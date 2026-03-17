/**
 * FrankFlow API Routes
 *
 * Express router exposing all FrankFlow modules:
 * - Checkpoints: resumable execution state
 * - Orphans: stale worker detection & recovery
 * - Retries: intelligent retry with backoff
 * - Router: intent detection & specialist routing
 * - Patterns: adaptive error memory
 * - Quality: multi-stack quality gates
 * - Review: multi-agent code review
 * - Spec Sync: spec-to-bead bridge
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../../lib/logger';

import {
  listCheckpoints,
  getCheckpointEvents,
  deleteCheckpoint,
  getCheckpointStats,
} from './checkpoint-engine';

import {
  detectOrphans,
  recoverAll,
  startOrphanLoop,
  stopOrphanLoop,
  getOrphanHistory,
  getOrphanStats,
  isOrphanLoopRunning,
} from './orphan-detector';

import {
  shouldRetry,
  scheduleRetry,
  getRetryable,
  executeRetry,
  getRetryRecord,
  getAllRetryRecords,
  getRetryStats,
  classifyError,
} from './retry-manager';

import {
  routeTask,
  routeBeadToWorker,
  getCategories,
  addCategoryFromStrings,
  removeCategory,
  getRouteHistory,
  getRouteStats,
} from './smart-router';

import {
  recordError,
  getActivePatterns,
  getAllPatterns,
  getPatternsByCategory,
  setResolution,
  generateSessionContext,
  getPatternStats,
} from './pattern-learner';

import type { ErrorCategory } from './pattern-learner';

import {
  runGates,
  runGatesWithFix,
  getGateReport,
  listReports as listQualityReports,
  detectStacks,
  getCoverageThresholds,
  getQualityStats,
} from './quality-gates';

import type { TechStack } from './quality-gates';

import {
  runReview,
  autoFixCriticals,
  getReviewResult,
  listReviews,
  getReviewAgents,
  addReviewAgent,
  removeReviewAgent,
} from './review-pipeline';

import {
  syncSpecToBeads,
  getSpecStatus,
  parseSpecTasks,
  validateSpec,
} from './spec-sync';

const log = createLogger('frankflow:routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Error wrapper
// ─────────────────────────────────────────────────────────────────────────────

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      log.error({ err, path: req.path }, 'FrankFlow route error');
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/frankflow/checkpoints — list checkpoint files */
router.get('/checkpoints', (_req, res) => {
  const ids = listCheckpoints();
  const stats = getCheckpointStats();
  res.json({ checkpoints: ids, stats });
});

/** GET /api/frankflow/checkpoints/:itemId — get checkpoint events */
router.get('/checkpoints/:itemId', (req, res) => {
  const events = getCheckpointEvents(req.params.itemId);
  if (events.length === 0) {
    return res.status(404).json({ error: 'Checkpoint not found' });
  }
  res.json({ itemId: req.params.itemId, events });
});

/** DELETE /api/frankflow/checkpoints/:itemId — cleanup */
router.delete('/checkpoints/:itemId', (req, res) => {
  const deleted = deleteCheckpoint(req.params.itemId);
  res.json({ deleted });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORPHANS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/frankflow/orphans — detect orphans */
router.get('/orphans', (req, res) => {
  const maxProcessingTimeMs = req.query.maxProcessingTimeMs
    ? parseInt(req.query.maxProcessingTimeMs as string, 10)
    : undefined;
  const maxHeartbeatStaleMs = req.query.maxHeartbeatStaleMs
    ? parseInt(req.query.maxHeartbeatStaleMs as string, 10)
    : undefined;

  const orphans = detectOrphans({ maxProcessingTimeMs, maxHeartbeatStaleMs });
  const stats = getOrphanStats();
  res.json({ orphans, stats });
});

/** GET /api/frankflow/orphans/history — orphan history */
router.get('/orphans/history', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const history = getOrphanHistory(limit);
  res.json({ history });
});

/** POST /api/frankflow/orphans/recover — recover all orphans */
router.post(
  '/orphans/recover',
  wrap(async (_req, res) => {
    const results = await recoverAll();
    res.json({ recovered: results.length, results });
  }),
);

/** POST /api/frankflow/orphans/loop/start — start detection loop */
router.post('/orphans/loop/start', (req, res) => {
  const intervalMs = req.body?.intervalMs ? parseInt(req.body.intervalMs, 10) : undefined;
  startOrphanLoop(intervalMs);
  res.json({ status: 'started', intervalMs: intervalMs || 60000 });
});

/** POST /api/frankflow/orphans/loop/stop — stop detection loop */
router.post('/orphans/loop/stop', (_req, res) => {
  stopOrphanLoop();
  res.json({ status: 'stopped' });
});

/** GET /api/frankflow/orphans/loop/status — loop status */
router.get('/orphans/loop/status', (_req, res) => {
  res.json({ running: isOrphanLoopRunning() });
});

// ─────────────────────────────────────────────────────────────────────────────
// RETRIES
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/frankflow/retries — get retryable items */
router.get('/retries', (_req, res) => {
  const retryable = getRetryable();
  const all = getAllRetryRecords();
  const stats = getRetryStats();
  res.json({ retryable, all, stats });
});

/** GET /api/frankflow/retries/:itemId/history — retry history for item */
router.get('/retries/:itemId/history', (req, res) => {
  const record = getRetryRecord(req.params.itemId);
  if (!record) {
    return res.status(404).json({ error: 'Retry record not found' });
  }
  res.json({ record });
});

/** POST /api/frankflow/retries/:itemId — execute retry */
router.post(
  '/retries/:itemId',
  wrap(async (req, res) => {
    const result = await executeRetry(req.params.itemId);
    if (!result) {
      return res.status(404).json({ error: 'No retry record found for item' });
    }
    res.json({ result });
  }),
);

/** POST /api/frankflow/retries/schedule — schedule a retry */
router.post('/retries/schedule', (req, res) => {
  const { itemId, error, config } = req.body || {};
  if (!itemId || !error) {
    return res.status(400).json({ error: 'itemId and error required' });
  }

  const canRetry = shouldRetry(itemId, error, config);
  if (!canRetry) {
    return res.json({ scheduled: false, reason: 'Not retryable' });
  }

  const record = scheduleRetry(itemId, error, config);
  res.json({ scheduled: !!record, record });
});

/** POST /api/frankflow/retries/classify — classify an error */
router.post('/retries/classify', (req, res) => {
  const { error } = req.body || {};
  if (!error) return res.status(400).json({ error: 'error string required' });

  const classification = classifyError(error);
  res.json({ error, classification });
});

// ─────────────────────────────────────────────────────────────────────────────
// SMART ROUTER
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/frankflow/route — route a task text */
router.post('/route', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  const result = routeTask(text);
  res.json({ result });
});

