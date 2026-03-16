/**
 * BUDGET MANAGEMENT AI -- CG-026 (Stage 05 Wave 7)
 *
 * AI-powered budget management and optimization for Gas Town.
 * Tracks spending per formula, skill, worker, and time period.
 * Predicts budget exhaustion, suggests optimizations, and enforces
 * emergency brakes when spending exceeds safety thresholds.
 *
 * Integrates with cost-tracking-real.ts and cost-forecasting.ts
 * for accurate burn rate data and projections.
 *
 * Features:
 *   - Per-formula, per-worker, per-day, and total monthly budgets
 *   - Burn rate trend analysis and exhaustion date prediction
 *   - AI-powered optimization suggestions via Gemini
 *   - Alert thresholds at 50/75/90/100% of budget consumed
 *   - Emergency brake: auto-pause non-critical formulas at >90%
 *   - Cost attribution per outcome (cost-per-successful-bead)
 *   - Monthly budget report generation
 *
 * Gas Town: "Count every drop of fuel, or the rig runs dry."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('budget-management-ai');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetScope = 'formula' | 'worker' | 'daily' | 'monthly' | 'total';

export type BudgetAlertSeverity = 'info' | 'warning' | 'danger' | 'critical';

export interface BudgetRule {
  id: string;
  scope: BudgetScope;
  scopeKey: string;                     // formula name, worker id, date, or 'total'
  limitUsd: number;
  spentUsd: number;
  utilizationPct: number;              // 0 - 100
  alertThresholds: number[];           // e.g. [50, 75, 90, 100]
  alertsFired: Set<number>;            // which thresholds already fired
  emergencyBrakeAt: number;            // pct at which to pause (default 90)
  brakeActive: boolean;
  period: string;                      // YYYY-MM or YYYY-MM-DD
  createdAt: Date;
  updatedAt: Date;
}

export interface SpendEntry {
  id: string;
  formulaName: string;
  skillName?: string;
  workerId?: string;
  moleculeId?: string;
  beadId?: string;
  costUsd: number;
  tokensUsed: number;
  provider: string;
  model: string;
  successful: boolean;
  createdAt: Date;
}

export interface BudgetAlert {
  id: string;
  ruleId: string;
  scope: BudgetScope;
  scopeKey: string;
  severity: BudgetAlertSeverity;
  thresholdPct: number;
  currentPct: number;
  spentUsd: number;
  limitUsd: number;
  message: string;
  createdAt: Date;
}

export interface OptimizationSuggestion {
  id: string;
  type: 'downgrade_tier' | 'batch_calls' | 'reduce_frequency' | 'switch_model' | 'defer_formula' | 'eliminate_waste';
  title: string;
  description: string;
  estimatedSavingsUsd: number;
  estimatedSavingsPct: number;
  targetFormula?: string;
  targetWorker?: string;
  confidence: number;                  // 0.0 - 1.0
  aiGenerated: boolean;
  createdAt: Date;
}

export interface BurnRateAnalysis {
  currentDailyBurnUsd: number;
  avgWeeklyBurnUsd: number;
  trendDirection: 'increasing' | 'stable' | 'decreasing';
  trendPctChange: number;
  exhaustionDate?: Date;              // when budget will hit 100%
  daysUntilExhaustion?: number;
  projectedMonthEndUsd: number;
  projectedMonthEndPct: number;
}

export interface CostAttribution {
  formulaName: string;
  totalCostUsd: number;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  costPerExecution: number;
  costPerSuccessfulOutcome: number;    // cost / successes
  shareOfTotalPct: number;
  efficiencyScore: number;             // 0 - 100 (success weighted by cost)
}

export interface MonthlyBudgetReport {
  id: string;
  month: string;                       // YYYY-MM
  totalBudgetUsd: number;
  totalSpentUsd: number;
  utilizationPct: number;
  topFormulas: CostAttribution[];
  topWorkers: Array<{ workerId: string; spentUsd: number; tasksCompleted: number }>;
  suggestions: OptimizationSuggestion[];
  burnRate: BurnRateAnalysis;
  alertsTriggered: number;
  brakesActivated: number;
  generatedAt: Date;
}

export interface BudgetManagerStats {
  totalRules: number;
  activeAlerts: number;
  brakesActive: number;
  totalSpendThisMonth: number;
  monthlyBudget: number;
  utilizationPct: number;
  suggestionsGenerated: number;
  formulasTracked: number;
  workersTracked: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ALERT_THRESHOLDS = [50, 75, 90, 100];
const DEFAULT_EMERGENCY_BRAKE_PCT = 90;
const DEFAULT_MONTHLY_BUDGET_USD = 500;
const BURN_RATE_LOOKBACK_DAYS = 7;
const MAX_SPEND_ENTRIES = 10_000;
const MAX_ALERTS = 1_000;
const MAX_SUGGESTIONS = 200;

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiBudgetAdvisor(context: string): Promise<string | null> {
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
                'You are a budget optimization AI for an AI agent orchestration platform. '
                + 'Analyze spending data and suggest concrete cost savings. '
                + 'Respond ONLY with valid JSON: {"suggestions": [{"type": "downgrade_tier|batch_calls|reduce_frequency|switch_model|defer_formula|eliminate_waste", '
                + '"title": "short title", "description": "actionable detail", "estimatedSavingsUsd": number, "confidence": 0.0-1.0}]}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 1024,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini budget advisor call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// BudgetManagementAI
// ---------------------------------------------------------------------------

export class BudgetManagementAI {
  private rules = new Map<string, BudgetRule>();
  private spendLog: SpendEntry[] = [];
  private alerts: BudgetAlert[] = [];
  private suggestions: OptimizationSuggestion[] = [];
  private monthlyBudgetUsd: number = DEFAULT_MONTHLY_BUDGET_USD;

  // --- Record a spend event --------------------------------------------------

  async recordSpend(entry: Omit<SpendEntry, 'id' | 'createdAt'>): Promise<void> {
    const spend: SpendEntry = {
      ...entry,
      id: uuidv4(),
      createdAt: new Date(),
    };

    this.spendLog.push(spend);
    if (this.spendLog.length > MAX_SPEND_ENTRIES) {
      this.spendLog = this.spendLog.slice(-MAX_SPEND_ENTRIES);
    }

    // Update all matching budget rules
    await this.updateBudgetRules(spend);

    // Persist spend entry
    await this.persistSpend(spend);
  }

  // --- Set a budget rule -----------------------------------------------------

  setBudgetRule(scope: BudgetScope, scopeKey: string, limitUsd: number, period?: string): BudgetRule {
    const now = new Date();
    const effectivePeriod = period ?? this.getCurrentPeriod(scope);
    const ruleKey = `${scope}:${scopeKey}:${effectivePeriod}`;

    const existing = this.rules.get(ruleKey);
    if (existing) {
      existing.limitUsd = limitUsd;
      existing.updatedAt = now;
      log.info({ scope, scopeKey, limitUsd, period: effectivePeriod }, 'Budget rule updated');
      return existing;
    }

    const rule: BudgetRule = {
      id: uuidv4(),
      scope,
      scopeKey,
      limitUsd,
      spentUsd: 0,
      utilizationPct: 0,
      alertThresholds: [...DEFAULT_ALERT_THRESHOLDS],
      alertsFired: new Set<number>(),
      emergencyBrakeAt: DEFAULT_EMERGENCY_BRAKE_PCT,
      brakeActive: false,
      period: effectivePeriod,
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(ruleKey, rule);
    this.persistRule(rule);

    log.info({ scope, scopeKey, limitUsd, period: effectivePeriod }, 'Budget rule created');
    return rule;
  }

  // --- Get budget rules ------------------------------------------------------

  getRule(scope: BudgetScope, scopeKey: string, period?: string): BudgetRule | null {
    const effectivePeriod = period ?? this.getCurrentPeriod(scope);
    return this.rules.get(`${scope}:${scopeKey}:${effectivePeriod}`) ?? null;
  }

  getAllRules(): BudgetRule[] {
    return Array.from(this.rules.values());
  }

  getActiveRules(): BudgetRule[] {
    const currentMonth = this.getCurrentPeriod('monthly');
    const currentDay = this.getCurrentPeriod('daily');
    return Array.from(this.rules.values()).filter(r =>
      r.period === currentMonth || r.period === currentDay || r.scope === 'total',
    );
  }

  // --- Check if an operation is within budget --------------------------------

  checkBudget(formulaName: string, workerId?: string, estimatedCostUsd?: number): {
    allowed: boolean;
    reason?: string;
    brakeActive: boolean;
    utilizationPct: number;
  } {
    const cost = estimatedCostUsd ?? 0;

    // Check total monthly budget
    const totalRule = this.getRule('total', 'total');
    if (totalRule && totalRule.brakeActive) {
      return {
        allowed: false,
        reason: `Emergency brake active: total budget at ${totalRule.utilizationPct.toFixed(1)}%`,
        brakeActive: true,
        utilizationPct: totalRule.utilizationPct,
      };
    }

    // Check formula-specific budget
    const formulaRule = this.getRule('formula', formulaName);
    if (formulaRule && formulaRule.brakeActive) {
      return {
        allowed: false,
        reason: `Emergency brake active for formula "${formulaName}": ${formulaRule.utilizationPct.toFixed(1)}% utilized`,
        brakeActive: true,
        utilizationPct: formulaRule.utilizationPct,
      };
    }

    // Check worker budget
    if (workerId) {
      const workerRule = this.getRule('worker', workerId);
      if (workerRule && workerRule.brakeActive) {
        return {
          allowed: false,
          reason: `Emergency brake active for worker "${workerId}": ${workerRule.utilizationPct.toFixed(1)}% utilized`,
          brakeActive: true,
          utilizationPct: workerRule.utilizationPct,
        };
      }
    }

    // Check daily budget
    const dailyRule = this.getRule('daily', 'total');
    if (dailyRule && dailyRule.brakeActive) {
      return {
        allowed: false,
        reason: `Daily emergency brake active: ${dailyRule.utilizationPct.toFixed(1)}% utilized`,
        brakeActive: true,
        utilizationPct: dailyRule.utilizationPct,
      };
    }

    // Check if adding this cost would trigger brake
    if (totalRule && cost > 0) {
      const projected = totalRule.spentUsd + cost;
      const projectedPct = (projected / totalRule.limitUsd) * 100;
      if (projectedPct >= totalRule.emergencyBrakeAt) {
        return {
          allowed: false,
          reason: `This operation ($${cost.toFixed(4)}) would push total spend to ${projectedPct.toFixed(1)}%, exceeding brake threshold`,
          brakeActive: false,
          utilizationPct: totalRule.utilizationPct,
        };
      }
    }

    const currentPct = totalRule?.utilizationPct ?? 0;
    return { allowed: true, brakeActive: false, utilizationPct: currentPct };
  }

  // --- Burn rate analysis ----------------------------------------------------

  async analyzeBurnRate(): Promise<BurnRateAnalysis> {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = Math.max(1, now.getDate());
    const daysRemaining = daysInMonth - daysElapsed;

    // Get daily costs for lookback period
    const dailyCosts = await this.getDailyCosts(BURN_RATE_LOOKBACK_DAYS);
    const currentDailyBurn = dailyCosts.length > 0
      ? dailyCosts.reduce((s, d) => s + d.total, 0) / dailyCosts.length
      : 0;

    const avgWeeklyBurn = currentDailyBurn * 7;

    // Detect trend
    const trend = this.detectTrend(dailyCosts.map(d => d.total));
    const trendPct = this.computeTrendPct(dailyCosts.map(d => d.total));

    // Current month spend
    const monthSpend = await this.getMonthToDateSpend();

    // Project month end
    const projectedMonthEnd = monthSpend + currentDailyBurn * daysRemaining;
    const projectedMonthEndPct = this.monthlyBudgetUsd > 0
      ? (projectedMonthEnd / this.monthlyBudgetUsd) * 100
      : 0;

    // Exhaustion date
    let exhaustionDate: Date | undefined;
    let daysUntilExhaustion: number | undefined;
    if (currentDailyBurn > 0 && this.monthlyBudgetUsd > 0) {
      const remaining = this.monthlyBudgetUsd - monthSpend;
      if (remaining > 0) {
        daysUntilExhaustion = Math.ceil(remaining / currentDailyBurn);
        exhaustionDate = new Date(now.getTime() + daysUntilExhaustion * 86_400_000);
      } else {
        daysUntilExhaustion = 0;
        exhaustionDate = now;
      }
    }

    return {
      currentDailyBurnUsd: Math.round(currentDailyBurn * 10000) / 10000,
      avgWeeklyBurnUsd: Math.round(avgWeeklyBurn * 100) / 100,
      trendDirection: trend,
      trendPctChange: Math.round(trendPct * 100) / 100,
      exhaustionDate,
      daysUntilExhaustion,
      projectedMonthEndUsd: Math.round(projectedMonthEnd * 100) / 100,
      projectedMonthEndPct: Math.round(projectedMonthEndPct * 10) / 10,
    };
  }

  // --- Cost attribution ------------------------------------------------------

  async getCostAttribution(): Promise<CostAttribution[]> {
    const pool = getPool();
    if (!pool) return this.getInMemoryCostAttribution();

    try {
      const { rows } = await pool.query(
        `SELECT
           formula_name,
           SUM(cost_usd) AS total_cost,
           COUNT(*) AS total_exec,
           COUNT(*) FILTER (WHERE successful = true) AS success_exec,
           COUNT(*) FILTER (WHERE successful = false) AS fail_exec
         FROM meow_budget_spend
         WHERE created_at >= DATE_TRUNC('month', NOW())
         GROUP BY formula_name
         ORDER BY total_cost DESC
         LIMIT 50`,
      );

      const totalCost = rows.reduce((s: number, r: Record<string, unknown>) => s + (parseFloat(r.total_cost as string) || 0), 0);

      return rows.map((r: Record<string, unknown>) => {
        const cost = parseFloat(r.total_cost as string) || 0;
        const total = parseInt(r.total_exec as string) || 0;
        const successes = parseInt(r.success_exec as string) || 0;
        const failures = parseInt(r.fail_exec as string) || 0;
        const costPerExec = total > 0 ? cost / total : 0;
        const costPerSuccess = successes > 0 ? cost / successes : 0;
        const successRate = total > 0 ? successes / total : 0;

        return {
          formulaName: r.formula_name as string,
          totalCostUsd: Math.round(cost * 10000) / 10000,
          totalExecutions: total,
          successfulExecutions: successes,
          failedExecutions: failures,
          costPerExecution: Math.round(costPerExec * 10000) / 10000,
          costPerSuccessfulOutcome: Math.round(costPerSuccess * 10000) / 10000,
          shareOfTotalPct: totalCost > 0 ? Math.round((cost / totalCost) * 1000) / 10 : 0,
          efficiencyScore: Math.round(successRate * (1 - Math.min(1, costPerExec / 1)) * 100),
        };
      });
    } catch (err) {
      log.warn({ err }, 'Failed to get cost attribution from DB');
      return this.getInMemoryCostAttribution();
    }
  }

  // --- AI optimization suggestions -------------------------------------------

  async generateSuggestions(): Promise<OptimizationSuggestion[]> {
    const attribution = await this.getCostAttribution();
    const burnRate = await this.analyzeBurnRate();
    const rules = this.getActiveRules();

    // Build context for AI
    const topFormulas = attribution.slice(0, 10).map(a =>
      `- ${a.formulaName}: $${a.totalCostUsd} (${a.totalExecutions} exec, ${Math.round(a.successfulExecutions / Math.max(1, a.totalExecutions) * 100)}% success, $${a.costPerExecution}/exec)`,
    ).join('\n');

    const context = `Budget Analysis:
Monthly budget: $${this.monthlyBudgetUsd}
Current daily burn: $${burnRate.currentDailyBurnUsd}/day
Trend: ${burnRate.trendDirection} (${burnRate.trendPctChange}%)
Projected month-end: $${burnRate.projectedMonthEndUsd} (${burnRate.projectedMonthEndPct}%)
Days until exhaustion: ${burnRate.daysUntilExhaustion ?? 'N/A'}

Top formulas by cost:
${topFormulas}

Budget rules with high utilization:
${rules.filter(r => r.utilizationPct > 50).map(r => `- ${r.scope}:${r.scopeKey}: ${r.utilizationPct.toFixed(1)}% ($${r.spentUsd.toFixed(2)}/$${r.limitUsd.toFixed(2)})`).join('\n') || 'None'}

Suggest 2-4 concrete cost savings opportunities.`;

    const raw = await callGeminiBudgetAdvisor(context);
    const newSuggestions: OptimizationSuggestion[] = [];

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            suggestions?: Array<{
              type: string;
              title: string;
              description: string;
              estimatedSavingsUsd: number;
              confidence: number;
            }>;
          };

          if (Array.isArray(parsed.suggestions)) {
            for (const s of parsed.suggestions) {
              newSuggestions.push({
                id: uuidv4(),
                type: s.type as OptimizationSuggestion['type'],
                title: s.title,
                description: s.description,
                estimatedSavingsUsd: Math.round((s.estimatedSavingsUsd || 0) * 100) / 100,
                estimatedSavingsPct: this.monthlyBudgetUsd > 0
                  ? Math.round(((s.estimatedSavingsUsd || 0) / this.monthlyBudgetUsd) * 1000) / 10
                  : 0,
                confidence: Math.max(0, Math.min(1, s.confidence || 0.5)),
                aiGenerated: true,
                createdAt: new Date(),
              });
            }
          }
        }
      } catch {
        log.warn('Failed to parse AI budget suggestions');
      }
    }

    // Always add heuristic suggestions as fallback/supplement
    const heuristics = this.generateHeuristicSuggestions(attribution, burnRate);
    for (const h of heuristics) {
      if (!newSuggestions.find(s => s.type === h.type && s.targetFormula === h.targetFormula)) {
        newSuggestions.push(h);
      }
    }

    this.suggestions.push(...newSuggestions);
    if (this.suggestions.length > MAX_SUGGESTIONS) {
      this.suggestions = this.suggestions.slice(-MAX_SUGGESTIONS);
    }

    broadcast('meow:cognitive', {
      type: 'budget_suggestions',
      count: newSuggestions.length,
      totalSavingsUsd: Math.round(newSuggestions.reduce((s, sug) => s + sug.estimatedSavingsUsd, 0) * 100) / 100,
    });

    log.info({ count: newSuggestions.length }, 'Budget optimization suggestions generated');
    return newSuggestions;
  }

  // --- Monthly report --------------------------------------------------------

  async generateMonthlyReport(): Promise<MonthlyBudgetReport> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const attribution = await this.getCostAttribution();
    const burnRate = await this.analyzeBurnRate();
    const suggestions = await this.generateSuggestions();
    const topWorkers = await this.getTopWorkerSpend();
    const monthSpend = await this.getMonthToDateSpend();

    const brakesActivated = Array.from(this.rules.values()).filter(r => r.brakeActive).length;

    const report: MonthlyBudgetReport = {
      id: uuidv4(),
      month,
      totalBudgetUsd: this.monthlyBudgetUsd,
      totalSpentUsd: Math.round(monthSpend * 100) / 100,
      utilizationPct: this.monthlyBudgetUsd > 0
        ? Math.round((monthSpend / this.monthlyBudgetUsd) * 1000) / 10
        : 0,
      topFormulas: attribution.slice(0, 15),
      topWorkers,
      suggestions: suggestions.slice(0, 10),
      burnRate,
      alertsTriggered: this.alerts.filter(a =>
        a.createdAt.getMonth() === now.getMonth() && a.createdAt.getFullYear() === now.getFullYear(),
      ).length,
      brakesActivated,
      generatedAt: now,
    };

    broadcast('meow:cognitive', {
      type: 'budget_monthly_report',
      month,
      totalSpentUsd: report.totalSpentUsd,
      utilizationPct: report.utilizationPct,
      suggestionsCount: report.suggestions.length,
    });

    log.info({ month, spentUsd: report.totalSpentUsd, utilizationPct: report.utilizationPct }, 'Monthly budget report generated');
    return report;
  }

  // --- Set monthly budget ----------------------------------------------------

  setMonthlyBudget(budgetUsd: number): void {
    this.monthlyBudgetUsd = budgetUsd;
    this.setBudgetRule('total', 'total', budgetUsd);
    log.info({ budgetUsd }, 'Monthly budget updated');
  }

  getMonthlyBudget(): number {
    return this.monthlyBudgetUsd;
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): BudgetManagerStats {
    const totalRule = this.getRule('total', 'total');
    const formulaNames = new Set(this.spendLog.map(s => s.formulaName));
    const workerIds = new Set(this.spendLog.filter(s => s.workerId).map(s => s.workerId!));

    return {
      totalRules: this.rules.size,
      activeAlerts: this.alerts.filter(a => {
        const age = Date.now() - a.createdAt.getTime();
        return age < 24 * 60 * 60_000; // last 24h
      }).length,
      brakesActive: Array.from(this.rules.values()).filter(r => r.brakeActive).length,
      totalSpendThisMonth: totalRule?.spentUsd ?? 0,
      monthlyBudget: this.monthlyBudgetUsd,
      utilizationPct: totalRule?.utilizationPct ?? 0,
      suggestionsGenerated: this.suggestions.length,
      formulasTracked: formulaNames.size,
      workersTracked: workerIds.size,
    };
  }

  // --- Get recent alerts -----------------------------------------------------

  getRecentAlerts(limit = 50): BudgetAlert[] {
    return this.alerts.slice(-limit);
  }

  // --- Get suggestions -------------------------------------------------------

  getSuggestions(limit = 20): OptimizationSuggestion[] {
    return this.suggestions.slice(-limit);
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, scope, scope_key, limit_usd, spent_usd, utilization_pct,
                alert_thresholds, emergency_brake_at, brake_active, period,
                created_at, updated_at
         FROM meow_budget_rules
         WHERE period >= TO_CHAR(NOW(), 'YYYY-MM')
         ORDER BY created_at DESC
         LIMIT 500`,
      );

      for (const r of rows) {
        const ruleKey = `${r.scope}:${r.scope_key}:${r.period}`;
        this.rules.set(ruleKey, {
          id: r.id as string,
          scope: r.scope as BudgetScope,
          scopeKey: r.scope_key as string,
          limitUsd: parseFloat(r.limit_usd as string) || 0,
          spentUsd: parseFloat(r.spent_usd as string) || 0,
          utilizationPct: parseFloat(r.utilization_pct as string) || 0,
          alertThresholds: this.parseJsonSafe(r.alert_thresholds, DEFAULT_ALERT_THRESHOLDS),
          alertsFired: new Set<number>(),
          emergencyBrakeAt: parseFloat(r.emergency_brake_at as string) || DEFAULT_EMERGENCY_BRAKE_PCT,
          brakeActive: r.brake_active as boolean,
          period: r.period as string,
          createdAt: new Date(r.created_at as string),
          updatedAt: new Date(r.updated_at as string),
        });
      }

      log.info({ count: rows.length }, 'Loaded budget rules from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load budget rules from DB');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Update budget rules on spend
  // ---------------------------------------------------------------------------

  private async updateBudgetRules(spend: SpendEntry): Promise<void> {
    const keysToUpdate: Array<{ scope: BudgetScope; scopeKey: string }> = [
      { scope: 'total', scopeKey: 'total' },
      { scope: 'formula', scopeKey: spend.formulaName },
      { scope: 'daily', scopeKey: 'total' },
    ];
    if (spend.workerId) {
      keysToUpdate.push({ scope: 'worker', scopeKey: spend.workerId });
    }

    for (const { scope, scopeKey } of keysToUpdate) {
      const period = this.getCurrentPeriod(scope);
      const ruleKey = `${scope}:${scopeKey}:${period}`;
      const rule = this.rules.get(ruleKey);
      if (!rule) continue;

      rule.spentUsd += spend.costUsd;
      rule.utilizationPct = rule.limitUsd > 0 ? (rule.spentUsd / rule.limitUsd) * 100 : 0;
      rule.updatedAt = new Date();

      // Check alert thresholds
      for (const threshold of rule.alertThresholds) {
        if (rule.utilizationPct >= threshold && !rule.alertsFired.has(threshold)) {
          rule.alertsFired.add(threshold);
          await this.fireAlert(rule, threshold);
        }
      }

      // Check emergency brake
      if (rule.utilizationPct >= rule.emergencyBrakeAt && !rule.brakeActive) {
        rule.brakeActive = true;
        log.warn({
          scope: rule.scope,
          scopeKey: rule.scopeKey,
          utilizationPct: rule.utilizationPct,
        }, 'Emergency brake ACTIVATED');

        broadcast('meow:cognitive', {
          type: 'budget_brake_activated',
          scope: rule.scope,
          scopeKey: rule.scopeKey,
          utilizationPct: Math.round(rule.utilizationPct * 10) / 10,
          spentUsd: Math.round(rule.spentUsd * 100) / 100,
          limitUsd: rule.limitUsd,
        });
      }

      // Persist rule update
      await this.persistRuleUpdate(rule);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Fire alert
  // ---------------------------------------------------------------------------

  private async fireAlert(rule: BudgetRule, thresholdPct: number): Promise<void> {
    const severity: BudgetAlertSeverity =
      thresholdPct >= 100 ? 'critical'
      : thresholdPct >= 90 ? 'danger'
      : thresholdPct >= 75 ? 'warning'
      : 'info';

    const alert: BudgetAlert = {
      id: uuidv4(),
      ruleId: rule.id,
      scope: rule.scope,
      scopeKey: rule.scopeKey,
      severity,
      thresholdPct,
      currentPct: Math.round(rule.utilizationPct * 10) / 10,
      spentUsd: Math.round(rule.spentUsd * 100) / 100,
      limitUsd: rule.limitUsd,
      message: `Budget alert: ${rule.scope}:${rule.scopeKey} reached ${Math.round(rule.utilizationPct)}% ($${rule.spentUsd.toFixed(2)}/$${rule.limitUsd.toFixed(2)})`,
      createdAt: new Date(),
    };

    this.alerts.push(alert);
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts = this.alerts.slice(-MAX_ALERTS);
    }

    broadcast('meow:cognitive', {
      type: 'budget_alert',
      alert: {
        id: alert.id,
        severity,
        scope: alert.scope,
        scopeKey: alert.scopeKey,
        thresholdPct,
        currentPct: alert.currentPct,
        message: alert.message,
      },
    });

    log.warn({ severity, scope: alert.scope, scopeKey: alert.scopeKey, thresholdPct, currentPct: alert.currentPct }, alert.message);
  }

  // ---------------------------------------------------------------------------
  // Private: Heuristic suggestions
  // ---------------------------------------------------------------------------

  private generateHeuristicSuggestions(
    attribution: CostAttribution[],
    burnRate: BurnRateAnalysis,
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // Suggestion: high failure-rate formulas are wasting money
    for (const attr of attribution) {
      if (attr.failedExecutions > 3 && attr.failedExecutions / attr.totalExecutions > 0.3) {
        const wastedUsd = attr.costPerExecution * attr.failedExecutions;
        suggestions.push({
          id: uuidv4(),
          type: 'eliminate_waste',
          title: `Fix failing formula: ${attr.formulaName}`,
          description: `${attr.formulaName} has ${Math.round(attr.failedExecutions / attr.totalExecutions * 100)}% failure rate. ~$${wastedUsd.toFixed(2)} wasted on failed runs this month.`,
          estimatedSavingsUsd: Math.round(wastedUsd * 0.7 * 100) / 100,
          estimatedSavingsPct: this.monthlyBudgetUsd > 0 ? Math.round((wastedUsd * 0.7 / this.monthlyBudgetUsd) * 1000) / 10 : 0,
          targetFormula: attr.formulaName,
          confidence: 0.8,
          aiGenerated: false,
          createdAt: new Date(),
        });
      }
    }

    // Suggestion: if burn rate is increasing, suggest reducing frequency
    if (burnRate.trendDirection === 'increasing' && burnRate.trendPctChange > 20) {
      const topFormula = attribution[0];
      if (topFormula) {
        suggestions.push({
          id: uuidv4(),
          type: 'reduce_frequency',
          title: `Reduce frequency of ${topFormula.formulaName}`,
          description: `Burn rate increasing ${burnRate.trendPctChange.toFixed(0)}%. Top-cost formula "${topFormula.formulaName}" ($${topFormula.totalCostUsd}) could be batched or run less frequently.`,
          estimatedSavingsUsd: Math.round(topFormula.totalCostUsd * 0.2 * 100) / 100,
          estimatedSavingsPct: this.monthlyBudgetUsd > 0 ? Math.round((topFormula.totalCostUsd * 0.2 / this.monthlyBudgetUsd) * 1000) / 10 : 0,
          targetFormula: topFormula.formulaName,
          confidence: 0.6,
          aiGenerated: false,
          createdAt: new Date(),
        });
      }
    }

    // Suggestion: if projected to exceed budget
    if (burnRate.projectedMonthEndPct > 100) {
      suggestions.push({
        id: uuidv4(),
        type: 'defer_formula',
        title: 'Defer non-critical formulas to next month',
        description: `Projected to exceed budget by $${(burnRate.projectedMonthEndUsd - this.monthlyBudgetUsd).toFixed(2)}. Defer low-priority convoys and non-critical formulas.`,
        estimatedSavingsUsd: Math.round((burnRate.projectedMonthEndUsd - this.monthlyBudgetUsd) * 0.5 * 100) / 100,
        estimatedSavingsPct: this.monthlyBudgetUsd > 0 ? Math.round(((burnRate.projectedMonthEndUsd - this.monthlyBudgetUsd) * 0.5 / this.monthlyBudgetUsd) * 1000) / 10 : 0,
        confidence: 0.7,
        aiGenerated: false,
        createdAt: new Date(),
      });
    }

    return suggestions;
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private getCurrentPeriod(scope: BudgetScope): string {
    const now = new Date();
    if (scope === 'daily') {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private async getDailyCosts(days: number): Promise<Array<{ date: string; total: number }>> {
    const pool = getPool();
    if (!pool) {
      // Fallback: in-memory approximation
      const byDay = new Map<string, number>();
      for (const entry of this.spendLog) {
        const day = entry.createdAt.toISOString().split('T')[0];
        byDay.set(day, (byDay.get(day) ?? 0) + entry.costUsd);
      }
      return Array.from(byDay.entries())
        .map(([date, total]) => ({ date, total }))
        .slice(-days);
    }

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
        date: r.day as string,
        total: parseFloat(r.total as string) || 0,
      }));
    } catch {
      return [];
    }
  }

  private async getMonthToDateSpend(): Promise<number> {
    const pool = getPool();
    if (!pool) {
      const now = new Date();
      return this.spendLog
        .filter(s => s.createdAt.getMonth() === now.getMonth() && s.createdAt.getFullYear() === now.getFullYear())
        .reduce((s, e) => s + e.costUsd, 0);
    }

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

  private async getTopWorkerSpend(): Promise<Array<{ workerId: string; spentUsd: number; tasksCompleted: number }>> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT worker_id, SUM(cost_usd) AS spent, COUNT(*) FILTER (WHERE successful = true) AS tasks
         FROM meow_budget_spend
         WHERE created_at >= DATE_TRUNC('month', NOW()) AND worker_id IS NOT NULL
         GROUP BY worker_id
         ORDER BY spent DESC
         LIMIT 20`,
      );
      return rows.map((r: Record<string, unknown>) => ({
        workerId: r.worker_id as string,
        spentUsd: Math.round((parseFloat(r.spent as string) || 0) * 100) / 100,
        tasksCompleted: parseInt(r.tasks as string) || 0,
      }));
    } catch {
      return [];
    }
  }

  private getInMemoryCostAttribution(): CostAttribution[] {
    const byFormula = new Map<string, { cost: number; total: number; success: number; fail: number }>();
    for (const entry of this.spendLog) {
      const stat = byFormula.get(entry.formulaName) ?? { cost: 0, total: 0, success: 0, fail: 0 };
      stat.cost += entry.costUsd;
      stat.total++;
      if (entry.successful) stat.success++; else stat.fail++;
      byFormula.set(entry.formulaName, stat);
    }

    const totalCost = Array.from(byFormula.values()).reduce((s, v) => s + v.cost, 0);

    return Array.from(byFormula.entries())
      .map(([formulaName, stat]) => {
        const costPerExec = stat.total > 0 ? stat.cost / stat.total : 0;
        const costPerSuccess = stat.success > 0 ? stat.cost / stat.success : 0;
        const successRate = stat.total > 0 ? stat.success / stat.total : 0;
        return {
          formulaName,
          totalCostUsd: Math.round(stat.cost * 10000) / 10000,
          totalExecutions: stat.total,
          successfulExecutions: stat.success,
          failedExecutions: stat.fail,
          costPerExecution: Math.round(costPerExec * 10000) / 10000,
          costPerSuccessfulOutcome: Math.round(costPerSuccess * 10000) / 10000,
          shareOfTotalPct: totalCost > 0 ? Math.round((stat.cost / totalCost) * 1000) / 10 : 0,
          efficiencyScore: Math.round(successRate * (1 - Math.min(1, costPerExec / 1)) * 100),
        };
      })
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  private detectTrend(values: number[]): 'increasing' | 'stable' | 'decreasing' {
    if (values.length < 3) return 'stable';
    const half = Math.floor(values.length / 2);
    const firstAvg = values.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const secondAvg = values.slice(half).reduce((s, v) => s + v, 0) / (values.length - half);
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

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistSpend(spend: SpendEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_budget_spend
          (id, formula_name, skill_name, worker_id, molecule_id, bead_id,
           cost_usd, tokens_used, provider, model, successful, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING`,
        [
          spend.id,
          spend.formulaName,
          spend.skillName ?? null,
          spend.workerId ?? null,
          spend.moleculeId ?? null,
          spend.beadId ?? null,
          spend.costUsd,
          spend.tokensUsed,
          spend.provider,
          spend.model,
          spend.successful,
          spend.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, spendId: spend.id }, 'Failed to persist spend entry');
    }
  }

  private async persistRule(rule: BudgetRule): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_budget_rules
          (id, scope, scope_key, limit_usd, spent_usd, utilization_pct,
           alert_thresholds, emergency_brake_at, brake_active, period,
           created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           limit_usd = EXCLUDED.limit_usd,
           spent_usd = EXCLUDED.spent_usd,
           utilization_pct = EXCLUDED.utilization_pct,
           brake_active = EXCLUDED.brake_active,
           updated_at = EXCLUDED.updated_at`,
        [
          rule.id,
          rule.scope,
          rule.scopeKey,
          rule.limitUsd,
          rule.spentUsd,
          rule.utilizationPct,
          JSON.stringify(rule.alertThresholds),
          rule.emergencyBrakeAt,
          rule.brakeActive,
          rule.period,
          rule.createdAt.toISOString(),
          rule.updatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, ruleId: rule.id }, 'Failed to persist budget rule');
    }
  }

  private async persistRuleUpdate(rule: BudgetRule): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_budget_rules
         SET spent_usd = $1, utilization_pct = $2, brake_active = $3, updated_at = $4
         WHERE id = $5`,
        [rule.spentUsd, rule.utilizationPct, rule.brakeActive, rule.updatedAt.toISOString(), rule.id],
      );
    } catch (err) {
      log.error({ err, ruleId: rule.id }, 'Failed to update budget rule');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    return raw as T;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: BudgetManagementAI | null = null;

export function getBudgetManagementAI(): BudgetManagementAI {
  if (!instance) {
    instance = new BudgetManagementAI();
  }
  return instance;
}
