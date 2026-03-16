/**
 * AUTO REPORTS — SG-024 (Stage 06 Wave 6)
 *
 * Auto-generated reports at configurable intervals, synthesized by AI.
 * Produces daily executive summaries, weekly performance analyses, and
 * monthly strategic deep dives.
 *
 * Report types:
 *   - daily_executive: Key metrics, notable events, anomalies
 *   - weekly_performance: Trends, week-over-week comparisons, highlights
 *   - monthly_strategic: Deep analysis, strategic recommendations, forecasts
 *
 * Features:
 *   - AI-powered: Gemini synthesizes data into coherent narrative with insights
 *   - Data sources: cost tracker, quality scorer, outcome tracker, molecules, workers
 *   - Format: structured markdown with sections (summary, metrics, highlights, concerns, recommendations)
 *   - Distribution: store in DB, broadcast on SSE, optionally email via Resend
 *   - Scheduling: daily 22:00, weekly Monday 09:00, monthly 1st 09:00 (configurable)
 *   - Historical: all reports stored and queryable
 *   - Comparison: each report compares against previous period
 *   - On-demand: trigger any report type manually
 *   - DB table: meow_reports
 *
 * Gas Town: "The ledger never lies — read it daily, or the refinery reads you."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('auto-reports');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportType = 'daily_executive' | 'weekly_performance' | 'monthly_strategic';

export type ReportStatus = 'generating' | 'completed' | 'failed';

export type ReportTrigger = 'scheduled' | 'manual';

export interface ReportRecord {
  id: string;
  type: ReportType;
  title: string;
  periodStart: Date;
  periodEnd: Date;
  status: ReportStatus;
  trigger: ReportTrigger;
  content: string;              // markdown body
  sections: ReportSection[];
  metrics: ReportMetrics;
  comparison?: PeriodComparison;
  aiGenerated: boolean;
  generationDurationMs: number;
  error?: string;
  distributedVia: string[];     // ['sse', 'db', 'email']
  createdAt: Date;
}

export interface ReportSection {
  title: string;
  order: number;
  content: string;
  type: 'summary' | 'metrics' | 'highlights' | 'concerns' | 'recommendations' | 'comparison' | 'forecast';
}

export interface ReportMetrics {
  totalCostUsd: number;
  totalMolecules: number;
  completedMolecules: number;
  failedMolecules: number;
  avgQualityScore: number;
  activeWorkers: number;
  totalBeads: number;
  completedBeads: number;
  formulasRun: number;
  crisesOccurred: number;
  avgResponseTimeMs: number;
}

export interface PeriodComparison {
  previousPeriodStart: Date;
  previousPeriodEnd: Date;
  costChange: number;            // percentage change
  moleculeChange: number;
  qualityChange: number;
  efficiencyChange: number;
  trend: 'improving' | 'stable' | 'declining';
  highlights: string[];
}

export interface ScheduleConfig {
  dailyHour: number;             // 0-23 UTC
  weeklyDay: number;             // 0=Sunday, 1=Monday, ...
  weeklyHour: number;
  monthlyDay: number;            // 1-28
  monthlyHour: number;
  timezone: string;
  emailRecipients: string[];
  enabled: boolean;
}

export interface ReportQuery {
  type?: ReportType;
  from?: Date;
  to?: Date;
  limit?: number;
  trigger?: ReportTrigger;
}

export interface ReporterStats {
  totalReports: number;
  reportsByType: Record<ReportType, number>;
  avgGenerationMs: number;
  lastDailyAt?: Date;
  lastWeeklyAt?: Date;
  lastMonthlyAt?: Date;
  aiGeneratedPct: number;
  failedReports: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_REPORTS_MEMORY = 200;
const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_SCHEDULE: ScheduleConfig = {
  dailyHour: 22,
  weeklyDay: 1,       // Monday
  weeklyHour: 9,
  monthlyDay: 1,
  monthlyHour: 9,
  timezone: 'America/Sao_Paulo',
  emailRecipients: [],
  enabled: true,
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiReport(systemPrompt: string, context: string): Promise<string | null> {
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
            { role: 'user', content: context },
          ],
          max_tokens: 4096,
          temperature: 0.4,
        }),
      },
    );

    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini report generation call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data collection helpers
// ---------------------------------------------------------------------------

async function collectMetrics(periodStart: Date, periodEnd: Date): Promise<ReportMetrics> {
  const pool = getPool();
  const defaults: ReportMetrics = {
    totalCostUsd: 0, totalMolecules: 0, completedMolecules: 0,
    failedMolecules: 0, avgQualityScore: 0, activeWorkers: 0,
    totalBeads: 0, completedBeads: 0, formulasRun: 0,
    crisesOccurred: 0, avgResponseTimeMs: 0,
  };
  if (!pool) return defaults;

  try {
    const [costRes, molRes, workerRes, beadRes, formulaRes, crisisRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0)::float as total_cost
         FROM meow_cost_log WHERE created_at BETWEEN $1 AND $2`,
        [periodStart, periodEnd],
      ),
      pool.query(
        `SELECT COUNT(*)::int as total,
                COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
                COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
                COALESCE(AVG(quality_score), 0)::float as avg_quality
         FROM meow_molecules WHERE created_at BETWEEN $1 AND $2`,
        [periodStart, periodEnd],
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int as active FROM meow_workers`,
      ),
      pool.query(
        `SELECT COUNT(*)::int as total,
                COUNT(*) FILTER (WHERE status = 'completed')::int as completed
         FROM meow_beads WHERE created_at BETWEEN $1 AND $2`,
        [periodStart, periodEnd],
      ),
      pool.query(
        `SELECT COUNT(*)::int as total FROM meow_formula_triggers
         WHERE created_at BETWEEN $1 AND $2`,
        [periodStart, periodEnd],
      ),
      pool.query(
        `SELECT COUNT(*)::int as total FROM meow_crisis_events
         WHERE created_at BETWEEN $1 AND $2`,
        [periodStart, periodEnd],
      ),
    ]);

    return {
      totalCostUsd: costRes.rows[0]?.total_cost ?? 0,
      totalMolecules: molRes.rows[0]?.total ?? 0,
      completedMolecules: molRes.rows[0]?.completed ?? 0,
      failedMolecules: molRes.rows[0]?.failed ?? 0,
      avgQualityScore: molRes.rows[0]?.avg_quality ?? 0,
      activeWorkers: workerRes.rows[0]?.active ?? 0,
      totalBeads: beadRes.rows[0]?.total ?? 0,
      completedBeads: beadRes.rows[0]?.completed ?? 0,
      formulasRun: formulaRes.rows[0]?.total ?? 0,
      crisesOccurred: crisisRes.rows[0]?.total ?? 0,
      avgResponseTimeMs: 0,
    };
  } catch (err) {
    log.warn({ err }, 'Failed to collect metrics from DB — using defaults');
    return defaults;
  }
}

async function collectPreviousPeriodMetrics(
  type: ReportType,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ metrics: ReportMetrics; start: Date; end: Date }> {
  const durationMs = periodEnd.getTime() - periodStart.getTime();
  const prevEnd = new Date(periodStart.getTime());
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  const metrics = await collectMetrics(prevStart, prevEnd);
  return { metrics, start: prevStart, end: prevEnd };
}

function computeComparison(
  current: ReportMetrics,
  previous: ReportMetrics,
  prevStart: Date,
  prevEnd: Date,
): PeriodComparison {
  const pctChange = (curr: number, prev: number): number => {
    if (prev === 0) return curr > 0 ? 100 : 0;
    return Math.round(((curr - prev) / prev) * 100);
  };

  const costChange = pctChange(current.totalCostUsd, previous.totalCostUsd);
  const moleculeChange = pctChange(current.completedMolecules, previous.completedMolecules);
  const qualityChange = pctChange(current.avgQualityScore, previous.avgQualityScore);

  const currentEfficiency = current.totalMolecules > 0
    ? (current.completedMolecules / current.totalMolecules) * 100 : 0;
  const previousEfficiency = previous.totalMolecules > 0
    ? (previous.completedMolecules / previous.totalMolecules) * 100 : 0;
  const efficiencyChange = pctChange(currentEfficiency, previousEfficiency);

  const highlights: string[] = [];
  if (costChange < -10) highlights.push(`Cost decreased by ${Math.abs(costChange)}%`);
  if (costChange > 10) highlights.push(`Cost increased by ${costChange}%`);
  if (moleculeChange > 10) highlights.push(`Molecule throughput up ${moleculeChange}%`);
  if (qualityChange > 5) highlights.push(`Quality improved by ${qualityChange}%`);
  if (qualityChange < -5) highlights.push(`Quality declined by ${Math.abs(qualityChange)}%`);
  if (current.crisesOccurred > previous.crisesOccurred) highlights.push(`More crises this period (${current.crisesOccurred} vs ${previous.crisesOccurred})`);

  let trend: 'improving' | 'stable' | 'declining' = 'stable';
  const positiveSignals = [moleculeChange > 5, qualityChange > 3, costChange < -5, efficiencyChange > 3].filter(Boolean).length;
  const negativeSignals = [moleculeChange < -5, qualityChange < -3, costChange > 10, efficiencyChange < -3].filter(Boolean).length;
  if (positiveSignals >= 2) trend = 'improving';
  if (negativeSignals >= 2) trend = 'declining';

  return {
    previousPeriodStart: prevStart,
    previousPeriodEnd: prevEnd,
    costChange,
    moleculeChange,
    qualityChange,
    efficiencyChange,
    trend,
    highlights,
  };
}

// ---------------------------------------------------------------------------
// Heuristic report builder (fallback when AI unavailable)
// ---------------------------------------------------------------------------

function buildHeuristicReport(
  type: ReportType,
  metrics: ReportMetrics,
  comparison?: PeriodComparison,
): ReportSection[] {
  const sections: ReportSection[] = [];

  const successRate = metrics.totalMolecules > 0
    ? Math.round((metrics.completedMolecules / metrics.totalMolecules) * 100) : 0;

  sections.push({
    title: 'Executive Summary',
    order: 1,
    type: 'summary',
    content: [
      `**Period Report** (${type.replace('_', ' ')})`,
      '',
      `Gas Town processed ${metrics.totalMolecules} molecules with a ${successRate}% success rate.`,
      `Total cost: $${metrics.totalCostUsd.toFixed(2)}. Active workers: ${metrics.activeWorkers}.`,
      `Beads completed: ${metrics.completedBeads}/${metrics.totalBeads}. Formulas run: ${metrics.formulasRun}.`,
      metrics.crisesOccurred > 0
        ? `**${metrics.crisesOccurred} crisis event(s)** occurred during this period.`
        : 'No crisis events during this period.',
    ].join('\n'),
  });

  sections.push({
    title: 'Key Metrics',
    order: 2,
    type: 'metrics',
    content: [
      '| Metric | Value |',
      '|--------|-------|',
      `| Total Cost (USD) | $${metrics.totalCostUsd.toFixed(2)} |`,
      `| Molecules Total | ${metrics.totalMolecules} |`,
      `| Molecules Completed | ${metrics.completedMolecules} |`,
      `| Molecules Failed | ${metrics.failedMolecules} |`,
      `| Success Rate | ${successRate}% |`,
      `| Avg Quality Score | ${metrics.avgQualityScore.toFixed(2)} |`,
      `| Active Workers | ${metrics.activeWorkers} |`,
      `| Beads Completed | ${metrics.completedBeads}/${metrics.totalBeads} |`,
      `| Formulas Run | ${metrics.formulasRun} |`,
      `| Crises | ${metrics.crisesOccurred} |`,
    ].join('\n'),
  });

  if (comparison) {
    sections.push({
      title: 'Period Comparison',
      order: 3,
      type: 'comparison',
      content: [
        `**Trend: ${comparison.trend.toUpperCase()}**`,
        '',
        `| Metric | Change |`,
        `|--------|--------|`,
        `| Cost | ${comparison.costChange > 0 ? '+' : ''}${comparison.costChange}% |`,
        `| Molecules | ${comparison.moleculeChange > 0 ? '+' : ''}${comparison.moleculeChange}% |`,
        `| Quality | ${comparison.qualityChange > 0 ? '+' : ''}${comparison.qualityChange}% |`,
        `| Efficiency | ${comparison.efficiencyChange > 0 ? '+' : ''}${comparison.efficiencyChange}% |`,
        '',
        comparison.highlights.length > 0
          ? comparison.highlights.map(h => `- ${h}`).join('\n')
          : '- No significant changes detected.',
      ].join('\n'),
    });
  }

  const concerns: string[] = [];
  if (metrics.failedMolecules > metrics.completedMolecules * 0.2) concerns.push('High failure rate (>20%) — investigate molecule errors');
  if (metrics.crisesOccurred > 0) concerns.push('Crisis events detected — review crisis post-mortems');
  if (metrics.avgQualityScore < 6) concerns.push('Average quality below 6.0 — quality gates may need adjustment');
  if (comparison && comparison.costChange > 20) concerns.push('Cost increase exceeds 20% — review resource allocation');

  sections.push({
    title: 'Concerns',
    order: 4,
    type: 'concerns',
    content: concerns.length > 0
      ? concerns.map(c => `- ${c}`).join('\n')
      : '- No major concerns identified.',
  });

  sections.push({
    title: 'Recommendations',
    order: 5,
    type: 'recommendations',
    content: [
      successRate < 80 ? '- Investigate and fix top failure causes to improve success rate' : '- Maintain current operational excellence',
      metrics.crisesOccurred > 2 ? '- Implement additional preventive measures for recurring crises' : '',
      type === 'monthly_strategic' ? '- Review resource allocation strategy for next month' : '',
      type === 'weekly_performance' ? '- Prioritize formulas with highest ROI for next week' : '',
    ].filter(Boolean).join('\n'),
  });

  return sections;
}

// ---------------------------------------------------------------------------
// AutoReporter
// ---------------------------------------------------------------------------

export class AutoReporter {
  private reports: ReportRecord[] = [];
  private schedule: ScheduleConfig = { ...DEFAULT_SCHEDULE };
  private schedulerTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private totalGenerated = 0;
  private failedCount = 0;
  private totalGenerationMs = 0;

  // -------------------------------------------------------------------------
  // Report generation
  // -------------------------------------------------------------------------

  async generateReport(type: ReportType, trigger: ReportTrigger = 'manual'): Promise<ReportRecord> {
    const startTime = Date.now();
    const reportId = uuidv4();
    const now = new Date();
    const { periodStart, periodEnd, title } = this.computePeriod(type, now);

    log.info({ reportId, type, trigger, periodStart, periodEnd }, 'Generating report');

    broadcast('meow:sovereign', {
      type: 'reports:generating',
      reportId,
      reportType: type,
    });

    // Collect data
    const metrics = await collectMetrics(periodStart, periodEnd);
    const prevData = await collectPreviousPeriodMetrics(type, periodStart, periodEnd);
    const comparison = computeComparison(metrics, prevData.metrics, prevData.start, prevData.end);

    // Try AI generation
    let sections: ReportSection[];
    let aiGenerated = false;

    const aiContent = await this.generateWithAI(type, title, metrics, comparison);
    if (aiContent) {
      sections = this.parseAISections(aiContent, type);
      aiGenerated = true;
    } else {
      sections = buildHeuristicReport(type, metrics, comparison);
    }

    const content = sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n---\n\n');

    const report: ReportRecord = {
      id: reportId,
      type,
      title,
      periodStart,
      periodEnd,
      status: 'completed',
      trigger,
      content,
      sections,
      metrics,
      comparison,
      aiGenerated,
      generationDurationMs: Date.now() - startTime,
      distributedVia: ['db', 'sse'],
      createdAt: now,
    };

    this.reports.push(report);
    if (this.reports.length > MAX_REPORTS_MEMORY) {
      this.reports = this.reports.slice(-Math.floor(MAX_REPORTS_MEMORY * 0.8));
    }

    this.totalGenerated += 1;
    this.totalGenerationMs += report.generationDurationMs;

    await this.persistReport(report);

    broadcast('meow:sovereign', {
      type: 'reports:completed',
      reportId,
      reportType: type,
      title,
      aiGenerated,
      durationMs: report.generationDurationMs,
    });

    // Email distribution if configured
    if (this.schedule.emailRecipients.length > 0) {
      await this.distributeEmail(report);
    }

    log.info({
      reportId, type, aiGenerated,
      durationMs: report.generationDurationMs,
    }, 'Report generated');

    return report;
  }

  // -------------------------------------------------------------------------
  // AI generation
  // -------------------------------------------------------------------------

  private async generateWithAI(
    type: ReportType,
    title: string,
    metrics: ReportMetrics,
    comparison: PeriodComparison,
  ): Promise<string | null> {
    const typeDescriptions: Record<ReportType, string> = {
      daily_executive: 'a concise daily executive summary focusing on key metrics, notable events, and any anomalies that need attention',
      weekly_performance: 'a comprehensive weekly performance analysis with trends, week-over-week comparisons, and actionable highlights',
      monthly_strategic: 'a deep monthly strategic analysis with trend forecasting, strategic recommendations, and resource allocation suggestions',
    };

    const systemPrompt =
      'You are the Gas Town Auto-Reporter, an AI system that generates operational reports for a digital marketing automation platform. '
      + `Generate ${typeDescriptions[type]}. `
      + 'Write in professional, data-driven language. Use markdown formatting. '
      + 'Structure the report with these sections: '
      + '## Executive Summary\n## Key Metrics\n## Highlights\n## Concerns\n## Recommendations'
      + (type === 'monthly_strategic' ? '\n## Forecast' : '')
      + '\nBe specific with numbers. Identify patterns and actionable insights.';

    const context = JSON.stringify({
      reportTitle: title,
      reportType: type,
      currentPeriod: {
        metrics,
        successRate: metrics.totalMolecules > 0
          ? `${Math.round((metrics.completedMolecules / metrics.totalMolecules) * 100)}%`
          : 'N/A',
      },
      comparison: {
        trend: comparison.trend,
        costChange: `${comparison.costChange}%`,
        moleculeChange: `${comparison.moleculeChange}%`,
        qualityChange: `${comparison.qualityChange}%`,
        efficiencyChange: `${comparison.efficiencyChange}%`,
        highlights: comparison.highlights,
      },
    }, null, 2);

    return callGeminiReport(systemPrompt, context);
  }

  private parseAISections(aiContent: string, type: ReportType): ReportSection[] {
    const sections: ReportSection[] = [];
    const sectionRegex = /##\s+(.+?)(?=\n##\s|\n*$)/gs;
    let match: RegExpExecArray | null;
    let order = 1;

    // Split by ## headers
    const parts = aiContent.split(/(?=## )/);

    for (const part of parts) {
      const headerMatch = part.match(/^##\s+(.+)/);
      if (!headerMatch) continue;

      const title = headerMatch[1].trim();
      const content = part.replace(/^##\s+.+\n*/, '').trim();

      const typeMap: Record<string, ReportSection['type']> = {
        'executive summary': 'summary',
        'summary': 'summary',
        'key metrics': 'metrics',
        'metrics': 'metrics',
        'highlights': 'highlights',
        'concerns': 'concerns',
        'recommendations': 'recommendations',
        'comparison': 'comparison',
        'forecast': 'forecast',
      };

      const sectionType = typeMap[title.toLowerCase()] ?? 'summary';

      sections.push({
        title,
        order: order++,
        content,
        type: sectionType,
      });
    }

    // If parsing failed, wrap entire content
    if (sections.length === 0) {
      sections.push({
        title: 'Report',
        order: 1,
        content: aiContent,
        type: 'summary',
      });
    }

    return sections;
  }

  // -------------------------------------------------------------------------
  // Period computation
  // -------------------------------------------------------------------------

  private computePeriod(type: ReportType, now: Date): { periodStart: Date; periodEnd: Date; title: string } {
    switch (type) {
      case 'daily_executive': {
        const end = new Date(now);
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        const dateStr = now.toISOString().slice(0, 10);
        return { periodStart: start, periodEnd: end, title: `Daily Executive Report — ${dateStr}` };
      }
      case 'weekly_performance': {
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const start = new Date(now);
        start.setDate(now.getDate() + mondayOffset);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        const weekStr = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
        return { periodStart: start, periodEnd: end, title: `Weekly Performance Report — ${weekStr}` };
      }
      case 'monthly_strategic': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        const monthStr = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        return { periodStart: start, periodEnd: end, title: `Monthly Strategic Report — ${monthStr}` };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  startScheduler(): void {
    if (!this.schedule.enabled) {
      log.info('Report scheduler disabled');
      return;
    }

    this.scheduleNext('daily_executive');
    this.scheduleNext('weekly_performance');
    this.scheduleNext('monthly_strategic');

    log.info('Report scheduler started');
  }

  private scheduleNext(type: ReportType): void {
    const now = new Date();
    const nextRun = this.getNextRunTime(type, now);
    const delayMs = nextRun.getTime() - now.getTime();

    if (delayMs <= 0) {
      // Already past schedule time — run now and schedule next
      this.generateReport(type, 'scheduled').catch(err =>
        log.error({ err, type }, 'Scheduled report generation failed'),
      );
      return;
    }

    // Cap to 24h to avoid setTimeout overflow issues
    const cappedDelay = Math.min(delayMs, 86_400_000);

    const timer = setTimeout(async () => {
      try {
        await this.generateReport(type, 'scheduled');
      } catch (err) {
        log.error({ err, type }, 'Scheduled report generation failed');
        this.failedCount += 1;
      }
      // Schedule next occurrence
      this.scheduleNext(type);
    }, cappedDelay);

    this.schedulerTimers.set(type, timer);

    log.info({ type, nextRun: nextRun.toISOString(), delayMs: cappedDelay }, 'Report scheduled');
  }

  private getNextRunTime(type: ReportType, now: Date): Date {
    const next = new Date(now);

    switch (type) {
      case 'daily_executive': {
        next.setHours(this.schedule.dailyHour, 0, 0, 0);
        if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
        return next;
      }
      case 'weekly_performance': {
        const dayDiff = (this.schedule.weeklyDay - now.getDay() + 7) % 7;
        next.setDate(now.getDate() + (dayDiff === 0 && now.getHours() >= this.schedule.weeklyHour ? 7 : dayDiff));
        next.setHours(this.schedule.weeklyHour, 0, 0, 0);
        return next;
      }
      case 'monthly_strategic': {
        next.setDate(this.schedule.monthlyDay);
        next.setHours(this.schedule.monthlyHour, 0, 0, 0);
        if (next.getTime() <= now.getTime()) next.setMonth(next.getMonth() + 1);
        return next;
      }
    }
  }

  updateSchedule(updates: Partial<ScheduleConfig>): void {
    Object.assign(this.schedule, updates);

    // Restart scheduler with new config
    this.stopScheduler();
    this.startScheduler();

    log.info({ schedule: this.schedule }, 'Report schedule updated');
  }

  stopScheduler(): void {
    this.schedulerTimers.forEach((timer) => clearTimeout(timer));
    this.schedulerTimers.clear();
    log.info('Report scheduler stopped');
  }

  // -------------------------------------------------------------------------
  // Email distribution
  // -------------------------------------------------------------------------

  private async distributeEmail(report: ReportRecord): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || this.schedule.emailRecipients.length === 0) return;

    try {
      const resp = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: 'Gas Town Reports <reports@gastown.ai>',
          to: this.schedule.emailRecipients,
          subject: report.title,
          html: `<pre style="font-family: monospace; white-space: pre-wrap;">${report.content}</pre>`,
        }),
      });

      if (resp.ok) {
        report.distributedVia.push('email');
        log.info({ reportId: report.id, recipients: this.schedule.emailRecipients.length }, 'Report emailed');
      } else {
        log.warn({ status: resp.status }, 'Failed to send report email');
      }
    } catch (err) {
      log.warn({ err }, 'Email distribution failed');
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getReport(reportId: string): ReportRecord | undefined {
    return this.reports.find(r => r.id === reportId);
  }

  queryReports(query: ReportQuery = {}): ReportRecord[] {
    let results = [...this.reports];

    if (query.type) results = results.filter(r => r.type === query.type);
    if (query.trigger) results = results.filter(r => r.trigger === query.trigger);
    if (query.from) results = results.filter(r => r.createdAt.getTime() >= query.from!.getTime());
    if (query.to) results = results.filter(r => r.createdAt.getTime() <= query.to!.getTime());

    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const limit = query.limit ?? 50;
    return results.slice(0, limit);
  }

  getLatestByType(type: ReportType): ReportRecord | undefined {
    for (let i = this.reports.length - 1; i >= 0; i--) {
      if (this.reports[i].type === type && this.reports[i].status === 'completed') {
        return this.reports[i];
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): ReporterStats {
    const byType: Record<ReportType, number> = {
      daily_executive: 0,
      weekly_performance: 0,
      monthly_strategic: 0,
    };

    let aiCount = 0;
    for (const r of this.reports) {
      if (byType[r.type] !== undefined) byType[r.type] += 1;
      if (r.aiGenerated) aiCount += 1;
    }

    const lastDaily = this.getLatestByType('daily_executive');
    const lastWeekly = this.getLatestByType('weekly_performance');
    const lastMonthly = this.getLatestByType('monthly_strategic');

    return {
      totalReports: this.totalGenerated,
      reportsByType: byType,
      avgGenerationMs: this.totalGenerated > 0
        ? Math.round(this.totalGenerationMs / this.totalGenerated)
        : 0,
      lastDailyAt: lastDaily?.createdAt,
      lastWeeklyAt: lastWeekly?.createdAt,
      lastMonthlyAt: lastMonthly?.createdAt,
      aiGeneratedPct: this.totalGenerated > 0
        ? Math.round((aiCount / this.totalGenerated) * 100)
        : 0,
      failedReports: this.failedCount,
    };
  }

  getSchedule(): ScheduleConfig {
    return { ...this.schedule };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistReport(report: ReportRecord): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_reports (id, type, title, period_start, period_end, status, trigger, content, sections, metrics, comparison, ai_generated, generation_duration_ms, error, distributed_via, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           content = EXCLUDED.content,
           sections = EXCLUDED.sections,
           metrics = EXCLUDED.metrics,
           comparison = EXCLUDED.comparison,
           generation_duration_ms = EXCLUDED.generation_duration_ms,
           error = EXCLUDED.error,
           distributed_via = EXCLUDED.distributed_via`,
        [
          report.id, report.type, report.title, report.periodStart, report.periodEnd,
          report.status, report.trigger, report.content,
          JSON.stringify(report.sections), JSON.stringify(report.metrics),
          report.comparison ? JSON.stringify(report.comparison) : null,
          report.aiGenerated, report.generationDurationMs,
          report.error ?? null, JSON.stringify(report.distributedVia),
          report.createdAt,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist report');
    }
  }

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_reports ORDER BY created_at DESC LIMIT $1`,
        [MAX_REPORTS_MEMORY],
      );

      for (const row of rows.reverse()) {
        this.reports.push({
          id: row.id,
          type: row.type,
          title: row.title,
          periodStart: new Date(row.period_start),
          periodEnd: new Date(row.period_end),
          status: row.status,
          trigger: row.trigger,
          content: row.content,
          sections: typeof row.sections === 'string' ? JSON.parse(row.sections) : (row.sections ?? []),
          metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : (row.metrics ?? {}),
          comparison: row.comparison ? (typeof row.comparison === 'string' ? JSON.parse(row.comparison) : row.comparison) : undefined,
          aiGenerated: row.ai_generated ?? false,
          generationDurationMs: row.generation_duration_ms ?? 0,
          error: row.error,
          distributedVia: typeof row.distributed_via === 'string' ? JSON.parse(row.distributed_via) : (row.distributed_via ?? []),
          createdAt: new Date(row.created_at),
        });
      }

      this.totalGenerated = this.reports.length;
      this.failedCount = this.reports.filter(r => r.status === 'failed').length;

      log.info({ reports: rows.length }, 'Loaded report history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load report history from DB');
    }
  }

  /** Cleanup: stop scheduler on shutdown */
  shutdown(): void {
    this.stopScheduler();
    log.info('Auto-reporter shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AutoReporter | null = null;

export function getAutoReporter(): AutoReporter {
  if (!instance) {
    instance = new AutoReporter();
  }
  return instance;
}
