/**
 * AUTO-APPROVE ENGINE -- CG-025 (Stage 05 Wave 7)
 *
 * Autonomous approval engine for low-risk operations.
 * Classifies operations by risk level and auto-approves low-risk ones
 * while requiring human approval for high-risk/critical actions.
 *
 * Risk assessment pipeline:
 *   1. Analyze bead skill chain and capabilities required
 *   2. Estimate cost and blast radius
 *   3. Check reversibility of the operation
 *   4. AI-powered assessment for ambiguous cases via Gemini
 *   5. Time-based escalation for medium-risk awaiting human approval
 *
 * Configurable thresholds per organization/team.
 * Full audit trail in meow_approvals DB table.
 *
 * Gas Town: "Don't ask permission for every drop of fuel — only for the tanker."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('auto-approve-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskCategory = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalStatus = 'auto_approved' | 'pending' | 'approved' | 'rejected' | 'escalated' | 'timed_out';

export interface ApprovalRequest {
  id: string;
  beadId: string;
  moleculeId?: string;
  requestedBy: string;              // worker ID
  riskCategory: RiskCategory;
  riskScore: number;                // 0 - 100
  riskFactors: RiskFactor[];
  status: ApprovalStatus;
  approvedBy?: string;              // worker ID or 'system' for auto
  rejectionReason?: string;
  skillChain: string[];             // ordered skills to be executed
  estimatedCostUsd: number;
  blastRadius: BlastRadius;
  reversible: boolean;
  aiAssessment?: string;            // Gemini risk narrative
  timeoutMinutes: number;
  expiresAt: Date;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface RiskFactor {
  name: string;
  weight: number;                   // 0.0 - 1.0
  score: number;                    // 0 - 100
  description: string;
}

export type BlastRadius = 'none' | 'single_bead' | 'molecule' | 'convoy' | 'system_wide';

export interface ApprovalThresholds {
  orgId?: string;
  teamId?: string;
  autoApproveBudgetUsd: number;     // max cost for auto-approve
  autoApproveRiskScore: number;     // max risk score for auto-approve (0-100)
  mediumRiskTimeoutMin: number;     // minutes before medium-risk escalates
  highRiskTimeoutMin: number;       // minutes before high-risk escalates
  requireHumanForExternal: boolean; // require human for external API writes
  requireHumanForDeploy: boolean;   // require human for deployments
}

export interface ApprovalPolicy {
  name: string;
  description: string;
  riskCategory: RiskCategory;
  autoApprove: boolean;
  patterns: string[];               // capability/skill patterns matched
}

export interface ApprovalStats {
  totalRequests: number;
  autoApprovedCount: number;
  humanApprovedCount: number;
  rejectedCount: number;
  escalatedCount: number;
  timedOutCount: number;
  avgRiskScore: number;
  avgResolutionTimeMs: number;
  autoApproveRate: number;
  byCategory: Record<RiskCategory, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Capabilities that always require human approval */
const HIGH_RISK_CAPABILITIES = new Set([
  'BudgetSpend',
  'MetaAdsManage',
  'GoogleAdsManage',
  'ShopifyManage',
  'GitPush',
  'PRCreate',
  'WhatsAppSend',
]);

/** Capabilities considered read-only / non-destructive */
const READ_ONLY_CAPABILITIES = new Set([
  'FileRead',
  'DbQuery',
  'LLMCall',
]);

/** Skills that are inherently low-risk */
const LOW_RISK_SKILLS = new Set([
  'data-analysis',
  'report-gen',
  'research',
  'code-review',
  'qa-check',
  'monitor',
  'alert-check',
  'translate',
]);

/** Skills that are inherently high-risk */
const HIGH_RISK_SKILLS = new Set([
  'deploy',
  'meta-ads',
  'google-ads',
  'campaign-gen',
  'shopify-manage',
]);

/** Default approval thresholds */
const DEFAULT_THRESHOLDS: ApprovalThresholds = {
  autoApproveBudgetUsd: 50,
  autoApproveRiskScore: 30,
  mediumRiskTimeoutMin: 30,
  highRiskTimeoutMin: 60,
  requireHumanForExternal: true,
  requireHumanForDeploy: true,
};

