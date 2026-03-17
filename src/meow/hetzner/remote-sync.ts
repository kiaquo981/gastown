/**
 * HETZNER — Remote Sync
 *
 * Sync workspaces, repos, and results between Gas Town and remote
 * Docker containers. Handles git operations, file transfers,
 * and workspace bootstrapping.
 *
 * Gas Town: "Supply lines to the wasteland rigs."
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';
import { getWorker } from './remote-worker-registry';
import { executeRemote } from './remote-executor';
import type { RemoteWorker } from './remote-worker-registry';

const execFileAsync = promisify(execFile);
const log = createLogger('hetzner:sync');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  workerId: string;
  operation: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  ahead: number;
  behind: number;
  modified: string[];
  untracked: string[];
  raw: string;
}

export interface WorkspaceSetupResult {
  success: boolean;
  workerId: string;
  repoUrl: string;
  branch: string;
  steps: { step: string; success: boolean; output?: string; error?: string }[];
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SSH/SCP helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildScpArgs(
  worker: RemoteWorker,
  direction: 'to' | 'from',
  localPath: string,
  remotePath: string,
): string[] {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-P', String(worker.port),
    '-r',
  ];

  if (direction === 'to') {
    args.push(localPath, `${worker.user}@${worker.host}:${remotePath}`);
  } else {
    args.push(`${worker.user}@${worker.host}:${remotePath}`, localPath);
  }

  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync a git repo to a remote worker.
 * If the repo already exists, pulls latest. Otherwise, clones.
 */
export async function syncRepoToWorker(
  workerId: string,
  repoUrl: string,
  branch?: string,
): Promise<SyncResult> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const start = Date.now();
  const targetBranch = branch || 'main';

  // Extract repo name from URL
  const repoName = repoUrl.replace(/\.git$/, '').split('/').pop() || 'repo';
  const repoPath = `~/workspace/${repoName}`;

  log.info({ workerId, hostname: worker.hostname, repoUrl, branch: targetBranch }, 'Syncing repo to worker');
  broadcast('hetzner:sync:start', { workerId, hostname: worker.hostname, repoUrl });

  try {
    // Check if repo already exists
    const checkExec = await executeRemote(workerId, `test -d ${repoPath}/.git && echo exists || echo missing`);
    const repoExists = checkExec.output?.trim() === 'exists';

    let output: string;

    if (repoExists) {
      // Pull latest
      const pullCmd = `cd ${repoPath} && git fetch --all && git checkout ${targetBranch} && git pull origin ${targetBranch}`;
      const pullExec = await executeRemote(workerId, pullCmd);
      output = pullExec.output || '';

      if (pullExec.status === 'failed') {
        throw new Error(pullExec.error || 'Git pull failed');
      }
    } else {
      // Clone
      const cloneCmd = `cd ~/workspace && git clone --branch ${targetBranch} ${repoUrl} ${repoName}`;
      const cloneExec = await executeRemote(workerId, cloneCmd);
      output = cloneExec.output || '';

      if (cloneExec.status === 'failed') {
        throw new Error(cloneExec.error || 'Git clone failed');
      }
    }

    const result: SyncResult = {
      success: true,
      workerId,
      operation: repoExists ? 'pull' : 'clone',
      output,
      durationMs: Date.now() - start,
    };

    log.info({ workerId, operation: result.operation, durationMs: result.durationMs }, 'Repo sync complete');
    broadcast('hetzner:sync:complete', { workerId, hostname: worker.hostname, operation: result.operation });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ workerId, err }, 'Repo sync failed');
    broadcast('hetzner:sync:failed', { workerId, hostname: worker.hostname, error });

    return {
      success: false,
      workerId,
      operation: 'sync',
      error,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Copy results from a remote worker back to the local machine via SCP.
 */
export async function syncResultsFromWorker(
  workerId: string,
  remotePath: string,
  localPath: string,
): Promise<SyncResult> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const start = Date.now();

  log.info({ workerId, hostname: worker.hostname, remotePath, localPath }, 'Syncing results from worker');
  broadcast('hetzner:sync:download:start', { workerId, hostname: worker.hostname, remotePath });

  try {
    const scpArgs = buildScpArgs(worker, 'from', localPath, remotePath);
    const { stdout } = await execFileAsync('scp', scpArgs, { timeout: 120_000 });

    const result: SyncResult = {
      success: true,
      workerId,
      operation: 'download',
      output: stdout,
      durationMs: Date.now() - start,
    };

    log.info({ workerId, durationMs: result.durationMs }, 'Results downloaded');
    broadcast('hetzner:sync:download:complete', { workerId, hostname: worker.hostname });

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ workerId, err }, 'Results download failed');

    return {
      success: false,
      workerId,
      operation: 'download',
      error,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Full workspace setup: clone repo, checkout branch, install deps.
 */
export async function setupWorkerWorkspace(
  workerId: string,
  repoUrl: string,
  branch?: string,
): Promise<WorkspaceSetupResult> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const start = Date.now();
  const targetBranch = branch || 'main';
  const repoName = repoUrl.replace(/\.git$/, '').split('/').pop() || 'repo';
  const repoPath = `~/workspace/${repoName}`;

  const steps: WorkspaceSetupResult['steps'] = [];

  log.info({ workerId, hostname: worker.hostname, repoUrl, branch: targetBranch }, 'Setting up worker workspace');
  broadcast('hetzner:setup:start', { workerId, hostname: worker.hostname, repoUrl });

  // Step 1: Ensure workspace directory
  const mkdirExec = await executeRemote(workerId, 'mkdir -p ~/workspace');
  steps.push({
    step: 'mkdir',
    success: mkdirExec.status === 'completed',
    output: mkdirExec.output,
    error: mkdirExec.error,
  });

  // Step 2: Clone or pull repo
  const syncResult = await syncRepoToWorker(workerId, repoUrl, targetBranch);
  steps.push({
    step: syncResult.operation,
    success: syncResult.success,
    output: syncResult.output,
    error: syncResult.error,
  });

  if (!syncResult.success) {
    return {
      success: false,
      workerId,
      repoUrl,
      branch: targetBranch,
      steps,
      durationMs: Date.now() - start,
    };
  }

  // Step 3: Install dependencies (detect package manager)
  const detectPmExec = await executeRemote(
    workerId,
    `cd ${repoPath} && if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f yarn.lock ]; then echo yarn; elif [ -f bun.lockb ]; then echo bun; else echo npm; fi`,
  );
  const pm = detectPmExec.output?.trim() || 'npm';

  steps.push({
    step: 'detect-pm',
    success: true,
    output: pm,
  });

  // Check if there's a package.json
  const hasPkgExec = await executeRemote(workerId, `test -f ${repoPath}/package.json && echo yes || echo no`);
  if (hasPkgExec.output?.trim() === 'yes') {
    const installCmd = pm === 'pnpm' ? 'pnpm install' : pm === 'yarn' ? 'yarn' : pm === 'bun' ? 'bun install' : 'npm install';
    const installExec = await executeRemote(workerId, `cd ${repoPath} && ${installCmd}`, { timeout: 120_000 });
    steps.push({
      step: 'install',
      success: installExec.status === 'completed',
      output: installExec.output?.slice(-500),
      error: installExec.error,
    });
  } else {
    steps.push({ step: 'install', success: true, output: 'No package.json found, skipping' });
  }

  const allSuccess = steps.every(s => s.success);
  const result: WorkspaceSetupResult = {
    success: allSuccess,
    workerId,
    repoUrl,
    branch: targetBranch,
    steps,
    durationMs: Date.now() - start,
  };

  log.info({ workerId, success: allSuccess, durationMs: result.durationMs }, 'Workspace setup complete');
  broadcast('hetzner:setup:complete', { workerId, hostname: worker.hostname, success: allSuccess });

  return result;
}

