/**
 * NOUS EPISTEMIC INJECTION -- CG-022 (Stage 05 Wave 6)
 *
 * Inject NOUS epistemic intelligence into cognitive decisions.
 *
 * NOUS is the "third sovereign entity" — an epistemic layer with lineage tracking.
 * It provides intellectual rigor by surfacing:
 *   - Thesis / Antithesis / Synthesis structured debate
 *   - Epistemic tension scores (when decisions lack rigor)
 *   - Dissenting viewpoints when confidence is too high (prevent groupthink)
 *   - Balanced perspectives from multiple epistemic stances
 *
 * Integration points:
 *   - Mayor decisions (convoy composition, resource allocation)
 *   - Formula selection (which formula best fits the context)
 *   - Resource allocation (budget, worker assignment)
 *
 * Queries megabrain_fragments where epistemic columns are populated:
 *   - epistemic_tension > 0
 *   - epistemic_stance IS NOT NULL (hypothesis/thesis/antithesis/synthesis)
 *
 * Configurable epistemic threshold (default: inject when tension > 0.3).
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, FeedEvent } from '../types';

const log = createLogger('nous-epistemic-injection');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EpistemicStance =
  | 'hypothesis'
  | 'thesis'
  | 'antithesis'
  | 'synthesis';

export interface EpistemicFragment {
  id: string;
  content: string;
  stance: EpistemicStance;
  tension: number;              // 0.0 - 1.0
  confidence: number;           // 0.0 - 1.0
  source: string;
  lineageId?: string;           // NOUS lineage chain ID
  category: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface EpistemicDebate {
  topic: string;
  thesis: EpistemicFragment[];
  antithesis: EpistemicFragment[];
  synthesis: EpistemicFragment[];
  hypotheses: EpistemicFragment[];
  avgTension: number;
  rigorScore: number;           // 0.0 - 1.0 (higher = more rigorous)
  recommendation: string;
  dissent?: string;             // Injected when confidence too high
}

export interface EpistemicInjection {
  id: string;
  context: string;              // What decision is being made
  debate: EpistemicDebate;
  composedText: string;
  injectedAt: Date;
  threshold: number;
  beadId?: string;
}

export interface EpistemicConfig {
  tensionThreshold: number;     // Inject when tension > this (default 0.3)
  maxFragmentsPerStance: number;
  dissentThreshold: number;     // Inject dissent when confidence > this (default 0.85)
  maxTokens: number;            // Max tokens for injection text
}

export interface EpistemicStats {
  totalInjections: number;
  avgTension: number;
  avgRigor: number;
  dissentInjectedCount: number;
  stanceDistribution: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: EpistemicConfig = {
  tensionThreshold: 0.3,
  maxFragmentsPerStance: 5,
  dissentThreshold: 0.85,
  maxTokens: 2000,
};

// ---------------------------------------------------------------------------
// Gemini helper
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
              content: 'You are NOUS, the epistemic intelligence engine. You analyze knowledge fragments across thesis/antithesis/synthesis stances and provide rigorous intellectual analysis. Always respond with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1536,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in nous-epistemic-injection');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// NousEpistemicInjector
// ---------------------------------------------------------------------------

export class NousEpistemicInjector {
  private config: EpistemicConfig;
  private injections: EpistemicInjection[] = [];
  private maxInjections = 5_000;

  constructor(config?: Partial<EpistemicConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Inject epistemic intelligence for a decision context -----------------

  async injectForDecision(
    context: string,
    beadId?: string,
  ): Promise<EpistemicInjection | null> {
    log.info({ context: context.slice(0, 100), beadId }, 'Preparing epistemic injection');

    // Fetch epistemic fragments from DB
    const fragments = await this.fetchEpistemicFragments(context);

    if (fragments.length === 0) {
      log.info({ context: context.slice(0, 80) }, 'No epistemic fragments found for context');
      return null;
    }

    // Check if tension meets threshold
    const avgTension = fragments.reduce((s, f) => s + f.tension, 0) / fragments.length;
    if (avgTension < this.config.tensionThreshold) {
      log.info(
        { avgTension, threshold: this.config.tensionThreshold },
        'Epistemic tension below threshold, skipping injection',
      );
      return null;
    }

    // Build structured debate
    const debate = await this.buildDebate(context, fragments);

    // Compose injection text
    const composedText = this.composeInjectionText(debate);

    const injection: EpistemicInjection = {
      id: uuidv4(),
      context,
      debate,
      composedText,
      injectedAt: new Date(),
      threshold: this.config.tensionThreshold,
      beadId,
    };

    this.injections.push(injection);
    if (this.injections.length > this.maxInjections) {
      this.injections = this.injections.slice(-this.maxInjections);
    }

    // Persist
    await this.persistInjection(injection);

    broadcast('meow:cognitive', {
      type: 'nous_epistemic_injected',
      injectionId: injection.id,
      context: context.slice(0, 100),
      avgTension: debate.avgTension,
      rigorScore: debate.rigorScore,
      stanceCount: {
        thesis: debate.thesis.length,
        antithesis: debate.antithesis.length,
        synthesis: debate.synthesis.length,
        hypothesis: debate.hypotheses.length,
      },
      hasDissent: !!debate.dissent,
      beadId,
    });

    return injection;
  }

  // --- Inject dissent when confidence is too high ---------------------------

  async injectDissent(
    context: string,
    currentConfidence: number,
    beadId?: string,
  ): Promise<string | null> {
    if (currentConfidence <= this.config.dissentThreshold) {
      return null;
    }

    log.info(
      { context: context.slice(0, 80), currentConfidence },
      'Confidence too high, injecting dissent',
    );

    // Fetch antithesis fragments
    const antitheses = await this.fetchFragmentsByStance('antithesis', context);

    if (antitheses.length === 0) {
      // Generate heuristic dissent
      return this.generateHeuristicDissent(context, currentConfidence);
    }

    // Use AI to compose dissent
    const aiDissent = await this.composeDissentWithAI(context, currentConfidence, antitheses);
    if (aiDissent) return aiDissent;

    // Fallback: compose from raw antithesis fragments
    const dissentLines = antitheses.slice(0, 3).map((f, i) =>
      `${i + 1}. [DISSENT] ${f.content.slice(0, 200)}`,
    );

    return `=== NOUS DISSENT (confidence ${currentConfidence} > ${this.config.dissentThreshold} threshold) ===\n` +
      `Consider these counterpoints before proceeding:\n${dissentLines.join('\n')}`;
  }

  // --- Check epistemic rigor of a decision ---------------------------------

  async assessRigor(
    context: string,
    proposedDecision: string,
  ): Promise<{ rigorScore: number; gaps: string[]; suggestion: string }> {
    const fragments = await this.fetchEpistemicFragments(context);

    // Check stance coverage
    const stances = new Set(fragments.map(f => f.stance));
    const gaps: string[] = [];

    if (!stances.has('thesis')) gaps.push('No supporting thesis found');
    if (!stances.has('antithesis')) gaps.push('No counterarguments considered');
    if (!stances.has('synthesis')) gaps.push('No synthesis/resolution attempted');

    // Calculate rigor score
    let rigorScore = 0;
    if (stances.has('thesis')) rigorScore += 0.25;
    if (stances.has('antithesis')) rigorScore += 0.30;  // Counterarguments weighted more
    if (stances.has('synthesis')) rigorScore += 0.25;
    if (fragments.length >= 3) rigorScore += 0.10;
    if (fragments.some(f => f.tension > 0.5)) rigorScore += 0.10;

    // AI-enhanced assessment
    const aiAssessment = await this.assessWithAI(context, proposedDecision, fragments, gaps);
    if (aiAssessment) {
      return aiAssessment;
    }

    // Heuristic suggestion
    let suggestion = 'Decision appears sound.';
    if (rigorScore < 0.5) {
      suggestion = `Decision lacks intellectual rigor (score: ${rigorScore.toFixed(2)}). ` +
        `Gaps: ${gaps.join('; ')}. Consider seeking additional perspectives.`;
    } else if (gaps.length > 0) {
      suggestion = `Decision is partially rigorous. Address: ${gaps.join('; ')}.`;
    }

    return { rigorScore, gaps, suggestion };
  }

  // --- Update config --------------------------------------------------------

  updateConfig(updates: Partial<EpistemicConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'Epistemic config updated');
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): EpistemicStats {
    const total = this.injections.length;
    const avgTension = total > 0
      ? Math.round((this.injections.reduce((s, inj) => s + inj.debate.avgTension, 0) / total) * 1000) / 1000
      : 0;
    const avgRigor = total > 0
      ? Math.round((this.injections.reduce((s, inj) => s + inj.debate.rigorScore, 0) / total) * 1000) / 1000
      : 0;

    const dissentInjectedCount = this.injections.filter(inj => !!inj.debate.dissent).length;

    const stanceDistribution: Record<string, number> = {};
    for (const inj of this.injections) {
      for (const f of [...inj.debate.thesis, ...inj.debate.antithesis, ...inj.debate.synthesis, ...inj.debate.hypotheses]) {
        stanceDistribution[f.stance] = (stanceDistribution[f.stance] ?? 0) + 1;
      }
    }

    return {
      totalInjections: total,
      avgTension,
      avgRigor,
      dissentInjectedCount,
      stanceDistribution,
    };
  }

  // --- Private helpers ------------------------------------------------------

  private async fetchEpistemicFragments(context: string): Promise<EpistemicFragment[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const keywords = context
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
        .slice(0, 10);

      const searchClause = keywords.length > 0
        ? `AND (${keywords.map((_, i) => `content ILIKE '%' || $${i + 2} || '%'`).join(' OR ')})`
        : '';

      const { rows } = await pool.query(
        `SELECT id, content, epistemic_stance, epistemic_tension,
                COALESCE((metadata::jsonb->>'confidence')::numeric, 0.5) as confidence,
                source, category, metadata, created_at,
                (metadata::jsonb->>'lineage_id') as lineage_id
         FROM megabrain_fragments
         WHERE epistemic_stance IS NOT NULL
           AND epistemic_tension > $1
           ${searchClause}
         ORDER BY epistemic_tension DESC, created_at DESC
         LIMIT 40`,
        [this.config.tensionThreshold * 0.5, ...keywords],
      );

      return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        content: (r.content as string) ?? '',
        stance: (r.epistemic_stance as EpistemicStance) ?? 'hypothesis',
        tension: parseFloat((r.epistemic_tension as string) ?? '0'),
        confidence: parseFloat((r.confidence as string) ?? '0.5'),
        source: (r.source as string) ?? '',
        lineageId: r.lineage_id as string | undefined,
        category: (r.category as string) ?? '',
        createdAt: new Date((r.created_at as string) ?? Date.now()),
        metadata: typeof r.metadata === 'string'
          ? JSON.parse(r.metadata)
          : (r.metadata as Record<string, unknown>) ?? {},
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to fetch epistemic fragments');
      return [];
    }
  }

  private async fetchFragmentsByStance(
    stance: EpistemicStance,
    context: string,
  ): Promise<EpistemicFragment[]> {
    const pool = getPool();
    if (!pool) return [];

    try {
      const keywords = context
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)
        .slice(0, 5);

      const { rows } = await pool.query(
        `SELECT id, content, epistemic_stance, epistemic_tension,
                COALESCE((metadata::jsonb->>'confidence')::numeric, 0.5) as confidence,
                source, category, metadata, created_at
         FROM megabrain_fragments
         WHERE epistemic_stance = $1
           AND epistemic_tension > 0
         ORDER BY epistemic_tension DESC, created_at DESC
         LIMIT $2`,
        [stance, this.config.maxFragmentsPerStance],
      );

      return (rows as Array<Record<string, unknown>>).map(r => ({
        id: r.id as string,
        content: (r.content as string) ?? '',
        stance: (r.epistemic_stance as EpistemicStance) ?? stance,
        tension: parseFloat((r.epistemic_tension as string) ?? '0'),
        confidence: parseFloat((r.confidence as string) ?? '0.5'),
        source: (r.source as string) ?? '',
        category: (r.category as string) ?? '',
        createdAt: new Date((r.created_at as string) ?? Date.now()),
        metadata: typeof r.metadata === 'string'
          ? JSON.parse(r.metadata)
          : (r.metadata as Record<string, unknown>) ?? {},
      }));
    } catch (err) {
      log.warn({ err, stance }, 'Failed to fetch fragments by stance');
      return [];
    }
  }

  private async buildDebate(
    context: string,
    fragments: EpistemicFragment[],
  ): Promise<EpistemicDebate> {
    // Categorize by stance
    const thesis = fragments.filter(f => f.stance === 'thesis');
    const antithesis = fragments.filter(f => f.stance === 'antithesis');
    const synthesis = fragments.filter(f => f.stance === 'synthesis');
    const hypotheses = fragments.filter(f => f.stance === 'hypothesis');

    const avgTension = fragments.reduce((s, f) => s + f.tension, 0) / (fragments.length || 1);
    const avgTensionRounded = Math.round(avgTension * 1000) / 1000;

    // Calculate rigor: coverage of stances + volume + tension
    let rigorScore = 0;
    if (thesis.length > 0) rigorScore += 0.25;
    if (antithesis.length > 0) rigorScore += 0.30;
    if (synthesis.length > 0) rigorScore += 0.25;
    if (fragments.length >= 5) rigorScore += 0.10;
    if (avgTension > 0.5) rigorScore += 0.10;
    rigorScore = Math.min(1, rigorScore);

    // Build recommendation using AI
    let recommendation = this.buildHeuristicRecommendation(thesis, antithesis, synthesis, hypotheses);
    let dissent: string | undefined;

    // Check for high-confidence groupthink
    const avgConfidence = fragments.reduce((s, f) => s + f.confidence, 0) / (fragments.length || 1);
    if (avgConfidence > this.config.dissentThreshold && antithesis.length === 0) {
      dissent = `WARNING: High average confidence (${avgConfidence.toFixed(2)}) with no counterarguments. ` +
        `This may indicate groupthink. Consider: What could go wrong? What are we not seeing?`;
    }

    // AI enhancement
    const aiDebate = await this.enhanceDebateWithAI(context, thesis, antithesis, synthesis);
    if (aiDebate) {
      recommendation = aiDebate.recommendation ?? recommendation;
      if (aiDebate.dissent) dissent = aiDebate.dissent;
    }

    return {
      topic: context,
      thesis: thesis.slice(0, this.config.maxFragmentsPerStance),
      antithesis: antithesis.slice(0, this.config.maxFragmentsPerStance),
      synthesis: synthesis.slice(0, this.config.maxFragmentsPerStance),
      hypotheses: hypotheses.slice(0, this.config.maxFragmentsPerStance),
      avgTension: avgTensionRounded,
      rigorScore: Math.round(rigorScore * 1000) / 1000,
      recommendation,
      dissent,
    };
  }

  private buildHeuristicRecommendation(
    thesis: EpistemicFragment[],
    antithesis: EpistemicFragment[],
    synthesis: EpistemicFragment[],
    hypotheses: EpistemicFragment[],
  ): string {
    const parts: string[] = [];

    if (synthesis.length > 0) {
      parts.push(`Synthesis available (${synthesis.length} fragments): ${synthesis[0].content.slice(0, 150)}`);
    } else if (thesis.length > 0 && antithesis.length > 0) {
      parts.push(
        `Thesis (${thesis.length}) and antithesis (${antithesis.length}) present but no synthesis yet. ` +
        `Consider resolving the tension between: "${thesis[0].content.slice(0, 80)}" vs "${antithesis[0].content.slice(0, 80)}"`,
      );
    } else if (thesis.length > 0) {
      parts.push(
        `Only thesis present (${thesis.length} fragments). Seek counterarguments before deciding.`,
      );
    } else if (hypotheses.length > 0) {
      parts.push(
        `Only hypotheses (${hypotheses.length} fragments). These are untested. Validate before committing.`,
      );
    } else {
      parts.push('Insufficient epistemic data. Proceed with caution.');
    }

    return parts.join(' ');
  }

  private async enhanceDebateWithAI(
    context: string,
    thesis: EpistemicFragment[],
    antithesis: EpistemicFragment[],
    synthesis: EpistemicFragment[],
  ): Promise<{ recommendation?: string; dissent?: string } | null> {
    if (thesis.length === 0 && antithesis.length === 0) return null;

    const prompt = `Analyze this epistemic debate and provide a recommendation.

Context: ${context}

THESIS fragments:
${thesis.slice(0, 3).map((f, i) => `${i + 1}. (tension: ${f.tension}) ${f.content.slice(0, 200)}`).join('\n')}

ANTITHESIS fragments:
${antithesis.slice(0, 3).map((f, i) => `${i + 1}. (tension: ${f.tension}) ${f.content.slice(0, 200)}`).join('\n')}

SYNTHESIS fragments:
${synthesis.slice(0, 2).map((f, i) => `${i + 1}. ${f.content.slice(0, 200)}`).join('\n')}

Respond with JSON:
{
  "recommendation": "1-2 sentence recommendation considering all sides",
  "dissent": "counterpoint to challenge the majority view, or null if balanced"
}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as { recommendation?: string; dissent?: string };
      return parsed;
    } catch {
      log.warn('Failed to parse Gemini epistemic debate response');
      return null;
    }
  }

  private async assessWithAI(
    context: string,
    proposedDecision: string,
    fragments: EpistemicFragment[],
    gaps: string[],
  ): Promise<{ rigorScore: number; gaps: string[]; suggestion: string } | null> {
    const prompt = `Assess the intellectual rigor of this decision.

Context: ${context}
Proposed decision: ${proposedDecision}
Available epistemic fragments: ${fragments.length}
Stances present: ${[...new Set(fragments.map(f => f.stance))].join(', ')}
Identified gaps: ${gaps.join(', ') || 'none'}

Respond with JSON:
{
  "rigorScore": 0.0-1.0,
  "gaps": ["gap1", "gap2"],
  "suggestion": "brief recommendation"
}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as { rigorScore: number; gaps: string[]; suggestion: string };
      return {
        rigorScore: Math.max(0, Math.min(1, parsed.rigorScore ?? 0.5)),
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps : gaps,
        suggestion: parsed.suggestion ?? 'No AI suggestion available.',
      };
    } catch {
      return null;
    }
  }

  private async composeDissentWithAI(
    context: string,
    confidence: number,
    antitheses: EpistemicFragment[],
  ): Promise<string | null> {
    const prompt = `The current decision confidence is ${confidence} (threshold: ${this.config.dissentThreshold}).
This is dangerously high. Generate a dissenting viewpoint.

Context: ${context}
Existing counterpoints:
${antitheses.slice(0, 3).map((f, i) => `${i + 1}. ${f.content.slice(0, 200)}`).join('\n')}

Write a concise dissent (2-3 sentences) that challenges the majority view.
Respond with plain text only, no JSON.`;

    return await callGemini(prompt);
  }

  private generateHeuristicDissent(context: string, confidence: number): string {
    return `=== NOUS DISSENT (auto-generated) ===\n` +
      `Confidence ${confidence.toFixed(2)} exceeds threshold ${this.config.dissentThreshold}.\n` +
      `No antithesis fragments found for: "${context.slice(0, 100)}"\n` +
      `Before proceeding, consider:\n` +
      `- What assumptions are we making that could be wrong?\n` +
      `- What would a skeptic say about this decision?\n` +
      `- What external factors might we be overlooking?`;
  }

  private composeInjectionText(debate: EpistemicDebate): string {
    const lines: string[] = [];
    lines.push('=== NOUS EPISTEMIC INTELLIGENCE ===');
    lines.push(`Topic: ${debate.topic.slice(0, 100)}`);
    lines.push(`Tension: ${debate.avgTension} | Rigor: ${debate.rigorScore}`);
    lines.push('');

    if (debate.thesis.length > 0) {
      lines.push('--- THESIS ---');
      for (const f of debate.thesis.slice(0, 3)) {
        lines.push(`  [T${f.tension.toFixed(1)}] ${f.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    if (debate.antithesis.length > 0) {
      lines.push('--- ANTITHESIS ---');
      for (const f of debate.antithesis.slice(0, 3)) {
        lines.push(`  [T${f.tension.toFixed(1)}] ${f.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    if (debate.synthesis.length > 0) {
      lines.push('--- SYNTHESIS ---');
      for (const f of debate.synthesis.slice(0, 2)) {
        lines.push(`  ${f.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    lines.push(`RECOMMENDATION: ${debate.recommendation}`);

    if (debate.dissent) {
      lines.push('');
      lines.push(`DISSENT: ${debate.dissent}`);
    }

    // Trim to max tokens
    let text = lines.join('\n');
    const maxChars = this.config.maxTokens * 4;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 3) + '...';
    }

    return text;
  }

  private async persistInjection(injection: EpistemicInjection): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_epistemic_injections
          (id, context, avg_tension, rigor_score, recommendation,
           dissent, composed_text, threshold, bead_id, injected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          injection.id,
          injection.context.slice(0, 1000),
          injection.debate.avgTension,
          injection.debate.rigorScore,
          injection.debate.recommendation.slice(0, 1000),
          injection.debate.dissent ?? null,
          injection.composedText.slice(0, 5000),
          injection.threshold,
          injection.beadId ?? null,
          injection.injectedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, injectionId: injection.id }, 'Failed to persist epistemic injection');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: NousEpistemicInjector | null = null;

export function getNousEpistemicInjector(config?: Partial<EpistemicConfig>): NousEpistemicInjector {
  if (!instance) {
    instance = new NousEpistemicInjector(config);
    log.info('NousEpistemicInjector singleton created');
  }
  return instance;
}
