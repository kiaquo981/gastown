/**
 * AUTONOMOUS LOOP — Wave 5
 *
 * The self-propelling engine that makes Gas Town fully autonomous.
 * Periodically scans for ready beads, places GUPP hooks, and lets the
 * existing chain do the rest:
 *
 *   Ready Bead → GUPP Hook → Polecat (or Maestro) → PR → Refinery Gates → Merge → Close → Cascade
 *
 * Enable with MEOW_AUTONOMOUS=true. Safe to run alongside manual work —
 * it only touches beads that have no active hooks.
 *
 * Configuration via environment:
 *   MEOW_AUTONOMOUS=true          — enable the loop (default: false)
 *   MEOW_AUTO_INTERVAL_MS=30000   — scan interval (default: 30s)
 *   MEOW_AUTO_MAX_INFLIGHT=5      — max beads being worked simultaneously (default: 5)
 *   MEOW_AUTO_DEFAULT_SKILL=code  — skill for beads without explicit skill (default: 'code')
 */

import { getBeadsService } from './beads-service';
import { gupp } from './workers/gupp';
import { refinery } from './refinery';
import { addActivity, broadcast } from '../sse';
import type { Bead } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = '[AUTO-LOOP]';

interface AutoLoopConfig {
  enabled: boolean;
  intervalMs: number;
  maxInflight: number;
  defaultSkill: string;
}

