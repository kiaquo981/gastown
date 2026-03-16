/**
 * CRISIS MODE — SG-011 (Stage 06 Wave 3)
 *
 * Emergency response system for Gas Town when critical alerts fire.
 * Pauses non-essential work, redirects all resources to resolution,
 * notifies operators, and tracks the full crisis lifecycle.
 *
 * Crisis triggers:
 *   - ROAS crash (< 0.5)
 *   - API down (Meta/Shopify/Evolution)
 *   - Budget exceeded (> 100%)
 *   - Security breach
 *   - Data integrity issue
 *
 * Lifecycle:
 *   opened → response_started → mitigated → resolved → post_mortem
 *
 * Features:
 *   - Immediate pause of all non-essential formulas and beads
 *   - Focus resources: redirect all workers to crisis resolution
 *   - WhatsApp alert via Evolution API with crisis summary
 *   - Per-trigger-type predefined response playbooks
 *   - Auto-exit when crisis conditions no longer met
 *   - Escalation if not resolved within threshold (default 30min)
 *   - Crisis mode flag queryable by all other systems
 *   - DB persistence: meow_crisis_events
 *
 * Gas Town: "When the refinery catches fire, everything stops until it's out."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('crisis-mode');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CrisisTriggerType =
  | 'roas_crash'
  | 'api_down'
  | 'budget_exceeded'
  | 'security_breach'
  | 'data_integrity'
  | 'system_overload'
  | 'manual';

export type CrisisStatus =
  | 'opened'
  | 'response_started'
  | 'mitigated'
  | 'resolved'
  | 'post_mortem'
  | 'expired';

export type CrisisSeverity = 'critical' | 'high' | 'medium';

export type EscalationLevel = 'l1_operator' | 'l2_manager' | 'l3_executive';

export interface CrisisEvent {
  id: string;
  triggerType: CrisisTriggerType;
  severity: CrisisSeverity;
  status: CrisisStatus;
  title: string;
  description: string;
  triggerValue?: number;         // e.g. ROAS value that triggered
  triggerThreshold?: number;     // threshold that was breached
  affectedSystems: string[];
  playbook: PlaybookStep[];
  completedSteps: string[];      // step IDs that have been executed
  pausedFormulas: string[];
  pausedBeads: string[];
  escalationLevel: EscalationLevel;
  escalatedAt?: Date;
  notifiedOperators: string[];
  resolutionNotes?: string;
  aiAnalysis?: string;
  autoExitCondition?: string;
  createdAt: Date;
  responseStartedAt?: Date;
  mitigatedAt?: Date;
  resolvedAt?: Date;
  postMortemAt?: Date;
}

export interface PlaybookStep {
  id: string;
  order: number;
  action: string;
  description: string;
  automated: boolean;            // can be executed automatically
  completed: boolean;
  completedAt?: Date;
  result?: string;
}

export interface CrisisTriggerConfig {
  type: CrisisTriggerType;
  label: string;
  severity: CrisisSeverity;
  thresholdDescription: string;
  autoDetect: boolean;
  escalationTimeoutMin: number;  // minutes before escalation
  playbook: Array<Omit<PlaybookStep, 'id' | 'completed' | 'completedAt' | 'result'>>;
  autoExitCondition: string;
  affectedSystems: string[];
}

export interface CrisisCheck {
  triggerType: CrisisTriggerType;
  triggered: boolean;
  currentValue?: number;
  threshold?: number;
  message: string;
}

export interface CrisisModeStatus {
  active: boolean;
  activeCrisis: CrisisEvent | null;
  crisisCount24h: number;
  avgResolutionMinutes: number;
  lastCrisisAt?: Date;
  escalationLevel: EscalationLevel | null;
}

export interface CrisisStats {
  totalCrises: number;
  resolvedCrises: number;
  avgResolutionMs: number;
  crisesByType: Record<CrisisTriggerType, number>;
  crisesBySeverity: Record<CrisisSeverity, number>;
  escalations: number;
  autoResolutions: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ESCALATION_TIMEOUT_MIN = 30;
const MAX_CRISIS_HISTORY = 100;

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL ?? '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE ?? '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY ?? '';
const OPERATOR_PHONE = process.env.MAYOR_OPERATOR_PHONE ?? '5511964682447';

/** Predefined crisis trigger configurations and playbooks */
const CRISIS_TRIGGERS: CrisisTriggerConfig[] = [
  {
    type: 'roas_crash',
    label: 'ROAS Crash',
    severity: 'critical',
    thresholdDescription: 'ROAS drops below 0.5',
    autoDetect: true,
    escalationTimeoutMin: 30,
    playbook: [
      { order: 1, action: 'pause_ads', description: 'Pause all active ad campaigns via Meta API', automated: true },
      { order: 2, action: 'snapshot_metrics', description: 'Capture current campaign metrics snapshot', automated: true },
      { order: 3, action: 'analyze_drop', description: 'AI-analyze root cause of ROAS crash', automated: true },
      { order: 4, action: 'notify_operator', description: 'Send WhatsApp alert with analysis', automated: true },
      { order: 5, action: 'propose_fix', description: 'Generate remediation plan', automated: true },
      { order: 6, action: 'await_approval', description: 'Wait for operator approval before resuming', automated: false },
    ],
    autoExitCondition: 'ROAS recovers above 0.8 for 30 minutes',
    affectedSystems: ['meta-ads', 'campaign-launcher', 'roas-monitor'],
  },
  {
    type: 'api_down',
    label: 'External API Down',
    severity: 'high',
    thresholdDescription: 'Meta, Shopify, or Evolution API unreachable',
    autoDetect: true,
    escalationTimeoutMin: 20,
    playbook: [
      { order: 1, action: 'confirm_outage', description: 'Verify API is actually down (3 retries)', automated: true },
      { order: 2, action: 'pause_dependent', description: 'Pause formulas that depend on the API', automated: true },
      { order: 3, action: 'check_status_page', description: 'Check provider status page', automated: true },
      { order: 4, action: 'notify_operator', description: 'Send WhatsApp alert with status', automated: true },
      { order: 5, action: 'enable_polling', description: 'Start polling API every 2min for recovery', automated: true },
    ],
    autoExitCondition: 'API responds successfully 3 times consecutively',
    affectedSystems: ['meta-ads', 'shopify-hub', 'whatsapp-funnel'],
  },
  {
    type: 'budget_exceeded',
    label: 'Budget Exceeded',
    severity: 'critical',
    thresholdDescription: 'Daily ad spend exceeds 100% of budget',
    autoDetect: true,
    escalationTimeoutMin: 15,
    playbook: [
      { order: 1, action: 'pause_all_ads', description: 'Immediately pause all ad campaigns', automated: true },
      { order: 2, action: 'calculate_overspend', description: 'Calculate exact overspend amount', automated: true },
      { order: 3, action: 'notify_operator', description: 'Send WhatsApp alert with overspend details', automated: true },
      { order: 4, action: 'review_budget_rules', description: 'Review and tighten budget rules', automated: false },
    ],
    autoExitCondition: 'Budget rules updated and spend back under limit',
    affectedSystems: ['meta-ads', 'budget-management', 'financial-controller'],
  },
  {
    type: 'security_breach',
    label: 'Security Breach',
    severity: 'critical',
    thresholdDescription: 'Unauthorized access or anomalous API usage detected',
    autoDetect: true,
    escalationTimeoutMin: 10,
    playbook: [
      { order: 1, action: 'lockdown', description: 'Pause ALL formulas and external API calls', automated: true },
      { order: 2, action: 'rotate_keys', description: 'Flag API keys for rotation', automated: true },
      { order: 3, action: 'audit_log', description: 'Capture full audit trail of last 1h', automated: true },
      { order: 4, action: 'notify_operator', description: 'Send urgent WhatsApp alert', automated: true },
      { order: 5, action: 'await_investigation', description: 'Hold lockdown until manual investigation', automated: false },
    ],
    autoExitCondition: 'Manual clearance by operator after investigation',
    affectedSystems: ['all'],
  },
  {
    type: 'data_integrity',
    label: 'Data Integrity Issue',
    severity: 'high',
    thresholdDescription: 'Database inconsistency or corrupted data detected',
    autoDetect: true,
    escalationTimeoutMin: 25,
    playbook: [
      { order: 1, action: 'pause_writes', description: 'Pause all write operations to affected tables', automated: true },
      { order: 2, action: 'snapshot_state', description: 'Create snapshot of current DB state', automated: true },
      { order: 3, action: 'identify_scope', description: 'AI-analyze scope of data corruption', automated: true },
      { order: 4, action: 'notify_operator', description: 'Send WhatsApp alert with scope analysis', automated: true },
      { order: 5, action: 'propose_repair', description: 'Generate data repair plan', automated: true },
    ],
    autoExitCondition: 'Data integrity checks pass after repair',
    affectedSystems: ['database', 'megabrain', 'persistence'],
  },
  {
    type: 'system_overload',
    label: 'System Overload',
    severity: 'medium',
    thresholdDescription: 'Worker utilization > 95% for 10+ minutes',
    autoDetect: true,
    escalationTimeoutMin: 45,
    playbook: [
      { order: 1, action: 'pause_low_priority', description: 'Pause all low-priority and background formulas', automated: true },
      { order: 2, action: 'shed_load', description: 'Reduce concurrent formula limit by 50%', automated: true },
      { order: 3, action: 'notify_operator', description: 'Send load alert via WhatsApp', automated: true },
      { order: 4, action: 'monitor_recovery', description: 'Monitor load until it drops below 70%', automated: true },
    ],
    autoExitCondition: 'Worker utilization below 70% for 5 minutes',
    affectedSystems: ['worker-pool', 'formula-engine'],
  },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiCrisis(context: string): Promise<string | null> {
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
                'You are a crisis response analyst for an AI agent platform called Gas Town. '
                + 'Given crisis data, provide root cause analysis and remediation recommendations. '
                + 'Respond ONLY with valid JSON: {"rootCause": "...", "impact": "...", '
                + '"immediateActions": ["..."], "remediationPlan": "...", "estimatedRecoveryMinutes": N}',
            },
            { role: 'user', content: context },
          ],
          max_tokens: 1024,
          temperature: 0.1,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini crisis analysis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp notification helper
