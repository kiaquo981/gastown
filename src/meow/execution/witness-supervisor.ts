/**
 * LP-005 — Witness Supervisor (Real Execution Engine)
 *
 * Real supervision of active polecats with stall detection,
 * graduated nudge chain, and escalation to overseer.
 *
 * Stall detection: no output > 5 minutes
 * Response chain: 1st -> nudge via mail, 2nd -> stronger nudge, 3rd -> escalate to overseer
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import { mailRouter } from '../mail';
import { overseer } from '../workers/overseer';
import { polecatManager } from '../workers/polecat';
import {
  getAllActivePolecats,
  getActivePolecat,
  recordNudge,
  type PolecatSpawnOptions,
} from './polecat-spawner';
import type { PatrolCheck, PatrolReport, FeedEvent, FeedEventType } from '../types';

const log = createLogger('witness-supervisor');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface WitnessSupervisorConfig {
  /** Stall threshold in milliseconds (default: 5 minutes) */
  stallThresholdMs: number;
  /** Maximum nudges before escalation (default: 3) */
  maxNudges: number;
  /** Supervision loop interval (default: 60 seconds) */
  intervalMs: number;
  /** Zombie threshold — polecat considered dead after this (default: 15 minutes) */
  zombieThresholdMs: number;
}

const DEFAULT_CONFIG: WitnessSupervisorConfig = {
  stallThresholdMs: 5 * 60 * 1000,     // 5 minutes
  maxNudges: 3,
  intervalMs: 60 * 1000,               // 60 seconds
  zombieThresholdMs: 15 * 60 * 1000,   // 15 minutes
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SupervisionAction = 'ok' | 'nudge_1' | 'nudge_2' | 'nudge_3' | 'escalated' | 'zombie_killed';

export interface SupervisionResult {
  polecatId: string;
  action: SupervisionAction;
  nudgeCount: number;
  stalledMs: number;
  details: string;
  timestamp: Date;
}

export interface SupervisionCycleResult {
  cycleId: string;
  totalChecked: number;
  healthy: number;
  nudged: number;
  escalated: number;
  zombiesKilled: number;
  results: SupervisionResult[];
  durationMs: number;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** Per-polecat nudge counts (persists across supervision cycles) */
const nudgeCounts = new Map<string, number>();

/** Track last known output timestamps for polecats not in spawner */
const lastOutputTimestamps = new Map<string, Date>();

/** Recent supervision results for reporting */
const recentResults: SupervisionCycleResult[] = [];
const MAX_RECENT_RESULTS = 50;

let supervisionTimer: ReturnType<typeof setInterval> | null = null;
let config: WitnessSupervisorConfig = { ...DEFAULT_CONFIG };

// ─────────────────────────────────────────────────────────────────────────────
// Nudge messages (graduated severity)
// ─────────────────────────────────────────────────────────────────────────────

const NUDGE_MESSAGES = [
  {
    level: 1,
    subject: 'Gentle nudge: Are you still working?',
    body: (polecatId: string, stalledMs: number) =>
      `Polecat ${polecatId} has been idle for ${Math.round(stalledMs / 1000)}s. ` +
      `Please send a heartbeat or output to confirm you are still active.`,
    priority: 'normal' as const,
  },
  {
    level: 2,
    subject: 'Second nudge: Stall detected',
    body: (polecatId: string, stalledMs: number) =>
      `Polecat ${polecatId} has been stalled for ${Math.round(stalledMs / 60000)} minutes. ` +
      `This is the second nudge. If no activity within the next cycle, you will be escalated to the Overseer.`,
    priority: 'high' as const,
  },
  {
    level: 3,
    subject: 'Final warning: Escalation imminent',
    body: (polecatId: string, stalledMs: number) =>
      `Polecat ${polecatId} stalled for ${Math.round(stalledMs / 60000)} minutes. ` +
      `Final nudge. Escalating to Overseer on next cycle if no response.`,
    priority: 'high' as const,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Single polecat supervision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supervise a single polecat. Checks for stalls and takes graduated action.
 */
export function supervisePolecat(polecatId: string): SupervisionResult {
  const now = new Date();
  const activePolecat = getActivePolecat(polecatId);

  // Check the polecat manager as well
  const managerPolecat = polecatManager.get(polecatId);

  // Determine last output time
  let lastOutput: Date;
  if (activePolecat?.lastOutputAt) {
    lastOutput = activePolecat.lastOutputAt;
  } else if (lastOutputTimestamps.has(polecatId)) {
    lastOutput = lastOutputTimestamps.get(polecatId)!;
  } else if (activePolecat?.spawnedAt) {
    lastOutput = activePolecat.spawnedAt;
  } else if (managerPolecat?.lastActiveAt) {
    lastOutput = managerPolecat.lastActiveAt;
  } else {
    lastOutput = now; // newly spawned, give benefit of the doubt
  }

  const stalledMs = now.getTime() - lastOutput.getTime();
  const currentNudgeCount = nudgeCounts.get(polecatId) || 0;

  // Check if healthy (within stall threshold)
  if (stalledMs < config.stallThresholdMs) {
    return {
      polecatId,
      action: 'ok',
      nudgeCount: currentNudgeCount,
      stalledMs,
      details: `Healthy — last output ${Math.round(stalledMs / 1000)}s ago`,
      timestamp: now,
    };
  }

  // Check for zombie (far beyond threshold)
  if (stalledMs > config.zombieThresholdMs) {
    nudgeCounts.delete(polecatId);
    lastOutputTimestamps.delete(polecatId);

    // Kill the zombie
    try {
      if (managerPolecat) {
        polecatManager.fail(polecatId, 'Zombie detected by witness supervisor').catch(() => {});
      }
    } catch {
      // Best effort
    }

    emitFeed('polecat_stalled', `Zombie polecat killed: ${polecatId} (stalled ${Math.round(stalledMs / 60000)}min)`, {
      metadata: { polecatId, stalledMs, action: 'zombie_killed' },
    });

    log.warn({ polecatId, stalledMs }, 'Zombie polecat killed');

    return {
      polecatId,
      action: 'zombie_killed',
      nudgeCount: currentNudgeCount,
      stalledMs,
      details: `Zombie killed after ${Math.round(stalledMs / 60000)} minutes of inactivity`,
      timestamp: now,
    };
  }

  // Stalled — apply graduated response
  if (currentNudgeCount >= config.maxNudges) {
    // Escalate to overseer
    nudgeCounts.delete(polecatId);

    const escalationMsg = `Polecat ${polecatId} stalled for ${Math.round(stalledMs / 60000)} minutes after ${currentNudgeCount} nudges`;

    overseer.escalate(
      escalationMsg,
      'witness-supervisor',
      'warning',
    ).catch(err => {
      log.error({ err }, 'Failed to escalate to overseer');
    });

    emitFeed('escalation', `Escalated: ${escalationMsg}`, {
      metadata: { polecatId, stalledMs, nudgeCount: currentNudgeCount },
    });

    log.warn({ polecatId, stalledMs, nudgeCount: currentNudgeCount }, 'Polecat escalated to overseer');

    return {
      polecatId,
      action: 'escalated',
      nudgeCount: currentNudgeCount,
      stalledMs,
      details: escalationMsg,
      timestamp: now,
    };
  }

  // Send nudge
  const nudgeLevel = Math.min(currentNudgeCount, NUDGE_MESSAGES.length - 1);
  const nudgeTemplate = NUDGE_MESSAGES[nudgeLevel];

  // Send via mail system
  mailRouter.send({
    from: 'witness-supervisor',
    to: polecatId,
    priority: nudgeTemplate.priority,
    type: 'nudge',
    delivery: 'direct',
    subject: nudgeTemplate.subject,
    body: nudgeTemplate.body(polecatId, stalledMs),
    metadata: { nudgeCount: currentNudgeCount + 1, stalledMs },
  });

  // Also record in the spawner
  recordNudge(polecatId);

  // Update nudge count
  const newNudgeCount = currentNudgeCount + 1;
  nudgeCounts.set(polecatId, newNudgeCount);

  const actionName = `nudge_${newNudgeCount}` as SupervisionAction;

  emitFeed('patrol_alert', `Nudge #${newNudgeCount} sent to polecat ${polecatId} (stalled ${Math.round(stalledMs / 1000)}s)`, {
    metadata: { polecatId, stalledMs, nudgeCount: newNudgeCount },
  });

  log.info({ polecatId, stalledMs, nudgeCount: newNudgeCount }, 'Nudge sent to stalled polecat');

  return {
    polecatId,
    action: actionName,
    nudgeCount: newNudgeCount,
    stalledMs,
    details: `Nudge #${newNudgeCount} sent (stalled ${Math.round(stalledMs / 1000)}s)`,
    timestamp: now,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full supervision cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a supervision cycle across ALL active polecats.
 */
export function runSupervisionCycle(): SupervisionCycleResult {
  const cycleId = `wsc-${uuidv4().slice(0, 8)}`;
  const startMs = Date.now();
  const results: SupervisionResult[] = [];

  // Get all active polecats from the spawner
  const spawnerPolecats = getAllActivePolecats();

  // Also check polecats from the manager
  const managerPolecats = polecatManager.list().filter(
    p => p.status === 'working' || p.status === 'spawning'
  );

  // Merge unique polecat IDs
  const checkedIds = new Set<string>();

  for (const polecat of spawnerPolecats) {
    checkedIds.add(polecat.id);
    results.push(supervisePolecat(polecat.id));
  }

  for (const polecat of managerPolecats) {
    if (!checkedIds.has(polecat.id)) {
      checkedIds.add(polecat.id);
      // Track last active from manager
      lastOutputTimestamps.set(polecat.id, polecat.lastActiveAt);
      results.push(supervisePolecat(polecat.id));
    }
  }

  const durationMs = Date.now() - startMs;

  const healthy = results.filter(r => r.action === 'ok').length;
  const nudged = results.filter(r => r.action.startsWith('nudge')).length;
  const escalated = results.filter(r => r.action === 'escalated').length;
  const zombiesKilled = results.filter(r => r.action === 'zombie_killed').length;

  const cycleResult: SupervisionCycleResult = {
    cycleId,
    totalChecked: results.length,
    healthy,
    nudged,
    escalated,
    zombiesKilled,
    results,
    durationMs,
    timestamp: new Date(),
  };

  // Store for reporting
  recentResults.push(cycleResult);
  if (recentResults.length > MAX_RECENT_RESULTS) {
    recentResults.splice(0, recentResults.length - MAX_RECENT_RESULTS);
  }

  // Broadcast summary
  if (results.length > 0) {
    const severity = escalated > 0 || zombiesKilled > 0 ? 'warning' : 'info';
    broadcast('meow:feed', {
      type: 'patrol_completed',
      source: 'witness-supervisor',
      message: `Supervision cycle: ${healthy} healthy, ${nudged} nudged, ${escalated} escalated, ${zombiesKilled} zombies killed (${results.length} polecats, ${durationMs}ms)`,
      severity,
      metadata: { cycleId, healthy, nudged, escalated, zombiesKilled, totalChecked: results.length },
      timestamp: new Date(),
    });
  }

  log.info({
    cycleId,
    totalChecked: results.length,
    healthy,
    nudged,
    escalated,
    zombiesKilled,
    durationMs,
  }, 'Supervision cycle complete');

  return cycleResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervision loop lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the periodic supervision loop.
 */
export function startSupervisionLoop(intervalMs?: number): void {
  if (supervisionTimer) return;

  if (intervalMs) {
    config = { ...config, intervalMs };
  }

  log.info({ intervalMs: config.intervalMs }, 'Starting witness supervision loop');

  supervisionTimer = setInterval(() => {
    try {
      runSupervisionCycle();
    } catch (err) {
      log.error({ err }, 'Supervision cycle error');
    }
  }, config.intervalMs);

  // Run immediately
  try {
    runSupervisionCycle();
  } catch (err) {
    log.error({ err }, 'Initial supervision cycle error');
  }
}

/**
 * Stop the supervision loop.
 */
export function stopSupervisionLoop(): void {
  if (supervisionTimer) {
    clearInterval(supervisionTimer);
    supervisionTimer = null;
    log.info('Witness supervision loop stopped');
  }
}

/**
 * Check if the supervision loop is active.
 */
export function isSupervisionActive(): boolean {
  return supervisionTimer !== null;
}

/**
 * Update supervisor configuration.
 */
export function updateSupervisorConfig(updates: Partial<WitnessSupervisorConfig>): void {
  config = { ...config, ...updates };
  log.info({ config }, 'Supervisor config updated');

  // Restart loop if interval changed and loop is active
  if (updates.intervalMs && supervisionTimer) {
    stopSupervisionLoop();
    startSupervisionLoop();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get recent supervision cycle results.
 */
export function getRecentSupervisionResults(limit: number = 10): SupervisionCycleResult[] {
  return recentResults.slice(-limit).reverse();
}

/**
 * Get current nudge counts for all tracked polecats.
 */
export function getNudgeCounts(): Array<{ polecatId: string; nudgeCount: number }> {
  return Array.from(nudgeCounts.entries()).map(([polecatId, nudgeCount]) => ({
    polecatId,
    nudgeCount,
  }));
}

/**
 * Reset nudge count for a polecat (e.g., after it recovers).
 */
export function resetNudgeCount(polecatId: string): void {
  nudgeCounts.delete(polecatId);
}

/**
 * Get supervisor stats.
 */
export function getSupervisorStats(): {
  active: boolean;
  intervalMs: number;
  config: WitnessSupervisorConfig;
  trackedPolecats: number;
  totalNudges: number;
  recentCycles: number;
  lastCycle?: SupervisionCycleResult;
} {
  const totalNudges = Array.from(nudgeCounts.values()).reduce((sum, n) => sum + n, 0);

  return {
    active: supervisionTimer !== null,
    intervalMs: config.intervalMs,
    config,
    trackedPolecats: nudgeCounts.size,
    totalNudges,
    recentCycles: recentResults.length,
    lastCycle: recentResults[recentResults.length - 1],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed events
// ─────────────────────────────────────────────────────────────────────────────

function emitFeed(
  type: FeedEventType,
  message: string,
  extra?: { metadata?: Record<string, unknown> },
): void {
  const event: Partial<FeedEvent> = {
    id: uuidv4(),
    type,
    source: 'witness-supervisor',
    message,
    severity: type === 'escalation' ? 'error' : type === 'patrol_alert' ? 'warning' : 'info',
    timestamp: new Date(),
    ...extra,
  };
  broadcast('meow:feed', event);
}
