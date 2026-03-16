/**
 * Beads Core API Routes — Stage 02
 *
 * GET    /api/beads              → List beads (with filters)
 * GET    /api/beads/ready        → Ready beads (unblocked)
 * GET    /api/beads/stats        → Statistics
 * GET    /api/beads/search?q=... → Full-text search
 * GET    /api/beads/:id          → Get single bead
 * GET    /api/beads/:id/tree     → Dependency tree
 * POST   /api/beads              → Create bead
 * PUT    /api/beads/:id          → Update bead
 * POST   /api/beads/:id/close    → Close bead
 * POST   /api/beads/:id/deps     → Add dependency
 * DELETE /api/beads/:id/deps/:targetId → Remove dependency
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getBeadsService } from './beads-service';
import type { BeadPriority, BeadStatus, ExecutorType } from './types';

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
// GET /api/beads — list beads with optional filters
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads', async (req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const result = await service.list({
      status: req.query.status as BeadStatus | undefined,
      bu: req.query.bu as string | undefined,
      rig: req.query.rig as string | undefined,
      assignee: req.query.assignee as string | undefined,
      skill: req.query.skill as string | undefined,
      tier: req.query.tier as 'S' | 'A' | 'B' | undefined,
      priority: req.query.priority as BeadPriority | undefined,
      moleculeId: req.query.moleculeId as string | undefined,
      convoyId: req.query.convoyId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to list beads';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/beads/ready — beads ready to be worked on
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads/ready', async (req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const beads = await service.ready({
      bu: req.query.bu as string | undefined,
      rig: req.query.rig as string | undefined,
      assignee: req.query.assignee as string | undefined,
      skill: req.query.skill as string | undefined,
      tier: req.query.tier as 'S' | 'A' | 'B' | undefined,
      priority: req.query.priority as BeadPriority | undefined,
    });
    res.json({ count: beads.length, beads });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to get ready beads';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/beads/stats — statistics
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads/stats', async (_req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const stats = await service.stats();
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to get stats';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/beads/search?q=... — full-text search
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads/search', async (req: Request, res: Response) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const service = getBeadsService();
    const beads = await service.search(q);
    res.json({ count: beads.length, beads });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to search beads';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/beads/:id — get single bead
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads/:id', async (req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const bead = await service.get(req.params.id);
    if (!bead) {
      return res.status(404).json({ error: `Bead not found: ${req.params.id}` });
    }
    res.json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to get bead';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/beads/:id/tree — dependency tree
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/beads/:id/tree', async (req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const tree = await service.getDependencyTree(req.params.id);
    if (!tree) {
      return res.status(404).json({ error: `Bead not found: ${req.params.id}` });
    }
    res.json(tree);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to get dependency tree';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/beads — create bead
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/beads', async (req: Request, res: Response) => {
  try {
    const { title, description, priority, executorType, bu, rig, skill, formula, tier, labels, assignee, moleculeId, convoyId, parentId, createdBy } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const service = getBeadsService();
    const bead = await service.create({
      title,
      description,
      priority: priority as BeadPriority | undefined,
      executorType: executorType as ExecutorType | undefined,
      bu,
      rig,
      skill,
      formula,
      tier,
      labels,
      assignee,
      moleculeId,
      convoyId,
      parentId,
      createdBy: createdBy || 'api',
    });

    res.status(201).json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create bead';
    const status = msg.includes('required') || msg.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/beads/:id — update bead
// ─────────────────────────────────────────────────────────────────────────────

router.put('/api/beads/:id', async (req: Request, res: Response) => {
  try {
    const { title, description, status, priority, executorType, bu, rig, skill, formula, tier, labels, assignee, moleculeId, convoyId, parentId, artifacts, prUrl, worktree } = req.body;

    const service = getBeadsService();
    const bead = await service.update(
      req.params.id,
      {
        title,
        description,
        status: status as BeadStatus | undefined,
        priority: priority as BeadPriority | undefined,
        executorType: executorType as ExecutorType | undefined,
        bu,
        rig,
        skill,
        formula,
        tier,
        labels,
        assignee,
        moleculeId,
        convoyId,
        parentId,
        artifacts,
        prUrl,
        worktree,
      },
      req.body.actor || 'api',
    );

    res.json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update bead';
    const status = msg.includes('not found') ? 404 : msg.includes('Invalid') ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/beads/:id/close — close bead
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/beads/:id/close', async (req: Request, res: Response) => {
  try {
    const { completedBy } = req.body;
    const service = getBeadsService();
    const bead = await service.close(req.params.id, completedBy || 'api');
    res.json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to close bead';
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/beads/:id/deps — add dependency
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/beads/:id/deps', async (req: Request, res: Response) => {
  try {
    const { targetId, type } = req.body;

    if (!targetId) {
      return res.status(400).json({ error: 'targetId is required' });
    }
    if (!type) {
      return res.status(400).json({ error: 'type is required (blocks, relates_to, duplicates, discovered_from)' });
    }

    const service = getBeadsService();
    const bead = await service.addDependency(req.params.id, targetId, type);
    res.json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to add dependency';
    const status = msg.includes('not found') ? 404
      : msg.includes('cycle') || msg.includes('itself') || msg.includes('Invalid') ? 400
      : 500;
    res.status(status).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/beads/:id/deps/:targetId — remove dependency
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/api/beads/:id/deps/:targetId', async (req: Request, res: Response) => {
  try {
    const service = getBeadsService();
    const bead = await service.removeDependency(req.params.id, req.params.targetId);
    res.json(bead);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to remove dependency';
    const status = msg.includes('not found') ? 404 : 500;
    res.status(status).json({ error: msg });
  }
});

export default router;
