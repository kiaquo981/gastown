/**
 * Gas Town Command Center Routes — Stage 03 REST API
 *
 * Aggregates data from ALL MEOW subsystems into unified endpoints
 * for the Gas Town frontend (isometric map, pulse widget, timeline, terminal).
 *
 * Prefix: /api/meow/town/
 *
 * Endpoints:
 *   GET /api/meow/town/pulse      — Real-time aggregated stats from all subsystems
 *   GET /api/meow/town/buildings   — Isometric map building data
 *   GET /api/meow/town/timeline    — Merged event timeline
 *   GET /api/meow/town/log         — Enriched townlog for terminal view
 */

import { Router, Request, Response } from 'express';
import { meowEngine } from './engine';
import { workerPool } from './worker-pool';
import { mailRouter } from './mail';
import { refinery } from './refinery';
import { observabilityEngine } from './observability';
import { wispSystem } from './wisp-system';
import { getBeadsService } from './beads-service';
import { skillCount, listSkills } from './skill-registry';
import { maestroBridge } from './bridges/maestro-bridge';
import { gupp } from './workers/gupp';
import { notifyBeadCompleted, notifyBeadFailed } from './autonomous-loop';

const router = Router();

// ── Auth middleware for mutating Maestro endpoints ───────────────────────────
function requireMaestroAuth(req: Request, res: Response, next: Function) {
  if (req.method === 'GET') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== process.env.GASTOWN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — set x-api-key header' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: safe async call — wraps a subsystem call in try/catch, returns
// the result or a fallback value on failure.
// ─────────────────────────────────────────────────────────────────────────────

async function safeAsync<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function safeSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/town/pulse — Aggregated real-time stats from all subsystems
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/town/pulse', async (_req: Request, res: Response) => {
  try {
    // Gather data from all subsystems in parallel, each wrapped in its own try/catch
    const [
      healthData,
      moleculeData,
      wispData,
      workerData,
      beadData,
      mailData,
      refineryData,
      skillsData,
      patrolData,
      budgetData,
      observabilityData,
    ] = await Promise.all([
      // Health
      safeAsync(() => {
        const h = observabilityEngine.getHealth();
        return { score: h.score, status: h.status as string };
      }, { score: -1, status: 'unknown' }),

      // Molecules
      safeAsync(async () => {
        const all = await meowEngine.listMolecules({ limit: 500 });
        const active = all.filter(m => m.status === 'running' || m.status === 'pending').length;
        const completed = all.filter(m => m.status === 'completed').length;
        const failed = all.filter(m => m.status === 'failed').length;
        return { active, completed, failed, total: all.length };
      }, { active: 0, completed: 0, failed: 0, total: 0 }),

      // Wisps
      safeAsync(() => {
        const stats = wispSystem.getStats();
        return { active: stats.active, expired: stats.expired, promoted: stats.promoted };
      }, { active: 0, expired: 0, promoted: 0 }),

      // Workers
      safeAsync(() => {
        const overview = workerPool.overview();
        return {
          alive: overview.byStatus.alive,
          stale: overview.byStatus.stale,
          dead: overview.byStatus.dead,
          total: overview.totalWorkers,
        };
      }, { alive: 0, stale: 0, dead: 0, total: 0 }),

      // Beads
      safeAsync(async () => {
        const beads = getBeadsService();
        const stats = await beads.stats();
        const byStatus = stats.by_status || {};
        return {
          total: stats.total,
          ready: (byStatus['ready'] || 0),
          inProgress: (byStatus['in_progress'] || 0),
          blocked: (byStatus['blocked'] || 0),
        };
      }, { total: 0, ready: 0, inProgress: 0, blocked: 0 }),

      // Mail
      safeAsync(() => {
        const stats = mailRouter.stats();
        const pending = stats.totalSent - stats.totalDelivered;
        return {
          pending: Math.max(0, pending),
          delivered: stats.totalDelivered,
          failed: 0, // MailRouter does not track failures separately
        };
      }, { pending: 0, delivered: 0, failed: 0 }),

      // Refinery
      safeAsync(() => {
        const queue = refinery.getQueue();
        const queued = queue.filter(i => i.status === 'queued' || i.status === 'testing').length;
        const merged = refinery.getMetrics().totalMerged;
        const conflicted = queue.filter(i => i.conflictFiles.length > 0).length;
        return { queued, merged, conflicted };
      }, { queued: 0, merged: 0, conflicted: 0 }),

      // Skills
      safeAsync(() => {
        return { registered: skillCount() };
      }, { registered: 0 }),

      // Patrols
      safeAsync(() => {
        const reports = observabilityEngine.getPatrolReports(undefined, 10);
        const lastReport = reports[0];
        const lastScore = lastReport
          ? Math.round(((lastReport.totalChecks - lastReport.failedCount) / Math.max(lastReport.totalChecks, 1)) * 100)
          : 100;
        const failedChecks = reports.reduce((s, r) => s + r.failedCount, 0);
        return { lastScore, failedChecks };
      }, { lastScore: 100, failedChecks: 0 }),

      // Budget
      safeAsync(() => {
        const summary = observabilityEngine.getCostSummary();
        return {
          totalCostUsd: Math.round(summary.totalCostUsd * 100) / 100,
          warnings: summary.warnings,
          paused: summary.paused,
        };
      }, { totalCostUsd: 0, warnings: 0, paused: 0 }),

      // Observability
      safeAsync(() => {
        const stats = observabilityEngine.stats();
        const errorTrends = observabilityEngine.getErrorTrends(true).length;
        const activeAlerts = stats.activeAlertRules;
        return {
          townlogEntries: stats.townlogEntries,
          errorTrends,
          activeAlerts,
        };
      }, { townlogEntries: 0, errorTrends: 0, activeAlerts: 0 }),
    ]);

    res.json({
      timestamp: new Date().toISOString(),
      health: healthData,
      molecules: moleculeData,
      wisps: wispData,
      workers: workerData,
      beads: beadData,
      mail: mailData,
      refinery: refineryData,
      skills: skillsData,
      patrols: patrolData,
      budget: budgetData,
      observability: observabilityData,
    });
  } catch (err) {
    console.error('[TOWN-ROUTES] Pulse endpoint error:', err);
    res.status(500).json({ error: 'Failed to aggregate town pulse' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/town/buildings — Isometric map building data
// ─────────────────────────────────────────────────────────────────────────────

interface Building {
  id: string;
  name: string;
  icon: string;
  status: 'healthy' | 'degraded' | 'down';
  viewId: string;
  stats: Record<string, unknown>;
}

function downBuilding(id: string, name: string, icon: string, viewId: string): Building {
  return { id, name, icon, status: 'down', viewId, stats: {} };
}

router.get('/api/meow/town/buildings', async (_req: Request, res: Response) => {
  try {
    const buildings: Building[] = [];

    // 1. Mayor's Hall — Orchestration center
    buildings.push(await safeAsync<Building>(async () => {
      const mols = await meowEngine.listMolecules({ status: 'running', limit: 100 });
      const totalMols = await meowEngine.listMolecules({ limit: 500 });
      return {
        id: 'mayors-hall',
        name: "Mayor's Hall",
        icon: '🏛️',
        status: mols.length > 0 ? 'healthy' : totalMols.length > 0 ? 'degraded' : 'healthy',
        viewId: 'molecules',
        stats: { activeMolecules: mols.length, totalMolecules: totalMols.length },
      };
    }, downBuilding('mayors-hall', "Mayor's Hall", '🏛️', 'molecules')));

    // 2. Bead Forge — Work tracking
    buildings.push(await safeAsync<Building>(async () => {
      const beads = getBeadsService();
      const stats = await beads.stats();
      const inProgress = stats.by_status['in_progress'] || 0;
      const blocked = stats.by_status['blocked'] || 0;
      return {
        id: 'bead-forge',
        name: 'Bead Forge',
        icon: '🔩',
        status: blocked > 5 ? 'degraded' : 'healthy',
        viewId: 'beads',
        stats: { total: stats.total, inProgress, blocked, velocity7d: stats.velocity.closed_last_7d },
      };
    }, downBuilding('bead-forge', 'Bead Forge', '🔩', 'beads')));

    // 3. Molecule Lab — Molecule lifecycle
    buildings.push(await safeAsync<Building>(async () => {
      const molStats = observabilityEngine.getMoleculeStats();
      return {
        id: 'molecule-lab',
        name: 'Molecule Lab',
        icon: '🧪',
        status: molStats.failed > molStats.completed ? 'degraded' : 'healthy',
        viewId: 'molecules',
        stats: { running: molStats.running, completed: molStats.completed, failed: molStats.failed },
      };
    }, downBuilding('molecule-lab', 'Molecule Lab', '🧪', 'molecules')));

    // 4. Mail Tower — Communication hub
    buildings.push(safeSync<Building>(() => {
      const stats = mailRouter.stats();
      const pending = Math.max(0, stats.totalSent - stats.totalDelivered);
      return {
        id: 'mail-tower',
        name: 'Mail Tower',
        icon: '📬',
        status: pending > 50 ? 'degraded' : 'healthy',
        viewId: 'mailbox',
        stats: { totalSent: stats.totalSent, delivered: stats.totalDelivered, pending, mailboxes: stats.mailboxCount },
      };
    }, downBuilding('mail-tower', 'Mail Tower', '📬', 'mailbox')));

    // 5. Refinery — Merge queue
    buildings.push(safeSync<Building>(() => {
      const dashboard = refinery.getDashboard();
      const blockedCount = dashboard.queue.filter(i => i.status === 'blocked').length;
      return {
        id: 'refinery',
        name: 'Refinery',
        icon: '🏭',
        status: blockedCount > 3 ? 'degraded' : 'healthy',
        viewId: 'refinery',
        stats: {
          queued: dashboard.queue.length,
          merged: dashboard.metrics.totalMerged,
          activePush: dashboard.activePush,
          blocked: blockedCount,
        },
      };
    }, downBuilding('refinery', 'Refinery', '🏭', 'refinery')));

    // 6. Patrol Barracks — Health monitoring
    buildings.push(safeSync<Building>(() => {
      const reports = observabilityEngine.getPatrolReports(undefined, 10);
      const failedCount = reports.filter(r => r.failedCount > 0).length;
      return {
        id: 'patrol-barracks',
        name: 'Patrol Barracks',
        icon: '🛡️',
        status: failedCount > 5 ? 'degraded' : 'healthy',
        viewId: 'patrols',
        stats: { recentReports: reports.length, recentFailed: failedCount },
      };
    }, downBuilding('patrol-barracks', 'Patrol Barracks', '🛡️', 'patrols')));

    // 7. Skill Workshop — Skills registry
    buildings.push(safeSync<Building>(() => {
      const count = skillCount();
      const allSkills = listSkills();
      const runtimes: Record<string, number> = {};
      for (const s of allSkills) {
        runtimes[s.runtime] = (runtimes[s.runtime] || 0) + 1;
      }
      return {
        id: 'skill-workshop',
        name: 'Skill Workshop',
        icon: '🔧',
        status: 'healthy',
        viewId: 'beads',
        stats: { registered: count, byRuntime: runtimes },
      };
    }, downBuilding('skill-workshop', 'Skill Workshop', '🔧', 'beads')));

    // 8. Observatory — Observability tower
    buildings.push(safeSync<Building>(() => {
      const stats = observabilityEngine.stats();
      const health = observabilityEngine.getHealth();
      return {
        id: 'observatory',
        name: 'Observatory',
        icon: '🔭',
        status: health.score < 50 ? 'degraded' : 'healthy',
        viewId: 'budget-tracker',
        stats: {
          healthScore: health.score,
          townlogEntries: stats.townlogEntries,
          errorTrends: stats.errorTrends,
          alertRules: stats.activeAlertRules,
        },
      };
    }, downBuilding('observatory', 'Observatory', '🔭', 'budget-tracker')));

    // 9. Convoy Depot — Convoy management
    buildings.push(await safeAsync<Building>(async () => {
      const convoys = await meowEngine.listConvoys({ limit: 100 });
      const active = convoys.filter(c => c.status !== 'delivered' && c.status !== 'failed').length;
      return {
        id: 'convoy-depot',
        name: 'Convoy Depot',
        icon: '🚛',
        status: 'healthy',
        viewId: 'molecules',
        stats: { total: convoys.length, active },
      };
    }, downBuilding('convoy-depot', 'Convoy Depot', '🚛', 'molecules')));

    // 10. Wisp Garden — Ephemeral wisps
    buildings.push(safeSync<Building>(() => {
      const stats = wispSystem.getStats();
      return {
        id: 'wisp-garden',
        name: 'Wisp Garden',
        icon: '🌿',
        status: stats.active > 150 ? 'degraded' : 'healthy',
        viewId: 'molecules',
        stats: { active: stats.active, expired: stats.expired, promoted: stats.promoted },
      };
    }, downBuilding('wisp-garden', 'Wisp Garden', '🌿', 'molecules')));

    res.json({ buildings, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[TOWN-ROUTES] Buildings endpoint error:', err);
    res.status(500).json({ error: 'Failed to gather buildings data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/town/timeline — Merged event timeline
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/town/timeline', async (req: Request, res: Response) => {
  try {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const sourceFilter = req.query.source as string | undefined;

    // Gather events from two sources: townlog entries + feed events
    const [townlogEntries, feedEvents] = await Promise.all([
      safeAsync(() => {
        return observabilityEngine.queryTownlog({
          since,
          limit: limit * 2, // fetch extra, we'll merge and trim
          source: sourceFilter,
        });
      }, []),

      safeAsync(() => {
        return meowEngine.getFeedEvents({
          limit: limit * 2,
        });
      }, []),
    ]);

    // Normalize both sources into a common timeline event shape
    interface TimelineEvent {
      id: string;
      source: string;
      type: string;
      message: string;
      severity: string;
      timestamp: Date;
      metadata?: Record<string, unknown>;
      origin: 'townlog' | 'feed';
    }

    const events: TimelineEvent[] = [];

    // Townlog entries
    for (const entry of townlogEntries) {
      if (sourceFilter && entry.source !== sourceFilter) continue;
      events.push({
        id: entry.id,
        source: entry.source,
        type: entry.category,
        message: entry.message,
        severity: entry.level,
        timestamp: entry.timestamp,
        metadata: {
          ...entry.metadata,
          beadId: entry.beadId,
          moleculeId: entry.moleculeId,
        },
        origin: 'townlog',
      });
    }

    // Feed events
    for (const event of feedEvents) {
      if (sourceFilter && event.source !== sourceFilter) continue;
      if (since && event.timestamp < since) continue;
      events.push({
        id: String(event.id),
        source: event.source,
        type: event.type,
        message: event.message,
        severity: event.severity,
        timestamp: event.timestamp,
        metadata: {
          ...event.metadata,
          beadId: event.beadId,
          moleculeId: event.moleculeId,
          convoyId: event.convoyId,
          rig: event.rig,
        },
        origin: 'feed',
      });
    }

    // Sort by timestamp descending (newest first), then deduplicate by id
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Deduplicate (townlog and feed may share some events)
    const seen = new Set<string>();
    const deduped: TimelineEvent[] = [];
    for (const ev of events) {
      const key = `${ev.origin}:${ev.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(ev);
      if (deduped.length >= limit) break;
    }

    res.json({
      events: deduped,
      count: deduped.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[TOWN-ROUTES] Timeline endpoint error:', err);
    res.status(500).json({ error: 'Failed to gather timeline data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/town/log — Enriched townlog for the terminal view
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/town/log', (req: Request, res: Response) => {
  try {
    const { level, category, source, since, limit } = req.query;

    const entries = observabilityEngine.queryTownlog({
      level: level as any,
      category: category as string,
      source: source as string,
      since: since ? new Date(since as string) : undefined,
      limit: limit ? parseInt(limit as string, 10) : 100,
    });

    // Enrich entries with worker names and molecule names
    const enriched = entries.map(entry => {
      const enrichment: Record<string, unknown> = {};

      // Try to resolve worker name from worker pool
      if (entry.source) {
        try {
          const worker = workerPool.getWorker(entry.source);
          if (worker) {
            enrichment.workerName = worker.name;
            enrichment.workerRole = worker.role;
            enrichment.workerTier = worker.tier;
          }
        } catch {
          // Worker not found — fine, source may not be a worker ID
        }
      }

      // Try to enrich molecule info from metadata
      if (entry.moleculeId) {
        enrichment.moleculeId = entry.moleculeId;
      }

      if (entry.beadId) {
        enrichment.beadId = entry.beadId;
      }

      return {
        ...entry,
        enrichment: Object.keys(enrichment).length > 0 ? enrichment : undefined,
      };
    });

    res.json({
      entries: enriched,
      count: enriched.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[TOWN-ROUTES] Log endpoint error:', err);
    res.status(500).json({ error: 'Failed to retrieve townlog' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Maestro Bridge — /api/meow/town/maestro/*
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/meow/town/maestro/register — Register a local Maestro instance */
router.post('/api/meow/town/maestro/register', requireMaestroAuth, (req: Request, res: Response) => {
  try {
    const { callbackUrl, name, capabilities, maxSessions, hostname, os, version, metadata } = req.body;
    if (!callbackUrl) {
      return res.status(400).json({ error: 'callbackUrl is required' });
    }
    const instance = maestroBridge.register({ callbackUrl, name, capabilities, maxSessions, hostname, os, version, metadata });
    res.json({ success: true, instance });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed', details: String(err) });
  }
});

/** POST /api/meow/town/maestro/heartbeat — Update heartbeat */
router.post('/api/meow/town/maestro/heartbeat', requireMaestroAuth, (req: Request, res: Response) => {
  const { instanceId, activeSessions, status, metadata } = req.body;
  if (!instanceId) {
    return res.status(400).json({ error: 'instanceId is required' });
  }
  const ok = maestroBridge.heartbeat(instanceId, { activeSessions, status, metadata });
  if (!ok) {
    return res.status(404).json({ error: `Maestro ${instanceId} not found — re-register` });
  }
  res.json({ success: true });
});

/** POST /api/meow/town/maestro/dispatch — Dispatch work to best available Maestro */
router.post('/api/meow/town/maestro/dispatch', requireMaestroAuth, async (req: Request, res: Response) => {
  try {
    const { beadId, skill, title, description, priority, branch, context, payload } = req.body;
    if (!beadId || !skill) {
      return res.status(400).json({ error: 'beadId and skill are required' });
    }
    const result = await maestroBridge.dispatch({ beadId, skill, title: title || skill, description, priority: priority || 'normal', branch, context, payload });
    if (!result) {
      return res.status(503).json({ error: 'No available Maestro instances' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Dispatch failed', details: String(err) });
  }
});

/** POST /api/meow/town/maestro/report — Receive execution report from Maestro */
router.post('/api/meow/town/maestro/report', requireMaestroAuth, async (req: Request, res: Response) => {
  try {
    const { dispatchId, maestroId, success, output, prUrl, branch, artifacts, durationMs, sessionCount, error } = req.body;
    if (!dispatchId || !maestroId) {
      return res.status(400).json({ error: 'dispatchId and maestroId are required' });
    }
    maestroBridge.report({ dispatchId, maestroId, success, output: output || '', prUrl, branch, artifacts, durationMs, sessionCount, error });

    // Close the matching GUPP hook and notify the autonomous loop
    const runningHooks = gupp.listHooks().filter(
      (h: { status: string; payload?: Record<string, unknown> }) =>
        h.status === 'running' && h.payload?.dispatchId === dispatchId
    );
    for (const hook of runningHooks) {
      try {
        if (success) {
          gupp.completeHook(hook.id);
          notifyBeadCompleted(hook.beadId);
          // Update bead to done
          const beadsService = getBeadsService();
          await beadsService.update(hook.beadId, {
            status: 'done' as const,
            ...(prUrl ? { prUrl } : {}),
          });
        } else {
          gupp.failHook(hook.id, error || 'Maestro execution failed');
          notifyBeadFailed(hook.beadId);
        }
      } catch { /* best effort — hook/bead update is non-critical for the response */ }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Report failed', details: String(err) });
  }
});

/** DELETE /api/meow/town/maestro/:id — Unregister a Maestro instance */
router.delete('/api/meow/town/maestro/:id', requireMaestroAuth, (req: Request, res: Response) => {
  const ok = maestroBridge.unregister(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Instance not found' });
  res.json({ success: true });
});

/** GET /api/meow/town/maestro/list — List all Maestro instances */
router.get('/api/meow/town/maestro/list', (_req: Request, res: Response) => {
  res.json({
    instances: maestroBridge.list(),
    stats: maestroBridge.stats(),
  });
});

/** GET /api/meow/town/maestro/stats — Bridge stats */
router.get('/api/meow/town/maestro/stats', (_req: Request, res: Response) => {
  res.json(maestroBridge.stats());
});

export default router;
