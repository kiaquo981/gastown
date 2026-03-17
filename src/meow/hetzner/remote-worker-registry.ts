/**
 * HETZNER — Remote Worker Registry
 *
 * Registry of remote Docker containers running Claude Code on Hetzner.
 * Each container is a Gas Town "remote worker" accessible via SSH on
 * unique ports. The registry tracks status, heartbeats, and capabilities.
 *
 * Gas Town: "The rigs in the wasteland — always listening, always ready."
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const execFileAsync = promisify(execFile);
const log = createLogger('hetzner:registry');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerRole = 'polecat' | 'crew' | 'dog';
export type WorkerStatus = 'online' | 'offline' | 'busy' | 'error';

export interface WorkerMetrics {
  tokensUsed: number;
  costUsd: number;
  tasksCompleted: number;
  uptime: number;
}

export interface RemoteWorker {
  id: string;
  hostname: string;
  host: string;
  port: number;
  user: string;
  role: WorkerRole;
  status: WorkerStatus;
  currentBead?: string;
  lastHeartbeat?: Date;
  capabilities: string[];
  metrics: WorkerMetrics;
}

export interface RegisterWorkerConfig {
  hostname: string;
  host: string;
  port: number;
  user?: string;
  role?: WorkerRole;
  capabilities?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory registry
// ─────────────────────────────────────────────────────────────────────────────

const workers = new Map<string, RemoteWorker>();

// ─────────────────────────────────────────────────────────────────────────────
// Default FrankFlow Team Containers
// ─────────────────────────────────────────────────────────────────────────────

const HETZNER_HOST = process.env.HETZNER_HOST || '0.0.0.0';

const DEFAULT_WORKERS: RegisterWorkerConfig[] = [
  { hostname: 'kaique-dev', host: HETZNER_HOST, port: 2224, role: 'polecat' },
  { hostname: 'gobbi-dev',  host: HETZNER_HOST, port: 2225, role: 'crew' },
  { hostname: 'lara-dev',   host: HETZNER_HOST, port: 2226, role: 'crew' },
  { hostname: 'hugo-dev',   host: HETZNER_HOST, port: 2227, role: 'crew' },
  { hostname: 'heitor-dev', host: HETZNER_HOST, port: 2228, role: 'crew' },
  { hostname: 'mariza-dev', host: HETZNER_HOST, port: 2229, role: 'crew' },
  { hostname: 'queila-dev', host: HETZNER_HOST, port: 2230, role: 'dog' },
];

const DEFAULT_CAPABILITIES = ['claude-code', 'beads', 'gh', 'node', 'python'];

// ─────────────────────────────────────────────────────────────────────────────
// SSH heartbeat timeout (ms)
// ─────────────────────────────────────────────────────────────────────────────

const SSH_TIMEOUT = parseInt(process.env.HETZNER_SSH_TIMEOUT || '5000', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a new remote worker.
 */
export function registerWorker(config: RegisterWorkerConfig): RemoteWorker {
  const id = `rw-${config.hostname}-${uuidv4().slice(0, 8)}`;
  const worker: RemoteWorker = {
    id,
    hostname: config.hostname,
    host: config.host,
    port: config.port,
    user: config.user || 'dev',
    role: config.role || 'crew',
    status: 'offline',
    capabilities: config.capabilities || [...DEFAULT_CAPABILITIES],
    metrics: { tokensUsed: 0, costUsd: 0, tasksCompleted: 0, uptime: 0 },
  };

  workers.set(id, worker);
  log.info({ workerId: id, hostname: config.hostname, port: config.port }, 'Worker registered');
  broadcast('hetzner:worker:registered', { id, hostname: config.hostname });
  return worker;
}

/**
 * Remove a worker from the registry.
 */
export function removeWorker(id: string): boolean {
  const worker = workers.get(id);
  if (!worker) return false;

  workers.delete(id);
  log.info({ workerId: id, hostname: worker.hostname }, 'Worker removed');
  broadcast('hetzner:worker:removed', { id, hostname: worker.hostname });
  return true;
}

/**
 * List all registered workers.
 */
export function listWorkers(): RemoteWorker[] {
  return Array.from(workers.values());
}

/**
 * Get a specific worker by ID.
 */
export function getWorker(id: string): RemoteWorker | undefined {
  return workers.get(id);
}

/**
 * Find a worker by hostname.
 */
export function getWorkerByHostname(hostname: string): RemoteWorker | undefined {
  return Array.from(workers.values()).find(w => w.hostname === hostname);
}

/**
 * Check if a single worker is reachable via SSH.
 * Updates the worker status based on the result.
 */
