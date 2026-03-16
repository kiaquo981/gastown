/**
 * DYNAMIC TIER ADJUSTMENT -- CG-014 (Stage 05 Wave 4)
 *
 * Auto-adjusts worker Gemini tier based on performance over time.
 *
 * Tracks per-worker:
 *   - success rate, quality scores, cost per task
 *   - latency profile, error patterns, task complexity
 *
 * Rules:
 *   - If worker consistently produces high quality on tier B, keep there (cost savings)
 *   - If worker struggles on current tier, suggest upgrade
 *   - If worker is over-provisioned (tier S for simple tasks), suggest downgrade
 *   - Budget-aware: won't upgrade if budget is tight
 *
 * Tier levels:
 *   S → gemini-2.0-flash        (most capable, most expensive)
 *   A → gemini-2.0-flash        (same model, different budget tier)
 *   B → gemini-2.0-flash-lite   (lightweight, cheapest)
 *
 * Evaluation window: configurable (default 50 tasks).
 * Persists adjustments to meow_tier_adjustments table.
 *
 * Gas Town: "Don't waste premium fuel on a scooter."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('dynamic-tier-adjustment');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentTier = 'S' | 'A' | 'B';

export type AdjustmentDirection = 'upgrade' | 'downgrade' | 'hold';

export interface TierConfig {
  tier: AgentTier;
  model: string;
  costPerMillionTokens: number;   // USD
  maxContextTokens: number;
  label: string;
}

export interface WorkerTierRecord {
  workerId: string;
  taskType: string;
  tier: AgentTier;
  success: boolean;
  qualityScore: number;           // 1-10
  durationMs: number;
  costUsd: number;
  tokenCount: number;
  completedAt: Date;
}

export interface TierPerformance {
  tier: AgentTier;
  taskCount: number;
  successRate: number;            // 0.0 - 1.0
  avgQuality: number;             // 1-10
  avgCostUsd: number;
  avgDurationMs: number;
  avgTokens: number;
  qualityPerDollar: number;       // quality / cost (higher = better value)
}

export interface AdjustmentRecommendation {
  id: string;
  workerId: string;
  currentTier: AgentTier;
  recommendedTier: AgentTier;
  direction: AdjustmentDirection;
  confidence: number;             // 0.0 - 1.0
  reasoning: string[];
  currentPerformance: TierPerformance;
  projectedSavingsUsd: number;    // negative = costs more
  evaluationWindow: number;       // tasks evaluated
  createdAt: Date;
}

export interface TierAdjustmentEvent {
  id: string;
  workerId: string;
  fromTier: AgentTier;
  toTier: AgentTier;
  direction: AdjustmentDirection;
  reasoning: string;
  approvedBy: string;             // 'auto' or operator ID
  adjustedAt: Date;
}

export interface TierBudgetState {
  monthlyBudgetUsd: number;
  spentThisMonthUsd: number;
  projectedMonthlyUsd: number;
  budgetUtilization: number;      // 0.0 - 1.0
  isTight: boolean;               // > 80% utilization
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_CONFIGS: Record<AgentTier, TierConfig> = {
  S: {
    tier: 'S',
    model: 'gemini-2.0-flash',
    costPerMillionTokens: 0.15,
    maxContextTokens: 1_000_000,
    label: 'Tier S (Flash)',
  },
  A: {
    tier: 'A',
    model: 'gemini-2.0-flash',
    costPerMillionTokens: 0.15,
    maxContextTokens: 1_000_000,
    label: 'Tier A (Flash)',
  },
  B: {
    tier: 'B',
    model: 'gemini-2.0-flash-lite',
    costPerMillionTokens: 0.02,
    maxContextTokens: 1_000_000,
    label: 'Tier B (Flash Lite)',
  },
};

const TIER_ORDER: AgentTier[] = ['B', 'A', 'S'];  // lowest to highest

/** Thresholds for tier adjustment decisions */
const THRESHOLDS = {
  /** Minimum tasks in evaluation window to make a decision */
  minEvalTasks: 10,
  /** Success rate below which we consider upgrading */
  upgradeSuccessThreshold: 0.75,
  /** Quality below which we consider upgrading */
  upgradeQualityThreshold: 5.0,
  /** Success rate above which we consider downgrading */
  downgradeSuccessThreshold: 0.92,
  /** Quality above which we consider downgrading */
  downgradeQualityThreshold: 7.5,
  /** Minimum confidence to auto-apply adjustment */
  autoApplyConfidence: 0.8,
  /** Budget utilization threshold for "tight budget" mode */
  tightBudgetThreshold: 0.8,
  /** Max consecutive upgrades without cooldown */
  maxConsecutiveUpgrades: 2,
  /** Cooldown after upgrade (minimum tasks before next eval) */
  postUpgradeCooldown: 30,
};

