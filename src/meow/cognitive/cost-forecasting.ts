/**
 * COST FORECASTING — CG-010 (Stage 05 Wave 3)
 *
 * Predicts monthly costs based on current trajectory.
 * Uses burn rate, scheduled formulas, historical patterns,
 * and seasonal adjustments to project future spend.
 *
 * Gas Town: "Know the cost of the convoy before it rolls out."
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetAlertLevel = 'green' | 'yellow' | 'red' | 'critical';

export interface CostForecast {
  daysAhead: number;
  currentDailyBurnUsd: number;
  projectedTotalUsd: number;
  projectedIncrementalUsd: number;
  confidenceInterval: { low: number; high: number };
  byProvider: Record<string, number>;
  assumptions: string[];
  forecastedAt: Date;
}

export interface MonthlyProjection {
  month: string;                  // YYYY-MM
  daysInMonth: number;
  daysElapsed: number;
  daysRemaining: number;
  spentToDateUsd: number;
  projectedTotalUsd: number;
  dailyBurnRate: number;
  weekdayRate: number;
  weekendRate: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  trendPctChange: number;
}

export interface BudgetAlert {
  level: BudgetAlertLevel;
  monthlyBudgetUsd: number;
  projectedSpendUsd: number;
  spentToDateUsd: number;
  utilizationPct: number;
  projectedUtilizationPct: number;
  message: string;
  recommendations: string[];
}

export interface ProviderForecast {
  provider: string;
  currentMonthSpend: number;
  dailyRate: number;
  projectedMonthlyUsd: number;
  shareOfTotal: number;           // 0-1
  trend: 'increasing' | 'stable' | 'decreasing';
}

export interface FormulaProjection {
  formulaName: string;
  executionCount: number;
  avgCostPerExecution: number;
  totalSpentUsd: number;
  projectedMonthlyCost: number;
  executionsPerDay: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seasonal multipliers (month index 0-11)
// ─────────────────────────────────────────────────────────────────────────────

const SEASONAL_MULTIPLIERS: Record<number, number> = {
  0: 0.90,   // January — post-holiday cooldown
  1: 0.95,   // February
  2: 1.00,   // March
  3: 1.00,   // April
  4: 1.05,   // May
  5: 1.00,   // June
  6: 0.90,   // July — summer slowdown
  7: 0.95,   // August
  8: 1.05,   // September — back to business
  9: 1.10,   // October — Q4 ramp
  10: 1.25,  // November — Black Friday / BFCM
  11: 1.20,  // December — holiday campaigns
};

// ─────────────────────────────────────────────────────────────────────────────
// CostForecaster
// ─────────────────────────────────────────────────────────────────────────────

export class CostForecaster {
  private monthlyBudgetUsd: number;

  constructor(monthlyBudgetUsd = 500) {
    this.monthlyBudgetUsd = monthlyBudgetUsd;
  }

  // ─── Forecast N days ahead ───────────────────────────────────────────

  async forecast(daysAhead: number): Promise<CostForecast> {
    const pool = getPool();
    const now = new Date();
    const assumptions: string[] = [];

    // Get daily costs for last 7 days
    const dailyCosts = await this.getDailyCosts(7);
    const currentDailyBurn = dailyCosts.length > 0
      ? dailyCosts.reduce((s, d) => s + d.total, 0) / dailyCosts.length
      : 0;

    // Get provider breakdown for last 7 days
    const byProvider: Record<string, number> = {};
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT provider, SUM(cost_usd) AS total
           FROM meow_cost_log
           WHERE created_at > NOW() - INTERVAL '7 days'
           GROUP BY provider`,
        );
        for (const row of rows) {
          const dailyRate = parseFloat(row.total as string) / 7;
          byProvider[row.provider as string] = Math.round(dailyRate * daysAhead * 100) / 100;
        }
      } catch (err) {
        console.error('[CostForecaster] Failed to query provider breakdown:', err);
      }
    }

    // Apply seasonal adjustment
    const targetMonth = new Date(now.getTime() + daysAhead * 86_400_000).getMonth();
    const seasonalFactor = SEASONAL_MULTIPLIERS[targetMonth] ?? 1.0;
    assumptions.push(`Seasonal factor for target period: ${seasonalFactor}x`);

    // Detect trend from daily costs
    const trend = this.detectTrend(dailyCosts.map(d => d.total));
    let trendMultiplier = 1.0;
    if (trend === 'increasing') {
      trendMultiplier = 1.1;
      assumptions.push('Cost trend is increasing — 10% uplift applied');
    } else if (trend === 'decreasing') {
      trendMultiplier = 0.9;
      assumptions.push('Cost trend is decreasing — 10% discount applied');
    } else {
      assumptions.push('Cost trend is stable');
    }

    const adjustedDailyBurn = currentDailyBurn * seasonalFactor * trendMultiplier;
    const projectedIncremental = adjustedDailyBurn * daysAhead;

    // Confidence interval: +/- 1 std dev of daily costs
    const stdDev = this.computeStdDev(dailyCosts.map(d => d.total));
    const confidenceLow = Math.max(0, (adjustedDailyBurn - stdDev) * daysAhead);
    const confidenceHigh = (adjustedDailyBurn + stdDev) * daysAhead;

    // Current month's spend so far
    const spentToDate = await this.getMonthToDateSpend();

    return {
      daysAhead,
      currentDailyBurnUsd: Math.round(currentDailyBurn * 100) / 100,
      projectedTotalUsd: Math.round((spentToDate + projectedIncremental) * 100) / 100,
      projectedIncrementalUsd: Math.round(projectedIncremental * 100) / 100,
      confidenceInterval: {
        low: Math.round(confidenceLow * 100) / 100,
        high: Math.round(confidenceHigh * 100) / 100,
      },
      byProvider,
      assumptions,
      forecastedAt: now,
    };
  }

  // ─── Monthly projection ──────────────────────────────────────────────

  async getMonthlyProjection(): Promise<MonthlyProjection> {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysElapsed = Math.max(1, now.getDate());
    const daysRemaining = daysInMonth - daysElapsed;
    const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;

    const spentToDate = await this.getMonthToDateSpend();
    const dailyCosts = await this.getDailyCosts(daysElapsed);

    // Separate weekday vs weekend rates
    let weekdayTotal = 0;
    let weekdayDays = 0;
    let weekendTotal = 0;
    let weekendDays = 0;

    for (const day of dailyCosts) {
      const d = new Date(day.date);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) {
        weekendTotal += day.total;
        weekendDays++;
      } else {
        weekdayTotal += day.total;
        weekdayDays++;
      }
    }

    const weekdayRate = weekdayDays > 0 ? weekdayTotal / weekdayDays : 0;
    const weekendRate = weekendDays > 0 ? weekendTotal / weekendDays : weekdayRate * 0.6;

    // Project remaining days using weekday/weekend split
    let projectedRemaining = 0;
    for (let d = 1; d <= daysRemaining; d++) {
      const futureDate = new Date(year, month, now.getDate() + d);
      const dow = futureDate.getDay();
      projectedRemaining += (dow === 0 || dow === 6) ? weekendRate : weekdayRate;
    }

    const projectedTotal = spentToDate + projectedRemaining;
    const dailyBurnRate = daysElapsed > 0 ? spentToDate / daysElapsed : 0;

    // Detect trend
    const recentCosts = dailyCosts.map(d => d.total);
    const trend = this.detectTrend(recentCosts);
    const trendPctChange = this.computeTrendPct(recentCosts);

    return {
      month: monthStr,
      daysInMonth,
      daysElapsed,
      daysRemaining,
      spentToDateUsd: Math.round(spentToDate * 100) / 100,
      projectedTotalUsd: Math.round(projectedTotal * 100) / 100,
      dailyBurnRate: Math.round(dailyBurnRate * 100) / 100,
      weekdayRate: Math.round(weekdayRate * 100) / 100,
      weekendRate: Math.round(weekendRate * 100) / 100,
      trend,
      trendPctChange: Math.round(trendPctChange * 100) / 100,
    };
  }

  // ─── Budget alert ────────────────────────────────────────────────────

  async getBudgetAlert(): Promise<BudgetAlert> {
    const projection = await this.getMonthlyProjection();
    const spentPct = (projection.spentToDateUsd / this.monthlyBudgetUsd) * 100;
    const projectedPct = (projection.projectedTotalUsd / this.monthlyBudgetUsd) * 100;

    let level: BudgetAlertLevel;
    let message: string;
    const recommendations: string[] = [];

    if (spentPct >= 100) {
      level = 'critical';
      message = `Budget EXCEEDED: $${projection.spentToDateUsd.toFixed(2)} spent of $${this.monthlyBudgetUsd} budget (${spentPct.toFixed(1)}%)`;
      recommendations.push('Immediately pause non-critical molecules');
      recommendations.push('Review high-cost formulas for optimization');
      recommendations.push('Consider increasing monthly budget if spend is justified');
    } else if (projectedPct >= 100) {
      level = 'red';
      message = `On track to EXCEED budget: projected $${projection.projectedTotalUsd.toFixed(2)} vs $${this.monthlyBudgetUsd} limit`;
      recommendations.push('Reduce execution frequency for expensive formulas');
      recommendations.push('Switch to cheaper LLM tiers where possible');
      recommendations.push('Defer non-urgent convoys to next month');
    } else if (projectedPct >= 80) {
      level = 'yellow';
      message = `Budget utilization trending high: projected ${projectedPct.toFixed(1)}% of budget`;
      recommendations.push('Monitor daily spend closely');
      recommendations.push('Consider optimizing top-cost formulas');
    } else {
      level = 'green';
      message = `Budget on track: projected ${projectedPct.toFixed(1)}% utilization`;
    }

    const alert: BudgetAlert = {
      level,
      monthlyBudgetUsd: this.monthlyBudgetUsd,
      projectedSpendUsd: projection.projectedTotalUsd,
      spentToDateUsd: projection.spentToDateUsd,
      utilizationPct: Math.round(spentPct * 100) / 100,
      projectedUtilizationPct: Math.round(projectedPct * 100) / 100,
      message,
      recommendations,
    };

    // Broadcast non-green alerts
    if (level !== 'green') {
      broadcast('meow:cognitive', {
        type: 'budget_alert',
        alert: {
          level: alert.level,
          utilizationPct: alert.utilizationPct,
          projectedPct: alert.projectedUtilizationPct,
          message: alert.message,
        },
      });
    }

    return alert;
  }

  // ─── Provider breakdown ──────────────────────────────────────────────

  async getProviderBreakdown(): Promise<ProviderForecast[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const now = new Date();
      const daysElapsed = Math.max(1, now.getDate());
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

      const { rows } = await pool.query(
        `SELECT provider,
                SUM(cost_usd) AS total,
                SUM(cost_usd) / $1 AS daily_rate
         FROM meow_cost_log
         WHERE created_at >= DATE_TRUNC('month', NOW())
         GROUP BY provider
         ORDER BY total DESC`,
        [daysElapsed],
      );

      const totalSpend = rows.reduce((s: number, r: Record<string, unknown>) => s + parseFloat(r.total as string), 0);

      return rows.map((r: Record<string, unknown>) => {
        const monthlySpend = parseFloat(r.total as string);
        const dailyRate = parseFloat(r.daily_rate as string);
        const projected = dailyRate * daysInMonth;

        return {
          provider: r.provider as string,
          currentMonthSpend: Math.round(monthlySpend * 100) / 100,
          dailyRate: Math.round(dailyRate * 100) / 100,
          projectedMonthlyUsd: Math.round(projected * 100) / 100,
          shareOfTotal: totalSpend > 0 ? Math.round((monthlySpend / totalSpend) * 1000) / 1000 : 0,
          trend: 'stable' as const,
        };
      });
    } catch (err) {
      console.error('[CostForecaster] Failed to get provider breakdown:', err);
      return [];
    }
  }

  // ─── Formula projected costs ─────────────────────────────────────────

  async getFormulaProjectedCosts(): Promise<FormulaProjection[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const now = new Date();
      const daysElapsed = Math.max(1, now.getDate());
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

      const { rows } = await pool.query(
        `SELECT m.formula_name,
                COUNT(DISTINCT m.id) AS exec_count,
                COALESCE(SUM(c.cost_usd), 0) AS total_cost
         FROM molecules m
         LEFT JOIN meow_cost_log c ON c.molecule_id = m.id
         WHERE m.created_at >= DATE_TRUNC('month', NOW())
         GROUP BY m.formula_name
         ORDER BY total_cost DESC
         LIMIT 50`,
      );

      return rows.map((r: Record<string, unknown>) => {
        const execCount = parseInt(r.exec_count as string) || 0;
        const totalCost = parseFloat(r.total_cost as string) || 0;
        const avgCost = execCount > 0 ? totalCost / execCount : 0;
        const execsPerDay = execCount / daysElapsed;
        const projectedMonthly = execsPerDay * daysInMonth * avgCost;

        return {
          formulaName: r.formula_name as string,
          executionCount: execCount,
          avgCostPerExecution: Math.round(avgCost * 10000) / 10000,
          totalSpentUsd: Math.round(totalCost * 100) / 100,
          projectedMonthlyCost: Math.round(projectedMonthly * 100) / 100,
          executionsPerDay: Math.round(execsPerDay * 100) / 100,
        };
      });
    } catch (err) {
      console.error('[CostForecaster] Failed to get formula projections:', err);
      return [];
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  private async getDailyCosts(days: number): Promise<Array<{ date: string; total: number }>> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT DATE(created_at) AS day, SUM(cost_usd) AS total
         FROM meow_cost_log
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         GROUP BY DATE(created_at)
         ORDER BY day`,
        [days],
      );
      return rows.map((r: Record<string, unknown>) => ({
        date: (r.day as string),
        total: parseFloat(r.total as string) || 0,
      }));
    } catch {
      return [];
    }
  }

  private async getMonthToDateSpend(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM meow_cost_log
         WHERE created_at >= DATE_TRUNC('month', NOW())`,
      );
      return parseFloat(rows[0]?.total as string) || 0;
    } catch {
      return 0;
    }
  }

  private detectTrend(values: number[]): 'increasing' | 'stable' | 'decreasing' {
    if (values.length < 3) return 'stable';

    const half = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, half);
    const secondHalf = values.slice(half);

    const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

    if (firstAvg === 0) return 'stable';

    const changePct = (secondAvg - firstAvg) / firstAvg;
    if (changePct > 0.15) return 'increasing';
    if (changePct < -0.15) return 'decreasing';
    return 'stable';
  }

  private computeTrendPct(values: number[]): number {
    if (values.length < 2) return 0;

    const half = Math.floor(values.length / 2);
    const firstAvg = values.slice(0, half).reduce((s, v) => s + v, 0) / Math.max(1, half);
    const secondAvg = values.slice(half).reduce((s, v) => s + v, 0) / Math.max(1, values.length - half);

    if (firstAvg === 0) return 0;
    return ((secondAvg - firstAvg) / firstAvg) * 100;
  }

  private computeStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  setMonthlyBudget(budgetUsd: number): void {
    this.monthlyBudgetUsd = budgetUsd;
  }

  getMonthlyBudget(): number {
    return this.monthlyBudgetUsd;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: CostForecaster | null = null;

export function getCostForecaster(): CostForecaster {
  if (!instance) {
    instance = new CostForecaster();
  }
  return instance;
}
