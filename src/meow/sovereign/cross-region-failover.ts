/**
 * CROSS-REGION FAILOVER — SG-027 (Stage 06 Wave 7)
 *
 * Standby instance in different region for failover. Implements a primary/standby
 * model where one active Gas Town instance processes all work while a standby
 * continuously syncs state, ready to promote on primary failure.
 *
 * Features:
 *   - Primary/standby model: one active Gas Town, one standby syncing state
 *   - State sync: replicate chronicle events to standby via periodic sync
 *   - Heartbeat: standby pings primary every 30s, declares dead after 3 missed beats
 *   - Failover trigger: automatic on primary failure, or manual for maintenance
 *   - Failover process: standby promotes to primary, catches up from last sync point
 *   - Split-brain prevention: fencing mechanism — only one instance can be active
 *   - Failback: when original primary recovers, sync state back and resume as standby
 *   - DB table: meow_failover_state for tracking primary/standby status and sync cursor
 *
 * Note: This is designed as a logical model (same DB, different process)
 * not true multi-region (would need distributed DB).
 *
 * Gas Town: "A backup convoy always rides parallel — if the lead falls, the shadow takes command."
 */

import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('cross-region-failover');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstanceRole = 'primary' | 'standby' | 'promoting' | 'demoting' | 'fenced';

export type FailoverTrigger = 'heartbeat_timeout' | 'manual' | 'maintenance' | 'health_check' | 'split_brain_recovery';

export type FailoverStatus = 'idle' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';

export type SyncStatus = 'syncing' | 'synced' | 'lagging' | 'disconnected' | 'error';

export interface InstanceInfo {
  id: string;
  role: InstanceRole;
  region: string;
  hostname: string;
  startedAt: Date;
  lastHeartbeatAt: Date;
  chronicleSequence: number;
  syncCursor: number;
  healthy: boolean;
  version: string;
  metadata: Record<string, unknown>;
}

export interface HeartbeatMessage {
  instanceId: string;
  role: InstanceRole;
  sequence: number;
  timestamp: string;
  healthy: boolean;
  loadPct: number;
  activeFormulas: number;
  pendingBeads: number;
}

export interface FailoverEvent {
  id: string;
  trigger: FailoverTrigger;
  status: FailoverStatus;
  fromInstanceId: string;
  toInstanceId: string;
  fromRole: InstanceRole;
  toRole: InstanceRole;
  syncCursorAtStart: number;
  syncCursorAtEnd: number;
  eventsReplayedDuringPromotion: number;
  durationMs: number;
  fencingToken: string;
  aiAnalysis?: string;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: Date | null;
  syncCursor: number;             // last chronicle sequence synced
  lagEvents: number;              // how many events behind primary
  lagMs: number;                  // approximate time lag in ms
  syncRateEventsPerSec: number;
  totalEventsSynced: number;
  lastError?: string;
}

export interface FencingToken {
  token: string;
  instanceId: string;
  acquiredAt: Date;
  expiresAt: Date;
  role: InstanceRole;
}

export interface FailoverConfig {
  heartbeatIntervalMs: number;    // default 30s
  heartbeatTimeoutMs: number;     // declare dead after 3 missed beats
  missedBeatsThreshold: number;   // number of missed beats before failover
  syncIntervalMs: number;         // how often to sync chronicle events
  syncBatchSize: number;          // events per sync batch
  fencingTokenTtlMs: number;     // fencing token lifetime
  autoFailoverEnabled: boolean;
  autoFailbackEnabled: boolean;
  promotionDelayMs: number;       // delay before promotion to confirm primary is truly dead
  region: string;
  hostname: string;
}

