/**
 * LP-022 — Cron Triggers
 *
 * Schedule-based molecule firing. Uses setInterval + hour/minute checking
 * to fire formulas on a recurring schedule.
 *
 * Built-in schedules:
 *   - daily-audit: fires performance-audit.formula.toml at 06:00 UTC
 *   - weekly-report: fires performance-audit.formula.toml on Monday 09:00 UTC
 *   - monthly-review: fires performance-audit.formula.toml on 1st of month 08:00 UTC
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { meowEngine } from '../engine';
import { createLogger } from '../../lib/logger';
import type { FeedEvent } from '../types';

const log = createLogger('cron-triggers');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronSchedule {
  hour: number;           // 0-23 UTC
  minute: number;         // 0-59
  daysOfWeek?: number[];  // 0=Sunday, 1=Monday, ..., 6=Saturday (undefined = every day)
  dayOfMonth?: number;    // 1-31 (undefined = every day)
}

export interface CronTriggerDef {
  name: string;
  schedule: CronSchedule;
  formulaName: string;
  vars: Record<string, string>;
  enabled: boolean;
  lastFiredAt?: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const cronTriggers = new Map<string, CronTriggerDef>();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastCheckMinute: number = -1; // Track last checked minute to avoid double-firing

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFormulaContent(formulaName: string): Promise<string | null> {
  const formulasDir = path.resolve(__dirname, '..', 'formulas');
  const filePath = path.join(formulasDir, `${formulaName}.formula.toml`);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    log.error({ formulaName, filePath }, 'Formula file not found for cron trigger');
    return null;
  }
}

function matchesSchedule(schedule: CronSchedule, now: Date): boolean {
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDayOfWeek = now.getUTCDay();
  const utcDayOfMonth = now.getUTCDate();

  // Check hour and minute
  if (utcHour !== schedule.hour || utcMinute !== schedule.minute) {
    return false;
  }

  // Check day of week constraint
  if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
    if (!schedule.daysOfWeek.includes(utcDayOfWeek)) {
      return false;
    }
  }

  // Check day of month constraint
  if (schedule.dayOfMonth !== undefined) {
    if (utcDayOfMonth !== schedule.dayOfMonth) {
      return false;
    }
  }

  return true;
}

async function fireCronMolecule(trigger: CronTriggerDef): Promise<void> {
  const content = await loadFormulaContent(trigger.formulaName);
  if (!content) {
    log.error({ name: trigger.name, formulaName: trigger.formulaName }, 'Cron trigger skipped — formula not found');
    return;
  }

  try {
    const proto = await meowEngine.cook(content, trigger.vars);
    const molecule = await meowEngine.pour(proto.id);

    trigger.lastFiredAt = new Date();

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_started',
      source: 'cron-triggers',
      moleculeId: molecule.id,
      message: `Cron trigger "${trigger.name}" fired formula "${trigger.formulaName}" -> molecule ${molecule.id}`,
      severity: 'info',
      metadata: { triggerName: trigger.name, formulaName: trigger.formulaName, vars: trigger.vars },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);

    log.info(
      { name: trigger.name, moleculeId: molecule.id, formulaName: trigger.formulaName },
      'Cron trigger fired molecule',
    );

    // Persist last-fired to DB
    await persistTriggerState(trigger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, name: trigger.name, formulaName: trigger.formulaName }, 'Cron trigger failed to fire molecule');

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_failed',
      source: 'cron-triggers',
      message: `Cron trigger "${trigger.name}" failed: ${msg}`,
      severity: 'warning',
      metadata: { triggerName: trigger.name, error: msg },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);
  }
}

async function persistTriggerState(trigger: CronTriggerDef): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO feed_events (type, source, message, severity, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'system_health',
        'cron-triggers',
        `Cron trigger "${trigger.name}" state persisted (last fired: ${trigger.lastFiredAt?.toISOString()})`,
        'info',
        JSON.stringify({
          triggerName: trigger.name,
          formulaName: trigger.formulaName,
          lastFiredAt: trigger.lastFiredAt,
          schedule: trigger.schedule,
        }),
        new Date(),
      ],
    );
  } catch (err) {
    log.error({ err }, 'Failed to persist cron trigger state');
  }
}

// ---------------------------------------------------------------------------
// Check Loop
// ---------------------------------------------------------------------------

async function checkTriggers(): Promise<void> {
  const now = new Date();
  const currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Skip if we already checked this minute (avoid double-firing within the 30s interval)
  if (currentMinute === lastCheckMinute) return;
  lastCheckMinute = currentMinute;

  for (const [, trigger] of cronTriggers) {
    if (!trigger.enabled) continue;

    if (!matchesSchedule(trigger.schedule, now)) continue;

    // Guard against re-firing within the same minute window
    if (trigger.lastFiredAt) {
      const lastFiredMinute =
        trigger.lastFiredAt.getUTCHours() * 60 + trigger.lastFiredAt.getUTCMinutes();
      const lastFiredDate = trigger.lastFiredAt.toISOString().slice(0, 10);
      const nowDate = now.toISOString().slice(0, 10);

      if (lastFiredMinute === currentMinute && lastFiredDate === nowDate) {
        continue; // Already fired this minute today
      }
    }

    log.info({ name: trigger.name }, 'Cron schedule matched — firing trigger');
    await fireCronMolecule(trigger);
  }
}

// ---------------------------------------------------------------------------
// Built-in schedules
// ---------------------------------------------------------------------------

function registerBuiltins(): void {
  // Daily audit: fires performance-audit.formula.toml at 06:00 UTC
  cronTriggers.set('daily-audit', {
    name: 'daily-audit',
    schedule: { hour: 6, minute: 0 },
    formulaName: 'performance-audit',
    vars: { audit_type: 'daily', scope: 'all-campaigns' },
    enabled: true,
    createdAt: new Date(),
  });

  // Weekly report: fires on Monday 09:00 UTC
  cronTriggers.set('weekly-report', {
    name: 'weekly-report',
    schedule: { hour: 9, minute: 0, daysOfWeek: [1] }, // Monday
    formulaName: 'performance-audit',
    vars: { audit_type: 'weekly', scope: 'full-report' },
    enabled: true,
    createdAt: new Date(),
  });

  // Monthly review: fires on 1st of month 08:00 UTC
  cronTriggers.set('monthly-review', {
    name: 'monthly-review',
    schedule: { hour: 8, minute: 0, dayOfMonth: 1 },
    formulaName: 'performance-audit',
    vars: { audit_type: 'monthly', scope: 'comprehensive-review' },
    enabled: true,
    createdAt: new Date(),
  });

  log.info('Built-in cron triggers registered (daily-audit, weekly-report, monthly-review)');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start all cron triggers. Registers built-ins and begins the check loop.
 */
