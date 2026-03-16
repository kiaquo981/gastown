/**
 * LP-023 — Threshold Triggers
 *
 * Monitors metrics and fires formulas when thresholds are breached.
 * Polling interval: checks every 5 minutes.
 * Cooldown: won't re-trigger same rule for 1 hour after firing.
 *
 * Built-in threshold rules:
 *   - roas_low: if ROAS < 1.5 for any campaign -> fire optimization formula
 *   - inventory_low: if stock < 10 for any product -> fire reorder formula
 *   - error_spike: if error rate > 5% in 15min -> fire incident formula
 *   - budget_exceeded: if daily spend > budget limit -> fire pause formula
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { meowEngine } from '../engine';
import { createLogger } from '../../lib/logger';
import type { FeedEvent } from '../types';

const log = createLogger('threshold-triggers');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThresholdOperator = 'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq';

export interface ThresholdRule {
  name: string;
  /** SQL query that returns a single numeric value */
  query: string;
  /** The threshold value to compare against */
  threshold: number;
  /** Comparison operator */
  operator: ThresholdOperator;
  /** Formula to fire when threshold is breached */
  formulaName: string;
  /** Variables to pass to the formula */
  vars: Record<string, string>;
  /** Cooldown in ms before the same rule can re-fire (default: 1 hour) */
  cooldownMs: number;
  /** Whether this rule is enabled */
  enabled: boolean;
  /** Last time this rule fired a molecule */
  lastFiredAt?: Date;
  /** Last measured metric value */
  lastValue?: number;
  /** When the rule was created */
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const rules = new Map<string, ThresholdRule>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_COOLDOWN_MS = 60 * 60_000;      // 1 hour

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFormulaContent(formulaName: string): Promise<string | null> {
  const formulasDir = path.resolve(__dirname, '..', 'formulas');
  const filePath = path.join(formulasDir, `${formulaName}.formula.toml`);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    log.error({ formulaName, filePath }, 'Formula file not found for threshold trigger');
    return null;
  }
}

function isBreached(value: number, threshold: number, operator: ThresholdOperator): boolean {
  switch (operator) {
    case 'lt': return value < threshold;
    case 'gt': return value > threshold;
    case 'lte': return value <= threshold;
    case 'gte': return value >= threshold;
    case 'eq': return value === threshold;
    case 'neq': return value !== threshold;
    default: return false;
  }
}

function operatorToSymbol(operator: ThresholdOperator): string {
  switch (operator) {
    case 'lt': return '<';
    case 'gt': return '>';
    case 'lte': return '<=';
    case 'gte': return '>=';
    case 'eq': return '==';
    case 'neq': return '!=';
  }
}

function isInCooldown(rule: ThresholdRule): boolean {
  if (!rule.lastFiredAt) return false;
  return Date.now() - rule.lastFiredAt.getTime() < rule.cooldownMs;
}

async function evaluateRule(rule: ThresholdRule): Promise<number | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const { rows } = await pool.query(rule.query);
    if (rows.length === 0) return null;

    // Expect the first column of the first row to be the metric value
    const firstRow = rows[0];
    const firstCol = Object.values(firstRow)[0];
    const value = Number(firstCol);

    if (isNaN(value)) {
      log.warn({ rule: rule.name, rawValue: firstCol }, 'Threshold query returned non-numeric value');
      return null;
    }

    return value;
  } catch (err) {
    log.error({ err, rule: rule.name }, 'Failed to evaluate threshold query');
    return null;
  }
}

async function fireThresholdMolecule(rule: ThresholdRule, currentValue: number): Promise<void> {
  const content = await loadFormulaContent(rule.formulaName);
  if (!content) {
    log.error({ name: rule.name, formulaName: rule.formulaName }, 'Threshold trigger skipped — formula not found');
    return;
  }

  // Inject the breached metric value into vars
  const vars = {
    ...rule.vars,
    _trigger_name: rule.name,
    _trigger_value: String(currentValue),
    _trigger_threshold: String(rule.threshold),
    _trigger_operator: rule.operator,
  };

  try {
    const proto = await meowEngine.cook(content, vars);
    const molecule = await meowEngine.pour(proto.id);

    rule.lastFiredAt = new Date();
    rule.lastValue = currentValue;

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_started',
      source: 'threshold-triggers',
      moleculeId: molecule.id,
      message: `Threshold "${rule.name}" breached: ${currentValue} ${operatorToSymbol(rule.operator)} ${rule.threshold} -> fired formula "${rule.formulaName}" (molecule ${molecule.id})`,
      severity: 'warning',
      metadata: {
        triggerName: rule.name,
        formulaName: rule.formulaName,
        value: currentValue,
        threshold: rule.threshold,
        operator: rule.operator,
        moleculeId: molecule.id,
      },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);

    log.info(
      { name: rule.name, moleculeId: molecule.id, value: currentValue, threshold: rule.threshold },
      'Threshold trigger fired molecule',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, name: rule.name }, 'Threshold trigger failed to fire molecule');

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_failed',
      source: 'threshold-triggers',
      message: `Threshold trigger "${rule.name}" failed: ${msg}`,
      severity: 'error',
      metadata: { triggerName: rule.name, error: msg, value: currentValue },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);
  }
}

// ---------------------------------------------------------------------------
// Monitor Loop
// ---------------------------------------------------------------------------

