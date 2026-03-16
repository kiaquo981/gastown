/**
 * BeadsService — Stage 02 Beads Core
 *
 * Git-backed issue tracking system inspired by Gas Town's Beads concept.
 * Manages bead lifecycle, dependencies (with cycle detection via Kahn's algorithm),
 * full-text search, activity logging, and statistics.
 */

import { getPool } from '../db/client';
import type {
  Bead,
  BeadStatus,
  BeadPriority,
  BeadDependency,
  DependencyType,
  ExecutorType,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBeadInput {
  title: string;
  description?: string;
  priority?: BeadPriority;
  executorType?: ExecutorType;
  bu?: string;
  rig?: string;
  skill?: string;
  formula?: string;
  tier?: 'S' | 'A' | 'B';
  labels?: Record<string, string>;
  assignee?: string;
  moleculeId?: string;
  convoyId?: string;
  parentId?: string;
  createdBy: string;
}

export interface UpdateBeadInput {
  title?: string;
  description?: string;
  status?: BeadStatus;
  priority?: BeadPriority;
  executorType?: ExecutorType;
  bu?: string;
  rig?: string;
  skill?: string;
  formula?: string;
  tier?: 'S' | 'A' | 'B';
  labels?: Record<string, string>;
  assignee?: string;
  moleculeId?: string;
  convoyId?: string;
  parentId?: string;
  artifacts?: string[];
  prUrl?: string;
  worktree?: string;
}

export interface ListBeadsFilter {
  status?: BeadStatus;
  bu?: string;
  rig?: string;
  assignee?: string;
  skill?: string;
  tier?: 'S' | 'A' | 'B';
  priority?: BeadPriority;
  moleculeId?: string;
  convoyId?: string;
  limit?: number;
  offset?: number;
}

export interface BeadStats {
  total: number;
  by_status: Record<string, number>;
  by_bu: Record<string, number>;
  by_rig: Record<string, number>;
  velocity: {
    closed_last_7d: number;
    closed_last_30d: number;
    avg_per_week: number;
  };
}

interface DependencyNode {
  id: string;
  title: string;
  status: BeadStatus;
  dependencies: BeadDependency[];
  children?: DependencyNode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STATUSES: BeadStatus[] = ['backlog', 'ready', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
const VALID_PRIORITIES: BeadPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_EXECUTOR_TYPES: ExecutorType[] = ['agent', 'worker', 'clone', 'human'];
const VALID_TIERS = ['S', 'A', 'B'] as const;
const VALID_DEP_TYPES: DependencyType[] = ['blocks', 'relates_to', 'duplicates', 'discovered_from'];

/** Map a DB row (snake_case) to a Bead object (camelCase) */
function rowToBead(row: Record<string, unknown>): Bead {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || undefined,
    status: row.status as BeadStatus,
    priority: row.priority as BeadPriority,
    executorType: row.executor_type as ExecutorType,
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
    dependencies: (row.dependencies as BeadDependency[]) || [],
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

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class BeadsService {
  private idCounter = 0;

  // ───────────── ID Generation ─────────────

  /**
   * Generate a bead ID: bd-XXXX (4-char hex).
   * Scales to 5 chars at 500 beads, 6 chars at 1500.
   */
  async generateId(): Promise<string> {
    const pool = getPool();
    let count = this.idCounter;

    if (pool) {
      try {
        const res = await pool.query('SELECT COUNT(*)::int AS cnt FROM beads');
        count = res.rows[0]?.cnt || 0;
      } catch {
        // fallback to in-memory counter
      }
    }

    let hexLen = 4;
    if (count >= 1500) hexLen = 6;
    else if (count >= 500) hexLen = 5;

    // Generate random hex and check for collisions
    for (let attempt = 0; attempt < 20; attempt++) {
      const bytes = new Uint8Array(Math.ceil(hexLen / 2));
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, hexLen);
      const id = `bd-${hex}`;

      if (pool) {
        const exists = await pool.query('SELECT 1 FROM beads WHERE id = $1', [id]);
        if (exists.rowCount === 0) {
          this.idCounter = count + 1;
          return id;
        }
      } else {
        this.idCounter++;
        return id;
      }
    }

    throw new Error('Failed to generate unique bead ID after 20 attempts');
  }

  // ───────────── Activity Log ─────────────

  private async logActivity(
    beadId: string,
    action: string,
    actor: string,
    oldValue?: Record<string, unknown> | null,
    newValue?: Record<string, unknown> | null,
  ): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO beads_activity_log (bead_id, action, actor, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5)`,
        [beadId, action, actor, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null],
      );
    } catch (err) {
      console.error(`[BeadsService] Failed to log activity for ${beadId}:`, err);
    }
  }

  // ───────────── CRUD ─────────────

  async create(input: CreateBeadInput): Promise<Bead> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    // Validate required fields
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('title is required');
    }
    if (!input.createdBy || input.createdBy.trim().length === 0) {
      throw new Error('createdBy is required');
    }

    // Validate enums
    const priority = input.priority || 'medium';
    if (!VALID_PRIORITIES.includes(priority)) {
      throw new Error(`Invalid priority: ${priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }

    const executorType = input.executorType || 'agent';
    if (!VALID_EXECUTOR_TYPES.includes(executorType)) {
      throw new Error(`Invalid executorType: ${executorType}. Must be one of: ${VALID_EXECUTOR_TYPES.join(', ')}`);
    }

    if (input.tier && !VALID_TIERS.includes(input.tier)) {
      throw new Error(`Invalid tier: ${input.tier}. Must be one of: ${VALID_TIERS.join(', ')}`);
    }

    // Validate parent exists if specified
    if (input.parentId) {
      const parent = await pool.query('SELECT id FROM beads WHERE id = $1', [input.parentId]);
      if (parent.rowCount === 0) {
        throw new Error(`Parent bead not found: ${input.parentId}`);
      }
    }

    const id = await this.generateId();

    const res = await pool.query(
      `INSERT INTO beads (
        id, title, description, status, priority, executor_type,
        bu, rig, skill, formula, tier, labels,
        assignee, molecule_id, convoy_id, parent_id,
        dependencies, created_by
      ) VALUES (
        $1, $2, $3, 'backlog', $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        '[]'::jsonb, $16
      ) RETURNING *`,
      [
        id,
        input.title.trim(),
        input.description?.trim() || null,
        priority,
        executorType,
        input.bu || null,
        input.rig || null,
        input.skill || null,
        input.formula || null,
        input.tier || null,
        JSON.stringify(input.labels || {}),
        input.assignee || null,
        input.moleculeId || null,
        input.convoyId || null,
        input.parentId || null,
        input.createdBy.trim(),
      ],
    );

    const bead = rowToBead(res.rows[0]);

    await this.logActivity(id, 'created', input.createdBy, null, {
      title: bead.title,
      priority,
      executorType,
      bu: input.bu,
    });

    return bead;
  }

  async get(id: string): Promise<Bead | null> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const res = await pool.query('SELECT * FROM beads WHERE id = $1', [id]);
    if (res.rowCount === 0) return null;
    return rowToBead(res.rows[0]);
  }

  async list(filters: ListBeadsFilter = {}): Promise<{ beads: Bead[]; total: number }> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters.bu) {
      conditions.push(`bu = $${paramIdx++}`);
      params.push(filters.bu);
    }
    if (filters.rig) {
      conditions.push(`rig = $${paramIdx++}`);
      params.push(filters.rig);
    }
    if (filters.assignee) {
      conditions.push(`assignee = $${paramIdx++}`);
      params.push(filters.assignee);
    }
    if (filters.skill) {
      conditions.push(`skill = $${paramIdx++}`);
      params.push(filters.skill);
    }
    if (filters.tier) {
      conditions.push(`tier = $${paramIdx++}`);
      params.push(filters.tier);
    }
    if (filters.priority) {
      conditions.push(`priority = $${paramIdx++}`);
      params.push(filters.priority);
    }
    if (filters.moleculeId) {
      conditions.push(`molecule_id = $${paramIdx++}`);
      params.push(filters.moleculeId);
    }
    if (filters.convoyId) {
      conditions.push(`convoy_id = $${paramIdx++}`);
      params.push(filters.convoyId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 100, 500);
    const offset = filters.offset || 0;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM beads ${where} ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM beads ${where}`, params),
    ]);

    return {
      beads: dataRes.rows.map(rowToBead),
      total: countRes.rows[0]?.total || 0,
    };
  }

  /**
   * Get beads that are ready to be worked on.
   * A bead is ready when:
   * - status is 'ready', OR status is 'backlog' with no blocking dependencies
   * - AND none of its 'blocks' dependencies are still open (not done/cancelled)
   */
  async ready(filters?: Omit<ListBeadsFilter, 'status'>): Promise<Bead[]> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    // Fetch candidate beads (ready + backlog)
    const conditions: string[] = ["status IN ('ready', 'backlog')"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.bu) {
      conditions.push(`bu = $${paramIdx++}`);
      params.push(filters.bu);
    }
    if (filters?.rig) {
      conditions.push(`rig = $${paramIdx++}`);
      params.push(filters.rig);
    }
    if (filters?.assignee) {
      conditions.push(`assignee = $${paramIdx++}`);
      params.push(filters.assignee);
    }
    if (filters?.skill) {
      conditions.push(`skill = $${paramIdx++}`);
      params.push(filters.skill);
    }
    if (filters?.tier) {
      conditions.push(`tier = $${paramIdx++}`);
      params.push(filters.tier);
    }
    if (filters?.priority) {
      conditions.push(`priority = $${paramIdx++}`);
      params.push(filters.priority);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const res = await pool.query(
      `SELECT * FROM beads ${where} ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        created_at ASC
       LIMIT 200`,
      params,
    );

    const candidates = res.rows.map(rowToBead);
    if (candidates.length === 0) return [];

    // For each candidate, check if all its blocking dependencies are resolved
    const readyBeads: Bead[] = [];

    for (const bead of candidates) {
      const blockingDeps = bead.dependencies.filter(d => d.type === 'blocks');

      if (blockingDeps.length === 0) {
        readyBeads.push(bead);
        continue;
      }

      // Check if all blocking targets are done/cancelled
      const targetIds = blockingDeps.map(d => d.targetId);
      const placeholders = targetIds.map((_, i) => `$${i + 1}`).join(', ');
      const depRes = await pool.query(
        `SELECT id, status FROM beads WHERE id IN (${placeholders})`,
        targetIds,
      );

      const allResolved = depRes.rows.every(
        (r: Record<string, unknown>) => r.status === 'done' || r.status === 'cancelled',
      );
      if (allResolved) {
        readyBeads.push(bead);
      }
    }

    return readyBeads;
  }

  async update(id: string, changes: UpdateBeadInput, actor: string = 'system'): Promise<Bead> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const existing = await this.get(id);
    if (!existing) throw new Error(`Bead not found: ${id}`);

    // Validate enums if provided
    if (changes.status && !VALID_STATUSES.includes(changes.status)) {
      throw new Error(`Invalid status: ${changes.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    if (changes.priority && !VALID_PRIORITIES.includes(changes.priority)) {
      throw new Error(`Invalid priority: ${changes.priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }
    if (changes.executorType && !VALID_EXECUTOR_TYPES.includes(changes.executorType)) {
      throw new Error(`Invalid executorType: ${changes.executorType}. Must be one of: ${VALID_EXECUTOR_TYPES.join(', ')}`);
    }
    if (changes.tier && !VALID_TIERS.includes(changes.tier)) {
      throw new Error(`Invalid tier: ${changes.tier}. Must be one of: ${VALID_TIERS.join(', ')}`);
    }

    // Build SET clause dynamically
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      status: 'status',
      priority: 'priority',
      executorType: 'executor_type',
      bu: 'bu',
      rig: 'rig',
      skill: 'skill',
      formula: 'formula',
      tier: 'tier',
      assignee: 'assignee',
      moleculeId: 'molecule_id',
      convoyId: 'convoy_id',
      parentId: 'parent_id',
      prUrl: 'pr_url',
      worktree: 'worktree',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in changes && (changes as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${col} = $${paramIdx++}`);
        params.push((changes as Record<string, unknown>)[key]);
      }
    }

    // Special handling for jsonb/array fields
    if (changes.labels !== undefined) {
      sets.push(`labels = $${paramIdx++}`);
      params.push(JSON.stringify(changes.labels));
    }
    if (changes.artifacts !== undefined) {
      sets.push(`artifacts = $${paramIdx++}`);
      params.push(changes.artifacts);
    }

    // Auto-set timestamps based on status changes
    if (changes.status === 'in_progress' && !existing.startedAt) {
      sets.push(`started_at = now()`);
    }
    if (changes.status === 'done' || changes.status === 'cancelled') {
      sets.push(`completed_at = now()`);
    }

    if (sets.length === 0) {
      return existing; // nothing to update
    }

    params.push(id);
    const res = await pool.query(
      `UPDATE beads SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );

    const updated = rowToBead(res.rows[0]);

    // Log specific changes
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    for (const key of Object.keys(changes)) {
      const existingVal = (existing as unknown as Record<string, unknown>)[key];
      const newVal = (changes as Record<string, unknown>)[key];
      if (existingVal !== newVal) {
        oldValues[key] = existingVal;
        newValues[key] = newVal;
      }
    }

    if (changes.status && changes.status !== existing.status) {
      await this.logActivity(id, 'status_changed', actor, { status: existing.status }, { status: changes.status });
    }
    if (changes.assignee && changes.assignee !== existing.assignee) {
      await this.logActivity(id, 'assigned', actor, { assignee: existing.assignee }, { assignee: changes.assignee });
    }
    if (Object.keys(newValues).length > 0) {
      await this.logActivity(id, 'updated', actor, oldValues, newValues);
    }

    return updated;
  }

  async close(id: string, completedBy: string): Promise<Bead> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const existing = await this.get(id);
    if (!existing) throw new Error(`Bead not found: ${id}`);

    if (existing.status === 'done') {
      return existing; // already closed
    }

    const res = await pool.query(
      `UPDATE beads SET status = 'done', completed_by = $1, completed_at = now()
       WHERE id = $2 RETURNING *`,
      [completedBy, id],
    );

    const closed = rowToBead(res.rows[0]);

    await this.logActivity(id, 'completed', completedBy, { status: existing.status }, { status: 'done' });

    // Check if closing this bead unblocks others
    await this.checkUnblocked(id);

    return closed;
  }

  /**
   * After closing a bead, check if any other beads that depend on it
   * (via 'blocks' type where this bead is the target) are now unblocked.
   */
  private async checkUnblocked(closedId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    // Find beads that have a 'blocks' dependency targeting the closed bead
    const res = await pool.query(
      `SELECT * FROM beads WHERE status = 'blocked' AND dependencies @> $1::jsonb`,
      [JSON.stringify([{ targetId: closedId, type: 'blocks' }])],
    );

    for (const row of res.rows) {
      const bead = rowToBead(row);
      const blockingDeps = bead.dependencies.filter(d => d.type === 'blocks');
      const remainingTargets = blockingDeps
        .map(d => d.targetId)
        .filter(tid => tid !== closedId);

      if (remainingTargets.length === 0) {
        // All blockers resolved, move to ready
        await pool.query(`UPDATE beads SET status = 'ready' WHERE id = $1`, [bead.id]);
        await this.logActivity(bead.id, 'status_changed', 'system', { status: 'blocked' }, { status: 'ready' });
      } else {
        // Check remaining blockers
        const placeholders = remainingTargets.map((_, i) => `$${i + 1}`).join(', ');
        const depRes = await pool.query(
          `SELECT id, status FROM beads WHERE id IN (${placeholders})`,
          remainingTargets,
        );
        const allResolved = depRes.rows.every(
          (r: Record<string, unknown>) => r.status === 'done' || r.status === 'cancelled',
        );
        if (allResolved) {
          await pool.query(`UPDATE beads SET status = 'ready' WHERE id = $1`, [bead.id]);
          await this.logActivity(bead.id, 'status_changed', 'system', { status: 'blocked' }, { status: 'ready' });
        }
      }
    }
  }

  // ───────────── Dependencies ─────────────

  /**
   * Add a dependency from one bead to another.
   * Runs cycle detection using Kahn's algorithm before committing.
   */
  async addDependency(fromId: string, toId: string, type: DependencyType): Promise<Bead> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    if (fromId === toId) throw new Error('A bead cannot depend on itself');

    if (!VALID_DEP_TYPES.includes(type)) {
      throw new Error(`Invalid dependency type: ${type}. Must be one of: ${VALID_DEP_TYPES.join(', ')}`);
    }

    // Verify both beads exist
    const [fromRes, toRes] = await Promise.all([
      pool.query('SELECT id, dependencies FROM beads WHERE id = $1', [fromId]),
      pool.query('SELECT id FROM beads WHERE id = $1', [toId]),
    ]);

    if (fromRes.rowCount === 0) throw new Error(`Bead not found: ${fromId}`);
    if (toRes.rowCount === 0) throw new Error(`Bead not found: ${toId}`);

    const currentDeps: BeadDependency[] = fromRes.rows[0].dependencies || [];

    // Check if dependency already exists
    if (currentDeps.some(d => d.targetId === toId && d.type === type)) {
      return (await this.get(fromId))!;
    }

    // Cycle detection for 'blocks' type
    if (type === 'blocks') {
      const hasCycle = await this.detectCycle(fromId, toId);
      if (hasCycle) {
        throw new Error(`Adding dependency ${fromId} -> ${toId} would create a cycle`);
      }
    }

    const newDeps = [...currentDeps, { targetId: toId, type }];

    const res = await pool.query(
      `UPDATE beads SET dependencies = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(newDeps), fromId],
    );

    await this.logActivity(fromId, 'dependency_added', 'system', null, { targetId: toId, type });

    return rowToBead(res.rows[0]);
  }

  async removeDependency(fromId: string, toId: string): Promise<Bead> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const fromRes = await pool.query('SELECT id, dependencies FROM beads WHERE id = $1', [fromId]);
    if (fromRes.rowCount === 0) throw new Error(`Bead not found: ${fromId}`);

    const currentDeps: BeadDependency[] = fromRes.rows[0].dependencies || [];
    const removed = currentDeps.filter(d => d.targetId === toId);
    const newDeps = currentDeps.filter(d => d.targetId !== toId);

    if (removed.length === 0) {
      return (await this.get(fromId))!;
    }

    const res = await pool.query(
      `UPDATE beads SET dependencies = $1 WHERE id = $2 RETURNING *`,
      [JSON.stringify(newDeps), fromId],
    );

    await this.logActivity(fromId, 'dependency_removed', 'system', { removed }, null);

    return rowToBead(res.rows[0]);
  }

  /**
   * Cycle detection via Kahn's algorithm (topological sort).
   * Returns true if adding edge fromId -> toId would create a cycle
   * within the 'blocks' dependency graph.
   */
  private async detectCycle(fromId: string, toId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;

    // Load all beads with their 'blocks' dependencies to build adjacency list
    const res = await pool.query(`SELECT id, dependencies FROM beads`);
    const rows = res.rows as { id: string; dependencies: BeadDependency[] }[];

    // Build adjacency: edge from A -> B means "A depends on B" (A is blocked by B)
    const adjList = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Initialize all nodes
    for (const row of rows) {
      if (!adjList.has(row.id)) adjList.set(row.id, new Set());
      if (!inDegree.has(row.id)) inDegree.set(row.id, 0);
    }

    // Build edges from existing dependencies
    for (const row of rows) {
      const blocksDeps = (row.dependencies || []).filter((d: BeadDependency) => d.type === 'blocks');
      for (const dep of blocksDeps) {
        if (!adjList.has(dep.targetId)) adjList.set(dep.targetId, new Set());
        if (!inDegree.has(dep.targetId)) inDegree.set(dep.targetId, 0);

        // Edge: targetId -> row.id (target must be done before row can proceed)
        adjList.get(dep.targetId)!.add(row.id);
        inDegree.set(row.id, (inDegree.get(row.id) || 0) + 1);
      }
    }

    // Add the proposed edge: toId -> fromId (toId must be done before fromId)
    if (!adjList.has(toId)) adjList.set(toId, new Set());
    if (!inDegree.has(toId)) inDegree.set(toId, 0);
    if (!adjList.has(fromId)) adjList.set(fromId, new Set());
    if (!inDegree.has(fromId)) inDegree.set(fromId, 0);

    adjList.get(toId)!.add(fromId);
    inDegree.set(fromId, (inDegree.get(fromId) || 0) + 1);

    // Kahn's algorithm: count nodes that can be topologically sorted
    const queue: string[] = [];
    for (const [node, degree] of inDegree.entries()) {
      if (degree === 0) queue.push(node);
    }

    let sortedCount = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      sortedCount++;

      const neighbors = adjList.get(node) || new Set();
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    const totalNodes = adjList.size;
    // If not all nodes were sorted, there is a cycle
    return sortedCount < totalNodes;
  }

  /**
   * Get full dependency tree for a bead (recursive).
   */
  async getDependencyTree(id: string): Promise<DependencyNode | null> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const visited = new Set<string>();

    const buildTree = async (beadId: string): Promise<DependencyNode | null> => {
      if (visited.has(beadId)) return null; // prevent infinite loops
      visited.add(beadId);

      const res = await pool.query('SELECT * FROM beads WHERE id = $1', [beadId]);
      if (res.rowCount === 0) return null;

      const bead = rowToBead(res.rows[0]);
      const children: DependencyNode[] = [];

      for (const dep of bead.dependencies) {
        const child = await buildTree(dep.targetId);
        if (child) children.push(child);
      }

      return {
        id: bead.id,
        title: bead.title,
        status: bead.status,
        dependencies: bead.dependencies,
        children: children.length > 0 ? children : undefined,
      };
    };

    return buildTree(id);
  }

  // ───────────── Statistics ─────────────

  async stats(): Promise<BeadStats> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const [totalRes, statusRes, buRes, rigRes, vel7Res, vel30Res] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM beads'),
      pool.query('SELECT status, COUNT(*)::int AS count FROM beads GROUP BY status'),
      pool.query('SELECT bu, COUNT(*)::int AS count FROM beads WHERE bu IS NOT NULL GROUP BY bu'),
      pool.query('SELECT rig, COUNT(*)::int AS count FROM beads WHERE rig IS NOT NULL GROUP BY rig'),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM beads
         WHERE status = 'done' AND completed_at >= now() - interval '7 days'`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM beads
         WHERE status = 'done' AND completed_at >= now() - interval '30 days'`,
      ),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusRes.rows) {
      byStatus[row.status] = row.count;
    }

    const byBu: Record<string, number> = {};
    for (const row of buRes.rows) {
      byBu[row.bu] = row.count;
    }

    const byRig: Record<string, number> = {};
    for (const row of rigRes.rows) {
      byRig[row.rig] = row.count;
    }

    const closed7d = vel7Res.rows[0]?.count || 0;
    const closed30d = vel30Res.rows[0]?.count || 0;

    return {
      total: totalRes.rows[0]?.total || 0,
      by_status: byStatus,
      by_bu: byBu,
      by_rig: byRig,
      velocity: {
        closed_last_7d: closed7d,
        closed_last_30d: closed30d,
        avg_per_week: closed30d > 0 ? Math.round((closed30d / 4.29) * 100) / 100 : 0,
      },
    };
  }

  // ───────────── Search ─────────────

  async search(query: string): Promise<Bead[]> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    if (!query || query.trim().length === 0) {
      return [];
    }

    const res = await pool.query(
      `SELECT *, ts_rank(
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')),
        plainto_tsquery('english', $1)
       ) AS rank
       FROM beads
       WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
             @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT 50`,
      [query.trim()],
    );

    return res.rows.map(rowToBead);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

let instance: BeadsService | null = null;

export function getBeadsService(): BeadsService {
  if (!instance) {
    instance = new BeadsService();
  }
  return instance;
}

export default BeadsService;
