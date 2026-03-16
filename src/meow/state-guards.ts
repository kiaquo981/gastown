/**
 * State Machine Guards — EP-016
 *
 * Rigorous validation for all state transitions in the MEOW lifecycle.
 *
 * Three layers of guards:
 *   1. Phase transitions (ICE9→SOLID→LIQUID→VAPOR) via operators
 *   2. Step status transitions (pending→ready→running→done/failed)
 *   3. Molecule status transitions (pending→running→completed/failed/paused)
 *
 * Each guard returns a TransitionResult with pass/fail + reason.
 * Guards are composable and can have pre/post hooks for audit.
 */

import { createLogger } from '../lib/logger';
import { broadcast } from '../sse';
import { MEOWPhase, MEOW_TRANSITIONS } from './types';
import type { Molecule, MoleculeStep } from './types';

const log = createLogger('state-guards');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
}

type StepStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'gated' | 'skipped';
type MoleculeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

// ─────────────────────────────────────────────────────────────────────────────
// Valid Step Status Transitions
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STEP_TRANSITIONS: Record<string, StepStatus[]> = {
  pending:   ['ready', 'skipped'],
  ready:     ['running', 'gated', 'skipped', 'failed'],
  running:   ['completed', 'failed', 'ready'],            // ready = retry/reset
  gated:     ['ready', 'completed', 'failed'],            // gate pass → ready or direct complete
  completed: [],                                          // terminal
  failed:    ['ready'],                                   // retry allowed
  skipped:   [],                                          // terminal
};

// ─────────────────────────────────────────────────────────────────────────────
// Valid Molecule Status Transitions
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MOL_TRANSITIONS: Record<string, MoleculeStatus[]> = {
  pending:   ['running', 'failed'],
  running:   ['completed', 'failed', 'paused'],
  paused:    ['running', 'failed'],
  completed: [],                                          // terminal
  failed:    ['running'],                                 // restart allowed
};

// ─────────────────────────────────────────────────────────────────────────────
// Audit Trail
// ─────────────────────────────────────────────────────────────────────────────

interface TransitionEvent {
  timestamp: Date;
  entityType: 'phase' | 'step' | 'molecule';
  entityId: string;
  from: string;
  to: string;
  operator?: string;
  allowed: boolean;
  reason?: string;
}

const auditLog: TransitionEvent[] = [];
const MAX_AUDIT = 500;

