/**
 * PERFORMANCE BASELINES — LP-037 (Stage 04 Wave 8)
 *
 * Computes and monitors baseline metrics from historical data.
 * Alerts when metrics deviate >2 standard deviations from baseline.
 * Baselines recomputed daily at 00:00 UTC.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BaselineMetric {
  name: string;
  mean: number;
  stddev: number;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
  computedAt: Date;
}

export interface BaselineMetrics {
  moleculeDurationByFormula: Map<string, BaselineMetric>;
  stepLatency: BaselineMetric;
  gateFailureRate: BaselineMetric;
  workerIdlePct: BaselineMetric;
  skillSuccessRate: BaselineMetric;
  errorRateByType: Map<string, BaselineMetric>;
  computedAt: Date;
}

export interface Deviation {
  metricName: string;
  currentValue: number;
  baselineMean: number;
  baselineStddev: number;
  deviationSigma: number;   // How many sigma from the mean
  direction: 'above' | 'below';
  severity: 'warning' | 'critical';
  detectedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(values: number[]): Omit<BaselineMetric, 'name' | 'computedAt'> {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, p50: 0, p95: 0, p99: 0, sampleCount: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;

  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  const percentile = (p: number): number => {
    const idx = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, idx)];
  };

  return {
    mean: Math.round(mean * 100) / 100,
    stddev: Math.round(stddev * 100) / 100,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    sampleCount: n,
  };
}

function makeMetric(name: string, values: number[]): BaselineMetric {
  return { name, ...computeStats(values), computedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// PerformanceBaselines
// ─────────────────────────────────────────────────────────────────────────────

export class PerformanceBaselines {
  private baselines: BaselineMetrics | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private deviationThreshold: number;
  private criticalThreshold: number;

  constructor(deviationThreshold = 2, criticalThreshold = 3) {
    this.deviationThreshold = deviationThreshold;
    this.criticalThreshold = criticalThreshold;
  }

  // ─── Compute baselines from DB ───────────────────────────────────────

  async computeBaselines(): Promise<BaselineMetrics> {
    const pool = getPool();
    const now = new Date();

    const moleculeDurationByFormula = new Map<string, BaselineMetric>();
    let stepLatencyValues: number[] = [];
    let gateFailureValues: number[] = [];
    let workerIdleValues: number[] = [];
    let skillSuccessValues: number[] = [];
    const errorRateByType = new Map<string, BaselineMetric>();

    if (pool) {
      try {
        // Molecule durations by formula (last 7 days)
        const molRes = await pool.query(
          `SELECT formula_id, EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS dur_ms
           FROM meow_molecules
           WHERE completed_at IS NOT NULL AND started_at > NOW() - INTERVAL '7 days'`,
        );
        const byFormula = new Map<string, number[]>();
        for (const row of molRes.rows) {
          const fid = row.formula_id as string;
          if (!byFormula.has(fid)) byFormula.set(fid, []);
          byFormula.get(fid)!.push(parseFloat(row.dur_ms));
        }
        for (const [fid, vals] of byFormula) {
          moleculeDurationByFormula.set(fid, makeMetric(`molecule_duration:${fid}`, vals));
        }

        // Step latency
        const stepRes = await pool.query(
          `SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS lat_ms
           FROM meow_steps
           WHERE completed_at IS NOT NULL AND started_at > NOW() - INTERVAL '7 days'`,
        );
        stepLatencyValues = stepRes.rows.map((r: Record<string, unknown>) => parseFloat(r.lat_ms as string));

        // Gate failure rate (percentage of gate failures per day)
        const gateRes = await pool.query(
          `SELECT DATE(created_at) AS d,
                  COUNT(*) FILTER (WHERE status = 'rejected') * 100.0 / GREATEST(COUNT(*), 1) AS fail_pct
           FROM meow_gates
           WHERE created_at > NOW() - INTERVAL '7 days'
           GROUP BY DATE(created_at)`,
        );
        gateFailureValues = gateRes.rows.map((r: Record<string, unknown>) => parseFloat(r.fail_pct as string));

        // Worker idle percentage
        const workerRes = await pool.query(
          `SELECT worker_id,
                  COALESCE(idle_pct, 0) AS idle_pct
           FROM meow_worker_stats
           WHERE recorded_at > NOW() - INTERVAL '7 days'`,
        );
        workerIdleValues = workerRes.rows.map((r: Record<string, unknown>) => parseFloat(r.idle_pct as string));

        // Skill success rate
        const skillRes = await pool.query(
          `SELECT DATE(executed_at) AS d,
                  COUNT(*) FILTER (WHERE status = 'success') * 100.0 / GREATEST(COUNT(*), 1) AS success_pct
           FROM meow_skill_executions
           WHERE executed_at > NOW() - INTERVAL '7 days'
           GROUP BY DATE(executed_at)`,
        );
        skillSuccessValues = skillRes.rows.map((r: Record<string, unknown>) => parseFloat(r.success_pct as string));

        // Error rate by type
        const errRes = await pool.query(
          `SELECT error_class, COUNT(*) AS cnt
           FROM meow_errors
           WHERE created_at > NOW() - INTERVAL '7 days'
           GROUP BY error_class`,
        );
        for (const row of errRes.rows) {
          const cls = row.error_class as string;
          errorRateByType.set(cls, makeMetric(`error_rate:${cls}`, [parseInt(row.cnt as string)]));
        }
      } catch (err) {
        console.error('[PerformanceBaselines] DB query failed, using empty baselines:', err);
      }
    }

    this.baselines = {
      moleculeDurationByFormula,
      stepLatency: makeMetric('step_latency', stepLatencyValues),
      gateFailureRate: makeMetric('gate_failure_rate', gateFailureValues),
      workerIdlePct: makeMetric('worker_idle_pct', workerIdleValues),
      skillSuccessRate: makeMetric('skill_success_rate', skillSuccessValues),
      errorRateByType,
      computedAt: now,
    };

    console.info('[PerformanceBaselines] Baselines computed at', now.toISOString());
    broadcast('meow:baselines', { type: 'baselines_computed', timestamp: now.toISOString() });

    return this.baselines;
  }

  // ─── Check deviations ────────────────────────────────────────────────

  async checkDeviations(): Promise<Deviation[]> {
    if (!this.baselines) {
      await this.computeBaselines();
    }
    if (!this.baselines) return [];

    const deviations: Deviation[] = [];
    const pool = getPool();
    if (!pool) return deviations;

    try {
      // Check step latency (last 15 min vs baseline)
      const recentSteps = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS lat_ms
         FROM meow_steps
         WHERE completed_at IS NOT NULL AND started_at > NOW() - INTERVAL '15 minutes'`,
      );

      if (recentSteps.rows.length > 0) {
        const recentMean = recentSteps.rows
          .map((r: Record<string, unknown>) => parseFloat(r.lat_ms as string))
          .reduce((s: number, v: number) => s + v, 0) / recentSteps.rows.length;

        const deviation = this.checkSingleDeviation(
          'step_latency',
          recentMean,
          this.baselines.stepLatency,
        );
        if (deviation) deviations.push(deviation);
      }

      // Check gate failure rate (last hour)
      const recentGates = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'rejected') * 100.0 / GREATEST(COUNT(*), 1) AS fail_pct
         FROM meow_gates
         WHERE created_at > NOW() - INTERVAL '1 hour'`,
      );

      if (recentGates.rows.length > 0) {
        const failPct = parseFloat(recentGates.rows[0].fail_pct);
        const deviation = this.checkSingleDeviation(
          'gate_failure_rate',
          failPct,
          this.baselines.gateFailureRate,
        );
        if (deviation) deviations.push(deviation);
      }
    } catch (err) {
      console.error('[PerformanceBaselines] Deviation check failed:', err);
    }

    // Broadcast deviations
    if (deviations.length > 0) {
      broadcast('meow:alert', {
        type: 'performance_deviation',
        deviations: deviations.map(d => ({
          metric: d.metricName,
          current: d.currentValue,
          mean: d.baselineMean,
          sigma: d.deviationSigma,
          severity: d.severity,
        })),
      });
    }

    return deviations;
  }

  private checkSingleDeviation(
    metricName: string,
    currentValue: number,
    baseline: BaselineMetric,
  ): Deviation | null {
    if (baseline.stddev === 0 || baseline.sampleCount < 5) return null;

    const sigma = Math.abs(currentValue - baseline.mean) / baseline.stddev;
    if (sigma < this.deviationThreshold) return null;

    return {
      metricName,
      currentValue: Math.round(currentValue * 100) / 100,
      baselineMean: baseline.mean,
      baselineStddev: baseline.stddev,
      deviationSigma: Math.round(sigma * 100) / 100,
      direction: currentValue > baseline.mean ? 'above' : 'below',
      severity: sigma >= this.criticalThreshold ? 'critical' : 'warning',
      detectedAt: new Date(),
    };
  }

  // ─── Getters ─────────────────────────────────────────────────────────

  getBaseline(metricName: string): BaselineMetric | null {
    if (!this.baselines) return null;

    if (metricName === 'step_latency') return this.baselines.stepLatency;
    if (metricName === 'gate_failure_rate') return this.baselines.gateFailureRate;
    if (metricName === 'worker_idle_pct') return this.baselines.workerIdlePct;
    if (metricName === 'skill_success_rate') return this.baselines.skillSuccessRate;

    if (metricName.startsWith('molecule_duration:')) {
      const formulaId = metricName.split(':')[1];
      return this.baselines.moleculeDurationByFormula.get(formulaId) ?? null;
    }
    if (metricName.startsWith('error_rate:')) {
      const errClass = metricName.split(':')[1];
      return this.baselines.errorRateByType.get(errClass) ?? null;
    }

    return null;
  }

  // ─── Monitor lifecycle ───────────────────────────────────────────────

  startBaselineMonitor(checkIntervalMs = 5 * 60_000): void {
    if (this.monitorTimer) return;
    console.info(`[PerformanceBaselines] Monitor started (interval: ${checkIntervalMs}ms)`);

    // Initial computation
    this.computeBaselines().catch(err =>
      console.error('[PerformanceBaselines] Initial baseline computation failed:', err),
    );

    this.monitorTimer = setInterval(async () => {
      try {
        await this.checkDeviations();
      } catch (err) {
        console.error('[PerformanceBaselines] Monitor check failed:', err);
      }
    }, checkIntervalMs);
  }

  stopBaselineMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
      console.info('[PerformanceBaselines] Monitor stopped');
    }
  }

  isMonitorRunning(): boolean {
    return this.monitorTimer !== null;
  }
}