/** POST /api/frankflow/route/bead — route a bead to worker */
router.post(
  '/route/bead',
  wrap(async (req, res) => {
    const { beadId } = req.body || {};
    if (!beadId) return res.status(400).json({ error: 'beadId required' });

    const result = await routeBeadToWorker(beadId);
    if (!result) return res.status(404).json({ error: 'Bead not found or DB unavailable' });

    res.json({ result });
  }),
);

/** GET /api/frankflow/routes — list routing categories */
router.get('/routes', (_req, res) => {
  const categories = getCategories().map(c => ({
    id: c.id,
    specialist: c.specialist,
    priority: c.priority,
    workflow: c.workflow,
    patternCount: c.patterns.length,
    contextInjection: c.contextInjection.slice(0, 100) + '...',
  }));
  const stats = getRouteStats();
  res.json({ categories, stats });
});

/** POST /api/frankflow/routes — add a routing category */
router.post('/routes', (req, res) => {
  const { id, patterns, specialist, contextInjection, priority, workflow } = req.body || {};
  if (!id || !patterns || !specialist || !contextInjection) {
    return res.status(400).json({ error: 'id, patterns, specialist, contextInjection required' });
  }

  addCategoryFromStrings({ id, patterns, specialist, contextInjection, priority: priority || 50, workflow });
  res.json({ added: id });
});

/** DELETE /api/frankflow/routes/:id — remove a routing category */
router.delete('/routes/:id', (req, res) => {
  const removed = removeCategory(req.params.id);
  res.json({ removed });
});

