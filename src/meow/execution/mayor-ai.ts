/**
 * LP-004 — Mayor AI (Real Execution Engine)
 *
 * AI-powered mayor that dispatches convoys intelligently.
 * Uses Gemini (tier S / flash) to analyze beads, create optimal convoys,
 * assign workers based on capability match, and dispatch with resource-aware scheduling.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import { executeWithGemini } from './gemini-executor';
import { getCrewAgentContext, syncCrewWithAgents } from './crew-agent-bridge';
import { getBeadsService } from '../beads-service';
import { mayor } from '../workers/mayor';
import { convoyManager } from '../convoy-manager';
import { workerPool } from '../worker-pool';
import type { Bead, Convoy, FeedEvent, FeedEventType } from '../types';

const log = createLogger('mayor-ai');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConvoyDecision {
  convoyName: string;
  beadIds: string[];
  rig?: string;
  rationale: string;
  estimatedTier: 'S' | 'A' | 'B';
  suggestedWorkers: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface DispatchResult {
  convoys: ConvoyDecision[];
  rationale: string;
  analysisTokens: number;
  costUsd: number;
  unassignedBeads: string[];
  timestamp: Date;
}

export interface BacklogItem {
  bead: Bead;
  score: number;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompts
// ─────────────────────────────────────────────────────────────────────────────

const MAYOR_DISPATCH_SYSTEM = `You are MOROS, the Mayor of Gas Town — the chief orchestrator of the MEOW work system.

Your role:
1. Analyze pending beads (tasks) and their priorities, dependencies, and required skills.
2. Group related beads into convoys (work bundles) for efficient execution.
3. Assign optimal workers based on tier requirements and capability match.
4. Consider resource constraints and parallel execution opportunities.

Rules:
- NEVER assign more work than available capacity allows.
- Group related beads (same BU, same rig, dependent beads) into the same convoy.
- Critical beads get their own convoy or go with high-priority groups.
- Prefer smaller, focused convoys over large omnibus ones.
- Each convoy should have 1-5 beads maximum.
- Consider skill requirements when grouping.

Output format: JSON array of convoy decisions.`;

const MAYOR_PRIORITIZE_SYSTEM = `You are MOROS, the Mayor of Gas Town. You prioritize the backlog.

Analyze each bead and assign a priority score (0-100) based on:
- Priority field weight: critical=90, high=70, medium=50, low=20
- Dependencies: beads that unblock others get +15
- Age: older beads get slight boost (+1 per day, max +10)
- Skill availability: beads with common skills get +5
- Business impact: beads in active BUs get +10

Output format: JSON array of { beadId, score, reasons[] }`;

// ─────────────────────────────────────────────────────────────────────────────
// Mayor AI dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mayor analyzes pending beads and creates optimal convoys.
 * Uses Gemini tier-S to make intelligent dispatch decisions.
 */
