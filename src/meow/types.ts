/**
 * STAGE 02 — Type System Foundation
 *
 * 4 Orthogonal Dimensions: Task × Skill × Executor × Context
 * MEOW State Machine: ICE9 → SOLID → LIQUID → VAPOR
 * Gas Town Worker Roles, Beads, Convoys, Mail, Patrols
 *
 * Based on: Gas Town (Yegge), FrankFlow, Guia Definitivo v4, OpenFang, Paperclip
 */

// ─────────────────────────────────────────────────────────────────────────────
// MEOW STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

/** MEOW phases — the lifecycle of molecular work */
export enum MEOWPhase {
  /** Formula source code (TOML template) — immutable reference */
  ICE9 = 'ice9',
  /** Protomolecule — frozen, reusable, vars substituted */
  SOLID = 'solid',
  /** Molecule — persistent, flowing, executing steps */
  LIQUID = 'liquid',
  /** Wisp — ephemeral, in-memory only, TTL-bound */
  VAPOR = 'vapor',
}

/** Valid state transitions and their operator names */
export const MEOW_TRANSITIONS: Record<string, { to: MEOWPhase; operator: string }[]> = {
  [MEOWPhase.ICE9]: [{ to: MEOWPhase.SOLID, operator: 'cook' }],
  [MEOWPhase.SOLID]: [
    { to: MEOWPhase.LIQUID, operator: 'pour' },
    { to: MEOWPhase.VAPOR, operator: 'wisp' },
  ],
  [MEOWPhase.LIQUID]: [{ to: MEOWPhase.LIQUID, operator: 'squash' }], // squash = condense to digest
  [MEOWPhase.VAPOR]: [], // burn = destroy, no transition target
};

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY SYSTEM (OpenFang-inspired)
// ─────────────────────────────────────────────────────────────────────────────

export enum Capability {
  ToolInvoke = 'ToolInvoke',
  NetConnect = 'NetConnect',
  ShellExec = 'ShellExec',
  FileRead = 'FileRead',
  FileWrite = 'FileWrite',
  DbQuery = 'DbQuery',
  LLMCall = 'LLMCall',
  HumanEscalate = 'HumanEscalate',
  WorktreeCreate = 'WorktreeCreate',
  GitPush = 'GitPush',
  PRCreate = 'PRCreate',
  BudgetSpend = 'BudgetSpend',
  WhatsAppSend = 'WhatsAppSend',
  MetaAdsManage = 'MetaAdsManage',
  GoogleAdsManage = 'GoogleAdsManage',
  ShopifyManage = 'ShopifyManage',
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 1: TASK (WHAT)
// ─────────────────────────────────────────────────────────────────────────────

export type BeadStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type BeadPriority = 'critical' | 'high' | 'medium' | 'low';

export type ExecutorType = 'agent' | 'worker' | 'clone' | 'human';

export type DependencyType = 'blocks' | 'relates_to' | 'duplicates' | 'discovered_from';

export interface BeadDependency {
  targetId: string;
  type: DependencyType;
}

export interface Bead {
  id: string;                       // bd-XXXX (4-char hex hash)
  title: string;
  description?: string;
  status: BeadStatus;
  priority: BeadPriority;

  // Gas Town labels
  executorType: ExecutorType;
  bu?: string;                      // Business unit: ecommerce, content, platform
  rig?: string;                     // App/project: gastown-app, gastown-platform
  skill?: string;                   // Skill to execute (skill.toml name)
  formula?: string;                 // Parent molecule/formula
  tier?: 'S' | 'A' | 'B';         // Required agent tier
  labels: Record<string, string>;   // Extensible k/v labels

  // Assignment
  assignee?: string;                // Agent ID
  moleculeId?: string;              // Parent molecule
  convoyId?: string;                // Parent convoy
  parentId?: string;                // Hierarchical parent bead

  // Dependencies
  dependencies: BeadDependency[];

  // Tracking
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdBy: string;                // Actor who created
  completedBy?: string;

  // Outputs
  artifacts?: string[];             // Artifact IDs produced
  prUrl?: string;                   // PR if code change
  worktree?: string;                // Git worktree path
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 2: SKILL (HOW)
// ─────────────────────────────────────────────────────────────────────────────

export type SkillRuntime = 'python' | 'wasm' | 'node' | 'prompt_only' | 'builtin';

export interface SkillToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;

  runtime: SkillRuntime;
  entry?: string;                   // e.g. "src/main.ts"

  tools: {
    provided: SkillToolDef[];       // Tools this skill exposes
    required: string[];             // Tools this skill needs from registry
  };

