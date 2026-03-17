/**
 * MAESTRO — Playbook Engine
 *
 * Generates and executes Maestro-compatible markdown playbooks.
 * A playbook is a sequence of markdown documents containing checkbox tasks.
 * The engine iterates through tasks, dispatching each to a CLI agent,
 * collecting output, and tracking cost/tokens.
 *
 * Gas Town: "The convoy runs on rails. The playbook IS the rail."
 */

import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import { getAgentDefinition, buildAgentArgs, ensureDetected } from './agent-registry';
import { createWorktree, markWorktree, removeWorktree } from './worktree-manager';
import { createSession, updateUsage, completeSession, failSession } from './session-tracker';

const log = createLogger('maestro:playbook');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Playbook {
  id: string;
  name: string;
  description?: string;
  documents: PlaybookDocument[];
  settings: PlaybookSettings;
  createdAt: Date;
  lastRunAt?: Date;
}

export interface PlaybookDocument {
  id: string;
  path: string;
  content: string;
  order: number;
}

export interface PlaybookSettings {
  loop: boolean;
  resetOnCompletion: boolean;
  worktreeDispatch: boolean;
  agentId: string;
  promptTemplate?: string;
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  status: PlaybookRunStatus;
  currentDocIndex: number;
  currentTaskIndex: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  startedAt: Date;
  completedAt?: Date;
  loopCount: number;
  taskResults: TaskResult[];
}

export type PlaybookRunStatus = 'running' | 'completed' | 'failed' | 'paused';

export interface TaskResult {
  taskId: string;
  taskText: string;
  status: TaskResultStatus;
  output?: string;
  sessionId?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
  startedAt?: Date;
  completedAt?: Date;
}

export type TaskResultStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TASK_REGEX = /^(\s*)-\s*\[([ xX])\]\s+(.+)$/;
const DEFAULT_PROMPT_TEMPLATE =
  'Complete the following task. Work carefully and verify your changes.\n\nTask: {{task}}';
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per task

// ─────────────────────────────────────────────────────────────────────────────
// In-memory run store (also persisted to DB)
// ─────────────────────────────────────────────────────────────────────────────

const activeRuns = new Map<string, PlaybookRun>();
const runProcesses = new Map<string, ChildProcess>();
const pauseSignals = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function playbookId(): string {
  return `pb-${uuidv4().slice(0, 8)}`;
}

function runId(): string {
  return `pbr-${uuidv4().slice(0, 8)}`;
}

function taskId(): string {
  return `pbt-${uuidv4().slice(0, 8)}`;
}

