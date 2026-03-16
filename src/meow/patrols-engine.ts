/**
 * PATROLS ENGINE — Automated Health Check Loops (EP-092 → EP-100)
 *
 * Gas Town: "The Deacon never sleeps. The Witness never blinks. The Refinery never stops."
 *
 * Implements:
 * - EP-092: Deacon Patrol (26 checks — dogs, workers, molecules, queues, memory, mail, convoys, wisps, hooks, budget, errors, uptime)
 * - EP-093: Witness Patrol (10 checks — polecat supervision, assignments, skills, gates, escalations, heartbeats)
 * - EP-094: Refinery Patrol (9 checks — queue depth, gate failures, conflicts, locks, stale items, merge rate, rebase, blocked, throughput)
 * - EP-095: Boot Watchdog — already implemented (skip)
 * - EP-096: Patrol Scheduling — schedule/unschedule with default intervals
 * - EP-097: Patrol Reports — store and query last 100 reports per patrol
 * - EP-098: Patrol Backoff — exponential backoff when all checks pass, reset on failure
 * - EP-099: Patrol Fan-Out — parallel execution of all active patrols
 * - EP-100: Patrol Dashboard Data — aggregated dashboard view
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../sse';
import { createLogger } from '../lib/logger';
import type { FeedEvent, FeedEventType, PatrolOwner } from './types';

const log = createLogger('patrol-engine');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PatrolSeverity = 'info' | 'warning' | 'critical';

export interface PatrolCheck {
  name: string;
  passed: boolean;
  details?: string;
  severity: PatrolSeverity;
}

export interface PatrolReport {
  id: string;
  patrolName: string;
  owner: PatrolOwner;
  timestamp: Date;
  checks: PatrolCheck[];
  passRate: number;
  duration: number;
  summary?: string;
}

export interface PatrolSchedule {
  patrolName: string;
  baseIntervalMs: number;
  currentIntervalMs: number;
  backoffMultiplier: number;
  timer: ReturnType<typeof setInterval> | null;
  active: boolean;
  consecutiveCleanRuns: number;
}

export interface PatrolDashboardEntry {
  name: string;
  lastRun: Date | null;
  passRate: number;
  status: 'idle' | 'running' | 'healthy' | 'degraded' | 'critical';
  interval: number;
}

export interface PatrolDashboard {
  patrols: PatrolDashboardEntry[];
  recentReports: PatrolReport[];
  overallHealth: 'healthy' | 'degraded' | 'critical';
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory simulated state for best-effort health checks
// ─────────────────────────────────────────────────────────────────────────────

interface SimulatedState {
  dogs: { name: string; status: 'running' | 'stopped' | 'error'; lastRun: Date }[];
  workers: { id: string; role: string; healthy: boolean; load: number; lastHeartbeat: Date }[];
  molecules: { id: string; status: string; stepsTotal: number; stepsCompleted: number; phase: string }[];
  polecats: { id: string; status: string; assignedBead: string | null; startedAt: Date }[];
  guppQueue: { id: string; priority: string; age: number }[];
  mailBacklog: { from: string; to: string; read: boolean; age: number }[];
  convoys: { id: string; status: string; progress: number }[];
  wisps: { id: string; expiresAt: Date }[];
  hooks: { name: string; lastRun: Date; enabled: boolean }[];
  refineryQueue: { id: string; status: string; lockedSince: Date | null; conflicted: boolean }[];
  escalationQueue: { id: string; priority: string; age: number }[];
  skills: { name: string; available: boolean }[];
  gates: { id: string; status: string; pending: boolean }[];
  startedAt: Date;
  budgetUsedPct: number;
  errorRatePerMin: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
}

function buildSimulatedState(): SimulatedState {
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  return {
    dogs: [
      { name: 'compactor', status: 'running', lastRun: minutesAgo(2) },
      { name: 'doctor', status: 'running', lastRun: minutesAgo(5) },
      { name: 'janitor', status: 'running', lastRun: minutesAgo(1) },
      { name: 'wisp_reaper', status: 'running', lastRun: minutesAgo(3) },
    ],
    workers: [
      { id: 'w-mayor-01', role: 'mayor', healthy: true, load: 0.3, lastHeartbeat: minutesAgo(0) },
      { id: 'w-deacon-01', role: 'deacon', healthy: true, load: 0.1, lastHeartbeat: minutesAgo(0) },
      { id: 'w-witness-01', role: 'witness', healthy: true, load: 0.2, lastHeartbeat: minutesAgo(1) },
      { id: 'w-refinery-01', role: 'refinery', healthy: true, load: 0.4, lastHeartbeat: minutesAgo(0) },
    ],
    molecules: [
      { id: 'mol-a1b2c3d4', status: 'running', stepsTotal: 7, stepsCompleted: 4, phase: 'liquid' },
      { id: 'mol-e5f6g7h8', status: 'completed', stepsTotal: 3, stepsCompleted: 3, phase: 'liquid' },
    ],
    polecats: [
      { id: 'pc-001', status: 'working', assignedBead: 'bd-aa11', startedAt: minutesAgo(12) },
      { id: 'pc-002', status: 'idle', assignedBead: null, startedAt: minutesAgo(45) },
    ],
    guppQueue: [
      { id: 'gq-01', priority: 'high', age: 120 },
      { id: 'gq-02', priority: 'medium', age: 300 },
    ],
    mailBacklog: [
      { from: 'w-mayor-01', to: 'w-deacon-01', read: true, age: 60 },
      { from: 'w-witness-01', to: 'w-mayor-01', read: false, age: 180 },
    ],
    convoys: [
      { id: 'cvy-001', status: 'in_progress', progress: 65 },
    ],
    wisps: [
      { id: 'wsp-001', expiresAt: new Date(now.getTime() + 30 * 60_000) },
    ],
    hooks: [
      { name: 'pre-commit', lastRun: minutesAgo(8), enabled: true },
      { name: 'loop-guard', lastRun: minutesAgo(2), enabled: true },
      { name: 'smart-router', lastRun: minutesAgo(15), enabled: true },
    ],
    refineryQueue: [
      { id: 'rq-01', status: 'pending', lockedSince: null, conflicted: false },
      { id: 'rq-02', status: 'merging', lockedSince: minutesAgo(1), conflicted: false },
    ],
    escalationQueue: [],
    skills: [
      { name: 'code-review', available: true },
      { name: 'testing', available: true },
      { name: 'deploy', available: true },
    ],
    gates: [
      { id: 'gate-01', status: 'approved', pending: false },
    ],
    startedAt: new Date(now.getTime() - 24 * 60 * 60_000),
    budgetUsedPct: 0.42,
    errorRatePerMin: 0.1,
    memoryUsedMb: 256,
    memoryLimitMb: 512,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REPORTS_PER_PATROL = 100;
const MAX_BACKOFF_MULTIPLIER = 4;

const DEFAULT_INTERVALS: Record<string, number> = {
  deacon: 600_000,    // 10 minutes
  witness: 300_000,   // 5 minutes
  refinery: 120_000,  // 2 minutes
};

// ─────────────────────────────────────────────────────────────────────────────
// PatrolEngine
// ─────────────────────────────────────────────────────────────────────────────

export class PatrolEngine {
  private reports: Map<string, PatrolReport[]> = new Map();
  private schedules: Map<string, PatrolSchedule> = new Map();
  private state: SimulatedState;
  private running: Set<string> = new Set();

  constructor() {
    this.state = buildSimulatedState();

    // Initialize default schedules (not started)
    for (const [name, interval] of Object.entries(DEFAULT_INTERVALS)) {
      this.schedules.set(name, {
        patrolName: name,
        baseIntervalMs: interval,
        currentIntervalMs: interval,
        backoffMultiplier: 1,
        timer: null,
        active: false,
        consecutiveCleanRuns: 0,
      });
    }

    log.info('[PATROL] PatrolEngine initialized — 3 patrol types registered');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-092: Deacon Patrol (26 checks)
  // ─────────────────────────────────────────────────────────────────────────

  async runDeaconPatrol(): Promise<PatrolReport> {
    const t0 = Date.now();
    log.info('[PATROL] Running Deacon patrol (26 checks)');
    this.running.add('deacon');

    // Refresh simulated state
    this.state = buildSimulatedState();
    const checks: PatrolCheck[] = [];

    // ── dog-status (4 checks) ──
    for (const dog of this.state.dogs) {
      checks.push({
        name: `dog-status:${dog.name}`,
        passed: dog.status === 'running',
        details: dog.status === 'running'
          ? `${dog.name} running, last active ${this.timeAgo(dog.lastRun)}`
          : `${dog.name} is ${dog.status}`,
        severity: dog.status === 'error' ? 'critical' : dog.status === 'stopped' ? 'warning' : 'info',
      });
    }

    // ── worker-health (4 checks) ──
    for (const worker of this.state.workers) {
      checks.push({
        name: `worker-health:${worker.id}`,
        passed: worker.healthy,
        details: worker.healthy
          ? `${worker.role} load=${(worker.load * 100).toFixed(0)}%, heartbeat ${this.timeAgo(worker.lastHeartbeat)}`
          : `${worker.role} unhealthy`,
        severity: worker.healthy ? 'info' : 'critical',
      });
    }

    // ── molecule-status (4 checks: running count, completed count, failed check, stale check) ──
    const runningMols = this.state.molecules.filter(m => m.status === 'running');
    const completedMols = this.state.molecules.filter(m => m.status === 'completed');
    const failedMols = this.state.molecules.filter(m => m.status === 'failed');
    const staleMols = runningMols.filter(m => m.stepsCompleted === 0);

    checks.push({
      name: 'molecule-status:running',
      passed: true,
      details: `${runningMols.length} molecule(s) currently running`,
      severity: 'info',
    });
    checks.push({
      name: 'molecule-status:completed',
      passed: true,
      details: `${completedMols.length} molecule(s) completed`,
      severity: 'info',
    });
    checks.push({
      name: 'molecule-status:failed',
      passed: failedMols.length === 0,
      details: failedMols.length === 0 ? 'No failed molecules' : `${failedMols.length} molecule(s) in failed state`,
      severity: failedMols.length > 0 ? 'warning' : 'info',
    });
    checks.push({
      name: 'molecule-status:stale',
      passed: staleMols.length === 0,
      details: staleMols.length === 0 ? 'No stale molecules' : `${staleMols.length} molecule(s) with zero progress`,
      severity: staleMols.length > 0 ? 'warning' : 'info',
    });

    // ── gupp-queue (3 checks: depth, age, priority distribution) ──
    const queueDepth = this.state.guppQueue.length;
    const maxAge = this.state.guppQueue.reduce((max, g) => Math.max(max, g.age), 0);
    const highPriCount = this.state.guppQueue.filter(g => g.priority === 'high' || g.priority === 'critical').length;

    checks.push({
      name: 'gupp-queue:depth',
      passed: queueDepth < 50,
      details: `Queue depth: ${queueDepth} items`,
      severity: queueDepth >= 100 ? 'critical' : queueDepth >= 50 ? 'warning' : 'info',
    });
    checks.push({
      name: 'gupp-queue:max-age',
      passed: maxAge < 3600,
      details: `Oldest item: ${maxAge}s`,
      severity: maxAge >= 3600 ? 'warning' : 'info',
    });
    checks.push({
      name: 'gupp-queue:high-priority',
      passed: highPriCount < 10,
      details: `High/critical priority items: ${highPriCount}`,
      severity: highPriCount >= 10 ? 'warning' : 'info',
    });

    // ── memory-usage (2 checks: heap, ratio) ──
    const memRatio = this.state.memoryUsedMb / this.state.memoryLimitMb;
    checks.push({
      name: 'memory-usage:heap',
      passed: this.state.memoryUsedMb < this.state.memoryLimitMb * 0.9,
      details: `Heap: ${this.state.memoryUsedMb}MB / ${this.state.memoryLimitMb}MB`,
      severity: memRatio >= 0.9 ? 'critical' : memRatio >= 0.7 ? 'warning' : 'info',
    });
    checks.push({
      name: 'memory-usage:ratio',
      passed: memRatio < 0.8,
      details: `Memory utilization: ${(memRatio * 100).toFixed(1)}%`,
      severity: memRatio >= 0.8 ? 'warning' : 'info',
    });

    // ── mail-backlog (2 checks: unread count, oldest unread age) ──
    const unreadMail = this.state.mailBacklog.filter(m => !m.read);
    const oldestUnread = unreadMail.reduce((max, m) => Math.max(max, m.age), 0);

    checks.push({
      name: 'mail-backlog:unread',
      passed: unreadMail.length < 20,
      details: `Unread mail: ${unreadMail.length}`,
      severity: unreadMail.length >= 20 ? 'warning' : 'info',
    });
    checks.push({
      name: 'mail-backlog:oldest',
      passed: oldestUnread < 1800,
      details: `Oldest unread: ${oldestUnread}s`,
      severity: oldestUnread >= 1800 ? 'warning' : 'info',
    });

    // ── convoy-progress (2 checks: active count, stuck convoys) ──
    const activeConvoys = this.state.convoys.filter(c => c.status === 'in_progress');
    const stuckConvoys = activeConvoys.filter(c => c.progress < 10);

    checks.push({
      name: 'convoy-progress:active',
      passed: true,
      details: `Active convoys: ${activeConvoys.length}`,
      severity: 'info',
    });
    checks.push({
      name: 'convoy-progress:stuck',
      passed: stuckConvoys.length === 0,
      details: stuckConvoys.length === 0 ? 'No stuck convoys' : `${stuckConvoys.length} convoy(s) below 10% progress`,
      severity: stuckConvoys.length > 0 ? 'warning' : 'info',
    });

    // ── wisp-expiry (1 check) ──
    const now = new Date();
    const expiringWisps = this.state.wisps.filter(w => w.expiresAt.getTime() - now.getTime() < 5 * 60_000);
    checks.push({
      name: 'wisp-expiry',
      passed: expiringWisps.length === 0,
      details: expiringWisps.length === 0
        ? `${this.state.wisps.length} wisp(s) active, none expiring soon`
        : `${expiringWisps.length} wisp(s) expiring within 5 minutes`,
      severity: expiringWisps.length > 0 ? 'warning' : 'info',
    });

    // ── hook-age (1 check) ──
    const staleHooks = this.state.hooks.filter(h => {
      const age = now.getTime() - h.lastRun.getTime();
      return h.enabled && age > 30 * 60_000;
    });
    checks.push({
      name: 'hook-age',
      passed: staleHooks.length === 0,
      details: staleHooks.length === 0
        ? 'All hooks recently active'
        : `${staleHooks.length} hook(s) not run in 30+ minutes: ${staleHooks.map(h => h.name).join(', ')}`,
      severity: staleHooks.length > 0 ? 'warning' : 'info',
    });

    // ── budget-check (1 check) ──
    checks.push({
      name: 'budget-check',
      passed: this.state.budgetUsedPct < 0.8,
      details: `Budget utilization: ${(this.state.budgetUsedPct * 100).toFixed(1)}%`,
      severity: this.state.budgetUsedPct >= 0.9 ? 'critical' : this.state.budgetUsedPct >= 0.8 ? 'warning' : 'info',
    });

    // ── error-rate (1 check) ──
    checks.push({
      name: 'error-rate',
      passed: this.state.errorRatePerMin < 5,
      details: `Error rate: ${this.state.errorRatePerMin.toFixed(2)}/min`,
      severity: this.state.errorRatePerMin >= 10 ? 'critical' : this.state.errorRatePerMin >= 5 ? 'warning' : 'info',
    });

    // ── uptime (1 check) ──
    const uptimeMs = now.getTime() - this.state.startedAt.getTime();
    const uptimeHours = uptimeMs / (1000 * 60 * 60);
    checks.push({
      name: 'uptime',
      passed: true,
      details: `System uptime: ${uptimeHours.toFixed(1)}h`,
      severity: 'info',
    });

    const report = this.buildReport('deacon', 'deacon', checks, t0);
    this.storeReport(report);
    this.applyBackoff('deacon', report);
    this.running.delete('deacon');

    log.info(
      { passRate: report.passRate, duration: report.duration, checks: checks.length },
      '[PATROL] Deacon patrol complete',
    );

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-093: Witness Patrol (10 checks)
  // ─────────────────────────────────────────────────────────────────────────

  async runWitnessPatrol(): Promise<PatrolReport> {
    const t0 = Date.now();
    log.info('[PATROL] Running Witness patrol (10 checks)');
    this.running.add('witness');

    this.state = buildSimulatedState();
    const checks: PatrolCheck[] = [];
    const now = new Date();

    // ── polecat-status ──
    const polecats = this.state.polecats;
    checks.push({
      name: 'polecat-status',
      passed: polecats.length > 0,
      details: `${polecats.length} polecat(s) tracked: ${polecats.map(p => `${p.id}=${p.status}`).join(', ') || 'none'}`,
      severity: 'info',
    });

    // ── polecat-stalled ──
    const stalledPolecats = polecats.filter(p => {
      const age = now.getTime() - p.startedAt.getTime();
      return p.status === 'working' && age > 30 * 60_000;
    });
    checks.push({
      name: 'polecat-stalled',
      passed: stalledPolecats.length === 0,
      details: stalledPolecats.length === 0
        ? 'No stalled polecats'
        : `${stalledPolecats.length} polecat(s) working for 30+ minutes: ${stalledPolecats.map(p => p.id).join(', ')}`,
      severity: stalledPolecats.length > 0 ? 'warning' : 'info',
    });

    // ── polecat-zombie ──
    const zombiePolecats = polecats.filter(p => p.status === 'zombie' || p.status === 'stalled');
    checks.push({
      name: 'polecat-zombie',
      passed: zombiePolecats.length === 0,
      details: zombiePolecats.length === 0
        ? 'No zombie polecats'
        : `${zombiePolecats.length} zombie/stalled polecat(s): ${zombiePolecats.map(p => p.id).join(', ')}`,
      severity: zombiePolecats.length > 0 ? 'critical' : 'info',
    });

    // ── assignment-balance ──
    const workingPolecats = polecats.filter(p => p.status === 'working');
    const idlePolecats = polecats.filter(p => p.status === 'idle');
    const imbalanced = idlePolecats.length > 0 && this.state.guppQueue.length > 0;
    checks.push({
      name: 'assignment-balance',
      passed: !imbalanced,
      details: imbalanced
        ? `Imbalanced: ${idlePolecats.length} idle polecat(s) but ${this.state.guppQueue.length} items in queue`
        : `Balanced: ${workingPolecats.length} working, ${idlePolecats.length} idle, ${this.state.guppQueue.length} queued`,
      severity: imbalanced ? 'warning' : 'info',
    });

    // ── skill-availability ──
    const unavailableSkills = this.state.skills.filter(s => !s.available);
    checks.push({
      name: 'skill-availability',
      passed: unavailableSkills.length === 0,
      details: unavailableSkills.length === 0
        ? `All ${this.state.skills.length} skill(s) available`
        : `${unavailableSkills.length} skill(s) unavailable: ${unavailableSkills.map(s => s.name).join(', ')}`,
      severity: unavailableSkills.length > 0 ? 'warning' : 'info',
    });

    // ── step-progress ──
    const runningMols = this.state.molecules.filter(m => m.status === 'running');
    const totalProgress = runningMols.reduce((sum, m) => sum + (m.stepsTotal > 0 ? m.stepsCompleted / m.stepsTotal : 0), 0);
    const avgProgress = runningMols.length > 0 ? totalProgress / runningMols.length : 1;
    checks.push({
      name: 'step-progress',
      passed: true,
      details: `Average molecule progress: ${(avgProgress * 100).toFixed(1)}% across ${runningMols.length} running molecule(s)`,
      severity: 'info',
    });

    // ── gate-pending ──
    const pendingGates = this.state.gates.filter(g => g.pending);
    checks.push({
      name: 'gate-pending',
      passed: pendingGates.length < 5,
      details: pendingGates.length === 0
        ? 'No pending gates'
        : `${pendingGates.length} gate(s) awaiting approval`,
      severity: pendingGates.length >= 5 ? 'warning' : 'info',
    });

    // ── escalation-queue ──
    const escalations = this.state.escalationQueue;
    checks.push({
      name: 'escalation-queue',
      passed: escalations.length === 0,
      details: escalations.length === 0
        ? 'Escalation queue empty'
        : `${escalations.length} item(s) in escalation queue`,
      severity: escalations.length > 0 ? 'warning' : 'info',
    });

    // ── worker-load ──
    const overloadedWorkers = this.state.workers.filter(w => w.load > 0.9);
    checks.push({
      name: 'worker-load',
      passed: overloadedWorkers.length === 0,
      details: overloadedWorkers.length === 0
        ? `All workers within load limits (max: ${Math.max(...this.state.workers.map(w => w.load) , 0).toFixed(0)}%)`
        : `${overloadedWorkers.length} worker(s) overloaded (>90%): ${overloadedWorkers.map(w => w.id).join(', ')}`,
      severity: overloadedWorkers.length > 0 ? 'warning' : 'info',
    });

    // ── heartbeat-freshness ──
    const staleWorkers = this.state.workers.filter(w => {
      const age = now.getTime() - w.lastHeartbeat.getTime();
      return age > 5 * 60_000;
    });
    checks.push({
      name: 'heartbeat-freshness',
      passed: staleWorkers.length === 0,
      details: staleWorkers.length === 0
        ? 'All worker heartbeats fresh (<5min)'
        : `${staleWorkers.length} worker(s) with stale heartbeats: ${staleWorkers.map(w => w.id).join(', ')}`,
      severity: staleWorkers.length > 0 ? 'critical' : 'info',
    });

    const report = this.buildReport('witness', 'witness', checks, t0);
    this.storeReport(report);
    this.applyBackoff('witness', report);
    this.running.delete('witness');

    log.info(
      { passRate: report.passRate, duration: report.duration, checks: checks.length },
      '[PATROL] Witness patrol complete',
    );

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-094: Refinery Patrol (9 checks)
  // ─────────────────────────────────────────────────────────────────────────

  async runRefineryPatrol(): Promise<PatrolReport> {
    const t0 = Date.now();
    log.info('[PATROL] Running Refinery patrol (9 checks)');
    this.running.add('refinery');

    this.state = buildSimulatedState();
    const checks: PatrolCheck[] = [];
    const now = new Date();
    const queue = this.state.refineryQueue;

    // ── queue-depth ──
    checks.push({
      name: 'queue-depth',
      passed: queue.length < 20,
      details: `Refinery queue depth: ${queue.length}`,
      severity: queue.length >= 50 ? 'critical' : queue.length >= 20 ? 'warning' : 'info',
    });

    // ── gate-failures ──
    const failedGates = this.state.gates.filter(g => g.status === 'failed');
    checks.push({
      name: 'gate-failures',
      passed: failedGates.length === 0,
      details: failedGates.length === 0
        ? 'No gate failures'
        : `${failedGates.length} gate(s) in failed state`,
      severity: failedGates.length > 0 ? 'warning' : 'info',
    });

    // ── conflict-count ──
    const conflicted = queue.filter(q => q.conflicted);
    checks.push({
      name: 'conflict-count',
      passed: conflicted.length === 0,
      details: conflicted.length === 0
        ? 'No merge conflicts detected'
        : `${conflicted.length} item(s) with merge conflicts`,
      severity: conflicted.length > 0 ? 'warning' : 'info',
    });

    // ── push-lock-duration ──
    const locked = queue.filter(q => q.lockedSince !== null);
    const maxLockMs = locked.reduce((max, q) => {
      const lockAge = q.lockedSince ? now.getTime() - q.lockedSince.getTime() : 0;
      return Math.max(max, lockAge);
    }, 0);
    const maxLockMin = maxLockMs / 60_000;
    checks.push({
      name: 'push-lock-duration',
      passed: maxLockMin < 10,
      details: locked.length === 0
        ? 'No active push locks'
        : `${locked.length} lock(s), longest: ${maxLockMin.toFixed(1)}min`,
      severity: maxLockMin >= 10 ? 'warning' : 'info',
    });

    // ── stale-items ──
    const staleItems = queue.filter(q => q.status === 'pending');
    checks.push({
      name: 'stale-items',
      passed: staleItems.length < 10,
      details: `${staleItems.length} pending/stale item(s) in refinery queue`,
      severity: staleItems.length >= 10 ? 'warning' : 'info',
    });

    // ── merge-rate ──
    const mergingItems = queue.filter(q => q.status === 'merging');
    const mergeRate = queue.length > 0 ? mergingItems.length / queue.length : 1;
    checks.push({
      name: 'merge-rate',
      passed: true,
      details: `Merge throughput: ${mergingItems.length}/${queue.length} items actively merging (${(mergeRate * 100).toFixed(0)}%)`,
      severity: 'info',
    });

    // ── rebase-needed ──
    const rebaseNeeded = queue.filter(q => q.status === 'pending' && !q.conflicted);
    checks.push({
      name: 'rebase-needed',
      passed: rebaseNeeded.length < 5,
      details: rebaseNeeded.length === 0
        ? 'No items need rebase'
        : `${rebaseNeeded.length} item(s) may need rebase before merge`,
      severity: rebaseNeeded.length >= 5 ? 'warning' : 'info',
    });

    // ── blocked-items ──
    const blocked = queue.filter(q => q.conflicted || (q.lockedSince && maxLockMin > 10));
    checks.push({
      name: 'blocked-items',
      passed: blocked.length === 0,
      details: blocked.length === 0
        ? 'No blocked items in refinery'
        : `${blocked.length} item(s) blocked (conflicts or long locks)`,
      severity: blocked.length > 0 ? 'warning' : 'info',
    });

    // ── throughput ──
    const completedRatio = queue.length > 0 ? (queue.length - staleItems.length) / queue.length : 1;
    checks.push({
      name: 'throughput',
      passed: completedRatio >= 0.5 || queue.length === 0,
      details: `Refinery throughput: ${(completedRatio * 100).toFixed(0)}% non-stale`,
      severity: completedRatio < 0.3 && queue.length > 0 ? 'warning' : 'info',
    });

    const report = this.buildReport('refinery', 'refinery', checks, t0);
    this.storeReport(report);
    this.applyBackoff('refinery', report);
    this.running.delete('refinery');

    log.info(
      { passRate: report.passRate, duration: report.duration, checks: checks.length },
      '[PATROL] Refinery patrol complete',
    );

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-096: Patrol Scheduling
  // ─────────────────────────────────────────────────────────────────────────

  schedulePatrol(patrolName: string, intervalMs?: number): void {
    const existing = this.schedules.get(patrolName);
    const baseInterval = intervalMs || existing?.baseIntervalMs || DEFAULT_INTERVALS[patrolName] || 300_000;

    if (existing?.timer) {
      clearInterval(existing.timer);
    }

    const schedule: PatrolSchedule = {
      patrolName,
      baseIntervalMs: baseInterval,
      currentIntervalMs: baseInterval,
      backoffMultiplier: 1,
      timer: null,
      active: true,
      consecutiveCleanRuns: 0,
    };

    schedule.timer = setInterval(() => {
      this.executePatrolByName(patrolName).catch(err => {
        log.error({ err, patrolName }, '[PATROL] Scheduled patrol execution failed');
      });
    }, schedule.currentIntervalMs);

    this.schedules.set(patrolName, schedule);
    log.info({ patrolName, intervalMs: schedule.currentIntervalMs }, '[PATROL] Patrol scheduled');
  }

  unschedulePatrol(patrolName: string): void {
    const schedule = this.schedules.get(patrolName);
    if (schedule?.timer) {
      clearInterval(schedule.timer);
      schedule.timer = null;
      schedule.active = false;
      log.info({ patrolName }, '[PATROL] Patrol unscheduled');
    }
  }

  listSchedules(): Array<{ patrolName: string; active: boolean; baseIntervalMs: number; currentIntervalMs: number; backoffMultiplier: number }> {
    return Array.from(this.schedules.values()).map(s => ({
      patrolName: s.patrolName,
      active: s.active,
      baseIntervalMs: s.baseIntervalMs,
      currentIntervalMs: s.currentIntervalMs,
      backoffMultiplier: s.backoffMultiplier,
    }));
  }

  startAll(): void {
    for (const name of ['deacon', 'witness', 'refinery']) {
      this.schedulePatrol(name);
    }
    log.info('[PATROL] All patrols started');
  }

  stopAll(): void {
    for (const [name] of this.schedules) {
      this.unschedulePatrol(name);
    }
    log.info('[PATROL] All patrols stopped');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-097: Patrol Reports
  // ─────────────────────────────────────────────────────────────────────────

  getReports(patrolName?: string, limit: number = 50): PatrolReport[] {
    if (patrolName) {
      const reports = this.reports.get(patrolName) || [];
      return reports.slice(0, limit);
    }

    // All reports merged and sorted by timestamp desc
    const all: PatrolReport[] = [];
    for (const reports of this.reports.values()) {
      all.push(...reports);
    }
    all.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return all.slice(0, limit);
  }

  getLatestReport(patrolName: string): PatrolReport | null {
    const reports = this.reports.get(patrolName);
    if (!reports || reports.length === 0) return null;
    return reports[0];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-099: Patrol Fan-Out
  // ─────────────────────────────────────────────────────────────────────────

  async runAllPatrols(): Promise<PatrolReport[]> {
    log.info('[PATROL] Fan-out: running all patrols in parallel');
    const t0 = Date.now();

    const results = await Promise.all([
      this.runDeaconPatrol(),
      this.runWitnessPatrol(),
      this.runRefineryPatrol(),
    ]);

    const totalDuration = Date.now() - t0;
    log.info(
      { totalDuration, patrols: results.length, avgPassRate: (results.reduce((s, r) => s + r.passRate, 0) / results.length).toFixed(1) },
      '[PATROL] Fan-out complete',
    );

    this.emitFeed('patrol_completed', `All patrols complete in ${totalDuration}ms — ${results.map(r => `${r.patrolName}:${r.passRate.toFixed(0)}%`).join(', ')}`, {
      metadata: { reports: results.map(r => ({ name: r.patrolName, passRate: r.passRate })) },
    });

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EP-100: Patrol Dashboard Data
  // ─────────────────────────────────────────────────────────────────────────

  getDashboard(): PatrolDashboard {
    const patrols: PatrolDashboardEntry[] = [];

    for (const name of ['deacon', 'witness', 'refinery']) {
      const schedule = this.schedules.get(name);
      const latest = this.getLatestReport(name);
      const isRunning = this.running.has(name);

      let status: PatrolDashboardEntry['status'] = 'idle';
      if (isRunning) {
        status = 'running';
      } else if (latest) {
        if (latest.passRate >= 90) status = 'healthy';
        else if (latest.passRate >= 60) status = 'degraded';
        else status = 'critical';
      }

      patrols.push({
        name,
        lastRun: latest?.timestamp || null,
        passRate: latest?.passRate || 0,
        status,
        interval: schedule?.currentIntervalMs || DEFAULT_INTERVALS[name] || 0,
      });
    }

    const recentReports = this.getReports(undefined, 20);

    // Overall health: worst patrol status wins
    let overallHealth: PatrolDashboard['overallHealth'] = 'healthy';
    for (const p of patrols) {
      if (p.status === 'critical') {
        overallHealth = 'critical';
        break;
      }
      if (p.status === 'degraded') {
        overallHealth = 'degraded';
      }
    }

    return { patrols, recentReports, overallHealth };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private buildReport(patrolName: string, owner: PatrolOwner, checks: PatrolCheck[], startTime: number): PatrolReport {
    const passed = checks.filter(c => c.passed).length;
    const total = checks.length;
    const passRate = total > 0 ? (passed / total) * 100 : 100;
    const failed = checks.filter(c => !c.passed);
    const criticals = failed.filter(c => c.severity === 'critical');

    let summary: string | undefined;
    if (failed.length > 0) {
      const failNames = failed.map(c => c.name).join(', ');
      summary = `${failed.length} check(s) failed: ${failNames}`;
      if (criticals.length > 0) {
        summary += ` [${criticals.length} CRITICAL]`;
      }
    } else {
      summary = 'All checks passed';
    }

    return {
      id: `pr-${uuidv4().slice(0, 8)}`,
      patrolName,
      owner: owner as PatrolOwner,
      timestamp: new Date(),
      checks,
      passRate: Math.round(passRate * 100) / 100,
      duration: Date.now() - startTime,
      summary,
    };
  }

  private storeReport(report: PatrolReport): void {
    if (!this.reports.has(report.patrolName)) {
      this.reports.set(report.patrolName, []);
    }
    const reports = this.reports.get(report.patrolName)!;
    reports.unshift(report);

    // EP-097: cap at 100 per patrol
    if (reports.length > MAX_REPORTS_PER_PATROL) {
      reports.length = MAX_REPORTS_PER_PATROL;
    }
  }

  // EP-098: Exponential backoff
  private applyBackoff(patrolName: string, report: PatrolReport): void {
    const schedule = this.schedules.get(patrolName);
    if (!schedule || !schedule.active) return;

    const allPassed = report.passRate === 100;

    if (allPassed) {
      schedule.consecutiveCleanRuns++;

      // Double interval up to 4x max when everything is clean
      if (schedule.consecutiveCleanRuns >= 3) {
        const newMultiplier = Math.min(schedule.backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
        if (newMultiplier !== schedule.backoffMultiplier) {
          schedule.backoffMultiplier = newMultiplier;
          schedule.currentIntervalMs = schedule.baseIntervalMs * schedule.backoffMultiplier;
          this.rescheduleTimer(schedule);
          log.info(
            { patrolName, multiplier: schedule.backoffMultiplier, intervalMs: schedule.currentIntervalMs },
            '[PATROL] Backoff increased — all clean',
          );
        }
      }
    } else {
      // Reset to base on any failure
      if (schedule.backoffMultiplier !== 1 || schedule.consecutiveCleanRuns > 0) {
        schedule.consecutiveCleanRuns = 0;
        schedule.backoffMultiplier = 1;
        schedule.currentIntervalMs = schedule.baseIntervalMs;
        this.rescheduleTimer(schedule);
        log.info(
          { patrolName, intervalMs: schedule.currentIntervalMs },
          '[PATROL] Backoff reset — failures detected',
        );
      }
    }
  }

  private rescheduleTimer(schedule: PatrolSchedule): void {
    if (schedule.timer) {
      clearInterval(schedule.timer);
    }
    schedule.timer = setInterval(() => {
      this.executePatrolByName(schedule.patrolName).catch(err => {
        log.error({ err, patrolName: schedule.patrolName }, '[PATROL] Scheduled patrol execution failed');
      });
    }, schedule.currentIntervalMs);
  }

  private async executePatrolByName(patrolName: string): Promise<PatrolReport> {
    switch (patrolName) {
      case 'deacon':
        return this.runDeaconPatrol();
      case 'witness':
        return this.runWitnessPatrol();
      case 'refinery':
        return this.runRefineryPatrol();
      default:
        throw new Error(`Unknown patrol: ${patrolName}`);
    }
  }

  private timeAgo(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s ago`;
    if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}min ago`;
    return `${(diffMs / 3_600_000).toFixed(1)}h ago`;
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'patrol-engine',
      message,
      severity: 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const patrolEngine = new PatrolEngine();
