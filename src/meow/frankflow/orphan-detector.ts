/**
 * FrankFlow Orphan Detector — Stale Worker Detection
 *
 * Detects and recovers orphaned work items:
 * - Dead PID: worker process no longer exists
 * - Timeout: processing exceeded maximum allowed time
 * - Stale heartbeat: worker stopped sending heartbeats
 *
 * Ported from FrankFlow's orphan recovery system.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:orphan');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OrphanReason = 'pid_dead' | 'timeout' | 'stale_heartbeat';

export interface OrphanResult {
  id: string;
  beadId?: string;
  workerId?: string;
  reason: OrphanReason;
  staleSince: Date;
  recovered: boolean;
}

export interface OrphanDetectionOpts {
  /** Max processing time before timeout (ms). Default: 30min */
  maxProcessingTimeMs?: number;
  /** Max heartbeat staleness before flagging (ms). Default: 5min */
  maxHeartbeatStaleMs?: number;
  /** Only scan specific worker IDs */
  workerIds?: string[];
}

interface TrackedWorker {
  workerId: string;
  beadId?: string;
  pid?: number;
  startedAt: Date;
  lastHeartbeat: Date;
  status: 'active' | 'orphaned' | 'recovered';
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_PROCESSING_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_HEARTBEAT_STALE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LOOP_INTERVAL_MS = 60 * 1000; // 60 seconds
const MAX_ORPHAN_HISTORY = 500;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const trackedWorkers = new Map<string, TrackedWorker>();
const orphanHistory: OrphanResult[] = [];
let orphanLoopTimer: NodeJS.Timeout | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Worker Registration (used by worker-pool or hooks-engine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a worker as active. Call when a worker picks up a task.
 */
export function registerWorker(workerId: string, beadId?: string, pid?: number): void {
  const now = new Date();
  trackedWorkers.set(workerId, {
    workerId,
    beadId,
    pid: pid ?? process.pid,
    startedAt: now,
    lastHeartbeat: now,
    status: 'active',
  });
  log.debug({ workerId, beadId, pid }, 'Worker registered for orphan tracking');
}

/**
 * Update heartbeat for an active worker.
 */
export function heartbeat(workerId: string): void {
  const worker = trackedWorkers.get(workerId);
  if (worker) {
    worker.lastHeartbeat = new Date();
  }
}

/**
 * Deregister a worker (completed/cancelled normally).
 */
export function deregisterWorker(workerId: string): void {
  trackedWorkers.delete(workerId);
  log.debug({ workerId }, 'Worker deregistered from orphan tracking');
}

/**
 * Get the count of tracked active workers.
 */
export function getTrackedCount(): number {
  return trackedWorkers.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// PID Probing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a PID is alive. Uses kill(pid, 0) which doesn't actually
 * send a signal — just checks if the process exists.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process (dead)
    // EPERM = process exists but no permission (still alive)
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan all tracked workers for orphans.
 *
 * Detection criteria (checked in order):
 * 1. Dead PID — process.kill(pid, 0) throws ESRCH
 * 2. Timeout — processing time exceeds maxProcessingTimeMs
 * 3. Stale heartbeat — last heartbeat older than maxHeartbeatStaleMs
 */
export function detectOrphans(opts?: OrphanDetectionOpts): OrphanResult[] {
  const maxProcessing = opts?.maxProcessingTimeMs ?? DEFAULT_MAX_PROCESSING_MS;
  const maxHeartbeat = opts?.maxHeartbeatStaleMs ?? DEFAULT_MAX_HEARTBEAT_STALE_MS;
  const now = Date.now();
  const results: OrphanResult[] = [];

  for (const [, worker] of trackedWorkers) {
    // Skip if filtering by worker IDs and not in the list
    if (opts?.workerIds && !opts.workerIds.includes(worker.workerId)) {
      continue;
    }

    // Skip already-orphaned workers
    if (worker.status === 'orphaned') continue;

    let reason: OrphanReason | null = null;
    let staleSince: Date = worker.lastHeartbeat;

    // Check 1: Dead PID
    if (worker.pid && !isPidAlive(worker.pid)) {
      reason = 'pid_dead';
      staleSince = worker.lastHeartbeat;
    }

    // Check 2: Timeout
    if (!reason) {
      const processingMs = now - worker.startedAt.getTime();
      if (processingMs > maxProcessing) {
        reason = 'timeout';
        staleSince = new Date(worker.startedAt.getTime() + maxProcessing);
      }
    }

    // Check 3: Stale heartbeat
    if (!reason) {
      const heartbeatAge = now - worker.lastHeartbeat.getTime();
      if (heartbeatAge > maxHeartbeat) {
        reason = 'stale_heartbeat';
        staleSince = worker.lastHeartbeat;
      }
    }

    if (reason) {
      const orphan: OrphanResult = {
        id: uuidv4(),
        beadId: worker.beadId,
        workerId: worker.workerId,
        reason,
        staleSince,
        recovered: false,
      };
      results.push(orphan);
      worker.status = 'orphaned';

      log.warn(
        { workerId: worker.workerId, beadId: worker.beadId, reason, staleSince },
        'Orphaned worker detected',
      );
    }
  }

  if (results.length > 0) {
    broadcast('frankflow:orphans', { detected: results.length, orphans: results });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recover a single orphaned item — move its bead back to 'ready' status
 * and deregister the dead worker.
 */
export async function recoverOrphan(orphanId: string): Promise<OrphanResult | null> {
  // Find the orphan in recent history
  const orphan = orphanHistory.find(o => o.id === orphanId);
  if (!orphan) {
    log.warn({ orphanId }, 'Orphan not found in history');
    return null;
  }

  if (orphan.recovered) {
    log.info({ orphanId }, 'Orphan already recovered');
    return orphan;
  }

  // Attempt DB recovery — move bead back to ready
  if (orphan.beadId) {
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE beads SET status = 'ready', assignee = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'in_progress'`,
          [orphan.beadId],
        );
        log.info({ beadId: orphan.beadId }, 'Bead recovered to ready state');
      } catch (err) {
        log.error({ beadId: orphan.beadId, err }, 'Failed to recover bead in DB');
      }
    }
  }

  // Deregister the dead worker
  if (orphan.workerId) {
    trackedWorkers.delete(orphan.workerId);
  }

  orphan.recovered = true;
  broadcast('frankflow:orphan-recovered', { orphanId, beadId: orphan.beadId });

  log.info({ orphanId, beadId: orphan.beadId, workerId: orphan.workerId }, 'Orphan recovered');
  return orphan;
}

/**
 * Detect and recover all orphans in one call.
 */
export async function recoverAll(opts?: OrphanDetectionOpts): Promise<OrphanResult[]> {
  const detected = detectOrphans(opts);

  // Store in history before recovery
  for (const orphan of detected) {
    orphanHistory.unshift(orphan);
  }
  // Trim history
  while (orphanHistory.length > MAX_ORPHAN_HISTORY) {
    orphanHistory.pop();
  }

  // Recover each orphan
  const results: OrphanResult[] = [];
  for (const orphan of detected) {
    const recovered = await recoverOrphan(orphan.id);
    if (recovered) {
      results.push(recovered);
    }
  }

  if (results.length > 0) {
    log.info({ recovered: results.length }, 'Orphan recovery sweep complete');
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get recent orphan events.
 */
export function getOrphanHistory(limit = 50): OrphanResult[] {
  return orphanHistory.slice(0, limit);
}

/**
 * Get summary stats about orphan detection.
 */
export function getOrphanStats(): {
  tracked: number;
  orphaned: number;
  totalDetected: number;
  totalRecovered: number;
} {
  let orphaned = 0;
  for (const [, worker] of trackedWorkers) {
    if (worker.status === 'orphaned') orphaned++;
  }

  const totalRecovered = orphanHistory.filter(o => o.recovered).length;

  return {
    tracked: trackedWorkers.size,
    orphaned,
    totalDetected: orphanHistory.length,
    totalRecovered,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic Detection Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start periodic orphan detection. Default interval: 60 seconds.
 */
export function startOrphanLoop(intervalMs?: number): void {
  if (orphanLoopTimer) {
    log.warn('Orphan detection loop already running');
    return;
  }

  const interval = intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;

  orphanLoopTimer = setInterval(async () => {
    try {
      const results = await recoverAll();
      if (results.length > 0) {
        log.info({ recovered: results.length }, 'Orphan loop recovered workers');
      }
    } catch (err) {
      log.error({ err }, 'Orphan detection loop error');
    }
  }, interval);

  // Unref so this doesn't keep the process alive
  orphanLoopTimer.unref();

  log.info({ intervalMs: interval }, 'Orphan detection loop started');
  broadcast('frankflow:orphan-loop', { status: 'started', intervalMs: interval });
}

/**
 * Stop the periodic orphan detection loop.
 */
export function stopOrphanLoop(): void {
  if (orphanLoopTimer) {
    clearInterval(orphanLoopTimer);
    orphanLoopTimer = null;
    log.info('Orphan detection loop stopped');
    broadcast('frankflow:orphan-loop', { status: 'stopped' });
  }
}

/**
 * Check if the orphan loop is currently running.
 */
export function isOrphanLoopRunning(): boolean {
  return orphanLoopTimer !== null;
}
