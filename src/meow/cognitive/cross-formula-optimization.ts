/**
 * CROSS-FORMULA OPTIMIZATION -- CG-016 (Stage 05 Wave 4)
 *
 * Optimizes across multiple running formulas simultaneously.
 * Detects opportunities for efficiency gains when concurrent formulas
 * share resources, steps, or data dependencies.
 *
 * Capabilities:
 *   - Detect shared steps across concurrent formulas
 *     (e.g., two formulas both need Meta Ads data)
 *   - Suggest step deduplication / result sharing
 *   - Identify formula execution order to minimize resource contention
 *   - Track formula interaction patterns over time
 *   - Detect formula conflicts (two formulas modifying the same resource)
 *   - Suggest formula merging opportunities
 *
 * Runs periodic analysis on configurable interval (default 5min).
 * Persists optimization suggestions to meow_formula_optimizations.
 *
 * Gas Town: "Two convoys don't need two scouts for the same road."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Molecule, FormulaStep } from '../types';

const log = createLogger('cross-formula-optimization');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OptimizationType =
  | 'step_dedup'            // Two formulas share an identical step
  | 'result_sharing'        // One formula's output feeds another's input
  | 'execution_order'       // Reorder formula starts to reduce contention
  | 'conflict_detected'     // Two formulas modify the same resource
  | 'merge_opportunity'     // Two formulas could be merged into one
  | 'resource_contention';  // Bottleneck from concurrent resource access

export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SharedStep {
  stepId: string;
  stepTitle: string;
  skill: string;
  formulaNames: string[];
  moleculeIds: string[];
  potentialSavingsMs: number;
}

export interface FormulaConflict {
  formulaA: string;
  formulaB: string;
  moleculeA: string;
  moleculeB: string;
  conflictResource: string;    // the resource being contended
  conflictType: 'write-write' | 'read-write' | 'rate-limit';
  severity: ConflictSeverity;
  description: string;
  detectedAt: Date;
}

export interface OptimizationSuggestion {
  id: string;
  type: OptimizationType;
  description: string;
  involvedFormulas: string[];
  involvedMolecules: string[];
  estimatedSavingsMs: number;
  estimatedCostSavingsUsd: number;
  confidence: number;          // 0.0 - 1.0
  details: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected' | 'applied';
  createdAt: Date;
}

export interface FormulaInteraction {
  formulaA: string;
  formulaB: string;
  coOccurrences: number;       // how often they run concurrently
  sharedStepCount: number;
  conflictCount: number;
  avgOverlapMs: number;        // average temporal overlap
  lastObservedAt: Date;
}

export interface AnalysisReport {
  id: string;
  activeMolecules: number;
  sharedSteps: SharedStep[];
  conflicts: FormulaConflict[];
  suggestions: OptimizationSuggestion[];
  interactionSummary: FormulaInteraction[];
  analysisTimeMs: number;
  analyzedAt: Date;
}

export interface CrossFormulaConfig {
  analysisIntervalMs: number;      // default 5 minutes
  minConcurrentFormulas: number;   // minimum to trigger analysis
  conflictDetectionEnabled: boolean;
  mergeDetectionEnabled: boolean;
  maxSuggestionsPerRun: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CrossFormulaConfig = {
  analysisIntervalMs: 5 * 60 * 1000,
  minConcurrentFormulas: 2,
  conflictDetectionEnabled: true,
  mergeDetectionEnabled: true,
  maxSuggestionsPerRun: 20,
};

/** Resource names that are commonly contended */
const KNOWN_SHARED_RESOURCES: Record<string, string[]> = {
  'meta-ads': ['meta_api', 'ad_account', 'campaign_budget'],
  'google-ads': ['google_api', 'ad_account'],
  'shopify': ['shopify_api', 'product_catalog', 'inventory'],
  'web-scrape': ['scraper_pool', 'proxy_rotation'],
  'whatsapp': ['evolution_api', 'rate_limit'],
  'email': ['resend_api', 'sender_reputation'],
  'image-gen': ['fal_api', 'gpu_queue'],
  'llm-call': ['gemini_api', 'token_budget'],
};