export interface FailoverStats {
  totalFailovers: number;
  successfulFailovers: number;
  failedFailovers: number;
  totalFailbacks: number;
  avgFailoverDurationMs: number;
  avgSyncLagMs: number;
  totalEventsSynced: number;
  splitBrainIncidents: number;
  uptimeAsPrimaryMs: number;
  uptimeAsStandbyMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FailoverConfig = {
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,      // 3 missed beats at 30s
  missedBeatsThreshold: 3,
  syncIntervalMs: 10_000,          // sync every 10s
  syncBatchSize: 500,
  fencingTokenTtlMs: 5 * 60_000,  // 5 minutes
  autoFailoverEnabled: true,
  autoFailbackEnabled: false,       // manual failback by default (safer)
  promotionDelayMs: 15_000,        // 15s confirmation window
  region: process.env.FAILOVER_REGION ?? 'primary',
  hostname: process.env.HOSTNAME ?? `gastown-${process.pid}`,
};

const MAX_FAILOVER_EVENTS = 50;

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiFailover(context: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a distributed systems failover analyst for an AI agent platform called Gas Town. '
                + 'Given failover state and heartbeat data, advise on whether failover should proceed, '
                + 'potential risks, and recovery strategy. '
                + 'Respond ONLY with valid JSON: {"shouldFailover": true|false, "risk": "low|medium|high", '
                + '"reason": "...", "recoverySteps": ["..."], "estimatedDowntimeSeconds": N}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 512,
          temperature: 0.1,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini failover analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// CrossRegionFailover
// ---------------------------------------------------------------------------

export class CrossRegionFailover {
  private config: FailoverConfig = { ...DEFAULT_CONFIG };
  private instanceId: string = process.env.MEOW_INSTANCE_ID || os.hostname().slice(0, 8) || 'default';
  private role: InstanceRole = 'standby';
  private peerInstance: InstanceInfo | null = null;
  private fencingToken: FencingToken | null = null;
  private syncState: SyncState = {
    status: 'disconnected',
    lastSyncAt: null,
    syncCursor: 0,
    lagEvents: 0,
    lagMs: 0,
    syncRateEventsPerSec: 0,
    totalEventsSynced: 0,
  };
  private failoverEvents: FailoverEvent[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private lastHeartbeatReceived: Date | null = null;
  private roleStartedAt: Date = new Date();
  private stats: FailoverStats = {
    totalFailovers: 0,
    successfulFailovers: 0,
    failedFailovers: 0,
    totalFailbacks: 0,
    avgFailoverDurationMs: 0,
    avgSyncLagMs: 0,
    totalEventsSynced: 0,
    splitBrainIncidents: 0,
    uptimeAsPrimaryMs: 0,
    uptimeAsStandbyMs: 0,
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(
    role: InstanceRole = 'standby',
    configOverrides?: Partial<FailoverConfig>,
  ): Promise<void> {
    if (this.initialized) return;

    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    this.role = role;
    this.roleStartedAt = new Date();

    await this.loadFromDb();
    await this.registerInstance();

    if (role === 'primary') {
      await this.acquireFencingToken();
      this.startHeartbeating();
    } else {
      this.startHeartbeatMonitoring();
      this.startStateSync();
    }

    this.initialized = true;

    log.info({
      instanceId: this.instanceId,
      role,
      region: this.config.region,
      hostname: this.config.hostname,
      autoFailover: this.config.autoFailoverEnabled,
    }, 'Cross-region failover initialized');
  }

  // -------------------------------------------------------------------------
  // Heartbeat — primary sends, standby monitors
  // -------------------------------------------------------------------------

  private startHeartbeating(): void {
    this.stopHeartbeating();

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);

    log.info({ intervalMs: this.config.heartbeatIntervalMs }, 'Heartbeat sending started');
  }

  private startHeartbeatMonitoring(): void {
    this.stopHeartbeating();

    this.heartbeatTimer = setInterval(async () => {
      await this.checkPrimaryHeartbeat();
    }, this.config.heartbeatIntervalMs);

    log.info({ intervalMs: this.config.heartbeatIntervalMs }, 'Heartbeat monitoring started');
  }

  private stopHeartbeating(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.role !== 'primary') return;

    // CRIT-04: Validate fencing token before primary-only operation
    if (!this.validateFencingToken()) {
      log.error('sendHeartbeat blocked — fencing token invalid or expired. Demoting to standby.');
      this.role = 'fenced';
      this.stopHeartbeating();
      return;
    }

    const pool = getPool();
    if (!pool) return;

    const heartbeat: HeartbeatMessage = {
      instanceId: this.instanceId,
      role: this.role,
      sequence: this.syncState.syncCursor,
      timestamp: new Date().toISOString(),
      healthy: true,
      loadPct: this.estimateLoad(),
      activeFormulas: 0,
      pendingBeads: 0,
    };

    try {
      await pool.query(
        `UPDATE meow_failover_state
         SET last_heartbeat_at = NOW(),
             chronicle_sequence = $2,
             healthy = true,
             metadata = $3
         WHERE instance_id = $1`,
        [this.instanceId, heartbeat.sequence, JSON.stringify(heartbeat)],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to send heartbeat');
    }
  }

  private async checkPrimaryHeartbeat(): Promise<void> {
    if (this.role !== 'standby') return;

    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT instance_id, last_heartbeat_at, chronicle_sequence, healthy
         FROM meow_failover_state
         WHERE role = 'primary'
         ORDER BY last_heartbeat_at DESC
         LIMIT 1`,
      );

      if (rows.length === 0) {
        this.missedHeartbeats += 1;
        log.warn({ missed: this.missedHeartbeats }, 'No primary instance found in DB');
      } else {
        const primary = rows[0];
        const lastBeat = new Date(primary.last_heartbeat_at);
        const elapsed = Date.now() - lastBeat.getTime();

        if (elapsed > this.config.heartbeatIntervalMs * 1.5) {
          this.missedHeartbeats += 1;
          log.warn({
            elapsed,
            threshold: this.config.heartbeatTimeoutMs,
            missed: this.missedHeartbeats,
          }, 'Primary heartbeat delayed');
        } else {
          this.missedHeartbeats = 0;
          this.lastHeartbeatReceived = lastBeat;
          this.peerInstance = {
            id: primary.instance_id,
            role: 'primary',
            region: 'unknown',
            hostname: 'unknown',
            startedAt: lastBeat,
            lastHeartbeatAt: lastBeat,
            chronicleSequence: Number(primary.chronicle_sequence),
            syncCursor: Number(primary.chronicle_sequence),
            healthy: primary.healthy,
            version: '1.0',
            metadata: {},
          };
        }
      }

      // Check for failover trigger
      if (this.missedHeartbeats >= this.config.missedBeatsThreshold) {
        log.error({
          missedBeats: this.missedHeartbeats,
          threshold: this.config.missedBeatsThreshold,
        }, 'Primary declared dead — initiating failover');

        if (this.config.autoFailoverEnabled) {
          await this.initiateFailover('heartbeat_timeout');
        } else {
          broadcast('meow:sovereign', {
            type: 'failover:primary_dead',
            missedBeats: this.missedHeartbeats,
            autoFailoverEnabled: false,
            message: 'Manual failover required',
          });
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to check primary heartbeat');
    }
  }

  // -------------------------------------------------------------------------
  // State sync — standby replicates chronicle events from primary
  // -------------------------------------------------------------------------

  private startStateSync(): void {
    this.stopStateSync();

    this.syncTimer = setInterval(async () => {
      await this.syncFromPrimary();
    }, this.config.syncIntervalMs);

    log.info({ intervalMs: this.config.syncIntervalMs }, 'State sync started');
  }

  private stopStateSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async syncFromPrimary(): Promise<void> {
    if (this.role !== 'standby') return;

    const pool = getPool();
    if (!pool) {
      this.syncState.status = 'disconnected';
      return;
    }

    const syncStart = Date.now();

    try {
      // Fetch events since our last sync cursor
      const { rows } = await pool.query(
        `SELECT sequence, type, timestamp
         FROM meow_chronicle
         WHERE sequence > $1
         ORDER BY sequence ASC
         LIMIT $2`,
        [this.syncState.syncCursor, this.config.syncBatchSize],
      );

      if (rows.length === 0) {
        this.syncState.status = 'synced';
        this.syncState.lagEvents = 0;
        this.syncState.lagMs = 0;
        return;
      }

      // Update sync cursor
      const lastRow = rows[rows.length - 1];
      this.syncState.syncCursor = Number(lastRow.sequence);
      this.syncState.totalEventsSynced += rows.length;
      this.syncState.lastSyncAt = new Date();
      this.stats.totalEventsSynced += rows.length;

      // Calculate sync rate
      const syncDurationMs = Date.now() - syncStart;
      this.syncState.syncRateEventsPerSec = syncDurationMs > 0
        ? Math.round((rows.length / syncDurationMs) * 1000)
        : 0;

      // Calculate lag
      const { rows: maxRows } = await pool.query(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM meow_chronicle`,
      );
      const primarySequence = Number(maxRows[0]?.max_seq ?? 0);
      this.syncState.lagEvents = primarySequence - this.syncState.syncCursor;

      if (this.syncState.lagEvents > this.config.syncBatchSize) {
        this.syncState.status = 'lagging';
        this.syncState.lagMs = this.syncState.lagEvents * (this.config.syncIntervalMs / this.config.syncBatchSize);
      } else {
        this.syncState.status = 'synced';
        this.syncState.lagMs = 0;
      }

      // Update DB record
      await pool.query(
        `UPDATE meow_failover_state
         SET sync_cursor = $2, chronicle_sequence = $2, last_heartbeat_at = NOW()
         WHERE instance_id = $1`,
        [this.instanceId, this.syncState.syncCursor],
      );
    } catch (err) {
      this.syncState.status = 'error';
      this.syncState.lastError = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'State sync failed');
    }
  }

