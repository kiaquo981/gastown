/**
 * HETZNER — Index
 *
 * Barrel export for the Hetzner Remote Workers integration layer.
 * Connects Gas Town's orchestrator to Docker containers running
 * Claude Code on a Hetzner server via SSH.
 *
 * Gas Town: "The wasteland rigs — remote, ruthless, reliable."
 */

// ─────────────────────────────────────────────────────────────────────────────
// Remote Worker Registry
// ─────────────────────────────────────────────────────────────────────────────

export {
  registerWorker,
  removeWorker,
  listWorkers,
  getWorker,
  getWorkerByHostname,
  heartbeatWorker,
  heartbeatAll,
  getOnlineWorkers,
  getAvailableWorker,
  markWorkerBusy,
  markWorkerAvailable,
  updateWorkerMetrics,
  getAggregateStats,
  loadDefaultWorkers,
  clearWorkers,
} from './remote-worker-registry';

export type {
  RemoteWorker,
  WorkerRole,
  WorkerStatus,
  WorkerMetrics,
  RegisterWorkerConfig,
} from './remote-worker-registry';

// ─────────────────────────────────────────────────────────────────────────────
// Remote Executor
// ─────────────────────────────────────────────────────────────────────────────

export {
  executeRemote,
  dispatchClaude,
  dispatchBeadToRemote,
  getExecution,
  listExecutions,
  killExecution,
  getExecutionStats,
} from './remote-executor';

export type {
  RemoteExecution,
  ExecutionStatus,
  ExecuteRemoteOpts,
  DispatchClaudeOpts,
  ClaudeResult,
} from './remote-executor';

// ─────────────────────────────────────────────────────────────────────────────
// Remote Sync
// ─────────────────────────────────────────────────────────────────────────────

export {
  syncRepoToWorker,
  syncResultsFromWorker,
  setupWorkerWorkspace,
  getWorkerGitStatus,
  createWorkerBranch,
  pushWorkerBranch,
} from './remote-sync';

export type {
  SyncResult,
  GitStatus,
  WorkspaceSetupResult,
} from './remote-sync';

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export { default as hetznerRouter } from './hetzner-routes';
