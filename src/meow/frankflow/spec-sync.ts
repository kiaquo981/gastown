/**
 * FrankFlow Spec Sync — Spec-to-Task Bridge
 *
 * Converts markdown specification files into Gas Town beads with
 * dependency DAGs. Supports parallel [P] markers, user story [US] refs,
 * phase inference, and priority annotations.
 *
 * Ported from FrankFlow's spec-driven task decomposition system.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:spec-sync');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecTask {
  /** Task ID extracted from spec, e.g., T001 */
  id: string;
  /** Task description text */
  text: string;
  /** Can run in parallel with siblings [P] */
  parallel: boolean;
  /** User story reference [US1] */
  userStoryRef?: string;
  /** Priority 1 (highest) to 3 (lowest) */
  priority: number;
  /** Phase number (inferred from position/headers) */
  phase: number;
  /** Whether the task is already done (checked checkbox) */
  done: boolean;
  /** Raw line number in the spec file */
  lineNumber: number;
}

export interface SpecSyncResult {
  specPath: string;
  epicTitle: string;
  epicBeadId?: string;
  tasks: SpecTask[];
  beadIds: string[];
  dependencies: Array<{ from: string; to: string }>;
  created: number;
  skipped: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec Task Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Task line format:
 *   - [ ] T001 [P] [US1] [!1] Description text
 *   - [x] T002 Description text (already done)
 *
 * Flags:
 *   [P] — parallel, can run concurrently with other [P] tasks in same phase
 *   [US1], [US2] — user story reference
 *   [!1], [!2], [!3] — priority (1=critical, 2=high, 3=medium)
 *
 * Phase inference:
 *   ## Phase 1: ...  → tasks below get phase=1
 *   ### Phase 2: ... → tasks below get phase=2
 *   If no phase headers, all tasks are phase=1
 */
export function parseSpecTasks(markdown: string): SpecTask[] {
  const lines = markdown.split('\n');
  const tasks: SpecTask[] = [];
  let currentPhase = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Phase detection from headers
    const phaseMatch = line.match(/^#{1,3}\s+(?:Phase|Stage|Step)\s+(\d+)/i);
    if (phaseMatch) {
      currentPhase = parseInt(phaseMatch[1], 10);
      continue;
    }

    // Also detect numbered headers as phases: "## 1. ..."
    const numberedHeader = line.match(/^#{1,3}\s+(\d+)\.\s/);
    if (numberedHeader) {
      currentPhase = parseInt(numberedHeader[1], 10);
      continue;
    }

    // Task line detection: - [ ] or - [x] followed by task ID
    const taskMatch = line.match(/^\s*-\s+\[([ xX])\]\s+(T\d{1,4})\b\s*(.*)/);
    if (!taskMatch) continue;

    const done = taskMatch[1].toLowerCase() === 'x';
    const taskId = taskMatch[2];
    let remainder = taskMatch[3];

    // Extract flags
    const parallel = /\[P\]/i.test(remainder);
    remainder = remainder.replace(/\[P\]/gi, '').trim();

    const usMatch = remainder.match(/\[US(\d+)\]/i);
    const userStoryRef = usMatch ? `US${usMatch[1]}` : undefined;
    remainder = remainder.replace(/\[US\d+\]/gi, '').trim();

    const priorityMatch = remainder.match(/\[!(\d)\]/);
    const priority = priorityMatch ? parseInt(priorityMatch[1], 10) : 2; // default medium
    remainder = remainder.replace(/\[!\d\]/g, '').trim();

    const text = remainder.trim();

    tasks.push({
      id: taskId,
      text,
      parallel,
      userStoryRef,
      priority,
      phase: currentPhase,
      done,
      lineNumber: i + 1,
    });
  }

  log.info({ taskCount: tasks.length, phases: new Set(tasks.map(t => t.phase)).size }, 'Spec tasks parsed');
  return tasks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency Graph Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build dependency edges from spec tasks.
 *
 * Rules:
 * 1. Sequential tasks within the same phase: each depends on the previous
 *    (unless both are [P] parallel)
 * 2. Parallel [P] tasks within the same phase can run concurrently
 *    (no dependency between them)
 * 3. Cross-phase: all tasks in phase N+1 depend on the last task(s) in phase N
 */
function buildDependencies(tasks: SpecTask[]): Array<{ from: string; to: string }> {
  const deps: Array<{ from: string; to: string }> = [];

  // Group by phase
  const phases = new Map<number, SpecTask[]>();
  for (const task of tasks) {
    const group = phases.get(task.phase) || [];
    group.push(task);
    phases.set(task.phase, group);
  }

  const sortedPhases = Array.from(phases.keys()).sort((a, b) => a - b);

  for (let pi = 0; pi < sortedPhases.length; pi++) {
    const phaseNum = sortedPhases[pi];
    const phaseTasks = phases.get(phaseNum)!;

    // Within phase: sequential tasks depend on previous (unless both parallel)
    let lastSequential: string | null = null;
    for (let i = 0; i < phaseTasks.length; i++) {
      const task = phaseTasks[i];

      if (!task.parallel && lastSequential) {
        // This sequential task depends on the last sequential task
        deps.push({ from: lastSequential, to: task.id });
      }

      if (!task.parallel) {
        lastSequential = task.id;
      } else if (lastSequential && i > 0 && !phaseTasks[i - 1].parallel) {
        // Parallel task depends on last sequential before it
        deps.push({ from: lastSequential, to: task.id });
      }
    }

    // Cross-phase: first tasks of next phase depend on last tasks of this phase
    if (pi < sortedPhases.length - 1) {
      const nextPhaseNum = sortedPhases[pi + 1];
      const nextPhaseTasks = phases.get(nextPhaseNum)!;

      // Get "exit" tasks of current phase (tasks nothing else depends on within the phase)
      const hasDependents = new Set(deps.filter(d => phaseTasks.some(t => t.id === d.from)).map(d => d.from));
      const exitTasks = phaseTasks.filter(t => {
        // It's an exit task if nothing in this phase depends on it
        return !deps.some(d => d.from === t.id && phaseTasks.some(pt => pt.id === d.to));
      });

      // Get "entry" tasks of next phase (first tasks, or parallel tasks at start)
      const entryTasks: SpecTask[] = [];
      for (const task of nextPhaseTasks) {
        if (entryTasks.length === 0 || task.parallel) {
          entryTasks.push(task);
        }
        if (!task.parallel && entryTasks.length > 0) {
          if (!entryTasks.includes(task)) entryTasks.push(task);
          break;
        }
      }

      // Create cross-phase edges
      const exits = exitTasks.length > 0 ? exitTasks : [phaseTasks[phaseTasks.length - 1]];
      const entries = entryTasks.length > 0 ? entryTasks : [nextPhaseTasks[0]];

      for (const exit of exits) {
        for (const entry of entries) {
          deps.push({ from: exit.id, to: entry.id });
        }
      }
    }
  }

  return deps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bead Sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync a spec file to Gas Town beads.
 *
 * 1. Parse the spec file for tasks
 * 2. Create an epic bead (parent) with the given title
 * 3. Create child beads for each task
 * 4. Wire up dependency edges
 */
export async function syncSpecToBeads(
  specPath: string,
  epicTitle?: string,
): Promise<SpecSyncResult> {
  // Read and parse spec
  if (!fs.existsSync(specPath)) {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const markdown = fs.readFileSync(specPath, 'utf-8');
  const tasks = parseSpecTasks(markdown);
  const dependencies = buildDependencies(tasks);

  // Derive title from first H1 if not provided
  const title = epicTitle || extractTitle(markdown) || path.basename(specPath, path.extname(specPath));

  const pool = getPool();
  const beadIds: string[] = [];
  let epicBeadId: string | undefined;
  let created = 0;
  let skipped = 0;

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create epic bead
      const epicId = `bead-${uuidv4().slice(0, 8)}`;
      await client.query(
        `INSERT INTO beads (id, title, description, status, priority, executor_type, labels, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [
          epicId,
          title,
          `Auto-generated epic from spec: ${specPath}`,
          'ready',
          'high',
          'agent',
          JSON.stringify({ type: 'epic', specPath, source: 'frankflow-spec-sync' }),
          'frankflow',
        ],
      );
      epicBeadId = epicId;

      // Task ID → bead ID mapping
      const taskBeadMap = new Map<string, string>();

      // Create child beads for each task
      for (const task of tasks) {
        const beadId = `bead-${uuidv4().slice(0, 8)}`;
        taskBeadMap.set(task.id, beadId);

        const status = task.done ? 'done' : 'backlog';
        const priorityMap: Record<number, string> = { 1: 'critical', 2: 'high', 3: 'medium' };

        try {
          await client.query(
            `INSERT INTO beads (id, title, description, status, priority, executor_type, parent_id, labels, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
              beadId,
              `${task.id}: ${task.text}`,
              `Spec task from ${path.basename(specPath)} line ${task.lineNumber}`,
              status,
              priorityMap[task.priority] || 'medium',
              'agent',
              epicId,
              JSON.stringify({
                specTaskId: task.id,
                phase: task.phase,
                parallel: task.parallel,
                userStory: task.userStoryRef,
                source: 'frankflow-spec-sync',
              }),
              'frankflow',
            ],
          );

          beadIds.push(beadId);
          if (task.done) skipped++;
          else created++;
        } catch (err) {
          log.warn({ taskId: task.id, err }, 'Failed to create bead for task');
          skipped++;
        }
      }

      // Wire up dependencies
      for (const dep of dependencies) {
        const fromBead = taskBeadMap.get(dep.from);
        const toBead = taskBeadMap.get(dep.to);
        if (fromBead && toBead) {
          try {
            await client.query(
              `INSERT INTO bead_dependencies (source_id, target_id, dep_type, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT DO NOTHING`,
              [fromBead, toBead, 'blocks'],
            );
          } catch (err) {
            log.warn({ from: dep.from, to: dep.to, err }, 'Failed to create dependency');
          }
        }
      }

      await client.query('COMMIT');

      log.info(
        { epicId, title, created, skipped, dependencies: dependencies.length },
        'Spec synced to beads',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({ specPath, err }, 'Failed to sync spec to beads');
      throw err;
    } finally {
      client.release();
    }
  } else {
    log.warn('DB not available — spec parsed but beads not persisted');
    created = tasks.filter(t => !t.done).length;
    skipped = tasks.filter(t => t.done).length;
  }

  const result: SpecSyncResult = {
    specPath,
    epicTitle: title,
    epicBeadId,
    tasks,
    beadIds,
    dependencies,
    created,
    skipped,
  };

  broadcast('frankflow:spec-sync', {
    specPath,
    epicTitle: title,
    created,
    skipped,
    totalTasks: tasks.length,
  });

  return result;
}

/**
 * Get the current status of a spec file — check which tasks are done.
 */
export async function getSpecStatus(specPath: string): Promise<{
  specPath: string;
  totalTasks: number;
  doneTasks: number;
  pendingTasks: number;
  phases: Record<number, { total: number; done: number }>;
  tasks: SpecTask[];
}> {
  if (!fs.existsSync(specPath)) {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const markdown = fs.readFileSync(specPath, 'utf-8');
  const tasks = parseSpecTasks(markdown);

  const doneTasks = tasks.filter(t => t.done).length;
  const pendingTasks = tasks.length - doneTasks;

  // Phase breakdown
  const phases: Record<number, { total: number; done: number }> = {};
  for (const task of tasks) {
    if (!phases[task.phase]) {
      phases[task.phase] = { total: 0, done: 0 };
    }
    phases[task.phase].total++;
    if (task.done) phases[task.phase].done++;
  }

  return {
    specPath,
    totalTasks: tasks.length,
    doneTasks,
    pendingTasks,
    phases,
    tasks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the first H1 title from markdown.
 */
function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Validate a spec file has the expected format.
 */
export function validateSpec(markdown: string): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tasks = parseSpecTasks(markdown);

  if (tasks.length === 0) {
    errors.push('No tasks found. Expected format: - [ ] T001 Description');
  }

  // Check for duplicate task IDs
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    ids.add(task.id);
  }

  // Check for empty descriptions
  for (const task of tasks) {
    if (!task.text || task.text.trim().length === 0) {
      warnings.push(`Task ${task.id} has no description`);
    }
  }

  // Check sequential numbering
  const sortedIds = tasks.map(t => parseInt(t.id.replace('T', ''), 10)).sort((a, b) => a - b);
  for (let i = 1; i < sortedIds.length; i++) {
    if (sortedIds[i] - sortedIds[i - 1] > 1) {
      warnings.push(`Gap in task numbering between T${String(sortedIds[i - 1]).padStart(3, '0')} and T${String(sortedIds[i]).padStart(3, '0')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
