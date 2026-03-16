/**
 * Foundation Routes — Wave 1 REST API (EP-111 → EP-130)
 *
 * Exposes Hooks Engine (FrankFlow) and Workspace Governance operations.
 * Prefix: /api/meow/
 */

import { Router, Request, Response } from 'express';
import { hooksEngine } from './hooks-engine';
import { workspaceGov } from './workspace-gov';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HOOKS ENGINE — /api/meow/hooks/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/hooks/stats — Hooks engine stats
router.get('/api/meow/hooks/stats', (_req: Request, res: Response) => {
  res.json(hooksEngine.stats());
});

// GET /api/meow/hooks — List all hook definitions
router.get('/api/meow/hooks', (_req: Request, res: Response) => {
  res.json({ hooks: hooksEngine.listHooks() });
});

// GET /api/meow/hooks/:id — Get specific hook definition
router.get('/api/meow/hooks/:id', (req: Request, res: Response) => {
  const hook = hooksEngine.getHook(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Hook not found' });
  res.json(hook);
});

// POST /api/meow/hooks/run — Run a specific hook type
router.post('/api/meow/hooks/run', async (req: Request, res: Response) => {
  const { type, context } = req.body;
  if (!type) return res.status(400).json({ error: 'type (HookType) required' });
  try {
    const result = await hooksEngine.runHook(type, context || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/hooks/run-batch — Run multiple hooks at once
router.post('/api/meow/hooks/run-batch', async (req: Request, res: Response) => {
  const { types, context } = req.body;
  if (!Array.isArray(types) || types.length === 0) {
    return res.status(400).json({ error: 'types (HookType[]) required' });
  }
  try {
    const results = await hooksEngine.runHooks(types, context || {});
    res.json({ results, blocked: results.some(r => r.blocked) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/hooks/:id/toggle — Enable/disable a hook
router.post('/api/meow/hooks/:id/toggle', (req: Request, res: Response) => {
  const enabled = req.body.enabled !== false;
  hooksEngine.setEnabled(req.params.id, enabled);
  res.json({ ok: true, hookId: req.params.id, enabled });
});

// POST /api/meow/hooks/loop-guard/reset — Reset loop guard entries
router.post('/api/meow/hooks/loop-guard/reset', (_req: Request, res: Response) => {
  const cleared = hooksEngine.resetLoopGuard();
  res.json({ ok: true, cleared });
});

// ─── Pattern Learner ─────────────────────────────────────────────────────────

// GET /api/meow/hooks/patterns — List all learned patterns
router.get('/api/meow/hooks/patterns', (_req: Request, res: Response) => {
  res.json({ patterns: hooksEngine.getPatterns() });
});

// POST /api/meow/hooks/patterns — Learn a new pattern
router.post('/api/meow/hooks/patterns', (req: Request, res: Response) => {
  const { pattern, solution, tags } = req.body;
  if (!pattern || !solution) {
    return res.status(400).json({ error: 'pattern and solution required' });
  }
  const entry = hooksEngine.learnPattern(pattern, solution, tags || []);
  res.status(201).json(entry);
});

// POST /api/meow/hooks/patterns/find — Find matching patterns for an error
router.post('/api/meow/hooks/patterns/find', (req: Request, res: Response) => {
  const { error: errorStr } = req.body;
  if (!errorStr) return res.status(400).json({ error: 'error (string) required' });
  const matches = hooksEngine.findPatterns(errorStr);
  res.json({ matches });
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE GOVERNANCE — /api/meow/workspace/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/workspace/stats — Governance stats
router.get('/api/meow/workspace/stats', (_req: Request, res: Response) => {
  res.json(workspaceGov.stats());
});

// GET /api/meow/workspace/hierarchy — Get CLAUDE.md hierarchy definition
router.get('/api/meow/workspace/hierarchy', (_req: Request, res: Response) => {
  res.json({ levels: workspaceGov.getHierarchy() });
});

// GET /api/meow/workspace/audit — Get last audit report
router.get('/api/meow/workspace/audit', (_req: Request, res: Response) => {
  const report = workspaceGov.getLastAudit();
  if (!report) return res.status(404).json({ error: 'No audit has been run yet' });
  res.json(report);
});

// POST /api/meow/workspace/audit — Run workspace audit
router.post('/api/meow/workspace/audit', (req: Request, res: Response) => {
  const report = workspaceGov.audit(req.body || {});
  res.json(report);
});

// GET /api/meow/workspace/sanitize — Get last sanitize result
router.get('/api/meow/workspace/sanitize', (_req: Request, res: Response) => {
  const result = workspaceGov.getLastSanitize();
  if (!result) return res.status(404).json({ error: 'No sanitization has been run yet' });
  res.json(result);
});

// POST /api/meow/workspace/sanitize — Run 7-phase sanitization
router.post('/api/meow/workspace/sanitize', (req: Request, res: Response) => {
  const { issues } = req.body;
  if (!Array.isArray(issues)) {
    return res.status(400).json({ error: 'issues (array of {type, path?, description, autoFixable}) required' });
  }
  const result = workspaceGov.sanitize(issues);
  res.json(result);
});

// ─── Learning Pipeline ───────────────────────────────────────────────────────

// GET /api/meow/workspace/learnings — Get all learnings
router.get('/api/meow/workspace/learnings', (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const valid = ['lesson', 'decision', 'friction', 'gotcha'];
  const learnings = type && valid.includes(type)
    ? workspaceGov.getLearnings(type as 'lesson' | 'decision' | 'friction' | 'gotcha')
    : workspaceGov.getLearnings();
  res.json({ learnings });
});

// GET /api/meow/workspace/learnings/promoted — Get promoted learnings only
router.get('/api/meow/workspace/learnings/promoted', (_req: Request, res: Response) => {
  res.json({ learnings: workspaceGov.getPromotedLearnings() });
});

// POST /api/meow/workspace/learnings — Record a learning
router.post('/api/meow/workspace/learnings', (req: Request, res: Response) => {
  const { type, content, source, tags } = req.body;
  if (!type || !content || !source) {
    return res.status(400).json({ error: 'type (lesson|decision|friction|gotcha), content, and source required' });
  }
  const entry = workspaceGov.learn(type, content, source, tags || []);
  res.status(201).json(entry);
});

// ─── Context Bootstrap ───────────────────────────────────────────────────────

// POST /api/meow/workspace/context/session — Generate session context brief
router.post('/api/meow/workspace/context/session', (req: Request, res: Response) => {
  const brief = workspaceGov.generateSessionContext(req.body || {});
  res.json(brief);
});

// POST /api/meow/workspace/context/subagent — Generate subagent brief
router.post('/api/meow/workspace/context/subagent', (req: Request, res: Response) => {
  const { beadId, skill, moleculeState, constraints, tokenBudget } = req.body;
  if (!beadId || !skill) {
    return res.status(400).json({ error: 'beadId and skill required' });
  }
  const brief = workspaceGov.generateSubagentBrief({ beadId, skill, moleculeState, constraints, tokenBudget });
  res.json(brief);
});

// POST /api/meow/workspace/hygiene/start — Start hygiene pipeline
router.post('/api/meow/workspace/hygiene/start', (_req: Request, res: Response) => {
  workspaceGov.startHygiene();
  res.json({ ok: true, message: 'Hygiene pipeline started' });
});

// POST /api/meow/workspace/hygiene/stop — Stop hygiene pipeline
router.post('/api/meow/workspace/hygiene/stop', (_req: Request, res: Response) => {
  workspaceGov.stopHygiene();
  res.json({ ok: true, message: 'Hygiene pipeline stopped' });
});

export default router;
