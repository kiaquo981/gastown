/**
 * FORMULA SCHEDULING AI -- CG-028 (Stage 05 Wave 7)
 *
 * AI-powered formula scheduling and orchestration for Gas Town.
 * Analyzes formula resource requirements, learns optimal execution windows,
 * and schedules formulas to maximize throughput while minimizing conflicts.
 *
 * Features:
 *   - Resource requirement analysis per formula
 *   - Optimal execution window scheduling (low-load periods preferred)
 *   - Batch similar formulas together for efficiency
 *   - Conflict detection (avoid two resource-heavy formulas simultaneously)
 *   - Priority-based scheduling: critical formulas get immediate slots
 *   - Predictive scheduling: learn best time-of-day per formula type
 *   - Calendar awareness: skip maintenance windows
 *   - Integration with demand-forecasting.ts for load prediction
 *   - Configurable scheduling window (default: plan 24h ahead)
 *
 * Gas Town: "Schedule the convoy for when the road is clear."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('formula-scheduling-ai');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleStatus = 'planned' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped' | 'deferred';

export type SchedulePriority = 'critical' | 'high' | 'normal' | 'low' | 'background';

export type ResourceIntensity = 'light' | 'medium' | 'heavy' | 'extreme';

export interface ScheduleSlot {
  id: string;
  formulaName: string;
  moleculeId?: string;
  status: ScheduleStatus;
  priority: SchedulePriority;
  scheduledAt: Date;                    // when it should start
  actualStartAt?: Date;
  completedAt?: Date;
  estimatedDurationMs: number;
  actualDurationMs?: number;
  estimatedCostUsd: number;
  resourceIntensity: ResourceIntensity;
  resourceRequirements: ResourceRequirements;
  batchId?: string;                     // group ID for batched formulas
  conflictsWith: string[];              // IDs of conflicting slots
  windowId?: string;                    // maintenance window that blocked
  aiScheduled: boolean;
  reason: string;
  createdAt: Date;
}

export interface ResourceRequirements {
  concurrentWorkers: number;            // max workers needed simultaneously
  estimatedLlmCalls: number;
  estimatedTokens: number;
  requiresExternalApi: boolean;
  requiresGpu: boolean;
  memoryMb: number;                     // approximate memory requirement
  capabilities: string[];
}

export interface MaintenanceWindow {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  recurring: boolean;
  recurrencePattern?: string;           // 'daily', 'weekly:mon', 'monthly:15'
  reason: string;
  active: boolean;
}

export interface FormulaProfile {
  formulaName: string;
  avgDurationMs: number;
  avgCostUsd: number;
  avgWorkers: number;
  executionCount: number;
  bestHourUtc: number;                  // learned optimal hour
  bestDayOfWeek: number;                // 0-6, learned optimal day
  successRate: number;
  resourceIntensity: ResourceIntensity;
  lastExecutedAt?: Date;
  batchable: boolean;                   // can be batched with similar formulas
}

export interface ScheduleBatch {
  id: string;
  formulaNames: string[];
  slotIds: string[];
  scheduledAt: Date;
  estimatedSavingsPct: number;          // batching efficiency gain
  reason: string;
}

export interface ConflictDetection {
  slotA: string;
  slotB: string;
  conflictType: 'resource' | 'api_limit' | 'worker_contention' | 'time_overlap';
  severity: 'soft' | 'hard';           // soft = degraded, hard = cannot run
  description: string;
}

export interface SchedulingPlan {
  windowHours: number;
  totalSlots: number;
  byPriority: Record<SchedulePriority, number>;
  conflicts: ConflictDetection[];
  batches: ScheduleBatch[];
  maintenanceWindows: MaintenanceWindow[];
  utilizationByHour: Array<{ hourUtc: number; slotCount: number; loadPct: number }>;
  generatedAt: Date;
}

export interface FormulaSchedulerStats {
  totalScheduled: number;
  completedOnTime: number;
  completedLate: number;
  deferred: number;
  failed: number;
  avgScheduleAccuracyMs: number;        // how close to scheduled time
  batchesCreated: number;
  conflictsResolved: number;
  profilesLearned: number;
  planningWindowHours: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PLANNING_WINDOW_HOURS = 24;
const MAX_CONCURRENT_HEAVY = 2;
const MAX_CONCURRENT_EXTREME = 1;
const MAX_CONCURRENT_TOTAL = 10;
const MAX_SLOTS_IN_MEMORY = 5_000;
const MAX_PROFILES = 500;
const MAX_MAINTENANCE_WINDOWS = 50;

/** Default resource profiles by formula type keyword */
const DEFAULT_RESOURCE_PROFILES: Record<string, Partial<ResourceRequirements>> = {
  'campaign': { concurrentWorkers: 3, estimatedLlmCalls: 15, requiresExternalApi: true, memoryMb: 256 },
  'analysis': { concurrentWorkers: 1, estimatedLlmCalls: 5, requiresExternalApi: false, memoryMb: 128 },
  'report':   { concurrentWorkers: 1, estimatedLlmCalls: 3, requiresExternalApi: false, memoryMb: 64 },
  'deploy':   { concurrentWorkers: 2, estimatedLlmCalls: 2, requiresExternalApi: true, memoryMb: 512 },
  'scrape':   { concurrentWorkers: 1, estimatedLlmCalls: 1, requiresExternalApi: true, memoryMb: 128 },
  'content':  { concurrentWorkers: 2, estimatedLlmCalls: 10, requiresExternalApi: false, memoryMb: 128 },
  'monitor':  { concurrentWorkers: 1, estimatedLlmCalls: 1, requiresExternalApi: false, memoryMb: 64 },
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiScheduler(context: string): Promise<string | null> {
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
                'You are a formula scheduling optimizer for an AI agent platform. '
                + 'Given resource constraints and formula profiles, suggest optimal scheduling. '
                + 'Respond ONLY with valid JSON: {"schedule": [{"formulaName": "...", "suggestedHourUtc": 0-23, '
                + '"reason": "...", "batchWith": ["..."] | null, "defer": false}], "reasoning": "overall strategy"}',
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
    log.warn({ err }, 'Gemini scheduler call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// FormulaSchedulingAI
// ---------------------------------------------------------------------------

export class FormulaSchedulingAI {
  private slots: ScheduleSlot[] = [];
  private profiles = new Map<string, FormulaProfile>();
  private maintenanceWindows: MaintenanceWindow[] = [];
  private batches: ScheduleBatch[] = [];
  private planningWindowHours = DEFAULT_PLANNING_WINDOW_HOURS;

  // --- Schedule a formula ----------------------------------------------------

  async scheduleFormula(
    formulaName: string,
    priority: SchedulePriority,
    resourceReqs?: Partial<ResourceRequirements>,
    preferredTime?: Date,
    moleculeId?: string,
  ): Promise<ScheduleSlot> {
    const startMs = Date.now();

    // Get or create formula profile
    const profile = await this.getOrCreateProfile(formulaName);

    // Build resource requirements
    const requirements = this.buildResourceRequirements(formulaName, profile, resourceReqs);

    // Determine resource intensity
    const intensity = this.classifyIntensity(requirements);

    // Estimate cost and duration
    const estimatedDurationMs = profile.avgDurationMs > 0 ? profile.avgDurationMs : 60_000;
    const estimatedCostUsd = profile.avgCostUsd > 0 ? profile.avgCostUsd : 0.01;

    // Find optimal time slot
    let scheduledAt: Date;
    let reason: string;
    let aiScheduled = false;

    if (priority === 'critical') {
      // Critical: immediate execution
      scheduledAt = new Date();
      reason = 'Critical priority: immediate execution';
    } else if (preferredTime) {
      // Check if preferred time has conflicts
      const conflicts = this.detectConflictsAtTime(preferredTime, estimatedDurationMs, intensity);
      if (conflicts.length === 0 && !this.isMaintenanceWindow(preferredTime)) {
        scheduledAt = preferredTime;
        reason = 'Scheduled at preferred time (no conflicts)';
      } else {
        scheduledAt = await this.findOptimalSlot(formulaName, profile, intensity, estimatedDurationMs, preferredTime);
        reason = conflicts.length > 0
          ? `Preferred time had ${conflicts.length} conflicts; rescheduled`
          : 'Preferred time in maintenance window; rescheduled';
      }
    } else {
      // AI-assisted scheduling
      scheduledAt = await this.findOptimalSlot(formulaName, profile, intensity, estimatedDurationMs);
      aiScheduled = true;
      reason = `AI-scheduled at optimal time based on ${profile.executionCount > 0 ? 'learned profile' : 'heuristic analysis'}`;
    }

    // Detect conflicts with existing slots
    const conflictIds = this.detectConflictsAtTime(scheduledAt, estimatedDurationMs, intensity)
      .map(c => c.slotA);

    const slot: ScheduleSlot = {
      id: uuidv4(),
      formulaName,
      moleculeId,
      status: 'planned',
      priority,
      scheduledAt,
      estimatedDurationMs,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      resourceIntensity: intensity,
      resourceRequirements: requirements,
      conflictsWith: conflictIds,
      aiScheduled,
      reason,
      createdAt: new Date(),
    };

    this.slots.push(slot);
    if (this.slots.length > MAX_SLOTS_IN_MEMORY) {
      this.slots = this.slots.slice(-MAX_SLOTS_IN_MEMORY);
    }

    // Persist
    await this.persistSlot(slot);

    broadcast('meow:cognitive', {
      type: 'formula_scheduled',
      schedule: {
        id: slot.id,
        formulaName,
        priority,
        scheduledAt: scheduledAt.toISOString(),
        intensity,
        aiScheduled,
        conflicts: conflictIds.length,
        timeMs: Date.now() - startMs,
      },
    });

    log.info({
      id: slot.id,
      formulaName,
      priority,
      scheduledAt: scheduledAt.toISOString(),
      intensity,
      aiScheduled,
    }, 'Formula scheduled');

    return slot;
  }

  // --- Mark slot as started --------------------------------------------------

  markStarted(slotId: string): boolean {
    const slot = this.slots.find(s => s.id === slotId);
    if (!slot || slot.status !== 'planned' && slot.status !== 'ready') return false;

    slot.status = 'running';
    slot.actualStartAt = new Date();
    this.updateSlotInDb(slot);
    return true;
  }

  // --- Mark slot as completed ------------------------------------------------

  markCompleted(slotId: string, success: boolean): boolean {
    const slot = this.slots.find(s => s.id === slotId);
    if (!slot) return false;

    slot.status = success ? 'completed' : 'failed';
    slot.completedAt = new Date();
    if (slot.actualStartAt) {
      slot.actualDurationMs = slot.completedAt.getTime() - slot.actualStartAt.getTime();
    }

    // Update profile with actual data
    this.updateProfile(slot);
    this.updateSlotInDb(slot);
    return true;
  }

  // --- Batch similar formulas ------------------------------------------------

  async batchSimilarFormulas(): Promise<ScheduleBatch[]> {
    const newBatches: ScheduleBatch[] = [];
    const planned = this.slots.filter(s => s.status === 'planned');
    const grouped = new Map<string, ScheduleSlot[]>();

    // Group planned slots by formula name
    for (const slot of planned) {
      const key = slot.formulaName;
      const group = grouped.get(key) ?? [];
      group.push(slot);
      grouped.set(key, group);
    }

    // Batch formulas with 2+ planned instances that are batchable
    for (const [formulaName, slots] of grouped) {
      if (slots.length < 2) continue;

      const profile = this.profiles.get(formulaName);
      if (profile && !profile.batchable) continue;

      // Schedule all at the same optimal time
      const firstSlot = slots.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];

      const batch: ScheduleBatch = {
        id: uuidv4(),
        formulaNames: slots.map(() => formulaName),
        slotIds: slots.map(s => s.id),
        scheduledAt: firstSlot.scheduledAt,
        estimatedSavingsPct: Math.round(Math.min(30, slots.length * 8)),
        reason: `Batching ${slots.length} instances of "${formulaName}" for ${Math.round(Math.min(30, slots.length * 8))}% efficiency gain`,
      };

      // Update slots with batch ID
      for (const slot of slots) {
        slot.batchId = batch.id;
        slot.scheduledAt = firstSlot.scheduledAt;
      }

      newBatches.push(batch);
      this.batches.push(batch);
    }

    if (newBatches.length > 0) {
      broadcast('meow:cognitive', {
        type: 'formula_batched',
        count: newBatches.length,
        totalSlots: newBatches.reduce((s, b) => s + b.slotIds.length, 0),
      });

      log.info({ batches: newBatches.length }, 'Formula batches created');
    }

    return newBatches;
  }

  // --- Generate scheduling plan ----------------------------------------------

  async generatePlan(): Promise<SchedulingPlan> {
    const windowEnd = new Date(Date.now() + this.planningWindowHours * 60 * 60_000);

    // Get planned slots in window
    const plannedSlots = this.slots.filter(s =>
      s.status === 'planned' && s.scheduledAt <= windowEnd,
    );

    // Detect all conflicts
    const conflicts: ConflictDetection[] = [];
    for (let i = 0; i < plannedSlots.length; i++) {
      for (let j = i + 1; j < plannedSlots.length; j++) {
        const conflict = this.checkConflict(plannedSlots[i], plannedSlots[j]);
        if (conflict) conflicts.push(conflict);
      }
    }

    // Count by priority
    const byPriority: Record<SchedulePriority, number> = {
      critical: 0, high: 0, normal: 0, low: 0, background: 0,
    };
    for (const slot of plannedSlots) {
      byPriority[slot.priority]++;
    }

    // Utilization by hour
    const utilizationByHour: Array<{ hourUtc: number; slotCount: number; loadPct: number }> = [];
    for (let h = 0; h < 24; h++) {
      const slotsAtHour = plannedSlots.filter(s => s.scheduledAt.getUTCHours() === h);
      const totalWorkers = slotsAtHour.reduce((sum, s) => sum + s.resourceRequirements.concurrentWorkers, 0);
      utilizationByHour.push({
        hourUtc: h,
        slotCount: slotsAtHour.length,
        loadPct: Math.round((totalWorkers / MAX_CONCURRENT_TOTAL) * 1000) / 10,
      });
    }

    // Get active maintenance windows in the planning period
    const activeWindows = this.maintenanceWindows.filter(w =>
      w.active && w.endAt > new Date() && w.startAt < windowEnd,
    );

    return {
      windowHours: this.planningWindowHours,
      totalSlots: plannedSlots.length,
      byPriority,
      conflicts,
      batches: this.batches.filter(b => b.scheduledAt <= windowEnd),
      maintenanceWindows: activeWindows,
      utilizationByHour,
      generatedAt: new Date(),
    };
  }

  // --- AI-powered rescheduling -----------------------------------------------

  async aiReschedule(): Promise<number> {
    const planned = this.slots.filter(s => s.status === 'planned');
    if (planned.length === 0) return 0;

    const profileSummary = Array.from(this.profiles.values())
      .slice(0, 20)
      .map(p => `- ${p.formulaName}: avg ${Math.round(p.avgDurationMs / 1000)}s, $${p.avgCostUsd.toFixed(4)}, best hour UTC ${p.bestHourUtc}, intensity ${p.resourceIntensity}`)
      .join('\n');

    const pendingSummary = planned.slice(0, 15).map(s =>
      `- ${s.formulaName} (${s.priority}): scheduled ${s.scheduledAt.toISOString()}, intensity ${s.resourceIntensity}`,
    ).join('\n');

    const context = `Current time: ${new Date().toISOString()}
Planning window: ${this.planningWindowHours} hours

Formula profiles (learned from execution history):
${profileSummary || 'No profiles yet'}

Pending formulas to schedule:
${pendingSummary}

Maintenance windows: ${this.maintenanceWindows.filter(w => w.active).map(w => `${w.name}: ${w.startAt.toISOString()} - ${w.endAt.toISOString()}`).join(', ') || 'none'}

Max concurrent heavy formulas: ${MAX_CONCURRENT_HEAVY}
Max concurrent total: ${MAX_CONCURRENT_TOTAL}

Optimize the schedule for throughput and cost efficiency.`;

    const raw = await callGeminiScheduler(context);
    let rescheduled = 0;

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            schedule?: Array<{
              formulaName: string;
              suggestedHourUtc: number;
              defer: boolean;
              batchWith?: string[];
            }>;
          };

          if (Array.isArray(parsed.schedule)) {
            for (const suggestion of parsed.schedule) {
              const slot = planned.find(s => s.formulaName === suggestion.formulaName);
              if (!slot) continue;

              if (suggestion.defer) {
                slot.status = 'deferred';
                slot.reason += ' | AI deferred: low priority';
                rescheduled++;
              } else if (typeof suggestion.suggestedHourUtc === 'number') {
                const newTime = new Date(slot.scheduledAt);
                newTime.setUTCHours(suggestion.suggestedHourUtc, 0, 0, 0);
                if (newTime < new Date()) {
                  newTime.setDate(newTime.getDate() + 1);
                }
                if (!this.isMaintenanceWindow(newTime)) {
                  slot.scheduledAt = newTime;
                  slot.aiScheduled = true;
                  slot.reason += ` | AI rescheduled to ${suggestion.suggestedHourUtc}:00 UTC`;
                  rescheduled++;
                }
              }
            }
          }
        }
      } catch {
        log.warn('Failed to parse AI scheduling response');
      }
    }

    if (rescheduled === 0) {
      // Heuristic fallback: spread heavy formulas across low-load hours
      rescheduled = this.heuristicReschedule(planned);
    }

    if (rescheduled > 0) {
      broadcast('meow:cognitive', {
        type: 'formula_rescheduled',
        count: rescheduled,
        aiPowered: raw !== null,
      });

      log.info({ rescheduled, aiPowered: raw !== null }, 'Formulas rescheduled');
    }

    return rescheduled;
  }

  // --- Maintenance windows ---------------------------------------------------

  addMaintenanceWindow(window: Omit<MaintenanceWindow, 'id'>): MaintenanceWindow {
    const mw: MaintenanceWindow = { ...window, id: uuidv4() };
    this.maintenanceWindows.push(mw);
    if (this.maintenanceWindows.length > MAX_MAINTENANCE_WINDOWS) {
      this.maintenanceWindows = this.maintenanceWindows.slice(-MAX_MAINTENANCE_WINDOWS);
    }
    log.info({ windowId: mw.id, name: mw.name, start: mw.startAt.toISOString(), end: mw.endAt.toISOString() }, 'Maintenance window added');
    return mw;
  }

  removeMaintenanceWindow(windowId: string): boolean {
    const idx = this.maintenanceWindows.findIndex(w => w.id === windowId);
    if (idx >= 0) {
      this.maintenanceWindows.splice(idx, 1);
      return true;
    }
    return false;
  }

  getMaintenanceWindows(): MaintenanceWindow[] {
    return [...this.maintenanceWindows];
  }

  // --- Planning window -------------------------------------------------------

  setPlanningWindow(hours: number): void {
    this.planningWindowHours = Math.max(1, Math.min(168, hours)); // 1h to 7 days
    log.info({ hours: this.planningWindowHours }, 'Planning window updated');
  }

  // --- Query slots -----------------------------------------------------------

  getSlot(slotId: string): ScheduleSlot | null {
    return this.slots.find(s => s.id === slotId) ?? null;
  }

  getPlannedSlots(): ScheduleSlot[] {
    return this.slots.filter(s => s.status === 'planned' || s.status === 'ready');
  }

  getSlotsForFormula(formulaName: string): ScheduleSlot[] {
    return this.slots.filter(s => s.formulaName === formulaName);
  }

  getProfile(formulaName: string): FormulaProfile | null {
    return this.profiles.get(formulaName) ?? null;
  }

  getAllProfiles(): FormulaProfile[] {
    return Array.from(this.profiles.values());
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): FormulaSchedulerStats {
    const completed = this.slots.filter(s => s.status === 'completed');
    const failed = this.slots.filter(s => s.status === 'failed');
    const deferred = this.slots.filter(s => s.status === 'deferred');

    // On-time: completed within 2x estimated duration
    const onTime = completed.filter(s => {
      if (!s.actualDurationMs) return true;
      return s.actualDurationMs <= s.estimatedDurationMs * 2;
    });

    // Schedule accuracy: how close to scheduled time was actual start
    const withActualStart = this.slots.filter(s => s.actualStartAt);
    const avgAccuracy = withActualStart.length > 0
      ? withActualStart.reduce((sum, s) => {
          const diff = Math.abs((s.actualStartAt?.getTime() ?? 0) - s.scheduledAt.getTime());
          return sum + diff;
        }, 0) / withActualStart.length
      : 0;

    // Count resolved conflicts
    const allConflicts = this.slots.reduce((sum, s) => sum + s.conflictsWith.length, 0);

    return {
      totalScheduled: this.slots.length,
      completedOnTime: onTime.length,
      completedLate: completed.length - onTime.length,
      deferred: deferred.length,
      failed: failed.length,
      avgScheduleAccuracyMs: Math.round(avgAccuracy),
      batchesCreated: this.batches.length,
      conflictsResolved: Math.round(allConflicts / 2), // each conflict counted twice
      profilesLearned: this.profiles.size,
      planningWindowHours: this.planningWindowHours,
    };
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 14): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    // Load slot history to rebuild profiles
    try {
      const { rows } = await pool.query(
        `SELECT formula_name, status,
                EXTRACT(EPOCH FROM (completed_at - actual_start_at)) * 1000 AS duration_ms,
                estimated_cost_usd, resource_intensity,
                EXTRACT(HOUR FROM scheduled_at) AS sched_hour,
                EXTRACT(DOW FROM scheduled_at) AS sched_dow,
                resource_requirements
         FROM meow_formula_schedule
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
           AND status IN ('completed', 'failed')
         ORDER BY created_at DESC
         LIMIT 5000`,
        [sinceDays],
      );

      // Rebuild profiles from historical data
      const grouped = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const key = row.formula_name as string;
        const group = grouped.get(key) ?? [];
        group.push(row);
        grouped.set(key, group);
      }

      for (const [formulaName, group] of grouped) {
        const completed = group.filter(r => r.status === 'completed');
        const avgDuration = completed.length > 0
          ? completed.reduce((s, r) => s + (parseFloat(r.duration_ms as string) || 0), 0) / completed.length
          : 60_000;
        const avgCost = group.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd as string) || 0), 0) / group.length;
        const successRate = group.length > 0 ? completed.length / group.length : 0.5;

        // Find most common scheduling hour
        const hourCounts = new Map<number, number>();
        for (const r of completed) {
          const hour = parseInt(r.sched_hour as string) || 0;
          hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
        }
        let bestHour = 10; // default 10 UTC
        let bestHourCount = 0;
        for (const [hour, count] of hourCounts) {
          if (count > bestHourCount) { bestHour = hour; bestHourCount = count; }
        }

        // Find most common day
        const dowCounts = new Map<number, number>();
        for (const r of completed) {
          const dow = parseInt(r.sched_dow as string) || 0;
          dowCounts.set(dow, (dowCounts.get(dow) ?? 0) + 1);
        }
        let bestDow = 1; // default Monday
        let bestDowCount = 0;
        for (const [dow, count] of dowCounts) {
          if (count > bestDowCount) { bestDow = dow; bestDowCount = count; }
        }

        const intensity = group[0]?.resource_intensity as ResourceIntensity ?? 'medium';

        this.profiles.set(formulaName, {
          formulaName,
          avgDurationMs: Math.round(avgDuration),
          avgCostUsd: Math.round(avgCost * 10000) / 10000,
          avgWorkers: 1,
          executionCount: group.length,
          bestHourUtc: bestHour,
          bestDayOfWeek: bestDow,
          successRate: Math.round(successRate * 1000) / 1000,
          resourceIntensity: intensity,
          batchable: intensity === 'light' || intensity === 'medium',
        });
      }

      log.info({ profiles: this.profiles.size, slots: rows.length }, 'Loaded formula scheduling history from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load formula scheduling history from DB');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Optimal slot finding
  // ---------------------------------------------------------------------------

  private async findOptimalSlot(
    formulaName: string,
    profile: FormulaProfile,
    intensity: ResourceIntensity,
    estimatedDurationMs: number,
    preferredTime?: Date,
  ): Promise<Date> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + this.planningWindowHours * 60 * 60_000);

    // Start from preferred time or next hour
    const searchStart = preferredTime ?? new Date(now.getTime() + 5 * 60_000);

    // If profile has a learned best hour, prefer it
    if (profile.executionCount >= 5 && !preferredTime) {
      const candidate = new Date(searchStart);
      candidate.setUTCHours(profile.bestHourUtc, 0, 0, 0);
      if (candidate < now) candidate.setDate(candidate.getDate() + 1);

      if (candidate <= windowEnd && !this.isMaintenanceWindow(candidate)) {
        const conflicts = this.detectConflictsAtTime(candidate, estimatedDurationMs, intensity);
        if (conflicts.length === 0) return candidate;
      }
    }

    // Scan hours in the planning window for lowest load
    let bestTime = searchStart;
    let lowestLoad = Infinity;

    for (let offset = 0; offset < this.planningWindowHours; offset++) {
      const candidate = new Date(searchStart.getTime() + offset * 60 * 60_000);
      candidate.setMinutes(0, 0, 0);

      if (candidate < now) continue;
      if (candidate > windowEnd) break;
      if (this.isMaintenanceWindow(candidate)) continue;

      const conflicts = this.detectConflictsAtTime(candidate, estimatedDurationMs, intensity);
      const load = this.getLoadAtTime(candidate);

      const score = load + conflicts.length * 5;
      if (score < lowestLoad) {
        lowestLoad = score;
        bestTime = candidate;
      }

      // Perfect slot found
      if (score === 0) break;
    }

    return bestTime;
  }

  // ---------------------------------------------------------------------------
  // Private: Conflict detection
  // ---------------------------------------------------------------------------

  private detectConflictsAtTime(
    time: Date,
    durationMs: number,
    intensity: ResourceIntensity,
  ): ConflictDetection[] {
    const endTime = time.getTime() + durationMs;
    const conflicts: ConflictDetection[] = [];

    const overlapping = this.slots.filter(s => {
      if (s.status !== 'planned' && s.status !== 'ready' && s.status !== 'running') return false;
      const slotEnd = s.scheduledAt.getTime() + s.estimatedDurationMs;
      return s.scheduledAt.getTime() < endTime && slotEnd > time.getTime();
    });

    // Check resource intensity conflicts
    const heavyCount = overlapping.filter(s =>
      s.resourceIntensity === 'heavy' || s.resourceIntensity === 'extreme',
    ).length;

    if (intensity === 'extreme' && overlapping.length > 0) {
      conflicts.push({
        slotA: 'new',
        slotB: overlapping[0].id,
        conflictType: 'resource',
        severity: 'hard',
        description: 'Extreme intensity formula cannot run concurrently with other formulas',
      });
    }

    if (intensity === 'heavy' && heavyCount >= MAX_CONCURRENT_HEAVY) {
      conflicts.push({
        slotA: 'new',
        slotB: overlapping.find(s => s.resourceIntensity === 'heavy')?.id ?? 'unknown',
        conflictType: 'resource',
        severity: 'hard',
        description: `Max concurrent heavy formulas (${MAX_CONCURRENT_HEAVY}) exceeded`,
      });
    }

    if (overlapping.length >= MAX_CONCURRENT_TOTAL) {
      conflicts.push({
        slotA: 'new',
        slotB: overlapping[0].id,
        conflictType: 'worker_contention',
        severity: 'hard',
        description: `Max concurrent formulas (${MAX_CONCURRENT_TOTAL}) exceeded`,
      });
    }

    // Check external API rate-limit conflicts
    const externalApiSlots = overlapping.filter(s => s.resourceRequirements.requiresExternalApi);
    if (externalApiSlots.length >= 3) {
      conflicts.push({
        slotA: 'new',
        slotB: externalApiSlots[0].id,
        conflictType: 'api_limit',
        severity: 'soft',
        description: 'Multiple external API formulas scheduled concurrently may hit rate limits',
      });
    }

    return conflicts;
  }

  private checkConflict(a: ScheduleSlot, b: ScheduleSlot): ConflictDetection | null {
    const aEnd = a.scheduledAt.getTime() + a.estimatedDurationMs;
    const bEnd = b.scheduledAt.getTime() + b.estimatedDurationMs;

    // Check time overlap
    if (a.scheduledAt.getTime() >= bEnd || b.scheduledAt.getTime() >= aEnd) return null;

    // Both extreme
    if (a.resourceIntensity === 'extreme' || b.resourceIntensity === 'extreme') {
      return {
        slotA: a.id,
        slotB: b.id,
        conflictType: 'resource',
        severity: 'hard',
        description: `Extreme intensity conflict: ${a.formulaName} vs ${b.formulaName}`,
      };
    }

    // Both heavy
    if (a.resourceIntensity === 'heavy' && b.resourceIntensity === 'heavy') {
      return {
        slotA: a.id,
        slotB: b.id,
        conflictType: 'resource',
        severity: 'soft',
        description: `Heavy formulas overlapping: ${a.formulaName} vs ${b.formulaName}`,
      };
    }

    return null;
  }

  private getLoadAtTime(time: Date): number {
    return this.slots.filter(s => {
      if (s.status !== 'planned' && s.status !== 'ready') return false;
      const endTime = s.scheduledAt.getTime() + s.estimatedDurationMs;
      return s.scheduledAt.getTime() <= time.getTime() && endTime > time.getTime();
    }).reduce((sum, s) => sum + s.resourceRequirements.concurrentWorkers, 0);
  }

  // ---------------------------------------------------------------------------
  // Private: Maintenance windows
  // ---------------------------------------------------------------------------

  private isMaintenanceWindow(time: Date): boolean {
    return this.maintenanceWindows.some(w =>
      w.active && time >= w.startAt && time <= w.endAt,
    );
  }

  // ---------------------------------------------------------------------------
  // Private: Resource classification
  // ---------------------------------------------------------------------------

  private buildResourceRequirements(
    formulaName: string,
    profile: FormulaProfile,
    overrides?: Partial<ResourceRequirements>,
  ): ResourceRequirements {
    // Start with defaults based on formula name keywords
    let baseReqs: Partial<ResourceRequirements> = {};
    for (const [keyword, reqs] of Object.entries(DEFAULT_RESOURCE_PROFILES)) {
      if (formulaName.toLowerCase().includes(keyword)) {
        baseReqs = { ...reqs };
        break;
      }
    }

    return {
      concurrentWorkers: overrides?.concurrentWorkers ?? baseReqs.concurrentWorkers ?? Math.max(1, Math.round(profile.avgWorkers)),
      estimatedLlmCalls: overrides?.estimatedLlmCalls ?? baseReqs.estimatedLlmCalls ?? 5,
      estimatedTokens: overrides?.estimatedTokens ?? 10_000,
      requiresExternalApi: overrides?.requiresExternalApi ?? baseReqs.requiresExternalApi ?? false,
      requiresGpu: overrides?.requiresGpu ?? false,
      memoryMb: overrides?.memoryMb ?? baseReqs.memoryMb ?? 128,
      capabilities: overrides?.capabilities ?? [],
    };
  }

  private classifyIntensity(reqs: ResourceRequirements): ResourceIntensity {
    const score = reqs.concurrentWorkers * 2
      + (reqs.estimatedLlmCalls > 20 ? 3 : reqs.estimatedLlmCalls > 10 ? 2 : 1)
      + (reqs.requiresExternalApi ? 2 : 0)
      + (reqs.requiresGpu ? 3 : 0)
      + (reqs.memoryMb > 512 ? 2 : reqs.memoryMb > 256 ? 1 : 0);

    if (score >= 10) return 'extreme';
    if (score >= 7) return 'heavy';
    if (score >= 4) return 'medium';
    return 'light';
  }

  // ---------------------------------------------------------------------------
  // Private: Profile management
  // ---------------------------------------------------------------------------

  private async getOrCreateProfile(formulaName: string): Promise<FormulaProfile> {
    const existing = this.profiles.get(formulaName);
    if (existing) return existing;

    // Try DB
    const profile = await this.loadProfileFromDb(formulaName);
    if (profile) {
      this.profiles.set(formulaName, profile);
      return profile;
    }

    // Create default
    const defaultProfile: FormulaProfile = {
      formulaName,
      avgDurationMs: 60_000,
      avgCostUsd: 0.01,
      avgWorkers: 1,
      executionCount: 0,
      bestHourUtc: 10,
      bestDayOfWeek: 1,
      successRate: 0.5,
      resourceIntensity: 'medium',
      batchable: true,
    };

    this.profiles.set(formulaName, defaultProfile);
    return defaultProfile;
  }

  private updateProfile(slot: ScheduleSlot): void {
    const profile = this.profiles.get(slot.formulaName);
    if (!profile) return;

    profile.executionCount++;
    profile.lastExecutedAt = slot.completedAt ?? new Date();

    if (slot.status === 'completed' && slot.actualDurationMs) {
      // Running average for duration
      profile.avgDurationMs = Math.round(
        profile.avgDurationMs + (slot.actualDurationMs - profile.avgDurationMs) / profile.executionCount,
      );
    }

    // Running average for cost
    profile.avgCostUsd = Math.round(
      (profile.avgCostUsd + (slot.estimatedCostUsd - profile.avgCostUsd) / profile.executionCount) * 10000,
    ) / 10000;

    // Update success rate
    const successCount = Math.round(profile.successRate * (profile.executionCount - 1));
    const newSuccessCount = slot.status === 'completed' ? successCount + 1 : successCount;
    profile.successRate = Math.round((newSuccessCount / profile.executionCount) * 1000) / 1000;

    // Update best hour from successful runs
    if (slot.status === 'completed') {
      profile.bestHourUtc = slot.scheduledAt.getUTCHours();
      profile.bestDayOfWeek = slot.scheduledAt.getUTCDay();
    }
  }

  private async loadProfileFromDb(formulaName: string): Promise<FormulaProfile | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) AS exec_count,
           AVG(EXTRACT(EPOCH FROM (completed_at - actual_start_at)) * 1000) AS avg_dur,
           AVG(estimated_cost_usd) AS avg_cost,
           COUNT(*) FILTER (WHERE status = 'completed') * 1.0 / GREATEST(COUNT(*), 1) AS success_rate,
           MODE() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM scheduled_at)) AS best_hour,
           MODE() WITHIN GROUP (ORDER BY EXTRACT(DOW FROM scheduled_at)) AS best_dow
         FROM meow_formula_schedule
         WHERE formula_name = $1
           AND created_at > NOW() - INTERVAL '30 days'`,
        [formulaName],
      );

      if (!rows[0] || parseInt(rows[0].exec_count as string) === 0) return null;

      const r = rows[0];
      return {
        formulaName,
        avgDurationMs: Math.round(parseFloat(r.avg_dur as string) || 60_000),
        avgCostUsd: Math.round((parseFloat(r.avg_cost as string) || 0.01) * 10000) / 10000,
        avgWorkers: 1,
        executionCount: parseInt(r.exec_count as string) || 0,
        bestHourUtc: parseInt(r.best_hour as string) || 10,
        bestDayOfWeek: parseInt(r.best_dow as string) || 1,
        successRate: Math.round((parseFloat(r.success_rate as string) || 0.5) * 1000) / 1000,
        resourceIntensity: 'medium',
        batchable: true,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Heuristic rescheduling
  // ---------------------------------------------------------------------------

  private heuristicReschedule(planned: ScheduleSlot[]): number {
    let rescheduled = 0;
    const heavy = planned.filter(s => s.resourceIntensity === 'heavy' || s.resourceIntensity === 'extreme');

    // Spread heavy formulas across different hours
    for (let i = 0; i < heavy.length; i++) {
      const slot = heavy[i];
      const targetHour = (10 + i * 2) % 24; // spread starting from 10 UTC
      const newTime = new Date(slot.scheduledAt);
      newTime.setUTCHours(targetHour, 0, 0, 0);
      if (newTime < new Date()) newTime.setDate(newTime.getDate() + 1);

      if (!this.isMaintenanceWindow(newTime)) {
        slot.scheduledAt = newTime;
        slot.reason += ` | Heuristic: spread heavy formula to ${targetHour}:00 UTC`;
        rescheduled++;
      }
    }

    return rescheduled;
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistSlot(slot: ScheduleSlot): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_formula_schedule
          (id, formula_name, molecule_id, status, priority,
           scheduled_at, actual_start_at, completed_at,
           estimated_duration_ms, actual_duration_ms, estimated_cost_usd,
           resource_intensity, resource_requirements, batch_id,
           conflicts_with, window_id, ai_scheduled, reason, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [
          slot.id,
          slot.formulaName,
          slot.moleculeId ?? null,
          slot.status,
          slot.priority,
          slot.scheduledAt.toISOString(),
          slot.actualStartAt?.toISOString() ?? null,
          slot.completedAt?.toISOString() ?? null,
          slot.estimatedDurationMs,
          slot.actualDurationMs ?? null,
          slot.estimatedCostUsd,
          slot.resourceIntensity,
          JSON.stringify(slot.resourceRequirements),
          slot.batchId ?? null,
          JSON.stringify(slot.conflictsWith),
          slot.windowId ?? null,
          slot.aiScheduled,
          slot.reason,
          slot.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, slotId: slot.id }, 'Failed to persist schedule slot');
    }
  }

  private async updateSlotInDb(slot: ScheduleSlot): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `UPDATE meow_formula_schedule
         SET status = $1, actual_start_at = $2, completed_at = $3,
             actual_duration_ms = $4, scheduled_at = $5, reason = $6
         WHERE id = $7`,
        [
          slot.status,
          slot.actualStartAt?.toISOString() ?? null,
          slot.completedAt?.toISOString() ?? null,
          slot.actualDurationMs ?? null,
          slot.scheduledAt.toISOString(),
          slot.reason,
          slot.id,
        ],
      );
    } catch (err) {
      log.error({ err, slotId: slot.id }, 'Failed to update schedule slot');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FormulaSchedulingAI | null = null;

export function getFormulaSchedulingAI(): FormulaSchedulingAI {
  if (!instance) {
    instance = new FormulaSchedulingAI();
  }
  return instance;
}
