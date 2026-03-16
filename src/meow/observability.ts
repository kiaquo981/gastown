/**
 * OBSERVABILITY — Centralized Monitoring (EP-131 → EP-140)
 *
 * Gas Town: "What you can't see, you can't fix."
 *
 * Provides:
 * - Activity Feed aggregation (EP-131)
 * - Townlog centralized logging (EP-132)
 * - Keepalive heartbeat system (EP-133)
 * - Budget Tracking / Paperclip (EP-134)
 * - Cost aggregation per agent/skill/BU (EP-135)
 * - Patrol Reports aggregation (EP-136)
 * - Molecule Metrics (EP-137)
 * - Error Trending (EP-138)
 * - System Health Score 0-100 (EP-139)
 * - Alerting Rules engine (EP-140)
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../sse';
import type { FeedEvent, FeedEventType, PatrolReport, AgentBudget } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TownlogEntry {
  id: string;
  source: string;              // Worker/service ID
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  category: string;            // molecule, worker, patrol, hook, mail, convoy
  message: string;
  metadata?: Record<string, unknown>;
  beadId?: string;
  moleculeId?: string;
  timestamp: Date;
}

export interface KeepaliveEntry {
  workerId: string;
  workerName: string;
  lastSeen: Date;
  intervalMs: number;          // Expected heartbeat interval
  status: 'alive' | 'stale' | 'dead';
  missedBeats: number;
}

export interface MoleculeMetric {
  moleculeId: string;
  formulaId: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  durationMs: number;
  totalTokens: number;
  costUsd: number;
  startedAt: Date;
  completedAt?: Date;
  status: 'running' | 'completed' | 'failed';
}

export interface ErrorTrend {
  pattern: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  sources: string[];           // Which workers/services hit this
  trending: 'up' | 'stable' | 'down';
  resolved: boolean;
}

export type AlertChannel = 'sse' | 'whatsapp' | 'email';
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: string;           // Human-readable condition
  channels: AlertChannel[];
  severity: AlertSeverity;
  cooldownMs: number;          // Min time between alerts
  lastFired?: Date;
  fireCount: number;
}

export interface HealthComponent {
  name: string;
  score: number;               // 0-100
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  details?: string;
}

export interface HealthReport {
  score: number;               // 0-100 overall
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: HealthComponent[];
  timestamp: Date;
}

export interface ObservabilityConfig {
  townlogMaxEntries: number;         // Max log entries (default 5000)
  keepaliveCheckIntervalMs: number;  // How often to check heartbeats (default 60s)
  keepaliveStaleMs: number;          // Mark stale after N ms (default 2min)
  keepaliveDeadMs: number;           // Mark dead after N ms (default 5min)
  metricsRetentionCount: number;     // Max molecule metrics (default 1000)
  errorTrendWindowMs: number;        // Error trend window (default 1h)
  alertDefaultCooldownMs: number;    // Default alert cooldown (default 5min)
}

export interface ObservabilityStats {
  townlogEntries: number;
  keepaliveWorkers: number;
  keepaliveAlive: number;
  keepaliveStale: number;
  keepaliveDead: number;
  budgetsTracked: number;
  budgetsWarning: number;
  budgetsPaused: number;
  patrolReportsStored: number;
  moleculeMetrics: number;
  errorTrends: number;
  activeAlertRules: number;
  lastHealthScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ObservabilityConfig = {
  townlogMaxEntries: 5000,
  keepaliveCheckIntervalMs: 60_000,     // 1 min
  keepaliveStaleMs: 2 * 60_000,         // 2 min
  keepaliveDeadMs: 5 * 60_000,          // 5 min
  metricsRetentionCount: 1000,
  errorTrendWindowMs: 60 * 60_000,      // 1 hour
  alertDefaultCooldownMs: 5 * 60_000,   // 5 min
};

// ─────────────────────────────────────────────────────────────────────────────
// ObservabilityEngine
// ─────────────────────────────────────────────────────────────────────────────

export class ObservabilityEngine {
  private config: ObservabilityConfig;

  // Townlog (EP-132)
  private townlog: TownlogEntry[] = [];

  // Keepalive (EP-133)
  private keepalives: Map<string, KeepaliveEntry> = new Map();
  private keepaliveTimer?: NodeJS.Timeout;

  // Budgets (EP-134)
  private budgets: Map<string, AgentBudget> = new Map();

  // Patrol Reports (EP-136)
  private patrolReports: PatrolReport[] = [];

  // Molecule Metrics (EP-137)
  private moleculeMetrics: MoleculeMetric[] = [];

  // Error Trending (EP-138)
  private errorTrends: Map<string, ErrorTrend> = new Map();

  // Alerting (EP-140)
  private alertRules: Map<string, AlertRule> = new Map();

  // Health (EP-139)
  private lastHealth?: HealthReport;

  constructor(config?: Partial<ObservabilityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registerDefaultAlertRules();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOWNLOG (EP-132) — Centralized log for all MEOW events
  // ═══════════════════════════════════════════════════════════════════════════

  log(
    source: string,
    level: TownlogEntry['level'],
    category: string,
    message: string,
    extra?: { metadata?: Record<string, unknown>; beadId?: string; moleculeId?: string },
  ): TownlogEntry {
    const entry: TownlogEntry = {
      id: `tl-${uuidv4().slice(0, 8)}`,
      source,
      level,
      category,
      message,
      metadata: extra?.metadata,
      beadId: extra?.beadId,
      moleculeId: extra?.moleculeId,
      timestamp: new Date(),
    };

    this.townlog.push(entry);
    if (this.townlog.length > this.config.townlogMaxEntries) {
      this.townlog.shift();
    }

    // Critical/error → also emit SSE
    if (level === 'critical' || level === 'error') {
      broadcast('meow:townlog', entry);
      this.checkAlertRules(entry);
    }

    return entry;
  }

  /** Query townlog with filters */
  queryTownlog(filters?: {
    level?: TownlogEntry['level'];
    category?: string;
    source?: string;
    since?: Date;
    limit?: number;
  }): TownlogEntry[] {
    let results = this.townlog;

    if (filters?.level) results = results.filter(e => e.level === filters.level);
    if (filters?.category) results = results.filter(e => e.category === filters.category);
    if (filters?.source) results = results.filter(e => e.source === filters.source);
    if (filters?.since) results = results.filter(e => e.timestamp >= filters.since!);

    const limit = filters?.limit || 100;
    return results.slice(-limit).reverse();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KEEPALIVE (EP-133) — Worker heartbeat system
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register a worker for keepalive monitoring */
  registerWorker(workerId: string, workerName: string, intervalMs: number = 60_000): void {
    this.keepalives.set(workerId, {
      workerId,
      workerName,
      lastSeen: new Date(),
      intervalMs,
      status: 'alive',
      missedBeats: 0,
    });
  }

  /** Worker sends heartbeat */
  heartbeat(workerId: string): void {
    const entry = this.keepalives.get(workerId);
    if (entry) {
      entry.lastSeen = new Date();
      entry.status = 'alive';
      entry.missedBeats = 0;
    }
  }

  /** Check all keepalives (run periodically) */
  checkKeepalives(): KeepaliveEntry[] {
    const now = Date.now();
    const alerts: KeepaliveEntry[] = [];

    for (const [, entry] of this.keepalives) {
      const elapsed = now - entry.lastSeen.getTime();

      if (elapsed > this.config.keepaliveDeadMs) {
        if (entry.status !== 'dead') {
          entry.status = 'dead';
          entry.missedBeats = Math.floor(elapsed / entry.intervalMs);
          alerts.push(entry);
          this.log('keepalive', 'critical', 'worker', `Worker "${entry.workerName}" is DEAD (${entry.missedBeats} missed beats)`);
        }
      } else if (elapsed > this.config.keepaliveStaleMs) {
        if (entry.status !== 'stale') {
          entry.status = 'stale';
          entry.missedBeats = Math.floor(elapsed / entry.intervalMs);
          alerts.push(entry);
          this.log('keepalive', 'warning', 'worker', `Worker "${entry.workerName}" is stale (${entry.missedBeats} missed beats)`);
        }
      } else {
        entry.status = 'alive';
        entry.missedBeats = 0;
      }
    }

    return alerts;
  }

  /** Start keepalive check loop */
  startKeepaliveCheck(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      this.checkKeepalives();
    }, this.config.keepaliveCheckIntervalMs);
  }

  /** Stop keepalive check loop */
  stopKeepaliveCheck(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  /** Get all keepalive entries */
  getKeepalives(): KeepaliveEntry[] {
    return Array.from(this.keepalives.values());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUDGET TRACKING / PAPERCLIP (EP-134 + EP-135)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Set budget for an agent */
  setBudget(agentId: string, budget: Partial<AgentBudget>): AgentBudget {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const existing = this.budgets.get(agentId);

    const updated: AgentBudget = {
      agentId,
      monthlyTokenLimit: budget.monthlyTokenLimit ?? existing?.monthlyTokenLimit ?? 1_000_000,
      tokensUsed: budget.tokensUsed ?? existing?.tokensUsed ?? 0,
      monthlyCostLimitUsd: budget.monthlyCostLimitUsd ?? existing?.monthlyCostLimitUsd ?? 10,
      costUsedUsd: budget.costUsedUsd ?? existing?.costUsedUsd ?? 0,
      period: budget.period ?? existing?.period ?? period,
      status: 'active',
      warningThreshold: budget.warningThreshold ?? existing?.warningThreshold ?? 0.8,
      pauseThreshold: budget.pauseThreshold ?? existing?.pauseThreshold ?? 1.0,
      lastUpdated: now,
    };

    // Check thresholds
    const tokenRatio = updated.tokensUsed / updated.monthlyTokenLimit;
    const costRatio = updated.costUsedUsd / updated.monthlyCostLimitUsd;
    const maxRatio = Math.max(tokenRatio, costRatio);

    if (maxRatio >= updated.pauseThreshold) {
      updated.status = 'paused';
      this.log('budget', 'critical', 'budget', `Agent ${agentId} PAUSED — budget exhausted (${(maxRatio * 100).toFixed(0)}%)`, {
        metadata: { agentId, tokenRatio, costRatio },
      });
    } else if (maxRatio >= updated.warningThreshold) {
      updated.status = 'warning';
      this.log('budget', 'warning', 'budget', `Agent ${agentId} budget warning (${(maxRatio * 100).toFixed(0)}%)`, {
        metadata: { agentId, tokenRatio, costRatio },
      });
    }

    this.budgets.set(agentId, updated);
    return updated;
  }

  /** Record token/cost usage for an agent */
  recordUsage(agentId: string, tokens: number, costUsd: number): AgentBudget | undefined {
    const budget = this.budgets.get(agentId);
    if (!budget) return undefined;

    budget.tokensUsed += tokens;
    budget.costUsedUsd += costUsd;
    budget.lastUpdated = new Date();

    // Re-check thresholds
    return this.setBudget(agentId, budget);
  }

  /** Get budget for agent */
  getBudget(agentId: string): AgentBudget | undefined {
    return this.budgets.get(agentId);
  }

  /** List all budgets */
  listBudgets(): AgentBudget[] {
    return Array.from(this.budgets.values());
  }

  /** Get cost aggregation per-agent/per-BU */
  getCostSummary(): {
    totalCostUsd: number;
    totalTokens: number;
    byAgent: Array<{ agentId: string; costUsd: number; tokens: number; status: string }>;
    warnings: number;
    paused: number;
  } {
    const agents = Array.from(this.budgets.values());
    return {
      totalCostUsd: agents.reduce((s, a) => s + a.costUsedUsd, 0),
      totalTokens: agents.reduce((s, a) => s + a.tokensUsed, 0),
      byAgent: agents.map(a => ({ agentId: a.agentId, costUsd: a.costUsedUsd, tokens: a.tokensUsed, status: a.status })),
      warnings: agents.filter(a => a.status === 'warning').length,
      paused: agents.filter(a => a.status === 'paused' || a.status === 'exhausted').length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PATROL REPORTS (EP-136)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Store a patrol report */
  recordPatrol(report: PatrolReport): void {
    this.patrolReports.push(report);
    if (this.patrolReports.length > 500) this.patrolReports.shift();

    if (report.failedCount > 0) {
      this.log('patrol', 'warning', 'patrol',
        `Patrol ${report.owner}: ${report.failedCount}/${report.totalChecks} checks failed`,
        { metadata: { owner: report.owner, alerts: report.alerts } },
      );
    }
  }

  /** Get patrol reports, optionally filtered by owner */
  getPatrolReports(owner?: string, limit: number = 50): PatrolReport[] {
    let results = this.patrolReports;
    if (owner) results = results.filter(r => r.owner === owner);
    return results.slice(-limit).reverse();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MOLECULE METRICS (EP-137)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record molecule execution metrics */
  recordMoleculeMetric(metric: MoleculeMetric): void {
    this.moleculeMetrics.push(metric);
    if (this.moleculeMetrics.length > this.config.metricsRetentionCount) {
      this.moleculeMetrics.shift();
    }
  }

  /** Get molecule metrics summary */
  getMoleculeMetrics(limit: number = 50): MoleculeMetric[] {
    return this.moleculeMetrics.slice(-limit).reverse();
  }

  /** Aggregate molecule stats */
  getMoleculeStats(): {
    total: number;
    completed: number;
    failed: number;
    running: number;
    avgDurationMs: number;
    totalTokens: number;
    totalCostUsd: number;
  } {
    const all = this.moleculeMetrics;
    const completed = all.filter(m => m.status === 'completed');
    return {
      total: all.length,
      completed: completed.length,
      failed: all.filter(m => m.status === 'failed').length,
      running: all.filter(m => m.status === 'running').length,
      avgDurationMs: completed.length > 0
        ? completed.reduce((s, m) => s + m.durationMs, 0) / completed.length
        : 0,
      totalTokens: all.reduce((s, m) => s + m.totalTokens, 0),
      totalCostUsd: all.reduce((s, m) => s + m.costUsd, 0),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ERROR TRENDING (EP-138)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record an error for trending */
  recordError(pattern: string, source: string): ErrorTrend {
    const existing = this.errorTrends.get(pattern);
    if (existing) {
      existing.count++;
      existing.lastSeen = new Date();
      if (!existing.sources.includes(source)) existing.sources.push(source);
      // Simple trending: if 3+ in last hour → up
      const hourAgo = Date.now() - this.config.errorTrendWindowMs;
      existing.trending = existing.lastSeen.getTime() > hourAgo && existing.count >= 3 ? 'up' : 'stable';
      return existing;
    }

    const trend: ErrorTrend = {
      pattern,
      count: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
      sources: [source],
      trending: 'stable',
      resolved: false,
    };
    this.errorTrends.set(pattern, trend);
    return trend;
  }

  /** Mark error as resolved */
  resolveError(pattern: string): boolean {
    const trend = this.errorTrends.get(pattern);
    if (!trend) return false;
    trend.resolved = true;
    trend.trending = 'down';
    return true;
  }

  /** Get error trends, sorted by count */
  getErrorTrends(unresolvedOnly: boolean = false): ErrorTrend[] {
    let results = Array.from(this.errorTrends.values());
    if (unresolvedOnly) results = results.filter(e => !e.resolved);
    return results.sort((a, b) => b.count - a.count);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTH SCORE (EP-139) — System-wide 0-100
  // ═══════════════════════════════════════════════════════════════════════════

  /** Compute system health score */
  computeHealth(): HealthReport {
    const components: HealthComponent[] = [];

    // 1. Keepalive health (25 pts)
    const workers = Array.from(this.keepalives.values());
    const alive = workers.filter(w => w.status === 'alive').length;
    const keepaliveScore = workers.length > 0 ? Math.round((alive / workers.length) * 25) : 25;
    components.push({
      name: 'Workers Keepalive',
      score: keepaliveScore,
      status: keepaliveScore >= 20 ? 'healthy' : keepaliveScore >= 10 ? 'degraded' : 'unhealthy',
      details: `${alive}/${workers.length} alive`,
    });

    // 2. Budget health (20 pts)
    const budgets = Array.from(this.budgets.values());
    const budgetPaused = budgets.filter(b => b.status === 'paused' || b.status === 'exhausted').length;
    const budgetScore = budgets.length > 0
      ? Math.round(((budgets.length - budgetPaused) / budgets.length) * 20)
      : 20;
    components.push({
      name: 'Budget Health',
      score: budgetScore,
      status: budgetPaused === 0 ? 'healthy' : budgetPaused <= 2 ? 'degraded' : 'unhealthy',
      details: `${budgetPaused} agents paused/exhausted`,
    });

    // 3. Error rate (20 pts)
    const trending = Array.from(this.errorTrends.values()).filter(e => !e.resolved && e.trending === 'up');
    const errorScore = Math.max(0, 20 - trending.length * 5);
    components.push({
      name: 'Error Rate',
      score: errorScore,
      status: trending.length === 0 ? 'healthy' : trending.length <= 2 ? 'degraded' : 'unhealthy',
      details: `${trending.length} trending errors`,
    });

    // 4. Patrol health (20 pts)
    const recentPatrols = this.patrolReports.slice(-10);
    const failedPatrols = recentPatrols.filter(p => p.failedCount > 0).length;
    const patrolScore = recentPatrols.length > 0
      ? Math.round(((recentPatrols.length - failedPatrols) / recentPatrols.length) * 20)
      : 20;
    components.push({
      name: 'Patrol Health',
      score: patrolScore,
      status: failedPatrols === 0 ? 'healthy' : failedPatrols <= 3 ? 'degraded' : 'unhealthy',
      details: `${failedPatrols}/${recentPatrols.length} recent patrols had failures`,
    });

    // 5. Molecule success rate (15 pts)
    const recentMols = this.moleculeMetrics.slice(-20);
    const failedMols = recentMols.filter(m => m.status === 'failed').length;
    const molScore = recentMols.length > 0
      ? Math.round(((recentMols.length - failedMols) / recentMols.length) * 15)
      : 15;
    components.push({
      name: 'Molecule Success',
      score: molScore,
      status: failedMols === 0 ? 'healthy' : failedMols <= 3 ? 'degraded' : 'unhealthy',
      details: `${failedMols}/${recentMols.length} recent molecules failed`,
    });

    const totalScore = components.reduce((s, c) => s + c.score, 0);
    const report: HealthReport = {
      score: totalScore,
      status: totalScore >= 80 ? 'healthy' : totalScore >= 50 ? 'degraded' : 'unhealthy',
      components,
      timestamp: new Date(),
    };

    this.lastHealth = report;
    return report;
  }

  /** Get last computed health report */
  getHealth(): HealthReport {
    if (!this.lastHealth) return this.computeHealth();
    return this.lastHealth;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ALERTING RULES (EP-140)
  // ═══════════════════════════════════════════════════════════════════════════

  private registerDefaultAlertRules(): void {
    const defaults: Omit<AlertRule, 'id'>[] = [
      {
        name: 'Worker Dead',
        enabled: true,
        condition: 'Any worker keepalive status = dead',
        channels: ['sse', 'whatsapp'],
        severity: 'critical',
        cooldownMs: 5 * 60_000,
        fireCount: 0,
      },
      {
        name: 'Budget Exhausted',
        enabled: true,
        condition: 'Any agent budget status = paused/exhausted',
        channels: ['sse'],
        severity: 'error',
        cooldownMs: 30 * 60_000,
        fireCount: 0,
      },
      {
        name: 'Error Trending Up',
        enabled: true,
        condition: 'Error trend count >= 5 within window',
        channels: ['sse'],
        severity: 'warning',
        cooldownMs: 15 * 60_000,
        fireCount: 0,
      },
      {
        name: 'Health Score Low',
        enabled: true,
        condition: 'System health score < 50',
        channels: ['sse', 'whatsapp'],
        severity: 'critical',
        cooldownMs: 10 * 60_000,
        fireCount: 0,
      },
      {
        name: 'Patrol Failures',
        enabled: true,
        condition: 'Patrol report has > 3 failed checks',
        channels: ['sse'],
        severity: 'warning',
        cooldownMs: 10 * 60_000,
        fireCount: 0,
      },
    ];

    for (const rule of defaults) {
      const id = `alert-${rule.name.toLowerCase().replace(/\s+/g, '-')}`;
      this.alertRules.set(id, { ...rule, id });
    }
  }

  /** Check alert rules against a townlog entry */
  private checkAlertRules(entry: TownlogEntry): void {
    const now = Date.now();

    for (const [, rule] of this.alertRules) {
      if (!rule.enabled) continue;
      if (rule.lastFired && now - rule.lastFired.getTime() < rule.cooldownMs) continue;

      let shouldFire = false;

      if (rule.name === 'Worker Dead' && entry.category === 'worker' && entry.level === 'critical') {
        shouldFire = true;
      } else if (rule.name === 'Budget Exhausted' && entry.category === 'budget' && entry.level === 'critical') {
        shouldFire = true;
      } else if (rule.name === 'Error Trending Up' && entry.level === 'error') {
        shouldFire = true;
      }

      if (shouldFire) {
        rule.lastFired = new Date();
        rule.fireCount++;
        this.fireAlert(rule, entry);
      }
    }
  }

  /** Fire an alert on configured channels */
  private fireAlert(rule: AlertRule, trigger: TownlogEntry): void {
    for (const channel of rule.channels) {
      if (channel === 'sse') {
        broadcast('meow:alert', {
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message: trigger.message,
          source: trigger.source,
          timestamp: new Date(),
        });
      }
      // WhatsApp and email channels deferred to EP-140 advanced
    }

    addActivity({
      type: rule.severity === 'critical' ? 'error' : 'warning',
      action: 'alert_fired',
      details: `Alert "${rule.name}": ${trigger.message}`,
    });
  }

  /** List all alert rules */
  listAlertRules(): AlertRule[] {
    return Array.from(this.alertRules.values());
  }

  /** Toggle alert rule */
  setAlertEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.alertRules.get(ruleId);
    if (rule) rule.enabled = enabled;
  }

  /** Create custom alert rule */
  createAlertRule(name: string, condition: string, channels: AlertChannel[], severity: AlertSeverity): AlertRule {
    const id = `alert-${uuidv4().slice(0, 8)}`;
    const rule: AlertRule = {
      id, name, enabled: true, condition, channels, severity,
      cooldownMs: this.config.alertDefaultCooldownMs,
      fireCount: 0,
    };
    this.alertRules.set(id, rule);
    return rule;
  }

  /** Delete alert rule */
  deleteAlertRule(ruleId: string): boolean {
    return this.alertRules.delete(ruleId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS & MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  stats(): ObservabilityStats {
    const workers = Array.from(this.keepalives.values());
    const budgets = Array.from(this.budgets.values());
    return {
      townlogEntries: this.townlog.length,
      keepaliveWorkers: workers.length,
      keepaliveAlive: workers.filter(w => w.status === 'alive').length,
      keepaliveStale: workers.filter(w => w.status === 'stale').length,
      keepaliveDead: workers.filter(w => w.status === 'dead').length,
      budgetsTracked: budgets.length,
      budgetsWarning: budgets.filter(b => b.status === 'warning').length,
      budgetsPaused: budgets.filter(b => b.status === 'paused' || b.status === 'exhausted').length,
      patrolReportsStored: this.patrolReports.length,
      moleculeMetrics: this.moleculeMetrics.length,
      errorTrends: this.errorTrends.size,
      activeAlertRules: Array.from(this.alertRules.values()).filter(r => r.enabled).length,
      lastHealthScore: this.lastHealth?.score ?? -1,
    };
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'observability',
      message,
      severity: 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton ObservabilityEngine instance */
export const observabilityEngine = new ObservabilityEngine();
