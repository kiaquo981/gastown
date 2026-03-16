/**
 * CG-001 — Mayor Priority Scoring (Stage 05 Wave 1)
 *
 * AI-powered bead priority scoring for the Gas Town backlog.
 * The Mayor uses Gemini to score beads across 5 dimensions and automatically
 * reorders the backlog on a configurable interval.
 *
 * Scoring dimensions:
 *   - urgency: deadline proximity, SLA breach risk (0-100)
 *   - impact: business value, revenue potential (0-100)
 *   - cost: estimated execution cost vs. budget (0-100, inverted)
 *   - resource_fit: available worker skill match (0-100)
 *   - dependency_clear: how many blocking deps are resolved (0-100)
 *
 * Composite score = weighted sum (configurable weights).
 * Falls back to heuristic scoring when Gemini is unavailable.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('mayor-priority-scoring');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  urgency: number;
  impact: number;
  cost: number;
  resource_fit: number;
  dependency_clear: number;
}

export interface DimensionScores {
  urgency: number;
  impact: number;
  cost: number;
  resource_fit: number;
  dependency_clear: number;
}

export interface BeadScore {
  beadId: string;
  dimensions: DimensionScores;
  composite: number;
  rationale: string;
  scoredAt: Date;
  source: 'ai' | 'heuristic';
}

export interface ScoredBead {
  bead: Bead;
  score: BeadScore;
}

export interface ScoringContext {
  availableWorkers: WorkerIdentity[];
  resolvedDependencyIds: Set<string>;
  budgetRemainingUsd?: number;
  activeBUs?: string[];
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const DEFAULT_WEIGHTS: ScoringWeights = {
  urgency: 0.30,
  impact: 0.25,
  cost: 0.15,
  resource_fit: 0.15,
  dependency_clear: 0.15,
};

const PRIORITY_URGENCY_MAP: Record<string, number> = {
  critical: 95,
  high: 75,
  medium: 50,
  low: 20,
};

const SCORING_SYSTEM_PROMPT = `You are MOROS, the Mayor of Gas Town. You score beads (tasks) for prioritization.

For each bead, provide scores on 5 dimensions (0-100):
- urgency: How time-sensitive is this? Consider priority field, deadlines, SLA risk.
- impact: What is the business value? Revenue potential, unblocking power, strategic alignment.
- cost: Inverse of execution cost. Simple/cheap beads score higher. Complex/expensive beads score lower.
- resource_fit: How well do available workers match the required skills? Perfect match = 100.
- dependency_clear: What percentage of blocking dependencies are already resolved? All clear = 100.

Also provide a brief rationale (1-2 sentences) for each bead explaining the key scoring factors.

Output STRICT JSON: { "scores": [{ "beadId": "...", "urgency": N, "impact": N, "cost": N, "resource_fit": N, "dependency_clear": N, "rationale": "..." }] }`;

// ---------------------------------------------------------------------------
// Heuristic fallback scoring
// ---------------------------------------------------------------------------

function heuristicScoreDimensions(bead: Bead, ctx: ScoringContext): DimensionScores {
  const now = ctx.nowMs ?? Date.now();

  // Urgency: based on priority + age
  const basePriorityScore = PRIORITY_URGENCY_MAP[bead.priority] ?? 50;
  const ageDays = Math.floor((now - bead.createdAt.getTime()) / (86400 * 1000));
  const ageBoost = Math.min(ageDays * 2, 20);
  const urgency = Math.min(basePriorityScore + ageBoost, 100);

  // Impact: tier-based + BU activity bonus
  let impact = 50;
  if (bead.tier === 'S') impact = 85;
  else if (bead.tier === 'A') impact = 65;
  if (bead.bu && ctx.activeBUs?.includes(bead.bu)) impact = Math.min(impact + 10, 100);
  if (bead.dependencies.length > 0) impact = Math.min(impact + 8, 100); // unblocks others

  // Cost: simple heuristic — shorter descriptions imply simpler tasks
  const descLen = bead.description?.length ?? 0;
  const cost = descLen > 500 ? 30 : descLen > 200 ? 55 : 75;

  // Resource fit: check if any available worker has matching capabilities
  let resource_fit = 40; // baseline
  if (bead.skill) {
    const matchingWorkers = ctx.availableWorkers.filter(
      w => w.capabilities.some(c => c.toLowerCase().includes(bead.skill?.toLowerCase() ?? ''))
    );
    if (matchingWorkers.length > 0) resource_fit = 80;
  }
  if (bead.tier) {
    const tierMatch = ctx.availableWorkers.filter(w => w.tier === bead.tier);
    if (tierMatch.length > 0) resource_fit = Math.min(resource_fit + 15, 100);
  }

  // Dependency clear: ratio of resolved deps
  const totalDeps = bead.dependencies.filter(d => d.type === 'blocks').length;
  let dependency_clear = 100;
  if (totalDeps > 0) {
    const resolved = bead.dependencies.filter(
      d => d.type === 'blocks' && ctx.resolvedDependencyIds.has(d.targetId)
    ).length;
    dependency_clear = Math.round((resolved / totalDeps) * 100);
  }

  return { urgency, impact, cost, resource_fit, dependency_clear };
}

function computeComposite(dims: DimensionScores, weights: ScoringWeights): number {
  const raw =
    dims.urgency * weights.urgency +
    dims.impact * weights.impact +
    dims.cost * weights.cost +
    dims.resource_fit * weights.resource_fit +
    dims.dependency_clear * weights.dependency_clear;
  return Math.round(Math.min(raw, 100) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Gemini AI scoring
// ---------------------------------------------------------------------------

async function callGeminiForScoring(
  beads: Bead[],
  ctx: ScoringContext,
): Promise<Map<string, { dims: DimensionScores; rationale: string }> | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const beadSummaries = beads.map(b => ({
    id: b.id,
    title: b.title,
    description: b.description?.slice(0, 300),
    priority: b.priority,
    tier: b.tier,
    skill: b.skill,
    bu: b.bu,
    rig: b.rig,
    depCount: b.dependencies.length,
    blockedBy: b.dependencies.filter(d => d.type === 'blocks').map(d => d.targetId),
    labels: b.labels,
    ageDays: Math.floor(((ctx.nowMs ?? Date.now()) - b.createdAt.getTime()) / (86400 * 1000)),
  }));

  const workerSummary = ctx.availableWorkers.slice(0, 15).map(w => ({
    id: w.id,
    role: w.role,
    tier: w.tier,
    capabilities: w.capabilities.slice(0, 5),
  }));

  const prompt = [
    `## Beads to Score (${beads.length})`,
    '```json',
    JSON.stringify(beadSummaries, null, 2),
    '```',
    '',
    `## Available Workers (${ctx.availableWorkers.length})`,
    '```json',
    JSON.stringify(workerSummary, null, 2),
    '```',
    '',
    `## Resolved Dependency IDs`,
    `[${Array.from(ctx.resolvedDependencyIds).slice(0, 50).join(', ')}]`,
    '',
    `Score each bead on all 5 dimensions (0-100). Output strict JSON.`,
  ].join('\n');

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: SCORING_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, body: errText.slice(0, 200) }, 'Gemini scoring API error');
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const parsed = JSON.parse(jsonMatch[1] || raw) as {
      scores: Array<{
        beadId: string;
        urgency: number;
        impact: number;
        cost: number;
        resource_fit: number;
        dependency_clear: number;
        rationale: string;
      }>;
    };

    const result = new Map<string, { dims: DimensionScores; rationale: string }>();
    for (const s of (parsed.scores || [])) {
      const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
      result.set(s.beadId, {
        dims: {
          urgency: clamp(s.urgency),
          impact: clamp(s.impact),
          cost: clamp(s.cost),
          resource_fit: clamp(s.resource_fit),
          dependency_clear: clamp(s.dependency_clear),
        },
        rationale: s.rationale || '',
      });
    }

    log.info({ scoredCount: result.size, beadCount: beads.length }, 'Gemini scoring completed');
    return result;
  } catch (err) {
    log.error({ err }, 'Gemini scoring call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistScores(scores: BeadScore[]): Promise<void> {
  const pool = getPool();
  if (!pool || scores.length === 0) return;

  try {
    const values = scores.map((s, i) => {
      const base = i * 9;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    }).join(', ');

    const params = scores.flatMap(s => [
      s.beadId,
      s.dimensions.urgency,
      s.dimensions.impact,
      s.dimensions.cost,
      s.dimensions.resource_fit,
      s.dimensions.dependency_clear,
      s.composite,
      s.source,
      s.scoredAt,
    ]);

    await pool.query(
      `INSERT INTO meow_bead_scores
        (bead_id, urgency, impact, cost, resource_fit, dependency_clear, composite, source, scored_at)
       VALUES ${values}
       ON CONFLICT (bead_id) DO UPDATE SET
        urgency = EXCLUDED.urgency, impact = EXCLUDED.impact, cost = EXCLUDED.cost,
        resource_fit = EXCLUDED.resource_fit, dependency_clear = EXCLUDED.dependency_clear,
        composite = EXCLUDED.composite, source = EXCLUDED.source, scored_at = EXCLUDED.scored_at`,
      params,
    );
  } catch (err) {
    log.warn({ err }, 'Failed to persist bead scores (table may not exist)');
  }
}

// ---------------------------------------------------------------------------
// MayorPriorityScorer
// ---------------------------------------------------------------------------

export class MayorPriorityScorer {
  private weights: ScoringWeights;
  private autoScoringTimer: ReturnType<typeof setInterval> | null = null;
  private lastScoringResult: ScoredBead[] = [];

  constructor(weights?: Partial<ScoringWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    log.info({ weights: this.weights }, 'MayorPriorityScorer initialized');
  }

  /** Score a single bead across all 5 dimensions */
  async scoreBead(bead: Bead, context: ScoringContext): Promise<BeadScore> {
    // Try AI scoring for complex beads
    const isComplex = (bead.description?.length ?? 0) > 100 || bead.dependencies.length > 2;
    let aiResult: Map<string, { dims: DimensionScores; rationale: string }> | null = null;

    if (isComplex && process.env.GEMINI_API_KEY) {
      aiResult = await callGeminiForScoring([bead], context);
    }

    const aiScore = aiResult?.get(bead.id);
    if (aiScore) {
      const composite = computeComposite(aiScore.dims, this.weights);
      return {
        beadId: bead.id,
        dimensions: aiScore.dims,
        composite,
        rationale: aiScore.rationale,
        scoredAt: new Date(),
        source: 'ai',
      };
    }

    // Heuristic fallback
    const dims = heuristicScoreDimensions(bead, context);
    const composite = computeComposite(dims, this.weights);
    const rationale = this.buildHeuristicRationale(bead, dims);

    return {
      beadId: bead.id,
      dimensions: dims,
      composite,
      rationale,
      scoredAt: new Date(),
      source: 'heuristic',
    };
  }

  /** Score an entire backlog and return sorted (descending composite) */
  async scoreBacklog(beads: Bead[], context?: ScoringContext): Promise<ScoredBead[]> {
    if (beads.length === 0) return [];

    const ctx: ScoringContext = context ?? {
      availableWorkers: [],
      resolvedDependencyIds: new Set(),
      nowMs: Date.now(),
    };

    const startMs = Date.now();
    log.info({ beadCount: beads.length }, 'Scoring backlog');

    // Batch AI scoring for larger backlogs
    let aiScores: Map<string, { dims: DimensionScores; rationale: string }> | null = null;
    if (beads.length > 3 && process.env.GEMINI_API_KEY) {
      aiScores = await callGeminiForScoring(beads.slice(0, 50), ctx);
    }

    const results: ScoredBead[] = [];
    for (const bead of beads) {
      const aiScore = aiScores?.get(bead.id);
      let score: BeadScore;

      if (aiScore) {
        const composite = computeComposite(aiScore.dims, this.weights);
        score = {
          beadId: bead.id,
          dimensions: aiScore.dims,
          composite,
          rationale: aiScore.rationale,
          scoredAt: new Date(),
          source: 'ai',
        };
      } else {
        const dims = heuristicScoreDimensions(bead, ctx);
        const composite = computeComposite(dims, this.weights);
        score = {
          beadId: bead.id,
          dimensions: dims,
          composite,
          rationale: this.buildHeuristicRationale(bead, dims),
          scoredAt: new Date(),
          source: 'heuristic',
        };
      }

      results.push({ bead, score });
    }

    // Sort descending by composite
    results.sort((a, b) => b.score.composite - a.score.composite);
    this.lastScoringResult = results;

    // Persist scores asynchronously
    persistScores(results.map(r => r.score)).catch(() => {});

    const durationMs = Date.now() - startMs;
    const aiCount = results.filter(r => r.score.source === 'ai').length;

    broadcast('meow:feed', {
      id: uuidv4(),
      type: 'system_health',
      source: 'mayor-priority-scoring',
      message: `Backlog scored: ${beads.length} beads (${aiCount} AI, ${beads.length - aiCount} heuristic) in ${durationMs}ms`,
      severity: 'info',
      metadata: { beadCount: beads.length, aiCount, durationMs, topScore: results[0]?.score.composite },
      timestamp: new Date(),
    });

    log.info({ beadCount: beads.length, aiCount, durationMs, topScore: results[0]?.score.composite }, 'Backlog scoring complete');
    return results;
  }

  /** Start auto-scoring on an interval */
  startAutoScoring(intervalMs: number): void {
    if (this.autoScoringTimer) {
      log.warn('Auto-scoring already running');
      return;
    }

    log.info({ intervalMs }, 'Starting auto-scoring loop');
    this.autoScoringTimer = setInterval(async () => {
      try {
        const pool = getPool();
        if (!pool) return;

        // Fetch backlog beads from DB
        const { rows } = await pool.query(
          `SELECT * FROM meow_beads WHERE status IN ('backlog', 'ready') ORDER BY created_at DESC LIMIT 100`
        );

        if (rows.length === 0) return;

        const beads: Bead[] = rows.map(this.rowToBead);
        await this.scoreBacklog(beads);
      } catch (err) {
        log.error({ err }, 'Auto-scoring cycle failed');
      }
    }, intervalMs);
  }

  /** Stop auto-scoring */
  stopAutoScoring(): void {
    if (this.autoScoringTimer) {
      clearInterval(this.autoScoringTimer);
      this.autoScoringTimer = null;
      log.info('Auto-scoring stopped');
    }
  }

  /** Get current scoring weights */
  getWeights(): ScoringWeights {
    return { ...this.weights };
  }

  /** Update scoring weights (partial) */
  setWeights(weights: Partial<ScoringWeights>): void {
    this.weights = { ...this.weights, ...weights };

    // Normalize weights to sum to 1.0
    const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - 1.0) > 0.01) {
      for (const key of Object.keys(this.weights) as (keyof ScoringWeights)[]) {
        this.weights[key] = this.weights[key] / sum;
      }
    }

    log.info({ weights: this.weights }, 'Scoring weights updated');
  }

  /** Get last scoring result (cached) */
  getLastResult(): ScoredBead[] {
    return this.lastScoringResult;
  }

  /** Check if auto-scoring is active */
  isAutoScoringActive(): boolean {
    return this.autoScoringTimer !== null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildHeuristicRationale(bead: Bead, dims: DimensionScores): string {
    const parts: string[] = [];
    if (dims.urgency >= 80) parts.push(`High urgency (${bead.priority})`);
    if (dims.impact >= 70) parts.push(`High impact (tier ${bead.tier || 'B'})`);
    if (dims.dependency_clear < 50) parts.push(`Blocked deps (${100 - dims.dependency_clear}% pending)`);
    if (dims.resource_fit >= 70) parts.push('Good worker fit');
    if (parts.length === 0) parts.push('Standard scoring applied');
    return parts.join('; ');
  }

  private rowToBead(row: Record<string, unknown>): Bead {
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string | undefined,
      status: row.status as Bead['status'],
      priority: row.priority as Bead['priority'],
      executorType: (row.executor_type as Bead['executorType']) || 'agent',
      bu: row.bu as string | undefined,
      rig: row.rig as string | undefined,
      skill: row.skill as string | undefined,
      formula: row.formula as string | undefined,
      tier: row.tier as Bead['tier'],
      labels: (row.labels as Record<string, string>) || {},
      assignee: row.assignee as string | undefined,
      moleculeId: row.molecule_id as string | undefined,
      convoyId: row.convoy_id as string | undefined,
      parentId: row.parent_id as string | undefined,
      dependencies: (row.dependencies as Bead['dependencies']) || [],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
      createdBy: row.created_by as string || 'system',
      completedBy: row.completed_by as string | undefined,
      artifacts: row.artifacts as string[] | undefined,
      prUrl: row.pr_url as string | undefined,
      worktree: row.worktree as string | undefined,
    };
  }
}

/** Singleton instance */
export const mayorPriorityScorer = new MayorPriorityScorer();
