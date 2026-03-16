/**
 * Observability Routes — Wave 6 REST API (EP-131 → EP-140)
 *
 * Exposes Townlog, Keepalive, Budget, Patrol Reports, Molecule Metrics,
 * Error Trending, Health Score, and Alerting Rules.
 * Prefix: /api/meow/
 */

import { Router, Request, Response } from 'express';
import { observabilityEngine } from './observability';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// STATS — /api/meow/observability/stats
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/observability/stats', (_req: Request, res: Response) => {
  res.json(observabilityEngine.stats());
});

// ─────────────────────────────────────────────────────────────────────────────
// TOWNLOG — /api/meow/townlog/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/townlog — Query townlog entries
router.get('/api/meow/townlog', (req: Request, res: Response) => {
  const { level, category, source, since, limit } = req.query;
  const entries = observabilityEngine.queryTownlog({
    level: level as any,
    category: category as string,
    source: source as string,
    since: since ? new Date(since as string) : undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
  });
  res.json({ entries, count: entries.length });
});

// POST /api/meow/townlog — Write a townlog entry
router.post('/api/meow/townlog', (req: Request, res: Response) => {
  const { source, level, category, message, metadata, beadId, moleculeId } = req.body;
  if (!source || !level || !category || !message) {
    return res.status(400).json({ error: 'source, level, category, and message required' });
  }
  const entry = observabilityEngine.log(source, level, category, message, { metadata, beadId, moleculeId });
  res.status(201).json(entry);
});

// ─────────────────────────────────────────────────────────────────────────────
// KEEPALIVE — /api/meow/keepalive/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/keepalive — List all keepalive entries
router.get('/api/meow/keepalive', (_req: Request, res: Response) => {
  res.json({ workers: observabilityEngine.getKeepalives() });
});

// POST /api/meow/keepalive/register — Register worker for keepalive
router.post('/api/meow/keepalive/register', (req: Request, res: Response) => {
  const { workerId, workerName, intervalMs } = req.body;
  if (!workerId || !workerName) {
    return res.status(400).json({ error: 'workerId and workerName required' });
  }
  observabilityEngine.registerWorker(workerId, workerName, intervalMs);
  res.json({ ok: true });
});

// POST /api/meow/keepalive/:workerId/heartbeat — Send heartbeat
router.post('/api/meow/keepalive/:workerId/heartbeat', (req: Request, res: Response) => {
  observabilityEngine.heartbeat(req.params.workerId);
  res.json({ ok: true, timestamp: new Date() });
});

