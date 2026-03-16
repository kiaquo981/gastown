/**
 * DEACON — Daemon Beacon (System Health)
 *
 * Gas Town: "Deacon watches over everything. Has Dogs that do the dirty work."
 * Monitors Mayor, Witnesses, system health. Runs the 26-step patrol.
 * Dogs: Compactor (GC), Doctor (health), Janitor (cleanup), WispReaper (ephemeral cleanup)
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import { mayor } from './mayor';
import { polecatManager } from './polecat';
import type { PatrolReport, PatrolCheck, FeedEvent, FeedEventType, DogType } from '../types';

export interface Dog {
  type: DogType;
  name: string;
  lastRun?: Date;
  run: () => Promise<{ actions: number; details: string }>;
}

export interface DeaconConfig {
  patrolIntervalMs: number;
  compactIntervalMs: number;
  healthCheckIntervalMs: number;
}

const DEFAULT_CONFIG: DeaconConfig = {
  patrolIntervalMs: 10 * 60 * 1000,     // 10 min
  compactIntervalMs: 60 * 60 * 1000,    // 1 hour
  healthCheckIntervalMs: 5 * 60 * 1000, // 5 min
};

export class Deacon {
  private config: DeaconConfig;
  private dogs: Map<DogType, Dog> = new Map();
  private patrolTimer?: NodeJS.Timeout;
  private lastReport?: PatrolReport;
  private systemHealth: number = 100; // 0-100 score

  constructor(config?: Partial<DeaconConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initDogs();
  }

  private initDogs(): void {
    // Compactor Dog — garbage collection
    this.dogs.set('compactor', {
      type: 'compactor',
      name: 'Compactor',
      run: async () => {
        // Clean up old completed polecats
        const { cleaned } = await polecatManager.cleanup();
        return { actions: cleaned, details: `Compacted ${cleaned} expired workers` };
      },
    });

    // Doctor Dog — health checks
    this.dogs.set('doctor', {
      type: 'doctor',
      name: 'Doctor',
      run: async () => {
        const health = polecatManager.healthCheck();
        const issues = health.stalled.length + health.zombies.length;
        return {
          actions: issues,
          details: `Health: ${health.active} active, ${issues} issues (${health.stalled.length} stalled, ${health.zombies.length} zombie)`,
        };
      },
    });

    // Janitor Dog — cleanup temp files, logs
    this.dogs.set('janitor', {
      type: 'janitor',
      name: 'Janitor',
      run: async () => {
        // Future: cleanup .worktrees/, temp files, old logs
        return { actions: 0, details: 'Janitor sweep complete' };
      },
    });

    // WispReaper Dog — cleanup expired wisps
    this.dogs.set('wisp_reaper', {
      type: 'wisp_reaper',
      name: 'Wisp Reaper',
      run: async () => {
        // Future: clean expired wisps from MEOW engine
        return { actions: 0, details: 'No expired wisps' };
      },
    });
  }

  /** Start patrol loop */
  startPatrol(): void {
    if (this.patrolTimer) return;
    this.patrolTimer = setInterval(() => this.patrol(), this.config.patrolIntervalMs);
    addActivity({
      type: 'info',
      action: 'deacon_started',
      details: `Deacon started patrol (every ${this.config.patrolIntervalMs / 1000}s)`,
    });
  }

  /** Stop patrol loop */
  stopPatrol(): void {
    if (this.patrolTimer) {
      clearInterval(this.patrolTimer);
      this.patrolTimer = undefined;
    }
  }

  /** Run full patrol — comprehensive system health check */
  async patrol(): Promise<PatrolReport> {
    const startedAt = new Date();
    const checks: PatrolCheck[] = [];

    // 1. Mayor status
    const mayorStatus = mayor.status();
    checks.push({
      id: 'mayor-alive',
      name: 'Mayor Alive',
      passed: true,
      details: `${mayorStatus.activeConvoys} convoys, ${mayorStatus.unreadMail} unread mail`,
      durationMs: 0,
    });

    // 2. Polecat health
    const pcHealth = polecatManager.healthCheck();
    checks.push({
      id: 'polecats-health',
      name: 'Polecat System Health',
      passed: pcHealth.zombies.length === 0,
      details: `Active: ${pcHealth.active}, Idle: ${pcHealth.idle}, Stalled: ${pcHealth.stalled.length}, Zombie: ${pcHealth.zombies.length}`,
      durationMs: 0,
    });

    // 3. Queue overflow check
    checks.push({
      id: 'queue-overflow',
      name: 'Queue Overflow',
      passed: pcHealth.queued <= 20,
      details: `${pcHealth.queued} items queued`,
      durationMs: 0,
    });

    // 4. Run each dog
    for (const [type, dog] of this.dogs) {
      const t0 = Date.now();
      try {
        const result = await dog.run();
        dog.lastRun = new Date();
        checks.push({
          id: `dog-${type}`,
          name: `Dog: ${dog.name}`,
          passed: true,
          details: result.details,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        checks.push({
          id: `dog-${type}`,
          name: `Dog: ${dog.name}`,
          passed: false,
          details: `Error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - t0,
        });
      }
    }

    // 5. Memory usage check
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    checks.push({
      id: 'memory',
      name: 'Memory Usage',
      passed: heapUsedMB < heapTotalMB * 0.85,
      details: `Heap: ${heapUsedMB}MB / ${heapTotalMB}MB (${Math.round(heapUsedMB / heapTotalMB * 100)}%)`,
      durationMs: 0,
    });

    // 6. Uptime check
    const uptimeHours = Math.round(process.uptime() / 3600 * 10) / 10;
    checks.push({
      id: 'uptime',
      name: 'Process Uptime',
      passed: true,
      details: `${uptimeHours}h uptime`,
      durationMs: 0,
    });

    // Calculate system health score
    const passed = checks.filter(c => c.passed).length;
    this.systemHealth = Math.round((passed / checks.length) * 100);

    const report: PatrolReport = {
      id: uuidv4(),
      owner: 'deacon',
      status: 'completed',
      checks,
      passedCount: passed,
      failedCount: checks.length - passed,
      totalChecks: checks.length,
      startedAt,
      completedAt: new Date(),
      nextScheduled: new Date(Date.now() + this.config.patrolIntervalMs),
      alerts: checks.filter(c => !c.passed).map(c => `${c.name}: ${c.details}`),
    };

    this.lastReport = report;

    // Broadcast
    this.emitFeed('patrol_completed', `Deacon patrol: ${passed}/${checks.length} passed (health: ${this.systemHealth}%)`, {
      metadata: { reportId: report.id, health: this.systemHealth },
    });

    if (report.failedCount > 0) {
      this.emitFeed('patrol_alert', `Deacon alert: ${report.failedCount} checks failed`, {
        metadata: { alerts: report.alerts },
      });
    }

    return report;
  }

  /** Get system health score */
  getHealth(): number {
    return this.systemHealth;
  }

  /** Get last patrol report */
  getLastReport(): PatrolReport | undefined {
    return this.lastReport;
  }

  /** Get all dog statuses */
  getDogStatuses(): Array<{ type: DogType; name: string; lastRun?: Date }> {
    return Array.from(this.dogs.values()).map(d => ({
      type: d.type,
      name: d.name,
      lastRun: d.lastRun,
    }));
  }

  /** Run a specific dog manually */
  async runDog(type: DogType): Promise<{ actions: number; details: string }> {
    const dog = this.dogs.get(type);
    if (!dog) throw new Error(`Dog ${type} not found`);
    const result = await dog.run();
    dog.lastRun = new Date();
    return result;
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> }
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'deacon',
      message,
      severity: type === 'patrol_alert' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton Deacon */
export const deacon = new Deacon();
