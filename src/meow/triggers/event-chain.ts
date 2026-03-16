/**
 * LP-024 — Event Chain Trigger
 *
 * When a molecule completes, check if it's part of a chain and fire the next molecule.
 * Chain definition: moleculeA completes -> start moleculeB after delay.
 *
 * Built-in chains:
 *   - campaign-launch -> monitoring (starts immediately after launch)
 *   - monitoring -> audit (starts 7 days after monitoring begins)
 *
 * Stores chains in-memory Map + DB persistence.
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { meowEngine } from '../engine';
import { createLogger } from '../../lib/logger';
import type { FeedEvent } from '../types';

const log = createLogger('event-chain');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChainDef {
  id: string;
  /** Formula name that triggers this chain when completed */
  fromFormula: string;
  /** Formula name to fire next */
  toFormula: string;
  /** Delay in ms before firing the next molecule (0 = immediate) */
  delayMs: number;
  /** Map vars from the completed molecule to the next molecule's vars */
  varMapping: Record<string, string>;
  /** Whether this chain is enabled */
  enabled: boolean;
  /** When this chain was created */
  createdAt: Date;
}

interface PendingChainFire {
  chainId: string;
  toFormula: string;
  vars: Record<string, string>;
  fireAt: Date;
  timerId: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const chains = new Map<string, ChainDef>();
const pendingFires = new Map<string, PendingChainFire>();
const MAX_CHAIN_DEPTH = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFormulaContent(formulaName: string): Promise<string | null> {
  const formulasDir = path.resolve(__dirname, '..', 'formulas');
  const filePath = path.join(formulasDir, `${formulaName}.formula.toml`);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    log.error({ formulaName, filePath }, 'Formula file not found for event chain');
    return null;
  }
}

function mapVars(
  sourceVars: Record<string, string>,
  mapping: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [fromKey, toKey] of Object.entries(mapping)) {
    if (sourceVars[fromKey] !== undefined) {
      result[toKey] = sourceVars[fromKey];
    }
  }

  return result;
}

async function fireChainMolecule(chain: ChainDef, vars: Record<string, string>): Promise<void> {
  const content = await loadFormulaContent(chain.toFormula);
  if (!content) {
    log.error(
      { chainId: chain.id, toFormula: chain.toFormula },
      'Event chain skipped — target formula not found',
    );
    return;
  }

  try {
    const proto = await meowEngine.cook(content, vars);
    const molecule = await meowEngine.pour(proto.id);

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_started',
      source: 'event-chain',
      moleculeId: molecule.id,
      message: `Chain "${chain.id}": ${chain.fromFormula} -> ${chain.toFormula} (molecule ${molecule.id})`,
      severity: 'info',
      metadata: {
        chainId: chain.id,
        fromFormula: chain.fromFormula,
        toFormula: chain.toFormula,
        vars,
        moleculeId: molecule.id,
      },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);

    log.info(
      { chainId: chain.id, moleculeId: molecule.id, fromFormula: chain.fromFormula, toFormula: chain.toFormula },
      'Event chain fired next molecule',
    );

    // Persist chain fire event to DB
    await persistChainEvent(chain, molecule.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, chainId: chain.id, toFormula: chain.toFormula }, 'Event chain failed to fire molecule');

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_failed',
      source: 'event-chain',
      message: `Event chain "${chain.id}" failed: ${msg}`,
      severity: 'error',
      metadata: { chainId: chain.id, error: msg },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);
  }
}

async function persistChainEvent(chain: ChainDef, moleculeId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO feed_events (type, source, molecule_id, message, severity, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'molecule_started',
        'event-chain',
        moleculeId,
        `Chain "${chain.id}" fired: ${chain.fromFormula} -> ${chain.toFormula}`,
        'info',
        JSON.stringify({
          chainId: chain.id,
          fromFormula: chain.fromFormula,
          toFormula: chain.toFormula,
          delayMs: chain.delayMs,
        }),
        new Date(),
      ],
    );
  } catch (err) {
    log.error({ err }, 'Failed to persist chain event');
  }
}

// ---------------------------------------------------------------------------
// Built-in chains
// ---------------------------------------------------------------------------

