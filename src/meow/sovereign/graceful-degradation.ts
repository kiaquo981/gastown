/**
 * GRACEFUL DEGRADATION — SG-026 (Stage 06 Wave 7)
 *
 * On partial failure, Gas Town degrades gracefully through graduated levels
 * rather than catastrophic collapse. Detects failure conditions, classifies
 * severity, adjusts system behavior per level, and auto-recovers when
 * conditions improve.
 *
 * Degradation levels:
 *   normal → degraded → critical → minimal
 *
 * Per-level behavior:
 *   - degraded: skip non-essential formula steps, increase timeouts, reduce parallelism
 *   - critical: pause all non-critical formulas, focus on in-progress work only
 *   - minimal: only health checks and state preservation running
 *
 * Features:
 *   - Failure detection: API timeouts, error rates above threshold, worker pool depletion
 *   - Essential vs non-essential classification per formula/skill
 *   - Auto-recovery: when failure conditions resolve, step back up through levels
 *   - Recovery testing: verify each system before declaring recovered
 *   - Integration with crisis-mode.ts (SG-011) — degradation is the graduated response before full crisis
 *   - DB table: meow_degradation_events
 *
 * Gas Town: "When fuel runs low, the convoy slows — but it never stops."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('graceful-degradation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DegradationLevel = 'normal' | 'degraded' | 'critical' | 'minimal';

export type FailureType =
  | 'api_timeout'
  | 'error_rate_high'
  | 'worker_pool_depleted'
  | 'memory_pressure'
  | 'db_connection_lost'
  | 'external_dependency_down'
  | 'queue_backlog'
  | 'budget_system_failure'
  | 'manual_degradation';

export type RecoveryStatus = 'monitoring' | 'testing' | 'recovering' | 'recovered' | 'stuck';

export type EssentialityClass = 'essential' | 'important' | 'non_essential';

export interface FailureSignal {
  id: string;
  type: FailureType;
  severity: number;              // 0-100
  source: string;                // which subsystem reported
  message: string;
  value?: number;                // current metric value
  threshold?: number;            // threshold that was breached
  detectedAt: Date;
  resolvedAt?: Date;
  active: boolean;
}

export interface DegradationEvent {
  id: string;
  previousLevel: DegradationLevel;
  newLevel: DegradationLevel;
  direction: 'degrade' | 'recover';
  triggerSignals: string[];      // failure signal IDs that caused transition
  adjustmentsApplied: DegradationAdjustment[];
  aiRecommendation?: string;
  createdAt: Date;
}

export interface DegradationAdjustment {
  system: string;
  adjustment: string;
  previousValue?: string;
  newValue: string;
}

export interface FormulaClassification {
  formulaId: string;
  name: string;
  essentiality: EssentialityClass;
  canSkipSteps: string[];         // step IDs that can be skipped in degraded mode
  minWorkers: number;             // minimum workers needed
  timeoutMultiplier: number;      // multiplier applied during degradation
}

export interface RecoveryTest {
  id: string;
  system: string;
  description: string;
  passed: boolean;
  testedAt: Date;
  latencyMs: number;
  error?: string;
}

export interface DegradationConfig {
  apiTimeoutThresholdMs: number;
  errorRateThresholdPct: number;
  workerDepletionThresholdPct: number;
  memoryPressureThresholdPct: number;
  queueBacklogThreshold: number;
  signalWindowMs: number;         // time window for signal aggregation
  recoveryHoldTimeMs: number;     // hold at each level before stepping up
  autoRecoveryEnabled: boolean;
  degradedParallelismPct: number; // reduce parallelism to this % in degraded
  criticalParallelismPct: number; // reduce parallelism to this % in critical
}

export interface DegradationStatus {
  currentLevel: DegradationLevel;
  activeSignals: FailureSignal[];
  lastTransitionAt: Date | null;
  timeSinceTransitionMs: number;
  recoveryStatus: RecoveryStatus;
  adjustmentsActive: DegradationAdjustment[];
  pausedFormulas: string[];
  reducedParallelismPct: number;
}

export interface DegradationStats {
  totalDegradations: number;
  totalRecoveries: number;
  timeInDegradedMs: number;
  timeInCriticalMs: number;
  timeInMinimalMs: number;
  avgRecoveryTimeMs: number;
  signalsByType: Record<string, number>;
  longestDegradationMs: number;
  autoRecoveries: number;
  manualRecoveries: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DegradationConfig = {
  apiTimeoutThresholdMs: 10_000,
  errorRateThresholdPct: 25,
  workerDepletionThresholdPct: 90,
  memoryPressureThresholdPct: 85,
  queueBacklogThreshold: 1000,
  signalWindowMs: 5 * 60_000,      // 5 minutes
  recoveryHoldTimeMs: 3 * 60_000,  // 3 minutes per level
  autoRecoveryEnabled: true,
  degradedParallelismPct: 60,
  criticalParallelismPct: 20,
};

const LEVEL_ORDER: DegradationLevel[] = ['normal', 'degraded', 'critical', 'minimal'];
const MAX_SIGNALS_IN_MEMORY = 200;
const MAX_EVENTS_IN_MEMORY = 100;
const MAX_RECOVERY_TESTS = 50;

/** Severity thresholds for each degradation level */
const LEVEL_THRESHOLDS: Record<DegradationLevel, number> = {
  normal: 0,
  degraded: 30,
  critical: 60,
  minimal: 85,
};

