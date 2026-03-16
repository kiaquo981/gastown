/**
 * WORKER POOL — Advanced Worker Management (EP-048 → EP-058)
 *
 * Gas Town: "Every worker has a name, a rig, a cost, and a heartbeat."
 *
 * Unified registry for all worker lifecycle operations:
 * - EP-048: Worker Identity — persistent registry with CV chain
 * - EP-049: Worker Keepalive — heartbeat, staleness, death detection
 * - EP-050: Worker Mail — convenience wrappers around MailRouter
 * - EP-051: Worker Hooks — convenience wrappers around GUPP
 * - EP-052: Worker Rigs — worker↔rig (workspace/worktree) binding
 * - EP-053: Worker Pool — spawn limits, queueing, capacity management
 * - EP-054: Worker Cost — token/cost tracking per worker
 * - EP-055: Worker Session — state persistence, handoff between workers
 * - EP-056: Worker Crash Recovery — crash marking, auto-recovery, logs
 * - EP-057: Worker Config — per-worker LLM config (model, tier, temp, etc.)
 * - EP-058: Worker Templates — role-based templates for quick spawning
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../sse';
import { mailRouter } from './mail';
import { gupp } from './workers/gupp';
import type {
  WorkerIdentity,
  WorkerRole,
  Capability,
  FeedEvent,
  FeedEventType,
  MailPriority,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// EP-048: Worker Identity — CV Chain
// ─────────────────────────────────────────────────────────────────────────────

export interface CVEntry {
  beadId?: string;
  task: string;
  assignedAt: Date;
  completedAt?: Date;
  outcome: 'completed' | 'failed' | 'in_progress' | 'handed_off';
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-049: Worker Keepalive
// ─────────────────────────────────────────────────────────────────────────────

export type AliveStatus = 'alive' | 'stale' | 'dead';

const STALE_THRESHOLD_MS = 60_000;   // 60 seconds
const DEAD_THRESHOLD_MS = 300_000;   // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// EP-052: Worker Rigs
// ─────────────────────────────────────────────────────────────────────────────

export interface RigBinding {
  workerId: string;
  rigId: string;
  assignedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-053: Worker Pool Config
// ─────────────────────────────────────────────────────────────────────────────

export interface PoolConfig {
  maxWorkers: number;
  maxPerRole: Record<string, number>;
  queueSize: number;
}

export interface PoolStatus {
  active: number;
  queued: number;
  capacity: number;
}

export interface QueuedSpawn {
  id: string;
  role: WorkerRole;
  priority: number;           // Lower = higher priority
  queuedAt: Date;
  overrides?: Partial<WorkerTemplate>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-054: Worker Cost
// ─────────────────────────────────────────────────────────────────────────────

export interface CostRecord {
  tokens: number;
  costUsd: number;
  recordedAt: Date;
}

export interface WorkerCostSummary {
  totalTokens: number;
  totalCost: number;
  sessions: number;
}

export interface CostReportEntry {
  workerId: string;
  workerName: string;
  role: WorkerRole;
  totalTokens: number;
  totalCost: number;
  sessions: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-055: Worker Session
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionState {
  workerId: string;
  savedAt: Date;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-056: Worker Crash Recovery
// ─────────────────────────────────────────────────────────────────────────────

export interface CrashLogEntry {
  workerId: string;
  error: string;
  crashedAt: Date;
  recoveredAt?: Date;
  autoRecovery: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-057: Worker Config
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  model: 'opus' | 'sonnet' | 'haiku';
  tier: 'S' | 'A' | 'B';
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

const DEFAULT_CONFIGS: Record<WorkerRole, WorkerConfig> = {
  mayor:    { model: 'opus',   tier: 'S', maxTokens: 8192,  temperature: 0.3 },
  polecat:  { model: 'sonnet', tier: 'A', maxTokens: 4096,  temperature: 0.5 },
  crew:     { model: 'sonnet', tier: 'A', maxTokens: 4096,  temperature: 0.5 },
  refinery: { model: 'sonnet', tier: 'A', maxTokens: 2048,  temperature: 0.2 },
  witness:  { model: 'haiku',  tier: 'B', maxTokens: 2048,  temperature: 0.3 },
  deacon:   { model: 'haiku',  tier: 'B', maxTokens: 2048,  temperature: 0.2 },
  boot:     { model: 'haiku',  tier: 'B', maxTokens: 1024,  temperature: 0.1 },
  dog:      { model: 'haiku',  tier: 'B', maxTokens: 1024,  temperature: 0.1 },
  overseer: { model: 'opus',   tier: 'S', maxTokens: 8192,  temperature: 0.3 },
};

// ─────────────────────────────────────────────────────────────────────────────
// EP-058: Worker Templates
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerTemplate {
  model: 'opus' | 'sonnet' | 'haiku';
  tier: 'S' | 'A' | 'B';
  capabilities: Capability[];
  systemPrompt?: string;
  tools?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Pool Config
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxWorkers: 50,
  maxPerRole: {
    mayor: 1,
    polecat: 20,
    crew: 15,
    refinery: 2,
    witness: 3,
    deacon: 1,
    boot: 1,
    dog: 4,
    overseer: 5,
  },
  queueSize: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
// WorkerPool
// ─────────────────────────────────────────────────────────────────────────────

export class WorkerPool {
  // EP-048: Identity registry
  private workers: Map<string, WorkerIdentity> = new Map();
  private cvChains: Map<string, CVEntry[]> = new Map();

  // EP-049: Keepalive
  private heartbeats: Map<string, Date> = new Map();

  // EP-052: Rigs
  private rigBindings: Map<string, RigBinding> = new Map();         // workerId → RigBinding

  // EP-053: Pool
  private poolConfig: PoolConfig = { ...DEFAULT_POOL_CONFIG };
  private spawnQueue: QueuedSpawn[] = [];

  // EP-054: Cost
  private costRecords: Map<string, CostRecord[]> = new Map();

  // EP-055: Session
  private sessions: Map<string, SessionState> = new Map();

  // EP-056: Crash recovery
  private crashLogs: Map<string, CrashLogEntry[]> = new Map();
  private crashedWorkers: Set<string> = new Set();

  // EP-057: Config
  private workerConfigs: Map<string, WorkerConfig> = new Map();

  // EP-058: Templates
  private templates: Map<string, WorkerTemplate> = new Map();

  constructor() {
    console.log('[WORKER-POOL] WorkerPool initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-048: Worker Identity
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register a worker in the pool */
  registerWorker(identity: WorkerIdentity): WorkerIdentity {
    if (this.workers.has(identity.id)) {
      console.log(`[WORKER-POOL] Worker ${identity.id} already registered, updating`);
    }
    this.workers.set(identity.id, { ...identity, lastActiveAt: new Date() });
    this.heartbeats.set(identity.id, new Date());
    this.cvChains.set(identity.id, this.cvChains.get(identity.id) || []);

    // Register with mail system for broadcast delivery
    mailRouter.registerRole(identity.role, identity.id);

    this.emitFeed('system_health', `Worker registered: ${identity.name} (${identity.role})`, {
      metadata: { workerId: identity.id, role: identity.role, tier: identity.tier },
    });

    console.log(`[WORKER-POOL] Registered worker: ${identity.id} (${identity.role}/${identity.name})`);
    return this.workers.get(identity.id)!;
  }

  /** Get a worker by ID */
  getWorker(id: string): WorkerIdentity | undefined {
    return this.workers.get(id);
  }

  /** List workers with optional filters */
  listWorkers(filters?: {
    role?: WorkerRole;
    tier?: 'S' | 'A' | 'B';
    model?: 'opus' | 'sonnet' | 'haiku';
    alive?: boolean;
  }): WorkerIdentity[] {
    let result = Array.from(this.workers.values());

    if (filters?.role) {
      result = result.filter(w => w.role === filters.role);
    }
    if (filters?.tier) {
      result = result.filter(w => w.tier === filters.tier);
    }
    if (filters?.model) {
      result = result.filter(w => w.model === filters.model);
    }
    if (filters?.alive !== undefined) {
      result = result.filter(w => {
        const status = this.checkAlive(w.id);
        return filters.alive ? status === 'alive' : status !== 'alive';
      });
    }

    return result;
  }

  /** Update a worker's fields */
  updateWorker(id: string, updates: Partial<WorkerIdentity>): WorkerIdentity {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Worker ${id} not found`);

    Object.assign(worker, updates, { lastActiveAt: new Date() });
    console.log(`[WORKER-POOL] Updated worker: ${id}`);
    return worker;
  }

  /** Get the CV chain (assignment/completion history) for a worker */
  getWorkerCV(id: string): CVEntry[] {
    return this.cvChains.get(id) || [];
  }

  /** Add a CV entry for a worker */
  addCVEntry(workerId: string, entry: Omit<CVEntry, 'assignedAt'>): CVEntry {
    const chain = this.cvChains.get(workerId) || [];
    const full: CVEntry = { ...entry, assignedAt: new Date() };
    chain.push(full);
    this.cvChains.set(workerId, chain);
    return full;
  }

  /** Complete the latest in-progress CV entry */
  completeCVEntry(workerId: string, outcome: CVEntry['outcome'], notes?: string): void {
    const chain = this.cvChains.get(workerId);
    if (!chain || chain.length === 0) return;

    const current = chain.find(e => e.outcome === 'in_progress');
    if (current) {
      current.outcome = outcome;
      current.completedAt = new Date();
      if (notes) current.notes = notes;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-049: Worker Keepalive
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record a heartbeat for a worker */
  heartbeat(workerId: string): void {
    if (!this.workers.has(workerId)) {
      console.log(`[WORKER-POOL] Heartbeat for unknown worker: ${workerId}`);
      return;
    }
    this.heartbeats.set(workerId, new Date());

    const worker = this.workers.get(workerId)!;
    worker.lastActiveAt = new Date();

    // Auto-recovery: if worker was crashed and sends heartbeat, recover it
    if (this.crashedWorkers.has(workerId)) {
      this.recover(workerId);
    }
  }

  /** Check if a worker is alive, stale, or dead */
  checkAlive(workerId: string): AliveStatus {
    const last = this.heartbeats.get(workerId);
    if (!last) return 'dead';

    const elapsed = Date.now() - last.getTime();
    if (elapsed <= STALE_THRESHOLD_MS) return 'alive';
    if (elapsed <= DEAD_THRESHOLD_MS) return 'stale';
    return 'dead';
  }

  /** Get the last heartbeat timestamp */
  getLastHeartbeat(workerId: string): Date | undefined {
    return this.heartbeats.get(workerId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-050: Worker Mail
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get the mailbox contents for a worker */
  getWorkerMailbox(workerId: string) {
    return mailRouter.getInbox(workerId);
  }

  /** Send a message to a worker — convenience wrapper */
  sendToWorker(
    workerId: string,
    subject: string,
    body: string,
    priority: MailPriority = 'normal',
  ) {
    return mailRouter.send({
      from: 'worker-pool',
      to: workerId,
      priority,
      type: 'notification',
      delivery: 'direct',
      subject,
      body,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-051: Worker Hooks
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get pending GUPP hooks for a worker (by agent ID) */
  getWorkerHooks(workerId: string) {
    const worker = this.workers.get(workerId);
    const agentId = worker?.agentDefId || workerId;
    return gupp.getAgentHooks(agentId).filter(h => h.status === 'pending');
  }

  /** Assign a GUPP hook to a worker */
  assignHook(workerId: string, hookId: string) {
    return gupp.claimHook(hookId, workerId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-052: Worker Rigs
  // ═══════════════════════════════════════════════════════════════════════════

  /** Bind a worker to a rig (workspace/worktree) */
  assignRig(workerId: string, rigId: string): RigBinding {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    const binding: RigBinding = {
      workerId,
      rigId,
      assignedAt: new Date(),
    };

    this.rigBindings.set(workerId, binding);
    worker.worktree = rigId;

    console.log(`[WORKER-POOL] Worker ${workerId} assigned to rig ${rigId}`);
    return binding;
  }

  /** Get the rig binding for a worker */
  getRig(workerId: string): RigBinding | undefined {
    return this.rigBindings.get(workerId);
  }

  /** List all workers bound to a specific rig */
  listWorkersByRig(rigId: string): WorkerIdentity[] {
    const workerIds: string[] = [];
    for (const [wid, binding] of this.rigBindings) {
      if (binding.rigId === rigId) workerIds.push(wid);
    }
    return workerIds
      .map(id => this.workers.get(id))
      .filter(Boolean) as WorkerIdentity[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-053: Worker Pool Management
  // ═══════════════════════════════════════════════════════════════════════════

  /** Set pool configuration */
  setPoolConfig(config: Partial<PoolConfig>): void {
    if (config.maxWorkers !== undefined) this.poolConfig.maxWorkers = config.maxWorkers;
    if (config.queueSize !== undefined) this.poolConfig.queueSize = config.queueSize;
    if (config.maxPerRole) {
      this.poolConfig.maxPerRole = { ...this.poolConfig.maxPerRole, ...config.maxPerRole };
    }
    console.log(`[WORKER-POOL] Pool config updated: max=${this.poolConfig.maxWorkers}, queue=${this.poolConfig.queueSize}`);
  }

  /** Check if a new worker of the given role can be spawned */
  canSpawn(role: WorkerRole): boolean {
    // Total capacity check
    if (this.workers.size >= this.poolConfig.maxWorkers) return false;

    // Per-role limit check
    const maxForRole = this.poolConfig.maxPerRole[role];
    if (maxForRole !== undefined) {
      const currentCount = Array.from(this.workers.values()).filter(w => w.role === role).length;
      if (currentCount >= maxForRole) return false;
    }

    return true;
  }

  /** Get current pool status */
  getPoolStatus(): PoolStatus {
    return {
      active: this.workers.size,
      queued: this.spawnQueue.length,
      capacity: this.poolConfig.maxWorkers - this.workers.size,
    };
  }

  /** Queue a spawn request when pool is at capacity */
  queueSpawn(role: WorkerRole, priority: number = 5, overrides?: Partial<WorkerTemplate>): QueuedSpawn {
    if (this.spawnQueue.length >= this.poolConfig.queueSize) {
      throw new Error(`Spawn queue full (${this.poolConfig.queueSize})`);
    }

    const entry: QueuedSpawn = {
      id: `qs-${uuidv4().slice(0, 8)}`,
      role,
      priority,
      queuedAt: new Date(),
      overrides,
    };

    // Insert sorted by priority (lower = higher priority)
    const insertIdx = this.spawnQueue.findIndex(q => q.priority > priority);
    if (insertIdx === -1) {
      this.spawnQueue.push(entry);
    } else {
      this.spawnQueue.splice(insertIdx, 0, entry);
    }

    console.log(`[WORKER-POOL] Queued spawn: ${role} (priority=${priority}, queue=${this.spawnQueue.length})`);
    return entry;
  }

  /** Drain the queue — attempt to spawn queued workers */
  drainQueue(): WorkerIdentity[] {
    const spawned: WorkerIdentity[] = [];

    while (this.spawnQueue.length > 0) {
      const next = this.spawnQueue[0];
      if (!this.canSpawn(next.role)) break;

      this.spawnQueue.shift();
      try {
        const worker = this.spawnFromTemplate(next.role, next.overrides);
        spawned.push(worker);
      } catch (err) {
        console.log(`[WORKER-POOL] Queue drain failed for ${next.role}: ${(err as Error).message}`);
      }
    }

    if (spawned.length > 0) {
      console.log(`[WORKER-POOL] Drained ${spawned.length} from queue`);
    }

    return spawned;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-054: Worker Cost
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record token usage and cost for a worker */
  recordCost(workerId: string, tokens: number, costUsd: number): void {
    const records = this.costRecords.get(workerId) || [];
    records.push({ tokens, costUsd, recordedAt: new Date() });
    this.costRecords.set(workerId, records);
  }

  /** Get cost summary for a worker */
  getWorkerCost(workerId: string): WorkerCostSummary {
    const records = this.costRecords.get(workerId) || [];
    return {
      totalTokens: records.reduce((sum, r) => sum + r.tokens, 0),
      totalCost: records.reduce((sum, r) => sum + r.costUsd, 0),
      sessions: records.length,
    };
  }

  /** Get cost report for all workers */
  getCostReport(): CostReportEntry[] {
    const report: CostReportEntry[] = [];

    for (const [workerId, records] of this.costRecords) {
      const worker = this.workers.get(workerId);
      report.push({
        workerId,
        workerName: worker?.name || 'unknown',
        role: worker?.role || 'polecat',
        totalTokens: records.reduce((sum, r) => sum + r.tokens, 0),
        totalCost: records.reduce((sum, r) => sum + r.costUsd, 0),
        sessions: records.length,
      });
    }

    return report.sort((a, b) => b.totalCost - a.totalCost);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-055: Worker Session
  // ═══════════════════════════════════════════════════════════════════════════

  /** Save session state for a worker */
  saveSession(workerId: string, state: Record<string, unknown>): void {
    this.sessions.set(workerId, {
      workerId,
      savedAt: new Date(),
      data: state,
    });
    console.log(`[WORKER-POOL] Session saved for worker: ${workerId}`);
  }

  /** Restore session state for a worker */
  restoreSession(workerId: string): Record<string, unknown> | undefined {
    const session = this.sessions.get(workerId);
    if (!session) return undefined;
    console.log(`[WORKER-POOL] Session restored for worker: ${workerId} (saved at ${session.savedAt.toISOString()})`);
    return session.data;
  }

  /** Handoff context from one worker to another */
  handoff(fromWorkerId: string, toWorkerId: string): void {
    const fromWorker = this.workers.get(fromWorkerId);
    const toWorker = this.workers.get(toWorkerId);
    if (!fromWorker) throw new Error(`Source worker ${fromWorkerId} not found`);
    if (!toWorker) throw new Error(`Target worker ${toWorkerId} not found`);

    // Transfer session state
    const session = this.sessions.get(fromWorkerId);
    if (session) {
      this.sessions.set(toWorkerId, {
        workerId: toWorkerId,
        savedAt: new Date(),
        data: { ...session.data, handoffFrom: fromWorkerId, handoffAt: new Date().toISOString() },
      });
    }

    // Transfer current bead
    if (fromWorker.currentBeadId) {
      toWorker.currentBeadId = fromWorker.currentBeadId;
      fromWorker.currentBeadId = undefined;
    }

    // Transfer rig binding
    const rig = this.rigBindings.get(fromWorkerId);
    if (rig) {
      this.rigBindings.set(toWorkerId, { ...rig, workerId: toWorkerId, assignedAt: new Date() });
      this.rigBindings.delete(fromWorkerId);
      toWorker.worktree = rig.rigId;
      fromWorker.worktree = undefined;
    }

    // Update CV chains
    this.completeCVEntry(fromWorkerId, 'handed_off', `Handed off to ${toWorkerId}`);
    this.addCVEntry(toWorkerId, {
      task: `Handoff from ${fromWorkerId}`,
      outcome: 'in_progress',
      notes: `Received handoff from ${fromWorker.name} (${fromWorker.role})`,
    });

    // Notify via mail
    this.sendToWorker(toWorkerId, 'Handoff received', `Work handed off from ${fromWorker.name} (${fromWorker.role}).`, 'high');

    this.emitFeed('system_health', `Handoff: ${fromWorker.name} → ${toWorker.name}`, {
      metadata: { fromWorkerId, toWorkerId },
    });

    console.log(`[WORKER-POOL] Handoff: ${fromWorkerId} → ${toWorkerId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-056: Worker Crash Recovery
  // ═══════════════════════════════════════════════════════════════════════════

  /** Mark a worker as crashed */
  markCrashed(workerId: string, error: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Worker ${workerId} not found`);

    this.crashedWorkers.add(workerId);

    const logs = this.crashLogs.get(workerId) || [];
    logs.push({
      workerId,
      error,
      crashedAt: new Date(),
      autoRecovery: false,
    });
    this.crashLogs.set(workerId, logs);

    // Save session before marking crash
    this.saveSession(workerId, {
      crashedAt: new Date().toISOString(),
      error,
      lastBeadId: worker.currentBeadId,
      lastRole: worker.role,
    });

    this.emitFeed('worker_error', `Worker CRASHED: ${worker.name} (${worker.role}) — ${error}`, {
      metadata: { workerId, error, role: worker.role },
    });

    console.log(`[WORKER-POOL] Worker crashed: ${workerId} — ${error}`);
  }

  /** Recover a crashed worker */
  recover(workerId: string): void {
    if (!this.crashedWorkers.has(workerId)) {
      console.log(`[WORKER-POOL] Worker ${workerId} is not crashed, nothing to recover`);
      return;
    }

    this.crashedWorkers.delete(workerId);
    this.heartbeats.set(workerId, new Date());

    // Update the latest crash log entry
    const logs = this.crashLogs.get(workerId) || [];
    const latestCrash = logs[logs.length - 1];
    if (latestCrash && !latestCrash.recoveredAt) {
      latestCrash.recoveredAt = new Date();
      latestCrash.autoRecovery = true;
    }

    const worker = this.workers.get(workerId);
    this.emitFeed('system_health', `Worker RECOVERED: ${worker?.name || workerId}`, {
      metadata: { workerId },
    });

    console.log(`[WORKER-POOL] Worker recovered: ${workerId}`);
  }

  /** Get recovery log for a worker */
  getRecoveryLog(workerId: string): CrashLogEntry[] {
    return this.crashLogs.get(workerId) || [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-057: Worker Config
  // ═══════════════════════════════════════════════════════════════════════════

  /** Set per-worker LLM config */
  setConfig(workerId: string, config: Partial<WorkerConfig>): void {
    const existing = this.workerConfigs.get(workerId) || this.getDefaultConfig(
      this.workers.get(workerId)?.role || 'polecat',
    );
    this.workerConfigs.set(workerId, { ...existing, ...config });
    console.log(`[WORKER-POOL] Config updated for worker: ${workerId}`);
  }

  /** Get per-worker LLM config (falls back to role default) */
  getConfig(workerId: string): WorkerConfig {
    const custom = this.workerConfigs.get(workerId);
    if (custom) return custom;

    const worker = this.workers.get(workerId);
    return this.getDefaultConfig(worker?.role || 'polecat');
  }

  /** Get default config for a role */
  getDefaultConfig(role: WorkerRole): WorkerConfig {
    return { ...DEFAULT_CONFIGS[role] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-058: Worker Templates
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register a template for a role */
  registerTemplate(role: WorkerRole, template: WorkerTemplate): void {
    this.templates.set(role, template);
    console.log(`[WORKER-POOL] Template registered for role: ${role}`);
  }

  /** Get the template for a role */
  getTemplate(role: WorkerRole): WorkerTemplate | undefined {
    return this.templates.get(role);
  }

  /** Spawn a new worker from a role template */
  spawnFromTemplate(role: WorkerRole, overrides?: Partial<WorkerTemplate>): WorkerIdentity {
    if (!this.canSpawn(role)) {
      throw new Error(`Cannot spawn ${role}: pool or role limit reached`);
    }

    const template = this.templates.get(role);
    const defaults = DEFAULT_CONFIGS[role];

    const model = overrides?.model || template?.model || defaults.model;
    const tier = overrides?.tier || template?.tier || defaults.tier;
    const capabilities = overrides?.capabilities || template?.capabilities || [];
    const systemPrompt = overrides?.systemPrompt || template?.systemPrompt;

    const id = `wk-${role}-${uuidv4().slice(0, 8)}`;
    const identity: WorkerIdentity = {
      id,
      role,
      name: `${role}-${id.slice(-8)}`,
      tier,
      model,
      capabilities,
      tasksCompleted: 0,
      lastActiveAt: new Date(),
    };

    this.registerWorker(identity);

    // Apply config including system prompt
    if (systemPrompt) {
      this.setConfig(id, { model, tier, maxTokens: defaults.maxTokens, temperature: defaults.temperature, systemPrompt });
    }

    console.log(`[WORKER-POOL] Spawned from template: ${id} (${role}/${model}/${tier})`);

    // Attempt to drain queue after spawning
    this.drainQueue();

    return identity;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility
  // ═══════════════════════════════════════════════════════════════════════════

  /** Remove a worker from the pool entirely */
  removeWorker(id: string): boolean {
    const worker = this.workers.get(id);
    if (!worker) return false;

    this.workers.delete(id);
    this.heartbeats.delete(id);
    this.rigBindings.delete(id);
    this.crashedWorkers.delete(id);
    // Keep CV, cost, crash logs for history

    console.log(`[WORKER-POOL] Worker removed: ${id}`);

    // Try to drain queue since capacity freed
    this.drainQueue();

    return true;
  }

  /** Full pool overview */
  overview() {
    const workers = Array.from(this.workers.values());
    const byRole: Record<string, number> = {};
    const byStatus: Record<AliveStatus, number> = { alive: 0, stale: 0, dead: 0 };

    for (const w of workers) {
      byRole[w.role] = (byRole[w.role] || 0) + 1;
      byStatus[this.checkAlive(w.id)]++;
    }

    return {
      totalWorkers: workers.length,
      poolCapacity: this.poolConfig.maxWorkers,
      byRole,
      byStatus,
      queuedSpawns: this.spawnQueue.length,
      crashedCount: this.crashedWorkers.size,
      totalCost: this.getCostReport().reduce((sum, r) => sum + r.totalCost, 0),
      totalTokens: this.getCostReport().reduce((sum, r) => sum + r.totalTokens, 0),
      templates: Array.from(this.templates.keys()),
    };
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'worker-pool',
      message,
      severity: type === 'worker_error' ? 'error' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton WorkerPool instance */
export const workerPool = new WorkerPool();
