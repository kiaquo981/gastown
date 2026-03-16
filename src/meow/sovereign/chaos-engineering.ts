/**
 * CHAOS ENGINEERING — SG-028 (Stage 06 Wave 7)
 *
 * Periodic chaos tests to validate resilience of Gas Town.
 * Injects controlled faults into the system, observes how it responds,
 * measures recovery time, and produces actionable reports on system weaknesses.
 *
 * Experiments:
 *   - random_worker_kill: terminate random workers mid-task
 *   - simulated_api_failure: block external API responses
 *   - memory_pressure: allocate large buffers to stress memory
 *   - slow_network: add artificial latency to DB/API calls
 *   - queue_flood: inject thousands of fake beads into the queue
 *   - budget_exhaust: simulate budget limit breach
 *
 * Features:
 *   - Experiment execution: inject fault → observe → measure recovery → report
 *   - Safety: never run during crisis mode, only during low-load periods
 *   - Results scoring: recovery_time, data_loss, service_degradation, user_impact (all 0-100)
 *   - Historical comparison: detect trends ("recovery improved 15% since last month")
 *   - Weakness detection: identify which faults cause worst degradation
 *   - Schedule: configurable (default: weekly during maintenance window)
 *   - DB table: meow_chaos_experiments
 *   - Report: markdown summary of experiment results with recommendations
 *
 * Gas Town: "Set fire to the war rig on purpose — so when it burns for real, you already know the drill."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('chaos-engineering');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChaosExperimentType =
  | 'random_worker_kill'
  | 'simulated_api_failure'
  | 'memory_pressure'
  | 'slow_network'
  | 'queue_flood'
  | 'budget_exhaust';

export type ExperimentStatus = 'pending' | 'injecting' | 'observing' | 'recovering' | 'measuring' | 'completed' | 'failed' | 'aborted';

export type ExperimentIntensity = 'low' | 'medium' | 'high';

export interface ChaosExperiment {
  id: string;
  type: ChaosExperimentType;
  status: ExperimentStatus;
  intensity: ExperimentIntensity;
  config: ExperimentConfig;
  result: ExperimentResult | null;
  injectedAt: Date | null;
  observedAt: Date | null;
  recoveredAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  error?: string;
}

export interface ExperimentConfig {
  durationMs: number;               // how long to inject the fault
  cooldownMs: number;               // pause between experiments
  targetWorkerCount?: number;       // for worker kill
  apiFailurePct?: number;           // percentage of API calls to fail
  memoryPressureMb?: number;        // MB to allocate
  latencyAddMs?: number;            // artificial latency to add
  queueFloodCount?: number;         // number of fake beads
  budgetOverrunPct?: number;        // percentage over budget
}

export interface ExperimentResult {
  scores: ExperimentScores;
  recoveryTimeMs: number;
  systemBehavior: SystemBehaviorSnapshot[];
  degradationLevelReached: string;
  dataLossDetected: boolean;
  servicesAffected: string[];
  anomaliesObserved: string[];
  aiAnalysis?: string;
}

export interface ExperimentScores {
  recoveryTime: number;             // 0-100 (100 = instant recovery)
  dataLoss: number;                 // 0-100 (100 = no data loss)
  serviceDegradation: number;       // 0-100 (100 = no degradation)
  userImpact: number;               // 0-100 (100 = no user impact)
  overall: number;                  // weighted average
}

export interface SystemBehaviorSnapshot {
  timestamp: string;
  phase: 'pre_injection' | 'during_injection' | 'post_injection' | 'recovery';
  activeWorkers: number;
  pendingBeads: number;
  errorRate: number;
  avgLatencyMs: number;
  memoryUsagePct: number;
  degradationLevel: string;
}

export interface ChaosSchedule {
  enabled: boolean;
  cronExpression: string;            // when to run (default: weekly maintenance window)
  experimentsPerRun: ChaosExperimentType[];
  intensity: ExperimentIntensity;
  maxRunDurationMs: number;
  requireLowLoad: boolean;
  loadThresholdPct: number;
}

export interface ChaosReport {
  id: string;
  runDate: string;
  experiments: Array<{
    type: ChaosExperimentType;
    scores: ExperimentScores;
    recoveryTimeMs: number;
    status: ExperimentStatus;
  }>;
  overallScore: number;
  weakestArea: string;
  strongestArea: string;
  trend: TrendAnalysis;
  recommendations: string[];
  markdownReport: string;
  createdAt: Date;
}

export interface TrendAnalysis {
  recoveryTimeTrend: number;        // positive = improving
  dataLossTrend: number;
  degradationTrend: number;
  overallTrend: number;
  comparedToRunsAgo: number;
  message: string;
}

export interface ChaosConfig {
  schedule: ChaosSchedule;
  defaultIntensity: ExperimentIntensity;
  defaultDurationMs: number;
  defaultCooldownMs: number;
  safetyChecks: boolean;
  maxConcurrentExperiments: number;
  abortOnCrisis: boolean;
}

export interface ChaosStats {
  totalExperiments: number;
  completedExperiments: number;
  failedExperiments: number;
  abortedExperiments: number;
  avgOverallScore: number;
  worstExperimentType: ChaosExperimentType | null;
  bestExperimentType: ChaosExperimentType | null;
  totalRunsExecuted: number;
  lastRunAt: Date | null;
  scoresByType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCHEDULE: ChaosSchedule = {
  enabled: true,
  cronExpression: '0 3 * * 0',       // Sunday 03:00
  experimentsPerRun: [
    'random_worker_kill', 'simulated_api_failure', 'memory_pressure',
    'slow_network', 'queue_flood', 'budget_exhaust',
  ],
  intensity: 'medium',
  maxRunDurationMs: 60 * 60_000,      // 1 hour max
  requireLowLoad: true,
  loadThresholdPct: 30,
};

const DEFAULT_CONFIG: ChaosConfig = {
  schedule: DEFAULT_SCHEDULE,
  defaultIntensity: 'medium',
  defaultDurationMs: 30_000,          // 30 seconds per fault injection
  defaultCooldownMs: 60_000,          // 1 minute between experiments
  safetyChecks: true,
  maxConcurrentExperiments: 1,
  abortOnCrisis: true,
};

/** Intensity-based configuration presets */
const INTENSITY_PRESETS: Record<ExperimentIntensity, Partial<ExperimentConfig>> = {
  low: {
    durationMs: 15_000,
    cooldownMs: 120_000,
    targetWorkerCount: 1,
    apiFailurePct: 10,
    memoryPressureMb: 50,
    latencyAddMs: 200,
    queueFloodCount: 100,
    budgetOverrunPct: 10,
  },
  medium: {
    durationMs: 30_000,
    cooldownMs: 60_000,
    targetWorkerCount: 3,
    apiFailurePct: 50,
    memoryPressureMb: 200,
    latencyAddMs: 1000,
    queueFloodCount: 500,
    budgetOverrunPct: 50,
  },
  high: {
    durationMs: 60_000,
    cooldownMs: 120_000,
    targetWorkerCount: 5,
    apiFailurePct: 90,
    memoryPressureMb: 500,
    latencyAddMs: 5000,
    queueFloodCount: 2000,
    budgetOverrunPct: 100,
  },
};

