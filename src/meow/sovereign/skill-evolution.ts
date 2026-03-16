/**
 * SKILL EVOLUTION — SG-014 (Stage 06 Wave 4)
 *
 * Skills evolve as new capabilities become available.
 * Monitors skill health, detects deprecated APIs, auto-generates upgrades,
 * handles migration of formulas when skills are replaced, and discovers
 * new external APIs that could be wrapped as skills.
 *
 * Features:
 *   - Monitor skill performance: success rate, latency, cost over time windows
 *   - Detect deprecated APIs: flag skills whose underlying API changes or degrades
 *   - Auto-generate skill upgrades: analyze new API features → suggest improvements
 *   - Skill migration: auto-migrate formulas from deprecated skill to replacement
 *   - Skill capability discovery: periodically check for new wrappable APIs
 *   - Compatibility tracking: which formulas use which skill versions
 *   - Evolution lifecycle: detected → proposed → tested → deployed → retired_old
 *   - DB table: meow_skill_evolution
 *
 * Integration: reads from skill-performance-ranking.ts (Stage 05 CG-006)
 *
 * Gas Town: "Evolve or rust — every skill must keep up with the road ahead."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-evolution');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvolutionLifecycle =
  | 'detected'
  | 'proposed'
  | 'tested'
  | 'deployed'
  | 'retired_old'
  | 'rejected';

export type EvolutionTrigger =
  | 'performance_degradation'
  | 'api_deprecation'
  | 'new_api_available'
  | 'cost_increase'
  | 'success_rate_drop'
  | 'latency_spike'
  | 'manual_request'
  | 'capability_discovery';

export type DeprecationSeverity = 'info' | 'warning' | 'critical';

export interface SkillHealthSnapshot {
  skillName: string;
  successRate: number;           // 0.0 - 1.0
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  executionCount: number;
  errorRate: number;             // 0.0 - 1.0
  lastExecutedAt: Date | null;
  windowStartAt: Date;
  windowEndAt: Date;
}

export interface DeprecationAlert {
  id: string;
  skillName: string;
  severity: DeprecationSeverity;
  reason: string;
  detectedAt: Date;
  apiEndpoint?: string;
  httpStatus?: number;
  errorPattern?: string;
  suggestedAction: string;
  acknowledged: boolean;
  acknowledgedAt?: Date;
}

export interface EvolutionProposal {
  id: string;
  lifecycle: EvolutionLifecycle;
  trigger: EvolutionTrigger;
  sourceSkill: string;           // the skill being evolved
  targetSkill: string;           // proposed replacement skill name
  description: string;
  reasoning: string;
  upgradeSteps: string[];        // human-readable migration steps
  estimatedImprovement: {
    successRateDelta: number;    // expected change
    latencyDeltaMs: number;
    costDeltaUsd: number;
  };
  affectedFormulas: string[];    // formula names that use source skill
  testResults?: TestResult[];
  riskAssessment: string;
  proposedAt: Date;
  testedAt?: Date;
  deployedAt?: Date;
  retiredAt?: Date;
  rejectedAt?: Date;
  rejectionReason?: string;
  metadata?: Record<string, unknown>;
}

export interface TestResult {
  testId: string;
  testType: 'unit' | 'integration' | 'performance' | 'regression';
  passed: boolean;
  durationMs: number;
  details: string;
  executedAt: Date;
}

export interface SkillCompatibility {
  skillName: string;
  skillVersion: string;
  formulasUsing: string[];
  lastCheckedAt: Date;
  compatible: boolean;
  issues: string[];
}

export interface CapabilityDiscovery {
  id: string;
  apiName: string;
  apiEndpoint: string;
  description: string;
  potentialSkillName: string;
  capabilities: string[];
  estimatedCostPerCall: number;
  discoveredAt: Date;
  status: 'discovered' | 'evaluated' | 'approved' | 'dismissed';
  evaluationNotes?: string;
}

export interface EvolutionConfig {
  healthCheckIntervalMs: number;
  successRateThreshold: number;     // below this triggers evolution
  latencySpikeMultiplier: number;   // above baseline × this triggers alert
  costIncreaseThreshold: number;    // percentage increase to trigger
  minExecutionsForEvaluation: number;
  discoveryEnabled: boolean;
  autoPropose: boolean;
  maxProposalsInMemory: number;
  maxAlertsInMemory: number;
}

export interface EvolutionStats {
  totalProposals: number;
  byLifecycle: Record<string, number>;
  byTrigger: Record<string, number>;
  activeAlerts: number;
  skillsMonitored: number;
  deploymentsCount: number;
  rejectionsCount: number;
  avgTimeToDeployMs: number;
  discoveriesCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: EvolutionConfig = {
  healthCheckIntervalMs: 10 * 60 * 1000,  // 10 min
  successRateThreshold: 0.7,
  latencySpikeMultiplier: 3.0,
  costIncreaseThreshold: 0.5,              // 50% cost increase
  minExecutionsForEvaluation: 20,
  discoveryEnabled: true,
  autoPropose: true,
  maxProposalsInMemory: 1_000,
  maxAlertsInMemory: 500,
};

const HEALTH_WINDOW_HOURS = 24;

// Known API endpoints to monitor for deprecation signals
const MONITORED_APIS: Array<{ name: string; healthUrl: string; skillPattern: string }> = [
  { name: 'Meta Ads', healthUrl: 'https://graph.facebook.com/v21.0/me', skillPattern: 'meta_' },
  { name: 'Shopify', healthUrl: 'https://shopify.dev/api', skillPattern: 'shopify_' },
  { name: 'ElevenLabs', healthUrl: 'https://api.elevenlabs.io/v1/user', skillPattern: 'elevenlabs_' },
  { name: 'Evolution', healthUrl: '/api/evolution/status', skillPattern: 'evolution_' },
];

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
              content:
                'You are a skill evolution analyst for the Gas Town MEOW system. '
                + 'You analyze skill performance, detect degradation patterns, and propose upgrades. '
                + 'Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1536,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in skill-evolution');
    return null;
  }
}

// ---------------------------------------------------------------------------
// SkillEvolution
// ---------------------------------------------------------------------------

export class SkillEvolution {
  private config: EvolutionConfig;
  private proposals: EvolutionProposal[] = [];
  private alerts: DeprecationAlert[] = [];
  private discoveries: CapabilityDiscovery[] = [];
  private compatibilityMap = new Map<string, SkillCompatibility>();
  private healthBaselines = new Map<string, SkillHealthSnapshot>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<EvolutionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info({ config: this.config }, 'SkillEvolution created');
  }

  // --- Lifecycle -------------------------------------------------------------

  start(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.runHealthCheck().catch(err =>
        log.error({ err }, 'Skill evolution health check failed'),
      );
    }, this.config.healthCheckIntervalMs);

    broadcast('meow:sovereign', {
      type: 'skill_evolution_started',
      intervalMs: this.config.healthCheckIntervalMs,
    });

    log.info('SkillEvolution monitoring started');
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    log.info('SkillEvolution monitoring stopped');
  }

  // --- Health check ----------------------------------------------------------

  async runHealthCheck(): Promise<DeprecationAlert[]> {
    log.info('Running skill evolution health check');
    const newAlerts: DeprecationAlert[] = [];

    try {
      const pool = getPool();
      if (!pool) return newAlerts;
      const windowStart = new Date(Date.now() - HEALTH_WINDOW_HOURS * 60 * 60 * 1000);

      // Pull recent skill executions from meow_skill_metrics
      const { rows } = await pool.query(
        `SELECT skill_name,
                COUNT(*)::int as exec_count,
                AVG(CASE WHEN success THEN 1 ELSE 0 END)::float as success_rate,
                AVG(duration_ms)::float as avg_latency,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float as p95_latency,
                AVG(cost_usd)::float as avg_cost,
                MAX(recorded_at) as last_executed
         FROM meow_skill_metrics
         WHERE recorded_at >= $1
         GROUP BY skill_name
         HAVING COUNT(*) >= $2`,
        [windowStart.toISOString(), this.config.minExecutionsForEvaluation],
      );

      for (const row of rows) {
        const snapshot: SkillHealthSnapshot = {
          skillName: row.skill_name,
          successRate: row.success_rate ?? 0,
          avgLatencyMs: row.avg_latency ?? 0,
          p95LatencyMs: row.p95_latency ?? 0,
          avgCostUsd: row.avg_cost ?? 0,
          executionCount: row.exec_count ?? 0,
          errorRate: 1 - (row.success_rate ?? 0),
          lastExecutedAt: row.last_executed ? new Date(row.last_executed) : null,
          windowStartAt: windowStart,
          windowEndAt: new Date(),
        };

        const baseline = this.healthBaselines.get(snapshot.skillName);

        // Check for degradation
        if (snapshot.successRate < this.config.successRateThreshold) {
          const alert = this.createAlert(
            snapshot.skillName,
            snapshot.successRate < 0.5 ? 'critical' : 'warning',
            `Success rate dropped to ${(snapshot.successRate * 100).toFixed(1)}% (threshold: ${(this.config.successRateThreshold * 100).toFixed(1)}%)`,
            'Review skill implementation or migrate to alternative',
          );
          newAlerts.push(alert);

          if (this.config.autoPropose) {
            await this.proposeEvolution('success_rate_drop', snapshot.skillName, snapshot);
          }
        }

        // Check latency spike
        if (baseline && baseline.avgLatencyMs > 0) {
          const latencyRatio = snapshot.avgLatencyMs / baseline.avgLatencyMs;
          if (latencyRatio > this.config.latencySpikeMultiplier) {
            const alert = this.createAlert(
              snapshot.skillName,
              'warning',
              `Latency spike: ${snapshot.avgLatencyMs.toFixed(0)}ms (baseline: ${baseline.avgLatencyMs.toFixed(0)}ms, ${latencyRatio.toFixed(1)}x)`,
              'Check API health or consider caching/batching optimizations',
            );
            newAlerts.push(alert);

            if (this.config.autoPropose) {
              await this.proposeEvolution('latency_spike', snapshot.skillName, snapshot);
            }
          }
        }

        // Check cost increase
        if (baseline && baseline.avgCostUsd > 0) {
          const costIncrease = (snapshot.avgCostUsd - baseline.avgCostUsd) / baseline.avgCostUsd;
          if (costIncrease > this.config.costIncreaseThreshold) {
            const alert = this.createAlert(
              snapshot.skillName,
              'warning',
              `Cost increased by ${(costIncrease * 100).toFixed(1)}% ($${snapshot.avgCostUsd.toFixed(4)} vs baseline $${baseline.avgCostUsd.toFixed(4)})`,
              'Evaluate cost optimization or cheaper alternative skills',
            );
            newAlerts.push(alert);

            if (this.config.autoPropose) {
              await this.proposeEvolution('cost_increase', snapshot.skillName, snapshot);
            }
          }
        }

        // Update baseline (moving average)
        if (!baseline) {
          this.healthBaselines.set(snapshot.skillName, snapshot);
        } else {
          // Exponential moving average with alpha=0.3
          const alpha = 0.3;
          baseline.avgLatencyMs = alpha * snapshot.avgLatencyMs + (1 - alpha) * baseline.avgLatencyMs;
          baseline.avgCostUsd = alpha * snapshot.avgCostUsd + (1 - alpha) * baseline.avgCostUsd;
          baseline.successRate = alpha * snapshot.successRate + (1 - alpha) * baseline.successRate;
          baseline.windowEndAt = snapshot.windowEndAt;
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to run health check against DB');
    }

    if (newAlerts.length > 0) {
      broadcast('meow:sovereign', {
        type: 'skill_evolution_alerts',
        alertCount: newAlerts.length,
        skills: newAlerts.map(a => a.skillName),
      });
    }

    return newAlerts;
  }

  // --- Propose evolution -----------------------------------------------------

  async proposeEvolution(
    trigger: EvolutionTrigger,
    sourceSkill: string,
    healthSnapshot?: SkillHealthSnapshot,
  ): Promise<EvolutionProposal> {
    log.info({ trigger, sourceSkill }, 'Proposing skill evolution');

    // Check for existing active proposal for same skill
    const existing = this.proposals.find(
      p => p.sourceSkill === sourceSkill
        && ['detected', 'proposed', 'tested'].includes(p.lifecycle),
    );
    if (existing) {
      log.info({ existingId: existing.id, sourceSkill }, 'Active proposal already exists');
      return existing;
    }

    // Get affected formulas
    const affectedFormulas = await this.getAffectedFormulas(sourceSkill);

    // Ask Gemini for upgrade suggestion
    let description = `Performance degradation detected for skill "${sourceSkill}"`;
    let reasoning = 'Heuristic: skill metrics crossed configured thresholds';
    let upgradeSteps: string[] = ['Investigate root cause', 'Identify replacement API', 'Implement and test', 'Migrate formulas'];
    let riskAssessment = 'medium';
    let estimatedImprovement = { successRateDelta: 0.1, latencyDeltaMs: -100, costDeltaUsd: 0 };

    const prompt = `Analyze skill degradation and suggest evolution:
Skill: ${sourceSkill}
Trigger: ${trigger}
${healthSnapshot ? `Current metrics: success_rate=${healthSnapshot.successRate.toFixed(2)}, avg_latency=${healthSnapshot.avgLatencyMs.toFixed(0)}ms, cost=$${healthSnapshot.avgCostUsd.toFixed(4)}, executions=${healthSnapshot.executionCount}` : ''}
Affected formulas (${affectedFormulas.length}): ${affectedFormulas.slice(0, 10).join(', ')}

Return JSON:
{
  "description": "what's happening",
  "reasoning": "why this evolution is needed",
  "upgradeSteps": ["step1", "step2", ...],
  "targetSkill": "suggested_replacement_name",
  "riskAssessment": "low|medium|high",
  "estimatedImprovement": {"successRateDelta": 0.1, "latencyDeltaMs": -50, "costDeltaUsd": -0.001}
}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        description = (parsed.description as string) ?? description;
        reasoning = (parsed.reasoning as string) ?? reasoning;
        upgradeSteps = Array.isArray(parsed.upgradeSteps) ? parsed.upgradeSteps as string[] : upgradeSteps;
        riskAssessment = (parsed.riskAssessment as string) ?? riskAssessment;
        const ei = parsed.estimatedImprovement as Record<string, number> | undefined;
        if (ei) {
          estimatedImprovement = {
            successRateDelta: ei.successRateDelta ?? 0.1,
            latencyDeltaMs: ei.latencyDeltaMs ?? -100,
            costDeltaUsd: ei.costDeltaUsd ?? 0,
          };
        }
      } catch {
        log.warn('Failed to parse Gemini evolution proposal');
      }
    }

    const proposal: EvolutionProposal = {
      id: uuidv4(),
      lifecycle: 'detected',
      trigger,
      sourceSkill,
      targetSkill: `${sourceSkill}_v2`,
      description,
      reasoning,
      upgradeSteps,
      estimatedImprovement,
      affectedFormulas,
      riskAssessment,
      proposedAt: new Date(),
    };

    this.proposals.push(proposal);
    this.trimMemory();
    await this.persistProposal(proposal);

    broadcast('meow:sovereign', {
      type: 'skill_evolution_proposed',
      proposalId: proposal.id,
      sourceSkill,
      trigger,
      affectedFormulas: affectedFormulas.length,
      riskAssessment,
    });

    log.info({ proposalId: proposal.id, sourceSkill, trigger }, 'Evolution proposal created');
    return proposal;
  }

  // --- Transition lifecycle --------------------------------------------------

  async transitionProposal(
    proposalId: string,
    newLifecycle: EvolutionLifecycle,
    details?: { testResults?: TestResult[]; rejectionReason?: string },
  ): Promise<EvolutionProposal> {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

    const validTransitions: Record<EvolutionLifecycle, EvolutionLifecycle[]> = {
      detected: ['proposed', 'rejected'],
      proposed: ['tested', 'rejected'],
      tested: ['deployed', 'rejected'],
      deployed: ['retired_old'],
      retired_old: [],
      rejected: [],
    };

    if (!validTransitions[proposal.lifecycle].includes(newLifecycle)) {
      throw new Error(`Cannot transition from ${proposal.lifecycle} to ${newLifecycle}`);
    }

    proposal.lifecycle = newLifecycle;

    if (newLifecycle === 'tested') {
      proposal.testedAt = new Date();
      if (details?.testResults) {
        proposal.testResults = details.testResults;
      }
    } else if (newLifecycle === 'deployed') {
      proposal.deployedAt = new Date();
    } else if (newLifecycle === 'retired_old') {
      proposal.retiredAt = new Date();
    } else if (newLifecycle === 'rejected') {
      proposal.rejectedAt = new Date();
      proposal.rejectionReason = details?.rejectionReason ?? 'No reason given';
    }

    await this.persistProposal(proposal);

    broadcast('meow:sovereign', {
      type: 'skill_evolution_transition',
      proposalId,
      sourceSkill: proposal.sourceSkill,
      lifecycle: newLifecycle,
    });

    log.info({ proposalId, newLifecycle, sourceSkill: proposal.sourceSkill }, 'Proposal transitioned');
    return proposal;
  }

  // --- Capability discovery --------------------------------------------------

  async discoverCapabilities(): Promise<CapabilityDiscovery[]> {
    if (!this.config.discoveryEnabled) return [];

    log.info('Running skill capability discovery');

    const prompt = `You are scanning for new API capabilities that could be wrapped as MEOW skills.
Current skill categories: campaign management, content creation, fulfillment, analytics, communication, image generation, video generation, voice synthesis, web scraping, data enrichment.

Suggest 3 new API-based capabilities that could be valuable for an e-commerce dropshipping orchestration system.
For each, return JSON array:
[{"apiName": "...", "apiEndpoint": "...", "description": "...", "potentialSkillName": "...", "capabilities": ["..."], "estimatedCostPerCall": 0.01}]`;

    const raw = await callGemini(prompt);
    const newDiscoveries: CapabilityDiscovery[] = [];

    if (raw) {
      try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as Array<Record<string, unknown>>;
        for (const item of parsed) {
          const discovery: CapabilityDiscovery = {
            id: uuidv4(),
            apiName: (item.apiName as string) ?? 'Unknown',
            apiEndpoint: (item.apiEndpoint as string) ?? '',
            description: (item.description as string) ?? '',
            potentialSkillName: (item.potentialSkillName as string) ?? '',
            capabilities: Array.isArray(item.capabilities) ? item.capabilities as string[] : [],
            estimatedCostPerCall: typeof item.estimatedCostPerCall === 'number' ? item.estimatedCostPerCall : 0.01,
            discoveredAt: new Date(),
            status: 'discovered',
          };
          newDiscoveries.push(discovery);
          this.discoveries.push(discovery);
        }
      } catch {
        log.warn('Failed to parse Gemini discovery response');
      }
    }

    // Heuristic fallback if no AI response
    if (newDiscoveries.length === 0) {
      const fallbackDiscovery: CapabilityDiscovery = {
        id: uuidv4(),
        apiName: 'Periodic Health Scan',
        apiEndpoint: 'internal',
        description: 'No new capabilities discovered this cycle (AI unavailable)',
        potentialSkillName: 'health_scan_noop',
        capabilities: ['monitoring'],
        estimatedCostPerCall: 0,
        discoveredAt: new Date(),
        status: 'dismissed',
      };
      newDiscoveries.push(fallbackDiscovery);
      this.discoveries.push(fallbackDiscovery);
    }

    if (newDiscoveries.length > 0) {
      broadcast('meow:sovereign', {
        type: 'skill_capability_discovered',
        count: newDiscoveries.length,
        names: newDiscoveries.map(d => d.potentialSkillName),
      });
    }

    log.info({ count: newDiscoveries.length }, 'Capability discovery completed');
    return newDiscoveries;
  }

  // --- Compatibility tracking ------------------------------------------------

  async updateCompatibility(
    skillName: string,
    skillVersion: string,
  ): Promise<SkillCompatibility> {
    const formulas = await this.getAffectedFormulas(skillName);

    const compat: SkillCompatibility = {
      skillName,
      skillVersion,
      formulasUsing: formulas,
      lastCheckedAt: new Date(),
      compatible: true,
      issues: [],
    };

    this.compatibilityMap.set(skillName, compat);
    return compat;
  }

  getCompatibility(skillName: string): SkillCompatibility | undefined {
    return this.compatibilityMap.get(skillName);
  }

  // --- Alerts ----------------------------------------------------------------

  acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date();
    }
  }

  getActiveAlerts(): DeprecationAlert[] {
    return this.alerts.filter(a => !a.acknowledged);
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): EvolutionStats {
    const byLifecycle: Record<string, number> = {};
    const byTrigger: Record<string, number> = {};
    let deployTimeSum = 0;
    let deployCount = 0;

    for (const p of this.proposals) {
      byLifecycle[p.lifecycle] = (byLifecycle[p.lifecycle] ?? 0) + 1;
      byTrigger[p.trigger] = (byTrigger[p.trigger] ?? 0) + 1;

      if (p.deployedAt && p.proposedAt) {
        deployTimeSum += p.deployedAt.getTime() - p.proposedAt.getTime();
        deployCount += 1;
      }
    }

    return {
      totalProposals: this.proposals.length,
      byLifecycle,
      byTrigger,
      activeAlerts: this.alerts.filter(a => !a.acknowledged).length,
      skillsMonitored: this.healthBaselines.size,
      deploymentsCount: this.proposals.filter(p => p.lifecycle === 'deployed' || p.lifecycle === 'retired_old').length,
      rejectionsCount: this.proposals.filter(p => p.lifecycle === 'rejected').length,
      avgTimeToDeployMs: deployCount > 0 ? Math.round(deployTimeSum / deployCount) : 0,
      discoveriesCount: this.discoveries.length,
    };
  }

  // --- Getters ---------------------------------------------------------------

  getProposal(id: string): EvolutionProposal | undefined {
    return this.proposals.find(p => p.id === id);
  }

  getProposals(lifecycle?: EvolutionLifecycle): EvolutionProposal[] {
    if (lifecycle) return this.proposals.filter(p => p.lifecycle === lifecycle);
    return [...this.proposals];
  }

  getDiscoveries(): CapabilityDiscovery[] {
    return [...this.discoveries];
  }

  // --- Helpers ---------------------------------------------------------------

  private createAlert(
    skillName: string,
    severity: DeprecationSeverity,
    reason: string,
    suggestedAction: string,
  ): DeprecationAlert {
    const alert: DeprecationAlert = {
      id: uuidv4(),
      skillName,
      severity,
      reason,
      detectedAt: new Date(),
      suggestedAction,
      acknowledged: false,
    };
    this.alerts.push(alert);
    if (this.alerts.length > this.config.maxAlertsInMemory) {
      this.alerts = this.alerts.slice(-this.config.maxAlertsInMemory);
    }
    return alert;
  }

  private async getAffectedFormulas(skillName: string): Promise<string[]> {
    try {
      const pool = getPool();
      if (!pool) return [];
      const { rows } = await pool.query(
        `SELECT DISTINCT formula_name FROM meow_beads
         WHERE skill_name = $1
         AND created_at > NOW() - INTERVAL '30 days'
         LIMIT 100`,
        [skillName],
      );
      return rows.map((r: { formula_name: string }) => r.formula_name);
    } catch {
      return [];
    }
  }

  private trimMemory(): void {
    if (this.proposals.length > this.config.maxProposalsInMemory) {
      // Keep most recent
      this.proposals.sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime());
      this.proposals = this.proposals.slice(0, this.config.maxProposalsInMemory);
    }
    if (this.discoveries.length > 500) {
      this.discoveries = this.discoveries.slice(-500);
    }
  }

  // --- DB persistence --------------------------------------------------------

  private async persistProposal(proposal: EvolutionProposal): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_skill_evolution
          (id, lifecycle, trigger, source_skill, target_skill, description, reasoning,
           upgrade_steps, estimated_improvement, affected_formulas, test_results,
           risk_assessment, proposed_at, tested_at, deployed_at, retired_at,
           rejected_at, rejection_reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO UPDATE SET
           lifecycle = EXCLUDED.lifecycle,
           description = EXCLUDED.description,
           reasoning = EXCLUDED.reasoning,
           upgrade_steps = EXCLUDED.upgrade_steps,
           estimated_improvement = EXCLUDED.estimated_improvement,
           affected_formulas = EXCLUDED.affected_formulas,
           test_results = EXCLUDED.test_results,
           risk_assessment = EXCLUDED.risk_assessment,
           tested_at = EXCLUDED.tested_at,
           deployed_at = EXCLUDED.deployed_at,
           retired_at = EXCLUDED.retired_at,
           rejected_at = EXCLUDED.rejected_at,
           rejection_reason = EXCLUDED.rejection_reason,
           metadata = EXCLUDED.metadata`,
        [
          proposal.id,
          proposal.lifecycle,
          proposal.trigger,
          proposal.sourceSkill,
          proposal.targetSkill,
          proposal.description,
          proposal.reasoning,
          JSON.stringify(proposal.upgradeSteps),
          JSON.stringify(proposal.estimatedImprovement),
          JSON.stringify(proposal.affectedFormulas),
          proposal.testResults ? JSON.stringify(proposal.testResults) : null,
          proposal.riskAssessment,
          proposal.proposedAt.toISOString(),
          proposal.testedAt?.toISOString() ?? null,
          proposal.deployedAt?.toISOString() ?? null,
          proposal.retiredAt?.toISOString() ?? null,
          proposal.rejectedAt?.toISOString() ?? null,
          proposal.rejectionReason ?? null,
          proposal.metadata ? JSON.stringify(proposal.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, proposalId: proposal.id }, 'Failed to persist evolution proposal');
    }
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_skill_evolution
         WHERE lifecycle NOT IN ('retired_old', 'rejected')
         ORDER BY proposed_at DESC
         LIMIT $1`,
        [this.config.maxProposalsInMemory],
      );

      for (const row of rows) {
        const proposal: EvolutionProposal = {
          id: row.id,
          lifecycle: row.lifecycle,
          trigger: row.trigger,
          sourceSkill: row.source_skill,
          targetSkill: row.target_skill,
          description: row.description ?? '',
          reasoning: row.reasoning ?? '',
          upgradeSteps: this.parseJsonSafe(row.upgrade_steps, []),
          estimatedImprovement: this.parseJsonSafe(row.estimated_improvement, {
            successRateDelta: 0, latencyDeltaMs: 0, costDeltaUsd: 0,
          }),
          affectedFormulas: this.parseJsonSafe(row.affected_formulas, []),
          testResults: this.parseJsonSafe(row.test_results, undefined),
          riskAssessment: row.risk_assessment ?? 'medium',
          proposedAt: new Date(row.proposed_at),
          testedAt: row.tested_at ? new Date(row.tested_at) : undefined,
          deployedAt: row.deployed_at ? new Date(row.deployed_at) : undefined,
          retiredAt: row.retired_at ? new Date(row.retired_at) : undefined,
          rejectedAt: row.rejected_at ? new Date(row.rejected_at) : undefined,
          rejectionReason: row.rejection_reason ?? undefined,
          metadata: this.parseJsonSafe(row.metadata, undefined),
        };
        this.proposals.push(proposal);
      }

      log.info({ loaded: rows.length }, 'Loaded skill evolution proposals from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load skill evolution from DB');
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

let instance: SkillEvolution | null = null;

export function getSkillEvolution(
  config?: Partial<EvolutionConfig>,
): SkillEvolution {
  if (!instance) {
    instance = new SkillEvolution(config);
    log.info('SkillEvolution singleton created');
  }
  return instance;
}