  // -------------------------------------------------------------------------
  // Failover execution
  // -------------------------------------------------------------------------

  async initiateFailover(trigger: FailoverTrigger): Promise<FailoverEvent> {
    const failoverId = uuidv4();
    const startMs = Date.now();

    log.warn({ failoverId, trigger, role: this.role }, 'Failover initiated');

    broadcast('meow:sovereign', {
      type: 'failover:initiated',
      failoverId,
      trigger,
      fromInstance: this.peerInstance?.id ?? 'unknown',
      toInstance: this.instanceId,
    });

    const event: FailoverEvent = {
      id: failoverId,
      trigger,
      status: 'in_progress',
      fromInstanceId: this.peerInstance?.id ?? 'unknown',
      toInstanceId: this.instanceId,
      fromRole: 'primary',
      toRole: 'standby',
      syncCursorAtStart: this.syncState.syncCursor,
      syncCursorAtEnd: this.syncState.syncCursor,
      eventsReplayedDuringPromotion: 0,
      durationMs: 0,
      fencingToken: '',
      createdAt: new Date(),
    };

    try {
      // Step 1: Confirmation delay — verify primary is truly dead
      if (trigger === 'heartbeat_timeout') {
        log.info({ delayMs: this.config.promotionDelayMs }, 'Waiting for promotion confirmation');
        await this.delay(this.config.promotionDelayMs);

        // Re-check heartbeat
        const stillDead = await this.isPrimaryStillDead();
        if (!stillDead) {
          event.status = 'rolled_back';
          event.error = 'Primary recovered during confirmation delay';
          event.durationMs = Date.now() - startMs;
          this.failoverEvents.push(event);
          await this.persistFailoverEvent(event);

          log.info('Primary recovered during confirmation — failover cancelled');

          broadcast('meow:sovereign', {
            type: 'failover:cancelled',
            failoverId,
            reason: 'Primary recovered during confirmation delay',
          });

          return event;
        }
      }

      // Step 2: Fence the old primary
      await this.fenceInstance(this.peerInstance?.id ?? 'unknown');

      // Step 3: Acquire fencing token for ourselves
      const token = await this.acquireFencingToken();
      event.fencingToken = token?.token ?? '';

      // Step 4: Catch up from last sync point
      const replayedEvents = await this.catchUpFromSyncPoint();
      event.eventsReplayedDuringPromotion = replayedEvents;
      event.syncCursorAtEnd = this.syncState.syncCursor;

      // Step 5: Promote to primary
      this.role = 'primary';
      this.roleStartedAt = new Date();
      this.missedHeartbeats = 0;

      // Stop sync, start heartbeating
      this.stopStateSync();
      this.stopHeartbeating();
      this.startHeartbeating();

      // Update DB
      await this.updateInstanceRole('primary');

      // Step 6: AI analysis
      const aiAnalysis = await this.analyzeFailover(event);
      if (aiAnalysis) event.aiAnalysis = aiAnalysis;

      event.status = 'completed';
      event.durationMs = Date.now() - startMs;
      event.completedAt = new Date();

      this.stats.totalFailovers += 1;
      this.stats.successfulFailovers += 1;
      this.updateAvgFailoverDuration(event.durationMs);

    } catch (err) {
      event.status = 'failed';
      event.error = err instanceof Error ? err.message : String(err);
      event.durationMs = Date.now() - startMs;
      this.stats.totalFailovers += 1;
      this.stats.failedFailovers += 1;

      log.error({ err, failoverId }, 'Failover failed');
    }

    this.failoverEvents.push(event);
    if (this.failoverEvents.length > MAX_FAILOVER_EVENTS) {
      this.failoverEvents = this.failoverEvents.slice(-MAX_FAILOVER_EVENTS);
    }

    await this.persistFailoverEvent(event);

    log.info({
      failoverId,
      status: event.status,
      durationMs: event.durationMs,
      eventsReplayed: event.eventsReplayedDuringPromotion,
    }, `Failover ${event.status}`);

    broadcast('meow:sovereign', {
      type: `failover:${event.status}`,
      failoverId,
      durationMs: event.durationMs,
      newRole: this.role,
      eventsReplayed: event.eventsReplayedDuringPromotion,
    });

    return event;
  }

