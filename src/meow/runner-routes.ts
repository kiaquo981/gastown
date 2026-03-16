/**
 * MoleculeRunner Routes — Stage 02 EP-019
 *
 * Control endpoints for the MoleculeRunner auto-execution engine.
 * All routes prefixed with /api/meow/runner/
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger';
import {
  startRunner,
  stopRunner,
  isRunnerActive,
  getRunnerStatus,
  approveGate,
  rejectGate,
  manualDispatch,
} from './molecule-runner';

const log = createLogger('runner-routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — GET is public, mutations require HIVE_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== process.env.HIVE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireApiKey);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/runner/status — get runner status
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/runner/status', (_req: Request, res: Response) => {
  res.json(getRunnerStatus());
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/runner/start — start the runner
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/runner/start', (req: Request, res: Response) => {
  if (isRunnerActive()) {
    return res.status(409).json({ error: 'Runner is already active' });
  }

  const { intervalMs, simulate } = req.body as {
    intervalMs?: number;
    simulate?: boolean;
  };

  startRunner(intervalMs || 10_000, simulate || false);
  log.info({ intervalMs, simulate }, 'Runner started via API');
  res.json({ ok: true, ...getRunnerStatus() });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/runner/stop — stop the runner
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/runner/stop', (_req: Request, res: Response) => {
  if (!isRunnerActive()) {
    return res.status(409).json({ error: 'Runner is not active' });
  }

  stopRunner();
  log.info('Runner stopped via API');
  res.json({ ok: true, active: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/runner/gate/:moleculeId/:stepId/approve — approve a gate
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/runner/gate/:moleculeId/:stepId/approve', async (req: Request, res: Response) => {
  try {
    const { moleculeId, stepId } = req.params;
    const ok = await approveGate(moleculeId, stepId);
    if (!ok) {
      return res.status(404).json({ error: 'No pending gate found for this step' });
    }
    res.json({ ok: true, moleculeId, stepId, approved: true });
  } catch (err) {
    log.error({ err }, 'Approve gate failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/runner/gate/:moleculeId/:stepId/reject — reject a gate
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/runner/gate/:moleculeId/:stepId/reject', async (req: Request, res: Response) => {
  try {
    const { moleculeId, stepId } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) {
      return res.status(400).json({ error: 'reason is required' });
    }
    const ok = await rejectGate(moleculeId, stepId, reason);
    if (!ok) {
      return res.status(404).json({ error: 'No pending gate found for this step' });
    }
    res.json({ ok: true, moleculeId, stepId, rejected: true });
  } catch (err) {
    log.error({ err }, 'Reject gate failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/runner/dispatch/:moleculeId/:stepId — manual dispatch
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/runner/dispatch/:moleculeId/:stepId', async (req: Request, res: Response) => {
  try {
    const { moleculeId, stepId } = req.params;
    const ok = await manualDispatch(moleculeId, stepId);
    if (!ok) {
      return res.status(404).json({ error: 'Step not found or not in ready/gated state' });
    }
    res.json({ ok: true, moleculeId, stepId, dispatched: true });
  } catch (err) {
    log.error({ err }, 'Manual dispatch failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