/** Skills that produce outputs consumable by other skills */
const SKILL_OUTPUT_MAP: Record<string, string[]> = {
  'web-scrape': ['data-analysis', 'report-gen', 'campaign-gen'],
  'data-analysis': ['report-gen', 'campaign-gen', 'copywriting'],
  'research': ['copywriting', 'campaign-gen', 'creative-gen'],
  'meta-ads': ['data-analysis', 'report-gen'],
  'google-ads': ['data-analysis', 'report-gen'],
  'code-gen': ['test-gen', 'code-review'],
};

// ---------------------------------------------------------------------------
// Gemini helper (with heuristic fallback)
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a workflow optimization engine. Analyze concurrent formulas and suggest cross-formula optimizations. Respond only with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in cross-formula-optimization');
    return null;
  }
}

// ---------------------------------------------------------------------------
// CrossFormulaOptimizer
// ---------------------------------------------------------------------------

export class CrossFormulaOptimizer {
  private config: CrossFormulaConfig;
  private suggestions: OptimizationSuggestion[] = [];
  private conflicts: FormulaConflict[] = [];
  private interactions: FormulaInteraction[] = [];
  private reports: AnalysisReport[] = [];
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private moleculeProvider: (() => Molecule[]) | null = null;
  private maxSuggestions = 2_000;
  private maxConflicts = 1_000;
  private maxReports = 200;

  constructor(config: Partial<CrossFormulaConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Register molecule provider (called by engine) -----------------------

  setMoleculeProvider(provider: () => Molecule[]): void {
    this.moleculeProvider = provider;
    log.info('Molecule provider registered for cross-formula optimization');
  }

  // --- Start periodic analysis ---------------------------------------------

  startPeriodicAnalysis(): void {
    if (this.analysisTimer) return;

    this.analysisTimer = setInterval(async () => {
      try {
        await this.runAnalysis();
      } catch (err) {
        log.error({ err }, 'Periodic cross-formula analysis failed');
      }
    }, this.config.analysisIntervalMs);

    log.info(
      { intervalMs: this.config.analysisIntervalMs },
      'Cross-formula periodic analysis started',
    );
  }

  // --- Stop periodic analysis -----------------------------------------------

  stopPeriodicAnalysis(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
      log.info('Cross-formula periodic analysis stopped');
    }
  }

  // --- Run full analysis on active molecules --------------------------------