async function checkAllRules(): Promise<void> {
  for (const [, rule] of rules) {
    if (!rule.enabled) continue;
    if (isInCooldown(rule)) continue;

    const value = await evaluateRule(rule);
    if (value === null) continue;

    rule.lastValue = value;

    if (isBreached(value, rule.threshold, rule.operator)) {
      log.info(
        { name: rule.name, value, threshold: rule.threshold, operator: rule.operator },
        'Threshold breached — firing trigger',
      );
      await fireThresholdMolecule(rule, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Built-in threshold rules
// ---------------------------------------------------------------------------

function registerBuiltins(): void {
  // ROAS low: if ROAS < 1.5 for any campaign
  rules.set('roas_low', {
    name: 'roas_low',
    query: `SELECT COALESCE(MIN(
      CASE WHEN spend > 0 THEN revenue / spend ELSE NULL END
    ), 999) AS min_roas
    FROM campaign_metrics
    WHERE date >= CURRENT_DATE - INTERVAL '1 day'
      AND spend > 10`,
    threshold: 1.5,
    operator: 'lt',
    formulaName: 'performance-audit',
    vars: { audit_type: 'roas-optimization', scope: 'underperforming-campaigns' },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
    createdAt: new Date(),
  });

  // Inventory low: if stock < 10 for any product
  rules.set('inventory_low', {
    name: 'inventory_low',
    query: `SELECT COALESCE(MIN(stock_qty), 999) AS min_stock
    FROM products
    WHERE active = true`,
    threshold: 10,
    operator: 'lt',
    formulaName: 'product-discovery',
    vars: { action: 'reorder-check', scope: 'low-stock' },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
    createdAt: new Date(),
  });

  // Error spike: if error rate > 5% in 15min
  rules.set('error_spike', {
    name: 'error_spike',
    query: `SELECT COALESCE(
      (COUNT(*) FILTER (WHERE severity = 'error')::float / GREATEST(COUNT(*), 1)) * 100,
      0
    ) AS error_rate
    FROM feed_events
    WHERE timestamp >= NOW() - INTERVAL '15 minutes'`,
    threshold: 5,
    operator: 'gt',
    formulaName: 'performance-audit',
    vars: { audit_type: 'incident-response', scope: 'error-spike' },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
    createdAt: new Date(),
  });

  // Budget exceeded: if daily spend > budget limit
  rules.set('budget_exceeded', {
    name: 'budget_exceeded',
    query: `SELECT COALESCE(SUM(spend), 0) AS daily_spend
    FROM campaign_metrics
    WHERE date = CURRENT_DATE`,
    threshold: 1000, // Default $1000 daily budget — should be configured per account
    operator: 'gt',
    formulaName: 'performance-audit',
    vars: { audit_type: 'budget-alert', scope: 'overspend' },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    enabled: true,
    createdAt: new Date(),
  });

  log.info('Built-in threshold rules registered (roas_low, inventory_low, error_spike, budget_exceeded)');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the threshold monitor. Registers built-in rules and begins polling.
 */
export function startThresholdMonitor(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (monitorInterval) {
    log.warn('Threshold monitor already running');
    return;
  }

  registerBuiltins();

  monitorInterval = setInterval(() => {
    checkAllRules().catch(err => {
      log.error({ err }, 'Error in threshold monitor check loop');
    });
  }, intervalMs);

  log.info({ intervalMs, ruleCount: rules.size }, 'Threshold monitor started');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'threshold-triggers',
    message: `Threshold monitor started (poll every ${Math.round(intervalMs / 1000)}s, ${rules.size} rules)`,
    severity: 'info',
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);
}

/**
 * Stop the threshold monitor.
 */
export function stopThresholdMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    log.info('Threshold monitor stopped');
  }
}

/** Validate that a SQL query is read-only (no INSERT, UPDATE, DELETE, DROP, etc.) */
function validateReadOnly(sql: string): { valid: boolean; error?: string } {
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  cleaned = cleaned.replace(/--[^\n]*/g, ' ');
  const normalized = cleaned.trim().toUpperCase();

  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXECUTE'];
  for (const keyword of forbidden) {
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(normalized)) {
      return { valid: false, error: `Forbidden SQL operation: ${keyword}. Only SELECT queries are allowed.` };
    }
  }

  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    return { valid: false, error: 'Only SELECT and WITH (CTE) queries are allowed for threshold rules.' };
  }
  return { valid: true };
}

/**
 * Add a custom threshold rule.
 */
export function addThresholdRule(
  name: string,
  query: string,
  threshold: number,
  operator: ThresholdOperator,
  formulaName: string,
  vars: Record<string, string> = {},
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
): ThresholdRule {
  // Security: validate that the query is read-only
  const validation = validateReadOnly(query);
  if (!validation.valid) {
    throw new Error(`Threshold rule "${name}" rejected: ${validation.error}`);
  }

  if (rules.has(name)) {
    log.warn({ name }, 'Threshold rule already exists — overwriting');
  }

  const rule: ThresholdRule = {
    name,
    query,
    threshold,
    operator,
    formulaName,
    vars,
    cooldownMs,
    enabled: true,
    createdAt: new Date(),
  };
  rules.set(name, rule);

  log.info({ name, formulaName, threshold, operator }, 'Threshold rule added');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'threshold-triggers',
    message: `Threshold rule "${name}" added: fire "${formulaName}" when value ${operatorToSymbol(operator)} ${threshold}`,
    severity: 'info',
    metadata: { name, formulaName, threshold, operator },
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);

  return rule;
}

/**
 * List all threshold rules.
 */
export function listThresholdRules(): ThresholdRule[] {
  return Array.from(rules.values());
}

/**
 * Remove a threshold rule by name.
 */
export function removeThresholdRule(name: string): boolean {
  const existed = rules.delete(name);
  if (existed) {
    log.info({ name }, 'Threshold rule removed');
  }
  return existed;
}
