/**
 * DRIFT DETECTION — CG-020 (Stage 05 Wave 5)
 *
 * Detects when system behavior drifts from expected baselines.
 * Compares current metrics against learned baselines using statistical
 * methods (rolling mean, std dev, CUSUM change detection).
 * AI-powered root cause analysis when drift is detected.
 *
 * Drift types:
 *   - Latency drift: step/molecule execution times changing
 *   - Quality drift: output quality scores degrading
 *   - Cost drift: per-molecule costs increasing
 *   - Error rate drift: failure rates climbing
 *   - Throughput drift: molecules/hour changing
 *
 * Alert escalation:
 *   minor → log only
 *   significant → SSE alert
 *   critical → WhatsApp notification
 *
 * Gas Town: "When the road shifts under you, adapt or crash."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('drift-detection');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DriftMetricType =
  | 'latency'
  | 'quality'
  | 'cost'
  | 'error_rate'
  | 'throughput';

export type DriftSeverity = 'minor' | 'significant' | 'critical';

export type DriftDirection = 'increasing' | 'decreasing';

export interface MetricBaseline {
  metricType: DriftMetricType;
  metricName: string;                 // e.g. 'step_latency', 'cost_per_molecule'
  mean: number;
  stddev: number;
  rollingMean: number;                // recent rolling window mean
  sampleCount: number;
  computedAt: Date;
}

export interface DriftEvent {
  id: string;
  metricType: DriftMetricType;
  metricName: string;
  currentValue: number;
  baselineMean: number;
  baselineStddev: number;
  deviationSigma: number;            // how many sigma from mean
  cusumValue: number;                 // CUSUM statistic
  direction: DriftDirection;
  severity: DriftSeverity;
  aiRootCause?: string;               // AI-generated hypothesis
  correctiveAction?: string;           // recommended action
  acknowledged: boolean;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface CusumState {
  metricName: string;
  sPlus: number;                      // positive CUSUM
  sMinus: number;                     // negative CUSUM
  targetMean: number;                 // reference (baseline) mean
  allowance: number;                  // slack parameter (k)
  threshold: number;                  // decision interval (h)
  lastUpdated: Date;
}

export interface DriftDetectionConfig {
  scanIntervalMs: number;             // how often to check (default 120s)
  sigmaWarning: number;               // sigma for significant drift (default 2.0)
  sigmaCritical: number;              // sigma for critical drift (default 3.0)
  cusumAllowance: number;             // CUSUM k parameter (default 0.5)
  cusumThreshold: number;             // CUSUM h parameter (default 5.0)
  rollingWindowSize: number;          // samples in rolling window (default 50)
  minSamplesForBaseline: number;      // minimum samples before detecting (default 20)
  enableAiAnalysis: boolean;          // use Gemini for root cause (default true)
  seasonalAdjustment: boolean;        // adjust for day-of-week patterns (default true)
  sensitivityOverrides: Map<DriftMetricType, { sigmaWarning: number; sigmaCritical: number }>;
}

export interface DriftReport {
  activeAlerts: DriftEvent[];
  totalDriftsDetected: number;
  driftsByType: Record<DriftMetricType, number>;
  driftsBySeverity: Record<DriftSeverity, number>;
  baselines: MetricBaseline[];
  cusumStates: CusumState[];
  avgDetectionLatencyMs: number;
  generatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DriftDetectionConfig = {
  scanIntervalMs: 120_000,            // 2 minutes
  sigmaWarning: 2.0,
  sigmaCritical: 3.0,
  cusumAllowance: 0.5,
  cusumThreshold: 5.0,
  rollingWindowSize: 50,
  minSamplesForBaseline: 20,
  enableAiAnalysis: true,
  seasonalAdjustment: true,
  sensitivityOverrides: new Map(),
};

/** Day-of-week load multipliers (approximate, refined by learning) */
const DEFAULT_DOW_FACTORS: Record<number, number> = {
  0: 0.6,  // Sunday
  1: 1.0,  // Monday
  2: 1.0,  // Tuesday
  3: 1.0,  // Wednesday
  4: 1.0,  // Thursday
  5: 0.9,  // Friday
  6: 0.7,  // Saturday
};

