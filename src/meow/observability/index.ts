/**
 * OBSERVABILITY INDEX — Stage 04 Wave 8
 *
 * Barrel export + singleton initialization for all 5 observability modules.
 * LP-036 through LP-040.
 */

import { RealCostTracker } from './cost-tracking-real';
import { PerformanceBaselines } from './performance-baselines';
import { OutcomeTracker } from './outcome-tracking';
import { ErrorClassifier } from './error-classification';
import { PersistentAuditLog } from './audit-log-persistent';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export { RealCostTracker } from './cost-tracking-real';
export type { CostProvider, CostEntry, CostBreakdown, DailyCostSummary, BudgetStatus } from './cost-tracking-real';

export { PerformanceBaselines } from './performance-baselines';
export type { BaselineMetric, BaselineMetrics, Deviation } from './performance-baselines';

export { OutcomeTracker } from './outcome-tracking';
export type { OutcomeType, Outcome, FormulaROI, OutcomeSummary } from './outcome-tracking';

export { ErrorClassifier } from './error-classification';
export type { ErrorClass, ClassifiedError, RetryDecision, ErrorStats, TopError } from './error-classification';

export { PersistentAuditLog } from './audit-log-persistent';
export type { AuditAction, AuditEntityType, AuditEntry, AuditQueryFilters, AuditStats } from './audit-log-persistent';

// ─────────────────────────────────────────────────────────────────────────────
// Singletons
// ─────────────────────────────────────────────────────────────────────────────

let costTracker: RealCostTracker | null = null;
let baselines: PerformanceBaselines | null = null;
let outcomeTracker: OutcomeTracker | null = null;
let errorClassifier: ErrorClassifier | null = null;
let auditLog: PersistentAuditLog | null = null;
let initialized = false;

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservabilityInitOptions {
  monthlyBudgetUsd?: number;
  deviationThreshold?: number;
  criticalThreshold?: number;
  auditRetentionDays?: number;
  baselineCheckIntervalMs?: number;
  loadHistoryDays?: number;
}

/**
 * Initialize all observability singletons and start monitors.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initObservability(options?: ObservabilityInitOptions): Promise<void> {
  if (initialized) {
    console.info('[Observability] Already initialized, skipping');
    return;
  }

  console.info('[Observability] Initializing Stage 04 observability modules...');

  // Create singletons
  costTracker = new RealCostTracker(options?.monthlyBudgetUsd ?? 500);
  baselines = new PerformanceBaselines(
    options?.deviationThreshold ?? 2,
    options?.criticalThreshold ?? 3,
  );
  outcomeTracker = new OutcomeTracker();
  errorClassifier = new ErrorClassifier();
  auditLog = new PersistentAuditLog(options?.auditRetentionDays ?? 90);

  // Load historical data from DB in parallel
  const historyDays = options?.loadHistoryDays ?? 30;
  await Promise.allSettled([
    costTracker.loadFromDb(historyDays),
    outcomeTracker.loadFromDb(historyDays),
    errorClassifier.loadFromDb(Math.min(historyDays, 7)),
  ]);

  // Start baseline monitor
  baselines.startBaselineMonitor(options?.baselineCheckIntervalMs ?? 5 * 60_000);

  // Log system startup
  await auditLog.log('system', 'system.startup', 'system', 'observability', 'Stage 04 observability initialized');

  initialized = true;
  console.info('[Observability] All modules initialized successfully');
}

/**
 * Graceful shutdown — stop monitors.
 */
export function shutdownObservability(): void {
  if (baselines) {
    baselines.stopBaselineMonitor();
  }
  initialized = false;
  console.info('[Observability] Shutdown complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// Getters
// ─────────────────────────────────────────────────────────────────────────────

export function getCostTracker(): RealCostTracker {
  if (!costTracker) {
    costTracker = new RealCostTracker();
  }
  return costTracker;
}

export function getBaselines(): PerformanceBaselines {
  if (!baselines) {
    baselines = new PerformanceBaselines();
  }
  return baselines;
}

export function getOutcomeTracker(): OutcomeTracker {
  if (!outcomeTracker) {
    outcomeTracker = new OutcomeTracker();
  }
  return outcomeTracker;
}

export function getErrorClassifier(): ErrorClassifier {
  if (!errorClassifier) {
    errorClassifier = new ErrorClassifier();
  }
  return errorClassifier;
}

export function getAuditLog(): PersistentAuditLog {
  if (!auditLog) {
    auditLog = new PersistentAuditLog();
  }
  return auditLog;
}

export function isObservabilityInitialized(): boolean {
  return initialized;
}