  requirements: {
    capabilities: Capability[];
    minTier?: 'S' | 'A' | 'B';
  };

  inputs: Record<string, { type: string; required: boolean; description: string }>;
  outputs: Record<string, { type: string; description: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 3: EXECUTOR (WHO) — Gas Town Worker Roles
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerRole =
  | 'mayor'       // Chief of Staff — orchestrates, never codes
  | 'polecat'     // Ephemeral worker — spawned per task, isolated worktree
  | 'crew'        // Long-lived named agent — persistent identity
  | 'refinery'    // Merge queue manager — sequential rebase
  | 'witness'     // Polecat supervisor — monitors and escalates
  | 'deacon'      // System health daemon — patrols + dogs
  | 'boot'        // Watchdog for deacon
  | 'dog'         // Deacon helper (compactor, doctor, janitor, wisp_reaper)
  | 'overseer';   // Human operator

export type DogType = 'compactor' | 'doctor' | 'janitor' | 'wisp_reaper';

export type PolecatStatus = 'spawning' | 'working' | 'idle' | 'stalled' | 'zombie' | 'cleaning';

export interface WorkerIdentity {
  id: string;
  role: WorkerRole;
  name: string;
  tier: 'S' | 'A' | 'B';
  model: 'opus' | 'sonnet' | 'haiku';
  capabilities: Capability[];
  agentDefId?: string;              // Links to agent definition

  // Polecat-specific
  worktree?: string;
  branch?: string;
  polecatStatus?: PolecatStatus;

  // Dog-specific
  dogType?: DogType;

  // Tracking
  currentBeadId?: string;
  lastActiveAt?: Date;
  tasksCompleted: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 4: CONTEXT (FOR WHOM) — Dynamic Context Injection
// ─────────────────────────────────────────────────────────────────────────────

export interface BUContext {
  bu: string;                       // e.g. "ecommerce"
  country?: string;                 // e.g. "BR"
  vertical?: string;                // e.g. "ecommerce"
  configPath: string;               // Path to context.md
  glossary: Record<string, string>; // Domain terms
  thresholds: Record<string, number>; // KPI thresholds (ROAS min, CPA max, etc.)
  rules: string[];                  // Business rules
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMULA (TOML template → the "DNA" of a workflow)
// ─────────────────────────────────────────────────────────────────────────────

export type FormulaType = 'workflow' | 'convoy' | 'expansion' | 'aspect';

export interface FormulaVar {
  description: string;
  required: boolean;
  default?: string;
}

export interface FormulaStep {
  id: string;
  title: string;
  description?: string;
  skill?: string;                   // Skill to execute
  needs: string[];                  // Step dependencies
  type: 'polecat' | 'crew';        // Worker type
  gate?: 'human-approval' | 'timer' | 'github-event' | 'test-pass';
  timeout?: number;                 // Seconds
  retries?: number;
  vars?: Record<string, string>;    // Step-specific var overrides
}

export interface FormulaLeg {
  id: string;
  title: string;
  steps: FormulaStep[];
}

export interface Formula {
  name: string;
  description: string;
  version: number;
  type: FormulaType;
  vars: Record<string, FormulaVar>;
  steps: FormulaStep[];             // For workflow/expansion/aspect types
  legs?: FormulaLeg[];              // For convoy type (parallel legs)
  synthesis?: FormulaStep;          // Final synthesis step for convoys
}

// ─────────────────────────────────────────────────────────────────────────────
// MOLECULE (running instance of a formula)
// ─────────────────────────────────────────────────────────────────────────────

export type MoleculeStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type MoleculeStepStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'gated' | 'skipped';

export interface MoleculeStep {
  id: string;
  title: string;
  skill?: string;
  needs: string[];
  type: 'polecat' | 'crew';
  gate?: string;
  status: MoleculeStepStatus;
  assignee?: string;                // Worker ID
  worktree?: string;                // Git worktree path (for polecats)
  beadId?: string;                  // Linked bead
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  output?: Record<string, unknown>;
  retryCount: number;
}

export interface Molecule {
  id: string;
  formulaName: string;
  formulaVersion: number;
  phase: MEOWPhase;
  status: MoleculeStatus;
  steps: MoleculeStep[];
  vars: Record<string, string>;
  convoyId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  completedSteps: string[];
  currentSteps: string[];           // Steps currently executing
  error?: string;
  digest?: string;                  // Squash output summary
}

// ─────────────────────────────────────────────────────────────────────────────
// WISP (ephemeral molecule — in-memory only, TTL-bound)
// ─────────────────────────────────────────────────────────────────────────────

export interface Wisp extends Omit<Molecule, 'phase'> {
  phase: MEOWPhase.VAPOR;
  ttlMs: number;                    // Time-to-live in milliseconds
  expiresAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVOY (work-order bundle wrapping related beads)
// ─────────────────────────────────────────────────────────────────────────────

export type ConvoyStatus = 'assembling' | 'dispatched' | 'in_progress' | 'delivered' | 'failed';

export interface Convoy {
  id: string;
  name: string;
  description?: string;
  status: ConvoyStatus;
  beadIds: string[];
  moleculeIds: string[];
  createdBy: string;                // Mayor ID
  assignedRig?: string;
  createdAt: Date;
  dispatchedAt?: Date;
  deliveredAt?: Date;
  progress: number;                 // 0-100
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIL SYSTEM (inter-agent messaging)
// ─────────────────────────────────────────────────────────────────────────────

export type MailPriority = 'critical' | 'high' | 'normal' | 'low';

export type MailType = 'task' | 'escalation' | 'notification' | 'report' | 'nudge';

export type MailDelivery = 'direct' | 'broadcast';

export interface Mail {
  id: string;
  from: string;                     // Worker ID
  to: string | string[];            // Worker ID(s) or role broadcast
  priority: MailPriority;
  type: MailType;
  delivery: MailDelivery;
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
  beadId?: string;                  // Related bead
  moleculeId?: string;              // Related molecule
  read: boolean;
  createdAt: Date;
  readAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATROL (recurring health/monitoring loops)
// ─────────────────────────────────────────────────────────────────────────────

export type PatrolOwner = 'deacon' | 'witness' | 'refinery' | 'boot';

export type PatrolStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface PatrolCheck {
  id: string;
  name: string;
  passed: boolean;
  details?: string;
  durationMs: number;
}

export interface PatrolReport {
  id: string;
  owner: PatrolOwner;
  rig?: string;                     // Which rig was patrolled (for witness/refinery)
  status: PatrolStatus;
  checks: PatrolCheck[];
  passedCount: number;
  failedCount: number;
  totalChecks: number;
  startedAt: Date;
  completedAt?: Date;
  nextScheduled?: Date;
  alerts: string[];                 // Issues that need attention
}

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET (Paperclip-inspired token/cost tracking)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentBudget {
  agentId: string;
  monthlyTokenLimit: number;
  tokensUsed: number;
  monthlyCostLimitUsd: number;
  costUsedUsd: number;
  period: string;                   // "2026-03"
  status: 'active' | 'warning' | 'paused' | 'exhausted';
  warningThreshold: number;         // 0.8 = 80%
  pauseThreshold: number;           // 1.0 = 100%
  lastUpdated: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL ADAPTER (Guia v4 adapter pattern)
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthStatus {
  healthy: boolean;
  latencyMs?: number;
  lastChecked: Date;
  error?: string;
}

export interface ToolAdapterMeta {
  name: string;
  version: string;
  capabilities: Capability[];
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAGA (checkpoint + compensate pattern for LLM pipelines)
// ─────────────────────────────────────────────────────────────────────────────

export interface SagaCheckpoint {
  stepId: string;
  state: Record<string, unknown>;
  timestamp: Date;
}

export interface SagaCompensation {
  stepId: string;
  action: string;
  executed: boolean;
  error?: string;
}

export interface Saga {
  id: string;
  moleculeId: string;
  checkpoints: SagaCheckpoint[];
  compensations: SagaCompensation[];
  status: 'active' | 'compensating' | 'compensated' | 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY FEED (Gas Town gt feed)
// ─────────────────────────────────────────────────────────────────────────────

export type FeedEventType =
  | 'bead_created'
  | 'bead_updated'
  | 'bead_completed'
  | 'molecule_started'
  | 'molecule_step_completed'
  | 'molecule_completed'
  | 'molecule_failed'
  | 'convoy_dispatched'
  | 'convoy_delivered'
  | 'polecat_spawned'
  | 'polecat_completed'
  | 'polecat_stalled'
  | 'patrol_completed'
  | 'patrol_alert'
  | 'mail_sent'
  | 'escalation'
  | 'budget_warning'
  | 'worker_idle'
  | 'worker_error'
  | 'system_health';

export interface FeedEvent {
  id: string;
  type: FeedEventType;
  source: string;                   // Worker ID that generated
  rig?: string;
  beadId?: string;
  moleculeId?: string;
  convoyId?: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  metadata?: Record<string, unknown>;
  timestamp: Date;
}
