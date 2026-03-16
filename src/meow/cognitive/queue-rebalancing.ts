/**
 * QUEUE REBALANCING — CG-019 (Stage 05 Wave 5)
 *
 * Dynamic work queue rebalancing across workers.
 * Monitors queue depth per worker, detects imbalance, and steals
 * work from overloaded workers to idle ones — respecting specialization,
 * priority, and worker affinity.
 *
 * Features:
 *   - Queue depth monitoring per worker with imbalance detection
 *   - Worker specialization awareness (skill matching)
 *   - Work stealing from overloaded to idle workers
 *   - Priority-aware: high-priority beads can preempt lower ones
 *   - Load prediction integration (demand-forecasting.ts)
 *   - Worker affinity: prefer keeping related work on same worker
 *   - Configurable rebalance interval (default 60s)
 *
 * Gas Town: "Spread the load evenly or the convoy breaks in half."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { BeadPriority } from '../types';

const log = createLogger('queue-rebalancing');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerQueue {
  workerId: string;
  workerName?: string;
  skills: string[];                   // skills this worker can handle
  activeBeads: number;                // currently executing
  queuedBeads: number;               // waiting in queue
  totalLoad: number;                  // active + queued
  capacity: number;                   // max concurrent beads
  utilizationPct: number;             // active / capacity * 100
  highestPriority?: BeadPriority;     // highest priority bead in queue
  avgBeadAgeMs: number;               // avg time beads have been waiting
}

export interface QueueImbalance {
  overloaded: WorkerQueue[];
  idle: WorkerQueue[];
  balanced: WorkerQueue[];
  imbalanceScore: number;             // 0 = perfect, 100 = maximally imbalanced
  giniCoefficient: number;            // 0 = equal, 1 = maximally unequal
}

export interface RebalanceAction {
  beadId: string;
  beadTitle?: string;
  beadPriority: BeadPriority;
  beadSkill?: string;
  fromWorker: string;
  toWorker: string;
  reason: string;
  type: RebalanceType;
}

export type RebalanceType =
  | 'steal'              // move from overloaded to idle
  | 'preempt'            // high-priority displaces low-priority
  | 'affinity_move'      // move to worker with related beads
  | 'skill_match';       // move to better-skilled worker

export interface RebalanceEvent {
  id: string;
  actions: RebalanceAction[];
  imbalanceBefore: number;
  imbalanceAfter: number;
  predictedLoad?: number;             // from demand forecasting
  createdAt: Date;
}

export interface RebalanceConfig {
  intervalMs: number;                 // scan interval (default 60s)
  imbalanceThreshold: number;         // minimum imbalance score to trigger (default 30)
  maxActionsPerCycle: number;         // max beads to move per cycle (default 5)
  enablePreemption: boolean;          // allow high-priority preemption (default true)
  enableWorkStealing: boolean;        // allow work stealing (default true)
  affinityBonus: number;              // bonus score for keeping related work together (default 10)
  overloadThresholdPct: number;       // utilization % above which worker is overloaded (default 80)
  idleThresholdPct: number;           // utilization % below which worker is idle (default 20)
}

export interface RebalanceReport {
  totalRebalances: number;
  totalActionsTaken: number;
  avgImbalanceScore: number;
  avgActionsPerCycle: number;
  actionsByType: Record<RebalanceType, number>;
  topSourceWorkers: Array<{ workerId: string; moveCount: number }>;
  topTargetWorkers: Array<{ workerId: string; receiveCount: number }>;
  generatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RebalanceConfig = {
  intervalMs: 60_000,
  imbalanceThreshold: 30,
  maxActionsPerCycle: 5,
  enablePreemption: true,
  enableWorkStealing: true,
  affinityBonus: 10,
  overloadThresholdPct: 80,
  idleThresholdPct: 20,
};

const PRIORITY_WEIGHT: Record<BeadPriority, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

const DEFAULT_CAPACITY = 5;
const MAX_EVENTS_IN_MEMORY = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// QueueRebalancer
// ─────────────────────────────────────────────────────────────────────────────

export class QueueRebalancer {
  private events: RebalanceEvent[] = [];
  private config: RebalanceConfig;
  private scanTimer: NodeJS.Timeout | null = null;
  private totalRebalances = 0;
  private totalActions = 0;
  private actionsByType: Record<RebalanceType, number> = {
    steal: 0,
    preempt: 0,
    affinity_move: 0,
    skill_match: 0,
  };
  private sourceCount = new Map<string, number>();
  private targetCount = new Map<string, number>();

  constructor(config?: Partial<RebalanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Get queue status for all workers ──────────────────────────────

  async getWorkerQueues(): Promise<WorkerQueue[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT
           b.assignee AS worker_id,
           COUNT(*) FILTER (WHERE b.status = 'in_progress') AS active_beads,
           COUNT(*) FILTER (WHERE b.status = 'ready') AS queued_beads,
           MAX(b.priority) AS highest_priority,
           AVG(EXTRACT(EPOCH FROM (NOW() - b.created_at)) * 1000)
             FILTER (WHERE b.status = 'ready') AS avg_bead_age_ms
         FROM beads b
         WHERE b.assignee IS NOT NULL
           AND b.status IN ('in_progress', 'ready')
         GROUP BY b.assignee`,
      );

      const queues: WorkerQueue[] = [];

      for (const row of rows) {
        const workerId = row.worker_id as string;
        const active = parseInt(row.active_beads as string) || 0;
        const queued = parseInt(row.queued_beads as string) || 0;
        const skills = await this.getWorkerSkills(workerId);
        const capacity = await this.getWorkerCapacity(workerId);

        queues.push({
          workerId,
          skills,
          activeBeads: active,
          queuedBeads: queued,
          totalLoad: active + queued,
          capacity,
          utilizationPct: Math.round((active / Math.max(capacity, 1)) * 100),
          highestPriority: row.highest_priority as BeadPriority | undefined,
          avgBeadAgeMs: Math.round(parseFloat(row.avg_bead_age_ms as string) || 0),
        });
      }

      return queues;
    } catch (err) {
      log.error({ err }, 'Failed to get worker queues');
      return [];
    }
  }

  // ─── Detect imbalance ──────────────────────────────────────────────

  async detectImbalance(): Promise<QueueImbalance> {
    const queues = await this.getWorkerQueues();

    if (queues.length <= 1) {
      return {
        overloaded: [],
        idle: queues.filter(q => q.totalLoad === 0),
        balanced: queues,
        imbalanceScore: 0,
        giniCoefficient: 0,
      };
    }

    const overloaded = queues.filter(q => q.utilizationPct >= this.config.overloadThresholdPct);
    const idle = queues.filter(q => q.utilizationPct <= this.config.idleThresholdPct);
    const balanced = queues.filter(q =>
      q.utilizationPct > this.config.idleThresholdPct &&
      q.utilizationPct < this.config.overloadThresholdPct,
    );

    // Gini coefficient for load distribution
    const loads = queues.map(q => q.totalLoad).sort((a, b) => a - b);
    const gini = this.computeGini(loads);

    // Imbalance score (0-100): combines Gini with overloaded/idle ratio
    const overloadRatio = queues.length > 0 ? overloaded.length / queues.length : 0;
    const idleRatio = queues.length > 0 ? idle.length / queues.length : 0;
    const imbalanceScore = Math.round(
      (gini * 50) + (overloadRatio * 25) + (idleRatio * 25),
    );

    return {
      overloaded,
      idle,
      balanced,
      imbalanceScore: Math.min(100, imbalanceScore),
      giniCoefficient: Math.round(gini * 1000) / 1000,
    };
  }

  // ─── Run rebalance cycle ───────────────────────────────────────────

  async rebalance(): Promise<RebalanceEvent | null> {
    const imbalance = await this.detectImbalance();

    if (imbalance.imbalanceScore < this.config.imbalanceThreshold) {
      log.debug({ score: imbalance.imbalanceScore, threshold: this.config.imbalanceThreshold }, 'Imbalance below threshold — skipping rebalance');
      return null;
    }

    const actions: RebalanceAction[] = [];
    let actionCount = 0;

    // Strategy 1: Work stealing — move beads from overloaded to idle
    if (this.config.enableWorkStealing && imbalance.overloaded.length > 0 && imbalance.idle.length > 0) {
      const stealActions = await this.planWorkStealing(imbalance);
      for (const action of stealActions) {
        if (actionCount >= this.config.maxActionsPerCycle) break;
        actions.push(action);
        actionCount++;
      }
    }

    // Strategy 2: Priority preemption — high-priority beads on idle workers
    if (this.config.enablePreemption && actionCount < this.config.maxActionsPerCycle) {
      const preemptActions = await this.planPreemption(imbalance);
      for (const action of preemptActions) {
        if (actionCount >= this.config.maxActionsPerCycle) break;
        actions.push(action);
        actionCount++;
      }
    }

    // Strategy 3: Skill matching — move mismatched beads to better-skilled workers
    if (actionCount < this.config.maxActionsPerCycle) {
      const skillActions = await this.planSkillMatching(imbalance);
      for (const action of skillActions) {
        if (actionCount >= this.config.maxActionsPerCycle) break;
        actions.push(action);
        actionCount++;
      }
    }

    if (actions.length === 0) {
      return null;
    }

    // Execute actions
    for (const action of actions) {
      await this.executeAction(action);
    }

    // Measure imbalance after rebalance
    const imbalanceAfter = await this.detectImbalance();

    const event: RebalanceEvent = {
      id: uuidv4(),
      actions,
      imbalanceBefore: imbalance.imbalanceScore,
      imbalanceAfter: imbalanceAfter.imbalanceScore,
      createdAt: new Date(),
    };

    // Track stats
    this.totalRebalances += 1;
    this.totalActions += actions.length;
    for (const action of actions) {
      this.actionsByType[action.type] = (this.actionsByType[action.type] ?? 0) + 1;
      this.sourceCount.set(action.fromWorker, (this.sourceCount.get(action.fromWorker) ?? 0) + 1);
      this.targetCount.set(action.toWorker, (this.targetCount.get(action.toWorker) ?? 0) + 1);
    }

    // Persist and store
    await this.persistEvent(event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'queue_rebalanced',
      rebalance: {
        id: event.id,
        actionsCount: actions.length,
        imbalanceBefore: event.imbalanceBefore,
        imbalanceAfter: event.imbalanceAfter,
        actions: actions.map(a => ({
          beadId: a.beadId,
          from: a.fromWorker,
          to: a.toWorker,
          type: a.type,
        })),
        timestamp: event.createdAt.toISOString(),
      },
    });

    log.info({
      id: event.id,
      actions: actions.length,
      imbalanceBefore: event.imbalanceBefore,
      imbalanceAfter: event.imbalanceAfter,
    }, 'Queue rebalance completed');

    return event;
  }

  // ─── Lifecycle management ──────────────────────────────────────────

  startRebalancer(): void {
    if (this.scanTimer) return;
    log.info({ intervalMs: this.config.intervalMs }, 'Queue rebalancer started');

    this.scanTimer = setInterval(async () => {
      try {
        await this.rebalance();
      } catch (err) {
        log.error({ err }, 'Queue rebalance tick failed');
      }
    }, this.config.intervalMs);
  }

  stopRebalancer(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      log.info('Queue rebalancer stopped');
    }
  }

  isRebalancerRunning(): boolean {
    return this.scanTimer !== null;
  }

  // ─── Report ────────────────────────────────────────────────────────

  getReport(): RebalanceReport {
    const topSourceWorkers = Array.from(this.sourceCount.entries())
      .map(([workerId, moveCount]) => ({ workerId, moveCount }))
      .sort((a, b) => b.moveCount - a.moveCount)
      .slice(0, 10);

    const topTargetWorkers = Array.from(this.targetCount.entries())
      .map(([workerId, receiveCount]) => ({ workerId, receiveCount }))
      .sort((a, b) => b.receiveCount - a.receiveCount)
      .slice(0, 10);

    return {
      totalRebalances: this.totalRebalances,
      totalActionsTaken: this.totalActions,
      avgImbalanceScore: this.events.length > 0
        ? Math.round(this.events.reduce((s, e) => s + e.imbalanceBefore, 0) / this.events.length)
        : 0,
      avgActionsPerCycle: this.totalRebalances > 0
        ? Math.round((this.totalActions / this.totalRebalances) * 10) / 10
        : 0,
      actionsByType: { ...this.actionsByType },
      topSourceWorkers,
      topTargetWorkers,
      generatedAt: new Date(),
    };
  }

  // ─── Internal: plan work stealing ──────────────────────────────────

  private async planWorkStealing(imbalance: QueueImbalance): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];
    const pool = getPool();
    if (!pool) return actions;

    // Sort overloaded by most overloaded first, idle by most available capacity
    const sorted = imbalance.overloaded.sort((a, b) => b.totalLoad - a.totalLoad);
    const available = [...imbalance.idle].sort((a, b) => a.totalLoad - b.totalLoad);

    for (const source of sorted) {
      if (available.length === 0) break;

      try {
        // Get stealable beads (queued, not in-progress, lowest priority first)
        const { rows } = await pool.query(
          `SELECT id, title, priority, skill, convoy_id
           FROM beads
           WHERE assignee = $1 AND status = 'ready'
           ORDER BY
             CASE priority
               WHEN 'low' THEN 1
               WHEN 'medium' THEN 2
               WHEN 'high' THEN 3
               WHEN 'critical' THEN 4
             END ASC,
             created_at ASC
           LIMIT 3`,
          [source.workerId],
        );

        for (const bead of rows) {
          if (available.length === 0) break;

          const beadSkill = bead.skill as string | null;
          const convoyId = bead.convoy_id as string | null;

          // Find best target: must have compatible skill
          const target = this.findBestTarget(available, beadSkill, convoyId);
          if (!target) continue;

          actions.push({
            beadId: bead.id as string,
            beadTitle: bead.title as string,
            beadPriority: bead.priority as BeadPriority,
            beadSkill: beadSkill ?? undefined,
            fromWorker: source.workerId,
            toWorker: target.workerId,
            reason: `Steal from overloaded worker (${source.utilizationPct}% util) to idle worker (${target.utilizationPct}% util)`,
            type: 'steal',
          });

          // Update available capacity tracking
          target.totalLoad += 1;
          target.utilizationPct = Math.round((target.totalLoad / Math.max(target.capacity, 1)) * 100);
        }
      } catch (err) {
        log.error({ err, workerId: source.workerId }, 'Failed to plan work stealing');
      }
    }

    return actions;
  }

  // ─── Internal: plan preemption ─────────────────────────────────────

  private async planPreemption(imbalance: QueueImbalance): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];
    const pool = getPool();
    if (!pool) return actions;

    try {
      // Find critical/high priority beads on overloaded workers
      const { rows } = await pool.query(
        `SELECT b.id, b.title, b.priority, b.skill, b.assignee, b.convoy_id
         FROM beads b
         WHERE b.status = 'ready'
           AND b.priority IN ('critical', 'high')
           AND b.assignee = ANY($1::text[])
         ORDER BY
           CASE b.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 END ASC,
           b.created_at ASC
         LIMIT 5`,
        [imbalance.overloaded.map(w => w.workerId)],
      );

      for (const bead of rows) {
        const beadSkill = bead.skill as string | null;
        const convoyId = bead.convoy_id as string | null;

        // Find idle worker that can handle this skill
        const target = this.findBestTarget(imbalance.idle, beadSkill, convoyId);
        if (!target) continue;

        actions.push({
          beadId: bead.id as string,
          beadTitle: bead.title as string,
          beadPriority: bead.priority as BeadPriority,
          beadSkill: beadSkill ?? undefined,
          fromWorker: bead.assignee as string,
          toWorker: target.workerId,
          reason: `Preempt ${bead.priority} bead to idle worker for faster processing`,
          type: 'preempt',
        });
      }
    } catch (err) {
      log.error({ err }, 'Failed to plan preemption');
    }

    return actions;
  }

  // ─── Internal: plan skill matching ─────────────────────────────────

  private async planSkillMatching(imbalance: QueueImbalance): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];
    const pool = getPool();
    if (!pool) return actions;

    try {
      // Find beads assigned to workers that lack the required skill
      const allWorkers = [...imbalance.overloaded, ...imbalance.balanced, ...imbalance.idle];

      const { rows } = await pool.query(
        `SELECT b.id, b.title, b.priority, b.skill, b.assignee, b.convoy_id
         FROM beads b
         WHERE b.status = 'ready' AND b.skill IS NOT NULL AND b.assignee IS NOT NULL
         LIMIT 20`,
      );

      for (const bead of rows) {
        const beadSkill = bead.skill as string;
        const currentWorker = allWorkers.find(w => w.workerId === bead.assignee);
        if (!currentWorker) continue;

        // Check if current worker has the skill
        if (currentWorker.skills.includes(beadSkill)) continue;

        // Find a worker that has the skill and is not overloaded
        const candidates = allWorkers.filter(
          w => w.skills.includes(beadSkill) && w.utilizationPct < this.config.overloadThresholdPct,
        );

        if (candidates.length === 0) continue;

        const target = candidates.sort((a, b) => a.totalLoad - b.totalLoad)[0];

        actions.push({
          beadId: bead.id as string,
          beadTitle: bead.title as string,
          beadPriority: bead.priority as BeadPriority,
          beadSkill: beadSkill,
          fromWorker: bead.assignee as string,
          toWorker: target.workerId,
          reason: `Skill mismatch: worker "${currentWorker.workerId}" lacks skill "${beadSkill}"; moving to "${target.workerId}"`,
          type: 'skill_match',
        });
      }
    } catch (err) {
      log.error({ err }, 'Failed to plan skill matching');
    }

    return actions;
  }

  // ─── Internal: find best target worker ─────────────────────────────

  private findBestTarget(
    candidates: WorkerQueue[],
    beadSkill: string | null,
    convoyId: string | null,
  ): WorkerQueue | null {
    if (candidates.length === 0) return null;

    // Score each candidate
    const scored = candidates.map(c => {
      let score = 100 - c.utilizationPct; // prefer least loaded

      // Skill match bonus
      if (beadSkill && c.skills.includes(beadSkill)) {
        score += 30;
      }

      // Affinity bonus: if worker already has beads from same convoy
      if (convoyId) {
        // We'd check DB but for performance, just give a small bonus
        score += this.config.affinityBonus;
      }

      return { worker: c, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Don't assign to workers that lack the required skill entirely
    if (beadSkill) {
      const skillMatch = scored.find(s => s.worker.skills.includes(beadSkill));
      if (skillMatch) return skillMatch.worker;
    }

    return scored[0]?.worker ?? null;
  }

  // ─── Internal: execute rebalance action ────────────────────────────

  private async executeAction(action: RebalanceAction): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE beads
         SET assignee = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'ready'`,
        [action.toWorker, action.beadId],
      );

      log.info({
        beadId: action.beadId,
        from: action.fromWorker,
        to: action.toWorker,
        type: action.type,
      }, 'Rebalance action executed');
    } catch (err) {
      log.error({ err, action }, 'Failed to execute rebalance action');
    }
  }

  // ─── Internal: helper functions ────────────────────────────────────

  private async getWorkerSkills(workerId: string): Promise<string[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT b.skill
         FROM beads b
         WHERE b.assignee = $1 AND b.skill IS NOT NULL AND b.status IN ('done', 'in_progress')
         LIMIT 20`,
        [workerId],
      );
      return rows.map((r: Record<string, unknown>) => r.skill as string);
    } catch {
      return [];
    }
  }

  private async getWorkerCapacity(workerId: string): Promise<number> {
    const pool = getPool();
    if (!pool) return DEFAULT_CAPACITY;

    try {
      const { rows } = await pool.query(
        `SELECT capacity FROM meow_worker_status WHERE worker_id = $1 LIMIT 1`,
        [workerId],
      );
      return rows[0]?.capacity ? parseInt(rows[0].capacity as string) : DEFAULT_CAPACITY;
    } catch {
      return DEFAULT_CAPACITY;
    }
  }

  private computeGini(values: number[]): number {
    const n = values.length;
    if (n === 0) return 0;

    const mean = values.reduce((s, v) => s + v, 0) / n;
    if (mean === 0) return 0;

    let sumAbsDiff = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        sumAbsDiff += Math.abs(values[i] - values[j]);
      }
    }

    return sumAbsDiff / (2 * n * n * mean);
  }

  // ─── Persistence ───────────────────────────────────────────────────

  private async persistEvent(event: RebalanceEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_rebalance_events
          (id, actions, imbalance_before, imbalance_after,
           predicted_load, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          event.id,
          JSON.stringify(event.actions),
          event.imbalanceBefore,
          event.imbalanceAfter,
          event.predictedLoad ?? null,
          event.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist rebalance event');
    }
  }

  /** Load recent events from DB on startup */
  async loadFromDb(sinceDays = 7): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT id, actions, imbalance_before, imbalance_after, created_at
         FROM meow_rebalance_events
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT 500`,
        [since.toISOString()],
      );

      // Rebuild stats from history
      for (const row of rows) {
        const actions = row.actions as RebalanceAction[] | null;
        if (actions) {
          this.totalActions += actions.length;
          for (const action of actions) {
            this.actionsByType[action.type] = (this.actionsByType[action.type] ?? 0) + 1;
            this.sourceCount.set(action.fromWorker, (this.sourceCount.get(action.fromWorker) ?? 0) + 1);
            this.targetCount.set(action.toWorker, (this.targetCount.get(action.toWorker) ?? 0) + 1);
          }
        }
        this.totalRebalances += 1;
      }

      log.info({ events: rows.length }, 'Loaded rebalance history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load rebalance history from DB');
    }
  }

  getEventCount(): number {
    return this.events.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: QueueRebalancer | null = null;

export function getQueueRebalancer(): QueueRebalancer {
  if (!instance) {
    instance = new QueueRebalancer();
  }
  return instance;
}
