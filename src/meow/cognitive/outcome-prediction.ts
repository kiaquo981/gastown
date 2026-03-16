/**
 * OUTCOME PREDICTION — CG-012 (Stage 05 Wave 3)
 *
 * Before executing a formula, predicts success probability,
 * estimated cost, estimated duration, and business impact.
 * Stores predictions in DB and validates against actuals for accuracy tracking.
 *
 * Gas Town: "Know what the convoy will deliver before it leaves."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OutcomePrediction {
  id: string;
  formulaName: string;
  vars: Record<string, string>;
  successProbability: number;             // 0-1
  estimatedCostUsd: number;
  estimatedDurationMs: number;
  businessImpact: BusinessImpact;
  confidenceLevel: 'low' | 'medium' | 'high';
  factors: PredictionFactor[];
  predictedAt: Date;
}

export interface BusinessImpact {
  projectedRevenueUsd: number;
  projectedRoas: number;
  projectedConversions: number;
  impactLevel: 'high' | 'medium' | 'low' | 'unknown';
  description: string;
}

export interface PredictionFactor {
  name: string;
  value: number;
  influence: 'positive' | 'negative' | 'neutral';
  detail: string;
}

export interface ExecutionAdvice {
  recommend: 'execute_now' | 'wait' | 'skip';
  reason: string;
  alternativeTime?: string;               // ISO timestamp suggestion
  riskLevel: 'low' | 'medium' | 'high';
  expectedValue: number;                  // expected_benefit - expected_cost
  factors: string[];
}

export interface ExpectedROI {
  formulaName: string;
  avgCostUsd: number;
  avgRevenueUsd: number;
  roi: number;                            // (revenue - cost) / cost
  executionCount: number;
  successRate: number;
  expectedValuePerExecution: number;      // (successRate * avgRevenue) - avgCost
  recommendation: string;
}

export interface PredictionValidation {
  totalPredictions: number;
  validated: number;
  successAccuracy: number;                // how close predicted success rate matched actual
  costAccuracy: number;                   // how close predicted cost matched actual
  durationAccuracy: number;               // how close predicted duration matched actual
  avgCostError: number;                   // avg absolute error in USD
  avgDurationError: number;               // avg absolute error in ms
  details: ValidationDetail[];
}

export interface ValidationDetail {
  predictionId: string;
  formulaName: string;
  predictedSuccess: number;
  actualSuccess: boolean;
  predictedCost: number;
  actualCost: number;
  predictedDuration: number;
  actualDuration: number;
  accuracy: number;                       // composite accuracy 0-1
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored prediction for later validation
// ─────────────────────────────────────────────────────────────────────────────

interface StoredPrediction {
  id: string;
  formulaName: string;
  moleculeId?: string;
  predictedSuccess: number;
  predictedCost: number;
  predictedDuration: number;
  actualSuccess?: boolean;
  actualCost?: number;
  actualDuration?: number;
  predictedAt: Date;
  validatedAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// OutcomePredictor
// ─────────────────────────────────────────────────────────────────────────────

export class OutcomePredictor {
  private predictions: StoredPrediction[] = [];
  private maxPredictions = 5_000;
  private static readonly MAX_CACHE_SIZE = 500;
  private formulaStatsCache = new Map<string, {
    successRate: number;
    avgCost: number;
    avgDuration: number;
    avgRevenue: number;
    executions: number;
    cachedAt: Date;
  }>();

  // ─── Predict outcome ─────────────────────────────────────────────────

  async predictOutcome(
    formulaName: string,
    vars: Record<string, string>,
  ): Promise<OutcomePrediction> {
    const stats = await this.getFormulaStats(formulaName);
    const factors: PredictionFactor[] = [];

    // Factor 1: Historical success rate
    const successRate = stats.executions > 0 ? stats.successRate : 0.7;
    factors.push({
      name: 'historical_success_rate',
      value: successRate,
      influence: successRate >= 0.8 ? 'positive' : successRate >= 0.5 ? 'neutral' : 'negative',
      detail: stats.executions > 0
        ? `${(successRate * 100).toFixed(1)}% success over ${stats.executions} executions`
        : 'No history — using default 70% estimate',
    });

    // Factor 2: Current system load
    const loadFactor = await this.computeLoadFactor();
    factors.push({
      name: 'system_load',
      value: loadFactor,
      influence: loadFactor < 0.5 ? 'positive' : loadFactor < 0.8 ? 'neutral' : 'negative',
      detail: `System load at ${(loadFactor * 100).toFixed(0)}% — ${loadFactor > 0.8 ? 'may cause delays' : 'capacity available'}`,
    });

    // Factor 3: Recent error rate for this formula
    const recentErrorRate = await this.getRecentErrorRate(formulaName);
    factors.push({
      name: 'recent_error_rate',
      value: recentErrorRate,
      influence: recentErrorRate < 0.1 ? 'positive' : recentErrorRate < 0.3 ? 'neutral' : 'negative',
      detail: recentErrorRate > 0
        ? `${(recentErrorRate * 100).toFixed(1)}% error rate in last hour`
        : 'No recent errors',
    });

    // Factor 4: Variable complexity (more vars = more complex = more risk)
    const varCount = Object.keys(vars).length;
    const complexityFactor = Math.min(1.0, varCount / 10);
    factors.push({
      name: 'variable_complexity',
      value: complexityFactor,
      influence: varCount <= 3 ? 'positive' : varCount <= 7 ? 'neutral' : 'negative',
      detail: `${varCount} variables — ${varCount > 7 ? 'high' : varCount > 3 ? 'moderate' : 'low'} complexity`,
    });

    // Factor 5: Time-of-day suitability
    const hour = new Date().getUTCHours();
    const timeScore = (hour >= 2 && hour <= 12) ? 0.9 : 0.7; // off-peak = better
    factors.push({
      name: 'time_suitability',
      value: timeScore,
      influence: timeScore >= 0.8 ? 'positive' : 'neutral',
      detail: timeScore >= 0.8 ? 'Off-peak hours — lower API contention' : 'Peak hours — potential rate limiting',
    });

    // Composite success probability (weighted average)
    const successProbability = Math.round(
      (successRate * 0.40 +
       (1 - loadFactor) * 0.15 +
       (1 - recentErrorRate) * 0.20 +
       (1 - complexityFactor) * 0.10 +
       timeScore * 0.15) * 1000,
    ) / 1000;

    // Estimated cost: use historical avg or compute from formula structure
    const estimatedCost = stats.executions > 0
      ? stats.avgCost
      : await this.estimateCostFromStructure(formulaName);

    // Estimated duration: use historical avg or estimate from step count
    const estimatedDuration = stats.executions > 0
      ? stats.avgDuration
      : await this.estimateDurationFromStructure(formulaName);

    // Business impact
    const businessImpact = await this.estimateBusinessImpact(formulaName, stats);

    // Confidence level
    const confidenceLevel = stats.executions >= 20 ? 'high'
      : stats.executions >= 5 ? 'medium'
      : 'low';

    const prediction: OutcomePrediction = {
      id: uuidv4(),
      formulaName,
      vars,
      successProbability,
      estimatedCostUsd: Math.round(estimatedCost * 10000) / 10000,
      estimatedDurationMs: Math.round(estimatedDuration),
      businessImpact,
      confidenceLevel,
      factors,
      predictedAt: new Date(),
    };

    // Store for validation
    this.storePrediction({
      id: prediction.id,
      formulaName,
      predictedSuccess: successProbability,
      predictedCost: estimatedCost,
      predictedDuration: estimatedDuration,
      predictedAt: prediction.predictedAt,
    });

    // Persist to DB
    await this.persistPrediction(prediction);

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'outcome_prediction',
      prediction: {
        id: prediction.id,
        formulaName,
        successProbability,
        estimatedCostUsd: prediction.estimatedCostUsd,
        confidenceLevel,
        impactLevel: businessImpact.impactLevel,
        timestamp: prediction.predictedAt.toISOString(),
      },
    });

    return prediction;
  }

  // ─── Should execute now? ─────────────────────────────────────────────

  async shouldExecuteNow(
    formulaName: string,
    vars: Record<string, string>,
  ): Promise<ExecutionAdvice> {
    const prediction = await this.predictOutcome(formulaName, vars);
    const factors: string[] = [];

    // Calculate expected value
    const expectedBenefit = prediction.successProbability * prediction.businessImpact.projectedRevenueUsd;
    const expectedCost = prediction.estimatedCostUsd;
    const expectedValue = expectedBenefit - expectedCost;

    // Decision logic
    if (prediction.successProbability < 0.3) {
      factors.push(`Very low success probability (${(prediction.successProbability * 100).toFixed(1)}%)`);
      return {
        recommend: 'skip',
        reason: 'Success probability too low — investigate and fix root causes before execution',
        riskLevel: 'high',
        expectedValue: Math.round(expectedValue * 100) / 100,
        factors,
      };
    }

    if (prediction.successProbability < 0.5) {
      factors.push(`Below-average success probability (${(prediction.successProbability * 100).toFixed(1)}%)`);

      // Check if waiting might help (e.g., off-peak hours)
      const hour = new Date().getUTCHours();
      if (hour >= 13 && hour <= 20) {
        const offPeakTime = new Date();
        offPeakTime.setUTCHours(2, 0, 0, 0);
        if (offPeakTime < new Date()) offPeakTime.setDate(offPeakTime.getDate() + 1);

        factors.push('Currently in peak hours — off-peak may yield better results');
        return {
          recommend: 'wait',
          reason: 'Success probability moderate — scheduling for off-peak hours recommended',
          alternativeTime: offPeakTime.toISOString(),
          riskLevel: 'medium',
          expectedValue: Math.round(expectedValue * 100) / 100,
          factors,
        };
      }

      factors.push('Already in off-peak hours — proceed with caution');
      return {
        recommend: 'execute_now',
        reason: 'Moderate risk but no better time window available — proceed with monitoring',
        riskLevel: 'medium',
        expectedValue: Math.round(expectedValue * 100) / 100,
        factors,
      };
    }

    // High success probability
    factors.push(`Good success probability (${(prediction.successProbability * 100).toFixed(1)}%)`);
    if (expectedValue > 0) {
      factors.push(`Positive expected value: $${expectedValue.toFixed(2)}`);
    }

    return {
      recommend: 'execute_now',
      reason: 'Good conditions for execution — success probability and expected value are favorable',
      riskLevel: 'low',
      expectedValue: Math.round(expectedValue * 100) / 100,
      factors,
    };
  }

  // ─── Formula expected ROI ────────────────────────────────────────────

  async getFormulaExpectedROI(formulaName: string): Promise<ExpectedROI> {
    const stats = await this.getFormulaStats(formulaName);

    const roi = stats.avgCost > 0
      ? (stats.avgRevenue - stats.avgCost) / stats.avgCost
      : 0;

    const expectedValuePerExecution =
      (stats.successRate * stats.avgRevenue) - stats.avgCost;

    let recommendation: string;
    if (stats.executions < 5) {
      recommendation = 'Insufficient data — run more executions to build reliable ROI estimate';
    } else if (roi > 2.0) {
      recommendation = 'Excellent ROI — prioritize and increase execution frequency';
    } else if (roi > 0.5) {
      recommendation = 'Good ROI — maintain current execution cadence';
    } else if (roi > 0) {
      recommendation = 'Marginal ROI — review costs and optimize formula efficiency';
    } else {
      recommendation = 'Negative ROI — investigate failure patterns and cost drivers';
    }

    return {
      formulaName,
      avgCostUsd: Math.round(stats.avgCost * 10000) / 10000,
      avgRevenueUsd: Math.round(stats.avgRevenue * 100) / 100,
      roi: Math.round(roi * 100) / 100,
      executionCount: stats.executions,
      successRate: Math.round(stats.successRate * 1000) / 1000,
      expectedValuePerExecution: Math.round(expectedValuePerExecution * 100) / 100,
      recommendation,
    };
  }

  // ─── Validate predictions against actuals ────────────────────────────

  async validatePredictions(): Promise<PredictionValidation> {
    const pool = getPool();
    const validated = this.predictions.filter(p => p.actualSuccess !== undefined);

    if (validated.length === 0) {
      // Attempt to load from DB
      if (pool) {
        try {
          const { rows } = await pool.query(
            `SELECT p.id, p.formula_name, p.predicted_success, p.predicted_cost,
                    p.predicted_duration, m.status,
                    COALESCE(SUM(c.cost_usd), 0) AS actual_cost,
                    EXTRACT(EPOCH FROM (m.completed_at - m.created_at)) * 1000 AS actual_dur_ms
             FROM meow_predictions p
             JOIN molecules m ON m.id = p.molecule_id
             LEFT JOIN meow_cost_log c ON c.molecule_id = m.id
             WHERE m.status IN ('completed', 'failed')
               AND p.created_at > NOW() - INTERVAL '30 days'
             GROUP BY p.id, p.formula_name, p.predicted_success, p.predicted_cost,
                      p.predicted_duration, m.status, m.completed_at, m.created_at
             LIMIT 500`,
          );

          const details: ValidationDetail[] = rows.map((r: Record<string, unknown>) => {
            const predictedSuccess = parseFloat(r.predicted_success as string);
            const actualSuccess = (r.status as string) === 'completed';
            const predictedCost = parseFloat(r.predicted_cost as string);
            const actualCost = parseFloat(r.actual_cost as string) || 0;
            const predictedDuration = parseFloat(r.predicted_duration as string);
            const actualDuration = parseFloat(r.actual_dur_ms as string) || 0;

            // Composite accuracy
            const successMatch = (predictedSuccess >= 0.5) === actualSuccess ? 1 : 0;
            const costAccuracy = predictedCost > 0
              ? Math.max(0, 1 - Math.abs(actualCost - predictedCost) / predictedCost)
              : 0;
            const durAccuracy = predictedDuration > 0
              ? Math.max(0, 1 - Math.abs(actualDuration - predictedDuration) / predictedDuration)
              : 0;

            return {
              predictionId: r.id as string,
              formulaName: r.formula_name as string,
              predictedSuccess,
              actualSuccess,
              predictedCost,
              actualCost,
              predictedDuration,
              actualDuration,
              accuracy: Math.round(((successMatch * 0.5 + costAccuracy * 0.25 + durAccuracy * 0.25)) * 1000) / 1000,
            };
          });

          const totalValidated = details.length;
          const avgCostError = totalValidated > 0
            ? details.reduce((s, d) => s + Math.abs(d.actualCost - d.predictedCost), 0) / totalValidated
            : 0;
          const avgDurationError = totalValidated > 0
            ? details.reduce((s, d) => s + Math.abs(d.actualDuration - d.predictedDuration), 0) / totalValidated
            : 0;
          const successAccuracy = totalValidated > 0
            ? details.filter(d => (d.predictedSuccess >= 0.5) === d.actualSuccess).length / totalValidated
            : 0;
          const costAccuracy = totalValidated > 0
            ? details.reduce((s, d) => {
                if (d.predictedCost === 0) return s;
                return s + Math.max(0, 1 - Math.abs(d.actualCost - d.predictedCost) / d.predictedCost);
              }, 0) / totalValidated
            : 0;
          const durationAccuracy = totalValidated > 0
            ? details.reduce((s, d) => {
                if (d.predictedDuration === 0) return s;
                return s + Math.max(0, 1 - Math.abs(d.actualDuration - d.predictedDuration) / d.predictedDuration);
              }, 0) / totalValidated
            : 0;

          return {
            totalPredictions: this.predictions.length,
            validated: totalValidated,
            successAccuracy: Math.round(successAccuracy * 1000) / 1000,
            costAccuracy: Math.round(costAccuracy * 1000) / 1000,
            durationAccuracy: Math.round(durationAccuracy * 1000) / 1000,
            avgCostError: Math.round(avgCostError * 10000) / 10000,
            avgDurationError: Math.round(avgDurationError),
            details: details.slice(0, 20),
          };
        } catch (err) {
          console.error('[OutcomePredictor] Failed to validate from DB:', err);
        }
      }
    }

    // Fallback: in-memory validation
    const details: ValidationDetail[] = validated.map(p => {
      const successMatch = (p.predictedSuccess >= 0.5) === (p.actualSuccess ?? false) ? 1 : 0;
      const costAcc = p.predictedCost > 0 && p.actualCost !== undefined
        ? Math.max(0, 1 - Math.abs(p.actualCost - p.predictedCost) / p.predictedCost)
        : 0;
      const durAcc = p.predictedDuration > 0 && p.actualDuration !== undefined
        ? Math.max(0, 1 - Math.abs(p.actualDuration - p.predictedDuration) / p.predictedDuration)
        : 0;

      return {
        predictionId: p.id,
        formulaName: p.formulaName,
        predictedSuccess: p.predictedSuccess,
        actualSuccess: p.actualSuccess ?? false,
        predictedCost: p.predictedCost,
        actualCost: p.actualCost ?? 0,
        predictedDuration: p.predictedDuration,
        actualDuration: p.actualDuration ?? 0,
        accuracy: Math.round((successMatch * 0.5 + costAcc * 0.25 + durAcc * 0.25) * 1000) / 1000,
      };
    });

    const n = details.length || 1;

    return {
      totalPredictions: this.predictions.length,
      validated: validated.length,
      successAccuracy: Math.round(
        (details.filter(d => (d.predictedSuccess >= 0.5) === d.actualSuccess).length / n) * 1000,
      ) / 1000,
      costAccuracy: Math.round(
        (details.reduce((s, d) => s + (d.predictedCost > 0 ? Math.max(0, 1 - Math.abs(d.actualCost - d.predictedCost) / d.predictedCost) : 0), 0) / n) * 1000,
      ) / 1000,
      durationAccuracy: Math.round(
        (details.reduce((s, d) => s + (d.predictedDuration > 0 ? Math.max(0, 1 - Math.abs(d.actualDuration - d.predictedDuration) / d.predictedDuration) : 0), 0) / n) * 1000,
      ) / 1000,
      avgCostError: Math.round(
        (details.reduce((s, d) => s + Math.abs(d.actualCost - d.predictedCost), 0) / n) * 10000,
      ) / 10000,
      avgDurationError: Math.round(
        details.reduce((s, d) => s + Math.abs(d.actualDuration - d.predictedDuration), 0) / n,
      ),
      details: details.slice(0, 20),
    };
  }

  // ─── Record actual outcome for a prediction ─────────────────────────

  recordActual(predictionId: string, actual: { success: boolean; costUsd: number; durationMs: number; moleculeId?: string }): void {
    const pred = this.predictions.find(p => p.id === predictionId);
    if (pred) {
      pred.actualSuccess = actual.success;
      pred.actualCost = actual.costUsd;
      pred.actualDuration = actual.durationMs;
      pred.moleculeId = actual.moleculeId;
      pred.validatedAt = new Date();
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  private async getFormulaStats(formulaName: string): Promise<{
    successRate: number;
    avgCost: number;
    avgDuration: number;
    avgRevenue: number;
    executions: number;
  }> {
    // Check cache
    const cached = this.formulaStatsCache.get(formulaName);
    if (cached && (Date.now() - cached.cachedAt.getTime()) < 10 * 60_000) {
      return cached;
    }

    const pool = getPool();
    const defaults = { successRate: 0.7, avgCost: 0.01, avgDuration: 30_000, avgRevenue: 0, executions: 0, cachedAt: new Date() };

    if (!pool) return defaults;

    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE m.status = 'completed') AS completed,
           COALESCE(AVG(c.total_cost), 0) AS avg_cost,
           COALESCE(AVG(EXTRACT(EPOCH FROM (m.completed_at - m.created_at)) * 1000)
             FILTER (WHERE m.completed_at IS NOT NULL), 30000) AS avg_dur,
           COALESCE(AVG(o.revenue), 0) AS avg_revenue
         FROM molecules m
         LEFT JOIN LATERAL (
           SELECT SUM(cost_usd) AS total_cost FROM meow_cost_log WHERE molecule_id = m.id
         ) c ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE((metrics->>'revenue')::numeric, 0) AS revenue
           FROM meow_outcomes WHERE molecule_id = m.id LIMIT 1
         ) o ON TRUE
         WHERE m.formula_name = $1 AND m.created_at > NOW() - INTERVAL '30 days'`,
        [formulaName],
      );

      const row = rows[0];
      const total = parseInt(row.total) || 0;
      const completed = parseInt(row.completed) || 0;

      const stats = {
        successRate: total > 0 ? completed / total : 0.7,
        avgCost: parseFloat(row.avg_cost) || 0.01,
        avgDuration: parseFloat(row.avg_dur) || 30_000,
        avgRevenue: parseFloat(row.avg_revenue) || 0,
        executions: total,
        cachedAt: new Date(),
      };

      // Evict oldest if over cap
      if (this.formulaStatsCache.size >= OutcomePredictor.MAX_CACHE_SIZE) {
        const firstKey = this.formulaStatsCache.keys().next().value;
        if (firstKey !== undefined) this.formulaStatsCache.delete(firstKey);
      }
      this.formulaStatsCache.set(formulaName, stats);
      return stats;
    } catch (err) {
      console.error('[OutcomePredictor] Failed to get formula stats:', err);
      return defaults;
    }
  }

  private async computeLoadFactor(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0.3;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS running FROM molecules WHERE status = 'running'`,
      );
      const running = parseInt(rows[0]?.running) || 0;
      return Math.min(1.0, running / 20); // 20 concurrent = max load
    } catch {
      return 0.3;
    }
  }

  private async getRecentErrorRate(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM molecules
         WHERE formula_name = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [formulaName],
      );
      const total = parseInt(rows[0]?.total) || 0;
      const failed = parseInt(rows[0]?.failed) || 0;
      return total > 0 ? failed / total : 0;
    } catch {
      return 0;
    }
  }

  private async estimateCostFromStructure(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0.01;

    try {
      const { rows } = await pool.query(
        `SELECT steps FROM molecules WHERE formula_name = $1 ORDER BY created_at DESC LIMIT 1`,
        [formulaName],
      );
      if (rows.length > 0 && Array.isArray(rows[0].steps)) {
        // Rough estimate: $0.002 per step (Gemini Flash avg)
        return rows[0].steps.length * 0.002;
      }
      return 0.01;
    } catch {
      return 0.01;
    }
  }

  private async estimateDurationFromStructure(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 30_000;

    try {
      const { rows } = await pool.query(
        `SELECT steps FROM molecules WHERE formula_name = $1 ORDER BY created_at DESC LIMIT 1`,
        [formulaName],
      );
      if (rows.length > 0 && Array.isArray(rows[0].steps)) {
        // Rough estimate: 10s per step
        return rows[0].steps.length * 10_000;
      }
      return 30_000;
    } catch {
      return 30_000;
    }
  }

  private async estimateBusinessImpact(
    formulaName: string,
    stats: { avgRevenue: number; executions: number; successRate: number },
  ): Promise<BusinessImpact> {
    if (stats.executions < 3 || stats.avgRevenue === 0) {
      return {
        projectedRevenueUsd: 0,
        projectedRoas: 0,
        projectedConversions: 0,
        impactLevel: 'unknown',
        description: 'Insufficient data to estimate business impact',
      };
    }

    const projectedRevenue = stats.successRate * stats.avgRevenue;
    const projectedRoas = stats.avgRevenue > 0 ? projectedRevenue / Math.max(0.01, stats.avgRevenue * 0.1) : 0;

    // Estimate conversions from outcomes
    const pool = getPool();
    let avgConversions = 0;
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT AVG(COALESCE((metrics->>'conversions')::numeric, 0)) AS avg_conv
           FROM meow_outcomes
           WHERE formula_name = $1 AND recorded_at > NOW() - INTERVAL '30 days'`,
          [formulaName],
        );
        avgConversions = parseFloat(rows[0]?.avg_conv) || 0;
      } catch {
        // ignore
      }
    }

    const impactLevel = projectedRevenue > 100 ? 'high'
      : projectedRevenue > 10 ? 'medium'
      : projectedRevenue > 0 ? 'low'
      : 'unknown';

    return {
      projectedRevenueUsd: Math.round(projectedRevenue * 100) / 100,
      projectedRoas: Math.round(projectedRoas * 100) / 100,
      projectedConversions: Math.round(avgConversions * stats.successRate * 10) / 10,
      impactLevel,
      description: `Expected $${projectedRevenue.toFixed(2)} revenue at ${(stats.successRate * 100).toFixed(0)}% success rate`,
    };
  }

  private storePrediction(pred: StoredPrediction): void {
    this.predictions.push(pred);
    if (this.predictions.length > this.maxPredictions) {
      this.predictions = this.predictions.slice(-this.maxPredictions);
    }
  }

  private async persistPrediction(prediction: OutcomePrediction): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_predictions
          (id, formula_name, predicted_success, predicted_cost, predicted_duration,
           business_impact, confidence_level, factors, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          prediction.id,
          prediction.formulaName,
          prediction.successProbability,
          prediction.estimatedCostUsd,
          prediction.estimatedDurationMs,
          JSON.stringify(prediction.businessImpact),
          prediction.confidenceLevel,
          JSON.stringify(prediction.factors),
          prediction.predictedAt.toISOString(),
        ],
      );
    } catch (err) {
      // Table may not exist yet — that's OK, predictions still work in-memory
      console.warn('[OutcomePredictor] Failed to persist prediction (table may not exist):', (err as Error).message);
    }
  }

  getPredictionCount(): number {
    return this.predictions.length;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: OutcomePredictor | null = null;

export function getOutcomePredictor(): OutcomePredictor {
  if (!instance) {
    instance = new OutcomePredictor();
  }
  return instance;
}
