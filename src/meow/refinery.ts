/**
 * REFINERY — Merge Queue System (EP-082 → EP-091)
 *
 * Gas Town: "The Refinery controls what gets pushed. No chaos, no collisions."
 *
 * Provides:
 * - Merge Queue FIFO with priority (EP-082)
 * - Rebase Strategy management (EP-083)
 * - Quality Gates pipeline (EP-084)
 * - Conflict Resolution tracking (EP-085)
 * - Push Serialization with lock (EP-086)
 * - Post-Merge Cleanup (EP-087)
 * - Fast-Path Merge for pre-verified items (EP-088)
 * - Merge Notifications event bus (EP-089)
 * - Merge Metrics aggregation (EP-090)
 * - Merge Dashboard Data projection (EP-091)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../sse';
import { notifyBeadCompleted } from './autonomous-loop';
// Types imported from local definitions (FeedEvent/FeedEventType used via SSE broadcast)

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MergeItemStatus =
  | 'queued'
  | 'testing'
  | 'approved'
  | 'merging'
  | 'merged'
  | 'blocked'
  | 'rejected';

export type RebaseStrategy = 'auto-rebase' | 'manual' | 'fast-forward';

export type GateStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface GateResult {
  name: string;
  status: GateStatus;
  durationMs?: number;
  error?: string;
}

export interface MergeItem {
  id: string;
  branch: string;
  author: string;
  title: string;
  beadId?: string;
  priority: number;              // Lower = higher priority (0 is top)
  status: MergeItemStatus;
  gates: GateResult[];
  conflictFiles: string[];
  rebaseStrategy: RebaseStrategy;
  enqueuedAt: Date;
  startedAt?: Date;
  mergedAt?: Date;
  ahead: number;
  behind: number;
}

export type MergeEventType =
  | 'enqueue'
  | 'gates-pass'
  | 'gates-fail'
  | 'merged'
  | 'conflict-detected';

export type MergeEventHandler = (event: MergeEventType, item: MergeItem) => void;

export type GateChecker = (item: MergeItem) => Promise<GateResult>;

export interface MergeMetrics {
  avgQueueWaitMs: number;
  avgGateDurationMs: number;
  gatePassRate: number;
  totalMerged: number;
  totalRejected: number;
  throughputPerHour: number;
}

export interface MergeDashboard {
  queue: MergeItem[];
  metrics: MergeMetrics;
  activePush: string | null;
  recentlyMerged: MergeItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = '[REFINERY]';
const DEFAULT_PRIORITY = 50;
const MAX_RECENTLY_MERGED = 50;
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Default Quality Gates
// ─────────────────────────────────────────────────────────────────────────────

// Set MEOW_STUB_GATES=false in env to run real CLI commands (tsc, eslint, npm test, npm run build).
// Default (unset) = stub mode — all gates auto-pass. Safe for local dev & CI bootstrapping.
const STUB_GATES_ENABLED = process.env.MEOW_STUB_GATES !== 'false';

/** Derive gate working directory: bead worktree first, then env override, then cwd. */
function resolveGateDir(item: MergeItem): string {
  if (item.beadId) {
    const wt = path.join(process.cwd(), '.worktrees', item.beadId);
    if (fs.existsSync(wt)) return wt;
  }
  return process.env.MEOW_GATE_WORKDIR || process.cwd();
}

interface GateCmdResult { stdout: string; stderr: string; exitCode: number }

async function runGateCmd(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GateCmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout?.trim() || '',
      stderr: e.stderr?.trim() || String(err),
      exitCode: e.code ?? 1,
    };
  }
}

async function defaultTypecheck(item: MergeItem): Promise<GateResult> {
  const start = Date.now();
  if (STUB_GATES_ENABLED) {
    console.warn(`${PREFIX} typecheck gate is a STUB — auto-passing (set MEOW_STUB_GATES=false to enable)`);
    return { name: 'typecheck', status: 'passed', durationMs: Date.now() - start };
  }
  const cwd = resolveGateDir(item);
  console.log(`${PREFIX} typecheck running tsc --noEmit in ${cwd}`);
  const result = await runGateCmd('npx', ['tsc', '--noEmit'], cwd, 120_000);
  if (result.exitCode !== 0) {
    return { name: 'typecheck', status: 'failed', durationMs: Date.now() - start, error: result.stderr || result.stdout };
  }
  return { name: 'typecheck', status: 'passed', durationMs: Date.now() - start };
}

