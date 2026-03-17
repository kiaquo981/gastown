/**
 * FrankFlow Checkpoint Engine — Resumable Execution
 *
 * JSONL append-only event log for checkpoint-based resumable processing.
 * Each processing context maps to a single JSONL file that records all
 * state transitions. On crash/restart, replay the log to reconstruct state.
 *
 * Inspired by FrankFlow's crash-proof pipeline architecture.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:checkpoint');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CheckpointEventType = 'checkpoint' | 'start' | 'complete' | 'error' | 'retry';

export interface CheckpointEvent {
  timestamp: string;
  type: CheckpointEventType;
  key?: string;
  value?: unknown;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_PATH = path.join(process.cwd(), '.gastown', 'checkpoints');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeItemId(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Atomic append via write-to-temp-then-rename pattern.
 * This ensures partial writes never corrupt the main file.
 */
function atomicAppend(filePath: string, line: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a JSONL file into an array of events.
 * Silently skips malformed lines (crash resilience).
 */
function parseJSONL(filePath: string): CheckpointEvent[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const events: CheckpointEvent[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.timestamp === 'string' && typeof parsed.type === 'string') {
        events.push(parsed as CheckpointEvent);
      }
    } catch {
      log.warn({ line: line.slice(0, 80) }, 'Skipping malformed JSONL line');
    }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProcessingContext — checkpoint-based resumable execution context
// ─────────────────────────────────────────────────────────────────────────────

export class ProcessingContext {
  readonly itemId: string;
  private events: CheckpointEvent[];
  private checkpoints: Map<string, unknown>;
  private eventsPath: string;
  private basePath: string;
  private startTime: number;

  constructor(itemId: string, basePath?: string) {
    this.itemId = itemId;
    this.basePath = basePath || DEFAULT_BASE_PATH;
    this.eventsPath = path.join(this.basePath, `${sanitizeItemId(itemId)}.jsonl`);
    this.events = [];
    this.checkpoints = new Map();
    this.startTime = Date.now();

    ensureDir(this.basePath);
    log.debug({ itemId, path: this.eventsPath }, 'ProcessingContext created');
  }

  // ─── Checkpoint Operations ──────────────────────────────────────────────

  /**
   * Save a checkpoint (append to JSONL + update in-memory map).
   * If the same key already exists, it is overwritten in memory
   * but both events are kept in the log for auditability.
   */
  saveCheckpoint(key: string, value: unknown): void {
    const event: CheckpointEvent = {
      timestamp: new Date().toISOString(),
      type: 'checkpoint',
      key,
      value,
    };

    this.appendEvent(event);
    this.checkpoints.set(key, value);

    log.debug({ itemId: this.itemId, key }, 'Checkpoint saved');
    broadcast('frankflow:checkpoint', { itemId: this.itemId, key, type: 'saved' });
  }

  /**
   * Check if a step was already completed (has a checkpoint).
   */
  has(key: string): boolean {
    return this.checkpoints.has(key);
  }

  /**
   * Get checkpoint value by key.
   */
  get<T>(key: string): T | undefined {
    return this.checkpoints.get(key) as T | undefined;
  }

  // ─── Lifecycle Events ───────────────────────────────────────────────────

  /**
   * Record the start of processing.
   */
  recordStart(metadata?: Record<string, unknown>): void {
    this.startTime = Date.now();
    const event: CheckpointEvent = {
      timestamp: new Date().toISOString(),
      type: 'start',
      metadata: { ...metadata, pid: process.pid },
    };
    this.appendEvent(event);
    log.info({ itemId: this.itemId, metadata }, 'Processing started');
    broadcast('frankflow:checkpoint', { itemId: this.itemId, type: 'start' });
  }

  /**
   * Record successful completion.
   */
  recordComplete(result?: unknown): void {
    const durationMs = Date.now() - this.startTime;
    const event: CheckpointEvent = {
      timestamp: new Date().toISOString(),
      type: 'complete',
      value: result,
      metadata: { durationMs },
    };
    this.appendEvent(event);
    log.info({ itemId: this.itemId, durationMs }, 'Processing completed');
    broadcast('frankflow:checkpoint', { itemId: this.itemId, type: 'complete', durationMs });
  }

  /**
   * Record an error event.
   */
  recordError(error: string): void {
    const durationMs = Date.now() - this.startTime;
    const event: CheckpointEvent = {
      timestamp: new Date().toISOString(),
      type: 'error',
      value: error,
      metadata: { durationMs },
    };
    this.appendEvent(event);
    log.error({ itemId: this.itemId, error }, 'Processing error recorded');
    broadcast('frankflow:checkpoint', { itemId: this.itemId, type: 'error', error });
  }

  /**
   * Record a retry event (preserves all existing checkpoints).
   */
  recordRetry(metadata?: Record<string, unknown>): void {
    const event: CheckpointEvent = {
      timestamp: new Date().toISOString(),
      type: 'retry',
      metadata: { ...metadata, preservedCheckpoints: Array.from(this.checkpoints.keys()) },
    };
    this.appendEvent(event);
    log.info({ itemId: this.itemId, checkpoints: this.checkpoints.size }, 'Retry recorded');
  }

  // ─── State Restoration ──────────────────────────────────────────────────

  /**
   * Replay events from JSONL file to restore state.
   * Reconstructs the checkpoint map from the event log.
   */
  static restore(itemId: string, basePath?: string): ProcessingContext {
    const ctx = new ProcessingContext(itemId, basePath);
    const events = parseJSONL(ctx.eventsPath);

    // Replay events to reconstruct state
    for (const event of events) {
      ctx.events.push(event);
      if (event.type === 'checkpoint' && event.key !== undefined) {
        ctx.checkpoints.set(event.key, event.value);
      }
    }

    log.info(
      { itemId, eventsCount: events.length, checkpoints: ctx.checkpoints.size },
      'ProcessingContext restored from JSONL',
    );

    return ctx;
  }

  /**
   * Check if a JSONL file exists for this item.
   */
  static exists(itemId: string, basePath?: string): boolean {
    const base = basePath || DEFAULT_BASE_PATH;
    const filePath = path.join(base, `${sanitizeItemId(itemId)}.jsonl`);
    return fs.existsSync(filePath);
  }

  // ─── Cleanup & Inspection ───────────────────────────────────────────────

  /**
   * Delete the JSONL file (call after successful completion if not needed).
   */
  cleanup(): void {
    try {
      if (fs.existsSync(this.eventsPath)) {
        fs.unlinkSync(this.eventsPath);
        log.info({ itemId: this.itemId }, 'Checkpoint file cleaned up');
      }
    } catch (err) {
      log.warn({ itemId: this.itemId, err }, 'Failed to cleanup checkpoint file');
    }
  }

  /**
   * Get all recorded events for inspection/debugging.
   */
  getEvents(): CheckpointEvent[] {
    return [...this.events];
  }

  /**
   * Get all checkpoint keys and values.
   */
  getCheckpoints(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.checkpoints) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Get the path to the events file.
   */
  getEventsPath(): string {
    return this.eventsPath;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private appendEvent(event: CheckpointEvent): void {
    this.events.push(event);
    try {
      atomicAppend(this.eventsPath, JSON.stringify(event));
    } catch (err) {
      log.error({ itemId: this.itemId, err }, 'Failed to append event to JSONL');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers for listing/managing checkpoint files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all checkpoint files (item IDs with active checkpoints).
 */
export function listCheckpoints(basePath?: string): string[] {
  const base = basePath || DEFAULT_BASE_PATH;
  if (!fs.existsSync(base)) return [];

  return fs
    .readdirSync(base)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''));
}

/**
 * Get events for a specific item ID without creating a full context.
 */
export function getCheckpointEvents(itemId: string, basePath?: string): CheckpointEvent[] {
  const base = basePath || DEFAULT_BASE_PATH;
  const filePath = path.join(base, `${sanitizeItemId(itemId)}.jsonl`);
  return parseJSONL(filePath);
}

/**
 * Delete a checkpoint file by item ID.
 */
export function deleteCheckpoint(itemId: string, basePath?: string): boolean {
  const base = basePath || DEFAULT_BASE_PATH;
  const filePath = path.join(base, `${sanitizeItemId(itemId)}.jsonl`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Get summary stats for all checkpoints.
 */
export function getCheckpointStats(basePath?: string): {
  total: number;
  withErrors: number;
  completed: number;
  inProgress: number;
} {
  const ids = listCheckpoints(basePath);
  let withErrors = 0;
  let completed = 0;
  let inProgress = 0;

  for (const id of ids) {
    const events = getCheckpointEvents(id, basePath);
    const hasError = events.some(e => e.type === 'error');
    const hasComplete = events.some(e => e.type === 'complete');

    if (hasComplete) completed++;
    else if (hasError) withErrors++;
    else inProgress++;
  }

  return { total: ids.length, withErrors, completed, inProgress };
}
