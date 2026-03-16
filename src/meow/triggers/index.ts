/**
 * MEOW Triggers — Stage 04 Wave 4 (Barrel Export)
 *
 * 4 trigger types that CREATE molecules/hooks automatically based on events:
 *   LP-021: Webhook Listener — fires on incoming HTTP webhooks
 *   LP-022: Cron Triggers — fires on time-based schedules
 *   LP-023: Threshold Triggers — fires when metric thresholds are breached
 *   LP-024: Event Chain — fires when a molecule completes (chain reaction)
 */

import { Router } from 'express';
import { createLogger } from '../../lib/logger';

// Re-export all trigger modules
export { webhookRouter, registerWebhookTrigger, removeWebhookTrigger, listWebhookTriggers } from './webhook-listener';
export { startCronTriggers, stopCronTriggers, addCronTrigger, listCronTriggers, removeCronTrigger } from './cron-triggers';
export type { CronSchedule, CronTriggerDef } from './cron-triggers';
export { startThresholdMonitor, stopThresholdMonitor, addThresholdRule, listThresholdRules, removeThresholdRule } from './threshold-triggers';
export type { ThresholdOperator, ThresholdRule } from './threshold-triggers';
export { registerChain, onMoleculeComplete, listChains, removeChain, initEventChains, stopEventChains } from './event-chain';
export type { ChainDef } from './event-chain';

// Import for init
import { webhookRouter } from './webhook-listener';
import { startCronTriggers, stopCronTriggers } from './cron-triggers';
import { startThresholdMonitor, stopThresholdMonitor } from './threshold-triggers';
import { initEventChains, stopEventChains } from './event-chain';

const log = createLogger('meow-triggers');

// ---------------------------------------------------------------------------
// Combined Trigger Router
// ---------------------------------------------------------------------------

/** Express router that mounts all webhook-based trigger endpoints */
export const triggerRouter = Router();
triggerRouter.use('/webhooks', webhookRouter);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize all trigger subsystems:
 *   - Cron triggers (schedule-based)
 *   - Threshold monitor (metric-based)
 *   - Event chains (molecule completion-based)
 *   - Webhook routes are mounted via triggerRouter (no init needed)
 */
export function initAllTriggers(): void {
  log.info('Initializing all MEOW trigger systems...');

  startCronTriggers();
  startThresholdMonitor();
  initEventChains();

  log.info('All MEOW trigger systems initialized (webhooks, cron, thresholds, event-chains)');
}

/**
 * Stop all trigger subsystems gracefully.
 */
export function stopAllTriggers(): void {
  log.info('Stopping all MEOW trigger systems...');

  stopCronTriggers();
  stopThresholdMonitor();
  stopEventChains();

  log.info('All MEOW trigger systems stopped');
}
