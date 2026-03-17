/**
 * MAESTRO — Index
 *
 * Barrel export for the Maestro orchestration integration layer.
 * Brings RunMaestro's multi-agent dispatch, worktree isolation,
 * playbook execution, and session tracking into Gas Town.
 *
 * Gas Town: "The Maestro conducts. The rigs obey."
 */

// ─────────────────────────────────────────────────────────────────────────────
// Agent Registry
// ─────────────────────────────────────────────────────────────────────────────

export {
  detectInstalledAgents,
  getAgentDefinition,
  getDetectedAgent,
  listAgents,
  listInstalledAgents,
  getDefaultAgent,
  buildAgentArgs,
  ensureDetected,
  getDetectionAge,
} from './agent-registry';

export type {
  AgentDefinition,
  AgentCapabilities,
  DetectedAgent,
} from './agent-registry';

// ─────────────────────────────────────────────────────────────────────────────
// Worktree Manager
// ─────────────────────────────────────────────────────────────────────────────

export {
  createWorktree,
  listWorktrees,
  removeWorktree,
  cleanupOrphaned,
  getWorktreeForBead,
  getWorktree,
  markWorktree,
  initWorktreeManager,
} from './worktree-manager';

export type {
  Worktree,
  WorktreeStatus,
} from './worktree-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Playbook Engine
// ─────────────────────────────────────────────────────────────────────────────

export {
  createPlaybook,
  listPlaybooks,
  getPlaybook,
  deletePlaybook,
  runPlaybook,
  pausePlaybook,
  resumePlaybook,
  getPlaybookRun,
  getPlaybookRunFromDb,
  generatePlaybookFromBeads,
  parseMarkdownTasks,
} from './playbook-engine';

export type {
  Playbook,
  PlaybookDocument,
  PlaybookSettings,
  PlaybookRun,
  PlaybookRunStatus,
  TaskResult,
  TaskResultStatus,
} from './playbook-engine';

// ─────────────────────────────────────────────────────────────────────────────
// Session Tracker
// ─────────────────────────────────────────────────────────────────────────────

export {
  createSession,
  updateUsage,
  completeSession,
  failSession,
  crashSession,
  setAgentSessionId,
  getSession,
  listSessions,
  getSessionStats,
  getTotalCost,
  parseStreamJson,
  parseJsonl,
  extractUsageFromStreamJson,
  extractUsageFromJsonl,
} from './session-tracker';

export type {
  MaestroSession,
  SessionStatus,
  SessionFilters,
  SessionStats,
} from './session-tracker';

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export { default as maestroRouter } from './maestro-routes';
