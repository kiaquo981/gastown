/**
 * GUPP — Gas Town Universal Propulsion Protocol (EP-059/060)
 *
 * "If there is work on your Hook, YOU MUST RUN IT."
 *
 * Hook-based work detection system. Each agent has a hook directory:
 *   .beads/hooks/{agent-id}/
 *
 * When work appears on an agent's hook, GUPP detects it and propels the agent into action.
 * NDI (Nondeterministic Idempotence): Crash recovery guaranteed by persistent hooks.
 *
 * Startup protocol: check hook → check mail → idle protocol
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import { mayor } from './mayor';
import { polecatManager } from './polecat';
import { getPool } from '../../db/client';
import { spawnPolecat } from '../execution/polecat-spawner';
import { getBeadsService } from '../beads-service';
import { maestroBridge } from '../bridges/maestro-bridge';
import type { FeedEvent, FeedEventType, Bead, Mail } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HookEntry {
  id: string;
  agentId: string;
  beadId: string;
  skill: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  payload: Record<string, unknown>;
  createdAt: Date;
  claimedAt?: Date;
  claimedBy?: string;        // Worker ID that claimed this hook
  completedAt?: Date;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'expired';
  retryCount: number;
  maxRetries: number;
  expiresAt?: Date;
}

export interface GUPPConfig {
  scanIntervalMs: number;       // How often to scan hooks (default 15s)
  hookTtlMs: number;            // Hook expiration (default 1h)
  maxRetries: number;           // Max retries per hook (default 3)
  autoSpawnPolecat: boolean;    // Auto-spawn polecat when hook detected
}

export interface GUPPStats {
  totalHooks: number;
  pendingHooks: number;
  claimedHooks: number;
  runningHooks: number;
  completedHooks: number;
  failedHooks: number;
  expiredHooks: number;
  agentHookCounts: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GUPPConfig = {
  scanIntervalMs: 15_000,         // 15 seconds
  hookTtlMs: 60 * 60 * 1000,     // 1 hour
  maxRetries: 3,
  autoSpawnPolecat: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// GUPP Engine
// ─────────────────────────────────────────────────────────────────────────────

export class GUPP {
  private hooks: Map<string, HookEntry> = new Map();
  private config: GUPPConfig;
  private scanTimer?: NodeJS.Timeout;
  private scanCount: number = 0;

  constructor(config?: Partial<GUPPConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    void this.hydrateFromDB();
  }

  // ─── DB Persistence (write-through cache) ──────────────────────────────────

  /** Hydrate in-memory hooks from DB on startup (NDI guarantee across restarts). */
  async hydrateFromDB(): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    try {
      const res = await pool.query<{
        id: string; agent_id: string; bead_id: string; skill: string;
        priority: string; payload: Record<string, unknown>; status: string;
        retry_count: number; max_retries: number; claimed_by: string | null;
        claimed_at: string | null; completed_at: string | null;
        expires_at: string | null; created_at: string;
      }>(
        `SELECT * FROM meow_hooks WHERE status NOT IN ('completed','failed','expired')`,
      );
      for (const row of res.rows) {
        const hook: HookEntry = {
          id: row.id,
          agentId: row.agent_id,
          beadId: row.bead_id,
          skill: row.skill,
          priority: row.priority as HookEntry['priority'],
          payload: row.payload ?? {},
          createdAt: new Date(row.created_at),
          claimedAt: row.claimed_at ? new Date(row.claimed_at) : undefined,
          claimedBy: row.claimed_by ?? undefined,
          completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
          status: row.status as HookEntry['status'],
          retryCount: row.retry_count,
          maxRetries: row.max_retries,
          expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
        };
        this.hooks.set(hook.id, hook);
      }
      if (res.rows.length > 0) {
        console.log(`[GUPP] Hydrated ${res.rows.length} hooks from DB (NDI)`);
      }
    } catch (err) {
      console.error('[GUPP] hydrateFromDB error:', err);
    }
  }

  /** Upsert a hook to DB — fire-and-forget, never blocks the hot path. */
  private persistHook(hook: HookEntry): void {
    const pool = getPool();
    if (!pool) return;
    pool.query(
      `INSERT INTO meow_hooks
         (id, agent_id, bead_id, skill, priority, payload, status, retry_count, max_retries,
          claimed_by, claimed_at, completed_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         status       = EXCLUDED.status,
         retry_count  = EXCLUDED.retry_count,
         claimed_by   = EXCLUDED.claimed_by,
         claimed_at   = EXCLUDED.claimed_at,
         completed_at = EXCLUDED.completed_at`,
      [
        hook.id, hook.agentId, hook.beadId, hook.skill,
        hook.priority, JSON.stringify(hook.payload),
        hook.status, hook.retryCount, hook.maxRetries,
        hook.claimedBy ?? null, hook.claimedAt ?? null,
        hook.completedAt ?? null, hook.expiresAt ?? null,
        hook.createdAt,
      ],
    ).catch(err => console.error('[GUPP] persistHook error:', err));
  }

  // ─── Hook Management ───────────────────────────────────────────────────────

  /** Place work on an agent's hook — the core GUPP primitive */
  placeHook(agentId: string, beadId: string, skill: string, options?: {
    priority?: HookEntry['priority'];
    payload?: Record<string, unknown>;
    ttlMs?: number;
  }): HookEntry {
    const hook: HookEntry = {
      id: `hook-${uuidv4().slice(0, 8)}`,
      agentId,
      beadId,
      skill,
      priority: options?.priority || 'normal',
      payload: options?.payload || {},
      createdAt: new Date(),
      status: 'pending',
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      expiresAt: new Date(Date.now() + (options?.ttlMs || this.config.hookTtlMs)),
    };

    this.hooks.set(hook.id, hook);
    this.persistHook(hook);

    this.emitFeed('bead_updated', `Hook placed for agent ${agentId}: bead ${beadId} (${skill})`, {
      beadId,
      metadata: { hookId: hook.id, agentId, skill, priority: hook.priority },
    });

    addActivity({
      type: 'info',
      action: 'hook_placed',
      details: `GUPP hook placed: agent ${agentId}, bead ${beadId}, skill ${skill}`,
    });

    return hook;
  }

  /** Claim a hook — marks it as being worked on */
  claimHook(hookId: string, workerId: string): HookEntry {
    const hook = this.hooks.get(hookId);
    if (!hook) throw new Error(`Hook ${hookId} not found`);
    if (hook.status !== 'pending') throw new Error(`Hook ${hookId} is ${hook.status}, cannot claim`);

    hook.status = 'claimed';
    hook.claimedAt = new Date();
    hook.claimedBy = workerId;
    this.persistHook(hook);

    this.emitFeed('bead_updated', `Hook ${hookId} claimed by ${workerId}`, {
      beadId: hook.beadId,
      metadata: { hookId, workerId },
    });

    return hook;
  }

  /** Mark hook as running */
  startHook(hookId: string): HookEntry {
    const hook = this.hooks.get(hookId);
    if (!hook) throw new Error(`Hook ${hookId} not found`);
    if (hook.status !== 'claimed') throw new Error(`Hook ${hookId} is ${hook.status}, must be claimed first`);

    hook.status = 'running';
    this.persistHook(hook);
    return hook;
  }

  /** Complete a hook */
  completeHook(hookId: string): HookEntry {
    const hook = this.hooks.get(hookId);
    if (!hook) throw new Error(`Hook ${hookId} not found`);

    hook.status = 'completed';
    hook.completedAt = new Date();
    this.persistHook(hook);

    this.emitFeed('bead_completed', `Hook ${hookId} completed for bead ${hook.beadId}`, {
      beadId: hook.beadId,
      metadata: { hookId, agentId: hook.agentId, skill: hook.skill },
    });

    return hook;
  }

  /** Fail a hook — retries if under limit */
  failHook(hookId: string, error: string): HookEntry {
    const hook = this.hooks.get(hookId);
    if (!hook) throw new Error(`Hook ${hookId} not found`);

    hook.retryCount++;
    if (hook.retryCount < hook.maxRetries) {
      // Reset to pending for retry
      hook.status = 'pending';
      hook.claimedAt = undefined;
      hook.claimedBy = undefined;
      this.persistHook(hook);

      this.emitFeed('worker_error', `Hook ${hookId} failed (retry ${hook.retryCount}/${hook.maxRetries}): ${error}`, {
        beadId: hook.beadId,
        metadata: { hookId, error, retryCount: hook.retryCount },
      });
    } else {
      // Exhausted retries
      hook.status = 'failed';
      this.persistHook(hook);

      this.emitFeed('worker_error', `Hook ${hookId} permanently failed after ${hook.maxRetries} retries: ${error}`, {
        beadId: hook.beadId,
        metadata: { hookId, error, retryCount: hook.retryCount },
      });

      // Escalate to mayor
      mayor.handleEscalation(
        `Hook ${hookId} failed after ${hook.maxRetries} retries: ${error}`,
        'gupp',
        hook.beadId,
      );
    }

    return hook;
  }

  // ─── Hook Queries ──────────────────────────────────────────────────────────

  /** Get pending hooks for an agent */
  getAgentHooks(agentId: string): HookEntry[] {
    return Array.from(this.hooks.values())
      .filter(h => h.agentId === agentId && h.status === 'pending')
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /** Get all pending hooks across all agents */
  getPendingHooks(): HookEntry[] {
    return Array.from(this.hooks.values())
      .filter(h => h.status === 'pending')
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  /** Get a specific hook */
  getHook(hookId: string): HookEntry | undefined {
    return this.hooks.get(hookId);
  }

  /** Get all hooks */
  listHooks(): HookEntry[] {
    return Array.from(this.hooks.values());
  }

  // ─── Scan Loop ─────────────────────────────────────────────────────────────

  /** Start the GUPP scan loop — the propulsion engine */
  startScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => this.scan(), this.config.scanIntervalMs);

    addActivity({
      type: 'info',
      action: 'gupp_started',
      details: `GUPP propulsion started (scan every ${this.config.scanIntervalMs / 1000}s)`,
    });
  }

  /** Stop the scan loop */
  stopScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  /** Run one scan cycle — detect hooks, expire old ones, auto-spawn polecats */
  async scan(): Promise<{ processed: number; expired: number; spawned: number }> {
    this.scanCount++;
    const now = Date.now();
    let expired = 0;
    let spawned = 0;

    // 1. Expire old hooks
    for (const [id, hook] of this.hooks) {
      if (hook.expiresAt && now > hook.expiresAt.getTime() && hook.status === 'pending') {
        hook.status = 'expired';
        expired++;
      }
    }

    // 2. Auto-spawn polecats for pending hooks → fire real execution
    if (this.config.autoSpawnPolecat) {
      const pending = this.getPendingHooks();

      for (const hook of pending) {
        try {
          const polecat = await polecatManager.spawn(hook.beadId, hook.skill);
          hook.status = 'claimed';
          hook.claimedAt = new Date();
          hook.claimedBy = polecat.id;
          this.persistHook(hook);
          spawned++;

          this.emitFeed('polecat_spawned', `GUPP auto-spawned polecat ${polecat.id} for hook ${hook.id}`, {
            beadId: hook.beadId,
            metadata: { hookId: hook.id, polecatId: polecat.id, skill: hook.skill },
          });

          // Fire real execution asynchronously — never block the scan loop
          void this.executeHook(hook);
        } catch {
          // Polecat pool full — will retry next scan
          break;
        }
      }
    }

    // 3. Cleanup completed/failed hooks older than TTL
    for (const [id, hook] of this.hooks) {
      if (
        (hook.status === 'completed' || hook.status === 'failed' || hook.status === 'expired') &&
        hook.createdAt.getTime() + this.config.hookTtlMs * 2 < now
      ) {
        this.hooks.delete(id);
      }
    }

    return { processed: this.scanCount, expired, spawned };
  }

  // ─── NDI (Nondeterministic Idempotence) ────────────────────────────────────

  /**
   * Startup recovery — re-process any hooks that were claimed but not completed.
   * This guarantees NDI: if the system crashes, pending work is not lost.
   */
  recover(): number {
    let recovered = 0;
    for (const [, hook] of this.hooks) {
      if (hook.status === 'claimed' || hook.status === 'running') {
        hook.status = 'pending';
        hook.claimedAt = undefined;
        hook.claimedBy = undefined;
        recovered++;
      }
    }

    if (recovered > 0) {
      addActivity({
        type: 'warning',
        action: 'gupp_recovery',
        details: `GUPP NDI recovery: ${recovered} hooks reset to pending`,
      });
    }

    return recovered;
  }

  // ─── Real Execution Bridge ──────────────────────────────────────────────────

  /**
   * Execute a claimed hook. Prefers dispatching to a connected Maestro instance.
   * Falls back to local spawnPolecat (Gemini + worktree + PR) if no Maestro available.
   * Fire-and-forget from the scan loop — completes or fails the hook when done.
   */
  private async executeHook(hook: HookEntry): Promise<void> {
    try {
      // Deduplication: skip if another hook for the same bead is already running
      const siblingHooks = this.listHooks().filter(
        h => h.beadId === hook.beadId && h.id !== hook.id &&
        (h.status === 'running' || h.status === 'claimed'),
      );
      if (siblingHooks.length > 0) {
        hook.status = 'completed';
        this.persistHook(hook);
        return;
      }

      // Look up the bead for context
      let bead: { id: string; title: string; description?: string } = {
        id: hook.beadId,
        title: hook.skill,
      };
      try {
        const beadsService = getBeadsService();
        const fullBead = await beadsService.get(hook.beadId);
        if (fullBead) {
          bead = { id: fullBead.id, title: fullBead.title, description: fullBead.description };
        }
      } catch {
        // Bead lookup failed — use minimal placeholder
      }

      // Start the hook
      this.startHook(hook.id);

      // Strategy: try Maestro dispatch first, fall back to local polecat
      if (maestroBridge.hasAvailableMaestro()) {
        const dispatchResult = await maestroBridge.dispatch({
          beadId: hook.beadId,
          skill: hook.skill,
          title: bead.title,
          description: bead.description,
          priority: hook.priority,
          context: hook.payload ? JSON.stringify(hook.payload) : undefined,
        });

        if (dispatchResult?.accepted) {
          // Maestro accepted — hook stays in 'running' until report comes back.
          // Store dispatchId so the report handler can match this hook.
          hook.payload = { ...hook.payload, dispatchId: dispatchResult.dispatchId };
          hook.expiresAt = new Date(Date.now() + 30 * 60 * 1000);
          this.persistHook(hook);
          return;
        }
        // Maestro dispatch failed — fall through to local execution
      }

      // Local fallback: Gemini + git worktree + PR
      const tier: 'S' | 'A' | 'B' =
        hook.priority === 'critical' ? 'S' :
        hook.priority === 'high' ? 'A' : 'B';

      const result = await spawnPolecat({
        bead,
        skill: hook.skill,
        tier,
        context: hook.payload ? JSON.stringify(hook.payload) : undefined,
      });

      if (result.success) {
        this.completeHook(hook.id);
      } else {
        this.failHook(hook.id, result.output.slice(0, 500));
      }
    } catch (err) {
      try {
        this.failHook(hook.id, err instanceof Error ? err.message : String(err));
      } catch {
        // Hook may have been cleaned up — ignore
      }
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  stats(): GUPPStats {
    const agentHookCounts: Record<string, number> = {};
    let pending = 0, claimed = 0, running = 0, completed = 0, failed = 0, expired = 0;

    for (const [, hook] of this.hooks) {
      if (!agentHookCounts[hook.agentId]) agentHookCounts[hook.agentId] = 0;
      agentHookCounts[hook.agentId]++;

      switch (hook.status) {
        case 'pending': pending++; break;
        case 'claimed': claimed++; break;
        case 'running': running++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
        case 'expired': expired++; break;
      }
    }

    return {
      totalHooks: this.hooks.size,
      pendingHooks: pending,
      claimedHooks: claimed,
      runningHooks: running,
      completedHooks: completed,
      failedHooks: failed,
      expiredHooks: expired,
      agentHookCounts,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { beadId?: string; metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'gupp',
      message,
      severity: type === 'worker_error' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton GUPP instance */
export const gupp = new GUPP();