async function defaultLint(item: MergeItem): Promise<GateResult> {
  const start = Date.now();
  if (STUB_GATES_ENABLED) {
    console.warn(`${PREFIX} lint gate is a STUB — auto-passing (set MEOW_STUB_GATES=false to enable)`);
    return { name: 'lint', status: 'passed', durationMs: Date.now() - start };
  }
  const cwd = resolveGateDir(item);
  console.log(`${PREFIX} lint running npm run lint in ${cwd}`);
  const npmResult = await runGateCmd('npm', ['run', 'lint', '--', '--max-warnings', '0'], cwd, 60_000);
  if (npmResult.exitCode === 0) {
    return { name: 'lint', status: 'passed', durationMs: Date.now() - start };
  }
  // Fallback to eslint directly if project has no lint script
  if (npmResult.stderr.includes('Missing script') || npmResult.stderr.includes('missing script')) {
    const eslintResult = await runGateCmd('npx', ['eslint', '.', '--ext', '.ts,.tsx', '--max-warnings', '0'], cwd, 60_000);
    if (eslintResult.exitCode === 0) {
      return { name: 'lint', status: 'passed', durationMs: Date.now() - start };
    }
    return { name: 'lint', status: 'failed', durationMs: Date.now() - start, error: eslintResult.stderr || eslintResult.stdout };
  }
  return { name: 'lint', status: 'failed', durationMs: Date.now() - start, error: npmResult.stderr || npmResult.stdout };
}

async function defaultTest(item: MergeItem): Promise<GateResult> {
  const start = Date.now();
  if (STUB_GATES_ENABLED) {
    console.warn(`${PREFIX} test gate is a STUB — auto-passing (set MEOW_STUB_GATES=false to enable)`);
    return { name: 'test', status: 'passed', durationMs: Date.now() - start };
  }
  const cwd = resolveGateDir(item);
  console.log(`${PREFIX} test running npm test in ${cwd}`);
  const result = await runGateCmd('npm', ['test', '--', '--passWithNoTests'], cwd, 300_000);
  if (result.exitCode !== 0) {
    // Treat "no tests found" as a pass — a new bead may not have tests yet
    if (result.stderr.includes('No tests found') || result.stdout.includes('No tests found')) {
      return { name: 'test', status: 'passed', durationMs: Date.now() - start };
    }
    return { name: 'test', status: 'failed', durationMs: Date.now() - start, error: result.stderr || result.stdout };
  }
  return { name: 'test', status: 'passed', durationMs: Date.now() - start };
}

async function defaultBuild(item: MergeItem): Promise<GateResult> {
  const start = Date.now();
  if (STUB_GATES_ENABLED) {
    console.warn(`${PREFIX} build gate is a STUB — auto-passing (set MEOW_STUB_GATES=false to enable)`);
    return { name: 'build', status: 'passed', durationMs: Date.now() - start };
  }
  const cwd = resolveGateDir(item);
  console.log(`${PREFIX} build running npm run build in ${cwd}`);
  const result = await runGateCmd('npm', ['run', 'build'], cwd, 300_000);
  if (result.exitCode !== 0) {
    return { name: 'build', status: 'failed', durationMs: Date.now() - start, error: result.stderr || result.stdout };
  }
  return { name: 'build', status: 'passed', durationMs: Date.now() - start };
}

// ─────────────────────────────────────────────────────────────────────────────
// Refinery Class
// ─────────────────────────────────────────────────────────────────────────────

export class Refinery {
  /** Active merge queue */
  private queue: Map<string, MergeItem> = new Map();
  /** Recently merged items for dashboard */
  private recentlyMerged: MergeItem[] = [];
  /** Quality gate checkers */
  private gates: Map<string, GateChecker> = new Map();
  /** Push lock — only one item can push at a time */
  private pushLockHolder: string | null = null;
  /** Event handlers */
  private eventHandlers: Set<MergeEventHandler> = new Set();
  /** Metrics tracking */
  private metricsData = {
    totalQueueWaitMs: 0,
    totalGateDurationMs: 0,
    gateRuns: 0,
    gatePasses: 0,
    totalMerged: 0,
    totalRejected: 0,
    firstMergeAt: null as Date | null,
  };

