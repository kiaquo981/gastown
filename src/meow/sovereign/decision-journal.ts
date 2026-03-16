/**
 * DECISION JOURNAL — SG-019 (Stage 06 Wave 5)
 *
 * Every AI decision in Gas Town is logged with full context.
 * Provides accountability, pattern analysis, and feedback loops
 * for continuous improvement of decision-making quality.
 *
 * Features:
 *   - Decision types: bead_assignment, formula_selection, resource_allocation, etc.
 *   - Each entry: context, options_considered, chosen_action, rationale, outcome
 *   - Decision quality tracking: was the outcome positive?
 *   - Pattern analysis: which decision types have highest success rate?
 *   - Overseer review: human can review decisions, flag bad ones, provide feedback
 *   - Feedback loop: flagged decisions inform future AI decision-making
 *   - DB table: meow_decision_journal
 *   - Queryable: by type, outcome, time range, decision quality score
 *   - Integration: all cognitive modules write to journal
 *
 * Gas Town: "Every choice leaves a mark — the journal remembers them all."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('decision-journal');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionType =
  | 'bead_assignment'
  | 'formula_selection'
  | 'resource_allocation'
  | 'tier_change'
  | 'budget_adjustment'
  | 'crisis_response'
  | 'worker_assignment'
  | 'priority_change'
  | 'schedule_modification'
  | 'instance_scaling'
  | 'phase_transition'
  | 'consolidation'
  | 'custom';

export type DecisionOutcome = 'pending' | 'positive' | 'negative' | 'neutral' | 'unknown';

export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged' | 'rejected';

export type DecisionMaker = 'ai' | 'heuristic' | 'operator' | 'hybrid';

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  estimatedImpact: string;
  estimatedCostUsd?: number;
  riskLevel: 'low' | 'medium' | 'high';
  chosen: boolean;
  rejectionReason?: string;
}

export interface DecisionEntry {
  id: string;
  type: DecisionType;
  maker: DecisionMaker;
  context: DecisionContext;
  optionsConsidered: DecisionOption[];
  chosenAction: string;
  chosenOptionId: string;
  rationale: string;
  outcome: DecisionOutcome;
  outcomeDetails?: string;
  qualityScore: number | null;        // 0-100, null until outcome known
  reviewStatus: ReviewStatus;
  reviewerNotes?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  feedbackApplied: boolean;
  instanceId?: string;
  correlationId?: string;
  executionTimeMs: number;
  tags: string[];
  createdAt: Date;
  outcomeRecordedAt?: Date;
}

export interface DecisionContext {
  triggerEvent?: string;
  inputData: Record<string, unknown>;
  systemState?: Record<string, unknown>;
  workerId?: string;
  formulaName?: string;
  beadId?: string;
  moleculeId?: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
}

export interface DecisionQuery {
  types?: DecisionType[];
  outcomes?: DecisionOutcome[];
  reviewStatuses?: ReviewStatus[];
  makers?: DecisionMaker[];
  minQuality?: number;
  maxQuality?: number;
  instanceId?: string;
  fromDate?: Date;
  toDate?: Date;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface DecisionPattern {
  type: DecisionType;
  totalDecisions: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  neutralOutcomes: number;
  pendingOutcomes: number;
  successRate: number;                 // percentage
  avgQualityScore: number;
  avgExecutionTimeMs: number;
  flaggedCount: number;
  topChosenActions: Array<{ action: string; count: number; successRate: number }>;
  recentTrend: 'improving' | 'declining' | 'stable';
}

export interface FeedbackSummary {
  totalFlagged: number;
  totalApproved: number;
  totalRejected: number;
  commonIssues: Array<{ issue: string; count: number }>;
  improvementSuggestions: string[];
  aiUsed: boolean;
}

export interface DecisionJournalStats {
  totalDecisions: number;
  decisionsByType: Record<string, number>;
  decisionsByOutcome: Record<string, number>;
  decisionsByMaker: Record<string, number>;
  avgQualityScore: number;
  overallSuccessRate: number;
  flaggedCount: number;
  feedbackAppliedCount: number;
  todayDecisions: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DECISIONS_IN_MEMORY = 5000;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 500;
const QUALITY_WEIGHTS = {
  outcome: 0.5,
  executionTime: 0.15,
  optionsConsidered: 0.15,
  review: 0.2,
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiDecision(prompt: string): Promise<string | null> {
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
                'You are a decision analysis engine. Analyze decision patterns, outcomes, and feedback '
                + 'to provide insights for improving AI decision-making. Respond ONLY with valid JSON.',
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
    log.warn({ err }, 'Gemini decision analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// DecisionJournal
// ---------------------------------------------------------------------------

export class DecisionJournal {
  private entries: DecisionEntry[] = [];
  private stats: DecisionJournalStats = {
    totalDecisions: 0,
    decisionsByType: {},
    decisionsByOutcome: {},
    decisionsByMaker: {},
    avgQualityScore: 0,
    overallSuccessRate: 0,
    flaggedCount: 0,
    feedbackAppliedCount: 0,
    todayDecisions: 0,
  };
  private todayDate = new Date().toISOString().slice(0, 10);
  private qualityScoreSum = 0;
  private qualityScoreCount = 0;
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadRecentFromDb();
    this.initialized = true;

    log.info({
      cachedEntries: this.entries.length,
    }, 'Decision journal initialized');
  }

  // -------------------------------------------------------------------------
  // Record a decision
  // -------------------------------------------------------------------------

  async recordDecision(
    type: DecisionType,
    maker: DecisionMaker,
    context: DecisionContext,
    optionsConsidered: DecisionOption[],
    chosenOptionId: string,
    rationale: string,
    executionTimeMs: number,
    options: {
      instanceId?: string;
      correlationId?: string;
      tags?: string[];
    } = {},
  ): Promise<DecisionEntry> {
    const chosenOption = optionsConsidered.find(o => o.id === chosenOptionId);
    const now = new Date();

    const entry: DecisionEntry = {
      id: uuidv4(),
      type,
      maker,
      context,
      optionsConsidered: optionsConsidered.map(o => ({
        ...o,
        chosen: o.id === chosenOptionId,
      })),
      chosenAction: chosenOption?.label ?? `option_${chosenOptionId}`,
      chosenOptionId,
      rationale,
      outcome: 'pending',
      qualityScore: null,
      reviewStatus: 'unreviewed',
      feedbackApplied: false,
      instanceId: options.instanceId,
      correlationId: options.correlationId,
      executionTimeMs,
      tags: options.tags ?? [],
      createdAt: now,
    };

    // Add to in-memory store
    this.entries.push(entry);
    if (this.entries.length > MAX_DECISIONS_IN_MEMORY) {
      this.entries = this.entries.slice(-Math.floor(MAX_DECISIONS_IN_MEMORY * 0.8));
    }

    // Update stats
    this.stats.totalDecisions += 1;
    this.stats.decisionsByType[type] = (this.stats.decisionsByType[type] ?? 0) + 1;
    this.stats.decisionsByOutcome['pending'] = (this.stats.decisionsByOutcome['pending'] ?? 0) + 1;
    this.stats.decisionsByMaker[maker] = (this.stats.decisionsByMaker[maker] ?? 0) + 1;

    const today = now.toISOString().slice(0, 10);
    if (today !== this.todayDate) {
      this.todayDate = today;
      this.stats.todayDecisions = 1;
    } else {
      this.stats.todayDecisions += 1;
    }

    await this.persistEntry(entry);

    broadcast('meow:sovereign', {
      type: 'decision:recorded',
      decisionId: entry.id,
      decisionType: type,
      maker,
      chosenAction: entry.chosenAction,
      optionsCount: optionsConsidered.length,
      urgency: context.urgency,
      executionTimeMs,
    });

    log.debug({
      decisionId: entry.id,
      type,
      maker,
      chosen: entry.chosenAction,
      options: optionsConsidered.length,
    }, 'Decision recorded');

    return entry;
  }

  // -------------------------------------------------------------------------
  // Record outcome
  // -------------------------------------------------------------------------

  async recordOutcome(
    decisionId: string,
    outcome: DecisionOutcome,
    details?: string,
  ): Promise<DecisionEntry | null> {
    const entry = this.entries.find(e => e.id === decisionId);
    if (!entry) {
      // Try DB
      return this.recordOutcomeInDb(decisionId, outcome, details);
    }

    // Update pending count
    if (entry.outcome === 'pending') {
      this.stats.decisionsByOutcome['pending'] = Math.max(0,
        (this.stats.decisionsByOutcome['pending'] ?? 1) - 1);
    }

    entry.outcome = outcome;
    entry.outcomeDetails = details;
    entry.outcomeRecordedAt = new Date();
    entry.qualityScore = this.computeQualityScore(entry);

    this.stats.decisionsByOutcome[outcome] = (this.stats.decisionsByOutcome[outcome] ?? 0) + 1;

    // Update average quality
    if (entry.qualityScore !== null) {
      this.qualityScoreSum += entry.qualityScore;
      this.qualityScoreCount += 1;
      this.stats.avgQualityScore = this.qualityScoreSum / this.qualityScoreCount;
    }

    // Update success rate
    const positiveCount = this.stats.decisionsByOutcome['positive'] ?? 0;
    const negativeCount = this.stats.decisionsByOutcome['negative'] ?? 0;
    const totalResolved = positiveCount + negativeCount + (this.stats.decisionsByOutcome['neutral'] ?? 0);
    this.stats.overallSuccessRate = totalResolved > 0
      ? (positiveCount / totalResolved) * 100
      : 0;

    await this.persistOutcome(entry);

    broadcast('meow:sovereign', {
      type: 'decision:outcome',
      decisionId: entry.id,
      decisionType: entry.type,
      outcome,
      qualityScore: entry.qualityScore,
    });

    return entry;
  }

  private async recordOutcomeInDb(
    decisionId: string,
    outcome: DecisionOutcome,
    details?: string,
  ): Promise<DecisionEntry | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      await pool.query(
        `UPDATE meow_decision_journal
         SET outcome = $2, outcome_details = $3, outcome_recorded_at = NOW()
         WHERE id = $1`,
        [decisionId, outcome, details ?? null],
      );
      log.debug({ decisionId, outcome }, 'Outcome recorded in DB');
      return null; // Entry not in memory, but DB updated
    } catch (err) {
      log.error({ err, decisionId }, 'Failed to record outcome in DB');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Overseer review
  // -------------------------------------------------------------------------

  async reviewDecision(
    decisionId: string,
    reviewStatus: ReviewStatus,
    reviewerNotes: string,
    reviewedBy: string,
  ): Promise<DecisionEntry | null> {
    const entry = this.entries.find(e => e.id === decisionId);
    if (!entry) {
      log.warn({ decisionId }, 'Decision not found in memory for review');
      return null;
    }

    entry.reviewStatus = reviewStatus;
    entry.reviewerNotes = reviewerNotes;
    entry.reviewedBy = reviewedBy;
    entry.reviewedAt = new Date();

    if (reviewStatus === 'flagged') {
      this.stats.flaggedCount += 1;
    }

    await this.persistReview(entry);

    broadcast('meow:sovereign', {
      type: 'decision:reviewed',
      decisionId: entry.id,
      decisionType: entry.type,
      reviewStatus,
      reviewedBy,
    });

    log.info({
      decisionId,
      status: reviewStatus,
      reviewer: reviewedBy,
    }, 'Decision reviewed');

    return entry;
  }

  // -------------------------------------------------------------------------
  // Query decisions
  // -------------------------------------------------------------------------

  async queryDecisions(q: DecisionQuery): Promise<{ entries: DecisionEntry[]; total: number }> {
    const limit = Math.min(q.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const offset = q.offset ?? 0;

    // Try DB for broader queries
    const pool = getPool();
    if (pool && (q.fromDate || offset > 0)) {
      return this.queryFromDb(q, limit, offset);
    }

    // In-memory query
    let filtered = [...this.entries];

    if (q.types && q.types.length > 0) {
      filtered = filtered.filter(e => q.types!.includes(e.type));
    }
    if (q.outcomes && q.outcomes.length > 0) {
      filtered = filtered.filter(e => q.outcomes!.includes(e.outcome));
    }
    if (q.reviewStatuses && q.reviewStatuses.length > 0) {
      filtered = filtered.filter(e => q.reviewStatuses!.includes(e.reviewStatus));
    }
    if (q.makers && q.makers.length > 0) {
      filtered = filtered.filter(e => q.makers!.includes(e.maker));
    }
    if (q.minQuality != null) {
      filtered = filtered.filter(e => e.qualityScore !== null && e.qualityScore >= q.minQuality!);
    }
    if (q.maxQuality != null) {
      filtered = filtered.filter(e => e.qualityScore !== null && e.qualityScore <= q.maxQuality!);
    }
    if (q.instanceId) {
      filtered = filtered.filter(e => e.instanceId === q.instanceId);
    }
    if (q.fromDate) {
      filtered = filtered.filter(e => e.createdAt >= q.fromDate!);
    }
    if (q.toDate) {
      filtered = filtered.filter(e => e.createdAt <= q.toDate!);
    }
    if (q.tags && q.tags.length > 0) {
      filtered = filtered.filter(e => q.tags!.some(t => e.tags.includes(t)));
    }

    // Sort by most recent first
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return { entries: page, total };
  }

  private async queryFromDb(
    q: DecisionQuery,
    limit: number,
    offset: number,
  ): Promise<{ entries: DecisionEntry[]; total: number }> {
    const pool = getPool();
    if (!pool) return { entries: [], total: 0 };

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (q.types && q.types.length > 0) {
        conditions.push(`type = ANY($${paramIdx})`);
        params.push(q.types);
        paramIdx++;
      }
      if (q.outcomes && q.outcomes.length > 0) {
        conditions.push(`outcome = ANY($${paramIdx})`);
        params.push(q.outcomes);
        paramIdx++;
      }
      if (q.reviewStatuses && q.reviewStatuses.length > 0) {
        conditions.push(`review_status = ANY($${paramIdx})`);
        params.push(q.reviewStatuses);
        paramIdx++;
      }
      if (q.makers && q.makers.length > 0) {
        conditions.push(`maker = ANY($${paramIdx})`);
        params.push(q.makers);
        paramIdx++;
      }
      if (q.instanceId) {
        conditions.push(`instance_id = $${paramIdx}`);
        params.push(q.instanceId);
        paramIdx++;
      }
      if (q.fromDate) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(q.fromDate.toISOString());
        paramIdx++;
      }
      if (q.toDate) {
        conditions.push(`created_at <= $${paramIdx}`);
        params.push(q.toDate.toISOString());
        paramIdx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM meow_decision_journal ${where}`,
        params,
      );
      const total = Number(countResult.rows[0]?.cnt ?? 0);

      params.push(limit);
      params.push(offset);

      const { rows } = await pool.query(
        `SELECT id, type, maker, context_json, options_json, chosen_action,
                chosen_option_id, rationale, outcome, outcome_details,
                quality_score, review_status, reviewer_notes, reviewed_by,
                reviewed_at, feedback_applied, instance_id, correlation_id,
                execution_time_ms, tags, created_at, outcome_recorded_at
         FROM meow_decision_journal
         ${where}
         ORDER BY created_at DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        params,
      );

      const entries = rows.map((r: Record<string, unknown>) => this.rowToEntry(r));
      return { entries, total };
    } catch (err) {
      log.error({ err }, 'Failed to query decisions from DB');
      return { entries: [], total: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Pattern analysis
  // -------------------------------------------------------------------------

  async analyzePatterns(type?: DecisionType): Promise<DecisionPattern[]> {
    const types = type ? [type] : [...new Set(this.entries.map(e => e.type))];
    const patterns: DecisionPattern[] = [];

    for (const t of types) {
      const typeEntries = this.entries.filter(e => e.type === t);
      if (typeEntries.length === 0) continue;

      const resolved = typeEntries.filter(e => e.outcome !== 'pending');
      const positive = resolved.filter(e => e.outcome === 'positive').length;
      const negative = resolved.filter(e => e.outcome === 'negative').length;
      const neutral = resolved.filter(e => e.outcome === 'neutral').length;
      const pending = typeEntries.filter(e => e.outcome === 'pending').length;

      const qualityEntries = typeEntries.filter(e => e.qualityScore !== null);
      const avgQuality = qualityEntries.length > 0
        ? qualityEntries.reduce((s, e) => s + (e.qualityScore ?? 0), 0) / qualityEntries.length
        : 0;

      const avgExecTime = typeEntries.reduce((s, e) => s + e.executionTimeMs, 0) / typeEntries.length;
      const flagged = typeEntries.filter(e => e.reviewStatus === 'flagged').length;

      // Top chosen actions
      const actionCounts = new Map<string, { count: number; positive: number; total: number }>();
      for (const e of typeEntries) {
        const ac = actionCounts.get(e.chosenAction) ?? { count: 0, positive: 0, total: 0 };
        ac.count += 1;
        if (e.outcome !== 'pending') {
          ac.total += 1;
          if (e.outcome === 'positive') ac.positive += 1;
        }
        actionCounts.set(e.chosenAction, ac);
      }
      const topActions = [...actionCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([action, data]) => ({
          action,
          count: data.count,
          successRate: data.total > 0 ? (data.positive / data.total) * 100 : 0,
        }));

      // Trend: compare last 20 vs previous 20
      const recentEntries = resolved.slice(-20);
      const olderEntries = resolved.slice(-40, -20);
      const recentSuccessRate = recentEntries.length > 0
        ? recentEntries.filter(e => e.outcome === 'positive').length / recentEntries.length
        : 0;
      const olderSuccessRate = olderEntries.length > 0
        ? olderEntries.filter(e => e.outcome === 'positive').length / olderEntries.length
        : 0;

      let trend: 'improving' | 'declining' | 'stable' = 'stable';
      if (recentSuccessRate > olderSuccessRate + 0.1) trend = 'improving';
      else if (recentSuccessRate < olderSuccessRate - 0.1) trend = 'declining';

      patterns.push({
        type: t,
        totalDecisions: typeEntries.length,
        positiveOutcomes: positive,
        negativeOutcomes: negative,
        neutralOutcomes: neutral,
        pendingOutcomes: pending,
        successRate: resolved.length > 0 ? (positive / resolved.length) * 100 : 0,
        avgQualityScore: Math.round(avgQuality * 10) / 10,
        avgExecutionTimeMs: Math.round(avgExecTime),
        flaggedCount: flagged,
        topChosenActions: topActions,
        recentTrend: trend,
      });
    }

    return patterns.sort((a, b) => b.totalDecisions - a.totalDecisions);
  }

  // -------------------------------------------------------------------------
  // Feedback loop: generate improvement suggestions
  // -------------------------------------------------------------------------

  async generateFeedbackSummary(): Promise<FeedbackSummary> {
    const flagged = this.entries.filter(e => e.reviewStatus === 'flagged');
    const approved = this.entries.filter(e => e.reviewStatus === 'approved');
    const rejected = this.entries.filter(e => e.reviewStatus === 'rejected');

    // Extract common issues from flagged/rejected decisions
    const issueCounts = new Map<string, number>();
    for (const e of [...flagged, ...rejected]) {
      if (e.reviewerNotes) {
        const key = e.reviewerNotes.slice(0, 100).toLowerCase();
        issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
      }
      // Also count by decision type
      const typeKey = `${e.type}_failures`;
      issueCounts.set(typeKey, (issueCounts.get(typeKey) ?? 0) + 1);
    }

    const commonIssues = [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([issue, count]) => ({ issue, count }));

    // Try AI for improvement suggestions
    let suggestions: string[] = [];
    let aiUsed = false;

    if (flagged.length >= 3) {
      const prompt = JSON.stringify({
        task: 'analyze_decision_failures',
        flaggedDecisions: flagged.slice(0, 20).map(e => ({
          type: e.type,
          chosenAction: e.chosenAction,
          rationale: e.rationale,
          outcome: e.outcome,
          reviewerNotes: e.reviewerNotes,
          optionsCount: e.optionsConsidered.length,
        })),
        instruction: 'Analyze these flagged decisions and suggest improvements. '
          + 'Return JSON: {"suggestions": ["string"], "riskPatterns": ["string"]}',
      });

      const aiResponse = await callGeminiDecision(prompt);
      if (aiResponse) {
        try {
          const match = aiResponse.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]) as {
              suggestions?: string[];
              riskPatterns?: string[];
            };
            suggestions = parsed.suggestions ?? [];
            aiUsed = true;
          }
        } catch {
          log.warn('Failed to parse AI feedback summary');
        }
      }
    }

    // Heuristic suggestions if AI unavailable
    if (suggestions.length === 0) {
      const patterns = await this.analyzePatterns();
      for (const p of patterns) {
        if (p.successRate < 50 && p.totalDecisions >= 5) {
          suggestions.push(
            `Decision type "${p.type}" has ${p.successRate.toFixed(0)}% success rate — review decision logic`,
          );
        }
        if (p.recentTrend === 'declining') {
          suggestions.push(
            `Decision type "${p.type}" is declining in quality — recent changes may have degraded performance`,
          );
        }
      }
    }

    return {
      totalFlagged: flagged.length,
      totalApproved: approved.length,
      totalRejected: rejected.length,
      commonIssues,
      improvementSuggestions: suggestions,
      aiUsed,
    };
  }

  // -------------------------------------------------------------------------
  // Get flagged decisions for AI context (feedback loop)
  // -------------------------------------------------------------------------

  getFlaggedContext(type: DecisionType, limit = 5): string {
    const flagged = this.entries
      .filter(e => e.type === type && (e.reviewStatus === 'flagged' || e.reviewStatus === 'rejected'))
      .slice(-limit);

    if (flagged.length === 0) return '';

    const lines = ['=== DECISION FEEDBACK (avoid these patterns) ==='];
    for (const e of flagged) {
      lines.push(`- Action "${e.chosenAction}" was ${e.reviewStatus}: ${e.reviewerNotes ?? 'no notes'}`);
      if (e.outcomeDetails) {
        lines.push(`  Outcome: ${e.outcomeDetails}`);
      }
    }
    lines.push('=== END FEEDBACK ===');
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Quality score computation
  // -------------------------------------------------------------------------

  private computeQualityScore(entry: DecisionEntry): number {
    let score = 0;

    // Outcome weight (0-50)
    switch (entry.outcome) {
      case 'positive': score += 50; break;
      case 'neutral': score += 30; break;
      case 'negative': score += 5; break;
      default: score += 25; // pending/unknown
    }

    // Execution time weight (0-15): faster is better, up to a point
    const execTimeScore = entry.executionTimeMs < 100 ? 15
      : entry.executionTimeMs < 500 ? 12
      : entry.executionTimeMs < 2000 ? 8
      : entry.executionTimeMs < 10000 ? 4
      : 1;
    score += execTimeScore;

    // Options considered weight (0-15): more deliberation is better
    const optionsScore = Math.min(15, entry.optionsConsidered.length * 3);
    score += optionsScore;

    // Review weight (0-20)
    switch (entry.reviewStatus) {
      case 'approved': score += 20; break;
      case 'unreviewed': score += 10; break;
      case 'flagged': score += 2; break;
      case 'rejected': score += 0; break;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // -------------------------------------------------------------------------
  // Stats & status
  // -------------------------------------------------------------------------

  getStats(): DecisionJournalStats {
    return { ...this.stats };
  }

  getEntry(decisionId: string): DecisionEntry | null {
    return this.entries.find(e => e.id === decisionId) ?? null;
  }

  getRecentDecisions(limit = 20): DecisionEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistEntry(entry: DecisionEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_decision_journal
           (id, type, maker, context_json, options_json, chosen_action,
            chosen_option_id, rationale, outcome, outcome_details,
            quality_score, review_status, reviewer_notes, reviewed_by,
            reviewed_at, feedback_applied, instance_id, correlation_id,
            execution_time_ms, tags, created_at, outcome_recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           outcome = $9, outcome_details = $10, quality_score = $11,
           review_status = $12, reviewer_notes = $13, reviewed_by = $14,
           reviewed_at = $15, feedback_applied = $16, outcome_recorded_at = $22`,
        [
          entry.id,
          entry.type,
          entry.maker,
          JSON.stringify(entry.context),
          JSON.stringify(entry.optionsConsidered),
          entry.chosenAction,
          entry.chosenOptionId,
          entry.rationale,
          entry.outcome,
          entry.outcomeDetails ?? null,
          entry.qualityScore,
          entry.reviewStatus,
          entry.reviewerNotes ?? null,
          entry.reviewedBy ?? null,
          entry.reviewedAt?.toISOString() ?? null,
          entry.feedbackApplied,
          entry.instanceId ?? null,
          entry.correlationId ?? null,
          entry.executionTimeMs,
          JSON.stringify(entry.tags),
          entry.createdAt.toISOString(),
          entry.outcomeRecordedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, decisionId: entry.id }, 'Failed to persist decision entry');
    }
  }

  private async persistOutcome(entry: DecisionEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_decision_journal
         SET outcome = $2, outcome_details = $3, quality_score = $4,
             outcome_recorded_at = $5
         WHERE id = $1`,
        [
          entry.id,
          entry.outcome,
          entry.outcomeDetails ?? null,
          entry.qualityScore,
          entry.outcomeRecordedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, decisionId: entry.id }, 'Failed to persist decision outcome');
    }
  }

  private async persistReview(entry: DecisionEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_decision_journal
         SET review_status = $2, reviewer_notes = $3, reviewed_by = $4,
             reviewed_at = $5
         WHERE id = $1`,
        [
          entry.id,
          entry.reviewStatus,
          entry.reviewerNotes ?? null,
          entry.reviewedBy ?? null,
          entry.reviewedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, decisionId: entry.id }, 'Failed to persist decision review');
    }
  }

  private async loadRecentFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, maker, context_json, options_json, chosen_action,
                chosen_option_id, rationale, outcome, outcome_details,
                quality_score, review_status, reviewer_notes, reviewed_by,
                reviewed_at, feedback_applied, instance_id, correlation_id,
                execution_time_ms, tags, created_at, outcome_recorded_at
         FROM meow_decision_journal
         WHERE created_at >= NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [MAX_DECISIONS_IN_MEMORY],
      );

      for (const row of rows.reverse()) {
        this.entries.push(this.rowToEntry(row));
      }

      // Rebuild stats
      for (const e of this.entries) {
        this.stats.decisionsByType[e.type] = (this.stats.decisionsByType[e.type] ?? 0) + 1;
        this.stats.decisionsByOutcome[e.outcome] = (this.stats.decisionsByOutcome[e.outcome] ?? 0) + 1;
        this.stats.decisionsByMaker[e.maker] = (this.stats.decisionsByMaker[e.maker] ?? 0) + 1;
        if (e.qualityScore !== null) {
          this.qualityScoreSum += e.qualityScore;
          this.qualityScoreCount += 1;
        }
        if (e.reviewStatus === 'flagged') this.stats.flaggedCount += 1;
        if (e.feedbackApplied) this.stats.feedbackAppliedCount += 1;
      }

      this.stats.totalDecisions = this.entries.length;
      this.stats.avgQualityScore = this.qualityScoreCount > 0
        ? this.qualityScoreSum / this.qualityScoreCount : 0;

      const positiveCount = this.stats.decisionsByOutcome['positive'] ?? 0;
      const negativeCount = this.stats.decisionsByOutcome['negative'] ?? 0;
      const neutralCount = this.stats.decisionsByOutcome['neutral'] ?? 0;
      const totalResolved = positiveCount + negativeCount + neutralCount;
      this.stats.overallSuccessRate = totalResolved > 0
        ? (positiveCount / totalResolved) * 100 : 0;

      log.info({ loaded: rows.length }, 'Loaded recent decisions from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load recent decisions (table may not exist yet)');
    }
  }

  private rowToEntry(row: Record<string, unknown>): DecisionEntry {
    const context = typeof row.context_json === 'string'
      ? JSON.parse(row.context_json as string) : (row.context_json ?? { inputData: {}, urgency: 'normal' });
    const options = typeof row.options_json === 'string'
      ? JSON.parse(row.options_json as string) : (row.options_json ?? []);
    const tags = typeof row.tags === 'string'
      ? JSON.parse(row.tags as string) : (row.tags ?? []);

    return {
      id: row.id as string,
      type: row.type as DecisionType,
      maker: row.maker as DecisionMaker,
      context: context as DecisionContext,
      optionsConsidered: Array.isArray(options) ? options : [],
      chosenAction: row.chosen_action as string,
      chosenOptionId: row.chosen_option_id as string,
      rationale: row.rationale as string,
      outcome: row.outcome as DecisionOutcome,
      outcomeDetails: (row.outcome_details as string) || undefined,
      qualityScore: row.quality_score != null ? Number(row.quality_score) : null,
      reviewStatus: (row.review_status as ReviewStatus) || 'unreviewed',
      reviewerNotes: (row.reviewer_notes as string) || undefined,
      reviewedBy: (row.reviewed_by as string) || undefined,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : undefined,
      feedbackApplied: Boolean(row.feedback_applied),
      instanceId: (row.instance_id as string) || undefined,
      correlationId: (row.correlation_id as string) || undefined,
      executionTimeMs: Number(row.execution_time_ms) || 0,
      tags: Array.isArray(tags) ? tags : [],
      createdAt: new Date(row.created_at as string),
      outcomeRecordedAt: row.outcome_recorded_at
        ? new Date(row.outcome_recorded_at as string) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: DecisionJournal | null = null;

export function getDecisionJournal(): DecisionJournal {
  if (!instance) {
    instance = new DecisionJournal();
    log.info('DecisionJournal singleton created');
  }
  return instance;
}
