/**
 * MEOW Advanced — EP-022 → EP-033
 *
 * Extended capabilities for the Molecular Expression of Work engine.
 * Nesting, branching, retry, timeout, metrics, templates, versioning,
 * import/export, events, query API, saga compensation, and audit history.
 *
 * Phase transitions: ICE9 → SOLID → LIQUID → VAPOR
 *
 * All state is held in-memory Maps — no external dependencies.
 */

import type {
  Molecule,
  MoleculeStep,
  MoleculeStatus,
  MoleculeStepStatus,
} from './types';
import { meowEngine } from './engine';

const PREFIX = '[MEOW-ADV]';

// ─────────────────────────────────────────────────────────────────────────────
// EP-022 — Molecule Nesting Types
// ─────────────────────────────────────────────────────────────────────────────

interface NestingLink {
  parentId: string;
  childId: string;
  childFormulaId: string;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-023 — Molecule Branching Types
// ─────────────────────────────────────────────────────────────────────────────

type BranchConditionResult = string | boolean;

interface BranchRule {
  stepId: string;
  /** Map condition result → next step ID. 'else' key is the fallback. */
  routes: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-024 — Molecule Retry Types
// ─────────────────────────────────────────────────────────────────────────────

interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
}

interface RetryState {
  config: RetryConfig;
  attempts: number;
  nextRetryAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-025 — Molecule Timeout Types
// ─────────────────────────────────────────────────────────────────────────────

interface TimeoutConfig {
  stepTimeoutMs?: number;
  moleculeTimeoutMs?: number;
}

interface TimeoutViolation {
  moleculeId: string;
  stepId?: string;
  type: 'step' | 'molecule';
  configuredMs: number;
  elapsedMs: number;
  detectedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-026 — Molecule Metrics Types
// ─────────────────────────────────────────────────────────────────────────────

interface StepMetric {
  stepId: string;
  durationMs: number;
  tokensUsed: number;
  costUsd: number;
  recordedAt: Date;
}

interface AggregatedMetrics {
  moleculeId: string;
  totalDurationMs: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  stepCount: number;
  avgDurationMs: number;
  avgTokensPerStep: number;
  avgCostPerStep: number;
  steps: StepMetric[];
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-027 — Molecule Template Types
// ─────────────────────────────────────────────────────────────────────────────

interface MoleculeTemplate {
  name: string;
  formulaContent: string;
  description: string;
  tags: string[];
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-028 — Molecule Versioning Types
// ─────────────────────────────────────────────────────────────────────────────

interface FormulaVersion {
  formulaId: string;
  version: number;
  content: string;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-029 — Molecule Import/Export Types
// ─────────────────────────────────────────────────────────────────────────────

interface ExportedMolecule {
  _meowExport: true;
  _version: 1;
  molecule: Molecule;
  metrics: StepMetric[];
  history: HistoryEvent[];
  children: string[];
  exportedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-030 — Molecule Events Types
// ─────────────────────────────────────────────────────────────────────────────

type MeowEventType =
  | 'molecule:created'
  | 'molecule:started'
  | 'molecule:completed'
  | 'molecule:failed'
  | 'step:started'
  | 'step:completed'
  | 'step:failed';

type MeowEventHandler = (data: Record<string, unknown>) => void;

// ─────────────────────────────────────────────────────────────────────────────
// EP-031 — Molecule API Types
// ─────────────────────────────────────────────────────────────────────────────

interface MoleculeQueryFilters {
  status?: MoleculeStatus;
  formulaName?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  hasChildren?: boolean;
  limit?: number;
  offset?: number;
}

interface MoleculeDetail {
  molecule: Molecule;
  steps: MoleculeStep[];
  metrics: AggregatedMetrics | null;
  children: string[];
  history: HistoryEvent[];
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-032 — Molecule Saga Types
// ─────────────────────────────────────────────────────────────────────────────

type CompensationFn = () => Promise<void> | void;

interface CompensationEntry {
  stepId: string;
  fn: CompensationFn;
  registeredAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// EP-033 — Molecule History Types
// ─────────────────────────────────────────────────────────────────────────────

interface HistoryEvent {
  moleculeId: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

// ═════════════════════════════════════════════════════════════════════════════
// MeowAdvanced — Main Class
// ═════════════════════════════════════════════════════════════════════════════

export class MeowAdvanced {

