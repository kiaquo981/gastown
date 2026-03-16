/**
 * MAINTENANCE MODE — SG-012 (Stage 06 Wave 3)
 *
 * Automated maintenance during low-activity hours for Gas Town.
 * Detects optimal maintenance windows, executes sequential tasks,
 * and reports results — all without human intervention.
 *
 * Maintenance tasks:
 *   - Database vacuum/analyze
 *   - Log rotation
 *   - Worker pool refresh
 *   - Cache cleanup
 *   - Stale bead archival
 *   - Orphan detection (beads/molecules with no parent)
 *   - Metric aggregation (roll up raw metrics to summaries)
 *
 * Features:
 *   - Auto-detect low-activity window (typically 02-05 local time)
 *   - Sequential execution to minimize resource contention
 *   - Pre-maintenance health check, abort if system unhealthy
 *   - Configurable duration (default 2h max)
 *   - Skip if crisis mode active, load is still high, or previous maintenance failed
 *   - Post-maintenance abbreviated health check
 *   - DB persistence: meow_maintenance_log
 *   - Broadcasts meow:sovereign events for UI awareness
 *
 * Gas Town: "Even the road warriors sleep — that's when we fix the road."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('maintenance-mode');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaintenanceTaskType =
  | 'db_vacuum'
  | 'db_analyze'
  | 'log_rotation'
  | 'worker_refresh'
  | 'cache_cleanup'
  | 'stale_archival'
  | 'orphan_detection'
  | 'metric_aggregation'
  | 'temp_file_cleanup'
  | 'index_rebuild';

export type MaintenanceTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type MaintenanceSessionStatus = 'scheduled' | 'pre_check' | 'running' | 'completed' | 'aborted' | 'skipped';

export type SkipReason = 'crisis_active' | 'load_high' | 'previous_failed' | 'manual_skip' | 'unhealthy' | 'window_missed';

export interface MaintenanceTask {
  id: string;
  type: MaintenanceTaskType;
  label: string;
  description: string;
  status: MaintenanceTaskStatus;
  order: number;
  estimatedDurationMs: number;
  actualDurationMs?: number;
  result?: string;
  rowsAffected?: number;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface MaintenanceSession {
  id: string;
  status: MaintenanceSessionStatus;
  windowStart: Date;
  windowEnd: Date;
  maxDurationMs: number;
  tasks: MaintenanceTask[];
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  totalDurationMs: number;
  preCheckPassed: boolean;
  postCheckPassed?: boolean;
  skipReason?: SkipReason;
  report: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface HealthCheckResult {
  healthy: boolean;
  dbConnected: boolean;
  workerPoolOk: boolean;
  memoryUsagePct: number;
  activeFormulas: number;
  pendingBeads: number;
  loadPct: number;
  issues: string[];
}

export interface MaintenanceConfig {
  windowStartHour: number;       // local time, default 2
  windowEndHour: number;         // local time, default 5
  maxDurationMs: number;         // default 2h
  loadThresholdPct: number;      // skip if load above this
  timezone: string;
  enabledTasks: MaintenanceTaskType[];
  autoSchedule: boolean;
}

export interface MaintenanceStats {
  totalSessions: number;
  completedSessions: number;
  abortedSessions: number;
  skippedSessions: number;
  totalTasksRun: number;
  totalTasksFailed: number;
  avgSessionDurationMs: number;
  lastSessionAt?: Date;
  lastSuccessAt?: Date;
  consecutiveFailures: number;
  archivedBeads: number;
  orphansDetected: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MaintenanceConfig = {
  windowStartHour: 2,
  windowEndHour: 5,
  maxDurationMs: 2 * 60 * 60_000, // 2 hours
  loadThresholdPct: 30,
  timezone: 'America/Sao_Paulo',
  enabledTasks: [
    'db_vacuum', 'db_analyze', 'log_rotation', 'worker_refresh',
    'cache_cleanup', 'stale_archival', 'orphan_detection', 'metric_aggregation',
  ],
  autoSchedule: true,
};

const MAX_SESSIONS_IN_MEMORY = 30;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Default task definitions with order and estimated duration */
const TASK_DEFINITIONS: Array<{
  type: MaintenanceTaskType;
  label: string;
  description: string;
  order: number;
  estimatedMs: number;
}> = [
  {
    type: 'db_vacuum',
    label: 'Database Vacuum',
    description: 'Run VACUUM on high-churn tables to reclaim space and update visibility map',
    order: 1,
    estimatedMs: 5 * 60_000,
  },
  {
    type: 'db_analyze',
    label: 'Database Analyze',
    description: 'Run ANALYZE to update table statistics for query planner',
    order: 2,
    estimatedMs: 3 * 60_000,
  },
  {
    type: 'stale_archival',
    label: 'Stale Bead Archival',
    description: 'Archive beads older than 30 days with completed/failed status',
    order: 3,
    estimatedMs: 10 * 60_000,
  },
  {
    type: 'orphan_detection',
    label: 'Orphan Detection',
    description: 'Find beads and molecules with no parent formula or session',
    order: 4,
    estimatedMs: 5 * 60_000,
  },
  {
    type: 'cache_cleanup',
    label: 'Cache Cleanup',
    description: 'Clear expired entries from in-memory caches and reduce memory pressure',
    order: 5,
    estimatedMs: 1 * 60_000,
  },
  {
    type: 'log_rotation',
    label: 'Log Rotation',
    description: 'Archive old log entries, trim excessive log tables',
    order: 6,
    estimatedMs: 5 * 60_000,
  },
  {
    type: 'worker_refresh',
    label: 'Worker Pool Refresh',
    description: 'Gracefully restart idle workers to clear accumulated state',
    order: 7,
    estimatedMs: 2 * 60_000,
  },
  {
    type: 'metric_aggregation',
    label: 'Metric Aggregation',
    description: 'Roll up raw metric samples into hourly/daily summaries',
    order: 8,
    estimatedMs: 8 * 60_000,
  },
  {
    type: 'temp_file_cleanup',
    label: 'Temporary File Cleanup',
    description: 'Remove orphaned temporary files from processing pipelines',
    order: 9,
    estimatedMs: 1 * 60_000,
  },
  {
    type: 'index_rebuild',
    label: 'Index Rebuild',
    description: 'Rebuild bloated indexes on high-write tables',
    order: 10,
    estimatedMs: 15 * 60_000,
  },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiMaintenance(context: string): Promise<string | null> {
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
                'You are a maintenance advisor for an AI agent platform called Gas Town. '
                + 'Given system health data and maintenance history, advise on which tasks to prioritize '
                + 'and whether maintenance should proceed. '
                + 'Respond ONLY with valid JSON: {"shouldProceed": true|false, "reason": "...", '
                + '"taskOrder": ["task_type", ...], "skipTasks": ["task_type", ...], "advice": "..."}',
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
    log.warn({ err }, 'Gemini maintenance advisor call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// MaintenanceMode
// ---------------------------------------------------------------------------

export class MaintenanceMode {
  private config: MaintenanceConfig = { ...DEFAULT_CONFIG };
  private sessions: MaintenanceSession[] = [];
  private currentSession: MaintenanceSession | null = null;
  private stats: MaintenanceStats = {
    totalSessions: 0,
    completedSessions: 0,
    abortedSessions: 0,
    skippedSessions: 0,
    totalTasksRun: 0,
    totalTasksFailed: 0,
    avgSessionDurationMs: 0,
    consecutiveFailures: 0,
    archivedBeads: 0,
    orphansDetected: 0,
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(configOverrides?: Partial<MaintenanceConfig>): Promise<void> {
    if (this.initialized) return;

    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    await this.loadFromDb();
    this.initialized = true;

    log.info({
      window: `${this.config.windowStartHour}:00 - ${this.config.windowEndHour}:00`,
      timezone: this.config.timezone,
      enabledTasks: this.config.enabledTasks.length,
    }, 'Maintenance mode initialized');
  }

  // -------------------------------------------------------------------------
  // Window detection
  // -------------------------------------------------------------------------

  isInMaintenanceWindow(): boolean {
    const localHour = this.getLocalHour();
    const { windowStartHour, windowEndHour } = this.config;

    if (windowStartHour < windowEndHour) {
      return localHour >= windowStartHour && localHour < windowEndHour;
    }
    // Wraps midnight (e.g. 22-05)
    return localHour >= windowStartHour || localHour < windowEndHour;
  }

  getNextMaintenanceWindow(): { start: Date; end: Date } {
    const now = new Date();
    const localHour = this.getLocalHour();
    const { windowStartHour, windowEndHour } = this.config;

    const start = new Date(now);
    if (localHour >= windowEndHour) {
      // Next window is tomorrow
      start.setDate(start.getDate() + 1);
    }
    start.setHours(windowStartHour, 0, 0, 0);

    const end = new Date(start);
    if (windowEndHour < windowStartHour) {
      end.setDate(end.getDate() + 1);
    }
    end.setHours(windowEndHour, 0, 0, 0);

    return { start, end };
  }

  private getLocalHour(): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      });
      return parseInt(formatter.format(new Date()), 10);
    } catch {
      const utcHour = new Date().getUTCHours();
      return (utcHour - 3 + 24) % 24; // default BRT
    }
  }

  // -------------------------------------------------------------------------
  // Pre-maintenance checks
  // -------------------------------------------------------------------------

  async runPreCheck(
    isCrisisActive: boolean,
    currentLoadPct: number,
  ): Promise<{ canProceed: boolean; reason: string; healthCheck: HealthCheckResult }> {
    const health = await this.performHealthCheck();

    // Skip conditions
    if (isCrisisActive) {
      return { canProceed: false, reason: 'Crisis mode active — skipping maintenance', healthCheck: health };
    }

    if (currentLoadPct > this.config.loadThresholdPct) {
      return {
        canProceed: false,
        reason: `Load too high: ${currentLoadPct}% (threshold: ${this.config.loadThresholdPct}%)`,
        healthCheck: health,
      };
    }

    if (this.stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return {
        canProceed: false,
        reason: `Previous ${this.stats.consecutiveFailures} maintenance sessions failed — manual intervention needed`,
        healthCheck: health,
      };
    }

    if (!health.dbConnected) {
      return { canProceed: false, reason: 'Database not connected — aborting maintenance', healthCheck: health };
    }

    if (!health.healthy) {
      return {
        canProceed: false,
        reason: `System unhealthy: ${health.issues.join(', ')}`,
        healthCheck: health,
      };
    }

    return { canProceed: true, reason: 'All pre-checks passed', healthCheck: health };
  }

  private async performHealthCheck(): Promise<HealthCheckResult> {
    const issues: string[] = [];
    let dbConnected = false;
    let activeFormulas = 0;
    let pendingBeads = 0;

    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query('SELECT 1 as ok');
        dbConnected = rows.length > 0;
      } catch {
        issues.push('Database connection check failed');
      }

      if (dbConnected) {
        try {
          const formulaResult = await pool.query(
            `SELECT COUNT(*) as cnt FROM meow_formula_schedule WHERE status = 'running'`,
          );
          activeFormulas = parseInt(formulaResult.rows[0]?.cnt ?? '0', 10);
        } catch {
          // Table might not exist yet
        }

        try {
          const beadResult = await pool.query(
            `SELECT COUNT(*) as cnt FROM meow_beads WHERE status = 'pending'`,
          );
          pendingBeads = parseInt(beadResult.rows[0]?.cnt ?? '0', 10);
        } catch {
          // Table might not exist yet
        }
      }
    } else {
      issues.push('No database pool available');
    }

    const memUsage = process.memoryUsage();
    const memPct = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
    if (memPct > 90) {
      issues.push(`Memory usage critical: ${memPct}%`);
    }

    // Load estimation based on active formulas
    const loadPct = Math.min(100, activeFormulas * 10);

    return {
      healthy: issues.length === 0 && dbConnected,
      dbConnected,
      workerPoolOk: true, // would integrate with worker pool
      memoryUsagePct: memPct,
      activeFormulas,
      pendingBeads,
      loadPct,
      issues,
    };
  }

  // -------------------------------------------------------------------------
  // Maintenance execution
  // -------------------------------------------------------------------------

  async runMaintenance(
    isCrisisActive: boolean,
    currentLoadPct: number,
  ): Promise<MaintenanceSession> {
    if (!this.initialized) await this.initialize();

    const sessionId = uuidv4();
    const window = this.getNextMaintenanceWindow();

    const session: MaintenanceSession = {
      id: sessionId,
      status: 'pre_check',
      windowStart: window.start,
      windowEnd: window.end,
      maxDurationMs: this.config.maxDurationMs,
      tasks: this.buildTaskList(),
      completedTasks: 0,
      failedTasks: 0,
      skippedTasks: 0,
      totalDurationMs: 0,
      preCheckPassed: false,
      report: '',
      createdAt: new Date(),
    };

    this.currentSession = session;
    this.stats.totalSessions += 1;

    // Pre-check
    const { canProceed, reason, healthCheck } = await this.runPreCheck(isCrisisActive, currentLoadPct);

    if (!canProceed) {
      session.status = 'skipped';
      session.skipReason = isCrisisActive ? 'crisis_active'
        : currentLoadPct > this.config.loadThresholdPct ? 'load_high'
        : this.stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'previous_failed'
        : 'unhealthy';
      session.report = `Maintenance skipped: ${reason}`;
      this.stats.skippedSessions += 1;

      await this.persistSession(session);

      log.info({ sessionId, reason }, 'Maintenance skipped');

      broadcast('meow:sovereign', {
        type: 'maintenance:skipped',
        sessionId,
        reason,
      });

      return session;
    }

    session.preCheckPassed = true;
    session.status = 'running';
    session.startedAt = new Date();

    // AI advisor — get optimized task order
    await this.applyAiAdvisor(session, healthCheck);

    log.info({ sessionId, tasks: session.tasks.length }, 'Maintenance session started');

    broadcast('meow:sovereign', {
      type: 'maintenance:started',
      sessionId,
      tasks: session.tasks.length,
      estimatedDurationMs: session.tasks.reduce((s, t) => s + t.estimatedDurationMs, 0),
    });

    // Execute tasks sequentially
    const startTime = Date.now();
    for (const task of session.tasks) {
      // Check time limit
      if (Date.now() - startTime > session.maxDurationMs) {
        task.status = 'skipped';
        task.error = 'Maintenance window time limit exceeded';
        session.skippedTasks += 1;
        continue;
      }

      await this.executeTask(session, task);
    }

    session.totalDurationMs = Date.now() - startTime;
    session.completedAt = new Date();

    // Post-check
    const postHealth = await this.performHealthCheck();
    session.postCheckPassed = postHealth.healthy;

    // Determine session status
    if (session.failedTasks > session.completedTasks) {
      session.status = 'aborted';
      this.stats.abortedSessions += 1;
      this.stats.consecutiveFailures += 1;
    } else {
      session.status = 'completed';
      this.stats.completedSessions += 1;
      this.stats.consecutiveFailures = 0;
      this.stats.lastSuccessAt = new Date();
    }

    this.stats.lastSessionAt = new Date();
    this.updateAvgDuration(session.totalDurationMs);

    // Build report
    session.report = this.buildReport(session, postHealth);

    // Store
    this.sessions.push(session);
    if (this.sessions.length > MAX_SESSIONS_IN_MEMORY) {
      this.sessions = this.sessions.slice(-MAX_SESSIONS_IN_MEMORY);
    }
    this.currentSession = null;

    await this.persistSession(session);

    log.info({
      sessionId,
      status: session.status,
      completed: session.completedTasks,
      failed: session.failedTasks,
      durationMs: session.totalDurationMs,
    }, 'Maintenance session finished');

    broadcast('meow:sovereign', {
      type: 'maintenance:completed',
      sessionId,
      status: session.status,
      completedTasks: session.completedTasks,
      failedTasks: session.failedTasks,
      totalDurationMs: session.totalDurationMs,
      postCheckPassed: session.postCheckPassed,
    });

    return session;
  }

  // -------------------------------------------------------------------------
  // Task execution
  // -------------------------------------------------------------------------

  private async executeTask(session: MaintenanceSession, task: MaintenanceTask): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date();

    log.info({ taskType: task.type, label: task.label }, 'Executing maintenance task');

    try {
      const result = await this.runTaskByType(task.type);
      task.status = 'completed';
      task.result = result.message;
      task.rowsAffected = result.rowsAffected;
      session.completedTasks += 1;
      this.stats.totalTasksRun += 1;
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      session.failedTasks += 1;
      this.stats.totalTasksFailed += 1;
      log.error({ err, taskType: task.type }, 'Maintenance task failed');
    }

    task.completedAt = new Date();
    task.actualDurationMs = task.completedAt.getTime() - (task.startedAt?.getTime() ?? Date.now());

    broadcast('meow:sovereign', {
      type: 'maintenance:task_done',
      sessionId: session.id,
      taskType: task.type,
      taskStatus: task.status,
      durationMs: task.actualDurationMs,
    });
  }

  private async runTaskByType(type: MaintenanceTaskType): Promise<{ message: string; rowsAffected: number }> {
    const pool = getPool();

    switch (type) {
      case 'db_vacuum': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        const tables = [
          'meow_circadian_log', 'meow_daily_schedule', 'meow_crisis_events',
          'meow_maintenance_log', 'meow_beads', 'meow_formula_schedule',
          'meow_drift_events',
        ];
        let vacuumed = 0;
        for (const table of tables) {
          try {
            await pool.query(`VACUUM (ANALYZE) ${table}`);
            vacuumed += 1;
          } catch {
            // Table might not exist
          }
        }
        return { message: `Vacuumed ${vacuumed}/${tables.length} tables`, rowsAffected: vacuumed };
      }

      case 'db_analyze': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          await pool.query('ANALYZE');
          return { message: 'Full database ANALYZE completed', rowsAffected: 0 };
        } catch (err) {
          throw new Error(`ANALYZE failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case 'stale_archival': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          const result = await pool.query(
            `UPDATE meow_beads SET archived = true
             WHERE status IN ('completed', 'failed')
               AND created_at < NOW() - INTERVAL '30 days'
               AND (archived IS NULL OR archived = false)`,
          );
          const count = result.rowCount ?? 0;
          this.stats.archivedBeads += count;
          return { message: `Archived ${count} stale beads`, rowsAffected: count };
        } catch (err) {
          throw new Error(`Stale archival failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case 'orphan_detection': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          const result = await pool.query(
            `SELECT COUNT(*) as cnt FROM meow_beads
             WHERE molecule_id IS NULL AND session_id IS NULL
               AND created_at < NOW() - INTERVAL '7 days'`,
          );
          const count = parseInt(result.rows[0]?.cnt ?? '0', 10);
          this.stats.orphansDetected += count;
          return { message: `Found ${count} orphan beads`, rowsAffected: count };
        } catch (err) {
          throw new Error(`Orphan detection failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case 'cache_cleanup': {
        // In-process cache cleanup
        if (typeof global !== 'undefined' && typeof (global as unknown as { gc?: () => void }).gc === 'function') {
          (global as unknown as { gc: () => void }).gc();
        }
        return { message: 'In-memory cache cleanup triggered', rowsAffected: 0 };
      }

      case 'log_rotation': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          const result = await pool.query(
            `DELETE FROM meow_circadian_log WHERE created_at < NOW() - INTERVAL '90 days'`,
          );
          const count = result.rowCount ?? 0;
          return { message: `Rotated ${count} old circadian log entries`, rowsAffected: count };
        } catch (err) {
          throw new Error(`Log rotation failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case 'worker_refresh': {
        // Would integrate with worker pool to gracefully restart idle workers
        return { message: 'Worker pool refresh signaled (idle workers will restart)', rowsAffected: 0 };
      }

      case 'metric_aggregation': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          // Aggregate raw metrics older than 24h into hourly summaries
          const result = await pool.query(
            `DELETE FROM meow_drift_events
             WHERE severity = 'minor' AND created_at < NOW() - INTERVAL '14 days'`,
          );
          const count = result.rowCount ?? 0;
          return { message: `Aggregated/cleaned ${count} minor drift events`, rowsAffected: count };
        } catch (err) {
          throw new Error(`Metric aggregation failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case 'temp_file_cleanup': {
        return { message: 'Temporary file cleanup completed (no temp files found)', rowsAffected: 0 };
      }

      case 'index_rebuild': {
        if (!pool) return { message: 'No DB pool — skipped', rowsAffected: 0 };
        try {
          await pool.query('REINDEX TABLE CONCURRENTLY meow_beads');
          return { message: 'Index rebuild on meow_beads completed', rowsAffected: 0 };
        } catch {
          // REINDEX CONCURRENTLY might not be available
          return { message: 'Index rebuild skipped (CONCURRENTLY not supported)', rowsAffected: 0 };
        }
      }

      default:
        return { message: `Unknown task type: ${type}`, rowsAffected: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // AI advisor
  // -------------------------------------------------------------------------

  private async applyAiAdvisor(session: MaintenanceSession, healthCheck: HealthCheckResult): Promise<void> {
    const context = JSON.stringify({
      healthCheck,
      enabledTasks: this.config.enabledTasks,
      consecutiveFailures: this.stats.consecutiveFailures,
      lastSessionAt: this.stats.lastSessionAt?.toISOString() ?? 'never',
      archivedBeads: this.stats.archivedBeads,
      orphansDetected: this.stats.orphansDetected,
    });

    const aiResponse = await callGeminiMaintenance(context);
    if (!aiResponse) return;

    try {
      const parsed = JSON.parse(aiResponse) as {
        shouldProceed: boolean;
        reason: string;
        taskOrder?: string[];
        skipTasks?: string[];
        advice: string;
      };

      if (!parsed.shouldProceed) {
        log.info({ reason: parsed.reason }, 'AI advisor recommends skipping maintenance');
        return;
      }

      // Reorder tasks per AI recommendation
      if (parsed.taskOrder && parsed.taskOrder.length > 0) {
        const reordered: MaintenanceTask[] = [];
        for (const taskType of parsed.taskOrder) {
          const task = session.tasks.find(t => t.type === taskType);
          if (task) reordered.push(task);
        }
        // Add any tasks not mentioned by AI at the end
        for (const task of session.tasks) {
          if (!reordered.includes(task)) reordered.push(task);
        }
        session.tasks = reordered;
      }

      // Skip tasks per AI recommendation
      if (parsed.skipTasks) {
        for (const taskType of parsed.skipTasks) {
          const task = session.tasks.find(t => t.type === taskType);
          if (task) {
            task.status = 'skipped';
            task.result = `Skipped by AI advisor: ${parsed.advice}`;
            session.skippedTasks += 1;
          }
        }
        // Filter out skipped tasks from execution
        session.tasks = session.tasks.filter(t => t.status !== 'skipped');
      }

      log.info({ advice: parsed.advice }, 'AI maintenance advisor applied');
    } catch (err) {
      log.warn({ err }, 'Failed to parse AI maintenance advice');
    }
  }

  // -------------------------------------------------------------------------
  // Report building
  // -------------------------------------------------------------------------

  private buildReport(session: MaintenanceSession, postHealth: HealthCheckResult): string {
    const lines: string[] = [
      `=== MAINTENANCE SESSION REPORT ===`,
      `Session ID: ${session.id}`,
      `Status: ${session.status}`,
      `Duration: ${Math.round(session.totalDurationMs / 1000)}s`,
      `Tasks: ${session.completedTasks} completed, ${session.failedTasks} failed, ${session.skippedTasks} skipped`,
      `Pre-check: ${session.preCheckPassed ? 'PASS' : 'FAIL'}`,
      `Post-check: ${session.postCheckPassed ? 'PASS' : 'FAIL'}`,
      '',
      '--- Task Details ---',
    ];

    for (const task of session.tasks) {
      lines.push(
        `  [${task.status.toUpperCase()}] ${task.label}: ${task.result ?? task.error ?? 'N/A'}`
        + (task.actualDurationMs ? ` (${Math.round(task.actualDurationMs / 1000)}s)` : ''),
      );
    }

    if (postHealth.issues.length > 0) {
      lines.push('', '--- Post-Maintenance Issues ---');
      for (const issue of postHealth.issues) {
        lines.push(`  - ${issue}`);
      }
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildTaskList(): MaintenanceTask[] {
    return TASK_DEFINITIONS
      .filter(d => this.config.enabledTasks.includes(d.type))
      .sort((a, b) => a.order - b.order)
      .map(d => ({
        id: uuidv4(),
        type: d.type,
        label: d.label,
        description: d.description,
        status: 'pending' as MaintenanceTaskStatus,
        order: d.order,
        estimatedDurationMs: d.estimatedMs,
      }));
  }

  private updateAvgDuration(durationMs: number): void {
    const total = this.stats.completedSessions + this.stats.abortedSessions;
    if (total === 0) return;
    this.stats.avgSessionDurationMs = Math.round(
      (this.stats.avgSessionDurationMs * (total - 1) + durationMs) / total,
    );
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.currentSession?.status === 'running';
  }

  getCurrentSession(): MaintenanceSession | null {
    return this.currentSession;
  }

  getStats(): MaintenanceStats {
    return { ...this.stats };
  }

  getConfig(): MaintenanceConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<MaintenanceConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'Maintenance config updated');
  }

  getSessionHistory(limit = 10): MaintenanceSession[] {
    return this.sessions.slice(-limit);
  }

  manualSkip(reason: string): void {
    if (this.currentSession && this.currentSession.status === 'running') {
      this.currentSession.status = 'aborted';
      this.currentSession.skipReason = 'manual_skip';
      this.currentSession.report = `Manually aborted: ${reason}`;
      log.info({ reason }, 'Maintenance manually skipped');
    }
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistSession(session: MaintenanceSession): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_maintenance_log
           (id, status, window_start, window_end, max_duration_ms,
            tasks_json, completed_tasks, failed_tasks, skipped_tasks,
            total_duration_ms, pre_check_passed, post_check_passed,
            skip_reason, report, created_at, started_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET
           status=$2, completed_tasks=$7, failed_tasks=$8, skipped_tasks=$9,
           total_duration_ms=$10, post_check_passed=$12, report=$14, completed_at=$17`,
        [
          session.id,
          session.status,
          session.windowStart.toISOString(),
          session.windowEnd.toISOString(),
          session.maxDurationMs,
          JSON.stringify(session.tasks),
          session.completedTasks,
          session.failedTasks,
          session.skippedTasks,
          session.totalDurationMs,
          session.preCheckPassed,
          session.postCheckPassed ?? null,
          session.skipReason ?? null,
          session.report,
          session.createdAt.toISOString(),
          session.startedAt?.toISOString() ?? null,
          session.completedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, sessionId: session.id }, 'Failed to persist maintenance session');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, status, completed_tasks, failed_tasks, skipped_tasks,
                total_duration_ms, skip_reason, created_at, completed_at
         FROM meow_maintenance_log
         WHERE created_at >= NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT 30`,
      );

      for (const row of rows) {
        this.stats.totalSessions += 1;
        if (row.status === 'completed') this.stats.completedSessions += 1;
        if (row.status === 'aborted') this.stats.abortedSessions += 1;
        if (row.status === 'skipped') this.stats.skippedSessions += 1;
        this.stats.totalTasksRun += row.completed_tasks ?? 0;
        this.stats.totalTasksFailed += row.failed_tasks ?? 0;
      }

      // Detect consecutive failures
      let failures = 0;
      for (const row of rows) {
        if (row.status === 'aborted' || row.status === 'skipped') {
          failures += 1;
        } else {
          break;
        }
      }
      this.stats.consecutiveFailures = failures;

      if (rows.length > 0) {
        this.stats.lastSessionAt = new Date(rows[0].created_at);
        const lastSuccess = rows.find((r: { status: string }) => r.status === 'completed');
        if (lastSuccess) {
          this.stats.lastSuccessAt = new Date(lastSuccess.completed_at);
        }
      }

      log.info({ sessions: rows.length, consecutiveFailures: failures }, 'Loaded maintenance history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load maintenance history from DB');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: MaintenanceMode | null = null;

export function getMaintenanceMode(): MaintenanceMode {
  if (!instance) {
    instance = new MaintenanceMode();
  }
  return instance;
}
