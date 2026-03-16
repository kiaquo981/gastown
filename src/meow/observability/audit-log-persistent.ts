/**
 * PERSISTENT AUDIT LOG — LP-040 (Stage 04 Wave 8)
 *
 * Immutable audit trail for ALL MEOW operations.
 * No UPDATE or DELETE on the audit table.
 * Queryable by actor, action, entityType, entityId, date range.
 * Retention: 90 days (auto-cleanup).
 * Exportable: CSV/JSON.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuditAction =
  // Molecule lifecycle
  | 'molecule.cook'
  | 'molecule.pour'
  | 'molecule.wisp'
  | 'molecule.squash'
  | 'molecule.burn'
  | 'molecule.complete'
  | 'molecule.fail'
  // Step transitions
  | 'step.pending'
  | 'step.running'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  // Worker events
  | 'worker.spawn'
  | 'worker.assign'
  | 'worker.complete'
  | 'worker.fail'
  | 'worker.kill'
  | 'worker.idle'
  // Gate events
  | 'gate.request'
  | 'gate.approve'
  | 'gate.reject'
  | 'gate.timeout'
  // Mail events
  | 'mail.send'
  | 'mail.read'
  | 'mail.escalate'
  // Config changes
  | 'config.formula_update'
  | 'config.skill_register'
  | 'config.trigger_add'
  | 'config.trigger_remove'
  // System
  | 'system.startup'
  | 'system.shutdown'
  | 'system.error';

export type AuditEntityType =
  | 'molecule'
  | 'step'
  | 'worker'
  | 'gate'
  | 'mail'
  | 'formula'
  | 'skill'
  | 'trigger'
  | 'system';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  actor: string;             // Worker ID, system, user, etc.
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  details?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditQueryFilters {
  actor?: string;
  action?: AuditAction;
  entityType?: AuditEntityType;
  entityId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditStats {
  totalEntries: number;
  byAction: Record<string, number>;
  byEntityType: Record<string, number>;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PersistentAuditLog
// ─────────────────────────────────────────────────────────────────────────────

export class PersistentAuditLog {
  private recentEntries: AuditEntry[] = [];
  private maxInMemory = 2_000;
  private retentionDays: number;

  constructor(retentionDays = 90) {
    this.retentionDays = retentionDays;
  }

  // ─── Log an event (immutable) ────────────────────────────────────────

  async log(
    actor: string,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId: string,
    details?: string,
    metadata?: Record<string, unknown>,
  ): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      actor,
      action,
      entityType,
      entityId,
      details,
      metadata,
    };

    // In-memory ring buffer for fast recent access
    this.recentEntries.push(entry);
    if (this.recentEntries.length > this.maxInMemory) {
      this.recentEntries = this.recentEntries.slice(-this.maxInMemory);
    }

    // Persist to DB (immutable INSERT only)
    await this.persistEntry(entry);

    // Broadcast for real-time UI
    broadcast('meow:townlog', {
      type: 'audit',
      entry: {
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details,
        timestamp: entry.timestamp.toISOString(),
      },
    });

    return entry;
  }

  // ─── Query ───────────────────────────────────────────────────────────

  async query(filters: AuditQueryFilters): Promise<{ entries: AuditEntry[]; total: number }> {
    const pool = getPool();

    // Fallback to in-memory if no DB
    if (!pool) {
      return this.queryInMemory(filters);
    }

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (filters.actor) {
        conditions.push(`actor = $${paramIdx++}`);
        params.push(filters.actor);
      }
      if (filters.action) {
        conditions.push(`action = $${paramIdx++}`);
        params.push(filters.action);
      }
      if (filters.entityType) {
        conditions.push(`entity_type = $${paramIdx++}`);
        params.push(filters.entityType);
      }
      if (filters.entityId) {
        conditions.push(`entity_id = $${paramIdx++}`);
        params.push(filters.entityId);
      }
      if (filters.since) {
        conditions.push(`created_at >= $${paramIdx++}`);
        params.push(filters.since.toISOString());
      }
      if (filters.until) {
        conditions.push(`created_at <= $${paramIdx++}`);
        params.push(filters.until.toISOString());
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = filters.limit ?? 100;
      const offset = filters.offset ?? 0;

      // Count query
      const countRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM meow_audit_log ${whereClause}`,
        params,
      );
      const total = parseInt(countRes.rows[0].cnt as string);

      // Data query
      const dataRes = await pool.query(
        `SELECT id, created_at, actor, action, entity_type, entity_id, details, metadata
         FROM meow_audit_log
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      const entries: AuditEntry[] = dataRes.rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        timestamp: new Date(r.created_at as string),
        actor: r.actor as string,
        action: r.action as AuditAction,
        entityType: r.entity_type as AuditEntityType,
        entityId: r.entity_id as string,
        details: (r.details as string) ?? undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));

      return { entries, total };
    } catch (err) {
      console.error('[AuditLog] Query failed, falling back to in-memory:', err);
      return this.queryInMemory(filters);
    }
  }

  private queryInMemory(filters: AuditQueryFilters): { entries: AuditEntry[]; total: number } {
    let filtered = [...this.recentEntries];

    if (filters.actor) filtered = filtered.filter(e => e.actor === filters.actor);
    if (filters.action) filtered = filtered.filter(e => e.action === filters.action);
    if (filters.entityType) filtered = filtered.filter(e => e.entityType === filters.entityType);
    if (filters.entityId) filtered = filtered.filter(e => e.entityId === filters.entityId);
    if (filters.since) filtered = filtered.filter(e => e.timestamp >= filters.since!);
    if (filters.until) filtered = filtered.filter(e => e.timestamp <= filters.until!);

    const total = filtered.length;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    const entries = filtered
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(offset, offset + limit);

    return { entries, total };
  }

  // ─── Export ──────────────────────────────────────────────────────────

  async export(format: 'csv' | 'json', filters?: AuditQueryFilters): Promise<string> {
    const { entries } = await this.query({
      ...filters,
      limit: filters?.limit ?? 10_000,
    });

    if (format === 'json') {
      return JSON.stringify(entries, null, 2);
    }

    // CSV
    const header = 'id,timestamp,actor,action,entity_type,entity_id,details';
    const rows = entries.map(e => {
      const details = (e.details ?? '').replace(/"/g, '""');
      return `${e.id},${e.timestamp.toISOString()},${e.actor},${e.action},${e.entityType},${e.entityId},"${details}"`;
    });

    return [header, ...rows].join('\n');
  }

  // ─── Cleanup (retention policy) ─────────────────────────────────────

  async cleanup(olderThanDays?: number): Promise<number> {
    const days = olderThanDays ?? this.retentionDays;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const pool = getPool();
    if (!pool) {
      // In-memory cleanup
      const before = this.recentEntries.length;
      this.recentEntries = this.recentEntries.filter(e => e.timestamp >= cutoff);
      return before - this.recentEntries.length;
    }

    try {
      const result = await pool.query(
        `DELETE FROM meow_audit_log WHERE created_at < $1`,
        [cutoff.toISOString()],
      );
      const deleted = result.rowCount ?? 0;
      console.info(`[AuditLog] Cleaned up ${deleted} entries older than ${days} days`);
      return deleted;
    } catch (err) {
      console.error('[AuditLog] Cleanup failed:', err);
      return 0;
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  async getStats(): Promise<AuditStats> {
    const pool = getPool();

    if (!pool) {
      return this.getStatsInMemory();
    }

    try {
      const totalRes = await pool.query(`SELECT COUNT(*) AS cnt FROM meow_audit_log`);
      const total = parseInt(totalRes.rows[0].cnt as string);

      const byActionRes = await pool.query(
        `SELECT action, COUNT(*) AS cnt FROM meow_audit_log GROUP BY action ORDER BY cnt DESC`,
      );
      const byAction: Record<string, number> = {};
      for (const row of byActionRes.rows) {
        byAction[row.action as string] = parseInt(row.cnt as string);
      }

      const byTypeRes = await pool.query(
        `SELECT entity_type, COUNT(*) AS cnt FROM meow_audit_log GROUP BY entity_type ORDER BY cnt DESC`,
      );
      const byEntityType: Record<string, number> = {};
      for (const row of byTypeRes.rows) {
        byEntityType[row.entity_type as string] = parseInt(row.cnt as string);
      }

      const boundsRes = await pool.query(
        `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM meow_audit_log`,
      );
      const oldest = boundsRes.rows[0].oldest ? new Date(boundsRes.rows[0].oldest) : null;
      const newest = boundsRes.rows[0].newest ? new Date(boundsRes.rows[0].newest) : null;

      return { totalEntries: total, byAction, byEntityType, oldestEntry: oldest, newestEntry: newest };
    } catch (err) {
      console.error('[AuditLog] Stats query failed:', err);
      return this.getStatsInMemory();
    }
  }

  private getStatsInMemory(): AuditStats {
    const byAction: Record<string, number> = {};
    const byEntityType: Record<string, number> = {};

    for (const e of this.recentEntries) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      byEntityType[e.entityType] = (byEntityType[e.entityType] ?? 0) + 1;
    }

    const sorted = [...this.recentEntries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      totalEntries: this.recentEntries.length,
      byAction,
      byEntityType,
      oldestEntry: sorted.length > 0 ? sorted[0].timestamp : null,
      newestEntry: sorted.length > 0 ? sorted[sorted.length - 1].timestamp : null,
    };
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  private async persistEntry(entry: AuditEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_audit_log
          (id, created_at, actor, action, entity_type, entity_id, details, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entry.id,
          entry.timestamp.toISOString(),
          entry.actor,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.details ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ],
      );
    } catch (err) {
      console.error('[AuditLog] Failed to persist entry:', err);
    }
  }

  getRecentCount(): number {
    return this.recentEntries.length;
  }
}