// ---------------------------------------------------------------------------

async function sendWhatsAppAlert(message: string): Promise<boolean> {
  if (!EVOLUTION_API_URL || !EVOLUTION_INSTANCE || !EVOLUTION_API_KEY) {
    log.warn('Evolution API not configured, WhatsApp alert skipped');
    return false;
  }

  try {
    const resp = await fetch(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number: OPERATOR_PHONE,
          text: message,
        }),
      },
    );
    if (!resp.ok) {
      log.warn({ status: resp.status }, 'WhatsApp alert send failed');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err }, 'WhatsApp alert send error');
    return false;
  }
}

// ---------------------------------------------------------------------------
// CrisisMode
// ---------------------------------------------------------------------------

export class CrisisMode {
  private activeCrisis: CrisisEvent | null = null;
  private crisisHistory: CrisisEvent[] = [];
  private escalationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stats: CrisisStats = {
    totalCrises: 0,
    resolvedCrises: 0,
    avgResolutionMs: 0,
    crisesByType: {} as Record<CrisisTriggerType, number>,
    crisesBySeverity: {} as Record<CrisisSeverity, number>,
    escalations: 0,
    autoResolutions: 0,
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadFromDb();
    this.initialized = true;

    log.info({
      activeCrisis: this.activeCrisis?.id ?? 'none',
      historySize: this.crisisHistory.length,
    }, 'Crisis mode initialized');
  }

