/**
 * Wisp System — EP-020
 *
 * Ephemeral molecules with TTL, auto-reaping, promotion to permanent,
 * and batch operations. Wisps live in VAPOR phase — in-memory only.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../sse';
import { meowEngine } from './engine';
import type { Wisp, MEOWPhase, FeedEvent, FeedEventType, MoleculeStep } from './types';

/* ---------- Types ---------- */

interface WispConfig {
  defaultTtlMs: number;      // Default TTL for new wisps
  maxWisps: number;           // Max concurrent wisps
  reapIntervalMs: number;     // How often to check for expired wisps
  autoPromoteOnComplete: boolean; // Promote to LIQUID on all-steps-done
}

interface WispCreateInput {
  title: string;
  steps: Array<{ title: string; type?: string }>;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  parentMoleculeId?: string;
}

interface WispStats {
  active: number;
  expired: number;
  promoted: number;
  totalCreated: number;
  avgLifespanMs: number;
}

/* ---------- Wisp System ---------- */
class WispSystem {
  private wisps = new Map<string, Wisp>();
  private config: WispConfig = {
    defaultTtlMs: 300_000,       // 5 minutes
    maxWisps: 200,
    reapIntervalMs: 30_000,      // 30 seconds
    autoPromoteOnComplete: true,
  };

  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private counters = { created: 0, expired: 0, promoted: 0 };
  private lifespans: number[] = [];

  // ─── Core Operations ───────────────────────────────────────────────────────

  create(input: WispCreateInput): Wisp {
    if (this.wisps.size >= this.config.maxWisps) {
      // Evict oldest expired wisps first
      this.reap();
      if (this.wisps.size >= this.config.maxWisps) {
        throw new Error(`Wisp limit reached (${this.config.maxWisps}). Reap or promote existing wisps.`);
      }
    }

    const ttl = input.ttlMs || this.config.defaultTtlMs;
    const now = new Date();

    const steps: MoleculeStep[] = input.steps.map((s, i) => ({
      id: `ws-${i + 1}`,
      title: s.title,
      type: (s.type as any) || 'crew',
      status: 'pending' as const,
      needs: i > 0 ? [`ws-${i}`] : [],
      retryCount: 0,
    }));

    const wisp: Wisp = {
      id: `wsp-${uuidv4().slice(0, 8)}`,
      formulaName: `wisp:${input.title.toLowerCase().replace(/\s+/g, '-')}`,
      formulaVersion: 1,
      status: 'running',
      phase: 'VAPOR' as any as MEOWPhase.VAPOR,
      steps,
      vars: {},
      createdAt: now,
      updatedAt: now,
      completedSteps: [],
      currentSteps: steps.length > 0 ? [steps[0].id] : [],
      ttlMs: ttl,
      expiresAt: new Date(now.getTime() + ttl),
    };

    this.wisps.set(wisp.id, wisp);
    this.counters.created++;

    this.emitFeed('bead_updated', `Wisp "${input.title}" created (TTL: ${Math.round(ttl / 1000)}s)`, {
      metadata: { wispId: wisp.id, ttlMs: ttl },
    });

    addActivity({
      type: 'info',
      action: 'wisp_created',
      details: `Wisp ${wisp.id} created: "${input.title}" (${steps.length} steps, TTL ${Math.round(ttl / 1000)}s)`,
    });

    console.info(`[WISP] Created ${wisp.id}: "${input.title}" (${steps.length} steps, TTL ${Math.round(ttl / 1000)}s)`);
    return wisp;
  }

  get(id: string): Wisp | undefined {
    return this.wisps.get(id);
  }

  list(includeExpired = false): Wisp[] {
    const now = Date.now();
    return [...this.wisps.values()].filter(w =>
      includeExpired || w.expiresAt.getTime() > now
    );
  }

  completeStep(wispId: string, stepId: string): Wisp {
    const wisp = this.wisps.get(wispId);
    if (!wisp) throw new Error(`Wisp ${wispId} not found`);

    const step = wisp.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found in wisp ${wispId}`);

    step.status = 'completed';

    // Check if all steps are done
    const allDone = wisp.steps.every(s => s.status === 'completed' || s.status === 'skipped');
    if (allDone) {
      wisp.status = 'completed';
      if (this.config.autoPromoteOnComplete) {
        this.promote(wispId);
      }
    }

    return wisp;
  }

  failStep(wispId: string, stepId: string, error?: string): Wisp {
    const wisp = this.wisps.get(wispId);
    if (!wisp) throw new Error(`Wisp ${wispId} not found`);

    const step = wisp.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found in wisp ${wispId}`);

    step.status = 'failed';
    wisp.status = 'failed';

