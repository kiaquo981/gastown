/**
 * Wave 7 Routes — Advanced Services REST API
 *
 * Exposes: MeowAdvanced, WorkerPool, GUPPAdvanced, ConvoyManager,
 *          MailAdvanced, Refinery, PatrolEngine, SkillsAdvanced
 * Prefix: /api/meow/
 */

import { Router, Request, Response } from 'express';
import { meowAdvanced } from './meow-advanced';
import { workerPool } from './worker-pool';
import { guppAdvanced } from './gupp-advanced';
import { convoyManager } from './convoy-manager';
import { mailAdvanced } from './mail-advanced';
import { refinery } from './refinery';
import { patrolEngine } from './patrols-engine';
import { skillsAdvanced } from './skills-advanced';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// MEOW ADVANCED — EP-022→033
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/advanced/stats', (_req: Request, res: Response) => {
  res.json(meowAdvanced.stats());
});

router.post('/api/meow/advanced/nest', async (req: Request, res: Response) => {
  try {
    const { parentId, childId, childFormulaId } = req.body;
    await meowAdvanced.nestMolecule(parentId, childId, childFormulaId);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/advanced/branch', (req: Request, res: Response) => {
  try {
    const { moleculeId, stepId, routes } = req.body;
    meowAdvanced.registerBranch(moleculeId, stepId, routes);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/advanced/template', (req: Request, res: Response) => {
  const { name, formulaContent, description, tags } = req.body;
  meowAdvanced.registerTemplate(name, formulaContent || '', description || '', tags);
  res.json({ ok: true });
});

router.get('/api/meow/advanced/templates', (_req: Request, res: Response) => {
  res.json(meowAdvanced.listTemplates());
});

router.get('/api/meow/advanced/versions/:formulaId', (req: Request, res: Response) => {
  res.json(meowAdvanced.listVersions(req.params.formulaId));
});

router.post('/api/meow/advanced/versions/:formulaId', (req: Request, res: Response) => {
  const { version, content } = req.body;
  meowAdvanced.registerVersion(req.params.formulaId, version, content);
  res.json({ ok: true });
});

router.get('/api/meow/advanced/export/:moleculeId', async (req: Request, res: Response) => {
  try {
    const json = await meowAdvanced.exportMolecule(req.params.moleculeId);
    res.json({ data: json });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/advanced/import', async (req: Request, res: Response) => {
  try {
    const id = await meowAdvanced.importMolecule(JSON.stringify(req.body));
    res.json({ moleculeId: id });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/meow/advanced/history/:moleculeId', (req: Request, res: Response) => {
  res.json(meowAdvanced.getHistory(req.params.moleculeId));
});

router.get('/api/meow/advanced/metrics/:moleculeId', (req: Request, res: Response) => {
  const m = meowAdvanced.getMoleculeMetrics(req.params.moleculeId);
  if (!m) return res.status(404).json({ error: 'No metrics' });
  res.json(m);
});

router.get('/api/meow/advanced/query', async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const filters: Record<string, unknown> = {};
  if (status) filters.status = status;
  const results = await meowAdvanced.queryMolecules(filters as any);
  res.json(results);
});

router.get('/api/meow/advanced/detail/:moleculeId', async (req: Request, res: Response) => {
  const detail = await meowAdvanced.getMoleculeDetail(req.params.moleculeId);
  if (!detail) return res.status(404).json({ error: 'Molecule not found' });
  res.json(detail);
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER POOL — EP-048→058
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/pool/overview', (_req: Request, res: Response) => {
  res.json(workerPool.overview());
});

router.get('/api/meow/pool/workers', (req: Request, res: Response) => {
  const role = req.query.role as string | undefined;
  const filters: Record<string, unknown> = {};
  if (role) filters.role = role;
  res.json(workerPool.listWorkers(filters as any));
});

router.get('/api/meow/pool/workers/:workerId', (req: Request, res: Response) => {
  const w = workerPool.getWorker(req.params.workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  res.json(w);
});

router.post('/api/meow/pool/workers/:workerId/heartbeat', (req: Request, res: Response) => {
  workerPool.heartbeat(req.params.workerId);
  res.json({ ok: true });
});

router.get('/api/meow/pool/workers/:workerId/alive', (req: Request, res: Response) => {
  res.json({ status: workerPool.checkAlive(req.params.workerId) });
});

router.get('/api/meow/pool/workers/:workerId/cv', (req: Request, res: Response) => {
  res.json(workerPool.getWorkerCV(req.params.workerId));
});

router.get('/api/meow/pool/workers/:workerId/hooks', (req: Request, res: Response) => {
  res.json(workerPool.getWorkerHooks(req.params.workerId));
});

router.post('/api/meow/pool/workers/:workerId/hooks/:hookId', (req: Request, res: Response) => {
  workerPool.assignHook(req.params.workerId, req.params.hookId);
  res.json({ ok: true });
});

router.post('/api/meow/pool/workers/:workerId/rig', (req: Request, res: Response) => {
  try {
    const binding = workerPool.assignRig(req.params.workerId, req.body.rigId);
    res.json(binding);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/meow/pool/workers/:workerId/rig', (req: Request, res: Response) => {
  res.json(workerPool.getRig(req.params.workerId) || null);
});

router.get('/api/meow/pool/costs', (_req: Request, res: Response) => {
  res.json(workerPool.getCostReport());
});

router.post('/api/meow/pool/costs/track', (req: Request, res: Response) => {
  const { workerId, tokens, cost } = req.body;
  workerPool.recordCost(workerId, tokens || 0, cost || 0);
  res.json({ ok: true });
});

router.get('/api/meow/pool/status', (_req: Request, res: Response) => {
  res.json(workerPool.getPoolStatus());
});

router.put('/api/meow/pool/config', (req: Request, res: Response) => {
  workerPool.setPoolConfig(req.body);
  res.json({ ok: true });
});

router.post('/api/meow/pool/sessions/:workerId/save', (req: Request, res: Response) => {
  workerPool.saveSession(req.params.workerId, req.body.state || {});
  res.json({ ok: true });
});

router.get('/api/meow/pool/sessions/:workerId/restore', (req: Request, res: Response) => {
  const state = workerPool.restoreSession(req.params.workerId);
  res.json(state || null);
});

router.post('/api/meow/pool/workers/:workerId/crash', (req: Request, res: Response) => {
  workerPool.markCrashed(req.params.workerId, req.body.error || 'unknown');
  res.json({ ok: true });
});

router.post('/api/meow/pool/workers/:workerId/recover', (req: Request, res: Response) => {
  workerPool.recover(req.params.workerId);
  res.json({ ok: true });
});

router.get('/api/meow/pool/workers/:workerId/crashes', (req: Request, res: Response) => {
  res.json(workerPool.getRecoveryLog(req.params.workerId));
});

router.get('/api/meow/pool/workers/:workerId/config', (req: Request, res: Response) => {
  res.json(workerPool.getConfig(req.params.workerId));
});

router.put('/api/meow/pool/workers/:workerId/config', (req: Request, res: Response) => {
  workerPool.setConfig(req.params.workerId, req.body);
  res.json({ ok: true });
});

router.get('/api/meow/pool/templates/:role', (req: Request, res: Response) => {
  const t = workerPool.getTemplate(req.params.role as any);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

router.post('/api/meow/pool/templates/:role', (req: Request, res: Response) => {
  workerPool.registerTemplate(req.params.role as any, req.body);
  res.json({ ok: true });
});

router.post('/api/meow/pool/spawn/:role', (req: Request, res: Response) => {
  try {
    const w = workerPool.spawnFromTemplate(req.params.role as any, req.body);
    res.status(201).json(w);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GUPP ADVANCED — EP-064→066
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/gupp/advanced/stats', (_req: Request, res: Response) => {
  res.json(guppAdvanced.stats());
});

router.get('/api/meow/gupp/advanced/backpressure', (_req: Request, res: Response) => {
  res.json(guppAdvanced.checkBackpressure());
});

router.put('/api/meow/gupp/advanced/backpressure', (req: Request, res: Response) => {
  guppAdvanced.setBackpressureConfig(req.body);
  res.json(guppAdvanced.getBackpressureConfig());
});

router.get('/api/meow/gupp/advanced/buckets', (_req: Request, res: Response) => {
  res.json(guppAdvanced.getPriorityBuckets());
});

router.put('/api/meow/gupp/advanced/buckets/:priority', (req: Request, res: Response) => {
  guppAdvanced.setPriorityBucket(parseInt(req.params.priority), req.body);
  res.json(guppAdvanced.getPriorityBuckets());
});

router.get('/api/meow/gupp/advanced/metrics', (_req: Request, res: Response) => {
  res.json(guppAdvanced.getMetrics());
});

router.post('/api/meow/gupp/advanced/metrics/reset', (_req: Request, res: Response) => {
  guppAdvanced.resetMetrics();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONVOY MANAGER — EP-069→073
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/convoy/advanced/stats', (_req: Request, res: Response) => {
  res.json(convoyManager.stats());
});

router.get('/api/meow/convoy/advanced/list', (_req: Request, res: Response) => {
  res.json(convoyManager.listConvoysEnriched());
});

router.get('/api/meow/convoy/advanced/:convoyId', (req: Request, res: Response) => {
  const detail = convoyManager.getConvoyDetail(req.params.convoyId);
  if (!detail) return res.status(404).json({ error: 'Convoy not found' });
  res.json(detail);
});

router.get('/api/meow/convoy/advanced/:convoyId/history', (req: Request, res: Response) => {
  res.json(convoyManager.getHistory(req.params.convoyId));
});

router.get('/api/meow/convoy/advanced/history/recent', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(convoyManager.getRecentHistory(limit));
});

router.get('/api/meow/convoy/advanced/templates/list', (_req: Request, res: Response) => {
  res.json(convoyManager.listTemplates());
});

router.post('/api/meow/convoy/advanced/templates', (req: Request, res: Response) => {
  const { name, description, ...opts } = req.body;
  const t = convoyManager.registerTemplate(name, description || '', opts);
  res.status(201).json(t);
});

router.post('/api/meow/convoy/advanced/from-template', (req: Request, res: Response) => {
  try {
    const { templateId, beadIds, overrides } = req.body;
    const convoy = convoyManager.createFromTemplate(templateId, beadIds, overrides);
    res.status(201).json(convoy);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/meow/convoy/advanced/:convoyId/merge-strategy', (req: Request, res: Response) => {
  res.json(convoyManager.getMergeStrategy(req.params.convoyId) || convoyManager.getDefaultMergeStrategy());
});

router.put('/api/meow/convoy/advanced/:convoyId/merge-strategy', (req: Request, res: Response) => {
  convoyManager.setMergeStrategy(req.params.convoyId, req.body);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIL ADVANCED — EP-077→081
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/mail/dashboard', (_req: Request, res: Response) => {
  res.json(mailAdvanced.getMailDashboard());
});

router.get('/api/meow/mail/advanced/stats', (_req: Request, res: Response) => {
  res.json(mailAdvanced.stats());
});

router.post('/api/meow/mail/queue-workers', (req: Request, res: Response) => {
  const { workerId, batchSize } = req.body;
  const qw = mailAdvanced.registerQueueWorker(workerId, batchSize);
  res.status(201).json(qw);
});

router.get('/api/meow/mail/queue-workers', (_req: Request, res: Response) => {
  res.json(mailAdvanced.listQueueWorkers());
});

router.post('/api/meow/mail/queue-workers/:id/claim', (req: Request, res: Response) => {
  const batch = mailAdvanced.claimBatch(req.params.id);
  res.json({ batch, count: batch.length });
});

router.post('/api/meow/mail/queue-workers/:id/pause', (req: Request, res: Response) => {
  mailAdvanced.pauseQueueWorker(req.params.id);
  res.json({ ok: true });
});

router.post('/api/meow/mail/queue-workers/:id/resume', (req: Request, res: Response) => {
  mailAdvanced.resumeQueueWorker(req.params.id);
  res.json({ ok: true });
});

router.get('/api/meow/mail/mute-rules/:workerId', (req: Request, res: Response) => {
  res.json(mailAdvanced.getMuteRules(req.params.workerId));
});

router.post('/api/meow/mail/mute-rules/:workerId', (req: Request, res: Response) => {
  const rule = mailAdvanced.addMuteRule(req.params.workerId, req.body);
  res.status(201).json(rule);
});

router.delete('/api/meow/mail/mute-rules/:workerId/:ruleId', (req: Request, res: Response) => {
  const ok = mailAdvanced.removeMuteRule(req.params.workerId, req.params.ruleId);
  res.json({ ok });
});

router.get('/api/meow/mail/retention', (_req: Request, res: Response) => {
  res.json(mailAdvanced.getRetentionPolicy());
});

router.put('/api/meow/mail/retention', (req: Request, res: Response) => {
  mailAdvanced.setRetentionPolicy(req.body);
  res.json(mailAdvanced.getRetentionPolicy());
});

router.post('/api/meow/mail/retention/enforce', (_req: Request, res: Response) => {
  const result = mailAdvanced.enforceRetention();
  res.json(result);
});

router.post('/api/meow/mail/bulk', (req: Request, res: Response) => {
  const sent = mailAdvanced.sendBulk(req.body.mails || []);
  res.json({ sent });
});

router.get('/api/meow/mail/threads/:workerId', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  res.json(mailAdvanced.getThreads(req.params.workerId, limit));
});

// ─────────────────────────────────────────────────────────────────────────────
// REFINERY — EP-082→091
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/refinery/dashboard', (_req: Request, res: Response) => {
  res.json(refinery.getDashboard());
});

router.get('/api/meow/refinery/stats', (_req: Request, res: Response) => {
  res.json(refinery.getDashboard());
});

router.get('/api/meow/refinery/config', (_req: Request, res: Response) => {
  res.json({ gates: refinery.getQueue().length, mode: 'auto' });
});

router.get('/api/meow/refinery/queue', (_req: Request, res: Response) => {
  res.json(refinery.getQueue());
});

router.post('/api/meow/refinery/enqueue', (req: Request, res: Response) => {
  try {
    const entry = refinery.enqueue(req.body);
    res.status(201).json(entry);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/meow/refinery/item/:id', (req: Request, res: Response) => {
  const item = refinery.getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

router.delete('/api/meow/refinery/item/:id', (req: Request, res: Response) => {
  const ok = refinery.removeItem(req.params.id);
  res.json({ ok });
});

router.post('/api/meow/refinery/gates/:itemId/run', async (req: Request, res: Response) => {
  try {
    const result = await refinery.runGates(req.params.itemId);
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/refinery/conflicts/:itemId/detect', (req: Request, res: Response) => {
  res.json(refinery.detectConflicts(req.params.itemId));
});

router.post('/api/meow/refinery/conflicts/:itemId/resolve', (req: Request, res: Response) => {
  refinery.markConflictResolved(req.params.itemId, req.body.file);
  res.json({ ok: true });
});

router.post('/api/meow/refinery/push-lock/:itemId', (req: Request, res: Response) => {
  const acquired = refinery.acquirePushLock(req.params.itemId);
  res.json({ acquired });
});

router.delete('/api/meow/refinery/push-lock/:itemId', (req: Request, res: Response) => {
  refinery.releasePushLock(req.params.itemId);
  res.json({ ok: true });
});

router.post('/api/meow/refinery/fast-path/:itemId', async (req: Request, res: Response) => {
  try {
    const result = await refinery.fastPathMerge(req.params.itemId);
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/meow/refinery/metrics', (_req: Request, res: Response) => {
  res.json(refinery.getMetrics());
});

router.post('/api/meow/refinery/item/:id/cleanup', (req: Request, res: Response) => {
  try {
    const result = refinery.postMergeCleanup(req.params.id);
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATROL ENGINE — EP-092→100
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/patrols', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const name = req.query.name as string | undefined;
  res.json(patrolEngine.getReports(name, limit));
});

router.get('/api/meow/patrols/dashboard', (_req: Request, res: Response) => {
  res.json(patrolEngine.getDashboard());
});

router.post('/api/meow/patrols/run/deacon', async (_req: Request, res: Response) => {
  try {
    const report = await patrolEngine.runDeaconPatrol();
    res.json(report);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/api/meow/patrols/run/witness', async (_req: Request, res: Response) => {
  try {
    const report = await patrolEngine.runWitnessPatrol();
    res.json(report);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/api/meow/patrols/run/refinery', async (_req: Request, res: Response) => {
  try {
    const report = await patrolEngine.runRefineryPatrol();
    res.json(report);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/api/meow/patrols/run/all', async (_req: Request, res: Response) => {
  try {
    const reports = await patrolEngine.runAllPatrols();
    res.json(reports);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/api/meow/patrols/schedules', (_req: Request, res: Response) => {
  res.json(patrolEngine.listSchedules());
});

router.post('/api/meow/patrols/schedule/:name', (req: Request, res: Response) => {
  const intervalMs = req.body.intervalMs;
  patrolEngine.schedulePatrol(req.params.name, intervalMs);
  res.json({ ok: true });
});

router.delete('/api/meow/patrols/schedule/:name', (req: Request, res: Response) => {
  patrolEngine.unschedulePatrol(req.params.name);
  res.json({ ok: true });
});

router.post('/api/meow/patrols/start-all', (_req: Request, res: Response) => {
  patrolEngine.startAll();
  res.json({ ok: true });
});

router.post('/api/meow/patrols/stop-all', (_req: Request, res: Response) => {
  patrolEngine.stopAll();
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// SKILLS ADVANCED — EP-108→110
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/skills/advanced/stats', (_req: Request, res: Response) => {
  res.json(skillsAdvanced.stats());
});

router.get('/api/meow/skills/advanced/versions/:skillName', (req: Request, res: Response) => {
  res.json(skillsAdvanced.listVersions(req.params.skillName));
});

router.post('/api/meow/skills/advanced/versions/:skillName', (req: Request, res: Response) => {
  const { version, manifest, changelog } = req.body;
  const v = skillsAdvanced.registerVersion(req.params.skillName, version, manifest, changelog);
  res.status(201).json(v);
});

router.get('/api/meow/skills/advanced/versions/:skillName/latest', (req: Request, res: Response) => {
  const v = skillsAdvanced.getLatestVersion(req.params.skillName);
  if (!v) return res.status(404).json({ error: 'No versions found' });
  res.json(v);
});

router.post('/api/meow/skills/advanced/versions/:skillName/:version/deprecate', (req: Request, res: Response) => {
  const ok = skillsAdvanced.deprecateVersion(req.params.skillName, req.params.version);
  res.json({ ok });
});

router.get('/api/meow/skills/advanced/tests/:skillName', (req: Request, res: Response) => {
  res.json(skillsAdvanced.getTestCases(req.params.skillName));
});

router.post('/api/meow/skills/advanced/tests/:skillName', (req: Request, res: Response) => {
  const { name, inputs, ...opts } = req.body;
  const tc = skillsAdvanced.addTestCase(req.params.skillName, name, inputs || {}, opts);
  res.status(201).json(tc);
});

router.delete('/api/meow/skills/advanced/tests/:testId', (req: Request, res: Response) => {
  const ok = skillsAdvanced.removeTestCase(req.params.testId);
  res.json({ ok });
});

router.post('/api/meow/skills/advanced/tests/:testId/run', async (req: Request, res: Response) => {
  try {
    const result = await skillsAdvanced.runTest(req.params.testId);
    res.json(result);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/skills/advanced/tests/:skillName/run-all', async (req: Request, res: Response) => {
  const results = await skillsAdvanced.runAllTests(req.params.skillName);
  res.json(results);
});

router.get('/api/meow/skills/advanced/tests/:skillName/results', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(skillsAdvanced.getTestResults(req.params.skillName, limit));
});

router.get('/api/meow/skills/advanced/tests/:skillName/summary', (req: Request, res: Response) => {
  res.json(skillsAdvanced.getTestSummary(req.params.skillName));
});

router.get('/api/meow/skills/marketplace', (req: Request, res: Response) => {
  const sortBy = req.query.sortBy as any;
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(skillsAdvanced.listMarketplace({ sortBy, limit }));
});

router.get('/api/meow/skills/marketplace/search', (req: Request, res: Response) => {
  const q = (req.query.q as string) || '';
  res.json(skillsAdvanced.searchMarketplace(q));
});

router.get('/api/meow/skills/marketplace/:name', (req: Request, res: Response) => {
  const entry = skillsAdvanced.getMarketplaceEntry(req.params.name);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

router.post('/api/meow/skills/marketplace/:skillName/publish', (req: Request, res: Response) => {
  try {
    const entry = skillsAdvanced.publishToMarketplace(req.params.skillName, req.body);
    res.status(201).json(entry);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post('/api/meow/skills/marketplace/:name/install', (req: Request, res: Response) => {
  const ok = skillsAdvanced.installFromMarketplace(req.params.name);
  res.json({ ok });
});

export default router;
