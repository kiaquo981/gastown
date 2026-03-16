/**
 * ERROR CLASSIFICATION — LP-039 (Stage 04 Wave 8)
 *
 * Classifies errors into a taxonomy and determines retry behavior.
 * Tracks error stats for trending and root cause analysis.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorClass =
  | 'api_timeout'
  | 'rate_limit'
  | 'auth_expired'
  | 'logic_error'
  | 'llm_hallucination'
  | 'network_error'
  | 'resource_exhausted'
  | 'unknown';

export interface ClassifiedError {
  id: string;
  errorClass: ErrorClass;
  originalMessage: string;
  moleculeId?: string;
  stepId?: string;
  workerId?: string;
  context?: Record<string, unknown>;
  retryable: boolean;
  maxRetries: number;
  retryDelayMs: number;
  createdAt: Date;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

export interface ErrorStats {
  byClass: Record<string, number>;
  total: number;
  retrySuccessRate: number;
  since: Date;
}

export interface TopError {
  errorClass: ErrorClass;
  count: number;
  lastSeen: Date;
  sampleMessage: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification patterns
// ─────────────────────────────────────────────────────────────────────────────

interface ClassificationRule {
  errorClass: ErrorClass;
  patterns: RegExp[];
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    errorClass: 'api_timeout',
    patterns: [
      /timeout/i,
      /ETIMEDOUT/i,
      /ESOCKETTIMEDOUT/i,
      /request.*timed?\s*out/i,
      /deadline.*exceeded/i,
      /response.*timeout/i,
    ],
  },
  {
    errorClass: 'rate_limit',
    patterns: [
      /rate.?limit/i,
      /429/,
      /too many requests/i,
      /quota.*exceeded/i,
      /throttl/i,
      /Resource has been exhausted/i,
    ],
  },
  {
    errorClass: 'auth_expired',
    patterns: [
      /401/,
      /403/,
      /unauthorized/i,
      /forbidden/i,
      /token.*expired/i,
      /invalid.*api.*key/i,
      /authentication.*failed/i,
      /credentials/i,
    ],
  },
  {
    errorClass: 'network_error',
    patterns: [
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /ENOTFOUND/i,
      /ENETUNREACH/i,
      /EPIPE/i,
      /socket.*hang.*up/i,
      /network.*error/i,
      /fetch.*failed/i,
      /dns.*resolution/i,
    ],
  },
  {
    errorClass: 'resource_exhausted',
    patterns: [
      /out of memory/i,
      /ENOMEM/i,
      /disk.*full/i,
      /ENOSPC/i,
      /heap.*limit/i,
      /pool.*exhausted/i,
      /connection.*limit/i,
    ],
  },
  {
    errorClass: 'llm_hallucination',
    patterns: [
      /invalid.*json/i,
      /unexpected.*token/i,
      /parse.*error.*response/i,
      /missing.*required.*field/i,
      /schema.*validation.*failed/i,
      /expected.*format/i,
      /malformed.*output/i,
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Retry configuration per error class
// ─────────────────────────────────────────────────────────────────────────────

interface RetryConfig {
  retryable: boolean;
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
}

const RETRY_CONFIG: Record<ErrorClass, RetryConfig> = {
  api_timeout:        { retryable: true,  maxRetries: 3, baseDelayMs: 2_000,  backoffMultiplier: 2 },
  rate_limit:         { retryable: true,  maxRetries: 3, baseDelayMs: 10_000, backoffMultiplier: 2 },
  auth_expired:       { retryable: false, maxRetries: 0, baseDelayMs: 0,      backoffMultiplier: 1 },
  logic_error:        { retryable: false, maxRetries: 0, baseDelayMs: 0,      backoffMultiplier: 1 },
  llm_hallucination:  { retryable: true,  maxRetries: 2, baseDelayMs: 1_000,  backoffMultiplier: 1.5 },
  network_error:      { retryable: true,  maxRetries: 3, baseDelayMs: 3_000,  backoffMultiplier: 2 },
  resource_exhausted: { retryable: false, maxRetries: 0, baseDelayMs: 0,      backoffMultiplier: 1 },
  unknown:            { retryable: true,  maxRetries: 1, baseDelayMs: 5_000,  backoffMultiplier: 1 },
};

// ─────────────────────────────────────────────────────────────────────────────
// ErrorClassifier
// ─────────────────────────────────────────────────────────────────────────────

export class ErrorClassifier {
  private errors: ClassifiedError[] = [];
  private retrySuccesses = 0;
  private retryAttempts = 0;
  private maxInMemory = 5_000;

  // ─── Classify an error ───────────────────────────────────────────────

  classify(error: Error | string, context?: Record<string, unknown>): ErrorClass {
    const message = typeof error === 'string' ? error : error.message;

    for (const rule of CLASSIFICATION_RULES) {
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
      if (code === 401 || code === 403) return 'auth_expired';
      if (code === 408 || code === 504) return 'api_timeout';
      if (code >= 500) return 'network_error';
    }

    // Check for logic errors via stack trace patterns
    if (typeof error !== 'string' && error.stack) {
      if (/TypeError|ReferenceError|RangeError/.test(error.stack)) {
        return 'logic_error';
      }
    }

    return 'unknown';
  }

  // ─── Retry decision ──────────────────────────────────────────────────

  shouldRetry(errorClass: ErrorClass, retryCount: number): RetryDecision {
    const config = RETRY_CONFIG[errorClass];

    if (!config.retryable) {
      return { retry: false, delayMs: 0, reason: `${errorClass} is not retryable` };
    }

    if (retryCount >= config.maxRetries) {
      return {
        retry: false,
        delayMs: 0,
        reason: `Max retries (${config.maxRetries}) exhausted for ${errorClass}`,
      };
    }

    const delayMs = Math.round(
      config.baseDelayMs * Math.pow(config.backoffMultiplier, retryCount),
    );

    // Add jitter (10% random)
    const jitter = Math.round(delayMs * 0.1 * Math.random());

    return {
      retry: true,
      delayMs: delayMs + jitter,
      reason: `Retry ${retryCount + 1}/${config.maxRetries} for ${errorClass} after ${delayMs + jitter}ms`,
    };
  }

  // ─── Record an error ─────────────────────────────────────────────────

  async recordError(
    errorClass: ErrorClass,
    originalMessage: string,
    ids?: { moleculeId?: string; stepId?: string; workerId?: string },
    context?: Record<string, unknown>,
  ): Promise<ClassifiedError> {
    const config = RETRY_CONFIG[errorClass];

    const classified: ClassifiedError = {
      id: uuidv4(),
      errorClass,
      originalMessage,
      moleculeId: ids?.moleculeId,
      stepId: ids?.stepId,
      workerId: ids?.workerId,
      context,
      retryable: config.retryable,
      maxRetries: config.maxRetries,
      retryDelayMs: config.baseDelayMs,
      createdAt: new Date(),
    };

    // In-memory buffer
    this.errors.push(classified);
    if (this.errors.length > this.maxInMemory) {
      this.errors = this.errors.slice(-this.maxInMemory);
    }

    // Persist
    await this.persistError(classified);

    // Broadcast
    broadcast('meow:alert', {
      type: 'error_classified',
      error: {
        id: classified.id,
        errorClass: classified.errorClass,
        retryable: classified.retryable,
        moleculeId: classified.moleculeId,
        message: classified.originalMessage.slice(0, 200),
        timestamp: classified.createdAt.toISOString(),
      },
    });

    return classified;
  }

  // ─── Record retry outcome ───────────────────────────────────────────

  recordRetryOutcome(success: boolean): void {
    this.retryAttempts += 1;
    if (success) this.retrySuccesses += 1;
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  getErrorStats(since?: Date): ErrorStats {
    const cutoff = since ?? new Date(0);
    const filtered = this.errors.filter(e => e.createdAt >= cutoff);

    const byClass: Record<string, number> = {};
    for (const err of filtered) {
      byClass[err.errorClass] = (byClass[err.errorClass] ?? 0) + 1;
    }

    return {
      byClass,
      total: filtered.length,
      retrySuccessRate:
        this.retryAttempts > 0
          ? Math.round((this.retrySuccesses / this.retryAttempts) * 10000) / 100
          : 0,
      since: cutoff,
    };
  }

  getTopErrors(limit = 10): TopError[] {
    const grouped = new Map<ErrorClass, { count: number; lastSeen: Date; sampleMessage: string }>();

    for (const err of this.errors) {
      const existing = grouped.get(err.errorClass);
      if (existing) {
        existing.count += 1;
        if (err.createdAt > existing.lastSeen) {
          existing.lastSeen = err.createdAt;
          existing.sampleMessage = err.originalMessage;
        }
      } else {
        grouped.set(err.errorClass, {
          count: 1,
          lastSeen: err.createdAt,
          sampleMessage: err.originalMessage,
        });
      }
    }

    return Array.from(grouped.entries())
      .map(([errorClass, data]) => ({
        errorClass,
        count: data.count,
        lastSeen: data.lastSeen,
        sampleMessage: data.sampleMessage.slice(0, 200),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private async persistError(err: ClassifiedError): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_errors
          (id, error_class, original_message, molecule_id, step_id, worker_id,
           context, retryable, max_retries, retry_delay_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          err.id,
          err.errorClass,
          err.originalMessage.slice(0, 2000),
          err.moleculeId ?? null,
          err.stepId ?? null,
          err.workerId ?? null,
          err.context ? JSON.stringify(err.context) : null,
          err.retryable,
          err.maxRetries,
          err.retryDelayMs,
          err.createdAt.toISOString(),
        ],
      );
    } catch (e) {
      console.error('[ErrorClassifier] Failed to persist error:', e);
    }
  }

  /** Load recent errors from DB on startup */
  async loadFromDb(sinceDays = 7): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT id, error_class, original_message, molecule_id, step_id, worker_id,
                context, retryable, max_retries, retry_delay_ms, created_at
         FROM meow_errors
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [since.toISOString(), this.maxInMemory],
      );

      this.errors = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        errorClass: r.error_class as ErrorClass,
        originalMessage: r.original_message as string,
        moleculeId: (r.molecule_id as string) ?? undefined,
        stepId: (r.step_id as string) ?? undefined,
        workerId: (r.worker_id as string) ?? undefined,
        context: r.context as Record<string, unknown> | undefined,
        retryable: r.retryable as boolean,
        maxRetries: r.max_retries as number,
        retryDelayMs: r.retry_delay_ms as number,
        createdAt: new Date(r.created_at as string),
      }));

      console.info(`[ErrorClassifier] Loaded ${this.errors.length} errors from DB`);
    } catch (e) {
      console.error('[ErrorClassifier] Failed to load from DB:', e);
    }
  }

  getEntryCount(): number {
    return this.errors.length;
  }
}
