/**
 * FrankFlow Execution Logic Layer — Barrel Export
 *
 * Ports FrankFlow's key innovations into Gas Town's TypeScript backend:
 *
 * - checkpoint-engine: JSONL append-only resumable execution
 * - orphan-detector:   stale worker detection with PID probing
 * - retry-manager:     exponential/linear/fixed backoff with error classification
 * - smart-router:      intent detection & specialist routing (13 categories)
 * - pattern-learner:   adaptive error memory across sessions
 * - quality-gates:     multi-stack quality pipeline with auto-detection
 * - review-pipeline:   multi-agent code review with auto-fix loop
 * - spec-sync:         spec-to-bead bridge with dependency DAG
 * - frankflow-routes:  Express router with all API endpoints
 */

// ─── Checkpoint Engine ────────────────────────────────────────────────────────
export {
  ProcessingContext,
  listCheckpoints,
  getCheckpointEvents,
  deleteCheckpoint,
  getCheckpointStats,
} from './checkpoint-engine';

export type { CheckpointEvent, CheckpointEventType } from './checkpoint-engine';

// ─── Orphan Detector ──────────────────────────────────────────────────────────
export {
  registerWorker,
  heartbeat,
  deregisterWorker,
  getTrackedCount,
  detectOrphans,
  recoverOrphan,
  recoverAll,
  getOrphanHistory,
  getOrphanStats,
  startOrphanLoop,
  stopOrphanLoop,
  isOrphanLoopRunning,
} from './orphan-detector';

export type { OrphanResult, OrphanReason, OrphanDetectionOpts } from './orphan-detector';

// ─── Retry Manager ────────────────────────────────────────────────────────────
export {
  shouldRetry,
  scheduleRetry,
  getRetryable,
  executeRetry,
  getRetryRecord,
  setRetryBeadId,
  clearRetryRecord,
  getAllRetryRecords,
  getRetryStats,
  classifyError,
} from './retry-manager';

export type {
  BackoffStrategy,
  ErrorClassification,
  RetryConfig,
  RetryRecord,
  RetryHistoryEntry,
} from './retry-manager';

// ─── Smart Router ─────────────────────────────────────────────────────────────
export {
  routeTask,
  routeBeadToWorker,
  getCategories,
  addCategory,
  addCategoryFromStrings,
  removeCategory,
  resetCategories,
  getRouteHistory,
  getRouteStats,
} from './smart-router';

export type { RouteCategory, RouteResult } from './smart-router';

// ─── Pattern Learner ──────────────────────────────────────────────────────────
export {
  recordError,
  getActivePatterns,
  getAllPatterns,
  getPatternsByCategory,
  setResolution,
  generateSessionContext,
  categorizeError,
  normalizeError,
  getPattern,
  getPatternStats,
  clearPatterns,
} from './pattern-learner';

export type { ErrorPattern, ErrorCategory } from './pattern-learner';

// ─── Quality Gates ────────────────────────────────────────────────────────────
export {
  detectStacks,
  runGates,
  runGatesWithFix,
  getGateReport,
  listReports as listQualityReports,
  getCoverageThresholds,
  getQualityStats,
} from './quality-gates';

export type { TechStack, GateResult, QualityReport, RunGatesOpts } from './quality-gates';

// ─── Review Pipeline ──────────────────────────────────────────────────────────
export {
  runReview,
  autoFixCriticals,
  getReviewResult,
  listReviews,
  getReviewAgents,
  addReviewAgent,
  removeReviewAgent,
  resetReviewAgents,
} from './review-pipeline';

export type {
  ReviewAgent,
  ReviewFinding,
  FindingSeverity,
  ReviewResult,
  RunReviewOpts,
} from './review-pipeline';

// ─── Spec Sync ────────────────────────────────────────────────────────────────
export {
  parseSpecTasks,
  syncSpecToBeads,
  getSpecStatus,
  validateSpec,
} from './spec-sync';

export type { SpecTask, SpecSyncResult } from './spec-sync';

// ─── Routes ───────────────────────────────────────────────────────────────────
export { default as frankflowRouter } from './frankflow-routes';
