/**
 * SELF-SCHEDULING — SG-010 (Stage 06 Wave 3)
 *
 * Gas Town auto-generates its daily execution schedule.
 * Analyzes pending beads, scheduled formulas, resource availability, and
 * deadlines to produce a prioritized daily plan with time slots.
 *
 * Features:
 *   - Analyze: pending beads, scheduled formulas, resource availability, deadlines
 *   - Generate: prioritized daily plan with time slots for each formula/bead group
 *   - Consider: formula dependencies, resource contention, optimal execution windows
 *   - Schedule types: recurring (daily audit), deadline-driven (launch by Friday), opportunistic
 *   - Re-schedule: if priorities change mid-day, regenerate remaining schedule
 *   - AI-powered: Gemini creates optimized schedule with rationale for each slot
 *   - Heuristic fallback: priority-sorted queue with time-based batching
 *   - DB persistence: meow_daily_schedule for planned vs actual execution
 *   - Schedule approval: auto-approve routine, human-approve novel ones
 *   - Publish schedule on SSE for frontend display
 *
 * Gas Town: "Every convoy needs a manifest — or the road turns to chaos."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('self-scheduling');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduleSlotStatus = 'planned' | 'approved' | 'running' | 'completed' | 'failed' | 'skipped' | 'rescheduled';

export type ScheduleType = 'recurring' | 'deadline_driven' | 'opportunistic' | 'dependency' | 'manual';

export type ApprovalStatus = 'auto_approved' | 'pending_approval' | 'approved' | 'rejected';

export interface ScheduleSlot {
  id: string;
  scheduleId: string;
  formulaName: string;
  beadGroupId?: string;
  type: ScheduleType;
  status: ScheduleSlotStatus;
  approval: ApprovalStatus;
  priority: number;                // 1 (highest) to 10 (lowest)
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  actualStartAt?: Date;
  actualEndAt?: Date;
  estimatedDurationMs: number;
  dependsOn: string[];             // slot IDs that must complete first
  resourceRequirements: SlotResourceReqs;
  rationale: string;               // AI or heuristic explanation
  aiGenerated: boolean;
  createdAt: Date;
}

export interface SlotResourceReqs {
  workers: number;
  llmCalls: number;
  externalApis: string[];
  estimatedCostUsd: number;
}

export interface DailySchedule {
  id: string;
  date: string;                    // YYYY-MM-DD
  timezone: string;
  totalSlots: number;
  completedSlots: number;
  failedSlots: number;
  skippedSlots: number;
  slots: ScheduleSlot[];
  generatedAt: Date;
  regeneratedCount: number;
  aiGenerated: boolean;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: Date;
}

export interface PendingWork {
  pendingBeads: number;
  scheduledFormulas: string[];
  deadlines: Array<{ formulaName: string; deadline: Date; urgency: number }>;
  recurringTasks: string[];
  availableWorkers: number;
  currentLoad: number;             // 0-100 percentage
}

export interface ScheduleGenerationResult {
  schedule: DailySchedule;
  aiUsed: boolean;
  slotsGenerated: number;
  estimatedTotalCostUsd: number;
  estimatedCompletionHour: number;
  warnings: string[];
}

export interface SchedulerStats {
  totalSchedulesGenerated: number;
  totalSlots: number;
  completedOnTime: number;
  completedLate: number;
  failed: number;
  avgAccuracyPct: number;         // scheduled vs actual timing
  regenerations: number;
  aiSchedulesPct: number;
  approvalsPending: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SLOTS_PER_DAY = 200;
const DEFAULT_SLOT_DURATION_MS = 30 * 60_000; // 30 minutes
const MAX_SCHEDULES_IN_MEMORY = 30;
const ROUTINE_FORMULAS = new Set([
  'daily-audit', 'metric-collection', 'log-rotation', 'health-check',
  'cost-reconciliation', 'cleanup', 'stale-archival', 'system-health',
]);

/** Default recurring tasks with preferred times (hour UTC) */
const DEFAULT_RECURRING: Array<{ formula: string; preferredHour: number; priority: number }> = [
  { formula: 'metric-collection', preferredHour: 7, priority: 2 },
  { formula: 'health-check', preferredHour: 8, priority: 1 },
  { formula: 'daily-audit', preferredHour: 22, priority: 3 },
  { formula: 'log-rotation', preferredHour: 3, priority: 5 },
  { formula: 'cost-reconciliation', preferredHour: 23, priority: 4 },
  { formula: 'stale-archival', preferredHour: 4, priority: 6 },
  { formula: 'cleanup', preferredHour: 3, priority: 7 },
];

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
                'You are a daily schedule optimizer for an AI agent platform called Gas Town. '
                + 'Given pending work, deadlines, resource constraints, and recurring tasks, '
                + 'create an optimal daily execution schedule. '
                + 'Respond ONLY with valid JSON: {"slots": [{"formulaName": "...", "startHour": 0-23, '
                + '"startMinute": 0-59, "durationMinutes": N, "priority": 1-10, "type": "recurring|deadline_driven|opportunistic", '
                + '"dependsOn": ["formulaName"], "rationale": "..."}], "warnings": ["..."], "strategy": "..."}',
            },
            { role: 'user', content: context },
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
    log.warn({ err }, 'Gemini scheduling call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// SelfScheduler
// ---------------------------------------------------------------------------

export class SelfScheduler {
  private schedules: DailySchedule[] = [];
  private currentSchedule: DailySchedule | null = null;
  private stats: SchedulerStats = {
    totalSchedulesGenerated: 0,
    totalSlots: 0,
    completedOnTime: 0,
    completedLate: 0,
    failed: 0,
    avgAccuracyPct: 0,
    regenerations: 0,
    aiSchedulesPct: 0,
    approvalsPending: 0,
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
      schedulesLoaded: this.schedules.length,
      currentSchedule: this.currentSchedule?.id ?? 'none',
    }, 'Self-scheduler initialized');
  }

  // -------------------------------------------------------------------------
  // Schedule generation
  // -------------------------------------------------------------------------

  async generateDailySchedule(
    pendingWork: PendingWork,
    timezone = 'America/Sao_Paulo',
    forceHeuristic = false,
  ): Promise<ScheduleGenerationResult> {
    const today = new Date().toISOString().slice(0, 10);
    const warnings: string[] = [];

    // Build context for AI
    const context = JSON.stringify({
      date: today,
      timezone,
      pendingBeads: pendingWork.pendingBeads,
      scheduledFormulas: pendingWork.scheduledFormulas,
      deadlines: pendingWork.deadlines.map(d => ({
        ...d,
        deadline: d.deadline.toISOString(),
      })),
      recurringTasks: DEFAULT_RECURRING,
      availableWorkers: pendingWork.availableWorkers,
      currentLoad: pendingWork.currentLoad,
    });

    let slots: ScheduleSlot[] = [];
    let aiUsed = false;

    // Try AI scheduling first
    if (!forceHeuristic) {
      const aiResponse = await callGeminiScheduler(context);
      if (aiResponse) {
        try {
          const parsed = JSON.parse(aiResponse) as {
            slots: Array<{
              formulaName: string;
              startHour: number;
              startMinute: number;
              durationMinutes: number;
              priority: number;
              type: ScheduleType;
              dependsOn?: string[];
              rationale: string;
            }>;
            warnings?: string[];
            strategy?: string;
          };

          const scheduleId = uuidv4();
          slots = parsed.slots.slice(0, MAX_SLOTS_PER_DAY).map(s => {
            const start = new Date();
            start.setHours(s.startHour, s.startMinute, 0, 0);
            const end = new Date(start.getTime() + s.durationMinutes * 60_000);

            return {
              id: uuidv4(),
              scheduleId,
              formulaName: s.formulaName,
              type: s.type || 'opportunistic',
              status: 'planned' as ScheduleSlotStatus,
              approval: this.determineApproval(s.formulaName, s.type),
              priority: Math.max(1, Math.min(10, s.priority)),
              scheduledStartAt: start,
              scheduledEndAt: end,
              estimatedDurationMs: s.durationMinutes * 60_000,
              dependsOn: s.dependsOn ?? [],
              resourceRequirements: this.estimateResources(s.formulaName),
              rationale: s.rationale,
              aiGenerated: true,
              createdAt: new Date(),
            };
          });

          if (parsed.warnings) warnings.push(...parsed.warnings);
          aiUsed = true;

          log.info({ slots: slots.length, strategy: parsed.strategy }, 'AI schedule generated');
        } catch (err) {
          log.warn({ err }, 'Failed to parse AI schedule, falling back to heuristic');
        }
      }
    }

    // Heuristic fallback
    if (slots.length === 0) {
      slots = this.generateHeuristicSchedule(pendingWork, today);
      if (!forceHeuristic) {
        warnings.push('AI scheduling unavailable, using heuristic fallback');
      }
    }

    // Build schedule
    const scheduleId = slots.length > 0 ? slots[0].scheduleId : uuidv4();
    const schedule: DailySchedule = {
      id: scheduleId,
      date: today,
      timezone,
      totalSlots: slots.length,
      completedSlots: 0,
      failedSlots: 0,
      skippedSlots: 0,
      slots,
      generatedAt: new Date(),
      regeneratedCount: 0,
      aiGenerated: aiUsed,
      approved: slots.every(s => s.approval === 'auto_approved'),
    };

    // Store
    this.currentSchedule = schedule;
    this.schedules.push(schedule);
    if (this.schedules.length > MAX_SCHEDULES_IN_MEMORY) {
      this.schedules = this.schedules.slice(-MAX_SCHEDULES_IN_MEMORY);
    }

    this.stats.totalSchedulesGenerated += 1;
    this.stats.totalSlots += slots.length;
    if (aiUsed) {
      this.stats.aiSchedulesPct = Math.round(
        (this.stats.aiSchedulesPct * (this.stats.totalSchedulesGenerated - 1) + 100) /
        this.stats.totalSchedulesGenerated,
      );
    }
    this.stats.approvalsPending = slots.filter(s => s.approval === 'pending_approval').length;

    await this.persistSchedule(schedule);

    // Broadcast
    broadcast('meow:sovereign', {
      type: 'schedule:generated',
      scheduleId: schedule.id,
      date: schedule.date,
      totalSlots: schedule.totalSlots,
      aiGenerated: aiUsed,
      approved: schedule.approved,
      pendingApproval: this.stats.approvalsPending,
    });

    const estimatedCost = slots.reduce((s, sl) => s + sl.resourceRequirements.estimatedCostUsd, 0);

    return {
      schedule,
      aiUsed,
      slotsGenerated: slots.length,
      estimatedTotalCostUsd: estimatedCost,
      estimatedCompletionHour: slots.length > 0
        ? slots[slots.length - 1].scheduledEndAt.getHours()
        : 0,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Heuristic schedule generation
  // -------------------------------------------------------------------------

  private generateHeuristicSchedule(work: PendingWork, date: string): ScheduleSlot[] {
    const scheduleId = uuidv4();
    const slots: ScheduleSlot[] = [];
    let currentHour = 6; // Start at 6am
    let currentMinute = 0;

    // 1. Add recurring tasks at their preferred times
    for (const rec of DEFAULT_RECURRING) {
      const start = new Date(`${date}T${String(rec.preferredHour).padStart(2, '0')}:00:00`);
      const end = new Date(start.getTime() + DEFAULT_SLOT_DURATION_MS);

      slots.push({
        id: uuidv4(),
        scheduleId,
        formulaName: rec.formula,
        type: 'recurring',
        status: 'planned',
        approval: 'auto_approved',
        priority: rec.priority,
        scheduledStartAt: start,
        scheduledEndAt: end,
        estimatedDurationMs: DEFAULT_SLOT_DURATION_MS,
        dependsOn: [],
        resourceRequirements: this.estimateResources(rec.formula),
        rationale: `Recurring task scheduled at preferred hour ${rec.preferredHour}`,
        aiGenerated: false,
        createdAt: new Date(),
      });
    }

    // 2. Add deadline-driven tasks sorted by urgency
    const sorted = [...work.deadlines].sort((a, b) => b.urgency - a.urgency);
    for (const dl of sorted) {
      if (slots.length >= MAX_SLOTS_PER_DAY) break;

      const start = new Date(`${date}T${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}:00`);
      const dur = DEFAULT_SLOT_DURATION_MS;
      const end = new Date(start.getTime() + dur);

      slots.push({
        id: uuidv4(),
        scheduleId,
        formulaName: dl.formulaName,
        type: 'deadline_driven',
        status: 'planned',
        approval: this.determineApproval(dl.formulaName, 'deadline_driven'),
        priority: Math.max(1, Math.min(10, 11 - dl.urgency)),
        scheduledStartAt: start,
        scheduledEndAt: end,
        estimatedDurationMs: dur,
        dependsOn: [],
        resourceRequirements: this.estimateResources(dl.formulaName),
        rationale: `Deadline-driven: due ${dl.deadline.toISOString()}, urgency ${dl.urgency}`,
        aiGenerated: false,
        createdAt: new Date(),
      });

      currentMinute += 30;
      if (currentMinute >= 60) {
        currentMinute = 0;
        currentHour += 1;
      }
    }

    // 3. Add scheduled formulas as opportunistic
    for (const formula of work.scheduledFormulas) {
      if (slots.length >= MAX_SLOTS_PER_DAY) break;
      if (slots.some(s => s.formulaName === formula)) continue; // avoid duplicates

      const start = new Date(`${date}T${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}:00`);
      const dur = DEFAULT_SLOT_DURATION_MS;
      const end = new Date(start.getTime() + dur);

      slots.push({
        id: uuidv4(),
        scheduleId,
        formulaName: formula,
        type: 'opportunistic',
        status: 'planned',
        approval: this.determineApproval(formula, 'opportunistic'),
        priority: 5,
        scheduledStartAt: start,
        scheduledEndAt: end,
        estimatedDurationMs: dur,
        dependsOn: [],
        resourceRequirements: this.estimateResources(formula),
        rationale: 'Opportunistic: scheduled when resource load allows',
        aiGenerated: false,
        createdAt: new Date(),
      });

      currentMinute += 30;
      if (currentMinute >= 60) {
        currentMinute = 0;
        currentHour += 1;
      }
    }

    // Sort by scheduled time
    slots.sort((a, b) => a.scheduledStartAt.getTime() - b.scheduledStartAt.getTime());

    return slots;
  }

  // -------------------------------------------------------------------------
  // Re-scheduling
  // -------------------------------------------------------------------------

  async reschedule(
    pendingWork: PendingWork,
    reason: string,
    timezone = 'America/Sao_Paulo',
  ): Promise<ScheduleGenerationResult> {
    if (!this.currentSchedule) {
      return this.generateDailySchedule(pendingWork, timezone);
    }

    // Mark non-started slots as rescheduled
    for (const slot of this.currentSchedule.slots) {
      if (slot.status === 'planned' || slot.status === 'approved') {
        slot.status = 'rescheduled';
      }
    }

    this.currentSchedule.regeneratedCount += 1;
    this.stats.regenerations += 1;

    log.info({
      scheduleId: this.currentSchedule.id,
      reason,
      regeneration: this.currentSchedule.regeneratedCount,
    }, 'Rescheduling triggered');

    // Generate fresh schedule for remaining day
    const result = await this.generateDailySchedule(pendingWork, timezone);

    broadcast('meow:sovereign', {
      type: 'schedule:rescheduled',
      scheduleId: result.schedule.id,
      reason,
      newSlots: result.slotsGenerated,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Slot lifecycle
  // -------------------------------------------------------------------------

  markSlotStarted(slotId: string): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;

    slot.status = 'running';
    slot.actualStartAt = new Date();
    this.persistSlotUpdate(slot);

    broadcast('meow:sovereign', {
      type: 'schedule:slot_started',
      slotId: slot.id,
      formulaName: slot.formulaName,
    });
  }

  markSlotCompleted(slotId: string): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;

    slot.status = 'completed';
    slot.actualEndAt = new Date();

    if (this.currentSchedule) {
      this.currentSchedule.completedSlots += 1;
    }

    // Track accuracy
    if (slot.actualStartAt) {
      const scheduledMs = slot.scheduledStartAt.getTime();
      const actualMs = slot.actualStartAt.getTime();
      const diffMs = Math.abs(actualMs - scheduledMs);
      const accuracyPct = Math.max(0, 100 - (diffMs / slot.estimatedDurationMs) * 100);
      this.stats.completedOnTime += (accuracyPct >= 80 ? 1 : 0);
      this.stats.completedLate += (accuracyPct < 80 ? 1 : 0);
      this.updateAvgAccuracy(accuracyPct);
    }

    this.persistSlotUpdate(slot);

    broadcast('meow:sovereign', {
      type: 'schedule:slot_completed',
      slotId: slot.id,
      formulaName: slot.formulaName,
    });
  }

  markSlotFailed(slotId: string, error: string): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;

    slot.status = 'failed';
    slot.actualEndAt = new Date();
    slot.rationale += ` | FAILED: ${error}`;

    if (this.currentSchedule) {
      this.currentSchedule.failedSlots += 1;
    }
    this.stats.failed += 1;

    this.persistSlotUpdate(slot);

    broadcast('meow:sovereign', {
      type: 'schedule:slot_failed',
      slotId: slot.id,
      formulaName: slot.formulaName,
      error,
    });
  }

  skipSlot(slotId: string, reason: string): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;

    slot.status = 'skipped';
    slot.rationale += ` | SKIPPED: ${reason}`;

    if (this.currentSchedule) {
      this.currentSchedule.skippedSlots += 1;
    }

    this.persistSlotUpdate(slot);
  }

  // -------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------

  approveSlot(slotId: string, approvedBy: string): boolean {
    const slot = this.findSlot(slotId);
    if (!slot || slot.approval !== 'pending_approval') return false;

    slot.approval = 'approved';
    this.stats.approvalsPending = Math.max(0, this.stats.approvalsPending - 1);

    this.persistSlotUpdate(slot);
    log.info({ slotId, approvedBy }, 'Schedule slot approved');

    // Check if entire schedule is now approved
    if (this.currentSchedule) {
      this.currentSchedule.approved = this.currentSchedule.slots.every(
        s => s.approval === 'auto_approved' || s.approval === 'approved',
      );
      if (this.currentSchedule.approved) {
        this.currentSchedule.approvedBy = approvedBy;
        this.currentSchedule.approvedAt = new Date();
      }
    }

    return true;
  }

  rejectSlot(slotId: string, reason: string): boolean {
    const slot = this.findSlot(slotId);
    if (!slot || slot.approval !== 'pending_approval') return false;

    slot.approval = 'rejected';
    slot.status = 'skipped';
    slot.rationale += ` | REJECTED: ${reason}`;
    this.stats.approvalsPending = Math.max(0, this.stats.approvalsPending - 1);

    this.persistSlotUpdate(slot);
    log.info({ slotId, reason }, 'Schedule slot rejected');
    return true;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getCurrentSchedule(): DailySchedule | null {
    return this.currentSchedule;
  }

  getNextSlot(): ScheduleSlot | null {
    if (!this.currentSchedule) return null;

    const now = Date.now();
    return this.currentSchedule.slots.find(
      s => (s.status === 'planned' || s.status === 'approved')
        && s.scheduledStartAt.getTime() >= now
        && (s.approval === 'auto_approved' || s.approval === 'approved'),
    ) ?? null;
  }

  getPendingApprovals(): ScheduleSlot[] {
    if (!this.currentSchedule) return [];
    return this.currentSchedule.slots.filter(s => s.approval === 'pending_approval');
  }

  getStats(): SchedulerStats {
    return { ...this.stats };
  }

  getScheduleHistory(days = 7): DailySchedule[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return this.schedules.filter(s => s.generatedAt >= cutoff);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private findSlot(slotId: string): ScheduleSlot | null {
    if (!this.currentSchedule) return null;
    return this.currentSchedule.slots.find(s => s.id === slotId) ?? null;
  }

  private determineApproval(formulaName: string, type: ScheduleType): ApprovalStatus {
    // Routine recurring tasks are auto-approved
    if (type === 'recurring' && ROUTINE_FORMULAS.has(formulaName)) {
      return 'auto_approved';
    }
    // Deadline-driven and high-priority are also auto-approved
    if (type === 'deadline_driven') {
      return 'auto_approved';
    }
    // Novel opportunistic schedules need human approval
    if (type === 'opportunistic') {
      return ROUTINE_FORMULAS.has(formulaName) ? 'auto_approved' : 'pending_approval';
    }
    return 'auto_approved';
  }

  private estimateResources(formulaName: string): SlotResourceReqs {
    // Heuristic: estimate based on formula name patterns
    const name = formulaName.toLowerCase();
    if (name.includes('campaign') || name.includes('launch')) {
      return { workers: 3, llmCalls: 15, externalApis: ['meta', 'shopify'], estimatedCostUsd: 0.12 };
    }
    if (name.includes('content') || name.includes('creative')) {
      return { workers: 2, llmCalls: 10, externalApis: ['fal'], estimatedCostUsd: 0.08 };
    }
    if (name.includes('audit') || name.includes('analysis')) {
      return { workers: 1, llmCalls: 5, externalApis: [], estimatedCostUsd: 0.03 };
    }
    if (name.includes('health') || name.includes('cleanup') || name.includes('rotation')) {
      return { workers: 1, llmCalls: 0, externalApis: [], estimatedCostUsd: 0.0 };
    }
    // Default
    return { workers: 1, llmCalls: 3, externalApis: [], estimatedCostUsd: 0.02 };
  }

  private updateAvgAccuracy(newPct: number): void {
    const total = this.stats.completedOnTime + this.stats.completedLate;
    this.stats.avgAccuracyPct = Math.round(
      (this.stats.avgAccuracyPct * (total - 1) + newPct) / total,
    );
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistSchedule(schedule: DailySchedule): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_daily_schedule
           (id, schedule_date, timezone, total_slots, completed_slots, failed_slots,
            skipped_slots, slots_json, generated_at, regenerated_count, ai_generated,
            approved, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           total_slots = $4, completed_slots = $5, failed_slots = $6,
           skipped_slots = $7, slots_json = $8, regenerated_count = $10,
           approved = $12, approved_by = $13, approved_at = $14`,
        [
          schedule.id,
          schedule.date,
          schedule.timezone,
          schedule.totalSlots,
          schedule.completedSlots,
          schedule.failedSlots,
          schedule.skippedSlots,
          JSON.stringify(schedule.slots),
          schedule.generatedAt.toISOString(),
          schedule.regeneratedCount,
          schedule.aiGenerated,
          schedule.approved,
          schedule.approvedBy ?? null,
          schedule.approvedAt?.toISOString() ?? null,
        ],
      );
    } catch (err) {
      log.error({ err, scheduleId: schedule.id }, 'Failed to persist daily schedule');
    }
  }

  private async persistSlotUpdate(slot: ScheduleSlot): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      // Update the full schedule JSON (slots are stored as JSON blob)
      if (this.currentSchedule) {
        await this.persistSchedule(this.currentSchedule);
      }
    } catch (err) {
      log.error({ err, slotId: slot.id }, 'Failed to persist slot update');
    }
  }

  private async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, schedule_date, timezone, total_slots, completed_slots,
                failed_slots, skipped_slots, slots_json, generated_at,
                regenerated_count, ai_generated, approved, approved_by, approved_at
         FROM meow_daily_schedule
         WHERE generated_at >= NOW() - INTERVAL '7 days'
         ORDER BY generated_at DESC
         LIMIT 30`,
      );

      for (const row of rows) {
        const slotsRaw = typeof row.slots_json === 'string'
          ? JSON.parse(row.slots_json)
          : row.slots_json;

        const schedule: DailySchedule = {
          id: row.id,
          date: row.schedule_date,
          timezone: row.timezone,
          totalSlots: row.total_slots,
          completedSlots: row.completed_slots,
          failedSlots: row.failed_slots,
          skippedSlots: row.skipped_slots,
          slots: (slotsRaw as ScheduleSlot[]).map(s => ({
            ...s,
            scheduledStartAt: new Date(s.scheduledStartAt),
            scheduledEndAt: new Date(s.scheduledEndAt),
            actualStartAt: s.actualStartAt ? new Date(s.actualStartAt) : undefined,
            actualEndAt: s.actualEndAt ? new Date(s.actualEndAt) : undefined,
            createdAt: new Date(s.createdAt),
          })),
          generatedAt: new Date(row.generated_at),
          regeneratedCount: row.regenerated_count,
          aiGenerated: row.ai_generated,
          approved: row.approved,
          approvedBy: row.approved_by ?? undefined,
          approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
        };

        this.schedules.push(schedule);
      }

      // Set current schedule to today's latest
      const today = new Date().toISOString().slice(0, 10);
      this.currentSchedule = this.schedules.find(s => s.date === today) ?? null;

      this.stats.totalSchedulesGenerated = rows.length;

      log.info({ schedules: rows.length, current: this.currentSchedule?.id ?? 'none' }, 'Loaded schedule history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load schedule history from DB');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SelfScheduler | null = null;

export function getSelfScheduler(): SelfScheduler {
  if (!instance) {
    instance = new SelfScheduler();
  }
  return instance;
}
