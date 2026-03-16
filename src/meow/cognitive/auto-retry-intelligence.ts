/**
 * AUTO-RETRY INTELLIGENCE — CG-017 (Stage 05 Wave 5)
 *
 * Intelligent retry system that goes beyond simple exponential backoff.
 * Classifies errors, selects per-class retry strategies, and uses AI
 * to analyze error context and suggest parameter mutations before retry.
 *
 * Features:
 *   - Error class classification (transient/permanent/resource/rate-limit/auth)
 *   - Per-class retry strategy with adaptive delay
 *   - AI-powered error analysis via Gemini (fallback to heuristic)
 *   - Parameter mutation on retry (simplify prompt, reduce batch, switch model)
 *   - Budget cap per bead to prevent runaway retry costs
 *   - Success rate learning per error class for optimal strategy selection
 *
 * Gas Town: "When the rig breaks down, don't just restart — fix it first."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead } from '../types';

const log = createLogger('auto-retry-intelligence');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RetryErrorClass =
  | 'transient'
  | 'permanent'
  | 'resource'
  | 'rate_limit'
  | 'auth'
  | 'llm_parse'
  | 'timeout'
  | 'unknown';

export interface RetryAttempt {
  id: string;
  beadId: string;
  errorClass: RetryErrorClass;
  errorMessage: string;
  attemptNumber: number;
  maxAttempts: number;
  delayMs: number;
  mutations: ParameterMutation[];
  aiFix?: string;                     // AI-suggested fix description
  outcome: 'pending' | 'success' | 'failure';
  costUsd: number;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface ParameterMutation {
  type: MutationType;
  field: string;
  originalValue: string;
  mutatedValue: string;
  reason: string;
}

export type MutationType =
  | 'simplify_prompt'
  | 'reduce_batch'
  | 'switch_model'
  | 'reduce_timeout'
  | 'strip_context'
  | 'fallback_provider';

export interface RetryStrategy {
  errorClass: RetryErrorClass;
  retryable: boolean;
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  respectRetryAfter: boolean;         // honor Retry-After header
  mutateParams: boolean;              // attempt parameter mutation
  reauth: boolean;                    // attempt re-authentication before retry
  aiAnalysis: boolean;                // ask AI to analyze error context
}

export interface RetryBudget {
  beadId: string;
  maxCostUsd: number;
  spentUsd: number;
  maxAttempts: number;
  attemptsMade: number;
  exhausted: boolean;
}

export interface RetryClassStats {
  errorClass: RetryErrorClass;
  totalAttempts: number;
  successes: number;
  failures: number;
  successRate: number;
  avgDelayMs: number;
  avgCostUsd: number;
  bestMutation?: MutationType;        // most effective mutation type
}

export interface RetryIntelligenceReport {
  totalRetries: number;
  overallSuccessRate: number;
  classBudget: Record<RetryErrorClass, RetryClassStats>;
  topMutations: Array<{ type: MutationType; successRate: number; count: number }>;
  totalCostUsd: number;
  generatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Configuration
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_STRATEGIES: Record<RetryErrorClass, RetryStrategy> = {
  transient:   { errorClass: 'transient',   retryable: true,  maxRetries: 3, baseDelayMs: 1_000,  backoffMultiplier: 2.0, respectRetryAfter: false, mutateParams: false, reauth: false, aiAnalysis: false },
  rate_limit:  { errorClass: 'rate_limit',  retryable: true,  maxRetries: 3, baseDelayMs: 15_000, backoffMultiplier: 2.5, respectRetryAfter: true,  mutateParams: true,  reauth: false, aiAnalysis: false },
  auth:        { errorClass: 'auth',        retryable: true,  maxRetries: 1, baseDelayMs: 2_000,  backoffMultiplier: 1.0, respectRetryAfter: false, mutateParams: false, reauth: true,  aiAnalysis: false },
  resource:    { errorClass: 'resource',    retryable: true,  maxRetries: 2, baseDelayMs: 5_000,  backoffMultiplier: 3.0, respectRetryAfter: false, mutateParams: true,  reauth: false, aiAnalysis: true  },
  timeout:     { errorClass: 'timeout',     retryable: true,  maxRetries: 2, baseDelayMs: 3_000,  backoffMultiplier: 2.0, respectRetryAfter: false, mutateParams: true,  reauth: false, aiAnalysis: false },
  llm_parse:   { errorClass: 'llm_parse',   retryable: true,  maxRetries: 2, baseDelayMs: 1_000,  backoffMultiplier: 1.5, respectRetryAfter: false, mutateParams: true,  reauth: false, aiAnalysis: true  },
  permanent:   { errorClass: 'permanent',   retryable: false, maxRetries: 0, baseDelayMs: 0,      backoffMultiplier: 1.0, respectRetryAfter: false, mutateParams: false, reauth: false, aiAnalysis: true  },
  unknown:     { errorClass: 'unknown',     retryable: true,  maxRetries: 1, baseDelayMs: 5_000,  backoffMultiplier: 1.5, respectRetryAfter: false, mutateParams: false, reauth: false, aiAnalysis: true  },
};

const DEFAULT_BUDGET_PER_BEAD_USD = 0.50;
const DEFAULT_MAX_ATTEMPTS = 3;

const CLASSIFICATION_PATTERNS: Array<{ errorClass: RetryErrorClass; patterns: RegExp[] }> = [
  { errorClass: 'rate_limit',  patterns: [/429/, /rate.?limit/i, /too many requests/i, /quota.*exceeded/i, /throttl/i] },
  { errorClass: 'auth',        patterns: [/401/, /403/, /unauthorized/i, /forbidden/i, /token.*expired/i, /invalid.*api.*key/i] },
  { errorClass: 'timeout',     patterns: [/timeout/i, /ETIMEDOUT/i, /ESOCKETTIMEDOUT/i, /deadline.*exceeded/i, /504/] },
  { errorClass: 'resource',    patterns: [/out of memory/i, /ENOMEM/i, /disk.*full/i, /ENOSPC/i, /heap.*limit/i, /pool.*exhausted/i] },
  { errorClass: 'transient',   patterns: [/ECONNRESET/i, /ECONNREFUSED/i, /socket.*hang.*up/i, /network.*error/i, /fetch.*failed/i, /502/, /503/] },
  { errorClass: 'llm_parse',   patterns: [/invalid.*json/i, /unexpected.*token/i, /parse.*error/i, /schema.*validation/i, /malformed.*output/i] },
  { errorClass: 'permanent',   patterns: [/TypeError/i, /ReferenceError/i, /RangeError/i, /not.*found/i, /does.*not.*exist/i] },
];

// ─────────────────────────────────────────────────────────────────────────────
// AutoRetryIntelligence
// ─────────────────────────────────────────────────────────────────────────────

export class AutoRetryIntelligence {
  private attempts: RetryAttempt[] = [];
  private budgets = new Map<string, RetryBudget>();
  private classStats = new Map<RetryErrorClass, RetryClassStats>();
  private mutationSuccess = new Map<MutationType, { total: number; successes: number }>();
  private maxInMemory = 5_000;

  // ─── Classify error ────────────────────────────────────────────────

  classifyError(error: Error | string, context?: Record<string, unknown>): RetryErrorClass {
    const message = typeof error === 'string' ? error : error.message;

    for (const rule of CLASSIFICATION_PATTERNS) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          return rule.errorClass;
        }
      }
    }

    // Check context for status codes
    if (context?.statusCode) {
      const code = Number(context.statusCode);
      if (code === 429) return 'rate_limit';
      if (code === 401 || code === 403) return 'auth';
      if (code === 408 || code === 504) return 'timeout';
      if (code === 502 || code === 503) return 'transient';
      if (code >= 400 && code < 500) return 'permanent';
    }

    return 'unknown';
  }

  // ─── Decide retry ──────────────────────────────────────────────────

  async decideRetry(
    beadId: string,
    error: Error | string,
    attemptNumber: number,
    context?: Record<string, unknown>,
  ): Promise<{
    shouldRetry: boolean;
    attempt?: RetryAttempt;
    reason: string;
  }> {
    const errorClass = this.classifyError(error, context);
    const strategy = RETRY_STRATEGIES[errorClass];
    const errorMessage = typeof error === 'string' ? error : error.message;

    // Check if retryable
    if (!strategy.retryable) {
      return { shouldRetry: false, reason: `${errorClass} errors are not retryable` };
    }

    // Check max retries (use learned optimal or default)
    const effectiveMax = this.getLearnedMaxRetries(errorClass) ?? strategy.maxRetries;
    if (attemptNumber >= effectiveMax) {
      return { shouldRetry: false, reason: `Max retries (${effectiveMax}) exhausted for ${errorClass}` };
    }

    // Check budget
    const budget = this.getOrCreateBudget(beadId);
    if (budget.exhausted) {
      return { shouldRetry: false, reason: `Retry budget exhausted for bead ${beadId} ($${budget.spentUsd.toFixed(4)}/$${budget.maxCostUsd.toFixed(4)})` };
    }

    // Compute delay
    let delayMs = this.computeDelay(strategy, attemptNumber, context);

    // Respect Retry-After header if present
    if (strategy.respectRetryAfter && context?.retryAfterMs) {
      delayMs = Math.max(delayMs, Number(context.retryAfterMs));
    }

    // Generate mutations if applicable
    const mutations: ParameterMutation[] = [];
    if (strategy.mutateParams) {
      mutations.push(...this.generateMutations(errorClass, attemptNumber, context));
    }

    // AI analysis (if enabled and Gemini available)
    let aiFix: string | undefined;
    if (strategy.aiAnalysis) {
      aiFix = await this.getAiFixSuggestion(errorMessage, errorClass, context);
    }

    // Estimate retry cost
    const estimatedCost = this.estimateRetryCost(context);
    if (budget.spentUsd + estimatedCost > budget.maxCostUsd) {
      budget.exhausted = true;
      return { shouldRetry: false, reason: `Retry would exceed budget ($${(budget.spentUsd + estimatedCost).toFixed(4)} > $${budget.maxCostUsd.toFixed(4)})` };
    }

    // Create retry attempt
    const attempt: RetryAttempt = {
      id: uuidv4(),
      beadId,
      errorClass,
      errorMessage: errorMessage.slice(0, 2000),
      attemptNumber: attemptNumber + 1,
      maxAttempts: effectiveMax,
      delayMs,
      mutations,
      aiFix,
      outcome: 'pending',
      costUsd: estimatedCost,
      createdAt: new Date(),
    };

    this.attempts.push(attempt);
    if (this.attempts.length > this.maxInMemory) {
      this.attempts = this.attempts.slice(-this.maxInMemory);
    }

    // Update budget
    budget.attemptsMade += 1;
    budget.spentUsd += estimatedCost;

    // Persist attempt
    await this.persistAttempt(attempt);

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'retry_decision',
      retry: {
        id: attempt.id,
        beadId,
        errorClass,
        attemptNumber: attempt.attemptNumber,
        delayMs,
        mutations: mutations.length,
        aiFix: aiFix ? true : false,
        timestamp: attempt.createdAt.toISOString(),
      },
    });

    log.info({ beadId, errorClass, attempt: attempt.attemptNumber, delayMs, mutations: mutations.length }, 'Retry decision: proceed');

    return {
      shouldRetry: true,
      attempt,
      reason: `Retry ${attempt.attemptNumber}/${effectiveMax} for ${errorClass} after ${delayMs}ms` +
        (mutations.length > 0 ? ` with ${mutations.length} mutations` : '') +
        (aiFix ? ' (AI-guided fix)' : ''),
    };
  }

  // ─── Record retry outcome ──────────────────────────────────────────

  async recordOutcome(attemptId: string, success: boolean): Promise<void> {
    const attempt = this.attempts.find(a => a.id === attemptId);
    if (!attempt) return;

    attempt.outcome = success ? 'success' : 'failure';
    attempt.resolvedAt = new Date();

    // Update class stats
    this.updateClassStats(attempt.errorClass, success, attempt.delayMs, attempt.costUsd);

    // Update mutation effectiveness
    for (const mutation of attempt.mutations) {
      const stats = this.mutationSuccess.get(mutation.type) ?? { total: 0, successes: 0 };
      stats.total += 1;
      if (success) stats.successes += 1;
      this.mutationSuccess.set(mutation.type, stats);
    }

    // Persist outcome
    await this.persistOutcome(attemptId, success);

    log.info({ attemptId, beadId: attempt.beadId, errorClass: attempt.errorClass, success }, 'Retry outcome recorded');
  }

  // ─── Get retry report ──────────────────────────────────────────────

  getReport(): RetryIntelligenceReport {
    const resolvedAttempts = this.attempts.filter(a => a.outcome !== 'pending');
    const successes = resolvedAttempts.filter(a => a.outcome === 'success').length;

    const classBudget: Record<string, RetryClassStats> = {};
    for (const [cls, stats] of this.classStats) {
      classBudget[cls] = { ...stats };
    }

    // Top mutations by success rate
    const topMutations = Array.from(this.mutationSuccess.entries())
      .map(([type, stats]) => ({
        type,
        successRate: stats.total > 0 ? Math.round((stats.successes / stats.total) * 1000) / 1000 : 0,
        count: stats.total,
      }))
      .sort((a, b) => b.successRate - a.successRate);

    return {
      totalRetries: resolvedAttempts.length,
      overallSuccessRate: resolvedAttempts.length > 0
        ? Math.round((successes / resolvedAttempts.length) * 1000) / 1000
        : 0,
      classBudget: classBudget as Record<RetryErrorClass, RetryClassStats>,
      topMutations,
      totalCostUsd: Math.round(resolvedAttempts.reduce((s, a) => s + a.costUsd, 0) * 10000) / 10000,
      generatedAt: new Date(),
    };
  }

  // ─── Budget management ─────────────────────────────────────────────

  setBudget(beadId: string, maxCostUsd: number, maxAttempts?: number): void {
    this.budgets.set(beadId, {
      beadId,
      maxCostUsd,
      spentUsd: 0,
      maxAttempts: maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      attemptsMade: 0,
      exhausted: false,
    });
  }

  getBudget(beadId: string): RetryBudget | null {
    return this.budgets.get(beadId) ?? null;
  }

  // ─── History queries ───────────────────────────────────────────────

  async getRetryHistory(beadId: string): Promise<RetryAttempt[]> {
    // In-memory first
    const inMemory = this.attempts.filter(a => a.beadId === beadId);
    if (inMemory.length > 0) return inMemory;

    // Fallback to DB
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT id, bead_id, error_class, error_message, attempt_number,
                max_attempts, delay_ms, mutations, ai_fix, outcome,
                cost_usd, created_at, resolved_at
         FROM meow_retry_history
         WHERE bead_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [beadId],
      );

      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        beadId: r.bead_id as string,
        errorClass: r.error_class as RetryErrorClass,
        errorMessage: r.error_message as string,
        attemptNumber: r.attempt_number as number,
        maxAttempts: r.max_attempts as number,
        delayMs: r.delay_ms as number,
        mutations: (r.mutations as ParameterMutation[]) ?? [],
        aiFix: r.ai_fix as string | undefined,
        outcome: r.outcome as 'pending' | 'success' | 'failure',
        costUsd: parseFloat(r.cost_usd as string) || 0,
        createdAt: new Date(r.created_at as string),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : undefined,
      }));
    } catch (err) {
      log.error({ err, beadId }, 'Failed to load retry history from DB');
      return [];
    }
  }

  async getClassSuccessRates(): Promise<RetryClassStats[]> {
    return Array.from(this.classStats.values());
  }

  // ─── Internal: compute delay ───────────────────────────────────────

  private computeDelay(strategy: RetryStrategy, attemptNumber: number, context?: Record<string, unknown>): number {
    const base = strategy.baseDelayMs * Math.pow(strategy.backoffMultiplier, attemptNumber);

    // Jitter: +/- 15%
    const jitter = base * 0.15 * (Math.random() * 2 - 1);
    let delay = Math.round(base + jitter);

    // Cap at 2 minutes
    delay = Math.min(delay, 120_000);

    // For rate limits, use learned optimal delay if available
    if (strategy.errorClass === 'rate_limit') {
      const stats = this.classStats.get('rate_limit');
      if (stats && stats.avgDelayMs > delay && stats.successRate > 0.5) {
        delay = Math.round(stats.avgDelayMs);
      }
    }

    return delay;
  }

  // ─── Internal: generate mutations ──────────────────────────────────

  private generateMutations(
    errorClass: RetryErrorClass,
    attemptNumber: number,
    context?: Record<string, unknown>,
  ): ParameterMutation[] {
    const mutations: ParameterMutation[] = [];

    switch (errorClass) {
      case 'rate_limit':
        // Reduce batch size if present
        if (context?.batchSize && Number(context.batchSize) > 1) {
          const original = Number(context.batchSize);
          const reduced = Math.max(1, Math.ceil(original / 2));
          mutations.push({
            type: 'reduce_batch',
            field: 'batchSize',
            originalValue: String(original),
            mutatedValue: String(reduced),
            reason: 'Rate limit hit — reducing batch size to lower API call frequency',
          });
        }
        break;

      case 'resource':
        // Simplify prompt to reduce token usage
        mutations.push({
          type: 'simplify_prompt',
          field: 'systemPrompt',
          originalValue: '(full prompt)',
          mutatedValue: '(condensed prompt)',
          reason: 'Resource exhaustion — simplifying prompt to reduce memory/token usage',
        });
        // Switch to lighter model
        if (attemptNumber >= 1) {
          mutations.push({
            type: 'switch_model',
            field: 'model',
            originalValue: context?.model as string ?? 'gemini-2.0-flash',
            mutatedValue: 'gemini-2.0-flash-lite',
            reason: 'Resource exhaustion — downgrading model tier to reduce resource usage',
          });
        }
        break;

      case 'timeout':
        // Switch to faster model on retry
        mutations.push({
          type: 'switch_model',
          field: 'model',
          originalValue: context?.model as string ?? 'gemini-2.0-flash',
          mutatedValue: 'gemini-2.0-flash-lite',
          reason: 'Timeout — using lighter model for faster response',
        });
        // Strip context to reduce processing time
        if (attemptNumber >= 1) {
          mutations.push({
            type: 'strip_context',
            field: 'contextDocs',
            originalValue: '(full context)',
            mutatedValue: '(essential context only)',
            reason: 'Timeout — stripping non-essential context to speed up processing',
          });
        }
        break;

      case 'llm_parse':
        // Simplify prompt for cleaner output
        mutations.push({
          type: 'simplify_prompt',
          field: 'outputFormat',
          originalValue: '(complex format)',
          mutatedValue: '(simplified JSON)',
          reason: 'LLM parse error — simplifying expected output format',
        });
        break;

      default:
        break;
    }

    // Rank mutations by learned effectiveness
    return mutations.sort((a, b) => {
      const aStats = this.mutationSuccess.get(a.type);
      const bStats = this.mutationSuccess.get(b.type);
      const aRate = aStats && aStats.total > 0 ? aStats.successes / aStats.total : 0.5;
      const bRate = bStats && bStats.total > 0 ? bStats.successes / bStats.total : 0.5;
      return bRate - aRate;
    });
  }

  // ─── Internal: AI fix suggestion ───────────────────────────────────

  private async getAiFixSuggestion(
    errorMessage: string,
    errorClass: RetryErrorClass,
    context?: Record<string, unknown>,
  ): Promise<string | undefined> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return undefined;

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
              content: 'You are a system reliability engineer. Analyze the error and suggest a concrete fix in 1-2 sentences. Be specific and actionable. Respond only with the fix suggestion, no preamble.',
            },
            {
              role: 'user',
              content: `Error class: ${errorClass}\nError message: ${errorMessage.slice(0, 500)}\nContext: ${JSON.stringify(context ?? {}).slice(0, 500)}\n\nWhat specific fix should be applied before retrying?`,
            },
          ],
        }),
      });

      if (!res.ok) {
        log.warn({ status: res.status }, 'Gemini AI fix suggestion failed');
        return undefined;
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim();
    } catch (err) {
      log.warn({ err }, 'AI fix suggestion request failed — falling back to heuristic');
      return this.getHeuristicFix(errorClass, errorMessage);
    }
  }

  // ─── Internal: heuristic fix (fallback) ────────────────────────────

  private getHeuristicFix(errorClass: RetryErrorClass, errorMessage: string): string {
    switch (errorClass) {
      case 'rate_limit':
        return 'Reduce request frequency and batch size. Consider spreading requests over a longer window.';
      case 'auth':
        return 'Re-authenticate with the API provider. Check if the token has expired or been revoked.';
      case 'resource':
        return 'Reduce payload size, simplify the prompt, or use a lighter model tier.';
      case 'timeout':
        return 'Reduce context size or switch to a faster model. Check if the API endpoint is under high load.';
      case 'llm_parse':
        return 'Simplify the output format and add explicit JSON schema instructions to the prompt.';
      case 'permanent':
        return 'This error is not retryable. Investigate the root cause in the code or configuration.';
      case 'transient':
        return 'Network issue detected. Wait briefly and retry with the same parameters.';
      default:
        return `Unknown error pattern: "${errorMessage.slice(0, 100)}". Investigate manually.`;
    }
  }

  // ─── Internal: budget management ───────────────────────────────────

  private static readonly MAX_BUDGET_ENTRIES = 10_000;

  private getOrCreateBudget(beadId: string): RetryBudget {
    let budget = this.budgets.get(beadId);
    if (!budget) {
      // Evict oldest entries if we've hit the cap
      if (this.budgets.size >= AutoRetryIntelligence.MAX_BUDGET_ENTRIES) {
        const firstKey = this.budgets.keys().next().value;
        if (firstKey !== undefined) this.budgets.delete(firstKey);
      }
      budget = {
        beadId,
        maxCostUsd: DEFAULT_BUDGET_PER_BEAD_USD,
        spentUsd: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        attemptsMade: 0,
        exhausted: false,
      };
      this.budgets.set(beadId, budget);
    }
    return budget;
  }

  private estimateRetryCost(context?: Record<string, unknown>): number {
    // Estimate based on model tier
    const model = (context?.model as string) ?? 'gemini-2.0-flash';
    if (model.includes('lite')) return 0.001;
    if (model.includes('flash')) return 0.005;
    return 0.02; // opus-class
  }

  // ─── Internal: learned max retries ─────────────────────────────────

  private getLearnedMaxRetries(errorClass: RetryErrorClass): number | null {
    const stats = this.classStats.get(errorClass);
    if (!stats || stats.totalAttempts < 10) return null;

    // If success rate is very low, reduce max retries
    if (stats.successRate < 0.1) return 1;
    // If success rate is decent, keep defaults
    if (stats.successRate > 0.5) return null;
    // Medium success: reduce by 1
    const strategy = RETRY_STRATEGIES[errorClass];
    return Math.max(1, strategy.maxRetries - 1);
  }

  // ─── Internal: class stats tracking ────────────────────────────────

  private updateClassStats(errorClass: RetryErrorClass, success: boolean, delayMs: number, costUsd: number): void {
    let stats = this.classStats.get(errorClass);
    if (!stats) {
      stats = {
        errorClass,
        totalAttempts: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        avgDelayMs: 0,
        avgCostUsd: 0,
      };
    }

    stats.totalAttempts += 1;
    if (success) stats.successes += 1;
    else stats.failures += 1;
    stats.successRate = Math.round((stats.successes / stats.totalAttempts) * 1000) / 1000;

    // Running average for delay and cost
    stats.avgDelayMs = Math.round(stats.avgDelayMs + (delayMs - stats.avgDelayMs) / stats.totalAttempts);
    stats.avgCostUsd = Math.round((stats.avgCostUsd + (costUsd - stats.avgCostUsd) / stats.totalAttempts) * 10000) / 10000;

    // Track best mutation type
    const bestMutation = Array.from(this.mutationSuccess.entries())
      .filter(([, s]) => s.total >= 3)
      .sort((a, b) => (b[1].successes / b[1].total) - (a[1].successes / a[1].total))[0];
    if (bestMutation) {
      stats.bestMutation = bestMutation[0];
    }

    this.classStats.set(errorClass, stats);
  }

  // ─── Persistence ───────────────────────────────────────────────────

  private async persistAttempt(attempt: RetryAttempt): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_retry_history
          (id, bead_id, error_class, error_message, attempt_number,
           max_attempts, delay_ms, mutations, ai_fix, outcome,
           cost_usd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          attempt.id,
          attempt.beadId,
          attempt.errorClass,
          attempt.errorMessage,
          attempt.attemptNumber,
          attempt.maxAttempts,
          attempt.delayMs,
          JSON.stringify(attempt.mutations),
          attempt.aiFix ?? null,
          attempt.outcome,
          attempt.costUsd,
          attempt.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, attemptId: attempt.id }, 'Failed to persist retry attempt');
    }
  }

  private async persistOutcome(attemptId: string, success: boolean): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_retry_history
         SET outcome = $1, resolved_at = NOW()
         WHERE id = $2`,
        [success ? 'success' : 'failure', attemptId],
      );
    } catch (err) {
      log.error({ err, attemptId }, 'Failed to persist retry outcome');
    }
  }

  /** Load recent retry history from DB on startup */
  async loadFromDb(sinceDays = 7): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT error_class, outcome, delay_ms, cost_usd, mutations
         FROM meow_retry_history
         WHERE created_at >= $1 AND outcome != 'pending'
         ORDER BY created_at DESC
         LIMIT 5000`,
        [since.toISOString()],
      );

      // Rebuild class stats from historical data
      for (const row of rows) {
        const success = row.outcome === 'success';
        this.updateClassStats(
          row.error_class as RetryErrorClass,
          success,
          parseInt(row.delay_ms as string) || 0,
          parseFloat(row.cost_usd as string) || 0,
        );

        // Rebuild mutation effectiveness
        const mutations = row.mutations as ParameterMutation[] | null;
        if (mutations) {
          for (const m of mutations) {
            const stats = this.mutationSuccess.get(m.type) ?? { total: 0, successes: 0 };
            stats.total += 1;
            if (success) stats.successes += 1;
            this.mutationSuccess.set(m.type, stats);
          }
        }
      }

      log.info({ count: rows.length }, 'Loaded retry history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load retry history from DB');
    }
  }

  getAttemptCount(): number {
    return this.attempts.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: AutoRetryIntelligence | null = null;

export function getAutoRetryIntelligence(): AutoRetryIntelligence {
  if (!instance) {
    instance = new AutoRetryIntelligence();
  }
  return instance;
}