function recordTransition(event: TransitionEvent): void {
  auditLog.push(event);
  if (auditLog.length > MAX_AUDIT) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT);
  }

  if (!event.allowed) {
    log.warn({
      entityType: event.entityType,
      entityId: event.entityId,
      from: event.from,
      to: event.to,
      reason: event.reason,
    }, `Transition BLOCKED: ${event.entityType} ${event.from} → ${event.to}`);

    broadcast('meow:guard', {
      type: 'transition_blocked',
      ...event,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase Transition Guards
// ─────────────────────────────────────────────────────────────────────────────

export function guardPhaseTransition(
  mol: Molecule,
  operator: string,
  targetPhase: MEOWPhase,
): TransitionResult {
  const currentPhase = mol.phase;
  const warnings: string[] = [];

  // 1. Check if transition is defined
  const allowed = MEOW_TRANSITIONS[currentPhase] || [];
  const match = allowed.find(t => t.operator === operator && t.to === targetPhase);

  if (!match) {
    const result: TransitionResult = {
      allowed: false,
      reason: `Invalid phase transition: ${currentPhase} → ${targetPhase} via "${operator}". Valid: ${allowed.map(t => `${t.operator}→${t.to}`).join(', ') || 'none'}`,
    };
    recordTransition({
      timestamp: new Date(),
      entityType: 'phase',
      entityId: mol.id,
      from: currentPhase,
      to: targetPhase,
      operator,
      allowed: false,
      reason: result.reason,
    });
    return result;
  }

  // 2. Pre-conditions per operator
  switch (operator) {
    case 'cook':
      // cook is handled at formula level, mol doesn't exist yet
      break;

    case 'pour':
      // Must be SOLID, must have steps, status must be pending
      if (mol.steps.length === 0) {
        return blocked(mol.id, 'phase', currentPhase, targetPhase, operator, 'Cannot pour: molecule has no steps');
      }
      if (mol.status !== 'pending') {
        return blocked(mol.id, 'phase', currentPhase, targetPhase, operator,
          `Cannot pour: molecule status is "${mol.status}", expected "pending"`);
      }
      break;

    case 'wisp':
      // Must be SOLID
      if (mol.status === 'running') {
        return blocked(mol.id, 'phase', currentPhase, targetPhase, operator,
          'Cannot wisp: molecule is already running');
      }
      break;

    case 'squash':
      // Must be LIQUID (squash is LIQUID→LIQUID condensation)
      if (mol.status === 'completed') {
        warnings.push('Squashing a completed molecule — digest will be final');
      }
      break;
  }

  // 3. Check for incomplete dependencies on pour
  if (operator === 'pour') {
    const unresolvedVars = findUnresolvedVars(mol);
    if (unresolvedVars.length > 0) {
      warnings.push(`Unresolved variables: ${unresolvedVars.join(', ')}`);
    }
  }

  recordTransition({
    timestamp: new Date(),
    entityType: 'phase',
    entityId: mol.id,
    from: currentPhase,
    to: targetPhase,
    operator,
    allowed: true,
  });

  return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step Status Guards
// ─────────────────────────────────────────────────────────────────────────────

export function guardStepTransition(
  mol: Molecule,
  step: MoleculeStep,
  toStatus: StepStatus,
): TransitionResult {
  const fromStatus = step.status as StepStatus;

  // 1. Check if transition is valid
  const validTargets = VALID_STEP_TRANSITIONS[fromStatus];
  if (!validTargets) {
    return blocked(step.id, 'step', fromStatus, toStatus, undefined,
      `Unknown step status: "${fromStatus}"`);
  }

  if (!validTargets.includes(toStatus)) {
    return blocked(step.id, 'step', fromStatus, toStatus, undefined,
      `Invalid step transition: ${fromStatus} → ${toStatus}. Valid: ${validTargets.join(', ') || 'none (terminal)'}`);
  }

  // 2. Molecule must be in LIQUID phase for step execution
  if (['running', 'completed'].includes(toStatus) && mol.phase !== 'liquid') {
    return blocked(step.id, 'step', fromStatus, toStatus, undefined,
      `Cannot transition step to "${toStatus}": molecule is in "${mol.phase}" phase, must be "liquid"`);
  }

  // 3. Dependencies check for ready→running
  if (toStatus === 'running' && fromStatus === 'ready') {
    const unmetDeps = checkDependencies(mol, step);
    if (unmetDeps.length > 0) {
      return blocked(step.id, 'step', fromStatus, toStatus, undefined,
        `Unmet dependencies: ${unmetDeps.join(', ')}`);
    }
  }

  // 4. Cannot complete if molecule is paused
  if (toStatus === 'completed' && mol.status === 'paused') {
    return blocked(step.id, 'step', fromStatus, toStatus, undefined,
      'Cannot complete step: molecule is paused');
  }

  const warnings: string[] = [];

  // Warn on retry (failed→ready)
  if (fromStatus === 'failed' && toStatus === 'ready') {
    warnings.push('Retrying failed step');
  }

  // Warn on reset (running→ready)
  if (fromStatus === 'running' && toStatus === 'ready') {
    warnings.push('Resetting running step back to ready');
  }

  recordTransition({
    timestamp: new Date(),
    entityType: 'step',
    entityId: step.id,
    from: fromStatus,
    to: toStatus,
    allowed: true,
  });

  return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Molecule Status Guards
// ─────────────────────────────────────────────────────────────────────────────

export function guardMoleculeStatus(
  mol: Molecule,
  toStatus: MoleculeStatus,
): TransitionResult {
  const fromStatus = mol.status as MoleculeStatus;

  // 1. Check if transition is valid
  const validTargets = VALID_MOL_TRANSITIONS[fromStatus];
  if (!validTargets) {
    return blocked(mol.id, 'molecule', fromStatus, toStatus, undefined,
      `Unknown molecule status: "${fromStatus}"`);
  }

  if (!validTargets.includes(toStatus)) {
    return blocked(mol.id, 'molecule', fromStatus, toStatus, undefined,
      `Invalid molecule transition: ${fromStatus} → ${toStatus}. Valid: ${validTargets.join(', ') || 'none (terminal)'}`);
  }

  const warnings: string[] = [];

  // 2. Completing requires all steps done/skipped
  if (toStatus === 'completed') {
    const incomplete = mol.steps.filter(s =>
      s.status !== 'completed' && s.status !== 'skipped' && s.status !== 'failed'
    );
    if (incomplete.length > 0) {
      return blocked(mol.id, 'molecule', fromStatus, toStatus, undefined,
        `Cannot complete: ${incomplete.length} step(s) still in progress (${incomplete.map(s => `${s.id}:${s.status}`).join(', ')})`);
    }

    const failed = mol.steps.filter(s => s.status === 'failed');
    if (failed.length > 0) {
      warnings.push(`Completing with ${failed.length} failed step(s)`);
    }
  }

  // 3. Pausing requires molecule to be running
  if (toStatus === 'paused') {
    const running = mol.steps.filter(s => s.status === 'running');
    if (running.length > 0) {
      warnings.push(`Pausing with ${running.length} step(s) still running — they will continue`);
    }
  }

  // 4. Restart (failed→running) warning
  if (fromStatus === 'failed' && toStatus === 'running') {
    warnings.push('Restarting failed molecule — failed steps will need manual retry');
  }

  recordTransition({
    timestamp: new Date(),
    entityType: 'molecule',
    entityId: mol.id,
    from: fromStatus,
    to: toStatus,
    allowed: true,
  });

  return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite Guard — validate full operation
// ─────────────────────────────────────────────────────────────────────────────

export function guardOperation(
  mol: Molecule,
  operator: string,
): TransitionResult {
  const warnings: string[] = [];

  switch (operator) {
    case 'pour': {
      // Phase guard
      const phaseResult = guardPhaseTransition(mol, 'pour', MEOWPhase.LIQUID);
      if (!phaseResult.allowed) return phaseResult;
      if (phaseResult.warnings) warnings.push(...phaseResult.warnings);

      // Molecule status guard
      const statusResult = guardMoleculeStatus(mol, 'running');
      if (!statusResult.allowed) return statusResult;
      if (statusResult.warnings) warnings.push(...statusResult.warnings);

      return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
    }

    case 'wisp': {
      const phaseResult = guardPhaseTransition(mol, 'wisp', MEOWPhase.VAPOR);
      if (!phaseResult.allowed) return phaseResult;
      return phaseResult;
    }

    case 'squash': {
      const phaseResult = guardPhaseTransition(mol, 'squash', MEOWPhase.LIQUID);
      if (!phaseResult.allowed) return phaseResult;
      return phaseResult;
    }

    case 'pause': {
      return guardMoleculeStatus(mol, 'paused');
    }

    case 'resume': {
      return guardMoleculeStatus(mol, 'running');
    }

    case 'complete': {
      return guardMoleculeStatus(mol, 'completed');
    }

    default:
      return { allowed: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function blocked(
  entityId: string,
  entityType: 'phase' | 'step' | 'molecule',
  from: string,
  to: string,
  operator: string | undefined,
  reason: string,
): TransitionResult {
  recordTransition({
    timestamp: new Date(),
    entityType,
    entityId,
    from,
    to,
    operator,
    allowed: false,
    reason,
  });
  return { allowed: false, reason };
}

function checkDependencies(mol: Molecule, step: MoleculeStep): string[] {
  const needs = step.needs || [];
  const unmet: string[] = [];

  for (const depId of needs) {
    const depStep = mol.steps.find(s => s.id === depId);
    if (!depStep) {
      unmet.push(`${depId} (not found)`);
    } else if (depStep.status !== 'completed' && depStep.status !== 'skipped') {
      unmet.push(`${depId} (${depStep.status})`);
    }
  }

  return unmet;
}

function findUnresolvedVars(mol: Molecule): string[] {
  const unresolved: string[] = [];

  for (const step of mol.steps) {
    // Check if step title still has {{var}} patterns
    if (step.title && /\{\{[^}]+\}\}/.test(step.title)) {
      const matches = step.title.match(/\{\{([^}]+)\}\}/g) || [];
      unresolved.push(...matches);
    }
  }

  return [...new Set(unresolved)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit API
// ─────────────────────────────────────────────────────────────────────────────

export function getAuditLog(limit = 50): TransitionEvent[] {
  return auditLog.slice(-limit);
}

export function getBlockedTransitions(limit = 20): TransitionEvent[] {
  return auditLog.filter(e => !e.allowed).slice(-limit);
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

export function getTransitionStats(): {
  total: number;
  allowed: number;
  blocked: number;
  byType: Record<string, { allowed: number; blocked: number }>;
} {
  const stats = {
    total: auditLog.length,
    allowed: 0,
    blocked: 0,
    byType: {} as Record<string, { allowed: number; blocked: number }>,
  };

  for (const event of auditLog) {
    if (event.allowed) stats.allowed++;
    else stats.blocked++;

    if (!stats.byType[event.entityType]) {
      stats.byType[event.entityType] = { allowed: 0, blocked: 0 };
    }
    if (event.allowed) stats.byType[event.entityType].allowed++;
    else stats.byType[event.entityType].blocked++;
  }

  return stats;
}
