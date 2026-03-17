/**
 * MAESTRO — Worktree Manager
 *
 * Git worktree management for parallel execution isolation.
 * Each bead/playbook task can run in its own worktree branch,
 * preventing file-system conflicts between concurrent agents.
 *
 * Gas Town: "Every rig gets its own lane on the road."
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const execFileAsync = promisify(execFile);
const log = createLogger('maestro:worktree');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  beadId?: string;
  agentId?: string;
  createdAt: Date;
  status: WorktreeStatus;
}

export type WorktreeStatus = 'active' | 'completed' | 'failed' | 'orphaned';

interface GitWorktreeEntry {
  worktree: string;
  HEAD: string;
  branch: string;
  bare?: boolean;
  detached?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const WORKTREE_DIR = '.gastown-worktrees';
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function gitExec(args: string[], cwd?: string): Promise<string> {
  const opts: { timeout: number; cwd?: string } = { timeout: 30000 };
  if (cwd) opts.cwd = cwd;
  const { stdout } = await execFileAsync('git', args, opts);
  return stdout.trim();
}

async function getRepoRoot(cwd?: string): Promise<string> {
  return gitExec(['rev-parse', '--show-toplevel'], cwd);
}

function worktreeId(): string {
  return `wt-${uuidv4().slice(0, 8)}`;
}

function branchName(id: string, suffix?: string): string {
  const safeSuffix = suffix ? `-${suffix.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
  return `maestro/${id}${safeSuffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistWorktree(wt: Worktree): Promise<void> {
  const pool = getPool();
  if (!pool) {
    log.warn('No DB pool — worktree metadata will not persist');
    return;
  }

  await pool.query(
    `INSERT INTO meow_worktrees (id, path, branch, bead_id, agent_id, created_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       bead_id = EXCLUDED.bead_id,
       agent_id = EXCLUDED.agent_id`,
    [wt.id, wt.path, wt.branch, wt.beadId ?? null, wt.agentId ?? null, wt.createdAt, wt.status],
  );
}

async function updateWorktreeStatus(id: string, status: WorktreeStatus): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`UPDATE meow_worktrees SET status = $1 WHERE id = $2`, [status, id]);
}

async function deleteWorktreeRecord(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`DELETE FROM meow_worktrees WHERE id = $1`, [id]);
}

async function loadWorktreesFromDb(): Promise<Worktree[]> {
  const pool = getPool();
  if (!pool) return [];

  const { rows } = await pool.query(
    `SELECT id, path, branch, bead_id, agent_id, created_at, status
     FROM meow_worktrees
     ORDER BY created_at DESC`,
  );

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    path: r.path as string,
    branch: r.branch as string,
    beadId: (r.bead_id as string) || undefined,
    agentId: (r.agent_id as string) || undefined,
    createdAt: new Date(r.created_at as string),
    status: r.status as WorktreeStatus,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory registry (mirrors DB for fast lookups)
// ─────────────────────────────────────────────────────────────────────────────

const worktreeRegistry = new Map<string, Worktree>();

// ─────────────────────────────────────────────────────────────────────────────
// Git Worktree Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> = {};

  for (const line of output.split('\n')) {
    if (line === '') {
      if (current.worktree) entries.push(current as GitWorktreeEntry);
      current = {};
      continue;
    }

    if (line.startsWith('worktree ')) {
      current.worktree = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.HEAD = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }

  // Flush last entry
  if (current.worktree) entries.push(current as GitWorktreeEntry);

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new git worktree for isolated execution.
 */
export async function createWorktree(
  basePath: string,
  branchSuffix?: string,
  beadId?: string,
  agentId?: string,
): Promise<Worktree> {
  const repoRoot = await getRepoRoot(basePath);
  const id = worktreeId();
  const branch = branchName(id, branchSuffix);
  const wtDir = path.join(repoRoot, WORKTREE_DIR, id);

  // Ensure parent directory exists
  await fs.mkdir(path.join(repoRoot, WORKTREE_DIR), { recursive: true });

  log.info({ id, branch, path: wtDir }, 'Creating worktree');

  // Create worktree with new branch
  await gitExec(['worktree', 'add', '-b', branch, wtDir], repoRoot);

  const wt: Worktree = {
    id,
    path: wtDir,
    branch,
    beadId,
    agentId,
    createdAt: new Date(),
    status: 'active',
  };

  worktreeRegistry.set(id, wt);
  await persistWorktree(wt);

  broadcast('maestro:worktree', { action: 'created', worktree: wt });
  log.info({ id, branch }, 'Worktree created');

  return wt;
}

/**
 * List all git worktrees from the git index, cross-referenced with DB metadata.
 */
export async function listWorktrees(basePath?: string): Promise<Worktree[]> {
  const cwd = basePath ?? process.cwd();

  try {
    const output = await gitExec(['worktree', 'list', '--porcelain'], cwd);
    const gitEntries = parseWorktreeList(output);

    // Merge with DB records
    const dbRecords = await loadWorktreesFromDb();
    const dbMap = new Map(dbRecords.map((r) => [r.path, r]));

    const result: Worktree[] = [];

    for (const entry of gitEntries) {
      // Skip the main worktree
      if (entry.bare || !entry.branch?.startsWith('maestro/')) continue;

      const dbRecord = dbMap.get(entry.worktree);
      if (dbRecord) {
        result.push(dbRecord);
      } else {
        // Git worktree exists but no DB record — create a synthetic entry
        result.push({
          id: entry.branch.replace('maestro/', ''),
          path: entry.worktree,
          branch: entry.branch,
          createdAt: new Date(),
          status: 'active',
        });
      }
    }

    return result;
  } catch (err) {
    log.error({ err }, 'Failed to list worktrees');
    // Fall back to DB-only records
    return loadWorktreesFromDb();
  }
}

