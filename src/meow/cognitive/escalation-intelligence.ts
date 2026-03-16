/**
 * ESCALATION INTELLIGENCE -- CG-027 (Stage 05 Wave 7)
 *
 * Intelligent escalation routing and management for Gas Town.
 * Routes issues through 4 escalation levels based on AI-powered triage,
 * learns from resolution patterns, detects escalation fatigue,
 * and manages time-based auto-escalation.
 *
 * Escalation levels:
 *   L1 — Auto-handle (retry, parameter mutation, known fix)
 *   L2 — Senior worker (higher-tier agent handles the issue)
 *   L3 — Human operator (dashboard notification, in-app alert)
 *   L4 — WhatsApp alert (critical, requires immediate attention)
 *
 * Features:
 *   - AI-powered triage to classify severity and route correctly
 *   - Skip-level escalation for critical issues (e.g., security → L4 immediately)
 *   - Resolution learning: track how issues are resolved and optimize routing
 *   - Escalation fatigue detection: redistribute when one person is overloaded
 *   - Time-based auto-escalation: if unresolved at level N, escalate to N+1
 *   - On-call schedule awareness: route to available operators
 *   - Integrates with witness-supervisor nudge chain
 *
 * Gas Town: "When the rig catches fire, don't whisper — sound the alarm."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('escalation-intelligence');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscalationLevel = 'L1' | 'L2' | 'L3' | 'L4';

export type EscalationSeverity = 'low' | 'medium' | 'high' | 'critical';

export type EscalationStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'expired';

export type EscalationCategory =
  | 'error'
  | 'performance'
  | 'budget'
  | 'security'
  | 'data_integrity'
  | 'availability'
  | 'quality'
  | 'timeout'
  | 'unknown';

export interface EscalationEvent {
  id: string;
  beadId?: string;
  moleculeId?: string;
  convoyId?: string;
  category: EscalationCategory;
  severity: EscalationSeverity;
  currentLevel: EscalationLevel;
  initialLevel: EscalationLevel;
  status: EscalationStatus;
  title: string;
  description: string;
  context: Record<string, unknown>;
  assignedTo?: string;                  // worker ID or operator ID
  escalationPath: EscalationStep[];
  aiTriageResult?: string;
  resolution?: EscalationResolution;
  timeoutMinutes: number;
  expiresAt: Date;
  createdAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
}

export interface EscalationStep {
  level: EscalationLevel;
  assignedTo?: string;
  reason: string;
  escalatedAt: Date;
  timeoutMinutes: number;
}

export interface EscalationResolution {
  resolvedBy: string;
  level: EscalationLevel;
  action: string;
  durationMs: number;
  couldHaveBeenLower: boolean;          // did it really need this level?
  notes?: string;
}

export interface OnCallEntry {
  operatorId: string;
  name: string;
  level: EscalationLevel;
  available: boolean;
  contactMethod: 'dashboard' | 'whatsapp' | 'email';
  contactTarget?: string;              // phone number or email
  activeEscalations: number;
  maxEscalations: number;
  shiftStart: string;                  // HH:MM UTC
  shiftEnd: string;                    // HH:MM UTC
}

export interface FatigueAnalysis {
  operatorId: string;
  name: string;
  escalationsLast24h: number;
  escalationsLast7d: number;
  avgResolutionTimeMs: number;
  isFatigued: boolean;
  fatigueScore: number;                // 0 - 100 (>70 = fatigued)
  recommendation: string;
}

export interface ResolutionPattern {
  category: EscalationCategory;
  resolvedAtLevel: EscalationLevel;
  count: number;
  avgResolutionMs: number;
  couldHaveBeenLower: number;          // count of over-escalated
  suggestedLevel: EscalationLevel;     // learned optimal level
}

export interface EscalationStats {
  totalEscalations: number;
  openCount: number;
  resolvedCount: number;
  avgResolutionMs: number;
  byLevel: Record<EscalationLevel, number>;
  byCategory: Record<EscalationCategory, number>;
  bySeverity: Record<EscalationSeverity, number>;
  escalationRate: number;              // escalations per hour (last 24h)
  autoHandleSuccessRate: number;       // L1 resolution rate
  avgEscalationsPerLevel: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVEL_ORDER: EscalationLevel[] = ['L1', 'L2', 'L3', 'L4'];

const DEFAULT_TIMEOUTS: Record<EscalationLevel, number> = {
  L1: 5,       // 5 minutes for auto-handle
  L2: 15,      // 15 minutes for senior worker
  L3: 30,      // 30 minutes for human operator
  L4: 60,      // 60 minutes for WhatsApp alert (if still unresolved, something is very wrong)
};

const FATIGUE_THRESHOLD_24H = 10;      // more than 10 escalations in 24h = fatigued
const FATIGUE_THRESHOLD_7D = 40;       // more than 40 in 7 days
const MAX_EVENTS_IN_MEMORY = 5_000;
const MAX_ON_CALL = 50;

/** Categories that skip directly to L4 */
const CRITICAL_CATEGORIES: Set<EscalationCategory> = new Set(['security', 'data_integrity']);