  async runAnalysis(): Promise<AnalysisReport> {
    const startMs = Date.now();

    // Get active molecules
    const molecules = await this.getActiveMolecules();
    if (molecules.length < this.config.minConcurrentFormulas) {
      const emptyReport: AnalysisReport = {
        id: uuidv4(),
        activeMolecules: molecules.length,
        sharedSteps: [],
        conflicts: [],
        suggestions: [],
        interactionSummary: [],
        analysisTimeMs: Date.now() - startMs,
        analyzedAt: new Date(),
      };
      return emptyReport;
    }

    // 1. Detect shared steps
    const sharedSteps = this.detectSharedSteps(molecules);

    // 2. Detect conflicts
    const conflicts: FormulaConflict[] = [];
    if (this.config.conflictDetectionEnabled) {
      conflicts.push(...this.detectConflicts(molecules));
    }

    // 3. Generate suggestions
    const suggestions: OptimizationSuggestion[] = [];

    // Step deduplication suggestions
    for (const shared of sharedSteps) {
      if (shared.formulaNames.length >= 2) {
        suggestions.push({
          id: uuidv4(),
          type: 'step_dedup',
          description:
            `Step "${shared.stepTitle}" (skill: ${shared.skill}) is duplicated across ` +
            `${shared.formulaNames.length} formulas: [${shared.formulaNames.join(', ')}]. ` +
            `Execute once and share result.`,
          involvedFormulas: shared.formulaNames,
          involvedMolecules: shared.moleculeIds,
          estimatedSavingsMs: shared.potentialSavingsMs,
          estimatedCostSavingsUsd: this.estimateStepCost(shared.skill) * (shared.formulaNames.length - 1),
          confidence: 0.8,
          details: { sharedStep: shared },
          status: 'pending',
          createdAt: new Date(),
        });
      }
    }

    // Result sharing suggestions
    const resultSharing = this.detectResultSharingOpportunities(molecules);
    suggestions.push(...resultSharing);

    // Conflict resolution suggestions
    for (const conflict of conflicts) {
      suggestions.push({
        id: uuidv4(),
        type: 'conflict_detected',
        description:
          `Conflict: "${conflict.formulaA}" and "${conflict.formulaB}" both access ` +
          `"${conflict.conflictResource}" (${conflict.conflictType}). ${conflict.description}`,
        involvedFormulas: [conflict.formulaA, conflict.formulaB],
        involvedMolecules: [conflict.moleculeA, conflict.moleculeB],
        estimatedSavingsMs: 0,
        estimatedCostSavingsUsd: 0,
        confidence: conflict.severity === 'critical' ? 0.95 : 0.7,
        details: { conflict },
        status: 'pending',
        createdAt: new Date(),
      });
    }

    // Execution order suggestions
    const orderSuggestions = this.suggestExecutionOrder(molecules, conflicts);
    suggestions.push(...orderSuggestions);

    // Merge detection
    if (this.config.mergeDetectionEnabled) {
      const mergeSuggestions = this.detectMergeOpportunities(molecules);
      suggestions.push(...mergeSuggestions);
    }

    // Try AI-enhanced analysis for complex scenarios
    if (molecules.length >= 3 && suggestions.length > 0) {
      const aiSuggestions = await this.getAiSuggestions(molecules, sharedSteps, conflicts);
      if (aiSuggestions) {
        suggestions.push(...aiSuggestions);
      }
    }

    // Limit suggestions
    const finalSuggestions = suggestions.slice(0, this.config.maxSuggestionsPerRun);

    // Store suggestions
    for (const s of finalSuggestions) {
      this.suggestions.push(s);
    }
    if (this.suggestions.length > this.maxSuggestions) {
      this.suggestions = this.suggestions.slice(-this.maxSuggestions);
    }

    // Store conflicts
    for (const c of conflicts) {
      this.conflicts.push(c);
    }
    if (this.conflicts.length > this.maxConflicts) {
      this.conflicts = this.conflicts.slice(-this.maxConflicts);
    }

    // Update interaction tracking
    this.updateInteractions(molecules);

    const report: AnalysisReport = {
      id: uuidv4(),
      activeMolecules: molecules.length,
      sharedSteps,
      conflicts,
      suggestions: finalSuggestions,
      interactionSummary: this.interactions.slice(0, 20),
      analysisTimeMs: Date.now() - startMs,
      analyzedAt: new Date(),
    };

    this.reports.push(report);
    if (this.reports.length > this.maxReports) {
      this.reports = this.reports.slice(-this.maxReports);
    }

    // Persist
    await this.persistReport(report);

    broadcast('meow:cognitive', {
      type: 'cross_formula_analysis',
      activeMolecules: molecules.length,
      sharedStepCount: sharedSteps.length,
      conflictCount: conflicts.length,
      suggestionCount: finalSuggestions.length,
      analysisTimeMs: report.analysisTimeMs,
    });

    log.info(
      {
        molecules: molecules.length,
        shared: sharedSteps.length,
        conflicts: conflicts.length,
        suggestions: finalSuggestions.length,
        timeMs: report.analysisTimeMs,
      },
      'Cross-formula analysis completed',
    );

    return report;
  }

  // --- Accept / reject a suggestion -----------------------------------------

