/**
 * MoleculeRunner — Stage 02 EP-019
 *
 * Tick-based auto-execution engine for molecules.
 * Scans active molecules for ready steps, evaluates gates,
 * dispatches to workers, and auto-advances the DAG.
 *
 * Worker types:
 *   polecat — ephemeral solo agent (isolated execution)
 *   crew    — long-lived named agent (collaborative)
 *
 * Gate types:
 *   human-approval — waits for manual POST to /approve
 *   timer          — auto-passes after step timeout
 *   test-pass      — waits for external test result
 *   github-event   — waits for external webhook
 */

import { meowEngine } from './engine';
import { broadcast } from '../sse';
import { createLogger } from '../lib/logger';
import { hasSkill } from './skill-registry';
import { executeSkill } from './skill-runtime';
import type { Molecule, MoleculeStep } from './types';

const log = createLogger('molecule-runner');

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch tracking: prevents re-dispatching steps already being worked on
// ─────────────────────────────────────────────────────────────────────────────

const dispatched = new Set<string>(); // "molId:stepId"

function dispatchKey(molId: string, stepId: string): string {
  return `${molId}:${stepId}`;
}

// Gate approvals waiting for manual intervention
const pendingApprovals = new Map<string, { moleculeId: string; stepId: string; requestedAt: Date }>();

// Timer gates: scheduled auto-pass
const timerGates = new Map<string, NodeJS.Timeout>();

// ─────────────────────────────────────────────────────────────────────────────
// Gate Evaluation
// ─────────────────────────────────────────────────────────────────────────────

type GateResult = 'pass' | 'wait' | 'fail';