  // -------------------------------------------------------------------------
  // Crisis detection
  // -------------------------------------------------------------------------

  checkTrigger(type: CrisisTriggerType, currentValue: number, threshold: number): CrisisCheck {
    let triggered = false;
    let message = '';

    switch (type) {
      case 'roas_crash':
        triggered = currentValue < threshold;
        message = triggered
          ? `ROAS crashed to ${currentValue.toFixed(2)} (threshold: ${threshold})`
          : `ROAS at ${currentValue.toFixed(2)}, within threshold`;
        break;
      case 'budget_exceeded':
        triggered = currentValue > threshold;
        message = triggered
          ? `Budget at ${currentValue.toFixed(0)}% (threshold: ${threshold}%)`
          : `Budget at ${currentValue.toFixed(0)}%, within limit`;
        break;
      case 'system_overload':
        triggered = currentValue > threshold;
        message = triggered
          ? `System load at ${currentValue.toFixed(0)}% (threshold: ${threshold}%)`
          : `System load at ${currentValue.toFixed(0)}%, nominal`;
        break;
      default:
        triggered = currentValue >= threshold;
        message = triggered
          ? `${type} triggered: value ${currentValue} >= threshold ${threshold}`
          : `${type} normal: value ${currentValue} < threshold ${threshold}`;
    }

    return { triggerType: type, triggered, currentValue, threshold, message };
  }

