/**
 * ZOMBIE DETECTION ADVANCED — CG-018 (Stage 05 Wave 5)
 *
 * Advanced zombie/stuck process detection beyond simple timeouts.
 * Multi-signal zombie scoring, graduated response protocol,
 * AI analysis for legitimate long-running tasks, pattern-based
 * prevention, and automatic work reassignment after zombie kill.
 *
 * Detection signals:
 *   - No heartbeat within expected interval
 *   - No SSE events emitted recently
 *   - No DB writes (step completions, artifact saves)
 *   - Stale lock held beyond expected duration
 *   - Memory/CPU anomalies (if available)
 *
 * Graduated response:
 *   ping → nudge → warning → kill → reallocate
 *
 * Gas Town: "A stalled rig blocks the whole road. Tow it or torch it."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { WorkerIdentity } from '../types';

const log = createLogger('zombie-detection-advanced');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ZombieSignal =
  | 'no_heartbeat'
  | 'no_sse_events'
  | 'no_db_writes'
  | 'stale_lock'
  | 'memory_anomaly'
  | 'stuck_step'
  | 'no_progress';

export type ZombieResponseLevel =
  | 'ping'
  | 'nudge'
  | 'warning'
  | 'kill'
  | 'reallocate';

export type ZombieEventOutcome =
  | 'recovered'        // worker resumed after ping/nudge
  | 'killed'           // worker forcefully terminated
  | 'reallocated'      // work moved to another worker
  | 'false_positive'   // turned out to be legitimately busy
  | 'pending';         // still in progress

export interface ZombieScore {
  workerId: string;
  beadId?: string;
  signals: Array<{ signal: ZombieSignal; weight: number; detail: string }>;
  totalScore: number;                 // 0-100
  threshold: number;                  // score threshold for action
  isZombie: boolean;
  recommendedAction: ZombieResponseLevel;
  scoredAt: Date;
}

export interface ZombieEvent {
  id: string;
  workerId: string;
  beadId?: string;
  signals: ZombieSignal[];
  score: number;
  responseLevel: ZombieResponseLevel;
  outcome: ZombieEventOutcome;
  aiAnalysis?: string;                // AI assessment of legitimacy
  createdAt: Date;
  resolvedAt?: Date;
}

export interface ZombiePattern {
  skill: string;
  formulaName?: string;
  occurrences: number;
  avgScoreBeforeZombie: number;
  avgTimeToZombieMs: number;
  lastSeen: Date;
}

export interface ZombieThresholds {
  heartbeatMaxMs: number;             // max time without heartbeat
  sseMaxMs: number;                   // max time without SSE events
  dbWriteMaxMs: number;               // max time without DB writes
  lockMaxMs: number;                  // max lock hold time
  progressMaxMs: number;              // max time without step progress
  scoreThreshold: number;             // score above which worker is zombie
}

export interface ZombieDetectionConfig {
  scanIntervalMs: number;             // how often to scan (default 30s)
  defaultThresholds: ZombieThresholds;
  thresholdOverrides: Map<string, Partial<ZombieThresholds>>; // per worker type
  enableAiAnalysis: boolean;
  enableAutoReassign: boolean;
}

export interface ZombieDetectionReport {
  totalScans: number;
  zombiesDetected: number;
  zombiesKilled: number;
  zombiesRecovered: number;
  falsePositives: number;
  topPatterns: ZombiePattern[];
  avgDetectionTimeMs: number;
  generatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ZombieThresholds = {
  heartbeatMaxMs: 60_000,             // 1 minute without heartbeat
  sseMaxMs: 90_000,                   // 1.5 minutes without SSE
  dbWriteMaxMs: 120_000,              // 2 minutes without DB writes
  lockMaxMs: 300_000,                 // 5 minutes stale lock
  progressMaxMs: 180_000,             // 3 minutes without step progress
  scoreThreshold: 60,                 // 60/100 = zombie
};

const SIGNAL_WEIGHTS: Record<ZombieSignal, number> = {
  no_heartbeat:   30,
  no_sse_events:  15,
  no_db_writes:   20,
  stale_lock:     15,
  memory_anomaly: 10,
  stuck_step:     25,
  no_progress:    20,
};

const RESPONSE_ESCALATION: ZombieResponseLevel[] = ['ping', 'nudge', 'warning', 'kill', 'reallocate'];

// Score thresholds for each response level
const RESPONSE_THRESHOLDS: Record<ZombieResponseLevel, number> = {
  ping: 30,
  nudge: 45,
  warning: 60,
  kill: 75,
  reallocate: 85,
};

const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const MAX_EVENTS_IN_MEMORY = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// ZombieDetector
// ─────────────────────────────────────────────────────────────────────────────

export class ZombieDetector {
  private events: ZombieEvent[] = [];
  private patterns = new Map<string, ZombiePattern>();
  private workerHistory = new Map<string, ZombieResponseLevel[]>(); // escalation tracking
  private scanTimer: NodeJS.Timeout | null = null;
  private totalScans = 0;
  private config: ZombieDetectionConfig;

  constructor(config?: Partial<ZombieDetectionConfig>) {
    this.config = {
      scanIntervalMs: config?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      defaultThresholds: config?.defaultThresholds ?? { ...DEFAULT_THRESHOLDS },
      thresholdOverrides: config?.thresholdOverrides ?? new Map(),
      enableAiAnalysis: config?.enableAiAnalysis ?? true,
      enableAutoReassign: config?.enableAutoReassign ?? true,
    };
  }

  // ─── Score a worker for zombie-ness ────────────────────────────────

  async scoreWorker(workerId: string, beadId?: string): Promise<ZombieScore> {
    const thresholds = this.getThresholdsForWorker(workerId);
    const signals: Array<{ signal: ZombieSignal; weight: number; detail: string }> = [];

    // Signal 1: Heartbeat check
    const lastHeartbeat = await this.getLastHeartbeat(workerId);
    if (lastHeartbeat) {
      const elapsed = Date.now() - lastHeartbeat.getTime();
      if (elapsed > thresholds.heartbeatMaxMs) {
        signals.push({
          signal: 'no_heartbeat',
          weight: SIGNAL_WEIGHTS.no_heartbeat,
          detail: `No heartbeat for ${Math.round(elapsed / 1000)}s (threshold: ${thresholds.heartbeatMaxMs / 1000}s)`,
        });
      }
    }

    // Signal 2: SSE events check
    const lastSse = await this.getLastSseEvent(workerId);
    if (lastSse) {
      const elapsed = Date.now() - lastSse.getTime();
      if (elapsed > thresholds.sseMaxMs) {
        signals.push({
          signal: 'no_sse_events',
          weight: SIGNAL_WEIGHTS.no_sse_events,
          detail: `No SSE events for ${Math.round(elapsed / 1000)}s`,
        });
      }
    }

    // Signal 3: DB writes check
    const lastDbWrite = await this.getLastDbWrite(workerId);
    if (lastDbWrite) {
      const elapsed = Date.now() - lastDbWrite.getTime();
      if (elapsed > thresholds.dbWriteMaxMs) {
        signals.push({
          signal: 'no_db_writes',
          weight: SIGNAL_WEIGHTS.no_db_writes,
          detail: `No DB writes for ${Math.round(elapsed / 1000)}s`,
        });
      }
    }

    // Signal 4: Stale lock check
    const lockAge = await this.getLockAge(workerId);
    if (lockAge !== null && lockAge > thresholds.lockMaxMs) {
      signals.push({
        signal: 'stale_lock',
        weight: SIGNAL_WEIGHTS.stale_lock,
        detail: `Lock held for ${Math.round(lockAge / 1000)}s (threshold: ${thresholds.lockMaxMs / 1000}s)`,
      });
    }

    // Signal 5: Step progress check
    const lastProgress = await this.getLastStepProgress(workerId);
    if (lastProgress) {
      const elapsed = Date.now() - lastProgress.getTime();
      if (elapsed > thresholds.progressMaxMs) {
        signals.push({
          signal: 'no_progress',
          weight: SIGNAL_WEIGHTS.no_progress,
          detail: `No step progress for ${Math.round(elapsed / 1000)}s`,
        });
      }
    }

    // Signal 6: Stuck step (running step with no recent output)
    const stuckStep = await this.hasStuckStep(workerId);
    if (stuckStep) {
      signals.push({
        signal: 'stuck_step',
        weight: SIGNAL_WEIGHTS.stuck_step,
        detail: `Step "${stuckStep}" is stuck with no output`,
      });
    }

    // Compute total score (capped at 100)
    const totalScore = Math.min(100, signals.reduce((s, sig) => s + sig.weight, 0));
    const isZombie = totalScore >= thresholds.scoreThreshold;

    // Determine recommended action based on score
    let recommendedAction: ZombieResponseLevel = 'ping';
    for (const level of RESPONSE_ESCALATION) {
      if (totalScore >= RESPONSE_THRESHOLDS[level]) {
        recommendedAction = level;
      }
    }

    // Check escalation history — if we already pinged/nudged, escalate
    const history = this.workerHistory.get(workerId) ?? [];
    if (history.length > 0 && isZombie) {
      const lastAction = history[history.length - 1];
      const lastIdx = RESPONSE_ESCALATION.indexOf(lastAction);
      const recIdx = RESPONSE_ESCALATION.indexOf(recommendedAction);
      if (recIdx <= lastIdx && lastIdx < RESPONSE_ESCALATION.length - 1) {
        recommendedAction = RESPONSE_ESCALATION[lastIdx + 1];
      }
    }

    return {
      workerId,
      beadId,
      signals,
      totalScore,
      threshold: thresholds.scoreThreshold,
      isZombie,
      recommendedAction,
      scoredAt: new Date(),
    };
  }

  // ─── Execute graduated response ────────────────────────────────────

  async respond(score: ZombieScore): Promise<ZombieEvent> {
    const event: ZombieEvent = {
      id: uuidv4(),
      workerId: score.workerId,
      beadId: score.beadId,
      signals: score.signals.map(s => s.signal),
      score: score.totalScore,
      responseLevel: score.recommendedAction,
      outcome: 'pending',
      createdAt: new Date(),
    };

    // Track escalation
    const history = this.workerHistory.get(score.workerId) ?? [];
    history.push(score.recommendedAction);
    this.workerHistory.set(score.workerId, history.slice(-10)); // keep last 10

    // AI analysis for ambiguous cases (60-80 score range)
    if (this.config.enableAiAnalysis && score.totalScore >= 50 && score.totalScore < 80) {
      event.aiAnalysis = await this.getAiAnalysis(score);
      if (event.aiAnalysis?.toLowerCase().includes('legitimate')) {
        event.outcome = 'false_positive';
        log.info({ workerId: score.workerId, score: score.totalScore }, 'AI determined task is legitimately long-running');
        await this.persistEvent(event);
        this.events.push(event);
        return event;
      }
    }

    // Execute response based on level
    switch (score.recommendedAction) {
      case 'ping':
        await this.sendPing(score.workerId);
        break;
      case 'nudge':
        await this.sendNudge(score.workerId, score);
        break;
      case 'warning':
        await this.sendWarning(score.workerId, score);
        break;
      case 'kill':
        await this.killWorker(score.workerId);
        event.outcome = 'killed';
        break;
      case 'reallocate':
        await this.killWorker(score.workerId);
        if (score.beadId && this.config.enableAutoReassign) {
          await this.reallocateWork(score.beadId, score.workerId);
          event.outcome = 'reallocated';
        } else {
          event.outcome = 'killed';
        }
        break;
    }

    // Update zombie pattern tracking
    if (score.isZombie) {
      await this.updatePatterns(score);
    }

    // Persist and store
    await this.persistEvent(event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'zombie_detected',
      zombie: {
        id: event.id,
        workerId: event.workerId,
        beadId: event.beadId,
        score: event.score,
        response: event.responseLevel,
        outcome: event.outcome,
        signals: event.signals,
        timestamp: event.createdAt.toISOString(),
      },
    });

    log.info({
      workerId: score.workerId,
      score: score.totalScore,
      response: score.recommendedAction,
      signals: score.signals.length,
    }, 'Zombie response executed');

    return event;
  }

  // ─── Prevention: check if bead matches zombie-prone pattern ────────

  async checkZombieRisk(skill: string, formulaName?: string): Promise<{
    riskLevel: 'low' | 'medium' | 'high';
    matchedPattern?: ZombiePattern;
    recommendation?: string;
  }> {
    const key = formulaName ? `${skill}:${formulaName}` : skill;
    const pattern = this.patterns.get(key) ?? this.patterns.get(skill);

    if (!pattern || pattern.occurrences < 3) {
      return { riskLevel: 'low' };
    }

    if (pattern.occurrences >= 10) {
      return {
        riskLevel: 'high',
        matchedPattern: pattern,
        recommendation: `Skill "${skill}" has produced ${pattern.occurrences} zombies. Consider adding checkpoints or reducing timeout. Avg time to zombie: ${Math.round(pattern.avgTimeToZombieMs / 1000)}s.`,
      };
    }

    return {
      riskLevel: 'medium',
      matchedPattern: pattern,
      recommendation: `Skill "${skill}" has ${pattern.occurrences} zombie occurrences. Monitor closely.`,
    };
  }

  // ─── Scan all active workers ───────────────────────────────────────

  async scanAllWorkers(): Promise<ZombieScore[]> {
    this.totalScans += 1;
    const pool = getPool();
    if (!pool) return [];

    const zombieScores: ZombieScore[] = [];

    try {
      // Get all workers with active beads
      const { rows } = await pool.query(
        `SELECT DISTINCT b.assignee AS worker_id, b.id AS bead_id
         FROM beads b
         WHERE b.status = 'in_progress' AND b.assignee IS NOT NULL`,
      );

      for (const row of rows) {
        try {
          const score = await this.scoreWorker(
            row.worker_id as string,
            row.bead_id as string,
          );

          if (score.isZombie) {
            zombieScores.push(score);
            await this.respond(score);
          }
        } catch (err) {
          log.error({ err, workerId: row.worker_id }, 'Failed to score worker');
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to scan workers for zombies');
    }

    if (zombieScores.length > 0) {
      log.info({ count: zombieScores.length, totalScans: this.totalScans }, 'Zombie scan complete — zombies found');
    }

    return zombieScores;
  }

  // ─── Lifecycle management ──────────────────────────────────────────

  startScanner(): void {
    if (this.scanTimer) return;
    log.info({ intervalMs: this.config.scanIntervalMs }, 'Zombie scanner started');

    this.scanTimer = setInterval(async () => {
      try {
        await this.scanAllWorkers();
      } catch (err) {
        log.error({ err }, 'Zombie scanner tick failed');
      }
    }, this.config.scanIntervalMs);
  }

  stopScanner(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      log.info('Zombie scanner stopped');
    }
  }

  isScannerRunning(): boolean {
    return this.scanTimer !== null;
  }

  // ─── Mark event resolved ───────────────────────────────────────────

  async markRecovered(workerId: string): Promise<void> {
    const pending = this.events.filter(e => e.workerId === workerId && e.outcome === 'pending');
    for (const evt of pending) {
      evt.outcome = 'recovered';
      evt.resolvedAt = new Date();
      await this.updateEventOutcome(evt.id, 'recovered');
    }
    // Clear escalation history on recovery
    this.workerHistory.delete(workerId);
  }

  // ─── Report ────────────────────────────────────────────────────────

  getReport(): ZombieDetectionReport {
    const resolved = this.events.filter(e => e.outcome !== 'pending');
    const killed = resolved.filter(e => e.outcome === 'killed').length;
    const recovered = resolved.filter(e => e.outcome === 'recovered').length;
    const falsePos = resolved.filter(e => e.outcome === 'false_positive').length;

    // Avg detection time (from first signal to action)
    const detectionTimes = resolved
      .filter(e => e.resolvedAt)
      .map(e => e.resolvedAt!.getTime() - e.createdAt.getTime());
    const avgDetectionTimeMs = detectionTimes.length > 0
      ? Math.round(detectionTimes.reduce((s, t) => s + t, 0) / detectionTimes.length)
      : 0;

    return {
      totalScans: this.totalScans,
      zombiesDetected: resolved.length,
      zombiesKilled: killed,
      zombiesRecovered: recovered,
      falsePositives: falsePos,
      topPatterns: Array.from(this.patterns.values())
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 10),
      avgDetectionTimeMs,
      generatedAt: new Date(),
    };
  }

  // ─── Internal: signal queries ──────────────────────────────────────

  private async getLastHeartbeat(workerId: string): Promise<Date | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT last_heartbeat FROM meow_worker_status
         WHERE worker_id = $1 LIMIT 1`,
        [workerId],
      );
      return rows[0]?.last_heartbeat ? new Date(rows[0].last_heartbeat as string) : null;
    } catch {
      return null;
    }
  }

  private async getLastSseEvent(workerId: string): Promise<Date | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT MAX(created_at) AS last_event
         FROM feed_events
         WHERE source = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
        [workerId],
      );
      return rows[0]?.last_event ? new Date(rows[0].last_event as string) : null;
    } catch {
      return null;
    }
  }

  private async getLastDbWrite(workerId: string): Promise<Date | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT GREATEST(
           (SELECT MAX(updated_at) FROM beads WHERE assignee = $1),
           (SELECT MAX(updated_at) FROM molecules WHERE id IN (
             SELECT molecule_id FROM beads WHERE assignee = $1
           ))
         ) AS last_write`,
        [workerId],
      );
      return rows[0]?.last_write ? new Date(rows[0].last_write as string) : null;
    } catch {
      return null;
    }
  }

  private async getLockAge(workerId: string): Promise<number | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - acquired_at)) * 1000 AS age_ms
         FROM meow_locks
         WHERE holder_id = $1 AND released_at IS NULL
         ORDER BY acquired_at ASC LIMIT 1`,
        [workerId],
      );
      return rows[0]?.age_ms ? parseFloat(rows[0].age_ms as string) : null;
    } catch {
      return null;
    }
  }

  private async getLastStepProgress(workerId: string): Promise<Date | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT MAX(ms.completed_at) AS last_progress
         FROM beads b
         JOIN molecules m ON m.id = b.molecule_id
         CROSS JOIN LATERAL jsonb_array_elements(m.steps::jsonb) AS step_elem
         CROSS JOIN LATERAL jsonb_to_record(step_elem) AS ms(completed_at timestamptz)
         WHERE b.assignee = $1 AND b.status = 'in_progress'`,
        [workerId],
      );
      return rows[0]?.last_progress ? new Date(rows[0].last_progress as string) : null;
    } catch {
      // Fallback: just check bead updated_at
      try {
        const { rows } = await pool.query(
          `SELECT MAX(updated_at) AS last_update
           FROM beads WHERE assignee = $1 AND status = 'in_progress'`,
          [workerId],
        );
        return rows[0]?.last_update ? new Date(rows[0].last_update as string) : null;
      } catch {
        return null;
      }
    }
  }

  private async hasStuckStep(workerId: string): Promise<string | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT b.title FROM beads b
         WHERE b.assignee = $1 AND b.status = 'in_progress'
           AND b.started_at < NOW() - INTERVAL '5 minutes'
           AND b.updated_at < NOW() - INTERVAL '3 minutes'
         LIMIT 1`,
        [workerId],
      );
      return rows[0]?.title as string | null ?? null;
    } catch {
      return null;
    }
  }

  // ─── Internal: response actions ────────────────────────────────────

  private async sendPing(workerId: string): Promise<void> {
    broadcast('meow:cognitive', {
      type: 'zombie_ping',
      workerId,
      message: 'Heartbeat check — are you still active?',
      timestamp: new Date().toISOString(),
    });
    log.debug({ workerId }, 'Sent zombie ping');
  }

  private async sendNudge(workerId: string, score: ZombieScore): Promise<void> {
    broadcast('meow:cognitive', {
      type: 'zombie_nudge',
      workerId,
      score: score.totalScore,
      signals: score.signals.map(s => s.signal),
      message: `Worker appears stalled (score: ${score.totalScore}). Please respond or task will be reassigned.`,
      timestamp: new Date().toISOString(),
    });
    log.info({ workerId, score: score.totalScore }, 'Sent zombie nudge');
  }

  private async sendWarning(workerId: string, score: ZombieScore): Promise<void> {
    broadcast('meow:cognitive', {
      type: 'zombie_warning',
      workerId,
      score: score.totalScore,
      signals: score.signals.map(s => s.signal),
      message: `ZOMBIE WARNING: Worker ${workerId} will be terminated if no response in 60s.`,
      severity: 'warning',
      timestamp: new Date().toISOString(),
    });
    log.warn({ workerId, score: score.totalScore }, 'Sent zombie warning');
  }

  private async killWorker(workerId: string): Promise<void> {
    const pool = getPool();

    // Mark worker status as zombie
    if (pool) {
      try {
        await pool.query(
          `UPDATE meow_worker_status SET status = 'zombie', updated_at = NOW()
           WHERE worker_id = $1`,
          [workerId],
        );
      } catch (err) {
        log.error({ err, workerId }, 'Failed to update worker status to zombie');
      }
    }

    broadcast('meow:cognitive', {
      type: 'zombie_killed',
      workerId,
      message: `Worker ${workerId} terminated as zombie.`,
      severity: 'error',
      timestamp: new Date().toISOString(),
    });

    log.warn({ workerId }, 'Worker killed as zombie');
  }

  private async reallocateWork(beadId: string, zombieWorkerId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Unassign bead from zombie and set back to ready
      await pool.query(
        `UPDATE beads
         SET assignee = NULL, status = 'ready', updated_at = NOW()
         WHERE id = $1 AND assignee = $2`,
        [beadId, zombieWorkerId],
      );

      broadcast('meow:cognitive', {
        type: 'work_reallocated',
        beadId,
        fromWorker: zombieWorkerId,
        message: `Bead ${beadId} reallocated from zombie worker ${zombieWorkerId}`,
        timestamp: new Date().toISOString(),
      });

      log.info({ beadId, fromWorker: zombieWorkerId }, 'Work reallocated from zombie worker');
    } catch (err) {
      log.error({ err, beadId, zombieWorkerId }, 'Failed to reallocate work from zombie');
    }
  }

  // ─── Internal: AI analysis ─────────────────────────────────────────

  private async getAiAnalysis(score: ZombieScore): Promise<string | undefined> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return this.getHeuristicAnalysis(score);

    try {
      const signalSummary = score.signals
        .map(s => `- ${s.signal}: ${s.detail}`)
        .join('\n');

      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          max_tokens: 200,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: 'You are a process health monitor. Determine if the worker process is truly stuck (zombie) or legitimately working on a long-running task. Respond with either "ZOMBIE: [reason]" or "LEGITIMATE: [reason]". Be concise.',
            },
            {
              role: 'user',
              content: `Worker: ${score.workerId}\nBead: ${score.beadId ?? 'unknown'}\nZombie Score: ${score.totalScore}/100\nSignals:\n${signalSummary}`,
            },
          ],
        }),
      });

      if (!res.ok) return this.getHeuristicAnalysis(score);

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim();
    } catch (err) {
      log.warn({ err }, 'AI zombie analysis failed — using heuristic');
      return this.getHeuristicAnalysis(score);
    }
  }

  private getHeuristicAnalysis(score: ZombieScore): string {
    if (score.totalScore >= 80) return 'ZOMBIE: Multiple strong signals indicate a stuck process.';
    if (score.totalScore >= 60) return 'ZOMBIE: Moderate signals suggest the process has stalled.';
    if (score.signals.length === 1) return 'LEGITIMATE: Only one signal detected — may be a slow operation.';
    return 'ZOMBIE: Multiple signals present — likely stuck.';
  }

  // ─── Internal: pattern tracking ────────────────────────────────────

  private async updatePatterns(score: ZombieScore): Promise<void> {
    // Try to get skill from bead
    const pool = getPool();
    if (!pool || !score.beadId) return;

    try {
      const { rows } = await pool.query(
        `SELECT skill, formula FROM beads WHERE id = $1 LIMIT 1`,
        [score.beadId],
      );

      if (rows.length === 0) return;

      const skill = rows[0].skill as string | null;
      if (!skill) return;

      const formulaName = rows[0].formula as string | undefined;
      const key = formulaName ? `${skill}:${formulaName}` : skill;

      const existing = this.patterns.get(key) ?? {
        skill,
        formulaName,
        occurrences: 0,
        avgScoreBeforeZombie: 0,
        avgTimeToZombieMs: 0,
        lastSeen: new Date(),
      };

      existing.occurrences += 1;
      existing.avgScoreBeforeZombie = Math.round(
        (existing.avgScoreBeforeZombie + (score.totalScore - existing.avgScoreBeforeZombie) / existing.occurrences),
      );
      existing.lastSeen = new Date();
      this.patterns.set(key, existing);
    } catch (err) {
      log.error({ err }, 'Failed to update zombie patterns');
    }
  }

  // ─── Internal: thresholds ──────────────────────────────────────────

  private getThresholdsForWorker(workerId: string): ZombieThresholds {
    const override = this.config.thresholdOverrides.get(workerId);
    if (!override) return { ...this.config.defaultThresholds };
    return { ...this.config.defaultThresholds, ...override };
  }

  setThresholdOverride(workerIdOrType: string, overrides: Partial<ZombieThresholds>): void {
    this.config.thresholdOverrides.set(workerIdOrType, overrides);
  }

  // ─── Persistence ───────────────────────────────────────────────────

  private async persistEvent(event: ZombieEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_zombie_events
          (id, worker_id, bead_id, signals, score, response_level,
           outcome, ai_analysis, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          event.id,
          event.workerId,
          event.beadId ?? null,
          JSON.stringify(event.signals),
          event.score,
          event.responseLevel,
          event.outcome,
          event.aiAnalysis ?? null,
          event.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist zombie event');
    }
  }

  private async updateEventOutcome(eventId: string, outcome: ZombieEventOutcome): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_zombie_events SET outcome = $1, resolved_at = NOW() WHERE id = $2`,
        [outcome, eventId],
      );
    } catch (err) {
      log.error({ err, eventId }, 'Failed to update zombie event outcome');
    }
  }

  /** Load zombie patterns from DB on startup */
  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT ze.worker_id, ze.bead_id, ze.signals, ze.score, ze.outcome, ze.created_at,
                b.skill, b.formula
         FROM meow_zombie_events ze
         LEFT JOIN beads b ON b.id = ze.bead_id
         WHERE ze.created_at >= $1
         ORDER BY ze.created_at DESC
         LIMIT 2000`,
        [since.toISOString()],
      );

      for (const row of rows) {
        const skill = row.skill as string | null;
        if (skill) {
          const formulaName = row.formula as string | undefined;
          const key = formulaName ? `${skill}:${formulaName}` : skill;
          const existing = this.patterns.get(key) ?? {
            skill,
            formulaName,
            occurrences: 0,
            avgScoreBeforeZombie: 0,
            avgTimeToZombieMs: 0,
            lastSeen: new Date(row.created_at as string),
          };
          existing.occurrences += 1;
          existing.avgScoreBeforeZombie = Math.round(
            existing.avgScoreBeforeZombie + ((row.score as number) - existing.avgScoreBeforeZombie) / existing.occurrences,
          );
          this.patterns.set(key, existing);
        }
      }

      log.info({ events: rows.length, patterns: this.patterns.size }, 'Loaded zombie history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load zombie history from DB');
    }
  }

  getEventCount(): number {
    return this.events.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: ZombieDetector | null = null;

export function getZombieDetector(): ZombieDetector {
  if (!instance) {
    instance = new ZombieDetector();
  }
  return instance;
}