// POST /api/meow/keepalive/check — Run keepalive check cycle
router.post('/api/meow/keepalive/check', (_req: Request, res: Response) => {
  const alerts = observabilityEngine.checkKeepalives();
  res.json({ alerts, checked: observabilityEngine.getKeepalives().length });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET — /api/meow/budget/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/budget — List all budgets
router.get('/api/meow/budget', (_req: Request, res: Response) => {
  res.json({ budgets: observabilityEngine.listBudgets() });
});

// GET /api/meow/budget/summary — Cost summary
router.get('/api/meow/budget/summary', (_req: Request, res: Response) => {
  res.json(observabilityEngine.getCostSummary());
});

// GET /api/meow/budget/:agentId — Get agent budget
router.get('/api/meow/budget/:agentId', (req: Request, res: Response) => {
  const budget = observabilityEngine.getBudget(req.params.agentId);
  if (!budget) return res.status(404).json({ error: 'Budget not found' });
  res.json(budget);
});

// POST /api/meow/budget — Set/update agent budget
router.post('/api/meow/budget', (req: Request, res: Response) => {
  const { agentId, ...rest } = req.body;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const budget = observabilityEngine.setBudget(agentId, rest);
  res.json(budget);
});

// POST /api/meow/budget/:agentId/usage — Record usage
router.post('/api/meow/budget/:agentId/usage', (req: Request, res: Response) => {
  const { tokens, costUsd } = req.body;
  if (tokens === undefined || costUsd === undefined) {
    return res.status(400).json({ error: 'tokens and costUsd required' });
  }
  const budget = observabilityEngine.recordUsage(req.params.agentId, tokens, costUsd);
  if (!budget) return res.status(404).json({ error: 'Budget not found — set budget first' });
  res.json(budget);
});

// ─────────────────────────────────────────────────────────────────────────────
// PATROL REPORTS — /api/meow/patrols/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/patrols — Get patrol reports
router.get('/api/meow/patrols', (req: Request, res: Response) => {
  const owner = req.query.owner as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  res.json({ reports: observabilityEngine.getPatrolReports(owner, limit) });
});

// POST /api/meow/patrols — Record a patrol report
router.post('/api/meow/patrols', (req: Request, res: Response) => {
  const report = req.body;
  if (!report.owner || !report.checks) {
    return res.status(400).json({ error: 'owner and checks required' });
  }
  observabilityEngine.recordPatrol(report);
  res.status(201).json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOLECULE METRICS — /api/meow/molecule-metrics/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/molecule-metrics — Get molecule metrics
router.get('/api/meow/molecule-metrics', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  res.json({ metrics: observabilityEngine.getMoleculeMetrics(limit) });
});

// GET /api/meow/molecule-metrics/stats — Aggregated molecule stats
router.get('/api/meow/molecule-metrics/stats', (_req: Request, res: Response) => {
  res.json(observabilityEngine.getMoleculeStats());
});

// POST /api/meow/molecule-metrics — Record molecule metric
router.post('/api/meow/molecule-metrics', (req: Request, res: Response) => {
  const metric = req.body;
  if (!metric.moleculeId || !metric.formulaId) {
    return res.status(400).json({ error: 'moleculeId and formulaId required' });
  }
  observabilityEngine.recordMoleculeMetric(metric);
  res.status(201).json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR TRENDING — /api/meow/errors/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/errors — Get error trends
router.get('/api/meow/errors', (req: Request, res: Response) => {
  const unresolvedOnly = req.query.unresolved === 'true';
  res.json({ trends: observabilityEngine.getErrorTrends(unresolvedOnly) });
});

// POST /api/meow/errors — Record an error
router.post('/api/meow/errors', (req: Request, res: Response) => {
  const { pattern, source } = req.body;
  if (!pattern || !source) return res.status(400).json({ error: 'pattern and source required' });
  const trend = observabilityEngine.recordError(pattern, source);
  res.status(201).json(trend);
});

// POST /api/meow/errors/resolve — Resolve an error trend
router.post('/api/meow/errors/resolve', (req: Request, res: Response) => {
  const { pattern } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern required' });
  const ok = observabilityEngine.resolveError(pattern);
  res.json({ ok });
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH — /api/meow/health/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/health — Get system health score
router.get('/api/meow/health', (_req: Request, res: Response) => {
  res.json(observabilityEngine.getHealth());
});

// POST /api/meow/health/compute — Force recompute health
router.post('/api/meow/health/compute', (_req: Request, res: Response) => {
  res.json(observabilityEngine.computeHealth());
});

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS — /api/meow/alerts/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/alerts — List all alert rules
router.get('/api/meow/alerts', (_req: Request, res: Response) => {
  res.json({ rules: observabilityEngine.listAlertRules() });
});

// POST /api/meow/alerts — Create alert rule
router.post('/api/meow/alerts', (req: Request, res: Response) => {
  const { name, condition, channels, severity } = req.body;
  if (!name || !condition || !channels || !severity) {
    return res.status(400).json({ error: 'name, condition, channels, and severity required' });
  }
  const rule = observabilityEngine.createAlertRule(name, condition, channels, severity);
  res.status(201).json(rule);
});

// POST /api/meow/alerts/:id/toggle — Enable/disable alert rule
router.post('/api/meow/alerts/:id/toggle', (req: Request, res: Response) => {
  const enabled = req.body.enabled !== false;
  observabilityEngine.setAlertEnabled(req.params.id, enabled);
  res.json({ ok: true, ruleId: req.params.id, enabled });
});

// DELETE /api/meow/alerts/:id — Delete alert rule
router.delete('/api/meow/alerts/:id', (req: Request, res: Response) => {
  const ok = observabilityEngine.deleteAlertRule(req.params.id);
  res.json({ ok });
});

export default router;