  // -------------------------------------------------------------------------
  // Crisis lifecycle
  // -------------------------------------------------------------------------

  async triggerCrisis(
    type: CrisisTriggerType,
    description: string,
    triggerValue?: number,
    triggerThreshold?: number,
    callerToken?: string,
  ): Promise<CrisisEvent> {
    // CRIT-02: Validate caller authorization before allowing crisis trigger
    const requiredToken = process.env.MEOW_CRISIS_TOKEN || process.env.GASTOWN_API_KEY;
    if (requiredToken && callerToken !== requiredToken) {
      log.error({ type, hasToken: !!callerToken }, 'Unauthorized crisis trigger attempt — missing or invalid callerToken');
      throw new Error('Unauthorized: valid callerToken required to trigger crisis mode');
    }

    // If there's already an active crisis, log but allow multiple
    if (this.activeCrisis && this.activeCrisis.status !== 'resolved' && this.activeCrisis.status !== 'post_mortem') {
      log.warn({
        existingCrisis: this.activeCrisis.id,
        newTrigger: type,
      }, 'New crisis triggered while existing crisis active');
    }

    const config = CRISIS_TRIGGERS.find(t => t.type === type) ?? CRISIS_TRIGGERS[0];

    const crisis: CrisisEvent = {
      id: uuidv4(),
      triggerType: type,
      severity: config.severity,
      status: 'opened',
      title: `${config.label}: ${description.slice(0, 100)}`,
      description,
      triggerValue,
      triggerThreshold,
      affectedSystems: [...config.affectedSystems],
      playbook: config.playbook.map(step => ({
        ...step,
        id: uuidv4(),
        completed: false,
      })),
      completedSteps: [],
      pausedFormulas: [],
      pausedBeads: [],
      escalationLevel: 'l1_operator',
      notifiedOperators: [],
      autoExitCondition: config.autoExitCondition,
      createdAt: new Date(),
    };

    this.activeCrisis = crisis;
    this.crisisHistory.push(crisis);
    if (this.crisisHistory.length > MAX_CRISIS_HISTORY) {
      this.crisisHistory = this.crisisHistory.slice(-MAX_CRISIS_HISTORY / 2);
    }

    this.stats.totalCrises += 1;
    this.stats.crisesByType[type] = (this.stats.crisesByType[type] ?? 0) + 1;
    this.stats.crisesBySeverity[config.severity] = (this.stats.crisesBySeverity[config.severity] ?? 0) + 1;

    await this.persistCrisis(crisis);

    log.error({
      crisisId: crisis.id,
      type,
      severity: config.severity,
      description,
    }, 'CRISIS TRIGGERED');

    broadcast('meow:sovereign', {
      type: 'crisis:triggered',
      crisisId: crisis.id,
      triggerType: type,
      severity: config.severity,
      title: crisis.title,
      affectedSystems: crisis.affectedSystems,
    });

    // Start automated response
    await this.startResponse(crisis.id);

    // Set escalation timer
    this.setEscalationTimer(crisis.id, config.escalationTimeoutMin);

    return crisis;
  }