function loadConfig(): AutoLoopConfig {
  return {
    enabled: process.env.MEOW_AUTONOMOUS === 'true',
    intervalMs: parseInt(process.env.MEOW_AUTO_INTERVAL_MS || '30000', 10) || 30_000,
    maxInflight: parseInt(process.env.MEOW_AUTO_MAX_INFLIGHT || '5', 10) || 5,
    defaultSkill: process.env.MEOW_AUTO_DEFAULT_SKILL || 'code',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** Track which beads have hooks placed by the auto-loop to avoid duplicates */
const beadsInFlight = new Set<string>();
let scanTimer: NodeJS.Timeout | undefined;
let scanInProgress = false;  // Mutex: prevent overlapping scan cycles
let cycleCount = 0;
let totalPlaced = 0;
let totalCompleted = 0;
let totalFailed = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Core Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single scan cycle:
 * 1. Get ready beads from BeadsService
 * 2. Filter out beads already in flight
 * 3. Place GUPP hooks for available beads (up to maxInflight)
 */
async function scanCycle(): Promise<{ placed: number; skipped: number; inflight: number }> {
  // Mutex: prevent overlapping scans from exceeding maxInflight
  if (scanInProgress) return { placed: 0, skipped: 0, inflight: beadsInFlight.size };
  scanInProgress = true;

  cycleCount++;
  const config = loadConfig();
  let placed = 0;
  let skipped = 0;

  try {
    const beadsService = getBeadsService();
    const readyBeads = await beadsService.ready({ limit: config.maxInflight * 2 });

    // Rebuild inflight from persisted hooks (survives restarts — fixes NDI gap)
    const allActiveHooks = gupp.listHooks().filter(
      h => h.status === 'pending' || h.status === 'claimed' || h.status === 'running',
    );
    const activeBeadIds = new Set(allActiveHooks.map(h => h.beadId));

    // Sync beadsInFlight with actual hook state
    for (const beadId of beadsInFlight) {
      if (!activeBeadIds.has(beadId)) {
        beadsInFlight.delete(beadId);
      }
    }
    for (const beadId of activeBeadIds) {
      beadsInFlight.add(beadId);
    }

    // How many slots are free?
    const slotsAvailable = config.maxInflight - beadsInFlight.size;
    if (slotsAvailable <= 0) {
      return { placed: 0, skipped: readyBeads.length, inflight: beadsInFlight.size };
    }

    // Sort by priority: critical first, then high, medium, low
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = readyBeads.sort((a, b) =>
      (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3),
    );

    for (const bead of sorted) {
      if (placed >= slotsAvailable) break;
      if (beadsInFlight.has(bead.id)) {
        skipped++;
        continue;
      }

      // Check if this bead already has an active hook (placed by someone else)
      const existingHooks = gupp.listHooks().filter(
        h => h.beadId === bead.id && h.status !== 'completed' && h.status !== 'failed' && h.status !== 'expired',
      );
      if (existingHooks.length > 0) {
        beadsInFlight.add(bead.id);
        skipped++;
        continue;
      }

      // Determine skill: bead.skill > bead.formula > default
      const skill = bead.skill || bead.formula || config.defaultSkill;

      // Map bead priority to hook priority
      const hookPriority: 'critical' | 'high' | 'normal' | 'low' =
        bead.priority === 'critical' ? 'critical' :
        bead.priority === 'high' ? 'high' :
        bead.priority === 'low' ? 'low' : 'normal';

      // Place the hook — GUPP scan will pick it up and execute
      gupp.placeHook(bead.assignee || 'auto-loop', bead.id, skill, {
        priority: hookPriority,
        payload: {
          title: bead.title,
          description: bead.description,
          rig: bead.rig,
          bu: bead.bu,
          tier: bead.tier,
          autoLoop: true,
        },
      });

      beadsInFlight.add(bead.id);
      placed++;
      totalPlaced++;

      // Update bead status to in_progress
      try {
        await beadsService.update(bead.id, { status: 'in_progress' });
      } catch {
        // Best effort — bead may have been modified concurrently
      }

      console.log(`${PREFIX} Placed hook for bead ${bead.id} (${bead.title}) — skill=${skill} priority=${hookPriority}`);
    }

    if (placed > 0) {
      addActivity({
        type: 'info',
        action: 'auto_loop_placed',
        details: `${PREFIX} Placed ${placed} hooks for ready beads (inflight: ${beadsInFlight.size}/${config.maxInflight})`,
      });

      broadcast('meow:auto-loop', {
        event: 'hooks_placed',
        placed,
        inflight: beadsInFlight.size,
        maxInflight: config.maxInflight,
        cycle: cycleCount,
      });
    }

  } catch (err) {
    console.error(`${PREFIX} Scan cycle error:`, err);
  } finally {
    scanInProgress = false;
  }

  return { placed, skipped, inflight: beadsInFlight.size };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Start the autonomous loop. No-op if already running or disabled. */
export function startAutonomousLoop(): void {
  const config = loadConfig();

  if (!config.enabled) {
    console.log(`${PREFIX} Disabled (set MEOW_AUTONOMOUS=true to enable)`);
    return;
  }

  if (scanTimer) {
    console.log(`${PREFIX} Already running`);
    return;
  }

  console.log(`${PREFIX} Starting autonomous loop (interval=${config.intervalMs}ms, maxInflight=${config.maxInflight}, skill=${config.defaultSkill})`);

  addActivity({
    type: 'success',
    action: 'auto_loop_start',
    details: `${PREFIX} Autonomous loop started — scanning every ${config.intervalMs / 1000}s, max ${config.maxInflight} beads in flight`,
  });

  // First scan immediately
  void scanCycle();

  // Then periodic
  scanTimer = setInterval(() => void scanCycle(), config.intervalMs);
}

/** Stop the autonomous loop. */
export function stopAutonomousLoop(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = undefined;
    console.log(`${PREFIX} Stopped`);

    addActivity({
      type: 'warning',
      action: 'auto_loop_stop',
      details: `${PREFIX} Autonomous loop stopped`,
    });
  }
}

/** Check if the loop is currently running. */
export function isAutonomousLoopRunning(): boolean {
  return scanTimer !== undefined;
}

/** Get autonomous loop stats. */
export function getAutonomousLoopStats(): {
  running: boolean;
  cycles: number;
  inflight: number;
  maxInflight: number;
  totalPlaced: number;
  totalCompleted: number;
  totalFailed: number;
  beadsInFlight: string[];
} {
  const config = loadConfig();
  return {
    running: scanTimer !== undefined,
    cycles: cycleCount,
    inflight: beadsInFlight.size,
    maxInflight: config.maxInflight,
    totalPlaced,
    totalCompleted,
    totalFailed,
    beadsInFlight: Array.from(beadsInFlight),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bead completion callback — called when refinery merges or bead is closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify the auto-loop that a bead has been completed.
 * Called by the refinery postMergeCleanup or by external code.
 */
export function notifyBeadCompleted(beadId: string): void {
  if (beadsInFlight.has(beadId)) {
    beadsInFlight.delete(beadId);
    totalCompleted++;
    console.log(`${PREFIX} Bead ${beadId} completed — removed from inflight (${beadsInFlight.size} remaining)`);
  }
}

/** Notify the auto-loop that a bead has failed. */
export function notifyBeadFailed(beadId: string): void {
  if (beadsInFlight.has(beadId)) {
    beadsInFlight.delete(beadId);
    totalFailed++;
    console.log(`${PREFIX} Bead ${beadId} failed — removed from inflight (${beadsInFlight.size} remaining)`);
  }
}