export async function heartbeatWorker(id: string): Promise<boolean> {
  const worker = workers.get(id);
  if (!worker) {
    log.warn({ workerId: id }, 'Heartbeat: worker not found');
    return false;
  }

  try {
    await execFileAsync('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.ceil(SSH_TIMEOUT / 1000)}`,
      '-p', String(worker.port),
      `${worker.user}@${worker.host}`,
      'echo ok',
    ], { timeout: SSH_TIMEOUT + 2000 });

    const wasOffline = worker.status === 'offline' || worker.status === 'error';
    if (worker.status !== 'busy') {
      worker.status = 'online';
    }
    worker.lastHeartbeat = new Date();

    if (wasOffline) {
      log.info({ workerId: id, hostname: worker.hostname }, 'Worker came online');
      broadcast('hetzner:worker:online', { id, hostname: worker.hostname });
    }

    return true;
  } catch (err) {
    const prevStatus = worker.status;
    worker.status = 'error';
    worker.lastHeartbeat = new Date();

    if (prevStatus !== 'error') {
      log.warn({ workerId: id, hostname: worker.hostname, err }, 'Worker unreachable');
      broadcast('hetzner:worker:error', { id, hostname: worker.hostname });
    }

    return false;
  }
}

/**
 * Check all registered workers for reachability.
 */
export async function heartbeatAll(): Promise<{ online: number; offline: number; total: number }> {
  log.info({ count: workers.size }, 'Running heartbeat on all workers');

  const results = await Promise.allSettled(
    Array.from(workers.keys()).map(id => heartbeatWorker(id)),
  );

  const online = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const offline = results.length - online;

  log.info({ online, offline, total: results.length }, 'Heartbeat complete');
  broadcast('hetzner:heartbeat', { online, offline, total: results.length });

  return { online, offline, total: results.length };
}

/**
 * Get all workers with online status.
 */
export function getOnlineWorkers(): RemoteWorker[] {
  return Array.from(workers.values()).filter(w => w.status === 'online');
}

/**
 * Get the next available worker (online and not busy).
 * Optionally filter by role.
 */
export function getAvailableWorker(role?: WorkerRole): RemoteWorker | undefined {
  const candidates = Array.from(workers.values()).filter(w => {
    if (w.status !== 'online') return false;
    if (role && w.role !== role) return false;
    return true;
  });

  if (candidates.length === 0) return undefined;

  // Prefer the worker with fewest completed tasks (load balance)
  candidates.sort((a, b) => a.metrics.tasksCompleted - b.metrics.tasksCompleted);
  return candidates[0];
}

/**
 * Mark a worker as busy with a specific bead.
 */
export function markWorkerBusy(id: string, beadId?: string): boolean {
  const worker = workers.get(id);
  if (!worker) return false;

  worker.status = 'busy';
  worker.currentBead = beadId;
  broadcast('hetzner:worker:busy', { id, hostname: worker.hostname, beadId });
  return true;
}

/**
 * Mark a worker as available (online, no current bead).
 */
export function markWorkerAvailable(id: string): boolean {
  const worker = workers.get(id);
  if (!worker) return false;

  worker.status = 'online';
  worker.currentBead = undefined;
  broadcast('hetzner:worker:available', { id, hostname: worker.hostname });
  return true;
}

/**
 * Update worker metrics (tokens, cost, tasks).
 */
export function updateWorkerMetrics(
  id: string,
  update: Partial<WorkerMetrics>,
): boolean {
  const worker = workers.get(id);
  if (!worker) return false;

  if (update.tokensUsed !== undefined) worker.metrics.tokensUsed += update.tokensUsed;
  if (update.costUsd !== undefined) worker.metrics.costUsd += update.costUsd;
  if (update.tasksCompleted !== undefined) worker.metrics.tasksCompleted += update.tasksCompleted;
  if (update.uptime !== undefined) worker.metrics.uptime = update.uptime;

  return true;
}

/**
 * Get aggregate stats across all workers.
 */
export function getAggregateStats(): {
  total: number;
  online: number;
  busy: number;
  offline: number;
  error: number;
  totalTokens: number;
  totalCost: number;
  totalTasks: number;
} {
  const all = Array.from(workers.values());
  return {
    total: all.length,
    online: all.filter(w => w.status === 'online').length,
    busy: all.filter(w => w.status === 'busy').length,
    offline: all.filter(w => w.status === 'offline').length,
    error: all.filter(w => w.status === 'error').length,
    totalTokens: all.reduce((sum, w) => sum + w.metrics.tokensUsed, 0),
    totalCost: all.reduce((sum, w) => sum + w.metrics.costUsd, 0),
    totalTasks: all.reduce((sum, w) => sum + w.metrics.tasksCompleted, 0),
  };
}

/**
 * Load the default FrankFlow team containers as workers.
 * Skips any that are already registered (by hostname).
 */
export function loadDefaultWorkers(): RemoteWorker[] {
  const registered: RemoteWorker[] = [];

  for (const config of DEFAULT_WORKERS) {
    const existing = getWorkerByHostname(config.hostname);
    if (existing) {
      log.debug({ hostname: config.hostname }, 'Default worker already registered, skipping');
      registered.push(existing);
      continue;
    }

    const worker = registerWorker(config);
    registered.push(worker);
  }

  log.info({ count: registered.length }, 'Default workers loaded');
  return registered;
}

/**
 * Clear all workers from the registry.
 */
export function clearWorkers(): void {
  workers.clear();
  log.info('All workers cleared from registry');
}

/**
 * Get the internal workers Map (for testing).
 */
export function _getWorkersMap(): Map<string, RemoteWorker> {
  return workers;
}