/** Severity → minimum escalation level mapping */
const SEVERITY_MINIMUM_LEVEL: Record<EscalationSeverity, EscalationLevel> = {
  low: 'L1',
  medium: 'L1',
  high: 'L2',
  critical: 'L3',
};

/** Category → severity heuristic patterns */
const CATEGORY_PATTERNS: Array<{ category: EscalationCategory; patterns: RegExp[] }> = [
  { category: 'security',        patterns: [/unauthorized/i, /forbidden/i, /injection/i, /breach/i, /leaked/i, /exposure/i, /token.*compromised/i] },
  { category: 'data_integrity',  patterns: [/corrupt/i, /data.*loss/i, /inconsisten/i, /duplicate/i, /orphan/i, /missing.*record/i] },
  { category: 'availability',    patterns: [/down/i, /unreachable/i, /503/i, /502/i, /health.*check.*fail/i, /connection.*refused/i] },
  { category: 'performance',     patterns: [/slow/i, /latency/i, /timeout/i, /bottleneck/i, /queue.*full/i, /memory.*high/i] },
  { category: 'budget',          patterns: [/budget/i, /cost.*exceed/i, /overspend/i, /brake.*active/i, /rate.*limit/i] },
  { category: 'quality',         patterns: [/quality.*low/i, /failed.*validation/i, /output.*invalid/i, /hallucin/i] },
  { category: 'timeout',         patterns: [/timeout/i, /stalled/i, /hung/i, /unresponsive/i, /zombie/i] },
  { category: 'error',           patterns: [/error/i, /exception/i, /crash/i, /fail/i, /panic/i] },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiTriage(context: string): Promise<string | null> {
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
                'You are an escalation triage engine for an AI agent orchestration platform. '
                + 'Analyze the issue and determine the correct escalation level and priority. '
                + 'Respond ONLY with valid JSON: {"level": "L1|L2|L3|L4", "severity": "low|medium|high|critical", '
                + '"category": "error|performance|budget|security|data_integrity|availability|quality|timeout|unknown", '
                + '"reasoning": "brief explanation", "suggestedAction": "what to do first"}',
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
    log.warn({ err }, 'Gemini triage call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// EscalationIntelligence
// ---------------------------------------------------------------------------

export class EscalationIntelligence {
  private events: EscalationEvent[] = [];
  private onCallSchedule: OnCallEntry[] = [];
  private resolutionPatterns = new Map<string, ResolutionPattern>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();

  // --- Create a new escalation -----------------------------------------------

  async createEscalation(
    title: string,
    description: string,
    context: Record<string, unknown>,
    beadId?: string,
    moleculeId?: string,
    convoyId?: string,
  ): Promise<EscalationEvent> {
    const startMs = Date.now();

    // Classify category and severity
    const issueText = `${title} ${description}`;
    const heuristicCategory = this.classifyCategory(issueText);
    const heuristicSeverity = this.classifySeverity(issueText, heuristicCategory, context);

    // Determine initial level
    let initialLevel = this.determineInitialLevel(heuristicCategory, heuristicSeverity);

    // AI-powered triage for better routing
    let aiTriageResult: string | undefined;
    let category = heuristicCategory;
    let severity = heuristicSeverity;

    const aiRaw = await callGeminiTriage(
      `Issue: ${title}\nDetails: ${description.slice(0, 500)}\nContext: ${JSON.stringify(context).slice(0, 500)}`,
    );

    if (aiRaw) {
      try {
        const match = aiRaw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            level?: string;
            severity?: string;
            category?: string;
            reasoning?: string;
            suggestedAction?: string;
          };

          if (parsed.level && LEVEL_ORDER.includes(parsed.level as EscalationLevel)) {
            initialLevel = parsed.level as EscalationLevel;
          }
          if (parsed.severity) severity = parsed.severity as EscalationSeverity;
          if (parsed.category) category = parsed.category as EscalationCategory;
          aiTriageResult = parsed.reasoning ?? 'AI triage completed';
        }
      } catch {
        // Use heuristic fallback
      }
    }

    // Apply learned patterns: if we know L2 always handles this category, start there
    const learnedLevel = this.getLearnedOptimalLevel(category);
    if (learnedLevel) {
      const learnedIdx = LEVEL_ORDER.indexOf(learnedLevel);
      const initialIdx = LEVEL_ORDER.indexOf(initialLevel);
      // Only upgrade level, never downgrade from AI/heuristic
      if (learnedIdx > initialIdx) {
        initialLevel = learnedLevel;
      }
    }

    // Skip-level for critical categories
    if (CRITICAL_CATEGORIES.has(category) && severity === 'critical') {
      initialLevel = 'L4';
    }

    // Find available assignee
    const assignedTo = this.findAvailableOperator(initialLevel);

    const timeoutMinutes = DEFAULT_TIMEOUTS[initialLevel];
    const now = new Date();

    const event: EscalationEvent = {
      id: uuidv4(),
      beadId,
      moleculeId,
      convoyId,
      category,
      severity,
      currentLevel: initialLevel,
      initialLevel,
      status: 'open',
      title,
      description: description.slice(0, 2000),
      context,
      assignedTo,
      escalationPath: [{
        level: initialLevel,
        assignedTo,
        reason: aiTriageResult ?? `Heuristic triage: ${category}/${severity}`,
        escalatedAt: now,
        timeoutMinutes,
      }],
      aiTriageResult,
      timeoutMinutes,
      expiresAt: new Date(now.getTime() + timeoutMinutes * 60_000),
      createdAt: now,
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS_IN_MEMORY) {
      this.events = this.events.slice(-MAX_EVENTS_IN_MEMORY);
    }

    // Persist
    await this.persistEvent(event);

    // Start auto-escalation timer
    this.startAutoEscalationTimer(event);

    // Broadcast
    broadcast('meow:cognitive', {
      type: 'escalation_created',
      escalation: {
        id: event.id,
        level: initialLevel,
        severity,
        category,
        title,
        assignedTo,
        beadId,
        moleculeId,
        timeMs: Date.now() - startMs,
      },
    });

    log.info({
      id: event.id,
      level: initialLevel,
      severity,
      category,
      assignedTo,
      beadId,
    }, `Escalation created: ${title}`);

    return event;
  }

  // --- Acknowledge an escalation ---------------------------------------------

  async acknowledge(eventId: string, operatorId: string): Promise<boolean> {
    const event = this.events.find(e => e.id === eventId);
    if (!event || event.status !== 'open') return false;

    event.status = 'acknowledged';
    event.acknowledgedAt = new Date();
    event.assignedTo = operatorId;

    // Reset the timer: give more time now that someone is looking
    this.clearAutoEscalationTimer(eventId);
    const extendedTimeout = event.timeoutMinutes * 2;
    event.expiresAt = new Date(Date.now() + extendedTimeout * 60_000);
    this.startAutoEscalationTimer(event);

    await this.updateEvent(event);

    broadcast('meow:cognitive', {
      type: 'escalation_acknowledged',
      escalation: { id: eventId, operatorId, level: event.currentLevel },
    });

    log.info({ eventId, operatorId, level: event.currentLevel }, 'Escalation acknowledged');
    return true;
  }

  // --- Resolve an escalation -------------------------------------------------

  async resolve(
    eventId: string,
    resolvedBy: string,
    action: string,
    couldHaveBeenLower: boolean,
    notes?: string,
  ): Promise<boolean> {
    const event = this.events.find(e => e.id === eventId);
    if (!event || event.status === 'resolved' || event.status === 'expired') return false;

    event.status = 'resolved';
    event.resolvedAt = new Date();
    event.resolution = {
      resolvedBy,
      level: event.currentLevel,
      action,
      durationMs: event.resolvedAt.getTime() - event.createdAt.getTime(),
      couldHaveBeenLower,
      notes,
    };

    this.clearAutoEscalationTimer(eventId);

    // Learn from resolution
    this.learnFromResolution(event);

    await this.updateEvent(event);

    broadcast('meow:cognitive', {
      type: 'escalation_resolved',
      escalation: {
        id: eventId,
        level: event.currentLevel,
        resolvedBy,
        durationMs: event.resolution.durationMs,
        couldHaveBeenLower,
      },
    });

    log.info({
      eventId,
      resolvedBy,
      level: event.currentLevel,
      durationMs: event.resolution.durationMs,
      couldHaveBeenLower,
    }, 'Escalation resolved');

    return true;
  }

  // --- Manual escalation -----------------------------------------------------

  async escalateManually(eventId: string, reason: string): Promise<boolean> {
    const event = this.events.find(e => e.id === eventId);
    if (!event || event.status === 'resolved' || event.status === 'expired') return false;

    return this.escalateToNextLevel(event, reason);
  }

  // --- On-call management ----------------------------------------------------

  registerOnCall(entry: OnCallEntry): void {
    const idx = this.onCallSchedule.findIndex(e => e.operatorId === entry.operatorId);
    if (idx >= 0) {
      this.onCallSchedule[idx] = entry;
    } else if (this.onCallSchedule.length < MAX_ON_CALL) {
      this.onCallSchedule.push(entry);
    }
    log.info({ operatorId: entry.operatorId, level: entry.level }, 'On-call registered');
  }

  removeOnCall(operatorId: string): void {
    this.onCallSchedule = this.onCallSchedule.filter(e => e.operatorId !== operatorId);
  }

  getOnCallSchedule(): OnCallEntry[] {
    return [...this.onCallSchedule];
  }

  // --- Fatigue analysis ------------------------------------------------------

  analyzeFatigue(): FatigueAnalysis[] {
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    const week = 7 * day;

    const analyses: FatigueAnalysis[] = [];

    for (const operator of this.onCallSchedule) {
      const assigned = this.events.filter(e => e.assignedTo === operator.operatorId);
      const last24h = assigned.filter(e => now - e.createdAt.getTime() < day).length;
      const last7d = assigned.filter(e => now - e.createdAt.getTime() < week).length;

      const resolved = assigned.filter(e => e.resolution);
      const avgResolutionMs = resolved.length > 0
        ? resolved.reduce((s, e) => s + (e.resolution!.durationMs), 0) / resolved.length
        : 0;

      // Compute fatigue score (0-100)
      let fatigueScore = 0;
      fatigueScore += Math.min(40, (last24h / FATIGUE_THRESHOLD_24H) * 40);
      fatigueScore += Math.min(30, (last7d / FATIGUE_THRESHOLD_7D) * 30);
      // Rising resolution time indicates fatigue
      if (avgResolutionMs > 30 * 60_000) fatigueScore += 15; // >30min avg
      if (avgResolutionMs > 60 * 60_000) fatigueScore += 15; // >60min avg

      const isFatigued = fatigueScore > 70;

      let recommendation = 'Normal workload';
      if (isFatigued) {
        recommendation = `Operator is fatigued (score: ${Math.round(fatigueScore)}). Redistribute escalations to other operators.`;
      } else if (fatigueScore > 50) {
        recommendation = `Approaching fatigue threshold (score: ${Math.round(fatigueScore)}). Monitor closely.`;
      }

      analyses.push({
        operatorId: operator.operatorId,
        name: operator.name,
        escalationsLast24h: last24h,
        escalationsLast7d: last7d,
        avgResolutionTimeMs: Math.round(avgResolutionMs),
        isFatigued,
        fatigueScore: Math.round(fatigueScore),
        recommendation,
      });
    }

    return analyses;
  }

  // --- Get resolution patterns -----------------------------------------------

  getResolutionPatterns(): ResolutionPattern[] {
    return Array.from(this.resolutionPatterns.values());
  }

  // --- Query events ----------------------------------------------------------

  getEvent(eventId: string): EscalationEvent | null {
    return this.events.find(e => e.id === eventId) ?? null;
  }

  getOpenEvents(): EscalationEvent[] {
    return this.events.filter(e => e.status === 'open' || e.status === 'acknowledged' || e.status === 'in_progress');
  }

  getEventsForBead(beadId: string): EscalationEvent[] {
    return this.events.filter(e => e.beadId === beadId);
  }

  getEventsForOperator(operatorId: string): EscalationEvent[] {
    return this.events.filter(e => e.assignedTo === operatorId && e.status !== 'resolved' && e.status !== 'expired');
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): EscalationStats {
    const total = this.events.length;
    if (total === 0) {
      return {
        totalEscalations: 0,
        openCount: 0,
        resolvedCount: 0,
        avgResolutionMs: 0,
        byLevel: { L1: 0, L2: 0, L3: 0, L4: 0 },
        byCategory: { error: 0, performance: 0, budget: 0, security: 0, data_integrity: 0, availability: 0, quality: 0, timeout: 0, unknown: 0 },
        bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
        escalationRate: 0,
        autoHandleSuccessRate: 0,
        avgEscalationsPerLevel: 0,
      };
    }

    const openCount = this.events.filter(e => e.status !== 'resolved' && e.status !== 'expired').length;
    const resolved = this.events.filter(e => e.status === 'resolved');
    const avgResolutionMs = resolved.length > 0
      ? resolved.reduce((s, e) => s + (e.resolution?.durationMs ?? 0), 0) / resolved.length
      : 0;

    const byLevel: Record<EscalationLevel, number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<EscalationSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };

    for (const event of this.events) {
      byLevel[event.currentLevel]++;
      byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
      bySeverity[event.severity]++;
    }

    // Escalation rate: per hour in last 24h
    const last24h = this.events.filter(e => Date.now() - e.createdAt.getTime() < 24 * 60 * 60_000).length;
    const escalationRate = Math.round((last24h / 24) * 10) / 10;

    // L1 auto-handle success rate
    const l1Events = this.events.filter(e => e.initialLevel === 'L1');
    const l1Resolved = l1Events.filter(e => e.status === 'resolved' && e.currentLevel === 'L1');
    const autoHandleRate = l1Events.length > 0 ? l1Resolved.length / l1Events.length : 0;

    // Average number of escalation steps
    const totalSteps = this.events.reduce((s, e) => s + e.escalationPath.length, 0);

    return {
      totalEscalations: total,
      openCount,
      resolvedCount: resolved.length,
      avgResolutionMs: Math.round(avgResolutionMs),
      byLevel,
      byCategory: byCategory as Record<EscalationCategory, number>,
      bySeverity,
      escalationRate,
      autoHandleSuccessRate: Math.round(autoHandleRate * 1000) / 1000,
      avgEscalationsPerLevel: total > 0 ? Math.round((totalSteps / total) * 10) / 10 : 0,
    };
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 7): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, bead_id, molecule_id, convoy_id, category, severity,
                current_level, initial_level, status, title, description,
                context, assigned_to, escalation_path, ai_triage_result,
                resolution, timeout_minutes, expires_at, created_at,
                acknowledged_at, resolved_at
         FROM meow_escalation_events
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, MAX_EVENTS_IN_MEMORY],
      );

      this.events = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        beadId: r.bead_id as string | undefined,
        moleculeId: r.molecule_id as string | undefined,
        convoyId: r.convoy_id as string | undefined,
        category: r.category as EscalationCategory,
        severity: r.severity as EscalationSeverity,
        currentLevel: r.current_level as EscalationLevel,
        initialLevel: r.initial_level as EscalationLevel,
        status: r.status as EscalationStatus,
        title: r.title as string,
        description: r.description as string,
        context: this.parseJsonSafe(r.context, {}),
        assignedTo: r.assigned_to as string | undefined,
        escalationPath: this.parseJsonSafe(r.escalation_path, []),
        aiTriageResult: r.ai_triage_result as string | undefined,
        resolution: this.parseJsonSafe(r.resolution, undefined),
        timeoutMinutes: parseInt(r.timeout_minutes as string) || 30,
        expiresAt: new Date(r.expires_at as string),
        createdAt: new Date(r.created_at as string),
        acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at as string) : undefined,
        resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : undefined,
      }));

      // Rebuild resolution patterns from resolved events
      for (const event of this.events) {
        if (event.resolution) {
          this.learnFromResolution(event);
        }
      }

      log.info({ count: this.events.length }, 'Loaded escalation events from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load escalation events from DB');
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
  // Private: Classification
  // ---------------------------------------------------------------------------

  private classifyCategory(text: string): EscalationCategory {
    for (const { category, patterns } of CATEGORY_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(text)) return category;
      }
    }
    return 'unknown';
  }

  private classifySeverity(
    text: string,
    category: EscalationCategory,
    context: Record<string, unknown>,
  ): EscalationSeverity {
    // Critical overrides
    if (CRITICAL_CATEGORIES.has(category)) return 'critical';
    if (/critical|emergency|urgent|disaster/i.test(text)) return 'critical';

    // High
    if (/high|severe|major|production.*down/i.test(text)) return 'high';
    if (category === 'availability') return 'high';

    // Cost-based
    if (context.costImpactUsd && Number(context.costImpactUsd) > 100) return 'high';
    if (context.costImpactUsd && Number(context.costImpactUsd) > 20) return 'medium';

    // Medium
    if (category === 'performance' || category === 'budget' || category === 'quality') return 'medium';

    return 'low';
  }

  private determineInitialLevel(category: EscalationCategory, severity: EscalationSeverity): EscalationLevel {
    // Skip-level for critical security/data issues
    if (CRITICAL_CATEGORIES.has(category) && severity === 'critical') return 'L4';

    // Use severity minimum
    return SEVERITY_MINIMUM_LEVEL[severity];
  }

  // ---------------------------------------------------------------------------
  // Private: Auto-escalation
  // ---------------------------------------------------------------------------

  private startAutoEscalationTimer(event: EscalationEvent): void {
    const timer = setTimeout(() => {
      this.autoEscalate(event.id);
    }, event.timeoutMinutes * 60_000);

    this.escalationTimers.set(event.id, timer);
  }

  private clearAutoEscalationTimer(eventId: string): void {
    const timer = this.escalationTimers.get(eventId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(eventId);
    }
  }

  private async autoEscalate(eventId: string): Promise<void> {
    const event = this.events.find(e => e.id === eventId);
    if (!event || event.status === 'resolved' || event.status === 'expired') return;

    const reason = `Auto-escalation: unresolved after ${event.timeoutMinutes} minutes at ${event.currentLevel}`;
    await this.escalateToNextLevel(event, reason);
  }

  private async escalateToNextLevel(event: EscalationEvent, reason: string): Promise<boolean> {
    const currentIdx = LEVEL_ORDER.indexOf(event.currentLevel);
    if (currentIdx >= LEVEL_ORDER.length - 1) {
      // Already at highest level, mark as expired if still unresolved
      if (event.status !== 'resolved') {
        event.status = 'expired';
        event.resolvedAt = new Date();
        await this.updateEvent(event);

        broadcast('meow:cognitive', {
          type: 'escalation_expired',
          escalation: { id: event.id, level: event.currentLevel, title: event.title },
        });

        log.warn({ eventId: event.id, level: event.currentLevel }, 'Escalation expired at highest level');
      }
      return false;
    }

    const nextLevel = LEVEL_ORDER[currentIdx + 1];
    const assignedTo = this.findAvailableOperator(nextLevel);
    const timeoutMinutes = DEFAULT_TIMEOUTS[nextLevel];

    event.currentLevel = nextLevel;
    event.assignedTo = assignedTo;
    event.timeoutMinutes = timeoutMinutes;
    event.expiresAt = new Date(Date.now() + timeoutMinutes * 60_000);
    event.escalationPath.push({
      level: nextLevel,
      assignedTo,
      reason,
      escalatedAt: new Date(),
      timeoutMinutes,
    });

    this.clearAutoEscalationTimer(event.id);
    this.startAutoEscalationTimer(event);

    await this.updateEvent(event);

    broadcast('meow:cognitive', {
      type: 'escalation_escalated',
      escalation: {
        id: event.id,
        fromLevel: LEVEL_ORDER[currentIdx],
        toLevel: nextLevel,
        reason,
        assignedTo,
        severity: event.severity,
        title: event.title,
      },
    });

    log.warn({
      eventId: event.id,
      from: LEVEL_ORDER[currentIdx],
      to: nextLevel,
      assignedTo,
      reason,
    }, `Escalation escalated from ${LEVEL_ORDER[currentIdx]} to ${nextLevel}`);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: Operator routing
  // ---------------------------------------------------------------------------

  private findAvailableOperator(level: EscalationLevel): string | undefined {
    const now = new Date();
    const currentHour = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

    // Filter by level and availability
    const candidates = this.onCallSchedule.filter(op => {
      if (!op.available) return false;
      if (op.level !== level && LEVEL_ORDER.indexOf(op.level) < LEVEL_ORDER.indexOf(level)) return false;
      if (op.activeEscalations >= op.maxEscalations) return false;

      // Check shift hours
      if (op.shiftStart <= op.shiftEnd) {
        if (currentHour < op.shiftStart || currentHour > op.shiftEnd) return false;
      } else {
        // Overnight shift (e.g., 22:00 - 06:00)
        if (currentHour < op.shiftStart && currentHour > op.shiftEnd) return false;
      }

      return true;
    });

    if (candidates.length === 0) return undefined;

    // Check fatigue: prefer operators with fewer recent escalations
    const fatigueAnalysis = this.analyzeFatigue();
    const nonFatigued = candidates.filter(c => {
      const analysis = fatigueAnalysis.find(f => f.operatorId === c.operatorId);
      return !analysis?.isFatigued;
    });

    const pool = nonFatigued.length > 0 ? nonFatigued : candidates;

    // Route to operator with fewest active escalations
    pool.sort((a, b) => a.activeEscalations - b.activeEscalations);

    const selected = pool[0];
    if (selected) {
      selected.activeEscalations++;
      return selected.operatorId;
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Private: Learning from resolutions
  // ---------------------------------------------------------------------------

  private learnFromResolution(event: EscalationEvent): void {
    if (!event.resolution) return;

    const key = event.category;
    const existing = this.resolutionPatterns.get(key) ?? {
      category: event.category,
      resolvedAtLevel: event.resolution.level,
      count: 0,
      avgResolutionMs: 0,
      couldHaveBeenLower: 0,
      suggestedLevel: event.resolution.level,
    };

    existing.count++;
    existing.avgResolutionMs = existing.avgResolutionMs + (event.resolution.durationMs - existing.avgResolutionMs) / existing.count;

    if (event.resolution.couldHaveBeenLower) {
      existing.couldHaveBeenLower++;
    }

    // Update suggested level based on resolution patterns
    // If >50% of resolutions at this level could have been lower, suggest lower
    if (existing.couldHaveBeenLower / existing.count > 0.5 && existing.count >= 5) {
      const currentIdx = LEVEL_ORDER.indexOf(existing.resolvedAtLevel);
      if (currentIdx > 0) {
        existing.suggestedLevel = LEVEL_ORDER[currentIdx - 1];
      }
    }

    // Track most common resolution level
    existing.resolvedAtLevel = event.resolution.level;

    this.resolutionPatterns.set(key, existing);
  }

  private getLearnedOptimalLevel(category: EscalationCategory): EscalationLevel | null {
    const pattern = this.resolutionPatterns.get(category);
    if (!pattern || pattern.count < 5) return null;
    return pattern.suggestedLevel;
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistEvent(event: EscalationEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_escalation_events
          (id, bead_id, molecule_id, convoy_id, category, severity,
           current_level, initial_level, status, title, description,
           context, assigned_to, escalation_path, ai_triage_result,
           resolution, timeout_minutes, expires_at, created_at,
           acknowledged_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.beadId ?? null,
          event.moleculeId ?? null,
          event.convoyId ?? null,
          event.category,
          event.severity,
          event.currentLevel,
          event.initialLevel,
          event.status,
          event.title,
          event.description,
          JSON.stringify(event.context),
          event.assignedTo ?? null,
          JSON.stringify(event.escalationPath),
          event.aiTriageResult ?? null,
          event.resolution ? JSON.stringify(event.resolution) : null,
          event.timeoutMinutes,
          event.expiresAt.toISOString(),
          event.createdAt.toISOString(),
          event.acknowledgedAt?.toISOString() ?? null,
          event.resolvedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to persist escalation event');
    }
  }

  private async updateEvent(event: EscalationEvent): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_escalation_events
         SET current_level = $1, status = $2, assigned_to = $3,
             escalation_path = $4, resolution = $5, timeout_minutes = $6,
             expires_at = $7, acknowledged_at = $8, resolved_at = $9
         WHERE id = $10`,
        [
          event.currentLevel,
          event.status,
          event.assignedTo ?? null,
          JSON.stringify(event.escalationPath),
          event.resolution ? JSON.stringify(event.resolution) : null,
          event.timeoutMinutes,
          event.expiresAt.toISOString(),
          event.acknowledgedAt?.toISOString() ?? null,
          event.resolvedAt?.toISOString() ?? null,
          event.id,
        ],
      );
    } catch (err) {
      log.error({ err, eventId: event.id }, 'Failed to update escalation event');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback as T;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback as T; }
    }
    return raw as T;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: EscalationIntelligence | null = null;

export function getEscalationIntelligence(): EscalationIntelligence {
  if (!instance) {
    instance = new EscalationIntelligence();
  }
  return instance;
}
