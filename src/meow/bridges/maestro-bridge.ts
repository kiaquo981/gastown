/**
 * MAESTRO BRIDGE — Wave 3
 *
 * Connects local RunMaestro (Electron desktop app) instances to Gas Town central.
 * Each Maestro registers with a callback URL where Gas Town dispatches work.
 *
 * Flow:
 *   1. Local Maestro → POST /register (callbackUrl, capabilities, maxSessions)
 *   2. Gas Town stores instance + starts tracking heartbeat
 *   3. When GUPP has work → Bridge picks best Maestro → POST callbackUrl/dispatch
 *   4. Maestro executes (Claude Code sessions) → POST /report (result)
 *   5. Gas Town updates bead/hook status from the report
 *
 * Heartbeat: Maestros send heartbeat every 30s. Stale after 90s. Dead after 5m.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { addActivity, broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MaestroInstance {
  id: string;
  name: string;
  callbackUrl: string;        // HTTP endpoint on the local machine
  capabilities: string[];     // e.g. ['code','refactor','test','review']
  maxSessions: number;        // Max concurrent Claude Code sessions
  activeSessions: number;     // Current active sessions
  hostname: string;
  os: string;
  version: string;
  status: 'online' | 'busy' | 'stale' | 'dead';
  registeredAt: Date;
  lastHeartbeat: Date;
  totalDispatched: number;
  totalCompleted: number;
  totalFailed: number;
  metadata: Record<string, unknown>;
}

export interface DispatchPayload {
  dispatchId: string;
  beadId: string;
  skill: string;
  title: string;
  description?: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  branch?: string;
  context?: string;
  payload?: Record<string, unknown>;
}

export interface DispatchResult {
  dispatchId: string;
  maestroId: string;
  accepted: boolean;
  error?: string;
}

export interface ReportPayload {
  dispatchId: string;
  maestroId: string;
  success: boolean;
  output: string;
  prUrl?: string;
  branch?: string;
  artifacts?: string[];
  durationMs?: number;
  sessionCount?: number;
  error?: string;
}

export interface MaestroBridgeStats {
  totalInstances: number;
  online: number;
  busy: number;
  stale: number;
  dead: number;
  totalCapacity: number;
  activeLoad: number;
  totalDispatched: number;
  totalCompleted: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = '[MAESTRO-BRIDGE]';
const HEARTBEAT_STALE_MS = 90_000;   // 90s without heartbeat → stale
const HEARTBEAT_DEAD_MS = 300_000;   // 5m without heartbeat → dead
const DISPATCH_TIMEOUT_MS = 10_000;  // 10s for dispatch HTTP call
const PRUNE_INTERVAL_MS = 60_000;    // Prune check every 60s

// ─────────────────────────────────────────────────────────────────────────────
// MaestroBridge
// ─────────────────────────────────────────────────────────────────────────────

export class MaestroBridge {
  private instances: Map<string, MaestroInstance> = new Map();
  private pruneTimer?: NodeJS.Timeout;
  private totalDispatched = 0;
  private totalCompleted = 0;

  constructor() {
    void this.hydrateFromDB();
    this.startPruneLoop();
    console.log(`${PREFIX} Initialized`);
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  /** Register a local Maestro instance. Returns the assigned instance ID. */
  register(input: {
    name?: string;
    callbackUrl: string;
    capabilities?: string[];
    maxSessions?: number;
    hostname?: string;
    os?: string;
    version?: string;
    metadata?: Record<string, unknown>;
  }): MaestroInstance {
    // Check if already registered (by callbackUrl)
    for (const [, inst] of this.instances) {
      if (inst.callbackUrl === input.callbackUrl) {
        // Re-register: update fields, reset status
        inst.status = 'online';
        inst.lastHeartbeat = new Date();
        inst.capabilities = input.capabilities || inst.capabilities;
        inst.maxSessions = input.maxSessions ?? inst.maxSessions;
        inst.hostname = input.hostname || inst.hostname;
        inst.os = input.os || inst.os;
        inst.version = input.version || inst.version;
        inst.metadata = input.metadata || inst.metadata;
        this.persistInstance(inst);
        console.log(`${PREFIX} Re-registered Maestro ${inst.id} (${inst.name}) at ${inst.callbackUrl}`);
        return inst;
      }
    }

    const instance: MaestroInstance = {
      id: `maestro-${uuidv4().slice(0, 8)}`,
      name: input.name || `Maestro-${Date.now().toString(36)}`,
      callbackUrl: input.callbackUrl,
      capabilities: input.capabilities || ['code', 'refactor', 'test', 'review'],
      maxSessions: input.maxSessions ?? 3,
      activeSessions: 0,
      hostname: input.hostname || 'unknown',
      os: input.os || 'unknown',
      version: input.version || '0.0.0',
      status: 'online',
      registeredAt: new Date(),
      lastHeartbeat: new Date(),
      totalDispatched: 0,
      totalCompleted: 0,
      totalFailed: 0,
      metadata: input.metadata || {},
    };

    this.instances.set(instance.id, instance);
    this.persistInstance(instance);

    addActivity({
      type: 'success',
      action: 'maestro_registered',
      details: `${PREFIX} Maestro "${instance.name}" registered (${instance.hostname}, ${instance.maxSessions} slots)`,
    });

    broadcast('maestro:bridge', {
      event: 'registered',
      instance: this.sanitize(instance),
    });

    console.log(`${PREFIX} Registered Maestro ${instance.id} — ${instance.name} at ${instance.callbackUrl} (${instance.maxSessions} slots)`);
    return instance;
  }

  /** Unregister a Maestro instance. */
  unregister(instanceId: string): boolean {
    const inst = this.instances.get(instanceId);
    if (!inst) return false;

    this.instances.delete(instanceId);
    this.removeInstanceFromDB(instanceId);

    addActivity({
      type: 'info',
      action: 'maestro_unregistered',
      details: `${PREFIX} Maestro "${inst.name}" unregistered`,
    });

    console.log(`${PREFIX} Unregistered Maestro ${instanceId}`);
    return true;
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  /** Update heartbeat for a Maestro. Returns false if instance not found. */
  heartbeat(instanceId: string, update?: {
    activeSessions?: number;
    status?: 'online' | 'busy';
    metadata?: Record<string, unknown>;
  }): boolean {
    const inst = this.instances.get(instanceId);
    if (!inst) return false;

    inst.lastHeartbeat = new Date();

    if (update?.activeSessions !== undefined) {
      inst.activeSessions = update.activeSessions;
    }

    // Auto-detect busy vs online
    if (update?.status) {
      inst.status = update.status;
    } else if (inst.activeSessions >= inst.maxSessions) {
      inst.status = 'busy';
    } else if (inst.status === 'stale' || inst.status === 'dead') {
      inst.status = 'online';
    }

    if (update?.metadata) {
      inst.metadata = { ...inst.metadata, ...update.metadata };
    }

    // Fire-and-forget DB update
    this.persistInstance(inst);
    return true;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────

  /**
   * Dispatch work to the best available Maestro.
   * Picks the Maestro with matching capabilities and most free capacity.
   * Returns null if no Maestro available.
   *
   * Note: In single-threaded Node.js, the activeSessions counter is safe
   * because findBestMaestro + fetch + increment run in one async flow.
   * Concurrent dispatches could briefly oversubscribe; self-corrects on heartbeat.
   */
  async dispatch(payload: Omit<DispatchPayload, 'dispatchId'>): Promise<DispatchResult | null> {
    const available = this.findBestMaestro(payload.skill);
    if (!available) {
      console.log(`${PREFIX} No available Maestro for skill "${payload.skill}"`);
      return null;
    }

    const dispatchId = `dsp-${uuidv4().slice(0, 8)}`;
    const fullPayload: DispatchPayload = { ...payload, dispatchId };

    try {
      const response = await fetch(`${available.callbackUrl}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullPayload),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        console.warn(`${PREFIX} Dispatch to ${available.id} failed: ${response.status} ${errText}`);
        return { dispatchId, maestroId: available.id, accepted: false, error: errText };
      }

      // Increment counters
      available.activeSessions++;
      available.totalDispatched++;
      this.totalDispatched++;
      if (available.activeSessions >= available.maxSessions) {
        available.status = 'busy';
      }
      this.persistInstance(available);

      broadcast('maestro:bridge', {
        event: 'dispatched',
        dispatchId,
        maestroId: available.id,
        beadId: payload.beadId,
        skill: payload.skill,
      });

      console.log(`${PREFIX} Dispatched ${dispatchId} to ${available.name} (bead=${payload.beadId}, skill=${payload.skill})`);
      return { dispatchId, maestroId: available.id, accepted: true };

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`${PREFIX} Dispatch HTTP error to ${available.id}: ${error}`);

      // Mark stale if connection failed
      if (error.includes('fetch') || error.includes('ECONNREFUSED') || error.includes('timeout')) {
        available.status = 'stale';
        this.persistInstance(available);
      }

      return { dispatchId, maestroId: available.id, accepted: false, error };
    }
  }

  // ─── Report ───────────────────────────────────────────────────────────────

  /** Receive execution report from a Maestro. */
  report(payload: ReportPayload): void {
    const inst = this.instances.get(payload.maestroId);
    if (inst) {
      inst.activeSessions = Math.max(0, inst.activeSessions - 1);
      inst.lastHeartbeat = new Date();

      if (payload.success) {
        inst.totalCompleted++;
        this.totalCompleted++;
      } else {
        inst.totalFailed++;
      }

      if (inst.activeSessions < inst.maxSessions && inst.status === 'busy') {
        inst.status = 'online';
      }

      this.persistInstance(inst);
    }

    broadcast('maestro:bridge', {
      event: 'report',
      ...payload,
    });

    const status = payload.success ? 'completed' : 'failed';
    console.log(`${PREFIX} Report ${payload.dispatchId} from ${payload.maestroId}: ${status}${payload.prUrl ? ` PR: ${payload.prUrl}` : ''}`);

    addActivity({
      type: payload.success ? 'success' : 'error',
      action: `maestro_${status}`,
      details: `${PREFIX} ${status}: ${payload.dispatchId}${payload.prUrl ? ` — PR: ${payload.prUrl}` : ''}${payload.error ? ` — ${payload.error}` : ''}`,
    });
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Find the best Maestro for a skill. Prefers most free capacity. */
  findBestMaestro(skill: string): MaestroInstance | null {
    let best: MaestroInstance | null = null;
    let bestFree = -1;

    for (const [, inst] of this.instances) {
      if (inst.status !== 'online') continue;
      if (inst.activeSessions >= inst.maxSessions) continue;

      // Check capability match (empty capabilities = accepts anything)
      if (inst.capabilities.length > 0 && !inst.capabilities.includes(skill)) {
        // Loose match: check if skill contains any capability keyword
        const matchesAny = inst.capabilities.some(cap =>
          skill.includes(cap) || cap.includes(skill),
        );
        if (!matchesAny) continue;
      }

      const free = inst.maxSessions - inst.activeSessions;
      if (free > bestFree) {
        bestFree = free;
        best = inst;
      }
    }

    return best;
  }

  /** List all Maestro instances. */
  list(): MaestroInstance[] {
    return Array.from(this.instances.values());
  }

  /** Get a specific instance. */
  get(instanceId: string): MaestroInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** Check if any Maestros are available for dispatch. */
  hasAvailableMaestro(): boolean {
    for (const [, inst] of this.instances) {
      if (inst.status === 'online' && inst.activeSessions < inst.maxSessions) {
        return true;
      }
    }
    return false;
  }

  /** Get bridge stats. */
  stats(): MaestroBridgeStats {
    let online = 0, busy = 0, stale = 0, dead = 0;
    let totalCapacity = 0, activeLoad = 0;

    for (const [, inst] of this.instances) {
      switch (inst.status) {
        case 'online': online++; break;
        case 'busy': busy++; break;
        case 'stale': stale++; break;
        case 'dead': dead++; break;
      }
      totalCapacity += inst.maxSessions;
      activeLoad += inst.activeSessions;
    }

    return {
      totalInstances: this.instances.size,
      online, busy, stale, dead,
      totalCapacity,
      activeLoad,
      totalDispatched: this.totalDispatched,
      totalCompleted: this.totalCompleted,
    };
  }

  // ─── Prune / Health ───────────────────────────────────────────────────────

  private startPruneLoop(): void {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  stopPruneLoop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  /** Mark stale/dead instances. Does NOT remove dead — only marks them. */
  prune(): { stale: number; dead: number } {
    const now = Date.now();
    let staleCount = 0, deadCount = 0;

    for (const [, inst] of this.instances) {
      if (inst.status === 'dead') continue;

      const elapsed = now - inst.lastHeartbeat.getTime();
      if (elapsed > HEARTBEAT_DEAD_MS) {
        inst.status = 'dead';
        deadCount++;
        console.warn(`${PREFIX} Maestro ${inst.id} (${inst.name}) marked DEAD — no heartbeat for ${Math.round(elapsed / 1000)}s`);
        this.persistInstance(inst);
      } else if (elapsed > HEARTBEAT_STALE_MS) {
        if (inst.status !== 'stale') {
          inst.status = 'stale';
          staleCount++;
          console.warn(`${PREFIX} Maestro ${inst.id} (${inst.name}) marked STALE`);
          this.persistInstance(inst);
        }
      }
    }

    return { stale: staleCount, dead: deadCount };
  }

  /** Remove dead instances permanently. */
  removeDead(): number {
    let removed = 0;
    for (const [id, inst] of this.instances) {
      if (inst.status === 'dead') {
        this.instances.delete(id);
        this.removeInstanceFromDB(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`${PREFIX} Removed ${removed} dead Maestro instances`);
    }
    return removed;
  }

  // ─── DB Persistence ───────────────────────────────────────────────────────

  async hydrateFromDB(): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    try {
      const res = await pool.query<{
        id: string; name: string; callback_url: string; capabilities: string[];
        max_sessions: number; active_sessions: number; hostname: string;
        os: string; version: string; status: string; registered_at: string;
        last_heartbeat: string; total_dispatched: number; total_completed: number;
        total_failed: number; metadata: Record<string, unknown>;
      }>(
        `SELECT * FROM meow_maestros WHERE status != 'dead'`,
      );
      for (const row of res.rows) {
        const inst: MaestroInstance = {
          id: row.id,
          name: row.name,
          callbackUrl: row.callback_url,
          capabilities: row.capabilities || [],
          maxSessions: row.max_sessions,
          activeSessions: 0, // Reset on startup — Maestros will re-register
          hostname: row.hostname,
          os: row.os,
          version: row.version,
          status: 'stale', // Stale until re-heartbeat
          registeredAt: new Date(row.registered_at),
          lastHeartbeat: new Date(row.last_heartbeat),
          totalDispatched: row.total_dispatched,
          totalCompleted: row.total_completed,
          totalFailed: row.total_failed,
          metadata: row.metadata || {},
        };
        this.instances.set(inst.id, inst);
      }
      if (res.rows.length > 0) {
        console.log(`${PREFIX} Hydrated ${res.rows.length} Maestro instances from DB (all marked stale until re-heartbeat)`);
      }
    } catch (err) {
      console.error(`${PREFIX} hydrateFromDB error:`, err);
    }
  }

  private persistInstance(inst: MaestroInstance): void {
    const pool = getPool();
    if (!pool) return;
    pool.query(
      `INSERT INTO meow_maestros
         (id, name, callback_url, capabilities, max_sessions, active_sessions,
          hostname, os, version, status, registered_at, last_heartbeat,
          total_dispatched, total_completed, total_failed, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         callback_url = EXCLUDED.callback_url,
         capabilities = EXCLUDED.capabilities,
         max_sessions = EXCLUDED.max_sessions,
         active_sessions = EXCLUDED.active_sessions,
         status = EXCLUDED.status,
         last_heartbeat = EXCLUDED.last_heartbeat,
         total_dispatched = EXCLUDED.total_dispatched,
         total_completed = EXCLUDED.total_completed,
         total_failed = EXCLUDED.total_failed,
         metadata = EXCLUDED.metadata`,
      [
        inst.id, inst.name, inst.callbackUrl, inst.capabilities,
        inst.maxSessions, inst.activeSessions, inst.hostname,
        inst.os, inst.version, inst.status,
        inst.registeredAt, inst.lastHeartbeat,
        inst.totalDispatched, inst.totalCompleted, inst.totalFailed,
        JSON.stringify(inst.metadata),
      ],
    ).catch(err => console.error(`${PREFIX} persistInstance error:`, err));
  }

  private removeInstanceFromDB(id: string): void {
    const pool = getPool();
    if (!pool) return;
    pool.query('DELETE FROM meow_maestros WHERE id = $1', [id])
      .catch(err => console.error(`${PREFIX} removeInstanceFromDB error:`, err));
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private sanitize(inst: MaestroInstance): Record<string, unknown> {
    return {
      id: inst.id,
      name: inst.name,
      capabilities: inst.capabilities,
      maxSessions: inst.maxSessions,
      activeSessions: inst.activeSessions,
      hostname: inst.hostname,
      os: inst.os,
      version: inst.version,
      status: inst.status,
      registeredAt: inst.registeredAt,
      lastHeartbeat: inst.lastHeartbeat,
      totalDispatched: inst.totalDispatched,
      totalCompleted: inst.totalCompleted,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const maestroBridge = new MaestroBridge();
