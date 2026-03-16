/**
 * Worker Routes — Wave 3+4+5 REST API
 *
 * Exposes Mayor, Polecat, Witness, Deacon, Boot, GUPP, Convoy,
 * Mail, Crew, and Overseer operations.
 * Prefix: /api/meow/
 */

import { Router, Request, Response, NextFunction } from 'express';
import { mayor } from './workers/mayor';
import { polecatManager } from './workers/polecat';
import { Witness } from './workers/witness';
import { deacon } from './workers/deacon';
import { boot } from './workers/boot';
import { gupp } from './workers/gupp';
import { crewManager } from './workers/crew';
import { overseer } from './workers/overseer';
import { mailRouter } from './mail';
import { startAutonomousLoop, stopAutonomousLoop, isAutonomousLoopRunning, getAutonomousLoopStats } from './autonomous-loop';

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
// MAYOR — /api/meow/mayor/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/mayor/status — Mayor overview
router.get('/api/meow/mayor/status', (_req: Request, res: Response) => {
  res.json(mayor.status());
});

// POST /api/meow/mayor/convoy — Create convoy
router.post('/api/meow/mayor/convoy', (req: Request, res: Response) => {
  const { name, beadIds, rig } = req.body;
  if (!name || !Array.isArray(beadIds) || beadIds.length === 0) {
    return res.status(400).json({ error: 'name (string) and beadIds (string[]) required' });
  }
  const convoy = mayor.createConvoy(name, beadIds, rig);
  res.status(201).json(convoy);
});

