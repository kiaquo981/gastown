/**
 * CIRCADIAN RHYTHM — SG-009 (Stage 06 Wave 3)
 *
 * Gas Town operates in daily cycles auto-adjusted by timezone.
 * Each phase of the day maps to a distinct operational focus:
 *
 *   Morning  (06-12): Intel gathering — market research, competitor monitoring, metric collection
 *   Midday   (12-18): Execution — campaign launches, content creation, fulfillment processing
 *   Evening  (18-22): Optimization — ROAS optimization, A/B test analysis, budget reallocation
 *   Night    (22-06): Audit — performance audit, system health, cleanup, planning for next day
 *
 * Features:
 *   - Phase-specific formula trigger lists with resource allocation weights
 *   - Timezone-aware: adjusts phases based on business unit timezone
 *   - Phase transition: broadcast event, adjust worker allocation, shift formula priorities
 *   - Override: human can force phase change or extend current phase
 *   - DB persistence: meow_circadian_log for phase transitions and activities
 *   - Current phase query + next transition time
 *
 * Gas Town: "The refinery breathes with the sun — gather, build, refine, rest."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('circadian-rhythm');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircadianPhase = 'morning' | 'midday' | 'evening' | 'night';

export type PhaseTransitionReason =
  | 'scheduled'
  | 'manual_override'
  | 'extension_expired'
  | 'crisis_override'
  | 'timezone_shift';

export interface PhaseDefinition {
  phase: CircadianPhase;
  label: string;
  startHour: number;          // 0-23, local time
  endHour: number;            // 0-23, local time
  focus: string;
  formulaTriggers: string[];  // formula names to prioritize
  resourceWeights: ResourceWeights;
  priorityAdjustments: PriorityAdjustment[];
}

export interface ResourceWeights {
  llmAllocationPct: number;       // percentage of LLM capacity to allocate
  workerAllocationPct: number;    // percentage of workers to activate
  externalApiPct: number;         // percentage of external API rate budget
  maxConcurrentFormulas: number;
}

export interface PriorityAdjustment {
  formulaPattern: string;         // glob-like pattern for formula names
  priorityBoost: number;          // -5 to +5, added to base priority
  reason: string;
}

export interface CircadianTransition {
  id: string;
  fromPhase: CircadianPhase | null;
  toPhase: CircadianPhase;
  reason: PhaseTransitionReason;
  timezone: string;
  localHour: number;
  activatedFormulas: string[];
  deactivatedFormulas: string[];
  overrideBy?: string;            // operator ID if manual
  overrideUntil?: Date;           // if phase extension was requested
  createdAt: Date;
}

export interface CircadianOverride {
  id: string;
  operatorId: string;
  targetPhase: CircadianPhase;
  reason: string;
  expiresAt: Date;
  active: boolean;
  createdAt: Date;
}

export interface CircadianStatus {
  currentPhase: CircadianPhase;
  phaseLabel: string;
  phaseFocus: string;
  phaseStartedAt: Date;
  nextTransitionAt: Date;
  nextPhase: CircadianPhase;
  timezone: string;
  localHour: number;
  isOverridden: boolean;
  overrideExpiresAt?: Date;
  resourceWeights: ResourceWeights;
  activeFormulaTriggers: string[];
  transitionsToday: number;
}

export interface CircadianStats {
  totalTransitions: number;
  transitionsToday: number;
  overridesToday: number;
  avgPhaseDurationMinutes: Record<CircadianPhase, number>;
  currentPhase: CircadianPhase;
  uptime24h: Record<CircadianPhase, number>;    // minutes per phase last 24h
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHASE_ORDER: CircadianPhase[] = ['morning', 'midday', 'evening', 'night'];

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

const DEFAULT_PHASE_DEFINITIONS: PhaseDefinition[] = [
  {
    phase: 'morning',
    label: 'Intel Gathering',
    startHour: 6,
    endHour: 12,
    focus: 'Market research, competitor monitoring, metric collection',
    formulaTriggers: [
      'market-research', 'competitor-scan', 'metric-collection',
      'product-mining', 'trend-detection', 'intel-digest',
    ],
    resourceWeights: {
      llmAllocationPct: 40,
      workerAllocationPct: 50,
      externalApiPct: 70,   // heavy external scraping
      maxConcurrentFormulas: 6,
    },
    priorityAdjustments: [
      { formulaPattern: '*-intel-*', priorityBoost: 3, reason: 'Morning intel priority' },
      { formulaPattern: '*-research-*', priorityBoost: 2, reason: 'Morning research priority' },
      { formulaPattern: '*-campaign-*', priorityBoost: -2, reason: 'Campaigns defer to midday' },
    ],
  },
  {
    phase: 'midday',
    label: 'Execution',
    startHour: 12,
    endHour: 18,
    focus: 'Campaign launches, content creation, fulfillment processing',
    formulaTriggers: [
      'campaign-launch', 'content-creation', 'fulfillment-process',
      'ad-deployment', 'lp-generation', 'shopify-sync',
    ],
    resourceWeights: {
      llmAllocationPct: 70,
      workerAllocationPct: 80,
      externalApiPct: 60,
      maxConcurrentFormulas: 10,
    },
    priorityAdjustments: [
      { formulaPattern: '*-campaign-*', priorityBoost: 3, reason: 'Midday execution priority' },
      { formulaPattern: '*-content-*', priorityBoost: 2, reason: 'Midday content priority' },
      { formulaPattern: '*-audit-*', priorityBoost: -3, reason: 'Audits defer to night' },
    ],
  },
  {
    phase: 'evening',
    label: 'Optimization',
    startHour: 18,
    endHour: 22,
    focus: 'ROAS optimization, A/B test analysis, budget reallocation',
    formulaTriggers: [
      'roas-optimization', 'ab-test-analysis', 'budget-reallocation',
      'performance-review', 'creative-scoring', 'audience-refine',
    ],
    resourceWeights: {
      llmAllocationPct: 60,
      workerAllocationPct: 60,
      externalApiPct: 40,
      maxConcurrentFormulas: 8,
    },
    priorityAdjustments: [
      { formulaPattern: '*-optim*', priorityBoost: 3, reason: 'Evening optimization priority' },
      { formulaPattern: '*-analysis-*', priorityBoost: 2, reason: 'Evening analysis priority' },
      { formulaPattern: '*-research-*', priorityBoost: -2, reason: 'Research defers to morning' },
    ],
  },
  {
    phase: 'night',
    label: 'Audit & Planning',
    startHour: 22,
    endHour: 6,
    focus: 'Performance audit, system health, cleanup, planning for next day',
    formulaTriggers: [
      'performance-audit', 'system-health', 'cleanup', 'daily-planning',
      'log-rotation', 'stale-archival', 'cost-reconciliation',
    ],
    resourceWeights: {
      llmAllocationPct: 30,
      workerAllocationPct: 30,
      externalApiPct: 20,
      maxConcurrentFormulas: 4,
    },
    priorityAdjustments: [
      { formulaPattern: '*-audit-*', priorityBoost: 3, reason: 'Night audit priority' },
      { formulaPattern: '*-health-*', priorityBoost: 2, reason: 'Night health priority' },
      { formulaPattern: '*-campaign-*', priorityBoost: -4, reason: 'No campaigns at night' },
    ],
  },
];

/** Timezone aliases for common business regions */
const TIMEZONE_PRESETS: Record<string, string> = {
  'region-br': 'America/Sao_Paulo',
  'region-ar': 'America/Argentina/Buenos_Aires',
  'region-mx': 'America/Mexico_City',
  'region-co': 'America/Bogota',
  'eu-pt': 'Europe/Lisbon',
  'eu-es': 'Europe/Madrid',
  'us-east': 'America/New_York',
  'us-west': 'America/Los_Angeles',
};

