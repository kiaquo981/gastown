/**
 * GAS TOWN CHRONICLE — SG-018 (Stage 06 Wave 5)
 *
 * Immutable event-sourced log of ALL Gas Town history.
 * Every significant event that occurs in Gas Town is recorded here —
 * an append-only ledger that enables full state reconstruction.
 *
 * Features:
 *   - Event types: molecule_created, bead_assigned, formula_executed, worker_spawned, etc.
 *   - Append-only: events are NEVER deleted or modified
 *   - Replay capability: reconstruct state at any point in time by replaying events
 *   - Cursor-based pagination for efficient querying
 *   - Event enrichment: each event includes context (who, what, when, why, impact)
 *   - Aggregation views: daily/weekly/monthly summaries auto-generated
 *   - Export: JSON/CSV/JSONL for external analysis
 *   - DB table: meow_chronicle (append-only, indexed by timestamp + type)
 *   - Retention: configurable (default 365 days, then archive)
 *   - Real-time: broadcast events on SSE for live chronicle viewer
 *
 * Gas Town: "History written in gas fumes — permanent, indelible, and always on the record."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gastown-chronicle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChronicleEventType =
  | 'molecule_created'
  | 'molecule_completed'
  | 'molecule_failed'
  | 'bead_assigned'
  | 'bead_completed'
  | 'bead_failed'
  | 'formula_executed'
  | 'formula_failed'
  | 'worker_spawned'
  | 'worker_terminated'
  | 'worker_assigned'
  | 'crisis_started'
  | 'crisis_resolved'
  | 'phase_transition'
  | 'schedule_generated'
  | 'budget_alert'
  | 'decision_made'
  | 'memory_consolidated'
  | 'reputation_changed'
  | 'instance_started'
  | 'instance_stopped'
  | 'maintenance_started'
  | 'maintenance_completed'
  | 'federation_sync'
  | 'council_meeting'
  | 'override_applied'
  | 'custom';

export type EventSeverity = 'trace' | 'info' | 'warning' | 'error' | 'critical';

export type ExportFormat = 'json' | 'csv' | 'jsonl';

export interface ChronicleEvent {
  id: string;
  sequence: number;                   // monotonically increasing
  type: ChronicleEventType;
  severity: EventSeverity;
  actor: EventActor;
  subject: EventSubject;
  payload: Record<string, unknown>;
  impact: EventImpact;
  tags: string[];
  instanceId?: string;
  correlationId?: string;             // links related events
  parentEventId?: string;             // causal chain
  timestamp: Date;
}

export interface EventActor {
  type: 'worker' | 'formula' | 'system' | 'operator' | 'ai' | 'scheduler';
  id: string;
  name?: string;
}

export interface EventSubject {
  type: 'molecule' | 'bead' | 'formula' | 'worker' | 'instance' | 'budget' | 'schedule' | 'system';
  id: string;
  name?: string;
}

export interface EventImpact {
  level: 'none' | 'low' | 'medium' | 'high' | 'critical';
  description?: string;
  costUsd?: number;
  affectedWorkers?: number;
  affectedMolecules?: number;
}

export interface ChronicleQuery {
  types?: ChronicleEventType[];
  severity?: EventSeverity[];
  instanceId?: string;
  correlationId?: string;
  actorId?: string;
  subjectId?: string;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  cursor?: string;                    // last event ID for pagination
  limit?: number;
  tags?: string[];
}

export interface ChroniclePageResult {
  events: ChronicleEvent[];
  nextCursor: string | null;
  totalEstimate: number;
  hasMore: boolean;
}

export interface AggregationPeriod {
  period: 'daily' | 'weekly' | 'monthly';
  startDate: string;
  endDate: string;
  totalEvents: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  topActors: Array<{ id: string; name?: string; count: number }>;
  topSubjects: Array<{ id: string; name?: string; count: number }>;
  avgEventsPerHour: number;
  peakHour: number;
  totalCostImpactUsd: number;
}

export interface ChronicleStats {
  totalEvents: number;
  eventsSinceStartup: number;
  eventsToday: number;
  currentSequence: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  oldestEvent: Date | null;
  newestEvent: Date | null;
  retentionDays: number;
  archivedCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS_IN_MEMORY = 10000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const DEFAULT_RETENTION_DAYS = 365;
const AGGREGATION_CACHE_TTL_MS = 300_000; // 5 minutes
const SEVERITY_ORDER: Record<EventSeverity, number> = {
  trace: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

// ---------------------------------------------------------------------------
// GasTownChronicle
// ---------------------------------------------------------------------------

export class GasTownChronicle {
  private events: ChronicleEvent[] = [];
  private sequenceCounter = 0;
  private retentionDays = DEFAULT_RETENTION_DAYS;
  private aggregationCache = new Map<string, { data: AggregationPeriod; expiresAt: number }>();
  private stats: ChronicleStats = {
    totalEvents: 0,
    eventsSinceStartup: 0,
    eventsToday: 0,
    currentSequence: 0,
    byType: {},
    bySeverity: {},
    oldestEvent: null,
    newestEvent: null,
    retentionDays: DEFAULT_RETENTION_DAYS,
    archivedCount: 0,
  };
  private todayDate = new Date().toISOString().slice(0, 10);
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadSequenceFromDb();
    await this.loadRecentEvents();
    this.initialized = true;

    log.info({
      sequence: this.sequenceCounter,
      cachedEvents: this.events.length,
    }, 'Gas Town Chronicle initialized');
  }

  setRetentionDays(days: number): void {
    this.retentionDays = Math.max(30, Math.min(3650, days));
    this.stats.retentionDays = this.retentionDays;
  }

  // -------------------------------------------------------------------------
  // Record events (append-only)
  // -------------------------------------------------------------------------

  async record(
    type: ChronicleEventType,
    actor: EventActor,
    subject: EventSubject,
    payload: Record<string, unknown> = {},
    options: {
      severity?: EventSeverity;
      impact?: EventImpact;
      tags?: string[];
      instanceId?: string;
      correlationId?: string;
      parentEventId?: string;
    } = {},
  ): Promise<ChronicleEvent> {
    this.sequenceCounter += 1;
    const now = new Date();

    const event: ChronicleEvent = {
      id: uuidv4(),
      sequence: this.sequenceCounter,
      type,
      severity: options.severity ?? 'info',
      actor,
      subject,
      payload,
      impact: options.impact ?? { level: 'none' },
      tags: options.tags ?? [],
      instanceId: options.instanceId,
      correlationId: options.correlationId,
      parentEventId: options.parentEventId,
      timestamp: now,
    };

    // Append to in-memory ring buffer
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-Math.floor(MAX_EVENTS_IN_MEMORY * 0.8));
    }

    // Update stats
    this.stats.totalEvents += 1;
    this.stats.eventsSinceStartup += 1;
    this.stats.currentSequence = this.sequenceCounter;
    this.stats.byType[type] = (this.stats.byType[type] ?? 0) + 1;
    this.stats.bySeverity[event.severity] = (this.stats.bySeverity[event.severity] ?? 0) + 1;
    this.stats.newestEvent = now;
    if (!this.stats.oldestEvent) this.stats.oldestEvent = now;

    const today = now.toISOString().slice(0, 10);
    if (today !== this.todayDate) {
      this.todayDate = today;
      this.stats.eventsToday = 1;
    } else {
      this.stats.eventsToday += 1;
    }

    // Persist to DB
    await this.persistEvent(event);

    // Broadcast on SSE for live viewers
    broadcast('meow:sovereign', {
      type: 'chronicle:event',
      eventId: event.id,
      eventType: event.type,
      severity: event.severity,
      actorId: event.actor.id,
      actorType: event.actor.type,
      subjectId: event.subject.id,
      subjectType: event.subject.type,
      impact: event.impact.level,
      sequence: event.sequence,
      timestamp: now.toISOString(),
    });

    // Log critical events at warn level
    if (SEVERITY_ORDER[event.severity] >= SEVERITY_ORDER.warning) {
      log.warn({
        eventType: type,
        severity: event.severity,
        actor: event.actor.id,
        subject: event.subject.id,
        impact: event.impact.level,
      }, `Chronicle: ${type}`);
    }

    return event;
  }

  // -------------------------------------------------------------------------
  // Query with cursor-based pagination
  // -------------------------------------------------------------------------

  async query(q: ChronicleQuery): Promise<ChroniclePageResult> {
    const limit = Math.min(q.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Try DB first for historical queries
    const pool = getPool();
    if (pool && (q.fromTimestamp || q.cursor)) {
      return this.queryFromDb(q, limit);
    }

    // In-memory query for recent events
    let filtered = [...this.events];

    if (q.types && q.types.length > 0) {
      filtered = filtered.filter(e => q.types!.includes(e.type));
    }
    if (q.severity && q.severity.length > 0) {
      filtered = filtered.filter(e => q.severity!.includes(e.severity));
    }
    if (q.instanceId) {
      filtered = filtered.filter(e => e.instanceId === q.instanceId);
    }
    if (q.correlationId) {
      filtered = filtered.filter(e => e.correlationId === q.correlationId);
    }
    if (q.actorId) {
      filtered = filtered.filter(e => e.actor.id === q.actorId);
    }
    if (q.subjectId) {
      filtered = filtered.filter(e => e.subject.id === q.subjectId);
    }
    if (q.fromTimestamp) {
      filtered = filtered.filter(e => e.timestamp >= q.fromTimestamp!);
    }
    if (q.toTimestamp) {
      filtered = filtered.filter(e => e.timestamp <= q.toTimestamp!);
    }
    if (q.tags && q.tags.length > 0) {
      filtered = filtered.filter(e => q.tags!.some(t => e.tags.includes(t)));
    }

    // Cursor-based offset
    if (q.cursor) {
      const cursorIdx = filtered.findIndex(e => e.id === q.cursor);
      if (cursorIdx >= 0) {
        filtered = filtered.slice(cursorIdx + 1);
      }
    }

    const page = filtered.slice(0, limit);
    const nextCursor = page.length === limit ? page[page.length - 1].id : null;

    return {
      events: page,
      nextCursor,
      totalEstimate: filtered.length,
      hasMore: filtered.length > limit,
    };
  }

  private async queryFromDb(q: ChronicleQuery, limit: number): Promise<ChroniclePageResult> {
    const pool = getPool();
    if (!pool) {
      return { events: [], nextCursor: null, totalEstimate: 0, hasMore: false };
    }

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (q.types && q.types.length > 0) {
        conditions.push(`type = ANY($${paramIdx})`);
        params.push(q.types);
        paramIdx++;
      }
      if (q.severity && q.severity.length > 0) {
        conditions.push(`severity = ANY($${paramIdx})`);
        params.push(q.severity);
        paramIdx++;
      }
      if (q.instanceId) {
        conditions.push(`instance_id = $${paramIdx}`);
        params.push(q.instanceId);
        paramIdx++;
      }
      if (q.correlationId) {
        conditions.push(`correlation_id = $${paramIdx}`);
        params.push(q.correlationId);
        paramIdx++;
      }
      if (q.actorId) {
        conditions.push(`actor_id = $${paramIdx}`);
        params.push(q.actorId);
        paramIdx++;
      }
      if (q.subjectId) {
        conditions.push(`subject_id = $${paramIdx}`);
        params.push(q.subjectId);
        paramIdx++;
      }
      if (q.fromTimestamp) {
        conditions.push(`timestamp >= $${paramIdx}`);
        params.push(q.fromTimestamp.toISOString());
        paramIdx++;
      }
      if (q.toTimestamp) {
        conditions.push(`timestamp <= $${paramIdx}`);
        params.push(q.toTimestamp.toISOString());
        paramIdx++;
      }
      if (q.cursor) {
        conditions.push(`sequence > (SELECT sequence FROM meow_chronicle WHERE id = $${paramIdx})`);
        params.push(q.cursor);
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit + 1); // fetch one extra to detect hasMore

      const { rows } = await pool.query(
        `SELECT id, sequence, type, severity, actor_json, subject_json,
                payload_json, impact_json, tags, instance_id, correlation_id,
                parent_event_id, timestamp
         FROM meow_chronicle
         ${where}
         ORDER BY sequence ASC
         LIMIT $${paramIdx}`,
        params,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const events = pageRows.map((r: Record<string, unknown>) => this.rowToEvent(r));
      const nextCursor = events.length > 0 ? events[events.length - 1].id : null;

      // Estimate total
      let totalEstimate = events.length;
      if (hasMore) {
        try {
          const countResult = await pool.query(
            `SELECT COUNT(*) AS cnt FROM meow_chronicle ${where}`,
            params.slice(0, -1), // remove limit param
          );
          totalEstimate = Number(countResult.rows[0]?.cnt ?? events.length);
        } catch {
          totalEstimate = events.length * 10; // rough estimate
        }
      }

      return { events, nextCursor: hasMore ? nextCursor : null, totalEstimate, hasMore };
    } catch (err) {
      log.error({ err }, 'Failed to query chronicle from DB');
      return { events: [], nextCursor: null, totalEstimate: 0, hasMore: false };
    }
  }

  // -------------------------------------------------------------------------
  // Replay: reconstruct state at a point in time
  // -------------------------------------------------------------------------

  async replay(
    upToTimestamp: Date,
    types?: ChronicleEventType[],
  ): Promise<ChronicleEvent[]> {
    const pool = getPool();
    if (!pool) {
      // Fall back to in-memory
      return this.events
        .filter(e => e.timestamp <= upToTimestamp)
        .filter(e => !types || types.includes(e.type))
        .sort((a, b) => a.sequence - b.sequence);
    }

    try {
      const conditions = [`timestamp <= $1`];
      const params: unknown[] = [upToTimestamp.toISOString()];

      if (types && types.length > 0) {
        conditions.push(`type = ANY($2)`);
        params.push(types);
      }

      const { rows } = await pool.query(
        `SELECT id, sequence, type, severity, actor_json, subject_json,
                payload_json, impact_json, tags, instance_id, correlation_id,
                parent_event_id, timestamp
         FROM meow_chronicle
         WHERE ${conditions.join(' AND ')}
         ORDER BY sequence ASC
         LIMIT 10000`,
        params,
      );

      return rows.map((r: Record<string, unknown>) => this.rowToEvent(r));
    } catch (err) {
      log.error({ err }, 'Failed to replay chronicle from DB');
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Aggregation views
  // -------------------------------------------------------------------------

  async aggregate(
    period: 'daily' | 'weekly' | 'monthly',
    referenceDate?: Date,
  ): Promise<AggregationPeriod> {
    const ref = referenceDate ?? new Date();
    const cacheKey = `${period}:${ref.toISOString().slice(0, 10)}`;

    // Check cache
    const cached = this.aggregationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const { startDate, endDate } = this.computePeriodBounds(period, ref);

    // Filter events in range
    const pool = getPool();
    let eventsInRange: ChronicleEvent[];

    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, sequence, type, severity, actor_json, subject_json,
                  payload_json, impact_json, tags, instance_id, correlation_id,
                  parent_event_id, timestamp
           FROM meow_chronicle
           WHERE timestamp >= $1 AND timestamp < $2
           ORDER BY sequence ASC
           LIMIT 50000`,
          [startDate, endDate],
        );
        eventsInRange = rows.map((r: Record<string, unknown>) => this.rowToEvent(r));
      } catch (err) {
        log.warn({ err }, 'Failed to query aggregation from DB, using in-memory');
        eventsInRange = this.events.filter(
          e => e.timestamp >= new Date(startDate) && e.timestamp < new Date(endDate),
        );
      }
    } else {
      eventsInRange = this.events.filter(
        e => e.timestamp >= new Date(startDate) && e.timestamp < new Date(endDate),
      );
    }

    // Compute aggregation
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const actorCounts = new Map<string, { id: string; name?: string; count: number }>();
    const subjectCounts = new Map<string, { id: string; name?: string; count: number }>();
    const hourCounts = new Array(24).fill(0);
    let totalCost = 0;

    for (const e of eventsInRange) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;

      const ac = actorCounts.get(e.actor.id) ?? { id: e.actor.id, name: e.actor.name, count: 0 };
      ac.count += 1;
      actorCounts.set(e.actor.id, ac);

      const sc = subjectCounts.get(e.subject.id) ?? { id: e.subject.id, name: e.subject.name, count: 0 };
      sc.count += 1;
      subjectCounts.set(e.subject.id, sc);

      hourCounts[e.timestamp.getHours()] += 1;

      if (e.impact.costUsd) totalCost += e.impact.costUsd;
    }

    const topActors = [...actorCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const topSubjects = [...subjectCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
    const periodHours = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 3_600_000;

    const aggregation: AggregationPeriod = {
      period,
      startDate,
      endDate,
      totalEvents: eventsInRange.length,
      byType,
      bySeverity,
      topActors,
      topSubjects,
      avgEventsPerHour: periodHours > 0 ? eventsInRange.length / periodHours : 0,
      peakHour,
      totalCostImpactUsd: Math.round(totalCost * 100) / 100,
    };

    // Cache result
    this.aggregationCache.set(cacheKey, {
      data: aggregation,
      expiresAt: Date.now() + AGGREGATION_CACHE_TTL_MS,
    });

    return aggregation;
  }

  private computePeriodBounds(
    period: 'daily' | 'weekly' | 'monthly',
    ref: Date,
  ): { startDate: string; endDate: string } {
    const d = new Date(ref);
    let start: Date;
    let end: Date;

    switch (period) {
      case 'daily':
        start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        end = new Date(start.getTime() + 86_400_000);
        break;
      case 'weekly': {
        const dow = d.getDay();
        start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
        end = new Date(start.getTime() + 7 * 86_400_000);
        break;
      }
      case 'monthly':
        start = new Date(d.getFullYear(), d.getMonth(), 1);
        end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        break;
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async exportEvents(
    format: ExportFormat,
    query?: ChronicleQuery,
  ): Promise<string> {
    const result = await this.query({ ...query, limit: MAX_PAGE_SIZE * 10 });
    const events = result.events;

    switch (format) {
      case 'json':
        return JSON.stringify(events, null, 2);

      case 'jsonl':
        return events.map(e => JSON.stringify(e)).join('\n');

      case 'csv': {
        const headers = [
          'id', 'sequence', 'type', 'severity', 'actor_type', 'actor_id',
          'subject_type', 'subject_id', 'impact_level', 'cost_usd',
          'instance_id', 'correlation_id', 'timestamp',
        ];
        const rows = events.map(e => [
          e.id,
          e.sequence,
          e.type,
          e.severity,
          e.actor.type,
          e.actor.id,
          e.subject.type,
          e.subject.id,
          e.impact.level,
          e.impact.costUsd ?? '',
          e.instanceId ?? '',
          e.correlationId ?? '',
          e.timestamp.toISOString(),
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

        return [headers.join(','), ...rows].join('\n');
      }

      default:
        return JSON.stringify(events);
    }
  }

  // -------------------------------------------------------------------------
  // Retention: archive old events
  // -------------------------------------------------------------------------

  async applyRetention(): Promise<{ archived: number; cutoffDate: string }> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    const cutoffStr = cutoff.toISOString();

    // Remove from in-memory
    const before = this.events.length;
    this.events = this.events.filter(e => e.timestamp >= cutoff);
    const removedFromMemory = before - this.events.length;

    // Archive in DB (move to archive table or just mark)
    const pool = getPool();
    let archivedFromDb = 0;
    if (pool) {
      try {
        const result = await pool.query(
          `DELETE FROM meow_chronicle
           WHERE timestamp < $1
           RETURNING id`,
          [cutoffStr],
        );
        archivedFromDb = result.rowCount ?? 0;
      } catch (err) {
        log.error({ err, cutoff: cutoffStr }, 'Failed to apply retention in DB');
      }
    }

    const totalArchived = removedFromMemory + archivedFromDb;
    this.stats.archivedCount += totalArchived;

    if (totalArchived > 0) {
      log.info({
        archived: totalArchived,
        cutoff: cutoffStr,
        retentionDays: this.retentionDays,
      }, 'Chronicle retention applied');

      broadcast('meow:sovereign', {
        type: 'chronicle:retention',
        archived: totalArchived,
        cutoffDate: cutoffStr,
        retentionDays: this.retentionDays,
      });
    }

    return { archived: totalArchived, cutoffDate: cutoffStr };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): ChronicleStats {
    return { ...this.stats };
  }

  getRecentEvents(limit = 20): ChronicleEvent[] {
    return this.events.slice(-limit).reverse();
  }

  getEventsByCorrelation(correlationId: string): ChronicleEvent[] {
    return this.events
      .filter(e => e.correlationId === correlationId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  // -------------------------------------------------------------------------
  // DB persistence (append-only)
  // -------------------------------------------------------------------------

  private async persistEvent(event: ChronicleEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_chronicle
           (id, sequence, type, severity, actor_json, actor_id,
            subject_json, subject_id, payload_json, impact_json,
            tags, instance_id, correlation_id, parent_event_id, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          event.id,
          event.sequence,
          event.type,
          event.severity,
          JSON.stringify(event.actor),
          event.actor.id,
          JSON.stringify(event.subject),
          event.subject.id,
          JSON.stringify(event.payload),
          JSON.stringify(event.impact),
          JSON.stringify(event.tags),
          event.instanceId ?? null,
          event.correlationId ?? null,
          event.parentEventId ?? null,
          event.timestamp.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist chronicle event');
    }
  }

  private async loadSequenceFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM meow_chronicle`,
      );
      this.sequenceCounter = Number(rows[0]?.max_seq ?? 0);
    } catch (err) {
      log.warn({ err }, 'Failed to load chronicle sequence (table may not exist yet)');
    }
  }

  private async loadRecentEvents(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, sequence, type, severity, actor_json, subject_json,
                payload_json, impact_json, tags, instance_id, correlation_id,
                parent_event_id, timestamp
         FROM meow_chronicle
         WHERE timestamp >= NOW() - INTERVAL '24 hours'
         ORDER BY sequence DESC
         LIMIT $1`,
        [MAX_EVENTS_IN_MEMORY],
      );

      for (const row of rows.reverse()) {
        this.events.push(this.rowToEvent(row));
      }

      // Rebuild today stats
      const today = new Date().toISOString().slice(0, 10);
      this.stats.eventsToday = this.events.filter(
        e => e.timestamp.toISOString().slice(0, 10) === today,
      ).length;
      this.stats.totalEvents = this.events.length;

      log.info({ loaded: rows.length }, 'Loaded recent chronicle events from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load recent chronicle events (table may not exist yet)');
    }
  }

  private rowToEvent(row: Record<string, unknown>): ChronicleEvent {
    const actor = typeof row.actor_json === 'string'
      ? JSON.parse(row.actor_json as string) : (row.actor_json ?? { type: 'system', id: 'unknown' });
    const subject = typeof row.subject_json === 'string'
      ? JSON.parse(row.subject_json as string) : (row.subject_json ?? { type: 'system', id: 'unknown' });
    const payload = typeof row.payload_json === 'string'
      ? JSON.parse(row.payload_json as string) : (row.payload_json ?? {});
    const impact = typeof row.impact_json === 'string'
      ? JSON.parse(row.impact_json as string) : (row.impact_json ?? { level: 'none' });
    const tags = typeof row.tags === 'string'
      ? JSON.parse(row.tags as string) : (row.tags ?? []);

    return {
      id: row.id as string,
      sequence: Number(row.sequence),
      type: row.type as ChronicleEventType,
      severity: row.severity as EventSeverity,
      actor: actor as EventActor,
      subject: subject as EventSubject,
      payload: payload as Record<string, unknown>,
      impact: impact as EventImpact,
      tags: Array.isArray(tags) ? tags : [],
      instanceId: (row.instance_id as string) || undefined,
      correlationId: (row.correlation_id as string) || undefined,
      parentEventId: (row.parent_event_id as string) || undefined,
      timestamp: new Date(row.timestamp as string),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GasTownChronicle | null = null;

export function getGasTownChronicle(): GasTownChronicle {
  if (!instance) {
    instance = new GasTownChronicle();
    log.info('GasTownChronicle singleton created');
  }
  return instance;
}