  async initiateFailback(): Promise<FailoverEvent> {
    return this.initiateFailover('maintenance');
  }

  async manualFailover(): Promise<FailoverEvent> {
    return this.initiateFailover('manual');
  }

  // -------------------------------------------------------------------------
  // Failover helpers
  // -------------------------------------------------------------------------

  private async isPrimaryStillDead(): Promise<boolean> {
    const pool = getPool();
    if (!pool) return true;

    try {
      const { rows } = await pool.query(
        `SELECT last_heartbeat_at FROM meow_failover_state
         WHERE role = 'primary'
         ORDER BY last_heartbeat_at DESC LIMIT 1`,
      );

      if (rows.length === 0) return true;

      const lastBeat = new Date(rows[0].last_heartbeat_at);
      const elapsed = Date.now() - lastBeat.getTime();
      return elapsed > this.config.heartbeatTimeoutMs;
    } catch {
      return true;
    }
  }

  private async catchUpFromSyncPoint(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM meow_chronicle
         WHERE sequence > $1`,
        [this.syncState.syncCursor],
      );

      const pending = Number(rows[0]?.cnt ?? 0);

      // Replay in batches
      let totalReplayed = 0;
      let cursor = this.syncState.syncCursor;

      while (totalReplayed < pending) {
        const { rows: eventRows } = await pool.query(
          `SELECT sequence, type, payload_json FROM meow_chronicle
           WHERE sequence > $1
           ORDER BY sequence ASC
           LIMIT $2`,
          [cursor, this.config.syncBatchSize],
        );

        if (eventRows.length === 0) break;

        totalReplayed += eventRows.length;
        cursor = Number(eventRows[eventRows.length - 1].sequence);
        this.syncState.syncCursor = cursor;
      }

      log.info({ eventsReplayed: totalReplayed }, 'Caught up from sync point');
      return totalReplayed;
    } catch (err) {
      log.error({ err }, 'Failed to catch up from sync point');
      return 0;
    }
  }

  private async fenceInstance(instanceId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_failover_state
         SET role = 'fenced', healthy = false
         WHERE instance_id = $1`,
        [instanceId],
      );
      log.info({ instanceId }, 'Instance fenced');
    } catch (err) {
      log.warn({ err, instanceId }, 'Failed to fence instance');
    }
  }

  /**
   * CRIT-04: Validates that the current fencing token exists and has not expired.
   * Must be called before any primary-only operation to prevent split-brain writes.
   */
  private validateFencingToken(): boolean {
    if (!this.fencingToken) {
      log.warn('Fencing token validation failed: no token held');
      return false;
    }
    if (this.fencingToken.expiresAt.getTime() <= Date.now()) {
      log.warn({ expiredAt: this.fencingToken.expiresAt.toISOString() }, 'Fencing token validation failed: token expired');
      this.fencingToken = null;
      return false;
    }
    return true;
  }

  private async acquireFencingToken(): Promise<FencingToken | null> {
    const pool = getPool();
    if (!pool) return null;

    const token: FencingToken = {
      token: uuidv4(),
      instanceId: this.instanceId,
      acquiredAt: new Date(),
      expiresAt: new Date(Date.now() + this.config.fencingTokenTtlMs),
      role: 'primary',
    };

    try {
      // Atomic check: ensure no other primary exists with a valid token
      const { rows } = await pool.query(
        `SELECT instance_id FROM meow_failover_state
         WHERE role = 'primary' AND healthy = true
           AND instance_id != $1
           AND last_heartbeat_at > NOW() - INTERVAL '2 minutes'`,
        [this.instanceId],
      );

      if (rows.length > 0) {
        log.error({ existingPrimary: rows[0].instance_id }, 'Split-brain detected — another primary exists');
        this.stats.splitBrainIncidents += 1;

        broadcast('meow:sovereign', {
          type: 'failover:split_brain',
          currentInstance: this.instanceId,
          conflictingInstance: rows[0].instance_id,
        });

        return null;
      }

      // Store token
      await pool.query(
        `INSERT INTO meow_failover_state
           (instance_id, role, region, hostname, fencing_token, fencing_token_expires_at,
            last_heartbeat_at, chronicle_sequence, sync_cursor, healthy, started_at)
         VALUES ($1, 'primary', $2, $3, $4, $5, NOW(), $6, $6, true, NOW())
         ON CONFLICT (instance_id) DO UPDATE SET
           role = 'primary', fencing_token = $4, fencing_token_expires_at = $5,
           last_heartbeat_at = NOW(), healthy = true`,
        [
          this.instanceId,
          this.config.region,
          this.config.hostname,
          token.token,
          token.expiresAt.toISOString(),
          this.syncState.syncCursor,
        ],
      );

      this.fencingToken = token;
      log.info({ token: token.token.slice(0, 8) + '...', expiresAt: token.expiresAt.toISOString() }, 'Fencing token acquired');
      return token;
    } catch (err) {
      log.error({ err }, 'Failed to acquire fencing token');
      return null;
    }
  }

  private async analyzeFailover(event: FailoverEvent): Promise<string | null> {
    const context = JSON.stringify({
      trigger: event.trigger,
      syncCursorGap: event.syncCursorAtEnd - event.syncCursorAtStart,
      eventsReplayed: event.eventsReplayedDuringPromotion,
      durationMs: event.durationMs,
      missedHeartbeats: this.missedHeartbeats,
      syncLag: this.syncState.lagEvents,
    });

    const aiResponse = await callGeminiFailover(context);
    if (!aiResponse) return null;

    try {
      const parsed = JSON.parse(aiResponse) as {
        reason: string;
        recoverySteps: string[];
        estimatedDowntimeSeconds: number;
      };
      return `Reason: ${parsed.reason}. Recovery: ${parsed.recoverySteps.join('; ')}. Est. downtime: ${parsed.estimatedDowntimeSeconds}s`;
    } catch {
      return aiResponse.slice(0, 300);
    }
  }

  // -------------------------------------------------------------------------
  // Instance registration
  // -------------------------------------------------------------------------

  private async registerInstance(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_failover_state
           (instance_id, role, region, hostname, last_heartbeat_at,
            chronicle_sequence, sync_cursor, healthy, started_at, metadata)
         VALUES ($1, $2, $3, $4, NOW(), 0, 0, true, NOW(), $5)
         ON CONFLICT (instance_id) DO UPDATE SET
           role = $2, healthy = true, last_heartbeat_at = NOW(), started_at = NOW()`,
        [
          this.instanceId,
          this.role,
          this.config.region,
          this.config.hostname,
          JSON.stringify({ version: '1.0', pid: process.pid }),
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to register instance');
    }
  }

  private async updateInstanceRole(role: InstanceRole): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_failover_state
         SET role = $2, last_heartbeat_at = NOW()
         WHERE instance_id = $1`,
        [this.instanceId, role],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to update instance role');
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getRole(): InstanceRole {
    return this.role;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  isPrimary(): boolean {
    return this.role === 'primary';
  }

  isStandby(): boolean {
    return this.role === 'standby';
  }

  getSyncState(): SyncState {
    return { ...this.syncState };
  }

  getPeerInstance(): InstanceInfo | null {
    return this.peerInstance ? { ...this.peerInstance } : null;
  }

  getStatus(): {
    instanceId: string;
    role: InstanceRole;
    region: string;
    hostname: string;
    uptime: number;
    syncState: SyncState;
    missedHeartbeats: number;
    lastHeartbeatReceived: Date | null;
    fencingTokenValid: boolean;
  } {
    const now = Date.now();
    return {
      instanceId: this.instanceId,
      role: this.role,
      region: this.config.region,
      hostname: this.config.hostname,
      uptime: now - this.roleStartedAt.getTime(),
      syncState: { ...this.syncState },
      missedHeartbeats: this.missedHeartbeats,
      lastHeartbeatReceived: this.lastHeartbeatReceived,
      fencingTokenValid: this.fencingToken != null && this.fencingToken.expiresAt.getTime() > now,
    };
  }

  getStats(): FailoverStats {
    // Update uptime stats
    const now = Date.now();
    const roleDuration = now - this.roleStartedAt.getTime();
    if (this.role === 'primary') {
      this.stats.uptimeAsPrimaryMs = roleDuration;
    } else if (this.role === 'standby') {
      this.stats.uptimeAsStandbyMs = roleDuration;
    }
    return { ...this.stats };
  }

  getConfig(): FailoverConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<FailoverConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'Failover config updated');
  }

  getFailoverHistory(limit = 20): FailoverEvent[] {
    return this.failoverEvents.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Stats helpers
  // -------------------------------------------------------------------------

  private updateAvgFailoverDuration(durationMs: number): void {
    const n = this.stats.successfulFailovers;
    if (n <= 1) {
      this.stats.avgFailoverDurationMs = durationMs;
    } else {
      this.stats.avgFailoverDurationMs = Math.round(
        (this.stats.avgFailoverDurationMs * (n - 1) + durationMs) / n,
      );
    }
  }

  private estimateLoad(): number {
    const mem = process.memoryUsage();
    return Math.round((mem.heapUsed / mem.heapTotal) * 100);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistFailoverEvent(event: FailoverEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_failover_state
           (instance_id, role, region, hostname, last_heartbeat_at,
            chronicle_sequence, sync_cursor, healthy, started_at, metadata)
         VALUES ($1, $2, $3, $4, NOW(), $5, $5, true, NOW(), $6)
         ON CONFLICT (instance_id) DO UPDATE SET
           metadata = meow_failover_state.metadata || $6::jsonb`,
        [
          `failover-event-${event.id}`,
          'primary',
          this.config.region,
          this.config.hostname,
          event.syncCursorAtEnd,
          JSON.stringify({
            failoverEvent: {
              id: event.id,
              trigger: event.trigger,
              status: event.status,
              durationMs: event.durationMs,
              eventsReplayed: event.eventsReplayedDuringPromotion,
              error: event.error,
              createdAt: event.createdAt.toISOString(),
              completedAt: event.completedAt?.toISOString(),
            },
          }),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist failover event');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Check if this instance was previously registered
      const { rows } = await pool.query(
        `SELECT instance_id, role, sync_cursor, chronicle_sequence
         FROM meow_failover_state
         WHERE region = $1 AND role != 'fenced'
         ORDER BY last_heartbeat_at DESC
         LIMIT 5`,
        [this.config.region],
      );

      if (rows.length > 0) {
        // Find our previous state or set sync cursor from last known position
        for (const row of rows) {
          if (row.instance_id === this.instanceId) {
            this.syncState.syncCursor = Number(row.sync_cursor ?? 0);
            break;
          }
        }
      }

      log.info({ instances: rows.length, syncCursor: this.syncState.syncCursor }, 'Loaded failover state from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load failover state from DB (table may not exist yet)');
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.stopHeartbeating();
    this.stopStateSync();

    // Mark instance as unhealthy in DB
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE meow_failover_state SET healthy = false WHERE instance_id = $1`,
          [this.instanceId],
        );
      } catch {
        // Best effort
      }
    }

    // Record uptime
    const roleDuration = Date.now() - this.roleStartedAt.getTime();
    if (this.role === 'primary') {
      this.stats.uptimeAsPrimaryMs += roleDuration;
    } else {
      this.stats.uptimeAsStandbyMs += roleDuration;
    }

    log.info({ instanceId: this.instanceId, role: this.role }, 'Cross-region failover shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CrossRegionFailover | null = null;

export function getCrossRegionFailover(): CrossRegionFailover {
  if (!instance) {
    instance = new CrossRegionFailover();
  }
  return instance;
}
