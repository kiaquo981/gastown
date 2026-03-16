/**
 * DEMAND FORECASTING — CG-011 (Stage 05 Wave 3)
 *
 * Predicts future workload to pre-spawn workers.
 * Analyzes webhook patterns, cron schedules, day-of-week effects,
 * campaign cycles, and seasonal factors.
 *
 * Gas Town: "Staff the rig before the convoy arrives."
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DemandForecast {
  hoursAhead: number;
  currentLoad: number;                    // active molecules right now
  predictedLoad: number;                  // predicted molecules in N hours
  predictedPeakLoad: number;              // max predicted in window
  peakHourUtc: number;                    // hour when peak is expected
  sources: DemandSource[];
  confidence: number;                     // 0-1
  forecastedAt: Date;
}

export interface DemandSource {
  name: string;                           // 'cron', 'webhook', 'manual', 'convoy'
  expectedMolecules: number;
  expectedAtUtc?: number;                 // hour
  detail: string;
}

export interface PoolRecommendation {
  currentPoolSize: number;
  recommendedPoolSize: number;
  reason: string;
  scaleAction: 'scale_up' | 'maintain' | 'scale_down';
  urgency: 'immediate' | 'soon' | 'low';
  predictedPeakLoad: number;
  headroomPct: number;                    // recommended buffer above peak
}

export type LoadDirection = 'increasing' | 'stable' | 'decreasing';

export interface LoadTrend {
  direction: LoadDirection;
  currentLoad: number;
  avgLoad1h: number;
  avgLoad6h: number;
  changeRate: number;                     // molecules per hour change
  description: string;
}

export interface HourlyPattern {
  hourUtc: number;                        // 0-23
  avgMolecules: number;
  maxMolecules: number;
  avgDurationMs: number;
  sampleDays: number;
}

export interface DayPattern {
  dayOfWeek: number;                      // 0=Sunday .. 6=Saturday
  dayName: string;
  avgMolecules: number;
  maxMolecules: number;
  relativeLoad: number;                   // 1.0 = average, >1 = busier
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WORKER_HEADROOM_PCT = 30;           // 30% buffer above predicted peak
const MIN_POOL_SIZE = 2;
const MAX_POOL_SIZE = 20;

// Known spike events (month-day → multiplier)
const KNOWN_SPIKES: Record<string, number> = {
  '11-24': 2.5,   // Black Friday (approx)
  '11-25': 2.0,   // Saturday after BF
  '11-27': 2.0,   // Cyber Monday
  '12-24': 0.5,   // Christmas Eve — low
  '12-25': 0.3,   // Christmas — very low
  '01-01': 0.4,   // New Year — low
};

// ─────────────────────────────────────────────────────────────────────────────
// DemandForecaster
// ─────────────────────────────────────────────────────────────────────────────

export class DemandForecaster {
  private hourlyCache: HourlyPattern[] | null = null;
  private dayCache: DayPattern[] | null = null;
  private cacheExpiry: Date | null = null;

  // ─── Forecast demand ─────────────────────────────────────────────────

  async forecastDemand(hoursAhead: number): Promise<DemandForecast> {
    const now = new Date();
    const currentLoad = await this.getCurrentActiveCount();
    const sources: DemandSource[] = [];

    // Source 1: Cron-triggered formulas in the forecast window
    const cronDemand = await this.estimateCronDemand(hoursAhead);
    if (cronDemand > 0) {
      sources.push({
        name: 'cron',
        expectedMolecules: cronDemand,
        detail: `${cronDemand} cron-triggered molecules expected in next ${hoursAhead}h`,
      });
    }

    // Source 2: Webhook patterns (based on historical hourly rates)
    const webhookDemand = await this.estimateWebhookDemand(hoursAhead);
    if (webhookDemand > 0) {
      sources.push({
        name: 'webhook',
        expectedMolecules: webhookDemand,
        detail: `${webhookDemand} webhook-triggered molecules based on historical patterns`,
      });
    }

    // Source 3: Active convoys that will generate molecules
    const convoyDemand = await this.estimateConvoyDemand();
    if (convoyDemand > 0) {
      sources.push({
        name: 'convoy',
        expectedMolecules: convoyDemand,
        detail: `${convoyDemand} molecules from active/pending convoys`,
      });
    }

    // Source 4: Manual/ad-hoc — baseline from recent manual triggers
    const manualDemand = await this.estimateManualDemand(hoursAhead);
    if (manualDemand > 0) {
      sources.push({
        name: 'manual',
        expectedMolecules: manualDemand,
        detail: `${manualDemand} manual/ad-hoc molecules based on recent patterns`,
      });
    }

    // Total predicted load
    const predictedIncremental = sources.reduce((s, src) => s + src.expectedMolecules, 0);

    // Apply day-of-week and seasonal adjustments
    const dowFactor = await this.getDayOfWeekFactor(now);
    const seasonalFactor = this.getSeasonalFactor(now);
    const adjustedPrediction = Math.round(predictedIncremental * dowFactor * seasonalFactor);

    // Determine peak hour in the forecast window
    const hourlyPatterns = await this.getHourlyPattern();
    let peakLoad = 0;
    let peakHour = now.getUTCHours();
    for (let h = 0; h < hoursAhead; h++) {
      const targetHour = (now.getUTCHours() + h) % 24;
      const pattern = hourlyPatterns.find(p => p.hourUtc === targetHour);
      const expectedAtHour = pattern?.avgMolecules ?? 0;
      if (expectedAtHour > peakLoad) {
        peakLoad = expectedAtHour;
        peakHour = targetHour;
      }
    }

    // Confidence: higher with more historical data
    const totalSamples = hourlyPatterns.reduce((s, p) => s + p.sampleDays, 0);
    const confidence = Math.min(1.0, totalSamples / (24 * 14)); // 14 days of full data = max confidence

    const forecast: DemandForecast = {
      hoursAhead,
      currentLoad,
      predictedLoad: currentLoad + adjustedPrediction,
      predictedPeakLoad: Math.max(currentLoad, Math.round(peakLoad * dowFactor * seasonalFactor)),
      peakHourUtc: peakHour,
      sources,
      confidence: Math.round(confidence * 100) / 100,
      forecastedAt: now,
    };

    // Broadcast if significant demand predicted
    if (adjustedPrediction > 10) {
      broadcast('meow:cognitive', {
        type: 'demand_forecast',
        forecast: {
          hoursAhead,
          currentLoad,
          predictedLoad: forecast.predictedLoad,
          peakHour,
          sources: sources.length,
          timestamp: now.toISOString(),
        },
      });
    }

    return forecast;
  }

  // ─── Pool size recommendation ────────────────────────────────────────

  async getRecommendedPoolSize(): Promise<PoolRecommendation> {
    const forecast = await this.forecastDemand(4); // look 4 hours ahead
    const currentPool = await this.getCurrentPoolSize();

    // Recommended = peak load + headroom
    const headroom = WORKER_HEADROOM_PCT / 100;
    const rawRecommended = Math.ceil(forecast.predictedPeakLoad * (1 + headroom));
    const recommended = Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, rawRecommended));

    let scaleAction: 'scale_up' | 'maintain' | 'scale_down';
    let urgency: 'immediate' | 'soon' | 'low';
    let reason: string;

    if (recommended > currentPool * 1.3) {
      scaleAction = 'scale_up';
      urgency = forecast.currentLoad > currentPool * 0.8 ? 'immediate' : 'soon';
      reason = `Predicted peak of ${forecast.predictedPeakLoad} molecules exceeds current pool of ${currentPool}`;
    } else if (recommended < currentPool * 0.6 && currentPool > MIN_POOL_SIZE) {
      scaleAction = 'scale_down';
      urgency = 'low';
      reason = `Current pool of ${currentPool} is oversized for predicted demand of ${forecast.predictedPeakLoad}`;
    } else {
      scaleAction = 'maintain';
      urgency = 'low';
      reason = `Pool size of ${currentPool} is appropriate for predicted demand`;
    }

    return {
      currentPoolSize: currentPool,
      recommendedPoolSize: recommended,
      reason,
      scaleAction,
      urgency,
      predictedPeakLoad: forecast.predictedPeakLoad,
      headroomPct: WORKER_HEADROOM_PCT,
    };
  }

  // ─── Current load trend ──────────────────────────────────────────────

  async getCurrentLoadTrend(): Promise<LoadTrend> {
    const pool = getPool();
    const currentLoad = await this.getCurrentActiveCount();
    let avgLoad1h = currentLoad;
    let avgLoad6h = currentLoad;

    if (pool) {
      try {
        // Avg active molecules per 10-min window in last hour
        const res1h = await pool.query(
          `SELECT COUNT(*) AS cnt
           FROM molecules
           WHERE status = 'running'
             AND created_at > NOW() - INTERVAL '1 hour'`,
        );
        avgLoad1h = parseInt(res1h.rows[0]?.cnt) || currentLoad;

        // Avg in last 6 hours
        const res6h = await pool.query(
          `SELECT COUNT(*) / GREATEST(6, 1) AS avg_per_hour
           FROM molecules
           WHERE status IN ('running', 'completed', 'failed')
             AND created_at > NOW() - INTERVAL '6 hours'`,
        );
        avgLoad6h = parseFloat(res6h.rows[0]?.avg_per_hour) || currentLoad;
      } catch (err) {
        console.error('[DemandForecaster] Failed to compute load trend:', err);
      }
    }

    const changeRate = avgLoad1h - avgLoad6h;
    let direction: LoadDirection;
    let description: string;

    if (changeRate > avgLoad6h * 0.2) {
      direction = 'increasing';
      description = `Load increasing: ${avgLoad6h.toFixed(1)}/h (6h avg) -> ${avgLoad1h.toFixed(1)}/h (1h avg)`;
    } else if (changeRate < -avgLoad6h * 0.2) {
      direction = 'decreasing';
      description = `Load decreasing: ${avgLoad6h.toFixed(1)}/h (6h avg) -> ${avgLoad1h.toFixed(1)}/h (1h avg)`;
    } else {
      direction = 'stable';
      description = `Load stable at ~${avgLoad1h.toFixed(1)} molecules/hour`;
    }

    return {
      direction,
      currentLoad,
      avgLoad1h: Math.round(avgLoad1h * 10) / 10,
      avgLoad6h: Math.round(avgLoad6h * 10) / 10,
      changeRate: Math.round(changeRate * 10) / 10,
      description,
    };
  }

  // ─── Hourly pattern ──────────────────────────────────────────────────

  async getHourlyPattern(): Promise<HourlyPattern[]> {
    if (this.hourlyCache && this.cacheExpiry && this.cacheExpiry > new Date()) {
      return this.hourlyCache;
    }

    const pool = getPool();
    if (!pool) return this.generateDefaultHourlyPattern();

    try {
      const { rows } = await pool.query(
        `SELECT
           EXTRACT(HOUR FROM created_at) AS hour_utc,
           COUNT(*) AS total,
           COUNT(DISTINCT DATE(created_at)) AS sample_days,
           MAX(daily_count) AS max_molecules,
           AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at)) * 1000) AS avg_dur_ms
         FROM molecules
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS daily_count
           FROM molecules m2
           WHERE DATE(m2.created_at) = DATE(molecules.created_at)
             AND EXTRACT(HOUR FROM m2.created_at) = EXTRACT(HOUR FROM molecules.created_at)
         ) dc ON TRUE
         WHERE created_at > NOW() - INTERVAL '14 days'
         GROUP BY EXTRACT(HOUR FROM created_at)
         ORDER BY hour_utc`,
      );

      const patterns: HourlyPattern[] = [];
      for (let h = 0; h < 24; h++) {
        const row = rows.find((r: Record<string, unknown>) => parseInt(r.hour_utc as string) === h);
        if (row) {
          const sampleDays = parseInt(row.sample_days as string) || 1;
          patterns.push({
            hourUtc: h,
            avgMolecules: Math.round((parseInt(row.total as string) || 0) / sampleDays * 10) / 10,
            maxMolecules: parseInt(row.max_molecules as string) || 0,
            avgDurationMs: Math.round(parseFloat(row.avg_dur_ms as string) || 0),
            sampleDays,
          });
        } else {
          patterns.push({ hourUtc: h, avgMolecules: 0, maxMolecules: 0, avgDurationMs: 0, sampleDays: 0 });
        }
      }

      this.hourlyCache = patterns;
      this.cacheExpiry = new Date(Date.now() + 30 * 60_000); // 30 min cache
      return patterns;
    } catch (err) {
      console.error('[DemandForecaster] Failed to compute hourly pattern:', err);
      return this.generateDefaultHourlyPattern();
    }
  }

  // ─── Day-of-week pattern ─────────────────────────────────────────────

  async getDayOfWeekPattern(): Promise<DayPattern[]> {
    if (this.dayCache && this.cacheExpiry && this.cacheExpiry > new Date()) {
      return this.dayCache;
    }

    const pool = getPool();
    if (!pool) return this.generateDefaultDayPattern();

    try {
      const { rows } = await pool.query(
        `SELECT
           EXTRACT(DOW FROM created_at) AS dow,
           COUNT(*) AS total,
           COUNT(DISTINCT DATE(created_at)) AS sample_weeks,
           MAX(daily_count) AS max_daily
         FROM molecules
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS daily_count
           FROM molecules m2
           WHERE DATE(m2.created_at) = DATE(molecules.created_at)
         ) dc ON TRUE
         WHERE created_at > NOW() - INTERVAL '28 days'
         GROUP BY EXTRACT(DOW FROM created_at)
         ORDER BY dow`,
      );

      const patterns: DayPattern[] = [];
      const avgAll = rows.length > 0
        ? rows.reduce((s: number, r: Record<string, unknown>) => {
            const weeks = parseInt(r.sample_weeks as string) || 1;
            return s + (parseInt(r.total as string) || 0) / weeks;
          }, 0) / rows.length
        : 1;

      for (let d = 0; d < 7; d++) {
        const row = rows.find((r: Record<string, unknown>) => parseInt(r.dow as string) === d);
        if (row) {
          const weeks = parseInt(row.sample_weeks as string) || 1;
          const avgMolecules = (parseInt(row.total as string) || 0) / weeks;
          patterns.push({
            dayOfWeek: d,
            dayName: DAY_NAMES[d],
            avgMolecules: Math.round(avgMolecules * 10) / 10,
            maxMolecules: parseInt(row.max_daily as string) || 0,
            relativeLoad: avgAll > 0 ? Math.round((avgMolecules / avgAll) * 100) / 100 : 1,
          });
        } else {
          patterns.push({
            dayOfWeek: d,
            dayName: DAY_NAMES[d],
            avgMolecules: 0,
            maxMolecules: 0,
            relativeLoad: d === 0 || d === 6 ? 0.6 : 1.0,
          });
        }
      }

      this.dayCache = patterns;
      return patterns;
    } catch (err) {
      console.error('[DemandForecaster] Failed to compute day-of-week pattern:', err);
      return this.generateDefaultDayPattern();
    }
  }

  // ─── Internal: demand estimators ─────────────────────────────────────

  private async estimateCronDemand(hoursAhead: number): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      // Count molecules triggered by cron in this time window historically
      const { rows } = await pool.query(
        `SELECT COUNT(*) / GREATEST(COUNT(DISTINCT DATE(created_at)), 1) AS avg_per_day
         FROM molecules
         WHERE vars::text LIKE '%cron%'
           AND created_at > NOW() - INTERVAL '7 days'`,
      );
      const perDay = parseFloat(rows[0]?.avg_per_day) || 0;
      return Math.round(perDay * (hoursAhead / 24));
    } catch {
      return 0;
    }
  }

  private async estimateWebhookDemand(hoursAhead: number): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) / GREATEST(COUNT(DISTINCT DATE(created_at)), 1) AS avg_per_day
         FROM feed_events
         WHERE type = 'molecule_started'
           AND created_at > NOW() - INTERVAL '7 days'`,
      );
      const perDay = parseFloat(rows[0]?.avg_per_day) || 0;
      return Math.round(perDay * (hoursAhead / 24));
    } catch {
      return 0;
    }
  }

  private async estimateConvoyDemand(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS pending
         FROM molecules
         WHERE status = 'pending' AND convoy_id IS NOT NULL`,
      );
      return parseInt(rows[0]?.pending) || 0;
    } catch {
      return 0;
    }
  }

  private async estimateManualDemand(hoursAhead: number): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) / GREATEST(COUNT(DISTINCT DATE(created_at)), 1) AS avg_per_day
         FROM molecules
         WHERE vars::text NOT LIKE '%cron%'
           AND convoy_id IS NULL
           AND created_at > NOW() - INTERVAL '7 days'`,
      );
      const perDay = parseFloat(rows[0]?.avg_per_day) || 0;
      return Math.round(perDay * (hoursAhead / 24));
    } catch {
      return 0;
    }
  }

  private async getCurrentActiveCount(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM molecules WHERE status = 'running'`,
      );
      return parseInt(rows[0]?.cnt) || 0;
    } catch {
      return 0;
    }
  }

  private async getCurrentPoolSize(): Promise<number> {
    const pool = getPool();
    if (!pool) return MIN_POOL_SIZE;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM beads WHERE status = 'in_progress'`,
      );
      // Pool size approximated by active beads; fallback to reasonable default
      return Math.max(MIN_POOL_SIZE, parseInt(rows[0]?.cnt) || MIN_POOL_SIZE);
    } catch {
      return MIN_POOL_SIZE;
    }
  }

  private async getDayOfWeekFactor(date: Date): Promise<number> {
    const patterns = await this.getDayOfWeekPattern();
    const dow = date.getDay();
    const pattern = patterns.find(p => p.dayOfWeek === dow);
    return pattern?.relativeLoad ?? 1.0;
  }

  private getSeasonalFactor(date: Date): number {
    const key = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return KNOWN_SPIKES[key] ?? 1.0;
  }

  private generateDefaultHourlyPattern(): HourlyPattern[] {
    return Array.from({ length: 24 }, (_, h) => ({
      hourUtc: h,
      avgMolecules: h >= 8 && h <= 20 ? 2 : 0.5,
      maxMolecules: h >= 8 && h <= 20 ? 5 : 1,
      avgDurationMs: 30_000,
      sampleDays: 0,
    }));
  }

  private generateDefaultDayPattern(): DayPattern[] {
    return DAY_NAMES.map((name, i) => ({
      dayOfWeek: i,
      dayName: name,
      avgMolecules: i === 0 || i === 6 ? 3 : 8,
      maxMolecules: i === 0 || i === 6 ? 5 : 15,
      relativeLoad: i === 0 || i === 6 ? 0.6 : 1.0,
    }));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: DemandForecaster | null = null;

export function getDemandForecaster(): DemandForecaster {
  if (!instance) {
    instance = new DemandForecaster();
  }
  return instance;
}