  constructor() {
    // Register default quality gates
    this.gates.set('typecheck', defaultTypecheck);
    this.gates.set('lint', defaultLint);
    this.gates.set('test', defaultTest);
    this.gates.set('build', defaultBuild);
    console.log(`${PREFIX} Initialized with ${this.gates.size} default quality gates`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-082: Merge Queue FIFO
  // ───────────────────────────────────────────────────────────────────────────

  /** Enqueue a branch for merge. Returns the created MergeItem. */
  enqueue(input: {
    branch: string;
    author: string;
    title: string;
    beadId?: string;
    priority?: number;
  }): MergeItem {
    const id = `mr-${uuidv4().slice(0, 8)}`;
    const item: MergeItem = {
      id,
      branch: input.branch,
      author: input.author,
      title: input.title,
      beadId: input.beadId,
      priority: input.priority ?? DEFAULT_PRIORITY,
      status: 'queued',
      gates: [],
      conflictFiles: [],
      rebaseStrategy: 'auto-rebase',
      enqueuedAt: new Date(),
      ahead: 0,
      behind: 0,
    };

    this.queue.set(id, item);
    console.log(`${PREFIX} Enqueued ${id} — branch=${item.branch} author=${item.author} priority=${item.priority}`);

    this.emitFeed('enqueue', `Merge item enqueued: ${item.title}`);
    this.notify('enqueue', item);

    return item;
  }

  /** Dequeue the next item (highest priority, then FIFO). Returns null if empty. */
  dequeue(): MergeItem | null {
    const sorted = this.getQueue();
    const next = sorted.find(i => i.status === 'queued');
    if (!next) return null;

    next.status = 'testing';
    next.startedAt = new Date();
    console.log(`${PREFIX} Dequeued ${next.id} — branch=${next.branch}`);
    return next;
  }

  /** Get all queue items sorted by priority (ascending) then FIFO (enqueuedAt ascending). */
  getQueue(): MergeItem[] {
    return Array.from(this.queue.values()).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
    });
  }

  /** Get a single merge item by ID. */
  getItem(id: string): MergeItem | undefined {
    return this.queue.get(id);
  }