const MAX_LOG_IN_MEMORY = 500;

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiCircadian(context: string): Promise<string | null> {
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
                'You are a circadian rhythm optimizer for an AI agent platform called Gas Town. '
                + 'Given operational data and time-of-day context, suggest phase adjustments, '
                + 'formula priorities, and resource allocation tweaks. '
                + 'Respond ONLY with valid JSON: {"phaseAdvice": "...", "formulaBoosts": [{"name": "...", "boost": -5..5}], '
                + '"resourceTweak": {"llmPct": 0-100, "workerPct": 0-100}, "reasoning": "..."}',
            },
            { role: 'user', content: context },
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
    log.warn({ err }, 'Gemini circadian call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// CircadianRhythm
// ---------------------------------------------------------------------------

export class CircadianRhythm {
  private currentPhase: CircadianPhase = 'morning';
  private phaseStartedAt: Date = new Date();
  private timezone: string = DEFAULT_TIMEZONE;
  private phaseDefinitions: PhaseDefinition[] = [...DEFAULT_PHASE_DEFINITIONS];
  private transitionLog: CircadianTransition[] = [];
  private activeOverride: CircadianOverride | null = null;
  private transitionsToday = 0;
  private overridesToday = 0;
  private totalTransitions = 0;
  private phaseDurations: Record<CircadianPhase, number[]> = {
    morning: [], midday: [], evening: [], night: [],
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(timezone?: string): Promise<void> {
    if (this.initialized) return;

    if (timezone) {
      this.timezone = TIMEZONE_PRESETS[timezone] ?? timezone;
    }

    const localHour = this.getLocalHour();
    this.currentPhase = this.phaseForHour(localHour);
    this.phaseStartedAt = new Date();

    await this.loadFromDb();

    log.info({
      phase: this.currentPhase,
      timezone: this.timezone,
      localHour,
    }, 'Circadian rhythm initialized');

    this.initialized = true;

    broadcast('meow:sovereign', {
      type: 'circadian:initialized',
      phase: this.currentPhase,
      timezone: this.timezone,
      localHour,
    });
  }

  // -------------------------------------------------------------------------
  // Phase resolution
  // -------------------------------------------------------------------------

  private getLocalHour(): number {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: 'numeric',
        hour12: false,
      });
      return parseInt(formatter.format(new Date()), 10);
    } catch {
      // Fallback: UTC offset heuristic
      const utcHour = new Date().getUTCHours();
      return (utcHour - 3 + 24) % 24; // default to BRT (UTC-3)
    }
  }

  private phaseForHour(hour: number): CircadianPhase {
    for (const def of this.phaseDefinitions) {
      if (def.startHour < def.endHour) {
        // Normal range (e.g. 6-12)
        if (hour >= def.startHour && hour < def.endHour) return def.phase;
      } else {
        // Wraps midnight (e.g. 22-6)
        if (hour >= def.startHour || hour < def.endHour) return def.phase;
      }
    }
    return 'night'; // fallback
  }

  private getPhaseDefinition(phase: CircadianPhase): PhaseDefinition {
    return this.phaseDefinitions.find(d => d.phase === phase) ?? this.phaseDefinitions[3];
  }

  private nextPhaseAfter(phase: CircadianPhase): CircadianPhase {
    const idx = PHASE_ORDER.indexOf(phase);
    return PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
  }

  // -------------------------------------------------------------------------
  // Tick — call periodically (e.g. every 5 minutes)
  // -------------------------------------------------------------------------

  async tick(): Promise<CircadianStatus> {
    if (!this.initialized) await this.initialize();

    // Check if override has expired
    if (this.activeOverride && new Date() >= this.activeOverride.expiresAt) {
      log.info({ override: this.activeOverride.id }, 'Override expired, returning to natural rhythm');
      this.activeOverride.active = false;
      this.activeOverride = null;
    }

    const localHour = this.getLocalHour();
    const naturalPhase = this.phaseForHour(localHour);

    // If overridden, stay in override phase
    if (this.activeOverride?.active) {
      return this.buildStatus(localHour);
    }

    // Check if phase should transition
    if (naturalPhase !== this.currentPhase) {
      await this.transitionTo(naturalPhase, 'scheduled', localHour);
    }

    return this.buildStatus(localHour);
  }

  // -------------------------------------------------------------------------
  // Phase transitions
  // -------------------------------------------------------------------------

  private async transitionTo(
    newPhase: CircadianPhase,
    reason: PhaseTransitionReason,
    localHour: number,
    overrideBy?: string,
  ): Promise<void> {
    const oldPhase = this.currentPhase;
    const oldDef = this.getPhaseDefinition(oldPhase);
    const newDef = this.getPhaseDefinition(newPhase);

    // Record duration of outgoing phase
    const durationMin = (Date.now() - this.phaseStartedAt.getTime()) / 60_000;
    this.phaseDurations[oldPhase].push(durationMin);
    if (this.phaseDurations[oldPhase].length > 100) {
      this.phaseDurations[oldPhase] = this.phaseDurations[oldPhase].slice(-50);
    }

    const transition: CircadianTransition = {
      id: uuidv4(),
      fromPhase: oldPhase,
      toPhase: newPhase,
      reason,
      timezone: this.timezone,
      localHour,
      activatedFormulas: newDef.formulaTriggers,
      deactivatedFormulas: oldDef.formulaTriggers.filter(f => !newDef.formulaTriggers.includes(f)),
      overrideBy,
      createdAt: new Date(),
    };

    this.currentPhase = newPhase;
    this.phaseStartedAt = new Date();
    this.totalTransitions += 1;
    this.transitionsToday += 1;

    this.transitionLog.push(transition);
    if (this.transitionLog.length > MAX_LOG_IN_MEMORY) {
      this.transitionLog = this.transitionLog.slice(-MAX_LOG_IN_MEMORY / 2);
    }

    await this.persistTransition(transition);

    log.info({
      from: oldPhase,
      to: newPhase,
      reason,
      localHour,
      resources: newDef.resourceWeights,
    }, 'Phase transition completed');

    broadcast('meow:sovereign', {
      type: 'circadian:transition',
      from: oldPhase,
      to: newPhase,
      reason,
      localHour,
      timezone: this.timezone,
      resources: newDef.resourceWeights,
      activatedFormulas: newDef.formulaTriggers,
      deactivatedFormulas: transition.deactivatedFormulas,
    });
  }

  // -------------------------------------------------------------------------
  // AI-powered phase tuning
  // -------------------------------------------------------------------------

  async tunePhase(): Promise<{ adjusted: boolean; advice?: string }> {
    const status = this.buildStatus(this.getLocalHour());
    const avgDurations: Record<string, number> = {};
    for (const [phase, durations] of Object.entries(this.phaseDurations)) {
      avgDurations[phase] = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
    }

    const context = JSON.stringify({
      currentPhase: status.currentPhase,
      localHour: status.localHour,
      timezone: status.timezone,
      transitionsToday: status.transitionsToday,
      avgPhaseDurations: avgDurations,
      resourceWeights: status.resourceWeights,
      activeFormulas: status.activeFormulaTriggers,
    });

    const aiResponse = await callGeminiCircadian(context);
    if (!aiResponse) {
      log.debug('AI tuning unavailable, using default phase config');
      return { adjusted: false };
    }

    try {
      const parsed = JSON.parse(aiResponse) as {
        phaseAdvice: string;
        formulaBoosts?: Array<{ name: string; boost: number }>;
        resourceTweak?: { llmPct?: number; workerPct?: number };
        reasoning: string;
      };

      // Apply resource tweaks to current phase definition
      if (parsed.resourceTweak) {
        const def = this.getPhaseDefinition(this.currentPhase);
        if (parsed.resourceTweak.llmPct != null) {
          def.resourceWeights.llmAllocationPct = Math.max(10, Math.min(100, parsed.resourceTweak.llmPct));
        }
        if (parsed.resourceTweak.workerPct != null) {
          def.resourceWeights.workerAllocationPct = Math.max(10, Math.min(100, parsed.resourceTweak.workerPct));
        }
      }

      log.info({ advice: parsed.phaseAdvice }, 'AI phase tuning applied');
      return { adjusted: true, advice: parsed.phaseAdvice };
    } catch (err) {
      log.warn({ err }, 'Failed to parse AI circadian response');
      return { adjusted: false };
    }
  }

  // -------------------------------------------------------------------------
  // Overrides
  // -------------------------------------------------------------------------

  async forcePhase(
    phase: CircadianPhase,
    operatorId: string,
    reason: string,
    durationMinutes = 60,
  ): Promise<CircadianOverride> {
    const override: CircadianOverride = {
      id: uuidv4(),
      operatorId,
      targetPhase: phase,
      reason,
      expiresAt: new Date(Date.now() + durationMinutes * 60_000),
      active: true,
      createdAt: new Date(),
    };

    this.activeOverride = override;
    this.overridesToday += 1;

    await this.transitionTo(phase, 'manual_override', this.getLocalHour(), operatorId);

    log.info({
      phase,
      operator: operatorId,
      expiresAt: override.expiresAt.toISOString(),
    }, 'Manual phase override activated');

    return override;
  }

  async extendPhase(additionalMinutes: number, operatorId: string): Promise<void> {
    if (this.activeOverride?.active) {
      this.activeOverride.expiresAt = new Date(
        this.activeOverride.expiresAt.getTime() + additionalMinutes * 60_000,
      );
    } else {
      // Create override for current phase
      await this.forcePhase(this.currentPhase, operatorId, 'Phase extension', additionalMinutes);
    }

    log.info({ additionalMinutes, operator: operatorId }, 'Phase extended');
  }

  cancelOverride(): void {
    if (this.activeOverride) {
      this.activeOverride.active = false;
      this.activeOverride = null;
      log.info('Override cancelled, returning to natural rhythm');
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getStatus(): CircadianStatus {
    return this.buildStatus(this.getLocalHour());
  }

  getCurrentPhase(): CircadianPhase {
    return this.currentPhase;
  }

  getNextTransitionTime(): Date {
    const localHour = this.getLocalHour();
    const currentDef = this.getPhaseDefinition(this.currentPhase);
    let hoursUntilEnd: number;

    if (currentDef.startHour < currentDef.endHour) {
      hoursUntilEnd = currentDef.endHour - localHour;
    } else {
      // Wraps midnight
      if (localHour >= currentDef.startHour) {
        hoursUntilEnd = (24 - localHour) + currentDef.endHour;
      } else {
        hoursUntilEnd = currentDef.endHour - localHour;
      }
    }

    if (hoursUntilEnd <= 0) hoursUntilEnd = 1; // safety minimum

    return new Date(Date.now() + hoursUntilEnd * 3_600_000);
  }

  getResourceWeights(): ResourceWeights {
    return { ...this.getPhaseDefinition(this.currentPhase).resourceWeights };
  }

  getFormulaTriggers(): string[] {
    return [...this.getPhaseDefinition(this.currentPhase).formulaTriggers];
  }

  getPriorityBoost(formulaName: string): number {
    const def = this.getPhaseDefinition(this.currentPhase);
    let boost = 0;
    for (const adj of def.priorityAdjustments) {
      if (this.matchPattern(formulaName, adj.formulaPattern)) {
        boost += adj.priorityBoost;
      }
    }
    return boost;
  }

  getStats(): CircadianStats {
    const avgDur: Record<CircadianPhase, number> = {
      morning: 0, midday: 0, evening: 0, night: 0,
    };
    const uptime: Record<CircadianPhase, number> = {
      morning: 0, midday: 0, evening: 0, night: 0,
    };

    for (const phase of PHASE_ORDER) {
      const durations = this.phaseDurations[phase];
      avgDur[phase] = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
      uptime[phase] = Math.round(durations.reduce((a, b) => a + b, 0));
    }

    return {
      totalTransitions: this.totalTransitions,
      transitionsToday: this.transitionsToday,
      overridesToday: this.overridesToday,
      avgPhaseDurationMinutes: avgDur,
      currentPhase: this.currentPhase,
      uptime24h: uptime,
    };
  }

  setTimezone(tz: string): void {
    const resolved = TIMEZONE_PRESETS[tz] ?? tz;
    if (resolved !== this.timezone) {
      this.timezone = resolved;
      log.info({ timezone: resolved }, 'Timezone updated');
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildStatus(localHour: number): CircadianStatus {
    const def = this.getPhaseDefinition(this.currentPhase);
    const next = this.nextPhaseAfter(this.currentPhase);

    return {
      currentPhase: this.currentPhase,
      phaseLabel: def.label,
      phaseFocus: def.focus,
      phaseStartedAt: this.phaseStartedAt,
      nextTransitionAt: this.getNextTransitionTime(),
      nextPhase: next,
      timezone: this.timezone,
      localHour,
      isOverridden: this.activeOverride?.active ?? false,
      overrideExpiresAt: this.activeOverride?.active ? this.activeOverride.expiresAt : undefined,
      resourceWeights: { ...def.resourceWeights },
      activeFormulaTriggers: [...def.formulaTriggers],
      transitionsToday: this.transitionsToday,
    };
  }

  private matchPattern(name: string, pattern: string): boolean {
    // Simple glob: *-intel-* matches "foo-intel-bar"
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(name);
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistTransition(transition: CircadianTransition): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_circadian_log
           (id, from_phase, to_phase, reason, timezone, local_hour,
            activated_formulas, deactivated_formulas, override_by, override_until, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          transition.id,
          transition.fromPhase,
          transition.toPhase,
          transition.reason,
          transition.timezone,
          transition.localHour,
          JSON.stringify(transition.activatedFormulas),
          JSON.stringify(transition.deactivatedFormulas),
          transition.overrideBy ?? null,
          transition.overrideUntil?.toISOString() ?? null,
          transition.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, transitionId: transition.id }, 'Failed to persist circadian transition');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT from_phase, to_phase, reason, local_hour, created_at
         FROM meow_circadian_log
         WHERE created_at >= NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 500`,
      );

      this.totalTransitions = rows.length;

      // Count today's transitions
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      this.transitionsToday = rows.filter(
        (r: { created_at: string }) => new Date(r.created_at) >= todayStart,
      ).length;

      // Rebuild phase durations from consecutive transitions
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i]; // older
        const curr = rows[i - 1]; // newer
        const dur = (new Date(curr.created_at).getTime() - new Date(prev.created_at).getTime()) / 60_000;
        const phase = prev.to_phase as CircadianPhase;
        if (dur > 0 && dur < 1440 && this.phaseDurations[phase]) {
          this.phaseDurations[phase].push(dur);
        }
      }

      log.info({ transitions: rows.length }, 'Loaded circadian history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load circadian history from DB');
    }
  }

  /** Reset daily counters — call at midnight */
  resetDailyCounters(): void {
    this.transitionsToday = 0;
    this.overridesToday = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CircadianRhythm | null = null;

export function getCircadianRhythm(): CircadianRhythm {
  if (!instance) {
    instance = new CircadianRhythm();
  }
  return instance;
}
