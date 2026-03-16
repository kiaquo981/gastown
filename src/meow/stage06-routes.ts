/**
 * Stage 06 — Sovereign Gas Town Routes (Expanded)
 *
 * Full REST API for all 29 sovereign modules across 7 groups:
 * - GROUP 1: Entity Integration (SG-001–004) — Moros, Atlas, Nous, Council
 * - GROUP 2: Multi-Instance (SG-005–008) — Ecom Latam, Ecom Global, ContentFactory, Federation
 * - GROUP 3: 24/7 Autonomy (SG-009–012) — Circadian, Scheduler, Crisis, Maintenance
 * - GROUP 4: Evolution (SG-013–016) — Marketplace, SkillEvolution, Specialization, Genesis
 * - GROUP 5: Persistent Identity (SG-017–020) — Memory, Chronicle, Journal, Reputation
 * - GROUP 6: External Interface (SG-021–024) — ApiGateway, CLI, Webhooks, AutoReports
 * - GROUP 7: Resilience (SG-025–028) — Snapshots, Degradation, Failover, Chaos
 *
 * Auth: GET is public, mutations require GASTOWN_API_KEY
 * Imports: Lazy (await import()) for all sovereign modules
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

// =============================================================================
//
//  GROUP 1: ENTITY INTEGRATION — /api/meow/sovereign/entities/*
//
//  SG-001: Moros Supreme Mayor (directives, strategy reviews)
//  SG-002: Atlas World Advisor (advisories, market scans)
//  SG-003: Nous Epistemic Oracle (insights, queries)
//  SG-004: Entity Council (deliberations)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/entities/status', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    res.json({
      moros: { active: !!getMorosSupremeMayor(), stats: getMorosSupremeMayor().getStats() },
      atlas: { active: !!getAtlasWorldAdvisor(), stats: getAtlasWorldAdvisor().getStats() },
      nous: { active: !!getNousEpistemicOracle(), stats: getNousEpistemicOracle().getStats() },
      council: { active: !!getEntityCouncil(), stats: getEntityCouncil().getStats() },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MOROS SUPREME MAYOR — /api/meow/sovereign/entities/moros/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/entities/moros/stats — Moros stats
router.get('/api/meow/sovereign/entities/moros/stats', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    res.json(getMorosSupremeMayor().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/moros/directives/active — Active directives
router.get('/api/meow/sovereign/entities/moros/directives/active', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    res.json({ directives: getMorosSupremeMayor().getActiveDirectives() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/moros/directives/proposed — Proposed directives
router.get('/api/meow/sovereign/entities/moros/directives/proposed', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    res.json({ directives: getMorosSupremeMayor().getProposedDirectives() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/moros/directives/by-type/:type — Directives by type
router.get('/api/meow/sovereign/entities/moros/directives/by-type/:type', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    res.json({ directives: getMorosSupremeMayor().getDirectivesByType(req.params.type as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/moros/directives/:id — Get directive by ID
router.get('/api/meow/sovereign/entities/moros/directives/:id', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const directive = getMorosSupremeMayor().getDirective(req.params.id);
    if (!directive) return res.status(404).json({ error: 'Directive not found' });
    res.json(directive);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/strategy-review — Conduct strategy review
router.post('/api/meow/sovereign/entities/moros/strategy-review', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const result = await getMorosSupremeMayor().conductStrategyReview();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/directives — Create directive
router.post('/api/meow/sovereign/entities/moros/directives', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const { type, title, rationale, impactEstimate } = req.body;
    const directive = await getMorosSupremeMayor().createDirective(type, title, rationale, impactEstimate ?? {});
    res.status(201).json(directive);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/directives/:id/activate — Activate directive
router.post('/api/meow/sovereign/entities/moros/directives/:id/activate', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const directive = getMorosSupremeMayor().activateDirective(req.params.id);
    res.json(directive);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/directives/:id/supersede — Supersede directive
router.post('/api/meow/sovereign/entities/moros/directives/:id/supersede', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const { newDirectiveId } = req.body;
    const result = await getMorosSupremeMayor().supersedeDirective(req.params.id, newDirectiveId);
    res.json({ success: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/directives/:id/review — Review directive
router.post('/api/meow/sovereign/entities/moros/directives/:id/review', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    const { approved, notes } = req.body;
    const result = await getMorosSupremeMayor().reviewDirective(req.params.id, approved, notes);
    res.json({ success: result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/periodic-review/start — Start periodic review
router.post('/api/meow/sovereign/entities/moros/periodic-review/start', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    getMorosSupremeMayor().startPeriodicReview();
    res.json({ ok: true, message: 'Moros periodic review started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/periodic-review/stop — Stop periodic review
router.post('/api/meow/sovereign/entities/moros/periodic-review/stop', async (_req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    getMorosSupremeMayor().stopPeriodicReview();
    res.json({ ok: true, message: 'Moros periodic review stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/moros/config — Update Moros config
router.post('/api/meow/sovereign/entities/moros/config', async (req: Request, res: Response) => {
  try {
    const { getMorosSupremeMayor } = await import('./sovereign/moros-supreme-mayor');
    getMorosSupremeMayor().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ATLAS WORLD ADVISOR — /api/meow/sovereign/entities/atlas/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/entities/atlas/stats — Atlas stats
router.get('/api/meow/sovereign/entities/atlas/stats', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    res.json(getAtlasWorldAdvisor().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/advisories/active — Active advisories
router.get('/api/meow/sovereign/entities/atlas/advisories/active', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    res.json({ advisories: getAtlasWorldAdvisor().getActiveAdvisories() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/advisories/by-country/:code — By country
router.get('/api/meow/sovereign/entities/atlas/advisories/by-country/:code', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    res.json({ advisories: getAtlasWorldAdvisor().getAdvisoriesForCountry(req.params.code as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/advisories/by-type/:type — By type
router.get('/api/meow/sovereign/entities/atlas/advisories/by-type/:type', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    res.json({ advisories: getAtlasWorldAdvisor().getAdvisoriesByType(req.params.type as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/advisories/:id — Get advisory by ID
router.get('/api/meow/sovereign/entities/atlas/advisories/:id', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const advisory = getAtlasWorldAdvisor().getAdvisory(req.params.id);
    if (!advisory) return res.status(404).json({ error: 'Advisory not found' });
    res.json(advisory);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/snapshots — All market snapshots
router.get('/api/meow/sovereign/entities/atlas/snapshots', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    res.json({ snapshots: getAtlasWorldAdvisor().getAllMarketSnapshots() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/atlas/snapshots/:code — Market snapshot by country
router.get('/api/meow/sovereign/entities/atlas/snapshots/:code', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const snapshot = getAtlasWorldAdvisor().getMarketSnapshot(req.params.code as any);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found for country' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/market-scan — Conduct market scan
router.post('/api/meow/sovereign/entities/atlas/market-scan', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const result = await getAtlasWorldAdvisor().conductMarketScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/advisories — Create advisory
router.post('/api/meow/sovereign/entities/atlas/advisories', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const { type, title, description, countryCodes, severity } = req.body;
    const advisory = await getAtlasWorldAdvisor().createAdvisory(type, title, description, countryCodes, severity);
    res.status(201).json(advisory);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/advisories/:id/publish — Publish advisory
router.post('/api/meow/sovereign/entities/atlas/advisories/:id/publish', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const result = getAtlasWorldAdvisor().publishAdvisory(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/advisories/:id/acted-on — Mark acted on
router.post('/api/meow/sovereign/entities/atlas/advisories/:id/acted-on', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const result = getAtlasWorldAdvisor().markActedOn(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/advisories/:id/archive — Archive advisory
router.post('/api/meow/sovereign/entities/atlas/advisories/:id/archive', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const result = getAtlasWorldAdvisor().archiveAdvisory(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/formula-context — Get formula context for countries
router.post('/api/meow/sovereign/entities/atlas/formula-context', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    const { formulaId, countryCodes } = req.body;
    const context = getAtlasWorldAdvisor().getFormulaContextForCountries(formulaId, countryCodes);
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/periodic-scan/start — Start periodic scan
router.post('/api/meow/sovereign/entities/atlas/periodic-scan/start', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    getAtlasWorldAdvisor().startPeriodicScan();
    res.json({ ok: true, message: 'Atlas periodic scan started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/periodic-scan/stop — Stop periodic scan
router.post('/api/meow/sovereign/entities/atlas/periodic-scan/stop', async (_req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    getAtlasWorldAdvisor().stopPeriodicScan();
    res.json({ ok: true, message: 'Atlas periodic scan stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/atlas/config — Update Atlas config
router.post('/api/meow/sovereign/entities/atlas/config', async (req: Request, res: Response) => {
  try {
    const { getAtlasWorldAdvisor } = await import('./sovereign/atlas-world-advisor');
    getAtlasWorldAdvisor().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOUS EPISTEMIC ORACLE — /api/meow/sovereign/entities/nous/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/entities/nous/stats — Nous stats
router.get('/api/meow/sovereign/entities/nous/stats', async (_req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    res.json(getNousEpistemicOracle().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/nous/insights/recent — Recent insights
router.get('/api/meow/sovereign/entities/nous/insights/recent', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ insights: getNousEpistemicOracle().getRecentInsights(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/nous/insights/by-type/:type — Insights by type
router.get('/api/meow/sovereign/entities/nous/insights/by-type/:type', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    res.json({ insights: getNousEpistemicOracle().getInsightsByType(req.params.type as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/nous/insights/:id — Get insight by ID
router.get('/api/meow/sovereign/entities/nous/insights/:id', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const insight = getNousEpistemicOracle().getInsight(req.params.id);
    if (!insight) return res.status(404).json({ error: 'Insight not found' });
    res.json(insight);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/nous/query — Query the oracle
router.post('/api/meow/sovereign/entities/nous/query', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    if (!req.body || (!req.body.question && !req.body.query)) {
      return res.status(400).json({ error: 'question or query required' });
    }
    const result = await getNousEpistemicOracle().query(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/nous/insights/:id/validate — Validate insight
router.post('/api/meow/sovereign/entities/nous/insights/:id/validate', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const { isValid, notes } = req.body;
    if (isValid === undefined) return res.status(400).json({ error: 'isValid (boolean) required' });
    const result = getNousEpistemicOracle().validateInsight(req.params.id, isValid, notes);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/nous/insights/:id/applied — Mark insight applied
router.post('/api/meow/sovereign/entities/nous/insights/:id/applied', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const result = getNousEpistemicOracle().markApplied(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/nous/insights/:id/impact — Record impact
router.post('/api/meow/sovereign/entities/nous/insights/:id/impact', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    const { impactRating } = req.body;
    if (impactRating === undefined) return res.status(400).json({ error: 'impactRating required' });
    const result = getNousEpistemicOracle().recordImpact(req.params.id, impactRating);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/nous/config — Update Nous config
router.post('/api/meow/sovereign/entities/nous/config', async (req: Request, res: Response) => {
  try {
    const { getNousEpistemicOracle } = await import('./sovereign/nous-epistemic-oracle');
    getNousEpistemicOracle().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY COUNCIL — /api/meow/sovereign/entities/council/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/entities/council/stats — Council stats
router.get('/api/meow/sovereign/entities/council/stats', async (_req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    res.json(getEntityCouncil().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/council/deliberations/recent — Recent deliberations
router.get('/api/meow/sovereign/entities/council/deliberations/recent', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ deliberations: getEntityCouncil().getRecentDeliberations(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/council/deliberations/by-outcome/:outcome — By outcome
router.get('/api/meow/sovereign/entities/council/deliberations/by-outcome/:outcome', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    res.json({ deliberations: getEntityCouncil().getDeliberationsByOutcome(req.params.outcome as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/council/deliberations/by-trigger/:trigger — By trigger
router.get('/api/meow/sovereign/entities/council/deliberations/by-trigger/:trigger', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    res.json({ deliberations: getEntityCouncil().getDeliberationsByTrigger(req.params.trigger as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/entities/council/deliberations/:id — Get deliberation by ID
router.get('/api/meow/sovereign/entities/council/deliberations/:id', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    const deliberation = getEntityCouncil().getDeliberation(req.params.id);
    if (!deliberation) return res.status(404).json({ error: 'Deliberation not found' });
    res.json(deliberation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/council/convene — Convene the council
router.post('/api/meow/sovereign/entities/council/convene', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    const { trigger, subject, context, options } = req.body;
    const result = await getEntityCouncil().convene(trigger, subject, context, options);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/council/should-convene — Check if council should convene
router.post('/api/meow/sovereign/entities/council/should-convene', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    const { estimatedBudgetUsd, isNewMarket, isFormulaCreation, isCrisis, approvalRiskCategory } = req.body;
    const result = getEntityCouncil().shouldConveneCouncil(estimatedBudgetUsd, isNewMarket, isFormulaCreation, isCrisis, approvalRiskCategory);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/entities/council/config — Update Council config
router.post('/api/meow/sovereign/entities/council/config', async (req: Request, res: Response) => {
  try {
    const { getEntityCouncil } = await import('./sovereign/entity-council');
    getEntityCouncil().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 2: MULTI-INSTANCE — /api/meow/sovereign/instances/*
//
//  SG-005: GasTown Ecom Latam (country metrics, workers, budget)
//  SG-006: GasTown Ecom Global (campaigns, market metrics, workers)
//  SG-007: GasTown Content Factory (content generation, quality, capacity)
//  SG-008: GasTown Federation (instances, mail, resources, knowledge, conflicts)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/instances/status', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    res.json({
      ecomLatam: getGasTownEcomLatam().getStatus(),
      ecomGlobal: getGasTownEcomGlobal().getStatus(),
      contentFactory: getGasTownContentFactory().getStatus(),
      federation: { instances: getGasTownFederation().getInstances() },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOWN ECOM-LATAM — /api/meow/sovereign/instances/ecom-latam/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/instances/ecom-latam/status — Instance status
router.get('/api/meow/sovereign/instances/ecom-latam/status', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    res.json(getGasTownEcomLatam().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-latam/workers — Available workers
router.get('/api/meow/sovereign/instances/ecom-latam/workers', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const spec = req.query.specialization as any;
    res.json({ workers: getGasTownEcomLatam().getAvailableWorkers(spec) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-latam/budget — Budget status
router.get('/api/meow/sovereign/instances/ecom-latam/budget', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    res.json(getGasTownEcomLatam().getBudget());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-latam/countries — All country metrics
router.get('/api/meow/sovereign/instances/ecom-latam/countries', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    res.json({ countries: getGasTownEcomLatam().getAllCountryMetrics() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-latam/countries/:country — Country metrics
router.get('/api/meow/sovereign/instances/ecom-latam/countries/:country', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const metrics = getGasTownEcomLatam().getCountryMetrics(req.params.country as any);
    if (!metrics) return res.status(404).json({ error: 'Country metrics not found' });
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/start — Start instance
router.post('/api/meow/sovereign/instances/ecom-latam/start', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    await getGasTownEcomLatam().start();
    res.json({ ok: true, message: 'Ecom Latam instance started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/stop — Stop instance
router.post('/api/meow/sovereign/instances/ecom-latam/stop', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    await getGasTownEcomLatam().stop();
    res.json({ ok: true, message: 'Ecom Latam instance stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/pause — Pause instance
router.post('/api/meow/sovereign/instances/ecom-latam/pause', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    getGasTownEcomLatam().pause();
    res.json({ ok: true, message: 'Ecom Latam instance paused' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/resume — Resume instance
router.post('/api/meow/sovereign/instances/ecom-latam/resume', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    getGasTownEcomLatam().resume();
    res.json({ ok: true, message: 'Ecom Latam instance resumed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/provision — Provision workers
router.post('/api/meow/sovereign/instances/ecom-latam/provision', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const result = getGasTownEcomLatam().provisionWorkers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/workers — Add worker
router.post('/api/meow/sovereign/instances/ecom-latam/workers', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const result = getGasTownEcomLatam().addWorker(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/sovereign/instances/ecom-latam/workers/:id — Remove worker
router.delete('/api/meow/sovereign/instances/ecom-latam/workers/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const result = getGasTownEcomLatam().removeWorker(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/workers/:id/borrow — Borrow worker
router.post('/api/meow/sovereign/instances/ecom-latam/workers/:id/borrow', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { sourceInstance } = req.body;
    if (!sourceInstance) return res.status(400).json({ error: 'sourceInstance required' });
    const result = getGasTownEcomLatam().borrowWorker(req.params.id, sourceInstance);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/workers/:id/return — Return borrowed worker
router.post('/api/meow/sovereign/instances/ecom-latam/workers/:id/return', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const result = getGasTownEcomLatam().returnBorrowedWorker(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/molecules/:id/register — Register molecule
router.post('/api/meow/sovereign/instances/ecom-latam/molecules/:id/register', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { formulaName } = req.body;
    if (!formulaName) return res.status(400).json({ error: 'formulaName required' });
    const result = getGasTownEcomLatam().registerMolecule(req.params.id, formulaName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/molecules/:id/complete — Complete molecule
router.post('/api/meow/sovereign/instances/ecom-latam/molecules/:id/complete', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { success } = req.body;
    const result = getGasTownEcomLatam().completeMolecule(req.params.id, success !== false);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/countries/:country/metrics — Update country metrics
router.post('/api/meow/sovereign/instances/ecom-latam/countries/:country/metrics', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const result = getGasTownEcomLatam().updateCountryMetrics(req.params.country as any, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/spend — Record spend
router.post('/api/meow/sovereign/instances/ecom-latam/spend', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { amount, country, category } = req.body;
    if (amount === undefined) return res.status(400).json({ error: 'amount required' });
    const result = getGasTownEcomLatam().recordSpend(amount, country, category);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-latam/budget/check — Check budget
router.post('/api/meow/sovereign/instances/ecom-latam/budget/check', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomLatam } = await import('./sovereign/gastown-ecom-latam');
    const { estimatedCostUsd } = req.body;
    if (estimatedCostUsd === undefined) return res.status(400).json({ error: 'estimatedCostUsd required' });
    const result = getGasTownEcomLatam().checkBudget(estimatedCostUsd);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOWN ECOM-GLOBAL — /api/meow/sovereign/instances/ecom-global/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/instances/ecom-global/status — Instance status
router.get('/api/meow/sovereign/instances/ecom-global/status', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    res.json(getGasTownEcomGlobal().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-global/workers — Available workers
router.get('/api/meow/sovereign/instances/ecom-global/workers', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const spec = req.query.specialization as any;
    res.json({ workers: getGasTownEcomGlobal().getAvailableWorkers(spec) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-global/campaigns/active — Active campaigns
router.get('/api/meow/sovereign/instances/ecom-global/campaigns/active', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    res.json({ campaigns: getGasTownEcomGlobal().getActiveCampaigns() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-global/campaigns/by-platform/:platform — By platform
router.get('/api/meow/sovereign/instances/ecom-global/campaigns/by-platform/:platform', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    res.json({ campaigns: getGasTownEcomGlobal().getCampaignsByPlatform(req.params.platform as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/ecom-global/campaigns/by-market/:market — By market
router.get('/api/meow/sovereign/instances/ecom-global/campaigns/by-market/:market', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    res.json({ campaigns: getGasTownEcomGlobal().getCampaignsByMarket(req.params.market as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/start — Start instance
router.post('/api/meow/sovereign/instances/ecom-global/start', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    await getGasTownEcomGlobal().start();
    res.json({ ok: true, message: 'Ecom Global instance started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/stop — Stop instance
router.post('/api/meow/sovereign/instances/ecom-global/stop', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    await getGasTownEcomGlobal().stop();
    res.json({ ok: true, message: 'Ecom Global instance stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/pause — Pause instance
router.post('/api/meow/sovereign/instances/ecom-global/pause', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    getGasTownEcomGlobal().pause();
    res.json({ ok: true, message: 'Ecom Global instance paused' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/resume — Resume instance
router.post('/api/meow/sovereign/instances/ecom-global/resume', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    getGasTownEcomGlobal().resume();
    res.json({ ok: true, message: 'Ecom Global instance resumed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/provision — Provision workers
router.post('/api/meow/sovereign/instances/ecom-global/provision', async (_req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().provisionWorkers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/workers — Add worker
router.post('/api/meow/sovereign/instances/ecom-global/workers', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().addWorker(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/sovereign/instances/ecom-global/workers/:id — Remove worker
router.delete('/api/meow/sovereign/instances/ecom-global/workers/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().removeWorker(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/workers/:id/borrow — Borrow worker
router.post('/api/meow/sovereign/instances/ecom-global/workers/:id/borrow', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const { sourceInstance } = req.body;
    if (!sourceInstance) return res.status(400).json({ error: 'sourceInstance required' });
    const result = getGasTownEcomGlobal().borrowWorker(req.params.id, sourceInstance);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/workers/:id/return — Return borrowed worker
router.post('/api/meow/sovereign/instances/ecom-global/workers/:id/return', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().returnBorrowedWorker(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/campaigns — Register campaign
router.post('/api/meow/sovereign/instances/ecom-global/campaigns', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().registerCampaign(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/campaigns/:id/performance — Update campaign performance
router.post('/api/meow/sovereign/instances/ecom-global/campaigns/:id/performance', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().updateCampaignPerformance(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/molecules/:id/register — Register molecule
router.post('/api/meow/sovereign/instances/ecom-global/molecules/:id/register', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const { formulaName } = req.body;
    if (!formulaName) return res.status(400).json({ error: 'formulaName required' });
    const result = getGasTownEcomGlobal().registerMolecule(req.params.id, formulaName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/molecules/:id/complete — Complete molecule
router.post('/api/meow/sovereign/instances/ecom-global/molecules/:id/complete', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const { success } = req.body;
    const result = getGasTownEcomGlobal().completeMolecule(req.params.id, success !== false);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/ecom-global/markets/:market/metrics — Update market metrics
router.post('/api/meow/sovereign/instances/ecom-global/markets/:market/metrics', async (req: Request, res: Response) => {
  try {
    const { getGasTownEcomGlobal } = await import('./sovereign/gastown-ecom-global');
    const result = getGasTownEcomGlobal().updateMarketMetrics(req.params.market as any, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOWN CONTENT FACTORY — /api/meow/sovereign/instances/content-factory/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/instances/content-factory/status — Instance status
router.get('/api/meow/sovereign/instances/content-factory/status', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json(getGasTownContentFactory().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/workers — Available workers
router.get('/api/meow/sovereign/instances/content-factory/workers', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const spec = req.query.specialization as any;
    res.json({ workers: getGasTownContentFactory().getAvailableWorkers(spec) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/queue — Queue depth
router.get('/api/meow/sovereign/instances/content-factory/queue', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json({ depth: getGasTownContentFactory().getQueueDepth(), active: getGasTownContentFactory().getActiveGenerations() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/capacity — Capacity info
router.get('/api/meow/sovereign/instances/content-factory/capacity', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json(getGasTownContentFactory().getCapacity());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/metrics — Metrics
router.get('/api/meow/sovereign/instances/content-factory/metrics', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json(getGasTownContentFactory().getMetrics());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/budget — Budget status
router.get('/api/meow/sovereign/instances/content-factory/budget', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json(getGasTownContentFactory().getBudget());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/content-factory/formulas — Available formulas
router.get('/api/meow/sovereign/instances/content-factory/formulas', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    res.json({ formulas: getGasTownContentFactory().getAvailableFormulas() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/start — Start instance
router.post('/api/meow/sovereign/instances/content-factory/start', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    await getGasTownContentFactory().start();
    res.json({ ok: true, message: 'Content Factory started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/stop — Stop instance
router.post('/api/meow/sovereign/instances/content-factory/stop', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    await getGasTownContentFactory().stop();
    res.json({ ok: true, message: 'Content Factory stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/pause — Pause instance
router.post('/api/meow/sovereign/instances/content-factory/pause', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    getGasTownContentFactory().pause();
    res.json({ ok: true, message: 'Content Factory paused' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/resume — Resume instance
router.post('/api/meow/sovereign/instances/content-factory/resume', async (_req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    getGasTownContentFactory().resume();
    res.json({ ok: true, message: 'Content Factory resumed' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/submit — Submit content request
router.post('/api/meow/sovereign/instances/content-factory/submit', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const result = getGasTownContentFactory().submitRequest(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/complete — Complete generation
router.post('/api/meow/sovereign/instances/content-factory/complete', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { requestId, success, opts } = req.body;
    getGasTownContentFactory().completeGeneration(requestId, success, opts);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/assess-quality — Assess content quality
router.post('/api/meow/sovereign/instances/content-factory/assess-quality', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { contentDescription, contentType } = req.body;
    if (!contentDescription || !contentType) {
      return res.status(400).json({ error: 'contentDescription and contentType required' });
    }
    const result = await getGasTownContentFactory().assessContentQuality(contentDescription, contentType);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/budget/check — Check budget
router.post('/api/meow/sovereign/instances/content-factory/budget/check', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { estimatedCostUsd } = req.body;
    if (estimatedCostUsd === undefined) return res.status(400).json({ error: 'estimatedCostUsd required' });
    const result = getGasTownContentFactory().checkBudget(estimatedCostUsd);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/lend-worker — Lend worker to another instance
router.post('/api/meow/sovereign/instances/content-factory/lend-worker', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { targetInstanceId, specialization } = req.body;
    if (!targetInstanceId) return res.status(400).json({ error: 'targetInstanceId required' });
    const result = getGasTownContentFactory().lendWorker(targetInstanceId, specialization);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/content-factory/return-worker — Return worker
router.post('/api/meow/sovereign/instances/content-factory/return-worker', async (req: Request, res: Response) => {
  try {
    const { getGasTownContentFactory } = await import('./sovereign/gastown-content-factory');
    const { workerId } = req.body;
    if (!workerId) return res.status(400).json({ error: 'workerId required' });
    const result = getGasTownContentFactory().returnWorker(workerId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOWN FEDERATION — /api/meow/sovereign/instances/federation/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/instances/federation/instances — All instances
router.get('/api/meow/sovereign/instances/federation/instances', async (_req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    res.json({ instances: getGasTownFederation().getInstances() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/instances/:id — Get instance
router.get('/api/meow/sovereign/instances/federation/instances/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const instance = getGasTownFederation().getInstance(req.params.id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    res.json(instance);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/mail/:instanceId — Get mail for instance
router.get('/api/meow/sovereign/instances/federation/mail/:instanceId', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const unreadOnly = req.query.unread === 'true';
    res.json({ mail: getGasTownFederation().getMailForInstance(req.params.instanceId, unreadOnly) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/resources/pending — Pending resource requests
router.get('/api/meow/sovereign/instances/federation/resources/pending', async (_req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    res.json({ requests: getGasTownFederation().getPendingRequests() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/resources/history — Resource history
router.get('/api/meow/sovereign/instances/federation/resources/history', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const instanceId = req.query.instanceId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getGasTownFederation().getResourceHistory(instanceId, limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/knowledge — Query knowledge
router.get('/api/meow/sovereign/instances/federation/knowledge', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const topic = req.query.topic as string | undefined;
    const sourceType = req.query.sourceType as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ knowledge: getGasTownFederation().queryKnowledge(topic, sourceType as any, limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/conflicts/active — Active conflicts
router.get('/api/meow/sovereign/instances/federation/conflicts/active', async (_req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    res.json({ conflicts: getGasTownFederation().getActiveConflicts() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/instances/federation/conflicts/history — Conflict history
router.get('/api/meow/sovereign/instances/federation/conflicts/history', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ conflicts: getGasTownFederation().getConflictHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/start — Start federation
router.post('/api/meow/sovereign/instances/federation/start', async (_req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    await getGasTownFederation().start();
    res.json({ ok: true, message: 'Federation started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/stop — Stop federation
router.post('/api/meow/sovereign/instances/federation/stop', async (_req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    await getGasTownFederation().stop();
    res.json({ ok: true, message: 'Federation stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/register — Register instance
router.post('/api/meow/sovereign/instances/federation/register', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { id, type, metadata } = req.body;
    const result = getGasTownFederation().registerInstance(id, type, metadata);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/unregister/:id — Unregister instance
router.post('/api/meow/sovereign/instances/federation/unregister/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const result = getGasTownFederation().unregisterInstance(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/heartbeat/:id — Heartbeat
router.post('/api/meow/sovereign/instances/federation/heartbeat/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const result = getGasTownFederation().heartbeat(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/mail — Send mail
router.post('/api/meow/sovereign/instances/federation/mail', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { fromId, toId, subject, body, priority, metadata } = req.body;
    const result = getGasTownFederation().sendMail(fromId, toId, subject, body, priority, metadata);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/mail/:mailId/read — Mark mail read
router.post('/api/meow/sovereign/instances/federation/mail/:mailId/read', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const result = getGasTownFederation().markMailRead(req.params.mailId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/resources/request — Request resource
router.post('/api/meow/sovereign/instances/federation/resources/request', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { requesterId, resourceType, amount, reason, priority, targetId } = req.body;
    const result = getGasTownFederation().requestResource(requesterId, resourceType, amount, reason, priority, targetId);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/knowledge/share — Share knowledge
router.post('/api/meow/sovereign/instances/federation/knowledge/share', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { sourceInstanceId, topic, title, content, confidence } = req.body;
    const result = getGasTownFederation().shareKnowledge(sourceInstanceId, topic, title, content, confidence);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/knowledge/:id/consume — Consume knowledge
router.post('/api/meow/sovereign/instances/federation/knowledge/:id/consume', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { consumerId } = req.body;
    if (!consumerId) return res.status(400).json({ error: 'consumerId required' });
    const result = getGasTownFederation().consumeKnowledge(req.params.id, consumerId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/instances/federation/conflicts/detect — Detect conflict
router.post('/api/meow/sovereign/instances/federation/conflicts/detect', async (req: Request, res: Response) => {
  try {
    const { getGasTownFederation } = await import('./sovereign/gastown-federation');
    const { type, instanceA, instanceB, description, resourceType } = req.body;
    const result = getGasTownFederation().detectConflict(type, instanceA, instanceB, description, resourceType);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 3: 24/7 AUTONOMY — /api/meow/sovereign/autonomy/*
//
//  SG-009: Circadian Rhythm (phases, triggers, resource weights)
//  SG-010: Self-Scheduling (daily schedules, slot management)
//  SG-011: Crisis Mode (triggers, responses, post-mortems)
//  SG-012: Maintenance Mode (windows, pre-checks, sessions)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/autonomy/status', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    res.json({
      circadian: getCircadianRhythm().getStatus(),
      scheduler: getSelfScheduler().getStats(),
      crisis: getCrisisMode().getStatus(),
      maintenance: getMaintenanceMode().getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CIRCADIAN RHYTHM — /api/meow/sovereign/autonomy/circadian/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/autonomy/circadian/status — Full status
router.get('/api/meow/sovereign/autonomy/circadian/status', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    res.json(getCircadianRhythm().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/circadian/stats — Stats
router.get('/api/meow/sovereign/autonomy/circadian/stats', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    res.json(getCircadianRhythm().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/circadian/phase — Current phase
router.get('/api/meow/sovereign/autonomy/circadian/phase', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const cr = getCircadianRhythm();
    res.json({
      phase: cr.getCurrentPhase(),
      nextTransition: cr.getNextTransitionTime(),
      resourceWeights: cr.getResourceWeights(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/circadian/formula-triggers — Formula triggers
router.get('/api/meow/sovereign/autonomy/circadian/formula-triggers', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    res.json({ triggers: getCircadianRhythm().getFormulaTriggers() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/circadian/priority-boost/:formulaName — Priority boost for formula
router.get('/api/meow/sovereign/autonomy/circadian/priority-boost/:formulaName', async (req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    res.json({ boost: getCircadianRhythm().getPriorityBoost(req.params.formulaName) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/initialize — Initialize circadian
router.post('/api/meow/sovereign/autonomy/circadian/initialize', async (req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    getCircadianRhythm().initialize(req.body.timezone);
    res.json({ ok: true, message: 'Circadian rhythm initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/tick — Manual tick
router.post('/api/meow/sovereign/autonomy/circadian/tick', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const result = getCircadianRhythm().tick();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/tune — Tune phase
router.post('/api/meow/sovereign/autonomy/circadian/tune', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const result = getCircadianRhythm().tunePhase();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/force-phase — Force phase override
router.post('/api/meow/sovereign/autonomy/circadian/force-phase', async (req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const { phase, operatorId, reason, durationMinutes } = req.body;
    const result = await getCircadianRhythm().forcePhase(phase, operatorId, reason, durationMinutes);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/extend — Extend current phase
router.post('/api/meow/sovereign/autonomy/circadian/extend', async (req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const { additionalMinutes, operatorId } = req.body;
    if (!additionalMinutes) return res.status(400).json({ error: 'additionalMinutes required' });
    const result = getCircadianRhythm().extendPhase(additionalMinutes, operatorId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/cancel-override — Cancel phase override
router.post('/api/meow/sovereign/autonomy/circadian/cancel-override', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    getCircadianRhythm().cancelOverride();
    res.json({ ok: true, message: 'Override cancelled' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/timezone — Set timezone
router.post('/api/meow/sovereign/autonomy/circadian/timezone', async (req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    const { timezone } = req.body;
    if (!timezone) return res.status(400).json({ error: 'timezone required' });
    getCircadianRhythm().setTimezone(timezone);
    res.json({ ok: true, timezone });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/circadian/reset-counters — Reset daily counters
router.post('/api/meow/sovereign/autonomy/circadian/reset-counters', async (_req: Request, res: Response) => {
  try {
    const { getCircadianRhythm } = await import('./sovereign/circadian-rhythm');
    getCircadianRhythm().resetDailyCounters();
    res.json({ ok: true, message: 'Daily counters reset' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SELF-SCHEDULING — /api/meow/sovereign/autonomy/scheduler/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/autonomy/scheduler/stats — Scheduler stats
router.get('/api/meow/sovereign/autonomy/scheduler/stats', async (_req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    res.json(getSelfScheduler().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/scheduler/current — Current schedule
router.get('/api/meow/sovereign/autonomy/scheduler/current', async (_req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    res.json(getSelfScheduler().getCurrentSchedule());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/scheduler/next — Next slot
router.get('/api/meow/sovereign/autonomy/scheduler/next', async (_req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    res.json(getSelfScheduler().getNextSlot());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/scheduler/pending-approvals — Pending approvals
router.get('/api/meow/sovereign/autonomy/scheduler/pending-approvals', async (_req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    res.json({ approvals: getSelfScheduler().getPendingApprovals() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/scheduler/history — Schedule history
router.get('/api/meow/sovereign/autonomy/scheduler/history', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
    res.json({ history: getSelfScheduler().getScheduleHistory(days) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/initialize — Initialize scheduler
router.post('/api/meow/sovereign/autonomy/scheduler/initialize', async (_req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    getSelfScheduler().initialize();
    res.json({ ok: true, message: 'Scheduler initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/generate — Generate daily schedule
router.post('/api/meow/sovereign/autonomy/scheduler/generate', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { pendingWork, timezone, forceHeuristic } = req.body;
    const result = await getSelfScheduler().generateDailySchedule(pendingWork, timezone, forceHeuristic);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/reschedule — Reschedule
router.post('/api/meow/sovereign/autonomy/scheduler/reschedule', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { pendingWork, reason, timezone } = req.body;
    const result = await getSelfScheduler().reschedule(pendingWork, reason, timezone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/started — Mark slot started
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/started', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const result = getSelfScheduler().markSlotStarted(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/completed — Mark slot completed
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/completed', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const result = getSelfScheduler().markSlotCompleted(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/failed — Mark slot failed
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/failed', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { error: errMsg } = req.body;
    const result = getSelfScheduler().markSlotFailed(req.params.id, errMsg || 'Unknown');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/skip — Skip slot
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/skip', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const result = getSelfScheduler().skipSlot(req.params.id, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/approve — Approve slot
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/approve', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { approvedBy } = req.body;
    if (!approvedBy) return res.status(400).json({ error: 'approvedBy required' });
    const result = getSelfScheduler().approveSlot(req.params.id, approvedBy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/scheduler/slots/:id/reject — Reject slot
router.post('/api/meow/sovereign/autonomy/scheduler/slots/:id/reject', async (req: Request, res: Response) => {
  try {
    const { getSelfScheduler } = await import('./sovereign/self-scheduling');
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const result = getSelfScheduler().rejectSlot(req.params.id, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRISIS MODE — /api/meow/sovereign/autonomy/crisis/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/autonomy/crisis/status — Crisis status
router.get('/api/meow/sovereign/autonomy/crisis/status', async (_req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    res.json(getCrisisMode().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/crisis/stats — Crisis stats
router.get('/api/meow/sovereign/autonomy/crisis/stats', async (_req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    res.json(getCrisisMode().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/crisis/active — Active crisis
router.get('/api/meow/sovereign/autonomy/crisis/active', async (_req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    res.json({ active: getCrisisMode().isCrisisActive(), crisis: getCrisisMode().getActiveCrisis() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/crisis/history — Crisis history
router.get('/api/meow/sovereign/autonomy/crisis/history', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getCrisisMode().getCrisisHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/initialize — Initialize crisis mode
router.post('/api/meow/sovereign/autonomy/crisis/initialize', async (_req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    getCrisisMode().initialize();
    res.json({ ok: true, message: 'Crisis mode initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/check-trigger — Check crisis trigger
router.post('/api/meow/sovereign/autonomy/crisis/check-trigger', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const { type, currentValue, threshold } = req.body;
    if (!type || currentValue === undefined || threshold === undefined) {
      return res.status(400).json({ error: 'type, currentValue, and threshold required' });
    }
    const result = getCrisisMode().checkTrigger(type, currentValue, threshold);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/trigger — Trigger crisis manually
router.post('/api/meow/sovereign/autonomy/crisis/trigger', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const { type, description, triggerValue, triggerThreshold, callerToken } = req.body;
    const result = await getCrisisMode().triggerCrisis(type, description, triggerValue, triggerThreshold, callerToken);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/:id/start-response — Start crisis response
router.post('/api/meow/sovereign/autonomy/crisis/:id/start-response', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const result = getCrisisMode().startResponse(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/:id/mitigate — Mitigate crisis
router.post('/api/meow/sovereign/autonomy/crisis/:id/mitigate', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const { notes } = req.body;
    const result = getCrisisMode().mitigate(req.params.id, notes);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/:id/resolve — Resolve crisis
router.post('/api/meow/sovereign/autonomy/crisis/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const result = getCrisisMode().resolve(req.params.id, req.body.notes);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/:id/post-mortem — Record post-mortem
router.post('/api/meow/sovereign/autonomy/crisis/:id/post-mortem', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const { analysis } = req.body;
    if (!analysis) return res.status(400).json({ error: 'analysis required' });
    const result = getCrisisMode().recordPostMortem(req.params.id, analysis);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/crisis/check-auto-exit — Check auto exit conditions
router.post('/api/meow/sovereign/autonomy/crisis/check-auto-exit', async (req: Request, res: Response) => {
  try {
    const { getCrisisMode } = await import('./sovereign/crisis-mode');
    const result = getCrisisMode().checkAutoExit(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE MODE — /api/meow/sovereign/autonomy/maintenance/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/autonomy/maintenance/status — Maintenance status
router.get('/api/meow/sovereign/autonomy/maintenance/status', async (_req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    const mm = getMaintenanceMode();
    res.json({
      running: mm.isRunning(),
      inWindow: mm.isInMaintenanceWindow(),
      nextWindow: mm.getNextMaintenanceWindow(),
      currentSession: mm.getCurrentSession(),
      stats: mm.getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/maintenance/config — Get config
router.get('/api/meow/sovereign/autonomy/maintenance/config', async (_req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    res.json(getMaintenanceMode().getConfig());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/maintenance/stats — Stats
router.get('/api/meow/sovereign/autonomy/maintenance/stats', async (_req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    res.json(getMaintenanceMode().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/autonomy/maintenance/history — Session history
router.get('/api/meow/sovereign/autonomy/maintenance/history', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getMaintenanceMode().getSessionHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/maintenance/initialize — Initialize
router.post('/api/meow/sovereign/autonomy/maintenance/initialize', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    getMaintenanceMode().initialize(req.body);
    res.json({ ok: true, message: 'Maintenance mode initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/maintenance/pre-check — Run pre-check
router.post('/api/meow/sovereign/autonomy/maintenance/pre-check', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    const { isCrisisActive, currentLoadPct } = req.body;
    const result = await getMaintenanceMode().runPreCheck(isCrisisActive, currentLoadPct);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/maintenance/run — Run maintenance
router.post('/api/meow/sovereign/autonomy/maintenance/run', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    const { isCrisisActive, currentLoadPct } = req.body;
    const result = await getMaintenanceMode().runMaintenance(isCrisisActive, currentLoadPct);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/maintenance/config — Update config
router.post('/api/meow/sovereign/autonomy/maintenance/config', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    getMaintenanceMode().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/autonomy/maintenance/skip — Manual skip
router.post('/api/meow/sovereign/autonomy/maintenance/skip', async (req: Request, res: Response) => {
  try {
    const { getMaintenanceMode } = await import('./sovereign/maintenance-mode');
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    const result = getMaintenanceMode().manualSkip(reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 4: EVOLUTION — /api/meow/sovereign/evolution/*
//
//  SG-013: Formula Marketplace (listings, ratings, versions)
//  SG-014: Skill Evolution (proposals, capabilities, alerts)
//  SG-015: Worker Specialization (tasks, cross-training, recommendations)
//  SG-016: Formula Genesis (patterns, candidates, approvals)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/evolution/status', async (_req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    res.json({
      marketplace: getFormulaMarketplace().getStats(),
      skillEvolution: getSkillEvolution().getStats(),
      workerSpecialization: getWorkerSpecializationEngine().getStats(),
      formulaGenesis: getFormulaGenesis().getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FORMULA MARKETPLACE — /api/meow/sovereign/evolution/marketplace/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/evolution/marketplace/stats — Stats
router.get('/api/meow/sovereign/evolution/marketplace/stats', async (_req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    res.json(getFormulaMarketplace().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/marketplace/listings/:id — Get listing
router.get('/api/meow/sovereign/evolution/marketplace/listings/:id', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const listing = getFormulaMarketplace().getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json(listing);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/marketplace/listings/:id/ratings — Ratings
router.get('/api/meow/sovereign/evolution/marketplace/listings/:id/ratings', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    res.json({ ratings: getFormulaMarketplace().getRatings(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/marketplace/listings/:id/usage — Usage stats
router.get('/api/meow/sovereign/evolution/marketplace/listings/:id/usage', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    res.json(getFormulaMarketplace().getUsageStats(req.params.id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/marketplace/imports/:instanceId — Imports for instance
router.get('/api/meow/sovereign/evolution/marketplace/imports/:instanceId', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    res.json({ imports: getFormulaMarketplace().getImportsForInstance(req.params.instanceId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/search — Search formulas
router.post('/api/meow/sovereign/evolution/marketplace/search', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const results = getFormulaMarketplace().search(req.body);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/publish — Publish formula
router.post('/api/meow/sovereign/evolution/marketplace/publish', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const result = getFormulaMarketplace().publishFormula(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/listings/:id/transition — Transition status
router.post('/api/meow/sovereign/evolution/marketplace/listings/:id/transition', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const { newStatus, reason } = req.body;
    const result = await getFormulaMarketplace().transitionStatus(req.params.id, newStatus, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/listings/:id/version — Add version
router.post('/api/meow/sovereign/evolution/marketplace/listings/:id/version', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const { version, changelog, formulaToml, breakingChanges, compatibleWith } = req.body;
    const result = await getFormulaMarketplace().addVersion(req.params.id, version, changelog, formulaToml, breakingChanges, compatibleWith);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/listings/:id/rate — Rate formula
router.post('/api/meow/sovereign/evolution/marketplace/listings/:id/rate', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const { raterInstanceId, rating, comment, performanceEvidence } = req.body;
    const result = await getFormulaMarketplace().rateFormula(req.params.id, raterInstanceId, rating, comment, performanceEvidence);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/listings/:id/evaluate — Evaluate formula
router.post('/api/meow/sovereign/evolution/marketplace/listings/:id/evaluate', async (req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const result = await getFormulaMarketplace().evaluateFormula(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/marketplace/auto-deprecate — Auto deprecate stale
router.post('/api/meow/sovereign/evolution/marketplace/auto-deprecate', async (_req: Request, res: Response) => {
  try {
    const { getFormulaMarketplace } = await import('./sovereign/formula-marketplace');
    const result = getFormulaMarketplace().autoDeprecateStale();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SKILL EVOLUTION — /api/meow/sovereign/evolution/skills/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/evolution/skills/stats — Stats
router.get('/api/meow/sovereign/evolution/skills/stats', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    res.json(getSkillEvolution().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/skills/proposals — All proposals
router.get('/api/meow/sovereign/evolution/skills/proposals', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const lifecycle = req.query.lifecycle as any;
    res.json({ proposals: getSkillEvolution().getProposals(lifecycle) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/skills/proposals/:id — Get proposal
router.get('/api/meow/sovereign/evolution/skills/proposals/:id', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const proposal = getSkillEvolution().getProposal(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/skills/discoveries — Discoveries
router.get('/api/meow/sovereign/evolution/skills/discoveries', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    res.json({ discoveries: getSkillEvolution().getDiscoveries() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/skills/alerts/active — Active alerts
router.get('/api/meow/sovereign/evolution/skills/alerts/active', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    res.json({ alerts: getSkillEvolution().getActiveAlerts() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/skills/compatibility/:skillName — Get compatibility
router.get('/api/meow/sovereign/evolution/skills/compatibility/:skillName', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const compat = getSkillEvolution().getCompatibility(req.params.skillName);
    if (!compat) return res.status(404).json({ error: 'Compatibility info not found' });
    res.json(compat);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/start — Start skill evolution engine
router.post('/api/meow/sovereign/evolution/skills/start', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    getSkillEvolution().start();
    res.json({ ok: true, message: 'Skill evolution started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/stop — Stop skill evolution engine
router.post('/api/meow/sovereign/evolution/skills/stop', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    getSkillEvolution().stop();
    res.json({ ok: true, message: 'Skill evolution stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/health-check — Run health check
router.post('/api/meow/sovereign/evolution/skills/health-check', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const result = await getSkillEvolution().runHealthCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/propose — Propose evolution
router.post('/api/meow/sovereign/evolution/skills/propose', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const { trigger, sourceSkill, healthSnapshot } = req.body;
    const result = await getSkillEvolution().proposeEvolution(trigger, sourceSkill, healthSnapshot);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/proposals/:id/transition — Transition proposal
router.post('/api/meow/sovereign/evolution/skills/proposals/:id/transition', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const { newLifecycle, details } = req.body;
    const result = await getSkillEvolution().transitionProposal(req.params.id, newLifecycle, details);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/discover — Discover capabilities
router.post('/api/meow/sovereign/evolution/skills/discover', async (_req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const result = await getSkillEvolution().discoverCapabilities();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/compatibility — Update compatibility
router.post('/api/meow/sovereign/evolution/skills/compatibility', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const { skillName, skillVersion } = req.body;
    const result = await getSkillEvolution().updateCompatibility(skillName, skillVersion);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/skills/alerts/:id/acknowledge — Acknowledge alert
router.post('/api/meow/sovereign/evolution/skills/alerts/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const { getSkillEvolution } = await import('./sovereign/skill-evolution');
    const result = getSkillEvolution().acknowledgeAlert(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER SPECIALIZATION — /api/meow/sovereign/evolution/specialization/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/evolution/specialization/stats — Stats
router.get('/api/meow/sovereign/evolution/specialization/stats', async (_req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    res.json(getWorkerSpecializationEngine().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/map — Specialization map
router.get('/api/meow/sovereign/evolution/specialization/map', async (_req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    res.json(getWorkerSpecializationEngine().getSpecializationMap());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/workers/:workerId — Analyze worker
router.get('/api/meow/sovereign/evolution/specialization/workers/:workerId', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    res.json(getWorkerSpecializationEngine().analyzeWorker(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/workers/:workerId/specializations — Worker specializations
router.get('/api/meow/sovereign/evolution/specialization/workers/:workerId/specializations', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    res.json({ specializations: getWorkerSpecializationEngine().getWorkerSpecializations(req.params.workerId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/workers/:workerId/domain/:domain — Specialization in domain
router.get('/api/meow/sovereign/evolution/specialization/workers/:workerId/domain/:domain', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const spec = getWorkerSpecializationEngine().getSpecialization(req.params.workerId, req.params.domain as any);
    if (!spec) return res.status(404).json({ error: 'Specialization not found' });
    res.json(spec);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/workers/:workerId/cross-training — Cross-training suggestions
router.get('/api/meow/sovereign/evolution/specialization/workers/:workerId/cross-training', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    res.json(getWorkerSpecializationEngine().suggestCrossTraining(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/events/recent — Recent events
router.get('/api/meow/sovereign/evolution/specialization/events/recent', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ events: getWorkerSpecializationEngine().getRecentEvents(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/specialization/cross-trainings — All cross-trainings
router.get('/api/meow/sovereign/evolution/specialization/cross-trainings', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const workerId = req.query.workerId as string | undefined;
    res.json({ crossTrainings: getWorkerSpecializationEngine().getCrossTrainings(workerId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/specialization/start — Start engine
router.post('/api/meow/sovereign/evolution/specialization/start', async (_req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    getWorkerSpecializationEngine().start();
    res.json({ ok: true, message: 'Worker specialization engine started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/specialization/stop — Stop engine
router.post('/api/meow/sovereign/evolution/specialization/stop', async (_req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    getWorkerSpecializationEngine().stop();
    res.json({ ok: true, message: 'Worker specialization engine stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/specialization/record-task — Record task completion
router.post('/api/meow/sovereign/evolution/specialization/record-task', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const result = getWorkerSpecializationEngine().recordTaskCompletion(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/specialization/decay — Run decay check
router.post('/api/meow/sovereign/evolution/specialization/decay', async (_req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const result = getWorkerSpecializationEngine().runDecayCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/specialization/recommend — Recommend worker for task
router.post('/api/meow/sovereign/evolution/specialization/recommend', async (req: Request, res: Response) => {
  try {
    const { getWorkerSpecializationEngine } = await import('./sovereign/worker-specialization');
    const { domain, availableWorkerIds, preferSpecialist } = req.body;
    const result = getWorkerSpecializationEngine().recommendWorker(domain, availableWorkerIds, preferSpecialist);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FORMULA GENESIS — /api/meow/sovereign/evolution/genesis/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/evolution/genesis/stats — Stats
router.get('/api/meow/sovereign/evolution/genesis/stats', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    res.json(getFormulaGenesis().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/genesis/candidates — All candidates
router.get('/api/meow/sovereign/evolution/genesis/candidates', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const lifecycle = req.query.lifecycle as any;
    res.json({ candidates: getFormulaGenesis().getCandidates(lifecycle) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/genesis/candidates/pending — Pending approvals
router.get('/api/meow/sovereign/evolution/genesis/candidates/pending', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    res.json({ candidates: getFormulaGenesis().getPendingApprovals() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/genesis/candidates/:id — Get candidate
router.get('/api/meow/sovereign/evolution/genesis/candidates/:id', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const candidate = getFormulaGenesis().getCandidate(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json(candidate);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/evolution/genesis/patterns — Discovered patterns
router.get('/api/meow/sovereign/evolution/genesis/patterns', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    res.json({ patterns: getFormulaGenesis().getPatterns() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/start — Start genesis engine
router.post('/api/meow/sovereign/evolution/genesis/start', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    getFormulaGenesis().start();
    res.json({ ok: true, message: 'Formula genesis started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/stop — Stop genesis engine
router.post('/api/meow/sovereign/evolution/genesis/stop', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    getFormulaGenesis().stop();
    res.json({ ok: true, message: 'Formula genesis stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/scan — Scan for patterns
router.post('/api/meow/sovereign/evolution/genesis/scan', async (_req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const result = await getFormulaGenesis().scanForPatterns();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/candidates/:id/draft — Draft formula from candidate
router.post('/api/meow/sovereign/evolution/genesis/candidates/:id/draft', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const result = await getFormulaGenesis().draftFormula(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/candidates/:id/validate — Validate candidate
router.post('/api/meow/sovereign/evolution/genesis/candidates/:id/validate', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const result = getFormulaGenesis().validateCandidate(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/candidates/:id/approve — Approve candidate
router.post('/api/meow/sovereign/evolution/genesis/candidates/:id/approve', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const { approvedBy, note } = req.body;
    if (!approvedBy) return res.status(400).json({ error: 'approvedBy required' });
    const result = getFormulaGenesis().approveCandidate(req.params.id, approvedBy, note);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/candidates/:id/reject — Reject candidate
router.post('/api/meow/sovereign/evolution/genesis/candidates/:id/reject', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const { rejectedBy, reason } = req.body;
    if (!rejectedBy || !reason) return res.status(400).json({ error: 'rejectedBy and reason required' });
    const result = getFormulaGenesis().rejectCandidate(req.params.id, rejectedBy, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/evolution/genesis/candidates/:id/compare — Compare performance
router.post('/api/meow/sovereign/evolution/genesis/candidates/:id/compare', async (req: Request, res: Response) => {
  try {
    const { getFormulaGenesis } = await import('./sovereign/formula-genesis');
    const result = getFormulaGenesis().comparePerformance(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 5: PERSISTENT IDENTITY — /api/meow/sovereign/identity/*
//
//  SG-017: Worker Persistent Memory (memories, injection, consolidation)
//  SG-018: GasTown Chronicle (events, replay, aggregation)
//  SG-019: Decision Journal (decisions, outcomes, patterns)
//  SG-020: Reputation System (reputation, leaderboard, task matching)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/identity/status', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    res.json({
      workerMemory: getWorkerPersistentMemory().getStats(),
      chronicle: getGasTownChronicle().getStats(),
      decisionJournal: getDecisionJournal().getStats(),
      reputation: getReputationSystem().getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER PERSISTENT MEMORY — /api/meow/sovereign/identity/memory/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/identity/memory/stats — Stats
router.get('/api/meow/sovereign/identity/memory/stats', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    res.json(getWorkerPersistentMemory().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/memory/workers/:workerId/count — Worker memory count
router.get('/api/meow/sovereign/identity/memory/workers/:workerId/count', async (req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    res.json({ count: getWorkerPersistentMemory().getWorkerMemoryCount(req.params.workerId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/memory/cached-count — Cached count
router.get('/api/meow/sovereign/identity/memory/cached-count', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    res.json({ count: getWorkerPersistentMemory().getCachedCount() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/initialize — Initialize
router.post('/api/meow/sovereign/identity/memory/initialize', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    await getWorkerPersistentMemory().initialize();
    res.json({ ok: true, message: 'Worker persistent memory initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/load — Load worker memories
router.post('/api/meow/sovereign/identity/memory/load', async (req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const { workerId, limit } = req.body;
    const result = await getWorkerPersistentMemory().loadWorkerMemories(workerId, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/store — Store memory
router.post('/api/meow/sovereign/identity/memory/store', async (req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const { workerId, type, content, context, importance, tags } = req.body;
    const result = await getWorkerPersistentMemory().storeMemory(workerId, type, content, context, importance, tags);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/query — Query for injection
router.post('/api/meow/sovereign/identity/memory/query', async (req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const result = await getWorkerPersistentMemory().queryForInjection(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/consolidate — Consolidate worker memories
router.post('/api/meow/sovereign/identity/memory/consolidate', async (req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const result = await getWorkerPersistentMemory().consolidateWorkerMemories(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/memory/decay — Apply decay
router.post('/api/meow/sovereign/identity/memory/decay', async (_req: Request, res: Response) => {
  try {
    const { getWorkerPersistentMemory } = await import('./sovereign/worker-persistent-memory');
    const result = await getWorkerPersistentMemory().applyDecay();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GASTOWN CHRONICLE — /api/meow/sovereign/identity/chronicle/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/identity/chronicle/stats — Stats
router.get('/api/meow/sovereign/identity/chronicle/stats', async (_req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    res.json(getGasTownChronicle().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/chronicle/events/recent — Recent events
router.get('/api/meow/sovereign/identity/chronicle/events/recent', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ events: getGasTownChronicle().getRecentEvents(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/chronicle/events/by-correlation/:id — By correlation ID
router.get('/api/meow/sovereign/identity/chronicle/events/by-correlation/:id', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    res.json({ events: getGasTownChronicle().getEventsByCorrelation(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/initialize — Initialize
router.post('/api/meow/sovereign/identity/chronicle/initialize', async (_req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    getGasTownChronicle().initialize();
    res.json({ ok: true, message: 'Chronicle initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/record — Record event
router.post('/api/meow/sovereign/identity/chronicle/record', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const { type, actor, subject, payload, options } = req.body;
    const result = await getGasTownChronicle().record(type, actor, subject, payload, options);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/query — Query events
router.post('/api/meow/sovereign/identity/chronicle/query', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const result = getGasTownChronicle().query(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/replay — Replay events
router.post('/api/meow/sovereign/identity/chronicle/replay', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const result = getGasTownChronicle().replay(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/aggregate — Aggregate events
router.post('/api/meow/sovereign/identity/chronicle/aggregate', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const result = getGasTownChronicle().aggregate(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/export — Export events
router.post('/api/meow/sovereign/identity/chronicle/export', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const result = getGasTownChronicle().exportEvents(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/retention — Apply retention
router.post('/api/meow/sovereign/identity/chronicle/retention', async (_req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const result = getGasTownChronicle().applyRetention();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/chronicle/retention-days — Set retention days
router.post('/api/meow/sovereign/identity/chronicle/retention-days', async (req: Request, res: Response) => {
  try {
    const { getGasTownChronicle } = await import('./sovereign/gastown-chronicle');
    const { days } = req.body;
    if (!days) return res.status(400).json({ error: 'days required' });
    getGasTownChronicle().setRetentionDays(days);
    res.json({ ok: true, retentionDays: days });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DECISION JOURNAL — /api/meow/sovereign/identity/decisions/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/identity/decisions/stats — Stats
router.get('/api/meow/sovereign/identity/decisions/stats', async (_req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    res.json(getDecisionJournal().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/decisions/recent — Recent decisions
router.get('/api/meow/sovereign/identity/decisions/recent', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ decisions: getDecisionJournal().getRecentDecisions(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/decisions/:id — Get entry
router.get('/api/meow/sovereign/identity/decisions/:id', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const entry = getDecisionJournal().getEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Decision entry not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/decisions/flagged/:type — Get flagged context
router.get('/api/meow/sovereign/identity/decisions/flagged/:type', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ flagged: getDecisionJournal().getFlaggedContext(req.params.type as any, limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/initialize — Initialize
router.post('/api/meow/sovereign/identity/decisions/initialize', async (_req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    getDecisionJournal().initialize();
    res.json({ ok: true, message: 'Decision journal initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/record — Record decision
router.post('/api/meow/sovereign/identity/decisions/record', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const { type, maker, context, optionsConsidered, chosenOptionId, rationale, executionTimeMs } = req.body;
    const result = await getDecisionJournal().recordDecision(type, maker, context, optionsConsidered, chosenOptionId, rationale, executionTimeMs);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/:id/outcome — Record outcome
router.post('/api/meow/sovereign/identity/decisions/:id/outcome', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const { outcome, details } = req.body;
    const result = await getDecisionJournal().recordOutcome(req.params.id, outcome, details);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/:id/review — Review decision
router.post('/api/meow/sovereign/identity/decisions/:id/review', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const { reviewStatus, reviewerNotes, reviewedBy } = req.body;
    const result = await getDecisionJournal().reviewDecision(req.params.id, reviewStatus, reviewerNotes, reviewedBy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/query — Query decisions
router.post('/api/meow/sovereign/identity/decisions/query', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const result = getDecisionJournal().queryDecisions(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/analyze-patterns — Analyze patterns
router.post('/api/meow/sovereign/identity/decisions/analyze-patterns', async (req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const result = getDecisionJournal().analyzePatterns(req.body.type);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/decisions/feedback-summary — Generate feedback summary
router.post('/api/meow/sovereign/identity/decisions/feedback-summary', async (_req: Request, res: Response) => {
  try {
    const { getDecisionJournal } = await import('./sovereign/decision-journal');
    const result = getDecisionJournal().generateFeedbackSummary();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPUTATION SYSTEM — /api/meow/sovereign/identity/reputation/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/identity/reputation/stats — Stats
router.get('/api/meow/sovereign/identity/reputation/stats', async (_req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    res.json(getReputationSystem().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/reputation/leaderboard — Leaderboard
router.get('/api/meow/sovereign/identity/reputation/leaderboard', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const sortBy = req.query.sortBy as string | undefined;
    res.json({ leaderboard: getReputationSystem().getLeaderboard(limit, sortBy as any) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/reputation/workers/:workerId — Worker reputation
router.get('/api/meow/sovereign/identity/reputation/workers/:workerId', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const rep = getReputationSystem().getWorkerReputation(req.params.workerId);
    if (!rep) return res.status(404).json({ error: 'Worker reputation not found' });
    res.json(rep);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/reputation/workers/:workerId/analysis — Analyze worker
router.get('/api/meow/sovereign/identity/reputation/workers/:workerId/analysis', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    res.json(getReputationSystem().analyzeWorkerReputation(req.params.workerId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/identity/reputation/workers/:workerId/events — Worker events
router.get('/api/meow/sovereign/identity/reputation/workers/:workerId/events', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ events: getReputationSystem().getWorkerEvents(req.params.workerId, limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/initialize — Initialize
router.post('/api/meow/sovereign/identity/reputation/initialize', async (_req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    getReputationSystem().initialize();
    res.json({ ok: true, message: 'Reputation system initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/workers/:workerId/ensure — Ensure worker reputation
router.post('/api/meow/sovereign/identity/reputation/workers/:workerId/ensure', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const result = getReputationSystem().ensureWorkerReputation(req.params.workerId, req.body.workerName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/record-outcome — Record task outcome
router.post('/api/meow/sovereign/identity/reputation/record-outcome', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const { workerId, outcome } = req.body;
    const result = await getReputationSystem().recordTaskOutcome(workerId, outcome);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/decay — Apply inactivity decay
router.post('/api/meow/sovereign/identity/reputation/decay', async (_req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const result = getReputationSystem().applyInactivityDecay();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/adjust — Adjust reputation manually
router.post('/api/meow/sovereign/identity/reputation/adjust', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const { workerId, dimension, delta, reason, adjustedBy } = req.body;
    const result = await getReputationSystem().adjustReputation(workerId, dimension, delta, reason, adjustedBy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/query — Query workers
router.post('/api/meow/sovereign/identity/reputation/query', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const result = getReputationSystem().queryWorkers(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/identity/reputation/best-for-task — Best workers for task
router.post('/api/meow/sovereign/identity/reputation/best-for-task', async (req: Request, res: Response) => {
  try {
    const { getReputationSystem } = await import('./sovereign/reputation-system');
    const result = getReputationSystem().getBestWorkersForTask(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 6: EXTERNAL INTERFACE — /api/meow/sovereign/external/*
//
//  SG-021: API Gateway (keys, rate limits, request handling)
//  SG-022: GasTown CLI (command execution)
//  SG-023: Webhooks Outbound (registrations, deliveries, dead letters)
//  SG-024: Auto Reports (generation, scheduling)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/external/status', async (_req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    res.json({
      apiGateway: getApiGateway().getStats(),
      cli: getGasTownCli().getStats(),
      webhooksOut: getWebhooksOutbound().getStats(),
      autoReports: getAutoReporter().getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API GATEWAY — /api/meow/sovereign/external/gateway/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/external/gateway/stats — Stats
router.get('/api/meow/sovereign/external/gateway/stats', async (_req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    res.json(getApiGateway().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/gateway/health — Gateway health
router.get('/api/meow/sovereign/external/gateway/health', async (_req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    res.json(getApiGateway().getHealth());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/gateway/endpoints — Available endpoints
router.get('/api/meow/sovereign/external/gateway/endpoints', async (_req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    res.json({ endpoints: getApiGateway().getEndpoints() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/gateway/keys — List API keys
router.get('/api/meow/sovereign/external/gateway/keys', async (_req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    res.json({ keys: getApiGateway().listKeys() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/keys — Create API key
router.post('/api/meow/sovereign/external/gateway/keys', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { label, ownerId, permissions, rateLimitPerMin, expiresInDays } = req.body;
    const result = await getApiGateway().createKey(label, ownerId, permissions, rateLimitPerMin, expiresInDays);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/keys/:id/revoke — Revoke API key
router.post('/api/meow/sovereign/external/gateway/keys/:id/revoke', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const result = getApiGateway().revokeKey(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/authenticate — Authenticate key
router.post('/api/meow/sovereign/external/gateway/authenticate', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { rawKey } = req.body;
    if (!rawKey) return res.status(400).json({ error: 'rawKey required' });
    const result = getApiGateway().authenticate(rawKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/rate-limit/check — Check rate limit
router.post('/api/meow/sovereign/external/gateway/rate-limit/check', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { keyId, limitOverride } = req.body;
    if (!keyId) return res.status(400).json({ error: 'keyId required' });
    const result = getApiGateway().checkRateLimit(keyId, limitOverride);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/validate — Validate request
router.post('/api/meow/sovereign/external/gateway/validate', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { endpoint, method, body } = req.body;
    const result = getApiGateway().validateRequest(endpoint, method, body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/gateway/handle — Handle request
router.post('/api/meow/sovereign/external/gateway/handle', async (req: Request, res: Response) => {
  try {
    const { getApiGateway } = await import('./sovereign/api-gateway');
    const { rawKey, method, endpoint, body, query, ipAddress, userAgent } = req.body;
    const result = await getApiGateway().handleRequest(rawKey, method, endpoint, body, query, ipAddress, userAgent);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI — /api/meow/cli (kept at original path) + /api/meow/sovereign/external/cli/*
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/meow/cli — Execute CLI command (original path preserved)
router.post('/api/meow/cli', async (req: Request, res: Response) => {
  try {
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    const cli = getGasTownCli();
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ ok: false, error: 'command string required' });
    }
    const result = await cli.execute(command);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/cli/stats — CLI stats
router.get('/api/meow/sovereign/external/cli/stats', async (_req: Request, res: Response) => {
  try {
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    res.json(getGasTownCli().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/cli/history — Command history
router.get('/api/meow/sovereign/external/cli/history', async (req: Request, res: Response) => {
  try {
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getGasTownCli().getHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/cli/execute — Execute command (sovereign path)
router.post('/api/meow/sovereign/external/cli/execute', async (req: Request, res: Response) => {
  try {
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    const { command, operatorId } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command string required' });
    }
    const result = await getGasTownCli().execute(command, operatorId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/cli/batch — Execute batch commands
router.post('/api/meow/sovereign/external/cli/batch', async (req: Request, res: Response) => {
  try {
    const { getGasTownCli } = await import('./sovereign/gastown-cli');
    const { commands, operatorId } = req.body;
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'commands (string[]) required' });
    }
    const result = await getGasTownCli().executeBatch(commands, operatorId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOKS OUTBOUND — /api/meow/sovereign/external/webhooks/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/external/webhooks/stats — Stats
router.get('/api/meow/sovereign/external/webhooks/stats', async (_req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    res.json(getWebhooksOutbound().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/webhooks — List webhooks
router.get('/api/meow/sovereign/external/webhooks', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const includeDeleted = req.query.includeDeleted === 'true';
    res.json({ webhooks: getWebhooksOutbound().list(includeDeleted) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/webhooks/dead-letters — Dead letters
router.get('/api/meow/sovereign/external/webhooks/dead-letters', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ deadLetters: getWebhooksOutbound().getDeadLetters(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/webhooks/:id — Get webhook
router.get('/api/meow/sovereign/external/webhooks/:id', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const webhook = getWebhooksOutbound().get(req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    res.json(webhook);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/webhooks/:id/deliveries — Webhook deliveries
router.get('/api/meow/sovereign/external/webhooks/:id/deliveries', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ deliveries: getWebhooksOutbound().getDeliveries(req.params.id, limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/webhooks — Register webhook
router.post('/api/meow/sovereign/external/webhooks', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const { url, label, events, secret, headers, maxRetries } = req.body;
    const result = await getWebhooksOutbound().register(url, label, events, secret, headers, maxRetries);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/webhooks/:id/update — Update webhook
router.post('/api/meow/sovereign/external/webhooks/:id/update', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const result = await getWebhooksOutbound().update(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/webhooks/:id/test — Test webhook
router.post('/api/meow/sovereign/external/webhooks/:id/test', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const result = await getWebhooksOutbound().test(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/webhooks/emit — Emit event to all subscribed webhooks
router.post('/api/meow/sovereign/external/webhooks/emit', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const { event, data } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });
    const result = await getWebhooksOutbound().emit(event, data);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/meow/sovereign/external/webhooks/:id — Remove webhook
router.delete('/api/meow/sovereign/external/webhooks/:id', async (req: Request, res: Response) => {
  try {
    const { getWebhooksOutbound } = await import('./sovereign/webhooks-outbound');
    const result = getWebhooksOutbound().remove(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTO REPORTS — /api/meow/sovereign/external/reports/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/external/reports/stats — Stats
router.get('/api/meow/sovereign/external/reports/stats', async (_req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    res.json(getAutoReporter().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/reports/schedule — Get schedule
router.get('/api/meow/sovereign/external/reports/schedule', async (_req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    res.json(getAutoReporter().getSchedule());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/reports/latest/:type — Latest report by type
router.get('/api/meow/sovereign/external/reports/latest/:type', async (req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    const report = getAutoReporter().getLatestByType(req.params.type as any);
    if (!report) return res.status(404).json({ error: 'No report found for type' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/external/reports/:id — Get report by ID
router.get('/api/meow/sovereign/external/reports/:id', async (req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    const report = getAutoReporter().getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/reports/query — Query reports
router.post('/api/meow/sovereign/external/reports/query', async (req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    const result = getAutoReporter().queryReports(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/reports/generate — Generate report
router.post('/api/meow/sovereign/external/reports/generate', async (req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    const { type, trigger } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });
    const result = await getAutoReporter().generateReport(type, trigger);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/reports/scheduler/start — Start scheduler
router.post('/api/meow/sovereign/external/reports/scheduler/start', async (_req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    getAutoReporter().startScheduler();
    res.json({ ok: true, message: 'Report scheduler started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/reports/scheduler/stop — Stop scheduler
router.post('/api/meow/sovereign/external/reports/scheduler/stop', async (_req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    getAutoReporter().stopScheduler();
    res.json({ ok: true, message: 'Report scheduler stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/external/reports/schedule — Update schedule
router.post('/api/meow/sovereign/external/reports/schedule', async (req: Request, res: Response) => {
  try {
    const { getAutoReporter } = await import('./sovereign/auto-reports');
    getAutoReporter().updateSchedule(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  GROUP 7: RESILIENCE — /api/meow/sovereign/resilience/*
//
//  SG-025: State Snapshots (snapshots, collectors, restore)
//  SG-026: Graceful Degradation (levels, signals, recovery)
//  SG-027: Cross-Region Failover (failover, failback, sync state)
//  SG-028: Chaos Engineering (experiments, suites, safety)
//
// =============================================================================

// ── Status overview ──────────────────────────────────────────────────────────
router.get('/api/meow/sovereign/resilience/status', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    res.json({
      snapshots: getStateSnapshotManager().getStats(),
      degradation: getGracefulDegradation().getStatus(),
      failover: getCrossRegionFailover().getStatus(),
      chaos: getChaosEngineering().getStats(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE SNAPSHOTS — /api/meow/sovereign/resilience/snapshots/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/resilience/snapshots/stats — Stats
router.get('/api/meow/sovereign/resilience/snapshots/stats', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    res.json(getStateSnapshotManager().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/snapshots/config — Config
router.get('/api/meow/sovereign/resilience/snapshots/config', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    res.json(getStateSnapshotManager().getConfig());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/snapshots/latest — Latest snapshot
router.get('/api/meow/sovereign/resilience/snapshots/latest', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const snapshot = getStateSnapshotManager().getLatestSnapshot();
    if (!snapshot) return res.status(404).json({ error: 'No snapshot found' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/snapshots/history — Snapshot history
router.get('/api/meow/sovereign/resilience/snapshots/history', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getStateSnapshotManager().getSnapshotHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/initialize — Initialize
router.post('/api/meow/sovereign/resilience/snapshots/initialize', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    getStateSnapshotManager().initialize(req.body);
    res.json({ ok: true, message: 'Snapshot manager initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/take — Take snapshot
router.post('/api/meow/sovereign/resilience/snapshots/take', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const { trigger, label } = req.body;
    if (!trigger) return res.status(400).json({ error: 'trigger required' });
    const result = await getStateSnapshotManager().takeSnapshot(trigger, label);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/restore/latest — Restore from latest
router.post('/api/meow/sovereign/resilience/snapshots/restore/latest', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const result = await getStateSnapshotManager().restoreFromLatest();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/restore/:id — Restore from specific snapshot
router.post('/api/meow/sovereign/resilience/snapshots/restore/:id', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const result = await getStateSnapshotManager().restoreFromSnapshot(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/verify-all — Verify all checksums
router.post('/api/meow/sovereign/resilience/snapshots/verify-all', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const result = getStateSnapshotManager().verifyAllSnapshots();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/register-collector — Register collector
router.post('/api/meow/sovereign/resilience/snapshots/register-collector', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required (collector must be registered programmatically)' });
    // Note: collector function must be registered programmatically, this is a placeholder
    res.status(501).json({ error: 'Collectors must be registered programmatically via getStateSnapshotManager().registerCollector()' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/periodic/start — Start periodic snapshots
router.post('/api/meow/sovereign/resilience/snapshots/periodic/start', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    getStateSnapshotManager().startPeriodicSnapshots();
    res.json({ ok: true, message: 'Periodic snapshots started' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/periodic/stop — Stop periodic snapshots
router.post('/api/meow/sovereign/resilience/snapshots/periodic/stop', async (_req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    getStateSnapshotManager().stopPeriodicSnapshots();
    res.json({ ok: true, message: 'Periodic snapshots stopped' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/snapshots/config — Update config
router.post('/api/meow/sovereign/resilience/snapshots/config', async (req: Request, res: Response) => {
  try {
    const { getStateSnapshotManager } = await import('./sovereign/state-snapshot');
    getStateSnapshotManager().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL DEGRADATION — /api/meow/sovereign/resilience/degradation/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/resilience/degradation/status — Full status
router.get('/api/meow/sovereign/resilience/degradation/status', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json(getGracefulDegradation().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/stats — Stats
router.get('/api/meow/sovereign/resilience/degradation/stats', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json(getGracefulDegradation().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/level — Current level
router.get('/api/meow/sovereign/resilience/degradation/level', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json({ level: getGracefulDegradation().getCurrentLevel(), parallelismPct: getGracefulDegradation().getParallelismPct() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/config — Config
router.get('/api/meow/sovereign/resilience/degradation/config', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json(getGracefulDegradation().getConfig());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/formula/:formulaId/paused — Is formula paused?
router.get('/api/meow/sovereign/resilience/degradation/formula/:formulaId/paused', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json({ paused: getGracefulDegradation().isFormulaPaused(req.params.formulaId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/formula/:formulaId/classification — Formula classification
router.get('/api/meow/sovereign/resilience/degradation/formula/:formulaId/classification', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json(getGracefulDegradation().getFormulaClassification(req.params.formulaId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/formula/:formulaId/skippable — Skippable steps
router.get('/api/meow/sovereign/resilience/degradation/formula/:formulaId/skippable', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json({ steps: getGracefulDegradation().getSkippableSteps(req.params.formulaId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/formula/:formulaId/timeout-multiplier — Timeout multiplier
router.get('/api/meow/sovereign/resilience/degradation/formula/:formulaId/timeout-multiplier', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    res.json({ multiplier: getGracefulDegradation().getTimeoutMultiplier(req.params.formulaId) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/events — Event history
router.get('/api/meow/sovereign/resilience/degradation/events', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ events: getGracefulDegradation().getEventHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/degradation/recovery-tests — Recent recovery tests
router.get('/api/meow/sovereign/resilience/degradation/recovery-tests', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ tests: getGracefulDegradation().getRecentRecoveryTests(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/initialize — Initialize
router.post('/api/meow/sovereign/resilience/degradation/initialize', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    getGracefulDegradation().initialize(req.body);
    res.json({ ok: true, message: 'Graceful degradation initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/report-failure — Report failure
router.post('/api/meow/sovereign/resilience/degradation/report-failure', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const { type, source, message, severity, value, threshold } = req.body;
    const result = getGracefulDegradation().reportFailure(type, source, message, severity, value, threshold);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/signals/:id/resolve — Resolve signal
router.post('/api/meow/sovereign/resilience/degradation/signals/:id/resolve', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const result = getGracefulDegradation().resolveSignal(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/evaluate — Evaluate degradation level
router.post('/api/meow/sovereign/resilience/degradation/evaluate', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const result = getGracefulDegradation().evaluateLevel();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/recover — Attempt recovery
router.post('/api/meow/sovereign/resilience/degradation/recover', async (_req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const result = await getGracefulDegradation().attemptRecovery();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/force-recovery — Force recovery
router.post('/api/meow/sovereign/resilience/degradation/force-recovery', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const result = getGracefulDegradation().forceRecovery(req.body.targetLevel);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/config — Update config
router.post('/api/meow/sovereign/resilience/degradation/config', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    getGracefulDegradation().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/degradation/register-formula — Register formula classification
router.post('/api/meow/sovereign/resilience/degradation/register-formula', async (req: Request, res: Response) => {
  try {
    const { getGracefulDegradation } = await import('./sovereign/graceful-degradation');
    const result = getGracefulDegradation().registerFormulaClassification(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-REGION FAILOVER — /api/meow/sovereign/resilience/failover/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/resilience/failover/status — Status
router.get('/api/meow/sovereign/resilience/failover/status', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    res.json(getCrossRegionFailover().getStatus());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/failover/stats — Stats
router.get('/api/meow/sovereign/resilience/failover/stats', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    res.json(getCrossRegionFailover().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/failover/config — Config
router.get('/api/meow/sovereign/resilience/failover/config', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    res.json(getCrossRegionFailover().getConfig());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/failover/role — Current role
router.get('/api/meow/sovereign/resilience/failover/role', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const fr = getCrossRegionFailover();
    res.json({
      role: fr.getRole(),
      instanceId: fr.getInstanceId(),
      isPrimary: fr.isPrimary(),
      isStandby: fr.isStandby(),
      syncState: fr.getSyncState(),
      peerInstance: fr.getPeerInstance(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/failover/history — Failover history
router.get('/api/meow/sovereign/resilience/failover/history', async (req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getCrossRegionFailover().getFailoverHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/failover/initialize — Initialize
router.post('/api/meow/sovereign/resilience/failover/initialize', async (req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    getCrossRegionFailover().initialize(req.body);
    res.json({ ok: true, message: 'Cross-region failover initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/failover/initiate — Initiate failover
router.post('/api/meow/sovereign/resilience/failover/initiate', async (req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const { trigger } = req.body;
    if (!trigger) return res.status(400).json({ error: 'trigger required' });
    const result = await getCrossRegionFailover().initiateFailover(trigger);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/failover/failback — Initiate failback
router.post('/api/meow/sovereign/resilience/failover/failback', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const result = await getCrossRegionFailover().initiateFailback();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/failover/manual — Manual failover
router.post('/api/meow/sovereign/resilience/failover/manual', async (_req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    const result = await getCrossRegionFailover().manualFailover();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/failover/config — Update config
router.post('/api/meow/sovereign/resilience/failover/config', async (req: Request, res: Response) => {
  try {
    const { getCrossRegionFailover } = await import('./sovereign/cross-region-failover');
    getCrossRegionFailover().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAOS ENGINEERING — /api/meow/sovereign/resilience/chaos/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/sovereign/resilience/chaos/stats — Stats
router.get('/api/meow/sovereign/resilience/chaos/stats', async (_req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    res.json(getChaosEngineering().getStats());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/chaos/config — Config
router.get('/api/meow/sovereign/resilience/chaos/config', async (_req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    res.json(getChaosEngineering().getConfig());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/chaos/active — Is active / current experiment
router.get('/api/meow/sovereign/resilience/chaos/active', async (_req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    res.json({ active: getChaosEngineering().isActive(), experiment: getChaosEngineering().getCurrentExperiment() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/chaos/experiments/history — Experiment history
router.get('/api/meow/sovereign/resilience/chaos/experiments/history', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ history: getChaosEngineering().getExperimentHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/chaos/reports/history — Report history
router.get('/api/meow/sovereign/resilience/chaos/reports/history', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    res.json({ reports: getChaosEngineering().getReportHistory(limit) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/meow/sovereign/resilience/chaos/reports/latest — Latest report
router.get('/api/meow/sovereign/resilience/chaos/reports/latest', async (_req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    const report = getChaosEngineering().getLatestReport();
    if (!report) return res.status(404).json({ error: 'No chaos report found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/chaos/initialize — Initialize
router.post('/api/meow/sovereign/resilience/chaos/initialize', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    getChaosEngineering().initialize(req.body);
    res.json({ ok: true, message: 'Chaos engineering initialized' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/chaos/full-suite — Run full suite
router.post('/api/meow/sovereign/resilience/chaos/full-suite', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    const result = await getChaosEngineering().runFullSuite(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/chaos/experiment — Run single experiment
router.post('/api/meow/sovereign/resilience/chaos/experiment', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    const { type, intensity } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });
    const result = await getChaosEngineering().runExperiment(type, intensity);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/chaos/abort — Abort current experiment
router.post('/api/meow/sovereign/resilience/chaos/abort', async (_req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    getChaosEngineering().abort();
    res.json({ ok: true, message: 'Chaos experiment aborted' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/meow/sovereign/resilience/chaos/config — Update config
router.post('/api/meow/sovereign/resilience/chaos/config', async (req: Request, res: Response) => {
  try {
    const { getChaosEngineering } = await import('./sovereign/chaos-engineering');
    getChaosEngineering().updateConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// =============================================================================
//
//  STAGE 06 OVERVIEW — /api/meow/stage06/status
//
// =============================================================================

router.get('/api/meow/stage06/status', (_req: Request, res: Response) => {
  const groups = {
    entities: {
      prefix: '/api/meow/sovereign/entities',
      modules: ['moros', 'atlas', 'nous', 'council'],
      endpoints: {
        status: 'GET /api/meow/sovereign/entities/status',
        moros: {
          stats: 'GET .../entities/moros/stats',
          directives: 'GET .../entities/moros/directives/active | /proposed | /by-type/:type | /:id',
          strategyReview: 'POST .../entities/moros/strategy-review',
          createDirective: 'POST .../entities/moros/directives',
          activateDirective: 'POST .../entities/moros/directives/:id/activate',
          supersedeDirective: 'POST .../entities/moros/directives/:id/supersede',
          reviewDirective: 'POST .../entities/moros/directives/:id/review',
          periodicReview: 'POST .../entities/moros/periodic-review/start | /stop',
          config: 'POST .../entities/moros/config',
        },
        atlas: {
          stats: 'GET .../entities/atlas/stats',
          advisories: 'GET .../entities/atlas/advisories/active | /by-country/:code | /by-type/:type | /:id',
          snapshots: 'GET .../entities/atlas/snapshots | /snapshots/:code',
          marketScan: 'POST .../entities/atlas/market-scan',
          createAdvisory: 'POST .../entities/atlas/advisories',
          publishAdvisory: 'POST .../entities/atlas/advisories/:id/publish',
          actedOn: 'POST .../entities/atlas/advisories/:id/acted-on',
          archive: 'POST .../entities/atlas/advisories/:id/archive',
          formulaContext: 'POST .../entities/atlas/formula-context',
          periodicScan: 'POST .../entities/atlas/periodic-scan/start | /stop',
          config: 'POST .../entities/atlas/config',
        },
        nous: {
          stats: 'GET .../entities/nous/stats',
          insights: 'GET .../entities/nous/insights/recent | /by-type/:type | /:id',
          query: 'POST .../entities/nous/query',
          validate: 'POST .../entities/nous/insights/:id/validate',
          applied: 'POST .../entities/nous/insights/:id/applied',
          impact: 'POST .../entities/nous/insights/:id/impact',
          config: 'POST .../entities/nous/config',
        },
        council: {
          stats: 'GET .../entities/council/stats',
          deliberations: 'GET .../entities/council/deliberations/recent | /by-outcome/:o | /by-trigger/:t | /:id',
          convene: 'POST .../entities/council/convene',
          shouldConvene: 'POST .../entities/council/should-convene',
          config: 'POST .../entities/council/config',
        },
      },
    },
    instances: {
      prefix: '/api/meow/sovereign/instances',
      modules: ['ecom-latam', 'ecom-global', 'content-factory', 'federation'],
      endpoints: 'status, start/stop/pause/resume, workers, budget, campaigns, molecules, countries/markets, mail, resources, knowledge, conflicts',
    },
    autonomy: {
      prefix: '/api/meow/sovereign/autonomy',
      modules: ['circadian', 'scheduler', 'crisis', 'maintenance'],
      endpoints: 'status, phase/triggers, schedule/slots, crisis trigger/mitigate/resolve/post-mortem, maintenance pre-check/run/skip',
    },
    evolution: {
      prefix: '/api/meow/sovereign/evolution',
      modules: ['marketplace', 'skills', 'specialization', 'genesis'],
      endpoints: 'status, publish/search/rate/evaluate, propose/transition/discover, record-task/decay/recommend, scan/draft/validate/approve/reject',
    },
    identity: {
      prefix: '/api/meow/sovereign/identity',
      modules: ['memory', 'chronicle', 'decisions', 'reputation'],
      endpoints: 'status, store/load/query/consolidate/decay, record/query/replay/aggregate/export, record/outcome/review/analyze/feedback, leaderboard/best-for-task/adjust',
    },
    external: {
      prefix: '/api/meow/sovereign/external',
      modules: ['gateway', 'cli', 'webhooks', 'reports'],
      endpoints: 'status, keys/authenticate/rate-limit/handle, execute/batch/history, register/emit/test/deliveries, generate/schedule/query',
    },
    resilience: {
      prefix: '/api/meow/sovereign/resilience',
      modules: ['snapshots', 'degradation', 'failover', 'chaos'],
      endpoints: 'status, take/restore/verify/periodic, report-failure/evaluate/recover/force-recovery, initiate/failback/manual, full-suite/experiment/abort',
    },
  };

  res.json({
    stage: '06',
    name: 'Sovereign Gas Town',
    status: 'active',
    groups: 7,
    modules: 28,
    totalEndpoints: '~250',
    cli: 'POST /api/meow/cli',
    overview: groups,
    timestamp: new Date().toISOString(),
  });
});

export default router;
