/**
 * WORKER SPECIALIZATION — SG-015 (Stage 06 Wave 4)
 *
 * Workers develop specializations over time through emergent behavior.
 * The system observes worker performance across domains, detects natural
 * aptitudes, assigns specialization tags, and routes future tasks accordingly.
 *
 * Features:
 *   - Track worker performance per skill/formula/domain (regional copy, EU ads, content creation)
 *   - Detect natural specializations: "this worker consistently excels at X"
 *   - Assign specialization tags: affects future task routing (prefer specialists)
 *   - Specialization levels: novice → competent → proficient → expert → master
 *   - De-specialization: if worker hasn't done specialized work in 30 days, decay level
 *   - Cross-training: occasionally assign non-specialized tasks to prevent tunnel vision
 *   - Specialization map: visual data of all workers × specializations
 *   - DB table: meow_worker_specializations
 *
 * Integration: reads from worker-performance-learning.ts (Stage 05 CG-007)
 *
 * Gas Town: "A road warrior who finds their niche becomes a legend."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('worker-specialization');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecializationLevel =
  | 'novice'
  | 'competent'
  | 'proficient'
  | 'expert'
  | 'master';

export type SpecializationDomain =
  | 'regional_copy'
  | 'eu_ads'
  | 'content_creation'
  | 'campaign_management'
  | 'fulfillment'
  | 'analytics'
  | 'creative_design'
  | 'audience_research'
  | 'pricing_optimization'
  | 'recovery_operations'
  | 'market_intelligence'
  | 'email_marketing'
  | 'video_production'
  | 'seo_optimization'
  | 'customer_support';

export interface DomainPerformance {
  domain: SpecializationDomain;
  totalTasks: number;
  successfulTasks: number;
  successRate: number;           // 0.0 - 1.0
  avgQuality: number;            // 1-10
  avgDurationMs: number;
  lastTaskAt: Date | null;
  trendDirection: 'improving' | 'stable' | 'declining';
  trendMagnitude: number;        // 0.0 - 1.0
}

export interface WorkerSpecialization {
  id: string;
  workerId: string;
  domain: SpecializationDomain;
  level: SpecializationLevel;
  levelNumeric: number;          // 1-5 for math operations
  xpPoints: number;              // accumulated experience points
  xpToNextLevel: number;
  successRate: number;           // 0.0 - 1.0, domain-specific
  avgQuality: number;            // 1-10, domain-specific
  totalTasks: number;
  consecutiveSuccesses: number;
  lastTaskAt: Date | null;
  lastDecayAt: Date | null;
  decayWarning: boolean;         // true if approaching de-specialization
  createdAt: Date;
  updatedAt: Date;
}

export interface SpecializationEvent {
  id: string;
  workerId: string;
  domain: SpecializationDomain;
  eventType: 'level_up' | 'level_down' | 'decay' | 'cross_train' | 'specialization_detected' | 'task_completed';
  fromLevel?: SpecializationLevel;
  toLevel?: SpecializationLevel;
  details: string;
  createdAt: Date;
}

export interface CrossTrainingAssignment {
  id: string;
  workerId: string;
  primaryDomain: SpecializationDomain;
  assignedDomain: SpecializationDomain;
  reason: string;
  assignedAt: Date;
  completedAt?: Date;
  result?: 'success' | 'failure' | 'partial';
}

export interface SpecializationMapEntry {
  workerId: string;
  workerName?: string;
  specializations: Array<{
    domain: SpecializationDomain;
    level: SpecializationLevel;
    levelNumeric: number;
    xpPoints: number;
    successRate: number;
  }>;
  primaryDomain: SpecializationDomain | null;
  crossTrainingCount: number;
}

export interface SpecializationConfig {
  xpPerSuccess: number;
  xpPerFailure: number;           // negative XP for failures
  xpLevelThresholds: number[];    // [0, 50, 150, 400, 1000] for 5 levels
  decayDays: number;              // days of inactivity before decay
  decayCheckIntervalMs: number;
  crossTrainProbability: number;  // 0.0 - 1.0, chance to assign non-specialized task
  minTasksForDetection: number;   // minimum tasks before specialization detected
  minSuccessRateForDetection: number;  // minimum success rate to qualify
  qualityBoostThreshold: number;  // quality above this in domain = bonus XP
  maxInMemory: number;
}

export interface SpecializationStats {
  totalWorkers: number;
  workersByLevel: Record<string, number>;
  topDomains: Array<{ domain: string; workerCount: number }>;
  avgXpPerWorker: number;
  masterCount: number;
  crossTrainingAssignments: number;
  decaysThisCycle: number;
  promotionsThisCycle: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SpecializationConfig = {
  xpPerSuccess: 10,
  xpPerFailure: -3,
  xpLevelThresholds: [0, 50, 150, 400, 1000],
  decayDays: 30,
  decayCheckIntervalMs: 6 * 60 * 60 * 1000,  // 6 hours
  crossTrainProbability: 0.1,
  minTasksForDetection: 10,
  minSuccessRateForDetection: 0.85,
  qualityBoostThreshold: 8,
  maxInMemory: 5_000,
};

const LEVEL_NAMES: SpecializationLevel[] = [
  'novice', 'competent', 'proficient', 'expert', 'master',
];

const VALID_DOMAINS: SpecializationDomain[] = [
  'regional_copy', 'eu_ads', 'content_creation', 'campaign_management',
  'fulfillment', 'analytics', 'creative_design', 'audience_research',
  'pricing_optimization', 'recovery_operations', 'market_intelligence',
  'email_marketing', 'video_production', 'seo_optimization', 'customer_support',
];

// Skill-to-domain mapping heuristics
const SKILL_DOMAIN_MAP: Record<string, SpecializationDomain> = {
  'meta_ads': 'campaign_management',
  'google_ads': 'campaign_management',
  'shopify_': 'fulfillment',
  'copy_': 'regional_copy',
  'content_': 'content_creation',
  'creative_': 'creative_design',
  'analytics_': 'analytics',
  'video_': 'video_production',
  'email_': 'email_marketing',
  'seo_': 'seo_optimization',
  'scrape_': 'market_intelligence',
  'intel_': 'market_intelligence',
  'audience_': 'audience_research',
  'pricing_': 'pricing_optimization',
  'recovery_': 'recovery_operations',
  'support_': 'customer_support',
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
              content:
                'You are a worker specialization analyst for the Gas Town MEOW system. '
                + 'You analyze worker performance patterns to detect natural specializations and recommend routing optimizations. '
                + 'Respond ONLY with valid JSON.',
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
    log.warn({ err }, 'Gemini call failed in worker-specialization');
    return null;
  }
}

// ---------------------------------------------------------------------------
// WorkerSpecializationEngine
// ---------------------------------------------------------------------------

export class WorkerSpecializationEngine {
  private config: SpecializationConfig;
  private specializations = new Map<string, WorkerSpecialization>();  // key: workerId:domain
  private events: SpecializationEvent[] = [];
  private crossTrainings: CrossTrainingAssignment[] = [];
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  private decaysThisCycle = 0;
  private promotionsThisCycle = 0;

  constructor(config?: Partial<SpecializationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info({ config: this.config }, 'WorkerSpecializationEngine created');
  }

  // --- Lifecycle -------------------------------------------------------------

  start(): void {
    if (this.decayTimer) return;

    this.decayTimer = setInterval(() => {
      this.runDecayCheck().catch(err =>
        log.error({ err }, 'Worker specialization decay check failed'),
      );
    }, this.config.decayCheckIntervalMs);

    broadcast('meow:sovereign', {
      type: 'worker_specialization_started',
      decayCheckIntervalMs: this.config.decayCheckIntervalMs,
      domainsTracked: VALID_DOMAINS.length,
    });

    log.info('WorkerSpecializationEngine started');
  }

  stop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
    log.info('WorkerSpecializationEngine stopped');
  }

  // --- Record task completion ------------------------------------------------

  async recordTaskCompletion(params: {
    workerId: string;
    skillName: string;
    formulaName?: string;
    success: boolean;
    quality?: number;
    durationMs: number;
  }): Promise<WorkerSpecialization | null> {
    const domain = this.inferDomain(params.skillName, params.formulaName);
    if (!domain) {
      log.debug({ skillName: params.skillName }, 'Could not infer domain for skill');
      return null;
    }

    const key = `${params.workerId}:${domain}`;
    let spec = this.specializations.get(key);

    if (!spec) {
      spec = this.createSpecialization(params.workerId, domain);
      this.specializations.set(key, spec);
    }

    // Update metrics
    spec.totalTasks += 1;
    if (params.success) {
      spec.consecutiveSuccesses += 1;
      spec.xpPoints += this.config.xpPerSuccess;

      // Quality bonus
      if (params.quality != null && params.quality >= this.config.qualityBoostThreshold) {
        spec.xpPoints += Math.round(this.config.xpPerSuccess * 0.5);
      }

      // Consecutive success bonus
      if (spec.consecutiveSuccesses >= 5) {
        spec.xpPoints += Math.round(this.config.xpPerSuccess * 0.3);
      }
    } else {
      spec.consecutiveSuccesses = 0;
      spec.xpPoints = Math.max(0, spec.xpPoints + this.config.xpPerFailure);
    }

    // Recalculate success rate (exponential moving average)
    const alpha = 0.1;
    const successVal = params.success ? 1 : 0;
    spec.successRate = alpha * successVal + (1 - alpha) * spec.successRate;

    if (params.quality != null) {
      spec.avgQuality = alpha * params.quality + (1 - alpha) * spec.avgQuality;
    }

    spec.lastTaskAt = new Date();
    spec.decayWarning = false;
    spec.updatedAt = new Date();

    // Check for level up
    const oldLevel = spec.level;
    const newLevelIdx = this.calculateLevel(spec.xpPoints);
    spec.level = LEVEL_NAMES[newLevelIdx];
    spec.levelNumeric = newLevelIdx + 1;
    spec.xpToNextLevel = newLevelIdx < 4
      ? this.config.xpLevelThresholds[newLevelIdx + 1] - spec.xpPoints
      : 0;

    if (LEVEL_NAMES.indexOf(spec.level) > LEVEL_NAMES.indexOf(oldLevel)) {
      this.promotionsThisCycle += 1;
      this.emitEvent(params.workerId, domain, 'level_up', {
        fromLevel: oldLevel,
        toLevel: spec.level,
        details: `Worker promoted to ${spec.level} in ${domain} (XP: ${spec.xpPoints})`,
      });

      broadcast('meow:sovereign', {
        type: 'worker_specialization_level_up',
        workerId: params.workerId,
        domain,
        fromLevel: oldLevel,
        toLevel: spec.level,
        xpPoints: spec.xpPoints,
      });
    }

    // Detect new specialization
    if (oldLevel === 'novice' && spec.level !== 'novice'
      && spec.totalTasks >= this.config.minTasksForDetection
      && spec.successRate >= this.config.minSuccessRateForDetection) {
      this.emitEvent(params.workerId, domain, 'specialization_detected', {
        details: `Natural specialization detected: ${domain} (success rate: ${(spec.successRate * 100).toFixed(1)}%, tasks: ${spec.totalTasks})`,
      });

      broadcast('meow:sovereign', {
        type: 'worker_specialization_detected',
        workerId: params.workerId,
        domain,
        successRate: spec.successRate,
        totalTasks: spec.totalTasks,
      });
    }

    this.trimMemory();
    await this.persistSpecialization(spec);

    return spec;
  }

  // --- Decay check -----------------------------------------------------------

  async runDecayCheck(): Promise<number> {
    const now = Date.now();
    const decayThresholdMs = this.config.decayDays * 24 * 60 * 60 * 1000;
    const warningThresholdMs = decayThresholdMs * 0.8;  // warn at 80% of decay period
    let decayCount = 0;

    for (const [key, spec] of this.specializations) {
      if (spec.level === 'novice') continue;
      if (!spec.lastTaskAt) continue;

      const inactiveMs = now - spec.lastTaskAt.getTime();

      // Warning phase
      if (inactiveMs > warningThresholdMs && !spec.decayWarning) {
        spec.decayWarning = true;
        spec.updatedAt = new Date();
        const daysLeft = Math.round((decayThresholdMs - inactiveMs) / (24 * 60 * 60 * 1000));
        log.info({ workerId: spec.workerId, domain: spec.domain, daysLeft }, 'Decay warning issued');
      }

      // Actual decay
      if (inactiveMs > decayThresholdMs) {
        const oldLevel = spec.level;
        const oldLevelIdx = LEVEL_NAMES.indexOf(spec.level);

        if (oldLevelIdx > 0) {
          spec.level = LEVEL_NAMES[oldLevelIdx - 1];
          spec.levelNumeric = oldLevelIdx;  // was idx+1, now idx
          spec.xpPoints = Math.max(0, spec.xpPoints - Math.round(this.config.xpLevelThresholds[oldLevelIdx] * 0.3));
          spec.lastDecayAt = new Date();
          spec.decayWarning = false;
          spec.updatedAt = new Date();
          decayCount += 1;
          this.decaysThisCycle += 1;

          this.emitEvent(spec.workerId, spec.domain, 'decay', {
            fromLevel: oldLevel,
            toLevel: spec.level,
            details: `Inactivity decay: ${oldLevel} → ${spec.level} in ${spec.domain} (inactive ${Math.round(inactiveMs / (24 * 60 * 60 * 1000))} days)`,
          });

          await this.persistSpecialization(spec);
        }
      }
    }

    if (decayCount > 0) {
      broadcast('meow:sovereign', {
        type: 'worker_specialization_decay',
        decayCount,
      });
      log.info({ decayCount }, 'Decay check completed');
    }

    return decayCount;
  }

  // --- Cross-training --------------------------------------------------------

  async suggestCrossTraining(workerId: string): Promise<CrossTrainingAssignment | null> {
    // Find worker's primary specialization
    const workerSpecs = this.getWorkerSpecializations(workerId);
    if (workerSpecs.length === 0) return null;

    const primary = workerSpecs.sort((a, b) => b.xpPoints - a.xpPoints)[0];

    // Only cross-train if above competent level
    if (LEVEL_NAMES.indexOf(primary.level) < 1) return null;

    // Random check against probability
    if (Math.random() > this.config.crossTrainProbability) return null;

    // Find weakest domain (or one never attempted)
    const activeDomains = new Set(workerSpecs.map(s => s.domain));
    const unexploredDomains = VALID_DOMAINS.filter(d => !activeDomains.has(d));

    let assignedDomain: SpecializationDomain;
    if (unexploredDomains.length > 0) {
      assignedDomain = unexploredDomains[Math.floor(Math.random() * unexploredDomains.length)];
    } else {
      // Pick the weakest existing domain
      const weakest = workerSpecs.sort((a, b) => a.xpPoints - b.xpPoints)[0];
      assignedDomain = weakest.domain;
    }

    // Use AI to reason about cross-training benefit
    let reason = `Diversification: assign ${assignedDomain} to prevent tunnel vision in ${primary.domain}`;

    const prompt = `A worker is specialized in "${primary.domain}" (level: ${primary.level}, XP: ${primary.xpPoints}).
We want to cross-train them in "${assignedDomain}".
Provide a brief reason why this cross-training is beneficial.
Return JSON: {"reason": "..."}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as { reason: string };
        reason = parsed.reason ?? reason;
      } catch {
        // Use heuristic reason
      }
    }

    const assignment: CrossTrainingAssignment = {
      id: uuidv4(),
      workerId,
      primaryDomain: primary.domain,
      assignedDomain,
      reason,
      assignedAt: new Date(),
    };

    this.crossTrainings.push(assignment);

    this.emitEvent(workerId, assignedDomain, 'cross_train', {
      details: `Cross-training assigned: ${primary.domain} → ${assignedDomain}. Reason: ${reason}`,
    });

    broadcast('meow:sovereign', {
      type: 'worker_cross_training_assigned',
      workerId,
      primaryDomain: primary.domain,
      assignedDomain,
    });

    log.info({ workerId, primary: primary.domain, assigned: assignedDomain }, 'Cross-training assigned');
    return assignment;
  }

  // --- Task routing recommendation -------------------------------------------

  recommendWorker(
    domain: SpecializationDomain,
    availableWorkerIds: string[],
    preferSpecialist: boolean = true,
  ): { workerId: string; reason: string } | null {
    if (availableWorkerIds.length === 0) return null;

    const candidates: Array<{ workerId: string; score: number; level: SpecializationLevel }> = [];

    for (const wid of availableWorkerIds) {
      const spec = this.specializations.get(`${wid}:${domain}`);
      if (spec) {
        const score = spec.levelNumeric * 20 + spec.successRate * 30 + spec.avgQuality * 5;
        candidates.push({ workerId: wid, score, level: spec.level });
      } else {
        // Unknown worker gets base score
        candidates.push({ workerId: wid, score: 10, level: 'novice' });
      }
    }

    if (preferSpecialist) {
      candidates.sort((a, b) => b.score - a.score);
    } else {
      // For cross-training: prefer less specialized
      candidates.sort((a, b) => a.score - b.score);
    }

    const selected = candidates[0];
    return {
      workerId: selected.workerId,
      reason: preferSpecialist
        ? `Best specialist for ${domain}: level=${selected.level}, score=${selected.score.toFixed(1)}`
        : `Cross-training candidate for ${domain}: level=${selected.level}`,
    };
  }

  // --- Specialization map ----------------------------------------------------

  getSpecializationMap(): SpecializationMapEntry[] {
    const workerMap = new Map<string, WorkerSpecialization[]>();

    for (const spec of this.specializations.values()) {
      const existing = workerMap.get(spec.workerId) ?? [];
      existing.push(spec);
      workerMap.set(spec.workerId, existing);
    }

    const entries: SpecializationMapEntry[] = [];

    for (const [workerId, specs] of workerMap) {
      const sorted = specs.sort((a, b) => b.xpPoints - a.xpPoints);
      const crossTrainCount = this.crossTrainings.filter(ct => ct.workerId === workerId).length;

      entries.push({
        workerId,
        specializations: sorted.map(s => ({
          domain: s.domain,
          level: s.level,
          levelNumeric: s.levelNumeric,
          xpPoints: s.xpPoints,
          successRate: s.successRate,
        })),
        primaryDomain: sorted.length > 0 ? sorted[0].domain : null,
        crossTrainingCount: crossTrainCount,
      });
    }

    return entries;
  }

  // --- AI specialization analysis --------------------------------------------

  async analyzeWorker(workerId: string): Promise<{
    primaryStrength: string;
    growthAreas: string[];
    recommendations: string[];
  }> {
    const specs = this.getWorkerSpecializations(workerId);
    if (specs.length === 0) {
      return {
        primaryStrength: 'none (no data)',
        growthAreas: ['all domains'],
        recommendations: ['Assign diverse tasks to discover natural aptitudes'],
      };
    }

    const specSummary = specs.map(s =>
      `${s.domain}: level=${s.level}, xp=${s.xpPoints}, success=${(s.successRate * 100).toFixed(0)}%, tasks=${s.totalTasks}`,
    ).join('\n');

    const prompt = `Analyze worker specialization profile:
Worker: ${workerId}
Specializations:
${specSummary}

Return JSON:
{"primaryStrength": "...", "growthAreas": ["..."], "recommendations": ["..."]}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const cleaned = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as {
          primaryStrength: string;
          growthAreas: string[];
          recommendations: string[];
        };
        return {
          primaryStrength: parsed.primaryStrength ?? specs[0].domain,
          growthAreas: Array.isArray(parsed.growthAreas) ? parsed.growthAreas.slice(0, 5) : [],
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
        };
      } catch {
        // Fallback below
      }
    }

    // Heuristic fallback
    const sorted = specs.sort((a, b) => b.xpPoints - a.xpPoints);
    const weak = specs.filter(s => s.successRate < 0.7).map(s => s.domain);

    return {
      primaryStrength: sorted[0].domain,
      growthAreas: weak.length > 0 ? weak : ['explore new domains'],
      recommendations: [
        `Continue ${sorted[0].domain} tasks to advance toward ${LEVEL_NAMES[Math.min(4, sorted[0].levelNumeric)]}`,
        weak.length > 0 ? `Improve in ${weak[0]} with targeted practice` : 'Consider cross-training in unexplored domains',
      ],
    };
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): SpecializationStats {
    const workerSet = new Set<string>();
    const byLevel: Record<string, number> = {};
    const domainCounts = new Map<string, Set<string>>();
    let xpTotal = 0;

    for (const spec of this.specializations.values()) {
      workerSet.add(spec.workerId);
      byLevel[spec.level] = (byLevel[spec.level] ?? 0) + 1;
      xpTotal += spec.xpPoints;

      if (!domainCounts.has(spec.domain)) domainCounts.set(spec.domain, new Set());
      domainCounts.get(spec.domain)!.add(spec.workerId);
    }

    const topDomains = Array.from(domainCounts.entries())
      .map(([domain, workers]) => ({ domain, workerCount: workers.size }))
      .sort((a, b) => b.workerCount - a.workerCount)
      .slice(0, 10);

    return {
      totalWorkers: workerSet.size,
      workersByLevel: byLevel,
      topDomains,
      avgXpPerWorker: workerSet.size > 0 ? Math.round(xpTotal / workerSet.size) : 0,
      masterCount: byLevel['master'] ?? 0,
      crossTrainingAssignments: this.crossTrainings.length,
      decaysThisCycle: this.decaysThisCycle,
      promotionsThisCycle: this.promotionsThisCycle,
    };
  }

  // --- Getters ---------------------------------------------------------------

  getWorkerSpecializations(workerId: string): WorkerSpecialization[] {
    return Array.from(this.specializations.values())
      .filter(s => s.workerId === workerId);
  }

  getSpecialization(workerId: string, domain: SpecializationDomain): WorkerSpecialization | undefined {
    return this.specializations.get(`${workerId}:${domain}`);
  }

  getRecentEvents(limit: number = 50): SpecializationEvent[] {
    return this.events.slice(-limit);
  }

  getCrossTrainings(workerId?: string): CrossTrainingAssignment[] {
    if (workerId) return this.crossTrainings.filter(ct => ct.workerId === workerId);
    return [...this.crossTrainings];
  }

  // --- Domain inference ------------------------------------------------------

  private inferDomain(skillName: string, formulaName?: string): SpecializationDomain | null {
    const combined = `${skillName}_${formulaName ?? ''}`.toLowerCase();

    for (const [pattern, domain] of Object.entries(SKILL_DOMAIN_MAP)) {
      if (combined.includes(pattern)) return domain;
    }

    // Check formula name for clues
    if (formulaName) {
      const fl = formulaName.toLowerCase();
      if (fl.includes('regional') || fl.includes('local')) return 'regional_copy';
      if (fl.includes('eu') || fl.includes('europe')) return 'eu_ads';
      if (fl.includes('content') || fl.includes('blog')) return 'content_creation';
      if (fl.includes('campaign') || fl.includes('ads')) return 'campaign_management';
      if (fl.includes('fulfill') || fl.includes('ship')) return 'fulfillment';
      if (fl.includes('analyt') || fl.includes('report')) return 'analytics';
      if (fl.includes('recover') || fl.includes('rescue')) return 'recovery_operations';
    }

    return null;
  }

  // --- Helpers ---------------------------------------------------------------

  private createSpecialization(
    workerId: string,
    domain: SpecializationDomain,
  ): WorkerSpecialization {
    const now = new Date();
    return {
      id: uuidv4(),
      workerId,
      domain,
      level: 'novice',
      levelNumeric: 1,
      xpPoints: 0,
      xpToNextLevel: this.config.xpLevelThresholds[1],
      successRate: 0.5,
      avgQuality: 5,
      totalTasks: 0,
      consecutiveSuccesses: 0,
      lastTaskAt: null,
      lastDecayAt: null,
      decayWarning: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private calculateLevel(xp: number): number {
    const thresholds = this.config.xpLevelThresholds;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (xp >= thresholds[i]) return i;
    }
    return 0;
  }

  private emitEvent(
    workerId: string,
    domain: SpecializationDomain,
    eventType: SpecializationEvent['eventType'],
    data: { fromLevel?: SpecializationLevel; toLevel?: SpecializationLevel; details: string },
  ): void {
    const event: SpecializationEvent = {
      id: uuidv4(),
      workerId,
      domain,
      eventType,
      fromLevel: data.fromLevel,
      toLevel: data.toLevel,
      details: data.details,
      createdAt: new Date(),
    };
    this.events.push(event);
    if (this.events.length > 5_000) {
      this.events = this.events.slice(-5_000);
    }
  }

  private trimMemory(): void {
    if (this.specializations.size > this.config.maxInMemory) {
      const entries = Array.from(this.specializations.entries())
        .sort((a, b) => (a[1].updatedAt.getTime()) - (b[1].updatedAt.getTime()));
      const toRemove = entries.slice(0, entries.length - this.config.maxInMemory);
      for (const [key] of toRemove) {
        this.specializations.delete(key);
      }
    }
    if (this.crossTrainings.length > 2_000) {
      this.crossTrainings = this.crossTrainings.slice(-2_000);
    }
  }

  // --- DB persistence --------------------------------------------------------

  private async persistSpecialization(spec: WorkerSpecialization): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_worker_specializations
          (id, worker_id, domain, level, level_numeric, xp_points, xp_to_next_level,
           success_rate, avg_quality, total_tasks, consecutive_successes,
           last_task_at, last_decay_at, decay_warning, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           level = EXCLUDED.level,
           level_numeric = EXCLUDED.level_numeric,
           xp_points = EXCLUDED.xp_points,
           xp_to_next_level = EXCLUDED.xp_to_next_level,
           success_rate = EXCLUDED.success_rate,
           avg_quality = EXCLUDED.avg_quality,
           total_tasks = EXCLUDED.total_tasks,
           consecutive_successes = EXCLUDED.consecutive_successes,
           last_task_at = EXCLUDED.last_task_at,
           last_decay_at = EXCLUDED.last_decay_at,
           decay_warning = EXCLUDED.decay_warning,
           updated_at = EXCLUDED.updated_at`,
        [
          spec.id,
          spec.workerId,
          spec.domain,
          spec.level,
          spec.levelNumeric,
          spec.xpPoints,
          spec.xpToNextLevel,
          spec.successRate,
          spec.avgQuality,
          spec.totalTasks,
          spec.consecutiveSuccesses,
          spec.lastTaskAt?.toISOString() ?? null,
          spec.lastDecayAt?.toISOString() ?? null,
          spec.decayWarning,
          spec.createdAt.toISOString(),
          spec.updatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, specId: spec.id }, 'Failed to persist worker specialization');
    }
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_worker_specializations ORDER BY updated_at DESC LIMIT $1`,
        [this.config.maxInMemory],
      );

      for (const row of rows) {
        const spec: WorkerSpecialization = {
          id: row.id,
          workerId: row.worker_id,
          domain: row.domain,
          level: row.level ?? 'novice',
          levelNumeric: parseInt(row.level_numeric ?? '1', 10),
          xpPoints: parseInt(row.xp_points ?? '0', 10),
          xpToNextLevel: parseInt(row.xp_to_next_level ?? '50', 10),
          successRate: parseFloat(row.success_rate ?? '0.5'),
          avgQuality: parseFloat(row.avg_quality ?? '5'),
          totalTasks: parseInt(row.total_tasks ?? '0', 10),
          consecutiveSuccesses: parseInt(row.consecutive_successes ?? '0', 10),
          lastTaskAt: row.last_task_at ? new Date(row.last_task_at) : null,
          lastDecayAt: row.last_decay_at ? new Date(row.last_decay_at) : null,
          decayWarning: row.decay_warning ?? false,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
        this.specializations.set(`${spec.workerId}:${spec.domain}`, spec);
      }

      log.info({ loaded: rows.length }, 'Loaded worker specializations from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load worker specializations from DB');
    }
  }

  /** Reset cycle counters — call at start of each monitoring cycle */
  resetCycleCounters(): void {
    this.decaysThisCycle = 0;
    this.promotionsThisCycle = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WorkerSpecializationEngine | null = null;

export function getWorkerSpecializationEngine(
  config?: Partial<SpecializationConfig>,
): WorkerSpecializationEngine {
  if (!instance) {
    instance = new WorkerSpecializationEngine(config);
    log.info('WorkerSpecializationEngine singleton created');
  }
  return instance;
}
