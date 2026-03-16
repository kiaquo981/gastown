/**
 * CONTINUOUS IMPROVEMENT ENGINE -- CG-031 (Stage 05 Wave 8)
 *
 * Autonomous continuous improvement engine for the MEOW system.
 * Aggregates data from all cognitive modules: quality scores, performance, costs, errors.
 * Identifies improvement opportunities using AI analysis.
 * Generates improvement proposals: parameter tweaks, workflow changes, skill substitutions.
 * Tracks proposal lifecycle: proposed -> approved -> applied -> measured.
 * ROI estimation for each proposal before application.
 * Automatic rollback if applied change degrades metrics.
 * Weekly improvement digest: top 5 actionable suggestions.
 * DB table: meow_improvements.
 * Configurable auto-apply threshold (default: only auto-apply if estimated > 10% improvement and risk < low).
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('continuous-improvement');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalStatus = 'proposed' | 'approved' | 'applied' | 'measured' | 'rolled_back' | 'rejected';

export type ProposalCategory =
  | 'parameter_tweak'
  | 'workflow_change'
  | 'skill_substitution'
  | 'resource_reallocation'
  | 'formula_optimization'
  | 'cost_reduction'
  | 'quality_improvement';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ROIEstimate {
  expectedImprovementPct: number;   // e.g. 15.0 = 15% improvement
  costSavingsUsd: number;           // estimated monthly savings
  timeSavingsMs: number;            // estimated per-execution savings
  qualityImpact: number;            // -10 to +10
  confidenceLevel: number;          // 0.0-1.0
  riskLevel: RiskLevel;
  rationale: string;
}

export interface Proposal {
  id: string;
  title: string;
  description: string;
  category: ProposalCategory;
  status: ProposalStatus;
  priority: number;                 // 1-5, higher = more urgent
  source: string;                   // which cognitive module suggested this
  targetEntity: string;             // formula name, skill name, worker id, etc.
  targetEntityType: 'formula' | 'skill' | 'worker' | 'system';
  currentValue: string;             // current setting/config
  proposedValue: string;            // proposed change
  roi: ROIEstimate;
  preApplyMetrics?: Record<string, number>;   // metrics snapshot before applying
  postApplyMetrics?: Record<string, number>;  // metrics snapshot after applying
  rollbackReason?: string;
  createdAt: Date;
  approvedAt?: Date;
  appliedAt?: Date;
  measuredAt?: Date;
  rolledBackAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ImprovementDigest {
  generatedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  totalProposals: number;
  appliedCount: number;
  rolledBackCount: number;
  netImprovementPct: number;
  topSuggestions: Array<{
    title: string;
    category: ProposalCategory;
    expectedImprovementPct: number;
    riskLevel: RiskLevel;
    priority: number;
  }>;
  summary: string;
}

export interface ImprovementStats {
  totalProposals: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  avgROI: number;
  successRate: number;              // applied & not rolled back / total applied
  avgTimeToApply: number;           // ms from proposed to applied
}

// Auto-apply thresholds
const DEFAULT_AUTO_APPLY_MIN_IMPROVEMENT = 10; // 10%
const DEFAULT_AUTO_APPLY_MAX_RISK: RiskLevel = 'low';
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

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
              content: 'You are a continuous improvement analyst for an AI orchestration system. Identify improvement opportunities and generate actionable proposals. Respond only with valid JSON.',
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
    log.warn({ err }, 'Gemini call failed in continuous-improvement');
    return null;
  }
}

// ---------------------------------------------------------------------------
// ContinuousImprovementEngine
// ---------------------------------------------------------------------------

export class ContinuousImprovementEngine {
  private proposals: Proposal[] = [];
  private maxInMemory = 2_000;
  private autoApplyMinImprovement = DEFAULT_AUTO_APPLY_MIN_IMPROVEMENT;
  private autoApplyMaxRisk: RiskLevel = DEFAULT_AUTO_APPLY_MAX_RISK;

  // --- Generate proposals from aggregated data ------------------------------

  async generateProposals(aggregatedData: {
    qualityScores?: Array<{ entity: string; entityType: string; avgScore: number; count: number }>;
    performanceMetrics?: Array<{ entity: string; avgDurationMs: number; successRate: number; count: number }>;
    costData?: Array<{ entity: string; totalCostUsd: number; count: number }>;
    errorPatterns?: Array<{ entity: string; errorType: string; frequency: number }>;
    recentChanges?: Array<{ entity: string; change: string; impact: string }>;
  }): Promise<Proposal[]> {
    const newProposals: Proposal[] = [];

    // Try AI-powered proposal generation
    const aiProposals = await this.generateWithGemini(aggregatedData);
    if (aiProposals && aiProposals.length > 0) {
      for (const p of aiProposals) {
        const proposal = this.createProposal(p);
        newProposals.push(proposal);
      }
      log.info({ count: aiProposals.length }, 'AI-generated improvement proposals');
    }

    // Heuristic proposals (always run as supplement)
    const heuristicProposals = this.generateHeuristicProposals(aggregatedData);
    for (const p of heuristicProposals) {
      const proposal = this.createProposal(p);
      newProposals.push(proposal);
    }

    // Persist and broadcast
    for (const proposal of newProposals) {
      await this.persistProposal(proposal);
      broadcast('meow:cognitive', {
        type: 'improvement_proposed',
        proposalId: proposal.id,
        title: proposal.title,
        category: proposal.category,
        expectedImprovement: proposal.roi.expectedImprovementPct,
        riskLevel: proposal.roi.riskLevel,
      });
    }

    // Check auto-apply eligibility
    for (const proposal of newProposals) {
      if (this.isEligibleForAutoApply(proposal)) {
        log.info({ proposalId: proposal.id, title: proposal.title }, 'Proposal eligible for auto-apply');
        broadcast('meow:cognitive', {
          type: 'improvement_auto_apply_eligible',
          proposalId: proposal.id,
          title: proposal.title,
        });
      }
    }

    return newProposals;
  }

  // --- Approve a proposal ---------------------------------------------------

  async approveProposal(proposalId: string): Promise<Proposal | null> {
    const proposal = this.findProposal(proposalId);
    if (!proposal || proposal.status !== 'proposed') return null;

    proposal.status = 'approved';
    proposal.approvedAt = new Date();

    await this.persistProposal(proposal);

    broadcast('meow:cognitive', {
      type: 'improvement_approved',
      proposalId: proposal.id,
      title: proposal.title,
    });

    log.info({ proposalId: proposal.id }, 'Proposal approved');
    return proposal;
  }

  // --- Apply a proposal (record pre-apply metrics) --------------------------

  async applyProposal(proposalId: string, preApplyMetrics: Record<string, number>): Promise<Proposal | null> {
    const proposal = this.findProposal(proposalId);
    if (!proposal || (proposal.status !== 'approved' && proposal.status !== 'proposed')) return null;

    proposal.status = 'applied';
    proposal.appliedAt = new Date();
    proposal.preApplyMetrics = preApplyMetrics;

    if (!proposal.approvedAt) {
      proposal.approvedAt = new Date(); // auto-approved
    }

    await this.persistProposal(proposal);

    broadcast('meow:cognitive', {
      type: 'improvement_applied',
      proposalId: proposal.id,
      title: proposal.title,
      category: proposal.category,
    });

    log.info({ proposalId: proposal.id, title: proposal.title }, 'Proposal applied');
    return proposal;
  }

  // --- Measure results after applying ---------------------------------------

  async measureResults(proposalId: string, postApplyMetrics: Record<string, number>): Promise<{
    improved: boolean;
    shouldRollback: boolean;
    actualImprovementPct: number;
  }> {
    const proposal = this.findProposal(proposalId);
    if (!proposal || proposal.status !== 'applied') {
      return { improved: false, shouldRollback: false, actualImprovementPct: 0 };
    }

    proposal.postApplyMetrics = postApplyMetrics;
    proposal.measuredAt = new Date();
    proposal.status = 'measured';

    // Compare pre and post metrics
    const preMetrics = proposal.preApplyMetrics ?? {};
    let totalImprovement = 0;
    let metricCount = 0;
    let degradedCount = 0;

    for (const [key, postVal] of Object.entries(postApplyMetrics)) {
      const preVal = preMetrics[key];
      if (preVal != null && preVal > 0) {
        const changePct = ((postVal - preVal) / preVal) * 100;
        totalImprovement += changePct;
        metricCount++;
        if (changePct < -5) degradedCount++; // more than 5% degradation
      }
    }

    const actualImprovementPct = metricCount > 0 ? totalImprovement / metricCount : 0;
    const improved = actualImprovementPct > 0;
    const shouldRollback = degradedCount > metricCount / 2 || actualImprovementPct < -10;

    if (shouldRollback) {
      proposal.status = 'rolled_back';
      proposal.rolledBackAt = new Date();
      proposal.rollbackReason = `Degraded ${degradedCount}/${metricCount} metrics. Avg change: ${actualImprovementPct.toFixed(1)}%`;

      broadcast('meow:cognitive', {
        type: 'improvement_rolled_back',
        proposalId: proposal.id,
        title: proposal.title,
        reason: proposal.rollbackReason,
      });

      log.warn({ proposalId: proposal.id, actualImprovementPct }, 'Proposal rolled back due to metric degradation');
    } else {
      broadcast('meow:cognitive', {
        type: 'improvement_measured',
        proposalId: proposal.id,
        title: proposal.title,
        actualImprovementPct: Math.round(actualImprovementPct * 10) / 10,
        improved,
      });

      log.info({ proposalId: proposal.id, actualImprovementPct, improved }, 'Proposal results measured');
    }

    await this.persistProposal(proposal);

    return {
      improved,
      shouldRollback,
      actualImprovementPct: Math.round(actualImprovementPct * 10) / 10,
    };
  }

  // --- Reject a proposal ----------------------------------------------------

  async rejectProposal(proposalId: string, reason?: string): Promise<Proposal | null> {
    const proposal = this.findProposal(proposalId);
    if (!proposal || proposal.status !== 'proposed') return null;

    proposal.status = 'rejected';
    proposal.rollbackReason = reason ?? 'Manually rejected';

    await this.persistProposal(proposal);

    broadcast('meow:cognitive', {
      type: 'improvement_rejected',
      proposalId: proposal.id,
      title: proposal.title,
    });

    log.info({ proposalId: proposal.id }, 'Proposal rejected');
    return proposal;
  }

  // --- Generate weekly digest -----------------------------------------------

  async generateDigest(periodDays = 7): Promise<ImprovementDigest> {
    const now = new Date();
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    const periodProposals = this.proposals.filter(p => p.createdAt >= periodStart);
    const appliedProposals = periodProposals.filter(p => p.status === 'measured' || p.status === 'applied');
    const rolledBack = periodProposals.filter(p => p.status === 'rolled_back');

    // Net improvement: average actual improvement of measured proposals
    const measuredProposals = periodProposals.filter(
      p => p.status === 'measured' && p.preApplyMetrics && p.postApplyMetrics,
    );
    let netImprovement = 0;
    if (measuredProposals.length > 0) {
      for (const p of measuredProposals) {
        const preVals = Object.values(p.preApplyMetrics ?? {});
        const postVals = Object.values(p.postApplyMetrics ?? {});
        if (preVals.length > 0 && postVals.length > 0) {
          const preAvg = preVals.reduce((s, v) => s + v, 0) / preVals.length;
          const postAvg = postVals.reduce((s, v) => s + v, 0) / postVals.length;
          if (preAvg > 0) netImprovement += ((postAvg - preAvg) / preAvg) * 100;
        }
      }
      netImprovement = netImprovement / measuredProposals.length;
    }

    // Top suggestions: pending proposals sorted by priority and ROI
    const pending = this.proposals
      .filter(p => p.status === 'proposed')
      .sort((a, b) => {
        const priorityDiff = b.priority - a.priority;
        if (priorityDiff !== 0) return priorityDiff;
        return b.roi.expectedImprovementPct - a.roi.expectedImprovementPct;
      })
      .slice(0, 5);

    // Generate AI summary if available
    const summaryText = await this.generateDigestSummary(
      periodProposals.length,
      appliedProposals.length,
      rolledBack.length,
      netImprovement,
      pending,
    );

    const digest: ImprovementDigest = {
      generatedAt: now,
      periodStart,
      periodEnd: now,
      totalProposals: periodProposals.length,
      appliedCount: appliedProposals.length,
      rolledBackCount: rolledBack.length,
      netImprovementPct: Math.round(netImprovement * 10) / 10,
      topSuggestions: pending.map(p => ({
        title: p.title,
        category: p.category,
        expectedImprovementPct: p.roi.expectedImprovementPct,
        riskLevel: p.roi.riskLevel,
        priority: p.priority,
      })),
      summary: summaryText,
    };

    broadcast('meow:cognitive', {
      type: 'improvement_digest_generated',
      totalProposals: digest.totalProposals,
      appliedCount: digest.appliedCount,
      netImprovementPct: digest.netImprovementPct,
      topSuggestionCount: digest.topSuggestions.length,
    });

    log.info({ totalProposals: digest.totalProposals, netImprovement }, 'Weekly improvement digest generated');
    return digest;
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): ImprovementStats {
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let totalROI = 0;
    let appliedCount = 0;
    let notRolledBack = 0;
    let totalTimeToApply = 0;
    let applyTimeCount = 0;

    for (const p of this.proposals) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
      totalROI += p.roi.expectedImprovementPct;

      if (p.status === 'applied' || p.status === 'measured') {
        appliedCount++;
        notRolledBack++;
      }
      if (p.status === 'rolled_back') {
        appliedCount++;
        // rolled_back: counted as applied but not as successful
      }
      if (p.appliedAt && p.createdAt) {
        totalTimeToApply += p.appliedAt.getTime() - p.createdAt.getTime();
        applyTimeCount++;
      }
    }

    return {
      totalProposals: this.proposals.length,
      byStatus,
      byCategory,
      avgROI: this.proposals.length > 0
        ? Math.round((totalROI / this.proposals.length) * 10) / 10
        : 0,
      successRate: appliedCount > 0
        ? Math.round((notRolledBack / appliedCount) * 1000) / 1000
        : 0,
      avgTimeToApply: applyTimeCount > 0
        ? Math.round(totalTimeToApply / applyTimeCount)
        : 0,
    };
  }

  // --- List proposals -------------------------------------------------------

  listProposals(params?: {
    status?: ProposalStatus;
    category?: ProposalCategory;
    limit?: number;
  }): Proposal[] {
    let filtered = this.proposals;
    if (params?.status) filtered = filtered.filter(p => p.status === params.status);
    if (params?.category) filtered = filtered.filter(p => p.category === params.category);

    return filtered
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, params?.limit ?? 50);
  }

  // --- Load from DB ---------------------------------------------------------

  async loadFromDb(days = 90): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, title, description, category, status, priority, source,
                target_entity, target_entity_type, current_value, proposed_value,
                roi, pre_apply_metrics, post_apply_metrics, rollback_reason,
                created_at, approved_at, applied_at, measured_at, rolled_back_at, metadata
         FROM meow_improvements
         WHERE created_at > NOW() - INTERVAL '${days} days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.maxInMemory],
      );

      this.proposals = rows.map((r: Record<string, unknown>) => this.rowToProposal(r));
      log.info({ count: this.proposals.length, days }, 'Loaded improvement proposals from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load improvement proposals from DB');
    }
  }

  // --- Configuration --------------------------------------------------------

  setAutoApplyThresholds(minImprovement: number, maxRisk: RiskLevel): void {
    this.autoApplyMinImprovement = minImprovement;
    this.autoApplyMaxRisk = maxRisk;
    log.info({ minImprovement, maxRisk }, 'Auto-apply thresholds updated');
  }

  getProposalCount(): number {
    return this.proposals.length;
  }

  // --- Private helpers ------------------------------------------------------

  private createProposal(input: {
    title: string;
    description: string;
    category: ProposalCategory;
    priority: number;
    source: string;
    targetEntity: string;
    targetEntityType: 'formula' | 'skill' | 'worker' | 'system';
    currentValue: string;
    proposedValue: string;
    roi: ROIEstimate;
    metadata?: Record<string, unknown>;
  }): Proposal {
    const proposal: Proposal = {
      id: uuidv4(),
      ...input,
      status: 'proposed',
      createdAt: new Date(),
    };

    this.proposals.push(proposal);
    if (this.proposals.length > this.maxInMemory) {
      this.proposals = this.proposals.slice(-this.maxInMemory);
    }

    return proposal;
  }

  private isEligibleForAutoApply(proposal: Proposal): boolean {
    return (
      proposal.roi.expectedImprovementPct >= this.autoApplyMinImprovement &&
      RISK_ORDER[proposal.roi.riskLevel] <= RISK_ORDER[this.autoApplyMaxRisk] &&
      proposal.roi.confidenceLevel >= 0.7
    );
  }

  private generateHeuristicProposals(data: {
    qualityScores?: Array<{ entity: string; entityType: string; avgScore: number; count: number }>;
    performanceMetrics?: Array<{ entity: string; avgDurationMs: number; successRate: number; count: number }>;
    costData?: Array<{ entity: string; totalCostUsd: number; count: number }>;
    errorPatterns?: Array<{ entity: string; errorType: string; frequency: number }>;
  }): Array<{
    title: string;
    description: string;
    category: ProposalCategory;
    priority: number;
    source: string;
    targetEntity: string;
    targetEntityType: 'formula' | 'skill' | 'worker' | 'system';
    currentValue: string;
    proposedValue: string;
    roi: ROIEstimate;
  }> {
    const proposals: ReturnType<ContinuousImprovementEngine['generateHeuristicProposals']> = [];

    // Low quality entities
    if (data.qualityScores) {
      for (const qs of data.qualityScores) {
        if (qs.avgScore < 6.0 && qs.count >= 5) {
          proposals.push({
            title: `Improve quality for ${qs.entity}`,
            description: `${qs.entity} has average quality score ${qs.avgScore.toFixed(1)} across ${qs.count} executions. Consider prompt refinement or skill substitution.`,
            category: 'quality_improvement',
            priority: qs.avgScore < 4 ? 5 : 3,
            source: 'heuristic:quality_threshold',
            targetEntity: qs.entity,
            targetEntityType: qs.entityType as 'formula' | 'skill' | 'worker' | 'system',
            currentValue: `avg_quality=${qs.avgScore.toFixed(1)}`,
            proposedValue: 'target_quality>=7.0',
            roi: {
              expectedImprovementPct: Math.round((7.0 - qs.avgScore) / qs.avgScore * 100),
              costSavingsUsd: 0,
              timeSavingsMs: 0,
              qualityImpact: Math.round(7.0 - qs.avgScore),
              confidenceLevel: 0.6,
              riskLevel: 'low',
              rationale: `Quality below 6.0 threshold. ${qs.count} samples.`,
            },
          });
        }
      }
    }

    // Low success rate
    if (data.performanceMetrics) {
      for (const pm of data.performanceMetrics) {
        if (pm.successRate < 0.8 && pm.count >= 10) {
          proposals.push({
            title: `Improve reliability for ${pm.entity}`,
            description: `${pm.entity} has ${Math.round(pm.successRate * 100)}% success rate (${pm.count} executions). Add retry logic or investigate error patterns.`,
            category: 'formula_optimization',
            priority: pm.successRate < 0.5 ? 5 : 4,
            source: 'heuristic:success_rate',
            targetEntity: pm.entity,
            targetEntityType: 'formula',
            currentValue: `success_rate=${pm.successRate.toFixed(3)}`,
            proposedValue: 'target_success_rate>=0.9',
            roi: {
              expectedImprovementPct: Math.round((0.9 - pm.successRate) * 100),
              costSavingsUsd: 0,
              timeSavingsMs: 0,
              qualityImpact: 3,
              confidenceLevel: 0.7,
              riskLevel: 'medium',
              rationale: `Success rate ${Math.round(pm.successRate * 100)}% is below 80% threshold.`,
            },
          });
        }

        // Slow execution
        if (pm.avgDurationMs > 60_000 && pm.count >= 5) {
          proposals.push({
            title: `Optimize execution time for ${pm.entity}`,
            description: `${pm.entity} averages ${Math.round(pm.avgDurationMs / 1000)}s per execution. Consider parallelization or caching.`,
            category: 'parameter_tweak',
            priority: pm.avgDurationMs > 180_000 ? 4 : 2,
            source: 'heuristic:slow_execution',
            targetEntity: pm.entity,
            targetEntityType: 'formula',
            currentValue: `avg_duration=${Math.round(pm.avgDurationMs)}ms`,
            proposedValue: `target_duration<${Math.round(pm.avgDurationMs * 0.7)}ms`,
            roi: {
              expectedImprovementPct: 30,
              costSavingsUsd: 0,
              timeSavingsMs: Math.round(pm.avgDurationMs * 0.3),
              qualityImpact: 0,
              confidenceLevel: 0.5,
              riskLevel: 'low',
              rationale: `Average execution time ${Math.round(pm.avgDurationMs / 1000)}s.`,
            },
          });
        }
      }
    }

    // High cost entities
    if (data.costData) {
      const sorted = [...data.costData].sort((a, b) => {
        const costPerExecA = a.count > 0 ? a.totalCostUsd / a.count : 0;
        const costPerExecB = b.count > 0 ? b.totalCostUsd / b.count : 0;
        return costPerExecB - costPerExecA;
      });

      for (const cd of sorted.slice(0, 3)) {
        const costPerExec = cd.count > 0 ? cd.totalCostUsd / cd.count : 0;
        if (costPerExec > 0.10 && cd.count >= 5) {
          proposals.push({
            title: `Reduce cost for ${cd.entity}`,
            description: `${cd.entity} costs $${costPerExec.toFixed(4)}/execution ($${cd.totalCostUsd.toFixed(2)} total, ${cd.count} executions). Consider using a lower tier model or caching.`,
            category: 'cost_reduction',
            priority: costPerExec > 0.50 ? 4 : 2,
            source: 'heuristic:high_cost',
            targetEntity: cd.entity,
            targetEntityType: 'skill',
            currentValue: `cost_per_exec=$${costPerExec.toFixed(4)}`,
            proposedValue: `target_cost<$${(costPerExec * 0.6).toFixed(4)}`,
            roi: {
              expectedImprovementPct: 0,
              costSavingsUsd: cd.totalCostUsd * 0.4,
              timeSavingsMs: 0,
              qualityImpact: -1,
              confidenceLevel: 0.6,
              riskLevel: 'medium',
              rationale: `High per-execution cost. Potential 40% reduction with model tier change.`,
            },
          });
        }
      }
    }

    // Frequent errors
    if (data.errorPatterns) {
      for (const ep of data.errorPatterns) {
        if (ep.frequency >= 5) {
          proposals.push({
            title: `Address recurring error in ${ep.entity}: ${ep.errorType}`,
            description: `${ep.entity} has ${ep.frequency} occurrences of "${ep.errorType}". Needs investigation and fix.`,
            category: 'formula_optimization',
            priority: ep.frequency >= 20 ? 5 : 3,
            source: 'heuristic:error_pattern',
            targetEntity: ep.entity,
            targetEntityType: 'formula',
            currentValue: `error_frequency=${ep.frequency}`,
            proposedValue: 'error_frequency=0',
            roi: {
              expectedImprovementPct: Math.min(50, ep.frequency * 2),
              costSavingsUsd: 0,
              timeSavingsMs: 0,
              qualityImpact: 5,
              confidenceLevel: 0.8,
              riskLevel: 'low',
              rationale: `Recurring error pattern with ${ep.frequency} occurrences.`,
            },
          });
        }
      }
    }

    return proposals;
  }

  private async generateWithGemini(data: Record<string, unknown>): Promise<Array<{
    title: string;
    description: string;
    category: ProposalCategory;
    priority: number;
    source: string;
    targetEntity: string;
    targetEntityType: 'formula' | 'skill' | 'worker' | 'system';
    currentValue: string;
    proposedValue: string;
    roi: ROIEstimate;
  }> | null> {
    const prompt = `Analyze this system performance data and suggest improvement proposals.

DATA:
${JSON.stringify(data, null, 2).slice(0, 3000)}

Generate 2-5 improvement proposals. Respond with JSON array:
[{
  "title": "short title",
  "description": "detailed description",
  "category": "parameter_tweak|workflow_change|skill_substitution|resource_reallocation|formula_optimization|cost_reduction|quality_improvement",
  "priority": 1-5,
  "source": "ai_analysis",
  "targetEntity": "entity name",
  "targetEntityType": "formula|skill|worker|system",
  "currentValue": "current state",
  "proposedValue": "proposed change",
  "roi": {
    "expectedImprovementPct": number,
    "costSavingsUsd": number,
    "timeSavingsMs": number,
    "qualityImpact": -10 to 10,
    "confidenceLevel": 0.0-1.0,
    "riskLevel": "low|medium|high|critical",
    "rationale": "why this improvement"
  }
}]`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>;
      return parsed
        .filter(p => p.title && p.description && p.category)
        .map(p => ({
          title: String(p.title),
          description: String(p.description),
          category: (p.category as ProposalCategory) ?? 'parameter_tweak',
          priority: Math.max(1, Math.min(5, Number(p.priority) || 3)),
          source: 'ai_analysis',
          targetEntity: String(p.targetEntity ?? 'system'),
          targetEntityType: (p.targetEntityType as 'formula' | 'skill' | 'worker' | 'system') ?? 'system',
          currentValue: String(p.currentValue ?? 'unknown'),
          proposedValue: String(p.proposedValue ?? 'unknown'),
          roi: {
            expectedImprovementPct: Number((p.roi as Record<string, unknown>)?.expectedImprovementPct ?? 5),
            costSavingsUsd: Number((p.roi as Record<string, unknown>)?.costSavingsUsd ?? 0),
            timeSavingsMs: Number((p.roi as Record<string, unknown>)?.timeSavingsMs ?? 0),
            qualityImpact: Number((p.roi as Record<string, unknown>)?.qualityImpact ?? 0),
            confidenceLevel: Math.max(0, Math.min(1, Number((p.roi as Record<string, unknown>)?.confidenceLevel ?? 0.5))),
            riskLevel: ((p.roi as Record<string, unknown>)?.riskLevel as RiskLevel) ?? 'medium',
            rationale: String((p.roi as Record<string, unknown>)?.rationale ?? 'AI-generated proposal'),
          },
        }));
    } catch {
      log.warn('Failed to parse Gemini improvement proposals');
      return null;
    }
  }

  private async generateDigestSummary(
    total: number,
    applied: number,
    rolledBack: number,
    netImprovement: number,
    pending: Proposal[],
  ): Promise<string> {
    const prompt = `Generate a 2-3 sentence summary for this weekly improvement digest:
- ${total} proposals generated
- ${applied} applied, ${rolledBack} rolled back
- Net improvement: ${netImprovement.toFixed(1)}%
- Top pending: ${pending.map(p => p.title).join(', ') || 'none'}

Be concise and actionable.`;

    const raw = await callGemini(prompt);
    if (raw) return raw.replace(/^"|"$/g, '').trim();

    // Heuristic summary
    const statusLine = applied > 0
      ? `${applied} changes applied (${rolledBack} rolled back), net ${netImprovement.toFixed(1)}% improvement.`
      : 'No changes applied this period.';
    const pendingLine = pending.length > 0
      ? `Top pending: ${pending.slice(0, 3).map(p => p.title).join('; ')}.`
      : 'No pending proposals.';

    return `${total} improvement proposals generated. ${statusLine} ${pendingLine}`;
  }

  private findProposal(id: string): Proposal | null {
    return this.proposals.find(p => p.id === id) ?? null;
  }

  private async persistProposal(proposal: Proposal): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_improvements
          (id, title, description, category, status, priority, source,
           target_entity, target_entity_type, current_value, proposed_value,
           roi, pre_apply_metrics, post_apply_metrics, rollback_reason,
           created_at, approved_at, applied_at, measured_at, rolled_back_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           pre_apply_metrics = EXCLUDED.pre_apply_metrics,
           post_apply_metrics = EXCLUDED.post_apply_metrics,
           rollback_reason = EXCLUDED.rollback_reason,
           approved_at = EXCLUDED.approved_at,
           applied_at = EXCLUDED.applied_at,
           measured_at = EXCLUDED.measured_at,
           rolled_back_at = EXCLUDED.rolled_back_at`,
        [
          proposal.id,
          proposal.title,
          proposal.description,
          proposal.category,
          proposal.status,
          proposal.priority,
          proposal.source,
          proposal.targetEntity,
          proposal.targetEntityType,
          proposal.currentValue,
          proposal.proposedValue,
          JSON.stringify(proposal.roi),
          proposal.preApplyMetrics ? JSON.stringify(proposal.preApplyMetrics) : null,
          proposal.postApplyMetrics ? JSON.stringify(proposal.postApplyMetrics) : null,
          proposal.rollbackReason ?? null,
          proposal.createdAt.toISOString(),
          proposal.approvedAt?.toISOString() ?? null,
          proposal.appliedAt?.toISOString() ?? null,
          proposal.measuredAt?.toISOString() ?? null,
          proposal.rolledBackAt?.toISOString() ?? null,
          proposal.metadata ? JSON.stringify(proposal.metadata) : null,
        ],
      );
    } catch (err) {
      log.warn({ err, proposalId: proposal.id }, 'Failed to persist improvement proposal');
    }
  }

  private rowToProposal(r: Record<string, unknown>): Proposal {
    const parseJson = (val: unknown) => {
      if (val == null) return undefined;
      if (typeof val === 'string') return JSON.parse(val);
      return val;
    };

    return {
      id: r.id as string,
      title: r.title as string,
      description: (r.description as string) ?? '',
      category: r.category as ProposalCategory,
      status: r.status as ProposalStatus,
      priority: parseInt(String(r.priority ?? '3'), 10),
      source: (r.source as string) ?? 'unknown',
      targetEntity: (r.target_entity as string) ?? '',
      targetEntityType: (r.target_entity_type as 'formula' | 'skill' | 'worker' | 'system') ?? 'system',
      currentValue: (r.current_value as string) ?? '',
      proposedValue: (r.proposed_value as string) ?? '',
      roi: parseJson(r.roi) as ROIEstimate ?? {
        expectedImprovementPct: 0,
        costSavingsUsd: 0,
        timeSavingsMs: 0,
        qualityImpact: 0,
        confidenceLevel: 0,
        riskLevel: 'medium' as RiskLevel,
        rationale: '',
      },
      preApplyMetrics: parseJson(r.pre_apply_metrics) as Record<string, number> | undefined,
      postApplyMetrics: parseJson(r.post_apply_metrics) as Record<string, number> | undefined,
      rollbackReason: (r.rollback_reason as string) ?? undefined,
      createdAt: new Date((r.created_at as string) ?? Date.now()),
      approvedAt: r.approved_at ? new Date(r.approved_at as string) : undefined,
      appliedAt: r.applied_at ? new Date(r.applied_at as string) : undefined,
      measuredAt: r.measured_at ? new Date(r.measured_at as string) : undefined,
      rolledBackAt: r.rolled_back_at ? new Date(r.rolled_back_at as string) : undefined,
      metadata: parseJson(r.metadata) as Record<string, unknown> | undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ContinuousImprovementEngine | null = null;

export function getContinuousImprovementEngine(): ContinuousImprovementEngine {
  if (!instance) {
    instance = new ContinuousImprovementEngine();
    log.info('ContinuousImprovementEngine singleton created');
  }
  return instance;
}
