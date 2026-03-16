/**
 * OUTPUT QUALITY SCORER -- CG-029 (Stage 05 Wave 8)
 *
 * AI-powered quality scoring for all molecule/bead outputs.
 * Score dimensions:
 *   - accuracy:      factual correctness
 *   - completeness:  all requirements met
 *   - clarity:       well-structured, readable
 *   - relevance:     on-topic, addresses the brief
 *   - actionability: can be used directly without rework
 *
 * Each dimension 0-10, composite = weighted average.
 * Gemini-powered with heuristic fallback.
 * Tracks quality trends per worker, skill, formula over time.
 * Auto-flags outputs below threshold (default 6.0) for human review.
 * DB table: meow_quality_scores.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity } from '../types';

const log = createLogger('output-quality-scorer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityDimensions {
  accuracy: number;       // 0-10
  completeness: number;   // 0-10
  clarity: number;        // 0-10
  relevance: number;      // 0-10
  actionability: number;  // 0-10
}

export interface QualityScore {
  id: string;
  beadId: string;
  moleculeId?: string;
  formulaName?: string;
  skillName?: string;
  workerId?: string;
  dimensions: QualityDimensions;
  composite: number;            // weighted 0-10
  flaggedForReview: boolean;
  reviewReason?: string;
  aiPowered: boolean;           // true if scored by Gemini, false if heuristic
  outputSnippet: string;        // first 500 chars of the output
  requirements: string;         // original requirements text
  feedback?: string;            // AI-generated feedback
  metadata?: Record<string, unknown>;
  scoredAt: Date;
}

export interface QualityTrend {
  entityId: string;             // worker/skill/formula identifier
  entityType: 'worker' | 'skill' | 'formula';
  avgComposite: number;
  avgByDimension: QualityDimensions;
  scoreCount: number;
  trend: 'improving' | 'stable' | 'declining';
  recentScores: number[];       // last 10 composites
}

export interface QualityDashboard {
  totalScored: number;
  avgComposite: number;
  flaggedCount: number;
  bestWorkers: Array<{ id: string; avgScore: number; count: number }>;
  worstWorkers: Array<{ id: string; avgScore: number; count: number }>;
  bestSkills: Array<{ name: string; avgScore: number; count: number }>;
  worstSkills: Array<{ name: string; avgScore: number; count: number }>;
  dimensionAverages: QualityDimensions;
  trendDirection: 'improving' | 'stable' | 'declining';
}

// Weights for composite score
const DIMENSION_WEIGHTS: Record<keyof QualityDimensions, number> = {
  accuracy: 0.25,
  completeness: 0.25,
  clarity: 0.15,
  relevance: 0.20,
  actionability: 0.15,
};

const DEFAULT_FLAG_THRESHOLD = 6.0;

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
              content: 'You are a strict quality assessment engine for an AI orchestration system. Score outputs on accuracy, completeness, clarity, relevance, and actionability. Always respond with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in output-quality-scorer');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic quality scoring (fallback)
// ---------------------------------------------------------------------------

function scoreHeuristic(output: string, requirements: string): {
  dimensions: QualityDimensions;
  feedback: string;
} {
  const outLen = output.length;
  const reqLen = requirements.length;
  const outLower = output.toLowerCase();
  const reqLower = requirements.toLowerCase();

  // Accuracy heuristic: presence of numbers, data references, structured info
  const hasNumbers = /\d+/.test(output);
  const hasStructure = /[{[\n]/.test(output);
  const accuracyBase = hasNumbers ? 6.5 : 5.0;
  const accuracy = Math.min(10, accuracyBase + (hasStructure ? 1.0 : 0));

  // Completeness: ratio of requirement keywords found in output
  const reqWords = reqLower.split(/\s+/).filter(w => w.length > 4);
  const matchedWords = reqWords.filter(w => outLower.includes(w));
  const completenessRatio = reqWords.length > 0 ? matchedWords.length / reqWords.length : 0.5;
  const completeness = Math.min(10, Math.max(2, completenessRatio * 10));

  // Clarity: sentence structure, paragraph breaks, not too dense
  const sentences = output.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const avgSentenceLen = sentences.length > 0
    ? sentences.reduce((s, sent) => s + sent.length, 0) / sentences.length
    : outLen;
  const hasParagraphs = output.includes('\n\n') || output.includes('\n- ');
  const clarityBase = avgSentenceLen > 200 ? 4.0 : avgSentenceLen < 20 ? 5.0 : 7.0;
  const clarity = Math.min(10, clarityBase + (hasParagraphs ? 1.5 : 0));

  // Relevance: keyword overlap between output and requirements
  const relevanceRatio = completenessRatio; // reuse keyword overlap
  const relevance = Math.min(10, Math.max(3, relevanceRatio * 9 + 1));

  // Actionability: presence of action verbs, lists, concrete items
  const actionWords = ['create', 'implement', 'add', 'update', 'deploy', 'run', 'configure', 'set', 'use', 'build'];
  const actionCount = actionWords.filter(w => outLower.includes(w)).length;
  const hasList = /^[\s]*[-*\d]/.test(output);
  const actionabilityBase = Math.min(8, 4 + actionCount * 0.5);
  const actionability = Math.min(10, actionabilityBase + (hasList ? 1.5 : 0));

  // Length penalty: very short outputs are suspicious
  const lengthPenalty = outLen < 50 ? -2.0 : outLen < 150 ? -1.0 : 0;

  const dims: QualityDimensions = {
    accuracy: Math.max(1, Math.round((accuracy + lengthPenalty) * 10) / 10),
    completeness: Math.max(1, Math.round((completeness + lengthPenalty) * 10) / 10),
    clarity: Math.max(1, Math.round((clarity + lengthPenalty) * 10) / 10),
    relevance: Math.max(1, Math.round((relevance + lengthPenalty) * 10) / 10),
    actionability: Math.max(1, Math.round((actionability + lengthPenalty) * 10) / 10),
  };

  const issues: string[] = [];
  if (outLen < 50) issues.push('Output is very short');
  if (completenessRatio < 0.3) issues.push('Many requirement keywords missing');
  if (avgSentenceLen > 200) issues.push('Sentences are too long, reduce complexity');
  if (actionCount === 0) issues.push('No actionable items detected');

  const feedback = issues.length > 0
    ? `Heuristic assessment issues: ${issues.join('; ')}`
    : 'Heuristic assessment: output appears adequate based on length, structure, and keyword coverage';

  return { dimensions: dims, feedback };
}

// ---------------------------------------------------------------------------
// OutputQualityScorer
// ---------------------------------------------------------------------------

export class OutputQualityScorer {
  private scores: QualityScore[] = [];
  private maxInMemory = 5_000;
  private flagThreshold = DEFAULT_FLAG_THRESHOLD;

  // --- Score an output (main entry point) -----------------------------------

  async scoreOutput(params: {
    beadId: string;
    output: string;
    requirements: string;
    moleculeId?: string;
    formulaName?: string;
    skillName?: string;
    workerId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<QualityScore> {
    const { beadId, output, requirements, moleculeId, formulaName, skillName, workerId, metadata } = params;

    // Try AI scoring first
    const aiResult = await this.scoreWithGemini(output, requirements);

    let dimensions: QualityDimensions;
    let feedback: string;
    let aiPowered: boolean;

    if (aiResult) {
      dimensions = aiResult.dimensions;
      feedback = aiResult.feedback;
      aiPowered = true;
    } else {
      const heuristic = scoreHeuristic(output, requirements);
      dimensions = heuristic.dimensions;
      feedback = heuristic.feedback;
      aiPowered = false;
    }

    const composite = this.computeComposite(dimensions);
    const flagged = composite < this.flagThreshold;
    const reviewReason = flagged
      ? this.buildReviewReason(dimensions, composite)
      : undefined;

    const score: QualityScore = {
      id: uuidv4(),
      beadId,
      moleculeId,
      formulaName,
      skillName,
      workerId,
      dimensions,
      composite,
      flaggedForReview: flagged,
      reviewReason,
      aiPowered,
      outputSnippet: output.slice(0, 500),
      requirements: requirements.slice(0, 500),
      feedback,
      metadata,
      scoredAt: new Date(),
    };

    // Store
    this.scores.push(score);
    if (this.scores.length > this.maxInMemory) {
      this.scores = this.scores.slice(-this.maxInMemory);
    }

    await this.persistScore(score);

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'quality_scored',
      scoreId: score.id,
      beadId,
      composite,
      flaggedForReview: flagged,
      aiPowered,
      workerId,
      skillName,
    });

    if (flagged) {
      broadcast('meow:cognitive', {
        type: 'quality_flagged',
        scoreId: score.id,
        beadId,
        composite,
        reviewReason,
        workerId,
      });
      log.warn({ beadId, composite, reviewReason }, 'Output flagged for review');
    }

    log.info({ beadId, composite, aiPowered, flagged }, 'Output quality scored');
    return score;
  }

  // --- Get quality trend for an entity --------------------------------------

  getQualityTrend(entityId: string, entityType: 'worker' | 'skill' | 'formula'): QualityTrend | null {
    const relevant = this.scores.filter(s => {
      switch (entityType) {
        case 'worker': return s.workerId === entityId;
        case 'skill': return s.skillName === entityId;
        case 'formula': return s.formulaName === entityId;
        default: return false;
      }
    });

    if (relevant.length === 0) return null;

    const sorted = relevant.sort((a, b) => a.scoredAt.getTime() - b.scoredAt.getTime());
    const composites = sorted.map(s => s.composite);
    const recentScores = composites.slice(-10);

    // Compute dimension averages
    const dimSums: QualityDimensions = { accuracy: 0, completeness: 0, clarity: 0, relevance: 0, actionability: 0 };
    for (const s of sorted) {
      dimSums.accuracy += s.dimensions.accuracy;
      dimSums.completeness += s.dimensions.completeness;
      dimSums.clarity += s.dimensions.clarity;
      dimSums.relevance += s.dimensions.relevance;
      dimSums.actionability += s.dimensions.actionability;
    }
    const count = sorted.length;

    // Determine trend: compare first half vs second half averages
    const mid = Math.floor(count / 2);
    const firstHalf = composites.slice(0, mid);
    const secondHalf = composites.slice(mid);
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;

    let trend: 'improving' | 'stable' | 'declining';
    const diff = secondAvg - firstAvg;
    if (diff > 0.5) trend = 'improving';
    else if (diff < -0.5) trend = 'declining';
    else trend = 'stable';

    return {
      entityId,
      entityType,
      avgComposite: Math.round((composites.reduce((a, b) => a + b, 0) / count) * 100) / 100,
      avgByDimension: {
        accuracy: Math.round((dimSums.accuracy / count) * 100) / 100,
        completeness: Math.round((dimSums.completeness / count) * 100) / 100,
        clarity: Math.round((dimSums.clarity / count) * 100) / 100,
        relevance: Math.round((dimSums.relevance / count) * 100) / 100,
        actionability: Math.round((dimSums.actionability / count) * 100) / 100,
      },
      scoreCount: count,
      trend,
      recentScores,
    };
  }

  // --- Get dashboard data ---------------------------------------------------

  getDashboard(): QualityDashboard {
    const total = this.scores.length;
    if (total === 0) {
      return {
        totalScored: 0,
        avgComposite: 0,
        flaggedCount: 0,
        bestWorkers: [],
        worstWorkers: [],
        bestSkills: [],
        worstSkills: [],
        dimensionAverages: { accuracy: 0, completeness: 0, clarity: 0, relevance: 0, actionability: 0 },
        trendDirection: 'stable',
      };
    }

    const sumComposite = this.scores.reduce((s, sc) => s + sc.composite, 0);
    const flaggedCount = this.scores.filter(s => s.flaggedForReview).length;

    // Aggregate by worker
    const workerMap = new Map<string, { total: number; count: number }>();
    const skillMap = new Map<string, { total: number; count: number }>();
    const dimSums: QualityDimensions = { accuracy: 0, completeness: 0, clarity: 0, relevance: 0, actionability: 0 };

    for (const s of this.scores) {
      if (s.workerId) {
        const entry = workerMap.get(s.workerId) ?? { total: 0, count: 0 };
        entry.total += s.composite;
        entry.count++;
        workerMap.set(s.workerId, entry);
      }
      if (s.skillName) {
        const entry = skillMap.get(s.skillName) ?? { total: 0, count: 0 };
        entry.total += s.composite;
        entry.count++;
        skillMap.set(s.skillName, entry);
      }
      dimSums.accuracy += s.dimensions.accuracy;
      dimSums.completeness += s.dimensions.completeness;
      dimSums.clarity += s.dimensions.clarity;
      dimSums.relevance += s.dimensions.relevance;
      dimSums.actionability += s.dimensions.actionability;
    }

    const workerRanked: Array<{ id: string; avgScore: number; count: number }> = [];
    workerMap.forEach((e, id) => {
      workerRanked.push({ id, avgScore: Math.round((e.total / e.count) * 100) / 100, count: e.count });
    });
    const workerFiltered = workerRanked
      .filter(w => w.count >= 2)
      .sort((a, b) => b.avgScore - a.avgScore);

    const skillRanked: Array<{ name: string; avgScore: number; count: number }> = [];
    skillMap.forEach((e, name) => {
      skillRanked.push({ name, avgScore: Math.round((e.total / e.count) * 100) / 100, count: e.count });
    });
    const skillFiltered = skillRanked
      .filter(s => s.count >= 2)
      .sort((a, b) => b.avgScore - a.avgScore);

    // Overall trend
    const recent50 = this.scores.slice(-50);
    const mid = Math.floor(recent50.length / 2);
    const firstHalf = recent50.slice(0, mid);
    const secondHalf = recent50.slice(mid);
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((s, sc) => s + sc.composite, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((s, sc) => s + sc.composite, 0) / secondHalf.length : 0;
    const diff = secondAvg - firstAvg;
    let trendDirection: 'improving' | 'stable' | 'declining';
    if (diff > 0.3) trendDirection = 'improving';
    else if (diff < -0.3) trendDirection = 'declining';
    else trendDirection = 'stable';

    return {
      totalScored: total,
      avgComposite: Math.round((sumComposite / total) * 100) / 100,
      flaggedCount,
      bestWorkers: workerFiltered.slice(0, 5),
      worstWorkers: workerFiltered.slice(-5).reverse(),
      bestSkills: skillFiltered.slice(0, 5),
      worstSkills: skillFiltered.slice(-5).reverse(),
      dimensionAverages: {
        accuracy: Math.round((dimSums.accuracy / total) * 100) / 100,
        completeness: Math.round((dimSums.completeness / total) * 100) / 100,
        clarity: Math.round((dimSums.clarity / total) * 100) / 100,
        relevance: Math.round((dimSums.relevance / total) * 100) / 100,
        actionability: Math.round((dimSums.actionability / total) * 100) / 100,
      },
      trendDirection,
    };
  }

  // --- Get flagged outputs for review ---------------------------------------

  getFlaggedOutputs(limit = 20): QualityScore[] {
    return this.scores
      .filter(s => s.flaggedForReview)
      .sort((a, b) => a.composite - b.composite) // worst first
      .slice(0, limit);
  }

  // --- Get scores for a bead ------------------------------------------------

  getScoresForBead(beadId: string): QualityScore[] {
    return this.scores.filter(s => s.beadId === beadId);
  }

  // --- Load historical scores from DB ---------------------------------------

  async loadFromDb(days = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, bead_id, molecule_id, formula_name, skill_name, worker_id,
                dimensions, composite, flagged_for_review, review_reason,
                ai_powered, output_snippet, requirements, feedback, metadata, scored_at
         FROM meow_quality_scores
         WHERE scored_at > NOW() - INTERVAL '${days} days'
         ORDER BY scored_at DESC
         LIMIT $1`,
        [this.maxInMemory],
      );

      this.scores = rows.map((r: Record<string, unknown>) => this.rowToScore(r));
      log.info({ count: this.scores.length, days }, 'Loaded quality scores from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load quality scores from DB');
    }
  }

  // --- Configuration --------------------------------------------------------

  setFlagThreshold(threshold: number): void {
    this.flagThreshold = Math.max(0, Math.min(10, threshold));
    log.info({ threshold: this.flagThreshold }, 'Flag threshold updated');
  }

  getFlagThreshold(): number {
    return this.flagThreshold;
  }

  getScoreCount(): number {
    return this.scores.length;
  }

  // --- Private helpers ------------------------------------------------------

  private async scoreWithGemini(output: string, requirements: string): Promise<{
    dimensions: QualityDimensions;
    feedback: string;
  } | null> {
    const prompt = `Score this output against the requirements on 5 dimensions (0-10 each).

REQUIREMENTS:
${requirements.slice(0, 1000)}

OUTPUT:
${output.slice(0, 2000)}

Respond with JSON:
{
  "accuracy": <0-10>,
  "completeness": <0-10>,
  "clarity": <0-10>,
  "relevance": <0-10>,
  "actionability": <0-10>,
  "feedback": "1-2 sentence summary of quality assessment and improvement suggestions"
}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as {
        accuracy: number;
        completeness: number;
        clarity: number;
        relevance: number;
        actionability: number;
        feedback: string;
      };

      const clamp = (v: unknown) => {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        return isNaN(n) ? 5 : Math.max(0, Math.min(10, Math.round(n * 10) / 10));
      };

      return {
        dimensions: {
          accuracy: clamp(parsed.accuracy),
          completeness: clamp(parsed.completeness),
          clarity: clamp(parsed.clarity),
          relevance: clamp(parsed.relevance),
          actionability: clamp(parsed.actionability),
        },
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'AI assessment completed',
      };
    } catch {
      log.warn('Failed to parse Gemini quality response');
      return null;
    }
  }

  private computeComposite(dims: QualityDimensions): number {
    const weighted =
      DIMENSION_WEIGHTS.accuracy * dims.accuracy +
      DIMENSION_WEIGHTS.completeness * dims.completeness +
      DIMENSION_WEIGHTS.clarity * dims.clarity +
      DIMENSION_WEIGHTS.relevance * dims.relevance +
      DIMENSION_WEIGHTS.actionability * dims.actionability;

    return Math.round(weighted * 100) / 100;
  }

  private buildReviewReason(dims: QualityDimensions, composite: number): string {
    const issues: string[] = [];
    if (dims.accuracy < 5) issues.push(`low accuracy (${dims.accuracy})`);
    if (dims.completeness < 5) issues.push(`incomplete (${dims.completeness})`);
    if (dims.clarity < 5) issues.push(`unclear (${dims.clarity})`);
    if (dims.relevance < 5) issues.push(`off-topic (${dims.relevance})`);
    if (dims.actionability < 5) issues.push(`not actionable (${dims.actionability})`);

    if (issues.length === 0) {
      return `Composite score ${composite.toFixed(1)} below threshold ${this.flagThreshold}`;
    }
    return `Composite ${composite.toFixed(1)} < ${this.flagThreshold}: ${issues.join(', ')}`;
  }

  private async persistScore(score: QualityScore): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_quality_scores
          (id, bead_id, molecule_id, formula_name, skill_name, worker_id,
           dimensions, composite, flagged_for_review, review_reason,
           ai_powered, output_snippet, requirements, feedback, metadata, scored_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING`,
        [
          score.id,
          score.beadId,
          score.moleculeId ?? null,
          score.formulaName ?? null,
          score.skillName ?? null,
          score.workerId ?? null,
          JSON.stringify(score.dimensions),
          score.composite,
          score.flaggedForReview,
          score.reviewReason ?? null,
          score.aiPowered,
          score.outputSnippet,
          score.requirements,
          score.feedback ?? null,
          score.metadata ? JSON.stringify(score.metadata) : null,
          score.scoredAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, scoreId: score.id }, 'Failed to persist quality score');
    }
  }

  private rowToScore(r: Record<string, unknown>): QualityScore {
    const dims = typeof r.dimensions === 'string' ? JSON.parse(r.dimensions) : r.dimensions;
    return {
      id: r.id as string,
      beadId: r.bead_id as string,
      moleculeId: (r.molecule_id as string) ?? undefined,
      formulaName: (r.formula_name as string) ?? undefined,
      skillName: (r.skill_name as string) ?? undefined,
      workerId: (r.worker_id as string) ?? undefined,
      dimensions: {
        accuracy: dims?.accuracy ?? 5,
        completeness: dims?.completeness ?? 5,
        clarity: dims?.clarity ?? 5,
        relevance: dims?.relevance ?? 5,
        actionability: dims?.actionability ?? 5,
      },
      composite: parseFloat(String(r.composite ?? '5')),
      flaggedForReview: r.flagged_for_review as boolean ?? false,
      reviewReason: (r.review_reason as string) ?? undefined,
      aiPowered: r.ai_powered as boolean ?? false,
      outputSnippet: (r.output_snippet as string) ?? '',
      requirements: (r.requirements as string) ?? '',
      feedback: (r.feedback as string) ?? undefined,
      metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown> : undefined,
      scoredAt: new Date((r.scored_at as string) ?? Date.now()),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: OutputQualityScorer | null = null;

export function getOutputQualityScorer(): OutputQualityScorer {
  if (!instance) {
    instance = new OutputQualityScorer();
    log.info('OutputQualityScorer singleton created');
  }
  return instance;
}