/** GET /api/frankflow/routes/history — routing history */
router.get('/routes/history', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const history = getRouteHistory(limit);
  res.json({ history });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN LEARNER
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/frankflow/patterns — get all error patterns */
router.get('/patterns', (req, res) => {
  const category = req.query.category as ErrorCategory | undefined;
  const patternsResult = category ? getPatternsByCategory(category) : getAllPatterns();
  const stats = getPatternStats();
  res.json({ patterns: patternsResult, stats });
});

/** GET /api/frankflow/patterns/active — active (recurring) patterns */
router.get('/patterns/active', (req, res) => {
  const minCount = req.query.minCount ? parseInt(req.query.minCount as string, 10) : 2;
  const active = getActivePatterns(minCount);
  const context = generateSessionContext();
  res.json({ active, context });
});

/** POST /api/frankflow/patterns/record — record an error */
router.post('/patterns/record', (req, res) => {
  const { error, beadId } = req.body || {};
  if (!error) return res.status(400).json({ error: 'error string required' });

  const pattern = recordError(error, beadId);
  res.json({ pattern });
});

/** POST /api/frankflow/patterns/:patternId/resolution — set resolution */
router.post('/patterns/:patternId/resolution', (req, res) => {
  const { resolution } = req.body || {};
  if (!resolution) return res.status(400).json({ error: 'resolution required' });

  const success = setResolution(req.params.patternId, resolution);
  if (!success) return res.status(404).json({ error: 'Pattern not found' });

  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY GATES
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/frankflow/quality/run — run quality gates */
router.post(
  '/quality/run',
  wrap(async (req, res) => {
    const { workdir, stacks, beadId, branch, autoFix } = req.body || {};
    if (!workdir) return res.status(400).json({ error: 'workdir required' });

    const opts = { beadId, branch };
    const report = autoFix
      ? await runGatesWithFix(workdir, opts)
      : await runGates(workdir, stacks as TechStack[] | undefined, opts);

    res.json({ report });
  }),
);

/** GET /api/frankflow/quality/detect — detect stacks in workdir */
router.get('/quality/detect', (req, res) => {
  const workdir = req.query.workdir as string;
  if (!workdir) return res.status(400).json({ error: 'workdir query param required' });

  const stacks = detectStacks(workdir);
  res.json({ workdir, stacks });
});

/** GET /api/frankflow/quality/:id — get quality report */
router.get('/quality/:id', (req, res) => {
  const report = getGateReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Quality report not found' });
  res.json({ report });
});

/** GET /api/frankflow/quality — list quality reports */
router.get('/quality', (req, res) => {
  const filters = {
    beadId: req.query.beadId as string | undefined,
    branch: req.query.branch as string | undefined,
    passed: req.query.passed !== undefined ? req.query.passed === 'true' : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const reports = listQualityReports(filters);
  const stats = getQualityStats();
  const thresholds = getCoverageThresholds();
  res.json({ reports, stats, thresholds });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/frankflow/review/run — run code review */
router.post(
  '/review/run',
  wrap(async (req, res) => {
    const { workdir, beadId, branch, agentIds } = req.body || {};
    if (!workdir) return res.status(400).json({ error: 'workdir required' });

    const result = await runReview(workdir, beadId, { branch, agentIds });
    res.json({ result });
  }),
);

/** POST /api/frankflow/review/autofix — auto-fix critical findings */
router.post(
  '/review/autofix',
  wrap(async (req, res) => {
    const { workdir, findings, maxRounds } = req.body || {};
    if (!workdir || !findings) {
      return res.status(400).json({ error: 'workdir and findings required' });
    }

    const result = await autoFixCriticals(workdir, findings, maxRounds);
    res.json({ result });
  }),
);

/** GET /api/frankflow/review/:id — get review result */
router.get('/review/:id', (req, res) => {
  const result = getReviewResult(req.params.id);
  if (!result) return res.status(404).json({ error: 'Review result not found' });
  res.json({ result });
});

/** GET /api/frankflow/review — list reviews */
router.get('/review', (req, res) => {
  const filters = {
    beadId: req.query.beadId as string | undefined,
    passed: req.query.passed !== undefined ? req.query.passed === 'true' : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
  };
  const reviews = listReviews(filters);
  res.json({ reviews });
});

/** GET /api/frankflow/review/agents — list review agents */
router.get('/review/agents', (_req, res) => {
  const agents = getReviewAgents().map(a => ({
    id: a.id,
    name: a.name,
    focus: a.focus,
    severity: a.severity,
  }));
  res.json({ agents });
});

/** POST /api/frankflow/review/agents — add review agent */
router.post('/review/agents', (req, res) => {
  const { id, name, focus, severity, prompt, filePatterns, excludePatterns } = req.body || {};
  if (!id || !name || !focus || !severity || !prompt) {
    return res.status(400).json({ error: 'id, name, focus, severity, prompt required' });
  }

  addReviewAgent({ id, name, focus, severity, prompt, filePatterns, excludePatterns });
  res.json({ added: id });
});

/** DELETE /api/frankflow/review/agents/:id — remove review agent */
router.delete('/review/agents/:id', (req, res) => {
  const removed = removeReviewAgent(req.params.id);
  res.json({ removed });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC SYNC
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/frankflow/spec-sync — sync spec to beads */
router.post(
  '/spec-sync',
  wrap(async (req, res) => {
    const { specPath, epicTitle } = req.body || {};
    if (!specPath) return res.status(400).json({ error: 'specPath required' });

    const result = await syncSpecToBeads(specPath, epicTitle);
    res.json({ result });
  }),
);

/** POST /api/frankflow/spec-sync/parse — parse spec without syncing */
router.post('/spec-sync/parse', (req, res) => {
  const { markdown } = req.body || {};
  if (!markdown) return res.status(400).json({ error: 'markdown body required' });

  const tasks = parseSpecTasks(markdown);
  const validation = validateSpec(markdown);
  res.json({ tasks, validation });
});

/** POST /api/frankflow/spec-sync/status — get spec status */
router.post(
  '/spec-sync/status',
  wrap(async (req, res) => {
    const { specPath } = req.body || {};
    if (!specPath) return res.status(400).json({ error: 'specPath required' });

    const status = await getSpecStatus(specPath);
    res.json({ status });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/frankflow — overview of all FrankFlow modules */
router.get('/', (_req, res) => {
  res.json({
    name: 'FrankFlow Execution Logic Layer',
    version: '1.0.0',
    modules: {
      checkpoints: { stats: getCheckpointStats() },
      orphans: { stats: getOrphanStats(), loopRunning: isOrphanLoopRunning() },
      retries: { stats: getRetryStats() },
      router: { stats: getRouteStats() },
      patterns: { stats: getPatternStats() },
      quality: { stats: getQualityStats() },
    },
  });
});

export default router;
