/**
 * NOUS EPISTEMIC ORACLE -- SG-003 (Stage 06 Wave 1)
 *
 * NOUS lineage knowledge enriches Gas Town decision-making with deep
 * epistemic intelligence, extending nous-epistemic-injection.ts (Stage 05
 * CG-022) with strategic depth.
 *
 * While CG-022 injects structured thesis/antithesis/synthesis fragments,
 * this oracle:
 *   - Queries MegaBrain for epistemic fragments (stance + tension)
 *   - Provides cross-domain insights: patterns from other business areas
 *   - Historical pattern matching: "last time we saw this, outcome was..."
 *   - Philosophical frameworks for high-stakes decisions
 *   - Deep Gemini-powered analysis with epistemic context
 *
 * Insight types:
 *   - pattern_recognition:   Detected recurring pattern across domains
 *   - historical_analogy:    "We saw this before, here is what happened"
 *   - framework_application: First principles, inversion, second-order effects
 *   - contrarian_view:       Devil's advocate when consensus is too strong
 *
 * Insight lifecycle:
 *   generated -> validated -> applied -> impact_measured
 *
 * DB table: meow_epistemic_insights
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('nous-epistemic-oracle');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InsightType =
  | 'pattern_recognition'
  | 'historical_analogy'
  | 'framework_application'
  | 'contrarian_view';

export type InsightStatus =
  | 'generated'
  | 'validated'
  | 'applied'
  | 'impact_measured';

export type PhilosophicalFramework =
  | 'first_principles'
  | 'inversion'
  | 'second_order_effects'
  | 'regret_minimization'
  | 'premortem'
  | 'steelmanning';

export interface EpistemicInsight {
  id: string;
  type: InsightType;
  status: InsightStatus;
  title: string;
  content: string;
  context: string;                    // the question/decision being analyzed
  framework?: PhilosophicalFramework;
  sourceFragmentIds: string[];        // MegaBrain fragment references
  historicalMatches: HistoricalMatch[];
  crossDomainLinks: CrossDomainLink[];
  tensionScore: number;               // 0.0 - 1.0
  confidenceScore: number;            // 0.0 - 1.0
  impactRating: number | null;        // set after impact_measured (-1 to +1)
  createdAt: Date;
  validatedAt: Date | null;
  appliedAt: Date | null;
  measuredAt: Date | null;
  metadata?: Record<string, unknown>;
}

export interface HistoricalMatch {
  fragmentId: string;
  summary: string;
  outcome: string;
  similarity: number;                 // 0.0 - 1.0
  dateRange: string;
  domain: string;
}

export interface CrossDomainLink {
  sourceDomain: string;
  targetDomain: string;
  pattern: string;
  relevance: number;                  // 0.0 - 1.0
}

export interface OracleQuery {
  question: string;
  context?: string;
  framework?: PhilosophicalFramework;
  maxInsights?: number;
  includeContrarian?: boolean;
  includeHistorical?: boolean;
}

export interface OracleResponse {
  insights: EpistemicInsight[];
  synthesizedAnswer: string;
  frameworkApplied: PhilosophicalFramework | null;
  epistemicTension: number;
  recommendation: string;
  caveats: string[];
}

export interface NousOracleConfig {
  maxInsightsPerQuery: number;
  minTensionThreshold: number;
  historicalLookbackDays: number;
  enableContrarianDefault: boolean;
  maxFragmentsPerSearch: number;
}

export interface NousOracleStats {
  totalInsights: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byFramework: Record<string, number>;
  avgTension: number;
  avgConfidence: number;
  validationRate: number;
  impactMeasuredCount: number;
  avgImpactRating: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAMEWORK_PROMPTS: Record<PhilosophicalFramework, string> = {
  first_principles:
    'Break this down to fundamental truths. What is definitely true? What assumptions can we strip away? Rebuild reasoning from ground truth.',
  inversion:
    'Invert the problem. Instead of asking "how to succeed", ask "how would we guarantee failure?" Avoid those failure modes.',
  second_order_effects:
    'Analyze second and third-order effects. If we take this action, what happens next? And after that? Who else is affected and how will they respond?',
  regret_minimization:
    'Apply regret minimization framework. In 10 years, which decision would you regret NOT making? Optimize for minimal long-term regret.',
  premortem:
    'Perform a premortem. Assume this decision failed spectacularly. Work backwards: what went wrong? Identify the most likely failure modes.',
  steelmanning:
    'Steelman the opposing view. Present the strongest possible argument AGAINST the proposed action. What would the best critic say?',
};

const DEFAULT_CONFIG: NousOracleConfig = {
  maxInsightsPerQuery: 5,
  minTensionThreshold: 0.2,
  historicalLookbackDays: 90,
  enableContrarianDefault: true,
  maxFragmentsPerSearch: 30,
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
          temperature: 0.4,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in nous-epistemic-oracle');
    return null;
  }
}

// ---------------------------------------------------------------------------
// NousEpistemicOracle
// ---------------------------------------------------------------------------

export class NousEpistemicOracle {
  private insights: EpistemicInsight[] = [];
  private config: NousOracleConfig;
  private maxInMemory = 5_000;

  constructor(config?: Partial<NousOracleConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Query the Oracle (main entry point) -----------------------------------

  async query(oracleQuery: OracleQuery): Promise<OracleResponse> {
    log.info({ question: oracleQuery.question.slice(0, 100) }, 'NOUS Oracle query received');
    const startMs = Date.now();

    const framework = oracleQuery.framework ?? null;
    const maxInsights = oracleQuery.maxInsights ?? this.config.maxInsightsPerQuery;
    const includeContrarian = oracleQuery.includeContrarian ?? this.config.enableContrarianDefault;
    const includeHistorical = oracleQuery.includeHistorical ?? true;

    // 1. Fetch relevant epistemic fragments
    const fragments = await this.fetchRelevantFragments(oracleQuery.question);

    // 2. Find historical matches
    const historicalMatches = includeHistorical
      ? await this.findHistoricalMatches(oracleQuery.question)
      : [];

    // 3. Find cross-domain links
    const crossDomainLinks = await this.findCrossDomainLinks(oracleQuery.question);

    // 4. Generate pattern recognition insights
    const patternInsights = await this.generatePatternInsights(
      oracleQuery.question,
      fragments,
      crossDomainLinks,
    );

    // 5. Generate historical analogy insights
    const historyInsights = historicalMatches.length > 0
      ? await this.generateHistoricalInsights(oracleQuery.question, historicalMatches)
      : [];

    // 6. Apply philosophical framework if requested
    const frameworkInsight = framework
      ? await this.applyFramework(oracleQuery.question, framework, fragments)
      : null;

    // 7. Generate contrarian view
    const contrarianInsight = includeContrarian
      ? await this.generateContrarianView(oracleQuery.question, fragments)
      : null;

    // 8. Collect all insights
    const allInsights: EpistemicInsight[] = [
      ...patternInsights,
      ...historyInsights,
    ];
    if (frameworkInsight) allInsights.push(frameworkInsight);
    if (contrarianInsight) allInsights.push(contrarianInsight);

    // Limit
    const finalInsights = allInsights.slice(0, maxInsights);

    // 9. Synthesize answer
    const synthesis = await this.synthesizeAnswer(oracleQuery.question, finalInsights, framework);

    // 10. Calculate overall tension
    const epistemicTension = finalInsights.length > 0
      ? Math.round(
          (finalInsights.reduce((s, i) => s + i.tensionScore, 0) / finalInsights.length) * 1000,
        ) / 1000
      : 0;

    // 11. Persist all insights
    for (const insight of finalInsights) {
      this.insights.push(insight);
      await this.persistInsight(insight);
    }

    if (this.insights.length > this.maxInMemory) {
      this.insights = this.insights.slice(-this.maxInMemory);
    }

    const elapsedMs = Date.now() - startMs;

    broadcast('meow:sovereign', {
      type: 'nous_oracle_query',
      question: oracleQuery.question.slice(0, 100),
      insightCount: finalInsights.length,
      framework: framework ?? 'none',
      epistemicTension,
      elapsedMs,
    });

    log.info(
      { insightCount: finalInsights.length, framework, epistemicTension, elapsedMs },
      'NOUS Oracle query complete',
    );

    return {
      insights: finalInsights,
      synthesizedAnswer: synthesis.answer,
      frameworkApplied: framework,
      epistemicTension,
      recommendation: synthesis.recommendation,
      caveats: synthesis.caveats,
    };
  }

  // --- Validate an insight ---------------------------------------------------

  async validateInsight(insightId: string, isValid: boolean, notes?: string): Promise<boolean> {
    const insight = this.insights.find(i => i.id === insightId);
    if (!insight || insight.status !== 'generated') return false;

    insight.status = 'validated';
    insight.validatedAt = new Date();
    if (notes) {
      insight.metadata = { ...insight.metadata, validationNotes: notes, isValid };
    }

    await this.updateInsightStatus(insight);
    log.info({ insightId, isValid }, 'Insight validated');
    return true;
  }

  // --- Mark insight as applied -----------------------------------------------

  async markApplied(insightId: string): Promise<boolean> {
    const insight = this.insights.find(i => i.id === insightId);
    if (!insight) return false;

    insight.status = 'applied';
    insight.appliedAt = new Date();
    await this.updateInsightStatus(insight);

    log.info({ insightId }, 'Insight marked as applied');
    return true;
  }

  // --- Record impact measurement ---------------------------------------------

  async recordImpact(insightId: string, impactRating: number): Promise<boolean> {
    const insight = this.insights.find(i => i.id === insightId);
    if (!insight) return false;

    insight.status = 'impact_measured';
    insight.measuredAt = new Date();
    insight.impactRating = Math.max(-1, Math.min(1, impactRating));
    await this.updateInsightStatus(insight);

    log.info({ insightId, impactRating: insight.impactRating }, 'Insight impact recorded');
    return true;
  }

  // --- Getters ---------------------------------------------------------------

  getInsight(id: string): EpistemicInsight | null {
    return this.insights.find(i => i.id === id) ?? null;
  }

  getInsightsByType(type: InsightType): EpistemicInsight[] {
    return this.insights.filter(i => i.type === type);
  }

  getRecentInsights(limit = 20): EpistemicInsight[] {
    return this.insights.slice(-limit).reverse();
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): NousOracleStats {
    const total = this.insights.length;
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byFramework: Record<string, number> = {};
    let totalTension = 0;
    let totalConfidence = 0;
    let validatedCount = 0;
    let impactMeasuredCount = 0;
    let totalImpact = 0;

    for (const insight of this.insights) {
      byType[insight.type] = (byType[insight.type] ?? 0) + 1;
      byStatus[insight.status] = (byStatus[insight.status] ?? 0) + 1;
      if (insight.framework) {
        byFramework[insight.framework] = (byFramework[insight.framework] ?? 0) + 1;
      }
      totalTension += insight.tensionScore;
      totalConfidence += insight.confidenceScore;
      if (insight.status === 'validated' || insight.status === 'applied' || insight.status === 'impact_measured') {
        validatedCount++;
      }
      if (insight.status === 'impact_measured' && insight.impactRating !== null) {
        impactMeasuredCount++;
        totalImpact += insight.impactRating;
      }
    }

    return {
      totalInsights: total,
      byType,
      byStatus,
      byFramework,
      avgTension: total > 0 ? Math.round((totalTension / total) * 1000) / 1000 : 0,
      avgConfidence: total > 0 ? Math.round((totalConfidence / total) * 1000) / 1000 : 0,
      validationRate: total > 0 ? Math.round((validatedCount / total) * 1000) / 1000 : 0,
      impactMeasuredCount,
      avgImpactRating: impactMeasuredCount > 0
        ? Math.round((totalImpact / impactMeasuredCount) * 1000) / 1000
        : 0,
    };
  }

  // --- Update config ---------------------------------------------------------

  updateConfig(updates: Partial<NousOracleConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'NOUS Oracle config updated');
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, status, title, content, context,
                framework, source_fragment_ids, historical_matches,
                cross_domain_links, tension_score, confidence_score,
                impact_rating, created_at, validated_at, applied_at,
                measured_at, metadata
         FROM meow_epistemic_insights
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, this.maxInMemory],
      );

      this.insights = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as InsightType,
        status: r.status as InsightStatus,
        title: (r.title as string) ?? '',
        content: (r.content as string) ?? '',
        context: (r.context as string) ?? '',
        framework: (r.framework as PhilosophicalFramework) ?? undefined,
        sourceFragmentIds: this.parseJsonSafe(r.source_fragment_ids, []),
        historicalMatches: this.parseJsonSafe(r.historical_matches, []),
        crossDomainLinks: this.parseJsonSafe(r.cross_domain_links, []),
        tensionScore: parseFloat(String(r.tension_score ?? '0')),
        confidenceScore: parseFloat(String(r.confidence_score ?? '0')),
        impactRating: r.impact_rating != null ? parseFloat(String(r.impact_rating)) : null,
        createdAt: new Date(r.created_at as string),
        validatedAt: r.validated_at ? new Date(r.validated_at as string) : null,
        appliedAt: r.applied_at ? new Date(r.applied_at as string) : null,
        measuredAt: r.measured_at ? new Date(r.measured_at as string) : null,
        metadata: this.parseJsonSafe(r.metadata, {}),
      }));

      log.info({ count: this.insights.length }, 'Loaded epistemic insights from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load epistemic insights from DB');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Fragment Retrieval
  // ---------------------------------------------------------------------------

  private async fetchRelevantFragments(
    question: string,
  ): Promise<Array<{ id: string; content: string; stance: string; tension: number; category: string }>> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const keywords = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
        .slice(0, 10);

      const searchClause = keywords.length > 0
        ? `AND (${keywords.map((_, i) => `content ILIKE '%' || $${i + 2} || '%'`).join(' OR ')})`
        : '';

      const { rows } = await pool.query(
        `SELECT id, content, epistemic_stance, epistemic_tension, category
         FROM megabrain_fragments
         WHERE epistemic_tension >= $1
           ${searchClause}
         ORDER BY epistemic_tension DESC, created_at DESC
         LIMIT $${keywords.length + 2}`,
        [this.config.minTensionThreshold, ...keywords, this.config.maxFragmentsPerSearch],
      );

      return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        content: (r.content as string) ?? '',
        stance: (r.epistemic_stance as string) ?? 'hypothesis',
        tension: parseFloat(String(r.epistemic_tension ?? '0')),
        category: (r.category as string) ?? '',
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to fetch epistemic fragments');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Historical Pattern Matching
  // ---------------------------------------------------------------------------

  private async findHistoricalMatches(question: string): Promise<HistoricalMatch[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const keywords = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 3)
        .slice(0, 6);

      if (keywords.length === 0) return [];

      const searchClause = keywords
        .map((_, i) => `content ILIKE '%' || $${i + 2} || '%'`)
        .join(' OR ');

      const { rows } = await pool.query(
        `SELECT id, content, category, source, created_at,
                (metadata::jsonb->>'outcome') as outcome
         FROM megabrain_fragments
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
           AND (${searchClause})
           AND category IN ('pattern', 'outcome', 'lesson', 'retrospective')
         ORDER BY created_at DESC
         LIMIT 10`,
        [this.config.historicalLookbackDays, ...keywords],
      );

      return (rows as Array<Record<string, unknown>>).map(r => ({
        fragmentId: r.id as string,
        summary: (r.content as string).slice(0, 300),
        outcome: (r.outcome as string) ?? 'outcome not recorded',
        similarity: 0.6, // heuristic — true similarity requires embeddings
        dateRange: new Date(r.created_at as string).toISOString().split('T')[0],
        domain: (r.category as string) ?? 'unknown',
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to find historical matches');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Cross-Domain Links
  // ---------------------------------------------------------------------------

  private async findCrossDomainLinks(question: string): Promise<CrossDomainLink[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT category, COUNT(*) as cnt
         FROM megabrain_fragments
         WHERE epistemic_tension > 0.3
           AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY category
         HAVING COUNT(*) >= 2
         ORDER BY cnt DESC
         LIMIT 10`,
      );

      const categories = (rows as Array<Record<string, unknown>>).map(r => r.category as string);
      if (categories.length < 2) return [];

      // Build cross-domain links between categories with high tension
      const links: CrossDomainLink[] = [];
      for (let i = 0; i < categories.length - 1; i++) {
        for (let j = i + 1; j < categories.length && links.length < 5; j++) {
          links.push({
            sourceDomain: categories[i],
            targetDomain: categories[j],
            pattern: `High epistemic tension in both ${categories[i]} and ${categories[j]}`,
            relevance: 0.5,
          });
        }
      }

      return links;
    } catch (err) {
      log.warn({ err }, 'Failed to find cross-domain links');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Insight Generation
  // ---------------------------------------------------------------------------

  private async generatePatternInsights(
    question: string,
    fragments: Array<{ id: string; content: string; stance: string; tension: number; category: string }>,
    crossDomainLinks: CrossDomainLink[],
  ): Promise<EpistemicInsight[]> {
    if (fragments.length === 0) return [];

    const prompt = `Analyze these epistemic fragments and identify recurring patterns relevant to the question.

Question: ${question}

Fragments:
${fragments.slice(0, 10).map((f, i) => `${i + 1}. [${f.stance}, tension=${f.tension.toFixed(2)}, cat=${f.category}] ${f.content.slice(0, 200)}`).join('\n')}

Cross-domain links:
${crossDomainLinks.map(l => `${l.sourceDomain} <-> ${l.targetDomain}: ${l.pattern}`).join('\n') || 'None detected'}

Respond with JSON array of 0-2 pattern insights:
[{
  "title": "short pattern title",
  "content": "detailed pattern description (2-3 sentences)",
  "tensionScore": 0.0-1.0,
  "confidenceScore": 0.0-1.0
}]`;

    const raw = await callGemini(
      'You are NOUS, the epistemic oracle. Identify deep patterns across knowledge fragments. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) return this.generateHeuristicPatternInsights(fragments);

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return this.generateHeuristicPatternInsights(fragments);

      const parsed = JSON.parse(match[0]) as Array<{
        title: string;
        content: string;
        tensionScore: number;
        confidenceScore: number;
      }>;

      return parsed.slice(0, 2).map(p => ({
        id: uuidv4(),
        type: 'pattern_recognition' as InsightType,
        status: 'generated' as InsightStatus,
        title: (p.title ?? 'Pattern detected').slice(0, 200),
        content: (p.content ?? '').slice(0, 2000),
        context: question,
        sourceFragmentIds: fragments.slice(0, 5).map(f => f.id),
        historicalMatches: [],
        crossDomainLinks,
        tensionScore: Math.max(0, Math.min(1, p.tensionScore ?? 0.5)),
        confidenceScore: Math.max(0, Math.min(1, p.confidenceScore ?? 0.5)),
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      }));
    } catch {
      return this.generateHeuristicPatternInsights(fragments);
    }
  }

  private generateHeuristicPatternInsights(
    fragments: Array<{ id: string; content: string; stance: string; tension: number; category: string }>,
  ): EpistemicInsight[] {
    if (fragments.length < 2) return [];

    // Detect if multiple stances exist (indicates intellectual debate)
    const stances = new Set(fragments.map(f => f.stance));
    const avgTension = fragments.reduce((s, f) => s + f.tension, 0) / fragments.length;

    return [{
      id: uuidv4(),
      type: 'pattern_recognition',
      status: 'generated',
      title: stances.size > 2
        ? 'Multi-stance epistemic debate detected'
        : 'Knowledge fragments show tension',
      content: `${fragments.length} fragments found with ${stances.size} distinct epistemic stances (${[...stances].join(', ')}). Average tension: ${avgTension.toFixed(2)}. This indicates ${stances.size > 2 ? 'active intellectual debate — synthesis may be emerging' : 'a contested topic requiring further analysis'}.`,
      context: 'Heuristic pattern analysis',
      sourceFragmentIds: fragments.slice(0, 5).map(f => f.id),
      historicalMatches: [],
      crossDomainLinks: [],
      tensionScore: avgTension,
      confidenceScore: 0.4,
      impactRating: null,
      createdAt: new Date(),
      validatedAt: null,
      appliedAt: null,
      measuredAt: null,
    }];
  }

  private async generateHistoricalInsights(
    question: string,
    matches: HistoricalMatch[],
  ): Promise<EpistemicInsight[]> {
    if (matches.length === 0) return [];

    const prompt = `Based on historical patterns, what lessons apply to this question?

Question: ${question}

Historical matches:
${matches.slice(0, 5).map((m, i) => `${i + 1}. [${m.domain}, ${m.dateRange}] ${m.summary}\n   Outcome: ${m.outcome}`).join('\n')}

Respond with JSON:
{
  "title": "historical analogy title",
  "content": "what we can learn from history (2-3 sentences)",
  "tensionScore": 0.0-1.0,
  "confidenceScore": 0.0-1.0
}`;

    const raw = await callGemini(
      'You are NOUS, the epistemic oracle. Draw meaningful analogies from historical patterns. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) {
      return [{
        id: uuidv4(),
        type: 'historical_analogy',
        status: 'generated',
        title: `${matches.length} historical match(es) found`,
        content: matches.slice(0, 3).map(m => `[${m.domain}] ${m.summary.slice(0, 100)} -> ${m.outcome}`).join('. '),
        context: question,
        sourceFragmentIds: matches.map(m => m.fragmentId),
        historicalMatches: matches,
        crossDomainLinks: [],
        tensionScore: 0.4,
        confidenceScore: 0.4,
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      }];
    }

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]) as {
        title: string;
        content: string;
        tensionScore: number;
        confidenceScore: number;
      };

      return [{
        id: uuidv4(),
        type: 'historical_analogy',
        status: 'generated',
        title: (parsed.title ?? 'Historical pattern').slice(0, 200),
        content: (parsed.content ?? '').slice(0, 2000),
        context: question,
        sourceFragmentIds: matches.map(m => m.fragmentId),
        historicalMatches: matches,
        crossDomainLinks: [],
        tensionScore: Math.max(0, Math.min(1, parsed.tensionScore ?? 0.5)),
        confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.5)),
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      }];
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Framework Application
  // ---------------------------------------------------------------------------

  private async applyFramework(
    question: string,
    framework: PhilosophicalFramework,
    fragments: Array<{ id: string; content: string; stance: string; tension: number }>,
  ): Promise<EpistemicInsight | null> {
    const frameworkPrompt = FRAMEWORK_PROMPTS[framework];
    if (!frameworkPrompt) return null;

    const prompt = `Apply the following philosophical framework to this question.

Framework: ${framework}
Instructions: ${frameworkPrompt}

Question: ${question}

Relevant knowledge fragments:
${fragments.slice(0, 5).map((f, i) => `${i + 1}. [${f.stance}] ${f.content.slice(0, 150)}`).join('\n') || 'None available'}

Respond with JSON:
{
  "title": "framework application title",
  "content": "detailed analysis using the framework (3-5 sentences)",
  "tensionScore": 0.0-1.0,
  "confidenceScore": 0.0-1.0
}`;

    const raw = await callGemini(
      `You are NOUS, the epistemic oracle applying ${framework} thinking. Provide rigorous philosophical analysis. Respond ONLY with valid JSON.`,
      prompt,
    );

    if (!raw) {
      return {
        id: uuidv4(),
        type: 'framework_application',
        status: 'generated',
        title: `${framework} analysis`,
        content: `Applied ${framework} framework. ${frameworkPrompt} Based on ${fragments.length} available fragments.`,
        context: question,
        framework,
        sourceFragmentIds: fragments.slice(0, 5).map(f => f.id),
        historicalMatches: [],
        crossDomainLinks: [],
        tensionScore: 0.5,
        confidenceScore: 0.3,
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      };
    }

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as {
        title: string;
        content: string;
        tensionScore: number;
        confidenceScore: number;
      };

      return {
        id: uuidv4(),
        type: 'framework_application',
        status: 'generated',
        title: (parsed.title ?? `${framework} applied`).slice(0, 200),
        content: (parsed.content ?? '').slice(0, 2000),
        context: question,
        framework,
        sourceFragmentIds: fragments.slice(0, 5).map(f => f.id),
        historicalMatches: [],
        crossDomainLinks: [],
        tensionScore: Math.max(0, Math.min(1, parsed.tensionScore ?? 0.5)),
        confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.6)),
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Contrarian View
  // ---------------------------------------------------------------------------

  private async generateContrarianView(
    question: string,
    fragments: Array<{ id: string; content: string; stance: string; tension: number }>,
  ): Promise<EpistemicInsight | null> {
    const prompt = `Play devil's advocate for this question. Challenge the obvious answer.

Question: ${question}

Available fragments (showing current thinking):
${fragments.slice(0, 5).map((f, i) => `${i + 1}. [${f.stance}] ${f.content.slice(0, 150)}`).join('\n') || 'No fragments — challenge the question itself'}

Respond with JSON:
{
  "title": "contrarian view title",
  "content": "detailed contrarian argument (2-3 sentences)",
  "tensionScore": 0.0-1.0,
  "confidenceScore": 0.0-1.0
}`;

    const raw = await callGemini(
      'You are NOUS in contrarian mode. Challenge assumptions, find blind spots, present the strongest case AGAINST the prevailing view. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) {
      return {
        id: uuidv4(),
        type: 'contrarian_view',
        status: 'generated',
        title: 'Contrarian view (heuristic)',
        content: `Before deciding on "${question.slice(0, 80)}", consider: What if the opposite were true? What assumptions are untested? What would the most informed skeptic say?`,
        context: question,
        sourceFragmentIds: [],
        historicalMatches: [],
        crossDomainLinks: [],
        tensionScore: 0.7,
        confidenceScore: 0.3,
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      };
    }

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as {
        title: string;
        content: string;
        tensionScore: number;
        confidenceScore: number;
      };

      return {
        id: uuidv4(),
        type: 'contrarian_view',
        status: 'generated',
        title: (parsed.title ?? 'Contrarian perspective').slice(0, 200),
        content: (parsed.content ?? '').slice(0, 2000),
        context: question,
        sourceFragmentIds: fragments.slice(0, 3).map(f => f.id),
        historicalMatches: [],
        crossDomainLinks: [],
        tensionScore: Math.max(0.5, Math.min(1, parsed.tensionScore ?? 0.7)),
        confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.5)),
        impactRating: null,
        createdAt: new Date(),
        validatedAt: null,
        appliedAt: null,
        measuredAt: null,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Synthesis
  // ---------------------------------------------------------------------------

  private async synthesizeAnswer(
    question: string,
    insights: EpistemicInsight[],
    framework: PhilosophicalFramework | null,
  ): Promise<{ answer: string; recommendation: string; caveats: string[] }> {
    if (insights.length === 0) {
      return {
        answer: 'Insufficient epistemic data to synthesize an answer. Gather more information before deciding.',
        recommendation: 'Defer decision until more data is available.',
        caveats: ['No relevant knowledge fragments found', 'Decision made without historical context'],
      };
    }

    const prompt = `Synthesize these insights into a coherent answer.

Question: ${question}
Framework applied: ${framework ?? 'none'}

Insights:
${insights.map((ins, i) => `${i + 1}. [${ins.type}] ${ins.title}: ${ins.content.slice(0, 300)}`).join('\n')}

Respond with JSON:
{
  "answer": "synthesized answer (2-4 sentences)",
  "recommendation": "actionable recommendation (1-2 sentences)",
  "caveats": ["caveat1", "caveat2"]
}`;

    const raw = await callGemini(
      'You are NOUS, synthesizing multiple epistemic perspectives into wisdom. Be balanced, nuanced, and actionable. Respond ONLY with valid JSON.',
      prompt,
    );

    if (!raw) {
      // Heuristic synthesis
      const types = [...new Set(insights.map(i => i.type))];
      const avgTension = insights.reduce((s, i) => s + i.tensionScore, 0) / insights.length;

      return {
        answer: `Based on ${insights.length} insights (${types.join(', ')}), epistemic tension is ${avgTension.toFixed(2)}. ${insights[0].content.slice(0, 200)}`,
        recommendation: avgTension > 0.6
          ? 'High tension detected. Seek additional perspectives before acting.'
          : 'Moderate tension. Proceed with awareness of the identified caveats.',
        caveats: [
          'AI synthesis unavailable — using heuristic aggregation',
          insights.some(i => i.type === 'contrarian_view') ? 'Contrarian view should be considered seriously' : 'No contrarian view generated',
        ],
      };
    }

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('no match');

      const parsed = JSON.parse(match[0]) as {
        answer: string;
        recommendation: string;
        caveats: string[];
      };

      return {
        answer: (parsed.answer ?? '').slice(0, 2000),
        recommendation: (parsed.recommendation ?? '').slice(0, 500),
        caveats: Array.isArray(parsed.caveats) ? parsed.caveats.slice(0, 5) : [],
      };
    } catch {
      return {
        answer: insights.map(i => i.content.slice(0, 100)).join('. '),
        recommendation: 'Review individual insights for detailed guidance.',
        caveats: ['Synthesis parsing failed — raw insights available above'],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistInsight(insight: EpistemicInsight): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_epistemic_insights
          (id, type, status, title, content, context,
           framework, source_fragment_ids, historical_matches,
           cross_domain_links, tension_score, confidence_score,
           impact_rating, created_at, validated_at, applied_at,
           measured_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          insight.id,
          insight.type,
          insight.status,
          insight.title.slice(0, 500),
          insight.content.slice(0, 5000),
          insight.context.slice(0, 1000),
          insight.framework ?? null,
          JSON.stringify(insight.sourceFragmentIds),
          JSON.stringify(insight.historicalMatches),
          JSON.stringify(insight.crossDomainLinks),
          insight.tensionScore,
          insight.confidenceScore,
          insight.impactRating,
          insight.createdAt.toISOString(),
          insight.validatedAt?.toISOString() ?? null,
          insight.appliedAt?.toISOString() ?? null,
          insight.measuredAt?.toISOString() ?? null,
          insight.metadata ? JSON.stringify(insight.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, insightId: insight.id }, 'Failed to persist epistemic insight');
    }
  }

  private async updateInsightStatus(insight: EpistemicInsight): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_epistemic_insights
         SET status = $1, impact_rating = $2, validated_at = $3,
             applied_at = $4, measured_at = $5, metadata = $6
         WHERE id = $7`,
        [
          insight.status,
          insight.impactRating,
          insight.validatedAt?.toISOString() ?? null,
          insight.appliedAt?.toISOString() ?? null,
          insight.measuredAt?.toISOString() ?? null,
          insight.metadata ? JSON.stringify(insight.metadata) : null,
          insight.id,
        ],
      );
    } catch (err) {
      log.error({ err, insightId: insight.id }, 'Failed to update insight status');
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

let instance: NousEpistemicOracle | null = null;

export function getNousEpistemicOracle(
  config?: Partial<NousOracleConfig>,
): NousEpistemicOracle {
  if (!instance) {
    instance = new NousEpistemicOracle(config);
    log.info('NousEpistemicOracle singleton created');
  }
  return instance;
}