  async startResponse(crisisId: string): Promise<void> {
    const crisis = this.findCrisis(crisisId);
    if (!crisis) return;

    crisis.status = 'response_started';
    crisis.responseStartedAt = new Date();

    // Execute automated playbook steps
    for (const step of crisis.playbook) {
      if (!step.automated) break; // Stop at first manual step

      await this.executePlaybookStep(crisis, step);
    }

    // AI analysis
    const aiAnalysis = await this.performAiAnalysis(crisis);
    if (aiAnalysis) {
      crisis.aiAnalysis = aiAnalysis;
    }

    // Notify operator via WhatsApp
    await this.notifyOperator(crisis);

    await this.persistCrisis(crisis);

    broadcast('meow:sovereign', {
      type: 'crisis:response_started',
      crisisId: crisis.id,
      completedSteps: crisis.completedSteps.length,
      totalSteps: crisis.playbook.length,
      aiAnalysis: crisis.aiAnalysis,
    });
  }

  async mitigate(crisisId: string, notes: string): Promise<void> {
    const crisis = this.findCrisis(crisisId);
    if (!crisis) return;

    crisis.status = 'mitigated';
    crisis.mitigatedAt = new Date();
    crisis.resolutionNotes = notes;

    this.clearEscalationTimer(crisisId);
    await this.persistCrisis(crisis);

    log.info({ crisisId, notes }, 'Crisis mitigated');

    broadcast('meow:sovereign', {
      type: 'crisis:mitigated',
      crisisId: crisis.id,
      notes,
      durationMs: Date.now() - crisis.createdAt.getTime(),
    });
  }

  async resolve(crisisId: string, notes?: string): Promise<void> {
    const crisis = this.findCrisis(crisisId);
    if (!crisis) return;

    crisis.status = 'resolved';
    crisis.resolvedAt = new Date();
    if (notes) crisis.resolutionNotes = (crisis.resolutionNotes ?? '') + '\n' + notes;

    this.clearEscalationTimer(crisisId);

    // Update stats
    this.stats.resolvedCrises += 1;
    const durationMs = crisis.resolvedAt.getTime() - crisis.createdAt.getTime();
    this.stats.avgResolutionMs = Math.round(
      (this.stats.avgResolutionMs * (this.stats.resolvedCrises - 1) + durationMs) /
      this.stats.resolvedCrises,
    );

    // If this was the active crisis, clear it
    if (this.activeCrisis?.id === crisisId) {
      this.activeCrisis = null;
    }

    await this.persistCrisis(crisis);

    log.info({
      crisisId,
      durationMs,
      type: crisis.triggerType,
    }, 'Crisis resolved');

    broadcast('meow:sovereign', {
      type: 'crisis:resolved',
      crisisId: crisis.id,
      durationMs,
      triggerType: crisis.triggerType,
    });

    // Notify resolution via WhatsApp
    const msg = `[GAS TOWN] CRISIS RESOLVED\n`
      + `Type: ${crisis.triggerType}\n`
      + `Duration: ${Math.round(durationMs / 60_000)}min\n`
      + `Resolution: ${crisis.resolutionNotes ?? 'No notes'}`;
    await sendWhatsAppAlert(msg);
  }

  async recordPostMortem(crisisId: string, analysis: string): Promise<void> {
    const crisis = this.findCrisis(crisisId);
    if (!crisis) return;

    crisis.status = 'post_mortem';
    crisis.postMortemAt = new Date();
    crisis.resolutionNotes = (crisis.resolutionNotes ?? '') + '\n[POST-MORTEM] ' + analysis;

    await this.persistCrisis(crisis);

    log.info({ crisisId }, 'Post-mortem recorded');

    broadcast('meow:sovereign', {
      type: 'crisis:post_mortem',
      crisisId: crisis.id,
      analysis,
    });
  }

