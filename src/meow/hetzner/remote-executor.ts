/**
 * HETZNER — Remote Executor
 *
 * Execute commands and dispatch Claude Code work to remote Docker containers
 * via SSH. Tracks executions, parses stream-json output, and manages
 * the lifecycle of remote tasks.
 *
 * Gas Town: "Send the war party. Track the kills."
 */

import { execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';
import {
  getWorker,
  markWorkerBusy,
  markWorkerAvailable,
  updateWorkerMetrics,
} from './remote-worker-registry';
import type { RemoteWorker } from './remote-worker-registry';

const execFileAsync = promisify(execFile);
const log = createLogger('hetzner:executor');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RemoteExecution {
  id: string;
  workerId: string;
  beadId?: string;
  command: string;
  status: ExecutionStatus;
  output?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  exitCode?: number;
}

export interface ExecuteRemoteOpts {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DispatchClaudeOpts {
  model?: string;
  yolo?: boolean;
  cwd?: string;
  timeout?: number;
  beadId?: string;
}

export interface ClaudeResult {
  executionId: string;
  output: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  exitCode: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory execution store
// ─────────────────────────────────────────────────────────────────────────────

const executions = new Map<string, RemoteExecution>();
const activeProcesses = new Map<string, ChildProcess>();

const MAX_EXECUTIONS = 500;
const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const CLAUDE_TIMEOUT = 600_000; // 10 minutes

// ─────────────────────────────────────────────────────────────────────────────
// SSH helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildSshArgs(worker: RemoteWorker, command: string): string[] {
  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-p', String(worker.port),
    `${worker.user}@${worker.host}`,
    command,
  ];
}

function pruneExecutions(): void {
  if (executions.size <= MAX_EXECUTIONS) return;

  const sorted = Array.from(executions.entries())
    .sort((a, b) => a[1].startedAt.getTime() - b[1].startedAt.getTime());

  const toRemove = sorted.slice(0, sorted.length - MAX_EXECUTIONS);
  for (const [id] of toRemove) {
    executions.delete(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream-JSON parser
// ─────────────────────────────────────────────────────────────────────────────

interface StreamJsonUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function extractUsageFromStreamJson(output: string): StreamJsonUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const lines = output.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      // Claude Code stream-json emits result events with usage
      if (parsed.type === 'result' && parsed.result) {
        inputTokens = parsed.result.input_tokens || parsed.result.inputTokens || inputTokens;
        outputTokens = parsed.result.output_tokens || parsed.result.outputTokens || outputTokens;
        costUsd = parsed.result.cost_usd || parsed.result.costUsd || costUsd;
      }

      // Also check for usage in message events
      if (parsed.usage) {
        inputTokens = parsed.usage.input_tokens || parsed.usage.inputTokens || inputTokens;
        outputTokens = parsed.usage.output_tokens || parsed.usage.outputTokens || outputTokens;
      }

      if (parsed.cost_usd !== undefined) costUsd = parsed.cost_usd;
      if (parsed.costUsd !== undefined) costUsd = parsed.costUsd;
    } catch {
      // Not JSON — skip
    }
  }

  // Estimate cost if not provided (Claude Sonnet 4 pricing approximation)
  if (costUsd === 0 && (inputTokens > 0 || outputTokens > 0)) {
    costUsd = (inputTokens * 0.003 + outputTokens * 0.015) / 1000;
  }

  return { inputTokens, outputTokens, costUsd };
}

function extractTextFromStreamJson(output: string): string {
  const textParts: string[] = [];
  const lines = output.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }
      }

      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        textParts.push(parsed.delta.text);
      }

      // Result text
      if (parsed.type === 'result' && parsed.result?.text) {
        textParts.push(parsed.result.text);
      }
    } catch {
      // Not JSON — could be raw text output
    }
  }

  return textParts.join('') || output;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a raw command on a remote worker via SSH.
 */
