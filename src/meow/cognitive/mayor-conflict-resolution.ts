/**
 * CG-004 — Mayor Conflict Resolution (Stage 05 Wave 1)
 *
 * AI-powered conflict detection and resolution for Gas Town.
 * The Mayor detects and resolves conflicts between workers:
 *
 * Conflict types:
 *   - overlapping_assignment: two workers assigned same bead
 *   - resource_contention: workers competing for same external resource (API quota)
 *   - deadline_conflict: worker has more work than time allows
 *   - quality_dispute: reviewer disagrees with executor's output
 *
 * Resolution strategies per type:
 *   overlapping       -> reassign based on capability score
 *   resource_contention -> queue + priority ordering
 *   deadline           -> redistribute load or escalate
 *   quality_dispute    -> third-party review or Overseer escalation
 *
 * All conflicts and resolutions are logged to an audit trail.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity, FeedEvent } from '../types';

const log = createLogger('mayor-conflict-resolution');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictType =
  | 'overlapping_assignment'
  | 'resource_contention'
  | 'deadline_conflict'
  | 'quality_dispute';

export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ResolutionStrategy =
  | 'reassign'
  | 'queue_priority'
  | 'redistribute_load'
  | 'escalate_overseer'
  | 'third_party_review'
  | 'auto_resolved'
  | 'manual';

export interface Conflict {
  id: string;
  type: ConflictType;
  severity: ConflictSeverity;
  description: string;
  involvedWorkerIds: string[];
  involvedBeadIds: string[];
  resourceId?: string;
  detectedAt: Date;
  resolved: boolean;
  resolution?: Resolution;
}

export interface Resolution {
  conflictId: string;
  strategy: ResolutionStrategy;
  description: string;
  actions: ResolutionAction[];
  resolvedAt: Date;
  resolvedBy: 'ai' | 'heuristic' | 'overseer';
  costImpact?: string;
}

export interface ResolutionAction {
  type: 'reassign_bead' | 'queue_worker' | 'redistribute' | 'escalate' | 'notify' | 'pause_worker';
  target: string;
  details: string;
}

export interface ResolutionReport {
  totalConflicts: number;
  resolved: number;
  pending: number;
  escalated: number;
  byType: Record<ConflictType, number>;
  resolutions: Resolution[];
  generatedAt: Date;
}

export interface ConflictRecord {
  conflict: Conflict;
  resolution?: Resolution;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const MAX_CONCURRENT_BEADS_PER_WORKER = 5;
const DEADLINE_BUFFER_HOURS = 2;

const RESOLUTION_SYSTEM_PROMPT = `You are the Mayor of Gas Town. You resolve conflicts between workers.

For each conflict, determine the best resolution strategy:

1. overlapping_assignment: Two workers assigned the same bead.
   -> Reassign to the worker with better capability match. Release the other.

2. resource_contention: Workers competing for the same external resource (API quota, shared service).
   -> Queue workers by priority. Higher-priority beads get access first.

3. deadline_conflict: Worker overloaded, cannot complete all work by deadlines.
   -> Redistribute: move lower-priority beads to less-loaded workers. Escalate if no capacity.

4. quality_dispute: Reviewer rejects executor's output.
   -> Request third-party review from another worker. If persistent, escalate to Overseer.

Output STRICT JSON:
{
  "resolutions": [
    {
      "conflictId": "...",
      "strategy": "reassign|queue_priority|redistribute_load|escalate_overseer|third_party_review",
      "description": "Explanation of resolution",
      "actions": [
        { "type": "reassign_bead|queue_worker|redistribute|escalate|notify|pause_worker", "target": "id", "details": "what to do" }
      ]
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Conflict detection functions
// ---------------------------------------------------------------------------

async function detectOverlappingAssignments(): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const pool = getPool();
  if (!pool) return conflicts;

  try {
    // Find beads assigned to multiple workers (via meow_beads where assignee appears multiple times for same bead)
    const { rows } = await pool.query(
      `SELECT b.id as bead_id, b.title, b.assignee,
              COUNT(*) OVER (PARTITION BY b.id) as assignee_count
       FROM meow_beads b
       WHERE b.status = 'in_progress' AND b.assignee IS NOT NULL
       ORDER BY b.id`
    );

    // Group by bead ID to find overlaps
    const beadWorkers = new Map<string, string[]>();
    for (const row of rows) {
      const beadId = row.bead_id as string;
      const assignee = row.assignee as string;
      if (!beadWorkers.has(beadId)) beadWorkers.set(beadId, []);
      const list = beadWorkers.get(beadId)!;
      if (!list.includes(assignee)) list.push(assignee);
    }

    for (const [beadId, workerIds] of beadWorkers) {
      if (workerIds.length > 1) {
        conflicts.push({
          id: `cfl-${uuidv4().slice(0, 8)}`,
          type: 'overlapping_assignment',
          severity: 'high',
          description: `Bead ${beadId} is assigned to ${workerIds.length} workers: ${workerIds.join(', ')}`,
          involvedWorkerIds: workerIds,
          involvedBeadIds: [beadId],
          detectedAt: new Date(),
          resolved: false,
        });
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to detect overlapping assignments');
  }

  return conflicts;
}

async function detectDeadlineConflicts(workers: WorkerIdentity[]): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const pool = getPool();
  if (!pool) return conflicts;

  try {
    // Find workers with too many in-progress beads
    const { rows } = await pool.query(
      `SELECT assignee, COUNT(*) as bead_count,
              ARRAY_AGG(id) as bead_ids
       FROM meow_beads
       WHERE status = 'in_progress' AND assignee IS NOT NULL
       GROUP BY assignee
       HAVING COUNT(*) > $1`,
      [MAX_CONCURRENT_BEADS_PER_WORKER]
    );

    for (const row of rows) {
      const workerId = row.assignee as string;
      const beadCount = parseInt(row.bead_count as string, 10);
      const beadIds = (row.bead_ids as string[]) || [];
      const worker = workers.find(w => w.id === workerId);

      conflicts.push({
        id: `cfl-${uuidv4().slice(0, 8)}`,
        type: 'deadline_conflict',
        severity: beadCount > MAX_CONCURRENT_BEADS_PER_WORKER + 2 ? 'critical' : 'high',
        description: `Worker ${worker?.name || workerId} has ${beadCount} active beads (max ${MAX_CONCURRENT_BEADS_PER_WORKER})`,
        involvedWorkerIds: [workerId],
        involvedBeadIds: beadIds,
        detectedAt: new Date(),
        resolved: false,
      });
    }
  } catch (err) {
    log.warn({ err }, 'Failed to detect deadline conflicts');
  }

  return conflicts;
}

function detectResourceContention(workers: WorkerIdentity[]): Conflict[] {
  const conflicts: Conflict[] = [];

  // Detect workers competing for the same resource via shared capabilities
  const resourceUsers = new Map<string, string[]>();
  const sharedResources = ['MetaAdsManage', 'GoogleAdsManage', 'ShopifyManage', 'WhatsAppSend'];

  for (const worker of workers) {
    if (!worker.currentBeadId) continue;
    for (const cap of worker.capabilities) {
      if (sharedResources.includes(cap)) {
        if (!resourceUsers.has(cap)) resourceUsers.set(cap, []);
        resourceUsers.get(cap)!.push(worker.id);
      }
    }
  }

  for (const [resource, workerIds] of resourceUsers) {
    if (workerIds.length > 2) {
      conflicts.push({
        id: `cfl-${uuidv4().slice(0, 8)}`,
        type: 'resource_contention',
        severity: workerIds.length > 4 ? 'high' : 'medium',
        description: `${workerIds.length} workers competing for ${resource} API access`,
        involvedWorkerIds: workerIds,
        involvedBeadIds: [],
        resourceId: resource,
        detectedAt: new Date(),
        resolved: false,
      });
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Resolution via heuristic
// ---------------------------------------------------------------------------

function resolveOverlappingHeuristic(conflict: Conflict, workers: WorkerIdentity[]): Resolution {
  const actions: ResolutionAction[] = [];

  // Keep the first worker, reassign the rest
  const keepWorker = conflict.involvedWorkerIds[0];
  const releaseWorkers = conflict.involvedWorkerIds.slice(1);

  for (const workerId of releaseWorkers) {
    actions.push({
      type: 'reassign_bead',
      target: workerId,
      details: `Release worker ${workerId} from beads ${conflict.involvedBeadIds.join(', ')} — keeping ${keepWorker}`,
    });
    actions.push({
      type: 'notify',
      target: workerId,
      details: `You have been reassigned. Bead(s) handed to ${keepWorker}.`,
    });
  }

  return {
    conflictId: conflict.id,
    strategy: 'reassign',
    description: `Kept ${keepWorker} on bead(s), released ${releaseWorkers.join(', ')}`,
    actions,
    resolvedAt: new Date(),
    resolvedBy: 'heuristic',
  };
}

function resolveDeadlineHeuristic(conflict: Conflict, workers: WorkerIdentity[]): Resolution {
  const actions: ResolutionAction[] = [];
  const overloadedWorkerId = conflict.involvedWorkerIds[0];
  const excessBeads = conflict.involvedBeadIds.slice(MAX_CONCURRENT_BEADS_PER_WORKER);

  // Find workers with capacity
  const idleWorkers = workers.filter(
    w => w.id !== overloadedWorkerId && !w.currentBeadId
  );

  if (idleWorkers.length > 0 && excessBeads.length > 0) {
    let idleIdx = 0;
    for (const beadId of excessBeads) {
      if (idleIdx >= idleWorkers.length) break;
      actions.push({
        type: 'redistribute',
        target: idleWorkers[idleIdx].id,
        details: `Move bead ${beadId} from ${overloadedWorkerId} to ${idleWorkers[idleIdx].id}`,
      });
      idleIdx++;
    }

    return {
      conflictId: conflict.id,
      strategy: 'redistribute_load',
      description: `Redistributed ${actions.length} bead(s) from overloaded worker to idle workers`,
      actions,
      resolvedAt: new Date(),
      resolvedBy: 'heuristic',
    };
  }

  // No idle workers — escalate
  actions.push({
    type: 'escalate',
    target: 'overseer',
    details: `Worker ${overloadedWorkerId} overloaded with ${conflict.involvedBeadIds.length} beads and no idle workers available`,
  });

  return {
    conflictId: conflict.id,
    strategy: 'escalate_overseer',
    description: `No capacity to redistribute — escalating to Overseer`,
    actions,
    resolvedAt: new Date(),
    resolvedBy: 'heuristic',
  };
}

function resolveResourceContentionHeuristic(conflict: Conflict): Resolution {
  const actions: ResolutionAction[] = [];

  // Queue workers by order, rate-limit access
  for (let i = 0; i < conflict.involvedWorkerIds.length; i++) {
    actions.push({
      type: 'queue_worker',
      target: conflict.involvedWorkerIds[i],
      details: `Queued at position ${i + 1} for ${conflict.resourceId || 'shared resource'}`,
    });
  }

  return {
    conflictId: conflict.id,
    strategy: 'queue_priority',
    description: `Queued ${conflict.involvedWorkerIds.length} workers for ${conflict.resourceId} access by priority`,
    actions,
    resolvedAt: new Date(),
    resolvedBy: 'heuristic',
  };
}

function resolveQualityDisputeHeuristic(conflict: Conflict): Resolution {
  const actions: ResolutionAction[] = [];

  if (conflict.involvedWorkerIds.length >= 2) {
    actions.push({
      type: 'notify',
      target: conflict.involvedWorkerIds[0],
      details: 'Your output is under third-party review',
    });
    actions.push({
      type: 'escalate',
      target: 'overseer',
      details: `Quality dispute on beads ${conflict.involvedBeadIds.join(', ')}: requesting Overseer review`,
    });
  }

  return {
    conflictId: conflict.id,
    strategy: 'third_party_review',
    description: 'Escalated quality dispute for third-party review',
    actions,
    resolvedAt: new Date(),
    resolvedBy: 'heuristic',
  };
}

// ---------------------------------------------------------------------------
// AI-powered resolution
// ---------------------------------------------------------------------------

async function aiResolve(conflicts: Conflict[], workers: WorkerIdentity[]): Promise<Map<string, Resolution> | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || conflicts.length === 0) return null;

  const conflictSummaries = conflicts.map(c => ({
    id: c.id,
    type: c.type,
    severity: c.severity,
    description: c.description,
    involvedWorkers: c.involvedWorkerIds,
    involvedBeads: c.involvedBeadIds,
    resource: c.resourceId,
  }));

  const workerSummaries = workers.slice(0, 20).map(w => ({
    id: w.id,
    name: w.name,
    role: w.role,
    tier: w.tier,
    busy: !!w.currentBeadId,
  }));

  const prompt = [
    `## Active Conflicts (${conflicts.length})`,
    '```json',
    JSON.stringify(conflictSummaries, null, 2),
    '```',
    '',
    `## Workers`,
    '```json',
    JSON.stringify(workerSummaries, null, 2),
    '```',
    '',
    'Resolve each conflict with the appropriate strategy. Output strict JSON.',
  ].join('\n');

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: RESOLUTION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, body: errText.slice(0, 200) }, 'Gemini resolution API error');
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const parsed = JSON.parse(jsonMatch[1] || raw) as {
      resolutions: Array<{
        conflictId: string;
        strategy: ResolutionStrategy;
        description: string;
        actions: ResolutionAction[];
      }>;
    };

    const validConflictIds = new Set(conflicts.map(c => c.id));
    const result = new Map<string, Resolution>();

    for (const r of (parsed.resolutions || [])) {
      if (!validConflictIds.has(r.conflictId)) continue;
      result.set(r.conflictId, {
        conflictId: r.conflictId,
        strategy: r.strategy || 'manual',
        description: r.description || 'AI-resolved',
        actions: (r.actions || []).map(a => ({
          type: a.type || 'notify',
          target: a.target || '',
          details: a.details || '',
        })),
        resolvedAt: new Date(),
        resolvedBy: 'ai',
      });
    }

    log.info({ resolvedCount: result.size, conflictCount: conflicts.length }, 'AI resolution completed');
    return result;
  } catch (err) {
    log.error({ err }, 'Gemini resolution call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence (audit trail)
// ---------------------------------------------------------------------------

async function persistConflict(conflict: Conflict): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO meow_conflicts
        (id, type, severity, description, involved_workers, involved_beads, resource_id, detected_at, resolved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET resolved = EXCLUDED.resolved`,
      [
        conflict.id,
        conflict.type,
        conflict.severity,
        conflict.description,
        JSON.stringify(conflict.involvedWorkerIds),
        JSON.stringify(conflict.involvedBeadIds),
        conflict.resourceId || null,
        conflict.detectedAt,
        conflict.resolved,
      ]
    );
  } catch (err) {
    log.warn({ err }, 'Failed to persist conflict (table may not exist)');
  }
}

async function persistResolution(resolution: Resolution): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO meow_resolutions
        (conflict_id, strategy, description, actions, resolved_at, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        resolution.conflictId,
        resolution.strategy,
        resolution.description,
        JSON.stringify(resolution.actions),
        resolution.resolvedAt,
        resolution.resolvedBy,
      ]
    );
  } catch (err) {
    log.warn({ err }, 'Failed to persist resolution (table may not exist)');
  }
}

// ---------------------------------------------------------------------------
// MayorConflictResolver
// ---------------------------------------------------------------------------

export class MayorConflictResolver {
  private activeConflicts: Map<string, Conflict> = new Map();
  private conflictHistory: ConflictRecord[] = [];

  constructor() {
    log.info('MayorConflictResolver initialized');
  }

  /** Detect all current conflicts */
  async detectConflicts(workers?: WorkerIdentity[]): Promise<Conflict[]> {
    const startMs = Date.now();
    const allWorkers = workers || [];

    log.info({ workerCount: allWorkers.length }, 'Detecting conflicts');

    const [overlapping, deadlines, contention] = await Promise.all([
      detectOverlappingAssignments(),
      detectDeadlineConflicts(allWorkers),
      Promise.resolve(detectResourceContention(allWorkers)),
    ]);

    const allConflicts = [...overlapping, ...deadlines, ...contention];

    // Register new conflicts (skip already-known ones)
    for (const conflict of allConflicts) {
      if (!this.activeConflicts.has(conflict.id)) {
        this.activeConflicts.set(conflict.id, conflict);
        persistConflict(conflict).catch(() => {});
      }
    }

    const durationMs = Date.now() - startMs;

    if (allConflicts.length > 0) {
      broadcast('meow:feed', {
        id: uuidv4(),
        type: 'patrol_alert',
        source: 'mayor-conflict-resolution',
        message: `Detected ${allConflicts.length} conflict(s): ${overlapping.length} overlapping, ${deadlines.length} deadline, ${contention.length} contention`,
        severity: allConflicts.some(c => c.severity === 'critical') ? 'critical' : 'warning',
        metadata: {
          total: allConflicts.length,
          overlapping: overlapping.length,
          deadlines: deadlines.length,
          contention: contention.length,
          durationMs,
        },
        timestamp: new Date(),
      });
    }

    log.info({
      total: allConflicts.length,
      overlapping: overlapping.length,
      deadlines: deadlines.length,
      contention: contention.length,
      durationMs,
    }, 'Conflict detection complete');

    return allConflicts;
  }

  /** Resolve a single conflict */
  async resolveConflict(conflict: Conflict, workers?: WorkerIdentity[]): Promise<Resolution> {
    const allWorkers = workers || [];

    log.info({ conflictId: conflict.id, type: conflict.type }, 'Resolving conflict');

    // Try AI resolution
    const aiResolutions = await aiResolve([conflict], allWorkers);
    let resolution = aiResolutions?.get(conflict.id);

    // Fallback to heuristic
    if (!resolution) {
      switch (conflict.type) {
        case 'overlapping_assignment':
          resolution = resolveOverlappingHeuristic(conflict, allWorkers);
          break;
        case 'deadline_conflict':
          resolution = resolveDeadlineHeuristic(conflict, allWorkers);
          break;
        case 'resource_contention':
          resolution = resolveResourceContentionHeuristic(conflict);
          break;
        case 'quality_dispute':
          resolution = resolveQualityDisputeHeuristic(conflict);
          break;
        default:
          resolution = {
            conflictId: conflict.id,
            strategy: 'manual',
            description: `Unknown conflict type: ${conflict.type}`,
            actions: [{ type: 'escalate', target: 'overseer', details: 'Unknown conflict type' }],
            resolvedAt: new Date(),
            resolvedBy: 'heuristic',
          };
      }
    }

    // Mark conflict as resolved
    conflict.resolved = true;
    conflict.resolution = resolution;

    // Move from active to history
    this.activeConflicts.delete(conflict.id);
    this.conflictHistory.push({ conflict, resolution });

    // Cap history
    if (this.conflictHistory.length > 1000) {
      this.conflictHistory.splice(0, this.conflictHistory.length - 500);
    }

    // Persist
    persistConflict(conflict).catch(() => {});
    persistResolution(resolution).catch(() => {});

    broadcast('meow:feed', {
      id: uuidv4(),
      type: 'system_health',
      source: 'mayor-conflict-resolution',
      message: `Resolved ${conflict.type}: ${resolution.strategy} (${resolution.resolvedBy})`,
      severity: 'info',
      metadata: {
        conflictId: conflict.id,
        type: conflict.type,
        strategy: resolution.strategy,
        actionCount: resolution.actions.length,
      },
      timestamp: new Date(),
    });

    log.info({
      conflictId: conflict.id,
      type: conflict.type,
      strategy: resolution.strategy,
      resolvedBy: resolution.resolvedBy,
    }, 'Conflict resolved');

    return resolution;
  }

  /** Detect and resolve all conflicts in one pass */
  async resolveAll(workers?: WorkerIdentity[]): Promise<ResolutionReport> {
    const startMs = Date.now();
    const allWorkers = workers || [];

    const conflicts = await this.detectConflicts(allWorkers);

    if (conflicts.length === 0) {
      return {
        totalConflicts: 0,
        resolved: 0,
        pending: 0,
        escalated: 0,
        byType: {
          overlapping_assignment: 0,
          resource_contention: 0,
          deadline_conflict: 0,
          quality_dispute: 0,
        },
        resolutions: [],
        generatedAt: new Date(),
      };
    }

    // Try batch AI resolution first
    const aiResolutions = await aiResolve(conflicts, allWorkers);

    const resolutions: Resolution[] = [];
    let escalated = 0;

    const byType: Record<ConflictType, number> = {
      overlapping_assignment: 0,
      resource_contention: 0,
      deadline_conflict: 0,
      quality_dispute: 0,
    };

    for (const conflict of conflicts) {
      byType[conflict.type] = (byType[conflict.type] || 0) + 1;

      let resolution = aiResolutions?.get(conflict.id);

      if (!resolution) {
        resolution = await this.resolveConflict(conflict, allWorkers);
      } else {
        conflict.resolved = true;
        conflict.resolution = resolution;
        this.activeConflicts.delete(conflict.id);
        this.conflictHistory.push({ conflict, resolution });
        persistConflict(conflict).catch(() => {});
        persistResolution(resolution).catch(() => {});
      }

      resolutions.push(resolution);
      if (resolution.strategy === 'escalate_overseer') escalated++;
    }

    const durationMs = Date.now() - startMs;

    log.info({
      totalConflicts: conflicts.length,
      resolved: resolutions.length,
      escalated,
      durationMs,
    }, 'Bulk conflict resolution complete');

    return {
      totalConflicts: conflicts.length,
      resolved: resolutions.length,
      pending: this.activeConflicts.size,
      escalated,
      byType,
      resolutions,
      generatedAt: new Date(),
    };
  }

  /** Get conflict history, optionally filtered by date */
  getConflictHistory(since?: Date): ConflictRecord[] {
    if (!since) return [...this.conflictHistory];
    return this.conflictHistory.filter(
      r => r.conflict.detectedAt.getTime() >= since.getTime()
    );
  }

  /** Get active (unresolved) conflicts */
  getActiveConflicts(): Conflict[] {
    return Array.from(this.activeConflicts.values());
  }

  /** Manually register a quality dispute conflict */
  registerQualityDispute(
    executorId: string,
    reviewerId: string,
    beadId: string,
    description: string,
  ): Conflict {
    const conflict: Conflict = {
      id: `cfl-${uuidv4().slice(0, 8)}`,
      type: 'quality_dispute',
      severity: 'medium',
      description: `Quality dispute on bead ${beadId}: ${description}`,
      involvedWorkerIds: [executorId, reviewerId],
      involvedBeadIds: [beadId],
      detectedAt: new Date(),
      resolved: false,
    };

    this.activeConflicts.set(conflict.id, conflict);
    persistConflict(conflict).catch(() => {});

    broadcast('meow:feed', {
      id: uuidv4(),
      type: 'escalation',
      source: 'mayor-conflict-resolution',
      message: `Quality dispute: ${executorId} vs ${reviewerId} on bead ${beadId}`,
      severity: 'warning',
      metadata: { conflictId: conflict.id, beadId, executor: executorId, reviewer: reviewerId },
      timestamp: new Date(),
    });

    log.info({ conflictId: conflict.id, beadId, executor: executorId, reviewer: reviewerId }, 'Quality dispute registered');
    return conflict;
  }

  /** Get statistics */
  stats() {
    const byType: Record<string, number> = {};
    for (const record of this.conflictHistory) {
      byType[record.conflict.type] = (byType[record.conflict.type] || 0) + 1;
    }

    return {
      activeConflicts: this.activeConflicts.size,
      totalResolved: this.conflictHistory.length,
      byType,
      recentEscalations: this.conflictHistory
        .filter(r => r.resolution?.strategy === 'escalate_overseer')
        .slice(-10)
        .map(r => ({
          conflictId: r.conflict.id,
          type: r.conflict.type,
          detectedAt: r.conflict.detectedAt,
        })),
    };
  }
}

/** Singleton instance */
export const mayorConflictResolver = new MayorConflictResolver();
