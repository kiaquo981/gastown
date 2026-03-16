/**
 * WORKER PERFORMANCE LEARNING -- CG-007 (Stage 05 Wave 2)
 *
 * Workers develop profiles from experience.
 * Enriches worker profiles over time:
 *   - strengths: task types where success rate > 90%
 *   - weaknesses: task types where failure rate > 20%
 *   - preferred_tasks: tasks completed fastest with best quality
 *   - optimal_load: max concurrent tasks before quality drops
 *   - best_hours: time-of-day when worker performs best (scheduling)
 *
 * Informed routing: assign tasks to workers based on learned profile.
 * Persists to meow_worker_profiles table.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('worker-performance-learning');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskResult {
  workerId: string;
  taskType: string;
  success: boolean;
  durationMs: number;
  quality?: number;           // 1-10
  concurrentTasks?: number;   // how many tasks were running when this completed
  completedAt: Date;
}

export interface HourPerformance {
  hour: number;               // 0-23 UTC
  executionCount: number;
  successRate: number;
  avgDurationMs: number;
}

export interface WorkerProfile {
  workerId: string;
  strengths: string[];        // task types with >90% success rate
  weaknesses: string[];       // task types with >20% failure rate
  preferredTasks: string[];   // tasks completed fastest + best quality
  optimalLoad: number;        // max concurrent tasks before quality degrades
  bestHours: number[];        // top 3 hours by performance
  totalTasksCompleted: number;
  overallSuccessRate: number;
  avgQuality: number;
  lastUpdatedAt: Date;
}

interface TaskTypeStats {
  taskType: string;
  total: number;
  successes: number;
  durations: number[];
  qualities: number[];
}

// ---------------------------------------------------------------------------
// WorkerPerformanceLearner
// ---------------------------------------------------------------------------

export class WorkerPerformanceLearner {
  private results: TaskResult[] = [];
  private profiles = new Map<string, WorkerProfile>();
  private maxResults = 20_000;
  private profileDirty = new Set<string>(); // worker IDs needing recompute

  // --- Record a task result -----------------------------------------------

  async recordTaskResult(
    workerId: string,
    taskType: string,
    success: boolean,
    durationMs: number,
    quality?: number,
    concurrentTasks?: number,
  ): Promise<void> {
    const result: TaskResult = {
      workerId,
      taskType,
      success,
      durationMs,
      quality,
      concurrentTasks,
      completedAt: new Date(),
    };

    this.results.push(result);
    if (this.results.length > this.maxResults) {
      this.results = this.results.slice(-this.maxResults);
    }

    this.profileDirty.add(workerId);

    // Persist to DB
    await this.persistResult(result);

    // Recompute profile inline if we have enough data
    const workerResults = this.results.filter(r => r.workerId === workerId);
    if (workerResults.length % 10 === 0) {
      this.recomputeProfile(workerId);
    }

    broadcast('meow:cognitive', {
      type: 'worker_task_recorded',
      workerId,
      taskType,
      success,
      durationMs,
    });
  }

  // --- Get worker profile -------------------------------------------------

  getWorkerProfile(workerId: string): WorkerProfile | null {
    if (this.profileDirty.has(workerId) || !this.profiles.has(workerId)) {
      this.recomputeProfile(workerId);
    }
    return this.profiles.get(workerId) ?? null;
  }

  // --- Suggest best worker for a task type --------------------------------

  suggestWorkerForTask(taskType: string, available: string[]): string {
    if (available.length === 0) return '';
    if (available.length === 1) return available[0];

    let bestId = available[0];
    let bestScore = -1;

    for (const wid of available) {
      const profile = this.getWorkerProfile(wid);
      if (!profile) continue;

      let score = 0;

      // Bonus for strength in this task type
      if (profile.strengths.includes(taskType)) score += 40;
      // Bonus for preferred task
      if (profile.preferredTasks.includes(taskType)) score += 30;
      // Penalty for weakness
      if (profile.weaknesses.includes(taskType)) score -= 30;

      // General success rate contribution
      score += profile.overallSuccessRate * 20;
      // Quality contribution
      score += (profile.avgQuality / 10) * 10;

      // Current hour bonus
      const currentHour = new Date().getUTCHours();
      if (profile.bestHours.includes(currentHour)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestId = wid;
      }
    }

    log.info({ taskType, selectedWorker: bestId, score: bestScore }, 'Worker suggested for task');
    return bestId;
  }

  // --- Get strengths / weaknesses -----------------------------------------

  getStrengths(workerId: string): string[] {
    const profile = this.getWorkerProfile(workerId);
    return profile?.strengths ?? [];
  }

  getWeaknesses(workerId: string): string[] {
    const profile = this.getWorkerProfile(workerId);
    return profile?.weaknesses ?? [];
  }

  // --- Refresh all profiles from DB ---------------------------------------

  async refreshProfiles(): Promise<void> {
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT worker_id, task_type, success, duration_ms,
                  quality, concurrent_tasks, completed_at
           FROM meow_worker_profiles_log
           WHERE completed_at > NOW() - INTERVAL '60 days'
           ORDER BY completed_at DESC
           LIMIT $1`,
          [this.maxResults],
        );

        this.results = rows.map((r: Record<string, unknown>) => ({
          workerId: r.worker_id as string,
          taskType: r.task_type as string,
          success: r.success as boolean,
          durationMs: parseFloat(r.duration_ms as string),
          quality: r.quality != null ? parseFloat(r.quality as string) : undefined,
          concurrentTasks: r.concurrent_tasks != null
            ? parseInt(r.concurrent_tasks as string, 10)
            : undefined,
          completedAt: new Date(r.completed_at as string),
        }));

        log.info({ count: this.results.length }, 'Loaded worker results from DB');
      } catch (err) {
        log.warn({ err }, 'Failed to load worker results from DB');
      }
    }

    // Recompute all profiles
    const workerIds = new Set(this.results.map(r => r.workerId));
    for (const wid of workerIds) {
      this.recomputeProfile(wid);
    }

    broadcast('meow:cognitive', {
      type: 'worker_profiles_refreshed',
      workerCount: workerIds.size,
    });
  }

  // --- Private: recompute a single worker profile -------------------------

  private recomputeProfile(workerId: string): void {
    const workerResults = this.results.filter(r => r.workerId === workerId);
    if (workerResults.length === 0) return;

    // Aggregate by task type
    const taskStats = new Map<string, TaskTypeStats>();

    for (const r of workerResults) {
      if (!taskStats.has(r.taskType)) {
        taskStats.set(r.taskType, {
          taskType: r.taskType,
          total: 0,
          successes: 0,
          durations: [],
          qualities: [],
        });
      }
      const stats = taskStats.get(r.taskType)!;
      stats.total++;
      if (r.success) stats.successes++;
      stats.durations.push(r.durationMs);
      if (r.quality != null) stats.qualities.push(r.quality);
    }

    // Identify strengths (>90% success, min 3 executions)
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    for (const [taskType, stats] of taskStats) {
      if (stats.total < 3) continue;
      const successRate = stats.successes / stats.total;
      if (successRate >= 0.9) strengths.push(taskType);
      if (1 - successRate > 0.2) weaknesses.push(taskType);
    }

    // Preferred tasks: best composite (speed + quality)
    const taskScores: Array<{ taskType: string; score: number }> = [];
    for (const [taskType, stats] of taskStats) {
      if (stats.total < 2) continue;
      const avgDur = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
      const avgQual = stats.qualities.length > 0
        ? stats.qualities.reduce((a, b) => a + b, 0) / stats.qualities.length
        : 5;
      const successRate = stats.successes / stats.total;
      // Score: weight quality and speed
      const speed = Math.max(0, 1 - avgDur / 120_000); // normalize against 2 min
      const score = successRate * 40 + (avgQual / 10) * 30 + speed * 30;
      taskScores.push({ taskType, score });
    }
    taskScores.sort((a, b) => b.score - a.score);
    const preferredTasks = taskScores.slice(0, 5).map(t => t.taskType);

    // Optimal load: find concurrency level where quality starts dropping
    const optimalLoad = this.computeOptimalLoad(workerResults);

    // Best hours: group by hour, find top 3
    const bestHours = this.computeBestHours(workerResults);

    // Overall stats
    const totalSuccesses = workerResults.filter(r => r.success).length;
    const overallSuccessRate = Math.round((totalSuccesses / workerResults.length) * 1000) / 1000;
    const qualityValues = workerResults
      .filter(r => r.quality != null)
      .map(r => r.quality!);
    const avgQuality = qualityValues.length > 0
      ? Math.round((qualityValues.reduce((a, b) => a + b, 0) / qualityValues.length) * 10) / 10
      : 5;

    const profile: WorkerProfile = {
      workerId,
      strengths,
      weaknesses,
      preferredTasks,
      optimalLoad,
      bestHours,
      totalTasksCompleted: workerResults.length,
      overallSuccessRate,
      avgQuality,
      lastUpdatedAt: new Date(),
    };

    this.profiles.set(workerId, profile);
    this.profileDirty.delete(workerId);

    // Persist profile summary
    this.persistProfile(profile).catch(err =>
      log.warn({ err, workerId }, 'Failed to persist worker profile'),
    );
  }

  private computeOptimalLoad(results: TaskResult[]): number {
    // Group by concurrentTasks, measure avg quality
    const loadBuckets = new Map<number, { qualities: number[]; successes: number; total: number }>();

    for (const r of results) {
      const load = r.concurrentTasks ?? 1;
      if (!loadBuckets.has(load)) {
        loadBuckets.set(load, { qualities: [], successes: 0, total: 0 });
      }
      const bucket = loadBuckets.get(load)!;
      bucket.total++;
      if (r.success) bucket.successes++;
      if (r.quality != null) bucket.qualities.push(r.quality);
    }

    // Find the highest load where quality is still >70% of best
    const entries = Array.from(loadBuckets.entries()).sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return 3; // default

    let bestQuality = 0;
    for (const [, bucket] of entries) {
      if (bucket.qualities.length > 0) {
        const avg = bucket.qualities.reduce((a, b) => a + b, 0) / bucket.qualities.length;
        if (avg > bestQuality) bestQuality = avg;
      }
    }

    if (bestQuality === 0) return 3;

    let optimal = 1;
    for (const [load, bucket] of entries) {
      const avgQ = bucket.qualities.length > 0
        ? bucket.qualities.reduce((a, b) => a + b, 0) / bucket.qualities.length
        : bestQuality;
      const successRate = bucket.total > 0 ? bucket.successes / bucket.total : 1;
      if (avgQ >= bestQuality * 0.7 && successRate >= 0.7) {
        optimal = load;
      }
    }

    return optimal;
  }

  private computeBestHours(results: TaskResult[]): number[] {
    const hourStats = new Map<number, { successes: number; total: number; durations: number[] }>();

    for (const r of results) {
      const hour = r.completedAt.getUTCHours();
      if (!hourStats.has(hour)) {
        hourStats.set(hour, { successes: 0, total: 0, durations: [] });
      }
      const stats = hourStats.get(hour)!;
      stats.total++;
      if (r.success) stats.successes++;
      stats.durations.push(r.durationMs);
    }

    // Score each hour: success rate * speed
    const hourScores: Array<{ hour: number; score: number }> = [];
    for (const [hour, stats] of hourStats) {
      if (stats.total < 2) continue;
      const successRate = stats.successes / stats.total;
      const avgDur = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
      const speed = Math.max(0, 1 - avgDur / 120_000);
      hourScores.push({ hour, score: successRate * 60 + speed * 40 });
    }

    hourScores.sort((a, b) => b.score - a.score);
    return hourScores.slice(0, 3).map(h => h.hour);
  }

  private async persistResult(result: TaskResult): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_worker_profiles_log
          (id, worker_id, task_type, success, duration_ms, quality, concurrent_tasks, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuidv4(),
          result.workerId,
          result.taskType,
          result.success,
          result.durationMs,
          result.quality ?? null,
          result.concurrentTasks ?? null,
          result.completedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, workerId: result.workerId }, 'Failed to persist task result');
    }
  }

  private async persistProfile(profile: WorkerProfile): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_worker_profiles
          (worker_id, strengths, weaknesses, preferred_tasks, optimal_load,
           best_hours, total_tasks_completed, overall_success_rate, avg_quality, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (worker_id) DO UPDATE SET
           strengths = EXCLUDED.strengths,
           weaknesses = EXCLUDED.weaknesses,
           preferred_tasks = EXCLUDED.preferred_tasks,
           optimal_load = EXCLUDED.optimal_load,
           best_hours = EXCLUDED.best_hours,
           total_tasks_completed = EXCLUDED.total_tasks_completed,
           overall_success_rate = EXCLUDED.overall_success_rate,
           avg_quality = EXCLUDED.avg_quality,
           updated_at = EXCLUDED.updated_at`,
        [
          profile.workerId,
          JSON.stringify(profile.strengths),
          JSON.stringify(profile.weaknesses),
          JSON.stringify(profile.preferredTasks),
          profile.optimalLoad,
          JSON.stringify(profile.bestHours),
          profile.totalTasksCompleted,
          profile.overallSuccessRate,
          profile.avgQuality,
          profile.lastUpdatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, workerId: profile.workerId }, 'Failed to persist worker profile summary');
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: WorkerPerformanceLearner | null = null;

export function getWorkerPerformanceLearner(): WorkerPerformanceLearner {
  if (!instance) {
    instance = new WorkerPerformanceLearner();
  }
  return instance;
}
