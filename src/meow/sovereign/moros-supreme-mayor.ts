/**
 * MOROS SUPREME MAYOR -- SG-001 (Stage 06 Wave 1)
 *
 * MOROS (sovereign entity) supervises the Gas Town Mayor.
 *
 * Chain of command:
 *   MOROS strategic directive -> Mayor tactical plan -> Workers execute
 *
 * MOROS defines high-level strategic priorities by pulling intelligence from:
 *   - MegaBrain pattern library (cross-domain insights)
 *   - DropOps performance metrics (real-time business health)
 *   - Market conditions (seasonal, competitive, regulatory)
 *
 * The Mayor translates each directive into tactical execution:
 *   - Bead priority adjustments
 *   - Formula scheduling changes
 *   - Worker allocation shifts
 *   - Resource rebalancing
 *
 * Directive types:
 *   - market_focus:       Shift attention to a specific market/vertical
 *   - budget_reallocation: Move budget between business areas
 *   - crisis_response:    Emergency protocol when metrics breach thresholds
 *   - opportunity_capture: Exploit a detected window of opportunity
 *
 * Directive lifecycle:
 *   proposed -> reviewed -> active -> superseded
 *
 * Periodic strategy review configurable (default: every 6 hours).
 * Full audit trail in meow_strategic_directives DB table.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('moros-supreme-mayor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DirectiveType =
  | 'market_focus'
  | 'budget_reallocation'
  | 'crisis_response'
  | 'opportunity_capture';

export type DirectiveStatus =
  | 'proposed'
  | 'reviewed'
  | 'active'
  | 'superseded';

export interface StrategicDirective {
  id: string;
  type: DirectiveType;
  status: DirectiveStatus;
  title: string;
  rationale: string;
  sourceIntelligence: SourceIntelligence;
  tacticalPlan: TacticalPlan | null;
  priority: number;                   // 1 (highest) - 10 (lowest)
  impactEstimate: ImpactEstimate;
  createdAt: Date;
  reviewedAt: Date | null;
  activatedAt: Date | null;
  supersededAt: Date | null;
  supersededBy: string | null;        // ID of new directive
  metadata?: Record<string, unknown>;
}

export interface SourceIntelligence {
  megabrainPatterns: string[];        // pattern IDs from MegaBrain
  dropopsMetrics: PerformanceSignal[];
  marketConditions: string[];
  confidenceScore: number;            // 0.0 - 1.0
}

export interface PerformanceSignal {
  metric: string;
  currentValue: number;
  threshold: number;
  direction: 'above' | 'below' | 'stable';
  severity: 'info' | 'warning' | 'critical';
}

export interface TacticalPlan {
  beadPriorityShifts: Array<{ beadPattern: string; newPriority: string }>;
  formulaScheduling: Array<{ formulaId: string; action: 'accelerate' | 'pause' | 'reschedule' }>;
  workerAllocation: Array<{ pool: string; change: number; reason: string }>;
  budgetAdjustments: Array<{ area: string; changePercent: number; reason: string }>;
  estimatedDurationHours: number;
  rollbackPlan: string;
}

export interface ImpactEstimate {
  revenueImpactPercent: number;       // + or - percentage
  riskLevel: 'low' | 'medium' | 'high';
  affectedMarkets: string[];
  affectedFormulas: string[];
  timeToImpactHours: number;
}

export interface MorosStrategyConfig {
  reviewIntervalMs: number;           // default 6h
  maxActiveDirectives: number;        // max simultaneous active
  autoActivateLowRisk: boolean;       // auto-activate low-risk directives
  crisisThresholds: Record<string, number>;
}

export interface MorosStats {
  totalDirectives: number;
  activeDirectives: number;
  proposedDirectives: number;
  avgConfidenceScore: number;
  directivesByType: Record<string, number>;
  lastReviewAt: Date | null;
  nextReviewAt: Date | null;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MorosStrategyConfig = {
  reviewIntervalMs: 6 * 60 * 60 * 1000,  // 6 hours
  maxActiveDirectives: 5,
  autoActivateLowRisk: true,
  crisisThresholds: {
    roas_min: 1.5,
    cpa_max: 30,
    conversion_rate_min: 0.02,
    budget_utilization_max: 0.95,
    error_rate_max: 0.10,
  },
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(systemPrompt: string, userPrompt: string): Promise<string | null> {
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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
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
    log.warn({ err }, 'Gemini call failed in moros-supreme-mayor');
    return null;
  }
}

// ---------------------------------------------------------------------------
// MorosSupremeMayor
// ---------------------------------------------------------------------------

export class MorosSupremeMayor {
  private directives: StrategicDirective[] = [];
  private config: MorosStrategyConfig;
  private maxInMemory = 5_000;
  private reviewTimer: NodeJS.Timeout | null = null;
  private lastReviewAt: Date | null = null;

  constructor(config?: Partial<MorosStrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Start periodic strategy review ----------------------------------------

  startPeriodicReview(): void {
    if (this.reviewTimer) return;

    this.reviewTimer = setInterval(async () => {
      try {
        await this.conductStrategyReview();
      } catch (err) {
        log.error({ err }, 'Periodic strategy review failed');
      }
    }, this.config.reviewIntervalMs);

    log.info(
      { intervalMs: this.config.reviewIntervalMs },
      'MOROS periodic strategy review started',
    );
  }

  stopPeriodicReview(): void {
    if (this.reviewTimer) {
      clearInterval(this.reviewTimer);
      this.reviewTimer = null;
      log.info('MOROS periodic strategy review stopped');
    }
  }

  // --- Conduct strategy review -----------------------------------------------

  async conductStrategyReview(): Promise<StrategicDirective[]> {
    log.info('MOROS conducting strategy review...');
    const startMs = Date.now();

    // 1. Gather intelligence
    const intelligence = await this.gatherIntelligence();

    // 2. Generate directives via AI
    const proposed = await this.generateDirectives(intelligence);

    // 3. Check for crisis conditions
    const crisisDirectives = this.detectCrisisConditions(intelligence);
    proposed.push(...crisisDirectives);

    // 4. Deduplicate against active directives
    const novel = this.filterNovelDirectives(proposed);

    // 5. Store and broadcast
    for (const d of novel) {
      this.directives.push(d);
      await this.persistDirective(d);

      // Auto-activate low-risk if configured
      if (this.config.autoActivateLowRisk && d.impactEstimate.riskLevel === 'low') {
        await this.activateDirective(d.id);
      }
    }

    // Evict old in-memory
    if (this.directives.length > this.maxInMemory) {
      this.directives = this.directives.slice(-this.maxInMemory);
    }

    this.lastReviewAt = new Date();
    const elapsedMs = Date.now() - startMs;

    broadcast('meow:sovereign', {
      type: 'moros_strategy_review',
      proposedCount: novel.length,
      crisisCount: crisisDirectives.length,
      activeCount: this.getActiveDirectives().length,
      elapsedMs,
    });

    log.info(
      { proposedCount: novel.length, crisisCount: crisisDirectives.length, elapsedMs },
      'MOROS strategy review complete',
    );

    return novel;
  }

  // --- Create a manual directive ---------------------------------------------

  async createDirective(
    type: DirectiveType,
    title: string,
    rationale: string,
    impactEstimate: Partial<ImpactEstimate>,
  ): Promise<StrategicDirective> {
    const directive: StrategicDirective = {
      id: uuidv4(),
      type,
      status: 'proposed',
      title,
      rationale,
      sourceIntelligence: {
        megabrainPatterns: [],
        dropopsMetrics: [],
        marketConditions: [],
        confidenceScore: 0.7,
      },
      tacticalPlan: null,
      priority: type === 'crisis_response' ? 1 : 5,
      impactEstimate: {
        revenueImpactPercent: impactEstimate.revenueImpactPercent ?? 0,
        riskLevel: impactEstimate.riskLevel ?? 'medium',
        affectedMarkets: impactEstimate.affectedMarkets ?? [],
        affectedFormulas: impactEstimate.affectedFormulas ?? [],
        timeToImpactHours: impactEstimate.timeToImpactHours ?? 24,
      },
      createdAt: new Date(),
      reviewedAt: null,
      activatedAt: null,
      supersededAt: null,
      supersededBy: null,
    };

    // Generate tactical plan via AI
    directive.tacticalPlan = await this.generateTacticalPlan(directive);

    this.directives.push(directive);
    await this.persistDirective(directive);

    broadcast('meow:sovereign', {
      type: 'moros_directive_created',
      directiveId: directive.id,
      directiveType: directive.type,
      title: directive.title,
      priority: directive.priority,
    });

    log.info({ id: directive.id, type, title }, 'Strategic directive created');
    return directive;
  }

  // --- Activate a directive (Mayor receives it) ------------------------------

  async activateDirective(directiveId: string): Promise<boolean> {
    const directive = this.directives.find(d => d.id === directiveId);
    if (!directive) {
      log.warn({ directiveId }, 'Directive not found for activation');
      return false;
    }

    if (directive.status !== 'proposed' && directive.status !== 'reviewed') {
      log.warn({ directiveId, status: directive.status }, 'Directive not in activatable state');
      return false;
    }

    // Check max active limit
    const activeCount = this.getActiveDirectives().length;
    if (activeCount >= this.config.maxActiveDirectives) {
      log.warn(
        { activeCount, max: this.config.maxActiveDirectives },
        'Max active directives reached, cannot activate',
      );
      return false;
    }

    // Generate tactical plan if missing
    if (!directive.tacticalPlan) {
      directive.tacticalPlan = await this.generateTacticalPlan(directive);
    }

    directive.status = 'active';
    directive.activatedAt = new Date();
    if (!directive.reviewedAt) directive.reviewedAt = new Date();

    await this.updateDirectiveStatus(directive);

    broadcast('meow:sovereign', {
      type: 'moros_directive_activated',
      directiveId: directive.id,
      directiveType: directive.type,
      title: directive.title,
      tacticalPlan: directive.tacticalPlan ? {
        beadShifts: directive.tacticalPlan.beadPriorityShifts.length,
        formulaChanges: directive.tacticalPlan.formulaScheduling.length,
        workerChanges: directive.tacticalPlan.workerAllocation.length,
        budgetChanges: directive.tacticalPlan.budgetAdjustments.length,
      } : null,
    });

    log.info({ id: directive.id, type: directive.type }, 'Directive activated — Mayor now executing');
    return true;
  }

  // --- Supersede an active directive -----------------------------------------

  async supersedeDirective(
    oldDirectiveId: string,
    newDirectiveId: string,
  ): Promise<boolean> {
    const oldDirective = this.directives.find(d => d.id === oldDirectiveId);
    const newDirective = this.directives.find(d => d.id === newDirectiveId);

    if (!oldDirective || !newDirective) return false;
    if (oldDirective.status !== 'active') return false;

    oldDirective.status = 'superseded';
    oldDirective.supersededAt = new Date();
    oldDirective.supersededBy = newDirectiveId;

    await this.updateDirectiveStatus(oldDirective);

    broadcast('meow:sovereign', {
      type: 'moros_directive_superseded',
      oldDirectiveId,
      newDirectiveId,
      reason: `Superseded by: ${newDirective.title}`,
    });

    log.info({ oldDirectiveId, newDirectiveId }, 'Directive superseded');
    return true;
  }

  // --- Review a proposed directive -------------------------------------------

  async reviewDirective(
    directiveId: string,
    approved: boolean,
    notes?: string,
  ): Promise<boolean> {
    const directive = this.directives.find(d => d.id === directiveId);
    if (!directive || directive.status !== 'proposed') return false;

    directive.reviewedAt = new Date();

    if (approved) {
      directive.status = 'reviewed';
      if (notes) {
        directive.metadata = { ...directive.metadata, reviewNotes: notes };
      }
      await this.updateDirectiveStatus(directive);
      log.info({ directiveId, notes }, 'Directive reviewed and approved');
    } else {
      directive.status = 'superseded';
      directive.supersededAt = new Date();
      directive.metadata = { ...directive.metadata, rejectionNotes: notes };
      await this.updateDirectiveStatus(directive);
      log.info({ directiveId, notes }, 'Directive reviewed and rejected');
    }

    return true;
  }

  // --- Getters ---------------------------------------------------------------

  getDirective(id: string): StrategicDirective | null {
    return this.directives.find(d => d.id === id) ?? null;
  }

  getActiveDirectives(): StrategicDirective[] {
    return this.directives.filter(d => d.status === 'active');
  }

  getProposedDirectives(): StrategicDirective[] {
    return this.directives.filter(d => d.status === 'proposed');
  }

  getDirectivesByType(type: DirectiveType): StrategicDirective[] {
    return this.directives.filter(d => d.type === type);
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): MorosStats {
    const total = this.directives.length;
    const active = this.directives.filter(d => d.status === 'active').length;
    const proposed = this.directives.filter(d => d.status === 'proposed').length;

    const withConfidence = this.directives.filter(d => d.sourceIntelligence.confidenceScore > 0);
    const avgConfidence = withConfidence.length > 0
      ? Math.round(
          (withConfidence.reduce((s, d) => s + d.sourceIntelligence.confidenceScore, 0) /
            withConfidence.length) * 1000,
        ) / 1000
      : 0;

    const byType: Record<string, number> = {};
    for (const d of this.directives) {
      byType[d.type] = (byType[d.type] ?? 0) + 1;
    }

    const nextReviewAt = this.lastReviewAt
      ? new Date(this.lastReviewAt.getTime() + this.config.reviewIntervalMs)
      : null;

    return {
      totalDirectives: total,
      activeDirectives: active,
      proposedDirectives: proposed,
      avgConfidenceScore: avgConfidence,
      directivesByType: byType,
      lastReviewAt: this.lastReviewAt,
      nextReviewAt,
    };
  }

  // --- Update config ---------------------------------------------------------

  updateConfig(updates: Partial<MorosStrategyConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart periodic review if interval changed
    if (updates.reviewIntervalMs && this.reviewTimer) {
      this.stopPeriodicReview();
      this.startPeriodicReview();
    }

    log.info({ config: this.config }, 'MOROS config updated');
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, status, title, rationale, source_intelligence,
                tactical_plan, priority, impact_estimate,
                created_at, reviewed_at, activated_at, superseded_at,
                superseded_by, metadata
         FROM meow_strategic_directives
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, this.maxInMemory],
      );

      this.directives = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as DirectiveType,
        status: r.status as DirectiveStatus,
        title: r.title as string,
        rationale: (r.rationale as string) ?? '',
        sourceIntelligence: this.parseJsonSafe(r.source_intelligence, {
          megabrainPatterns: [],
          dropopsMetrics: [],
          marketConditions: [],
          confidenceScore: 0,
        }),
        tacticalPlan: this.parseJsonSafe(r.tactical_plan, null),
        priority: parseInt(String(r.priority ?? '5'), 10),
        impactEstimate: this.parseJsonSafe(r.impact_estimate, {
          revenueImpactPercent: 0,
          riskLevel: 'medium',
          affectedMarkets: [],
          affectedFormulas: [],
          timeToImpactHours: 24,
        }),
        createdAt: new Date(r.created_at as string),
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string) : null,
        activatedAt: r.activated_at ? new Date(r.activated_at as string) : null,
        supersededAt: r.superseded_at ? new Date(r.superseded_at as string) : null,
        supersededBy: (r.superseded_by as string) ?? null,
        metadata: this.parseJsonSafe(r.metadata, {}),
      }));

      log.info({ count: this.directives.length }, 'Loaded strategic directives from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load strategic directives from DB');
    }
  }

  // --- Destroy ---------------------------------------------------------------

  destroy(): void {
    this.stopPeriodicReview();
    log.info('MorosSupremeMayor destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private: Intelligence Gathering
  // ---------------------------------------------------------------------------

  private async gatherIntelligence(): Promise<SourceIntelligence> {
    const pool = getPool();
    const megabrainPatterns: string[] = [];
    const dropopsMetrics: PerformanceSignal[] = [];
    const marketConditions: string[] = [];

    // Fetch MegaBrain patterns
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, content, category
           FROM megabrain_fragments
           WHERE category IN ('pattern', 'heuristic', 'strategy')
             AND created_at > NOW() - INTERVAL '7 days'
           ORDER BY created_at DESC
           LIMIT 20`,
        );
        for (const r of rows as Array<Record<string, unknown>>) {
          megabrainPatterns.push(`${r.category}: ${(r.content as string).slice(0, 200)}`);
        }
      } catch (err) {
        log.warn({ err }, 'Failed to fetch MegaBrain patterns');
      }
    }

    // Fetch DropOps performance
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT metric_name, metric_value, threshold_value, severity
           FROM meow_performance_metrics
           WHERE recorded_at > NOW() - INTERVAL '24 hours'
           ORDER BY recorded_at DESC
           LIMIT 30`,
        );
        for (const r of rows as Array<Record<string, unknown>>) {
          const val = parseFloat(String(r.metric_value ?? '0'));
          const thresh = parseFloat(String(r.threshold_value ?? '0'));
          dropopsMetrics.push({
            metric: r.metric_name as string,
            currentValue: val,
            threshold: thresh,
            direction: val > thresh ? 'above' : val < thresh ? 'below' : 'stable',
            severity: (r.severity as 'info' | 'warning' | 'critical') ?? 'info',
          });
        }
      } catch (err) {
        log.warn({ err }, 'Failed to fetch DropOps metrics');
      }
    }

    // Fetch recent market advisories (from ATLAS)
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT advisory_type, title, country_codes
           FROM meow_world_advisories
           WHERE status IN ('detected', 'assessed', 'published')
             AND created_at > NOW() - INTERVAL '48 hours'
           ORDER BY created_at DESC
           LIMIT 10`,
        );
        for (const r of rows as Array<Record<string, unknown>>) {
          marketConditions.push(`[${r.advisory_type}] ${r.title} (${r.country_codes})`);
        }
      } catch (err) {
        log.warn({ err }, 'Failed to fetch market advisories');
      }
    }

    // Calculate confidence based on data availability
    let confidence = 0.3; // baseline
    if (megabrainPatterns.length > 0) confidence += 0.2;
    if (dropopsMetrics.length > 0) confidence += 0.3;
    if (marketConditions.length > 0) confidence += 0.2;

    return {
      megabrainPatterns,
      dropopsMetrics,
      marketConditions,
      confidenceScore: Math.min(1, confidence),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Directive Generation
  // ---------------------------------------------------------------------------

  private async generateDirectives(
    intelligence: SourceIntelligence,
  ): Promise<StrategicDirective[]> {
    const prompt = `You are MOROS, the supreme strategic entity overseeing Gas Town operations.

Based on the following intelligence, propose 0-3 strategic directives.

=== MegaBrain Patterns ===
${intelligence.megabrainPatterns.slice(0, 10).join('\n') || 'No recent patterns'}

=== Performance Metrics ===
${intelligence.dropopsMetrics
  .slice(0, 10)
  .map(m => `${m.metric}: ${m.currentValue} (threshold: ${m.threshold}, ${m.severity})`)
  .join('\n') || 'No recent metrics'}

=== Market Conditions ===
${intelligence.marketConditions.slice(0, 5).join('\n') || 'No recent conditions'}

Respond with JSON array:
[{
  "type": "market_focus|budget_reallocation|crisis_response|opportunity_capture",
  "title": "short directive title",
  "rationale": "why this directive is needed",
  "priority": 1-10,
  "riskLevel": "low|medium|high",
  "affectedMarkets": ["AR","BR","MX",...],
  "revenueImpactPercent": -5 to +20,
  "timeToImpactHours": number
}]

If no directives are warranted, respond with: []`;

    const raw = await callGemini(
      'You are MOROS, the supreme strategic intelligence. Analyze data and propose directives. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) {
      return this.generateHeuristicDirectives(intelligence);
    }

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return this.generateHeuristicDirectives(intelligence);

      const parsed = JSON.parse(match[0]) as Array<{
        type: string;
        title: string;
        rationale: string;
        priority: number;
        riskLevel: string;
        affectedMarkets: string[];
        revenueImpactPercent: number;
        timeToImpactHours: number;
      }>;

      if (!Array.isArray(parsed) || parsed.length === 0) return [];

      return parsed.slice(0, 3).map(p => ({
        id: uuidv4(),
        type: this.validateDirectiveType(p.type),
        status: 'proposed' as DirectiveStatus,
        title: (p.title ?? 'Untitled directive').slice(0, 200),
        rationale: (p.rationale ?? '').slice(0, 1000),
        sourceIntelligence: intelligence,
        tacticalPlan: null,
        priority: Math.max(1, Math.min(10, p.priority ?? 5)),
        impactEstimate: {
          revenueImpactPercent: p.revenueImpactPercent ?? 0,
          riskLevel: this.validateRiskLevel(p.riskLevel),
          affectedMarkets: Array.isArray(p.affectedMarkets) ? p.affectedMarkets : [],
          affectedFormulas: [],
          timeToImpactHours: p.timeToImpactHours ?? 24,
        },
        createdAt: new Date(),
        reviewedAt: null,
        activatedAt: null,
        supersededAt: null,
        supersededBy: null,
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to parse Gemini directive response');
      return this.generateHeuristicDirectives(intelligence);
    }
  }

  private generateHeuristicDirectives(
    intelligence: SourceIntelligence,
  ): StrategicDirective[] {
    const directives: StrategicDirective[] = [];

    // Crisis detection: any critical-severity metric
    const criticals = intelligence.dropopsMetrics.filter(m => m.severity === 'critical');
    if (criticals.length > 0) {
      directives.push({
        id: uuidv4(),
        type: 'crisis_response',
        status: 'proposed',
        title: `Crisis: ${criticals.length} critical metric(s) breached`,
        rationale: criticals.map(c => `${c.metric}: ${c.currentValue} (threshold: ${c.threshold})`).join('; '),
        sourceIntelligence: intelligence,
        tacticalPlan: null,
        priority: 1,
        impactEstimate: {
          revenueImpactPercent: -10,
          riskLevel: 'high',
          affectedMarkets: [],
          affectedFormulas: [],
          timeToImpactHours: 2,
        },
        createdAt: new Date(),
        reviewedAt: null,
        activatedAt: null,
        supersededAt: null,
        supersededBy: null,
      });
    }

    // Opportunity: strong positive metrics
    const positives = intelligence.dropopsMetrics.filter(
      m => m.direction === 'above' && m.severity === 'info',
    );
    if (positives.length >= 3) {
      directives.push({
        id: uuidv4(),
        type: 'opportunity_capture',
        status: 'proposed',
        title: 'Multiple positive signals — scale up opportunity',
        rationale: `${positives.length} metrics trending positively`,
        sourceIntelligence: intelligence,
        tacticalPlan: null,
        priority: 3,
        impactEstimate: {
          revenueImpactPercent: 5,
          riskLevel: 'low',
          affectedMarkets: [],
          affectedFormulas: [],
          timeToImpactHours: 12,
        },
        createdAt: new Date(),
        reviewedAt: null,
        activatedAt: null,
        supersededAt: null,
        supersededBy: null,
      });
    }

    return directives;
  }

  // ---------------------------------------------------------------------------
  // Private: Crisis Detection
  // ---------------------------------------------------------------------------

  private detectCrisisConditions(
    intelligence: SourceIntelligence,
  ): StrategicDirective[] {
    const directives: StrategicDirective[] = [];

    for (const metric of intelligence.dropopsMetrics) {
      if (metric.severity !== 'critical') continue;

      const thresholdKey = Object.keys(this.config.crisisThresholds).find(k =>
        metric.metric.toLowerCase().includes(k.replace('_min', '').replace('_max', '')),
      );

      if (!thresholdKey) continue;

      const alreadyCrisis = this.directives.some(
        d =>
          d.type === 'crisis_response' &&
          d.status === 'active' &&
          d.rationale.includes(metric.metric),
      );

      if (alreadyCrisis) continue;

      directives.push({
        id: uuidv4(),
        type: 'crisis_response',
        status: 'proposed',
        title: `CRISIS: ${metric.metric} at ${metric.currentValue} (threshold: ${metric.threshold})`,
        rationale: `Metric ${metric.metric} has breached crisis threshold. Current: ${metric.currentValue}, Expected: ${metric.threshold}, Direction: ${metric.direction}`,
        sourceIntelligence: intelligence,
        tacticalPlan: null,
        priority: 1,
        impactEstimate: {
          revenueImpactPercent: -15,
          riskLevel: 'high',
          affectedMarkets: [],
          affectedFormulas: [],
          timeToImpactHours: 1,
        },
        createdAt: new Date(),
        reviewedAt: null,
        activatedAt: null,
        supersededAt: null,
        supersededBy: null,
      });
    }

    return directives;
  }

  // ---------------------------------------------------------------------------
  // Private: Tactical Plan Generation
  // ---------------------------------------------------------------------------

  private async generateTacticalPlan(
    directive: StrategicDirective,
  ): Promise<TacticalPlan> {
    const prompt = `Given this strategic directive, generate a tactical execution plan for the Gas Town Mayor.

Directive: ${directive.title}
Type: ${directive.type}
Rationale: ${directive.rationale}
Priority: ${directive.priority}
Risk Level: ${directive.impactEstimate.riskLevel}
Affected Markets: ${directive.impactEstimate.affectedMarkets.join(', ') || 'all'}

Respond with JSON:
{
  "beadPriorityShifts": [{"beadPattern": "pattern", "newPriority": "high|medium|low"}],
  "formulaScheduling": [{"formulaId": "id", "action": "accelerate|pause|reschedule"}],
  "workerAllocation": [{"pool": "pool_name", "change": +2 or -1, "reason": "why"}],
  "budgetAdjustments": [{"area": "area_name", "changePercent": 10, "reason": "why"}],
  "estimatedDurationHours": number,
  "rollbackPlan": "how to roll back if needed"
}`;

    const raw = await callGemini(
      'You are the tactical planning engine for Gas Town Mayor. Create detailed, actionable plans. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) return this.generateHeuristicTacticalPlan(directive);

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return this.generateHeuristicTacticalPlan(directive);

      const parsed = JSON.parse(match[0]) as TacticalPlan;
      return {
        beadPriorityShifts: Array.isArray(parsed.beadPriorityShifts)
          ? parsed.beadPriorityShifts.slice(0, 10)
          : [],
        formulaScheduling: Array.isArray(parsed.formulaScheduling)
          ? parsed.formulaScheduling.slice(0, 10)
          : [],
        workerAllocation: Array.isArray(parsed.workerAllocation)
          ? parsed.workerAllocation.slice(0, 10)
          : [],
        budgetAdjustments: Array.isArray(parsed.budgetAdjustments)
          ? parsed.budgetAdjustments.slice(0, 10)
          : [],
        estimatedDurationHours: parsed.estimatedDurationHours ?? 24,
        rollbackPlan: (parsed.rollbackPlan ?? 'Revert to previous configuration').slice(0, 500),
      };
    } catch {
      return this.generateHeuristicTacticalPlan(directive);
    }
  }

  private generateHeuristicTacticalPlan(directive: StrategicDirective): TacticalPlan {
    const plan: TacticalPlan = {
      beadPriorityShifts: [],
      formulaScheduling: [],
      workerAllocation: [],
      budgetAdjustments: [],
      estimatedDurationHours: 24,
      rollbackPlan: 'Revert to previous configuration and notify operators.',
    };

    switch (directive.type) {
      case 'crisis_response':
        plan.beadPriorityShifts.push({ beadPattern: '*', newPriority: 'critical' });
        plan.workerAllocation.push({ pool: 'default', change: 2, reason: 'Crisis staffing' });
        plan.estimatedDurationHours = 4;
        plan.rollbackPlan = 'Scale down workers and reset priorities after crisis resolution.';
        break;
      case 'budget_reallocation':
        plan.budgetAdjustments.push({ area: 'ads', changePercent: -10, reason: 'Reallocation' });
        plan.budgetAdjustments.push({ area: 'content', changePercent: 10, reason: 'Reallocation' });
        plan.estimatedDurationHours = 12;
        break;
      case 'market_focus':
        plan.beadPriorityShifts.push({ beadPattern: 'market:*', newPriority: 'high' });
        plan.formulaScheduling.push({ formulaId: 'market-analysis', action: 'accelerate' });
        plan.estimatedDurationHours = 48;
        break;
      case 'opportunity_capture':
        plan.workerAllocation.push({ pool: 'default', change: 1, reason: 'Opportunity scaling' });
        plan.formulaScheduling.push({ formulaId: 'campaign-launch', action: 'accelerate' });
        plan.estimatedDurationHours = 24;
        break;
    }

    return plan;
  }

  // ---------------------------------------------------------------------------
  // Private: Filtering
  // ---------------------------------------------------------------------------

  private filterNovelDirectives(
    proposed: StrategicDirective[],
  ): StrategicDirective[] {
    const active = this.getActiveDirectives();
    return proposed.filter(p => {
      // Skip if same type + similar title already active
      const duplicate = active.some(
        a => a.type === p.type && this.titleSimilarity(a.title, p.title) > 0.7,
      );
      if (duplicate) {
        log.info({ title: p.title }, 'Skipping duplicate directive');
      }
      return !duplicate;
    });
  }

  private titleSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // ---------------------------------------------------------------------------
  // Private: Validation Helpers
  // ---------------------------------------------------------------------------

  private validateDirectiveType(raw: string): DirectiveType {
    const valid: DirectiveType[] = ['market_focus', 'budget_reallocation', 'crisis_response', 'opportunity_capture'];
    return valid.includes(raw as DirectiveType) ? (raw as DirectiveType) : 'market_focus';
  }

  private validateRiskLevel(raw: string): 'low' | 'medium' | 'high' {
    const valid = ['low', 'medium', 'high'];
    return valid.includes(raw) ? (raw as 'low' | 'medium' | 'high') : 'medium';
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistDirective(directive: StrategicDirective): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_strategic_directives
          (id, type, status, title, rationale, source_intelligence,
           tactical_plan, priority, impact_estimate,
           created_at, reviewed_at, activated_at, superseded_at,
           superseded_by, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          directive.id,
          directive.type,
          directive.status,
          directive.title,
          directive.rationale.slice(0, 2000),
          JSON.stringify(directive.sourceIntelligence),
          directive.tacticalPlan ? JSON.stringify(directive.tacticalPlan) : null,
          directive.priority,
          JSON.stringify(directive.impactEstimate),
          directive.createdAt.toISOString(),
          directive.reviewedAt?.toISOString() ?? null,
          directive.activatedAt?.toISOString() ?? null,
          directive.supersededAt?.toISOString() ?? null,
          directive.supersededBy,
          directive.metadata ? JSON.stringify(directive.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, directiveId: directive.id }, 'Failed to persist strategic directive');
    }
  }

  private async updateDirectiveStatus(directive: StrategicDirective): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_strategic_directives
         SET status = $1, tactical_plan = $2, reviewed_at = $3,
             activated_at = $4, superseded_at = $5, superseded_by = $6, metadata = $7
         WHERE id = $8`,
        [
          directive.status,
          directive.tacticalPlan ? JSON.stringify(directive.tacticalPlan) : null,
          directive.reviewedAt?.toISOString() ?? null,
          directive.activatedAt?.toISOString() ?? null,
          directive.supersededAt?.toISOString() ?? null,
          directive.supersededBy,
          directive.metadata ? JSON.stringify(directive.metadata) : null,
          directive.id,
        ],
      );
    } catch (err) {
      log.error({ err, directiveId: directive.id }, 'Failed to update directive status');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    if (typeof raw === 'object') return raw as T;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: MorosSupremeMayor | null = null;

export function getMorosSupremeMayor(
  config?: Partial<MorosStrategyConfig>,
): MorosSupremeMayor {
  if (!instance) {
    instance = new MorosSupremeMayor(config);
    log.info('MorosSupremeMayor singleton created');
  }
  return instance;
}