    return wisp;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Extend a wisp's TTL */
  extend(wispId: string, additionalMs: number): Wisp {
    const wisp = this.wisps.get(wispId);
    if (!wisp) throw new Error(`Wisp ${wispId} not found`);

    wisp.ttlMs += additionalMs;
    wisp.expiresAt = new Date(wisp.expiresAt.getTime() + additionalMs);

    console.info(`[WISP] Extended ${wispId} by ${Math.round(additionalMs / 1000)}s (new TTL: ${Math.round(wisp.ttlMs / 1000)}s)`);
    return wisp;
  }

  /** Promote a wisp to a permanent molecule (VAPOR → LIQUID) */
  promote(wispId: string): { promoted: boolean; moleculeId?: string } {
    const wisp = this.wisps.get(wispId);
    if (!wisp) return { promoted: false };

    // Record lifespan
    this.lifespans.push(Date.now() - wisp.createdAt.getTime());
    if (this.lifespans.length > 500) this.lifespans.splice(0, this.lifespans.length - 250);

    // Remove from wisp store
    this.wisps.delete(wispId);
    this.counters.promoted++;

    this.emitFeed('bead_updated', `Wisp ${wispId} promoted to molecule`, {
      metadata: { wispId, formulaName: wisp.formulaName },
    });

    addActivity({
      type: 'info',
      action: 'wisp_promoted',
      details: `Wisp ${wispId} promoted to permanent molecule (was "${wisp.formulaName}")`,
    });

    console.info(`[WISP] Promoted ${wispId} to permanent molecule`);
    return { promoted: true, moleculeId: wispId };
  }

  /** Manually expire a wisp */
  expire(wispId: string): boolean {
    const wisp = this.wisps.get(wispId);
    if (!wisp) return false;

    this.lifespans.push(Date.now() - wisp.createdAt.getTime());
    if (this.lifespans.length > 500) this.lifespans.splice(0, this.lifespans.length - 250);

    this.wisps.delete(wispId);
    this.counters.expired++;

    console.info(`[WISP] Expired ${wispId}`);
    return true;
  }

  // ─── Reaper (automatic expiry) ─────────────────────────────────────────────

  reap(): number {
    const now = Date.now();
    let reaped = 0;

    for (const [id, wisp] of this.wisps) {
      if (wisp.expiresAt.getTime() <= now) {
        this.lifespans.push(now - wisp.createdAt.getTime());
        this.wisps.delete(id);
        this.counters.expired++;
        reaped++;
      }
    }

    if (this.lifespans.length > 500) this.lifespans.splice(0, this.lifespans.length - 250);
    if (reaped > 0) {
      console.info(`[WISP] Reaped ${reaped} expired wisps (${this.wisps.size} remaining)`);
      broadcast('meow:feed', {
        id: uuidv4(),
        type: 'bead_updated',
        source: 'wisp-reaper',
        message: `WispReaper: ${reaped} wisps expired`,
        severity: 'info',
        timestamp: new Date(),
      });
    }

    return reaped;
  }

  startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => this.reap(), this.config.reapIntervalMs);
    console.info(`[WISP] Reaper started (every ${this.config.reapIntervalMs / 1000}s)`);
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
      console.info('[WISP] Reaper stopped');
    }
  }

  // ─── Batch Operations ──────────────────────────────────────────────────────

  createBatch(inputs: WispCreateInput[]): Wisp[] {
    return inputs.map(i => this.create(i));
  }

  reapAll(): number {
    const count = this.wisps.size;
    for (const [id, wisp] of this.wisps) {
      this.lifespans.push(Date.now() - wisp.createdAt.getTime());
      this.counters.expired++;
    }
    this.wisps.clear();
    if (this.lifespans.length > 500) this.lifespans.splice(0, this.lifespans.length - 250);
    console.info(`[WISP] Reaped all ${count} wisps`);
    return count;
  }

  // ─── Config ────────────────────────────────────────────────────────────────

  setConfig(config: Partial<WispConfig>): void {
    Object.assign(this.config, config);
    // Restart reaper with new interval if running
    if (this.reaperTimer) {
      this.stopReaper();
      this.startReaper();
    }
    console.info(`[WISP] Config updated: TTL=${this.config.defaultTtlMs}ms, max=${this.config.maxWisps}`);
  }

  getConfig(): WispConfig {
    return { ...this.config };
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getStats(): WispStats {
    const avgLifespan = this.lifespans.length > 0
      ? Math.round(this.lifespans.reduce((s, l) => s + l, 0) / this.lifespans.length)
      : 0;

    return {
      active: this.wisps.size,
      expired: this.counters.expired,
      promoted: this.counters.promoted,
      totalCreated: this.counters.created,
      avgLifespanMs: avgLifespan,
    };
  }

  stats() {
    return this.getStats();
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { beadId?: string; moleculeId?: string; convoyId?: string; metadata?: Record<string, unknown> }
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'wisp-system',
      message,
      severity: 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

export const wispSystem = new WispSystem();
