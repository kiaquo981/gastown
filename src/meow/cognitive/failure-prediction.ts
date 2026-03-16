/**
 * FAILURE PREDICTION — CG-009 (Stage 05 Wave 3)
 *
 * Predicts which molecules will fail before they start.
 * Rule-based weighted scoring with learned weights from DB history.
 * Features: formula risk, time-of-day, worker load, skill complexity,
 * external dependency risk, recent error recency.
 *
 * Gas Town: "Anticipate the crash before the rig even leaves the gate."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RiskFactor {
  name: string;
  score: number;          // 0-1 contribution to failure probability
  weight: number;         // learned weight
  detail: string;         // human-readable explanation
}

export interface FailurePrediction {
  id: string;
  formulaName: string;
  probability: number;    // 0-1 overall failure probability
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskFactors: RiskFactor[];
  mitigations: string[];
  predictedAt: Date;
}

export interface RiskProfile {
  formulaName: string;
  totalExecutions: number;
  failures: number;
  failureRate: number;          // 0-1
  avgDurationMs: number;
  commonErrors: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  lastFailure?: Date;
}

export interface PredictionAccuracy {
  totalPredictions: number;
  correct: number;
  falsePositives: number;       // predicted fail but succeeded
  falseNegatives: number;       // predicted success but failed
  accuracy: number;             // 0-1
  precision: number;            // 0-1
  recall: number;               // 0-1
}

// ─────────────────────────────────────────────────────────────────────────────
// Default weights — tuned from heuristics, updated by history
// ─────────────────────────────────────────────────────────────────────────────

interface FeatureWeights {
  formulaHistory: number;
  timeOfDay: number;
  workerLoad: number;
  skillComplexity: number;
  externalDependency: number;
  recentErrors: number;
}

const DEFAULT_WEIGHTS: FeatureWeights = {
  formulaHistory: 0.30,
  timeOfDay: 0.10,
  workerLoad: 0.15,
  skillComplexity: 0.15,
  externalDependency: 0.20,
  recentErrors: 0.10,
};

// Peak hours (UTC) where API rate limits are more common
const PEAK_HOURS = new Set([13, 14, 15, 16, 17, 18, 19, 20]);

// Skills known to depend on external APIs
const EXTERNAL_SKILLS = new Set([
  'meta-ads', 'google-ads', 'shopify', 'whatsapp', 'elevenlabs',
  'heygen', 'fal', 'web-scrape', 'deploy-lp',
]);

// ─────────────────────────────────────────────────────────────────────────────
// FailurePredictor
// ─────────────────────────────────────────────────────────────────────────────

export class FailurePredictor {
  private weights: FeatureWeights;
  private predictions: Array<{ id: string; formulaName: string; predicted: number; actual?: boolean; timestamp: Date }> = [];
  private static readonly MAX_CACHE_SIZE = 500;
  private formulaCache = new Map<string, RiskProfile>();
  private cacheExpiry: Date | null = null;
  private maxPredictions = 5_000;

  constructor(weights?: Partial<FeatureWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  // ─── Main prediction ─────────────────────────────────────────────────

  async predict(
    formulaName: string,
    vars: Record<string, string>,
  ): Promise<FailurePrediction> {
    const factors: RiskFactor[] = [];

    // Feature 1: Formula historical failure rate
    const profile = await this.getFormulaRiskProfile(formulaName);
    const historyScore = profile.totalExecutions > 0
      ? profile.failureRate
      : 0.3; // unknown formula = moderate risk
    factors.push({
      name: 'formula_history',
      score: historyScore,
      weight: this.weights.formulaHistory,
      detail: profile.totalExecutions > 0
        ? `${(profile.failureRate * 100).toFixed(1)}% failure rate over ${profile.totalExecutions} executions`
        : 'No execution history — unknown risk',
    });

    // Feature 2: Time of day — API rate limits more common at peak hours
    const hour = new Date().getUTCHours();
    const timeScore = PEAK_HOURS.has(hour) ? 0.6 : 0.1;
    factors.push({
      name: 'time_of_day',
      score: timeScore,
      weight: this.weights.timeOfDay,
      detail: PEAK_HOURS.has(hour)
        ? `Peak hour (${hour}:00 UTC) — higher rate limit risk`
        : `Off-peak hour (${hour}:00 UTC) — lower risk`,
    });

    // Feature 3: Worker load — query active workers vs capacity
    const loadScore = await this.computeWorkerLoadScore();
    factors.push({
      name: 'worker_load',
      score: loadScore,
      weight: this.weights.workerLoad,
      detail: loadScore > 0.7
        ? `High worker utilization (${(loadScore * 100).toFixed(0)}%) — overload risk`
        : `Worker load acceptable (${(loadScore * 100).toFixed(0)}%)`,
    });

    // Feature 4: Skill complexity — multi-step formulas with many skills fail more
    const stepCount = await this.getFormulaStepCount(formulaName);
    const complexityScore = Math.min(1.0, stepCount / 10);
    factors.push({
      name: 'skill_complexity',
      score: complexityScore,
      weight: this.weights.skillComplexity,
      detail: `${stepCount} steps — ${stepCount > 5 ? 'complex' : 'simple'} formula`,
    });

    // Feature 5: External dependency — steps depending on external APIs
    const extDeps = await this.countExternalDependencies(formulaName);
    const extScore = Math.min(1.0, extDeps / 4);
    factors.push({
      name: 'external_dependency',
      score: extScore,
      weight: this.weights.externalDependency,
      detail: extDeps > 0
        ? `${extDeps} external API dependencies — network/auth risk`
        : 'No external dependencies',
    });

    // Feature 6: Recent errors — if similar molecules failed recently
    const recentErrorScore = await this.computeRecentErrorScore(formulaName);
    factors.push({
      name: 'recent_errors',
      score: recentErrorScore,
      weight: this.weights.recentErrors,
      detail: recentErrorScore > 0.5
        ? 'Similar molecules failed recently — elevated risk'
        : 'No recent failures for this formula',
    });

    // Compute weighted probability
    let probability = 0;
    let totalWeight = 0;
    for (const f of factors) {
      probability += f.score * f.weight;
      totalWeight += f.weight;
    }
    probability = totalWeight > 0 ? probability / totalWeight : 0.5;
    probability = Math.round(probability * 1000) / 1000;

    // Determine risk level
    const riskLevel = probability >= 0.75 ? 'critical'
      : probability >= 0.5 ? 'high'
      : probability >= 0.25 ? 'medium'
      : 'low';

    // Generate mitigations
    const mitigations = this.generateMitigations(factors, riskLevel);

    const prediction: FailurePrediction = {
      id: uuidv4(),
      formulaName,
      probability,
      riskLevel,
      riskFactors: factors,
      mitigations,
      predictedAt: new Date(),
    };

    // Store for accuracy tracking
    this.predictions.push({
      id: prediction.id,
      formulaName,
      predicted: probability,
      timestamp: prediction.predictedAt,
    });
    if (this.predictions.length > this.maxPredictions) {
      this.predictions = this.predictions.slice(-this.maxPredictions);
    }

    // Broadcast if high risk
    if (riskLevel === 'high' || riskLevel === 'critical') {
      broadcast('meow:cognitive', {
        type: 'failure_prediction',
        prediction: {
          id: prediction.id,
          formulaName,
          probability,
          riskLevel,
          topRisk: factors.sort((a, b) => (b.score * b.weight) - (a.score * a.weight))[0]?.name,
          timestamp: prediction.predictedAt.toISOString(),
        },
      });
    }

    return prediction;
  }

  // ─── Formula risk profile ────────────────────────────────────────────

  async getFormulaRiskProfile(formulaName: string): Promise<RiskProfile> {
    // Check cache (expires every 10 minutes)
    if (this.cacheExpiry && this.cacheExpiry > new Date() && this.formulaCache.has(formulaName)) {
      return this.formulaCache.get(formulaName)!;
    }

    const pool = getPool();
    const defaultProfile: RiskProfile = {
      formulaName,
      totalExecutions: 0,
      failures: 0,
      failureRate: 0,
      avgDurationMs: 0,
      commonErrors: [],
      riskLevel: 'medium',
    };

    if (!pool) return defaultProfile;

    try {
      // Get execution stats
      const statsRes = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'failed') AS failures,
           AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000)
             FILTER (WHERE completed_at IS NOT NULL) AS avg_dur_ms
         FROM molecules
         WHERE formula_name = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        [formulaName],
      );

      const row = statsRes.rows[0];
      const total = parseInt(row.total) || 0;
      const failures = parseInt(row.failures) || 0;
      const avgDurationMs = parseFloat(row.avg_dur_ms) || 0;
      const failureRate = total > 0 ? failures / total : 0;

      // Get common errors
      const errRes = await pool.query(
        `SELECT me.error_class, COUNT(*) AS cnt
         FROM meow_errors me
         JOIN molecules m ON me.molecule_id = m.id
         WHERE m.formula_name = $1 AND me.created_at > NOW() - INTERVAL '30 days'
         GROUP BY me.error_class
         ORDER BY cnt DESC
         LIMIT 5`,
        [formulaName],
      );
      const commonErrors = errRes.rows.map((r: Record<string, unknown>) => r.error_class as string);

      // Get last failure
      const lastFailRes = await pool.query(
        `SELECT completed_at FROM molecules
         WHERE formula_name = $1 AND status = 'failed'
         ORDER BY completed_at DESC LIMIT 1`,
        [formulaName],
      );
      const lastFailure = lastFailRes.rows[0]?.completed_at
        ? new Date(lastFailRes.rows[0].completed_at as string)
        : undefined;

      const riskLevel = failureRate >= 0.5 ? 'critical'
        : failureRate >= 0.3 ? 'high'
        : failureRate >= 0.1 ? 'medium'
        : 'low';

      const profile: RiskProfile = {
        formulaName,
        totalExecutions: total,
        failures,
        failureRate: Math.round(failureRate * 1000) / 1000,
        avgDurationMs: Math.round(avgDurationMs),
        commonErrors,
        riskLevel,
        lastFailure,
      };

      // Update cache (evict oldest if over cap)
      if (this.formulaCache.size >= FailurePredictor.MAX_CACHE_SIZE) {
        const firstKey = this.formulaCache.keys().next().value;
        if (firstKey !== undefined) this.formulaCache.delete(firstKey);
      }
      this.formulaCache.set(formulaName, profile);
      if (!this.cacheExpiry || this.cacheExpiry < new Date()) {
        this.cacheExpiry = new Date(Date.now() + 10 * 60_000);
      }

      return profile;
    } catch (err) {
      console.error('[FailurePredictor] Failed to build risk profile:', err);
      return defaultProfile;
    }
  }

  // ─── Relearn weights from historical data ────────────────────────────

  async updateWeightsFromHistory(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Get molecules with known outcomes from last 30 days
      const { rows } = await pool.query(
        `SELECT formula_name, status, steps, vars,
                EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS dur_ms,
                created_at
         FROM molecules
         WHERE completed_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'
         LIMIT 5000`,
      );

      if (rows.length < 50) {
        console.info('[FailurePredictor] Insufficient data for weight update (need 50+, have %d)', rows.length);
        return;
      }

      // Calculate correlation: for each feature, measure its correlation with failure
      const featureCorrelations: Record<string, number> = {
        formulaHistory: 0,
        timeOfDay: 0,
        workerLoad: 0,
        skillComplexity: 0,
        externalDependency: 0,
        recentErrors: 0,
      };

      const failedFormulas = new Map<string, number>();
      const totalFormulas = new Map<string, number>();

      for (const row of rows) {
        const fname = row.formula_name as string;
        totalFormulas.set(fname, (totalFormulas.get(fname) || 0) + 1);
        if (row.status === 'failed') {
          failedFormulas.set(fname, (failedFormulas.get(fname) || 0) + 1);
        }
      }

      // Formulas with high failure rates should increase formulaHistory weight
      let highFailFormulas = 0;
      totalFormulas.forEach((total, fname) => {
        const failed = failedFormulas.get(fname) || 0;
        if (total >= 3 && failed / total > 0.3) highFailFormulas++;
      });
      featureCorrelations.formulaHistory = Math.min(1, highFailFormulas / Math.max(1, totalFormulas.size));

      // Time-of-day: check if failures cluster at peak hours
      let peakFailures = 0;
      let peakTotal = 0;
      let offPeakFailures = 0;
      let offPeakTotal = 0;
      for (const row of rows) {
        const hour = new Date(row.created_at as string).getUTCHours();
        const isPeak = PEAK_HOURS.has(hour);
        if (isPeak) {
          peakTotal++;
          if (row.status === 'failed') peakFailures++;
        } else {
          offPeakTotal++;
          if (row.status === 'failed') offPeakFailures++;
        }
      }
      const peakRate = peakTotal > 0 ? peakFailures / peakTotal : 0;
      const offPeakRate = offPeakTotal > 0 ? offPeakFailures / offPeakTotal : 0;
      featureCorrelations.timeOfDay = Math.abs(peakRate - offPeakRate);

      // Skill complexity: correlate step count with failures
      let complexFails = 0;
      let complexTotal = 0;
      let simpleFails = 0;
      let simpleTotal = 0;
      for (const row of rows) {
        const steps = Array.isArray(row.steps) ? row.steps.length : 0;
        if (steps > 5) {
          complexTotal++;
          if (row.status === 'failed') complexFails++;
        } else {
          simpleTotal++;
          if (row.status === 'failed') simpleFails++;
        }
      }
      const complexRate = complexTotal > 0 ? complexFails / complexTotal : 0;
      const simpleRate = simpleTotal > 0 ? simpleFails / simpleTotal : 0;
      featureCorrelations.skillComplexity = Math.abs(complexRate - simpleRate);

      // Normalize and apply as new weights (blend 70% old + 30% new)
      const totalCorrelation = Object.values(featureCorrelations).reduce((s, v) => s + v, 0) || 1;
      for (const key of Object.keys(featureCorrelations) as (keyof FeatureWeights)[]) {
        const normalized = featureCorrelations[key] / totalCorrelation;
        this.weights[key] = Math.round((this.weights[key] * 0.7 + normalized * 0.3) * 1000) / 1000;
      }

      // Ensure weights sum is reasonable (re-normalize)
      const weightSum = Object.values(this.weights).reduce((s, v) => s + v, 0);
      if (weightSum > 0) {
        for (const key of Object.keys(this.weights) as (keyof FeatureWeights)[]) {
          this.weights[key] = Math.round((this.weights[key] / weightSum) * 1000) / 1000;
        }
      }

      console.info('[FailurePredictor] Weights updated from %d historical molecules', rows.length);
      broadcast('meow:cognitive', {
        type: 'weights_updated',
        module: 'failure_prediction',
        weights: { ...this.weights },
      });
    } catch (err) {
      console.error('[FailurePredictor] Failed to update weights:', err);
    }
  }

  // ─── Accuracy tracking ───────────────────────────────────────────────

  recordActualOutcome(predictionId: string, failed: boolean): void {
    const pred = this.predictions.find(p => p.id === predictionId);
    if (pred) {
      pred.actual = failed;
    }
  }

  getAccuracy(): PredictionAccuracy {
    const withOutcome = this.predictions.filter(p => p.actual !== undefined);
    if (withOutcome.length === 0) {
      return { totalPredictions: this.predictions.length, correct: 0, falsePositives: 0, falseNegatives: 0, accuracy: 0, precision: 0, recall: 0 };
    }

    let correct = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const p of withOutcome) {
      const predictedFail = p.predicted >= 0.5;
      const actualFail = p.actual!;

      if (predictedFail === actualFail) correct++;
      else if (predictedFail && !actualFail) falsePositives++;
      else if (!predictedFail && actualFail) falseNegatives++;
    }

    const truePositives = withOutcome.filter(p => p.predicted >= 0.5 && p.actual === true).length;
    const precision = (truePositives + falsePositives) > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;
    const recall = (truePositives + falseNegatives) > 0
      ? truePositives / (truePositives + falseNegatives)
      : 0;

    return {
      totalPredictions: this.predictions.length,
      correct,
      falsePositives,
      falseNegatives,
      accuracy: Math.round((correct / withOutcome.length) * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  private async computeWorkerLoadScore(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0.3;

    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'running') AS active,
           COUNT(*) AS total
         FROM molecules
         WHERE created_at > NOW() - INTERVAL '1 hour'`,
      );
      const active = parseInt(rows[0]?.active) || 0;
      const total = parseInt(rows[0]?.total) || 1;
      return Math.min(1.0, active / Math.max(total, 5));
    } catch {
      return 0.3;
    }
  }

  private async getFormulaStepCount(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 3;

    try {
      const { rows } = await pool.query(
        `SELECT steps FROM molecules
         WHERE formula_name = $1
         ORDER BY created_at DESC LIMIT 1`,
        [formulaName],
      );
      if (rows.length > 0 && Array.isArray(rows[0].steps)) {
        return rows[0].steps.length;
      }
      return 3;
    } catch {
      return 3;
    }
  }

  private async countExternalDependencies(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 1;

    try {
      const { rows } = await pool.query(
        `SELECT steps FROM molecules
         WHERE formula_name = $1
         ORDER BY created_at DESC LIMIT 1`,
        [formulaName],
      );
      if (rows.length > 0 && Array.isArray(rows[0].steps)) {
        const steps = rows[0].steps as Array<{ skill?: string }>;
        return steps.filter(s => s.skill && EXTERNAL_SKILLS.has(s.skill)).length;
      }
      return 1;
    } catch {
      return 1;
    }
  }

  private async computeRecentErrorScore(formulaName: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0.2;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM meow_errors me
         JOIN molecules m ON me.molecule_id = m.id
         WHERE m.formula_name = $1 AND me.created_at > NOW() - INTERVAL '1 hour'`,
        [formulaName],
      );
      const count = parseInt(rows[0]?.cnt) || 0;
      return Math.min(1.0, count / 5); // 5+ recent errors = max score
    } catch {
      return 0.2;
    }
  }

  private generateMitigations(factors: RiskFactor[], riskLevel: string): string[] {
    const mitigations: string[] = [];
    const sorted = [...factors].sort((a, b) => (b.score * b.weight) - (a.score * a.weight));

    for (const f of sorted.slice(0, 3)) {
      if (f.score < 0.3) continue;

      switch (f.name) {
        case 'formula_history':
          mitigations.push('Consider running a dry-run first or reducing batch size');
          break;
        case 'time_of_day':
          mitigations.push('Schedule execution during off-peak hours (UTC 00:00-12:00)');
          break;
        case 'worker_load':
          mitigations.push('Wait for current worker load to decrease or scale pool');
          break;
        case 'skill_complexity':
          mitigations.push('Break formula into smaller sub-formulas to isolate failures');
          break;
        case 'external_dependency':
          mitigations.push('Pre-check external API health before execution');
          break;
        case 'recent_errors':
          mitigations.push('Investigate recent errors before retrying — root cause may persist');
          break;
      }
    }

    if (riskLevel === 'critical') {
      mitigations.push('CRITICAL: Consider manual approval gate before execution');
    }

    return mitigations;
  }

  getWeights(): FeatureWeights {
    return { ...this.weights };
  }

  getPredictionCount(): number {
    return this.predictions.length;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: FailurePredictor | null = null;

export function getFailurePredictor(): FailurePredictor {
  if (!instance) {
    instance = new FailurePredictor();
  }
  return instance;
}
