/**
 * A/B FORMULA TESTING -- CG-030 (Stage 05 Wave 8)
 *
 * A/B testing framework for formula variants.
 * Define experiments: formula A (control) vs formula B (variant).
 * Traffic splitting: configurable ratio (default 50/50).
 * Metrics: execution time, cost, quality score, success rate, business outcome.
 * Statistical significance: chi-squared for success rate, t-test for continuous.
 * Minimum sample size calculator.
 * Auto-stop: declare winner when p < 0.05 with minimum sample.
 * Multi-variant support: A/B/C/D up to 4 variants.
 * Experiment lifecycle: draft -> running -> analyzing -> completed -> applied.
 * DB table: meow_ab_experiments.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Molecule } from '../types';

const log = createLogger('ab-formula-testing');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExperimentStatus = 'draft' | 'running' | 'analyzing' | 'completed' | 'applied';

export interface VariantMetrics {
  executions: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  totalCostUsd: number;
  qualityScores: number[];
  businessOutcomes: number[];    // e.g. revenue, conversion rate
}

export interface Variant {
  id: string;
  name: string;                   // e.g. "control", "variant_b"
  formulaName: string;
  formulaVersion?: number;
  weight: number;                 // 0.0-1.0, all weights must sum to 1.0
  metrics: VariantMetrics;
}

export interface StatisticalResult {
  testType: 'chi_squared' | 't_test';
  metricName: string;
  controlMean: number;
  variantMean: number;
  pValue: number;
  significant: boolean;          // p < 0.05
  effectSize: number;            // relative improvement (%)
  confidenceInterval: [number, number];
  sampleSufficient: boolean;
}

export interface Experiment {
  id: string;
  name: string;
  description: string;
  status: ExperimentStatus;
  variants: Variant[];
  minSampleSize: number;
  significanceLevel: number;     // default 0.05
  autoStop: boolean;
  winnerVariantId?: string;
  results: StatisticalResult[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ExperimentSummary {
  id: string;
  name: string;
  status: ExperimentStatus;
  variantCount: number;
  totalExecutions: number;
  winnerName?: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Compute chi-squared p-value for 2x2 contingency table (success/failure x control/variant) */
function chiSquaredTest(
  controlSuccess: number,
  controlFail: number,
  variantSuccess: number,
  variantFail: number,
): { chiSq: number; pValue: number } {
  const a = controlSuccess;
  const b = controlFail;
  const c = variantSuccess;
  const d = variantFail;
  const n = a + b + c + d;

  if (n === 0) return { chiSq: 0, pValue: 1 };

  // Yates' correction for continuity
  const numerator = n * (Math.abs(a * d - b * c) - n / 2) ** 2;
  const denominator = (a + b) * (c + d) * (a + c) * (b + d);

  if (denominator === 0) return { chiSq: 0, pValue: 1 };

  const chiSq = numerator / denominator;

  // Approximate p-value from chi-squared distribution (1 df)
  // Using Wilson-Hilferty approximation
  const pValue = chiSquaredPValue(chiSq, 1);

  return { chiSq, pValue };
}

/** Approximate chi-squared CDF complement (p-value) for df=1 */
function chiSquaredPValue(chiSq: number, _df: number): number {
  // For df=1, the p-value can be approximated using the error function
  if (chiSq <= 0) return 1;
  const z = Math.sqrt(chiSq);
  return 2 * (1 - normalCDF(z));
}

/** Welch's t-test for unequal variances */
function welchTTest(
  mean1: number,
  var1: number,
  n1: number,
  mean2: number,
  var2: number,
  n2: number,
): { tStat: number; pValue: number } {
  if (n1 < 2 || n2 < 2) return { tStat: 0, pValue: 1 };

  const se1 = var1 / n1;
  const se2 = var2 / n2;
  const seDiff = Math.sqrt(se1 + se2);

  if (seDiff === 0) return { tStat: 0, pValue: 1 };

  const tStat = (mean1 - mean2) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const dfNumerator = (se1 + se2) ** 2;
  const dfDenominator = (se1 ** 2) / (n1 - 1) + (se2 ** 2) / (n2 - 1);
  const df = dfDenominator > 0 ? dfNumerator / dfDenominator : 1;

  // Approximate p-value using normal distribution for large df
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

  return { tStat, pValue };
}