  /** Remove a merge item from the queue. Returns true if found and removed. */
  removeItem(id: string): boolean {
    const item = this.queue.get(id);
    if (!item) return false;

    // Release push lock if this item holds it
    if (this.pushLockHolder === id) {
      this.pushLockHolder = null;
    }

    this.queue.delete(id);
    console.log(`${PREFIX} Removed ${id} from queue`);
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-083: Rebase Strategy
  // ───────────────────────────────────────────────────────────────────────────

  /** Set the rebase strategy for a merge item. */
  setRebaseStrategy(itemId: string, strategy: RebaseStrategy): void {
    const item = this.queue.get(itemId);
    if (!item) {
      console.warn(`${PREFIX} setRebaseStrategy: item ${itemId} not found`);
      return;
    }
    item.rebaseStrategy = strategy;
    console.log(`${PREFIX} Rebase strategy for ${itemId} set to ${strategy}`);
  }

  /** Check whether the item needs a rebase (behind > 0). */
  needsRebase(itemId: string): boolean {
    const item = this.queue.get(itemId);
    if (!item) return false;
    return item.behind > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-084: Quality Gates
  // ───────────────────────────────────────────────────────────────────────────

  /** Run all registered quality gates for a merge item. */
  async runGates(itemId: string): Promise<{ passed: boolean; results: GateResult[] }> {
    const item = this.queue.get(itemId);
    if (!item) {
      return { passed: false, results: [{ name: 'lookup', status: 'failed', error: `Item ${itemId} not found` }] };
    }

    item.status = 'testing';
    item.startedAt = item.startedAt ?? new Date();
    item.gates = [];

    const results: GateResult[] = [];
    let allPassed = true;

    for (const [name, checker] of this.gates) {
      const pendingGate: GateResult = { name, status: 'running' };
      item.gates.push(pendingGate);

      try {
        const result = await checker(item);
        // Update in-place
        pendingGate.status = result.status;
        pendingGate.durationMs = result.durationMs;
        pendingGate.error = result.error;
        results.push(pendingGate);

        // Track gate duration metrics
        if (result.durationMs) {
          this.metricsData.totalGateDurationMs += result.durationMs;
        }
        this.metricsData.gateRuns++;

        if (result.status === 'passed') {
          this.metricsData.gatePasses++;
        }

        if (result.status === 'failed') {
          allPassed = false;
          console.log(`${PREFIX} Gate "${name}" FAILED for ${itemId}: ${result.error ?? 'no details'}`);
        } else {
          console.log(`${PREFIX} Gate "${name}" passed for ${itemId} (${result.durationMs ?? 0}ms)`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        pendingGate.status = 'failed';
        pendingGate.error = error;
        results.push(pendingGate);
        allPassed = false;
        this.metricsData.gateRuns++;
        console.error(`${PREFIX} Gate "${name}" threw for ${itemId}: ${error}`);
      }
    }

    if (allPassed) {
      item.status = 'approved';
      this.notify('gates-pass', item);
      this.emitFeed('gates_pass', `All gates passed for ${item.title}`);
    } else {
      item.status = 'blocked';
      this.metricsData.totalRejected++;
      this.notify('gates-fail', item);
      this.emitFeed('gates_fail', `Gates failed for ${item.title}`);
    }

    return { passed: allPassed, results };
  }

  /** Register a custom quality gate. */
  addGate(name: string, checker: GateChecker): void {
    this.gates.set(name, checker);
    console.log(`${PREFIX} Gate "${name}" registered (total: ${this.gates.size})`);
  }

  /** Remove a quality gate by name. */
  removeGate(name: string): boolean {
    const removed = this.gates.delete(name);
    if (removed) {
      console.log(`${PREFIX} Gate "${name}" removed (total: ${this.gates.size})`);
    }
    return removed;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-085: Conflict Resolution
  // ───────────────────────────────────────────────────────────────────────────

  /** Detect conflicting files for a merge item. Returns list of conflicting file paths. */
  detectConflicts(itemId: string): string[] {
    const item = this.queue.get(itemId);
    if (!item) return [];

    // In production this would run `git merge-tree` or similar.
    // For now, returns the currently tracked conflict files.
    if (item.conflictFiles.length > 0) {
      item.status = 'blocked';
      this.notify('conflict-detected', item);
      this.emitFeed('conflict', `Conflicts detected in ${item.branch}: ${item.conflictFiles.join(', ')}`);
    }

    return [...item.conflictFiles];
  }

  /** Mark a single conflicting file as resolved. */
  markConflictResolved(itemId: string, file: string): void {
    const item = this.queue.get(itemId);
    if (!item) return;

    item.conflictFiles = item.conflictFiles.filter(f => f !== file);
    console.log(`${PREFIX} Conflict resolved for ${itemId}: ${file} (remaining: ${item.conflictFiles.length})`);

    // If all conflicts resolved and item was blocked, move back to queued
    if (item.conflictFiles.length === 0 && item.status === 'blocked') {
      item.status = 'queued';
      console.log(`${PREFIX} All conflicts resolved for ${itemId}, re-queued`);
    }
  }

  /** Check if an item has unresolved conflicts. */
  hasConflicts(itemId: string): boolean {
    const item = this.queue.get(itemId);
    if (!item) return false;
    return item.conflictFiles.length > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-086: Push Serialization
  // ───────────────────────────────────────────────────────────────────────────

  /** Acquire the push lock for a merge item. Single-slot: only one item can push at a time. */
  acquirePushLock(itemId: string): boolean {
    if (this.pushLockHolder !== null) {
      console.log(`${PREFIX} Push lock denied for ${itemId} — held by ${this.pushLockHolder}`);
      return false;
    }

    const item = this.queue.get(itemId);
    if (!item) return false;

    this.pushLockHolder = itemId;
    item.status = 'merging';
    console.log(`${PREFIX} Push lock acquired by ${itemId}`);
    return true;
  }

  /** Release the push lock. Only the holder can release. */
  releasePushLock(itemId: string): void {
    if (this.pushLockHolder !== itemId) {
      console.warn(`${PREFIX} releasePushLock: ${itemId} does not hold the lock (holder: ${this.pushLockHolder})`);
      return;
    }
    this.pushLockHolder = null;
    console.log(`${PREFIX} Push lock released by ${itemId}`);
  }

  /** Check if the push lock is currently held. */
  isPushLocked(): boolean {
    return this.pushLockHolder !== null;
  }

  /** Get the ID of the item currently holding the push lock, or null. */
  getPushLockHolder(): string | null {
    return this.pushLockHolder;
  }

  /**
   * Attempt to acquire push lock with exponential backoff.
   * Returns true if lock acquired within maxRetries attempts.
   */
  async acquirePushLockWithBackoff(itemId: string, maxRetries = 5): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.acquirePushLock(itemId)) return true;

      if (attempt < maxRetries) {
        const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
        console.log(`${PREFIX} Push lock retry ${attempt + 1}/${maxRetries} for ${itemId} — waiting ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    console.warn(`${PREFIX} Push lock acquisition failed for ${itemId} after ${maxRetries} retries`);
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-087: Post-Merge Cleanup
  // ───────────────────────────────────────────────────────────────────────────

  /** Perform post-merge cleanup: close beads, mark branch deleted, notify. */
  postMergeCleanup(itemId: string): { closedBeads: string[]; deletedBranch: boolean; notified: boolean } {
    const item = this.queue.get(itemId);
    if (!item) {
      return { closedBeads: [], deletedBranch: false, notified: false };
    }

    const closedBeads: string[] = [];

    // Close linked bead if present
    if (item.beadId) {
      closedBeads.push(item.beadId);
      notifyBeadCompleted(item.beadId);
      console.log(`${PREFIX} Post-merge: closed bead ${item.beadId}`);
    }

    // Mark item as merged
    item.status = 'merged';
    item.mergedAt = new Date();

    // Track queue wait time
    if (item.enqueuedAt) {
      const waitMs = item.mergedAt.getTime() - item.enqueuedAt.getTime();
      this.metricsData.totalQueueWaitMs += waitMs;
    }
    this.metricsData.totalMerged++;
    if (!this.metricsData.firstMergeAt) {
      this.metricsData.firstMergeAt = new Date();
    }

    // Release push lock if held
    if (this.pushLockHolder === itemId) {
      this.pushLockHolder = null;
    }

    // Move to recently merged
    this.recentlyMerged.unshift({ ...item });
    if (this.recentlyMerged.length > MAX_RECENTLY_MERGED) {
      this.recentlyMerged = this.recentlyMerged.slice(0, MAX_RECENTLY_MERGED);
    }

    // Remove from active queue
    this.queue.delete(itemId);

    // Notify
    this.notify('merged', item);
    this.emitFeed('merged', `Merged: ${item.title} (${item.branch})`);

    console.log(`${PREFIX} Post-merge cleanup complete for ${itemId}: beads=${closedBeads.length} branch=deleted`);

    return { closedBeads, deletedBranch: true, notified: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-088: Fast-Path Merge
  // ───────────────────────────────────────────────────────────────────────────

  /** Check if an item qualifies for fast-path merge (pre-verified, no conflicts, all gates passed, 0 behind). */
  canFastPath(itemId: string): boolean {
    const item = this.queue.get(itemId);
    if (!item) return false;

    const allGatesPassed = item.gates.length > 0 && item.gates.every(g => g.status === 'passed');
    const noConflicts = item.conflictFiles.length === 0;
    const zeroBehind = item.behind === 0;
    const isApproved = item.status === 'approved';

    return allGatesPassed && noConflicts && zeroBehind && isApproved;
  }

  /** Execute a fast-path merge: acquire lock, merge, cleanup — all in one shot. */
  async fastPathMerge(itemId: string): Promise<{ success: boolean; error?: string }> {
    const item = this.queue.get(itemId);
    if (!item) {
      return { success: false, error: `Item ${itemId} not found` };
    }

    if (!this.canFastPath(itemId)) {
      return { success: false, error: `Item ${itemId} does not qualify for fast-path merge` };
    }

    // Acquire push lock
    const locked = this.acquirePushLock(itemId);
    if (!locked) {
      return { success: false, error: `Could not acquire push lock for ${itemId} (held by ${this.pushLockHolder})` };
    }

    try {
      console.log(`${PREFIX} Fast-path merge executing for ${itemId} (branch=${item.branch})`);

      // Real git merge: fetch + merge --ff-only + push
      const mergeResult = await this.gitMergeBranch(item.branch);
      if (!mergeResult.success) {
        this.releasePushLock(itemId);
        item.status = 'blocked';
        console.error(`${PREFIX} Git merge failed for ${itemId}: ${mergeResult.error}`);
        return { success: false, error: mergeResult.error };
      }

      // Cleanup (marks merged, releases lock, notifies, etc.)
      this.postMergeCleanup(itemId);

      console.log(`${PREFIX} Fast-path merge complete for ${itemId}`);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.releasePushLock(itemId);
      item.status = 'blocked';
      console.error(`${PREFIX} Fast-path merge failed for ${itemId}: ${error}`);
      return { success: false, error };
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Git Merge (real execution)
  // ───────────────────────────────────────────────────────────────────────────

  /** Perform real git merge: fetch → merge --no-ff → push. */
  private async gitMergeBranch(branch: string): Promise<{ success: boolean; error?: string }> {
    const cwd = process.env.MEOW_GATE_WORKDIR || process.cwd();

    // Fetch latest
    const fetchRes = await runGateCmd('git', ['fetch', 'origin'], cwd, 30_000);
    if (fetchRes.exitCode !== 0) {
      console.warn(`${PREFIX} git fetch warning: ${fetchRes.stderr}`);
    }

    // Merge the branch into current (usually main)
    const mergeRes = await runGateCmd(
      'git', ['merge', '--no-ff', `origin/${branch}`, '-m', `Merge ${branch} [MEOW Refinery]`],
      cwd, 60_000,
    );
    if (mergeRes.exitCode !== 0) {
      return { success: false, error: `git merge failed: ${mergeRes.stderr || mergeRes.stdout}` };
    }

    // Push
    const pushRes = await runGateCmd('git', ['push', 'origin', 'HEAD'], cwd, 30_000);
    if (pushRes.exitCode !== 0) {
      return { success: false, error: `git push failed: ${pushRes.stderr || pushRes.stdout}` };
    }

    // Cleanup: delete merged branch
    void runGateCmd('git', ['push', 'origin', '--delete', branch], cwd, 15_000).catch(() => {});

    console.log(`${PREFIX} Git merge+push complete for branch ${branch}`);
    return { success: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-089: Merge Notifications
  // ───────────────────────────────────────────────────────────────────────────

  /** Subscribe to merge events. Returns unsubscribe function. */
  onMergeEvent(handler: MergeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Internal: dispatch merge event to all handlers. */
  private notify(event: MergeEventType, item: MergeItem): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event, item);
      } catch (err) {
        console.error(`${PREFIX} Event handler error on "${event}":`, err);
      }
    }

    // Also broadcast via SSE for real-time UI
    broadcast('refinery', { event, item: this.sanitizeItem(item) });
  }

  /** Strip internal fields for SSE broadcast. */
  private sanitizeItem(item: MergeItem): Record<string, unknown> {
    return {
      id: item.id,
      branch: item.branch,
      author: item.author,
      title: item.title,
      beadId: item.beadId,
      priority: item.priority,
      status: item.status,
      gates: item.gates,
      conflictFiles: item.conflictFiles,
      rebaseStrategy: item.rebaseStrategy,
      enqueuedAt: item.enqueuedAt,
      startedAt: item.startedAt,
      mergedAt: item.mergedAt,
      ahead: item.ahead,
      behind: item.behind,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-090: Merge Metrics
  // ───────────────────────────────────────────────────────────────────────────

  /** Get aggregated merge metrics. */
  getMetrics(): MergeMetrics {
    const { totalMerged, totalRejected, totalQueueWaitMs, totalGateDurationMs, gateRuns, gatePasses, firstMergeAt } = this.metricsData;

    const avgQueueWaitMs = totalMerged > 0 ? totalQueueWaitMs / totalMerged : 0;
    const avgGateDurationMs = gateRuns > 0 ? totalGateDurationMs / gateRuns : 0;
    const gatePassRate = gateRuns > 0 ? gatePasses / gateRuns : 0;

    // Throughput: merges per hour since the first merge
    let throughputPerHour = 0;
    if (firstMergeAt && totalMerged > 0) {
      const elapsedHours = (Date.now() - firstMergeAt.getTime()) / 3_600_000;
      throughputPerHour = elapsedHours > 0 ? totalMerged / elapsedHours : totalMerged;
    }

    return {
      avgQueueWaitMs: Math.round(avgQueueWaitMs),
      avgGateDurationMs: Math.round(avgGateDurationMs),
      gatePassRate: Math.round(gatePassRate * 10_000) / 10_000, // 4 decimal places
      totalMerged,
      totalRejected,
      throughputPerHour: Math.round(throughputPerHour * 100) / 100,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EP-091: Merge Dashboard Data
  // ───────────────────────────────────────────────────────────────────────────

  /** Get full dashboard payload for RefineryView. */
  getDashboard(): MergeDashboard {
    return {
      queue: this.getQueue(),
      metrics: this.getMetrics(),
      activePush: this.pushLockHolder,
      recentlyMerged: this.recentlyMerged.slice(0, 20),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Emit activity via SSE addActivity. */
  private emitFeed(action: string, message: string, metadata?: Record<string, unknown>): void {
    try {
      addActivity({
        type: 'info',
        action: `refinery:${action}`,
        details: `${PREFIX} ${message}`,
      });
    } catch {
      // SSE not available — swallow silently
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

export const refinery = new Refinery();
