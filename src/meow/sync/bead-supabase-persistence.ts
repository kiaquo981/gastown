/**
 * BeadPersistenceEnhanced — LP-029 Stage 04 Wave 6
 *
 * Enhanced Supabase persistence layer for Beads:
 * - Cursor-based pagination (keyset, not offset)
 * - Batch operations: bulk create, bulk status update
 * - Archive: move old completed beads to archive table (>90 days)
 * - Stats cache: precomputed stats refreshed every 5 min
 * - Full-text search index maintenance
 * - Flexible query builder: filter by any field combination
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Bead, BeadStatus, BeadPriority } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface BeadQueryFilters {
  status?: BeadStatus | BeadStatus[];
  priority?: BeadPriority | BeadPriority[];
  bu?: string;
  rig?: string;
  assignee?: string;
  skill?: string;
  tier?: 'S' | 'A' | 'B';
  moleculeId?: string;
  convoyId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  search?: string;
  cursor?: string;          // opaque cursor (base64-encoded id + created_at)
  limit?: number;
  sortBy?: 'created_at' | 'updated_at' | 'priority';
  sortDir?: 'asc' | 'desc';
}

export interface BeadQueryResult {
  beads: Bead[];
  cursor: string | null;
  total: number;
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
  computedAt: Date;
}

interface CursorData {
  id: string;
  ts: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function encodeCursor(id: string, ts: Date): string {
  const data: CursorData = { id, ts: ts.toISOString() };
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeCursor(cursor: string): CursorData | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const data = JSON.parse(json) as CursorData;
    if (!data.id || !data.ts) return null;
    return data;
  } catch {
    return null;
  }
}

function rowToBead(row: Record<string, unknown>): Bead {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || undefined,
    status: row.status as BeadStatus,
    priority: row.priority as BeadPriority,
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

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

const STATS_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class BeadPersistenceEnhanced {
  private statsCache: BeadStats | null = null;
  private statsCacheTime = 0;

  // ───────────── Query Builder ─────────────

  async queryBeads(filters: BeadQueryFilters): Promise<BeadQueryResult> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      const placeholders = statuses.map(() => `$${idx++}`);
      conditions.push(`status IN (${placeholders.join(', ')})`);
      params.push(...statuses);
    }
    if (filters.priority) {
      const priorities = Array.isArray(filters.priority) ? filters.priority : [filters.priority];
      const placeholders = priorities.map(() => `$${idx++}`);
      conditions.push(`priority IN (${placeholders.join(', ')})`);
      params.push(...priorities);
    }
    if (filters.bu) { conditions.push(`bu = $${idx++}`); params.push(filters.bu); }
    if (filters.rig) { conditions.push(`rig = $${idx++}`); params.push(filters.rig); }
    if (filters.assignee) { conditions.push(`assignee = $${idx++}`); params.push(filters.assignee); }
    if (filters.skill) { conditions.push(`skill = $${idx++}`); params.push(filters.skill); }
    if (filters.tier) { conditions.push(`tier = $${idx++}`); params.push(filters.tier); }
    if (filters.moleculeId) { conditions.push(`molecule_id = $${idx++}`); params.push(filters.moleculeId); }
    if (filters.convoyId) { conditions.push(`convoy_id = $${idx++}`); params.push(filters.convoyId); }
    if (filters.createdAfter) { conditions.push(`created_at >= $${idx++}`); params.push(filters.createdAfter.toISOString()); }
    if (filters.createdBefore) { conditions.push(`created_at <= $${idx++}`); params.push(filters.createdBefore.toISOString()); }

    if (filters.search) {
      conditions.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')) @@ plainto_tsquery('english', $${idx++})`);
      params.push(filters.search);
    }

    // Cursor-based pagination (keyset)
    const sortCol = filters.sortBy || 'created_at';
    const sortDir = filters.sortDir || 'desc';
    const comparator = sortDir === 'desc' ? '<' : '>';

    if (filters.cursor) {
      const c = decodeCursor(filters.cursor);
      if (c) {
        conditions.push(`(${sortCol}, id) ${comparator} ($${idx++}, $${idx++})`);
        params.push(c.ts, c.id);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 50, 500);

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM beads ${where} ORDER BY ${sortCol} ${sortDir}, id ${sortDir} LIMIT $${idx++}`,
        [...params, limit],
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM beads ${where}`, params),
    ]);

    const beads = dataRes.rows.map(rowToBead);
    const last = beads[beads.length - 1];
    const nextCursor = last
      ? encodeCursor(last.id, sortCol === 'updated_at' ? last.updatedAt : last.createdAt)
      : null;

    return { beads, cursor: nextCursor, total: countRes.rows[0]?.total || 0 };
  }

  // ───────────── Batch Operations ─────────────

  async batchCreate(beads: Partial<Bead>[]): Promise<Bead[]> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');
    if (beads.length === 0) return [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results: Bead[] = [];

      for (const b of beads) {
        const res = await client.query(
          `INSERT INTO beads (id, title, description, status, priority, executor_type, bu, rig, skill, formula, tier, labels, assignee, molecule_id, convoy_id, parent_id, dependencies, created_by)
           VALUES (gen_random_uuid()::text, $1, $2, 'backlog', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '[]'::jsonb, $15)
           RETURNING *`,
          [
            b.title || 'Untitled', b.description || null, b.priority || 'medium',
            b.executorType || 'agent', b.bu || null, b.rig || null, b.skill || null,
            b.formula || null, b.tier || null, JSON.stringify(b.labels || {}),
            b.assignee || null, b.moleculeId || null, b.convoyId || null,
            b.parentId || null, b.createdBy || 'system',
          ],
        );
        results.push(rowToBead(res.rows[0]));
      }

      await client.query('COMMIT');
      broadcast('meow:beads', { action: 'batch_created', count: results.length });
      return results;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Batch create failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  async batchUpdateStatus(ids: string[], status: BeadStatus): Promise<number> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');
    if (ids.length === 0) return 0;

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
    const extras = status === 'done' || status === 'cancelled'
      ? ', completed_at = now()'
      : status === 'in_progress'
        ? ', started_at = COALESCE(started_at, now())'
        : '';

    const res = await pool.query(
      `UPDATE beads SET status = $1${extras}, updated_at = now() WHERE id IN (${placeholders}) RETURNING id`,
      [status, ...ids],
    );

    const updated = res.rowCount || 0;
    if (updated > 0) {
      broadcast('meow:beads', { action: 'batch_status_updated', status, count: updated });
    }
    return updated;
  }

  // ───────────── Archive ─────────────

  async archiveOld(olderThanDays: number = 90): Promise<number> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Ensure archive table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS beads_archive (LIKE beads INCLUDING ALL)
      `);

      const safeDays = Math.max(1, Math.floor(olderThanDays));
      const moved = await client.query(
        `WITH archived AS (
           DELETE FROM beads
           WHERE status IN ('done', 'cancelled') AND completed_at < now() - make_interval(days => $1)
           RETURNING *
         )
         INSERT INTO beads_archive SELECT * FROM archived RETURNING id`,
        [safeDays],
      );

      await client.query('COMMIT');
      const count = moved.rowCount || 0;

      if (count > 0) {
        broadcast('meow:beads', { action: 'archived', count, olderThanDays });
        console.info(`[BeadPersistence] Archived ${count} beads older than ${olderThanDays} days`);
      }
      return count;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  // ───────────── Stats Cache ─────────────

  async refreshStatsCache(): Promise<BeadStats> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    const [totalRes, statusRes, buRes, rigRes, vel7Res, vel30Res] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM beads'),
      pool.query('SELECT status, COUNT(*)::int AS count FROM beads GROUP BY status'),
      pool.query('SELECT bu, COUNT(*)::int AS count FROM beads WHERE bu IS NOT NULL GROUP BY bu'),
      pool.query('SELECT rig, COUNT(*)::int AS count FROM beads WHERE rig IS NOT NULL GROUP BY rig'),
      pool.query(`SELECT COUNT(*)::int AS count FROM beads WHERE status = 'done' AND completed_at >= now() - interval '7 days'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM beads WHERE status = 'done' AND completed_at >= now() - interval '30 days'`),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusRes.rows) byStatus[row.status] = row.count;

    const byBu: Record<string, number> = {};
    for (const row of buRes.rows) byBu[row.bu] = row.count;

    const byRig: Record<string, number> = {};
    for (const row of rigRes.rows) byRig[row.rig] = row.count;

    const closed7d = vel7Res.rows[0]?.count || 0;
    const closed30d = vel30Res.rows[0]?.count || 0;

    this.statsCache = {
      total: totalRes.rows[0]?.total || 0,
      by_status: byStatus,
      by_bu: byBu,
      by_rig: byRig,
      velocity: {
        closed_last_7d: closed7d,
        closed_last_30d: closed30d,
        avg_per_week: closed30d > 0 ? Math.round((closed30d / 4.29) * 100) / 100 : 0,
      },
      computedAt: new Date(),
    };
    this.statsCacheTime = Date.now();

    return this.statsCache;
  }

  getCachedStats(): BeadStats | null {
    if (!this.statsCache) return null;
    if (Date.now() - this.statsCacheTime > STATS_TTL_MS) return null;
    return this.statsCache;
  }

  async getStats(): Promise<BeadStats> {
    const cached = this.getCachedStats();
    if (cached) return cached;
    return this.refreshStatsCache();
  }
}