export async function mayorAnalyzeAndDispatch(): Promise<DispatchResult> {
  const beadsService = getBeadsService();
  const startMs = Date.now();

  log.info('Mayor AI: Starting analysis and dispatch cycle');

  // Fetch ready beads
  let readyBeads: Bead[];
  try {
    readyBeads = await beadsService.ready({ limit: 50 });
  } catch (err) {
    log.error({ err }, 'Mayor AI: Failed to fetch ready beads');
    return {
      convoys: [],
      rationale: 'Failed to fetch ready beads from database',
      analysisTokens: 0,
      costUsd: 0,
      unassignedBeads: [],
      timestamp: new Date(),
    };
  }

  if (readyBeads.length === 0) {
    log.info('Mayor AI: No ready beads to dispatch');
    return {
      convoys: [],
      rationale: 'No ready beads in the backlog',
      analysisTokens: 0,
      costUsd: 0,
      unassignedBeads: [],
      timestamp: new Date(),
    };
  }

  // Get worker pool status for capacity awareness
  const poolStatus = workerPool.getPoolStatus();
  const workers = workerPool.listWorkers({ alive: true });
  const workerSummary = workers.map(w => ({
    id: w.id,
    role: w.role,
    tier: w.tier,
    busy: !!w.currentBeadId,
    capabilities: w.capabilities,
  }));

  // Build the analysis prompt
  const beadSummaries = readyBeads.map(b => ({
    id: b.id,
    title: b.title,
    description: b.description?.slice(0, 200),
    priority: b.priority,
    tier: b.tier,
    skill: b.skill,
    bu: b.bu,
    rig: b.rig,
    dependencies: b.dependencies.length,
    labels: b.labels,
  }));

  const prompt = [
    `## Ready Beads (${readyBeads.length})`,
    '```json',
    JSON.stringify(beadSummaries, null, 2),
    '```',
    '',
    `## Worker Pool`,
    `- Active: ${poolStatus.active}, Capacity: ${poolStatus.capacity}, Queued: ${poolStatus.queued}`,
    `- Available workers:`,
    '```json',
    JSON.stringify(workerSummary.filter(w => !w.busy).slice(0, 20), null, 2),
    '```',
    '',
    `## Instructions`,
    `Create convoy groupings for these beads. Output a JSON object:`,
    '```json',
    '{',
    '  "convoys": [',
    '    {',
    '      "convoyName": "descriptive-name",',
    '      "beadIds": ["bd-xxxx", ...],',
    '      "rig": "optional-rig-name",',
    '      "rationale": "why these beads are grouped",',
    '      "estimatedTier": "S|A|B",',
    '      "suggestedWorkers": ["worker-id", ...],',
    '      "priority": "critical|high|medium|low"',
    '    }',
    '  ],',
    '  "rationale": "overall dispatch strategy explanation",',
    '  "unassignedBeads": ["bd-xxxx"] // beads that should wait',
    '}',
    '```',
  ].join('\n');

  try {
    // Call Gemini for analysis (tier S for maximum intelligence)
    const geminiResult = await executeWithGemini(prompt, MAYOR_DISPATCH_SYSTEM, 'S', {
      moleculeId: 'mayor-dispatch',
      workerId: 'mayor-moros',
      skillName: 'convoy-dispatch',
    });

    // Parse the AI response
    let parsed: {
      convoys: ConvoyDecision[];
      rationale: string;
      unassignedBeads?: string[];
    };

    try {
      const jsonMatch = geminiResult.result.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, geminiResult.result];
      parsed = JSON.parse(jsonMatch[1] || geminiResult.result);
    } catch (parseErr) {
      log.warn({ parseErr }, 'Mayor AI: Failed to parse Gemini response — attempting raw parse');
      try {
        parsed = JSON.parse(geminiResult.result);
      } catch {
        parsed = {
          convoys: [],
          rationale: `AI response could not be parsed: ${geminiResult.result.slice(0, 200)}`,
          unassignedBeads: readyBeads.map(b => b.id),
        };
      }
    }

    // Validate and sanitize convoy decisions
    const validConvoys: ConvoyDecision[] = [];
    const validBeadIds = new Set(readyBeads.map(b => b.id));

    for (const convoy of (parsed.convoys || [])) {
      // Filter to only valid bead IDs
      const filteredBeadIds = (convoy.beadIds || []).filter((id: string) => validBeadIds.has(id));
      if (filteredBeadIds.length === 0) continue;

      validConvoys.push({
        convoyName: convoy.convoyName || `convoy-${uuidv4().slice(0, 6)}`,
        beadIds: filteredBeadIds,
        rig: convoy.rig,
        rationale: convoy.rationale || 'Auto-grouped by Mayor AI',
        estimatedTier: ['S', 'A', 'B'].includes(convoy.estimatedTier) ? convoy.estimatedTier : 'A',
        suggestedWorkers: convoy.suggestedWorkers || [],
        priority: ['critical', 'high', 'medium', 'low'].includes(convoy.priority) ? convoy.priority : 'medium',
      });
    }

    // Create actual convoys via the mayor
    for (const decision of validConvoys) {
      try {
        const convoy = mayor.createConvoy(decision.convoyName, decision.beadIds, decision.rig);
        mayor.dispatchConvoy(convoy.id);

        convoyManager.notifyCreated(convoy.id, decision.convoyName);
        convoyManager.notifyDispatched(convoy.id);

        log.info({
          convoyId: convoy.id,
          name: decision.convoyName,
          beadCount: decision.beadIds.length,
          priority: decision.priority,
        }, 'Mayor AI: Convoy created and dispatched');
      } catch (err) {
        log.error({ err, convoyName: decision.convoyName }, 'Mayor AI: Failed to create convoy');
      }
    }

    const durationMs = Date.now() - startMs;
    const result: DispatchResult = {
      convoys: validConvoys,
      rationale: parsed.rationale || 'Dispatch completed',
      analysisTokens: geminiResult.usage.inputTokens + geminiResult.usage.outputTokens,
      costUsd: geminiResult.usage.costUsd,
      unassignedBeads: parsed.unassignedBeads || [],
      timestamp: new Date(),
    };

    // Broadcast the dispatch result
    broadcast('meow:feed', {
      type: 'convoy_dispatched',
      source: 'mayor-ai',
      message: `Mayor AI dispatched ${validConvoys.length} convoys (${readyBeads.length} beads analyzed, ${durationMs}ms, $${result.costUsd.toFixed(6)})`,
      severity: 'info',
      metadata: {
        convoyCount: validConvoys.length,
        beadCount: readyBeads.length,
        unassigned: result.unassignedBeads.length,
        durationMs,
        costUsd: result.costUsd,
      },
      timestamp: new Date(),
    });

    log.info({
      convoyCount: validConvoys.length,
      beadCount: readyBeads.length,
      durationMs,
      costUsd: result.costUsd,
    }, 'Mayor AI: Dispatch cycle complete');

    return result;

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Mayor AI: Dispatch analysis failed');

    broadcast('meow:feed', {
      type: 'worker_error',
      source: 'mayor-ai',
      message: `Mayor AI dispatch failed: ${error}`,
      severity: 'error',
      timestamp: new Date(),
    });

    return {
      convoys: [],
      rationale: `Dispatch failed: ${error}`,
      analysisTokens: 0,
      costUsd: 0,
      unassignedBeads: readyBeads.map(b => b.id),
      timestamp: new Date(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backlog prioritization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mayor AI prioritizes the backlog using Gemini analysis.
 * Returns beads sorted by priority score with reasons.
 */
export async function mayorPrioritizeBacklog(beads: Bead[]): Promise<BacklogItem[]> {
  if (beads.length === 0) return [];

  // For small backlogs, use heuristic scoring (no LLM call needed)
  if (beads.length <= 5) {
    return heuristicPrioritize(beads);
  }

  const beadSummaries = beads.map(b => ({
    id: b.id,
    title: b.title,
    priority: b.priority,
    tier: b.tier,
    skill: b.skill,
    bu: b.bu,
    dependencies: b.dependencies.length,
    createdAt: b.createdAt.toISOString(),
    labels: b.labels,
  }));

  const prompt = [
    `## Backlog Beads (${beads.length})`,
    '```json',
    JSON.stringify(beadSummaries, null, 2),
    '```',
    '',
    `Score each bead 0-100 and provide reasons.`,
    `Output: { "items": [{ "beadId": "...", "score": N, "reasons": ["..."] }] }`,
  ].join('\n');

  try {
    const geminiResult = await executeWithGemini(prompt, MAYOR_PRIORITIZE_SYSTEM, 'A', {
      workerId: 'mayor-moros',
      skillName: 'backlog-prioritize',
    });

    let parsed: { items: Array<{ beadId: string; score: number; reasons: string[] }> };
    try {
      const jsonMatch = geminiResult.result.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, geminiResult.result];
      parsed = JSON.parse(jsonMatch[1] || geminiResult.result);
    } catch {
      log.warn('Mayor AI: Failed to parse prioritization — falling back to heuristic');
      return heuristicPrioritize(beads);
    }

    // Map AI scores back to beads
    const scoreMap = new Map<string, { score: number; reasons: string[] }>();
    for (const item of (parsed.items || [])) {
      scoreMap.set(item.beadId, { score: item.score, reasons: item.reasons || [] });
    }

    const result: BacklogItem[] = beads.map(b => {
      const aiScore = scoreMap.get(b.id);
      if (aiScore) {
        return { bead: b, score: aiScore.score, reasons: aiScore.reasons };
      }
      // Fallback for beads not scored by AI
      return heuristicScoreSingle(b);
    });

    result.sort((a, b) => b.score - a.score);

    log.info({ beadCount: beads.length, topScore: result[0]?.score }, 'Mayor AI: Backlog prioritized');
    return result;

  } catch (err) {
    log.error({ err }, 'Mayor AI: Prioritization failed — using heuristic');
    return heuristicPrioritize(beads);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_WEIGHTS: Record<string, number> = {
  critical: 90,
  high: 70,
  medium: 50,
  low: 20,
};

function heuristicScoreSingle(bead: Bead): BacklogItem {
  const reasons: string[] = [];
  let score = PRIORITY_WEIGHTS[bead.priority] || 50;
  reasons.push(`Base priority: ${bead.priority} (${PRIORITY_WEIGHTS[bead.priority] || 50})`);

  // Age bonus (1 point per day, max 10)
  const ageDays = Math.floor((Date.now() - bead.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const ageBonus = Math.min(ageDays, 10);
  if (ageBonus > 0) {
    score += ageBonus;
    reasons.push(`Age bonus: +${ageBonus} (${ageDays} days old)`);
  }

  // Dependency bonus (unblocks others)
  if (bead.dependencies.length > 0) {
    score += 5;
    reasons.push(`Has dependencies: +5`);
  }

  // Tier bonus (higher tier = more impactful)
  if (bead.tier === 'S') {
    score += 10;
    reasons.push('Tier S: +10');
  } else if (bead.tier === 'A') {
    score += 5;
    reasons.push('Tier A: +5');
  }

  return { bead, score: Math.min(score, 100), reasons };
}

function heuristicPrioritize(beads: Bead[]): BacklogItem[] {
  const items = beads.map(heuristicScoreSingle);
  items.sort((a, b) => b.score - a.score);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled dispatch loop
// ─────────────────────────────────────────────────────────────────────────────

let dispatchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the mayor AI dispatch loop.
 * Runs analysis and dispatch at the specified interval.
 */
export function startMayorDispatchLoop(intervalMs: number = 5 * 60 * 1000): void {
  if (dispatchTimer) return;

  log.info({ intervalMs }, 'Starting Mayor AI dispatch loop');

  // Sync crew with agents on startup
  syncCrewWithAgents();

  dispatchTimer = setInterval(async () => {
    try {
      await mayorAnalyzeAndDispatch();
    } catch (err) {
      log.error({ err }, 'Mayor AI dispatch loop error');
    }
  }, intervalMs);

  // Run immediately
  mayorAnalyzeAndDispatch().catch(err => {
    log.error({ err }, 'Mayor AI initial dispatch failed');
  });
}

/**
 * Stop the mayor AI dispatch loop.
 */
export function stopMayorDispatchLoop(): void {
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
    log.info('Mayor AI dispatch loop stopped');
  }
}

/**
 * Check if the dispatch loop is active.
 */
export function isMayorDispatchActive(): boolean {
  return dispatchTimer !== null;
}
