/**
 * Stage 04 — Living Pipeline Routes
 *
 * Mounts all new API endpoints introduced by Stage 04:
 * - Webhook triggers (LP-021)
 * - Cron trigger management (LP-022)
 * - Threshold trigger management (LP-023)
 * - Event chain management (LP-024)
 * - Mail bridge status (LP-025–028)
 * - Bead sync status (LP-029–032)
 * - Observability enhancements (LP-036–040)
 * - Formula listing (LP-007–012, LP-033–035)
 */

import { Router, Request, Response } from 'express';
import { triggerRouter } from './triggers';
import { getMailBridgeOrchestrator } from './bridges';
import { getBeadSyncOrchestrator } from './sync';
import { listCronTriggers, addCronTrigger, removeCronTrigger } from './triggers/cron-triggers';
import { listThresholdRules, addThresholdRule, removeThresholdRule } from './triggers/threshold-triggers';
import { listChains, registerChain, removeChain } from './triggers/event-chain';

const router = Router();

// ── Webhook Triggers (LP-021) ────────────────────────────────────
router.use('/api/meow/webhooks', triggerRouter);

// ── Cron Triggers (LP-022) ───────────────────────────────────────
router.get('/api/meow/triggers/cron', (_req: Request, res: Response) => {
  res.json({ triggers: listCronTriggers() });
});

router.post('/api/meow/triggers/cron', (req: Request, res: Response) => {
  try {
    const { name, schedule, formulaName, vars } = req.body;
    if (!name || !schedule || !formulaName) {
      res.status(400).json({ error: 'name, schedule, formulaName required' });
      return;
    }
    addCronTrigger(name, schedule, formulaName, vars || {});
    res.json({ ok: true, message: `Cron trigger '${name}' added` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/api/meow/triggers/cron/:name', (req: Request, res: Response) => {
  const removed = removeCronTrigger(req.params.name);
  res.json({ ok: removed, message: removed ? 'Removed' : 'Not found' });
});

// ── Threshold Triggers (LP-023) ──────────────────────────────────
router.get('/api/meow/triggers/thresholds', (_req: Request, res: Response) => {
  res.json({ rules: listThresholdRules() });
});

router.post('/api/meow/triggers/thresholds', (req: Request, res: Response) => {
  try {
    const { name, query, threshold, operator, formulaName, vars, cooldownMs } = req.body;
    if (!name || !query || threshold == null || !operator || !formulaName) {
      res.status(400).json({ error: 'name, query, threshold, operator, formulaName required' });
      return;
    }
    addThresholdRule(name, query, threshold, operator, formulaName, vars || {}, cooldownMs);
    res.json({ ok: true, message: `Threshold rule '${name}' added` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/api/meow/triggers/thresholds/:name', (req: Request, res: Response) => {
  const removed = removeThresholdRule(req.params.name);
  res.json({ ok: removed, message: removed ? 'Removed' : 'Not found' });
});

// ── Event Chains (LP-024) ────────────────────────────────────────
router.get('/api/meow/triggers/chains', (_req: Request, res: Response) => {
  res.json({ chains: listChains() });
});

router.post('/api/meow/triggers/chains', (req: Request, res: Response) => {
  try {
    const { fromFormula, toFormula, delayMs, varMapping } = req.body;
    if (!fromFormula || !toFormula) {
      res.status(400).json({ error: 'fromFormula, toFormula required' });
      return;
    }
    const id = registerChain(fromFormula, toFormula, delayMs || 0, varMapping || {});
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/api/meow/triggers/chains/:id', (req: Request, res: Response) => {
  const removed = removeChain(req.params.id);
  res.json({ ok: removed, message: removed ? 'Removed' : 'Not found' });
});

// ── Mail Bridge Status (LP-025–028) ──────────────────────────────
router.get('/api/meow/bridges/status', (_req: Request, res: Response) => {
  try {
    const orchestrator = getMailBridgeOrchestrator();
    res.json(orchestrator.getStatus());
  } catch (err) {
    res.json({ whatsapp: false, email: false, sse: false, slack: false, discord: false, error: (err as Error).message });
  }
});

// ── Bead Sync Status (LP-029–032) ────────────────────────────────
router.get('/api/meow/sync/status', (_req: Request, res: Response) => {
  try {
    const orchestrator = getBeadSyncOrchestrator();
    res.json(orchestrator.getStatus());
  } catch (err) {
    res.json({ supabase: false, projectQueue: false, github: false, megabrain: false, error: (err as Error).message });
  }
});

// ── Stage 04 Overview ────────────────────────────────────────────
router.get('/api/meow/stage04/status', (_req: Request, res: Response) => {
  try {
    const bridges = getMailBridgeOrchestrator().getStatus();
    const sync = getBeadSyncOrchestrator().getStatus();
    const crons = listCronTriggers();
    const thresholds = listThresholdRules();
    const chains = listChains();

    res.json({
      stage: '04',
      name: 'Living Pipeline',
      status: 'active',
      triggers: {
        cron: crons.length,
        thresholds: thresholds.length,
        chains: chains.length,
      },
      bridges,
      sync,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