/** Default formula classifications */
const DEFAULT_FORMULA_CLASSES: FormulaClassification[] = [
  { formulaId: 'campaign-launch', name: 'Campaign Launch', essentiality: 'essential', canSkipSteps: [], minWorkers: 2, timeoutMultiplier: 1.5 },
  { formulaId: 'roas-monitor', name: 'ROAS Monitor', essentiality: 'essential', canSkipSteps: [], minWorkers: 1, timeoutMultiplier: 2.0 },
  { formulaId: 'order-fulfillment', name: 'Order Fulfillment', essentiality: 'essential', canSkipSteps: [], minWorkers: 1, timeoutMultiplier: 1.5 },
  { formulaId: 'content-generation', name: 'Content Generation', essentiality: 'important', canSkipSteps: ['polish', 'ab_test'], minWorkers: 1, timeoutMultiplier: 2.0 },
  { formulaId: 'market-intel', name: 'Market Intelligence', essentiality: 'important', canSkipSteps: ['deep_analysis', 'competitor_scrape'], minWorkers: 1, timeoutMultiplier: 3.0 },
  { formulaId: 'audience-research', name: 'Audience Research', essentiality: 'non_essential', canSkipSteps: ['expand_lookalikes', 'psychographic'], minWorkers: 0, timeoutMultiplier: 3.0 },
  { formulaId: 'report-generation', name: 'Report Generation', essentiality: 'non_essential', canSkipSteps: ['charts', 'pdf_export'], minWorkers: 0, timeoutMultiplier: 5.0 },
  { formulaId: 'skill-training', name: 'Skill Training', essentiality: 'non_essential', canSkipSteps: ['all'], minWorkers: 0, timeoutMultiplier: 5.0 },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiDegradation(context: string): Promise<string | null> {
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
                'You are a systems reliability engineer for an AI agent platform called Gas Town. '
                + 'Given failure signals and current degradation state, recommend the appropriate '
                + 'degradation level and specific adjustments. '
                + 'Respond ONLY with valid JSON: {"recommendedLevel": "normal|degraded|critical|minimal", '
                + '"adjustments": [{"system":"...","adjustment":"...","newValue":"..."}], '
                + '"shouldEscalateToCrisis": false, "reason": "...", "confidence": 0.0-1.0}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 768,
          temperature: 0.1,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini degradation analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// GracefulDegradation
// ---------------------------------------------------------------------------

export class GracefulDegradation {
  private config: DegradationConfig = { ...DEFAULT_CONFIG };
  private currentLevel: DegradationLevel = 'normal';
  private activeSignals: FailureSignal[] = [];
  private allSignals: FailureSignal[] = [];
  private events: DegradationEvent[] = [];
  private formulaClasses: FormulaClassification[] = [...DEFAULT_FORMULA_CLASSES];
  private pausedFormulas: string[] = [];
  private activeAdjustments: DegradationAdjustment[] = [];
  private recoveryTests: RecoveryTest[] = [];
  private lastTransitionAt: Date | null = null;
  private recoveryStatus: RecoveryStatus = 'monitoring';
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private levelEntryTime = new Map<DegradationLevel, number>();
  private stats: DegradationStats = {
    totalDegradations: 0,
    totalRecoveries: 0,
    timeInDegradedMs: 0,
    timeInCriticalMs: 0,
    timeInMinimalMs: 0,
    avgRecoveryTimeMs: 0,
    signalsByType: {},
    longestDegradationMs: 0,
    autoRecoveries: 0,
    manualRecoveries: 0,
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(configOverrides?: Partial<DegradationConfig>): Promise<void> {
    if (this.initialized) return;

    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    await this.loadFromDb();
    this.levelEntryTime.set('normal', Date.now());
    this.initialized = true;

    log.info({
      currentLevel: this.currentLevel,
      autoRecovery: this.config.autoRecoveryEnabled,
      signalWindow: this.config.signalWindowMs,
    }, 'Graceful degradation initialized');
  }

  // -------------------------------------------------------------------------
  // Signal ingestion
  // -------------------------------------------------------------------------

  reportFailure(
    type: FailureType,
    source: string,
    message: string,
    severity: number,
    value?: number,
    threshold?: number,
  ): FailureSignal {
    const signal: FailureSignal = {
      id: uuidv4(),
      type,
      severity: Math.max(0, Math.min(100, severity)),
      source,
      message,
      value,
      threshold,
      detectedAt: new Date(),
      active: true,
    };

    this.activeSignals.push(signal);
    this.allSignals.push(signal);
    if (this.allSignals.length > MAX_SIGNALS_IN_MEMORY) {
      this.allSignals = this.allSignals.slice(-MAX_SIGNALS_IN_MEMORY);
    }

    this.stats.signalsByType[type] = (this.stats.signalsByType[type] ?? 0) + 1;

    log.warn({
      signalId: signal.id,
      type,
      severity,
      source,
      message,
    }, 'Failure signal reported');

    broadcast('meow:sovereign', {
      type: 'degradation:signal',
      signalId: signal.id,
      failureType: type,
      severity,
      source,
      message,
    });

    // Evaluate if level transition needed
    this.evaluateLevel().catch(err =>
      log.error({ err }, 'Level evaluation failed after signal'),
    );

    return signal;
  }

  resolveSignal(signalId: string): void {
    const signal = this.activeSignals.find(s => s.id === signalId);
    if (signal) {
      signal.active = false;
      signal.resolvedAt = new Date();
      this.activeSignals = this.activeSignals.filter(s => s.id !== signalId);

      log.info({ signalId, type: signal.type }, 'Failure signal resolved');

      // Evaluate if recovery is possible
      if (this.config.autoRecoveryEnabled) {
        this.scheduleRecoveryCheck();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Level evaluation
  // -------------------------------------------------------------------------

  async evaluateLevel(): Promise<DegradationLevel> {
    // Prune expired signals
    const cutoff = Date.now() - this.config.signalWindowMs;
    this.activeSignals = this.activeSignals.filter(s => s.detectedAt.getTime() >= cutoff && s.active);

    if (this.activeSignals.length === 0) {
      if (this.currentLevel !== 'normal' && this.config.autoRecoveryEnabled) {
        this.scheduleRecoveryCheck();
      }
      return this.currentLevel;
    }

    // Calculate aggregate severity
    const aggregateSeverity = this.calculateAggregateSeverity();

    // Determine target level based on severity
    let targetLevel: DegradationLevel = 'normal';
    if (aggregateSeverity >= LEVEL_THRESHOLDS.minimal) {
      targetLevel = 'minimal';
    } else if (aggregateSeverity >= LEVEL_THRESHOLDS.critical) {
      targetLevel = 'critical';
    } else if (aggregateSeverity >= LEVEL_THRESHOLDS.degraded) {
      targetLevel = 'degraded';
    }

    // AI recommendation (if available)
    const aiLevel = await this.getAiRecommendation();
    if (aiLevel) {
      const aiIdx = LEVEL_ORDER.indexOf(aiLevel);
      const heuristicIdx = LEVEL_ORDER.indexOf(targetLevel);
      // Use the worse of AI vs heuristic (more conservative)
      if (aiIdx > heuristicIdx) {
        targetLevel = aiLevel;
      }
    }

    // Only degrade, never skip levels (go through each level sequentially)
    const currentIdx = LEVEL_ORDER.indexOf(this.currentLevel);
    const targetIdx = LEVEL_ORDER.indexOf(targetLevel);

    if (targetIdx > currentIdx) {
      // Degrade one level at a time
      const nextLevel = LEVEL_ORDER[currentIdx + 1];
      await this.transitionTo(nextLevel, 'degrade');
    }

    return this.currentLevel;
  }

  private calculateAggregateSeverity(): number {
    if (this.activeSignals.length === 0) return 0;

    // Weighted average — recent signals weigh more
    const now = Date.now();
    let totalWeight = 0;
    let weightedSum = 0;

    for (const signal of this.activeSignals) {
      const ageMs = now - signal.detectedAt.getTime();
      const recencyWeight = Math.max(0.1, 1 - (ageMs / this.config.signalWindowMs));
      weightedSum += signal.severity * recencyWeight;
      totalWeight += recencyWeight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  private async getAiRecommendation(): Promise<DegradationLevel | null> {
    const context = JSON.stringify({
      currentLevel: this.currentLevel,
      activeSignals: this.activeSignals.map(s => ({
        type: s.type,
        severity: s.severity,
        source: s.source,
        message: s.message,
        ageMs: Date.now() - s.detectedAt.getTime(),
      })),
      pausedFormulas: this.pausedFormulas,
      aggregateSeverity: this.calculateAggregateSeverity(),
    });

    const aiResponse = await callGeminiDegradation(context);
    if (!aiResponse) return null;

    try {
      const parsed = JSON.parse(aiResponse) as {
        recommendedLevel: DegradationLevel;
        shouldEscalateToCrisis: boolean;
        reason: string;
        confidence: number;
      };

      if (parsed.shouldEscalateToCrisis) {
        log.warn({ reason: parsed.reason }, 'AI recommends escalation to crisis mode');
        broadcast('meow:sovereign', {
          type: 'degradation:crisis_recommended',
          reason: parsed.reason,
          confidence: parsed.confidence,
        });
      }

      if (parsed.confidence >= 0.7 && LEVEL_ORDER.includes(parsed.recommendedLevel)) {
        return parsed.recommendedLevel;
      }
    } catch {
      // Ignore parse errors
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Level transitions
  // -------------------------------------------------------------------------

  private async transitionTo(newLevel: DegradationLevel, direction: 'degrade' | 'recover'): Promise<void> {
    const previousLevel = this.currentLevel;
    if (previousLevel === newLevel) return;

    // Track time spent in previous level
    this.recordTimeInLevel(previousLevel);

    // Apply adjustments for new level
    const adjustments = this.computeAdjustments(newLevel, previousLevel);

    const event: DegradationEvent = {
      id: uuidv4(),
      previousLevel,
      newLevel,
      direction,
      triggerSignals: this.activeSignals.map(s => s.id),
      adjustmentsApplied: adjustments,
      createdAt: new Date(),
    };

    this.currentLevel = newLevel;
    this.lastTransitionAt = new Date();
    this.activeAdjustments = adjustments;
    this.levelEntryTime.set(newLevel, Date.now());

    // Apply level-specific behavior
    this.applyLevelBehavior(newLevel);

    // Store event
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    // Update stats
    if (direction === 'degrade') {
      this.stats.totalDegradations += 1;
    } else {
      this.stats.totalRecoveries += 1;
    }

    await this.persistEvent(event);

    log.warn({
      previousLevel,
      newLevel,
      direction,
      activeSignals: this.activeSignals.length,
      adjustments: adjustments.length,
    }, `Degradation level transition: ${previousLevel} → ${newLevel}`);

    broadcast('meow:sovereign', {
      type: 'degradation:transition',
      previousLevel,
      newLevel,
      direction,
      activeSignals: this.activeSignals.length,
      adjustments: adjustments.map(a => `${a.system}: ${a.adjustment}`),
    });
  }

  private computeAdjustments(newLevel: DegradationLevel, _previousLevel: DegradationLevel): DegradationAdjustment[] {
    const adjustments: DegradationAdjustment[] = [];

    switch (newLevel) {
      case 'degraded':
        adjustments.push(
          { system: 'parallelism', adjustment: 'reduce_parallelism', previousValue: '100%', newValue: `${this.config.degradedParallelismPct}%` },
          { system: 'timeouts', adjustment: 'increase_timeouts', previousValue: '1x', newValue: '2x' },
          { system: 'formulas', adjustment: 'skip_non_essential_steps', newValue: 'active' },
        );
        break;
      case 'critical':
        adjustments.push(
          { system: 'parallelism', adjustment: 'reduce_parallelism', previousValue: `${this.config.degradedParallelismPct}%`, newValue: `${this.config.criticalParallelismPct}%` },
          { system: 'formulas', adjustment: 'pause_non_critical', newValue: 'paused' },
          { system: 'timeouts', adjustment: 'increase_timeouts', previousValue: '2x', newValue: '5x' },
          { system: 'queue', adjustment: 'reject_new_work', newValue: 'non_essential_rejected' },
        );
        break;
      case 'minimal':
        adjustments.push(
          { system: 'parallelism', adjustment: 'minimal_parallelism', previousValue: `${this.config.criticalParallelismPct}%`, newValue: '5%' },
          { system: 'formulas', adjustment: 'pause_all_except_health', newValue: 'minimal' },
          { system: 'queue', adjustment: 'reject_all_new_work', newValue: 'all_rejected' },
          { system: 'state', adjustment: 'snapshot_state', newValue: 'triggered' },
        );
        break;
      case 'normal':
        adjustments.push(
          { system: 'parallelism', adjustment: 'restore_full_parallelism', newValue: '100%' },
          { system: 'formulas', adjustment: 'resume_all', newValue: 'active' },
          { system: 'timeouts', adjustment: 'restore_default_timeouts', newValue: '1x' },
          { system: 'queue', adjustment: 'accept_all_work', newValue: 'normal' },
        );
        break;
    }

    return adjustments;
  }

  private applyLevelBehavior(level: DegradationLevel): void {
    switch (level) {
      case 'degraded': {
        // Pause non-essential formulas' optional steps
        this.pausedFormulas = [];
        const nonEssential = this.formulaClasses.filter(f => f.essentiality === 'non_essential');
        // Don't fully pause, just skip steps (handled by formula engine querying us)
        log.info({ nonEssentialFormulas: nonEssential.length }, 'Degraded mode: skipping non-essential steps');
        break;
      }
      case 'critical': {
        // Pause all non-essential and important formulas
        this.pausedFormulas = this.formulaClasses
          .filter(f => f.essentiality !== 'essential')
          .map(f => f.formulaId);
        log.info({ pausedFormulas: this.pausedFormulas.length }, 'Critical mode: pausing non-essential formulas');
        break;
      }
      case 'minimal': {
        // Pause everything except health checks
        this.pausedFormulas = this.formulaClasses.map(f => f.formulaId);
        log.info('Minimal mode: all formulas paused, health checks only');
        break;
      }
      case 'normal': {
        this.pausedFormulas = [];
        this.activeAdjustments = [];
        this.recoveryStatus = 'monitoring';
        log.info('Normal mode: all systems restored');
        break;
      }
    }
  }

  private recordTimeInLevel(level: DegradationLevel): void {
    const entryTime = this.levelEntryTime.get(level);
    if (!entryTime) return;

    const duration = Date.now() - entryTime;
    switch (level) {
      case 'degraded':
        this.stats.timeInDegradedMs += duration;
        break;
      case 'critical':
        this.stats.timeInCriticalMs += duration;
        break;
      case 'minimal':
        this.stats.timeInMinimalMs += duration;
        break;
    }

    // Track longest degradation
    if (level !== 'normal') {
      const totalDegTime = duration;
      if (totalDegTime > this.stats.longestDegradationMs) {
        this.stats.longestDegradationMs = totalDegTime;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private scheduleRecoveryCheck(): void {
    if (this.recoveryTimer) return;
    if (this.currentLevel === 'normal') return;

    this.recoveryStatus = 'monitoring';

    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      await this.attemptRecovery();
    }, this.config.recoveryHoldTimeMs);
  }

  async attemptRecovery(): Promise<boolean> {
    if (this.currentLevel === 'normal') return true;

    // Prune expired signals
    const cutoff = Date.now() - this.config.signalWindowMs;
    this.activeSignals = this.activeSignals.filter(s => s.detectedAt.getTime() >= cutoff && s.active);

    const aggregateSeverity = this.calculateAggregateSeverity();
    const currentIdx = LEVEL_ORDER.indexOf(this.currentLevel);

    // Check if we can step down one level
    const targetLevel = LEVEL_ORDER[currentIdx - 1];
    const targetThreshold = LEVEL_THRESHOLDS[this.currentLevel];

    if (aggregateSeverity < targetThreshold) {
      // Run recovery tests before stepping down
      this.recoveryStatus = 'testing';
      const testsPassed = await this.runRecoveryTests();

      if (testsPassed) {
        this.recoveryStatus = 'recovering';
        await this.transitionTo(targetLevel, 'recover');
        this.stats.autoRecoveries += 1;

        if (targetLevel !== 'normal') {
          // Schedule next recovery check
          this.scheduleRecoveryCheck();
        } else {
          this.recoveryStatus = 'recovered';
        }

        return true;
      } else {
        this.recoveryStatus = 'stuck';
        log.warn({ currentLevel: this.currentLevel }, 'Recovery tests failed — staying at current level');

        broadcast('meow:sovereign', {
          type: 'degradation:recovery_failed',
          currentLevel: this.currentLevel,
          reason: 'Recovery tests did not pass',
        });

        // Retry later
        this.recoveryTimer = setTimeout(async () => {
          this.recoveryTimer = null;
          await this.attemptRecovery();
        }, this.config.recoveryHoldTimeMs * 2);

        return false;
      }
    }

    // Conditions not met for recovery
    this.scheduleRecoveryCheck();
    return false;
  }

  async forceRecovery(targetLevel: DegradationLevel = 'normal'): Promise<boolean> {
    if (!LEVEL_ORDER.includes(targetLevel)) return false;

    const currentIdx = LEVEL_ORDER.indexOf(this.currentLevel);
    const targetIdx = LEVEL_ORDER.indexOf(targetLevel);

    if (targetIdx >= currentIdx) {
      log.warn({ currentLevel: this.currentLevel, targetLevel }, 'Cannot force-recover to same or worse level');
      return false;
    }

    // Step down one level at a time
    while (LEVEL_ORDER.indexOf(this.currentLevel) > targetIdx) {
      const nextLevel = LEVEL_ORDER[LEVEL_ORDER.indexOf(this.currentLevel) - 1];
      await this.transitionTo(nextLevel, 'recover');
    }

    this.stats.manualRecoveries += 1;
    this.activeSignals = [];

    log.info({ targetLevel }, 'Forced recovery to level');

    return true;
  }

  private async runRecoveryTests(): Promise<boolean> {
    const tests: RecoveryTest[] = [];
    let allPassed = true;

    // Test 1: Database connectivity
    const dbTest = await this.testDatabase();
    tests.push(dbTest);
    if (!dbTest.passed) allPassed = false;

    // Test 2: Memory pressure
    const memTest = this.testMemory();
    tests.push(memTest);
    if (!memTest.passed) allPassed = false;

    // Test 3: Worker availability (simulated check)
    const workerTest = this.testWorkerPool();
    tests.push(workerTest);
    if (!workerTest.passed) allPassed = false;

    // Test 4: External API (check Gemini as proxy for API health)
    const apiTest = await this.testExternalApi();
    tests.push(apiTest);
    if (!apiTest.passed) allPassed = false;

    // Store tests
    this.recoveryTests.push(...tests);
    if (this.recoveryTests.length > MAX_RECOVERY_TESTS) {
      this.recoveryTests = this.recoveryTests.slice(-MAX_RECOVERY_TESTS);
    }

    log.info({
      totalTests: tests.length,
      passed: tests.filter(t => t.passed).length,
      failed: tests.filter(t => !t.passed).length,
    }, 'Recovery tests completed');

    broadcast('meow:sovereign', {
      type: 'degradation:recovery_tests',
      tests: tests.map(t => ({ system: t.system, passed: t.passed, latencyMs: t.latencyMs })),
      allPassed,
    });

    return allPassed;
  }

  private async testDatabase(): Promise<RecoveryTest> {
    const start = Date.now();
    const pool = getPool();

    if (!pool) {
      return { id: uuidv4(), system: 'database', description: 'DB pool check', passed: false, testedAt: new Date(), latencyMs: Date.now() - start, error: 'No pool available' };
    }

    try {
      await pool.query('SELECT 1 as ok');
      return { id: uuidv4(), system: 'database', description: 'DB connectivity', passed: true, testedAt: new Date(), latencyMs: Date.now() - start };
    } catch (err) {
      return { id: uuidv4(), system: 'database', description: 'DB connectivity', passed: false, testedAt: new Date(), latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private testMemory(): RecoveryTest {
    const mem = process.memoryUsage();
    const usagePct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    const passed = usagePct < this.config.memoryPressureThresholdPct;

    return {
      id: uuidv4(),
      system: 'memory',
      description: `Heap usage: ${usagePct}% (threshold: ${this.config.memoryPressureThresholdPct}%)`,
      passed,
      testedAt: new Date(),
      latencyMs: 0,
      error: passed ? undefined : `Memory pressure at ${usagePct}%`,
    };
  }

  private testWorkerPool(): RecoveryTest {
    const start = Date.now();
    try {
      const { polecatManager } = require('../workers/polecat');
      const polecatStats = polecatManager.stats();
      const totalPolecats = polecatStats.total ?? 0;
      const activePolecats = polecatStats.active ?? 0;

      const { crewManager } = require('../workers/crew');
      const crewStats = crewManager.stats();
      const totalCrew = crewStats.total ?? 0;
      const idleCrew = crewStats.idle ?? 0;

      const hasWorkers = totalPolecats > 0 || totalCrew > 0;
      const hasAvailable = activePolecats < totalPolecats || idleCrew > 0;
      const passed = hasWorkers && hasAvailable;
      const latencyMs = Date.now() - start;

      return {
        id: uuidv4(),
        system: 'worker_pool',
        description: `Polecats: ${activePolecats}/${totalPolecats} active, Crew: ${totalCrew - idleCrew}/${totalCrew} busy`,
        passed,
        testedAt: new Date(),
        latencyMs,
        error: passed ? undefined : hasWorkers ? 'All workers busy — no capacity' : 'No workers registered',
      };
    } catch (err) {
      return {
        id: uuidv4(),
        system: 'worker_pool',
        description: 'Worker pool availability check',
        passed: false,
        testedAt: new Date(),
        latencyMs: Date.now() - start,
        error: `Failed to query worker pool: ${(err as Error).message}`,
      };
    }
  }

  private async testExternalApi(): Promise<RecoveryTest> {
    const start = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return { id: uuidv4(), system: 'external_api', description: 'Gemini API health check', passed: true, testedAt: new Date(), latencyMs: 0 };
    }

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
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const latencyMs = Date.now() - start;
      return { id: uuidv4(), system: 'external_api', description: 'Gemini API health', passed: resp.ok, testedAt: new Date(), latencyMs };
    } catch (err) {
      return { id: uuidv4(), system: 'external_api', description: 'Gemini API health', passed: false, testedAt: new Date(), latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Queries — used by other systems
  // -------------------------------------------------------------------------

  getCurrentLevel(): DegradationLevel {
    return this.currentLevel;
  }

  isFormulaPaused(formulaId: string): boolean {
    return this.pausedFormulas.includes(formulaId);
  }

  getFormulaClassification(formulaId: string): FormulaClassification | null {
    return this.formulaClasses.find(f => f.formulaId === formulaId) ?? null;
  }

  getSkippableSteps(formulaId: string): string[] {
    if (this.currentLevel === 'normal') return [];
    const cls = this.formulaClasses.find(f => f.formulaId === formulaId);
    if (!cls) return [];
    return cls.canSkipSteps;
  }

  getTimeoutMultiplier(formulaId: string): number {
    if (this.currentLevel === 'normal') return 1.0;
    const cls = this.formulaClasses.find(f => f.formulaId === formulaId);
    return cls?.timeoutMultiplier ?? 2.0;
  }

  getParallelismPct(): number {
    switch (this.currentLevel) {
      case 'degraded': return this.config.degradedParallelismPct;
      case 'critical': return this.config.criticalParallelismPct;
      case 'minimal': return 5;
      default: return 100;
    }
  }

  getStatus(): DegradationStatus {
    return {
      currentLevel: this.currentLevel,
      activeSignals: [...this.activeSignals],
      lastTransitionAt: this.lastTransitionAt,
      timeSinceTransitionMs: this.lastTransitionAt ? Date.now() - this.lastTransitionAt.getTime() : 0,
      recoveryStatus: this.recoveryStatus,
      adjustmentsActive: [...this.activeAdjustments],
      pausedFormulas: [...this.pausedFormulas],
      reducedParallelismPct: this.getParallelismPct(),
    };
  }

  getStats(): DegradationStats {
    return { ...this.stats };
  }

  getConfig(): DegradationConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<DegradationConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'Degradation config updated');
  }

  registerFormulaClassification(classification: FormulaClassification): void {
    const existing = this.formulaClasses.findIndex(f => f.formulaId === classification.formulaId);
    if (existing >= 0) {
      this.formulaClasses[existing] = classification;
    } else {
      this.formulaClasses.push(classification);
    }
  }

  getEventHistory(limit = 20): DegradationEvent[] {
    return this.events.slice(-limit);
  }

  getRecentRecoveryTests(limit = 10): RecoveryTest[] {
    return this.recoveryTests.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistEvent(event: DegradationEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_degradation_events
           (id, previous_level, new_level, direction, trigger_signals,
            adjustments_json, ai_recommendation, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          event.id,
          event.previousLevel,
          event.newLevel,
          event.direction,
          JSON.stringify(event.triggerSignals),
          JSON.stringify(event.adjustmentsApplied),
          event.aiRecommendation ?? null,
          event.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist degradation event');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, previous_level, new_level, direction, created_at
         FROM meow_degradation_events
         WHERE created_at >= NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 50`,
      );

      for (const row of rows) {
        if (row.direction === 'degrade') this.stats.totalDegradations += 1;
        if (row.direction === 'recover') this.stats.totalRecoveries += 1;
      }

      // Check if there's an active degradation (last event was a degrade without a subsequent recover)
      if (rows.length > 0 && rows[0].direction === 'degrade') {
        this.currentLevel = rows[0].new_level as DegradationLevel;
        this.lastTransitionAt = new Date(rows[0].created_at);
        this.applyLevelBehavior(this.currentLevel);
        log.info({ currentLevel: this.currentLevel }, 'Restored degradation level from DB');
      }

      log.info({ events: rows.length }, 'Loaded degradation history from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load degradation history from DB (table may not exist yet)');
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  shutdown(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.recordTimeInLevel(this.currentLevel);
    log.info('Graceful degradation shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GracefulDegradation | null = null;

export function getGracefulDegradation(): GracefulDegradation {
  if (!instance) {
    instance = new GracefulDegradation();
  }
  return instance;
}