export function startCronTriggers(): void {
  if (checkInterval) {
    log.warn('Cron triggers already running');
    return;
  }

  registerBuiltins();

  checkInterval = setInterval(() => {
    checkTriggers().catch(err => {
      log.error({ err }, 'Error in cron trigger check loop');
    });
  }, CHECK_INTERVAL_MS);

  log.info({ intervalMs: CHECK_INTERVAL_MS }, 'Cron triggers started');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'cron-triggers',
    message: `Cron trigger system started (check every ${CHECK_INTERVAL_MS / 1000}s, ${cronTriggers.size} triggers)`,
    severity: 'info',
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);
}

/**
 * Stop all cron triggers.
 */
export function stopCronTriggers(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    lastCheckMinute = -1;
    log.info('Cron triggers stopped');
  }
}

/**
 * Add a custom cron trigger.
 */
export function addCronTrigger(
  name: string,
  schedule: CronSchedule,
  formulaName: string,
  vars: Record<string, string> = {},
): CronTriggerDef {
  if (cronTriggers.has(name)) {
    log.warn({ name }, 'Cron trigger already exists — overwriting');
  }

  const def: CronTriggerDef = {
    name,
    schedule,
    formulaName,
    vars,
    enabled: true,
    createdAt: new Date(),
  };
  cronTriggers.set(name, def);

  log.info({ name, formulaName, schedule }, 'Cron trigger added');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'cron-triggers',
    message: `Cron trigger "${name}" added for formula "${formulaName}" (${schedule.hour}:${String(schedule.minute).padStart(2, '0')} UTC)`,
    severity: 'info',
    metadata: { name, formulaName, schedule },
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);

  return def;
}

/**
 * List all active cron triggers.
 */
export function listCronTriggers(): CronTriggerDef[] {
  return Array.from(cronTriggers.values());
}

/**
 * Remove a cron trigger by name.
 */
export function removeCronTrigger(name: string): boolean {
  const existed = cronTriggers.delete(name);
  if (existed) {
    log.info({ name }, 'Cron trigger removed');
  }
  return existed;
}