// POST /api/meow/mayor/convoy/:id/dispatch — Dispatch convoy
router.post('/api/meow/mayor/convoy/:id/dispatch', (req: Request, res: Response) => {
  try {
    const convoy = mayor.dispatchConvoy(req.params.id);
    res.json(convoy);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/mayor/sling — Assign bead to rig
router.post('/api/meow/mayor/sling', async (req: Request, res: Response) => {
  const { beadId, rig, preferWorker, tier } = req.body;
  if (!beadId || !rig) {
    return res.status(400).json({ error: 'beadId and rig required' });
  }
  await mayor.sling(beadId, rig, { preferWorker, tier });
  res.json({ ok: true, beadId, rig });
});

// POST /api/meow/mayor/escalate — Handle escalation
router.post('/api/meow/mayor/escalate', async (req: Request, res: Response) => {
  const { issue, fromWorkerId, beadId } = req.body;
  if (!issue || !fromWorkerId) {
    return res.status(400).json({ error: 'issue and fromWorkerId required' });
  }
  await mayor.handleEscalation(issue, fromWorkerId, beadId);
  res.json({ ok: true });
});

// POST /api/meow/mayor/handoff — Save state for restart
router.post('/api/meow/mayor/handoff', async (_req: Request, res: Response) => {
  const data = await mayor.handoff();
  res.json(data);
});

// ─────────────────────────────────────────────────────────────────────────────
// POLECAT — /api/meow/polecats/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/polecats — List all polecats
router.get('/api/meow/polecats', (_req: Request, res: Response) => {
  res.json({ polecats: polecatManager.list() });
});

// GET /api/meow/polecats/stats — Polecat pool stats
router.get('/api/meow/polecats/stats', (_req: Request, res: Response) => {
  res.json(polecatManager.stats());
});

// GET /api/meow/polecats/health — Health check
router.get('/api/meow/polecats/health', (_req: Request, res: Response) => {
  res.json(polecatManager.healthCheck());
});

// POST /api/meow/polecats/spawn — Spawn a polecat
router.post('/api/meow/polecats/spawn', async (req: Request, res: Response) => {
  const { beadId, skill, tier, branch } = req.body;
  if (!beadId || !skill) {
    return res.status(400).json({ error: 'beadId and skill required' });
  }
  try {
    const polecat = await polecatManager.spawn(beadId, skill, { tier, branch });
    res.status(201).json(polecat);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/polecats/:id/complete — Mark complete
router.post('/api/meow/polecats/:id/complete', async (req: Request, res: Response) => {
  try {
    await polecatManager.complete(req.params.id, req.body.prUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/polecats/:id/fail — Mark failed
router.post('/api/meow/polecats/:id/fail', async (req: Request, res: Response) => {
  try {
    await polecatManager.fail(req.params.id, req.body.error || 'Unknown error');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/polecats/cleanup — Cleanup zombies/stalled
router.post('/api/meow/polecats/cleanup', async (_req: Request, res: Response) => {
  const result = await polecatManager.cleanup();
  res.json(result);
});

// GET /api/meow/polecats/:id — Get specific polecat
router.get('/api/meow/polecats/:id', (req: Request, res: Response) => {
  const polecat = polecatManager.get(req.params.id);
  if (!polecat) return res.status(404).json({ error: 'Polecat not found' });
  res.json(polecat);
});

// ─────────────────────────────────────────────────────────────────────────────
// WITNESS — /api/meow/witness/*
// ─────────────────────────────────────────────────────────────────────────────

// Singleton witness for orchestrator rig
const orchestratorWitness = new Witness('orchestrator');

// GET /api/meow/witness/report — Last patrol report
router.get('/api/meow/witness/report', (_req: Request, res: Response) => {
  const report = orchestratorWitness.getLastReport();
  res.json({ report: report || null });
});

// POST /api/meow/witness/patrol — Run patrol now
router.post('/api/meow/witness/patrol', async (_req: Request, res: Response) => {
  const report = await orchestratorWitness.patrol();
  res.json(report);
});

// POST /api/meow/witness/start — Start patrol loop
router.post('/api/meow/witness/start', (_req: Request, res: Response) => {
  orchestratorWitness.startPatrol();
  res.json({ ok: true, message: 'Witness patrol started' });
});

// POST /api/meow/witness/stop — Stop patrol loop
router.post('/api/meow/witness/stop', (_req: Request, res: Response) => {
  orchestratorWitness.stopPatrol();
  res.json({ ok: true, message: 'Witness patrol stopped' });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEACON — /api/meow/deacon/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/deacon/health — System health score
router.get('/api/meow/deacon/health', (_req: Request, res: Response) => {
  res.json({
    health: deacon.getHealth(),
    dogs: deacon.getDogStatuses(),
  });
});

// GET /api/meow/deacon/report — Last patrol report
router.get('/api/meow/deacon/report', (_req: Request, res: Response) => {
  const report = deacon.getLastReport();
  res.json({ report: report || null });
});

// POST /api/meow/deacon/patrol — Run patrol now
router.post('/api/meow/deacon/patrol', async (_req: Request, res: Response) => {
  const report = await deacon.patrol();
  res.json(report);
});

// POST /api/meow/deacon/start — Start patrol loop
router.post('/api/meow/deacon/start', (_req: Request, res: Response) => {
  deacon.startPatrol();
  res.json({ ok: true, message: 'Deacon patrol started' });
});

// POST /api/meow/deacon/stop — Stop patrol loop
router.post('/api/meow/deacon/stop', (_req: Request, res: Response) => {
  deacon.stopPatrol();
  res.json({ ok: true, message: 'Deacon patrol stopped' });
});

// POST /api/meow/deacon/dog/:type — Run specific dog manually
router.post('/api/meow/deacon/dog/:type', async (req: Request, res: Response) => {
  try {
    const result = await deacon.runDog(req.params.type as any);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT — /api/meow/boot/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/boot/status — Boot watchdog status
router.get('/api/meow/boot/status', (_req: Request, res: Response) => {
  res.json(boot.status());
});

// GET /api/meow/boot/report — Last boot patrol report
router.get('/api/meow/boot/report', (_req: Request, res: Response) => {
  const report = boot.getLastReport();
  res.json({ report: report || null });
});

// POST /api/meow/boot/check — Run liveness check now
router.post('/api/meow/boot/check', async (_req: Request, res: Response) => {
  const report = await boot.check();
  res.json(report);
});

// POST /api/meow/boot/start — Start watchdog loop
router.post('/api/meow/boot/start', (_req: Request, res: Response) => {
  boot.start();
  res.json({ ok: true, message: 'Boot watchdog started' });
});

// POST /api/meow/boot/stop — Stop watchdog loop
router.post('/api/meow/boot/stop', (_req: Request, res: Response) => {
  boot.stop();
  res.json({ ok: true, message: 'Boot watchdog stopped' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUPP — /api/meow/gupp/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/gupp/stats — GUPP propulsion stats
router.get('/api/meow/gupp/stats', (_req: Request, res: Response) => {
  res.json(gupp.stats());
});

// GET /api/meow/gupp/hooks — List all hooks
router.get('/api/meow/gupp/hooks', (_req: Request, res: Response) => {
  res.json({ hooks: gupp.listHooks() });
});

// GET /api/meow/gupp/hooks/pending — List pending hooks
router.get('/api/meow/gupp/hooks/pending', (_req: Request, res: Response) => {
  res.json({ hooks: gupp.getPendingHooks() });
});

// GET /api/meow/gupp/hooks/agent/:agentId — Get hooks for an agent
router.get('/api/meow/gupp/hooks/agent/:agentId', (req: Request, res: Response) => {
  res.json({ hooks: gupp.getAgentHooks(req.params.agentId) });
});

// POST /api/meow/gupp/hooks — Place a hook (propel work)
router.post('/api/meow/gupp/hooks', (req: Request, res: Response) => {
  const { agentId, beadId, skill, priority, payload, ttlMs } = req.body;
  if (!agentId || !beadId || !skill) {
    return res.status(400).json({ error: 'agentId, beadId, and skill required' });
  }
  const hook = gupp.placeHook(agentId, beadId, skill, { priority, payload, ttlMs });
  res.status(201).json(hook);
});

// POST /api/meow/gupp/hooks/:id/claim — Claim a hook
router.post('/api/meow/gupp/hooks/:id/claim', (req: Request, res: Response) => {
  const { workerId } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId required' });
  try {
    const hook = gupp.claimHook(req.params.id, workerId);
    res.json(hook);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/gupp/hooks/:id/complete — Complete a hook
router.post('/api/meow/gupp/hooks/:id/complete', (req: Request, res: Response) => {
  try {
    const hook = gupp.completeHook(req.params.id);
    res.json(hook);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/gupp/hooks/:id/fail — Fail a hook
router.post('/api/meow/gupp/hooks/:id/fail', (req: Request, res: Response) => {
  const { error: errMsg } = req.body;
  try {
    const hook = gupp.failHook(req.params.id, errMsg || 'Unknown error');
    res.json(hook);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/gupp/scan — Run one scan cycle manually
router.post('/api/meow/gupp/scan', async (_req: Request, res: Response) => {
  const result = await gupp.scan();
  res.json(result);
});

// POST /api/meow/gupp/start — Start GUPP scan loop
router.post('/api/meow/gupp/start', (_req: Request, res: Response) => {
  gupp.startScan();
  res.json({ ok: true, message: 'GUPP propulsion started' });
});

// POST /api/meow/gupp/stop — Stop GUPP scan loop
router.post('/api/meow/gupp/stop', (_req: Request, res: Response) => {
  gupp.stopScan();
  res.json({ ok: true, message: 'GUPP propulsion stopped' });
});

// POST /api/meow/gupp/recover — NDI crash recovery
router.post('/api/meow/gupp/recover', (_req: Request, res: Response) => {
  const recovered = gupp.recover();
  res.json({ ok: true, recovered });
});

// GET /api/meow/gupp/hooks/:id — Get specific hook
router.get('/api/meow/gupp/hooks/:id', (req: Request, res: Response) => {
  const hook = gupp.getHook(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Hook not found' });
  res.json(hook);
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS LOOP — /api/meow/auto/*
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/meow/auto/start — Start the autonomous loop
router.post('/api/meow/auto/start', (_req: Request, res: Response) => {
  startAutonomousLoop();
  res.json({ ok: true, running: isAutonomousLoopRunning() });
});

// POST /api/meow/auto/stop — Stop the autonomous loop
router.post('/api/meow/auto/stop', (_req: Request, res: Response) => {
  stopAutonomousLoop();
  res.json({ ok: true, running: false });
});

// GET /api/meow/auto/stats — Get autonomous loop stats
router.get('/api/meow/auto/stats', (_req: Request, res: Response) => {
  res.json(getAutonomousLoopStats());
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIL — /api/meow/mail/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/mail/stats — Mail router stats
router.get('/api/meow/mail/stats', (_req: Request, res: Response) => {
  res.json(mailRouter.stats());
});

// GET /api/meow/mail/mailboxes — List all mailboxes
router.get('/api/meow/mail/mailboxes', (_req: Request, res: Response) => {
  res.json({ mailboxes: mailRouter.listMailboxes() });
});

// GET /api/meow/mail/:workerId — Get inbox for a worker
router.get('/api/meow/mail/:workerId', (req: Request, res: Response) => {
  const unreadOnly = req.query.unread === 'true';
  res.json({ messages: mailRouter.getInbox(req.params.workerId, unreadOnly) });
});

// POST /api/meow/mail/send — Send a message
router.post('/api/meow/mail/send', (req: Request, res: Response) => {
  const { from, to, priority, type, delivery, subject, body, metadata, beadId, moleculeId } = req.body;
  if (!from || !to || !subject || !body) {
    return res.status(400).json({ error: 'from, to, subject, and body required' });
  }
  const mail = mailRouter.send({
    from, to,
    priority: priority || 'normal',
    type: type || 'notification',
    delivery: delivery || 'direct',
    subject, body, metadata, beadId, moleculeId,
  });
  res.status(201).json(mail);
});

// POST /api/meow/mail/:workerId/read/:mailId — Mark message read
router.post('/api/meow/mail/:workerId/read/:mailId', (req: Request, res: Response) => {
  const ok = mailRouter.markRead(req.params.workerId, req.params.mailId);
  res.json({ ok });
});

// POST /api/meow/mail/:workerId/read-all — Mark all read
router.post('/api/meow/mail/:workerId/read-all', (req: Request, res: Response) => {
  const count = mailRouter.markAllRead(req.params.workerId);
  res.json({ ok: true, marked: count });
});

// POST /api/meow/mail/:workerId/dnd — Toggle DND
router.post('/api/meow/mail/:workerId/dnd', (req: Request, res: Response) => {
  const enabled = req.body.enabled !== false;
  mailRouter.setDND(req.params.workerId, enabled);
  res.json({ ok: true, dnd: enabled });
});

// POST /api/meow/mail/cleanup — Run cleanup cycle
router.post('/api/meow/mail/cleanup', (_req: Request, res: Response) => {
  const result = mailRouter.cleanup();
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// CREW — /api/meow/crew/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/crew — List all crew members
router.get('/api/meow/crew', (_req: Request, res: Response) => {
  res.json({ crew: crewManager.list() });
});

// GET /api/meow/crew/stats — Crew stats
router.get('/api/meow/crew/stats', (_req: Request, res: Response) => {
  res.json(crewManager.stats());
});

// GET /api/meow/crew/:id — Get specific crew member
router.get('/api/meow/crew/:id', (req: Request, res: Response) => {
  const member = crewManager.get(req.params.id);
  if (!member) return res.status(404).json({ error: 'Crew member not found' });
  res.json(member);
});

// POST /api/meow/crew/register — Register new crew member
router.post('/api/meow/crew/register', (req: Request, res: Response) => {
  const { id, name, tier, model, agentDefId } = req.body;
  if (!id || !name || !tier || !model) {
    return res.status(400).json({ error: 'id, name, tier, and model required' });
  }
  try {
    const member = crewManager.register(id, name, tier, model, agentDefId);
    res.status(201).json(member);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/crew/:id/assign — Assign work
router.post('/api/meow/crew/:id/assign', (req: Request, res: Response) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });
  try {
    crewManager.assignWork(req.params.id, task);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/crew/:id/complete — Mark work complete
router.post('/api/meow/crew/:id/complete', (req: Request, res: Response) => {
  try {
    crewManager.completeWork(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/crew/:id/pause — Pause crew member
router.post('/api/meow/crew/:id/pause', (req: Request, res: Response) => {
  try {
    crewManager.pause(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/crew/:id/resume — Resume crew member
router.post('/api/meow/crew/:id/resume', (req: Request, res: Response) => {
  try {
    crewManager.resume(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /api/meow/crew/:id/context — Get crew context
router.get('/api/meow/crew/:id/context', (req: Request, res: Response) => {
  try {
    const ctx = crewManager.getContext(req.params.id);
    res.json(ctx);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/crew/:id/context — Save context key
router.post('/api/meow/crew/:id/context', (req: Request, res: Response) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    crewManager.saveContext(req.params.id, key, value);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// OVERSEER — /api/meow/overseer/*
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/meow/overseer/stats — Overseer stats
router.get('/api/meow/overseer/stats', (_req: Request, res: Response) => {
  res.json(overseer.stats());
});

// GET /api/meow/overseer/gates — List all gates
router.get('/api/meow/overseer/gates', (_req: Request, res: Response) => {
  res.json({ gates: overseer.getAllGates() });
});

// GET /api/meow/overseer/gates/pending — List pending gates
router.get('/api/meow/overseer/gates/pending', (_req: Request, res: Response) => {
  res.json({ gates: overseer.getPendingGates() });
});

// GET /api/meow/overseer/gates/:id — Get specific gate
router.get('/api/meow/overseer/gates/:id', (req: Request, res: Response) => {
  const gate = overseer.getGate(req.params.id);
  if (!gate) return res.status(404).json({ error: 'Gate not found' });
  res.json(gate);
});

// POST /api/meow/overseer/gates — Request a gate
router.post('/api/meow/overseer/gates', (req: Request, res: Response) => {
  const { moleculeId, stepId, gateType, title, description, requestedBy } = req.body;
  if (!moleculeId || !stepId || !gateType || !title || !requestedBy) {
    return res.status(400).json({ error: 'moleculeId, stepId, gateType, title, and requestedBy required' });
  }
  const gate = overseer.requestGate(moleculeId, stepId, gateType, title, description || '', requestedBy);
  res.status(201).json(gate);
});

// POST /api/meow/overseer/gates/:id/approve — Approve gate
router.post('/api/meow/overseer/gates/:id/approve', (req: Request, res: Response) => {
  try {
    const gate = overseer.approveGate(req.params.id, req.body.reason);
    res.json(gate);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/overseer/gates/:id/reject — Reject gate
router.post('/api/meow/overseer/gates/:id/reject', (req: Request, res: Response) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason required' });
  try {
    const gate = overseer.rejectGate(req.params.id, reason);
    res.json(gate);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/meow/overseer/pause — Pause an entity
router.post('/api/meow/overseer/pause', (req: Request, res: Response) => {
  const { entityId, reason } = req.body;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  overseer.pauseEntity(entityId, reason);
  res.json({ ok: true, paused: entityId });
});

// POST /api/meow/overseer/resume — Resume an entity
router.post('/api/meow/overseer/resume', (req: Request, res: Response) => {
  const { entityId } = req.body;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  overseer.resumeEntity(entityId);
  res.json({ ok: true, resumed: entityId });
});

// POST /api/meow/overseer/escalate — Manual escalation
router.post('/api/meow/overseer/escalate', async (req: Request, res: Response) => {
  const { issue, fromWorkerId, severity } = req.body;
  if (!issue || !fromWorkerId) {
    return res.status(400).json({ error: 'issue and fromWorkerId required' });
  }
  await overseer.escalate(issue, fromWorkerId, severity || 'warning');
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW — /api/meow/workers/overview
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/workers/overview', (_req: Request, res: Response) => {
  res.json({
    mayor: mayor.status(),
    polecats: polecatManager.stats(),
    deacon: {
      health: deacon.getHealth(),
      dogs: deacon.getDogStatuses(),
    },
    witness: {
      lastReport: orchestratorWitness.getLastReport() || null,
    },
    boot: boot.status(),
    gupp: gupp.stats(),
    mail: mailRouter.stats(),
    crew: crewManager.stats(),
    overseer: overseer.stats(),
  });
});

export { orchestratorWitness };
export default router;