function registerBuiltins(): void {
  // campaign-launch -> monitoring (immediate)
  const chain1: ChainDef = {
    id: `chain-${uuidv4().slice(0, 8)}`,
    fromFormula: 'campaign-launch',
    toFormula: 'performance-audit',
    delayMs: 0,
    varMapping: {
      campaign_name: 'campaign_name',
      country: 'country',
    },
    enabled: true,
    createdAt: new Date(),
  };
  chains.set(chain1.id, chain1);

  // performance-audit -> performance-audit (7-day follow-up) — DISABLED to prevent infinite loops
  const chain2: ChainDef = {
    id: `chain-${uuidv4().slice(0, 8)}`,
    fromFormula: 'performance-audit',
    toFormula: 'performance-audit',
    delayMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    varMapping: {
      campaign_name: 'campaign_name',
      audit_type: 'follow_up_type',
    },
    enabled: false, // Disabled: self-referencing chains risk infinite loops
    createdAt: new Date(),
  };
  chains.set(chain2.id, chain2);

  log.info('Built-in event chains registered (campaign-launch->audit, audit->follow-up)');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new chain: when fromFormula completes, fire toFormula after delay.
 */
export function registerChain(
  fromFormula: string,
  toFormula: string,
  delayMs: number = 0,
  varMapping: Record<string, string> = {},
): ChainDef {
  const chain: ChainDef = {
    id: `chain-${uuidv4().slice(0, 8)}`,
    fromFormula,
    toFormula,
    delayMs,
    varMapping,
    enabled: true,
    createdAt: new Date(),
  };
  chains.set(chain.id, chain);

  log.info({ chainId: chain.id, fromFormula, toFormula, delayMs }, 'Event chain registered');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'event-chain',
    message: `Event chain registered: "${fromFormula}" -> "${toFormula}" (delay: ${delayMs}ms)`,
    severity: 'info',
    metadata: { chainId: chain.id, fromFormula, toFormula, delayMs, varMapping },
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);

  return chain;
}

/**
 * Called when a molecule completes. Checks if any chains should fire.
 * This is the main integration point — call this from the engine's completeStep
 * when a molecule reaches 'completed' status.
 *
 * @param depth — current chain depth (prevents infinite loops, max = MAX_CHAIN_DEPTH)
 */
export async function onMoleculeComplete(
  moleculeId: string,
  formulaName: string,
  moleculeVars: Record<string, string>,
  depth: number = 0,
): Promise<void> {
  // Guard against infinite chain loops
  if (depth >= MAX_CHAIN_DEPTH) {
    log.warn(
      { moleculeId, formulaName, depth, maxDepth: MAX_CHAIN_DEPTH },
      'Event chain depth limit reached — aborting to prevent infinite loop',
    );
    const event: FeedEvent = {
      id: uuidv4(),
      type: 'system_health',
      source: 'event-chain',
      message: `Chain depth limit (${MAX_CHAIN_DEPTH}) reached for formula "${formulaName}" — chain execution halted`,
      severity: 'warning',
      metadata: { moleculeId, formulaName, depth },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);
    return;
  }

  const matchingChains = Array.from(chains.values()).filter(
    c => c.enabled && c.fromFormula === formulaName,
  );

  if (matchingChains.length === 0) return;

  log.info(
    { moleculeId, formulaName, chainCount: matchingChains.length, depth },
    'Molecule completed — checking event chains',
  );

  for (const chain of matchingChains) {
    const nextVars = { ...mapVars(moleculeVars, chain.varMapping), _chain_depth: String(depth + 1) };

    if (chain.delayMs <= 0) {
      // Fire immediately
      await fireChainMolecule(chain, nextVars);
    } else {
      // Schedule delayed fire
      const fireAt = new Date(Date.now() + chain.delayMs);
      const pendingId = `pending-${uuidv4().slice(0, 8)}`;

      const timerId = setTimeout(async () => {
        pendingFires.delete(pendingId);
        await fireChainMolecule(chain, nextVars);
      }, chain.delayMs);

      pendingFires.set(pendingId, {
        chainId: chain.id,
        toFormula: chain.toFormula,
        vars: nextVars,
        fireAt,
        timerId,
      });

      log.info(
        { chainId: chain.id, pendingId, delayMs: chain.delayMs, fireAt, depth },
        'Event chain delayed fire scheduled',
      );

      const event: FeedEvent = {
        id: uuidv4(),
        type: 'system_health',
        source: 'event-chain',
        message: `Chain "${chain.id}" scheduled: "${chain.toFormula}" will fire at ${fireAt.toISOString()} (delay ${Math.round(chain.delayMs / 1000)}s)`,
        severity: 'info',
        metadata: { chainId: chain.id, pendingId, fireAt: fireAt.toISOString(), depth },
        timestamp: new Date(),
      };
      broadcast('meow:feed', event);
    }
  }
}

/**
 * List all registered chains.
 */
export function listChains(): ChainDef[] {
  return Array.from(chains.values());
}

/**
 * Remove a chain by ID.
 */
export function removeChain(id: string): boolean {
  const existed = chains.delete(id);
  if (existed) {
    // Cancel any pending fires for this chain
    for (const [pendingId, pending] of pendingFires) {
      if (pending.chainId === id) {
        clearTimeout(pending.timerId);
        pendingFires.delete(pendingId);
      }
    }
    log.info({ id }, 'Event chain removed');
  }
  return existed;
}

/**
 * Initialize the event chain system. Registers built-in chains.
 */
export function initEventChains(): void {
  registerBuiltins();
  log.info({ chainCount: chains.size }, 'Event chain system initialized');
}

/**
 * Cleanup: cancel all pending delayed fires.
 */
export function stopEventChains(): void {
  for (const [, pending] of pendingFires) {
    clearTimeout(pending.timerId);
  }
  pendingFires.clear();
  log.info('Event chain system stopped — all pending fires cancelled');
}