/**
 * Get git status on a remote worker's workspace.
 */
export async function getWorkerGitStatus(
  workerId: string,
  repoName?: string,
): Promise<GitStatus> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const repoPath = repoName ? `~/workspace/${repoName}` : '~/workspace';

  // Run git status + branch info in one SSH call
  const cmd = [
    `cd ${repoPath}`,
    'git rev-parse --abbrev-ref HEAD',
    'git status --porcelain',
    'git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "0\t0"',
  ].join(' && echo "---SEPARATOR---" && ');

  const exec = await executeRemote(workerId, cmd);
  if (exec.status === 'failed') {
    throw new Error(exec.error || 'Failed to get git status');
  }

  const raw = exec.output || '';
  const sections = raw.split('---SEPARATOR---').map(s => s.trim());

  const branch = sections[0] || 'unknown';
  const porcelain = sections[1] || '';
  const leftRight = sections[2] || '0\t0';

  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of porcelain.split('\n').filter(l => l.trim())) {
    const status = line.slice(0, 2);
    const file = line.slice(3);
    if (status === '??') {
      untracked.push(file);
    } else {
      modified.push(file);
    }
  }

  const [aheadStr, behindStr] = leftRight.split('\t');
  const ahead = parseInt(aheadStr, 10) || 0;
  const behind = parseInt(behindStr, 10) || 0;

  return {
    branch,
    clean: modified.length === 0 && untracked.length === 0,
    ahead,
    behind,
    modified,
    untracked,
    raw,
  };
}

/**
 * Create a feature branch on a remote worker.
 */
export async function createWorkerBranch(
  workerId: string,
  branchName: string,
  repoName?: string,
): Promise<SyncResult> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const start = Date.now();
  const repoPath = repoName ? `~/workspace/${repoName}` : '~/workspace';

  log.info({ workerId, hostname: worker.hostname, branchName }, 'Creating branch on remote worker');
  broadcast('hetzner:branch:create', { workerId, hostname: worker.hostname, branchName });

  const cmd = `cd ${repoPath} && git checkout -b ${branchName}`;
  const exec = await executeRemote(workerId, cmd);

  const result: SyncResult = {
    success: exec.status === 'completed',
    workerId,
    operation: 'create-branch',
    output: exec.output,
    error: exec.error,
    durationMs: Date.now() - start,
  };

  if (result.success) {
    log.info({ workerId, branchName, durationMs: result.durationMs }, 'Branch created');
  } else {
    log.error({ workerId, branchName, err: exec.error }, 'Branch creation failed');
  }

  return result;
}

/**
 * Push commits from a remote worker's branch.
 */
export async function pushWorkerBranch(
  workerId: string,
  repoName?: string,
): Promise<SyncResult> {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker not found: ${workerId}`);

  const start = Date.now();
  const repoPath = repoName ? `~/workspace/${repoName}` : '~/workspace';

  const cmd = `cd ${repoPath} && git push -u origin HEAD`;
  const exec = await executeRemote(workerId, cmd);

  return {
    success: exec.status === 'completed',
    workerId,
    operation: 'push',
    output: exec.output,
    error: exec.error,
    durationMs: Date.now() - start,
  };
}
