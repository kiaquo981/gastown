/**
 * Final Routes — Beads Advanced (EP-003, 006, 007, 008, 011, 012, 013) + Wisp System (EP-020)
 *
 * Completes Stage 02: 147/147 EPICs.
 */

import { Router, Request, Response } from 'express';
import { beadsAdvanced } from './beads-advanced';
import { wispSystem } from './wisp-system';

const router = Router();

// ─── EP-003: MCP Server Interface ──────────────────────────────────────────────

/** GET /api/meow/mcp/tools — List MCP tool definitions */
router.get('/api/meow/mcp/tools', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.getMCPTools());
});

/** GET /api/meow/mcp/manifest — MCP server manifest (.claude.json) */
router.get('/api/meow/mcp/manifest', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.getMCPManifest());
});

/** POST /api/meow/mcp/call — Execute MCP tool call */
router.post('/api/meow/mcp/call', async (req: Request, res: Response) => {
  try {
    const { tool, args } = req.body;
    if (!tool) return res.status(400).json({ error: 'tool is required' });
    const result = await beadsAdvanced.handleMCPCall(tool, args || {});
    res.json({ result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── EP-006: Sync (Push/Pull) ──────────────────────────────────────────────────

/** GET /api/meow/sync/targets — List sync targets */
router.get('/api/meow/sync/targets', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.listSyncTargets());
});

/** POST /api/meow/sync/targets — Add sync target */
router.post('/api/meow/sync/targets', (req: Request, res: Response) => {
  try {
    const { type, url, branch } = req.body;
    if (!type || !url) return res.status(400).json({ error: 'type and url are required' });
    res.json(beadsAdvanced.addSyncTarget(type, url, branch));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/meow/sync/targets/:id — Remove sync target */
router.delete('/api/meow/sync/targets/:id', (req: Request, res: Response) => {
  const ok = beadsAdvanced.removeSyncTarget(req.params.id);
  res.json({ removed: ok });
});

/** POST /api/meow/sync/:id/push — Push beads to sync target */
router.post('/api/meow/sync/:id/push', async (req: Request, res: Response) => {
  try {
    const result = await beadsAdvanced.syncPush(req.params.id);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/meow/sync/:id/pull — Pull beads from sync target */
router.post('/api/meow/sync/:id/pull', async (req: Request, res: Response) => {
  try {
    const result = await beadsAdvanced.syncPull(req.params.id);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── EP-007: Admin (Compaction, Doctor) ─────────────────────────────────────────

/** POST /api/meow/admin/compact — Compact old closed beads */
router.post('/api/meow/admin/compact', async (_req: Request, res: Response) => {
  try {
    const result = await beadsAdvanced.compact();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/meow/admin/doctor — Run consistency checks */
router.post('/api/meow/admin/doctor', async (_req: Request, res: Response) => {
  try {
    const result = await beadsAdvanced.doctor();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/meow/admin/stats — Beads advanced stats */
router.get('/api/meow/admin/stats', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.stats());
});

// ─── EP-008: Migration ──────────────────────────────────────────────────────────

/** POST /api/meow/migrate — Migrate items from external source */
router.post('/api/meow/migrate', async (req: Request, res: Response) => {
  try {
    const { config, items } = req.body;
    if (!config || !items) return res.status(400).json({ error: 'config and items are required' });
    const result = await beadsAdvanced.migrate(config, items);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/meow/migrate/history — Migration history */
router.get('/api/meow/migrate/history', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.getMigrationHistory());
});

// ─── EP-011: Hooks ──────────────────────────────────────────────────────────────

/** GET /api/meow/hooks — List all hooks or filter by event */
router.get('/api/meow/hooks', (req: Request, res: Response) => {
  const event = req.query.event as string | undefined;
  const hooks = beadsAdvanced.listHooks(event as any);
  // Strip fn from response (not serializable)
  res.json(hooks.map(h => ({ ...h, fn: undefined })));
});

/** POST /api/meow/hooks — Register a hook (for internal use — fn cannot be passed via REST) */
router.post('/api/meow/hooks', (_req: Request, res: Response) => {
  // Hooks with custom functions must be registered programmatically.
  // This endpoint is a placeholder for documentation / future webhook support.
  res.status(501).json({ error: 'Hooks must be registered programmatically. Use beadsAdvanced.registerHook() in code.' });
});

/** DELETE /api/meow/hooks/:id — Remove a hook */
router.delete('/api/meow/hooks/:id', (req: Request, res: Response) => {
  const ok = beadsAdvanced.removeHook(req.params.id);
  res.json({ removed: ok });
});

/** PATCH /api/meow/hooks/:id/toggle — Enable/disable a hook */
router.patch('/api/meow/hooks/:id/toggle', (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
  const ok = beadsAdvanced.toggleHook(req.params.id, enabled);
  res.json({ toggled: ok });
});

// ─── EP-012: Export ─────────────────────────────────────────────────────────────

/** POST /api/meow/export — Export beads as JSONL/CSV/Markdown */
router.post('/api/meow/export', async (req: Request, res: Response) => {
  try {
    const { format, filters, includeHistory, includeDeps } = req.body;
    if (!format) return res.status(400).json({ error: 'format is required (jsonl|csv|markdown)' });
    const output = await beadsAdvanced.exportBeads({ format, filters, includeHistory, includeDeps });

    // Set content type based on format
    const contentTypes: Record<string, string> = {
      jsonl: 'application/jsonl',
      csv: 'text/csv',
      markdown: 'text/markdown',
    };
    res.setHeader('Content-Type', contentTypes[format] || 'text/plain');
    res.send(output);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/meow/export/history — Export history */
router.get('/api/meow/export/history', (_req: Request, res: Response) => {
  res.json(beadsAdvanced.getExportHistory());
});

// ─── EP-013: Import ─────────────────────────────────────────────────────────────

/** POST /api/meow/import/json — Import items from JSON array */
router.post('/api/meow/import/json', async (req: Request, res: Response) => {
  try {
    const { items, source } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });
    const result = await beadsAdvanced.importFromJSON(items, source);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/meow/import/csv — Import items from CSV string */
router.post('/api/meow/import/csv', async (req: Request, res: Response) => {
  try {
    const { csv, source } = req.body;
    if (!csv) return res.status(400).json({ error: 'csv string is required' });
    const result = await beadsAdvanced.importFromCSV(csv, source);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── EP-020: Wisp System ────────────────────────────────────────────────────────

/** POST /api/meow/wisps — Create a wisp */
router.post('/api/meow/wisps', (req: Request, res: Response) => {
  try {
    const wisp = wispSystem.create(req.body);
    res.status(201).json(wisp);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/meow/wisps — List active wisps */
router.get('/api/meow/wisps', (req: Request, res: Response) => {
  const includeExpired = req.query.includeExpired === 'true';
  res.json(wispSystem.list(includeExpired));
});

/** GET /api/meow/wisps/stats — Wisp stats */
router.get('/api/meow/wisps/stats', (_req: Request, res: Response) => {
  res.json(wispSystem.getStats());
});

/** GET /api/meow/wisps/config — Wisp config */
router.get('/api/meow/wisps/config', (_req: Request, res: Response) => {
  res.json(wispSystem.getConfig());
});

/** PATCH /api/meow/wisps/config — Update wisp config */
router.patch('/api/meow/wisps/config', (req: Request, res: Response) => {
  wispSystem.setConfig(req.body);
  res.json(wispSystem.getConfig());
});

/** GET /api/meow/wisps/:id — Get a wisp */
router.get('/api/meow/wisps/:id', (req: Request, res: Response) => {
  const wisp = wispSystem.get(req.params.id);
  if (!wisp) return res.status(404).json({ error: 'Wisp not found' });
  res.json(wisp);
});

/** POST /api/meow/wisps/:id/steps/:stepId/complete — Complete a wisp step */
router.post('/api/meow/wisps/:id/steps/:stepId/complete', (req: Request, res: Response) => {
  try {
    const wisp = wispSystem.completeStep(req.params.id, req.params.stepId);
    res.json(wisp);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

/** POST /api/meow/wisps/:id/steps/:stepId/fail — Fail a wisp step */
router.post('/api/meow/wisps/:id/steps/:stepId/fail', (req: Request, res: Response) => {
  try {
    const wisp = wispSystem.failStep(req.params.id, req.params.stepId, req.body.error);
    res.json(wisp);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

/** POST /api/meow/wisps/:id/extend — Extend wisp TTL */
router.post('/api/meow/wisps/:id/extend', (req: Request, res: Response) => {
  try {
    const { additionalMs } = req.body;
    if (!additionalMs) return res.status(400).json({ error: 'additionalMs is required' });
    const wisp = wispSystem.extend(req.params.id, additionalMs);
    res.json(wisp);
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

/** POST /api/meow/wisps/:id/promote — Promote wisp to molecule */
router.post('/api/meow/wisps/:id/promote', (req: Request, res: Response) => {
  const result = wispSystem.promote(req.params.id);
  res.json(result);
});

/** DELETE /api/meow/wisps/:id — Manually expire a wisp */
router.delete('/api/meow/wisps/:id', (req: Request, res: Response) => {
  const ok = wispSystem.expire(req.params.id);
  res.json({ expired: ok });
});

/** POST /api/meow/wisps/batch — Create batch wisps */
router.post('/api/meow/wisps/batch', (req: Request, res: Response) => {
  try {
    const { wisps } = req.body;
    if (!wisps || !Array.isArray(wisps)) return res.status(400).json({ error: 'wisps array is required' });
    const created = wispSystem.createBatch(wisps);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/meow/wisps/reap — Trigger manual reap */
router.post('/api/meow/wisps/reap', (_req: Request, res: Response) => {
  const reaped = wispSystem.reap();
  res.json({ reaped });
});

/** POST /api/meow/wisps/reap-all — Reap all wisps */
router.post('/api/meow/wisps/reap-all', (_req: Request, res: Response) => {
  const reaped = wispSystem.reapAll();
  res.json({ reaped });
});

/** POST /api/meow/wisps/reaper/start — Start auto-reaper */
router.post('/api/meow/wisps/reaper/start', (_req: Request, res: Response) => {
  wispSystem.startReaper();
  res.json({ status: 'reaper started' });
});

/** POST /api/meow/wisps/reaper/stop — Stop auto-reaper */
router.post('/api/meow/wisps/reaper/stop', (_req: Request, res: Response) => {
  wispSystem.stopReaper();
  res.json({ status: 'reaper stopped' });
});

export default router;