/**
 * Remove a worktree by ID. Forces removal even if dirty.
 */
export async function removeWorktree(id: string, basePath?: string): Promise<void> {
  const wt = worktreeRegistry.get(id);
  const wtPath = wt?.path;

  if (!wtPath) {
    // Try to find from DB
    const dbRecords = await loadWorktreesFromDb();
    const record = dbRecords.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Worktree not found: ${id}`);
    }
    return removeWorktreeByPath(record.path, id, basePath);
  }

  return removeWorktreeByPath(wtPath, id, basePath);
}

async function removeWorktreeByPath(wtPath: string, id: string, basePath?: string): Promise<void> {
  const cwd = basePath ?? process.cwd();

  log.info({ id, path: wtPath }, 'Removing worktree');

  try {
    await gitExec(['worktree', 'remove', '--force', wtPath], cwd);
  } catch (err) {
    log.warn({ id, err }, 'git worktree remove failed — trying manual cleanup');
    // Manual cleanup if git command fails
    try {
      await fs.rm(wtPath, { recursive: true, force: true });
      await gitExec(['worktree', 'prune'], cwd);
    } catch (cleanupErr) {
      log.error({ id, cleanupErr }, 'Manual worktree cleanup also failed');
      throw cleanupErr;
    }
  }

  // Clean up branch
  const wt = worktreeRegistry.get(id);
  if (wt?.branch) {
    try {
      await gitExec(['branch', '-D', wt.branch], cwd);
    } catch {
      // Branch may already be deleted
    }
  }

  worktreeRegistry.delete(id);
  await deleteWorktreeRecord(id);

  broadcast('maestro:worktree', { action: 'removed', id });
  log.info({ id }, 'Worktree removed');
}

/**
 * Mark a worktree as completed or failed.
 */
export async function markWorktree(id: string, status: 'completed' | 'failed'): Promise<void> {
  const wt = worktreeRegistry.get(id);
  if (wt) wt.status = status;

  await updateWorktreeStatus(id, status);
  broadcast('maestro:worktree', { action: 'status', id, status });
  log.info({ id, status }, 'Worktree status updated');
}

/**
 * Find the worktree assigned to a specific bead.
 */
export async function getWorktreeForBead(beadId: string): Promise<Worktree | undefined> {
  // Check in-memory first
  for (const wt of worktreeRegistry.values()) {
    if (wt.beadId === beadId && wt.status === 'active') return wt;
  }

  // Check DB
  const pool = getPool();
  if (!pool) return undefined;

  const { rows } = await pool.query(
    `SELECT id, path, branch, bead_id, agent_id, created_at, status
     FROM meow_worktrees
     WHERE bead_id = $1 AND status = 'active'
     LIMIT 1`,
    [beadId],
  );

  if (rows.length === 0) return undefined;

  const r = rows[0];
  const wt: Worktree = {
    id: r.id,
    path: r.path,
    branch: r.branch,
    beadId: r.bead_id || undefined,
    agentId: r.agent_id || undefined,
    createdAt: new Date(r.created_at),
    status: r.status,
  };

  worktreeRegistry.set(wt.id, wt);
  return wt;
}

/**
 * Find and clean up orphaned worktrees — those with no active process
 * and older than the stale threshold.
 */
export async function cleanupOrphaned(basePath?: string): Promise<{ removed: string[] }> {
  const worktrees = await listWorktrees(basePath);
  const removed: string[] = [];
  const now = Date.now();

  for (const wt of worktrees) {
    const age = now - wt.createdAt.getTime();
    const isStale = age > STALE_THRESHOLD_MS;
    const isOrphanable = wt.status === 'completed' || wt.status === 'failed' || wt.status === 'orphaned';

    if (isStale || isOrphanable) {
      // Check if a process is still using this worktree
      const hasProcess = await isWorktreeInUse(wt.path);
      if (!hasProcess) {
        try {
          await removeWorktree(wt.id, basePath);
          removed.push(wt.id);
        } catch (err) {
          log.warn({ id: wt.id, err }, 'Failed to cleanup orphaned worktree');
          // Mark as orphaned so next pass picks it up
          await updateWorktreeStatus(wt.id, 'orphaned');
        }
      }
    }
  }

  if (removed.length > 0) {
    log.info({ count: removed.length }, 'Cleaned up orphaned worktrees');
    broadcast('maestro:worktree', { action: 'cleanup', removed });
  }

  return { removed };
}

/**
 * Check if any process has a CWD inside the worktree path.
 * Uses `lsof` on macOS/Linux.
 */
async function isWorktreeInUse(wtPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lsof', ['+D', wtPath], { timeout: 10000 });
    return stdout.trim().length > 0;
  } catch {
    // lsof returns non-zero if no matches — that means not in use
    return false;
  }
}

/**
 * Get a worktree by ID from the in-memory registry.
 */
export function getWorktree(id: string): Worktree | undefined {
  return worktreeRegistry.get(id);
}

/**
 * Load DB records into in-memory registry on startup.
 */
export async function initWorktreeManager(): Promise<void> {
  try {
    const records = await loadWorktreesFromDb();
    for (const r of records) {
      worktreeRegistry.set(r.id, r);
    }
    log.info({ count: records.length }, 'Worktree registry loaded from DB');
  } catch (err) {
    log.warn({ err }, 'Failed to load worktree registry from DB');
  }
}
