/**
 * SKILL PERFORMANCE RANKING -- CG-006 (Stage 05 Wave 2)
 *
 * Skills ranked by real performance metrics.
 * Tracks per-skill: success_rate, avg_latency, cost_efficiency,
 * output_quality, reliability.
 *
 * Composite ranking = weighted aggregate.
 * Auto-prefer better-performing skills for similar tasks.
 * Persists metrics to meow_skill_metrics table.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-performance-ranking');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillExecution {
  skillName: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  outputQuality?: number;     // 1-10 (AI-scored or manual)
  taskType?: string;
  recordedAt: Date;
}

export interface SkillMetrics {
  skillName: string;
  successRate: number;        // 0.0 - 1.0
  avgLatencyMs: number;
  p95LatencyMs: number;
  costEfficiency: number;     // quality per dollar (higher = better)
  avgOutputQuality: number;   // 1-10
  reliability: number;        // 0.0 - 1.0 (uptime consistency)
  executionCount: number;
  lastExecutedAt: Date | null;
}

export interface SkillRanking {
  rank: number;
  skillName: string;
  compositeScore: number;     // 0-100
  metrics: SkillMetrics;
}

// Weighting for composite score
const WEIGHTS = {
  successRate: 0.30,
  latencyScore: 0.15,
  costEfficiency: 0.15,
  outputQuality: 0.25,
  reliability: 0.15,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function normalizeLatency(avgMs: number): number {
  // Lower latency = higher score. Cap at 60s for normalization.
  const maxMs = 60_000;
  return Math.max(0, Math.min(1, 1 - avgMs / maxMs));
}

function normalizeCostEfficiency(ce: number): number {
  // Scale cost efficiency into 0-1. Cap at 100 for normalization.
  return Math.min(1, ce / 100);
}

function normalizeQuality(q: number): number {
  // Quality is 1-10, normalize to 0-1
  return Math.max(0, Math.min(1, (q - 1) / 9));
}

// ---------------------------------------------------------------------------
// SkillPerformanceRanker
// ---------------------------------------------------------------------------

export class SkillPerformanceRanker {
  private executions: SkillExecution[] = [];
  private rankings: SkillRanking[] = [];
  private metricsCache = new Map<string, SkillMetrics>();
  private taskTypeMap = new Map<string, string[]>(); // taskType -> skillName[]
  private maxExecutions = 10_000;

  // --- Record a skill execution -------------------------------------------

  async recordExecution(
    skillName: string,
    success: boolean,
    durationMs: number,
    costUsd: number,
    outputQuality?: number,
    taskType?: string,
  ): Promise<void> {
    const exec: SkillExecution = {
      skillName,
      success,
      durationMs,
      costUsd,
      outputQuality,
      taskType,
      recordedAt: new Date(),
    };

    this.executions.push(exec);
    if (this.executions.length > this.maxExecutions) {
      this.executions = this.executions.slice(-this.maxExecutions);
    }

    // Update task type mapping
    if (taskType) {
      if (!this.taskTypeMap.has(taskType)) this.taskTypeMap.set(taskType, []);
      const list = this.taskTypeMap.get(taskType)!;
      if (!list.includes(skillName)) list.push(skillName);
    }

    // Invalidate cache for this skill
    this.metricsCache.delete(skillName);

    // Persist to DB
    await this.persistExecution(exec);

    broadcast('meow:cognitive', {
      type: 'skill_execution_recorded',
      skillName,
      success,
      durationMs,
      costUsd,
    });
  }

  // --- Get rankings -------------------------------------------------------

  getRankings(): SkillRanking[] {
    if (this.rankings.length === 0) {
      this.computeRankingsSync();
    }
    return [...this.rankings];
  }

  // --- Get best skill for a task type -------------------------------------

  getBestSkillFor(taskType: string): string | null {
    const candidates = this.taskTypeMap.get(taskType);
    if (!candidates || candidates.length === 0) return null;

    let best: string | null = null;
    let bestScore = -1;

    for (const skill of candidates) {
      const metrics = this.getSkillMetrics(skill);
      if (!metrics) continue;
      const score = this.computeComposite(metrics);
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }

    return best;
  }

  // --- Get metrics for a specific skill -----------------------------------

  getSkillMetrics(skillName: string): SkillMetrics | null {
    if (this.metricsCache.has(skillName)) {
      return this.metricsCache.get(skillName)!;
    }

    const execs = this.executions.filter(e => e.skillName === skillName);
    if (execs.length === 0) return null;

    const successCount = execs.filter(e => e.success).length;
    const successRate = successCount / execs.length;

    const durations = execs.map(e => e.durationMs).sort((a, b) => a - b);
    const avgLatencyMs = Math.round(
      durations.reduce((a, b) => a + b, 0) / durations.length,
    );
    const p95LatencyMs = Math.round(percentile(durations, 95));

    // Cost efficiency: avg quality per dollar
    const qualityExecs = execs.filter(e => e.outputQuality != null && e.costUsd > 0);
    const costEfficiency = qualityExecs.length > 0
      ? qualityExecs.reduce((s, e) => s + (e.outputQuality! / e.costUsd), 0) / qualityExecs.length
      : 0;

    // Average output quality
    const qualityValues = execs
      .filter(e => e.outputQuality != null)
      .map(e => e.outputQuality!);
    const avgOutputQuality = qualityValues.length > 0
      ? qualityValues.reduce((a, b) => a + b, 0) / qualityValues.length
      : 5; // default middle score

    // Reliability: consistency of success over recent windows
    const windows = this.computeReliability(execs);

    const lastExec = execs[execs.length - 1];

    const metrics: SkillMetrics = {
      skillName,
      successRate: Math.round(successRate * 1000) / 1000,
      avgLatencyMs,
      p95LatencyMs,
      costEfficiency: Math.round(costEfficiency * 100) / 100,
      avgOutputQuality: Math.round(avgOutputQuality * 10) / 10,
      reliability: Math.round(windows * 1000) / 1000,
      executionCount: execs.length,
      lastExecutedAt: lastExec?.recordedAt ?? null,
    };

    this.metricsCache.set(skillName, metrics);
    return metrics;
  }

  // --- Refresh rankings from DB -------------------------------------------

  async refreshRankings(): Promise<void> {
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT skill_name, success, duration_ms, cost_usd,
                  output_quality, task_type, recorded_at
           FROM meow_skill_metrics
           WHERE recorded_at > NOW() - INTERVAL '30 days'
           ORDER BY recorded_at DESC
           LIMIT $1`,
          [this.maxExecutions],
        );

        this.executions = rows.map((r: Record<string, unknown>) => ({
          skillName: r.skill_name as string,
          success: r.success as boolean,
          durationMs: parseFloat(r.duration_ms as string),
          costUsd: parseFloat(r.cost_usd as string),
          outputQuality: r.output_quality != null ? parseFloat(r.output_quality as string) : undefined,
          taskType: (r.task_type as string) ?? undefined,
          recordedAt: new Date(r.recorded_at as string),
        }));

        // Rebuild task type map
        this.taskTypeMap.clear();
        for (const exec of this.executions) {
          if (exec.taskType) {
            if (!this.taskTypeMap.has(exec.taskType)) this.taskTypeMap.set(exec.taskType, []);
            const list = this.taskTypeMap.get(exec.taskType)!;
            if (!list.includes(exec.skillName)) list.push(exec.skillName);
          }
        }

        log.info({ count: this.executions.length }, 'Loaded skill executions from DB');
      } catch (err) {
        log.warn({ err }, 'Failed to load skill executions from DB');
      }
    }

    this.metricsCache.clear();
    this.computeRankingsSync();

    broadcast('meow:cognitive', {
      type: 'skill_rankings_refreshed',
      count: this.rankings.length,
    });
  }

  // --- Private helpers ----------------------------------------------------

  private computeRankingsSync(): void {
    const skillNames = new Set(this.executions.map(e => e.skillName));
    const ranked: SkillRanking[] = [];

    for (const name of skillNames) {
      const metrics = this.getSkillMetrics(name);
      if (!metrics || metrics.executionCount < 2) continue;

      const composite = this.computeComposite(metrics);
      ranked.push({ rank: 0, skillName: name, compositeScore: composite, metrics });
    }

    ranked.sort((a, b) => b.compositeScore - a.compositeScore);
    ranked.forEach((r, i) => (r.rank = i + 1));

    this.rankings = ranked;
  }

  private computeComposite(m: SkillMetrics): number {
    const score =
      WEIGHTS.successRate * m.successRate +
      WEIGHTS.latencyScore * normalizeLatency(m.avgLatencyMs) +
      WEIGHTS.costEfficiency * normalizeCostEfficiency(m.costEfficiency) +
      WEIGHTS.outputQuality * normalizeQuality(m.avgOutputQuality) +
      WEIGHTS.reliability * m.reliability;

    return Math.round(score * 10000) / 100; // 0-100
  }

  private computeReliability(execs: SkillExecution[]): number {
    // Split into 5 windows and measure consistency of success rate
    if (execs.length < 5) return execs.filter(e => e.success).length / Math.max(execs.length, 1);

    const windowSize = Math.ceil(execs.length / 5);
    const rates: number[] = [];

    for (let i = 0; i < execs.length; i += windowSize) {
      const window = execs.slice(i, i + windowSize);
      const wSuccess = window.filter(e => e.success).length;
      rates.push(wSuccess / window.length);
    }

    // Reliability = 1 - coefficient of variation of success rates
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    if (mean === 0) return 0;
    const variance = rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length;
    const cv = Math.sqrt(variance) / mean;

    return Math.max(0, Math.min(1, 1 - cv));
  }

  private async persistExecution(exec: SkillExecution): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_skill_metrics
          (id, skill_name, success, duration_ms, cost_usd, output_quality, task_type, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuidv4(),
          exec.skillName,
          exec.success,
          exec.durationMs,
          exec.costUsd,
          exec.outputQuality ?? null,
          exec.taskType ?? null,
          exec.recordedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, skillName: exec.skillName }, 'Failed to persist skill execution');
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: SkillPerformanceRanker | null = null;

export function getSkillPerformanceRanker(): SkillPerformanceRanker {
  if (!instance) {
    instance = new SkillPerformanceRanker();
  }
  return instance;
}