  async updateSuggestionStatus(
    suggestionId: string,
    status: 'accepted' | 'rejected' | 'applied',
  ): Promise<boolean> {
    const suggestion = this.suggestions.find(s => s.id === suggestionId);
    if (!suggestion) return false;

    suggestion.status = status;

    broadcast('meow:cognitive', {
      type: 'cross_formula_suggestion_updated',
      suggestionId,
      status,
    });

    return true;
  }

  // --- Get pending suggestions ----------------------------------------------

  getPendingSuggestions(): OptimizationSuggestion[] {
    return this.suggestions
      .filter(s => s.status === 'pending')
      .sort((a, b) => b.confidence - a.confidence);
  }

  // --- Get all suggestions --------------------------------------------------

  getSuggestions(formulaName?: string): OptimizationSuggestion[] {
    let result = this.suggestions;
    if (formulaName) {
      result = result.filter(s => s.involvedFormulas.includes(formulaName));
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // --- Get active conflicts -------------------------------------------------

  getActiveConflicts(): FormulaConflict[] {
    // Return conflicts from the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return this.conflicts.filter(c => c.detectedAt >= oneHourAgo);
  }

  // --- Get interaction patterns ---------------------------------------------

  getInteractions(): FormulaInteraction[] {
    return [...this.interactions].sort((a, b) => b.coOccurrences - a.coOccurrences);
  }

  // --- Get recent reports ---------------------------------------------------

  getRecentReports(limit = 10): AnalysisReport[] {
    return this.reports
      .slice(-limit)
      .sort((a, b) => b.analyzedAt.getTime() - a.analyzedAt.getTime());
  }

  // --- Load history from DB -------------------------------------------------

  async loadHistory(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, description, involved_formulas, involved_molecules,
                estimated_savings_ms, estimated_cost_savings_usd, confidence,
                details, status, created_at
         FROM meow_formula_optimizations
         WHERE created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.maxSuggestions],
      );

      this.suggestions = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as OptimizationType,
        description: r.description as string,
        involvedFormulas: this.parseJsonSafe(r.involved_formulas, []),
        involvedMolecules: this.parseJsonSafe(r.involved_molecules, []),
        estimatedSavingsMs: parseFloat(r.estimated_savings_ms as string) || 0,
        estimatedCostSavingsUsd: parseFloat(r.estimated_cost_savings_usd as string) || 0,
        confidence: parseFloat(r.confidence as string) || 0,
        details: this.parseJsonSafe(r.details, {}),
        status: (r.status as OptimizationSuggestion['status']) ?? 'pending',
        createdAt: new Date(r.created_at as string),
      }));

      log.info({ count: this.suggestions.length }, 'Loaded formula optimization suggestions from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load formula optimization suggestions from DB');
    }
  }

  // --- Private: get active molecules ----------------------------------------

  private async getActiveMolecules(): Promise<Molecule[]> {
    // First try in-memory provider
    if (this.moleculeProvider) {
      const molecules = this.moleculeProvider();
      return molecules.filter(
        m => m.status === 'running' || m.status === 'paused',
      );
    }

    // Fallback to DB
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT id, formula_name, formula_version, phase, status, steps,
                vars, convoy_id, created_at, updated_at, completed_at,
                completed_steps, current_steps, error, digest
         FROM molecules
         WHERE status IN ('running', 'paused')
         ORDER BY created_at DESC
         LIMIT 100`,
      );

      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        formulaName: r.formula_name as string,
        formulaVersion: parseInt(r.formula_version as string, 10) || 1,
        phase: r.phase as any,
        status: r.status as any,
        steps: this.parseJsonSafe(r.steps, []),
        vars: this.parseJsonSafe(r.vars, {}),
        convoyId: r.convoy_id as string | undefined,
        createdAt: new Date(r.created_at as string),
        updatedAt: new Date(r.updated_at as string),
        completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
        completedSteps: this.parseJsonSafe(r.completed_steps, []),
        currentSteps: this.parseJsonSafe(r.current_steps, []),
        error: r.error as string | undefined,
        digest: r.digest as string | undefined,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to load active molecules from DB');
      return [];
    }
  }

  // --- Private: detect shared steps -----------------------------------------

  private detectSharedSteps(molecules: Molecule[]): SharedStep[] {
    // Group steps by skill
    const skillSteps = new Map<string, Array<{
      stepId: string;
      stepTitle: string;
      formulaName: string;
      moleculeId: string;
      durationMs: number;
    }>>();

    for (const mol of molecules) {
      for (const step of mol.steps) {
        const skill = step.skill ?? 'unknown';
        if (!skillSteps.has(skill)) skillSteps.set(skill, []);
        skillSteps.get(skill)!.push({
          stepId: step.id,
          stepTitle: step.title,
          formulaName: mol.formulaName,
          moleculeId: mol.id,
          durationMs: step.startedAt && step.completedAt
            ? new Date(step.completedAt as any).getTime() - new Date(step.startedAt as any).getTime()
            : 10_000, // estimate
        });
      }
    }

    const shared: SharedStep[] = [];

    for (const [skill, entries] of skillSteps) {
      // Find entries from different formulas
      const formulaNames = [...new Set(entries.map(e => e.formulaName))];
      if (formulaNames.length < 2) continue;

      const moleculeIds = [...new Set(entries.map(e => e.moleculeId))];
      const avgDuration = entries.reduce((s, e) => s + e.durationMs, 0) / entries.length;

      shared.push({
        stepId: entries[0].stepId,
        stepTitle: entries[0].stepTitle,
        skill,
        formulaNames,
        moleculeIds,
        potentialSavingsMs: Math.round(avgDuration * (formulaNames.length - 1)),
      });
    }

    return shared.sort((a, b) => b.potentialSavingsMs - a.potentialSavingsMs);
  }

  // --- Private: detect conflicts --------------------------------------------

  private detectConflicts(molecules: Molecule[]): FormulaConflict[] {
    const conflicts: FormulaConflict[] = [];
    const now = new Date();

    // Build resource access map per molecule
    const resourceAccess = new Map<string, Array<{
      moleculeId: string;
      formulaName: string;
      accessType: 'read' | 'write';
    }>>();

    for (const mol of molecules) {
      for (const step of mol.steps) {
        if (step.status !== 'running' && step.status !== 'ready') continue;
        const skill = step.skill ?? '';

        // Determine resources this skill accesses
        const resources = KNOWN_SHARED_RESOURCES[skill] ?? [];
        for (const resource of resources) {
          if (!resourceAccess.has(resource)) resourceAccess.set(resource, []);
          // Heuristic: if the step modifies (write ops like campaign_budget), it's a write
          const isWrite = resource.includes('budget') ||
                          resource.includes('inventory') ||
                          resource.includes('campaign');
          resourceAccess.get(resource)!.push({
            moleculeId: mol.id,
            formulaName: mol.formulaName,
            accessType: isWrite ? 'write' : 'read',
          });
        }
      }
    }

    // Detect write-write and read-write conflicts
    for (const [resource, accessors] of resourceAccess) {
      if (accessors.length < 2) continue;

      const writers = accessors.filter(a => a.accessType === 'write');
      const readers = accessors.filter(a => a.accessType === 'read');

      // Write-write conflicts
      for (let i = 0; i < writers.length; i++) {
        for (let j = i + 1; j < writers.length; j++) {
          if (writers[i].formulaName === writers[j].formulaName) continue;
          conflicts.push({
            formulaA: writers[i].formulaName,
            formulaB: writers[j].formulaName,
            moleculeA: writers[i].moleculeId,
            moleculeB: writers[j].moleculeId,
            conflictResource: resource,
            conflictType: 'write-write',
            severity: 'high',
            description:
              `Both formulas are writing to "${resource}" simultaneously. ` +
              `Risk of data corruption or race condition.`,
            detectedAt: now,
          });
        }
      }

      // Read-write conflicts (lower severity)
      for (const writer of writers) {
        for (const reader of readers) {
          if (writer.formulaName === reader.formulaName) continue;
          if (writer.moleculeId === reader.moleculeId) continue;
          conflicts.push({
            formulaA: writer.formulaName,
            formulaB: reader.formulaName,
            moleculeA: writer.moleculeId,
            moleculeB: reader.moleculeId,
            conflictResource: resource,
            conflictType: 'read-write',
            severity: 'medium',
            description:
              `"${writer.formulaName}" is writing to "${resource}" while ` +
              `"${reader.formulaName}" is reading from it. Risk of stale data.`,
            detectedAt: now,
          });
        }
      }

      // Rate-limit conflicts (same API, many accessors)
      if (accessors.length >= 3 && (
        resource.includes('api') || resource.includes('rate_limit')
      )) {
        const formulaNames = [...new Set(accessors.map(a => a.formulaName))];
        if (formulaNames.length >= 2) {
          conflicts.push({
            formulaA: formulaNames[0],
            formulaB: formulaNames[1],
            moleculeA: accessors[0].moleculeId,
            moleculeB: accessors[1].moleculeId,
            conflictResource: resource,
            conflictType: 'rate-limit',
            severity: 'low',
            description:
              `${accessors.length} concurrent accesses to "${resource}" from ` +
              `${formulaNames.length} formulas. Potential rate-limit exhaustion.`,
            detectedAt: now,
          });
        }
      }
    }

    return conflicts;
  }

  // --- Private: detect result sharing opportunities -------------------------

  private detectResultSharingOpportunities(
    molecules: Molecule[],
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // For each molecule, check if any completed step's skill output
    // could feed into another molecule's pending step
    for (let i = 0; i < molecules.length; i++) {
      for (let j = i + 1; j < molecules.length; j++) {
        const molA = molecules[i];
        const molB = molecules[j];

        const completedA = molA.steps.filter(s => s.status === 'completed' && s.skill);
        const pendingB = molB.steps.filter(
          s => (s.status === 'pending' || s.status === 'ready') && s.skill,
        );

        for (const done of completedA) {
          const consumers = SKILL_OUTPUT_MAP[done.skill!] ?? [];
          for (const pending of pendingB) {
            if (consumers.includes(pending.skill!)) {
              suggestions.push({
                id: uuidv4(),
                type: 'result_sharing',
                description:
                  `"${molA.formulaName}" completed "${done.title}" (${done.skill}) ` +
                  `whose output could feed "${pending.title}" (${pending.skill}) ` +
                  `in "${molB.formulaName}". Share result instead of re-executing.`,
                involvedFormulas: [molA.formulaName, molB.formulaName],
                involvedMolecules: [molA.id, molB.id],
                estimatedSavingsMs: 15_000, // estimated re-execution cost
                estimatedCostSavingsUsd: this.estimateStepCost(pending.skill!),
                confidence: 0.65,
                details: {
                  producerStep: done.id,
                  producerSkill: done.skill,
                  consumerStep: pending.id,
                  consumerSkill: pending.skill,
                },
                status: 'pending',
                createdAt: new Date(),
              });
            }
          }
        }
      }
    }

    return suggestions.slice(0, 5); // limit per run
  }

  // --- Private: suggest execution order -------------------------------------

  private suggestExecutionOrder(
    molecules: Molecule[],
    conflicts: FormulaConflict[],
  ): OptimizationSuggestion[] {
    if (conflicts.length === 0) return [];

    // Group conflicts by resource
    const resourceConflicts = new Map<string, FormulaConflict[]>();
    for (const c of conflicts) {
      if (!resourceConflicts.has(c.conflictResource)) {
        resourceConflicts.set(c.conflictResource, []);
      }
      resourceConflicts.get(c.conflictResource)!.push(c);
    }

    const suggestions: OptimizationSuggestion[] = [];

    for (const [resource, rConflicts] of resourceConflicts) {
      if (rConflicts.length === 0) continue;

      const involvedFormulas = [
        ...new Set(rConflicts.flatMap(c => [c.formulaA, c.formulaB])),
      ];
      const involvedMolecules = [
        ...new Set(rConflicts.flatMap(c => [c.moleculeA, c.moleculeB])),
      ];

      suggestions.push({
        id: uuidv4(),
        type: 'execution_order',
        description:
          `${involvedFormulas.length} formulas contending for "${resource}". ` +
          `Suggest staggered execution to avoid ${rConflicts[0].conflictType} conflicts.`,
        involvedFormulas,
        involvedMolecules,
        estimatedSavingsMs: 5_000 * rConflicts.length,
        estimatedCostSavingsUsd: 0,
        confidence: 0.6,
        details: { resource, conflictCount: rConflicts.length },
        status: 'pending',
        createdAt: new Date(),
      });
    }

    return suggestions;
  }

  // --- Private: detect merge opportunities ----------------------------------

  private detectMergeOpportunities(molecules: Molecule[]): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    for (let i = 0; i < molecules.length; i++) {
      for (let j = i + 1; j < molecules.length; j++) {
        const molA = molecules[i];
        const molB = molecules[j];

        const skillsA = new Set(molA.steps.map(s => s.skill).filter(Boolean));
        const skillsB = new Set(molB.steps.map(s => s.skill).filter(Boolean));

        // Compute skill overlap
        const intersection = [...skillsA].filter(s => skillsB.has(s));
        const union = new Set([...skillsA, ...skillsB]);
        const overlapRatio = union.size > 0 ? intersection.length / union.size : 0;

        if (overlapRatio >= 0.6 && intersection.length >= 3) {
          suggestions.push({
            id: uuidv4(),
            type: 'merge_opportunity',
            description:
              `"${molA.formulaName}" and "${molB.formulaName}" share ${Math.round(overlapRatio * 100)}% of skills ` +
              `(${intersection.join(', ')}). Consider merging into a single formula.`,
            involvedFormulas: [molA.formulaName, molB.formulaName],
            involvedMolecules: [molA.id, molB.id],
            estimatedSavingsMs: Math.round(
              (molA.steps.length + molB.steps.length) * 2000 * overlapRatio,
            ),
            estimatedCostSavingsUsd:
              intersection.length * 0.001, // rough estimate
            confidence: overlapRatio,
            details: {
              sharedSkills: intersection,
              overlapRatio: Math.round(overlapRatio * 100) / 100,
            },
            status: 'pending',
            createdAt: new Date(),
          });
        }
      }
    }

    return suggestions;
  }

  // --- Private: update interaction tracking ---------------------------------

  private updateInteractions(molecules: Molecule[]): void {
    for (let i = 0; i < molecules.length; i++) {
      for (let j = i + 1; j < molecules.length; j++) {
        const a = molecules[i].formulaName;
        const b = molecules[j].formulaName;
        const key = a < b ? `${a}::${b}` : `${b}::${a}`;

        let interaction = this.interactions.find(
          int => (int.formulaA === a && int.formulaB === b) ||
                 (int.formulaA === b && int.formulaB === a),
        );

        if (!interaction) {
          interaction = {
            formulaA: a < b ? a : b,
            formulaB: a < b ? b : a,
            coOccurrences: 0,
            sharedStepCount: 0,
            conflictCount: 0,
            avgOverlapMs: 0,
            lastObservedAt: new Date(),
          };
          this.interactions.push(interaction);
        }

        interaction.coOccurrences++;
        interaction.lastObservedAt = new Date();

        // Compute temporal overlap
        const startA = molecules[i].createdAt.getTime();
        const startB = molecules[j].createdAt.getTime();
        const now = Date.now();
        const overlapStart = Math.max(startA, startB);
        const overlapMs = Math.max(0, now - overlapStart);
        interaction.avgOverlapMs =
          interaction.avgOverlapMs * 0.8 + overlapMs * 0.2;
      }
    }

    // Trim old interactions
    if (this.interactions.length > 500) {
      this.interactions = this.interactions
        .sort((a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime())
        .slice(0, 500);
    }
  }

  // --- Private: estimate step cost ------------------------------------------

  private estimateStepCost(skill: string): number {
    // Rough cost estimate per skill execution (USD)
    const costMap: Record<string, number> = {
      'meta-ads': 0.005,
      'google-ads': 0.005,
      'web-scrape': 0.002,
      'image-gen': 0.01,
      'llm-call': 0.003,
      'code-gen': 0.005,
      'data-analysis': 0.003,
    };
    return costMap[skill] ?? 0.002;
  }

  // --- Private: AI-enhanced suggestions -------------------------------------

  private async getAiSuggestions(
    molecules: Molecule[],
    sharedSteps: SharedStep[],
    conflicts: FormulaConflict[],
  ): Promise<OptimizationSuggestion[] | null> {
    const molSummaries = molecules.map(m => ({
      formula: m.formulaName,
      steps: m.steps.length,
      running: m.steps.filter(s => s.status === 'running').length,
      skills: m.steps.map(s => s.skill).filter(Boolean),
    }));

    const prompt = `Analyze these concurrent formulas and suggest cross-formula optimizations.

Active formulas:
${molSummaries.map(m => `- ${m.formula}: ${m.steps} steps (${m.running} running), skills: [${m.skills.join(', ')}]`).join('\n')}

Shared steps found: ${sharedSteps.map(s => `${s.skill} (in ${s.formulaNames.join(', ')})`).join('; ')}
Conflicts found: ${conflicts.map(c => `${c.conflictResource}: ${c.formulaA} vs ${c.formulaB} (${c.conflictType})`).join('; ')}

Suggest optimizations as JSON array:
[{"type":"step_dedup|result_sharing|execution_order|merge_opportunity|resource_contention","description":"...","involvedFormulas":["..."],"estimatedSavingsMs":0,"confidence":0.0-1.0}]`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as Array<{
        type: OptimizationType;
        description: string;
        involvedFormulas: string[];
        estimatedSavingsMs: number;
        confidence: number;
      }>;

      return parsed
        .filter(p => p.type && p.description && Array.isArray(p.involvedFormulas))
        .map(p => ({
          id: uuidv4(),
          type: p.type,
          description: `AI: ${p.description}`,
          involvedFormulas: p.involvedFormulas,
          involvedMolecules: [],
          estimatedSavingsMs: p.estimatedSavingsMs ?? 0,
          estimatedCostSavingsUsd: 0,
          confidence: Math.max(0, Math.min(1, p.confidence ?? 0.5)),
          details: { source: 'ai' },
          status: 'pending' as const,
          createdAt: new Date(),
        }));
    } catch {
      return null;
    }
  }

  // --- Private: JSON parse safety -------------------------------------------

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    return raw as T;
  }

  // --- Persistence: report --------------------------------------------------

  private async persistReport(report: AnalysisReport): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    // Persist each suggestion
    for (const suggestion of report.suggestions) {
      try {
        await pool.query(
          `INSERT INTO meow_formula_optimizations
            (id, type, description, involved_formulas, involved_molecules,
             estimated_savings_ms, estimated_cost_savings_usd, confidence,
             details, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING`,
          [
            suggestion.id,
            suggestion.type,
            suggestion.description,
            JSON.stringify(suggestion.involvedFormulas),
            JSON.stringify(suggestion.involvedMolecules),
            suggestion.estimatedSavingsMs,
            suggestion.estimatedCostSavingsUsd,
            suggestion.confidence,
            JSON.stringify(suggestion.details),
            suggestion.status,
            suggestion.createdAt.toISOString(),
          ],
        );
      } catch (err) {
        log.warn({ err, suggestionId: suggestion.id }, 'Failed to persist optimization suggestion');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CrossFormulaOptimizer | null = null;

export function getCrossFormulaOptimizer(): CrossFormulaOptimizer {
  if (!instance) {
    instance = new CrossFormulaOptimizer();
  }
  return instance;
}