/** Hour-of-day load multipliers (UTC) */
const DEFAULT_HOUR_FACTORS: Record<number, number> = {
  0: 0.4, 1: 0.3, 2: 0.3, 3: 0.3, 4: 0.4, 5: 0.5,
  6: 0.6, 7: 0.7, 8: 0.8, 9: 0.9, 10: 1.0, 11: 1.0,
  12: 1.0, 13: 1.1, 14: 1.1, 15: 1.0, 16: 1.0, 17: 0.9,
  18: 0.8, 19: 0.7, 20: 0.6, 21: 0.5, 22: 0.5, 23: 0.4,
};

const MAX_EVENTS_IN_MEMORY = 3_000;
const METRIC_DEFINITIONS: Array<{
  type: DriftMetricType;
  name: string;
  query: string;
  higherIsBetter: boolean;
}> = [
  {
    type: 'latency',
    name: 'step_latency_ms',
    query: `SELECT EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 AS val
            FROM meow_steps
            WHERE completed_at IS NOT NULL AND started_at > NOW() - INTERVAL '15 minutes'`,
    higherIsBetter: false,
  },
  {
    type: 'latency',
    name: 'molecule_duration_ms',
    query: `SELECT EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS val
            FROM molecules
            WHERE completed_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 minutes'
              AND status IN ('completed', 'failed')`,
    higherIsBetter: false,
  },
  {
    type: 'error_rate',
    name: 'error_rate_pct',
    query: `SELECT COUNT(*) FILTER (WHERE status = 'failed') * 100.0 / GREATEST(COUNT(*), 1) AS val
            FROM molecules
            WHERE created_at > NOW() - INTERVAL '1 hour'`,
    higherIsBetter: false,
  },
  {
    type: 'throughput',
    name: 'molecules_per_hour',
    query: `SELECT COUNT(*) AS val
            FROM molecules
            WHERE completed_at IS NOT NULL AND completed_at > NOW() - INTERVAL '1 hour'`,
    higherIsBetter: true,
  },
  {
    type: 'cost',
    name: 'cost_per_molecule_usd',
    query: `SELECT AVG(cost_usd) AS val
            FROM meow_cost_tracking
            WHERE created_at > NOW() - INTERVAL '1 hour'`,
    higherIsBetter: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DriftDetector
// ─────────────────────────────────────────────────────────────────────────────

export class DriftDetector {
  private config: DriftDetectionConfig;
  private baselines = new Map<string, MetricBaseline>();
  private cusumStates = new Map<string, CusumState>();
  private rollingWindows = new Map<string, number[]>();
  private events: DriftEvent[] = [];
  private scanTimer: NodeJS.Timeout | null = null;
  private totalDrifts = 0;
  private driftsByType: Record<DriftMetricType, number> = {
    latency: 0,
    quality: 0,
    cost: 0,
    error_rate: 0,
    throughput: 0,
  };
  private driftsBySeverity: Record<DriftSeverity, number> = {
    minor: 0,
    significant: 0,
    critical: 0,
  };

  constructor(config?: Partial<DriftDetectionConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      sensitivityOverrides: config?.sensitivityOverrides ?? new Map(),
    };
  }

  // ─── Compute baselines from historical data ────────────────────────

  async computeBaselines(): Promise<MetricBaseline[]> {
    const pool = getPool();
    if (!pool) return [];

    const computed: MetricBaseline[] = [];

    for (const metric of METRIC_DEFINITIONS) {
      try {
        // Get historical data for baseline (last 7 days)
        const historicalQuery = metric.query.replace(
          /NOW\(\) - INTERVAL '[^']+'/g,
          "NOW() - INTERVAL '7 days'",
        );

        const { rows } = await pool.query(historicalQuery);

        const values = rows
          .map((r: Record<string, unknown>) => parseFloat(r.val as string))
          .filter((v: number) => !isNaN(v) && isFinite(v));

        if (values.length < this.config.minSamplesForBaseline) {
          log.debug({ metric: metric.name, samples: values.length }, 'Insufficient data for baseline');
          continue;
        }

        const stats = this.computeStats(values);
        const baseline: MetricBaseline = {
          metricType: metric.type,
          metricName: metric.name,
          mean: stats.mean,
          stddev: stats.stddev,
          rollingMean: stats.mean,
          sampleCount: values.length,
          computedAt: new Date(),
        };

        this.baselines.set(metric.name, baseline);
        computed.push(baseline);

        // Initialize CUSUM state
        this.cusumStates.set(metric.name, {
          metricName: metric.name,
          sPlus: 0,
          sMinus: 0,
          targetMean: stats.mean,
          allowance: this.config.cusumAllowance * stats.stddev,
          threshold: this.config.cusumThreshold * stats.stddev,
          lastUpdated: new Date(),
        });

        // Initialize rolling window
        this.rollingWindows.set(metric.name, values.slice(-this.config.rollingWindowSize));
      } catch (err) {
        log.error({ err, metric: metric.name }, 'Failed to compute baseline');
      }
    }

    log.info({ baselines: computed.length }, 'Drift detection baselines computed');

    broadcast('meow:cognitive', {
      type: 'drift_baselines_computed',
      count: computed.length,
      metrics: computed.map(b => b.metricName),
      timestamp: new Date().toISOString(),
    });

    return computed;
  }

  // ─── Run drift scan ────────────────────────────────────────────────

  async scan(): Promise<DriftEvent[]> {
    const pool = getPool();
    if (!pool) return [];

    if (this.baselines.size === 0) {
      await this.computeBaselines();
      if (this.baselines.size === 0) return [];
    }

    const detectedDrifts: DriftEvent[] = [];

    for (const metric of METRIC_DEFINITIONS) {
      const baseline = this.baselines.get(metric.name);
      if (!baseline || baseline.stddev === 0) continue;

      try {
        const { rows } = await pool.query(metric.query);

        const values = rows
          .map((r: Record<string, unknown>) => parseFloat(r.val as string))
          .filter((v: number) => !isNaN(v) && isFinite(v));

        if (values.length === 0) continue;

        const currentMean = values.reduce((s, v) => s + v, 0) / values.length;

        // Apply seasonal adjustment
        let adjustedMean = currentMean;
        if (this.config.seasonalAdjustment) {
          adjustedMean = this.applySeasonalAdjustment(currentMean, metric.type);
        }

        // Update rolling window
        const window = this.rollingWindows.get(metric.name) ?? [];
        window.push(...values);
        while (window.length > this.config.rollingWindowSize) {
          window.shift();
        }
        this.rollingWindows.set(metric.name, window);

        // Update rolling mean
        baseline.rollingMean = window.reduce((s, v) => s + v, 0) / window.length;

        // Method 1: Sigma-based deviation
        const sigma = Math.abs(adjustedMean - baseline.mean) / baseline.stddev;

        // Method 2: CUSUM change detection
        const cusumDrift = this.updateCusum(metric.name, adjustedMean);

        // Determine severity
        const thresholds = this.getSensitivity(metric.type);
        let severity: DriftSeverity | null = null;

        if (sigma >= thresholds.sigmaCritical || cusumDrift.alarm) {
          severity = 'critical';
        } else if (sigma >= thresholds.sigmaWarning) {
          severity = 'significant';
        } else if (sigma >= thresholds.sigmaWarning * 0.75) {
          severity = 'minor';
        }

        if (!severity) continue;

        // Direction
        const direction: DriftDirection = adjustedMean > baseline.mean ? 'increasing' : 'decreasing';

        // For "higher is better" metrics, decreasing is bad
        const isBadDrift = metric.higherIsBetter
          ? direction === 'decreasing'
          : direction === 'increasing';

        // Only alert on bad drifts (performance degradation)
        if (!isBadDrift && severity === 'minor') continue;

        // AI root cause analysis for significant+ drift
        let aiRootCause: string | undefined;
        let correctiveAction: string | undefined;
        if (this.config.enableAiAnalysis && severity !== 'minor') {
          const analysis = await this.getAiRootCauseAnalysis(metric, baseline, adjustedMean, sigma, direction);
          aiRootCause = analysis.rootCause;
          correctiveAction = analysis.action;
        }

        // Heuristic corrective action fallback
        if (!correctiveAction) {
          correctiveAction = this.getHeuristicAction(metric.type, direction, severity);
        }

        const event: DriftEvent = {
          id: uuidv4(),
          metricType: metric.type,
          metricName: metric.name,
          currentValue: Math.round(adjustedMean * 100) / 100,
          baselineMean: baseline.mean,
          baselineStddev: baseline.stddev,
          deviationSigma: Math.round(sigma * 100) / 100,
          cusumValue: Math.round(Math.max(cusumDrift.sPlus, cusumDrift.sMinus) * 100) / 100,
          direction,
          severity,
          aiRootCause,
          correctiveAction,
          acknowledged: false,
          createdAt: new Date(),
        };

        detectedDrifts.push(event);
        this.events.push(event);

        // Stats tracking
        this.totalDrifts += 1;
        this.driftsByType[metric.type] = (this.driftsByType[metric.type] ?? 0) + 1;
        this.driftsBySeverity[severity] = (this.driftsBySeverity[severity] ?? 0) + 1;

        // Persist
        await this.persistEvent(event);

        // Alert based on severity
        await this.escalateAlert(event);

      } catch (err) {
        log.error({ err, metric: metric.name }, 'Failed to check metric for drift');
      }
    }

    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    if (detectedDrifts.length > 0) {
      log.info({ drifts: detectedDrifts.length }, 'Drift scan found issues');
    }

    return detectedDrifts;
  }

  // ─── Acknowledge a drift event ─────────────────────────────────────

  async acknowledgeDrift(eventId: string): Promise<void> {
    const event = this.events.find(e => e.id === eventId);
    if (event) {
      event.acknowledged = true;
      event.resolvedAt = new Date();
    }

    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE meow_drift_events SET acknowledged = true, resolved_at = NOW() WHERE id = $1`,
          [eventId],
        );
      } catch (err) {
        log.error({ err, eventId }, 'Failed to acknowledge drift event in DB');
      }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  startMonitor(): void {
    if (this.scanTimer) return;
    log.info({ intervalMs: this.config.scanIntervalMs }, 'Drift detection monitor started');

    // Initial baseline computation
    this.computeBaselines().catch(err =>
      log.error({ err }, 'Initial baseline computation failed'),
    );

    this.scanTimer = setInterval(async () => {
      try {
        await this.scan();
      } catch (err) {
        log.error({ err }, 'Drift scan tick failed');
      }
    }, this.config.scanIntervalMs);
  }

  stopMonitor(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      log.info('Drift detection monitor stopped');
    }
  }

  isMonitorRunning(): boolean {
    return this.scanTimer !== null;
  }

  // ─── Report ────────────────────────────────────────────────────────

  getReport(): DriftReport {
    const activeAlerts = this.events.filter(e => !e.acknowledged);

    return {
      activeAlerts,
      totalDriftsDetected: this.totalDrifts,
      driftsByType: { ...this.driftsByType },
      driftsBySeverity: { ...this.driftsBySeverity },
      baselines: Array.from(this.baselines.values()),
      cusumStates: Array.from(this.cusumStates.values()),
      avgDetectionLatencyMs: 0, // TODO: track scan duration
      generatedAt: new Date(),
    };
  }

  getActiveAlerts(): DriftEvent[] {
    return this.events.filter(e => !e.acknowledged);
  }

  getBaseline(metricName: string): MetricBaseline | null {
    return this.baselines.get(metricName) ?? null;
  }

  // ─── Internal: CUSUM change detection ──────────────────────────────

  private updateCusum(
    metricName: string,
    observedValue: number,
  ): { sPlus: number; sMinus: number; alarm: boolean } {
    let state = this.cusumStates.get(metricName);
    if (!state) {
      return { sPlus: 0, sMinus: 0, alarm: false };
    }

    // CUSUM update equations:
    // S+ = max(0, S+ + (x - mu0 - k))
    // S- = max(0, S- - (x - mu0 + k))
    const deviation = observedValue - state.targetMean;
    state.sPlus = Math.max(0, state.sPlus + deviation - state.allowance);
    state.sMinus = Math.max(0, state.sMinus - deviation - state.allowance);
    state.lastUpdated = new Date();

    const alarm = state.sPlus > state.threshold || state.sMinus > state.threshold;

    // Reset after alarm
    if (alarm) {
      log.warn({ metricName, sPlus: state.sPlus, sMinus: state.sMinus }, 'CUSUM alarm triggered');
      state.sPlus = 0;
      state.sMinus = 0;
    }

    this.cusumStates.set(metricName, state);

    return {
      sPlus: state.sPlus,
      sMinus: state.sMinus,
      alarm,
    };
  }

  // ─── Internal: statistics ──────────────────────────────────────────

  private computeStats(values: number[]): { mean: number; stddev: number } {
    if (values.length === 0) return { mean: 0, stddev: 0 };

    const n = values.length;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    return {
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev * 100) / 100,
    };
  }

  // ─── Internal: seasonal adjustment ─────────────────────────────────

  private applySeasonalAdjustment(value: number, metricType: DriftMetricType): number {
    const now = new Date();
    const dow = now.getDay();
    const hour = now.getUTCHours();

    const dowFactor = DEFAULT_DOW_FACTORS[dow] ?? 1.0;
    const hourFactor = DEFAULT_HOUR_FACTORS[hour] ?? 1.0;

    // For throughput, we expect lower values on weekends/nights
    // Normalize: divide by expected factor so baseline comparison is fair
    if (metricType === 'throughput') {
      const combinedFactor = dowFactor * hourFactor;
      return combinedFactor > 0 ? value / combinedFactor : value;
    }

    // For latency/error rate, higher load periods may naturally have higher values
    // Normalize by dividing by load factor
    if (metricType === 'latency' || metricType === 'error_rate') {
      const loadFactor = dowFactor * hourFactor;
      return loadFactor > 0.8 ? value / (loadFactor * 0.3 + 0.7) : value;
    }

    return value;
  }

  // ─── Internal: sensitivity thresholds ──────────────────────────────

  private getSensitivity(metricType: DriftMetricType): { sigmaWarning: number; sigmaCritical: number } {
    const override = this.config.sensitivityOverrides.get(metricType);
    if (override) return override;

    return {
      sigmaWarning: this.config.sigmaWarning,
      sigmaCritical: this.config.sigmaCritical,
    };
  }

  setSensitivity(metricType: DriftMetricType, sigmaWarning: number, sigmaCritical: number): void {
    this.config.sensitivityOverrides.set(metricType, { sigmaWarning, sigmaCritical });
  }

  // ─── Internal: alert escalation ────────────────────────────────────

  private async escalateAlert(event: DriftEvent): Promise<void> {
    switch (event.severity) {
      case 'minor':
        // Log only
        log.info({
          metric: event.metricName,
          sigma: event.deviationSigma,
          direction: event.direction,
        }, 'Minor drift detected');
        break;

      case 'significant':
        // SSE broadcast
        broadcast('meow:cognitive', {
          type: 'drift_detected',
          drift: {
            id: event.id,
            metric: event.metricName,
            metricType: event.metricType,
            current: event.currentValue,
            baseline: event.baselineMean,
            sigma: event.deviationSigma,
            direction: event.direction,
            severity: event.severity,
            rootCause: event.aiRootCause,
            action: event.correctiveAction,
            timestamp: event.createdAt.toISOString(),
          },
        });
        log.warn({
          metric: event.metricName,
          sigma: event.deviationSigma,
          direction: event.direction,
        }, 'Significant drift detected');
        break;

      case 'critical':
        // SSE broadcast + WhatsApp alert
        broadcast('meow:cognitive', {
          type: 'drift_critical',
          drift: {
            id: event.id,
            metric: event.metricName,
            metricType: event.metricType,
            current: event.currentValue,
            baseline: event.baselineMean,
            sigma: event.deviationSigma,
            direction: event.direction,
            severity: event.severity,
            rootCause: event.aiRootCause,
            action: event.correctiveAction,
            timestamp: event.createdAt.toISOString(),
          },
        });

        // WhatsApp alert for critical drifts
        await this.sendWhatsAppAlert(event);

        log.error({
          metric: event.metricName,
          sigma: event.deviationSigma,
          direction: event.direction,
          rootCause: event.aiRootCause,
        }, 'CRITICAL drift detected');
        break;
    }
  }

  // ─── Internal: WhatsApp alert ──────────────────────────────────────

  private async sendWhatsAppAlert(event: DriftEvent): Promise<void> {
    const phone = process.env.MOROS_OPERATOR_PHONE;
    const evolutionUrl = process.env.EVOLUTION_API_URL;
    const evolutionInstance = process.env.EVOLUTION_INSTANCE;
    const evolutionKey = process.env.EVOLUTION_API_KEY;

    if (!phone || !evolutionUrl || !evolutionInstance || !evolutionKey) {
      log.warn('WhatsApp alert skipped — missing Evolution API env vars');
      return;
    }

    try {
      const message = [
        `DRIFT CRITICAL: ${event.metricName}`,
        `Current: ${event.currentValue} | Baseline: ${event.baselineMean}`,
        `Deviation: ${event.deviationSigma} sigma ${event.direction}`,
        event.aiRootCause ? `Root cause: ${event.aiRootCause}` : '',
        event.correctiveAction ? `Action: ${event.correctiveAction}` : '',
      ].filter(Boolean).join('\n');

      await fetch(`${evolutionUrl}/message/sendText/${evolutionInstance}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: evolutionKey,
        },
        body: JSON.stringify({
          number: phone,
          text: message,
        }),
      });

      log.info({ phone: phone.slice(-4) }, 'WhatsApp critical drift alert sent');
    } catch (err) {
      log.error({ err }, 'Failed to send WhatsApp drift alert');
    }
  }

  // ─── Internal: AI root cause analysis ──────────────────────────────

  private async getAiRootCauseAnalysis(
    metric: typeof METRIC_DEFINITIONS[number],
    baseline: MetricBaseline,
    currentValue: number,
    sigma: number,
    direction: DriftDirection,
  ): Promise<{ rootCause?: string; action?: string }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return this.getHeuristicRootCause(metric.type, direction);

    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          max_tokens: 300,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content: 'You are a systems reliability engineer analyzing metric drift. Provide a brief root cause hypothesis and a concrete corrective action. Format: "ROOT CAUSE: [hypothesis]\\nACTION: [action]". Be specific and concise.',
            },
            {
              role: 'user',
              content: [
                `Metric: ${metric.name} (${metric.type})`,
                `Current value: ${currentValue}`,
                `Baseline mean: ${baseline.mean} (stddev: ${baseline.stddev})`,
                `Deviation: ${sigma.toFixed(1)} sigma ${direction}`,
                `Samples in baseline: ${baseline.sampleCount}`,
                `Time: ${new Date().toISOString()}`,
                `Day of week: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]}`,
                '',
                'What is the most likely root cause and what corrective action should be taken?',
              ].join('\n'),
            },
          ],
        }),
      });

      if (!res.ok) {
        return this.getHeuristicRootCause(metric.type, direction);
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';

      // Parse AI response
      const rootCauseMatch = content.match(/ROOT CAUSE:\s*(.+)/i);
      const actionMatch = content.match(/ACTION:\s*(.+)/i);

      return {
        rootCause: rootCauseMatch?.[1]?.trim() ?? content.slice(0, 200),
        action: actionMatch?.[1]?.trim(),
      };
    } catch (err) {
      log.warn({ err }, 'AI root cause analysis failed — using heuristic');
      return this.getHeuristicRootCause(metric.type, direction);
    }
  }

  // ─── Internal: heuristic root cause ────────────────────────────────

  private getHeuristicRootCause(
    metricType: DriftMetricType,
    direction: DriftDirection,
  ): { rootCause: string; action: string } {
    switch (metricType) {
      case 'latency':
        return direction === 'increasing'
          ? { rootCause: 'Possible API slowdown, increased load, or resource contention.', action: 'Check worker pool utilization and external API health. Consider scaling workers.' }
          : { rootCause: 'Latency decreased — may indicate simplified workloads or caching improvements.', action: 'Monitor to confirm this is a sustained improvement.' };
      case 'quality':
        return direction === 'decreasing'
          ? { rootCause: 'Output quality degradation — possible model drift or input data issues.', action: 'Review recent formula outputs manually. Check if model tier was downgraded.' }
          : { rootCause: 'Quality improved — may indicate better prompts or input data.', action: 'Document what changed for replication.' };
      case 'cost':
        return direction === 'increasing'
          ? { rootCause: 'Cost per molecule rising — possible retries, model upgrades, or longer prompts.', action: 'Review retry rates and prompt sizes. Check if tier-S agents are overallocated.' }
          : { rootCause: 'Costs decreasing — may indicate optimization or reduced workload.', action: 'Verify cost reduction is not due to dropped work or errors.' };
      case 'error_rate':
        return direction === 'increasing'
          ? { rootCause: 'Error rate climbing — possible external API issues, rate limits, or code regression.', action: 'Check error classification stats. Investigate top error classes.' }
          : { rootCause: 'Error rate improving — recent fixes may be taking effect.', action: 'Monitor to confirm sustained improvement.' };
      case 'throughput':
        return direction === 'decreasing'
          ? { rootCause: 'Throughput dropping — possible worker stalls, queue backup, or reduced demand.', action: 'Check zombie detector and queue rebalancer. Verify demand levels.' }
          : { rootCause: 'Throughput increasing — higher demand or improved efficiency.', action: 'Ensure worker pool can sustain the increased load.' };
      default:
        return { rootCause: 'Unknown drift pattern.', action: 'Investigate manually.' };
    }
  }

  // ─── Internal: heuristic action ────────────────────────────────────

  private getHeuristicAction(metricType: DriftMetricType, direction: DriftDirection, severity: DriftSeverity): string {
    const result = this.getHeuristicRootCause(metricType, direction);
    if (severity === 'critical') {
      return `URGENT: ${result.action}`;
    }
    return result.action;
  }

  // ─── Persistence ───────────────────────────────────────────────────

  private async persistEvent(event: DriftEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_drift_events
          (id, metric_type, metric_name, current_value, baseline_mean,
           baseline_stddev, deviation_sigma, cusum_value, direction,
           severity, ai_root_cause, corrective_action, acknowledged, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          event.id,
          event.metricType,
          event.metricName,
          event.currentValue,
          event.baselineMean,
          event.baselineStddev,
          event.deviationSigma,
          event.cusumValue,
          event.direction,
          event.severity,
          event.aiRootCause ?? null,
          event.correctiveAction ?? null,
          event.acknowledged,
          event.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist drift event');
    }
  }

  /** Load recent drift events from DB on startup */
  async loadFromDb(sinceDays = 14): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT metric_type, severity
         FROM meow_drift_events
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT 2000`,
        [since.toISOString()],
      );

      // Rebuild stats
      for (const row of rows) {
        this.totalDrifts += 1;
        const mType = row.metric_type as DriftMetricType;
        const sev = row.severity as DriftSeverity;
        this.driftsByType[mType] = (this.driftsByType[mType] ?? 0) + 1;
        this.driftsBySeverity[sev] = (this.driftsBySeverity[sev] ?? 0) + 1;
      }

      log.info({ events: rows.length }, 'Loaded drift history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load drift history from DB');
    }
  }

  getEventCount(): number {
    return this.events.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: DriftDetector | null = null;

export function getDriftDetector(): DriftDetector {
  if (!instance) {
    instance = new DriftDetector();
  }
  return instance;
}
