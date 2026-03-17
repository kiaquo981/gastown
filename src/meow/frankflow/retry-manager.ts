/**
 * FrankFlow Retry Manager — Intelligent Retry with Backoff
 *
 * Manages retries with configurable backoff strategies (exponential, linear, fixed),
 * transient error classification, and checkpoint preservation across retries.
 *
 * Ported from FrankFlow's fault-tolerant pipeline retry system.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { ProcessingContext } from './checkpoint-engine';

const log = createLogger('frankflow:retry');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type BackoffStrategy = 'exponential' | 'linear' | 'fixed';
export type ErrorClassification = 'transient' | 'permanent' | 'unknown';

export interface RetryConfig {
  /** Maximum number of retries. Default: 3 */
  maxRetries: number;
  /** Backoff strategy. Default: 'exponential' */
  strategy: BackoffStrategy;
  /** Base delay in ms. Default: 5000 */
  baseDelayMs: number;
  /** Maximum delay in ms. Default: 300000 (5 min) */
  maxDelayMs: number;
  /** Error codes/patterns considered retryable */
  retryableErrors: string[];
}

export interface RetryHistoryEntry {
  attempt: number;
  error: string;
  timestamp: Date;
  durationMs: number;
}

export interface RetryRecord {
  itemId: string;
  beadId?: string;
  retryCount: number;
  maxRetries: number;
  lastError: string;
  lastErrorCode?: string;
  nextRetryAt: Date;
  retryHistory: RetryHistoryEntry[];
  checkpointPreserved: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  strategy: 'exponential',
  baseDelayMs: 5000,
  maxDelayMs: 300_000,
  retryableErrors: [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'RATE_LIMIT',
    'TOO_MANY_REQUESTS',
    'SERVICE_UNAVAILABLE',
    'GATEWAY_TIMEOUT',
    'INTERNAL_SERVER_ERROR',
    'ORPHAN_RECOVERED',
  ],
};

/**
 * Transient error patterns — these are worth retrying.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /timeout/i,
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /503/,
  /502/,
  /504/,
  /service unavailable/i,
  /gateway timeout/i,
  /internal server error/i,
  /500/,
  /network/i,
  /socket hang up/i,
  /EPIPE/i,
  /orphan/i,
  /out of memory/i,
  /OOM/i,
  /ENOMEM/i,
  /temporary/i,
  /retry/i,
];

/**
 * Permanent error patterns — do NOT retry these.
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /auth/i,
  /unauthorized/i,
  /forbidden/i,
  /401/,
  /403/,
  /permission denied/i,
  /not found/i,
  /404/,
  /syntax error/i,
  /SyntaxError/,
  /TypeError/,
  /ReferenceError/,
  /validation/i,
  /invalid/i,
  /malformed/i,
  /ENOENT/i,
  /EACCES/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const retryRecords = new Map<string, RetryRecord>();

// ─────────────────────────────────────────────────────────────────────────────
// Backoff Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate delay for next retry based on strategy.
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  let delay: number;

  switch (config.strategy) {
    case 'exponential':
      // 2^attempt * base, with jitter (±20%)
      delay = Math.pow(2, attempt) * config.baseDelayMs;
      delay = delay * (0.8 + Math.random() * 0.4); // jitter
      break;

    case 'linear':
      // attempt * base
      delay = attempt * config.baseDelayMs;
      break;

    case 'fixed':
      delay = config.baseDelayMs;
      break;

    default:
      delay = config.baseDelayMs;
  }

  return Math.min(delay, config.maxDelayMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify an error as transient, permanent, or unknown.
 *
 * Transient errors are worth retrying (network issues, rate limits, etc.)
 * Permanent errors should not be retried (auth, validation, not_found, etc.)
 */
export function classifyError(error: string | Error): ErrorClassification {
  const msg = typeof error === 'string' ? error : error.message;

  // Check permanent first (more specific)
  for (const pattern of PERMANENT_PATTERNS) {
    if (pattern.test(msg)) return 'permanent';
  }

  // Check transient
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(msg)) return 'transient';
  }

  return 'unknown';
}

/**
 * Extract an error code from the error (if available).
 */