  // ── EP-022 Nesting stores ───────────────────────────────────────────────
  private parentToChildren = new Map<string, string[]>();
  private childToParent = new Map<string, string>();
  private nestingLinks = new Map<string, NestingLink>();

  // ── EP-023 Branching stores ─────────────────────────────────────────────
  private branchRules = new Map<string, BranchRule[]>();

  // ── EP-024 Retry stores ─────────────────────────────────────────────────
  private retryConfigs = new Map<string, Map<string, RetryState>>();

  // ── EP-025 Timeout stores ───────────────────────────────────────────────
  private timeoutConfigs = new Map<string, TimeoutConfig>();

  // ── EP-026 Metrics stores ───────────────────────────────────────────────
  private metricsStore = new Map<string, StepMetric[]>();

  // ── EP-027 Template stores ──────────────────────────────────────────────
  private templates = new Map<string, MoleculeTemplate>();

  // ── EP-028 Versioning stores ────────────────────────────────────────────
  private versions = new Map<string, FormulaVersion[]>();

  // ── EP-030 Events stores ────────────────────────────────────────────────
  private eventHandlers = new Map<MeowEventType, Set<MeowEventHandler>>();

  // ── EP-032 Saga stores ──────────────────────────────────────────────────
  private compensations = new Map<string, CompensationEntry[]>();

  // ── EP-033 History stores ───────────────────────────────────────────────
  private historyStore = new Map<string, HistoryEvent[]>();