// ---------------------------------------------------------------------------
// Gemini helper (with heuristic fallback)
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a tier optimization engine. Analyze worker performance and recommend tier adjustments. Respond only with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in dynamic-tier-adjustment');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierIndex(tier: AgentTier): number {
  return TIER_ORDER.indexOf(tier);
}

function tierAbove(tier: AgentTier): AgentTier | null {
  const idx = tierIndex(tier);
  return idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null;
}

function tierBelow(tier: AgentTier): AgentTier | null {
  const idx = tierIndex(tier);
  return idx > 0 ? TIER_ORDER[idx - 1] : null;
}

// ---------------------------------------------------------------------------
// DynamicTierAdjuster
// ---------------------------------------------------------------------------

export class DynamicTierAdjuster {
  private records: WorkerTierRecord[] = [];
  private adjustments: TierAdjustmentEvent[] = [];
  private recommendations: AdjustmentRecommendation[] = [];
  private currentTiers = new Map<string, AgentTier>();
  private consecutiveUpgrades = new Map<string, number>();
  private lastAdjustmentTaskCount = new Map<string, number>();
  private maxRecords = 20_000;
  private maxAdjustments = 1_000;
  private evaluationWindow: number;
  private budget: TierBudgetState = {
    monthlyBudgetUsd: 100,
    spentThisMonthUsd: 0,
    projectedMonthlyUsd: 0,
    budgetUtilization: 0,
    isTight: false,
  };

  constructor(evaluationWindow = 50) {
    this.evaluationWindow = evaluationWindow;
  }

  // --- Record a task completion with tier info ------------------------------