export async function executeRemote(
  workerId: string,
  command: string,
  opts?: ExecuteRemoteOpts,
): Promise<RemoteExecution> {
  const worker = getWorker(workerId);
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`);
  }

  const execId = `exec-${uuidv4().slice(0, 12)}`;
  const timeout = opts?.timeout || DEFAULT_TIMEOUT;

  const execution: RemoteExecution = {
    id: execId,
    workerId,
    command,
    status: 'running',
    startedAt: new Date(),
  };

  executions.set(execId, execution);
  pruneExecutions();

  log.info({ execId, workerId, hostname: worker.hostname, command: command.slice(0, 100) }, 'Executing remote command');
  broadcast('hetzner:exec:start', { id: execId, workerId, hostname: worker.hostname });

  // Build remote command with optional cwd
  let remoteCmd = command;
  if (opts?.cwd) {
    remoteCmd = `cd ${opts.cwd} && ${command}`;
  }
  if (opts?.env) {
    const envPrefix = Object.entries(opts.env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    remoteCmd = `${envPrefix} ${remoteCmd}`;
  }

  try {
    const sshArgs = buildSshArgs(worker, remoteCmd);

    const { stdout, stderr } = await execFileAsync('ssh', sshArgs, { timeout });

    execution.status = 'completed';
    execution.output = stdout;
    execution.error = stderr || undefined;
    execution.exitCode = 0;
    execution.completedAt = new Date();
    execution.durationMs = execution.completedAt.getTime() - execution.startedAt.getTime();

    log.info({ execId, durationMs: execution.durationMs }, 'Remote command completed');
    broadcast('hetzner:exec:complete', { id: execId, workerId, exitCode: 0, durationMs: execution.durationMs });

    return execution;
  } catch (err: unknown) {
    const error = err as { code?: number; stdout?: string; stderr?: string; message?: string };

    execution.status = 'failed';
    execution.output = error.stdout || undefined;
    execution.error = error.stderr || error.message || 'Unknown error';
    execution.exitCode = error.code ?? 1;
    execution.completedAt = new Date();
    execution.durationMs = execution.completedAt.getTime() - execution.startedAt.getTime();

    log.error({ execId, exitCode: execution.exitCode, err }, 'Remote command failed');
    broadcast('hetzner:exec:failed', { id: execId, workerId, exitCode: execution.exitCode, error: execution.error });

    return execution;
  }
}

/**
 * Run Claude Code on a remote worker.
 * Parses stream-json output for usage tracking.
 */
export async function dispatchClaude(
  workerId: string,
  prompt: string,
  opts?: DispatchClaudeOpts,
): Promise<ClaudeResult> {
  const worker = getWorker(workerId);
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`);
  }

  const execId = `claude-${uuidv4().slice(0, 12)}`;
  const timeout = opts?.timeout || CLAUDE_TIMEOUT;
  const cwd = opts?.cwd || '~/workspace';

  // Build Claude Code command
  const claudeArgs: string[] = ['claude', '--print', '--output-format', 'stream-json'];
  if (opts?.yolo) {
    claudeArgs.push('--dangerously-skip-permissions');
  }
  if (opts?.model) {
    claudeArgs.push('--model', opts.model);
  }

  // Escape prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  claudeArgs.push(`'${escapedPrompt}'`);

  const remoteCmd = `cd ${cwd} && ${claudeArgs.join(' ')}`;

  const execution: RemoteExecution = {
    id: execId,
    workerId,
    beadId: opts?.beadId,
    command: remoteCmd,
    status: 'running',
    startedAt: new Date(),
  };

  executions.set(execId, execution);
  pruneExecutions();

  // Mark worker busy
  markWorkerBusy(workerId, opts?.beadId);

  log.info(
    { execId, workerId, hostname: worker.hostname, promptLen: prompt.length, beadId: opts?.beadId },
    'Dispatching Claude Code to remote worker',
  );
  broadcast('hetzner:claude:start', {
    id: execId,
    workerId,
    hostname: worker.hostname,
    beadId: opts?.beadId,
  });

  try {
    const sshArgs = buildSshArgs(worker, remoteCmd);

    // Use raw execFile to capture process for potential kill
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        const proc = execFile('ssh', sshArgs, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
          activeProcesses.delete(execId);
          if (err) {
            const exitCode = (err as NodeJS.ErrnoException & { code?: number }).code;
            resolve({
              stdout: stdout || '',
              stderr: stderr || err.message,
              exitCode: typeof exitCode === 'number' ? exitCode : 1,
            });
          } else {
            resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
          }
        });

        activeProcesses.set(execId, proc);
      },
    );

    const now = new Date();
    const durationMs = now.getTime() - execution.startedAt.getTime();

    // Parse stream-json for usage
    const usage = extractUsageFromStreamJson(result.stdout);
    const textOutput = extractTextFromStreamJson(result.stdout);

    execution.status = result.exitCode === 0 ? 'completed' : 'failed';
    execution.output = result.stdout;
    execution.error = result.stderr || undefined;
    execution.exitCode = result.exitCode;
    execution.completedAt = now;
    execution.durationMs = durationMs;

    // Update worker metrics
    updateWorkerMetrics(workerId, {
      tokensUsed: usage.inputTokens + usage.outputTokens,
      costUsd: usage.costUsd,
      tasksCompleted: result.exitCode === 0 ? 1 : 0,
    });

    // Release worker
    markWorkerAvailable(workerId);

    const claudeResult: ClaudeResult = {
      executionId: execId,
      output: textOutput,
      tokensUsed: usage.inputTokens + usage.outputTokens,
      costUsd: usage.costUsd,
      durationMs,
      exitCode: result.exitCode,
    };

    log.info(
      { execId, durationMs, tokens: claudeResult.tokensUsed, cost: claudeResult.costUsd, exitCode: result.exitCode },
      'Claude Code dispatch completed',
    );
    broadcast('hetzner:claude:complete', {
      id: execId,
      workerId,
      hostname: worker.hostname,
      beadId: opts?.beadId,
      tokens: claudeResult.tokensUsed,
      cost: claudeResult.costUsd,
      durationMs,
      exitCode: result.exitCode,
    });

    return claudeResult;
  } catch (err) {
    const now = new Date();
    execution.status = 'failed';
    execution.error = err instanceof Error ? err.message : String(err);
    execution.completedAt = now;
    execution.durationMs = now.getTime() - execution.startedAt.getTime();

    markWorkerAvailable(workerId);

    log.error({ execId, err }, 'Claude Code dispatch failed');
    broadcast('hetzner:claude:failed', { id: execId, workerId, error: execution.error });

    throw err;
  }
}

