/**
 * State Guard Routes — EP-016
 *
 * API endpoints for state machine guard audit + diagnostics.
 * Prefixed with /api/meow/guards/
 */

import { Router, Request, Response } from 'express';
import {
  getAuditLog,
  getBlockedTransitions,
  getTransitionStats,
  clearAuditLog,
} from './state-guards';

const router = Router();

// GET /api/meow/guards/audit — get audit log of transitions
router.get('/api/meow/guards/audit', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json({ events: getAuditLog(limit) });
});

// GET /api/meow/guards/blocked — get blocked transitions only
router.get('/api/meow/guards/blocked', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json({ events: getBlockedTransitions(limit) });
});

// GET /api/meow/guards/stats — transition statistics
router.get('/api/meow/guards/stats', (_req: Request, res: Response) => {
  res.json(getTransitionStats());
});

// DELETE /api/meow/guards/audit — clear audit log
router.delete('/api/meow/guards/audit', (_req: Request, res: Response) => {
  clearAuditLog();
  res.json({ ok: true });
});

export default router;
