/**
 * CG-002 — Mayor Resource Allocation (Stage 05 Wave 1)
 *
 * Optimal worker distribution for Gas Town bead assignments.
 * The Mayor evaluates workers across multiple factors:
 *   - Skill match: worker capabilities vs. bead requirements
 *   - Cost efficiency: prefer lower-tier workers for simple tasks
 *   - Availability: current load, queue depth per worker
 *   - Historical performance: past success rate on similar tasks
 *   - Specialization: worker's track record in this domain
 *
 * Uses a scoring matrix (workers x beads) with Hungarian-style assignment
 * for optimal matching. Falls back to greedy allocation without Gemini.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, Capability, FeedEvent } from '../types';

const log = createLogger('mayor-resource-allocation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Assignment {
  beadId: string;
  workerId: string;
  score: number;
  rationale: string;
}

export interface AllocationPlan {
  assignments: Assignment[];
  unassigned: string[];
  totalScore: number;
  allocatedAt: Date;
  strategy: 'ai' | 'greedy';
}

export interface WorkerSuggestion {
  workerId: string;
  workerName: string;
  score: number;
  rationale: string;
  alternatives: Array<{ workerId: string; score: number }>;
}

export interface EfficiencyReport {
  totalWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  avgLoad: number;
  avgSuccessRate: number;
  costEfficiency: number;
  bottlenecks: string[];
  suggestions: string[];
  generatedAt: Date;
}

interface WorkerMetrics {
  workerId: string;
  currentLoad: number;
  totalCompleted: number;
  totalFailed: number;
  successRate: number;
  avgCostPerTask: number;
  specializations: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const ALLOCATION_SYSTEM_PROMPT = `You are MOROS, the Mayor of Gas Town. You allocate workers to beads (tasks) optimally.

Consider these factors for each worker-bead pair:
1. Skill match: Does the worker have capabilities matching the bead's requirements?
2. Cost efficiency: Prefer lower-tier (cheaper) workers for simple tasks. Reserve S-tier for complex work.
3. Availability: Prefer workers with lower current load.
4. Performance: Prefer workers with higher success rates on similar tasks.
5. Specialization: Prefer workers experienced in the bead's domain/BU.

Output STRICT JSON:
{
  "assignments": [
    { "beadId": "...", "workerId": "...", "score": 0-100, "rationale": "..." }
  ],
  "unassigned": ["beadId1"] // beads that should wait for better worker match
}`;

// ---------------------------------------------------------------------------
// Worker metrics computation
// ---------------------------------------------------------------------------

function computeWorkerMetrics(
  worker: WorkerIdentity,
  loadMap: Map<string, number>,
  historyMap: Map<string, { completed: number; failed: number; costTotal: number; domains: string[] }>,
): WorkerMetrics {
  const history = historyMap.get(worker.id) || { completed: 0, failed: 0, costTotal: 0, domains: [] };
  const total = history.completed + history.failed;

  return {
    workerId: worker.id,
    currentLoad: loadMap.get(worker.id) || 0,
    totalCompleted: history.completed,
    totalFailed: history.failed,
    successRate: total > 0 ? history.completed / total : 0.5,
    avgCostPerTask: total > 0 ? history.costTotal / total : 0,
    specializations: history.domains,
  };
}

// ---------------------------------------------------------------------------
// Scoring matrix computation (greedy/heuristic)
// ---------------------------------------------------------------------------

function computePairScore(
  bead: Bead,
  worker: WorkerIdentity,
  metrics: WorkerMetrics,
): number {
  let score = 0;

  // Skill match (0-30 points)
  if (bead.skill) {
    const skillMatch = worker.capabilities.some(
      c => c.toLowerCase().includes(bead.skill?.toLowerCase() ?? '')
    );
    score += skillMatch ? 30 : 5;
  } else {
    score += 15; // No specific skill required
  }

  // Tier appropriateness (0-25 points)
  if (bead.tier) {
    if (worker.tier === bead.tier) {
      score += 25;
    } else if (
      (bead.tier === 'B' && worker.tier === 'A') ||
      (bead.tier === 'A' && worker.tier === 'S')
    ) {
      score += 15; // Overqualified but acceptable
    } else if (
      (bead.tier === 'S' && worker.tier === 'A') ||
      (bead.tier === 'A' && worker.tier === 'B')
    ) {
      score += 5; // Underqualified
    }
  } else {
    // No tier requirement — prefer cheaper workers
    if (worker.tier === 'B') score += 25;
    else if (worker.tier === 'A') score += 20;
    else score += 10;
  }

  // Availability (0-20 points) — fewer current tasks = higher score
  const loadPenalty = Math.min(metrics.currentLoad * 5, 20);
  score += 20 - loadPenalty;

  // Historical performance (0-15 points)
  score += Math.round(metrics.successRate * 15);

  // Specialization (0-10 points)
  if (bead.bu && metrics.specializations.includes(bead.bu)) {
    score += 10;
  } else if (bead.rig && metrics.specializations.includes(bead.rig)) {
    score += 7;
  }

  return Math.min(score, 100);
}

// ---------------------------------------------------------------------------
// Greedy allocation (heuristic fallback)
// ---------------------------------------------------------------------------

function greedyAllocate(
  beads: Bead[],
  workers: WorkerIdentity[],
  metricsMap: Map<string, WorkerMetrics>,
): AllocationPlan {
  const assignments: Assignment[] = [];
  const unassigned: string[] = [];
  const workerLoad = new Map<string, number>();

  // Initialize load counts
  for (const w of workers) {
    workerLoad.set(w.id, metricsMap.get(w.id)?.currentLoad ?? 0);
  }

  // Sort beads by priority (critical first)
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedBeads = [...beads].sort(
    (a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
  );

  for (const bead of sortedBeads) {
    let bestWorker: string | null = null;
    let bestScore = -1;
    let bestRationale = '';

    for (const worker of workers) {
      const metrics = metricsMap.get(worker.id) || {
        workerId: worker.id,
        currentLoad: 0,
        totalCompleted: 0,
        totalFailed: 0,
        successRate: 0.5,
        avgCostPerTask: 0,
        specializations: [],
      };

      // Adjust load for already-assigned work in this allocation
      const adjustedMetrics = {
        ...metrics,
        currentLoad: workerLoad.get(worker.id) || 0,
      };

      // Skip overloaded workers (max 5 concurrent tasks)
      if (adjustedMetrics.currentLoad >= 5) continue;

      const score = computePairScore(bead, worker, adjustedMetrics);
      if (score > bestScore) {
        bestScore = score;
        bestWorker = worker.id;
        bestRationale = `Score ${score}: ${worker.tier}-tier, load=${adjustedMetrics.currentLoad}, success=${Math.round(adjustedMetrics.successRate * 100)}%`;
      }
    }

    if (bestWorker && bestScore > 10) {
      assignments.push({
        beadId: bead.id,
        workerId: bestWorker,
        score: bestScore,
        rationale: bestRationale,
      });
      workerLoad.set(bestWorker, (workerLoad.get(bestWorker) || 0) + 1);
    } else {
      unassigned.push(bead.id);
    }
  }

  const totalScore = assignments.reduce((sum, a) => sum + a.score, 0);

  return {
    assignments,
    unassigned,
    totalScore,
    allocatedAt: new Date(),
    strategy: 'greedy',
  };
}

// ---------------------------------------------------------------------------
// AI-powered allocation via Gemini
// ---------------------------------------------------------------------------

async function aiAllocate(
  beads: Bead[],
  workers: WorkerIdentity[],
  metricsMap: Map<string, WorkerMetrics>,
): Promise<AllocationPlan | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const beadSummaries = beads.map(b => ({
    id: b.id,
    title: b.title,
    description: b.description?.slice(0, 200),
    priority: b.priority,
    tier: b.tier,
    skill: b.skill,
    bu: b.bu,
    rig: b.rig,
  }));

  const workerSummaries = workers.map(w => {
    const m = metricsMap.get(w.id);
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      tier: w.tier,
      capabilities: w.capabilities.slice(0, 6),
      currentLoad: m?.currentLoad ?? 0,
      successRate: m ? Math.round(m.successRate * 100) : 50,
      specializations: m?.specializations?.slice(0, 3) ?? [],
    };
  });

  const prompt = [
    `## Beads to Assign (${beads.length})`,
    '```json',
    JSON.stringify(beadSummaries, null, 2),
    '```',
    '',
    `## Available Workers (${workers.length})`,
    '```json',
    JSON.stringify(workerSummaries, null, 2),
    '```',
    '',
    'Create optimal worker-bead assignments. Max 5 tasks per worker. Output strict JSON.',
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
          { role: 'system', content: ALLOCATION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, body: errText.slice(0, 200) }, 'Gemini allocation API error');
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const parsed = JSON.parse(jsonMatch[1] || raw) as {
      assignments: Array<{ beadId: string; workerId: string; score: number; rationale: string }>;
      unassigned?: string[];
    };

    // Validate assignments reference real IDs
    const validBeadIds = new Set(beads.map(b => b.id));
    const validWorkerIds = new Set(workers.map(w => w.id));

    const validAssignments = (parsed.assignments || []).filter(
      a => validBeadIds.has(a.beadId) && validWorkerIds.has(a.workerId)
    ).map(a => ({
      beadId: a.beadId,
      workerId: a.workerId,
      score: Math.max(0, Math.min(100, Math.round(a.score))),
      rationale: a.rationale || 'AI-assigned',
    }));

    const assignedBeadIds = new Set(validAssignments.map(a => a.beadId));
    const unassigned = beads.filter(b => !assignedBeadIds.has(b.id)).map(b => b.id);
    const totalScore = validAssignments.reduce((sum, a) => sum + a.score, 0);

    log.info({ assignmentCount: validAssignments.length, unassigned: unassigned.length }, 'AI allocation completed');

    return {
      assignments: validAssignments,
      unassigned,
      totalScore,
      allocatedAt: new Date(),
      strategy: 'ai',
    };
  } catch (err) {
    log.error({ err }, 'Gemini allocation call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load tracking
// ---------------------------------------------------------------------------

async function fetchWorkerLoadFromDB(): Promise<Map<string, number>> {
  const loadMap = new Map<string, number>();
  const pool = getPool();
  if (!pool) return loadMap;

  try {
    const { rows } = await pool.query(
      `SELECT assignee, COUNT(*) as cnt
       FROM meow_beads
       WHERE status = 'in_progress' AND assignee IS NOT NULL
       GROUP BY assignee`
    );
    for (const row of rows) {
      loadMap.set(row.assignee as string, parseInt(row.cnt as string, 10));
    }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch worker load from DB');
  }
  return loadMap;
}

async function fetchWorkerHistoryFromDB(): Promise<Map<string, { completed: number; failed: number; costTotal: number; domains: string[] }>> {
  const historyMap = new Map<string, { completed: number; failed: number; costTotal: number; domains: string[] }>();
  const pool = getPool();
  if (!pool) return historyMap;

  try {
    const { rows } = await pool.query(
      `SELECT assignee,
              COUNT(*) FILTER (WHERE status = 'done') as completed,
              COUNT(*) FILTER (WHERE status = 'cancelled') as failed,
              ARRAY_AGG(DISTINCT bu) FILTER (WHERE bu IS NOT NULL) as domains
       FROM meow_beads
       WHERE assignee IS NOT NULL
       GROUP BY assignee`
    );
    for (const row of rows) {
      historyMap.set(row.assignee as string, {
        completed: parseInt(row.completed as string, 10) || 0,
        failed: parseInt(row.failed as string, 10) || 0,
        costTotal: 0,
        domains: (row.domains as string[]) || [],
      });
    }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch worker history from DB');
  }
  return historyMap;
}

// ---------------------------------------------------------------------------
// MayorResourceAllocator
// ---------------------------------------------------------------------------

export class MayorResourceAllocator {
  private lastPlan: AllocationPlan | null = null;
  private workerLoadCache = new Map<string, number>();
  private cacheUpdatedAt = 0;

  constructor() {
    log.info('MayorResourceAllocator initialized');
  }

  /** Allocate beads to workers optimally */
  async allocate(beads: Bead[], workers: WorkerIdentity[]): Promise<AllocationPlan> {
    if (beads.length === 0 || workers.length === 0) {
      return {
        assignments: [],
        unassigned: beads.map(b => b.id),
        totalScore: 0,
        allocatedAt: new Date(),
        strategy: 'greedy',
      };
    }

    const startMs = Date.now();
    log.info({ beadCount: beads.length, workerCount: workers.length }, 'Starting resource allocation');

    // Fetch metrics
    const loadMap = await fetchWorkerLoadFromDB();
    const historyMap = await fetchWorkerHistoryFromDB();

    const metricsMap = new Map<string, WorkerMetrics>();
    for (const w of workers) {
      metricsMap.set(w.id, computeWorkerMetrics(w, loadMap, historyMap));
    }

    // Try AI allocation first for larger batches
    let plan: AllocationPlan | null = null;
    if (beads.length > 3) {
      plan = await aiAllocate(beads, workers, metricsMap);
    }

    // Fallback to greedy
    if (!plan) {
      plan = greedyAllocate(beads, workers, metricsMap);
    }

    this.lastPlan = plan;
    this.workerLoadCache = loadMap;
    this.cacheUpdatedAt = Date.now();

    const durationMs = Date.now() - startMs;
    broadcast('meow:feed', {
      id: uuidv4(),
      type: 'system_health',
      source: 'mayor-resource-allocation',
      message: `Allocation: ${plan.assignments.length} assigned, ${plan.unassigned.length} unassigned (${plan.strategy}, ${durationMs}ms)`,
      severity: 'info',
      metadata: {
        assignmentCount: plan.assignments.length,
        unassigned: plan.unassigned.length,
        totalScore: plan.totalScore,
        strategy: plan.strategy,
        durationMs,
      },
      timestamp: new Date(),
    });

    log.info({
      assignmentCount: plan.assignments.length,
      unassigned: plan.unassigned.length,
      strategy: plan.strategy,
      durationMs,
    }, 'Allocation complete');

    return plan;
  }

  /** Suggest the best worker for a single bead */
  async suggestWorkerForBead(bead: Bead, workers?: WorkerIdentity[]): Promise<WorkerSuggestion> {
    const availableWorkers = workers || [];
    if (availableWorkers.length === 0) {
      return {
        workerId: '',
        workerName: 'none',
        score: 0,
        rationale: 'No workers available',
        alternatives: [],
      };
    }

    const loadMap = await fetchWorkerLoadFromDB();
    const historyMap = await fetchWorkerHistoryFromDB();

    const scored: Array<{ worker: WorkerIdentity; score: number; rationale: string }> = [];

    for (const worker of availableWorkers) {
      const metrics = computeWorkerMetrics(worker, loadMap, historyMap);
      if (metrics.currentLoad >= 5) continue;

      const score = computePairScore(bead, worker, metrics);
      scored.push({
        worker,
        score,
        rationale: `${worker.tier}-tier, load=${metrics.currentLoad}, success=${Math.round(metrics.successRate * 100)}%, specializations=[${metrics.specializations.join(',')}]`,
      });
    }

    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) {
      return { workerId: '', workerName: 'none', score: 0, rationale: 'All workers overloaded', alternatives: [] };
    }

    return {
      workerId: best.worker.id,
      workerName: best.worker.name,
      score: best.score,
      rationale: best.rationale,
      alternatives: scored.slice(1, 4).map(s => ({ workerId: s.worker.id, score: s.score })),
    };
  }

  /** Get current worker load map */
  getWorkerLoad(): Map<string, number> {
    return new Map(this.workerLoadCache);
  }

  /** Generate efficiency report across all workers */
  async getEfficiencyReport(workers: WorkerIdentity[]): Promise<EfficiencyReport> {
    const loadMap = await fetchWorkerLoadFromDB();
    const historyMap = await fetchWorkerHistoryFromDB();

    const activeCount = workers.filter(w => (loadMap.get(w.id) || 0) > 0).length;
    const idleCount = workers.length - activeCount;
    const loads = workers.map(w => loadMap.get(w.id) || 0);
    const avgLoad = loads.length > 0 ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;

    const successRates: number[] = [];
    const costs: number[] = [];
    for (const w of workers) {
      const h = historyMap.get(w.id);
      if (h) {
        const total = h.completed + h.failed;
        if (total > 0) {
          successRates.push(h.completed / total);
          costs.push(h.costTotal / total);
        }
      }
    }

    const avgSuccessRate = successRates.length > 0
      ? successRates.reduce((a, b) => a + b, 0) / successRates.length
      : 0;

    const avgCost = costs.length > 0
      ? costs.reduce((a, b) => a + b, 0) / costs.length
      : 0;

    // Identify bottlenecks
    const bottlenecks: string[] = [];
    for (const w of workers) {
      const load = loadMap.get(w.id) || 0;
      if (load >= 4) {
        bottlenecks.push(`${w.name} (${w.role}) is near capacity: ${load} tasks`);
      }
    }

    // Generate suggestions
    const suggestions: string[] = [];
    if (idleCount > workers.length * 0.5) {
      suggestions.push(`${idleCount} idle workers — consider reducing pool size or assigning more work`);
    }
    if (avgSuccessRate < 0.7 && successRates.length > 0) {
      suggestions.push('Average success rate below 70% — review worker capabilities and task complexity');
    }
    if (bottlenecks.length > 0) {
      suggestions.push(`${bottlenecks.length} worker(s) near capacity — consider load redistribution`);
    }

    return {
      totalWorkers: workers.length,
      activeWorkers: activeCount,
      idleWorkers: idleCount,
      avgLoad: Math.round(avgLoad * 100) / 100,
      avgSuccessRate: Math.round(avgSuccessRate * 100) / 100,
      costEfficiency: avgCost > 0 ? Math.round((avgSuccessRate / avgCost) * 1000) / 1000 : 0,
      bottlenecks,
      suggestions,
      generatedAt: new Date(),
    };
  }

  /** Get the last allocation plan (cached) */
  getLastPlan(): AllocationPlan | null {
    return this.lastPlan;
  }
}

/** Singleton instance */
export const mayorResourceAllocator = new MayorResourceAllocator();
