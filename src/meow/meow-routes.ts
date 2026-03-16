/**
 * MEOW Routes — Stage 02
 *
 * Express router for the Molecular Expression of Work engine.
 * All routes prefixed with /api/meow/
 */

import { Router, Request, Response, NextFunction } from 'express';
import { meowEngine } from './engine';
import { createLogger } from '../lib/logger';

const log = createLogger('meow-routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — GET is public, mutations require GASTOWN_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== process.env.GASTOWN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireApiKey);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/cook — cook a formula into a protomolecule (SOLID)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/cook', async (req: Request, res: Response) => {
  try {
    const { formulaContent, vars } = req.body as {
      formulaContent?: string;
      vars?: Record<string, string>;
    };

    if (!formulaContent?.trim()) {
      return res.status(400).json({ error: 'formulaContent is required' });
    }

    const molecule = await meowEngine.cook(formulaContent, vars || {});
    res.json({ molecule });
  } catch (err) {
    log.error({ err }, 'Cook failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/pour/:protoId — pour protomolecule into molecule (LIQUID)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/pour/:protoId', async (req: Request, res: Response) => {
  try {
    const { protoId } = req.params;
    const molecule = await meowEngine.pour(protoId);
    res.json({ molecule });
  } catch (err) {
    log.error({ err, protoId: req.params.protoId }, 'Pour failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/wisp/:protoId — create wisp from protomolecule (VAPOR)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/wisp/:protoId', async (req: Request, res: Response) => {
  try {
    const { protoId } = req.params;
    const { ttlMs } = req.body as { ttlMs?: number };
    const wisp = await meowEngine.wisp(protoId, ttlMs);
    res.json({ wisp });
  } catch (err) {
    log.error({ err, protoId: req.params.protoId }, 'Wisp creation failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/squash/:moleculeId — squash molecule to digest
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/squash/:moleculeId', async (req: Request, res: Response) => {
  try {
    const { moleculeId } = req.params;
    const molecule = await meowEngine.squash(moleculeId);
    res.json({ molecule });
  } catch (err) {
    log.error({ err, moleculeId: req.params.moleculeId }, 'Squash failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/meow/wisp/:wispId — burn (delete) wisp
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/api/meow/wisp/:wispId', async (req: Request, res: Response) => {
  try {
    const { wispId } = req.params;
    await meowEngine.burn(wispId);
    res.json({ ok: true, burned: wispId });
  } catch (err) {
    log.error({ err, wispId: req.params.wispId }, 'Burn failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/molecules — list molecules
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/molecules', async (req: Request, res: Response) => {
  try {
    const { phase, status, formulaName, limit, offset } = req.query as {
      phase?: string;
      status?: string;
      formulaName?: string;
      limit?: string;
      offset?: string;
    };

    const molecules = await meowEngine.listMolecules({
      phase,
      status,
      formulaName,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    res.json({ molecules, count: molecules.length });
  } catch (err) {
    log.error({ err }, 'List molecules failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/molecules/:id — get molecule by ID
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/molecules/:id', async (req: Request, res: Response) => {
  try {
    const molecule = await meowEngine.getMolecule(req.params.id);
    if (!molecule) {
      return res.status(404).json({ error: `Molecule ${req.params.id} not found` });
    }
    res.json({ molecule });
  } catch (err) {
    log.error({ err, id: req.params.id }, 'Get molecule failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/molecules/:id/ready-steps — get executable steps
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/molecules/:id/ready-steps', async (req: Request, res: Response) => {
  try {
    const readySteps = await meowEngine.getReadySteps(req.params.id);
    res.json({ readySteps, count: readySteps.length });
  } catch (err) {
    log.error({ err, id: req.params.id }, 'Get ready steps failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/molecules/:id/steps/:stepId/complete — complete a step
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/molecules/:id/steps/:stepId/complete', async (req: Request, res: Response) => {
  try {
    const { id, stepId } = req.params;
    const { output } = req.body as { output?: Record<string, unknown> };
    const molecule = await meowEngine.completeStep(id, stepId, output);
    res.json({ molecule });
  } catch (err) {
    log.error({ err, id: req.params.id, stepId: req.params.stepId }, 'Complete step failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/molecules/:id/steps/:stepId/fail — fail a step
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/molecules/:id/steps/:stepId/fail', async (req: Request, res: Response) => {
  try {
    const { id, stepId } = req.params;
    const { error } = req.body as { error?: string };
    if (!error?.trim()) {
      return res.status(400).json({ error: 'error message is required' });
    }
    const molecule = await meowEngine.failStep(id, stepId, error);
    res.json({ molecule });
  } catch (err) {
    log.error({ err, id: req.params.id, stepId: req.params.stepId }, 'Fail step failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/convoys — list convoys
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/convoys', async (req: Request, res: Response) => {
  try {
    const { status, limit, offset } = req.query as {
      status?: string;
      limit?: string;
      offset?: string;
    };

    const convoys = await meowEngine.listConvoys({
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    res.json({ convoys, count: convoys.length });
  } catch (err) {
    log.error({ err }, 'List convoys failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/convoys/:id — get convoy by ID
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/convoys/:id', async (req: Request, res: Response) => {
  try {
    const convoy = await meowEngine.getConvoy(req.params.id);
    if (!convoy) {
      return res.status(404).json({ error: `Convoy ${req.params.id} not found` });
    }
    res.json({ convoy });
  } catch (err) {
    log.error({ err, id: req.params.id }, 'Get convoy failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/feed — get activity feed
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/feed', async (req: Request, res: Response) => {
  try {
    const { type, rig, moleculeId, limit, offset } = req.query as {
      type?: string;
      rig?: string;
      moleculeId?: string;
      limit?: string;
      offset?: string;
    };

    const events = await meowEngine.getFeedEvents({
      type,
      rig,
      moleculeId,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    res.json({ events, count: events.length });
  } catch (err) {
    log.error({ err }, 'Get feed events failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
