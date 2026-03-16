/**
 * MEOW Engine — Stage 02
 *
 * Core engine managing the lifecycle of molecular work.
 * Formula (TOML) → Protomolecule (SOLID) → Molecule (LIQUID) → Wisp (VAPOR)
 *
 * Operators: cook, pour, wisp, squash, burn
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client';
import { broadcast } from '../sse';
import { createLogger } from '../lib/logger';
import { parseFormula, validateFormula, substituteVars, readySteps as computeReadySteps } from './formula-parser';
import type {
  Molecule,
  MoleculeStep,
  MoleculeStepStatus,
  MoleculeStatus,
  MEOWPhase,
  Wisp,
  Convoy,
  ConvoyStatus,
  FeedEvent,
  FeedEventType,
  FormulaStep,
} from './types';

const log = createLogger('meow-engine');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory wisp store (wisps are ephemeral — DB is just tracking)
// ─────────────────────────────────────────────────────────────────────────────

const wispStore = new Map<string, Wisp>();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate short IDs
// ─────────────────────────────────────────────────────────────────────────────

function moleculeId(): string {
  return `mol-${uuidv4().slice(0, 8)}`;
}

function wispId(): string {
  return `wsp-${uuidv4().slice(0, 8)}`;
}

function convoyId(): string {
  return `cvy-${uuidv4().slice(0, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: FormulaStep → MoleculeStep
// ─────────────────────────────────────────────────────────────────────────────

function formulaStepToMoleculeStep(fs: FormulaStep): MoleculeStep {
  return {
    id: fs.id,
    title: fs.title,
    skill: fs.skill,
    needs: [...fs.needs],
    type: fs.type,
    gate: fs.gate,
    status: 'pending' as MoleculeStepStatus,
    retryCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: DB row → Molecule
// ─────────────────────────────────────────────────────────────────────────────

function rowToMolecule(row: Record<string, unknown>): Molecule {
  return {
    id: row.id as string,
    formulaName: row.formula_name as string,
    formulaVersion: row.formula_version as number,
    phase: row.phase as MEOWPhase,
    status: row.status as MoleculeStatus,
    steps: (row.steps as MoleculeStep[]) || [],
    vars: (row.vars as Record<string, string>) || {},
    convoyId: row.convoy_id as string | undefined,
    completedSteps: (row.completed_steps as string[]) || [],
    currentSteps: (row.current_steps as string[]) || [],
    error: row.error as string | undefined,
    digest: row.digest as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
  };
}

function rowToConvoy(row: Record<string, unknown>): Convoy {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | undefined,
    status: row.status as ConvoyStatus,
    beadIds: (row.bead_ids as string[]) || [],
    moleculeIds: (row.molecule_ids as string[]) || [],
    createdBy: row.created_by as string,
    assignedRig: row.assigned_rig as string | undefined,
    createdAt: new Date(row.created_at as string),
    dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at as string) : undefined,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string) : undefined,
    progress: row.progress as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MEOWEngine
// ─────────────────────────────────────────────────────────────────────────────

export class MEOWEngine {

  // ── cook: Formula (ICE9) → Protomolecule (SOLID) ──────────────────────────

  async cook(formulaContent: string, vars: Record<string, string> = {}): Promise<Molecule> {
    log.info({ vars: Object.keys(vars) }, 'Cooking formula');

    // Parse
    const formula = parseFormula(formulaContent);

    // Validate
    const validation = validateFormula(formula);
    if (!validation.valid) {
      const errMsg = `Formula validation failed: ${validation.errors.join('; ')}`;
      log.error(errMsg);
      throw new Error(errMsg);
    }

    // Substitute variables
    const resolved = substituteVars(formula, vars);

    // Build molecule steps from formula steps (including legs for convoy)
    const allFormulaSteps: FormulaStep[] = [...resolved.steps];
    if (resolved.legs) {
      for (const leg of resolved.legs) {
        allFormulaSteps.push(...leg.steps);
      }
    }
    if (resolved.synthesis) {
      allFormulaSteps.push(resolved.synthesis);
    }

    const moleculeSteps = allFormulaSteps.map(formulaStepToMoleculeStep);

    const mol: Molecule = {
      id: moleculeId(),
      formulaName: resolved.name,
      formulaVersion: resolved.version,
      phase: 'solid' as MEOWPhase,
      status: 'pending',
      steps: moleculeSteps,
      vars,
      completedSteps: [],
      currentSteps: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Persist
    await this.persistMolecule(mol);

    await this.emitEvent({
      type: 'molecule_started',
      source: 'meow-engine',
      moleculeId: mol.id,
      message: `Protomolecule cooked: ${resolved.name} v${resolved.version} (${moleculeSteps.length} steps)`,
      severity: 'info',
    });

    log.info({ id: mol.id, name: resolved.name, steps: moleculeSteps.length }, 'Protomolecule cooked (SOLID)');
    return mol;
  }

  // ── pour: Protomolecule (SOLID) → Molecule (LIQUID) ───────────────────────

  async pour(protoId: string): Promise<Molecule> {
    const mol = await this.getMolecule(protoId);
    if (!mol) throw new Error(`Molecule ${protoId} not found`);
    if (mol.phase !== 'solid') throw new Error(`Cannot pour: molecule is in "${mol.phase}" phase, expected "solid"`);

    // Transition to LIQUID
    mol.phase = 'liquid' as MEOWPhase;
    mol.status = 'running';
    mol.updatedAt = new Date();

    // Mark initial ready steps
    const ready = this.computeReady(mol);
    for (const step of mol.steps) {
      if (ready.includes(step.id)) {
        step.status = 'ready';
      }
    }
    mol.currentSteps = ready;

    await this.persistMolecule(mol);

    await this.emitEvent({
      type: 'molecule_started',
      source: 'meow-engine',
      moleculeId: mol.id,
      message: `Molecule poured (LIQUID): ${mol.formulaName} — ${ready.length} steps ready`,
      severity: 'info',
    });

    log.info({ id: mol.id, readySteps: ready }, 'Molecule poured (LIQUID)');
    return mol;
  }

  // ── wisp: Protomolecule (SOLID) → Wisp (VAPOR) ───────────────────────────

  async wisp(protoId: string, ttlMs: number = 3_600_000): Promise<Wisp> {
    const mol = await this.getMolecule(protoId);
    if (!mol) throw new Error(`Molecule ${protoId} not found`);
    if (mol.phase !== 'solid') throw new Error(`Cannot wisp: molecule is in "${mol.phase}" phase, expected "solid"`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const w: Wisp = {
      ...mol,
      id: wispId(),
      phase: 'vapor' as typeof w.phase,
      status: 'running',
      ttlMs,
      expiresAt,
      updatedAt: now,
    };

    // Mark initial ready steps
    const ready = this.computeReady(w);
    for (const step of w.steps) {
      if (ready.includes(step.id)) {
        step.status = 'ready';
      }
    }
    w.currentSteps = ready;

    // Store in memory
    wispStore.set(w.id, w);

    // Also persist to DB for tracking
    await this.persistWisp(w);

    // Remove the source protomolecule (it was consumed)
    await this.deleteMolecule(protoId);

    await this.emitEvent({
      type: 'molecule_started',
      source: 'meow-engine',
      moleculeId: w.id,
      message: `Wisp created (VAPOR): ${w.formulaName} — TTL ${Math.round(ttlMs / 1000)}s, expires ${expiresAt.toISOString()}`,
      severity: 'info',
    });

    log.info({ id: w.id, ttlMs, expiresAt }, 'Wisp created (VAPOR)');
    return w;
  }

  // ── squash: Condense molecule into digest summary ─────────────────────────

  async squash(moleculeId: string): Promise<Molecule> {
    const mol = await this.getMolecule(moleculeId);
    if (!mol) throw new Error(`Molecule ${moleculeId} not found`);

    const completed = mol.steps.filter(s => s.status === 'completed');
    const failed = mol.steps.filter(s => s.status === 'failed');
    const pending = mol.steps.filter(s => s.status === 'pending' || s.status === 'ready');

    const digest = [
      `## ${mol.formulaName} v${mol.formulaVersion}`,
      `**Phase:** ${mol.phase} | **Status:** ${mol.status}`,
      `**Steps:** ${completed.length} completed, ${failed.length} failed, ${pending.length} pending`,
      '',
      completed.length > 0 ? `### Completed\n${completed.map(s => `- [x] ${s.title}`).join('\n')}` : '',
      failed.length > 0 ? `### Failed\n${failed.map(s => `- [!] ${s.title}: ${s.error || 'unknown'}`).join('\n')}` : '',
      pending.length > 0 ? `### Pending\n${pending.map(s => `- [ ] ${s.title}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    mol.digest = digest;
    mol.updatedAt = new Date();

    await this.persistMolecule(mol);

    log.info({ id: mol.id, digestLen: digest.length }, 'Molecule squashed');
    return mol;
  }

  // ── burn: Delete wisp ─────────────────────────────────────────────────────

  async burn(wispIdStr: string): Promise<void> {
    wispStore.delete(wispIdStr);

    const pool = getPool();
    if (pool) {
      try {
        await pool.query('DELETE FROM wisps WHERE id = $1', [wispIdStr]);
      } catch (err) {
        log.error({ err, wispId: wispIdStr }, 'Failed to delete wisp from DB');
      }
    }

    log.info({ id: wispIdStr }, 'Wisp burned');
  }

  // ── getReadySteps ─────────────────────────────────────────────────────────

  async getReadySteps(moleculeId: string): Promise<MoleculeStep[]> {
    const mol = await this.getMolecule(moleculeId);
    if (!mol) throw new Error(`Molecule ${moleculeId} not found`);

    const readyIds = this.computeReady(mol);
    return mol.steps.filter(s => readyIds.includes(s.id));
  }

  // ── completeStep ──────────────────────────────────────────────────────────

  async completeStep(mId: string, stepId: string, output?: Record<string, unknown>): Promise<Molecule> {
    // For wisps (in-memory), no DB transaction needed
    const wispMol = wispStore.get(mId);
    if (wispMol) {
      return this._doCompleteStep(wispMol, stepId, output);
    }

    // For DB-backed molecules, use a transaction with row-level lock to prevent race conditions
    const pool = getPool();
    if (!pool) {
      const mol = await this.getMoleculeOrWisp(mId);
      if (!mol) throw new Error(`Molecule ${mId} not found`);
      return this._doCompleteStep(mol, stepId, output);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM molecules WHERE id = $1 FOR UPDATE', [mId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Molecule ${mId} not found`);
      }
      const mol = rowToMolecule(rows[0]);
      const result = await this._doCompleteStep(mol, stepId, output, client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Inner logic for completeStep, optionally using a transaction client */
  private async _doCompleteStep(
    mol: Molecule,
    stepId: string,
    output?: Record<string, unknown>,
    txClient?: { query(text: string, values?: unknown[]): Promise<unknown> },
  ): Promise<Molecule> {
    const step = mol.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step "${stepId}" not found in molecule ${mol.id}`);
    if (step.status === 'completed') throw new Error(`Step "${stepId}" already completed`);

    step.status = 'completed';
    step.completedAt = new Date();
    step.output = output;

    mol.completedSteps = [...new Set([...mol.completedSteps, stepId])];
    mol.currentSteps = mol.currentSteps.filter(s => s !== stepId);

    // Check if all steps are done
    const allDone = mol.steps.every(s => s.status === 'completed' || s.status === 'skipped');
    if (allDone) {
      mol.status = 'completed';
      mol.completedAt = new Date();
    } else {
      // Compute newly ready steps
      const readyIds = this.computeReady(mol);
      for (const s of mol.steps) {
        if (readyIds.includes(s.id) && s.status === 'pending') {
          s.status = 'ready';
        }
      }
      mol.currentSteps = [...new Set([...mol.currentSteps, ...readyIds])];
    }

    mol.updatedAt = new Date();

    // Persist
    if (this.isWisp(mol)) {
      wispStore.set(mol.id, mol as Wisp);
      await this.persistWisp(mol as Wisp);
    } else {
      await this.persistMolecule(mol, txClient);
    }

    await this.emitEvent({
      type: allDone ? 'molecule_completed' : 'molecule_step_completed',
      source: 'meow-engine',
      moleculeId: mol.id,
      message: allDone
        ? `Molecule completed: ${mol.formulaName}`
        : `Step completed: ${step.title} (${mol.completedSteps.length}/${mol.steps.length})`,
      severity: 'info',
      metadata: { stepId, output },
    });

    log.info({ moleculeId: mol.id, stepId, allDone }, 'Step completed');
    return mol;
  }

  // ── failStep ──────────────────────────────────────────────────────────────

  async failStep(mId: string, stepId: string, error: string): Promise<Molecule> {
    // For wisps (in-memory), no DB transaction needed
    const wispMol = wispStore.get(mId);
    if (wispMol) {
      return this._doFailStep(wispMol, stepId, error);
    }

    // For DB-backed molecules, use a transaction with row-level lock to prevent race conditions
    const pool = getPool();
    if (!pool) {
      const mol = await this.getMoleculeOrWisp(mId);
      if (!mol) throw new Error(`Molecule ${mId} not found`);
      return this._doFailStep(mol, stepId, error);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM molecules WHERE id = $1 FOR UPDATE', [mId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error(`Molecule ${mId} not found`);
      }
      const mol = rowToMolecule(rows[0]);
      const result = await this._doFailStep(mol, stepId, error, client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Inner logic for failStep, optionally using a transaction client */
  private async _doFailStep(
    mol: Molecule,
    stepId: string,
    error: string,
    txClient?: { query(text: string, values?: unknown[]): Promise<unknown> },
  ): Promise<Molecule> {
    const step = mol.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step "${stepId}" not found in molecule ${mol.id}`);
    if (step.status === 'failed') throw new Error(`Step "${stepId}" already failed`);

    step.status = 'failed';
    step.error = error;
    step.retryCount += 1;

    mol.currentSteps = mol.currentSteps.filter(s => s !== stepId);
    mol.status = 'failed';
    mol.error = `Step "${stepId}" failed: ${error}`;
    mol.updatedAt = new Date();

    if (this.isWisp(mol)) {
      wispStore.set(mol.id, mol as Wisp);
      await this.persistWisp(mol as Wisp);
    } else {
      await this.persistMolecule(mol, txClient);
    }

    await this.emitEvent({
      type: 'molecule_failed',
      source: 'meow-engine',
      moleculeId: mol.id,
      message: `Step failed: ${step.title} — ${error}`,
      severity: 'error',
      metadata: { stepId, error, retryCount: step.retryCount },
    });

    log.error({ moleculeId: mol.id, stepId, error }, 'Step failed');
    return mol;
  }

  // ── getMolecule ───────────────────────────────────────────────────────────

  async getMolecule(id: string): Promise<Molecule | null> {
    // Check wisp store first
    const w = wispStore.get(id);
    if (w) return w;

    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query('SELECT * FROM molecules WHERE id = $1', [id]);
      if (rows.length === 0) return null;
      return rowToMolecule(rows[0]);
    } catch (err) {
      log.error({ err, id }, 'Failed to get molecule');
      return null;
    }
  }

  // ── listMolecules ─────────────────────────────────────────────────────────

  async listMolecules(filters?: {
    phase?: string;
    status?: string;
    formulaName?: string;
    limit?: number;
    offset?: number;
  }): Promise<Molecule[]> {
    const pool = getPool();
    if (!pool) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.phase) {
      conditions.push(`phase = $${paramIdx++}`);
      params.push(filters.phase);
    }
    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters?.formulaName) {
      conditions.push(`formula_name = $${paramIdx++}`);
      params.push(filters.formulaName);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    try {
      const { rows } = await pool.query(
        `SELECT * FROM molecules ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      );
      return rows.map(rowToMolecule);
    } catch (err) {
      log.error({ err }, 'Failed to list molecules');
      return [];
    }
  }

  // ── Convoy operations ─────────────────────────────────────────────────────

  async getConvoy(id: string): Promise<Convoy | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query('SELECT * FROM convoys WHERE id = $1', [id]);
      if (rows.length === 0) return null;
      return rowToConvoy(rows[0]);
    } catch (err) {
      log.error({ err, id }, 'Failed to get convoy');
      return null;
    }
  }

  async listConvoys(filters?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<Convoy[]> {
    const pool = getPool();
    if (!pool) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    try {
      const { rows } = await pool.query(
        `SELECT * FROM convoys ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      );
      return rows.map(rowToConvoy);
    } catch (err) {
      log.error({ err }, 'Failed to list convoys');
      return [];
    }
  }

  // ── Feed events ───────────────────────────────────────────────────────────

  async emitEvent(event: Partial<FeedEvent>): Promise<void> {
    const full: FeedEvent = {
      id: uuidv4(),
      type: (event.type || 'system_health') as FeedEventType,
      source: event.source || 'meow-engine',
      rig: event.rig,
      beadId: event.beadId,
      moleculeId: event.moleculeId,
      convoyId: event.convoyId,
      message: event.message || '',
      severity: event.severity || 'info',
      metadata: event.metadata,
      timestamp: new Date(),
    };

    // Persist
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO feed_events (type, source, rig, bead_id, molecule_id, convoy_id, message, severity, metadata, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            full.type, full.source, full.rig, full.beadId, full.moleculeId,
            full.convoyId, full.message, full.severity,
            full.metadata ? JSON.stringify(full.metadata) : null, full.timestamp,
          ]
        );
      } catch (err) {
        log.error({ err }, 'Failed to persist feed event');
      }
    }

    // SSE broadcast
    broadcast('meow:feed', full);
  }

  async getFeedEvents(filters?: {
    type?: string;
    rig?: string;
    moleculeId?: string;
    limit?: number;
    offset?: number;
  }): Promise<FeedEvent[]> {
    const pool = getPool();
    if (!pool) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.type) {
      conditions.push(`type = $${paramIdx++}`);
      params.push(filters.type);
    }
    if (filters?.rig) {
      conditions.push(`rig = $${paramIdx++}`);
      params.push(filters.rig);
    }
    if (filters?.moleculeId) {
      conditions.push(`molecule_id = $${paramIdx++}`);
      params.push(filters.moleculeId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    try {
      const { rows } = await pool.query(
        `SELECT * FROM feed_events ${where} ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        [...params, limit, offset]
      );
      return rows.map(row => ({
        id: String(row.id),
        type: row.type as FeedEventType,
        source: row.source as string,
        rig: row.rig as string | undefined,
        beadId: row.bead_id as string | undefined,
        moleculeId: row.molecule_id as string | undefined,
        convoyId: row.convoy_id as string | undefined,
        message: row.message as string,
        severity: row.severity as FeedEvent['severity'],
        metadata: row.metadata as Record<string, unknown> | undefined,
        timestamp: new Date(row.timestamp as string),
      }));
    } catch (err) {
      log.error({ err }, 'Failed to get feed events');
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private computeReady(mol: Molecule): string[] {
    const completedSet = new Set(mol.completedSteps);
    return mol.steps
      .filter(s => {
        if (completedSet.has(s.id)) return false;
        if (s.status === 'completed' || s.status === 'failed' || s.status === 'running' || s.status === 'gated') return false;
        return s.needs.every(n => completedSet.has(n));
      })
      .map(s => s.id);
  }

  private isWisp(mol: Molecule): mol is Wisp {
    return mol.phase === 'vapor' && 'ttlMs' in mol;
  }

  private async getMoleculeOrWisp(id: string): Promise<Molecule | null> {
    // Check wisp store
    const w = wispStore.get(id);
    if (w) return w;

    // Check DB
    return this.getMolecule(id);
  }

  private async persistMolecule(mol: Molecule, client?: { query(text: string, values?: unknown[]): Promise<unknown> }): Promise<void> {
    const queryable = client || getPool();
    if (!queryable) {
      log.warn({ id: mol.id }, 'No DB pool — molecule not persisted');
      return;
    }

    try {
      await queryable.query(
        `INSERT INTO molecules (id, formula_name, formula_version, phase, status, steps, vars, convoy_id, completed_steps, current_steps, error, digest, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           phase = EXCLUDED.phase,
           status = EXCLUDED.status,
           steps = EXCLUDED.steps,
           vars = EXCLUDED.vars,
           convoy_id = EXCLUDED.convoy_id,
           completed_steps = EXCLUDED.completed_steps,
           current_steps = EXCLUDED.current_steps,
           error = EXCLUDED.error,
           digest = EXCLUDED.digest,
           updated_at = EXCLUDED.updated_at,
           completed_at = EXCLUDED.completed_at`,
        [
          mol.id, mol.formulaName, mol.formulaVersion, mol.phase, mol.status,
          JSON.stringify(mol.steps), JSON.stringify(mol.vars), mol.convoyId || null,
          mol.completedSteps, mol.currentSteps, mol.error || null, mol.digest || null,
          mol.createdAt, mol.updatedAt, mol.completedAt || null,
        ]
      );
    } catch (err) {
      log.error({ err, id: mol.id }, 'Failed to persist molecule');
      throw err;
    }
  }

  private async persistWisp(w: Wisp): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO wisps (id, formula_name, formula_version, phase, status, steps, vars, convoy_id, completed_steps, current_steps, error, digest, ttl_ms, expires_at, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           steps = EXCLUDED.steps,
           completed_steps = EXCLUDED.completed_steps,
           current_steps = EXCLUDED.current_steps,
           error = EXCLUDED.error,
           digest = EXCLUDED.digest,
           updated_at = EXCLUDED.updated_at,
           completed_at = EXCLUDED.completed_at`,
        [
          w.id, w.formulaName, w.formulaVersion, w.phase, w.status,
          JSON.stringify(w.steps), JSON.stringify(w.vars), w.convoyId || null,
          w.completedSteps, w.currentSteps, w.error || null, w.digest || null,
          w.ttlMs, w.expiresAt, w.createdAt, w.updatedAt, w.completedAt || null,
        ]
      );
    } catch (err) {
      log.error({ err, id: w.id }, 'Failed to persist wisp');
    }
  }

  private async deleteMolecule(id: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query('DELETE FROM molecules WHERE id = $1', [id]);
    } catch (err) {
      log.error({ err, id }, 'Failed to delete molecule');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────────────────────

export const meowEngine = new MEOWEngine();
