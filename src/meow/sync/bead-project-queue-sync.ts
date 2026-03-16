/**
 * BeadProjectQueueSync — LP-030 Stage 04 Wave 6
 *
 * Bidirectional sync between Beads and the ProjectQueue scheduler.
 * - Bead status='ready' -> automatically creates a Task in the scheduler
 * - Task completed -> marks Bead as 'done'
 * - Task failed -> marks Bead as 'blocked'
 * - Bead cancelled -> removes Task from queue
 *
 * Uses the existing taskBus EventEmitter for task lifecycle events.
 * Polls for new ready beads every 30 seconds.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { tasks, taskBus } from '../../stores';
import type { Bead, BeadStatus } from '../types';
import type { Task } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface SyncMapping {
  beadId: string;
  taskId: string;
  syncedAt: Date;
}

type TaskDonePayload = {
  taskId: string;
  projectId?: string;
  status: 'completed' | 'failed';
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function rowToBead(row: Record<string, unknown>): Bead {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || undefined,
    status: row.status as BeadStatus,
    priority: row.priority as Bead['priority'],
    executorType: row.executor_type as Bead['executorType'],
    bu: (row.bu as string) || undefined,
    rig: (row.rig as string) || undefined,
    skill: (row.skill as string) || undefined,
    formula: (row.formula as string) || undefined,
    tier: (row.tier as 'S' | 'A' | 'B') || undefined,
    labels: (row.labels as Record<string, string>) || {},
    assignee: (row.assignee as string) || undefined,
    moleculeId: (row.molecule_id as string) || undefined,
    convoyId: (row.convoy_id as string) || undefined,
    parentId: (row.parent_id as string) || undefined,
    dependencies: (row.dependencies as Bead['dependencies']) || [],
    artifacts: (row.artifacts as string[]) || undefined,
    prUrl: (row.pr_url as string) || undefined,
    worktree: (row.worktree as string) || undefined,
    createdBy: row.created_by as string,
    completedBy: (row.completed_by as string) || undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
  };
}

/** Map bead priority to task priority string understood by scheduler */
function mapPriority(priority: Bead['priority']): string {
  const MAP: Record<string, string> = {
    critical: 'urgent',
    high: 'high',
    medium: 'normal',
    low: 'low',
  };
  return MAP[priority] || 'normal';
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const TAG = '[BeadProjectQueueSync]';

export class BeadProjectQueueSync {
  private beadToTask: Map<string, string> = new Map();
  private taskToBead: Map<string, string> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private taskDoneHandler: ((payload: TaskDonePayload) => void) | null = null;

  // ───────────── Lifecycle ─────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    // Listen for task lifecycle events
    this.taskDoneHandler = (payload: TaskDonePayload) => {
      this.onTaskDone(payload.taskId, payload.status).catch((err) => {
        console.error(`${TAG} Error handling task:done for ${payload.taskId}:`, err);
      });
    };
    taskBus.on('task:done', this.taskDoneHandler);

    // Start polling for ready beads
    this.pollTimer = setInterval(() => {
      this.pollReadyBeads().catch((err) => {
        console.error(`${TAG} Poll error:`, err);
      });
    }, POLL_INTERVAL_MS);

    // Initial poll
    this.pollReadyBeads().catch(() => {});
    console.info(`${TAG} Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.taskDoneHandler) {
      taskBus.off('task:done', this.taskDoneHandler);
      this.taskDoneHandler = null;
    }

    console.info(`${TAG} Stopped`);
  }

  // ───────────── Bead -> Task ─────────────

  async syncBeadToTask(beadId: string): Promise<string> {
    // Check if already mapped
    const existing = this.beadToTask.get(beadId);
    if (existing && tasks.has(existing)) return existing;

    // Load bead from DB
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const res = await pool.query('SELECT * FROM beads WHERE id = $1', [beadId]);
    if (res.rowCount === 0) throw new Error(`Bead not found: ${beadId}`);

    const bead = rowToBead(res.rows[0]);
    if (bead.status !== 'ready' && bead.status !== 'backlog') {
      throw new Error(`Bead ${beadId} is not in a syncable state: ${bead.status}`);
    }

    // Create a Task in the scheduler store
    const taskId = `task-bead-${beadId}`;
    const task: Task = {
      id: taskId,
      projectId: bead.moleculeId || 'beads',
      type: bead.skill || 'bead-work',
      status: 'pending',
      priority: mapPriority(bead.priority),
      input: {
        beadId: bead.id,
        title: bead.title,
        description: bead.description || '',
        bu: bead.bu,
        rig: bead.rig,
        labels: bead.labels,
      },
      output: null,
      assignedAgent: bead.assignee || null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    } as unknown as Task;

    tasks.set(taskId, task);
    this.beadToTask.set(beadId, taskId);
    this.taskToBead.set(taskId, beadId);

    // Update bead status to in_progress
    await pool.query(
      `UPDATE beads SET status = 'in_progress', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1`,
      [beadId],
    );

    broadcast('meow:beads', { action: 'synced_to_task', beadId, taskId });
    console.info(`${TAG} Bead ${beadId} -> Task ${taskId}`);

    return taskId;
  }

  // ───────────── Task -> Bead ─────────────

  async syncTaskToBead(taskId: string, status: 'completed' | 'failed'): Promise<void> {
    const beadId = this.taskToBead.get(taskId);
    if (!beadId) return; // not a bead-linked task

    const pool = getPool();
    if (!pool) return;

    const beadStatus: BeadStatus = status === 'completed' ? 'done' : 'blocked';
    const extras = beadStatus === 'done' ? ", completed_at = now(), completed_by = 'scheduler'" : '';

    try {
      await pool.query(
        `UPDATE beads SET status = $1${extras}, updated_at = now() WHERE id = $2`,
        [beadStatus, beadId],
      );

      broadcast('meow:beads', { action: 'synced_from_task', beadId, taskId, status: beadStatus });
      console.info(`${TAG} Task ${taskId} (${status}) -> Bead ${beadId} (${beadStatus})`);
    } catch (err) {
      console.error(`${TAG} Failed to sync task ${taskId} -> bead ${beadId}:`, err);
    }
  }

  // ───────────── Bead Cancelled -> Remove Task ─────────────

  async onBeadCancelled(beadId: string): Promise<void> {
    const taskId = this.beadToTask.get(beadId);
    if (!taskId) return;

    tasks.delete(taskId);
    this.beadToTask.delete(beadId);
    this.taskToBead.delete(taskId);

    broadcast('meow:beads', { action: 'task_removed', beadId, taskId, reason: 'bead_cancelled' });
    console.info(`${TAG} Bead ${beadId} cancelled -> removed Task ${taskId}`);
  }

  // ───────────── Mapping Access ─────────────

  getMapping(): Map<string, string> {
    return new Map(this.beadToTask);
  }

  getTaskForBead(beadId: string): string | undefined {
    return this.beadToTask.get(beadId);
  }

  getBeadForTask(taskId: string): string | undefined {
    return this.taskToBead.get(taskId);
  }

  // ───────────── Internal ─────────────

  private async onTaskDone(taskId: string, status: 'completed' | 'failed'): Promise<void> {
    if (!this.taskToBead.has(taskId)) return;
    await this.syncTaskToBead(taskId, status);

    // Cleanup mapping after sync
    const beadId = this.taskToBead.get(taskId);
    if (beadId) {
      this.beadToTask.delete(beadId);
      this.taskToBead.delete(taskId);
    }
  }

  private async pollReadyBeads(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Find beads in 'ready' state that are not yet mapped to tasks
      const res = await pool.query(
        `SELECT * FROM beads WHERE status = 'ready' ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
           created_at ASC
         LIMIT 20`,
      );

      let synced = 0;
      for (const row of res.rows) {
        const bead = rowToBead(row);
        if (this.beadToTask.has(bead.id)) continue; // already mapped

        try {
          await this.syncBeadToTask(bead.id);
          synced++;
        } catch (err) {
          console.error(`${TAG} Failed to sync ready bead ${bead.id}:`, err);
        }
      }

      if (synced > 0) {
        console.info(`${TAG} Poll: synced ${synced} ready beads to tasks`);
      }
    } catch (err) {
      console.error(`${TAG} Poll query failed:`, err);
    }
  }
}