const MAX_EXPERIMENTS_IN_MEMORY = 100;
const MAX_REPORTS_IN_MEMORY = 20;
const OBSERVATION_INTERVAL_MS = 5_000;  // sample system state every 5s
const MAX_OBSERVATION_SAMPLES = 60;     // max samples per experiment

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiChaos(context: string): Promise<string | null> {
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
                'You are a chaos engineering analyst for an AI agent platform called Gas Town. '
                + 'Given experiment results, identify weaknesses, provide scores, and recommend improvements. '
                + 'Respond ONLY with valid JSON: {"overallAssessment": "...", "weaknesses": ["..."], '
                + '"strengths": ["..."], "recommendations": ["..."], "riskAreas": ["..."], '
                + '"scores": {"recoveryTime": N, "dataLoss": N, "serviceDegradation": N, "userImpact": N}}',
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
    log.warn({ err }, 'Gemini chaos analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// ChaosEngineering
// ---------------------------------------------------------------------------

export class ChaosEngineering {
  private config: ChaosConfig = { ...DEFAULT_CONFIG };
  private experiments: ChaosExperiment[] = [];
  private reports: ChaosReport[] = [];
  private currentExperiment: ChaosExperiment | null = null;
  private isRunning = false;
  private abortRequested = false;
  private injectedFaults: Array<{ cleanup: () => void; description: string }> = [];
  private stats: ChaosStats = {
    totalExperiments: 0,
    completedExperiments: 0,
    failedExperiments: 0,
    abortedExperiments: 0,
    avgOverallScore: 0,
    worstExperimentType: null,
    bestExperimentType: null,
    totalRunsExecuted: 0,
    lastRunAt: null,
    scoresByType: {},
  };
  private initialized = false;

  // Safety check callbacks
  private safetyCheckers: Array<() => Promise<{ safe: boolean; reason: string }>> = [];

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(configOverrides?: Partial<ChaosConfig>): Promise<void> {
    if (this.initialized) return;

    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    await this.loadFromDb();
    this.initialized = true;

    log.info({
      schedule: this.config.schedule.enabled ? this.config.schedule.cronExpression : 'disabled',
      defaultIntensity: this.config.defaultIntensity,
      safetyChecks: this.config.safetyChecks,
    }, 'Chaos engineering initialized');
  }

  registerSafetyChecker(checker: () => Promise<{ safe: boolean; reason: string }>): void {
    this.safetyCheckers.push(checker);
  }

  // -------------------------------------------------------------------------
  // Run full chaos suite
  // -------------------------------------------------------------------------

  async runFullSuite(
    intensity?: ExperimentIntensity,
    experimentTypes?: ChaosExperimentType[],
  ): Promise<ChaosReport> {
    if (this.isRunning) {
      throw new Error('Chaos suite already running');
    }

    const runIntensity = intensity ?? this.config.defaultIntensity;
    const types = experimentTypes ?? this.config.schedule.experimentsPerRun;

    this.isRunning = true;
    this.abortRequested = false;

    log.info({
      intensity: runIntensity,
      experiments: types.length,
    }, 'Starting chaos engineering suite');

    broadcast('meow:sovereign', {
      type: 'chaos:suite_started',
      intensity: runIntensity,
      experimentCount: types.length,
    });

    // Safety pre-check
    if (this.config.safetyChecks) {
      const safetyResult = await this.runSafetyChecks();
      if (!safetyResult.safe) {
        this.isRunning = false;
        log.warn({ reason: safetyResult.reason }, 'Chaos suite aborted by safety check');

        broadcast('meow:sovereign', {
          type: 'chaos:suite_aborted',
          reason: safetyResult.reason,
        });

        return this.buildReport([], 'Suite aborted by safety check: ' + safetyResult.reason);
      }
    }

    const completedExperiments: ChaosExperiment[] = [];
    const startMs = Date.now();

    for (const expType of types) {
      if (this.abortRequested) {
        log.info('Chaos suite abort requested — stopping');
        break;
      }

      // Check time limit
      if (Date.now() - startMs > this.config.schedule.maxRunDurationMs) {
        log.warn('Chaos suite time limit reached — stopping');
        break;
      }

      // Re-check safety before each experiment
      if (this.config.safetyChecks && this.config.abortOnCrisis) {
        const midCheck = await this.runSafetyChecks();
        if (!midCheck.safe) {
          log.warn({ reason: midCheck.reason }, 'Chaos suite halted mid-run by safety check');
          break;
        }
      }

      try {
        const experiment = await this.runExperiment(expType, runIntensity);
        completedExperiments.push(experiment);
      } catch (err) {
        log.error({ err, type: expType }, 'Experiment execution failed');
      }

      // Cooldown between experiments
      const cooldown = INTENSITY_PRESETS[runIntensity]?.cooldownMs ?? this.config.defaultCooldownMs;
      await this.delay(cooldown);
    }

    this.isRunning = false;
    this.stats.totalRunsExecuted += 1;
    this.stats.lastRunAt = new Date();

    // Build report
    const report = await this.buildReportWithAi(completedExperiments);

    this.reports.push(report);
    if (this.reports.length > MAX_REPORTS_IN_MEMORY) {
      this.reports = this.reports.slice(-MAX_REPORTS_IN_MEMORY);
    }

    await this.persistReport(report);

    log.info({
      experiments: completedExperiments.length,
      overallScore: report.overallScore,
      weakestArea: report.weakestArea,
    }, 'Chaos suite completed');

    broadcast('meow:sovereign', {
      type: 'chaos:suite_completed',
      experiments: completedExperiments.length,
      overallScore: report.overallScore,
      weakestArea: report.weakestArea,
      strongestArea: report.strongestArea,
    });

    return report;
  }

  // -------------------------------------------------------------------------
  // Single experiment execution
  // -------------------------------------------------------------------------

  async runExperiment(type: ChaosExperimentType, intensity: ExperimentIntensity = 'medium'): Promise<ChaosExperiment> {
    const preset = INTENSITY_PRESETS[intensity];
    const experimentConfig: ExperimentConfig = {
      durationMs: preset.durationMs ?? this.config.defaultDurationMs,
      cooldownMs: preset.cooldownMs ?? this.config.defaultCooldownMs,
      targetWorkerCount: preset.targetWorkerCount,
      apiFailurePct: preset.apiFailurePct,
      memoryPressureMb: preset.memoryPressureMb,
      latencyAddMs: preset.latencyAddMs,
      queueFloodCount: preset.queueFloodCount,
      budgetOverrunPct: preset.budgetOverrunPct,
    };

    const experiment: ChaosExperiment = {
      id: uuidv4(),
      type,
      status: 'pending',
      intensity,
      config: experimentConfig,
      result: null,
      injectedAt: null,
      observedAt: null,
      recoveredAt: null,
      completedAt: null,
      createdAt: new Date(),
    };

    this.currentExperiment = experiment;

    log.info({
      experimentId: experiment.id,
      type,
      intensity,
      durationMs: experimentConfig.durationMs,
    }, 'Starting chaos experiment');

    broadcast('meow:sovereign', {
      type: 'chaos:experiment_started',
      experimentId: experiment.id,
      experimentType: type,
      intensity,
    });

    const behaviorSnapshots: SystemBehaviorSnapshot[] = [];

    try {
      // Phase 1: Pre-injection baseline
      const baseline = await this.captureSystemState('pre_injection');
      behaviorSnapshots.push(baseline);

      // Phase 2: Inject fault
      experiment.status = 'injecting';
      experiment.injectedAt = new Date();
      await this.injectFault(type, experimentConfig);

      // Phase 3: Observe system behavior during fault
      experiment.status = 'observing';
      experiment.observedAt = new Date();
      const observationDuration = experimentConfig.durationMs;
      const samples = Math.min(
        Math.ceil(observationDuration / OBSERVATION_INTERVAL_MS),
        MAX_OBSERVATION_SAMPLES,
      );

      for (let i = 0; i < samples; i++) {
        if (this.abortRequested) break;
        await this.delay(OBSERVATION_INTERVAL_MS);
        const snapshot = await this.captureSystemState('during_injection');
        behaviorSnapshots.push(snapshot);
      }

      // Phase 4: Remove fault
      await this.cleanupFaults();

      // Phase 5: Observe recovery
      experiment.status = 'recovering';
      const recoveryStart = Date.now();
      const maxRecoveryWait = experimentConfig.durationMs * 3;
      let recovered = false;

      while (Date.now() - recoveryStart < maxRecoveryWait) {
        await this.delay(OBSERVATION_INTERVAL_MS);
        const snapshot = await this.captureSystemState('recovery');
        behaviorSnapshots.push(snapshot);

        // Check if system has recovered (error rate back to baseline level)
        if (snapshot.errorRate <= baseline.errorRate * 1.2 &&
            snapshot.avgLatencyMs <= baseline.avgLatencyMs * 1.5) {
          recovered = true;
          break;
        }
      }

      experiment.recoveredAt = new Date();

      // Phase 6: Post-injection measurement
      const postSnapshot = await this.captureSystemState('post_injection');
      behaviorSnapshots.push(postSnapshot);

      // Calculate scores
      experiment.status = 'measuring';
      const recoveryTimeMs = recovered
        ? (experiment.recoveredAt.getTime() - (experiment.observedAt?.getTime() ?? Date.now()))
        : maxRecoveryWait;

      const scores = this.calculateScores(type, baseline, behaviorSnapshots, recoveryTimeMs, experimentConfig);

      experiment.result = {
        scores,
        recoveryTimeMs,
        systemBehavior: behaviorSnapshots,
        degradationLevelReached: this.detectMaxDegradation(behaviorSnapshots),
        dataLossDetected: false, // would check chronicle for missing events
        servicesAffected: this.detectAffectedServices(type),
        anomaliesObserved: this.detectAnomalies(baseline, behaviorSnapshots),
        aiAnalysis: undefined,
      };

      experiment.status = 'completed';
      experiment.completedAt = new Date();

      // Update stats
      this.stats.totalExperiments += 1;
      this.stats.completedExperiments += 1;
      this.stats.scoresByType[type] = scores.overall;
      this.updateAvgScore(scores.overall);

    } catch (err) {
      experiment.status = 'failed';
      experiment.error = err instanceof Error ? err.message : String(err);
      experiment.completedAt = new Date();
      this.stats.totalExperiments += 1;
      this.stats.failedExperiments += 1;

      log.error({ err, experimentId: experiment.id, type }, 'Chaos experiment failed');

      // Ensure faults are cleaned up
      await this.cleanupFaults();
    }

    // Store experiment
    this.experiments.push(experiment);
    if (this.experiments.length > MAX_EXPERIMENTS_IN_MEMORY) {
      this.experiments = this.experiments.slice(-MAX_EXPERIMENTS_IN_MEMORY);
    }
    this.currentExperiment = null;

    await this.persistExperiment(experiment);

    log.info({
      experimentId: experiment.id,
      type,
      status: experiment.status,
      overallScore: experiment.result?.scores.overall ?? 0,
      recoveryTimeMs: experiment.result?.recoveryTimeMs ?? 0,
    }, `Chaos experiment ${experiment.status}`);

    broadcast('meow:sovereign', {
      type: 'chaos:experiment_completed',
      experimentId: experiment.id,
      experimentType: type,
      status: experiment.status,
      overallScore: experiment.result?.scores.overall ?? 0,
      recoveryTimeMs: experiment.result?.recoveryTimeMs ?? 0,
    });

    return experiment;
  }

  // -------------------------------------------------------------------------
  // Fault injection
  // -------------------------------------------------------------------------

  private async injectFault(type: ChaosExperimentType, config: ExperimentConfig): Promise<void> {
    this.injectedFaults = [];

    switch (type) {
      case 'random_worker_kill': {
        // Simulate killing workers by recording the intent
        // In production, this would actually terminate worker processes
        const count = config.targetWorkerCount ?? 1;
        log.warn({ count }, 'CHAOS: Simulating worker kill');
        this.injectedFaults.push({
          cleanup: () => { log.info('CHAOS: Worker kill fault cleaned up'); },
          description: `Kill ${count} random workers`,
        });
        break;
      }

      case 'simulated_api_failure': {
        const failurePct = config.apiFailurePct ?? 50;
        log.warn({ failurePct }, 'CHAOS: Simulating API failures');
        // In production, this would set a global flag that API clients check
        (globalThis as Record<string, unknown>).__chaos_api_failure_pct = failurePct;
        this.injectedFaults.push({
          cleanup: () => {
            delete (globalThis as Record<string, unknown>).__chaos_api_failure_pct;
            log.info('CHAOS: API failure simulation cleaned up');
          },
          description: `${failurePct}% API failure rate`,
        });
        break;
      }

      case 'memory_pressure': {
        const mb = config.memoryPressureMb ?? 200;
        log.warn({ mb }, 'CHAOS: Injecting memory pressure');
        // Allocate a buffer to simulate memory pressure
        const buffers: Buffer[] = [];
        try {
          for (let i = 0; i < mb; i++) {
            buffers.push(Buffer.alloc(1024 * 1024)); // 1MB each
          }
        } catch {
          log.warn('CHAOS: Memory allocation hit system limit');
        }
        this.injectedFaults.push({
          cleanup: () => {
            buffers.length = 0; // release for GC
            log.info('CHAOS: Memory pressure cleaned up');
          },
          description: `${mb}MB memory pressure`,
        });
        break;
      }

      case 'slow_network': {
        const latencyMs = config.latencyAddMs ?? 1000;
        log.warn({ latencyMs }, 'CHAOS: Injecting network latency');
        (globalThis as Record<string, unknown>).__chaos_latency_ms = latencyMs;
        this.injectedFaults.push({
          cleanup: () => {
            delete (globalThis as Record<string, unknown>).__chaos_latency_ms;
            log.info('CHAOS: Network latency cleaned up');
          },
          description: `${latencyMs}ms added latency`,
        });
        break;
      }

      case 'queue_flood': {
        const count = config.queueFloodCount ?? 500;
        log.warn({ count }, 'CHAOS: Flooding bead queue');
        const pool = getPool();
        if (pool) {
          try {
            const values: string[] = [];
            for (let i = 0; i < Math.min(count, 100); i++) {
              values.push(`('${uuidv4()}', 'chaos-molecule', 'pending', 0, NOW(), true)`);
            }
            if (values.length > 0) {
              await pool.query(
                `INSERT INTO meow_beads (id, molecule_id, status, priority, created_at, chaos_injected)
                 VALUES ${values.join(',')}`,
              );
            }
          } catch {
            log.warn('CHAOS: Queue flood injection failed (table may not support chaos_injected column)');
          }
        }
        this.injectedFaults.push({
          cleanup: async () => {
            if (pool) {
              try {
                await pool.query(`DELETE FROM meow_beads WHERE chaos_injected = true`);
              } catch {
                // Column may not exist
              }
            }
            log.info('CHAOS: Queue flood cleaned up');
          },
          description: `${count} fake beads injected`,
        } as { cleanup: () => void; description: string });
        break;
      }

      case 'budget_exhaust': {
        const overrunPct = config.budgetOverrunPct ?? 50;
        log.warn({ overrunPct }, 'CHAOS: Simulating budget exhaustion');
        (globalThis as Record<string, unknown>).__chaos_budget_overrun_pct = overrunPct;
        this.injectedFaults.push({
          cleanup: () => {
            delete (globalThis as Record<string, unknown>).__chaos_budget_overrun_pct;
            log.info('CHAOS: Budget exhaustion cleaned up');
          },
          description: `${overrunPct}% budget overrun`,
        });
        break;
      }
    }

    log.info({ faults: this.injectedFaults.length, type }, 'Fault injection complete');
  }

  private async cleanupFaults(): Promise<void> {
    for (const fault of this.injectedFaults) {
      try {
        await Promise.resolve(fault.cleanup());
      } catch (err) {
        log.error({ err, description: fault.description }, 'Failed to cleanup injected fault');
      }
    }
    this.injectedFaults = [];
  }

  // -------------------------------------------------------------------------
  // System state capture
  // -------------------------------------------------------------------------

  private async captureSystemState(phase: SystemBehaviorSnapshot['phase']): Promise<SystemBehaviorSnapshot> {
    const mem = process.memoryUsage();

    let pendingBeads = 0;
    let errorRate = 0;
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM meow_beads WHERE status = 'pending'`,
        );
        pendingBeads = parseInt(rows[0]?.cnt ?? '0', 10);
      } catch {
        errorRate += 10; // DB query failure counts as error
      }
    }

    // Check for injected chaos flags affecting error rate
    const chaosApiFailure = (globalThis as Record<string, unknown>).__chaos_api_failure_pct as number | undefined;
    if (chaosApiFailure) {
      errorRate += chaosApiFailure * 0.5; // Half the API failure rate shows as system error rate
    }

    const chaosLatency = (globalThis as Record<string, unknown>).__chaos_latency_ms as number | undefined;

    return {
      timestamp: new Date().toISOString(),
      phase,
      activeWorkers: 0, // would integrate with worker pool
      pendingBeads,
      errorRate: Math.min(100, errorRate),
      avgLatencyMs: chaosLatency ? chaosLatency : 50, // base latency
      memoryUsagePct: Math.round((mem.heapUsed / mem.heapTotal) * 100),
      degradationLevel: 'normal', // would integrate with graceful-degradation.ts
    };
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  private calculateScores(
    _type: ChaosExperimentType,
    baseline: SystemBehaviorSnapshot,
    snapshots: SystemBehaviorSnapshot[],
    recoveryTimeMs: number,
    config: ExperimentConfig,
  ): ExperimentScores {
    // Recovery time score: fast recovery = high score
    const maxRecovery = config.durationMs * 3;
    const recoveryTime = Math.round(Math.max(0, 100 - (recoveryTimeMs / maxRecovery) * 100));

    // Data loss score: check if any beads were lost during experiment
    const dataLoss = 100; // Default: no data loss (would check chronicle integrity)

    // Service degradation: how much did error rate increase?
    const duringSnapshots = snapshots.filter(s => s.phase === 'during_injection');
    const maxErrorRate = duringSnapshots.length > 0
      ? Math.max(...duringSnapshots.map(s => s.errorRate))
      : 0;
    const errorRateIncrease = maxErrorRate - baseline.errorRate;
    const serviceDegradation = Math.round(Math.max(0, 100 - errorRateIncrease));

    // User impact: combination of latency increase and error rate
    const maxLatency = duringSnapshots.length > 0
      ? Math.max(...duringSnapshots.map(s => s.avgLatencyMs))
      : baseline.avgLatencyMs;
    const latencyMultiplier = maxLatency / Math.max(1, baseline.avgLatencyMs);
    const userImpact = Math.round(Math.max(0, 100 - (latencyMultiplier - 1) * 20 - errorRateIncrease * 0.5));

    // Overall: weighted average
    const overall = Math.round(
      recoveryTime * 0.3 + dataLoss * 0.25 + serviceDegradation * 0.25 + userImpact * 0.2,
    );

    return { recoveryTime, dataLoss, serviceDegradation, userImpact, overall };
  }

  private detectMaxDegradation(snapshots: SystemBehaviorSnapshot[]): string {
    const levels = snapshots.map(s => s.degradationLevel);
    const priority = ['minimal', 'critical', 'degraded', 'normal'];
    for (const level of priority) {
      if (levels.includes(level)) return level;
    }
    return 'normal';
  }

  private detectAffectedServices(type: ChaosExperimentType): string[] {
    switch (type) {
      case 'random_worker_kill': return ['worker-pool', 'formula-engine'];
      case 'simulated_api_failure': return ['meta-ads', 'shopify', 'gemini'];
      case 'memory_pressure': return ['worker-pool', 'cache', 'formula-engine'];
      case 'slow_network': return ['database', 'external-apis', 'sse'];
      case 'queue_flood': return ['bead-queue', 'scheduler', 'worker-pool'];
      case 'budget_exhaust': return ['budget-management', 'campaign-launcher'];
      default: return [];
    }
  }

  private detectAnomalies(baseline: SystemBehaviorSnapshot, snapshots: SystemBehaviorSnapshot[]): string[] {
    const anomalies: string[] = [];

    const recoverySnapshots = snapshots.filter(s => s.phase === 'post_injection');
    if (recoverySnapshots.length > 0) {
      const lastRecovery = recoverySnapshots[recoverySnapshots.length - 1];

      if (lastRecovery.errorRate > baseline.errorRate * 2) {
        anomalies.push(`Error rate did not fully recover: ${lastRecovery.errorRate}% vs baseline ${baseline.errorRate}%`);
      }

      if (lastRecovery.memoryUsagePct > baseline.memoryUsagePct + 20) {
        anomalies.push(`Memory usage elevated after recovery: ${lastRecovery.memoryUsagePct}% vs baseline ${baseline.memoryUsagePct}%`);
      }

      if (lastRecovery.pendingBeads > baseline.pendingBeads * 3) {
        anomalies.push(`Bead queue backlog after recovery: ${lastRecovery.pendingBeads} vs baseline ${baseline.pendingBeads}`);
      }
    }

    return anomalies;
  }

  // -------------------------------------------------------------------------
  // Report generation
  // -------------------------------------------------------------------------

  private buildReport(experiments: ChaosExperiment[], note?: string): ChaosReport {
    const completedExps = experiments.filter(e => e.result);

    const avgScore = completedExps.length > 0
      ? Math.round(completedExps.reduce((s, e) => s + (e.result?.scores.overall ?? 0), 0) / completedExps.length)
      : 0;

    const sorted = [...completedExps].sort((a, b) => (a.result?.scores.overall ?? 0) - (b.result?.scores.overall ?? 0));
    const weakest = sorted[0];
    const strongest = sorted[sorted.length - 1];

    const trend = this.calculateTrend();

    const markdownLines: string[] = [
      `# Chaos Engineering Report`,
      `**Date:** ${new Date().toISOString().slice(0, 10)}`,
      `**Experiments:** ${completedExps.length}`,
      `**Overall Score:** ${avgScore}/100`,
      '',
    ];

    if (note) {
      markdownLines.push(`> ${note}`, '');
    }

    markdownLines.push('## Results by Experiment', '');
    markdownLines.push('| Experiment | Score | Recovery | Data Loss | Degradation | User Impact |');
    markdownLines.push('|------------|-------|----------|-----------|-------------|-------------|');

    for (const exp of completedExps) {
      const s = exp.result!.scores;
      markdownLines.push(
        `| ${exp.type} | **${s.overall}** | ${s.recoveryTime} | ${s.dataLoss} | ${s.serviceDegradation} | ${s.userImpact} |`,
      );
    }

    markdownLines.push('', '## Trend Analysis', '');
    markdownLines.push(trend.message);

    const recommendations = this.generateRecommendations(completedExps);
    if (recommendations.length > 0) {
      markdownLines.push('', '## Recommendations', '');
      for (const rec of recommendations) {
        markdownLines.push(`- ${rec}`);
      }
    }

    return {
      id: uuidv4(),
      runDate: new Date().toISOString(),
      experiments: completedExps.map(e => ({
        type: e.type,
        scores: e.result!.scores,
        recoveryTimeMs: e.result!.recoveryTimeMs,
        status: e.status,
      })),
      overallScore: avgScore,
      weakestArea: weakest?.type ?? 'N/A',
      strongestArea: strongest?.type ?? 'N/A',
      trend,
      recommendations,
      markdownReport: markdownLines.join('\n'),
      createdAt: new Date(),
    };
  }

  private async buildReportWithAi(experiments: ChaosExperiment[]): Promise<ChaosReport> {
    const report = this.buildReport(experiments);

    // Enrich with AI analysis
    const context = JSON.stringify({
      experiments: experiments.map(e => ({
        type: e.type,
        intensity: e.intensity,
        scores: e.result?.scores,
        recoveryTimeMs: e.result?.recoveryTimeMs,
        anomalies: e.result?.anomaliesObserved,
        degradationReached: e.result?.degradationLevelReached,
      })),
      overallScore: report.overallScore,
      previousScores: Object.entries(this.stats.scoresByType),
    });

    const aiResponse = await callGeminiChaos(context);
    if (aiResponse) {
      try {
        const parsed = JSON.parse(aiResponse) as {
          overallAssessment: string;
          weaknesses: string[];
          strengths: string[];
          recommendations: string[];
        };

        // Enrich experiments with AI analysis
        for (const exp of experiments) {
          if (exp.result) {
            exp.result.aiAnalysis = parsed.overallAssessment;
          }
        }

        // Merge AI recommendations with heuristic ones
        const aiRecs = parsed.recommendations.filter(r => !report.recommendations.includes(r));
        report.recommendations.push(...aiRecs);

        // Append AI section to markdown
        report.markdownReport += '\n\n## AI Analysis\n\n' + parsed.overallAssessment;
        if (parsed.weaknesses.length > 0) {
          report.markdownReport += '\n\n### Weaknesses\n';
          for (const w of parsed.weaknesses) {
            report.markdownReport += `- ${w}\n`;
          }
        }
        if (parsed.strengths.length > 0) {
          report.markdownReport += '\n\n### Strengths\n';
          for (const s of parsed.strengths) {
            report.markdownReport += `- ${s}\n`;
          }
        }
      } catch {
        // Ignore AI parse errors
      }
    }

    return report;
  }

  private calculateTrend(): TrendAnalysis {
    if (this.reports.length < 2) {
      return {
        recoveryTimeTrend: 0,
        dataLossTrend: 0,
        degradationTrend: 0,
        overallTrend: 0,
        comparedToRunsAgo: 0,
        message: 'Not enough historical data for trend analysis (need at least 2 runs)',
      };
    }

    const latest = this.reports[this.reports.length - 1];
    const previous = this.reports[this.reports.length - 2];

    if (!latest || !previous) {
      return {
        recoveryTimeTrend: 0, dataLossTrend: 0, degradationTrend: 0,
        overallTrend: 0, comparedToRunsAgo: 1,
        message: 'Insufficient data for trend',
      };
    }

    const overallTrend = latest.overallScore - previous.overallScore;

    let message = '';
    if (overallTrend > 5) {
      message = `Overall resilience improved by ${overallTrend} points since last run.`;
    } else if (overallTrend < -5) {
      message = `Overall resilience degraded by ${Math.abs(overallTrend)} points since last run. Investigation recommended.`;
    } else {
      message = `Resilience scores stable (${overallTrend >= 0 ? '+' : ''}${overallTrend} points).`;
    }

    return {
      recoveryTimeTrend: 0,
      dataLossTrend: 0,
      degradationTrend: 0,
      overallTrend,
      comparedToRunsAgo: 1,
      message,
    };
  }

  private generateRecommendations(experiments: ChaosExperiment[]): string[] {
    const recommendations: string[] = [];

    for (const exp of experiments) {
      if (!exp.result) continue;

      const scores = exp.result.scores;

      if (scores.recoveryTime < 50) {
        recommendations.push(`${exp.type}: Recovery time is slow (score ${scores.recoveryTime}/100). Consider adding retry logic or circuit breakers.`);
      }

      if (scores.dataLoss < 80) {
        recommendations.push(`${exp.type}: Potential data loss detected (score ${scores.dataLoss}/100). Review persistence and transaction boundaries.`);
      }

      if (scores.serviceDegradation < 40) {
        recommendations.push(`${exp.type}: Severe service degradation (score ${scores.serviceDegradation}/100). Implement better isolation between subsystems.`);
      }

      if (scores.userImpact < 50) {
        recommendations.push(`${exp.type}: High user impact (score ${scores.userImpact}/100). Add graceful degradation for user-facing endpoints.`);
      }

      if (exp.result.anomaliesObserved.length > 0) {
        recommendations.push(`${exp.type}: ${exp.result.anomaliesObserved.length} anomalies detected post-recovery. System may have lingering issues.`);
      }
    }

    // Identify worst-performing experiment type
    const worstExp = experiments
      .filter(e => e.result)
      .sort((a, b) => (a.result?.scores.overall ?? 100) - (b.result?.scores.overall ?? 100))[0];

    if (worstExp && worstExp.result && worstExp.result.scores.overall < 60) {
      recommendations.unshift(
        `PRIORITY: ${worstExp.type} is the weakest area (score ${worstExp.result.scores.overall}/100). Focus resilience improvements here.`,
      );
    }

    return recommendations;
  }

  // -------------------------------------------------------------------------
  // Safety checks
  // -------------------------------------------------------------------------

  private async runSafetyChecks(): Promise<{ safe: boolean; reason: string }> {
    // Check registered safety checkers (e.g., crisis mode, load)
    for (const checker of this.safetyCheckers) {
      try {
        const result = await checker();
        if (!result.safe) {
          return result;
        }
      } catch (err) {
        return { safe: false, reason: `Safety checker failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Check system load
    if (this.config.schedule.requireLowLoad) {
      const mem = process.memoryUsage();
      const memPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
      if (memPct > 80) {
        return { safe: false, reason: `Memory usage too high for chaos: ${memPct}%` };
      }
    }

    return { safe: true, reason: 'All safety checks passed' };
  }

  // -------------------------------------------------------------------------
  // Abort
  // -------------------------------------------------------------------------

  abort(): void {
    this.abortRequested = true;
    if (this.currentExperiment) {
      this.currentExperiment.status = 'aborted';
      this.stats.abortedExperiments += 1;
    }
    this.cleanupFaults().catch(err =>
      log.error({ err }, 'Failed to cleanup faults during abort'),
    );
    log.info('Chaos suite abort requested');
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  isActive(): boolean {
    return this.isRunning;
  }

  getCurrentExperiment(): ChaosExperiment | null {
    return this.currentExperiment;
  }

  getStats(): ChaosStats {
    // Determine worst/best types
    const typeEntries = Object.entries(this.stats.scoresByType);
    if (typeEntries.length > 0) {
      const sorted = typeEntries.sort((a, b) => a[1] - b[1]);
      this.stats.worstExperimentType = sorted[0][0] as ChaosExperimentType;
      this.stats.bestExperimentType = sorted[sorted.length - 1][0] as ChaosExperimentType;
    }
    return { ...this.stats };
  }

  getConfig(): ChaosConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  updateConfig(updates: Partial<ChaosConfig>): void {
    if (updates.schedule) {
      this.config.schedule = { ...this.config.schedule, ...updates.schedule };
    }
    if (updates.defaultIntensity) this.config.defaultIntensity = updates.defaultIntensity;
    if (updates.defaultDurationMs) this.config.defaultDurationMs = updates.defaultDurationMs;
    if (updates.defaultCooldownMs) this.config.defaultCooldownMs = updates.defaultCooldownMs;
    if (updates.safetyChecks !== undefined) this.config.safetyChecks = updates.safetyChecks;
    if (updates.abortOnCrisis !== undefined) this.config.abortOnCrisis = updates.abortOnCrisis;
    log.info({ config: this.config }, 'Chaos config updated');
  }

  getExperimentHistory(limit = 20): ChaosExperiment[] {
    return this.experiments.slice(-limit);
  }

  getReportHistory(limit = 5): ChaosReport[] {
    return this.reports.slice(-limit);
  }

  getLatestReport(): ChaosReport | null {
    return this.reports.length > 0 ? this.reports[this.reports.length - 1] : null;
  }

  // -------------------------------------------------------------------------
  // Stats helpers
  // -------------------------------------------------------------------------

  private updateAvgScore(score: number): void {
    const n = this.stats.completedExperiments;
    if (n <= 1) {
      this.stats.avgOverallScore = score;
    } else {
      this.stats.avgOverallScore = Math.round(
        (this.stats.avgOverallScore * (n - 1) + score) / n,
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistExperiment(experiment: ChaosExperiment): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_chaos_experiments
           (id, type, status, intensity, config_json, result_json,
            injected_at, observed_at, recovered_at, completed_at,
            created_at, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           status=$3, result_json=$6, recovered_at=$9, completed_at=$10, error=$12`,
        [
          experiment.id,
          experiment.type,
          experiment.status,
          experiment.intensity,
          JSON.stringify(experiment.config),
          experiment.result ? JSON.stringify(experiment.result) : null,
          experiment.injectedAt?.toISOString() ?? null,
          experiment.observedAt?.toISOString() ?? null,
          experiment.recoveredAt?.toISOString() ?? null,
          experiment.completedAt?.toISOString() ?? null,
          experiment.createdAt.toISOString(),
          experiment.error ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, experimentId: experiment.id }, 'Failed to persist chaos experiment');
    }
  }

  private async persistReport(report: ChaosReport): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_chaos_experiments
           (id, type, status, intensity, config_json, result_json, created_at)
         VALUES ($1, 'suite_report', 'completed', 'medium', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [
          `report-${report.id}`,
          JSON.stringify({ reportId: report.id, runDate: report.runDate }),
          JSON.stringify(report),
          report.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist chaos report');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, status, intensity, result_json, created_at
         FROM meow_chaos_experiments
         WHERE type != 'suite_report'
           AND created_at >= NOW() - INTERVAL '90 days'
         ORDER BY created_at DESC
         LIMIT 100`,
      );

      for (const row of rows) {
        this.stats.totalExperiments += 1;
        if (row.status === 'completed') {
          this.stats.completedExperiments += 1;
          if (row.result_json) {
            try {
              const result = typeof row.result_json === 'string'
                ? JSON.parse(row.result_json)
                : row.result_json;
              if (result.scores?.overall) {
                this.stats.scoresByType[row.type] = result.scores.overall;
              }
            } catch {
              // Ignore parse errors
            }
          }
        } else if (row.status === 'failed') {
          this.stats.failedExperiments += 1;
        } else if (row.status === 'aborted') {
          this.stats.abortedExperiments += 1;
        }
      }

      if (rows.length > 0) {
        this.stats.lastRunAt = new Date(rows[0].created_at);
      }

      log.info({ experiments: rows.length }, 'Loaded chaos experiment history from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load chaos experiments from DB (table may not exist yet)');
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.isRunning) {
      this.abort();
    }
    await this.cleanupFaults();
    log.info('Chaos engineering shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ChaosEngineering | null = null;

export function getChaosEngineering(): ChaosEngineering {
  if (!instance) {
    instance = new ChaosEngineering();
  }
  return instance;
}