function buildPrompt(template: string, taskText: string): string {
  return template.replace('{{task}}', taskText);
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract `- [ ] task` lines from markdown content.
 * Returns TaskResult[] with status based on checkbox state.
 */
export function parseMarkdownTasks(content: string): TaskResult[] {
  const lines = content.split('\n');
  const tasks: TaskResult[] = [];

  for (const line of lines) {
    const match = line.match(TASK_REGEX);
    if (!match) continue;

    const checked = match[2].toLowerCase() === 'x';
    const text = match[3].trim();

    tasks.push({
      taskId: taskId(),
      taskText: text,
      status: checked ? 'completed' : 'pending',
    });
  }

  return tasks;
}

/**
 * Update markdown content, marking a task as checked.
 */
function markTaskInMarkdown(content: string, taskText: string): string {
  const lines = content.split('\n');
  const updated = lines.map((line) => {
    const match = line.match(TASK_REGEX);
    if (match && match[3].trim() === taskText) {
      return line.replace('- [ ]', '- [x]');
    }
    return line;
  });
  return updated.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistPlaybook(pb: Playbook): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO meow_playbooks (id, name, description, documents, settings, created_at, last_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       documents = EXCLUDED.documents,
       settings = EXCLUDED.settings,
       last_run_at = EXCLUDED.last_run_at`,
    [
      pb.id,
      pb.name,
      pb.description ?? null,
      JSON.stringify(pb.documents),
      JSON.stringify(pb.settings),
      pb.createdAt,
      pb.lastRunAt ?? null,
    ],
  );
}

async function persistRun(run: PlaybookRun): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO meow_playbook_runs (id, playbook_id, status, current_doc_index, current_task_index,
       total_tasks, completed_tasks, failed_tasks, started_at, completed_at, loop_count, task_results)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       current_doc_index = EXCLUDED.current_doc_index,
       current_task_index = EXCLUDED.current_task_index,
       completed_tasks = EXCLUDED.completed_tasks,
       failed_tasks = EXCLUDED.failed_tasks,
       completed_at = EXCLUDED.completed_at,
       loop_count = EXCLUDED.loop_count,
       task_results = EXCLUDED.task_results`,
    [
      run.id,
      run.playbookId,
      run.status,
      run.currentDocIndex,
      run.currentTaskIndex,
      run.totalTasks,
      run.completedTasks,
      run.failedTasks,
      run.startedAt,
      run.completedAt ?? null,
      run.loopCount,
      JSON.stringify(run.taskResults),
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Dispatch
// ─────────────────────────────────────────────────────────────────────────────

interface DispatchResult {
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  sessionId: string;
}

/**
 * Dispatch a single task to an agent CLI process. Returns collected output
 * and usage metrics parsed from the agent's stream output.
 */
async function dispatchToAgent(
  agentId: string,
  prompt: string,
  cwd: string,
  runIdRef: string,
  beadId?: string,
): Promise<DispatchResult> {
  await ensureDetected();

  const agent = getAgentDefinition(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const session = await createSession(agentId, beadId);
  const args = buildAgentArgs(agent, { prompt, yolo: true });

  log.info({ agentId, sessionId: session.id, cwd }, 'Dispatching task to agent');

  return new Promise<DispatchResult>((resolve, reject) => {
    const startTime = Date.now();
    const chunks: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;

    const proc = spawn(agent.binary, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: TASK_TIMEOUT_MS,
    });

    runProcesses.set(runIdRef, proc);

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);

      // Parse streaming usage data from stream-json or jsonl formats
      if (agent.outputFormat === 'stream-json' || agent.outputFormat === 'jsonl') {
        for (const line of text.split('\n').filter((l) => l.trim())) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'usage' || parsed.usage) {
              const usage = parsed.usage ?? parsed;
              tokensIn += usage.input_tokens ?? usage.tokens_in ?? 0;
              tokensOut += usage.output_tokens ?? usage.tokens_out ?? 0;
              costUsd += usage.cost_usd ?? usage.cost ?? 0;
            }
          } catch {
            // Not JSON — plain text output
          }
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const errText = data.toString();
      log.debug({ agentId, stderr: errText.slice(0, 200) }, 'Agent stderr');
    });

    proc.on('error', async (err) => {
      runProcesses.delete(runIdRef);
      await failSession(session.id, err.message);
      reject(err);
    });

    proc.on('close', async (code) => {
      runProcesses.delete(runIdRef);
      const durationMs = Date.now() - startTime;
      const output = chunks.join('');

      await updateUsage(session.id, tokensIn, tokensOut, costUsd);

      if (code === 0) {
        await completeSession(session.id, output.slice(0, 10000));
        resolve({
          output,
          tokensIn,
          tokensOut,
          costUsd,
          durationMs,
          sessionId: session.id,
        });
      } else {
        const errMsg = `Agent exited with code ${code}`;
        await failSession(session.id, errMsg);
        reject(new Error(errMsg));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new playbook.
 */
export async function createPlaybook(
  name: string,
  docs: Omit<PlaybookDocument, 'id'>[],
  settings: PlaybookSettings,
  description?: string,
): Promise<Playbook> {
  const pb: Playbook = {
    id: playbookId(),
    name,
    description,
    documents: docs.map((d) => ({ ...d, id: `pbd-${uuidv4().slice(0, 8)}` })),
    settings,
    createdAt: new Date(),
  };

  await persistPlaybook(pb);
  broadcast('maestro:playbook', { action: 'created', playbook: { id: pb.id, name: pb.name } });
  log.info({ id: pb.id, name }, 'Playbook created');
  return pb;
}

/**
 * List all playbooks from DB.
 */
export async function listPlaybooks(): Promise<Playbook[]> {
  const pool = getPool();
  if (!pool) return [];

  const { rows } = await pool.query(
    `SELECT id, name, description, documents, settings, created_at, last_run_at
     FROM meow_playbooks ORDER BY created_at DESC`,
  );

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) || undefined,
    documents: r.documents as PlaybookDocument[],
    settings: r.settings as PlaybookSettings,
    createdAt: new Date(r.created_at as string),
    lastRunAt: r.last_run_at ? new Date(r.last_run_at as string) : undefined,
  }));
}

/**
 * Get a single playbook by ID.
 */
export async function getPlaybook(id: string): Promise<Playbook | null> {
  const pool = getPool();
  if (!pool) return null;

  const { rows } = await pool.query(
    `SELECT id, name, description, documents, settings, created_at, last_run_at
     FROM meow_playbooks WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    description: r.description || undefined,
    documents: r.documents,
    settings: r.settings,
    createdAt: new Date(r.created_at),
    lastRunAt: r.last_run_at ? new Date(r.last_run_at) : undefined,
  };
}

/**
 * Delete a playbook and its run history.
 */
export async function deletePlaybook(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`DELETE FROM meow_playbook_runs WHERE playbook_id = $1`, [id]);
  await pool.query(`DELETE FROM meow_playbooks WHERE id = $1`, [id]);

  broadcast('maestro:playbook', { action: 'deleted', id });
  log.info({ id }, 'Playbook deleted');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a playbook. Iterates through each document's tasks sequentially,
 * dispatching each to the configured agent CLI.
 *
 * Execution is async — returns the PlaybookRun immediately and processes
 * in the background. Monitor via SSE events or getPlaybookRun().
 */
export async function runPlaybook(
  pbId: string,
  opts?: { cwd?: string; loop?: boolean },
): Promise<PlaybookRun> {
  const pb = await getPlaybook(pbId);
  if (!pb) throw new Error(`Playbook not found: ${pbId}`);

  // Collect all tasks across documents
  const allTasks: TaskResult[] = [];
  for (const doc of pb.documents.sort((a, b) => a.order - b.order)) {
    const docTasks = parseMarkdownTasks(doc.content);
    allTasks.push(...docTasks);
  }

  const pendingTasks = allTasks.filter((t) => t.status === 'pending');

  const run: PlaybookRun = {
    id: runId(),
    playbookId: pbId,
    status: 'running',
    currentDocIndex: 0,
    currentTaskIndex: 0,
    totalTasks: pendingTasks.length,
    completedTasks: 0,
    failedTasks: 0,
    startedAt: new Date(),
    loopCount: 0,
    taskResults: pendingTasks,
  };

  activeRuns.set(run.id, run);
  await persistRun(run);

  // Update playbook last run timestamp
  pb.lastRunAt = new Date();
  await persistPlaybook(pb);

  broadcast('maestro:playbook', { action: 'run:started', runId: run.id, playbookId: pbId });

  // Execute in background
  const cwd = opts?.cwd ?? process.cwd();
  const shouldLoop = opts?.loop ?? pb.settings.loop;
  executePlaybookRun(run, pb, cwd, shouldLoop).catch((err) => {
    log.error({ runId: run.id, err }, 'Playbook run failed unexpectedly');
  });

  return run;
}

/**
 * Internal: execute the full playbook run loop.
 */
async function executePlaybookRun(
  run: PlaybookRun,
  pb: Playbook,
  cwd: string,
  loop: boolean,
): Promise<void> {
  const promptTemplate = pb.settings.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
  let workingDir = cwd;

  // Optionally create a worktree for isolation
  let worktreeId: string | undefined;
  if (pb.settings.worktreeDispatch) {
    try {
      const wt = await createWorktree(cwd, pb.name.replace(/\s+/g, '-'));
      workingDir = wt.path;
      worktreeId = wt.id;
      log.info({ worktreeId: wt.id, path: wt.path }, 'Worktree created for playbook run');
    } catch (err) {
      log.warn({ err }, 'Failed to create worktree — running in main repo');
    }
  }

  do {
    run.loopCount++;

    const sortedDocs = [...pb.documents].sort((a, b) => a.order - b.order);

    for (let docIdx = 0; docIdx < sortedDocs.length; docIdx++) {
      run.currentDocIndex = docIdx;
      const doc = sortedDocs[docIdx];
      const docTasks = run.taskResults.filter((t) => t.status === 'pending');

      for (let taskIdx = 0; taskIdx < docTasks.length; taskIdx++) {
        // Check for pause signal
        if (pauseSignals.has(run.id)) {
          run.status = 'paused';
          await persistRun(run);
          broadcast('maestro:playbook', { action: 'run:paused', runId: run.id });
          log.info({ runId: run.id }, 'Playbook run paused');
          return;
        }

        const task = docTasks[taskIdx];
        run.currentTaskIndex = taskIdx;
        task.status = 'running';
        task.startedAt = new Date();

        broadcast('maestro:playbook', {
          action: 'task:started',
          runId: run.id,
          taskId: task.taskId,
          taskText: task.taskText,
          docIndex: docIdx,
          taskIndex: taskIdx,
        });

        await persistRun(run);

        try {
          const prompt = buildPrompt(promptTemplate, task.taskText);
          const result = await dispatchToAgent(
            pb.settings.agentId,
            prompt,
            workingDir,
            run.id,
            undefined,
          );

          task.status = 'completed';
          task.output = result.output.slice(0, 10000); // cap stored output
          task.sessionId = result.sessionId;
          task.tokensUsed = result.tokensIn + result.tokensOut;
          task.costUsd = result.costUsd;
          task.durationMs = result.durationMs;
          task.completedAt = new Date();
          run.completedTasks++;

          // Update markdown in-memory — mark task as done
          doc.content = markTaskInMarkdown(doc.content, task.taskText);

          broadcast('maestro:playbook', {
            action: 'task:completed',
            runId: run.id,
            taskId: task.taskId,
            durationMs: result.durationMs,
            tokensUsed: task.tokensUsed,
            costUsd: result.costUsd,
          });

          log.info(
            { runId: run.id, taskId: task.taskId, durationMs: result.durationMs },
            `Task completed: ${task.taskText.slice(0, 60)}`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          task.status = 'failed';
          task.output = errMsg;
          task.completedAt = new Date();
          task.durationMs = task.startedAt ? Date.now() - task.startedAt.getTime() : 0;
          run.failedTasks++;

          broadcast('maestro:playbook', {
            action: 'task:failed',
            runId: run.id,
            taskId: task.taskId,
            error: errMsg,
          });

          log.error(
            { runId: run.id, taskId: task.taskId, err },
            `Task failed: ${task.taskText.slice(0, 60)}`,
          );
        }

        await persistRun(run);
      }
    }

    // Reset tasks for next loop iteration
    if (loop && pb.settings.resetOnCompletion) {
      for (const task of run.taskResults) {
        if (task.status === 'completed') task.status = 'pending';
      }
      run.completedTasks = 0;
      run.failedTasks = 0;
      log.info({ runId: run.id, loopCount: run.loopCount }, 'Playbook loop reset');
    }
  } while (loop && !pauseSignals.has(run.id));

  // Finalize run
  run.status = run.failedTasks > 0 && run.completedTasks === 0 ? 'failed' : 'completed';
  run.completedAt = new Date();
  await persistRun(run);

  // Cleanup worktree if created
  if (worktreeId) {
    try {
      await markWorktree(worktreeId, run.status === 'completed' ? 'completed' : 'failed');
    } catch (err) {
      log.warn({ worktreeId, err }, 'Failed to mark worktree');
    }
  }

  broadcast('maestro:playbook', {
    action: 'run:completed',
    runId: run.id,
    status: run.status,
    completedTasks: run.completedTasks,
    failedTasks: run.failedTasks,
    loopCount: run.loopCount,
  });

  log.info({ runId: run.id, status: run.status }, 'Playbook run finished');
}

/**
 * Pause a running playbook. The current task will complete before pausing.
 */
export function pausePlaybook(id: string): void {
  const run = activeRuns.get(id);
  if (!run || run.status !== 'running') {
    throw new Error(`No active run found: ${id}`);
  }
  pauseSignals.add(id);
  log.info({ runId: id }, 'Pause signal sent');
}

/**
 * Resume a paused playbook run.
 */
export async function resumePlaybook(
  id: string,
  opts?: { cwd?: string },
): Promise<PlaybookRun> {
  const run = activeRuns.get(id);
  if (!run || run.status !== 'paused') {
    throw new Error(`No paused run found: ${id}`);
  }

  const pb = await getPlaybook(run.playbookId);
  if (!pb) throw new Error(`Playbook not found: ${run.playbookId}`);

  pauseSignals.delete(id);
  run.status = 'running';
  await persistRun(run);

  broadcast('maestro:playbook', { action: 'run:resumed', runId: id });

  const cwd = opts?.cwd ?? process.cwd();
  executePlaybookRun(run, pb, cwd, pb.settings.loop).catch((err) => {
    log.error({ runId: id, err }, 'Resumed playbook run failed');
  });

  return run;
}

/**
 * Get the current state of a playbook run.
 */
export function getPlaybookRun(id: string): PlaybookRun | undefined {
  return activeRuns.get(id);
}

/**
 * Get a playbook run from DB (for historical runs).
 */
export async function getPlaybookRunFromDb(id: string): Promise<PlaybookRun | null> {
  const pool = getPool();
  if (!pool) return null;

  const { rows } = await pool.query(
    `SELECT id, playbook_id, status, current_doc_index, current_task_index,
       total_tasks, completed_tasks, failed_tasks, started_at, completed_at,
       loop_count, task_results
     FROM meow_playbook_runs WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.id,
    playbookId: r.playbook_id,
    status: r.status,
    currentDocIndex: r.current_doc_index,
    currentTaskIndex: r.current_task_index,
    totalTasks: r.total_tasks,
    completedTasks: r.completed_tasks,
    failedTasks: r.failed_tasks,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : undefined,
    loopCount: r.loop_count,
    taskResults: r.task_results,
  };
}

/**
 * Generate a playbook from a list of bead IDs.
 * Converts beads into a markdown document with checkbox tasks.
 */
export async function generatePlaybookFromBeads(
  beadIds: string[],
  name: string,
  agentId: string,
): Promise<Playbook> {
  const pool = getPool();
  if (!pool) throw new Error('Database required for bead lookup');

  const { rows } = await pool.query(
    `SELECT id, title, description, status FROM meow_beads
     WHERE id = ANY($1) ORDER BY created_at ASC`,
    [beadIds],
  );

  if (rows.length === 0) throw new Error('No beads found for the given IDs');

  // Build markdown document from beads
  const lines = [`# Playbook: ${name}`, '', `Generated from ${rows.length} beads.`, ''];

  for (const bead of rows) {
    const description = bead.description ? `: ${bead.description}` : '';
    lines.push(`- [ ] ${bead.title}${description}`);
  }

  const content = lines.join('\n');

  const doc: Omit<PlaybookDocument, 'id'> = {
    path: `playbooks/${name.replace(/\s+/g, '-').toLowerCase()}.md`,
    content,
    order: 0,
  };

  return createPlaybook(name, [doc], {
    loop: false,
    resetOnCompletion: false,
    worktreeDispatch: false,
    agentId,
  });
}
