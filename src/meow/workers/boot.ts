/**
 * BOOT — Watchdog for Deacon (EP-045)
 *
 * Gas Town: "Boot watches the Deacon. If the Deacon dies, Boot barks."
 *
 * Simple liveness checker that pings the Deacon every 5 minutes.
 * After 3 consecutive failures, sends WhatsApp alert to Overseer.
 * Boot is the last line of defense — it should never die.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import { deacon } from './deacon';
import type { PatrolReport, PatrolCheck, FeedEvent, FeedEventType } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BootConfig {
  checkIntervalMs: number;       // How often to check deacon (default 5min)
  maxFailures: number;           // Consecutive failures before alert (default 3)
  alertCooldownMs: number;       // Min time between alerts (default 30min)
}

export interface BootStatus {
  isRunning: boolean;
  consecutiveFailures: number;
  lastCheck?: Date;
  lastSuccess?: Date;
  lastAlert?: Date;
  totalChecks: number;
  totalFailures: number;
  deaconHealth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BootConfig = {
  checkIntervalMs: 5 * 60 * 1000,     // 5 minutes
  maxFailures: 3,
  alertCooldownMs: 30 * 60 * 1000,    // 30 minutes
};

// ─────────────────────────────────────────────────────────────────────────────
// Boot Watchdog
// ─────────────────────────────────────────────────────────────────────────────

export class Boot {
  private config: BootConfig;
  private timer?: NodeJS.Timeout;
  private consecutiveFailures: number = 0;
  private lastCheck?: Date;
  private lastSuccess?: Date;
  private lastAlert?: Date;
  private totalChecks: number = 0;
  private totalFailures: number = 0;
  private lastReport?: PatrolReport;

  constructor(config?: Partial<BootConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the watchdog loop */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);

    addActivity({
      type: 'info',
      action: 'boot_started',
      details: `Boot watchdog started (check every ${this.config.checkIntervalMs / 1000}s)`,
    });
  }

  /** Stop the watchdog loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one liveness check on the Deacon */
  async check(): Promise<PatrolReport> {
    this.totalChecks++;
    this.lastCheck = new Date();
    const checks: PatrolCheck[] = [];
    const startedAt = new Date();

    // 1. Check if Deacon is responding
    let deaconAlive = false;
    const t0 = Date.now();
    try {
      const health = deacon.getHealth();
      deaconAlive = typeof health === 'number' && health >= 0;
      checks.push({
        id: 'deacon-alive',
        name: 'Deacon Responsive',
        passed: deaconAlive,
        details: `Health score: ${health}`,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      checks.push({
        id: 'deacon-alive',
        name: 'Deacon Responsive',
        passed: false,
        details: `Error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t0,
      });
    }

    // 2. Check if Deacon has recent report
    const lastReport = deacon.getLastReport();
    const reportAge = lastReport?.completedAt
      ? Date.now() - new Date(lastReport.completedAt).getTime()
      : Infinity;
    const reportFresh = reportAge < this.config.checkIntervalMs * 4; // Allow 4x interval slack

    checks.push({
      id: 'deacon-report-fresh',
      name: 'Deacon Report Fresh',
      passed: reportFresh,
      details: lastReport?.completedAt
        ? `Last report ${Math.round(reportAge / 1000)}s ago`
        : 'No report available',
      durationMs: 0,
    });

    // 3. Check Deacon's dog statuses
    const dogs = deacon.getDogStatuses();
    const dogsRunning = dogs.length > 0;
    checks.push({
      id: 'deacon-dogs',
      name: 'Deacon Dogs Active',
      passed: dogsRunning,
      details: `${dogs.length} dogs registered`,
      durationMs: 0,
    });

    // 4. Memory pressure check
    const memUsage = process.memoryUsage();
    const heapPct = memUsage.heapUsed / memUsage.heapTotal;
    checks.push({
      id: 'memory-pressure',
      name: 'Memory Pressure',
      passed: heapPct < 0.90,
      details: `Heap: ${Math.round(heapPct * 100)}%`,
      durationMs: 0,
    });

    // Evaluate results
    const passed = checks.filter(c => c.passed).length;
    const allPassed = passed === checks.length;

    if (allPassed) {
      this.consecutiveFailures = 0;
      this.lastSuccess = new Date();
    } else {
      this.consecutiveFailures++;
      this.totalFailures++;

      this.emitFeed('patrol_alert',
        `Boot: Deacon check failed (${this.consecutiveFailures}/${this.config.maxFailures})`,
        { metadata: { failures: this.consecutiveFailures, checks: checks.filter(c => !c.passed).map(c => c.name) } },
      );

      // Alert after maxFailures consecutive failures
      if (this.consecutiveFailures >= this.config.maxFailures) {
        await this.alertOverseer(checks);
      }
    }

    const report: PatrolReport = {
      id: uuidv4(),
      owner: 'boot',
      status: 'completed',
      checks,
      passedCount: passed,
      failedCount: checks.length - passed,
      totalChecks: checks.length,
      startedAt,
      completedAt: new Date(),
      nextScheduled: new Date(Date.now() + this.config.checkIntervalMs),
      alerts: checks.filter(c => !c.passed).map(c => `${c.name}: ${c.details}`),
    };

    this.lastReport = report;
    return report;
  }

  /** Alert the Overseer (human) — via WhatsApp if configured, or SSE + activity log */
  private async alertOverseer(checks: PatrolCheck[]): Promise<void> {
    // Cooldown check
    if (this.lastAlert) {
      const sinceLast = Date.now() - this.lastAlert.getTime();
      if (sinceLast < this.config.alertCooldownMs) return;
    }

    this.lastAlert = new Date();
    const failedChecks = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.details}`);

    const alertMsg = `BOOT ALERT: Deacon unresponsive after ${this.consecutiveFailures} checks. Failed: ${failedChecks.join('; ')}`;

    // SSE critical alert
    this.emitFeed('system_health', alertMsg, {
      metadata: {
        severity: 'critical',
        consecutiveFailures: this.consecutiveFailures,
        failedChecks,
      },
    });

    addActivity({
      type: 'error',
      action: 'boot_alert',
      details: alertMsg,
    });

    // WhatsApp alert via Evolution API (if configured)
    const phone = process.env.MOROS_OPERATOR_PHONE;
    const evoUrl = process.env.EVOLUTION_API_URL;
    const evoInstance = process.env.EVOLUTION_INSTANCE;
    const evoKey = process.env.EVOLUTION_API_KEY;

    if (phone && evoUrl && evoInstance && evoKey) {
      try {
        const response = await fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': evoKey,
          },
          body: JSON.stringify({
            number: phone,
            text: `🚨 *BOOT WATCHDOG ALERT*\n\n${alertMsg}\n\nTimestamp: ${new Date().toISOString()}`,
          }),
        });

        if (response.ok) {
          addActivity({
            type: 'info',
            action: 'boot_wa_sent',
            details: `Boot WhatsApp alert sent to ${phone}`,
          });
        }
      } catch (err) {
        addActivity({
          type: 'warning',
          action: 'boot_wa_failed',
          details: `Boot WhatsApp alert failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /** Get current status */
  status(): BootStatus {
    return {
      isRunning: !!this.timer,
      consecutiveFailures: this.consecutiveFailures,
      lastCheck: this.lastCheck,
      lastSuccess: this.lastSuccess,
      lastAlert: this.lastAlert,
      totalChecks: this.totalChecks,
      totalFailures: this.totalFailures,
      deaconHealth: deacon.getHealth(),
    };
  }

  /** Get last patrol report */
  getLastReport(): PatrolReport | undefined {
    return this.lastReport;
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'boot',
      message,
      severity: type === 'system_health' ? 'critical' : 'warning',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton Boot instance */
export const boot = new Boot();
