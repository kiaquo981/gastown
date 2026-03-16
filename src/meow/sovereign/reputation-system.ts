/**
 * REPUTATION SYSTEM — SG-020 (Stage 06 Wave 5)
 *
 * Workers build reputation over time across multiple dimensions.
 * Reputation affects assignment priority — proven workers get the important tasks.
 *
 * Features:
 *   - Reputation dimensions: reliability, quality, speed, cost_efficiency, collaboration
 *   - Each dimension: 0-100 score, rolling average over last 100 tasks
 *   - Reputation effects: higher rep = preferred for important tasks
 *   - Decay: -1 point per week of inactivity per dimension
 *   - Boost: exceptional performance on high-priority tasks gives bonus
 *   - Reputation tiers: bronze, silver, gold, platinum, diamond
 *   - Leaderboard: ranked list of workers by composite reputation
 *   - DB table: meow_worker_reputation
 *   - Integration: reputation consulted during bead assignment
 *
 * Gas Town: "In the wastes, your name is everything. Earn it or lose it."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('reputation-system');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReputationDimension =
  | 'reliability'
  | 'quality'
  | 'speed'
  | 'cost_efficiency'
  | 'collaboration';

export type ReputationTier = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';

export type ReputationEventType =
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'quality_assessed'
  | 'handoff_success'
  | 'handoff_failure'
  | 'budget_under'
  | 'budget_over'
  | 'exceptional_performance'
  | 'inactivity_decay'
  | 'manual_adjustment';

export interface DimensionScore {
  current: number;                     // 0-100
  history: number[];                   // rolling window (last 100)
  lastUpdatedAt: Date;
  trend: 'rising' | 'falling' | 'stable';
}

export interface WorkerReputation {
  id: string;
  workerId: string;
  workerName?: string;
  dimensions: Record<ReputationDimension, DimensionScore>;
  compositeScore: number;              // weighted average of all dimensions
  tier: ReputationTier;
  previousTier: ReputationTier;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  streak: number;                      // consecutive successes (negative for failures)
  bestStreak: number;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReputationEvent {
  id: string;
  workerId: string;
  eventType: ReputationEventType;
  dimension: ReputationDimension;
  delta: number;                       // change in score
  previousScore: number;
  newScore: number;
  reason: string;
  taskId?: string;
  taskPriority?: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface LeaderboardEntry {
  rank: number;
  workerId: string;
  workerName?: string;
  compositeScore: number;
  tier: ReputationTier;
  reliability: number;
  quality: number;
  speed: number;
  costEfficiency: number;
  collaboration: number;
  totalTasks: number;
  streak: number;
}

export interface ReputationQuery {
  workerId?: string;
  tier?: ReputationTier;
  minComposite?: number;
  maxComposite?: number;
  dimension?: ReputationDimension;
  minDimensionScore?: number;
  limit?: number;
  sortBy?: 'composite' | ReputationDimension;
}

export interface ReputationSystemStats {
  totalWorkers: number;
  workersByTier: Record<ReputationTier, number>;
  avgCompositeScore: number;
  topPerformer: { workerId: string; score: number } | null;
  decayEventsToday: number;
  boostEventsToday: number;
  tierChangesToday: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLLING_WINDOW = 100;
const DECAY_PER_WEEK = 1.0;
const DECAY_CHECK_INTERVAL_HOURS = 24;
const EXCEPTIONAL_THRESHOLD = 90;       // score above this on a high-priority task = bonus
const EXCEPTIONAL_BONUS = 5;
const HIGH_PRIORITY_THRESHOLD = 3;      // tasks with priority <= 3 are high-priority
const MAX_WORKERS_IN_CACHE = 2000;
const MAX_EVENTS_IN_MEMORY = 5000;

const DIMENSION_WEIGHTS: Record<ReputationDimension, number> = {
  reliability: 0.30,
  quality: 0.30,
  speed: 0.15,
  cost_efficiency: 0.15,
  collaboration: 0.10,
};

const TIER_THRESHOLDS: Array<{ min: number; tier: ReputationTier }> = [
  { min: 95, tier: 'diamond' },
  { min: 80, tier: 'platinum' },
  { min: 60, tier: 'gold' },
  { min: 40, tier: 'silver' },
  { min: 0, tier: 'bronze' },
];

const DEFAULT_DIMENSION: DimensionScore = {
  current: 50,
  history: [50],
  lastUpdatedAt: new Date(),
  trend: 'stable',
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiReputation(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a worker reputation analysis engine. Evaluate worker performance data '
                + 'and provide fair, calibrated reputation assessments. Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini reputation call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// ReputationSystem
// ---------------------------------------------------------------------------

export class ReputationSystem {
  private workers = new Map<string, WorkerReputation>();
  private events: ReputationEvent[] = [];
  private stats: ReputationSystemStats = {
    totalWorkers: 0,
    workersByTier: { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0 },
    avgCompositeScore: 0,
    topPerformer: null,
    decayEventsToday: 0,
    boostEventsToday: 0,
    tierChangesToday: 0,
  };
  private lastDecayCheck = new Date();
  private todayDate = new Date().toISOString().slice(0, 10);
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadFromDb();
    this.recalculateStats();
    this.initialized = true;

    log.info({
      workers: this.workers.size,
      avgScore: this.stats.avgCompositeScore.toFixed(1),
    }, 'Reputation system initialized');
  }

  // -------------------------------------------------------------------------
  // Get or create worker reputation
  // -------------------------------------------------------------------------

  getWorkerReputation(workerId: string): WorkerReputation | null {
    return this.workers.get(workerId) ?? null;
  }

  ensureWorkerReputation(workerId: string, workerName?: string): WorkerReputation {
    const existing = this.workers.get(workerId);
    if (existing) return existing;

    const now = new Date();
    const rep: WorkerReputation = {
      id: uuidv4(),
      workerId,
      workerName,
      dimensions: {
        reliability: { ...DEFAULT_DIMENSION, lastUpdatedAt: now },
        quality: { ...DEFAULT_DIMENSION, lastUpdatedAt: now },
        speed: { ...DEFAULT_DIMENSION, lastUpdatedAt: now },
        cost_efficiency: { ...DEFAULT_DIMENSION, lastUpdatedAt: now },
        collaboration: { ...DEFAULT_DIMENSION, lastUpdatedAt: now },
      },
      compositeScore: 50,
      tier: 'silver',
      previousTier: 'silver',
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      streak: 0,
      bestStreak: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.workers.set(workerId, rep);
    this.stats.totalWorkers = this.workers.size;
    this.stats.workersByTier[rep.tier] = (this.stats.workersByTier[rep.tier] ?? 0) + 1;

    this.persistReputation(rep).catch(err => {
      log.warn({ err, workerId }, 'Failed to persist new reputation');
    });

    return rep;
  }

  // -------------------------------------------------------------------------
  // Record task outcome: updates relevant dimensions
  // -------------------------------------------------------------------------

  async recordTaskOutcome(
    workerId: string,
    outcome: {
      success: boolean;
      qualityScore?: number;          // 0-100
      executionTimeMs: number;
      estimatedTimeMs: number;
      costUsd: number;
      budgetUsd: number;
      taskPriority?: number;
      taskId?: string;
      handoffSuccess?: boolean;
    },
  ): Promise<WorkerReputation> {
    const rep = this.ensureWorkerReputation(workerId);
    const events: ReputationEvent[] = [];
    const now = new Date();

    rep.totalTasks += 1;
    rep.lastActiveAt = now;
    rep.updatedAt = now;

    // --- Reliability ---
    const reliabilityDelta = outcome.success ? 2 : -5;
    events.push(this.updateDimension(rep, 'reliability', reliabilityDelta, {
      eventType: outcome.success ? 'task_completed' : 'task_failed',
      reason: outcome.success ? 'Task completed successfully' : 'Task failed',
      taskId: outcome.taskId,
      taskPriority: outcome.taskPriority,
    }));

    if (outcome.success) {
      rep.completedTasks += 1;
      rep.streak = rep.streak >= 0 ? rep.streak + 1 : 1;
    } else {
      rep.failedTasks += 1;
      rep.streak = rep.streak <= 0 ? rep.streak - 1 : -1;
    }
    rep.bestStreak = Math.max(rep.bestStreak, rep.streak);

    // --- Quality ---
    if (outcome.qualityScore != null) {
      const qualityDelta = (outcome.qualityScore - rep.dimensions.quality.current) * 0.1;
      events.push(this.updateDimension(rep, 'quality', qualityDelta, {
        eventType: 'quality_assessed',
        reason: `Quality assessed at ${outcome.qualityScore}/100`,
        taskId: outcome.taskId,
        taskPriority: outcome.taskPriority,
        metadata: { qualityScore: outcome.qualityScore },
      }));
    }

    // --- Speed ---
    if (outcome.estimatedTimeMs > 0) {
      const speedRatio = outcome.estimatedTimeMs / Math.max(outcome.executionTimeMs, 1);
      // ratio > 1 = faster than expected, < 1 = slower
      const speedDelta = Math.max(-5, Math.min(5, (speedRatio - 1) * 5));
      events.push(this.updateDimension(rep, 'speed', speedDelta, {
        eventType: outcome.success ? 'task_completed' : 'task_timeout',
        reason: `Execution: ${outcome.executionTimeMs}ms / estimated: ${outcome.estimatedTimeMs}ms (ratio: ${speedRatio.toFixed(2)})`,
        taskId: outcome.taskId,
        taskPriority: outcome.taskPriority,
        metadata: { executionTimeMs: outcome.executionTimeMs, estimatedTimeMs: outcome.estimatedTimeMs },
      }));
    }

    // --- Cost efficiency ---
    if (outcome.budgetUsd > 0) {
      const costRatio = outcome.costUsd / outcome.budgetUsd;
      const costDelta = costRatio <= 1
        ? Math.min(3, (1 - costRatio) * 10)
        : Math.max(-5, -(costRatio - 1) * 10);
      events.push(this.updateDimension(rep, 'cost_efficiency', costDelta, {
        eventType: costRatio <= 1 ? 'budget_under' : 'budget_over',
        reason: `Cost: $${outcome.costUsd.toFixed(2)} / budget: $${outcome.budgetUsd.toFixed(2)} (${(costRatio * 100).toFixed(0)}%)`,
        taskId: outcome.taskId,
        taskPriority: outcome.taskPriority,
        metadata: { costUsd: outcome.costUsd, budgetUsd: outcome.budgetUsd },
      }));
    }

    // --- Collaboration ---
    if (outcome.handoffSuccess != null) {
      const collabDelta = outcome.handoffSuccess ? 3 : -4;
      events.push(this.updateDimension(rep, 'collaboration', collabDelta, {
        eventType: outcome.handoffSuccess ? 'handoff_success' : 'handoff_failure',
        reason: outcome.handoffSuccess ? 'Successful handoff' : 'Handoff failure',
        taskId: outcome.taskId,
        taskPriority: outcome.taskPriority,
      }));
    }

    // --- Exceptional performance bonus ---
    if (outcome.success && outcome.taskPriority != null &&
      outcome.taskPriority <= HIGH_PRIORITY_THRESHOLD) {
      const avgScore = (rep.dimensions.reliability.current + rep.dimensions.quality.current +
        rep.dimensions.speed.current) / 3;
      if (avgScore >= EXCEPTIONAL_THRESHOLD) {
        for (const dim of Object.keys(rep.dimensions) as ReputationDimension[]) {
          events.push(this.updateDimension(rep, dim, EXCEPTIONAL_BONUS, {
            eventType: 'exceptional_performance',
            reason: `Exceptional performance on high-priority task (avg ${avgScore.toFixed(0)})`,
            taskId: outcome.taskId,
            taskPriority: outcome.taskPriority,
          }));
        }
        this.stats.boostEventsToday += 1;
      }
    }

    // Recalculate composite and tier
    this.recalculateComposite(rep);
    const tierChanged = this.checkTierChange(rep);

    // Store events
    for (const e of events) {
      this.events.push(e);
    }
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-Math.floor(MAX_EVENTS_IN_MEMORY * 0.8));
    }

    // Persist
    await this.persistReputation(rep);
    await this.persistEventsBatch(events);

    // Broadcast
    broadcast('meow:sovereign', {
      type: 'reputation:updated',
      workerId,
      compositeScore: Math.round(rep.compositeScore * 10) / 10,
      tier: rep.tier,
      tierChanged,
      streak: rep.streak,
      dimensions: {
        reliability: Math.round(rep.dimensions.reliability.current),
        quality: Math.round(rep.dimensions.quality.current),
        speed: Math.round(rep.dimensions.speed.current),
        cost_efficiency: Math.round(rep.dimensions.cost_efficiency.current),
        collaboration: Math.round(rep.dimensions.collaboration.current),
      },
    });

    return rep;
  }

  // -------------------------------------------------------------------------
  // Decay: reduce scores for inactive workers
  // -------------------------------------------------------------------------

  async applyInactivityDecay(): Promise<{ affected: number; tierChanges: number }> {
    const now = new Date();
    const hoursSinceCheck = (now.getTime() - this.lastDecayCheck.getTime()) / 3_600_000;
    if (hoursSinceCheck < DECAY_CHECK_INTERVAL_HOURS) {
      return { affected: 0, tierChanges: 0 };
    }
    this.lastDecayCheck = now;

    let affected = 0;
    let tierChanges = 0;

    for (const [workerId, rep] of this.workers) {
      const weeksSinceActive = (now.getTime() - rep.lastActiveAt.getTime()) / (7 * 86_400_000);
      if (weeksSinceActive < 1) continue;

      const decayAmount = DECAY_PER_WEEK * Math.floor(weeksSinceActive);
      if (decayAmount <= 0) continue;

      let changed = false;
      for (const dim of Object.keys(rep.dimensions) as ReputationDimension[]) {
        const prev = rep.dimensions[dim].current;
        if (prev <= 0) continue;

        this.updateDimension(rep, dim, -decayAmount, {
          eventType: 'inactivity_decay',
          reason: `${Math.floor(weeksSinceActive)} weeks inactive, -${decayAmount.toFixed(1)} per dimension`,
        });
        changed = true;
      }

      if (changed) {
        this.recalculateComposite(rep);
        if (this.checkTierChange(rep)) tierChanges += 1;
        affected += 1;
      }
    }

    if (affected > 0) {
      this.stats.decayEventsToday += affected;
      log.info({ affected, tierChanges }, 'Inactivity decay applied');

      broadcast('meow:sovereign', {
        type: 'reputation:decay',
        affectedWorkers: affected,
        tierChanges,
      });
    }

    return { affected, tierChanges };
  }

  // -------------------------------------------------------------------------
  // Manual adjustment (overseer)
  // -------------------------------------------------------------------------

  async adjustReputation(
    workerId: string,
    dimension: ReputationDimension,
    delta: number,
    reason: string,
    adjustedBy: string,
  ): Promise<WorkerReputation | null> {
    const rep = this.workers.get(workerId);
    if (!rep) {
      log.warn({ workerId }, 'Worker not found for reputation adjustment');
      return null;
    }

    const event = this.updateDimension(rep, dimension, delta, {
      eventType: 'manual_adjustment',
      reason: `Manual adjustment by ${adjustedBy}: ${reason}`,
      metadata: { adjustedBy },
    });

    this.events.push(event);
    this.recalculateComposite(rep);
    this.checkTierChange(rep);

    await this.persistReputation(rep);
    await this.persistEventsBatch([event]);

    log.info({
      workerId,
      dimension,
      delta,
      newScore: rep.dimensions[dimension].current,
      adjustedBy,
    }, 'Manual reputation adjustment');

    return rep;
  }

  // -------------------------------------------------------------------------
  // Leaderboard
  // -------------------------------------------------------------------------

  getLeaderboard(limit = 20, sortBy: 'composite' | ReputationDimension = 'composite'): LeaderboardEntry[] {
    const workers = [...this.workers.values()];

    workers.sort((a, b) => {
      if (sortBy === 'composite') return b.compositeScore - a.compositeScore;
      return b.dimensions[sortBy].current - a.dimensions[sortBy].current;
    });

    return workers.slice(0, limit).map((rep, idx) => ({
      rank: idx + 1,
      workerId: rep.workerId,
      workerName: rep.workerName,
      compositeScore: Math.round(rep.compositeScore * 10) / 10,
      tier: rep.tier,
      reliability: Math.round(rep.dimensions.reliability.current),
      quality: Math.round(rep.dimensions.quality.current),
      speed: Math.round(rep.dimensions.speed.current),
      costEfficiency: Math.round(rep.dimensions.cost_efficiency.current),
      collaboration: Math.round(rep.dimensions.collaboration.current),
      totalTasks: rep.totalTasks,
      streak: rep.streak,
    }));
  }

  // -------------------------------------------------------------------------
  // Query workers by reputation
  // -------------------------------------------------------------------------

  queryWorkers(q: ReputationQuery): WorkerReputation[] {
    let filtered = [...this.workers.values()];

    if (q.workerId) {
      filtered = filtered.filter(r => r.workerId === q.workerId);
    }
    if (q.tier) {
      filtered = filtered.filter(r => r.tier === q.tier);
    }
    if (q.minComposite != null) {
      filtered = filtered.filter(r => r.compositeScore >= q.minComposite!);
    }
    if (q.maxComposite != null) {
      filtered = filtered.filter(r => r.compositeScore <= q.maxComposite!);
    }
    if (q.dimension && q.minDimensionScore != null) {
      filtered = filtered.filter(r => r.dimensions[q.dimension!].current >= q.minDimensionScore!);
    }

    // Sort
    const sortBy = q.sortBy ?? 'composite';
    filtered.sort((a, b) => {
      if (sortBy === 'composite') return b.compositeScore - a.compositeScore;
      return b.dimensions[sortBy].current - a.dimensions[sortBy].current;
    });

    return filtered.slice(0, q.limit ?? 50);
  }

  // -------------------------------------------------------------------------
  // Get best workers for assignment (integration point)
  // -------------------------------------------------------------------------

  getBestWorkersForTask(
    requiredDimensions: Partial<Record<ReputationDimension, number>>,
    limit = 5,
  ): Array<{ workerId: string; score: number; tier: ReputationTier }> {
    const candidates: Array<{ workerId: string; score: number; tier: ReputationTier }> = [];

    for (const [workerId, rep] of this.workers) {
      let meets = true;
      let totalScore = 0;
      let weightSum = 0;

      for (const [dim, minScore] of Object.entries(requiredDimensions) as Array<[ReputationDimension, number]>) {
        if (rep.dimensions[dim].current < minScore) {
          meets = false;
          break;
        }
        totalScore += rep.dimensions[dim].current * (DIMENSION_WEIGHTS[dim] ?? 0.2);
        weightSum += DIMENSION_WEIGHTS[dim] ?? 0.2;
      }

      if (meets) {
        candidates.push({
          workerId,
          score: weightSum > 0 ? totalScore / weightSum : rep.compositeScore,
          tier: rep.tier,
        });
      }
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // AI-powered reputation analysis
  // -------------------------------------------------------------------------

  async analyzeWorkerReputation(workerId: string): Promise<{
    summary: string;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
    aiUsed: boolean;
  }> {
    const rep = this.workers.get(workerId);
    if (!rep) {
      return {
        summary: 'Worker not found',
        strengths: [],
        weaknesses: [],
        recommendations: [],
        aiUsed: false,
      };
    }

    const prompt = JSON.stringify({
      task: 'analyze_worker_reputation',
      workerId,
      compositeScore: rep.compositeScore,
      tier: rep.tier,
      dimensions: Object.fromEntries(
        (Object.entries(rep.dimensions) as Array<[ReputationDimension, DimensionScore]>).map(
          ([dim, score]) => [dim, { current: score.current, trend: score.trend }],
        ),
      ),
      totalTasks: rep.totalTasks,
      completedTasks: rep.completedTasks,
      failedTasks: rep.failedTasks,
      streak: rep.streak,
      bestStreak: rep.bestStreak,
      recentEvents: this.events
        .filter(e => e.workerId === workerId)
        .slice(-20)
        .map(e => ({ type: e.eventType, dim: e.dimension, delta: e.delta, reason: e.reason })),
      instruction: 'Analyze this worker and return JSON: '
        + '{"summary": "string", "strengths": ["string"], "weaknesses": ["string"], "recommendations": ["string"]}',
    });

    const aiResponse = await callGeminiReputation(prompt);
    if (aiResponse) {
      try {
        const match = aiResponse.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            summary?: string;
            strengths?: string[];
            weaknesses?: string[];
            recommendations?: string[];
          };
          return {
            summary: parsed.summary ?? 'Analysis complete',
            strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
            weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
            recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
            aiUsed: true,
          };
        }
      } catch {
        log.warn({ workerId }, 'Failed to parse AI reputation analysis');
      }
    }

    // Heuristic fallback
    return this.heuristicAnalysis(rep);
  }

  private heuristicAnalysis(rep: WorkerReputation): {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
    aiUsed: boolean;
  } {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const recommendations: string[] = [];

    for (const [dim, score] of Object.entries(rep.dimensions) as Array<[ReputationDimension, DimensionScore]>) {
      if (score.current >= 80) {
        strengths.push(`Strong ${dim} (${score.current.toFixed(0)})`);
      } else if (score.current < 40) {
        weaknesses.push(`Low ${dim} (${score.current.toFixed(0)})`);
        recommendations.push(`Focus on improving ${dim} by taking on simpler tasks first`);
      }
      if (score.trend === 'falling') {
        recommendations.push(`${dim} is declining — investigate recent failures`);
      }
    }

    const successRate = rep.totalTasks > 0
      ? (rep.completedTasks / rep.totalTasks * 100).toFixed(0) : '0';

    return {
      summary: `${rep.tier.toUpperCase()} tier worker (${rep.compositeScore.toFixed(0)}/100). `
        + `${rep.totalTasks} tasks, ${successRate}% success rate, streak: ${rep.streak}.`,
      strengths,
      weaknesses,
      recommendations,
      aiUsed: false,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private updateDimension(
    rep: WorkerReputation,
    dimension: ReputationDimension,
    delta: number,
    opts: {
      eventType: ReputationEventType;
      reason: string;
      taskId?: string;
      taskPriority?: number;
      metadata?: Record<string, unknown>;
    },
  ): ReputationEvent {
    const dim = rep.dimensions[dimension];
    const prevScore = dim.current;

    // Apply delta with bounds
    dim.current = Math.max(0, Math.min(100, dim.current + delta));

    // Update rolling history
    dim.history.push(dim.current);
    if (dim.history.length > ROLLING_WINDOW) {
      dim.history = dim.history.slice(-ROLLING_WINDOW);
    }

    // Compute trend
    if (dim.history.length >= 10) {
      const recent = dim.history.slice(-5);
      const older = dim.history.slice(-10, -5);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

      if (recentAvg > olderAvg + 2) dim.trend = 'rising';
      else if (recentAvg < olderAvg - 2) dim.trend = 'falling';
      else dim.trend = 'stable';
    }

    dim.lastUpdatedAt = new Date();
    rep.updatedAt = new Date();

    return {
      id: uuidv4(),
      workerId: rep.workerId,
      eventType: opts.eventType,
      dimension,
      delta: Math.round((dim.current - prevScore) * 100) / 100,
      previousScore: Math.round(prevScore * 100) / 100,
      newScore: Math.round(dim.current * 100) / 100,
      reason: opts.reason,
      taskId: opts.taskId,
      taskPriority: opts.taskPriority,
      metadata: opts.metadata ?? {},
      createdAt: new Date(),
    };
  }

  private recalculateComposite(rep: WorkerReputation): void {
    let weighted = 0;
    for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS) as Array<[ReputationDimension, number]>) {
      weighted += rep.dimensions[dim].current * weight;
    }
    rep.compositeScore = Math.round(weighted * 100) / 100;
  }

  private checkTierChange(rep: WorkerReputation): boolean {
    const newTier = this.computeTier(rep.compositeScore);
    if (newTier !== rep.tier) {
      rep.previousTier = rep.tier;
      rep.tier = newTier;

      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.todayDate) {
        this.todayDate = today;
        this.stats.tierChangesToday = 1;
      } else {
        this.stats.tierChangesToday += 1;
      }

      broadcast('meow:sovereign', {
        type: 'reputation:tier_change',
        workerId: rep.workerId,
        previousTier: rep.previousTier,
        newTier: rep.tier,
        compositeScore: rep.compositeScore,
      });

      log.info({
        workerId: rep.workerId,
        from: rep.previousTier,
        to: rep.tier,
        score: rep.compositeScore,
      }, 'Worker tier changed');

      this.recalculateStats();
      return true;
    }
    return false;
  }

  private computeTier(score: number): ReputationTier {
    for (const { min, tier } of TIER_THRESHOLDS) {
      if (score >= min) return tier;
    }
    return 'bronze';
  }

  private recalculateStats(): void {
    const workers = [...this.workers.values()];
    this.stats.totalWorkers = workers.length;
    this.stats.workersByTier = { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0 };

    let totalComposite = 0;
    let topScore = 0;
    let topId = '';

    for (const w of workers) {
      this.stats.workersByTier[w.tier] += 1;
      totalComposite += w.compositeScore;
      if (w.compositeScore > topScore) {
        topScore = w.compositeScore;
        topId = w.workerId;
      }
    }

    this.stats.avgCompositeScore = workers.length > 0
      ? Math.round((totalComposite / workers.length) * 10) / 10
      : 0;
    this.stats.topPerformer = topId ? { workerId: topId, score: topScore } : null;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): ReputationSystemStats {
    return { ...this.stats };
  }

  getWorkerEvents(workerId: string, limit = 20): ReputationEvent[] {
    return this.events
      .filter(e => e.workerId === workerId)
      .slice(-limit)
      .reverse();
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistReputation(rep: WorkerReputation): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_worker_reputation
           (id, worker_id, worker_name, dimensions_json, composite_score,
            tier, previous_tier, total_tasks, completed_tasks, failed_tasks,
            streak, best_streak, last_active_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (worker_id) DO UPDATE SET
           worker_name = $3, dimensions_json = $4, composite_score = $5,
           tier = $6, previous_tier = $7, total_tasks = $8,
           completed_tasks = $9, failed_tasks = $10, streak = $11,
           best_streak = $12, last_active_at = $13, updated_at = $15`,
        [
          rep.id,
          rep.workerId,
          rep.workerName ?? null,
          JSON.stringify(rep.dimensions),
          rep.compositeScore,
          rep.tier,
          rep.previousTier,
          rep.totalTasks,
          rep.completedTasks,
          rep.failedTasks,
          rep.streak,
          rep.bestStreak,
          rep.lastActiveAt.toISOString(),
          rep.createdAt.toISOString(),
          rep.updatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, workerId: rep.workerId }, 'Failed to persist reputation');
    }
  }

  private async persistEventsBatch(events: ReputationEvent[]): Promise<void> {
    const pool = getPool();
    if (!pool || events.length === 0) return;

    try {
      for (const e of events) {
        await pool.query(
          `INSERT INTO meow_worker_reputation_events
             (id, worker_id, event_type, dimension, delta, previous_score,
              new_score, reason, task_id, task_priority, metadata_json, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            e.id,
            e.workerId,
            e.eventType,
            e.dimension,
            e.delta,
            e.previousScore,
            e.newScore,
            e.reason,
            e.taskId ?? null,
            e.taskPriority ?? null,
            JSON.stringify(e.metadata),
            e.createdAt.toISOString(),
          ],
        );
      }
    } catch (err) {
      log.warn({ err, count: events.length }, 'Failed to persist reputation events batch');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, worker_id, worker_name, dimensions_json, composite_score,
                tier, previous_tier, total_tasks, completed_tasks, failed_tasks,
                streak, best_streak, last_active_at, created_at, updated_at
         FROM meow_worker_reputation
         ORDER BY composite_score DESC
         LIMIT $1`,
        [MAX_WORKERS_IN_CACHE],
      );

      for (const row of rows) {
        const dims = typeof row.dimensions_json === 'string'
          ? JSON.parse(row.dimensions_json as string)
          : (row.dimensions_json ?? {});

        // Ensure all dimensions exist with defaults
        const dimensions: Record<ReputationDimension, DimensionScore> = {
          reliability: { ...DEFAULT_DIMENSION },
          quality: { ...DEFAULT_DIMENSION },
          speed: { ...DEFAULT_DIMENSION },
          cost_efficiency: { ...DEFAULT_DIMENSION },
          collaboration: { ...DEFAULT_DIMENSION },
        };

        for (const dim of Object.keys(dimensions) as ReputationDimension[]) {
          if (dims[dim]) {
            dimensions[dim] = {
              current: Number(dims[dim].current) || 50,
              history: Array.isArray(dims[dim].history) ? dims[dim].history : [50],
              lastUpdatedAt: dims[dim].lastUpdatedAt
                ? new Date(dims[dim].lastUpdatedAt) : new Date(),
              trend: dims[dim].trend ?? 'stable',
            };
          }
        }

        const rep: WorkerReputation = {
          id: row.id as string,
          workerId: row.worker_id as string,
          workerName: (row.worker_name as string) || undefined,
          dimensions,
          compositeScore: Number(row.composite_score) || 50,
          tier: (row.tier as ReputationTier) || 'silver',
          previousTier: (row.previous_tier as ReputationTier) || 'silver',
          totalTasks: Number(row.total_tasks) || 0,
          completedTasks: Number(row.completed_tasks) || 0,
          failedTasks: Number(row.failed_tasks) || 0,
          streak: Number(row.streak) || 0,
          bestStreak: Number(row.best_streak) || 0,
          lastActiveAt: new Date(row.last_active_at as string),
          createdAt: new Date(row.created_at as string),
          updatedAt: new Date(row.updated_at as string),
        };

        this.workers.set(rep.workerId, rep);
      }

      log.info({ loaded: rows.length }, 'Loaded worker reputations from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load reputations from DB (table may not exist yet)');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ReputationSystem | null = null;

export function getReputationSystem(): ReputationSystem {
  if (!instance) {
    instance = new ReputationSystem();
    log.info('ReputationSystem singleton created');
  }
  return instance;
}