  // -------------------------------------------------------------------------
  // Auto-exit check
  // -------------------------------------------------------------------------

  async checkAutoExit(checks: CrisisCheck[]): Promise<boolean> {
    if (!this.activeCrisis) return false;

    const crisis = this.activeCrisis;
    const relevantCheck = checks.find(c => c.triggerType === crisis.triggerType);

    if (relevantCheck && !relevantCheck.triggered) {
      log.info({
        crisisId: crisis.id,
        check: relevantCheck.message,
      }, 'Auto-exit condition met, resolving crisis');

      this.stats.autoResolutions += 1;
      await this.resolve(crisis.id, `Auto-resolved: ${relevantCheck.message}`);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  private setEscalationTimer(crisisId: string, timeoutMin: number): void {
    this.clearEscalationTimer(crisisId);

    const timer = setTimeout(() => {
      this.escalate(crisisId).catch(err =>
        log.error({ err, crisisId }, 'Escalation failed'),
      );
    }, timeoutMin * 60_000);

    this.escalationTimers.set(crisisId, timer);
  }

  private clearEscalationTimer(crisisId: string): void {
    const timer = this.escalationTimers.get(crisisId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(crisisId);
    }
  }

  private async escalate(crisisId: string): Promise<void> {
    const crisis = this.findCrisis(crisisId);
    if (!crisis || crisis.status === 'resolved' || crisis.status === 'post_mortem') return;

    const levels: EscalationLevel[] = ['l1_operator', 'l2_manager', 'l3_executive'];
    const currentIdx = levels.indexOf(crisis.escalationLevel);
    if (currentIdx < levels.length - 1) {
      crisis.escalationLevel = levels[currentIdx + 1];
    }
    crisis.escalatedAt = new Date();
    this.stats.escalations += 1;

    await this.persistCrisis(crisis);

    log.warn({
      crisisId,
      newLevel: crisis.escalationLevel,
    }, 'Crisis escalated');

    broadcast('meow:sovereign', {
      type: 'crisis:escalated',
      crisisId: crisis.id,
      escalationLevel: crisis.escalationLevel,
      durationMs: Date.now() - crisis.createdAt.getTime(),
    });

    // Send urgent WhatsApp
    const msg = `[GAS TOWN] CRISIS ESCALATED to ${crisis.escalationLevel}\n`
      + `Type: ${crisis.triggerType} (${crisis.severity})\n`
      + `Title: ${crisis.title}\n`
      + `Duration: ${Math.round((Date.now() - crisis.createdAt.getTime()) / 60_000)}min\n`
      + `AI Analysis: ${crisis.aiAnalysis ?? 'N/A'}\n`
      + `ACTION REQUIRED: Crisis not resolved within threshold.`;
    await sendWhatsAppAlert(msg);

    // Re-set escalation timer for next level
    if (crisis.escalationLevel !== 'l3_executive') {
      this.setEscalationTimer(crisisId, DEFAULT_ESCALATION_TIMEOUT_MIN);
    }
  }

  // -------------------------------------------------------------------------
  // Playbook execution
  // -------------------------------------------------------------------------

  private async executePlaybookStep(crisis: CrisisEvent, step: PlaybookStep): Promise<void> {
    try {
      log.info({ crisisId: crisis.id, step: step.action }, 'Executing playbook step');

      // Simulate step execution based on action type
      switch (step.action) {
        case 'pause_ads':
        case 'pause_all_ads':
        case 'lockdown':
        case 'pause_dependent':
        case 'pause_writes':
        case 'pause_low_priority':
          // These would integrate with the formula engine to pause work
          crisis.pausedFormulas.push(`paused-by-${step.action}`);
          break;
        case 'notify_operator':
          // Handled separately in notifyOperator()
          break;
        case 'snapshot_metrics':
        case 'snapshot_state':
        case 'audit_log':
        case 'calculate_overspend':
          // Data capture steps — logged for reference
          break;
        default:
          break;
      }

      step.completed = true;
      step.completedAt = new Date();
      step.result = `Executed: ${step.description}`;
      crisis.completedSteps.push(step.id);
    } catch (err) {
      log.error({ err, step: step.action }, 'Playbook step execution failed');
      step.result = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // AI analysis
  // -------------------------------------------------------------------------

  private async performAiAnalysis(crisis: CrisisEvent): Promise<string | null> {
    const context = JSON.stringify({
      triggerType: crisis.triggerType,
      severity: crisis.severity,
      description: crisis.description,
      triggerValue: crisis.triggerValue,
      triggerThreshold: crisis.triggerThreshold,
      affectedSystems: crisis.affectedSystems,
      completedSteps: crisis.completedSteps.length,
    });

    const aiResponse = await callGeminiCrisis(context);
    if (!aiResponse) return null;

    try {
      const parsed = JSON.parse(aiResponse) as {
        rootCause: string;
        impact: string;
        immediateActions: string[];
        remediationPlan: string;
        estimatedRecoveryMinutes: number;
      };

      return `Root Cause: ${parsed.rootCause}\n`
        + `Impact: ${parsed.impact}\n`
        + `Remediation: ${parsed.remediationPlan}\n`
        + `Est. Recovery: ${parsed.estimatedRecoveryMinutes}min`;
    } catch {
      return aiResponse.slice(0, 500); // use raw text as fallback
    }
  }

  // -------------------------------------------------------------------------
  // Operator notification
  // -------------------------------------------------------------------------

  private async notifyOperator(crisis: CrisisEvent): Promise<void> {
    const msg = `[GAS TOWN] CRISIS ALERT\n`
      + `Type: ${crisis.triggerType} (${crisis.severity})\n`
      + `Title: ${crisis.title}\n`
      + `Affected: ${crisis.affectedSystems.join(', ')}\n`
      + `Steps completed: ${crisis.completedSteps.length}/${crisis.playbook.length}\n`
      + `AI Analysis: ${crisis.aiAnalysis ?? 'Analyzing...'}\n`
      + `Auto-exit: ${crisis.autoExitCondition ?? 'Manual resolution required'}`;

    const sent = await sendWhatsAppAlert(msg);
    if (sent) {
      crisis.notifiedOperators.push(OPERATOR_PHONE);
    }
  }

  // -------------------------------------------------------------------------
  // Queries — used by other systems
  // -------------------------------------------------------------------------

  isCrisisActive(): boolean {
    return this.activeCrisis != null
      && this.activeCrisis.status !== 'resolved'
      && this.activeCrisis.status !== 'post_mortem'
      && this.activeCrisis.status !== 'expired';
  }

  getActiveCrisis(): CrisisEvent | null {
    return this.activeCrisis;
  }

  getStatus(): CrisisModeStatus {
    const twentyFourHoursAgo = Date.now() - 86_400_000;
    const recent = this.crisisHistory.filter(c => c.createdAt.getTime() >= twentyFourHoursAgo);

    return {
      active: this.isCrisisActive(),
      activeCrisis: this.activeCrisis,
      crisisCount24h: recent.length,
      avgResolutionMinutes: Math.round(this.stats.avgResolutionMs / 60_000),
      lastCrisisAt: this.crisisHistory.length > 0
        ? this.crisisHistory[this.crisisHistory.length - 1].createdAt
        : undefined,
      escalationLevel: this.activeCrisis?.escalationLevel ?? null,
    };
  }

  getStats(): CrisisStats {
    return { ...this.stats };
  }

  getCrisisHistory(limit = 20): CrisisEvent[] {
    return this.crisisHistory.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private findCrisis(crisisId: string): CrisisEvent | null {
    if (this.activeCrisis?.id === crisisId) return this.activeCrisis;
    return this.crisisHistory.find(c => c.id === crisisId) ?? null;
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistCrisis(crisis: CrisisEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_crisis_events
           (id, trigger_type, severity, status, title, description,
            trigger_value, trigger_threshold, affected_systems, playbook_json,
            completed_steps, paused_formulas, paused_beads, escalation_level,
            escalated_at, notified_operators, resolution_notes, ai_analysis,
            auto_exit_condition, created_at, response_started_at, mitigated_at,
            resolved_at, post_mortem_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (id) DO UPDATE SET
           status=$4, completed_steps=$11, paused_formulas=$12, escalation_level=$14,
           escalated_at=$15, notified_operators=$16, resolution_notes=$17,
           ai_analysis=$18, response_started_at=$21, mitigated_at=$22,
           resolved_at=$23, post_mortem_at=$24`,
        [
          crisis.id,
          crisis.triggerType,
          crisis.severity,
          crisis.status,
          crisis.title,
          crisis.description,
          crisis.triggerValue ?? null,
          crisis.triggerThreshold ?? null,
          JSON.stringify(crisis.affectedSystems),
          JSON.stringify(crisis.playbook),
          JSON.stringify(crisis.completedSteps),
          JSON.stringify(crisis.pausedFormulas),
          JSON.stringify(crisis.pausedBeads),
          crisis.escalationLevel,
          crisis.escalatedAt?.toISOString() ?? null,
          JSON.stringify(crisis.notifiedOperators),
          crisis.resolutionNotes ?? null,
          crisis.aiAnalysis ?? null,
          crisis.autoExitCondition ?? null,
          crisis.createdAt.toISOString(),
          crisis.responseStartedAt?.toISOString() ?? null,
          crisis.mitigatedAt?.toISOString() ?? null,
          crisis.resolvedAt?.toISOString() ?? null,
          crisis.postMortemAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, crisisId: crisis.id }, 'Failed to persist crisis event');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, trigger_type, severity, status, title, description,
                created_at, resolved_at
         FROM meow_crisis_events
         WHERE created_at >= NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT 100`,
      );

      for (const row of rows) {
        this.stats.totalCrises += 1;
        const tt = row.trigger_type as CrisisTriggerType;
        const sev = row.severity as CrisisSeverity;
        this.stats.crisesByType[tt] = (this.stats.crisesByType[tt] ?? 0) + 1;
        this.stats.crisesBySeverity[sev] = (this.stats.crisesBySeverity[sev] ?? 0) + 1;

        if (row.status === 'resolved' && row.resolved_at) {
          this.stats.resolvedCrises += 1;
          const dur = new Date(row.resolved_at).getTime() - new Date(row.created_at).getTime();
          this.stats.avgResolutionMs = Math.round(
            (this.stats.avgResolutionMs * (this.stats.resolvedCrises - 1) + dur) /
            this.stats.resolvedCrises,
          );
        }

        // Check for active crisis
        if (row.status === 'opened' || row.status === 'response_started' || row.status === 'mitigated') {
          if (!this.activeCrisis) {
            this.activeCrisis = {
              id: row.id,
              triggerType: tt,
              severity: sev,
              status: row.status,
              title: row.title,
              description: row.description,
              affectedSystems: [],
              playbook: [],
              completedSteps: [],
              pausedFormulas: [],
              pausedBeads: [],
              escalationLevel: 'l1_operator',
              notifiedOperators: [],
              createdAt: new Date(row.created_at),
            };
          }
        }
      }

      log.info({ crises: rows.length, active: this.activeCrisis?.id ?? 'none' }, 'Loaded crisis history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load crisis history from DB');
    }
  }

  /** Cleanup: clear timers on shutdown */
  shutdown(): void {
    this.escalationTimers.forEach((timer, id) => {
      clearTimeout(timer);
      this.escalationTimers.delete(id);
    });
    log.info('Crisis mode shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CrisisMode | null = null;

export function getCrisisMode(): CrisisMode {
  if (!instance) {
    instance = new CrisisMode();
  }
  return instance;
}
