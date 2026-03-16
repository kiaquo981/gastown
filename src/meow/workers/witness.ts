/**
 * WITNESS — Polecat Supervisor
 *
 * Gas Town: "Witness watches polecats. Nudges stuck ones. Escalates after 3 failures."
 * Runs patrol loops, monitors polecat health, reports to Mayor.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import { polecatManager, type PolecatInstance } from './polecat';
import { mayor } from './mayor';
import type { PatrolReport, PatrolCheck, FeedEvent, FeedEventType } from '../types';

export interface WitnessConfig {
  patrolIntervalMs: number;         // How often to run patrol (default 5 min)
  maxNudges: number;                // Max nudges before escalation (default 3)
  stallWarningMs: number;           // Warn if polecat inactive for this long
}

const DEFAULT_CONFIG: WitnessConfig = {
  patrolIntervalMs: 5 * 60 * 1000,
  maxNudges: 3,
  stallWarningMs: 5 * 60 * 1000,
};

export class Witness {
  private config: WitnessConfig;
  private rig: string;
  private nudgeCounts: Map<string, number> = new Map();
  private patrolTimer?: NodeJS.Timeout;
  private lastReport?: PatrolReport;

  constructor(rig: string, config?: Partial<WitnessConfig>) {
    this.rig = rig;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start patrol loop */
  startPatrol(): void {
    if (this.patrolTimer) return;
    this.patrolTimer = setInterval(() => this.patrol(), this.config.patrolIntervalMs);
    addActivity({
      type: 'info',
      action: 'witness_patrol_started',
      details: `Witness for rig "${this.rig}" started patrol (every ${this.config.patrolIntervalMs / 1000}s)`,
    });
  }

  /** Stop patrol loop */
  stopPatrol(): void {
    if (this.patrolTimer) {
      clearInterval(this.patrolTimer);
      this.patrolTimer = undefined;
    }
  }

  /** Run one patrol cycle — 10-step Gas Town witness patrol */
  async patrol(): Promise<PatrolReport> {
    const startedAt = new Date();
    const checks: PatrolCheck[] = [];

    // 1. Check polecat health
    const health = polecatManager.healthCheck();
    checks.push({
      id: 'polecat-health',
      name: 'Polecat Health Check',
      passed: health.zombies.length === 0 && health.stalled.length === 0,
      details: `Active: ${health.active}, Idle: ${health.idle}, Stalled: ${health.stalled.length}, Zombies: ${health.zombies.length}`,
      durationMs: 0,
    });

    // 2. Check queue depth
    checks.push({
      id: 'queue-depth',
      name: 'Queue Depth',
      passed: health.queued <= 10,
      details: `${health.queued} tasks queued`,
      durationMs: 0,
    });

    // 3. Check stalled polecats — nudge or escalate
    for (const stalledId of health.stalled) {
      const nudgeCount = this.nudgeCounts.get(stalledId) || 0;
      if (nudgeCount >= this.config.maxNudges) {
        await this.escalate(stalledId, `Polecat ${stalledId} stalled ${nudgeCount} times`);
        checks.push({
          id: `escalate-${stalledId}`,
          name: `Escalate ${stalledId}`,
          passed: false,
          details: `Escalated after ${nudgeCount} nudges`,
          durationMs: 0,
        });
      } else {
        await this.nudge(stalledId);
        checks.push({
          id: `nudge-${stalledId}`,
          name: `Nudge ${stalledId}`,
          passed: true,
          details: `Nudge #${nudgeCount + 1}`,
          durationMs: 0,
        });
      }
    }

    // 4. Check zombie polecats — cleanup
    if (health.zombies.length > 0) {
      await polecatManager.cleanup();
      checks.push({
        id: 'zombie-cleanup',
        name: 'Zombie Cleanup',
        passed: true,
        details: `Cleaned ${health.zombies.length} zombies`,
        durationMs: 0,
      });
    }

    // 5. Check capacity
    const stats = polecatManager.stats();
    checks.push({
      id: 'capacity',
      name: 'Capacity Check',
      passed: stats.working < stats.total || stats.total < 10,
      details: `${stats.working}/${stats.total} working, ${stats.queued} queued`,
      durationMs: 0,
    });

    // Build report
    const report: PatrolReport = {
      id: uuidv4(),
      owner: 'witness',
      rig: this.rig,
      status: 'completed',
      checks,
      passedCount: checks.filter(c => c.passed).length,
      failedCount: checks.filter(c => !c.passed).length,
      totalChecks: checks.length,
      startedAt,
      completedAt: new Date(),
      nextScheduled: new Date(Date.now() + this.config.patrolIntervalMs),
      alerts: checks.filter(c => !c.passed).map(c => c.details || c.name),
    };

    this.lastReport = report;

    // Broadcast report
    this.emitFeed('patrol_completed', `Witness patrol: ${report.passedCount}/${report.totalChecks} passed`, {
      metadata: { reportId: report.id, passed: report.passedCount, failed: report.failedCount },
    });

    if (report.failedCount > 0) {
      this.emitFeed('patrol_alert', `Witness alert: ${report.failedCount} checks failed`, {
        metadata: { alerts: report.alerts },
      });
    }

    return report;
  }

  /** Nudge a stalled polecat */
  async nudge(polecatId: string): Promise<void> {
    const count = (this.nudgeCounts.get(polecatId) || 0) + 1;
    this.nudgeCounts.set(polecatId, count);

    addActivity({
      type: 'warning',
      action: 'witness_nudge',
      details: `Witness nudged polecat ${polecatId} (nudge #${count})`,
      agentId: polecatId,
    });
  }

  /** Escalate to Mayor after max nudges exceeded */
  async escalate(polecatId: string, reason: string): Promise<void> {
    await mayor.handleEscalation(reason, `witness-${this.rig}`, polecatId);
    this.nudgeCounts.delete(polecatId);

    addActivity({
      type: 'error',
      action: 'witness_escalate',
      details: `Witness escalated polecat ${polecatId} to Mayor: ${reason}`,
      agentId: polecatId,
    });
  }

  /** Get last patrol report */
  getLastReport(): PatrolReport | undefined {
    return this.lastReport;
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> }
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: `witness-${this.rig}`,
      rig: this.rig,
      message,
      severity: type === 'patrol_alert' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}
