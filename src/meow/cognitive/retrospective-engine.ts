/**
 * RETROSPECTIVE ENGINE -- CG-032 (Stage 05 Wave 8)
 *
 * Automated retrospective generation and learning extraction.
 * Triggers: after formula completion, weekly, or on-demand.
 * Analyzes: what went well, what went wrong, what to improve.
 * AI-powered: Gemini synthesizes execution logs, quality scores, costs, errors
 * into coherent narrative.
 * Extracts actionable items: concrete next steps with assigned priority.
 * Compares against previous retrospectives: are we actually improving?
 * Team-level rollup: aggregate individual formula retros into team insights.
 * DB table: meow_retrospectives.
 * Generates structured output: markdown report + action items list.
 * Feeds back into pattern-library.ts and formula-evolution.ts.
 * Retention: keep retros for 90 days, archive older ones.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Molecule, FeedEvent } from '../types';

const log = createLogger('retrospective-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetroTrigger = 'formula_completion' | 'weekly' | 'on_demand' | 'team_rollup';

export type RetroStatus = 'generating' | 'completed' | 'archived';

export type ActionPriority = 'critical' | 'high' | 'medium' | 'low';

export type ActionStatus = 'open' | 'in_progress' | 'completed' | 'dismissed';

export interface ActionItem {
  id: string;
  title: string;
  description: string;
  priority: ActionPriority;
  status: ActionStatus;
  category: 'process' | 'quality' | 'cost' | 'performance' | 'tooling' | 'communication';
  assignedTo?: string;           // worker/skill/team name
  dueDate?: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface RetroSection {
  title: string;
  content: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  keyPoints: string[];
}

export interface ImprovementComparison {
  metricName: string;
  previousValue: number;
  currentValue: number;
  changePct: number;
  improved: boolean;
}

export interface Retrospective {
  id: string;
  trigger: RetroTrigger;
  status: RetroStatus;
  formulaName?: string;
  moleculeId?: string;
  teamName?: string;               // for team rollups

  // Report content
  title: string;
  summary: string;
  wentWell: RetroSection;
  wentWrong: RetroSection;
  toImprove: RetroSection;
  actionItems: ActionItem[];

  // Data used
  executionData: {
    totalMolecules: number;
    successCount: number;
    failureCount: number;
    avgDurationMs: number;
    avgCostUsd: number;
    avgQualityScore: number;
    errorSummary: Record<string, number>;
  };

  // Comparison to previous
  comparisonToPrevious?: ImprovementComparison[];
  overallTrend: 'improving' | 'stable' | 'declining';

  // Markdown report
  markdownReport: string;

  createdAt: Date;
  periodStart?: Date;
  periodEnd?: Date;
  metadata?: Record<string, unknown>;
}

export interface RetroSummary {
  id: string;
  title: string;
  trigger: RetroTrigger;
  formulaName?: string;
  overallTrend: 'improving' | 'stable' | 'declining';
  actionItemCount: number;
  openActionCount: number;
  createdAt: Date;
}

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
              content: 'You are a retrospective analysis engine for an AI orchestration system. Generate insightful retrospectives that identify patterns, celebrate wins, and propose actionable improvements. Always respond with valid JSON.',
            },
            { role: 'user', content: prompt },
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
    log.warn({ err }, 'Gemini call failed in retrospective-engine');
    return null;
  }
}

// ---------------------------------------------------------------------------
// RetroSpectiveEngine
// ---------------------------------------------------------------------------

export class RetrospectiveEngine {
  private retros: Retrospective[] = [];
  private maxInMemory = 1_000;
  private retentionDays = 90;

  // --- Generate retro after formula completion ------------------------------

  async generateFormulaRetro(params: {
    molecule: Molecule;
    qualityScores?: Array<{ beadId: string; composite: number; dimensions: Record<string, number> }>;
    costUsd?: number;
    errors?: Array<{ stepId: string; error: string }>;
    events?: FeedEvent[];
  }): Promise<Retrospective> {
    const { molecule, qualityScores, costUsd, errors, events } = params;

    // Gather execution data
    const executionData = this.gatherMoleculeData(molecule, qualityScores, costUsd, errors);

    // Get previous retro for comparison
    const previousRetro = this.findPreviousRetro(molecule.formulaName);

    // Try AI-powered retro
    const aiRetro = await this.generateWithGemini(executionData, molecule, previousRetro);

    let wentWell: RetroSection;
    let wentWrong: RetroSection;
    let toImprove: RetroSection;
    let actionItems: ActionItem[];
    let summary: string;

    if (aiRetro) {
      wentWell = aiRetro.wentWell;
      wentWrong = aiRetro.wentWrong;
      toImprove = aiRetro.toImprove;
      actionItems = aiRetro.actionItems;
      summary = aiRetro.summary;
    } else {
      // Heuristic fallback
      const heuristic = this.generateHeuristicRetro(executionData, molecule);
      wentWell = heuristic.wentWell;
      wentWrong = heuristic.wentWrong;
      toImprove = heuristic.toImprove;
      actionItems = heuristic.actionItems;
      summary = heuristic.summary;
    }

    // Compute comparison
    const comparison = previousRetro
      ? this.compareWithPrevious(executionData, previousRetro)
      : undefined;

    const overallTrend = this.determineTrend(comparison);

    const retro: Retrospective = {
      id: uuidv4(),
      trigger: 'formula_completion',
      status: 'completed',
      formulaName: molecule.formulaName,
      moleculeId: molecule.id,
      title: `Retro: ${molecule.formulaName} (${molecule.status})`,
      summary,
      wentWell,
      wentWrong,
      toImprove,
      actionItems,
      executionData,
      comparisonToPrevious: comparison,
      overallTrend,
      markdownReport: this.buildMarkdownReport({
        title: `Retro: ${molecule.formulaName}`,
        summary,
        wentWell,
        wentWrong,
        toImprove,
        actionItems,
        executionData,
        comparison,
        overallTrend,
      }),
      createdAt: new Date(),
    };

    this.retros.push(retro);
    if (this.retros.length > this.maxInMemory) {
      this.retros = this.retros.slice(-this.maxInMemory);
    }

    await this.persistRetro(retro);

    broadcast('meow:cognitive', {
      type: 'retrospective_generated',
      retroId: retro.id,
      formulaName: molecule.formulaName,
      overallTrend,
      actionItemCount: actionItems.length,
    });

    log.info({ retroId: retro.id, formulaName: molecule.formulaName, overallTrend }, 'Formula retrospective generated');
    return retro;
  }

  // --- Generate weekly team retrospective -----------------------------------

  async generateWeeklyRetro(teamName = 'all'): Promise<Retrospective> {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Aggregate from recent individual retros
    const recentRetros = this.retros.filter(
      r => r.trigger === 'formula_completion' && r.createdAt >= periodStart,
    );

    const aggregatedData = this.aggregateRetroData(recentRetros);
    const previousWeekly = this.findPreviousWeeklyRetro(teamName);

    // Generate sections
    let wentWell: RetroSection;
    let wentWrong: RetroSection;
    let toImprove: RetroSection;
    let actionItems: ActionItem[];
    let summary: string;

    const aiRetro = await this.generateWeeklyWithGemini(aggregatedData, recentRetros);

    if (aiRetro) {
      wentWell = aiRetro.wentWell;
      wentWrong = aiRetro.wentWrong;
      toImprove = aiRetro.toImprove;
      actionItems = aiRetro.actionItems;
      summary = aiRetro.summary;
    } else {
      const heuristic = this.generateWeeklyHeuristic(aggregatedData, recentRetros);
      wentWell = heuristic.wentWell;
      wentWrong = heuristic.wentWrong;
      toImprove = heuristic.toImprove;
      actionItems = heuristic.actionItems;
      summary = heuristic.summary;
    }

    const comparison = previousWeekly
      ? this.compareWithPrevious(aggregatedData, previousWeekly)
      : undefined;

    const overallTrend = this.determineTrend(comparison);

    const retro: Retrospective = {
      id: uuidv4(),
      trigger: 'weekly',
      status: 'completed',
      teamName,
      title: `Weekly Retro: ${teamName} (${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)})`,
      summary,
      wentWell,
      wentWrong,
      toImprove,
      actionItems,
      executionData: aggregatedData,
      comparisonToPrevious: comparison,
      overallTrend,
      markdownReport: this.buildMarkdownReport({
        title: `Weekly Retro: ${teamName}`,
        summary,
        wentWell,
        wentWrong,
        toImprove,
        actionItems,
        executionData: aggregatedData,
        comparison,
        overallTrend,
      }),
      createdAt: new Date(),
      periodStart,
      periodEnd,
    };

    this.retros.push(retro);
    if (this.retros.length > this.maxInMemory) {
      this.retros = this.retros.slice(-this.maxInMemory);
    }

    await this.persistRetro(retro);

    broadcast('meow:cognitive', {
      type: 'weekly_retrospective_generated',
      retroId: retro.id,
      teamName,
      overallTrend,
      actionItemCount: actionItems.length,
      formulaRetroCount: recentRetros.length,
    });

    log.info({ retroId: retro.id, teamName, overallTrend }, 'Weekly retrospective generated');
    return retro;
  }

  // --- Update action item status --------------------------------------------

  async updateActionItem(retroId: string, actionId: string, status: ActionStatus): Promise<ActionItem | null> {
    const retro = this.findRetro(retroId);
    if (!retro) return null;

    const action = retro.actionItems.find(a => a.id === actionId);
    if (!action) return null;

    action.status = status;
    if (status === 'completed') action.completedAt = new Date();

    await this.persistRetro(retro);

    broadcast('meow:cognitive', {
      type: 'action_item_updated',
      retroId,
      actionId,
      status,
    });

    return action;
  }

  // --- List retros ----------------------------------------------------------

  listRetros(params?: {
    trigger?: RetroTrigger;
    formulaName?: string;
    limit?: number;
  }): RetroSummary[] {
    let filtered = this.retros.filter(r => r.status !== 'archived');
    if (params?.trigger) filtered = filtered.filter(r => r.trigger === params.trigger);
    if (params?.formulaName) filtered = filtered.filter(r => r.formulaName === params.formulaName);

    return filtered
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, params?.limit ?? 30)
      .map(r => ({
        id: r.id,
        title: r.title,
        trigger: r.trigger,
        formulaName: r.formulaName,
        overallTrend: r.overallTrend,
        actionItemCount: r.actionItems.length,
        openActionCount: r.actionItems.filter(a => a.status === 'open' || a.status === 'in_progress').length,
        createdAt: r.createdAt,
      }));
  }

  // --- Get full retro -------------------------------------------------------

  getRetro(retroId: string): Retrospective | null {
    return this.findRetro(retroId);
  }

  // --- Archive old retros ---------------------------------------------------

  async archiveOldRetros(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);

    let archivedCount = 0;

    for (const retro of this.retros) {
      if (retro.createdAt < cutoff && retro.status !== 'archived') {
        retro.status = 'archived';
        archivedCount++;
      }
    }

    // Remove archived from in-memory (keep in DB)
    this.retros = this.retros.filter(r => r.status !== 'archived');

    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE meow_retrospectives SET status = 'archived'
           WHERE created_at < $1 AND status != 'archived'`,
          [cutoff.toISOString()],
        );
      } catch (err) {
        log.warn({ err }, 'Failed to archive old retros in DB');
      }
    }

    if (archivedCount > 0) {
      broadcast('meow:cognitive', {
        type: 'retros_archived',
        count: archivedCount,
        retentionDays: this.retentionDays,
      });
      log.info({ archivedCount, retentionDays: this.retentionDays }, 'Old retrospectives archived');
    }

    return archivedCount;
  }

  // --- Load from DB ---------------------------------------------------------

  async loadFromDb(days = 90): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, trigger, status, formula_name, molecule_id, team_name,
                title, summary, went_well, went_wrong, to_improve,
                action_items, execution_data, comparison_to_previous,
                overall_trend, markdown_report, created_at, period_start,
                period_end, metadata
         FROM meow_retrospectives
         WHERE created_at > NOW() - INTERVAL '${days} days'
           AND status != 'archived'
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.maxInMemory],
      );

      this.retros = rows.map((r: Record<string, unknown>) => this.rowToRetro(r));
      log.info({ count: this.retros.length, days }, 'Loaded retrospectives from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load retrospectives from DB');
    }
  }

  // --- Get open action items across all retros ------------------------------

  getOpenActionItems(): Array<ActionItem & { retroId: string; retroTitle: string }> {
    const items: Array<ActionItem & { retroId: string; retroTitle: string }> = [];

    for (const retro of this.retros) {
      for (const action of retro.actionItems) {
        if (action.status === 'open' || action.status === 'in_progress') {
          items.push({ ...action, retroId: retro.id, retroTitle: retro.title });
        }
      }
    }

    return items.sort((a, b) => {
      const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
    });
  }

  getRetroCount(): number {
    return this.retros.length;
  }

  // --- Private helpers ------------------------------------------------------

  private gatherMoleculeData(
    molecule: Molecule,
    qualityScores?: Array<{ beadId: string; composite: number; dimensions: Record<string, number> }>,
    costUsd?: number,
    errors?: Array<{ stepId: string; error: string }>,
  ): Retrospective['executionData'] {
    const isSuccess = molecule.status === 'completed';
    const totalDuration = molecule.steps.reduce((sum, s) => {
      if (s.startedAt && s.completedAt) {
        return sum + (new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime());
      }
      return sum;
    }, 0);

    const avgQuality = qualityScores && qualityScores.length > 0
      ? qualityScores.reduce((s, q) => s + q.composite, 0) / qualityScores.length
      : 0;

    const errorSummary: Record<string, number> = {};
    const allErrors = errors ?? molecule.steps.filter(s => s.error).map(s => ({ stepId: s.id, error: s.error! }));
    for (const err of allErrors) {
      const key = err.error.slice(0, 80);
      errorSummary[key] = (errorSummary[key] ?? 0) + 1;
    }

    return {
      totalMolecules: 1,
      successCount: isSuccess ? 1 : 0,
      failureCount: isSuccess ? 0 : 1,
      avgDurationMs: totalDuration,
      avgCostUsd: costUsd ?? 0,
      avgQualityScore: Math.round(avgQuality * 100) / 100,
      errorSummary,
    };
  }

  private aggregateRetroData(retros: Retrospective[]): Retrospective['executionData'] {
    if (retros.length === 0) {
      return {
        totalMolecules: 0, successCount: 0, failureCount: 0,
        avgDurationMs: 0, avgCostUsd: 0, avgQualityScore: 0,
        errorSummary: {},
      };
    }

    let totalMolecules = 0;
    let successCount = 0;
    let failureCount = 0;
    let totalDuration = 0;
    let totalCost = 0;
    let totalQuality = 0;
    let qualityCount = 0;
    const errorSummary: Record<string, number> = {};

    for (const r of retros) {
      totalMolecules += r.executionData.totalMolecules;
      successCount += r.executionData.successCount;
      failureCount += r.executionData.failureCount;
      totalDuration += r.executionData.avgDurationMs;
      totalCost += r.executionData.avgCostUsd;
      if (r.executionData.avgQualityScore > 0) {
        totalQuality += r.executionData.avgQualityScore;
        qualityCount++;
      }
      for (const [key, count] of Object.entries(r.executionData.errorSummary)) {
        errorSummary[key] = (errorSummary[key] ?? 0) + count;
      }
    }

    return {
      totalMolecules,
      successCount,
      failureCount,
      avgDurationMs: retros.length > 0 ? Math.round(totalDuration / retros.length) : 0,
      avgCostUsd: retros.length > 0 ? Math.round((totalCost / retros.length) * 10000) / 10000 : 0,
      avgQualityScore: qualityCount > 0 ? Math.round((totalQuality / qualityCount) * 100) / 100 : 0,
      errorSummary,
    };
  }

  private findPreviousRetro(formulaName?: string): Retrospective | undefined {
    if (!formulaName) return undefined;
    return this.retros
      .filter(r => r.formulaName === formulaName && r.trigger === 'formula_completion')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      [0];
  }

  private findPreviousWeeklyRetro(teamName: string): Retrospective | undefined {
    return this.retros
      .filter(r => r.trigger === 'weekly' && (r.teamName === teamName || teamName === 'all'))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      [0];
  }

  private compareWithPrevious(
    current: Retrospective['executionData'],
    previous: Retrospective,
  ): ImprovementComparison[] {
    const prev = previous.executionData;
    const comparisons: ImprovementComparison[] = [];

    const addComparison = (name: string, prevVal: number, curVal: number, higherIsBetter: boolean) => {
      if (prevVal === 0 && curVal === 0) return;
      const changePct = prevVal > 0 ? ((curVal - prevVal) / prevVal) * 100 : 0;
      comparisons.push({
        metricName: name,
        previousValue: Math.round(prevVal * 100) / 100,
        currentValue: Math.round(curVal * 100) / 100,
        changePct: Math.round(changePct * 10) / 10,
        improved: higherIsBetter ? curVal > prevVal : curVal < prevVal,
      });
    };

    const prevSuccessRate = prev.totalMolecules > 0 ? prev.successCount / prev.totalMolecules : 0;
    const curSuccessRate = current.totalMolecules > 0 ? current.successCount / current.totalMolecules : 0;

    addComparison('success_rate', prevSuccessRate, curSuccessRate, true);
    addComparison('avg_duration_ms', prev.avgDurationMs, current.avgDurationMs, false);
    addComparison('avg_cost_usd', prev.avgCostUsd, current.avgCostUsd, false);
    addComparison('avg_quality_score', prev.avgQualityScore, current.avgQualityScore, true);

    return comparisons;
  }

  private determineTrend(comparison?: ImprovementComparison[]): 'improving' | 'stable' | 'declining' {
    if (!comparison || comparison.length === 0) return 'stable';

    let improved = 0;
    let declined = 0;

    for (const c of comparison) {
      if (c.improved) improved++;
      else if (Math.abs(c.changePct) > 5) declined++;
    }

    if (improved > declined) return 'improving';
    if (declined > improved) return 'declining';
    return 'stable';
  }

  private generateHeuristicRetro(
    data: Retrospective['executionData'],
    molecule: Molecule,
  ): {
    wentWell: RetroSection;
    wentWrong: RetroSection;
    toImprove: RetroSection;
    actionItems: ActionItem[];
    summary: string;
  } {
    const isSuccess = molecule.status === 'completed';
    const successRate = data.totalMolecules > 0 ? data.successCount / data.totalMolecules : 0;

    // What went well
    const wellPoints: string[] = [];
    if (isSuccess) wellPoints.push(`Formula "${molecule.formulaName}" completed successfully`);
    if (data.avgQualityScore >= 7) wellPoints.push(`Quality score ${data.avgQualityScore} is above target`);
    const completedSteps = molecule.steps.filter(s => s.status === 'completed');
    if (completedSteps.length > 0) wellPoints.push(`${completedSteps.length}/${molecule.steps.length} steps completed`);
    if (wellPoints.length === 0) wellPoints.push('Execution attempted and data collected');

    // What went wrong
    const wrongPoints: string[] = [];
    if (!isSuccess) wrongPoints.push(`Formula failed: ${molecule.error ?? 'unknown error'}`);
    const failedSteps = molecule.steps.filter(s => s.status === 'failed');
    for (const step of failedSteps.slice(0, 3)) {
      wrongPoints.push(`Step "${step.title}" failed: ${(step.error ?? 'unknown').slice(0, 80)}`);
    }
    if (data.avgDurationMs > 120_000) wrongPoints.push(`Slow execution: ${Math.round(data.avgDurationMs / 1000)}s`);
    if (data.avgQualityScore > 0 && data.avgQualityScore < 6) wrongPoints.push(`Low quality: ${data.avgQualityScore}`);
    if (wrongPoints.length === 0) wrongPoints.push('No significant issues detected');

    // What to improve
    const improvePoints: string[] = [];
    if (failedSteps.length > 0) improvePoints.push('Add retry logic to failing steps');
    if (data.avgDurationMs > 60_000) improvePoints.push('Optimize step execution for faster completion');
    if (data.avgCostUsd > 0.10) improvePoints.push('Consider lower-tier models for cost reduction');
    if (data.avgQualityScore > 0 && data.avgQualityScore < 7) improvePoints.push('Refine prompts to improve output quality');
    if (improvePoints.length === 0) improvePoints.push('Continue monitoring and collecting data');

    // Action items
    const actions: ActionItem[] = [];
    if (failedSteps.length > 0) {
      actions.push({
        id: uuidv4(),
        title: `Investigate failures in ${failedSteps.map(s => s.title).join(', ')}`,
        description: `${failedSteps.length} steps failed. Root cause analysis needed.`,
        priority: failedSteps.length > 2 ? 'critical' : 'high',
        status: 'open',
        category: 'quality',
      });
    }
    if (data.avgDurationMs > 120_000) {
      actions.push({
        id: uuidv4(),
        title: 'Optimize execution performance',
        description: `Average duration ${Math.round(data.avgDurationMs / 1000)}s exceeds target. Profile bottlenecks.`,
        priority: 'medium',
        status: 'open',
        category: 'performance',
      });
    }
    if (Object.keys(data.errorSummary).length > 0) {
      actions.push({
        id: uuidv4(),
        title: 'Address error patterns',
        description: `${Object.keys(data.errorSummary).length} distinct error types detected. See error summary.`,
        priority: 'high',
        status: 'open',
        category: 'quality',
      });
    }

    const summary = `${isSuccess ? 'Successful' : 'Failed'} execution of "${molecule.formulaName}". ` +
      `${completedSteps.length}/${molecule.steps.length} steps completed. ` +
      `Duration: ${Math.round(data.avgDurationMs / 1000)}s. ` +
      `${actions.length} action items identified.`;

    return {
      wentWell: {
        title: 'What Went Well',
        content: wellPoints.join('\n'),
        sentiment: isSuccess ? 'positive' : 'neutral',
        keyPoints: wellPoints,
      },
      wentWrong: {
        title: 'What Went Wrong',
        content: wrongPoints.join('\n'),
        sentiment: wrongPoints.length <= 1 && wrongPoints[0].includes('No significant') ? 'neutral' : 'negative',
        keyPoints: wrongPoints,
      },
      toImprove: {
        title: 'What To Improve',
        content: improvePoints.join('\n'),
        sentiment: 'neutral',
        keyPoints: improvePoints,
      },
      actionItems: actions,
      summary,
    };
  }

  private async generateWithGemini(
    data: Retrospective['executionData'],
    molecule: Molecule,
    previousRetro?: Retrospective,
  ): Promise<{
    wentWell: RetroSection;
    wentWrong: RetroSection;
    toImprove: RetroSection;
    actionItems: ActionItem[];
    summary: string;
  } | null> {
    const stepSummary = molecule.steps.map(s => ({
      title: s.title,
      status: s.status,
      skill: s.skill,
      error: s.error,
      duration: s.startedAt && s.completedAt
        ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
        : 0,
    }));

    const prompt = `Generate a retrospective for this formula execution.

Formula: ${molecule.formulaName}
Status: ${molecule.status}
Steps: ${JSON.stringify(stepSummary)}
Quality: ${data.avgQualityScore}, Cost: $${data.avgCostUsd}, Duration: ${data.avgDurationMs}ms
Errors: ${JSON.stringify(data.errorSummary)}
${previousRetro ? `Previous retro trend: ${previousRetro.overallTrend}, actions: ${previousRetro.actionItems.length}` : 'No previous retro'}

Respond with JSON:
{
  "summary": "2-3 sentence summary",
  "wentWell": { "keyPoints": ["point1", "point2"] },
  "wentWrong": { "keyPoints": ["point1", "point2"] },
  "toImprove": { "keyPoints": ["point1", "point2"] },
  "actionItems": [{ "title": "...", "description": "...", "priority": "critical|high|medium|low", "category": "process|quality|cost|performance|tooling|communication" }]
}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as Record<string, unknown>;

      const makeSection = (key: string, title: string): RetroSection => {
        const sec = parsed[key] as Record<string, unknown> | undefined;
        const points = Array.isArray(sec?.keyPoints) ? sec.keyPoints as string[] : [];
        const hasNegative = points.some((p: string) => /fail|error|slow|bad|wrong|miss/i.test(p));
        return {
          title,
          content: points.join('\n'),
          sentiment: key === 'wentWell' ? 'positive' : key === 'wentWrong' && hasNegative ? 'negative' : 'neutral',
          keyPoints: points,
        };
      };

      const actions = Array.isArray(parsed.actionItems)
        ? (parsed.actionItems as Array<Record<string, unknown>>).map(a => ({
            id: uuidv4(),
            title: String(a.title ?? 'Action item'),
            description: String(a.description ?? ''),
            priority: (a.priority as ActionPriority) ?? 'medium',
            status: 'open' as ActionStatus,
            category: (a.category as ActionItem['category']) ?? 'process',
          }))
        : [];

      return {
        wentWell: makeSection('wentWell', 'What Went Well'),
        wentWrong: makeSection('wentWrong', 'What Went Wrong'),
        toImprove: makeSection('toImprove', 'What To Improve'),
        actionItems: actions,
        summary: String(parsed.summary ?? 'AI-generated retrospective'),
      };
    } catch {
      log.warn('Failed to parse Gemini retrospective response');
      return null;
    }
  }

  private async generateWeeklyWithGemini(
    data: Retrospective['executionData'],
    retros: Retrospective[],
  ): Promise<{
    wentWell: RetroSection;
    wentWrong: RetroSection;
    toImprove: RetroSection;
    actionItems: ActionItem[];
    summary: string;
  } | null> {
    const retroSummaries = retros.slice(0, 20).map(r => ({
      formula: r.formulaName,
      trend: r.overallTrend,
      openActions: r.actionItems.filter(a => a.status === 'open').length,
    }));

    const prompt = `Generate a weekly team retrospective.

Aggregated data: ${JSON.stringify(data)}
Individual retros (${retros.length} this week): ${JSON.stringify(retroSummaries)}

Respond with JSON:
{
  "summary": "2-3 sentence weekly summary",
  "wentWell": { "keyPoints": ["team-level insight 1", "insight 2"] },
  "wentWrong": { "keyPoints": ["team-level concern 1", "concern 2"] },
  "toImprove": { "keyPoints": ["suggestion 1", "suggestion 2"] },
  "actionItems": [{ "title": "...", "description": "...", "priority": "critical|high|medium|low", "category": "process|quality|cost|performance|tooling|communication" }]
}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as Record<string, unknown>;

      const makeSection = (key: string, title: string): RetroSection => {
        const sec = parsed[key] as Record<string, unknown> | undefined;
        const points = Array.isArray(sec?.keyPoints) ? sec.keyPoints as string[] : [];
        return {
          title,
          content: points.join('\n'),
          sentiment: key === 'wentWell' ? 'positive' : key === 'wentWrong' ? 'negative' : 'neutral',
          keyPoints: points,
        };
      };

      const actions = Array.isArray(parsed.actionItems)
        ? (parsed.actionItems as Array<Record<string, unknown>>).map(a => ({
            id: uuidv4(),
            title: String(a.title ?? 'Action item'),
            description: String(a.description ?? ''),
            priority: (a.priority as ActionPriority) ?? 'medium',
            status: 'open' as ActionStatus,
            category: (a.category as ActionItem['category']) ?? 'process',
          }))
        : [];

      return {
        wentWell: makeSection('wentWell', 'What Went Well'),
        wentWrong: makeSection('wentWrong', 'What Went Wrong'),
        toImprove: makeSection('toImprove', 'What To Improve'),
        actionItems: actions,
        summary: String(parsed.summary ?? 'AI-generated weekly retrospective'),
      };
    } catch {
      log.warn('Failed to parse Gemini weekly retrospective response');
      return null;
    }
  }

  private generateWeeklyHeuristic(
    data: Retrospective['executionData'],
    retros: Retrospective[],
  ): {
    wentWell: RetroSection;
    wentWrong: RetroSection;
    toImprove: RetroSection;
    actionItems: ActionItem[];
    summary: string;
  } {
    const successRate = data.totalMolecules > 0 ? data.successCount / data.totalMolecules : 0;
    const improvingCount = retros.filter(r => r.overallTrend === 'improving').length;
    const decliningCount = retros.filter(r => r.overallTrend === 'declining').length;

    const wellPoints: string[] = [];
    if (successRate >= 0.8) wellPoints.push(`${Math.round(successRate * 100)}% success rate across ${data.totalMolecules} molecules`);
    if (improvingCount > 0) wellPoints.push(`${improvingCount} formulas showing improvement trend`);
    if (data.avgQualityScore >= 7) wellPoints.push(`Average quality ${data.avgQualityScore} above target`);
    if (wellPoints.length === 0) wellPoints.push(`${data.totalMolecules} molecules executed this week`);

    const wrongPoints: string[] = [];
    if (successRate < 0.8) wrongPoints.push(`Success rate ${Math.round(successRate * 100)}% below 80% target`);
    if (decliningCount > 0) wrongPoints.push(`${decliningCount} formulas showing declining trend`);
    if (data.failureCount > 0) wrongPoints.push(`${data.failureCount} failures out of ${data.totalMolecules}`);
    if (wrongPoints.length === 0) wrongPoints.push('No significant issues this week');

    const improvePoints = [
      retros.length > 0 ? `Continue monitoring ${retros.length} formulas` : 'Start collecting execution data',
      'Review and close open action items from previous weeks',
    ];

    const actions: ActionItem[] = [];
    if (successRate < 0.8) {
      actions.push({
        id: uuidv4(),
        title: 'Improve overall success rate',
        description: `Weekly success rate ${Math.round(successRate * 100)}%. Target: 80%+.`,
        priority: 'high',
        status: 'open',
        category: 'quality',
      });
    }

    const totalOpenActions = retros.reduce(
      (s, r) => s + r.actionItems.filter(a => a.status === 'open').length, 0,
    );
    if (totalOpenActions > 10) {
      actions.push({
        id: uuidv4(),
        title: `Review ${totalOpenActions} open action items`,
        description: 'Large backlog of open actions. Triage and prioritize.',
        priority: 'medium',
        status: 'open',
        category: 'process',
      });
    }

    const summary = `Weekly: ${data.totalMolecules} molecules, ${Math.round(successRate * 100)}% success rate. ` +
      `${improvingCount} improving, ${decliningCount} declining. ${actions.length} new actions.`;

    return {
      wentWell: { title: 'What Went Well', content: wellPoints.join('\n'), sentiment: 'positive', keyPoints: wellPoints },
      wentWrong: { title: 'What Went Wrong', content: wrongPoints.join('\n'), sentiment: wrongPoints[0].includes('No significant') ? 'neutral' : 'negative', keyPoints: wrongPoints },
      toImprove: { title: 'What To Improve', content: improvePoints.join('\n'), sentiment: 'neutral', keyPoints: improvePoints },
      actionItems: actions,
      summary,
    };
  }

  private buildMarkdownReport(params: {
    title: string;
    summary: string;
    wentWell: RetroSection;
    wentWrong: RetroSection;
    toImprove: RetroSection;
    actionItems: ActionItem[];
    executionData: Retrospective['executionData'];
    comparison?: ImprovementComparison[];
    overallTrend: string;
  }): string {
    const { title, summary, wentWell, wentWrong, toImprove, actionItems, executionData, comparison, overallTrend } = params;
    const successRate = executionData.totalMolecules > 0
      ? Math.round((executionData.successCount / executionData.totalMolecules) * 100)
      : 0;

    let md = `# ${title}\n\n`;
    md += `**Trend:** ${overallTrend} | **Generated:** ${new Date().toISOString().slice(0, 16)}\n\n`;
    md += `## Summary\n${summary}\n\n`;

    md += `## Metrics\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Molecules | ${executionData.totalMolecules} |\n`;
    md += `| Success Rate | ${successRate}% |\n`;
    md += `| Avg Duration | ${Math.round(executionData.avgDurationMs / 1000)}s |\n`;
    md += `| Avg Cost | $${executionData.avgCostUsd.toFixed(4)} |\n`;
    md += `| Avg Quality | ${executionData.avgQualityScore} |\n\n`;

    if (comparison && comparison.length > 0) {
      md += `## Comparison to Previous\n`;
      md += `| Metric | Previous | Current | Change |\n|--------|----------|---------|--------|\n`;
      for (const c of comparison) {
        const arrow = c.improved ? '+' : c.changePct < 0 ? '' : '';
        md += `| ${c.metricName} | ${c.previousValue} | ${c.currentValue} | ${arrow}${c.changePct}% |\n`;
      }
      md += '\n';
    }

    md += `## What Went Well\n`;
    for (const point of wentWell.keyPoints) md += `- ${point}\n`;
    md += '\n';

    md += `## What Went Wrong\n`;
    for (const point of wentWrong.keyPoints) md += `- ${point}\n`;
    md += '\n';

    md += `## What To Improve\n`;
    for (const point of toImprove.keyPoints) md += `- ${point}\n`;
    md += '\n';

    if (actionItems.length > 0) {
      md += `## Action Items (${actionItems.length})\n`;
      for (const action of actionItems) {
        md += `- [${action.status === 'completed' ? 'x' : ' '}] **[${action.priority.toUpperCase()}]** ${action.title}\n`;
        if (action.description) md += `  ${action.description}\n`;
      }
    }

    return md;
  }

  private findRetro(id: string): Retrospective | null {
    return this.retros.find(r => r.id === id) ?? null;
  }

  private async persistRetro(retro: Retrospective): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_retrospectives
          (id, trigger, status, formula_name, molecule_id, team_name,
           title, summary, went_well, went_wrong, to_improve,
           action_items, execution_data, comparison_to_previous,
           overall_trend, markdown_report, created_at, period_start,
           period_end, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           action_items = EXCLUDED.action_items`,
        [
          retro.id,
          retro.trigger,
          retro.status,
          retro.formulaName ?? null,
          retro.moleculeId ?? null,
          retro.teamName ?? null,
          retro.title,
          retro.summary,
          JSON.stringify(retro.wentWell),
          JSON.stringify(retro.wentWrong),
          JSON.stringify(retro.toImprove),
          JSON.stringify(retro.actionItems),
          JSON.stringify(retro.executionData),
          retro.comparisonToPrevious ? JSON.stringify(retro.comparisonToPrevious) : null,
          retro.overallTrend,
          retro.markdownReport,
          retro.createdAt.toISOString(),
          retro.periodStart?.toISOString() ?? null,
          retro.periodEnd?.toISOString() ?? null,
          retro.metadata ? JSON.stringify(retro.metadata) : null,
        ],
      );
    } catch (err) {
      log.warn({ err, retroId: retro.id }, 'Failed to persist retrospective');
    }
  }

  private rowToRetro(r: Record<string, unknown>): Retrospective {
    const parseJson = (val: unknown) => {
      if (val == null) return undefined;
      if (typeof val === 'string') return JSON.parse(val);
      return val;
    };

    const defaultSection: RetroSection = { title: '', content: '', sentiment: 'neutral', keyPoints: [] };

    return {
      id: r.id as string,
      trigger: r.trigger as RetroTrigger,
      status: r.status as RetroStatus,
      formulaName: (r.formula_name as string) ?? undefined,
      moleculeId: (r.molecule_id as string) ?? undefined,
      teamName: (r.team_name as string) ?? undefined,
      title: (r.title as string) ?? '',
      summary: (r.summary as string) ?? '',
      wentWell: (parseJson(r.went_well) as RetroSection) ?? defaultSection,
      wentWrong: (parseJson(r.went_wrong) as RetroSection) ?? defaultSection,
      toImprove: (parseJson(r.to_improve) as RetroSection) ?? defaultSection,
      actionItems: (parseJson(r.action_items) as ActionItem[]) ?? [],
      executionData: (parseJson(r.execution_data) as Retrospective['executionData']) ?? {
        totalMolecules: 0, successCount: 0, failureCount: 0,
        avgDurationMs: 0, avgCostUsd: 0, avgQualityScore: 0, errorSummary: {},
      },
      comparisonToPrevious: parseJson(r.comparison_to_previous) as ImprovementComparison[] | undefined,
      overallTrend: (r.overall_trend as 'improving' | 'stable' | 'declining') ?? 'stable',
      markdownReport: (r.markdown_report as string) ?? '',
      createdAt: new Date((r.created_at as string) ?? Date.now()),
      periodStart: r.period_start ? new Date(r.period_start as string) : undefined,
      periodEnd: r.period_end ? new Date(r.period_end as string) : undefined,
      metadata: parseJson(r.metadata) as Record<string, unknown> | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: RetrospectiveEngine | null = null;

export function getRetrospectiveEngine(): RetrospectiveEngine {
  if (!instance) {
    instance = new RetrospectiveEngine();
    log.info('RetrospectiveEngine singleton created');
  }
  return instance;
}