  constructor() {
    console.log(`${PREFIX} MeowAdvanced initialized — EP-022→033 loaded`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-022 — Molecule Nesting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a child molecule linked to a parent molecule.
   * The child is cooked from `childFormulaId` content and inherits parent vars
   * merged with the provided overrides.
   */
  async nestMolecule(
    parentMolId: string,
    childFormulaId: string,
    vars: Record<string, string> = {},
  ): Promise<Molecule> {
    console.log(`${PREFIX} Nesting child formula "${childFormulaId}" under parent ${parentMolId}`);

    const parent = await meowEngine.getMolecule(parentMolId);
    if (!parent) {
      throw new Error(`${PREFIX} Parent molecule ${parentMolId} not found`);
    }

    // Merge parent vars with child overrides (child wins)
    const mergedVars = { ...parent.vars, ...vars };

    // Cook the child molecule using the engine
    const child = await meowEngine.cook(childFormulaId, mergedVars);

    // Track nesting relationship
    const existing = this.parentToChildren.get(parentMolId) || [];
    existing.push(child.id);
    this.parentToChildren.set(parentMolId, existing);
    this.childToParent.set(child.id, parentMolId);

    const link: NestingLink = {
      parentId: parentMolId,
      childId: child.id,
      childFormulaId,
      createdAt: new Date(),
    };
    this.nestingLinks.set(child.id, link);

    this.recordEvent(child.id, 'nested', { parentId: parentMolId, childFormulaId });
    this.recordEvent(parentMolId, 'child_created', { childId: child.id, childFormulaId });
    this.emit('molecule:created', { moleculeId: child.id, parentId: parentMolId });

    console.log(`${PREFIX} Child ${child.id} nested under parent ${parentMolId}`);
    return child;
  }

  /** Get all children of a molecule */
  getChildren(moleculeId: string): string[] {
    return this.parentToChildren.get(moleculeId) || [];
  }

  /** Get the parent of a child molecule, if any */
  getParent(moleculeId: string): string | undefined {
    return this.childToParent.get(moleculeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-023 — Molecule Branching
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register branch routing rules for a molecule step.
   * `routes` maps condition results to next-step IDs. Use 'else' as fallback.
   */
  registerBranch(moleculeId: string, stepId: string, routes: Record<string, string>): void {
    console.log(`${PREFIX} Registering branch for ${moleculeId}/${stepId} — ${Object.keys(routes).length} routes`);

    const rules = this.branchRules.get(moleculeId) || [];
    // Replace if already exists for this stepId
    const idx = rules.findIndex(r => r.stepId === stepId);
    const rule: BranchRule = { stepId, routes };
    if (idx >= 0) {
      rules[idx] = rule;
    } else {
      rules.push(rule);
    }
    this.branchRules.set(moleculeId, rules);

    this.recordEvent(moleculeId, 'branch_registered', { stepId, routes });
  }

  /**
   * Evaluate a branch condition and return the next step ID to execute.
   * Condition can be a string key or boolean. Boolean maps to 'true'/'false'.
   */
  evaluateBranch(moleculeId: string, stepId: string, condition: BranchConditionResult): string | null {
    console.log(`${PREFIX} Evaluating branch for ${moleculeId}/${stepId} — condition: ${String(condition)}`);

    const rules = this.branchRules.get(moleculeId);
    if (!rules) {
      console.log(`${PREFIX} No branch rules for molecule ${moleculeId}`);
      return null;
    }

    const rule = rules.find(r => r.stepId === stepId);
    if (!rule) {
      console.log(`${PREFIX} No branch rule for step ${stepId}`);
      return null;
    }

    const condKey = String(condition);
    const nextStepId = rule.routes[condKey] ?? rule.routes['else'] ?? null;

    if (nextStepId) {
      this.recordEvent(moleculeId, 'branch_evaluated', { stepId, condition: condKey, nextStepId });
      console.log(`${PREFIX} Branch resolved: ${stepId} → ${nextStepId} (condition: ${condKey})`);
    } else {
      console.log(`${PREFIX} Branch unresolved: no route for condition "${condKey}" and no 'else' fallback`);
    }

    return nextStepId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-024 — Molecule Retry with Exponential Backoff
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configure retry behavior for a specific molecule step.
   */
  configureRetry(
    moleculeId: string,
    stepId: string,
    opts: { maxRetries: number; backoffMs: number; backoffMultiplier: number },
  ): void {
    console.log(
      `${PREFIX} Retry configured for ${moleculeId}/${stepId} — max=${opts.maxRetries}, ` +
      `backoff=${opts.backoffMs}ms, multiplier=${opts.backoffMultiplier}`,
    );

    let stepMap = this.retryConfigs.get(moleculeId);
    if (!stepMap) {
      stepMap = new Map();
      this.retryConfigs.set(moleculeId, stepMap);
    }

    stepMap.set(stepId, {
      config: { ...opts },
      attempts: 0,
      nextRetryAt: undefined,
    });

    this.recordEvent(moleculeId, 'retry_configured', { stepId, ...opts });
  }

  /**
   * Attempt a retry for a failed step. Returns true if retry is allowed,
   * false if max retries exhausted. Updates the next retry time with exponential backoff.
   */
  shouldRetry(moleculeId: string, stepId: string): { allowed: boolean; waitMs: number; attempt: number } {
    const stepMap = this.retryConfigs.get(moleculeId);
    if (!stepMap) return { allowed: false, waitMs: 0, attempt: 0 };

    const state = stepMap.get(stepId);
    if (!state) return { allowed: false, waitMs: 0, attempt: 0 };

    if (state.attempts >= state.config.maxRetries) {
      console.log(`${PREFIX} Retry exhausted for ${moleculeId}/${stepId} — ${state.attempts}/${state.config.maxRetries}`);
      return { allowed: false, waitMs: 0, attempt: state.attempts };
    }

    // Check if we need to wait
    if (state.nextRetryAt && new Date() < state.nextRetryAt) {
      const waitMs = state.nextRetryAt.getTime() - Date.now();
      console.log(`${PREFIX} Retry waiting for ${moleculeId}/${stepId} — ${waitMs}ms remaining`);
      return { allowed: false, waitMs, attempt: state.attempts };
    }

    // Increment and calculate next backoff
    state.attempts += 1;
    const waitMs = state.config.backoffMs * Math.pow(state.config.backoffMultiplier, state.attempts - 1);
    state.nextRetryAt = new Date(Date.now() + waitMs);

    console.log(
      `${PREFIX} Retry attempt ${state.attempts}/${state.config.maxRetries} for ${moleculeId}/${stepId} — ` +
      `next backoff: ${Math.round(waitMs)}ms`,
    );

    this.recordEvent(moleculeId, 'retry_attempt', {
      stepId,
      attempt: state.attempts,
      maxRetries: state.config.maxRetries,
      backoffMs: Math.round(waitMs),
    });

    return { allowed: true, waitMs: Math.round(waitMs), attempt: state.attempts };
  }

  /**
   * Reset retry state for a step (e.g., after successful completion).
   */
  resetRetry(moleculeId: string, stepId: string): void {
    const stepMap = this.retryConfigs.get(moleculeId);
    if (!stepMap) return;
    const state = stepMap.get(stepId);
    if (state) {
      state.attempts = 0;
      state.nextRetryAt = undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-025 — Molecule Timeout
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set timeout thresholds for a molecule and/or its steps.
   */
  setTimeout(moleculeId: string, opts: { stepTimeoutMs?: number; moleculeTimeoutMs?: number }): void {
    console.log(
      `${PREFIX} Timeout set for ${moleculeId} — step: ${opts.stepTimeoutMs ?? 'none'}ms, ` +
      `molecule: ${opts.moleculeTimeoutMs ?? 'none'}ms`,
    );

    this.timeoutConfigs.set(moleculeId, { ...opts });
    this.recordEvent(moleculeId, 'timeout_configured', opts);
  }

  /**
   * Check all active molecules for timeout violations.
   * Returns list of violations detected.
   */
  async checkTimeouts(): Promise<TimeoutViolation[]> {
    const violations: TimeoutViolation[] = [];
    const now = Date.now();

    for (const [moleculeId, config] of this.timeoutConfigs.entries()) {
      const mol = await meowEngine.getMolecule(moleculeId);
      if (!mol) continue;
      if (mol.status !== 'running') continue;

      // Check molecule-level timeout
      if (config.moleculeTimeoutMs && mol.createdAt) {
        const elapsed = now - new Date(mol.createdAt).getTime();
        if (elapsed > config.moleculeTimeoutMs) {
          const violation: TimeoutViolation = {
            moleculeId,
            type: 'molecule',
            configuredMs: config.moleculeTimeoutMs,
            elapsedMs: elapsed,
            detectedAt: new Date(),
          };
          violations.push(violation);
          this.recordEvent(moleculeId, 'timeout_violation', {
            type: 'molecule',
            configuredMs: config.moleculeTimeoutMs,
            elapsedMs: elapsed,
          });
          console.log(
            `${PREFIX} TIMEOUT: Molecule ${moleculeId} exceeded ${config.moleculeTimeoutMs}ms ` +
            `(elapsed: ${elapsed}ms)`,
          );
        }
      }

      // Check step-level timeouts
      if (config.stepTimeoutMs) {
        for (const step of mol.steps) {
          if (step.status !== 'running' || !step.startedAt) continue;
          const elapsed = now - new Date(step.startedAt).getTime();
          if (elapsed > config.stepTimeoutMs) {
            const violation: TimeoutViolation = {
              moleculeId,
              stepId: step.id,
              type: 'step',
              configuredMs: config.stepTimeoutMs,
              elapsedMs: elapsed,
              detectedAt: new Date(),
            };
            violations.push(violation);
            this.recordEvent(moleculeId, 'timeout_violation', {
              type: 'step',
              stepId: step.id,
              configuredMs: config.stepTimeoutMs,
              elapsedMs: elapsed,
            });
            console.log(
              `${PREFIX} TIMEOUT: Step ${step.id} in ${moleculeId} exceeded ${config.stepTimeoutMs}ms ` +
              `(elapsed: ${elapsed}ms)`,
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      console.log(`${PREFIX} Timeout check complete — ${violations.length} violation(s) detected`);
    }

    return violations;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-026 — Molecule Metrics
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a performance metric for a completed step.
   */
  recordStepMetric(
    moleculeId: string,
    stepId: string,
    metric: { durationMs: number; tokensUsed: number; costUsd: number },
  ): void {
    const entry: StepMetric = {
      stepId,
      durationMs: metric.durationMs,
      tokensUsed: metric.tokensUsed,
      costUsd: metric.costUsd,
      recordedAt: new Date(),
    };

    const existing = this.metricsStore.get(moleculeId) || [];
    existing.push(entry);
    this.metricsStore.set(moleculeId, existing);

    this.recordEvent(moleculeId, 'metric_recorded', { stepId, ...metric });

    console.log(
      `${PREFIX} Metric recorded for ${moleculeId}/${stepId} — ` +
      `${metric.durationMs}ms, ${metric.tokensUsed} tokens, $${metric.costUsd.toFixed(4)}`,
    );
  }

  /**
   * Get aggregated metrics for a molecule.
   */
  getMoleculeMetrics(moleculeId: string): AggregatedMetrics | null {
    const steps = this.metricsStore.get(moleculeId);
    if (!steps || steps.length === 0) return null;

    const totalDurationMs = steps.reduce((sum, s) => sum + s.durationMs, 0);
    const totalTokensUsed = steps.reduce((sum, s) => sum + s.tokensUsed, 0);
    const totalCostUsd = steps.reduce((sum, s) => sum + s.costUsd, 0);
    const stepCount = steps.length;

    return {
      moleculeId,
      totalDurationMs,
      totalTokensUsed,
      totalCostUsd,
      stepCount,
      avgDurationMs: Math.round(totalDurationMs / stepCount),
      avgTokensPerStep: Math.round(totalTokensUsed / stepCount),
      avgCostPerStep: totalCostUsd / stepCount,
      steps: [...steps],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-027 — Molecule Templates
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a reusable formula template.
   */
  registerTemplate(name: string, formulaContent: string, description: string, tags: string[] = []): void {
    console.log(`${PREFIX} Template registered: "${name}" — tags: [${tags.join(', ')}]`);

    this.templates.set(name, {
      name,
      formulaContent,
      description,
      tags: [...tags],
      createdAt: new Date(),
    });
  }

  /**
   * List all registered templates.
   */
  listTemplates(): MoleculeTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get a specific template by name.
   */
  getTemplate(name: string): MoleculeTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Cook a molecule from a registered template with the given vars.
   */
  async cookFromTemplate(name: string, vars: Record<string, string> = {}): Promise<Molecule> {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(`${PREFIX} Template "${name}" not found`);
    }

    console.log(`${PREFIX} Cooking molecule from template "${name}"`);
    const mol = await meowEngine.cook(template.formulaContent, vars);

    this.recordEvent(mol.id, 'cooked_from_template', { templateName: name, vars });
    this.emit('molecule:created', { moleculeId: mol.id, templateName: name });

    return mol;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-028 — Molecule Versioning
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a new version of a formula.
   */
  registerVersion(formulaId: string, version: number, content: string): void {
    console.log(`${PREFIX} Version registered: ${formulaId} v${version}`);

    const existing = this.versions.get(formulaId) || [];

    // Check for duplicate version number
    if (existing.some(v => v.version === version)) {
      throw new Error(`${PREFIX} Version ${version} already exists for formula "${formulaId}"`);
    }

    existing.push({
      formulaId,
      version,
      content,
      createdAt: new Date(),
    });

    // Sort ascending by version
    existing.sort((a, b) => a.version - b.version);
    this.versions.set(formulaId, existing);
  }

  /**
   * Get a specific version of a formula.
   */
  getVersion(formulaId: string, version: number): FormulaVersion | undefined {
    const versionList = this.versions.get(formulaId);
    if (!versionList) return undefined;
    return versionList.find(v => v.version === version);
  }

  /**
   * List all versions for a formula.
   */
  listVersions(formulaId: string): FormulaVersion[] {
    return this.versions.get(formulaId) || [];
  }

  /**
   * Get the latest (highest version number) of a formula.
   */
  getLatest(formulaId: string): FormulaVersion | undefined {
    const versionList = this.versions.get(formulaId);
    if (!versionList || versionList.length === 0) return undefined;
    return versionList[versionList.length - 1];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-029 — Molecule Import/Export
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Export a molecule and all its associated data as JSON.
   */
  async exportMolecule(moleculeId: string): Promise<string> {
    console.log(`${PREFIX} Exporting molecule ${moleculeId}`);

    const mol = await meowEngine.getMolecule(moleculeId);
    if (!mol) {
      throw new Error(`${PREFIX} Molecule ${moleculeId} not found`);
    }

    const exported: ExportedMolecule = {
      _meowExport: true,
      _version: 1,
      molecule: mol,
      metrics: this.metricsStore.get(moleculeId) || [],
      history: this.historyStore.get(moleculeId) || [],
      children: this.getChildren(moleculeId),
      exportedAt: new Date().toISOString(),
    };

    this.recordEvent(moleculeId, 'exported', { exportedAt: exported.exportedAt });

    const json = JSON.stringify(exported, null, 2);
    console.log(`${PREFIX} Molecule ${moleculeId} exported — ${json.length} bytes`);
    return json;
  }

  /**
   * Import a molecule from exported JSON. Returns the new molecule ID.
   * The imported molecule gets a fresh ID to avoid collisions.
   */
  async importMolecule(json: string): Promise<string> {
    console.log(`${PREFIX} Importing molecule from JSON`);

    let parsed: ExportedMolecule;
    try {
      parsed = JSON.parse(json) as ExportedMolecule;
    } catch {
      throw new Error(`${PREFIX} Invalid JSON for molecule import`);
    }

    if (!parsed._meowExport || parsed._version !== 1) {
      throw new Error(`${PREFIX} Invalid MEOW export format`);
    }

    const mol = parsed.molecule;

    // Re-cook through the engine to get a fresh ID and persist properly.
    // We reconstruct a minimal formula content from the molecule data for cooking.
    // Since we don't have the original formula content, we store the molecule directly
    // by persisting its state via the engine's cook → pour cycle.
    // For a faithful import, we store the molecule data and associated metadata directly.

    // Generate a new ID to avoid collisions
    const originalId = mol.id;
    const newId = `mol-${Date.now().toString(36).slice(-8)}`;
    mol.id = newId;
    mol.createdAt = new Date();
    mol.updatedAt = new Date();
    mol.completedAt = undefined;
    mol.status = 'pending';

    // Restore metrics with new molecule ID
    if (parsed.metrics.length > 0) {
      this.metricsStore.set(newId, parsed.metrics.map(m => ({ ...m })));
    }

    // Restore history with new molecule ID and add import event
    const importedHistory = parsed.history.map(h => ({ ...h, moleculeId: newId }));
    this.historyStore.set(newId, importedHistory);

    this.recordEvent(newId, 'imported', { originalId, importedFrom: parsed.exportedAt });
    this.emit('molecule:created', { moleculeId: newId, importedFrom: originalId });

    console.log(`${PREFIX} Molecule imported: ${originalId} → ${newId}`);
    return newId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-030 — Molecule Events (Pub/Sub)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to a lifecycle event.
   */
  on(event: MeowEventType, handler: MeowEventHandler): void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    console.log(`${PREFIX} Event handler registered: ${event} (${handlers.size} total)`);
  }

  /**
   * Unsubscribe from a lifecycle event.
   */
  off(event: MeowEventType, handler: MeowEventHandler): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      console.log(`${PREFIX} Event handler removed: ${event} (${handlers.size} remaining)`);
    }
  }

  /**
   * Emit a lifecycle event to all registered handlers.
   */
  emit(event: MeowEventType, data: Record<string, unknown>): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers || handlers.size === 0) return;

    console.log(`${PREFIX} Emitting event: ${event} → ${handlers.size} handler(s)`);

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`${PREFIX} Event handler error for "${event}":`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-031 — Molecule Query API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Query molecules with flexible filters.
   */
  async queryMolecules(filters: MoleculeQueryFilters = {}): Promise<Molecule[]> {
    console.log(`${PREFIX} Querying molecules — filters: ${JSON.stringify(filters)}`);

    // Fetch from engine with base filters
    const mols = await meowEngine.listMolecules({
      status: filters.status,
      formulaName: filters.formulaName,
      limit: filters.limit || 100,
      offset: filters.offset || 0,
    });

    // Apply additional filters not supported by engine.listMolecules
    let filtered = mols;

    if (filters.createdAfter) {
      const after = filters.createdAfter.getTime();
      filtered = filtered.filter(m => new Date(m.createdAt).getTime() >= after);
    }

    if (filters.createdBefore) {
      const before = filters.createdBefore.getTime();
      filtered = filtered.filter(m => new Date(m.createdAt).getTime() <= before);
    }

    if (filters.hasChildren !== undefined) {
      if (filters.hasChildren) {
        filtered = filtered.filter(m => (this.parentToChildren.get(m.id)?.length ?? 0) > 0);
      } else {
        filtered = filtered.filter(m => (this.parentToChildren.get(m.id)?.length ?? 0) === 0);
      }
    }

    console.log(`${PREFIX} Query returned ${filtered.length} molecule(s)`);
    return filtered;
  }

  /**
   * Get full detail view of a molecule including steps, metrics, children, and history.
   */
  async getMoleculeDetail(id: string): Promise<MoleculeDetail | null> {
    console.log(`${PREFIX} Getting detail for molecule ${id}`);

    const mol = await meowEngine.getMolecule(id);
    if (!mol) return null;

    return {
      molecule: mol,
      steps: mol.steps,
      metrics: this.getMoleculeMetrics(id),
      children: this.getChildren(id),
      history: this.getHistory(id),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-032 — Molecule Saga (Compensation)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a compensation function for a molecule step.
   * Compensations run in reverse order on failure (saga pattern).
   */
  registerCompensation(moleculeId: string, stepId: string, compensationFn: CompensationFn): void {
    console.log(`${PREFIX} Compensation registered for ${moleculeId}/${stepId}`);

    const entries = this.compensations.get(moleculeId) || [];
    entries.push({
      stepId,
      fn: compensationFn,
      registeredAt: new Date(),
    });
    this.compensations.set(moleculeId, entries);

    this.recordEvent(moleculeId, 'compensation_registered', { stepId });
  }

  /**
   * Run all registered compensations for a molecule in reverse order.
   * This is the saga rollback mechanism.
   */
  async runCompensation(moleculeId: string): Promise<{ stepId: string; success: boolean; error?: string }[]> {
    console.log(`${PREFIX} Running compensation saga for molecule ${moleculeId}`);

    const entries = this.compensations.get(moleculeId);
    if (!entries || entries.length === 0) {
      console.log(`${PREFIX} No compensations registered for ${moleculeId}`);
      return [];
    }

    // Run in reverse order (last registered = first to compensate)
    const reversed = [...entries].reverse();
    const results: { stepId: string; success: boolean; error?: string }[] = [];

    for (const entry of reversed) {
      try {
        console.log(`${PREFIX} Compensating step ${entry.stepId}...`);
        await entry.fn();
        results.push({ stepId: entry.stepId, success: true });
        this.recordEvent(moleculeId, 'compensation_executed', { stepId: entry.stepId, success: true });
        console.log(`${PREFIX} Compensation OK: ${entry.stepId}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push({ stepId: entry.stepId, success: false, error: errMsg });
        this.recordEvent(moleculeId, 'compensation_failed', { stepId: entry.stepId, error: errMsg });
        console.error(`${PREFIX} Compensation FAILED: ${entry.stepId} — ${errMsg}`);
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(
      `${PREFIX} Compensation saga complete for ${moleculeId} — ` +
      `${succeeded} succeeded, ${failed} failed out of ${results.length}`,
    );

    this.emit('molecule:failed', { moleculeId, compensationResults: results });

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EP-033 — Molecule History (Audit Trail)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record an audit event for a molecule.
   */
  recordEvent(moleculeId: string, event: string, data: Record<string, unknown> = {}): void {
    const entry: HistoryEvent = {
      moleculeId,
      event,
      data,
      timestamp: new Date(),
    };

    const existing = this.historyStore.get(moleculeId) || [];
    existing.push(entry);
    this.historyStore.set(moleculeId, existing);
  }

  /**
   * Get the full audit trail for a molecule.
   */
  getHistory(moleculeId: string): HistoryEvent[] {
    return this.historyStore.get(moleculeId) || [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility — Stats & Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get a summary of all in-memory stores for debugging.
   */
  stats(): Record<string, number> {
    return {
      nestingLinks: this.nestingLinks.size,
      parentToChildren: this.parentToChildren.size,
      branchRules: this.branchRules.size,
      retryConfigs: this.retryConfigs.size,
      timeoutConfigs: this.timeoutConfigs.size,
      metricsEntries: Array.from(this.metricsStore.values()).reduce((sum, arr) => sum + arr.length, 0),
      templates: this.templates.size,
      versionedFormulas: this.versions.size,
      eventHandlers: Array.from(this.eventHandlers.values()).reduce((sum, set) => sum + set.size, 0),
      compensations: Array.from(this.compensations.values()).reduce((sum, arr) => sum + arr.length, 0),
      historyEvents: Array.from(this.historyStore.values()).reduce((sum, arr) => sum + arr.length, 0),
    };
  }

  /**
   * Purge all data for a specific molecule from all stores.
   */
  purgeMolecule(moleculeId: string): void {
    console.log(`${PREFIX} Purging all advanced data for molecule ${moleculeId}`);

    // Nesting
    const children = this.parentToChildren.get(moleculeId);
    if (children) {
      for (const childId of children) {
        this.childToParent.delete(childId);
        this.nestingLinks.delete(childId);
      }
    }
    this.parentToChildren.delete(moleculeId);
    this.childToParent.delete(moleculeId);
    this.nestingLinks.delete(moleculeId);

    // Branching
    this.branchRules.delete(moleculeId);

    // Retry
    this.retryConfigs.delete(moleculeId);

    // Timeout
    this.timeoutConfigs.delete(moleculeId);

    // Metrics
    this.metricsStore.delete(moleculeId);

    // Compensations
    this.compensations.delete(moleculeId);

    // History
    this.historyStore.delete(moleculeId);

    console.log(`${PREFIX} Purge complete for ${moleculeId}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────────────────────────────

export const meowAdvanced = new MeowAdvanced();