/** Default approval policies */
const DEFAULT_POLICIES: ApprovalPolicy[] = [
  {
    name: 'routine_read',
    description: 'Read-only data analysis and monitoring',
    riskCategory: 'low',
    autoApprove: true,
    patterns: ['data-analysis', 'report-gen', 'monitor', 'research', 'FileRead', 'DbQuery'],
  },
  {
    name: 'content_generation',
    description: 'Content and copy generation (non-destructive)',
    riskCategory: 'low',
    autoApprove: true,
    patterns: ['copywriting', 'content-gen', 'headline-gen', 'email-gen', 'translate', 'LLMCall'],
  },
  {
    name: 'code_operations',
    description: 'Code generation and refactoring (sandboxed)',
    riskCategory: 'medium',
    autoApprove: false,
    patterns: ['code-gen', 'refactor', 'scaffold', 'FileWrite', 'ShellExec'],
  },
  {
    name: 'external_api',
    description: 'External API writes (Meta, Google, Shopify)',
    riskCategory: 'high',
    autoApprove: false,
    patterns: ['meta-ads', 'google-ads', 'shopify-manage', 'MetaAdsManage', 'GoogleAdsManage', 'ShopifyManage'],
  },
  {
    name: 'deployment',
    description: 'Deployments and git operations',
    riskCategory: 'critical',
    autoApprove: false,
    patterns: ['deploy', 'ci-cd', 'GitPush', 'PRCreate'],
  },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiRiskAssessment(context: string): Promise<string | null> {
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
                'You are a risk assessment engine for an AI agent orchestration system. '
                + 'Analyze the operation context and provide a JSON risk assessment. '
                + 'Respond ONLY with valid JSON: {"riskScore": 0-100, "category": "low|medium|high|critical", '
                + '"reversible": true|false, "reasoning": "brief explanation", "recommendations": ["..."]}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 512,
          temperature: 0.1,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini risk assessment call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// AutoApproveEngine
// ---------------------------------------------------------------------------

export class AutoApproveEngine {
  private requests: ApprovalRequest[] = [];
  private thresholds: Map<string, ApprovalThresholds> = new Map();
  private policies: ApprovalPolicy[] = [...DEFAULT_POLICIES];
  private maxInMemory = 5_000;
  private escalationTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.thresholds.set('default', { ...DEFAULT_THRESHOLDS });
  }

  // --- Evaluate an operation for approval ------------------------------------

  async evaluateApproval(
    bead: Bead,
    skillChain: string[],
    requestedBy: string,
    estimatedCostUsd: number,
    capabilities: string[],
    moleculeId?: string,
  ): Promise<ApprovalRequest> {
    const startMs = Date.now();

    // Determine risk factors
    const riskFactors = this.assessRiskFactors(bead, skillChain, estimatedCostUsd, capabilities);
    const rawRiskScore = this.computeRiskScore(riskFactors);

    // Determine blast radius
    const blastRadius = this.assessBlastRadius(bead, capabilities);

    // Determine reversibility
    const reversible = this.assessReversibility(capabilities, skillChain);

    // Get applicable thresholds
    const thresholds = this.getThresholds(bead.bu);

    // AI assessment for ambiguous cases (risk score 25-70)
    let aiAssessment: string | undefined;
    let aiRiskAdjustment = 0;
    if (rawRiskScore >= 25 && rawRiskScore <= 70) {
      const aiResult = await this.getAiRiskAssessment(bead, skillChain, capabilities, estimatedCostUsd);
      if (aiResult) {
        aiAssessment = aiResult.reasoning;
        aiRiskAdjustment = (aiResult.riskScore - rawRiskScore) * 0.3;
      }
    }

    const finalRiskScore = Math.max(0, Math.min(100, Math.round(rawRiskScore + aiRiskAdjustment)));

    // Classify risk category
    const riskCategory = this.classifyRisk(finalRiskScore, capabilities, skillChain, thresholds);

    // Determine approval status
    const { status, timeoutMinutes } = this.determineApprovalStatus(
      riskCategory,
      finalRiskScore,
      estimatedCostUsd,
      thresholds,
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeoutMinutes * 60_000);

    const request: ApprovalRequest = {
      id: uuidv4(),
      beadId: bead.id,
      moleculeId,
      requestedBy,
      riskCategory,
      riskScore: finalRiskScore,
      riskFactors,
      status,
      approvedBy: status === 'auto_approved' ? 'system' : undefined,
      skillChain,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      blastRadius,
      reversible,
      aiAssessment,
      timeoutMinutes,
      expiresAt,
      createdAt: now,
      resolvedAt: status === 'auto_approved' ? now : undefined,
    };

    // Store in memory
    this.requests.push(request);
    if (this.requests.length > this.maxInMemory) {
      this.requests = this.requests.slice(-this.maxInMemory);
    }

    // Persist to DB
    await this.persistRequest(request);

    // Start escalation timer for pending requests
    if (status === 'pending') {
      this.startEscalationTimer(request);
    }

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'approval_decision',
      approval: {
        id: request.id,
        beadId: bead.id,
        riskCategory,
        riskScore: finalRiskScore,
        status,
        estimatedCostUsd: request.estimatedCostUsd,
        blastRadius,
        reversible,
        aiAssisted: !!aiAssessment,
        timeMs: Date.now() - startMs,
      },
    });

    log.info({
      id: request.id,
      beadId: bead.id,
      riskCategory,
      riskScore: finalRiskScore,
      status,
      costUsd: request.estimatedCostUsd,
      timeMs: Date.now() - startMs,
    }, `Approval evaluated: ${status}`);

    return request;
  }

  // --- Human approve/reject --------------------------------------------------

  async humanApprove(requestId: string, approvedBy: string): Promise<boolean> {
    const request = this.requests.find(r => r.id === requestId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'approved';
    request.approvedBy = approvedBy;
    request.resolvedAt = new Date();

    this.clearEscalationTimer(requestId);
    await this.updateRequestStatus(request);

    broadcast('meow:cognitive', {
      type: 'approval_resolved',
      approval: { id: requestId, status: 'approved', approvedBy, beadId: request.beadId },
    });

    log.info({ requestId, approvedBy, beadId: request.beadId }, 'Request human-approved');
    return true;
  }

  async humanReject(requestId: string, rejectedBy: string, reason: string): Promise<boolean> {
    const request = this.requests.find(r => r.id === requestId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'rejected';
    request.approvedBy = rejectedBy;
    request.rejectionReason = reason;
    request.resolvedAt = new Date();

    this.clearEscalationTimer(requestId);
    await this.updateRequestStatus(request);

    broadcast('meow:cognitive', {
      type: 'approval_resolved',
      approval: { id: requestId, status: 'rejected', rejectedBy, reason, beadId: request.beadId },
    });

    log.info({ requestId, rejectedBy, reason, beadId: request.beadId }, 'Request human-rejected');
    return true;
  }

  // --- Query requests --------------------------------------------------------

  getRequest(requestId: string): ApprovalRequest | null {
    return this.requests.find(r => r.id === requestId) ?? null;
  }

  getPendingRequests(): ApprovalRequest[] {
    return this.requests.filter(r => r.status === 'pending');
  }

  getRequestsForBead(beadId: string): ApprovalRequest[] {
    return this.requests.filter(r => r.beadId === beadId);
  }

  // --- Configure thresholds --------------------------------------------------

  setThresholds(key: string, thresholds: Partial<ApprovalThresholds>): void {
    const existing = this.thresholds.get(key) ?? { ...DEFAULT_THRESHOLDS };
    this.thresholds.set(key, { ...existing, ...thresholds });
    log.info({ key, thresholds }, 'Approval thresholds updated');
  }

  getThresholds(orgOrTeam?: string): ApprovalThresholds {
    if (orgOrTeam) {
      const specific = this.thresholds.get(orgOrTeam);
      if (specific) return specific;
    }
    return this.thresholds.get('default') ?? DEFAULT_THRESHOLDS;
  }

  // --- Add/update policy -----------------------------------------------------

  addPolicy(policy: ApprovalPolicy): void {
    const idx = this.policies.findIndex(p => p.name === policy.name);
    if (idx >= 0) {
      this.policies[idx] = policy;
    } else {
      this.policies.push(policy);
    }
    log.info({ policy: policy.name }, 'Approval policy added/updated');
  }

  getPolicies(): ApprovalPolicy[] {
    return [...this.policies];
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): ApprovalStats {
    const total = this.requests.length;
    if (total === 0) {
      return {
        totalRequests: 0,
        autoApprovedCount: 0,
        humanApprovedCount: 0,
        rejectedCount: 0,
        escalatedCount: 0,
        timedOutCount: 0,
        avgRiskScore: 0,
        avgResolutionTimeMs: 0,
        autoApproveRate: 0,
        byCategory: { low: 0, medium: 0, high: 0, critical: 0 },
      };
    }

    const autoApproved = this.requests.filter(r => r.status === 'auto_approved').length;
    const humanApproved = this.requests.filter(r => r.status === 'approved').length;
    const rejected = this.requests.filter(r => r.status === 'rejected').length;
    const escalated = this.requests.filter(r => r.status === 'escalated').length;
    const timedOut = this.requests.filter(r => r.status === 'timed_out').length;

    const avgRiskScore = this.requests.reduce((s, r) => s + r.riskScore, 0) / total;

    const resolved = this.requests.filter(r => r.resolvedAt);
    const avgResolutionMs = resolved.length > 0
      ? resolved.reduce((s, r) => s + ((r.resolvedAt?.getTime() ?? 0) - r.createdAt.getTime()), 0) / resolved.length
      : 0;

    const byCategory: Record<RiskCategory, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const req of this.requests) {
      byCategory[req.riskCategory]++;
    }

    return {
      totalRequests: total,
      autoApprovedCount: autoApproved,
      humanApprovedCount: humanApproved,
      rejectedCount: rejected,
      escalatedCount: escalated,
      timedOutCount: timedOut,
      avgRiskScore: Math.round(avgRiskScore * 10) / 10,
      avgResolutionTimeMs: Math.round(avgResolutionMs),
      autoApproveRate: Math.round((autoApproved / total) * 1000) / 1000,
      byCategory,
    };
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 7): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, bead_id, molecule_id, requested_by, risk_category,
                risk_score, risk_factors, status, approved_by, rejection_reason,
                skill_chain, estimated_cost_usd, blast_radius, reversible,
                ai_assessment, timeout_minutes, expires_at, created_at, resolved_at
         FROM meow_approvals
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, this.maxInMemory],
      );

      this.requests = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        beadId: r.bead_id as string,
        moleculeId: r.molecule_id as string | undefined,
        requestedBy: r.requested_by as string,
        riskCategory: r.risk_category as RiskCategory,
        riskScore: parseFloat(r.risk_score as string) || 0,
        riskFactors: this.parseJsonSafe(r.risk_factors, []),
        status: r.status as ApprovalStatus,
        approvedBy: r.approved_by as string | undefined,
        rejectionReason: r.rejection_reason as string | undefined,
        skillChain: this.parseJsonSafe(r.skill_chain, []),
        estimatedCostUsd: parseFloat(r.estimated_cost_usd as string) || 0,
        blastRadius: r.blast_radius as BlastRadius,
        reversible: r.reversible as boolean,
        aiAssessment: r.ai_assessment as string | undefined,
        timeoutMinutes: parseInt(r.timeout_minutes as string) || 30,
        expiresAt: new Date(r.expires_at as string),
        createdAt: new Date(r.created_at as string),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : undefined,
      }));

      log.info({ count: this.requests.length }, 'Loaded approval history from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load approval history from DB');
    }
  }

  // --- Cleanup ---------------------------------------------------------------

  destroy(): void {
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: Risk Assessment
  // ---------------------------------------------------------------------------

  private assessRiskFactors(
    bead: Bead,
    skillChain: string[],
    estimatedCostUsd: number,
    capabilities: string[],
  ): RiskFactor[] {
    const factors: RiskFactor[] = [];

    // Factor 1: Cost
    const costScore = estimatedCostUsd <= 0.01 ? 0
      : estimatedCostUsd <= 1 ? 10
      : estimatedCostUsd <= 10 ? 30
      : estimatedCostUsd <= 50 ? 60
      : estimatedCostUsd <= 200 ? 80
      : 100;
    factors.push({ name: 'estimated_cost', weight: 0.25, score: costScore, description: `$${estimatedCostUsd.toFixed(4)} estimated` });

    // Factor 2: Destructive capabilities
    const destructiveCaps = capabilities.filter(c => HIGH_RISK_CAPABILITIES.has(c));
    const destructiveScore = destructiveCaps.length === 0 ? 0
      : destructiveCaps.length === 1 ? 50
      : destructiveCaps.length <= 3 ? 75
      : 100;
    factors.push({ name: 'destructive_capabilities', weight: 0.30, score: destructiveScore, description: `${destructiveCaps.length} high-risk caps: ${destructiveCaps.join(', ') || 'none'}` });

    // Factor 3: Skill risk profile
    const highRiskSkills = skillChain.filter(s => HIGH_RISK_SKILLS.has(s));
    const lowRiskSkills = skillChain.filter(s => LOW_RISK_SKILLS.has(s));
    let skillScore: number;
    if (highRiskSkills.length > 0) {
      skillScore = 70 + highRiskSkills.length * 10;
    } else if (lowRiskSkills.length === skillChain.length && skillChain.length > 0) {
      skillScore = 5;
    } else {
      skillScore = 35;
    }
    factors.push({ name: 'skill_risk', weight: 0.20, score: Math.min(100, skillScore), description: `${highRiskSkills.length} high-risk, ${lowRiskSkills.length} low-risk skills` });

    // Factor 4: Priority urgency (critical beads may need faster processing)
    const priorityScore = bead.priority === 'critical' ? 70
      : bead.priority === 'high' ? 50
      : bead.priority === 'medium' ? 30
      : 10;
    factors.push({ name: 'priority_urgency', weight: 0.10, score: priorityScore, description: `Priority: ${bead.priority}` });

    // Factor 5: External API involvement
    const externalApis = capabilities.filter(c =>
      c === 'MetaAdsManage' || c === 'GoogleAdsManage' || c === 'ShopifyManage' || c === 'WhatsAppSend' || c === 'NetConnect',
    );
    const externalScore = externalApis.length === 0 ? 0 : 40 + externalApis.length * 15;
    factors.push({ name: 'external_apis', weight: 0.15, score: Math.min(100, externalScore), description: `${externalApis.length} external API interactions` });

    return factors;
  }

  private computeRiskScore(factors: RiskFactor[]): number {
    if (factors.length === 0) return 0;
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    if (totalWeight === 0) return 0;
    const weightedScore = factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight;
    return Math.round(weightedScore * 10) / 10;
  }

  private assessBlastRadius(bead: Bead, capabilities: string[]): BlastRadius {
    if (capabilities.some(c => c === 'GitPush' || c === 'ShellExec')) return 'system_wide';
    if (capabilities.some(c => HIGH_RISK_CAPABILITIES.has(c))) return 'convoy';
    if (bead.moleculeId || bead.convoyId) return 'molecule';
    return 'single_bead';
  }

  private assessReversibility(capabilities: string[], skillChain: string[]): boolean {
    // Irreversible: external API writes, deployments, git push
    const irreversible = new Set(['GitPush', 'MetaAdsManage', 'GoogleAdsManage', 'ShopifyManage', 'WhatsAppSend']);
    if (capabilities.some(c => irreversible.has(c))) return false;
    if (skillChain.some(s => s === 'deploy' || s === 'ci-cd')) return false;
    return true;
  }

  private classifyRisk(
    riskScore: number,
    capabilities: string[],
    skillChain: string[],
    thresholds: ApprovalThresholds,
  ): RiskCategory {
    // Hard overrides
    if (capabilities.some(c => c === 'GitPush' || c === 'PRCreate') && thresholds.requireHumanForDeploy) return 'critical';
    if (skillChain.includes('deploy') && thresholds.requireHumanForDeploy) return 'critical';

    // Score-based
    if (riskScore <= thresholds.autoApproveRiskScore) return 'low';
    if (riskScore <= 50) return 'medium';
    if (riskScore <= 75) return 'high';
    return 'critical';
  }

  private determineApprovalStatus(
    riskCategory: RiskCategory,
    riskScore: number,
    estimatedCostUsd: number,
    thresholds: ApprovalThresholds,
  ): { status: ApprovalStatus; timeoutMinutes: number } {
    if (riskCategory === 'low' && estimatedCostUsd <= thresholds.autoApproveBudgetUsd && riskScore <= thresholds.autoApproveRiskScore) {
      return { status: 'auto_approved', timeoutMinutes: 0 };
    }

    if (riskCategory === 'medium') {
      return { status: 'pending', timeoutMinutes: thresholds.mediumRiskTimeoutMin };
    }

    // High and critical always require human
    return { status: 'pending', timeoutMinutes: thresholds.highRiskTimeoutMin };
  }

  // ---------------------------------------------------------------------------
  // Private: AI Risk Assessment
  // ---------------------------------------------------------------------------

  private async getAiRiskAssessment(
    bead: Bead,
    skillChain: string[],
    capabilities: string[],
    estimatedCostUsd: number,
  ): Promise<{ riskScore: number; reasoning: string } | null> {
    const context = `Operation to evaluate:
  Bead: ${bead.title} (priority: ${bead.priority})
  Description: ${(bead.description ?? 'N/A').slice(0, 300)}
  Skills: ${skillChain.join(', ')}
  Capabilities required: ${capabilities.join(', ')}
  Estimated cost: $${estimatedCostUsd.toFixed(4)}
  Business unit: ${bead.bu ?? 'unknown'}

Assess the risk level (0-100) considering:
- Can this operation be reversed if something goes wrong?
- Does it interact with external paid APIs (Meta Ads, Google Ads, Shopify)?
- What is the blast radius if it fails?
- Is the cost within acceptable auto-approve range ($50)?`;

    const raw = await callGeminiRiskAssessment(context);
    if (!raw) return this.heuristicRiskAssessment(skillChain, capabilities, estimatedCostUsd);

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return this.heuristicRiskAssessment(skillChain, capabilities, estimatedCostUsd);

      const parsed = JSON.parse(match[0]) as {
        riskScore?: number;
        reasoning?: string;
      };

      if (typeof parsed.riskScore !== 'number') return this.heuristicRiskAssessment(skillChain, capabilities, estimatedCostUsd);

      return {
        riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
        reasoning: parsed.reasoning ?? 'AI assessment completed',
      };
    } catch {
      return this.heuristicRiskAssessment(skillChain, capabilities, estimatedCostUsd);
    }
  }

  private heuristicRiskAssessment(
    skillChain: string[],
    capabilities: string[],
    estimatedCostUsd: number,
  ): { riskScore: number; reasoning: string } {
    let score = 20; // baseline
    if (capabilities.some(c => HIGH_RISK_CAPABILITIES.has(c))) score += 30;
    if (skillChain.some(s => HIGH_RISK_SKILLS.has(s))) score += 20;
    if (estimatedCostUsd > 50) score += 25;
    if (capabilities.includes('ShellExec')) score += 15;
    if (capabilities.every(c => READ_ONLY_CAPABILITIES.has(c))) score = Math.min(score, 15);

    return {
      riskScore: Math.min(100, score),
      reasoning: `Heuristic assessment: ${score <= 30 ? 'low risk' : score <= 60 ? 'moderate risk' : 'high risk'} based on capability and cost analysis`,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Escalation Timer
  // ---------------------------------------------------------------------------

  private startEscalationTimer(request: ApprovalRequest): void {
    if (request.timeoutMinutes <= 0) return;

    const timer = setTimeout(() => {
      this.escalateRequest(request.id);
    }, request.timeoutMinutes * 60_000);

    this.escalationTimers.set(request.id, timer);
  }

  private clearEscalationTimer(requestId: string): void {
    const timer = this.escalationTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(requestId);
    }
  }

  private async escalateRequest(requestId: string): Promise<void> {
    const request = this.requests.find(r => r.id === requestId);
    if (!request || request.status !== 'pending') return;

    request.status = 'escalated';
    request.resolvedAt = new Date();
    this.escalationTimers.delete(requestId);

    await this.updateRequestStatus(request);

    broadcast('meow:cognitive', {
      type: 'approval_escalated',
      approval: {
        id: requestId,
        beadId: request.beadId,
        riskCategory: request.riskCategory,
        riskScore: request.riskScore,
        timeoutMinutes: request.timeoutMinutes,
      },
    });

    log.warn({ requestId, beadId: request.beadId, riskCategory: request.riskCategory },
      'Approval request escalated due to timeout');
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistRequest(request: ApprovalRequest): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_approvals
          (id, bead_id, molecule_id, requested_by, risk_category,
           risk_score, risk_factors, status, approved_by, rejection_reason,
           skill_chain, estimated_cost_usd, blast_radius, reversible,
           ai_assessment, timeout_minutes, expires_at, created_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [
          request.id,
          request.beadId,
          request.moleculeId ?? null,
          request.requestedBy,
          request.riskCategory,
          request.riskScore,
          JSON.stringify(request.riskFactors),
          request.status,
          request.approvedBy ?? null,
          request.rejectionReason ?? null,
          JSON.stringify(request.skillChain),
          request.estimatedCostUsd,
          request.blastRadius,
          request.reversible,
          request.aiAssessment ?? null,
          request.timeoutMinutes,
          request.expiresAt.toISOString(),
          request.createdAt.toISOString(),
          request.resolvedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, requestId: request.id }, 'Failed to persist approval request');
    }
  }

  private async updateRequestStatus(request: ApprovalRequest): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_approvals
         SET status = $1, approved_by = $2, rejection_reason = $3, resolved_at = $4
         WHERE id = $5`,
        [
          request.status,
          request.approvedBy ?? null,
          request.rejectionReason ?? null,
          request.resolvedAt?.toISOString() ?? null,
          request.id,
        ],
      );
    } catch (err) {
      log.error({ err, requestId: request.id }, 'Failed to update approval status');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    return raw as T;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AutoApproveEngine | null = null;

export function getAutoApproveEngine(): AutoApproveEngine {
  if (!instance) {
    instance = new AutoApproveEngine();
  }
  return instance;
}
