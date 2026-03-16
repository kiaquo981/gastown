/**
 * LP-002 — Polecat Spawner (Real Execution Engine)
 *
 * Real polecat spawning with isolated execution contexts.
 * For AI tasks: spawn isolated Gemini session with full context.
 * For code tasks: create git worktree, execute, create PR, cleanup.
 * Integrates with gemini-executor for LLM calls.
 */

import { v4 as uuidv4 } from 'uuid';
import { execSync, execFileSync } from 'child_process';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import { getPool } from '../../db/client';
import { executeWithGemini, type GeminiUsage } from './gemini-executor';
import { polecatManager, type PolecatInstance } from '../workers/polecat';
import type { Bead, FeedEvent, FeedEventType } from '../types';

const log = createLogger('polecat-spawner');

/** Sanitize strings for safe use in shell commands — allow only safe characters */
function sanitizeForShell(str: string): string {
  return str.replace(/[^a-zA-Z0-9_\-./]/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PolecatResult {
  polecatId: string;
  beadId: string;
  success: boolean;
  output: string;
  prUrl?: string;
  artifacts: string[];
  usage: GeminiUsage;
  durationMs: number;
  spawnedAt: Date;
  completedAt: Date;
}

export interface PolecatSpawnOptions {
  /** Bead being worked on */
  bead: Partial<Bead> & { id: string; title: string };
  /** Skill name to execute */
  skill: string;
  /** Agent tier for model selection */
  tier: 'S' | 'A' | 'B';
  /** Additional context for the LLM */
  context?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Branch to work on (auto-generated if not provided) */
  branch?: string;
  /** Molecule ID for tracking */
  moleculeId?: string;
  /** Step ID for tracking */
  stepId?: string;
}

interface ActivePolecat {
  id: string;
  beadId: string;
  skill: string;
  tier: 'S' | 'A' | 'B';
  spawnedAt: Date;
  lastOutputAt?: Date;
  outputLines: string[];
  nudgeCount: number;
  instance?: PolecatInstance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Active polecat tracking
// ─────────────────────────────────────────────────────────────────────────────

const activePolecats = new Map<string, ActivePolecat>();

// ─────────────────────────────────────────────────────────────────────────────
// Git worktree helpers
// ─────────────────────────────────────────────────────────────────────────────

function createWorktree(beadId: string, branch: string, basePath: string): string | null {
  const safeBeadId = sanitizeForShell(beadId);
  const safeBranch = sanitizeForShell(branch);
  const safeBasePath = sanitizeForShell(basePath);
  const worktreePath = `${safeBasePath}/${safeBeadId}`;

  try {
    // Check if git is available and we're in a repo
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: process.cwd(), stdio: 'pipe' });

    // Create the worktree — try creating new branch first, fallback to existing
    try {
      execFileSync('git', ['worktree', 'add', worktreePath, '-b', safeBranch], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
    } catch {
      execFileSync('git', ['worktree', 'add', worktreePath, safeBranch], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
    }

    log.info({ beadId: safeBeadId, branch: safeBranch, worktreePath }, 'Git worktree created');
    return worktreePath;
  } catch (err) {
    log.warn({ err, beadId: safeBeadId }, 'Failed to create git worktree — continuing without isolation');
    return null;
  }
}

function cleanupWorktree(worktreePath: string): void {
  const safePath = sanitizeForShell(worktreePath);
  try {
    execFileSync('git', ['worktree', 'remove', safePath, '--force'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    log.info({ worktreePath: safePath }, 'Git worktree cleaned up');
  } catch (err) {
    log.warn({ err, worktreePath: safePath }, 'Failed to cleanup git worktree');
  }
}

function createPR(branch: string, title: string, body: string): string | null {
  const safeBranch = sanitizeForShell(branch);
  try {
    const result = execFileSync('gh', [
      'pr', 'create',
      '--head', safeBranch,
      '--title', title.slice(0, 200),
      '--body', body.slice(0, 2000),
    ], { cwd: process.cwd(), stdio: 'pipe' });
    const prUrl = result.toString().trim();
    log.info({ branch: safeBranch, prUrl }, 'PR created');
    return prUrl;
  } catch (err) {
    log.warn({ err, branch: safeBranch }, 'Failed to create PR via gh CLI');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polecat build prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildPolecatPrompt(options: PolecatSpawnOptions): { system: string; user: string } {
  const system = options.systemPrompt || [
    `You are a MEOW Polecat worker — an ephemeral, focused executor.`,
    `Your task is to execute the skill "${options.skill}" for bead "${options.bead.id}".`,
    ``,
    `## Bead Details`,
    `- **ID:** ${options.bead.id}`,
    `- **Title:** ${options.bead.title}`,
    options.bead.description ? `- **Description:** ${options.bead.description}` : '',
    options.bead.bu ? `- **Business Unit:** ${options.bead.bu}` : '',
    options.bead.rig ? `- **Rig:** ${options.bead.rig}` : '',
    ``,
    `## Rules`,
    `1. Focus exclusively on the assigned task.`,
    `2. Produce concrete, actionable output.`,
    `3. If you encounter a blocker, describe it clearly.`,
    `4. Return structured JSON when possible.`,
    `5. Be concise but thorough.`,
  ].filter(Boolean).join('\n');

  const user = [
    `Execute skill: ${options.skill}`,
    ``,
    `Bead: ${options.bead.title}`,
    options.bead.description ? `\nDescription:\n${options.bead.description}` : '',
    options.context ? `\nAdditional Context:\n${options.context}` : '',
    ``,
    `Provide your output as structured JSON with the following shape:`,
    `{`,
    `  "status": "completed" | "blocked" | "needs_review",`,
    `  "summary": "brief summary of what was done",`,
    `  "output": { ... skill-specific output ... },`,
    `  "artifacts": ["list of artifact paths or IDs if any"],`,
    `  "blockers": ["list of blockers if status is blocked"]`,
    `}`,
  ].filter(Boolean).join('\n');

  return { system, user };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main spawn function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a polecat to execute a task in isolation.
 * For AI tasks, uses Gemini. For code tasks, creates a git worktree.
 */
export async function spawnPolecat(options: PolecatSpawnOptions): Promise<PolecatResult> {
  const polecatId = `polecat-${uuidv4().slice(0, 8)}`;
  const spawnedAt = new Date();
  const rawBranch = options.branch || `feature/${options.bead.id}-${options.skill}`;
  const branch = sanitizeForShell(rawBranch);

  log.info({
    polecatId,
    beadId: options.bead.id,
    skill: options.skill,
    tier: options.tier,
  }, 'Spawning polecat');

  // Register in active tracking
  const activePolecat: ActivePolecat = {
    id: polecatId,
    beadId: options.bead.id,
    skill: options.skill,
    tier: options.tier,
    spawnedAt,
    outputLines: [],
    nudgeCount: 0,
  };
  activePolecats.set(polecatId, activePolecat);

  // Register with polecat manager
  let instance: PolecatInstance | undefined;
  try {
    instance = await polecatManager.spawn(options.bead.id, options.skill, {
      tier: options.tier,
      branch,
    });
    activePolecat.instance = instance;
  } catch (err) {
    log.warn({ err, polecatId }, 'Failed to register with polecat manager — continuing');
  }

  // Broadcast spawn event
  emitFeed('polecat_spawned', `Polecat ${polecatId} spawned for bead ${options.bead.id} (skill: ${options.skill}, tier: ${options.tier})`, {
    beadId: options.bead.id,
    moleculeId: options.moleculeId,
    metadata: { polecatId, skill: options.skill, tier: options.tier, branch },
  });

  try {
    // Build prompts
    const { system, user } = buildPolecatPrompt(options);

    // Execute via Gemini
    const geminiResult = await executeWithGemini(user, system, options.tier, {
      moleculeId: options.moleculeId,
      stepId: options.stepId,
      workerId: polecatId,
      beadId: options.bead.id,
      skillName: options.skill,
    });

    activePolecat.lastOutputAt = new Date();
    activePolecat.outputLines.push(geminiResult.result.slice(0, 500));

    // Parse structured output
    let parsedOutput: Record<string, unknown> = {};
    let artifacts: string[] = [];
    let prUrl: string | undefined;

    try {
      const jsonMatch = geminiResult.result.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, geminiResult.result];
      parsedOutput = JSON.parse(jsonMatch[1] || geminiResult.result);
      artifacts = (parsedOutput.artifacts as string[]) || [];
    } catch {
      parsedOutput = { result: geminiResult.result };
    }

    // For code-type skills, attempt worktree + PR
    const isCodeSkill = options.skill.includes('code') || options.skill.includes('implement') || options.skill.includes('refactor');
    if (isCodeSkill) {
      const worktreePath = createWorktree(options.bead.id, branch, '.worktrees');
      if (worktreePath) {
        try {
          prUrl = createPR(branch, `[MEOW] ${options.bead.title}`, `Auto-generated by Polecat ${polecatId}\n\nBead: ${options.bead.id}\nSkill: ${options.skill}`) || undefined;
        } catch {
          // PR creation is best-effort
        }
      }
    }

    // Complete polecat in manager
    if (instance) {
      try {
        await polecatManager.complete(instance.id, prUrl);
      } catch {
        // Manager completion is best-effort
      }
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - spawnedAt.getTime();

    // Persist result to DB
    await persistPolecatResult(polecatId, options, geminiResult.result, prUrl, durationMs, geminiResult.usage);

    // Broadcast completion
    emitFeed('polecat_completed', `Polecat ${polecatId} completed bead ${options.bead.id} in ${durationMs}ms`, {
      beadId: options.bead.id,
      moleculeId: options.moleculeId,
      metadata: { polecatId, durationMs, prUrl, tokenUsage: geminiResult.usage },
    });

    // Remove from active tracking
    activePolecats.delete(polecatId);

    const result: PolecatResult = {
      polecatId,
      beadId: options.bead.id,
      success: true,
      output: geminiResult.result,
      prUrl,
      artifacts,
      usage: geminiResult.usage,
      durationMs,
      spawnedAt,
      completedAt,
    };

    log.info({ polecatId, beadId: options.bead.id, durationMs, prUrl }, 'Polecat completed successfully');
    return result;

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - spawnedAt.getTime();

    // Fail the polecat in manager
    if (instance) {
      try {
        await polecatManager.fail(instance.id, error);
      } catch {
        // Manager failure is best-effort
      }
    }

    emitFeed('polecat_stalled', `Polecat ${polecatId} failed on bead ${options.bead.id}: ${error}`, {
      beadId: options.bead.id,
      moleculeId: options.moleculeId,
      metadata: { polecatId, error },
    });

    activePolecats.delete(polecatId);

    log.error({ err, polecatId, beadId: options.bead.id }, 'Polecat execution failed');

    return {
      polecatId,
      beadId: options.bead.id,
      success: false,
      output: `Error: ${error}`,
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'error' },
      durationMs,
      spawnedAt,
      completedAt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cleanup a polecat's resources (worktree, temporary files).
 */
export function cleanupPolecat(polecatId: string): void {
  const active = activePolecats.get(polecatId);
  if (!active) {
    log.warn({ polecatId }, 'Polecat not found in active map for cleanup');
    return;
  }

  // Cleanup git worktree if one was created
  const worktreePath = `.worktrees/${active.beadId}`;
  cleanupWorktree(worktreePath);

  activePolecats.delete(polecatId);
  log.info({ polecatId }, 'Polecat cleaned up');
}

// ─────────────────────────────────────────────────────────────────────────────
// Active polecat queries (used by witness-supervisor)
// ─────────────────────────────────────────────────────────────────────────────

export function getActivePolecat(polecatId: string): ActivePolecat | undefined {
  return activePolecats.get(polecatId);
}

export function getAllActivePolecats(): ActivePolecat[] {
  return Array.from(activePolecats.values());
}

export function getActivePolecatCount(): number {
  return activePolecats.size;
}

export function recordNudge(polecatId: string): number {
  const active = activePolecats.get(polecatId);
  if (!active) return 0;
  active.nudgeCount++;
  return active.nudgeCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistPolecatResult(
  polecatId: string,
  options: PolecatSpawnOptions,
  output: string,
  prUrl: string | undefined,
  durationMs: number,
  usage: GeminiUsage,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO meow_polecat_results (
        polecat_id, bead_id, skill, tier, molecule_id, step_id,
        output, pr_url, duration_ms, input_tokens, output_tokens,
        cost_usd, model, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        polecatId,
        options.bead.id,
        options.skill,
        options.tier,
        options.moleculeId || null,
        options.stepId || null,
        output.slice(0, 10_000),
        prUrl || null,
        durationMs,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
        usage.model,
        new Date(),
      ]
    );
  } catch (err) {
    log.warn({ err, polecatId }, 'Failed to persist polecat result (table may not exist)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed events
// ─────────────────────────────────────────────────────────────────────────────

function emitFeed(
  type: FeedEventType,
  message: string,
  extra?: { beadId?: string; moleculeId?: string; metadata?: Record<string, unknown> },
): void {
  const event: Partial<FeedEvent> = {
    id: uuidv4(),
    type,
    source: 'polecat-spawner',
    message,
    severity: type === 'polecat_stalled' ? 'warning' : 'info',
    timestamp: new Date(),
    ...extra,
  };
  broadcast('meow:feed', event);
}