  async recordTaskCompletion(
    workerId: string,
    taskType: string,
    tier: AgentTier,
    success: boolean,
    qualityScore: number,
    durationMs: number,
    costUsd: number,
    tokenCount: number,
  ): Promise<AdjustmentRecommendation | null> {
    const record: WorkerTierRecord = {
      workerId,
      taskType,
      tier,
      success,
      qualityScore: Math.max(1, Math.min(10, qualityScore)),
      durationMs,
      costUsd,
      tokenCount,
      completedAt: new Date(),
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    // Track current tier
    this.currentTiers.set(workerId, tier);

    // Persist record
    await this.persistRecord(record);

    // Check if evaluation is due
    const workerRecords = this.records.filter(r => r.workerId === workerId);
    const lastAdjustTask = this.lastAdjustmentTaskCount.get(workerId) ?? 0;
    const tasksSinceLastAdjust = workerRecords.length - lastAdjustTask;

    if (tasksSinceLastAdjust >= this.evaluationWindow) {
      return this.evaluate(workerId);
    }

    return null;
  }

  // --- Evaluate a worker and produce recommendation -------------------------

  async evaluate(workerId: string): Promise<AdjustmentRecommendation | null> {
    const workerRecords = this.records
      .filter(r => r.workerId === workerId)
      .slice(-this.evaluationWindow);

    if (workerRecords.length < THRESHOLDS.minEvalTasks) {
      log.info({ workerId, tasks: workerRecords.length }, 'Not enough tasks to evaluate');
      return null;
    }

    const currentTier = this.currentTiers.get(workerId) ?? 'A';
    const perf = this.computeTierPerformance(workerRecords, currentTier);
    const reasoning: string[] = [];
    let direction: AdjustmentDirection = 'hold';
    let recommendedTier: AgentTier = currentTier;
    let confidence = 0;

    // --- Upgrade logic ---
    const needsUpgrade =
      perf.successRate < THRESHOLDS.upgradeSuccessThreshold ||
      perf.avgQuality < THRESHOLDS.upgradeQualityThreshold;

    if (needsUpgrade) {
      const above = tierAbove(currentTier);
      if (above) {
        // Check consecutive upgrades limit
        const consecutive = this.consecutiveUpgrades.get(workerId) ?? 0;
        if (consecutive >= THRESHOLDS.maxConsecutiveUpgrades) {
          reasoning.push(
            `Worker hit max consecutive upgrades (${THRESHOLDS.maxConsecutiveUpgrades}). ` +
            `Possible fundamental task mismatch.`,
          );
          direction = 'hold';
        } else if (this.budget.isTight) {
          reasoning.push(
            `Upgrade recommended but budget is tight ` +
            `(${Math.round(this.budget.budgetUtilization * 100)}% utilization). Holding.`,
          );
          direction = 'hold';
        } else {
          direction = 'upgrade';
          recommendedTier = above;
          confidence = this.computeUpgradeConfidence(perf);
          reasoning.push(
            `Success rate ${(perf.successRate * 100).toFixed(1)}% < ${THRESHOLDS.upgradeSuccessThreshold * 100}% threshold`,
          );
          reasoning.push(
            `Avg quality ${perf.avgQuality.toFixed(1)} < ${THRESHOLDS.upgradeQualityThreshold} threshold`,
          );
          reasoning.push(
            `Recommend upgrade: ${currentTier} → ${above} (${TIER_CONFIGS[above].label})`,
          );
        }
      } else {
        reasoning.push(`Already at highest tier (${currentTier}). Cannot upgrade further.`);
        direction = 'hold';
      }
    }

    // --- Downgrade logic (only if not already upgrading) ---
    if (direction === 'hold') {
      const canDowngrade =
        perf.successRate >= THRESHOLDS.downgradeSuccessThreshold &&
        perf.avgQuality >= THRESHOLDS.downgradeQualityThreshold;

      if (canDowngrade) {
        const below = tierBelow(currentTier);
        if (below) {
          direction = 'downgrade';
          recommendedTier = below;
          confidence = this.computeDowngradeConfidence(perf);

          const currentCost = TIER_CONFIGS[currentTier].costPerMillionTokens;
          const newCost = TIER_CONFIGS[below].costPerMillionTokens;
          const savingsRatio = (currentCost - newCost) / currentCost;

          reasoning.push(
            `Success rate ${(perf.successRate * 100).toFixed(1)}% >= ${THRESHOLDS.downgradeSuccessThreshold * 100}% — excellent performance`,
          );
          reasoning.push(
            `Avg quality ${perf.avgQuality.toFixed(1)} >= ${THRESHOLDS.downgradeQualityThreshold} — consistently high`,
          );
          reasoning.push(
            `Recommend downgrade: ${currentTier} → ${below} (${TIER_CONFIGS[below].label}). ` +
            `Projected savings: ${(savingsRatio * 100).toFixed(0)}% per task.`,
          );
        }
      }
    }

    // If still hold, document why
    if (direction === 'hold' && reasoning.length === 0) {
      reasoning.push(
        `Performance within normal range. Success: ${(perf.successRate * 100).toFixed(1)}%, ` +
        `Quality: ${perf.avgQuality.toFixed(1)}. No adjustment needed.`,
      );
      confidence = 0.9;
    }

    // Try AI for borderline cases
    if (direction !== 'hold' && confidence < 0.7) {
      const aiAdvice = await this.getAiAdvice(workerId, currentTier, perf, direction);
      if (aiAdvice) {
        reasoning.push(`AI: ${aiAdvice.reasoning}`);
        if (aiAdvice.direction !== direction) {
          reasoning.push(`AI disagrees with heuristic (${direction} → ${aiAdvice.direction}). Using AI recommendation.`);
          direction = aiAdvice.direction;
          recommendedTier = aiAdvice.recommendedTier;
          confidence = Math.min(1, confidence + 0.1);
        } else {
          confidence = Math.min(1, confidence + 0.15);
        }
      }
    }

    // Compute projected savings
    const projectedSavingsUsd = this.computeProjectedSavings(
      currentTier,
      recommendedTier,
      perf.avgTokens,
      perf.taskCount,
    );

    const recommendation: AdjustmentRecommendation = {
      id: uuidv4(),
      workerId,
      currentTier,
      recommendedTier,
      direction,
      confidence: Math.round(confidence * 1000) / 1000,
      reasoning,
      currentPerformance: perf,
      projectedSavingsUsd: Math.round(projectedSavingsUsd * 100) / 100,
      evaluationWindow: workerRecords.length,
      createdAt: new Date(),
    };

    this.recommendations.push(recommendation);
    if (this.recommendations.length > 500) {
      this.recommendations = this.recommendations.slice(-500);
    }

    this.lastAdjustmentTaskCount.set(workerId, this.records.filter(r => r.workerId === workerId).length);

    await this.persistRecommendation(recommendation);

    broadcast('meow:cognitive', {
      type: 'tier_adjustment_recommendation',
      workerId,
      currentTier,
      recommendedTier,
      direction,
      confidence: recommendation.confidence,
      projectedSavingsUsd: recommendation.projectedSavingsUsd,
    });

    log.info(
      {
        workerId,
        direction,
        currentTier,
        recommendedTier,
        confidence: recommendation.confidence,
      },
      'Tier adjustment recommendation generated',
    );

    return recommendation;
  }

  // --- Apply a tier adjustment (after approval) -----------------------------

  async applyAdjustment(
    workerId: string,
    fromTier: AgentTier,
    toTier: AgentTier,
    approvedBy = 'auto',
  ): Promise<TierAdjustmentEvent> {
    const direction: AdjustmentDirection =
      tierIndex(toTier) > tierIndex(fromTier) ? 'upgrade' : 'downgrade';

    const event: TierAdjustmentEvent = {
      id: uuidv4(),
      workerId,
      fromTier,
      toTier,
      direction,
      reasoning: `Tier adjusted from ${fromTier} to ${toTier} by ${approvedBy}`,
      approvedBy,
      adjustedAt: new Date(),
    };

    this.adjustments.push(event);
    if (this.adjustments.length > this.maxAdjustments) {
      this.adjustments = this.adjustments.slice(-this.maxAdjustments);
    }

    this.currentTiers.set(workerId, toTier);

    // Track consecutive upgrades
    if (direction === 'upgrade') {
      const current = this.consecutiveUpgrades.get(workerId) ?? 0;
      this.consecutiveUpgrades.set(workerId, current + 1);
    } else {
      this.consecutiveUpgrades.set(workerId, 0);
    }

    await this.persistAdjustment(event);

    broadcast('meow:cognitive', {
      type: 'tier_adjustment_applied',
      workerId,
      fromTier,
      toTier,
      direction,
      approvedBy,
    });

    log.info({ workerId, fromTier, toTier, direction, approvedBy }, 'Tier adjustment applied');

    return event;
  }

  // --- Update budget state --------------------------------------------------

  updateBudget(
    monthlyBudgetUsd: number,
    spentThisMonthUsd: number,
    projectedMonthlyUsd: number,
  ): void {
    this.budget = {
      monthlyBudgetUsd,
      spentThisMonthUsd,
      projectedMonthlyUsd,
      budgetUtilization: monthlyBudgetUsd > 0 ? spentThisMonthUsd / monthlyBudgetUsd : 0,
      isTight:
        monthlyBudgetUsd > 0 &&
        spentThisMonthUsd / monthlyBudgetUsd > THRESHOLDS.tightBudgetThreshold,
    };
  }

  // --- Get current tier for a worker ----------------------------------------

  getCurrentTier(workerId: string): AgentTier {
    return this.currentTiers.get(workerId) ?? 'A';
  }

  // --- Get model name for a tier --------------------------------------------

  getModelForTier(tier: AgentTier): string {
    return TIER_CONFIGS[tier].model;
  }

  // --- Get recommendations for a worker -------------------------------------

  getRecommendations(workerId?: string): AdjustmentRecommendation[] {
    const recs = workerId
      ? this.recommendations.filter(r => r.workerId === workerId)
      : this.recommendations;
    return recs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // --- Get adjustment history -----------------------------------------------

  getAdjustmentHistory(workerId?: string): TierAdjustmentEvent[] {
    const events = workerId
      ? this.adjustments.filter(a => a.workerId === workerId)
      : this.adjustments;
    return events.sort((a, b) => b.adjustedAt.getTime() - a.adjustedAt.getTime());
  }

  // --- Load from DB ---------------------------------------------------------

  async loadHistory(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT worker_id, task_type, tier, success, quality_score,
                duration_ms, cost_usd, token_count, completed_at
         FROM meow_tier_adjustments
         WHERE completed_at > NOW() - INTERVAL '60 days'
         ORDER BY completed_at DESC
         LIMIT $1`,
        [this.maxRecords],
      );

      this.records = rows.map((r: Record<string, unknown>) => ({
        workerId: r.worker_id as string,
        taskType: r.task_type as string,
        tier: r.tier as AgentTier,
        success: r.success as boolean,
        qualityScore: parseFloat(r.quality_score as string),
        durationMs: parseFloat(r.duration_ms as string),
        costUsd: parseFloat(r.cost_usd as string),
        tokenCount: parseInt(r.token_count as string, 10),
        completedAt: new Date(r.completed_at as string),
      }));

      // Rebuild current tiers from most recent records
      for (const rec of this.records) {
        this.currentTiers.set(rec.workerId, rec.tier);
      }

      log.info({ count: this.records.length }, 'Loaded tier records from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load tier records from DB');
    }
  }

  // --- Private: compute tier performance ------------------------------------

  private computeTierPerformance(
    records: WorkerTierRecord[],
    tier: AgentTier,
  ): TierPerformance {
    const tierRecords = records.filter(r => r.tier === tier);
    if (tierRecords.length === 0) {
      return {
        tier,
        taskCount: 0,
        successRate: 0,
        avgQuality: 5,
        avgCostUsd: 0,
        avgDurationMs: 0,
        avgTokens: 0,
        qualityPerDollar: 0,
      };
    }

    const successes = tierRecords.filter(r => r.success).length;
    const successRate = successes / tierRecords.length;
    const avgQuality =
      tierRecords.reduce((s, r) => s + r.qualityScore, 0) / tierRecords.length;
    const avgCostUsd =
      tierRecords.reduce((s, r) => s + r.costUsd, 0) / tierRecords.length;
    const avgDurationMs =
      tierRecords.reduce((s, r) => s + r.durationMs, 0) / tierRecords.length;
    const avgTokens =
      tierRecords.reduce((s, r) => s + r.tokenCount, 0) / tierRecords.length;
    const qualityPerDollar = avgCostUsd > 0 ? avgQuality / avgCostUsd : 0;

    return {
      tier,
      taskCount: tierRecords.length,
      successRate: Math.round(successRate * 1000) / 1000,
      avgQuality: Math.round(avgQuality * 10) / 10,
      avgCostUsd: Math.round(avgCostUsd * 10000) / 10000,
      avgDurationMs: Math.round(avgDurationMs),
      avgTokens: Math.round(avgTokens),
      qualityPerDollar: Math.round(qualityPerDollar * 100) / 100,
    };
  }

  // --- Private: compute upgrade confidence ----------------------------------

  private computeUpgradeConfidence(perf: TierPerformance): number {
    let conf = 0.5;

    // Low success rate → higher confidence in upgrade
    if (perf.successRate < 0.6) conf += 0.25;
    else if (perf.successRate < 0.75) conf += 0.15;

    // Low quality → higher confidence
    if (perf.avgQuality < 4) conf += 0.2;
    else if (perf.avgQuality < 5) conf += 0.1;

    // More data → higher confidence
    if (perf.taskCount >= 30) conf += 0.1;
    if (perf.taskCount >= 50) conf += 0.05;

    return Math.min(1, conf);
  }

  // --- Private: compute downgrade confidence --------------------------------

  private computeDowngradeConfidence(perf: TierPerformance): number {
    let conf = 0.4;

    // High success rate → higher confidence in downgrade
    if (perf.successRate >= 0.98) conf += 0.25;
    else if (perf.successRate >= 0.95) conf += 0.15;

    // High quality → higher confidence
    if (perf.avgQuality >= 8.5) conf += 0.2;
    else if (perf.avgQuality >= 7.5) conf += 0.1;

    // More data → higher confidence
    if (perf.taskCount >= 30) conf += 0.1;
    if (perf.taskCount >= 50) conf += 0.05;

    return Math.min(1, conf);
  }

  // --- Private: compute projected savings -----------------------------------

  private computeProjectedSavings(
    fromTier: AgentTier,
    toTier: AgentTier,
    avgTokensPerTask: number,
    tasksInWindow: number,
  ): number {
    if (fromTier === toTier) return 0;

    const fromCost = TIER_CONFIGS[fromTier].costPerMillionTokens;
    const toCost = TIER_CONFIGS[toTier].costPerMillionTokens;
    const tokensPerM = avgTokensPerTask / 1_000_000;

    // Project monthly based on evaluation window rate
    const monthlyTasks = Math.round((tasksInWindow / this.evaluationWindow) * 30 * 24);
    const savings = (fromCost - toCost) * tokensPerM * monthlyTasks;

    return savings; // positive = saving money, negative = costs more
  }

  // --- Private: AI advice ---------------------------------------------------

  private async getAiAdvice(
    workerId: string,
    currentTier: AgentTier,
    perf: TierPerformance,
    heuristicDirection: AdjustmentDirection,
  ): Promise<{
    direction: AdjustmentDirection;
    recommendedTier: AgentTier;
    reasoning: string;
  } | null> {
    const prompt = `Analyze worker performance and recommend tier adjustment.

Worker: ${workerId}
Current Tier: ${currentTier} (${TIER_CONFIGS[currentTier].label})
Performance over last ${perf.taskCount} tasks:
  - Success rate: ${(perf.successRate * 100).toFixed(1)}%
  - Avg quality: ${perf.avgQuality}/10
  - Avg cost: $${perf.avgCostUsd.toFixed(4)}/task
  - Quality per dollar: ${perf.qualityPerDollar.toFixed(2)}
  - Avg tokens: ${perf.avgTokens}

Tier options:
  S: gemini-2.0-flash ($0.15/Mtok) — full capability
  A: gemini-2.0-flash ($0.15/Mtok) — standard
  B: gemini-2.0-flash-lite ($0.02/Mtok) — lightweight

Budget: ${this.budget.isTight ? 'TIGHT' : 'normal'} (${Math.round(this.budget.budgetUtilization * 100)}% utilized)
Heuristic suggests: ${heuristicDirection}

Respond with JSON: {"direction":"upgrade|downgrade|hold","recommendedTier":"S|A|B","reasoning":"brief explanation"}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        direction: AdjustmentDirection;
        recommendedTier: AgentTier;
        reasoning: string;
      };
      if (!['upgrade', 'downgrade', 'hold'].includes(parsed.direction)) return null;
      if (!['S', 'A', 'B'].includes(parsed.recommendedTier)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // --- Persistence: record --------------------------------------------------

  private async persistRecord(record: WorkerTierRecord): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_tier_adjustments
          (id, worker_id, task_type, tier, success, quality_score,
           duration_ms, cost_usd, token_count, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          uuidv4(),
          record.workerId,
          record.taskType,
          record.tier,
          record.success,
          record.qualityScore,
          record.durationMs,
          record.costUsd,
          record.tokenCount,
          record.completedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, workerId: record.workerId }, 'Failed to persist tier record');
    }
  }

  // --- Persistence: recommendation ------------------------------------------

  private async persistRecommendation(rec: AdjustmentRecommendation): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_tier_adjustments
          (id, worker_id, task_type, tier, success, quality_score,
           duration_ms, cost_usd, token_count, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          rec.id,
          rec.workerId,
          `recommendation:${rec.direction}`,
          rec.recommendedTier,
          rec.direction !== 'hold',
          rec.confidence * 10,
          0,
          rec.projectedSavingsUsd,
          rec.evaluationWindow,
          rec.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist tier recommendation');
    }
  }

  // --- Persistence: adjustment event ----------------------------------------

  private async persistAdjustment(event: TierAdjustmentEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_tier_adjustments
          (id, worker_id, task_type, tier, success, quality_score,
           duration_ms, cost_usd, token_count, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          event.id,
          event.workerId,
          `adjustment:${event.fromTier}->${event.toTier}`,
          event.toTier,
          true,
          10,
          0,
          0,
          0,
          event.adjustedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist tier adjustment event');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: DynamicTierAdjuster | null = null;

export function getDynamicTierAdjuster(): DynamicTierAdjuster {
  if (!instance) {
    instance = new DynamicTierAdjuster();
  }
  return instance;
}