function extractErrorCode(error: string | Error): string | undefined {
  const msg = typeof error === 'string' ? error : error.message;

  // Try to extract HTTP status code
  const httpMatch = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (httpMatch) return `HTTP_${httpMatch[1]}`;

  // Try to extract Node.js error code
  const nodeMatch = msg.match(/\b(E[A-Z_]+)\b/);
  if (nodeMatch) return nodeMatch[1];

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Retry Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an item should be retried.
 *
 * Returns true if:
 * 1. Retry count < maxRetries
 * 2. Error is classified as transient (or unknown with retryableErrors match)
 */
export function shouldRetry(
  itemId: string,
  error: string | Error,
  config?: Partial<RetryConfig>,
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const msg = typeof error === 'string' ? error : error.message;

  // Get existing record or create implied one
  const record = retryRecords.get(itemId);
  const currentCount = record?.retryCount ?? 0;

  // Check count limit
  if (currentCount >= cfg.maxRetries) {
    log.info({ itemId, retryCount: currentCount, maxRetries: cfg.maxRetries }, 'Max retries exceeded');
    return false;
  }

  // Check error classification
  const classification = classifyError(error);

  if (classification === 'permanent') {
    log.info({ itemId, error: msg, classification }, 'Permanent error — will not retry');
    return false;
  }

  if (classification === 'transient') {
    return true;
  }

  // For 'unknown' errors, check against the retryable patterns list
  const isRetryable = cfg.retryableErrors.some(pattern =>
    msg.toUpperCase().includes(pattern.toUpperCase()),
  );

  if (!isRetryable) {
    log.info({ itemId, error: msg }, 'Error not in retryable list — will not retry');
  }

  return isRetryable;
}

/**
 * Schedule a retry for an item. Creates/updates the retry record
 * and calculates the next retry time based on backoff strategy.
 */
export function scheduleRetry(
  itemId: string,
  error: string | Error,
  config?: Partial<RetryConfig>,
): RetryRecord | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const msg = typeof error === 'string' ? error : error.message;

  if (!shouldRetry(itemId, error, config)) {
    return null;
  }

  const existing = retryRecords.get(itemId);
  const retryCount = (existing?.retryCount ?? 0) + 1;
  const delay = calculateDelay(retryCount, cfg);
  const nextRetryAt = new Date(Date.now() + delay);

  const historyEntry: RetryHistoryEntry = {
    attempt: retryCount,
    error: msg,
    timestamp: new Date(),
    durationMs: delay,
  };

  // Check if checkpoint exists for this item
  const hasCheckpoint = ProcessingContext.exists(itemId);

  const record: RetryRecord = {
    itemId,
    beadId: existing?.beadId,
    retryCount,
    maxRetries: cfg.maxRetries,
    lastError: msg,
    lastErrorCode: extractErrorCode(error),
    nextRetryAt,
    retryHistory: [...(existing?.retryHistory ?? []), historyEntry],
    checkpointPreserved: hasCheckpoint,
  };

  retryRecords.set(itemId, record);

  log.info(
    {
      itemId,
      retryCount,
      maxRetries: cfg.maxRetries,
      strategy: cfg.strategy,
      delayMs: delay,
      nextRetryAt: nextRetryAt.toISOString(),
      checkpointPreserved: hasCheckpoint,
    },
    'Retry scheduled',
  );

  broadcast('frankflow:retry-scheduled', {
    itemId,
    retryCount,
    nextRetryAt: nextRetryAt.toISOString(),
    error: msg,
  });

  return record;
}

/**
 * Get items that are ready to be retried (nextRetryAt <= now).
 */
export function getRetryable(): RetryRecord[] {
  const now = Date.now();
  const ready: RetryRecord[] = [];

  for (const [, record] of retryRecords) {
    if (record.nextRetryAt.getTime() <= now) {
      ready.push(record);
    }
  }

  return ready.sort((a, b) => a.nextRetryAt.getTime() - b.nextRetryAt.getTime());
}

/**
 * Execute a retry: move the error item back to pending state,
 * preserving its checkpoint if one exists.
 */
export async function executeRetry(itemId: string): Promise<RetryRecord | null> {
  const record = retryRecords.get(itemId);
  if (!record) {
    log.warn({ itemId }, 'No retry record found');
    return null;
  }

  // Update bead status back to 'ready' in DB
  const pool = getPool();
  if (pool && record.beadId) {
    try {
      await pool.query(
        `UPDATE beads SET status = 'ready', updated_at = NOW()
         WHERE id = $1 AND status IN ('in_progress', 'blocked')`,
        [record.beadId],
      );
      log.info({ beadId: record.beadId }, 'Bead status reset to ready for retry');
    } catch (err) {
      log.error({ beadId: record.beadId, err }, 'Failed to reset bead for retry');
    }
  }

  // If checkpoint exists, record the retry event in the checkpoint log
  if (record.checkpointPreserved) {
    try {
      const ctx = ProcessingContext.restore(itemId);
      ctx.recordRetry({ retryCount: record.retryCount, lastError: record.lastError });
    } catch (err) {
      log.warn({ itemId, err }, 'Failed to record retry in checkpoint');
    }
  }

  log.info(
    { itemId, retryCount: record.retryCount, beadId: record.beadId },
    'Retry executed — item moved to pending',
  );

  broadcast('frankflow:retry-executed', { itemId, retryCount: record.retryCount });

  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the retry record for a specific item.
 */
export function getRetryRecord(itemId: string): RetryRecord | undefined {
  return retryRecords.get(itemId);
}

/**
 * Set the beadId association for a retry record.
 */
export function setRetryBeadId(itemId: string, beadId: string): void {
  const record = retryRecords.get(itemId);
  if (record) {
    record.beadId = beadId;
  }
}

/**
 * Clear retry record for an item (call after successful completion).
 */
export function clearRetryRecord(itemId: string): void {
  retryRecords.delete(itemId);
}

/**
 * Get all active retry records.
 */
export function getAllRetryRecords(): RetryRecord[] {
  return Array.from(retryRecords.values());
}

/**
 * Get summary statistics about retries.
 */
export function getRetryStats(): {
  total: number;
  pending: number;
  exhausted: number;
  avgRetries: number;
} {
  const records = Array.from(retryRecords.values());
  const total = records.length;
  const now = Date.now();
  const pending = records.filter(r => r.nextRetryAt.getTime() > now).length;
  const exhausted = records.filter(r => r.retryCount >= r.maxRetries).length;
  const avgRetries = total > 0 ? records.reduce((sum, r) => sum + r.retryCount, 0) / total : 0;

  return { total, pending, exhausted, avgRetries: Math.round(avgRetries * 10) / 10 };
}