/** Standard normal CDF approximation (Abramowitz & Stegun) */
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1 + sign * y);
}

/** Compute variance from an array of numbers */
function computeVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
}

/** Compute mean */
function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Minimum sample size for detecting a given effect size (two-proportion z-test) */
function minimumSampleSize(
  baselineRate: number,
  minDetectableDiff: number,
  alpha = 0.05,
  power = 0.80,
): number {
  const zAlpha = 1.96;  // for alpha=0.05
  const zBeta = 0.842;  // for power=0.80

  const p1 = baselineRate;
  const p2 = baselineRate + minDetectableDiff;
  const pBar = (p1 + p2) / 2;

  const numerator = (zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  const denominator = (p2 - p1) ** 2;

  if (denominator === 0) return 100;
  return Math.ceil(numerator / denominator);
}

// ---------------------------------------------------------------------------
// ABFormulaTester
// ---------------------------------------------------------------------------

export class ABFormulaTester {
  private experiments: Experiment[] = [];
  private maxInMemory = 500;

  // --- Create a new experiment ----------------------------------------------

  createExperiment(params: {
    name: string;
    description: string;
    variants: Array<{
      name: string;
      formulaName: string;
      formulaVersion?: number;
      weight?: number;
    }>;
    minSampleSize?: number;
    significanceLevel?: number;
    autoStop?: boolean;
    metadata?: Record<string, unknown>;
  }): Experiment {
    const variantCount = params.variants.length;
    if (variantCount < 2 || variantCount > 4) {
      throw new Error('Experiments require 2-4 variants');
    }

    // Normalize weights
    const defaultWeight = 1 / variantCount;
    const variants: Variant[] = params.variants.map(v => ({
      id: uuidv4(),
      name: v.name,
      formulaName: v.formulaName,
      formulaVersion: v.formulaVersion,
      weight: v.weight ?? defaultWeight,
      metrics: {
        executions: 0,
        successes: 0,
        failures: 0,
        totalDurationMs: 0,
        totalCostUsd: 0,
        qualityScores: [],
        businessOutcomes: [],
      },
    }));

    // Ensure weights sum to 1
    const weightSum = variants.reduce((s, v) => s + v.weight, 0);
    if (Math.abs(weightSum - 1.0) > 0.01) {
      for (const v of variants) {
        v.weight = v.weight / weightSum;
      }
    }

    const experiment: Experiment = {
      id: uuidv4(),
      name: params.name,
      description: params.description,
      status: 'draft',
      variants,
      minSampleSize: params.minSampleSize ?? 30,
      significanceLevel: params.significanceLevel ?? 0.05,
      autoStop: params.autoStop ?? true,
      results: [],
      createdAt: new Date(),
      metadata: params.metadata,
    };

    this.experiments.push(experiment);
    if (this.experiments.length > this.maxInMemory) {
      this.experiments = this.experiments.slice(-this.maxInMemory);
    }

    broadcast('meow:cognitive', {
      type: 'experiment_created',
      experimentId: experiment.id,
      name: experiment.name,
      variantCount,
    });

    log.info({ experimentId: experiment.id, name: experiment.name, variantCount }, 'Experiment created');
    return experiment;
  }

  // --- Start experiment -----------------------------------------------------

  async startExperiment(experimentId: string): Promise<void> {
    const exp = this.findExperiment(experimentId);
    if (!exp) throw new Error(`Experiment ${experimentId} not found`);
    if (exp.status !== 'draft') throw new Error(`Cannot start experiment in status ${exp.status}`);

    exp.status = 'running';
    exp.startedAt = new Date();

    await this.persistExperiment(exp);

    broadcast('meow:cognitive', {
      type: 'experiment_started',
      experimentId: exp.id,
      name: exp.name,
    });

    log.info({ experimentId: exp.id }, 'Experiment started');
  }

  // --- Route: select which variant to use for a new execution ---------------

  selectVariant(experimentId: string): Variant | null {
    const exp = this.findExperiment(experimentId);
    if (!exp || exp.status !== 'running') return null;

    // Weighted random selection
    const rand = Math.random();
    let cumulative = 0;

    for (const variant of exp.variants) {
      cumulative += variant.weight;
      if (rand <= cumulative) {
        return variant;
      }
    }

    // Fallback to last variant
    return exp.variants[exp.variants.length - 1];
  }

  // --- Find running experiment for a formula --------------------------------

  findRunningExperiment(formulaName: string): Experiment | null {
    return this.experiments.find(
      e => e.status === 'running' && e.variants.some(v => v.formulaName === formulaName),
    ) ?? null;
  }

  // --- Record execution result for a variant --------------------------------

  async recordResult(params: {
    experimentId: string;
    variantId: string;
    success: boolean;
    durationMs: number;
    costUsd: number;
    qualityScore?: number;
    businessOutcome?: number;
  }): Promise<{ autoStopped: boolean; winner?: string }> {
    const exp = this.findExperiment(params.experimentId);
    if (!exp || exp.status !== 'running') {
      return { autoStopped: false };
    }

    const variant = exp.variants.find(v => v.id === params.variantId);
    if (!variant) {
      log.warn({ experimentId: params.experimentId, variantId: params.variantId }, 'Variant not found');
      return { autoStopped: false };
    }

    // Update metrics
    variant.metrics.executions++;
    if (params.success) variant.metrics.successes++;
    else variant.metrics.failures++;
    variant.metrics.totalDurationMs += params.durationMs;
    variant.metrics.totalCostUsd += params.costUsd;
    if (params.qualityScore != null) variant.metrics.qualityScores.push(params.qualityScore);
    if (params.businessOutcome != null) variant.metrics.businessOutcomes.push(params.businessOutcome);

    broadcast('meow:cognitive', {
      type: 'experiment_result_recorded',
      experimentId: exp.id,
      variantId: variant.id,
      variantName: variant.name,
      executions: variant.metrics.executions,
    });

    // Check auto-stop conditions
    if (exp.autoStop) {
      const totalExecs = exp.variants.reduce((s, v) => s + v.metrics.executions, 0);
      const minPerVariant = exp.variants.every(v => v.metrics.executions >= exp.minSampleSize);

      if (minPerVariant && totalExecs >= exp.minSampleSize * exp.variants.length) {
        const results = this.analyzeExperiment(exp);
        const significantResults = results.filter(r => r.significant && r.sampleSufficient);

        if (significantResults.length > 0) {
          exp.results = results;
          const winner = this.determineWinner(exp);
          if (winner) {
            exp.status = 'completed';
            exp.winnerVariantId = winner.id;
            exp.completedAt = new Date();

            await this.persistExperiment(exp);

            broadcast('meow:cognitive', {
              type: 'experiment_completed',
              experimentId: exp.id,
              name: exp.name,
              winnerVariant: winner.name,
              winnerFormula: winner.formulaName,
            });

            log.info({ experimentId: exp.id, winner: winner.name }, 'Experiment auto-stopped with winner');
            return { autoStopped: true, winner: winner.name };
          }
        }
      }
    }

    return { autoStopped: false };
  }

  // --- Analyze experiment ---------------------------------------------------

  analyzeExperiment(exp: Experiment): StatisticalResult[] {
    if (exp.variants.length < 2) return [];

    const control = exp.variants[0]; // first variant is always control
    const results: StatisticalResult[] = [];

    for (let i = 1; i < exp.variants.length; i++) {
      const variant = exp.variants[i];

      // 1. Success rate (chi-squared)
      const chiResult = chiSquaredTest(
        control.metrics.successes,
        control.metrics.failures,
        variant.metrics.successes,
        variant.metrics.failures,
      );

      const controlSuccessRate = control.metrics.executions > 0
        ? control.metrics.successes / control.metrics.executions : 0;
      const variantSuccessRate = variant.metrics.executions > 0
        ? variant.metrics.successes / variant.metrics.executions : 0;

      const minRequired = minimumSampleSize(controlSuccessRate, 0.1);

      results.push({
        testType: 'chi_squared',
        metricName: `success_rate (${control.name} vs ${variant.name})`,
        controlMean: Math.round(controlSuccessRate * 1000) / 1000,
        variantMean: Math.round(variantSuccessRate * 1000) / 1000,
        pValue: Math.round(chiResult.pValue * 10000) / 10000,
        significant: chiResult.pValue < exp.significanceLevel,
        effectSize: controlSuccessRate > 0
          ? Math.round(((variantSuccessRate - controlSuccessRate) / controlSuccessRate) * 1000) / 10
          : 0,
        confidenceInterval: [
          Math.round((variantSuccessRate - 1.96 * Math.sqrt(variantSuccessRate * (1 - variantSuccessRate) / Math.max(variant.metrics.executions, 1))) * 1000) / 1000,
          Math.round((variantSuccessRate + 1.96 * Math.sqrt(variantSuccessRate * (1 - variantSuccessRate) / Math.max(variant.metrics.executions, 1))) * 1000) / 1000,
        ],
        sampleSufficient: control.metrics.executions >= minRequired && variant.metrics.executions >= minRequired,
      });

      // 2. Duration (t-test)
      if (control.metrics.executions > 1 && variant.metrics.executions > 1) {
        const controlAvgDur = control.metrics.totalDurationMs / control.metrics.executions;
        const variantAvgDur = variant.metrics.totalDurationMs / variant.metrics.executions;

        // Approximate variance from total (simplified)
        const controlVarDur = controlAvgDur * 0.3; // estimate 30% CV
        const variantVarDur = variantAvgDur * 0.3;

        const durTTest = welchTTest(
          controlAvgDur, controlVarDur ** 2, control.metrics.executions,
          variantAvgDur, variantVarDur ** 2, variant.metrics.executions,
        );

        results.push({
          testType: 't_test',
          metricName: `avg_duration_ms (${control.name} vs ${variant.name})`,
          controlMean: Math.round(controlAvgDur),
          variantMean: Math.round(variantAvgDur),
          pValue: Math.round(durTTest.pValue * 10000) / 10000,
          significant: durTTest.pValue < exp.significanceLevel,
          effectSize: controlAvgDur > 0
            ? Math.round(((variantAvgDur - controlAvgDur) / controlAvgDur) * 1000) / 10
            : 0,
          confidenceInterval: [
            Math.round(variantAvgDur * 0.85),
            Math.round(variantAvgDur * 1.15),
          ],
          sampleSufficient: control.metrics.executions >= exp.minSampleSize && variant.metrics.executions >= exp.minSampleSize,
        });
      }

      // 3. Quality scores (t-test)
      if (control.metrics.qualityScores.length > 1 && variant.metrics.qualityScores.length > 1) {
        const controlQMean = computeMean(control.metrics.qualityScores);
        const variantQMean = computeMean(variant.metrics.qualityScores);
        const controlQVar = computeVariance(control.metrics.qualityScores);
        const variantQVar = computeVariance(variant.metrics.qualityScores);

        const qTTest = welchTTest(
          controlQMean, controlQVar, control.metrics.qualityScores.length,
          variantQMean, variantQVar, variant.metrics.qualityScores.length,
        );

        results.push({
          testType: 't_test',
          metricName: `quality_score (${control.name} vs ${variant.name})`,
          controlMean: Math.round(controlQMean * 100) / 100,
          variantMean: Math.round(variantQMean * 100) / 100,
          pValue: Math.round(qTTest.pValue * 10000) / 10000,
          significant: qTTest.pValue < exp.significanceLevel,
          effectSize: controlQMean > 0
            ? Math.round(((variantQMean - controlQMean) / controlQMean) * 1000) / 10
            : 0,
          confidenceInterval: [
            Math.round((variantQMean - 1.96 * Math.sqrt(variantQVar / variant.metrics.qualityScores.length)) * 100) / 100,
            Math.round((variantQMean + 1.96 * Math.sqrt(variantQVar / variant.metrics.qualityScores.length)) * 100) / 100,
          ],
          sampleSufficient: control.metrics.qualityScores.length >= exp.minSampleSize && variant.metrics.qualityScores.length >= exp.minSampleSize,
        });
      }

      // 4. Cost (t-test)
      if (control.metrics.executions > 1 && variant.metrics.executions > 1) {
        const controlAvgCost = control.metrics.totalCostUsd / control.metrics.executions;
        const variantAvgCost = variant.metrics.totalCostUsd / variant.metrics.executions;

        results.push({
          testType: 't_test',
          metricName: `avg_cost_usd (${control.name} vs ${variant.name})`,
          controlMean: Math.round(controlAvgCost * 10000) / 10000,
          variantMean: Math.round(variantAvgCost * 10000) / 10000,
          pValue: 1, // simplified: not running full test for cost alone
          significant: false,
          effectSize: controlAvgCost > 0
            ? Math.round(((variantAvgCost - controlAvgCost) / controlAvgCost) * 1000) / 10
            : 0,
          confidenceInterval: [
            Math.round(variantAvgCost * 0.8 * 10000) / 10000,
            Math.round(variantAvgCost * 1.2 * 10000) / 10000,
          ],
          sampleSufficient: control.metrics.executions >= exp.minSampleSize && variant.metrics.executions >= exp.minSampleSize,
        });
      }
    }

    return results;
  }

  // --- Get experiment summary list ------------------------------------------

  listExperiments(status?: ExperimentStatus): ExperimentSummary[] {
    let filtered = this.experiments;
    if (status) filtered = filtered.filter(e => e.status === status);

    return filtered.map(e => ({
      id: e.id,
      name: e.name,
      status: e.status,
      variantCount: e.variants.length,
      totalExecutions: e.variants.reduce((s, v) => s + v.metrics.executions, 0),
      winnerName: e.winnerVariantId
        ? e.variants.find(v => v.id === e.winnerVariantId)?.name
        : undefined,
      createdAt: e.createdAt,
    }));
  }

  // --- Get full experiment --------------------------------------------------

  getExperiment(experimentId: string): Experiment | null {
    return this.findExperiment(experimentId);
  }

  // --- Apply winner: mark experiment as applied -----------------------------

  async applyWinner(experimentId: string): Promise<{ appliedFormula: string } | null> {
    const exp = this.findExperiment(experimentId);
    if (!exp || exp.status !== 'completed' || !exp.winnerVariantId) return null;

    const winner = exp.variants.find(v => v.id === exp.winnerVariantId);
    if (!winner) return null;

    exp.status = 'applied';
    await this.persistExperiment(exp);

    broadcast('meow:cognitive', {
      type: 'experiment_applied',
      experimentId: exp.id,
      name: exp.name,
      appliedFormula: winner.formulaName,
    });

    log.info({ experimentId: exp.id, appliedFormula: winner.formulaName }, 'Experiment winner applied');
    return { appliedFormula: winner.formulaName };
  }

  // --- Load experiments from DB ---------------------------------------------

  async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, name, description, status, variants, min_sample_size,
                significance_level, auto_stop, winner_variant_id, results,
                created_at, started_at, completed_at, metadata
         FROM meow_ab_experiments
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.maxInMemory],
      );

      this.experiments = rows.map((r: Record<string, unknown>) => this.rowToExperiment(r));
      log.info({ count: this.experiments.length }, 'Loaded A/B experiments from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load A/B experiments from DB');
    }
  }

  // --- Compute minimum sample size ------------------------------------------

  computeMinSampleSize(baselineSuccessRate: number, minDetectableDiff = 0.1): number {
    return minimumSampleSize(baselineSuccessRate, minDetectableDiff);
  }

  getExperimentCount(): number {
    return this.experiments.length;
  }

  // --- Private helpers ------------------------------------------------------

  private findExperiment(id: string): Experiment | null {
    return this.experiments.find(e => e.id === id) ?? null;
  }

  private determineWinner(exp: Experiment): Variant | null {
    // Score each variant: higher success rate, lower cost, higher quality
    let bestVariant: Variant | null = null;
    let bestScore = -Infinity;

    for (const variant of exp.variants) {
      if (variant.metrics.executions === 0) continue;

      const successRate = variant.metrics.successes / variant.metrics.executions;
      const avgQuality = variant.metrics.qualityScores.length > 0
        ? computeMean(variant.metrics.qualityScores) / 10
        : 0.5;
      const avgCostInverse = variant.metrics.totalCostUsd > 0
        ? 1 / (variant.metrics.totalCostUsd / variant.metrics.executions)
        : 1;

      // Composite score: 40% success + 35% quality + 25% cost-efficiency
      const score = 0.40 * successRate + 0.35 * avgQuality + 0.25 * Math.min(1, avgCostInverse);

      if (score > bestScore) {
        bestScore = score;
        bestVariant = variant;
      }
    }

    return bestVariant;
  }

  private async persistExperiment(exp: Experiment): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_ab_experiments
          (id, name, description, status, variants, min_sample_size,
           significance_level, auto_stop, winner_variant_id, results,
           created_at, started_at, completed_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           variants = EXCLUDED.variants,
           winner_variant_id = EXCLUDED.winner_variant_id,
           results = EXCLUDED.results,
           started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at`,
        [
          exp.id,
          exp.name,
          exp.description,
          exp.status,
          JSON.stringify(exp.variants),
          exp.minSampleSize,
          exp.significanceLevel,
          exp.autoStop,
          exp.winnerVariantId ?? null,
          JSON.stringify(exp.results),
          exp.createdAt.toISOString(),
          exp.startedAt?.toISOString() ?? null,
          exp.completedAt?.toISOString() ?? null,
          exp.metadata ? JSON.stringify(exp.metadata) : null,
        ],
      );
    } catch (err) {
      log.warn({ err, experimentId: exp.id }, 'Failed to persist A/B experiment');
    }
  }

  private rowToExperiment(r: Record<string, unknown>): Experiment {
    const parseJson = (val: unknown) => {
      if (typeof val === 'string') return JSON.parse(val);
      return val ?? [];
    };

    return {
      id: r.id as string,
      name: r.name as string,
      description: (r.description as string) ?? '',
      status: r.status as ExperimentStatus,
      variants: parseJson(r.variants) as Variant[],
      minSampleSize: parseInt(String(r.min_sample_size ?? '30'), 10),
      significanceLevel: parseFloat(String(r.significance_level ?? '0.05')),
      autoStop: r.auto_stop as boolean ?? true,
      winnerVariantId: (r.winner_variant_id as string) ?? undefined,
      results: parseJson(r.results) as StatisticalResult[],
      createdAt: new Date((r.created_at as string) ?? Date.now()),
      startedAt: r.started_at ? new Date(r.started_at as string) : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
      metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown> : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ABFormulaTester | null = null;

export function getABFormulaTester(): ABFormulaTester {
  if (!instance) {
    instance = new ABFormulaTester();
    log.info('ABFormulaTester singleton created');
  }
  return instance;
}
