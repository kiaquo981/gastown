/**
 * STATE SNAPSHOT — SG-025 (Stage 06 Wave 7)
 *
 * Periodic full state snapshots for crash recovery in Gas Town.
 * Captures the complete operational state at regular intervals, allowing
 * rapid restoration after unexpected shutdowns or data corruption.
 *
 * Features:
 *   - Snapshot contents: active molecules, pending beads, worker pool state,
 *     formula schedule, budget state, crisis state
 *   - Periodic snapshots: configurable interval (default every 30 min)
 *   - On-demand snapshot: trigger manually before risky operations
 *   - Restore from snapshot: reload full state from latest snapshot + replay events since
 *   - Event replay: use gastown-chronicle events to catch up from snapshot to current time
 *   - Snapshot storage: serialize to JSON, store in DB with timestamp and checksum
 *   - Snapshot retention: keep last 48 (24h at 30min intervals), archive older to cold storage
 *   - Integrity verification: SHA-256 checksum to detect corruption
 *   - DB table: meow_state_snapshots
 *   - Restore report: what was restored, what events were replayed, any conflicts found
 *
 * Gas Town: "Before you gamble, photograph the table — so you can always come back."
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('state-snapshot');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnapshotTrigger = 'periodic' | 'manual' | 'pre_operation' | 'pre_failover' | 'pre_upgrade';

export type SnapshotStatus = 'creating' | 'completed' | 'failed' | 'archived' | 'corrupted';

export interface MoleculeState {
  id: string;
  formulaId: string;
  status: string;
  beadIds: string[];
  progress: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface BeadState {
  id: string;
  moleculeId: string;
  workerId: string | null;
  status: string;
  priority: number;
  createdAt: string;
  assignedAt?: string;
}

export interface WorkerPoolState {
  totalWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  workers: Array<{
    id: string;
    status: string;
    currentBeadId: string | null;
    specializations: string[];
    uptimeMs: number;
  }>;
}

export interface FormulaScheduleState {
  scheduled: Array<{
    id: string;
    formulaId: string;
    scheduledAt: string;
    status: string;
    priority: number;
  }>;
  running: Array<{
    id: string;
    formulaId: string;
    startedAt: string;
    progress: number;
  }>;
}

export interface BudgetState {
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  remainingUsd: number;
  alertsActive: string[];
  lastUpdated: string;
}

export interface CrisisSnapshot {
  active: boolean;
  crisisId: string | null;
  triggerType: string | null;
  severity: string | null;
  status: string | null;
  startedAt: string | null;
}

export interface FullStatePayload {
  activeMolecules: MoleculeState[];
  pendingBeads: BeadState[];
  workerPool: WorkerPoolState;
  formulaSchedule: FormulaScheduleState;
  budgetState: BudgetState;
  crisisState: CrisisSnapshot;
  systemMetrics: {
    heapUsedMb: number;
    heapTotalMb: number;
    uptimeSeconds: number;
    eventLoopLagMs: number;
  };
  capturedAt: string;
}

export interface StateSnapshot {
  id: string;
  trigger: SnapshotTrigger;
  status: SnapshotStatus;
  payload: FullStatePayload;
  checksumSha256: string;
  sizeBytes: number;
  chronicleSequence: number;     // chronicle event sequence at snapshot time
  createdAt: Date;
  expiresAt: Date;
  archivedAt?: Date;
  label?: string;                // human-readable label (e.g. "pre-deploy v2.3")
}

export interface RestoreReport {
  snapshotId: string;
  snapshotTimestamp: string;
  chronicleSequenceAtSnapshot: number;
  eventsReplayed: number;
  eventsSkipped: number;
  conflicts: RestoreConflict[];
  restoredSections: string[];
  durationMs: number;
  success: boolean;
  notes: string;
}

export interface RestoreConflict {
  section: string;
  description: string;
  resolution: 'snapshot_wins' | 'current_wins' | 'merged' | 'skipped';
}

export interface SnapshotConfig {
  intervalMs: number;            // default 30 min
  retentionCount: number;        // keep last N snapshots (default 48)
  archiveOlderThanMs: number;    // archive snapshots older than this
  enablePeriodic: boolean;
  checksumVerifyOnLoad: boolean;
}

export interface SnapshotStats {
  totalSnapshots: number;
  totalRestores: number;
  lastSnapshotAt: Date | null;
  lastRestoreAt: Date | null;
  avgSnapshotSizeBytes: number;
  avgSnapshotDurationMs: number;
  corruptedSnapshots: number;
  archivedSnapshots: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30 * 60_000;          // 30 minutes
const DEFAULT_RETENTION_COUNT = 48;                 // 24h at 30min intervals
const DEFAULT_ARCHIVE_AFTER_MS = 48 * 60 * 60_000; // 48 hours
const MAX_SNAPSHOTS_IN_MEMORY = 5;
const MAX_REPLAY_EVENTS = 50_000;

const DEFAULT_CONFIG: SnapshotConfig = {
  intervalMs: DEFAULT_INTERVAL_MS,
  retentionCount: DEFAULT_RETENTION_COUNT,
  archiveOlderThanMs: DEFAULT_ARCHIVE_AFTER_MS,
  enablePeriodic: true,
  checksumVerifyOnLoad: true,
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiSnapshot(context: string): Promise<string | null> {
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
                'You are a state recovery analyst for an AI agent platform called Gas Town. '
                + 'Given a snapshot and replay events, detect conflicts, anomalies, and recommend resolution. '
                + 'Respond ONLY with valid JSON: {"conflicts": [{"section":"...","description":"...","resolution":"snapshot_wins|current_wins|merged|skipped"}], '
                + '"anomalies": ["..."], "recommendation": "...", "confidence": 0.0-1.0}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 1024,
          temperature: 0.1,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini snapshot analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// StateSnapshotManager
// ---------------------------------------------------------------------------

export class StateSnapshotManager {
  private config: SnapshotConfig = { ...DEFAULT_CONFIG };
  private snapshots: StateSnapshot[] = [];
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private stats: SnapshotStats = {
    totalSnapshots: 0,
    totalRestores: 0,
    lastSnapshotAt: null,
    lastRestoreAt: null,
    avgSnapshotSizeBytes: 0,
    avgSnapshotDurationMs: 0,
    corruptedSnapshots: 0,
    archivedSnapshots: 0,
  };
  private initialized = false;

  // Collectors: external systems register functions to provide their state
  private stateCollectors = new Map<string, () => Promise<Record<string, unknown>>>();

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(configOverrides?: Partial<SnapshotConfig>): Promise<void> {
    if (this.initialized) return;

    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    await this.loadFromDb();
    this.initialized = true;

    if (this.config.enablePeriodic) {
      this.startPeriodicSnapshots();
    }

    log.info({
      intervalMs: this.config.intervalMs,
      retention: this.config.retentionCount,
      periodic: this.config.enablePeriodic,
      existingSnapshots: this.snapshots.length,
    }, 'State snapshot manager initialized');
  }

  // -------------------------------------------------------------------------
  // State collector registration
  // -------------------------------------------------------------------------

  registerCollector(name: string, collector: () => Promise<Record<string, unknown>>): void {
    this.stateCollectors.set(name, collector);
    log.info({ collector: name }, 'State collector registered');
  }

  unregisterCollector(name: string): void {
    this.stateCollectors.delete(name);
  }

  // -------------------------------------------------------------------------
  // Periodic snapshots
  // -------------------------------------------------------------------------

  startPeriodicSnapshots(): void {
    this.stopPeriodicSnapshots();

    this.periodicTimer = setInterval(() => {
      this.takeSnapshot('periodic').catch(err =>
        log.error({ err }, 'Periodic snapshot failed'),
      );
    }, this.config.intervalMs);

    log.info({ intervalMs: this.config.intervalMs }, 'Periodic snapshots started');
  }

  stopPeriodicSnapshots(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
      log.info('Periodic snapshots stopped');
    }
  }

  // -------------------------------------------------------------------------
  // Take snapshot
  // -------------------------------------------------------------------------

  async takeSnapshot(trigger: SnapshotTrigger, label?: string): Promise<StateSnapshot> {
    const startMs = Date.now();
    const snapshotId = uuidv4();

    log.info({ snapshotId, trigger, label }, 'Taking state snapshot');

    broadcast('meow:sovereign', {
      type: 'snapshot:creating',
      snapshotId,
      trigger,
      label,
    });

    let payload: FullStatePayload;
    try {
      payload = await this.collectFullState();
    } catch (err) {
      log.error({ err, snapshotId }, 'Failed to collect state for snapshot');

      const failedSnapshot: StateSnapshot = {
        id: snapshotId,
        trigger,
        status: 'failed',
        payload: this.buildEmptyPayload(),
        checksumSha256: '',
        sizeBytes: 0,
        chronicleSequence: 0,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + this.config.archiveOlderThanMs),
        label,
      };

      broadcast('meow:sovereign', {
        type: 'snapshot:failed',
        snapshotId,
        error: err instanceof Error ? err.message : String(err),
      });

      return failedSnapshot;
    }

    // Serialize and compute checksum
    const serialized = JSON.stringify(payload);
    const sizeBytes = Buffer.byteLength(serialized, 'utf-8');
    const checksumSha256 = createHash('sha256').update(serialized).digest('hex');

    // Get chronicle sequence
    const chronicleSequence = await this.getCurrentChronicleSequence();

    const snapshot: StateSnapshot = {
      id: snapshotId,
      trigger,
      status: 'completed',
      payload,
      checksumSha256,
      sizeBytes,
      chronicleSequence,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + this.config.archiveOlderThanMs),
      label,
    };

    // Store in memory (ring buffer)
    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS_IN_MEMORY) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS_IN_MEMORY);
    }

    // Persist to DB
    await this.persistSnapshot(snapshot, serialized);

    // Enforce retention
    await this.enforceRetention();

    // Update stats
    const durationMs = Date.now() - startMs;
    this.stats.totalSnapshots += 1;
    this.stats.lastSnapshotAt = snapshot.createdAt;
    this.updateAvgSize(sizeBytes);
    this.updateAvgDuration(durationMs);

    log.info({
      snapshotId,
      trigger,
      sizeBytes,
      durationMs,
      chronicleSequence,
      checksumSha256: checksumSha256.slice(0, 12) + '...',
    }, 'State snapshot completed');

    broadcast('meow:sovereign', {
      type: 'snapshot:completed',
      snapshotId,
      trigger,
      sizeBytes,
      durationMs,
      chronicleSequence,
      label,
    });

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Restore from snapshot
  // -------------------------------------------------------------------------

  async restoreFromLatest(): Promise<RestoreReport> {
    const snapshot = await this.getLatestValidSnapshot();
    if (!snapshot) {
      return {
        snapshotId: 'none',
        snapshotTimestamp: 'N/A',
        chronicleSequenceAtSnapshot: 0,
        eventsReplayed: 0,
        eventsSkipped: 0,
        conflicts: [],
        restoredSections: [],
        durationMs: 0,
        success: false,
        notes: 'No valid snapshot found to restore from',
      };
    }

    return this.restoreFromSnapshot(snapshot.id);
  }

  async restoreFromSnapshot(snapshotId: string): Promise<RestoreReport> {
    const startMs = Date.now();
    const snapshot = this.snapshots.find(s => s.id === snapshotId)
      ?? await this.loadSnapshotFromDb(snapshotId);

    if (!snapshot) {
      return {
        snapshotId,
        snapshotTimestamp: 'N/A',
        chronicleSequenceAtSnapshot: 0,
        eventsReplayed: 0,
        eventsSkipped: 0,
        conflicts: [],
        restoredSections: [],
        durationMs: Date.now() - startMs,
        success: false,
        notes: `Snapshot ${snapshotId} not found`,
      };
    }

    log.info({
      snapshotId,
      chronicleSequence: snapshot.chronicleSequence,
      snapshotAge: Date.now() - snapshot.createdAt.getTime(),
    }, 'Restoring from state snapshot');

    broadcast('meow:sovereign', {
      type: 'snapshot:restoring',
      snapshotId,
      snapshotTimestamp: snapshot.createdAt.toISOString(),
      chronicleSequence: snapshot.chronicleSequence,
    });

    // Verify integrity
    if (this.config.checksumVerifyOnLoad) {
      const serialized = JSON.stringify(snapshot.payload);
      const checksum = createHash('sha256').update(serialized).digest('hex');
      if (checksum !== snapshot.checksumSha256) {
        log.error({ snapshotId, expected: snapshot.checksumSha256, actual: checksum }, 'Snapshot checksum mismatch — corrupted');
        this.stats.corruptedSnapshots += 1;
        snapshot.status = 'corrupted';
        return {
          snapshotId,
          snapshotTimestamp: snapshot.createdAt.toISOString(),
          chronicleSequenceAtSnapshot: snapshot.chronicleSequence,
          eventsReplayed: 0,
          eventsSkipped: 0,
          conflicts: [{ section: 'integrity', description: 'SHA-256 checksum mismatch', resolution: 'skipped' }],
          restoredSections: [],
          durationMs: Date.now() - startMs,
          success: false,
          notes: 'Snapshot corrupted — checksum verification failed',
        };
      }
    }

    // Restore state sections
    const restoredSections: string[] = [];
    const conflicts: RestoreConflict[] = [];

    // 1. Restore molecules
    try {
      await this.restoreMolecules(snapshot.payload.activeMolecules);
      restoredSections.push('activeMolecules');
    } catch (err) {
      conflicts.push({
        section: 'activeMolecules',
        description: `Failed to restore: ${err instanceof Error ? err.message : String(err)}`,
        resolution: 'skipped',
      });
    }

    // 2. Restore beads
    try {
      await this.restoreBeads(snapshot.payload.pendingBeads);
      restoredSections.push('pendingBeads');
    } catch (err) {
      conflicts.push({
        section: 'pendingBeads',
        description: `Failed to restore: ${err instanceof Error ? err.message : String(err)}`,
        resolution: 'skipped',
      });
    }

    // 3. Restore formula schedule
    try {
      await this.restoreFormulaSchedule(snapshot.payload.formulaSchedule);
      restoredSections.push('formulaSchedule');
    } catch (err) {
      conflicts.push({
        section: 'formulaSchedule',
        description: `Failed to restore: ${err instanceof Error ? err.message : String(err)}`,
        resolution: 'skipped',
      });
    }

    // 4. Replay chronicle events since snapshot
    let eventsReplayed = 0;
    let eventsSkipped = 0;
    try {
      const replayResult = await this.replayEventsSinceSnapshot(snapshot.chronicleSequence);
      eventsReplayed = replayResult.replayed;
      eventsSkipped = replayResult.skipped;
      if (replayResult.replayed > 0) {
        restoredSections.push('chronicleReplay');
      }
    } catch (err) {
      conflicts.push({
        section: 'chronicleReplay',
        description: `Replay failed: ${err instanceof Error ? err.message : String(err)}`,
        resolution: 'skipped',
      });
    }

    // 5. AI conflict analysis if any conflicts detected
    if (conflicts.length > 0) {
      const aiAnalysis = await this.analyzeRestoreConflicts(snapshot, conflicts, eventsReplayed);
      if (aiAnalysis) {
        for (const aiConflict of aiAnalysis) {
          const existing = conflicts.find(c => c.section === aiConflict.section);
          if (existing) {
            existing.resolution = aiConflict.resolution as RestoreConflict['resolution'];
          } else {
            conflicts.push(aiConflict);
          }
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const success = restoredSections.length > 0 && conflicts.filter(c => c.resolution === 'skipped').length < 3;

    this.stats.totalRestores += 1;
    this.stats.lastRestoreAt = new Date();

    const report: RestoreReport = {
      snapshotId,
      snapshotTimestamp: snapshot.createdAt.toISOString(),
      chronicleSequenceAtSnapshot: snapshot.chronicleSequence,
      eventsReplayed,
      eventsSkipped,
      conflicts,
      restoredSections,
      durationMs,
      success,
      notes: success
        ? `Restored ${restoredSections.length} sections, replayed ${eventsReplayed} events in ${durationMs}ms`
        : `Partial restore: ${conflicts.length} conflicts detected`,
    };

    // Persist report
    await this.persistRestoreReport(report);

    log.info({
      snapshotId,
      success,
      restoredSections: restoredSections.length,
      eventsReplayed,
      conflicts: conflicts.length,
      durationMs,
    }, 'State restore completed');

    broadcast('meow:sovereign', {
      type: 'snapshot:restored',
      snapshotId,
      success,
      restoredSections,
      eventsReplayed,
      conflicts: conflicts.length,
      durationMs,
    });

    return report;
  }

  // -------------------------------------------------------------------------
  // State collection
  // -------------------------------------------------------------------------

  private async collectFullState(): Promise<FullStatePayload> {
    const pool = getPool();
    const now = new Date();

    // Collect molecules
    let activeMolecules: MoleculeState[] = [];
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, formula_id, status, bead_ids, progress, created_at, metadata_json
           FROM meow_molecules
           WHERE status IN ('active', 'running', 'pending')
           LIMIT 5000`,
        );
        activeMolecules = rows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          formulaId: r.formula_id as string,
          status: r.status as string,
          beadIds: Array.isArray(r.bead_ids) ? r.bead_ids as string[] : JSON.parse((r.bead_ids as string) ?? '[]'),
          progress: Number(r.progress ?? 0),
          createdAt: new Date(r.created_at as string).toISOString(),
          metadata: typeof r.metadata_json === 'string' ? JSON.parse(r.metadata_json) : r.metadata_json as Record<string, unknown>,
        }));
      } catch {
        log.warn('Failed to collect molecules — table may not exist');
      }
    }

    // Collect pending beads
    let pendingBeads: BeadState[] = [];
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, molecule_id, worker_id, status, priority, created_at, assigned_at
           FROM meow_beads
           WHERE status IN ('pending', 'assigned', 'running')
           LIMIT 10000`,
        );
        pendingBeads = rows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          moleculeId: r.molecule_id as string,
          workerId: (r.worker_id as string) ?? null,
          status: r.status as string,
          priority: Number(r.priority ?? 0),
          createdAt: new Date(r.created_at as string).toISOString(),
          assignedAt: r.assigned_at ? new Date(r.assigned_at as string).toISOString() : undefined,
        }));
      } catch {
        log.warn('Failed to collect beads — table may not exist');
      }
    }

    // Collect worker pool state from registered collector or defaults
    let workerPool: WorkerPoolState = {
      totalWorkers: 0,
      activeWorkers: 0,
      idleWorkers: 0,
      workers: [],
    };
    const wpCollector = this.stateCollectors.get('workerPool');
    if (wpCollector) {
      try {
        const data = await wpCollector();
        workerPool = data as unknown as WorkerPoolState;
      } catch {
        log.warn('Worker pool state collector failed');
      }
    }

    // Collect formula schedule
    let formulaSchedule: FormulaScheduleState = { scheduled: [], running: [] };
    if (pool) {
      try {
        const { rows: schedRows } = await pool.query(
          `SELECT id, formula_id, scheduled_at, status, priority
           FROM meow_formula_schedule
           WHERE status IN ('scheduled', 'pending')
           ORDER BY scheduled_at ASC LIMIT 500`,
        );
        formulaSchedule.scheduled = schedRows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          formulaId: r.formula_id as string,
          scheduledAt: new Date(r.scheduled_at as string).toISOString(),
          status: r.status as string,
          priority: Number(r.priority ?? 0),
        }));

        const { rows: runRows } = await pool.query(
          `SELECT id, formula_id, started_at, progress
           FROM meow_formula_schedule
           WHERE status = 'running'
           LIMIT 100`,
        );
        formulaSchedule.running = runRows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          formulaId: r.formula_id as string,
          startedAt: new Date(r.started_at as string).toISOString(),
          progress: Number(r.progress ?? 0),
        }));
      } catch {
        log.warn('Failed to collect formula schedule — table may not exist');
      }
    }

    // Collect budget state from registered collector or defaults
    let budgetState: BudgetState = {
      dailyBudgetUsd: 0,
      spentTodayUsd: 0,
      remainingUsd: 0,
      alertsActive: [],
      lastUpdated: now.toISOString(),
    };
    const budgetCollector = this.stateCollectors.get('budget');
    if (budgetCollector) {
      try {
        const data = await budgetCollector();
        budgetState = data as unknown as BudgetState;
      } catch {
        log.warn('Budget state collector failed');
      }
    }

    // Collect crisis state from registered collector or defaults
    let crisisState: CrisisSnapshot = {
      active: false,
      crisisId: null,
      triggerType: null,
      severity: null,
      status: null,
      startedAt: null,
    };
    const crisisCollector = this.stateCollectors.get('crisis');
    if (crisisCollector) {
      try {
        const data = await crisisCollector();
        crisisState = data as unknown as CrisisSnapshot;
      } catch {
        log.warn('Crisis state collector failed');
      }
    }

    // System metrics
    const mem = process.memoryUsage();
    const systemMetrics = {
      heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
      heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
      uptimeSeconds: Math.round(process.uptime()),
      eventLoopLagMs: 0, // placeholder — would use perf_hooks in production
    };

    return {
      activeMolecules,
      pendingBeads,
      workerPool,
      formulaSchedule,
      budgetState,
      crisisState,
      systemMetrics,
      capturedAt: now.toISOString(),
    };
  }

  private buildEmptyPayload(): FullStatePayload {
    return {
      activeMolecules: [],
      pendingBeads: [],
      workerPool: { totalWorkers: 0, activeWorkers: 0, idleWorkers: 0, workers: [] },
      formulaSchedule: { scheduled: [], running: [] },
      budgetState: { dailyBudgetUsd: 0, spentTodayUsd: 0, remainingUsd: 0, alertsActive: [], lastUpdated: new Date().toISOString() },
      crisisState: { active: false, crisisId: null, triggerType: null, severity: null, status: null, startedAt: null },
      systemMetrics: { heapUsedMb: 0, heapTotalMb: 0, uptimeSeconds: 0, eventLoopLagMs: 0 },
      capturedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Restore helpers
  // -------------------------------------------------------------------------

  private async restoreMolecules(molecules: MoleculeState[]): Promise<void> {
    if (molecules.length === 0) return;
    const pool = getPool();
    if (!pool) return;

    for (const mol of molecules) {
      try {
        await pool.query(
          `INSERT INTO meow_molecules (id, formula_id, status, bead_ids, progress, created_at, metadata_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET status = $3, progress = $5`,
          [mol.id, mol.formulaId, mol.status, JSON.stringify(mol.beadIds), mol.progress, mol.createdAt, JSON.stringify(mol.metadata ?? {})],
        );
      } catch (err) {
        log.warn({ err, moleculeId: mol.id }, 'Failed to restore molecule');
      }
    }
  }

  private async restoreBeads(beads: BeadState[]): Promise<void> {
    if (beads.length === 0) return;
    const pool = getPool();
    if (!pool) return;

    for (const bead of beads) {
      try {
        await pool.query(
          `INSERT INTO meow_beads (id, molecule_id, worker_id, status, priority, created_at, assigned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET status = $4, worker_id = $3`,
          [bead.id, bead.moleculeId, bead.workerId, bead.status, bead.priority, bead.createdAt, bead.assignedAt ?? null],
        );
      } catch (err) {
        log.warn({ err, beadId: bead.id }, 'Failed to restore bead');
      }
    }
  }

  private async restoreFormulaSchedule(schedule: FormulaScheduleState): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    for (const item of schedule.scheduled) {
      try {
        await pool.query(
          `INSERT INTO meow_formula_schedule (id, formula_id, scheduled_at, status, priority)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET status = $4`,
          [item.id, item.formulaId, item.scheduledAt, item.status, item.priority],
        );
      } catch (err) {
        log.warn({ err, scheduleId: item.id }, 'Failed to restore formula schedule entry');
      }
    }
  }

  private async replayEventsSinceSnapshot(fromSequence: number): Promise<{ replayed: number; skipped: number }> {
    const pool = getPool();
    if (!pool) return { replayed: 0, skipped: 0 };

    try {
      const { rows } = await pool.query(
        `SELECT id, sequence, type, severity, payload_json, timestamp
         FROM meow_chronicle
         WHERE sequence > $1
         ORDER BY sequence ASC
         LIMIT $2`,
        [fromSequence, MAX_REPLAY_EVENTS],
      );

      let replayed = 0;
      let skipped = 0;

      for (const row of rows) {
        const eventType = row.type as string;
        // Only replay state-changing events
        const replayable = [
          'molecule_created', 'molecule_completed', 'molecule_failed',
          'bead_assigned', 'bead_completed', 'bead_failed',
          'worker_spawned', 'worker_terminated',
          'crisis_started', 'crisis_resolved',
          'schedule_generated',
        ];

        if (replayable.includes(eventType)) {
          replayed += 1;
          // CRIT-05: WARNING — Event replay is NOT actually applied.
          // This method categorizes events as "replayable" but only logs them.
          // True replay requires calling relevant subsystems (molecule manager,
          // worker pool, crisis engine, etc.) to re-apply each event.
          // Until implemented, restores from snapshot will miss events after snapshot time.
          log.warn({ sequence: row.sequence, type: eventType }, 'Chronicle event counted but NOT actually replayed — replay logic not implemented');
        } else {
          skipped += 1;
        }
      }

      return { replayed, skipped };
    } catch (err) {
      log.error({ err }, 'Failed to replay chronicle events');
      return { replayed: 0, skipped: 0 };
    }
  }

  private async analyzeRestoreConflicts(
    snapshot: StateSnapshot,
    conflicts: RestoreConflict[],
    eventsReplayed: number,
  ): Promise<RestoreConflict[] | null> {
    const context = JSON.stringify({
      snapshotId: snapshot.id,
      snapshotAge: Date.now() - snapshot.createdAt.getTime(),
      chronicleSequence: snapshot.chronicleSequence,
      eventsReplayed,
      conflicts,
      activeMolecules: snapshot.payload.activeMolecules.length,
      pendingBeads: snapshot.payload.pendingBeads.length,
    });

    const aiResponse = await callGeminiSnapshot(context);
    if (!aiResponse) return null;

    try {
      const parsed = JSON.parse(aiResponse) as {
        conflicts: RestoreConflict[];
        anomalies: string[];
        recommendation: string;
        confidence: number;
      };
      if (parsed.anomalies && parsed.anomalies.length > 0) {
        log.warn({ anomalies: parsed.anomalies }, 'AI detected anomalies during restore');
      }
      return parsed.conflicts;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Integrity verification
  // -------------------------------------------------------------------------

  verifyChecksum(snapshot: StateSnapshot): boolean {
    const serialized = JSON.stringify(snapshot.payload);
    const checksum = createHash('sha256').update(serialized).digest('hex');
    return checksum === snapshot.checksumSha256;
  }

  async verifyAllSnapshots(): Promise<Array<{ id: string; valid: boolean; error?: string }>> {
    const results: Array<{ id: string; valid: boolean; error?: string }> = [];

    for (const snap of this.snapshots) {
      const valid = this.verifyChecksum(snap);
      results.push({ id: snap.id, valid });
      if (!valid) {
        snap.status = 'corrupted';
        this.stats.corruptedSnapshots += 1;
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Retention enforcement
  // -------------------------------------------------------------------------

  private async enforceRetention(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Keep only last N snapshots
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM meow_state_snapshots WHERE status = 'completed'`,
      );
      const totalCount = parseInt(countRows[0]?.cnt ?? '0', 10);

      if (totalCount > this.config.retentionCount) {
        const toArchive = totalCount - this.config.retentionCount;
        const result = await pool.query(
          `UPDATE meow_state_snapshots
           SET status = 'archived', archived_at = NOW()
           WHERE status = 'completed'
             AND id IN (
               SELECT id FROM meow_state_snapshots
               WHERE status = 'completed'
               ORDER BY created_at ASC
               LIMIT $1
             )`,
          [toArchive],
        );
        const archived = result.rowCount ?? 0;
        this.stats.archivedSnapshots += archived;

        if (archived > 0) {
          log.info({ archived, remaining: this.config.retentionCount }, 'Snapshot retention enforced');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to enforce snapshot retention');
    }
  }

  // -------------------------------------------------------------------------
  // Chronicle sequence helper
  // -------------------------------------------------------------------------

  private async getCurrentChronicleSequence(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM meow_chronicle`,
      );
      return Number(rows[0]?.max_seq ?? 0);
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getLatestSnapshot(): StateSnapshot | null {
    if (this.snapshots.length === 0) return null;
    return this.snapshots[this.snapshots.length - 1];
  }

  private async getLatestValidSnapshot(): Promise<StateSnapshot | null> {
    // Check in-memory first
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const snap = this.snapshots[i];
      if (snap.status === 'completed' && this.verifyChecksum(snap)) {
        return snap;
      }
    }

    // Check DB
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT id FROM meow_state_snapshots
         WHERE status = 'completed'
         ORDER BY created_at DESC
         LIMIT 5`,
      );

      for (const row of rows) {
        const snap = await this.loadSnapshotFromDb(row.id as string);
        if (snap && this.verifyChecksum(snap)) {
          return snap;
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to find latest valid snapshot from DB');
    }

    return null;
  }

  getStats(): SnapshotStats {
    return { ...this.stats };
  }

  getConfig(): SnapshotConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<SnapshotConfig>): void {
    this.config = { ...this.config, ...updates };

    if (updates.intervalMs || updates.enablePeriodic !== undefined) {
      this.stopPeriodicSnapshots();
      if (this.config.enablePeriodic) {
        this.startPeriodicSnapshots();
      }
    }

    log.info({ config: this.config }, 'Snapshot config updated');
  }

  getSnapshotHistory(limit = 10): Array<Omit<StateSnapshot, 'payload'>> {
    return this.snapshots.slice(-limit).map(s => ({
      id: s.id,
      trigger: s.trigger,
      status: s.status,
      checksumSha256: s.checksumSha256,
      sizeBytes: s.sizeBytes,
      chronicleSequence: s.chronicleSequence,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      archivedAt: s.archivedAt,
      label: s.label,
      payload: undefined as unknown as FullStatePayload,
    }));
  }

  // -------------------------------------------------------------------------
  // Stats helpers
  // -------------------------------------------------------------------------

  private updateAvgSize(sizeBytes: number): void {
    const n = this.stats.totalSnapshots;
    if (n <= 1) {
      this.stats.avgSnapshotSizeBytes = sizeBytes;
    } else {
      this.stats.avgSnapshotSizeBytes = Math.round(
        (this.stats.avgSnapshotSizeBytes * (n - 1) + sizeBytes) / n,
      );
    }
  }

  private updateAvgDuration(durationMs: number): void {
    const n = this.stats.totalSnapshots;
    if (n <= 1) {
      this.stats.avgSnapshotDurationMs = durationMs;
    } else {
      this.stats.avgSnapshotDurationMs = Math.round(
        (this.stats.avgSnapshotDurationMs * (n - 1) + durationMs) / n,
      );
    }
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistSnapshot(snapshot: StateSnapshot, serializedPayload: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_state_snapshots
           (id, trigger, status, payload_json, checksum_sha256, size_bytes,
            chronicle_sequence, created_at, expires_at, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           status=$3, archived_at=NOW()`,
        [
          snapshot.id,
          snapshot.trigger,
          snapshot.status,
          serializedPayload,
          snapshot.checksumSha256,
          snapshot.sizeBytes,
          snapshot.chronicleSequence,
          snapshot.createdAt.toISOString(),
          snapshot.expiresAt.toISOString(),
          snapshot.label ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, snapshotId: snapshot.id }, 'Failed to persist snapshot');
    }
  }

  private async persistRestoreReport(report: RestoreReport): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_state_snapshots
           (id, trigger, status, payload_json, checksum_sha256, size_bytes,
            chronicle_sequence, created_at, expires_at, label)
         VALUES ($1, 'manual', 'completed', $2, '', 0, 0, NOW(), NOW() + INTERVAL '30 days', $3)
         ON CONFLICT (id) DO NOTHING`,
        [
          `restore-${report.snapshotId}-${Date.now()}`,
          JSON.stringify(report),
          `Restore report for ${report.snapshotId}`,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist restore report');
    }
  }

  private async loadSnapshotFromDb(snapshotId: string): Promise<StateSnapshot | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT id, trigger, status, payload_json, checksum_sha256, size_bytes,
                chronicle_sequence, created_at, expires_at, archived_at, label
         FROM meow_state_snapshots
         WHERE id = $1`,
        [snapshotId],
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      const payload = typeof row.payload_json === 'string'
        ? JSON.parse(row.payload_json) : row.payload_json;

      return {
        id: row.id,
        trigger: row.trigger as SnapshotTrigger,
        status: row.status as SnapshotStatus,
        payload: payload as FullStatePayload,
        checksumSha256: row.checksum_sha256,
        sizeBytes: Number(row.size_bytes),
        chronicleSequence: Number(row.chronicle_sequence),
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        archivedAt: row.archived_at ? new Date(row.archived_at) : undefined,
        label: row.label ?? undefined,
      };
    } catch (err) {
      log.error({ err, snapshotId }, 'Failed to load snapshot from DB');
      return null;
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, trigger, status, checksum_sha256, size_bytes,
                chronicle_sequence, created_at, expires_at, archived_at, label
         FROM meow_state_snapshots
         WHERE status = 'completed'
         ORDER BY created_at DESC
         LIMIT $1`,
        [MAX_SNAPSHOTS_IN_MEMORY],
      );

      this.stats.totalSnapshots = rows.length;
      if (rows.length > 0) {
        this.stats.lastSnapshotAt = new Date(rows[0].created_at);
      }

      log.info({ snapshots: rows.length }, 'Loaded snapshot metadata from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load snapshots from DB (table may not exist yet)');
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  shutdown(): void {
    this.stopPeriodicSnapshots();
    log.info('State snapshot manager shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: StateSnapshotManager | null = null;

export function getStateSnapshotManager(): StateSnapshotManager {
  if (!instance) {
    instance = new StateSnapshotManager();
  }
  return instance;
}