/**
 * Full bead dispatch: pick worker, run Claude, return result.
 */
export async function dispatchBeadToRemote(
  beadId: string,
  prompt: string,
  workerId?: string,
  opts?: Omit<DispatchClaudeOpts, 'beadId'>,
): Promise<ClaudeResult> {
  // Import here to avoid circular dependency
  const { getAvailableWorker, getWorker: getW } = await import('./remote-worker-registry');

  let targetWorkerId = workerId;

  if (!targetWorkerId) {
    const available = getAvailableWorker();
    if (!available) {
      throw new Error('No available remote workers');
    }
    targetWorkerId = available.id;
  } else {
    const worker = getW(targetWorkerId);
    if (!worker) throw new Error(`Worker not found: ${targetWorkerId}`);
    if (worker.status === 'busy') throw new Error(`Worker ${targetWorkerId} is busy`);
  }

  log.info({ beadId, workerId: targetWorkerId }, 'Dispatching bead to remote worker');
  broadcast('hetzner:bead:dispatch', { beadId, workerId: targetWorkerId });

  const result = await dispatchClaude(targetWorkerId, prompt, { ...opts, beadId });

  broadcast('hetzner:bead:complete', {
    beadId,
    workerId: targetWorkerId,
    executionId: result.executionId,
    tokens: result.tokensUsed,
    cost: result.costUsd,
  });

  return result;
}

/**
 * Get execution details by ID.
 */
export function getExecution(id: string): RemoteExecution | undefined {
  return executions.get(id);
}

/**
 * List recent executions, optionally filtered by worker.
 */
export function listExecutions(workerId?: string, limit = 50): RemoteExecution[] {
  let list = Array.from(executions.values());
  if (workerId) {
    list = list.filter(e => e.workerId === workerId);
  }
  return list
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, limit);
}

/**
 * Kill a running execution by terminating the SSH process.
 */
export function killExecution(id: string): boolean {
  const proc = activeProcesses.get(id);
  if (!proc) {
    log.warn({ execId: id }, 'No active process to kill');
    return false;
  }

  proc.kill('SIGTERM');
  setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, 3000);

  const execution = executions.get(id);
  if (execution) {
    execution.status = 'failed';
    execution.error = 'Killed by user';
    execution.completedAt = new Date();
    execution.durationMs = execution.completedAt.getTime() - execution.startedAt.getTime();

    // Release worker
    markWorkerAvailable(execution.workerId);
  }

  activeProcesses.delete(id);
  log.info({ execId: id }, 'Execution killed');
  broadcast('hetzner:exec:killed', { id });

  return true;
}

/**
 * Get execution stats.
 */
export function getExecutionStats(): {
  total: number;
  running: number;
  completed: number;
  failed: number;
} {
  const all = Array.from(executions.values());
  return {
    total: all.length,
    running: all.filter(e => e.status === 'running').length,
    completed: all.filter(e => e.status === 'completed').length,
    failed: all.filter(e => e.status === 'failed').length,
  };
}