function evaluateGate(mol: Molecule, step: MoleculeStep): GateResult {
  if (!step.gate) return 'pass';

  const key = dispatchKey(mol.id, step.id);

  switch (step.gate) {
    case 'human-approval':
      // Always wait — requires explicit approval via approveGate()
      if (!pendingApprovals.has(key)) {
        pendingApprovals.set(key, {
          moleculeId: mol.id,
          stepId: step.id,
          requestedAt: new Date(),
        });
        log.info({ moleculeId: mol.id, stepId: step.id }, 'Gate: human-approval requested');
        broadcast('meow:gate', {
          type: 'approval_requested',
          moleculeId: mol.id,
          stepId: step.id,
          stepTitle: step.title,
        });
      }
      return 'wait';

    case 'timer': {
      // Auto-pass after step startedAt + timeout (default 60s)
      if (step.startedAt) {
        const elapsed = Date.now() - new Date(step.startedAt).getTime();
        const timeout = ((step as unknown as { timeout?: number }).timeout) || 60;
        if (elapsed >= timeout * 1000) return 'pass';
      }
      return 'wait';
    }

    case 'test-pass':
      // Wait for external test result — same as human-approval pattern
      if (!pendingApprovals.has(key)) {
        pendingApprovals.set(key, {
          moleculeId: mol.id,
          stepId: step.id,
          requestedAt: new Date(),
        });
        log.info({ moleculeId: mol.id, stepId: step.id }, 'Gate: test-pass waiting');
      }
      return 'wait';

    case 'github-event':
      // Wait for external webhook
      if (!pendingApprovals.has(key)) {
        pendingApprovals.set(key, {
          moleculeId: mol.id,
          stepId: step.id,
          requestedAt: new Date(),
        });
        log.info({ moleculeId: mol.id, stepId: step.id }, 'Gate: github-event waiting');
      }
      return 'wait';

    default:
      return 'pass';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step Dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function dispatchStep(mol: Molecule, step: MoleculeStep): Promise<void> {
  const key = dispatchKey(mol.id, step.id);
  if (dispatched.has(key)) return;

  // Evaluate gate before dispatching
  const gateResult = evaluateGate(mol, step);

  if (gateResult === 'wait') {
    // Mark step as gated (not running)
    if (step.status !== 'gated') {
      step.status = 'gated';
      step.startedAt = step.startedAt || new Date();
      // Persist the gated state
      try {
        // We use a lightweight update — the engine's completeStep will handle full persist
        await meowEngine.emitEvent({
          type: 'polecat_spawned',
          source: 'molecule-runner',
          moleculeId: mol.id,
          message: `Step gated (${step.gate}): ${step.title}`,
          severity: 'info',
          metadata: { stepId: step.id, gate: step.gate },
        });
      } catch (err) {
        log.error({ err, moleculeId: mol.id, stepId: step.id }, 'Failed to emit gate event');
      }
    }
    return;
  }

  if (gateResult === 'fail') {
    dispatched.add(key);
    try {
      await meowEngine.failStep(mol.id, step.id, `Gate "${step.gate}" failed`);
    } catch (err) {
      log.error({ err, moleculeId: mol.id, stepId: step.id }, 'Failed to fail gated step');
    }
    dispatched.delete(key);
    return;
  }

  // Gate passed — dispatch to worker
  dispatched.add(key);

  log.info(
    { moleculeId: mol.id, stepId: step.id, type: step.type, skill: step.skill },
    `Dispatching step: ${step.title}`
  );

  await meowEngine.emitEvent({
    type: 'polecat_spawned',
    source: 'molecule-runner',
    moleculeId: mol.id,
    message: `Step dispatched (${step.type}): ${step.title}${step.skill ? ` [skill: ${step.skill}]` : ''}`,
    severity: 'info',
    metadata: { stepId: step.id, type: step.type, skill: step.skill },
  });

  broadcast('meow:dispatch', {
    type: 'step_dispatched',
    moleculeId: mol.id,
    stepId: step.id,
    stepTitle: step.title,
    workerType: step.type,
    skill: step.skill,
  });

  // Execution modes (in priority order):
  // 1. If step has a skill → execute via Skills Engine
  // 2. If simulate mode → auto-complete after delay
  // 3. Otherwise → wait for external worker (polecat/crew)

  if (step.skill) {
    // Skills Engine execution
    executeStepSkill(mol.id, step).catch(err => {
      log.error({ err, moleculeId: mol.id, stepId: step.id }, 'Skill execution error');
    });
  } else if (simulateMode) {
    const delay = 2000 + Math.random() * 3000; // 2-5s
    setTimeout(async () => {
      try {
        await meowEngine.completeStep(mol.id, step.id, {
          simulatedAt: new Date().toISOString(),
          runner: 'molecule-runner:simulate',
        });
        log.info({ moleculeId: mol.id, stepId: step.id }, 'Step auto-completed (simulate)');
      } catch (err) {
        log.warn({ err, moleculeId: mol.id, stepId: step.id }, 'Simulate auto-complete failed');
      } finally {
        dispatched.delete(key);
      }
    }, delay);
  }
  // else: external worker picks it up via API
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Execution Bridge — EP-104
// ─────────────────────────────────────────────────────────────────────────────

async function executeStepSkill(moleculeId: string, step: MoleculeStep): Promise<void> {
  const key = dispatchKey(moleculeId, step.id);

  if (!step.skill || !hasSkill(step.skill)) {
    log.warn({ moleculeId, stepId: step.id, skill: step.skill }, 'Skill not found in registry — waiting for external worker');
    return;
  }

  log.info({ moleculeId, stepId: step.id, skill: step.skill }, `Executing skill: ${step.skill}`);

  try {
    const result = await executeSkill(step.skill, {
      moleculeId,
      stepId: step.id,
      stepName: step.title,
      inputs: ((step as unknown as { inputs?: Record<string, unknown> }).inputs) || {},
      vars: ((step as unknown as { vars?: Record<string, unknown> }).vars) || {},
    });

    if (result.success) {
      await meowEngine.completeStep(moleculeId, step.id, {
        skillResult: result.outputs,
        skillLogs: result.logs,
        durationMs: result.durationMs,
        runtime: result.runtime,
        runner: 'molecule-runner:skill',
      });
      log.info({ moleculeId, stepId: step.id, skill: step.skill, durationMs: result.durationMs }, 'Skill step completed');
    } else {
      await meowEngine.failStep(moleculeId, step.id, result.error || 'Skill execution failed');
      log.warn({ moleculeId, stepId: step.id, skill: step.skill, error: result.error }, 'Skill step failed');
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err, moleculeId, stepId: step.id, skill: step.skill }, 'Skill execution exception');
    try {
      await meowEngine.failStep(moleculeId, step.id, `Skill exception: ${error}`);
    } catch {
      // ignore double-fail
    }
  } finally {
    dispatched.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick — the core scanning loop
// ─────────────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  try {
    // Fetch all running molecules
    const molecules = await meowEngine.listMolecules({ status: 'running', limit: 100 });

    for (const mol of molecules) {
      // Find ready steps that haven't been dispatched yet
      for (const step of mol.steps) {
        if (step.status === 'ready') {
          const key = dispatchKey(mol.id, step.id);
          if (!dispatched.has(key)) {
            await dispatchStep(mol, step);
          }
        }

        // Re-evaluate gated steps (timer gates may have elapsed)
        if (step.status === 'gated' && step.gate === 'timer') {
          const gate = evaluateGate(mol, step);
          if (gate === 'pass') {
            const key = dispatchKey(mol.id, step.id);
            step.status = 'ready'; // promote back to ready
            pendingApprovals.delete(key);
            await dispatchStep(mol, step);
          }
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Tick failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let tickTimer: ReturnType<typeof setInterval> | null = null;
let simulateMode = false;

export function startRunner(intervalMs = 10_000, simulate = false): void {
  if (tickTimer) return;
  simulateMode = simulate;
  log.info({ intervalMs, simulate }, 'MoleculeRunner started');

  // Initial recovery
  recover().catch(err => log.error({ err }, 'Recovery failed'));

  // Start ticking
  tickTimer = setInterval(tick, intervalMs);

  // Also tick immediately
  tick().catch(err => log.error({ err }, 'Initial tick failed'));
}

export function stopRunner(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  // Clear all timer gates
  for (const [, timer] of timerGates) {
    clearTimeout(timer);
  }
  timerGates.clear();
  dispatched.clear();
  pendingApprovals.clear();
  log.info('MoleculeRunner stopped');
}

export function isRunnerActive(): boolean {
  return tickTimer !== null;
}

export function getRunnerStatus(): {
  active: boolean;
  simulate: boolean;
  dispatchedCount: number;
  pendingGates: Array<{ moleculeId: string; stepId: string; gate: string; requestedAt: Date }>;
} {
  const gates: Array<{ moleculeId: string; stepId: string; gate: string; requestedAt: Date }> = [];
  for (const [key, val] of pendingApprovals) {
    gates.push({ ...val, gate: key });
  }
  return {
    active: tickTimer !== null,
    simulate: simulateMode,
    dispatchedCount: dispatched.size,
    pendingGates: gates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Approval — external actors call this to pass a gate
// ─────────────────────────────────────────────────────────────────────────────

export async function approveGate(moleculeId: string, stepId: string): Promise<boolean> {
  const key = dispatchKey(moleculeId, stepId);
  if (!pendingApprovals.has(key)) {
    log.warn({ moleculeId, stepId }, 'No pending approval found');
    return false;
  }

  pendingApprovals.delete(key);

  log.info({ moleculeId, stepId }, 'Gate approved');

  // Now complete the step (gate passed)
  try {
    await meowEngine.completeStep(moleculeId, stepId, {
      gateApprovedAt: new Date().toISOString(),
      gateType: 'manual-approval',
    });
    dispatched.delete(key);
    return true;
  } catch (err) {
    log.error({ err, moleculeId, stepId }, 'Failed to complete gate-approved step');
    dispatched.delete(key);
    return false;
  }
}

export async function rejectGate(moleculeId: string, stepId: string, reason: string): Promise<boolean> {
  const key = dispatchKey(moleculeId, stepId);
  pendingApprovals.delete(key);

  try {
    await meowEngine.failStep(moleculeId, stepId, `Gate rejected: ${reason}`);
    dispatched.delete(key);
    return true;
  } catch (err) {
    log.error({ err, moleculeId, stepId }, 'Failed to fail gate-rejected step');
    dispatched.delete(key);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery — on restart, reset stale 'running' steps back to 'ready'
// ─────────────────────────────────────────────────────────────────────────────

async function recover(): Promise<void> {
  log.info('Recovering in-progress molecules...');
  try {
    const molecules = await meowEngine.listMolecules({ status: 'running', limit: 200 });
    let recovered = 0;

    for (const mol of molecules) {
      let changed = false;
      for (const step of mol.steps) {
        // Steps stuck in 'running' from a previous process should be reset to 'ready'
        if (step.status === 'running') {
          step.status = 'ready';
          step.startedAt = undefined;
          step.assignee = undefined;
          changed = true;
          recovered++;
          log.info({ moleculeId: mol.id, stepId: step.id }, 'Recovered stale running step → ready');
        }
        // Gated steps stay gated — they need explicit approval
      }

      if (changed) {
        await meowEngine.emitEvent({
          type: 'system_health',
          source: 'molecule-runner',
          moleculeId: mol.id,
          message: `Recovered stale steps after restart`,
          severity: 'warning',
        });
      }
    }

    if (recovered > 0) {
      log.info({ recovered }, 'Recovery complete');
    } else {
      log.info('No stale steps to recover');
    }
  } catch (err) {
    log.error({ err }, 'Recovery scan failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual dispatch — force-run a specific step
// ─────────────────────────────────────────────────────────────────────────────

export async function manualDispatch(moleculeId: string, stepId: string): Promise<boolean> {
  const mol = await meowEngine.getMolecule(moleculeId);
  if (!mol) return false;

  const step = mol.steps.find(s => s.id === stepId);
  if (!step) return false;
  if (step.status !== 'ready' && step.status !== 'gated') return false;

  // Force dispatch (skip gate)
  const key = dispatchKey(moleculeId, stepId);
  pendingApprovals.delete(key);
  dispatched.delete(key);
  step.status = 'ready';

  await dispatchStep(mol, step);
  return true;
}
