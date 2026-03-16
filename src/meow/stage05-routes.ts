/**
 * Stage 05 — Cognitive Gas Town Routes
 *
 * Exposes all 32 cognitive modules across 8 groups:
 * - Mayor Intelligence (CG-001–004): priority scoring, resource allocation, convoy composition, conflict resolution
 * - Learning Loops (CG-005–008): formula evolution, skill ranking, worker learning, pattern library
 * - Predictive Intelligence (CG-009–012): failure prediction, cost forecasting, demand forecasting, outcome prediction
 * - Smart Routing (CG-013–016): mail routing, tier adjustment, skill selection, cross-formula optimization
 * - Self-Healing (CG-017–020): auto retry, zombie detection, queue rebalancing, drift detection
 * - Knowledge Integration (CG-021–024): megabrain context, nous injection, atlas injection, cross-molecule knowledge
 * - Autonomous Decisions (CG-025–028): auto approve, budget AI, escalation intelligence, formula scheduling
 * - Quality Intelligence (CG-029–032): output scoring, A/B testing, continuous improvement, retrospectives
 *
 * Prefix: /api/meow/cognitive/
 */

import { Router, Request, Response, NextFunction } from 'express';

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

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1: MAYOR INTELLIGENCE — /api/meow/cognitive/mayor/*
// CG-001: Priority Scoring | CG-002: Resource Allocation
// CG-003: Convoy Composition | CG-004: Conflict Resolution
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/mayor/status', async (_req: Request, res: Response) => {
  try {
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    const { mayorConvoyComposer } = await import('./cognitive/mayor-convoy-composition');
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    res.json({
      priorityScorer: { active: !!mayorPriorityScorer },
      resourceAllocator: { active: !!mayorResourceAllocator },
      convoyComposer: { active: !!mayorConvoyComposer },
      conflictResolver: { active: !!mayorConflictResolver },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-001: Priority Scoring ────────────────────────────────────────────────

// POST /api/meow/cognitive/mayor/priority/score — Score a single bead
router.post('/api/meow/cognitive/mayor/priority/score', async (req: Request, res: Response) => {
  try {
    const { bead, context } = req.body;
    if (!bead) return res.status(400).json({ error: 'bead required' });
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    const result = await mayorPriorityScorer.scoreBead(bead, context);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/priority/score-backlog — Score entire backlog
router.post('/api/meow/cognitive/mayor/priority/score-backlog', async (req: Request, res: Response) => {
  try {
    const { beads, context } = req.body;
    if (!Array.isArray(beads)) return res.status(400).json({ error: 'beads (array) required' });
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    const result = await mayorPriorityScorer.scoreBacklog(beads, context);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/priority/auto-scoring/start — Start auto-scoring loop
router.post('/api/meow/cognitive/mayor/priority/auto-scoring/start', async (req: Request, res: Response) => {
  try {
    const { intervalMs } = req.body;
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    mayorPriorityScorer.startAutoScoring(intervalMs);
    res.json({ ok: true, message: 'Auto-scoring started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/priority/auto-scoring/stop — Stop auto-scoring loop
router.post('/api/meow/cognitive/mayor/priority/auto-scoring/stop', async (_req: Request, res: Response) => {
  try {
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    mayorPriorityScorer.stopAutoScoring();
    res.json({ ok: true, message: 'Auto-scoring stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/priority/weights — Get scoring weights
router.get('/api/meow/cognitive/mayor/priority/weights', async (_req: Request, res: Response) => {
  try {
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    res.json(mayorPriorityScorer.getWeights());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/mayor/priority/weights — Update scoring weights
router.put('/api/meow/cognitive/mayor/priority/weights', async (req: Request, res: Response) => {
  try {
    const { weights } = req.body;
    if (!weights) return res.status(400).json({ error: 'weights required' });
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    mayorPriorityScorer.setWeights(weights);
    res.json({ ok: true, weights: mayorPriorityScorer.getWeights() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/priority/last-result — Get last scoring result
router.get('/api/meow/cognitive/mayor/priority/last-result', async (_req: Request, res: Response) => {
  try {
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    res.json(mayorPriorityScorer.getLastResult());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/priority/auto-scoring/active — Check if auto-scoring is running
router.get('/api/meow/cognitive/mayor/priority/auto-scoring/active', async (_req: Request, res: Response) => {
  try {
    const { mayorPriorityScorer } = await import('./cognitive/mayor-priority-scoring');
    res.json({ active: mayorPriorityScorer.isAutoScoringActive() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-002: Resource Allocation ─────────────────────────────────────────────

// POST /api/meow/cognitive/mayor/resources/allocate — Allocate beads to workers
router.post('/api/meow/cognitive/mayor/resources/allocate', async (req: Request, res: Response) => {
  try {
    const { beads, workers } = req.body;
    if (!Array.isArray(beads) || !Array.isArray(workers)) {
      return res.status(400).json({ error: 'beads (array) and workers (array) required' });
    }
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    const plan = await mayorResourceAllocator.allocate(beads, workers);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/resources/suggest — Suggest best worker for a bead
router.post('/api/meow/cognitive/mayor/resources/suggest', async (req: Request, res: Response) => {
  try {
    const { bead, workers } = req.body;
    if (!bead) return res.status(400).json({ error: 'bead required' });
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    const suggestion = await mayorResourceAllocator.suggestWorkerForBead(bead, workers);
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/resources/load — Get worker load distribution
router.get('/api/meow/cognitive/mayor/resources/load', async (_req: Request, res: Response) => {
  try {
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    res.json(mayorResourceAllocator.getWorkerLoad());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/resources/efficiency — Get efficiency report
router.get('/api/meow/cognitive/mayor/resources/efficiency', async (req: Request, res: Response) => {
  try {
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    const workers = req.query.workers ? JSON.parse(req.query.workers as string) : undefined;
    res.json(mayorResourceAllocator.getEfficiencyReport(workers));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/resources/last-plan — Get last allocation plan
router.get('/api/meow/cognitive/mayor/resources/last-plan', async (_req: Request, res: Response) => {
  try {
    const { mayorResourceAllocator } = await import('./cognitive/mayor-resource-allocation');
    res.json(mayorResourceAllocator.getLastPlan());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-003: Convoy Composition ──────────────────────────────────────────────

// POST /api/meow/cognitive/mayor/convoys/compose — Compose convoys from beads
router.post('/api/meow/cognitive/mayor/convoys/compose', async (req: Request, res: Response) => {
  try {
    const { beads } = req.body;
    if (!Array.isArray(beads)) return res.status(400).json({ error: 'beads (array) required' });
    const { mayorConvoyComposer } = await import('./cognitive/mayor-convoy-composition');
    const convoys = await mayorConvoyComposer.composeConvoys(beads);
    res.json(convoys);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/convoys/evaluate — Evaluate a convoy
router.post('/api/meow/cognitive/mayor/convoys/evaluate', async (req: Request, res: Response) => {
  try {
    const { beadIds } = req.body;
    if (!Array.isArray(beadIds)) return res.status(400).json({ error: 'beadIds (array) required' });
    const { mayorConvoyComposer } = await import('./cognitive/mayor-convoy-composition');
    const evaluation = await mayorConvoyComposer.evaluateConvoy(beadIds);
    res.json(evaluation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/convoys/suggest-merge — Suggest merging two convoys
router.post('/api/meow/cognitive/mayor/convoys/suggest-merge', async (req: Request, res: Response) => {
  try {
    const { convoyABeadIds, convoyBBeadIds } = req.body;
    if (!Array.isArray(convoyABeadIds) || !Array.isArray(convoyBBeadIds)) {
      return res.status(400).json({ error: 'convoyABeadIds (array) and convoyBBeadIds (array) required' });
    }
    const { mayorConvoyComposer } = await import('./cognitive/mayor-convoy-composition');
    const suggestion = await mayorConvoyComposer.suggestMerge(convoyABeadIds, convoyBBeadIds);
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/convoys/last-proposals — Get last convoy proposals
router.get('/api/meow/cognitive/mayor/convoys/last-proposals', async (_req: Request, res: Response) => {
  try {
    const { mayorConvoyComposer } = await import('./cognitive/mayor-convoy-composition');
    res.json(mayorConvoyComposer.getLastProposals());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-004: Conflict Resolution ─────────────────────────────────────────────

// GET /api/meow/cognitive/mayor/conflicts — Get active conflicts
router.get('/api/meow/cognitive/mayor/conflicts', async (_req: Request, res: Response) => {
  try {
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    res.json({ conflicts: mayorConflictResolver.getActiveConflicts() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/conflicts/detect — Detect conflicts
router.post('/api/meow/cognitive/mayor/conflicts/detect', async (req: Request, res: Response) => {
  try {
    const { workers } = req.body;
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    const conflicts = await mayorConflictResolver.detectConflicts(workers);
    res.json(conflicts);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/conflicts/resolve — Resolve a single conflict
router.post('/api/meow/cognitive/mayor/conflicts/resolve', async (req: Request, res: Response) => {
  try {
    const { conflict, workers } = req.body;
    if (!conflict) return res.status(400).json({ error: 'conflict required' });
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    const result = await mayorConflictResolver.resolveConflict(conflict, workers);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/conflicts/resolve-all — Resolve all conflicts
router.post('/api/meow/cognitive/mayor/conflicts/resolve-all', async (req: Request, res: Response) => {
  try {
    const { workers } = req.body;
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    const results = await mayorConflictResolver.resolveAll(workers);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/conflicts/history — Get conflict history
router.get('/api/meow/cognitive/mayor/conflicts/history', async (req: Request, res: Response) => {
  try {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    res.json({ history: mayorConflictResolver.getConflictHistory(since) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/mayor/conflicts/quality-dispute — Register quality dispute
router.post('/api/meow/cognitive/mayor/conflicts/quality-dispute', async (req: Request, res: Response) => {
  try {
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    const { executorId, reviewerId, beadId, description } = req.body;
    const dispute = await mayorConflictResolver.registerQualityDispute(executorId, reviewerId, beadId, description);
    res.json(dispute);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/mayor/conflicts/stats — Conflict resolution stats
router.get('/api/meow/cognitive/mayor/conflicts/stats', async (_req: Request, res: Response) => {
  try {
    const { mayorConflictResolver } = await import('./cognitive/mayor-conflict-resolution');
    res.json(mayorConflictResolver.stats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2: LEARNING LOOPS — /api/meow/cognitive/learning/*
// CG-005: Formula Evolution | CG-006: Skill Performance Ranking
// CG-007: Worker Performance Learning | CG-008: Pattern Library
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/learning/status', async (_req: Request, res: Response) => {
  try {
    const { getFormulaEvolver } = await import('./cognitive/formula-evolution');
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    res.json({
      formulaEvolution: { active: !!getFormulaEvolver },
      skillRanking: { active: !!getSkillPerformanceRanker },
      workerLearning: { active: !!getWorkerPerformanceLearner },
      patternLibrary: { active: !!getPatternLibrary },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-005: Formula Evolution ───────────────────────────────────────────────

// GET /api/meow/cognitive/learning/formulas/:name/analysis — Analyze formula executions
router.get('/api/meow/cognitive/learning/formulas/:name/analysis', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { getFormulaEvolver } = await import('./cognitive/formula-evolution');
    const evolver = getFormulaEvolver();
    const analysis = await evolver.analyzeExecutions(req.params.name, limit);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/formulas/:name/suggestions — Get improvement suggestions
router.get('/api/meow/cognitive/learning/formulas/:name/suggestions', async (req: Request, res: Response) => {
  try {
    const { getFormulaEvolver } = await import('./cognitive/formula-evolution');
    const evolver = getFormulaEvolver();
    const suggestions = await evolver.suggestImprovements(req.params.name);
    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/formulas/:name/evolve — Evolve a formula
router.post('/api/meow/cognitive/learning/formulas/:name/evolve', async (req: Request, res: Response) => {
  try {
    const { getFormulaEvolver } = await import('./cognitive/formula-evolution');
    const evolver = getFormulaEvolver();
    const result = await evolver.evolveFormula(req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/formulas/:name/history — Get evolution history
router.get('/api/meow/cognitive/learning/formulas/:name/history', async (req: Request, res: Response) => {
  try {
    const { getFormulaEvolver } = await import('./cognitive/formula-evolution');
    const evolver = getFormulaEvolver();
    const history = await evolver.getEvolutionHistory(req.params.name);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-006: Skill Performance Ranking ───────────────────────────────────────

// POST /api/meow/cognitive/learning/skills/record — Record skill execution
router.post('/api/meow/cognitive/learning/skills/record', async (req: Request, res: Response) => {
  try {
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const ranker = getSkillPerformanceRanker();
    const { skillName, success, durationMs, costUsd, outputQuality } = req.body;
    const result = await ranker.recordExecution(skillName, success, durationMs, costUsd, outputQuality);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/skills/rankings — Get skill rankings
router.get('/api/meow/cognitive/learning/skills/rankings', async (_req: Request, res: Response) => {
  try {
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const ranker = getSkillPerformanceRanker();
    res.json(ranker.getRankings());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/skills/best/:taskType — Get best skill for task type
router.get('/api/meow/cognitive/learning/skills/best/:taskType', async (req: Request, res: Response) => {
  try {
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const ranker = getSkillPerformanceRanker();
    const best = ranker.getBestSkillFor(req.params.taskType);
    res.json(best);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/skills/:name/metrics — Get metrics for a skill
router.get('/api/meow/cognitive/learning/skills/:name/metrics', async (req: Request, res: Response) => {
  try {
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const ranker = getSkillPerformanceRanker();
    res.json(ranker.getSkillMetrics(req.params.name));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/skills/refresh — Refresh rankings
router.post('/api/meow/cognitive/learning/skills/refresh', async (_req: Request, res: Response) => {
  try {
    const { getSkillPerformanceRanker } = await import('./cognitive/skill-performance-ranking');
    const ranker = getSkillPerformanceRanker();
    await ranker.refreshRankings();
    res.json({ ok: true, message: 'Rankings refreshed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-007: Worker Performance Learning ─────────────────────────────────────

// POST /api/meow/cognitive/learning/workers/record — Record task result
router.post('/api/meow/cognitive/learning/workers/record', async (req: Request, res: Response) => {
  try {
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    const { workerId, taskType, success, durationMs, quality } = req.body;
    const result = await learner.recordTaskResult(workerId, taskType, success, durationMs, quality);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/workers/:workerId/profile — Get worker profile
router.get('/api/meow/cognitive/learning/workers/:workerId/profile', async (req: Request, res: Response) => {
  try {
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    res.json(learner.getWorkerProfile(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/workers/suggest — Suggest worker for task type
router.post('/api/meow/cognitive/learning/workers/suggest', async (req: Request, res: Response) => {
  try {
    const { taskType, available } = req.body;
    if (!taskType) return res.status(400).json({ error: 'taskType required' });
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    const suggestion = await learner.suggestWorkerForTask(taskType, available);
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/workers/:workerId/strengths — Get worker strengths
router.get('/api/meow/cognitive/learning/workers/:workerId/strengths', async (req: Request, res: Response) => {
  try {
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    res.json(learner.getStrengths(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/workers/:workerId/weaknesses — Get worker weaknesses
router.get('/api/meow/cognitive/learning/workers/:workerId/weaknesses', async (req: Request, res: Response) => {
  try {
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    res.json(learner.getWeaknesses(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/workers/refresh — Refresh all worker profiles
router.post('/api/meow/cognitive/learning/workers/refresh', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPerformanceLearner } = await import('./cognitive/worker-performance-learning');
    const learner = getWorkerPerformanceLearner();
    await learner.refreshProfiles();
    res.json({ ok: true, message: 'Worker profiles refreshed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-008: Pattern Library ─────────────────────────────────────────────────

// POST /api/meow/cognitive/learning/patterns/extract — Extract patterns from molecule
router.post('/api/meow/cognitive/learning/patterns/extract', async (req: Request, res: Response) => {
  try {
    const { molecule } = req.body;
    if (!molecule) return res.status(400).json({ error: 'molecule required' });
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    const lib = getPatternLibrary();
    const patterns = await lib.extractPatterns(molecule);
    res.json(patterns);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/patterns/search — Search patterns
router.get('/api/meow/cognitive/learning/patterns/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    if (!query) return res.status(400).json({ error: 'q (query) param required' });
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    const lib = getPatternLibrary();
    const results = await lib.searchPatterns(query, limit);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/patterns/context — Get context for a molecule
router.post('/api/meow/cognitive/learning/patterns/context', async (req: Request, res: Response) => {
  try {
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    const lib = getPatternLibrary();
    const { formulaName, vars } = req.body;
    const context = await lib.getContextForMolecule(formulaName, vars);
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/learning/patterns/stats — Pattern library stats
router.get('/api/meow/cognitive/learning/patterns/stats', async (_req: Request, res: Response) => {
  try {
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    const lib = getPatternLibrary();
    res.json(lib.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/learning/patterns/prune — Prune old patterns
router.post('/api/meow/cognitive/learning/patterns/prune', async (req: Request, res: Response) => {
  try {
    const { olderThanDays } = req.body;
    const { getPatternLibrary } = await import('./cognitive/pattern-library');
    const lib = getPatternLibrary();
    const result = await lib.pruneOldPatterns(olderThanDays);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3: PREDICTIVE INTELLIGENCE — /api/meow/cognitive/predictions/*
// CG-009: Failure Prediction | CG-010: Cost Forecasting
// CG-011: Demand Forecasting | CG-012: Outcome Prediction
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/predictions/status', async (_req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    res.json({
      failurePredictor: { active: !!getFailurePredictor },
      costForecaster: { active: !!getCostForecaster },
      demandForecaster: { active: !!getDemandForecaster },
      outcomePredictor: { active: !!getOutcomePredictor },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-009: Failure Prediction ──────────────────────────────────────────────

// POST /api/meow/cognitive/predictions/failure/predict — Predict failure
router.post('/api/meow/cognitive/predictions/failure/predict', async (req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    const { formulaName, vars } = req.body;
    const prediction = await predictor.predict(formulaName, vars);
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/failure/formula/:name/risk — Get formula risk profile
router.get('/api/meow/cognitive/predictions/failure/formula/:name/risk', async (req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    res.json(predictor.getFormulaRiskProfile(req.params.name));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/predictions/failure/update-weights — Update weights from history
router.post('/api/meow/cognitive/predictions/failure/update-weights', async (_req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    await predictor.updateWeightsFromHistory();
    res.json({ ok: true, message: 'Weights updated from history' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/predictions/failure/record-outcome — Record actual outcome
router.post('/api/meow/cognitive/predictions/failure/record-outcome', async (req: Request, res: Response) => {
  try {
    const { predictionId, failed } = req.body;
    if (!predictionId || failed === undefined) {
      return res.status(400).json({ error: 'predictionId and failed (boolean) required' });
    }
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    await predictor.recordActualOutcome(predictionId, failed);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/failure/accuracy — Get prediction accuracy
router.get('/api/meow/cognitive/predictions/failure/accuracy', async (_req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    res.json(predictor.getAccuracy());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/failure/weights — Get current weights
router.get('/api/meow/cognitive/predictions/failure/weights', async (_req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    res.json(predictor.getWeights());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/failure/count — Get prediction count
router.get('/api/meow/cognitive/predictions/failure/count', async (_req: Request, res: Response) => {
  try {
    const { getFailurePredictor } = await import('./cognitive/failure-prediction');
    const predictor = getFailurePredictor();
    res.json({ count: predictor.getPredictionCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-010: Cost Forecasting ────────────────────────────────────────────────

// GET /api/meow/cognitive/predictions/cost/forecast — Forecast costs
router.get('/api/meow/cognitive/predictions/cost/forecast', async (req: Request, res: Response) => {
  try {
    const daysAhead = parseInt(req.query.days as string, 10) || 7;
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    const forecast = await forecaster.forecast(daysAhead);
    res.json(forecast);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/cost/monthly — Get monthly projection
router.get('/api/meow/cognitive/predictions/cost/monthly', async (_req: Request, res: Response) => {
  try {
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    res.json(await forecaster.getMonthlyProjection());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/cost/budget-alert — Get budget alert
router.get('/api/meow/cognitive/predictions/cost/budget-alert', async (_req: Request, res: Response) => {
  try {
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    res.json(await forecaster.getBudgetAlert());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/cost/providers — Get provider breakdown
router.get('/api/meow/cognitive/predictions/cost/providers', async (_req: Request, res: Response) => {
  try {
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    res.json(await forecaster.getProviderBreakdown());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/cost/formula-costs — Get per-formula projected costs
router.get('/api/meow/cognitive/predictions/cost/formula-costs', async (_req: Request, res: Response) => {
  try {
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    res.json(await forecaster.getFormulaProjectedCosts());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/predictions/cost/budget — Set monthly budget
router.put('/api/meow/cognitive/predictions/cost/budget', async (req: Request, res: Response) => {
  try {
    const { budgetUsd } = req.body;
    if (budgetUsd === undefined) return res.status(400).json({ error: 'budgetUsd required' });
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    forecaster.setMonthlyBudget(budgetUsd);
    res.json({ ok: true, budgetUsd: forecaster.getMonthlyBudget() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/cost/budget — Get monthly budget
router.get('/api/meow/cognitive/predictions/cost/budget', async (_req: Request, res: Response) => {
  try {
    const { getCostForecaster } = await import('./cognitive/cost-forecasting');
    const forecaster = getCostForecaster();
    res.json({ budgetUsd: forecaster.getMonthlyBudget() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-011: Demand Forecasting ──────────────────────────────────────────────

// GET /api/meow/cognitive/predictions/demand/forecast — Forecast demand
router.get('/api/meow/cognitive/predictions/demand/forecast', async (req: Request, res: Response) => {
  try {
    const hoursAhead = parseInt(req.query.hours as string, 10) || 24;
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const forecaster = getDemandForecaster();
    const forecast = await forecaster.forecastDemand(hoursAhead);
    res.json(forecast);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/demand/pool-size — Get recommended pool size
router.get('/api/meow/cognitive/predictions/demand/pool-size', async (_req: Request, res: Response) => {
  try {
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const forecaster = getDemandForecaster();
    res.json(await forecaster.getRecommendedPoolSize());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/demand/load-trend — Get current load trend
router.get('/api/meow/cognitive/predictions/demand/load-trend', async (_req: Request, res: Response) => {
  try {
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const forecaster = getDemandForecaster();
    res.json(await forecaster.getCurrentLoadTrend());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/demand/hourly-pattern — Get hourly pattern
router.get('/api/meow/cognitive/predictions/demand/hourly-pattern', async (_req: Request, res: Response) => {
  try {
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const forecaster = getDemandForecaster();
    res.json(await forecaster.getHourlyPattern());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/demand/day-pattern — Get day-of-week pattern
router.get('/api/meow/cognitive/predictions/demand/day-pattern', async (_req: Request, res: Response) => {
  try {
    const { getDemandForecaster } = await import('./cognitive/demand-forecasting');
    const forecaster = getDemandForecaster();
    res.json(await forecaster.getDayOfWeekPattern());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-012: Outcome Prediction ──────────────────────────────────────────────

// POST /api/meow/cognitive/predictions/outcome/predict — Predict outcome
router.post('/api/meow/cognitive/predictions/outcome/predict', async (req: Request, res: Response) => {
  try {
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    const { formulaName, vars } = req.body;
    const prediction = await predictor.predictOutcome(formulaName, vars);
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/predictions/outcome/should-execute — Should execute now?
router.post('/api/meow/cognitive/predictions/outcome/should-execute', async (req: Request, res: Response) => {
  try {
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    const { formulaName, vars } = req.body;
    const decision = await predictor.shouldExecuteNow(formulaName, vars);
    res.json(decision);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/outcome/formula/:name/roi — Get expected ROI
router.get('/api/meow/cognitive/predictions/outcome/formula/:name/roi', async (req: Request, res: Response) => {
  try {
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    res.json(await predictor.getFormulaExpectedROI(req.params.name));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/predictions/outcome/validate — Validate past predictions
router.post('/api/meow/cognitive/predictions/outcome/validate', async (_req: Request, res: Response) => {
  try {
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    const validation = await predictor.validatePredictions();
    res.json(validation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/predictions/outcome/record-actual — Record actual outcome
router.post('/api/meow/cognitive/predictions/outcome/record-actual', async (req: Request, res: Response) => {
  try {
    const { predictionId, actual } = req.body;
    if (!predictionId || actual === undefined) {
      return res.status(400).json({ error: 'predictionId and actual required' });
    }
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    await predictor.recordActual(predictionId, actual);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/predictions/outcome/count — Get prediction count
router.get('/api/meow/cognitive/predictions/outcome/count', async (_req: Request, res: Response) => {
  try {
    const { getOutcomePredictor } = await import('./cognitive/outcome-prediction');
    const predictor = getOutcomePredictor();
    res.json({ count: predictor.getPredictionCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4: SMART ROUTING — /api/meow/cognitive/routing/*
// CG-013: Intelligent Mail Routing | CG-014: Dynamic Tier Adjustment
// CG-015: Skill Auto-Selection | CG-016: Cross-Formula Optimization
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/routing/status', async (_req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    res.json({
      mailRouter: { active: !!getIntelligentMailRouter },
      tierAdjuster: { active: !!getDynamicTierAdjuster },
      skillSelector: { active: !!getSkillAutoSelector },
      formulaOptimizer: { active: !!getCrossFormulaOptimizer },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-013: Intelligent Mail Routing ────────────────────────────────────────

// POST /api/meow/cognitive/routing/mail/route — Route a mail intelligently
router.post('/api/meow/cognitive/routing/mail/route', async (req: Request, res: Response) => {
  try {
    const { mail } = req.body;
    if (!mail) return res.status(400).json({ error: 'mail required' });
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    const routed = await imr.routeMail(mail);
    res.json(routed);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/mail/feedback — Record delivery feedback
router.post('/api/meow/cognitive/routing/mail/feedback', async (req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    const { recipientId, channel, success, acknowledged } = req.body;
    await imr.recordDeliveryFeedback(recipientId, channel, success, acknowledged);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/mail/channel-health — Update channel health
router.post('/api/meow/cognitive/routing/mail/channel-health', async (req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    const { channel, healthy, latencyMs, rateLimitRemaining } = req.body;
    await imr.updateChannelHealth(channel, healthy, latencyMs, rateLimitRemaining);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/mail/preference/:recipientId — Get recipient preference
router.get('/api/meow/cognitive/routing/mail/preference/:recipientId', async (req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    res.json(imr.getRecipientPreference(req.params.recipientId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/routing/mail/quiet-hours — Set quiet hours
router.put('/api/meow/cognitive/routing/mail/quiet-hours', async (req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    const { recipientId, startHour, endHour, timezone } = req.body;
    await imr.setQuietHours(recipientId, startHour, endHour, timezone);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/mail/stats — Mail routing stats
router.get('/api/meow/cognitive/routing/mail/stats', async (_req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    res.json(imr.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/mail/channel-overview — Get channel health overview
router.get('/api/meow/cognitive/routing/mail/channel-overview', async (_req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    res.json(imr.getChannelHealthOverview());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/mail/load-preferences — Load preferences from storage
router.post('/api/meow/cognitive/routing/mail/load-preferences', async (_req: Request, res: Response) => {
  try {
    const { getIntelligentMailRouter } = await import('./cognitive/intelligent-mail-routing');
    const imr = getIntelligentMailRouter();
    await imr.loadPreferences();
    res.json({ ok: true, message: 'Preferences loaded' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-014: Dynamic Tier Adjustment ─────────────────────────────────────────

// POST /api/meow/cognitive/routing/tiers/record — Record task completion
router.post('/api/meow/cognitive/routing/tiers/record', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    const { workerId, taskType, tier, success, qualityScore, durationMs, costUsd, tokenCount } = req.body;
    await adjuster.recordTaskCompletion(workerId, taskType, tier, success, qualityScore, durationMs, costUsd, tokenCount);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/tiers/evaluate/:workerId — Evaluate worker tier
router.get('/api/meow/cognitive/routing/tiers/evaluate/:workerId', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    const evaluation = await adjuster.evaluate(req.params.workerId);
    res.json(evaluation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/tiers/apply — Apply tier adjustment
router.post('/api/meow/cognitive/routing/tiers/apply', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    const { workerId, fromTier, toTier, approvedBy } = req.body;
    const result = await adjuster.applyAdjustment(workerId, fromTier, toTier, approvedBy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/routing/tiers/budget — Update budget allocation
router.put('/api/meow/cognitive/routing/tiers/budget', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    const { monthlyBudgetUsd, spentThisMonthUsd, projectedMonthlyUsd } = req.body;
    await adjuster.updateBudget(monthlyBudgetUsd, spentThisMonthUsd, projectedMonthlyUsd);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/tiers/:workerId — Get current tier
router.get('/api/meow/cognitive/routing/tiers/:workerId', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    res.json({ tier: adjuster.getCurrentTier(req.params.workerId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/tiers/model/:tier — Get model for tier
router.get('/api/meow/cognitive/routing/tiers/model/:tier', async (req: Request, res: Response) => {
  try {
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    res.json({ model: adjuster.getModelForTier(req.params.tier as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/tiers/recommendations — Get recommendations
router.get('/api/meow/cognitive/routing/tiers/recommendations', async (req: Request, res: Response) => {
  try {
    const workerId = req.query.workerId as string | undefined;
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    res.json(adjuster.getRecommendations(workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/tiers/history — Get adjustment history
router.get('/api/meow/cognitive/routing/tiers/history', async (req: Request, res: Response) => {
  try {
    const workerId = req.query.workerId as string | undefined;
    const { getDynamicTierAdjuster } = await import('./cognitive/dynamic-tier-adjustment');
    const adjuster = getDynamicTierAdjuster();
    res.json(adjuster.getAdjustmentHistory(workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-015: Skill Auto-Selection ────────────────────────────────────────────

// POST /api/meow/cognitive/routing/skills/register — Register a skill
router.post('/api/meow/cognitive/routing/skills/register', async (req: Request, res: Response) => {
  try {
    const { manifest } = req.body;
    if (!manifest) return res.status(400).json({ error: 'manifest required' });
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    const result = await selector.registerSkill(manifest);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/skills/select — Select skills for a bead
router.post('/api/meow/cognitive/routing/skills/select', async (req: Request, res: Response) => {
  try {
    const { bead } = req.body;
    if (!bead) return res.status(400).json({ error: 'bead required' });
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    const skills = await selector.selectSkillsForBead(bead);
    res.json(skills);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/skills/feedback — Record skill selection feedback
router.post('/api/meow/cognitive/routing/skills/feedback', async (req: Request, res: Response) => {
  try {
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    const { selectionId, beadId, selectedSkill, outcome, correctSkill, feedbackNote } = req.body;
    await selector.recordFeedback(selectionId, beadId, selectedSkill, outcome, correctSkill, feedbackNote);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/skills/stats — Get skill selection stats
router.get('/api/meow/cognitive/routing/skills/stats', async (_req: Request, res: Response) => {
  try {
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    res.json(selector.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/skills/bead/:beadId — Get selection for bead
router.get('/api/meow/cognitive/routing/skills/bead/:beadId', async (req: Request, res: Response) => {
  try {
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    res.json(selector.getSelectionForBead(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/skills/profiles — Get all skill profiles
router.get('/api/meow/cognitive/routing/skills/profiles', async (_req: Request, res: Response) => {
  try {
    const { getSkillAutoSelector } = await import('./cognitive/skill-auto-selection');
    const selector = getSkillAutoSelector();
    res.json(selector.getSkillProfiles());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-016: Cross-Formula Optimization ──────────────────────────────────────

// POST /api/meow/cognitive/routing/cross-formula/analyze — Run cross-formula analysis
router.post('/api/meow/cognitive/routing/cross-formula/analyze', async (_req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    const report = await optimizer.runAnalysis();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/cross-formula/suggestions — Get pending suggestions
router.get('/api/meow/cognitive/routing/cross-formula/suggestions', async (req: Request, res: Response) => {
  try {
    const formulaName = req.query.formula as string | undefined;
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    const suggestions = formulaName
      ? optimizer.getSuggestions(formulaName)
      : optimizer.getPendingSuggestions();
    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/cross-formula/conflicts — Get active conflicts
router.get('/api/meow/cognitive/routing/cross-formula/conflicts', async (_req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    res.json(optimizer.getActiveConflicts());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/cross-formula/interactions — Get formula interactions
router.get('/api/meow/cognitive/routing/cross-formula/interactions', async (_req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    res.json(optimizer.getInteractions());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/routing/cross-formula/reports — Get recent reports
router.get('/api/meow/cognitive/routing/cross-formula/reports', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    res.json(optimizer.getRecentReports(limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/cross-formula/periodic/start — Start periodic analysis
router.post('/api/meow/cognitive/routing/cross-formula/periodic/start', async (_req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    optimizer.startPeriodicAnalysis();
    res.json({ ok: true, message: 'Periodic analysis started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/routing/cross-formula/periodic/stop — Stop periodic analysis
router.post('/api/meow/cognitive/routing/cross-formula/periodic/stop', async (_req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    optimizer.stopPeriodicAnalysis();
    res.json({ ok: true, message: 'Periodic analysis stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/routing/cross-formula/suggestions/:id/status — Update suggestion status
router.put('/api/meow/cognitive/routing/cross-formula/suggestions/:id/status', async (req: Request, res: Response) => {
  try {
    const { getCrossFormulaOptimizer } = await import('./cognitive/cross-formula-optimization');
    const optimizer = getCrossFormulaOptimizer();
    const { status } = req.body;
    const result = await optimizer.updateSuggestionStatus(req.params.id, status);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 5: SELF-HEALING — /api/meow/cognitive/healing/*
// CG-017: Auto-Retry Intelligence | CG-018: Zombie Detection
// CG-019: Queue Rebalancing | CG-020: Drift Detection
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/healing/status', async (_req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    res.json({
      autoRetry: { active: !!getAutoRetryIntelligence },
      zombieDetector: { active: !!getZombieDetector },
      queueRebalancer: { active: !!getQueueRebalancer },
      driftDetector: { active: !!getDriftDetector },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-017: Auto-Retry Intelligence ────────────────────────────────────────

// POST /api/meow/cognitive/healing/retry/classify — Classify an error
router.post('/api/meow/cognitive/healing/retry/classify', async (req: Request, res: Response) => {
  try {
    const { error, context } = req.body;
    if (!error) return res.status(400).json({ error: 'error required' });
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    const classification = await retryEngine.classifyError(error, context);
    res.json(classification);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/retry/decide — Decide whether to retry
router.post('/api/meow/cognitive/healing/retry/decide', async (req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    const { beadId, error, attemptNumber, context } = req.body;
    const decision = await retryEngine.decideRetry(beadId, error, attemptNumber, context);
    res.json(decision);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/retry/record-outcome — Record retry outcome
router.post('/api/meow/cognitive/healing/retry/record-outcome', async (req: Request, res: Response) => {
  try {
    const { attemptId, success } = req.body;
    if (!attemptId || success === undefined) {
      return res.status(400).json({ error: 'attemptId and success (boolean) required' });
    }
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    await retryEngine.recordOutcome(attemptId, success);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/retry/report — Get retry report
router.get('/api/meow/cognitive/healing/retry/report', async (_req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    res.json(retryEngine.getReport());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/healing/retry/budget/:beadId — Set retry budget for bead
router.put('/api/meow/cognitive/healing/retry/budget/:beadId', async (req: Request, res: Response) => {
  try {
    const { maxCostUsd, maxAttempts } = req.body;
    if (maxCostUsd === undefined) return res.status(400).json({ error: 'maxCostUsd required' });
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    retryEngine.setBudget(req.params.beadId, maxCostUsd, maxAttempts);
    res.json({ ok: true, budget: retryEngine.getBudget(req.params.beadId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/retry/budget/:beadId — Get retry budget for bead
router.get('/api/meow/cognitive/healing/retry/budget/:beadId', async (req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    res.json(retryEngine.getBudget(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/retry/history/:beadId — Get retry history for bead
router.get('/api/meow/cognitive/healing/retry/history/:beadId', async (req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    res.json(retryEngine.getRetryHistory(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/retry/success-rates — Get success rates by error class
router.get('/api/meow/cognitive/healing/retry/success-rates', async (_req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    res.json(retryEngine.getClassSuccessRates());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/retry/count — Get total attempt count
router.get('/api/meow/cognitive/healing/retry/count', async (_req: Request, res: Response) => {
  try {
    const { getAutoRetryIntelligence } = await import('./cognitive/auto-retry-intelligence');
    const retryEngine = getAutoRetryIntelligence();
    res.json({ count: retryEngine.getAttemptCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-018: Zombie Detection ────────────────────────────────────────────────

// POST /api/meow/cognitive/healing/zombie/score — Score a worker for zombie risk
router.post('/api/meow/cognitive/healing/zombie/score', async (req: Request, res: Response) => {
  try {
    const { workerId, beadId } = req.body;
    if (!workerId) return res.status(400).json({ error: 'workerId required' });
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    const score = await detector.scoreWorker(workerId, beadId);
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/respond — Respond to zombie score
router.post('/api/meow/cognitive/healing/zombie/respond', async (req: Request, res: Response) => {
  try {
    const { score } = req.body;
    if (!score) return res.status(400).json({ error: 'score required' });
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    const response = await detector.respond(score);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/check-risk — Check zombie risk for skill/formula
router.post('/api/meow/cognitive/healing/zombie/check-risk', async (req: Request, res: Response) => {
  try {
    const { skill, formulaName } = req.body;
    if (!skill) return res.status(400).json({ error: 'skill required' });
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    const risk = await detector.checkZombieRisk(skill, formulaName);
    res.json(risk);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/scan-all — Scan all workers
router.post('/api/meow/cognitive/healing/zombie/scan-all', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    const results = await detector.scanAllWorkers();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/scanner/start — Start zombie scanner
router.post('/api/meow/cognitive/healing/zombie/scanner/start', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    detector.startScanner();
    res.json({ ok: true, message: 'Zombie scanner started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/scanner/stop — Stop zombie scanner
router.post('/api/meow/cognitive/healing/zombie/scanner/stop', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    detector.stopScanner();
    res.json({ ok: true, message: 'Zombie scanner stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/zombie/scanner/running — Check if scanner is running
router.get('/api/meow/cognitive/healing/zombie/scanner/running', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    res.json({ running: detector.isScannerRunning() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/zombie/recover/:workerId — Mark worker as recovered
router.post('/api/meow/cognitive/healing/zombie/recover/:workerId', async (req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    await detector.markRecovered(req.params.workerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/zombie/report — Get zombie detection report
router.get('/api/meow/cognitive/healing/zombie/report', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    res.json(detector.getReport());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/healing/zombie/threshold — Set threshold override
router.put('/api/meow/cognitive/healing/zombie/threshold', async (req: Request, res: Response) => {
  try {
    const { workerIdOrType, overrides } = req.body;
    if (!workerIdOrType || !overrides) {
      return res.status(400).json({ error: 'workerIdOrType and overrides required' });
    }
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    detector.setThresholdOverride(workerIdOrType, overrides);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/zombie/event-count — Get event count
router.get('/api/meow/cognitive/healing/zombie/event-count', async (_req: Request, res: Response) => {
  try {
    const { getZombieDetector } = await import('./cognitive/zombie-detection-advanced');
    const detector = getZombieDetector();
    res.json({ count: detector.getEventCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-019: Queue Rebalancing ───────────────────────────────────────────────

// GET /api/meow/cognitive/healing/queues — Get worker queues
router.get('/api/meow/cognitive/healing/queues', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    res.json(rebalancer.getWorkerQueues());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/queues/imbalance — Detect imbalance
router.get('/api/meow/cognitive/healing/queues/imbalance', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    res.json(await rebalancer.detectImbalance());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/queues/rebalance — Rebalance queues now
router.post('/api/meow/cognitive/healing/queues/rebalance', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    const result = await rebalancer.rebalance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/queues/rebalancer/start — Start rebalancer loop
router.post('/api/meow/cognitive/healing/queues/rebalancer/start', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    rebalancer.startRebalancer();
    res.json({ ok: true, message: 'Queue rebalancer started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/queues/rebalancer/stop — Stop rebalancer loop
router.post('/api/meow/cognitive/healing/queues/rebalancer/stop', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    rebalancer.stopRebalancer();
    res.json({ ok: true, message: 'Queue rebalancer stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/queues/rebalancer/running — Check if rebalancer is running
router.get('/api/meow/cognitive/healing/queues/rebalancer/running', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    res.json({ running: rebalancer.isRebalancerRunning() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/queues/report — Get rebalancing report
router.get('/api/meow/cognitive/healing/queues/report', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    res.json(rebalancer.getReport());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/queues/event-count — Get event count
router.get('/api/meow/cognitive/healing/queues/event-count', async (_req: Request, res: Response) => {
  try {
    const { getQueueRebalancer } = await import('./cognitive/queue-rebalancing');
    const rebalancer = getQueueRebalancer();
    res.json({ count: rebalancer.getEventCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-020: Drift Detection ────────────────────────────────────────────────

// POST /api/meow/cognitive/healing/drift/compute-baselines — Compute baselines
router.post('/api/meow/cognitive/healing/drift/compute-baselines', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    const baselines = await detector.computeBaselines();
    res.json(baselines);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/drift/scan — Run drift scan
router.post('/api/meow/cognitive/healing/drift/scan', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    const results = await detector.scan();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/drift/acknowledge/:eventId — Acknowledge drift event
router.post('/api/meow/cognitive/healing/drift/acknowledge/:eventId', async (req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    await detector.acknowledgeDrift(req.params.eventId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/drift/monitor/start — Start drift monitor
router.post('/api/meow/cognitive/healing/drift/monitor/start', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    detector.startMonitor();
    res.json({ ok: true, message: 'Drift monitor started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/healing/drift/monitor/stop — Stop drift monitor
router.post('/api/meow/cognitive/healing/drift/monitor/stop', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    detector.stopMonitor();
    res.json({ ok: true, message: 'Drift monitor stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/drift/monitor/running — Check if monitor is running
router.get('/api/meow/cognitive/healing/drift/monitor/running', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    res.json({ running: detector.isMonitorRunning() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/drift/report — Get drift report
router.get('/api/meow/cognitive/healing/drift/report', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    res.json(detector.getReport());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/drift/alerts — Get active alerts
router.get('/api/meow/cognitive/healing/drift/alerts', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    res.json(detector.getActiveAlerts());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/drift/baseline/:metricName — Get specific baseline
router.get('/api/meow/cognitive/healing/drift/baseline/:metricName', async (req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    res.json(detector.getBaseline(req.params.metricName));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/healing/drift/sensitivity — Set sensitivity
router.put('/api/meow/cognitive/healing/drift/sensitivity', async (req: Request, res: Response) => {
  try {
    const { metricType, sigmaWarning, sigmaCritical } = req.body;
    if (!metricType || sigmaWarning === undefined || sigmaCritical === undefined) {
      return res.status(400).json({ error: 'metricType, sigmaWarning, and sigmaCritical required' });
    }
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    detector.setSensitivity(metricType, sigmaWarning, sigmaCritical);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/healing/drift/event-count — Get event count
router.get('/api/meow/cognitive/healing/drift/event-count', async (_req: Request, res: Response) => {
  try {
    const { getDriftDetector } = await import('./cognitive/drift-detection');
    const detector = getDriftDetector();
    res.json({ count: detector.getEventCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 6: KNOWLEDGE INTEGRATION — /api/meow/cognitive/knowledge/*
// CG-021: MegaBrain Worker Context | CG-022: NOUS Epistemic Injection
// CG-023: Atlas Country Injection | CG-024: Cross-Molecule Knowledge
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/knowledge/status', async (_req: Request, res: Response) => {
  try {
    const { getMegaBrainWorkerContext } = await import('./cognitive/megabrain-worker-context');
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    res.json({
      megabrainContext: { active: !!getMegaBrainWorkerContext },
      nousInjector: { active: !!getNousEpistemicInjector },
      atlasInjector: { active: !!getAtlasCountryInjector },
      crossMolecule: { active: !!getCrossMoleculeKnowledge },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-021: MegaBrain Worker Context ────────────────────────────────────────

// POST /api/meow/cognitive/knowledge/megabrain/context — Build context window
router.post('/api/meow/cognitive/knowledge/megabrain/context', async (req: Request, res: Response) => {
  try {
    const { getMegaBrainWorkerContext } = await import('./cognitive/megabrain-worker-context');
    const ctx = getMegaBrainWorkerContext();
    const { bead, worker } = req.body;
    const window = await ctx.buildContextWindow(bead, worker);
    res.json(window);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/megabrain/record-outcome — Record bead outcome
router.post('/api/meow/cognitive/knowledge/megabrain/record-outcome', async (req: Request, res: Response) => {
  try {
    const { getMegaBrainWorkerContext } = await import('./cognitive/megabrain-worker-context');
    const ctx = getMegaBrainWorkerContext();
    const { beadId, success } = req.body;
    await ctx.recordBeadOutcome(beadId, success);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/megabrain/stats — Get context stats
router.get('/api/meow/cognitive/knowledge/megabrain/stats', async (_req: Request, res: Response) => {
  try {
    const { getMegaBrainWorkerContext } = await import('./cognitive/megabrain-worker-context');
    const ctx = getMegaBrainWorkerContext();
    res.json(ctx.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/megabrain/clear-cache — Clear context cache
router.post('/api/meow/cognitive/knowledge/megabrain/clear-cache', async (_req: Request, res: Response) => {
  try {
    const { getMegaBrainWorkerContext } = await import('./cognitive/megabrain-worker-context');
    const ctx = getMegaBrainWorkerContext();
    ctx.clearCache();
    res.json({ ok: true, message: 'Cache cleared' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-022: NOUS Epistemic Injection ────────────────────────────────────────

// POST /api/meow/cognitive/knowledge/nous/inject-decision — Inject for decision
router.post('/api/meow/cognitive/knowledge/nous/inject-decision', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const injector = getNousEpistemicInjector();
    const { context, beadId } = req.body;
    const result = await injector.injectForDecision(context, beadId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/nous/inject-dissent — Inject dissent perspective
router.post('/api/meow/cognitive/knowledge/nous/inject-dissent', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const injector = getNousEpistemicInjector();
    const { context, currentConfidence, beadId } = req.body;
    const result = await injector.injectDissent(context, currentConfidence, beadId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/nous/assess-rigor — Assess epistemic rigor
router.post('/api/meow/cognitive/knowledge/nous/assess-rigor', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const injector = getNousEpistemicInjector();
    const { context, proposedDecision } = req.body;
    const assessment = await injector.assessRigor(context, proposedDecision);
    res.json(assessment);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/knowledge/nous/config — Update NOUS injector config
router.put('/api/meow/cognitive/knowledge/nous/config', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const injector = getNousEpistemicInjector();
    injector.updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/nous/stats — Get NOUS injection stats
router.get('/api/meow/cognitive/knowledge/nous/stats', async (_req: Request, res: Response) => {
  try {
    const { getNousEpistemicInjector } = await import('./cognitive/nous-epistemic-injection');
    const injector = getNousEpistemicInjector();
    res.json(injector.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-023: Atlas Country Injection ─────────────────────────────────────────

// POST /api/meow/cognitive/knowledge/atlas/inject-bead — Inject country context for bead
router.post('/api/meow/cognitive/knowledge/atlas/inject-bead', async (req: Request, res: Response) => {
  try {
    const { bead } = req.body;
    if (!bead) return res.status(400).json({ error: 'bead required' });
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    const result = await injector.injectForBead(bead);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/atlas/inject-countries — Inject for multiple countries
router.post('/api/meow/cognitive/knowledge/atlas/inject-countries', async (req: Request, res: Response) => {
  try {
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    const result = await injector.injectForCountries(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/atlas/country/:code — Get country intelligence
router.get('/api/meow/cognitive/knowledge/atlas/country/:code', async (req: Request, res: Response) => {
  try {
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    const intel = await injector.getCountryIntelligence(req.params.code as any);
    res.json(intel);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/atlas/refresh — Refresh volatile data
router.post('/api/meow/cognitive/knowledge/atlas/refresh', async (_req: Request, res: Response) => {
  try {
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    await injector.refreshVolatileData();
    res.json({ ok: true, message: 'Volatile data refreshed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/atlas/stats — Get Atlas stats
router.get('/api/meow/cognitive/knowledge/atlas/stats', async (_req: Request, res: Response) => {
  try {
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    res.json(injector.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/atlas/cache — Get all cached intelligence
router.get('/api/meow/cognitive/knowledge/atlas/cache', async (_req: Request, res: Response) => {
  try {
    const { getAtlasCountryInjector } = await import('./cognitive/atlas-country-injection');
    const injector = getAtlasCountryInjector();
    res.json(injector.getAllCachedIntelligence());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-024: Cross-Molecule Knowledge ────────────────────────────────────────

// POST /api/meow/cognitive/knowledge/cross-molecule/publish — Publish knowledge
router.post('/api/meow/cognitive/knowledge/cross-molecule/publish', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const { moleculeId, topic, type, title, content } = req.body;
    const result = await km.publish(moleculeId, topic, type, title, content);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/cross-molecule/subscribe — Subscribe to topic
router.post('/api/meow/cognitive/knowledge/cross-molecule/subscribe', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const { moleculeId, topics } = req.body;
    const subscription = km.subscribe(moleculeId, topics);
    res.status(201).json(subscription);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/cognitive/knowledge/cross-molecule/subscribe/:id — Unsubscribe
router.delete('/api/meow/cognitive/knowledge/cross-molecule/subscribe/:id', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    await km.unsubscribe(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/cross-molecule/query — Query topic
router.post('/api/meow/cognitive/knowledge/cross-molecule/query', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const results = await km.queryTopic(req.body);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/cross-molecule/molecule/:moleculeId — Query for molecule
router.get('/api/meow/cognitive/knowledge/cross-molecule/molecule/:moleculeId', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const results = await km.queryForMolecule(req.params.moleculeId as any);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/cross-molecule/related/:moleculeId — Detect related molecules
router.get('/api/meow/cognitive/knowledge/cross-molecule/related/:moleculeId', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const related = await km.detectRelatedMolecules(req.params.moleculeId);
    res.json(related);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/knowledge/cross-molecule/gc — Run garbage collection
router.post('/api/meow/cognitive/knowledge/cross-molecule/gc', async (_req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    const result = await km.gc();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/knowledge/cross-molecule/stats — Get stats
router.get('/api/meow/cognitive/knowledge/cross-molecule/stats', async (_req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    res.json(km.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/knowledge/cross-molecule/config — Update config
router.put('/api/meow/cognitive/knowledge/cross-molecule/config', async (req: Request, res: Response) => {
  try {
    const { getCrossMoleculeKnowledge } = await import('./cognitive/cross-molecule-knowledge');
    const km = getCrossMoleculeKnowledge();
    km.updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 7: AUTONOMOUS DECISIONS — /api/meow/cognitive/decisions/*
// CG-025: Auto-Approve Engine | CG-026: Budget Management AI
// CG-027: Escalation Intelligence | CG-028: Formula Scheduling AI
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/decisions/status', async (_req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    res.json({
      autoApprove: { active: !!getAutoApproveEngine },
      budgetAI: { active: !!getBudgetManagementAI },
      escalation: { active: !!getEscalationIntelligence },
      formulaScheduler: { active: !!getFormulaSchedulingAI },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-025: Auto-Approve Engine ─────────────────────────────────────────────

// POST /api/meow/cognitive/decisions/approve/evaluate — Evaluate approval request
router.post('/api/meow/cognitive/decisions/approve/evaluate', async (req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    const { bead, skillChain, requestedBy, estimatedCostUsd, capabilities, moleculeId } = req.body;
    const result = await engine.evaluateApproval(bead, skillChain, requestedBy, estimatedCostUsd, capabilities, moleculeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/approve/:requestId/human-approve — Human approve
router.post('/api/meow/cognitive/decisions/approve/:requestId/human-approve', async (req: Request, res: Response) => {
  try {
    const { approvedBy } = req.body;
    if (!approvedBy) return res.status(400).json({ error: 'approvedBy required' });
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    const result = await engine.humanApprove(req.params.requestId, approvedBy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/approve/:requestId/human-reject — Human reject
router.post('/api/meow/cognitive/decisions/approve/:requestId/human-reject', async (req: Request, res: Response) => {
  try {
    const { rejectedBy, reason } = req.body;
    if (!rejectedBy) return res.status(400).json({ error: 'rejectedBy required' });
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    const result = await engine.humanReject(req.params.requestId, rejectedBy, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/request/:requestId — Get request
router.get('/api/meow/cognitive/decisions/approve/request/:requestId', async (req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    const request = engine.getRequest(req.params.requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/pending — Get pending requests
router.get('/api/meow/cognitive/decisions/approve/pending', async (_req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    res.json(engine.getPendingRequests());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/bead/:beadId — Get requests for bead
router.get('/api/meow/cognitive/decisions/approve/bead/:beadId', async (req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    res.json(engine.getRequestsForBead(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/decisions/approve/thresholds — Set thresholds
router.put('/api/meow/cognitive/decisions/approve/thresholds', async (req: Request, res: Response) => {
  try {
    const { key, thresholds } = req.body;
    if (!key || !thresholds) return res.status(400).json({ error: 'key and thresholds required' });
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    engine.setThresholds(key, thresholds);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/thresholds — Get thresholds
router.get('/api/meow/cognitive/decisions/approve/thresholds', async (req: Request, res: Response) => {
  try {
    const orgOrTeam = req.query.orgOrTeam as string | undefined;
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    res.json(engine.getThresholds(orgOrTeam));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/approve/policies — Add policy
router.post('/api/meow/cognitive/decisions/approve/policies', async (req: Request, res: Response) => {
  try {
    const { policy } = req.body;
    if (!policy) return res.status(400).json({ error: 'policy required' });
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    engine.addPolicy(policy);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/policies — Get policies
router.get('/api/meow/cognitive/decisions/approve/policies', async (_req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    res.json(engine.getPolicies());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/approve/stats — Get approval stats
router.get('/api/meow/cognitive/decisions/approve/stats', async (_req: Request, res: Response) => {
  try {
    const { getAutoApproveEngine } = await import('./cognitive/auto-approve-engine');
    const engine = getAutoApproveEngine();
    res.json(engine.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-026: Budget Management AI ────────────────────────────────────────────

// POST /api/meow/cognitive/decisions/budget/record-spend — Record spend entry
router.post('/api/meow/cognitive/decisions/budget/record-spend', async (req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    await budget.recordSpend(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/decisions/budget/rules — Set budget rule
router.put('/api/meow/cognitive/decisions/budget/rules', async (req: Request, res: Response) => {
  try {
    const { scope, scopeKey, limitUsd, period } = req.body;
    if (!scope || !scopeKey || limitUsd === undefined) {
      return res.status(400).json({ error: 'scope, scopeKey, and limitUsd required' });
    }
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    budget.setBudgetRule(scope, scopeKey, limitUsd, period);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/rules — Get all rules
router.get('/api/meow/cognitive/decisions/budget/rules', async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.active === 'true';
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(activeOnly ? budget.getActiveRules() : budget.getAllRules());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/budget/check — Check budget for formula/worker
router.post('/api/meow/cognitive/decisions/budget/check', async (req: Request, res: Response) => {
  try {
    const { formulaName, workerId, estimatedCostUsd } = req.body;
    if (!formulaName) return res.status(400).json({ error: 'formulaName required' });
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    const check = await budget.checkBudget(formulaName, workerId, estimatedCostUsd);
    res.json(check);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/burn-rate — Analyze burn rate
router.get('/api/meow/cognitive/decisions/budget/burn-rate', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(await budget.analyzeBurnRate());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/attribution — Get cost attribution
router.get('/api/meow/cognitive/decisions/budget/attribution', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(await budget.getCostAttribution());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/budget/suggestions — Generate cost suggestions
router.post('/api/meow/cognitive/decisions/budget/suggestions', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    const suggestions = await budget.generateSuggestions();
    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/suggestions — Get recent suggestions
router.get('/api/meow/cognitive/decisions/budget/suggestions', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(budget.getSuggestions(limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/monthly-report — Generate monthly report
router.get('/api/meow/cognitive/decisions/budget/monthly-report', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(await budget.generateMonthlyReport());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/decisions/budget/monthly — Set monthly budget
router.put('/api/meow/cognitive/decisions/budget/monthly', async (req: Request, res: Response) => {
  try {
    const { budgetUsd } = req.body;
    if (budgetUsd === undefined) return res.status(400).json({ error: 'budgetUsd required' });
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    budget.setMonthlyBudget(budgetUsd);
    res.json({ ok: true, budgetUsd: budget.getMonthlyBudget() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/monthly — Get monthly budget
router.get('/api/meow/cognitive/decisions/budget/monthly', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json({ budgetUsd: budget.getMonthlyBudget() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/stats — Get budget stats
router.get('/api/meow/cognitive/decisions/budget/stats', async (_req: Request, res: Response) => {
  try {
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(budget.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/budget/alerts — Get recent alerts
router.get('/api/meow/cognitive/decisions/budget/alerts', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { getBudgetManagementAI } = await import('./cognitive/budget-management-ai');
    const budget = getBudgetManagementAI();
    res.json(budget.getRecentAlerts(limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-027: Escalation Intelligence ─────────────────────────────────────────

// POST /api/meow/cognitive/decisions/escalation/create — Create escalation
router.post('/api/meow/cognitive/decisions/escalation/create', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    const { title, description, context, beadId, moleculeId, convoyId } = req.body;
    const event = await escalation.createEscalation(title, description, context, beadId, moleculeId, convoyId);
    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/escalation/:eventId/acknowledge — Acknowledge
router.post('/api/meow/cognitive/decisions/escalation/:eventId/acknowledge', async (req: Request, res: Response) => {
  try {
    const { operatorId } = req.body;
    if (!operatorId) return res.status(400).json({ error: 'operatorId required' });
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    await escalation.acknowledge(req.params.eventId, operatorId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/escalation/:eventId/resolve — Resolve
router.post('/api/meow/cognitive/decisions/escalation/:eventId/resolve', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    const { resolvedBy, action, couldHaveBeenLower, notes } = req.body;
    await escalation.resolve(req.params.eventId, resolvedBy, action, couldHaveBeenLower, notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/escalation/:eventId/escalate — Manual escalation
router.post('/api/meow/cognitive/decisions/escalation/:eventId/escalate', async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    await escalation.escalateManually(req.params.eventId, reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/escalation/on-call — Register on-call
router.post('/api/meow/cognitive/decisions/escalation/on-call', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    escalation.registerOnCall(req.body);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/cognitive/decisions/escalation/on-call/:operatorId — Remove on-call
router.delete('/api/meow/cognitive/decisions/escalation/on-call/:operatorId', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    escalation.removeOnCall(req.params.operatorId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/on-call — Get on-call schedule
router.get('/api/meow/cognitive/decisions/escalation/on-call', async (_req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(escalation.getOnCallSchedule());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/fatigue — Analyze fatigue
router.get('/api/meow/cognitive/decisions/escalation/fatigue', async (_req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(await escalation.analyzeFatigue());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/resolution-patterns — Resolution patterns
router.get('/api/meow/cognitive/decisions/escalation/resolution-patterns', async (_req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(await escalation.getResolutionPatterns());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/event/:eventId — Get event
router.get('/api/meow/cognitive/decisions/escalation/event/:eventId', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    const event = escalation.getEvent(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/open — Get open events
router.get('/api/meow/cognitive/decisions/escalation/open', async (_req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(escalation.getOpenEvents());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/bead/:beadId — Events for bead
router.get('/api/meow/cognitive/decisions/escalation/bead/:beadId', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(escalation.getEventsForBead(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/operator/:operatorId — Events for operator
router.get('/api/meow/cognitive/decisions/escalation/operator/:operatorId', async (req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(escalation.getEventsForOperator(req.params.operatorId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/escalation/stats — Escalation stats
router.get('/api/meow/cognitive/decisions/escalation/stats', async (_req: Request, res: Response) => {
  try {
    const { getEscalationIntelligence } = await import('./cognitive/escalation-intelligence');
    const escalation = getEscalationIntelligence();
    res.json(escalation.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-028: Formula Scheduling AI ───────────────────────────────────────────

// POST /api/meow/cognitive/decisions/scheduling/schedule — Schedule a formula
router.post('/api/meow/cognitive/decisions/scheduling/schedule', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    const { formulaName, priority, resourceReqs, preferredTime, moleculeId } = req.body;
    const slot = await scheduler.scheduleFormula(formulaName, priority, resourceReqs, preferredTime, moleculeId);
    res.status(201).json(slot);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/:slotId/started — Mark slot started
router.post('/api/meow/cognitive/decisions/scheduling/:slotId/started', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    await scheduler.markStarted(req.params.slotId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/:slotId/completed — Mark slot completed
router.post('/api/meow/cognitive/decisions/scheduling/:slotId/completed', async (req: Request, res: Response) => {
  try {
    const { success } = req.body;
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    await scheduler.markCompleted(req.params.slotId, success !== false);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/batch — Batch similar formulas
router.post('/api/meow/cognitive/decisions/scheduling/batch', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    const batches = await scheduler.batchSimilarFormulas();
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/plan — Generate execution plan
router.post('/api/meow/cognitive/decisions/scheduling/plan', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    const plan = await scheduler.generatePlan();
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/reschedule — AI-driven reschedule
router.post('/api/meow/cognitive/decisions/scheduling/reschedule', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    const result = await scheduler.aiReschedule();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/decisions/scheduling/maintenance — Add maintenance window
router.post('/api/meow/cognitive/decisions/scheduling/maintenance', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    scheduler.addMaintenanceWindow(req.body);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/cognitive/decisions/scheduling/maintenance/:windowId — Remove maintenance window
router.delete('/api/meow/cognitive/decisions/scheduling/maintenance/:windowId', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    scheduler.removeMaintenanceWindow(req.params.windowId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/maintenance — Get maintenance windows
router.get('/api/meow/cognitive/decisions/scheduling/maintenance', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getMaintenanceWindows());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/slot/:slotId — Get specific slot
router.get('/api/meow/cognitive/decisions/scheduling/slot/:slotId', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    const slot = scheduler.getSlot(req.params.slotId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    res.json(slot);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/planned — Get planned slots
router.get('/api/meow/cognitive/decisions/scheduling/planned', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getPlannedSlots());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/formula/:name/slots — Get slots for formula
router.get('/api/meow/cognitive/decisions/scheduling/formula/:name/slots', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getSlotsForFormula(req.params.name));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/formula/:name/profile — Get formula profile
router.get('/api/meow/cognitive/decisions/scheduling/formula/:name/profile', async (req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getProfile(req.params.name));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/profiles — Get all profiles
router.get('/api/meow/cognitive/decisions/scheduling/profiles', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getAllProfiles());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/decisions/scheduling/stats — Scheduling stats
router.get('/api/meow/cognitive/decisions/scheduling/stats', async (_req: Request, res: Response) => {
  try {
    const { getFormulaSchedulingAI } = await import('./cognitive/formula-scheduling-ai');
    const scheduler = getFormulaSchedulingAI();
    res.json(scheduler.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 8: QUALITY INTELLIGENCE — /api/meow/cognitive/quality/*
// CG-029: Output Quality Scorer | CG-030: A/B Formula Testing
// CG-031: Continuous Improvement | CG-032: Retrospective Engine
// ═══════════════════════════════════════════════════════════════════════════════

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/api/meow/cognitive/quality/status', async (_req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    res.json({
      qualityScorer: { active: !!getOutputQualityScorer },
      abTesting: { active: !!getABFormulaTester },
      continuousImprovement: { active: !!getContinuousImprovementEngine },
      retrospective: { active: !!getRetrospectiveEngine },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-029: Output Quality Scorer ───────────────────────────────────────────

// POST /api/meow/cognitive/quality/scorer/score — Score an output
router.post('/api/meow/cognitive/quality/scorer/score', async (req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    const score = await scorer.scoreOutput(req.body);
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/trend/:entityId — Get quality trend
router.get('/api/meow/cognitive/quality/scorer/trend/:entityId', async (req: Request, res: Response) => {
  try {
    const entityType = req.query.entityType as string || 'worker';
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json(scorer.getQualityTrend(req.params.entityId, entityType as any));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/dashboard — Get quality dashboard
router.get('/api/meow/cognitive/quality/scorer/dashboard', async (_req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json(scorer.getDashboard());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/flagged — Get flagged outputs
router.get('/api/meow/cognitive/quality/scorer/flagged', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json(scorer.getFlaggedOutputs(limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/bead/:beadId — Get scores for bead
router.get('/api/meow/cognitive/quality/scorer/bead/:beadId', async (req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json(scorer.getScoresForBead(req.params.beadId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/quality/scorer/flag-threshold — Set flag threshold
router.put('/api/meow/cognitive/quality/scorer/flag-threshold', async (req: Request, res: Response) => {
  try {
    const { threshold } = req.body;
    if (threshold === undefined) return res.status(400).json({ error: 'threshold required' });
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    scorer.setFlagThreshold(threshold);
    res.json({ ok: true, threshold: scorer.getFlagThreshold() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/flag-threshold — Get flag threshold
router.get('/api/meow/cognitive/quality/scorer/flag-threshold', async (_req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json({ threshold: scorer.getFlagThreshold() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/scorer/count — Get score count
router.get('/api/meow/cognitive/quality/scorer/count', async (_req: Request, res: Response) => {
  try {
    const { getOutputQualityScorer } = await import('./cognitive/output-quality-scorer');
    const scorer = getOutputQualityScorer();
    res.json({ count: scorer.getScoreCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-030: A/B Formula Testing ─────────────────────────────────────────────

// POST /api/meow/cognitive/quality/ab/experiments — Create experiment
router.post('/api/meow/cognitive/quality/ab/experiments', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const experiment = await tester.createExperiment(req.body);
    res.status(201).json(experiment);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/ab/experiments/:id/start — Start experiment
router.post('/api/meow/cognitive/quality/ab/experiments/:id/start', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    await tester.startExperiment(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/experiments/:id/select — Select variant
router.get('/api/meow/cognitive/quality/ab/experiments/:id/select', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const variant = await tester.selectVariant(req.params.id);
    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/formula/:name/running — Find running experiment
router.get('/api/meow/cognitive/quality/ab/formula/:name/running', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const experiment = tester.findRunningExperiment(req.params.name);
    res.json(experiment || null);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/ab/experiments/:id/result — Record result
router.post('/api/meow/cognitive/quality/ab/experiments/:id/result', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    await tester.recordResult({ experimentId: req.params.id, ...req.body });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/experiments/:id/analyze — Analyze experiment
router.get('/api/meow/cognitive/quality/ab/experiments/:id/analyze', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const exp = tester.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    const analysis = tester.analyzeExperiment(exp);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/experiments — List experiments
router.get('/api/meow/cognitive/quality/ab/experiments', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    res.json(tester.listExperiments(status as any));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/experiments/:id — Get experiment
router.get('/api/meow/cognitive/quality/ab/experiments/:id', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const exp = tester.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    res.json(exp);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/ab/experiments/:id/apply-winner — Apply winner
router.post('/api/meow/cognitive/quality/ab/experiments/:id/apply-winner', async (req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    const result = await tester.applyWinner(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/sample-size — Compute min sample size
router.get('/api/meow/cognitive/quality/ab/sample-size', async (req: Request, res: Response) => {
  try {
    const baselineSuccessRate = parseFloat(req.query.baseline as string);
    const minDetectableDiff = req.query.diff ? parseFloat(req.query.diff as string) : undefined;
    if (isNaN(baselineSuccessRate)) {
      return res.status(400).json({ error: 'baseline (number) query param required' });
    }
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    res.json({ sampleSize: tester.computeMinSampleSize(baselineSuccessRate, minDetectableDiff) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/ab/count — Get experiment count
router.get('/api/meow/cognitive/quality/ab/count', async (_req: Request, res: Response) => {
  try {
    const { getABFormulaTester } = await import('./cognitive/ab-formula-testing');
    const tester = getABFormulaTester();
    res.json({ count: tester.getExperimentCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-031: Continuous Improvement ──────────────────────────────────────────

// POST /api/meow/cognitive/quality/improvement/proposals/generate — Generate proposals
router.post('/api/meow/cognitive/quality/improvement/proposals/generate', async (req: Request, res: Response) => {
  try {
    const { aggregatedData } = req.body;
    if (!aggregatedData) return res.status(400).json({ error: 'aggregatedData required' });
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    const proposals = await engine.generateProposals(aggregatedData);
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/improvement/proposals/:id/approve — Approve proposal
router.post('/api/meow/cognitive/quality/improvement/proposals/:id/approve', async (req: Request, res: Response) => {
  try {
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    await engine.approveProposal(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/improvement/proposals/:id/apply — Apply proposal
router.post('/api/meow/cognitive/quality/improvement/proposals/:id/apply', async (req: Request, res: Response) => {
  try {
    const { preApplyMetrics } = req.body;
    if (!preApplyMetrics) return res.status(400).json({ error: 'preApplyMetrics required' });
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    await engine.applyProposal(req.params.id, preApplyMetrics);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/improvement/proposals/:id/measure — Measure results
router.post('/api/meow/cognitive/quality/improvement/proposals/:id/measure', async (req: Request, res: Response) => {
  try {
    const { postApplyMetrics } = req.body;
    if (!postApplyMetrics) return res.status(400).json({ error: 'postApplyMetrics required' });
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    const result = await engine.measureResults(req.params.id, postApplyMetrics);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/improvement/proposals/:id/reject — Reject proposal
router.post('/api/meow/cognitive/quality/improvement/proposals/:id/reject', async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    await engine.rejectProposal(req.params.id, reason);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/improvement/digest — Generate digest
router.get('/api/meow/cognitive/quality/improvement/digest', async (req: Request, res: Response) => {
  try {
    const periodDays = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    res.json(await engine.generateDigest(periodDays));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/improvement/stats — Get improvement stats
router.get('/api/meow/cognitive/quality/improvement/stats', async (_req: Request, res: Response) => {
  try {
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    res.json(engine.getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/improvement/proposals — List proposals
router.get('/api/meow/cognitive/quality/improvement/proposals', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    res.json(engine.listProposals(status ? { status } as any : undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/quality/improvement/auto-apply-thresholds — Set thresholds
router.put('/api/meow/cognitive/quality/improvement/auto-apply-thresholds', async (req: Request, res: Response) => {
  try {
    const { minImprovement, maxRisk } = req.body;
    if (minImprovement === undefined || maxRisk === undefined) {
      return res.status(400).json({ error: 'minImprovement and maxRisk required' });
    }
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    engine.setAutoApplyThresholds(minImprovement, maxRisk);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/improvement/count — Get proposal count
router.get('/api/meow/cognitive/quality/improvement/count', async (_req: Request, res: Response) => {
  try {
    const { getContinuousImprovementEngine } = await import('./cognitive/continuous-improvement');
    const engine = getContinuousImprovementEngine();
    res.json({ count: engine.getProposalCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── CG-032: Retrospective Engine ────────────────────────────────────────────

// POST /api/meow/cognitive/quality/retro/formula — Generate formula retrospective
router.post('/api/meow/cognitive/quality/retro/formula', async (req: Request, res: Response) => {
  try {
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    const retro = await engine.generateFormulaRetro(req.body);
    res.json(retro);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/retro/weekly — Generate weekly retrospective
router.post('/api/meow/cognitive/quality/retro/weekly', async (req: Request, res: Response) => {
  try {
    const { teamName } = req.body;
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    const retro = await engine.generateWeeklyRetro(teamName);
    res.json(retro);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/meow/cognitive/quality/retro/:retroId/action/:actionId — Update action item
router.put('/api/meow/cognitive/quality/retro/:retroId/action/:actionId', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    await engine.updateActionItem(req.params.retroId, req.params.actionId, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/retro — List retrospectives
router.get('/api/meow/cognitive/quality/retro', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    res.json(engine.listRetros(type ? { type } as any : undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/retro/:retroId — Get specific retrospective
router.get('/api/meow/cognitive/quality/retro/:retroId', async (req: Request, res: Response) => {
  try {
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    const retro = engine.getRetro(req.params.retroId);
    if (!retro) return res.status(404).json({ error: 'Retrospective not found' });
    res.json(retro);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/cognitive/quality/retro/archive — Archive old retrospectives
router.post('/api/meow/cognitive/quality/retro/archive', async (_req: Request, res: Response) => {
  try {
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    const result = await engine.archiveOldRetros();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/retro/actions/open — Get open action items
router.get('/api/meow/cognitive/quality/retro/actions/open', async (_req: Request, res: Response) => {
  try {
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    res.json(engine.getOpenActionItems());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/cognitive/quality/retro/count — Get retro count
router.get('/api/meow/cognitive/quality/retro/count', async (_req: Request, res: Response) => {
  try {
    const { getRetrospectiveEngine } = await import('./cognitive/retrospective-engine');
    const engine = getRetrospectiveEngine();
    res.json({ count: engine.getRetroCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 05 OVERVIEW — /api/meow/stage05/status
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/api/meow/stage05/status', (_req: Request, res: Response) => {
  const groups = [
    {
      name: 'Mayor Intelligence',
      prefix: '/api/meow/cognitive/mayor',
      modules: ['priority-scoring', 'resource-allocation', 'convoy-composition', 'conflict-resolution'],
    },
    {
      name: 'Learning Loops',
      prefix: '/api/meow/cognitive/learning',
      modules: ['formula-evolution', 'skill-performance-ranking', 'worker-performance-learning', 'pattern-library'],
    },
    {
      name: 'Predictive Intelligence',
      prefix: '/api/meow/cognitive/predictions',
      modules: ['failure-prediction', 'cost-forecasting', 'demand-forecasting', 'outcome-prediction'],
    },
    {
      name: 'Smart Routing',
      prefix: '/api/meow/cognitive/routing',
      modules: ['intelligent-mail-routing', 'dynamic-tier-adjustment', 'skill-auto-selection', 'cross-formula-optimization'],
    },
    {
      name: 'Self-Healing',
      prefix: '/api/meow/cognitive/healing',
      modules: ['auto-retry-intelligence', 'zombie-detection-advanced', 'queue-rebalancing', 'drift-detection'],
    },
    {
      name: 'Knowledge Integration',
      prefix: '/api/meow/cognitive/knowledge',
      modules: ['megabrain-worker-context', 'nous-epistemic-injection', 'atlas-country-injection', 'cross-molecule-knowledge'],
    },
    {
      name: 'Autonomous Decisions',
      prefix: '/api/meow/cognitive/decisions',
      modules: ['auto-approve-engine', 'budget-management-ai', 'escalation-intelligence', 'formula-scheduling-ai'],
    },
    {
      name: 'Quality Intelligence',
      prefix: '/api/meow/cognitive/quality',
      modules: ['output-quality-scorer', 'ab-formula-testing', 'continuous-improvement', 'retrospective-engine'],
    },
  ];

  res.json({
    stage: '05',
    name: 'Cognitive Gas Town',
    status: 'active',
    groups: groups.length,
    modules: 32,
    endpoints: {
      mayor: {
        status: '/api/meow/cognitive/mayor/status',
        priority: '/api/meow/cognitive/mayor/priority/*',
        resources: '/api/meow/cognitive/mayor/resources/*',
        convoys: '/api/meow/cognitive/mayor/convoys/*',
        conflicts: '/api/meow/cognitive/mayor/conflicts/*',
      },
      learning: {
        status: '/api/meow/cognitive/learning/status',
        formulas: '/api/meow/cognitive/learning/formulas/:name/*',
        skills: '/api/meow/cognitive/learning/skills/*',
        workers: '/api/meow/cognitive/learning/workers/*',
        patterns: '/api/meow/cognitive/learning/patterns/*',
      },
      predictions: {
        status: '/api/meow/cognitive/predictions/status',
        failure: '/api/meow/cognitive/predictions/failure/*',
        cost: '/api/meow/cognitive/predictions/cost/*',
        demand: '/api/meow/cognitive/predictions/demand/*',
        outcome: '/api/meow/cognitive/predictions/outcome/*',
      },
      routing: {
        status: '/api/meow/cognitive/routing/status',
        mail: '/api/meow/cognitive/routing/mail/*',
        tiers: '/api/meow/cognitive/routing/tiers/*',
        skills: '/api/meow/cognitive/routing/skills/*',
        crossFormula: '/api/meow/cognitive/routing/cross-formula/*',
      },
      healing: {
        status: '/api/meow/cognitive/healing/status',
        retry: '/api/meow/cognitive/healing/retry/*',
        zombie: '/api/meow/cognitive/healing/zombie/*',
        queues: '/api/meow/cognitive/healing/queues/*',
        drift: '/api/meow/cognitive/healing/drift/*',
      },
      knowledge: {
        status: '/api/meow/cognitive/knowledge/status',
        megabrain: '/api/meow/cognitive/knowledge/megabrain/*',
        nous: '/api/meow/cognitive/knowledge/nous/*',
        atlas: '/api/meow/cognitive/knowledge/atlas/*',
        crossMolecule: '/api/meow/cognitive/knowledge/cross-molecule/*',
      },
      decisions: {
        status: '/api/meow/cognitive/decisions/status',
        approve: '/api/meow/cognitive/decisions/approve/*',
        budget: '/api/meow/cognitive/decisions/budget/*',
        escalation: '/api/meow/cognitive/decisions/escalation/*',
        scheduling: '/api/meow/cognitive/decisions/scheduling/*',
      },
      quality: {
        status: '/api/meow/cognitive/quality/status',
        scorer: '/api/meow/cognitive/quality/scorer/*',
        ab: '/api/meow/cognitive/quality/ab/*',
        improvement: '/api/meow/cognitive/quality/improvement/*',
        retro: '/api/meow/cognitive/quality/retro/*',
      },
    },
    groupDetails: groups,
    timestamp: new Date().toISOString(),
  });
});

export default router;
