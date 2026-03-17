/**
 * MAESTRO — Routes
 *
 * Express router for the Maestro orchestration protocol.
 * All routes prefixed with /api/maestro/
 *
 * Gas Town: "The war rig needs a dispatcher."
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';
import {
  detectInstalledAgents,
  getAgentDefinition,
  listAgents,
  listInstalledAgents,
  ensureDetected,
  getDetectedAgent,
  buildAgentArgs,
} from './agent-registry';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  cleanupOrphaned,
  getWorktree,
} from './worktree-manager';
import {
  createPlaybook,
  listPlaybooks,
  getPlaybook,
  deletePlaybook,
  runPlaybook,
  pausePlaybook,
  resumePlaybook,
  getPlaybookRun,
  getPlaybookRunFromDb,
  generatePlaybookFromBeads,
} from './playbook-engine';
import {
  listSessions,
  getSession,
  getSessionStats,
  createSession,
  updateUsage,
  completeSession,
  failSession,
} from './session-tracker';

const log = createLogger('maestro:routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — GET is public, mutations require GASTOWN_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();
  const key =
    req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== process.env.GASTOWN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireApiKey);

// ─────────────────────────────────────────────────────────────────────────────
// Wrap async route handlers to catch errors
// ─────────────────────────────────────────────────────────────────────────────

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// AGENT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/maestro/agents — List all detected agents with install status
 */
router.get(
  '/api/maestro/agents',
  wrap(async (_req, res) => {
    await ensureDetected();
    const definitions = listAgents();
    const result = definitions.map((def) => {
      const detected = getDetectedAgent(def.id);
      return {
        ...def,
        // Strip function fields for JSON serialization
        resumeArgs: undefined,
        modelArgs: undefined,
        installed: detected?.installed ?? false,
        binaryPath: detected?.binaryPath,
        version: detected?.version,
      };
    });
    res.json({ agents: result });
  }),
);

/**
 * GET /api/maestro/agents/:id — Get a specific agent definition
 */
router.get(
  '/api/maestro/agents/:id',
  wrap(async (req, res) => {
    const def = getAgentDefinition(req.params.id);
    if (!def) {
      res.status(404).json({ error: `Agent not found: ${req.params.id}` });
      return;
    }
    const detected = getDetectedAgent(def.id);
    res.json({
      ...def,
      resumeArgs: undefined,
      modelArgs: undefined,
      installed: detected?.installed ?? false,
      binaryPath: detected?.binaryPath,
      version: detected?.version,
    });
  }),
);

/**
 * POST /api/maestro/agents/detect — Force re-detection of installed agents
 */
router.post(
  '/api/maestro/agents/detect',
  wrap(async (_req, res) => {
    const results = await detectInstalledAgents();
    const installed = results.filter((r) => r.installed);
    res.json({
      detected: installed.length,
      total: results.length,
      agents: installed.map((r) => ({
        id: r.definition.id,
        displayName: r.definition.displayName,
        binaryPath: r.binaryPath,
        version: r.version,
      })),
    });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// WORKTREE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/maestro/worktrees — List all worktrees
 */
router.get(
  '/api/maestro/worktrees',
  wrap(async (_req, res) => {
    const worktrees = await listWorktrees();
    res.json({ worktrees });
  }),
);

/**
 * POST /api/maestro/worktrees — Create a new worktree
 * Body: { basePath?, branchSuffix?, beadId?, agentId? }
 */
router.post(
  '/api/maestro/worktrees',
  wrap(async (req, res) => {
    const { basePath, branchSuffix, beadId, agentId } = req.body as {
      basePath?: string;
      branchSuffix?: string;
      beadId?: string;
      agentId?: string;
    };

    const cwd = basePath ?? process.cwd();
    const wt = await createWorktree(cwd, branchSuffix, beadId, agentId);
    res.status(201).json({ worktree: wt });
  }),
);

/**
 * DELETE /api/maestro/worktrees/:id — Remove a worktree
 */
router.delete(
  '/api/maestro/worktrees/:id',
  wrap(async (req, res) => {
    await removeWorktree(req.params.id);
    res.json({ removed: true, id: req.params.id });
  }),
);

/**
 * POST /api/maestro/worktrees/cleanup — Cleanup orphaned worktrees
 */
router.post(
  '/api/maestro/worktrees/cleanup',
  wrap(async (_req, res) => {
    const result = await cleanupOrphaned();
    res.json(result);
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// PLAYBOOK ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/maestro/playbooks — List all playbooks
 */
router.get(
  '/api/maestro/playbooks',
  wrap(async (_req, res) => {
    const playbooks = await listPlaybooks();
    // Return without full document content for list view
    const summary = playbooks.map((pb) => ({
      id: pb.id,
      name: pb.name,
      description: pb.description,
      documentCount: pb.documents.length,
      settings: pb.settings,
      createdAt: pb.createdAt,
      lastRunAt: pb.lastRunAt,
    }));
    res.json({ playbooks: summary });
  }),
);

/**
 * GET /api/maestro/playbooks/:id — Get full playbook with documents
 */
router.get(
  '/api/maestro/playbooks/:id',
  wrap(async (req, res) => {
    const pb = await getPlaybook(req.params.id);
    if (!pb) {
      res.status(404).json({ error: `Playbook not found: ${req.params.id}` });
      return;
    }
    res.json({ playbook: pb });
  }),
);

/**
 * POST /api/maestro/playbooks — Create a new playbook
 * Body: { name, description?, documents: [{ path, content, order }], settings }
 */
router.post(
  '/api/maestro/playbooks',
  wrap(async (req, res) => {
    const { name, description, documents, settings } = req.body as {
      name: string;
      description?: string;
      documents: { path: string; content: string; order: number }[];
      settings: {
        loop: boolean;
        resetOnCompletion: boolean;
        worktreeDispatch: boolean;
        agentId: string;
        promptTemplate?: string;
      };
    };

    if (!name || !documents || !settings) {
      res.status(400).json({ error: 'Missing required fields: name, documents, settings' });
      return;
    }

    if (!settings.agentId) {
      res.status(400).json({ error: 'settings.agentId is required' });
      return;
    }

    const pb = await createPlaybook(name, documents, settings, description);
    res.status(201).json({ playbook: { id: pb.id, name: pb.name } });
  }),
);

/**
 * DELETE /api/maestro/playbooks/:id — Delete a playbook
 */
router.delete(
  '/api/maestro/playbooks/:id',
  wrap(async (req, res) => {
    const pb = await getPlaybook(req.params.id);
    if (!pb) {
      res.status(404).json({ error: `Playbook not found: ${req.params.id}` });
      return;
    }
    await deletePlaybook(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  }),
);

/**
 * POST /api/maestro/playbooks/:id/run — Execute a playbook
 * Body: { cwd?, loop? }
 */
router.post(
  '/api/maestro/playbooks/:id/run',
  wrap(async (req, res) => {
    const { cwd, loop } = req.body as { cwd?: string; loop?: boolean };

    try {
      const run = await runPlaybook(req.params.id, { cwd, loop });
      res.status(202).json({
        run: {
          id: run.id,
          playbookId: run.playbookId,
          status: run.status,
          totalTasks: run.totalTasks,
          startedAt: run.startedAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  }),
);

/**
 * POST /api/maestro/playbooks/:id/pause — Pause a running playbook
 */
router.post(
  '/api/maestro/playbooks/:id/pause',
  wrap(async (req, res) => {
    try {
      pausePlaybook(req.params.id);
      res.json({ paused: true, runId: req.params.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  }),
);

/**
 * POST /api/maestro/playbooks/:id/resume — Resume a paused playbook
 * Body: { cwd? }
 */
router.post(
  '/api/maestro/playbooks/:id/resume',
  wrap(async (req, res) => {
    const { cwd } = req.body as { cwd?: string };

    try {
      const run = await resumePlaybook(req.params.id, { cwd });
      res.json({
        resumed: true,
        run: {
          id: run.id,
          status: run.status,
          completedTasks: run.completedTasks,
          totalTasks: run.totalTasks,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  }),
);

/**
 * GET /api/maestro/playbooks/:id/status — Get run status for a playbook
 */
router.get(
  '/api/maestro/playbooks/:id/status',
  wrap(async (req, res) => {
    // Check in-memory first (active runs)
    let run = getPlaybookRun(req.params.id);

    // Fall back to DB for historical runs
    if (!run) {
      run = (await getPlaybookRunFromDb(req.params.id)) ?? undefined;
    }

    if (!run) {
      res.status(404).json({ error: `No run found for: ${req.params.id}` });
      return;
    }

    res.json({ run });
  }),
);

/**
 * POST /api/maestro/playbooks/from-beads — Generate a playbook from bead IDs
 * Body: { beadIds: string[], name: string, agentId: string }
 */
router.post(
  '/api/maestro/playbooks/from-beads',
  wrap(async (req, res) => {
    const { beadIds, name, agentId } = req.body as {
      beadIds: string[];
      name: string;
      agentId: string;
    };

    if (!beadIds?.length || !name || !agentId) {
      res.status(400).json({ error: 'Missing required fields: beadIds, name, agentId' });
      return;
    }

    try {
      const pb = await generatePlaybookFromBeads(beadIds, name, agentId);
      res.status(201).json({ playbook: { id: pb.id, name: pb.name } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// SESSION ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/maestro/sessions — List sessions with optional filters
 * Query: agentId?, status?, beadId?, since?, limit?, offset?
 */
router.get(
  '/api/maestro/sessions',
  wrap(async (req, res) => {
    const filters = {
      agentId: req.query.agentId as string | undefined,
      beadId: req.query.beadId as string | undefined,
      playbookRunId: req.query.playbookRunId as string | undefined,
      status: req.query.status as 'active' | 'completed' | 'failed' | 'crashed' | undefined,
      since: req.query.since ? new Date(req.query.since as string) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };

    const sessions = await listSessions(filters);
    res.json({ sessions, count: sessions.length });
  }),
);

/**
 * GET /api/maestro/sessions/stats — Aggregate cost/usage stats
 * Query: since?
 */
router.get(
  '/api/maestro/sessions/stats',
  wrap(async (req, res) => {
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const stats = await getSessionStats(since);
    res.json({ stats });
  }),
);

/**
 * GET /api/maestro/sessions/:id — Get a specific session
 */
router.get(
  '/api/maestro/sessions/:id',
  wrap(async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: `Session not found: ${req.params.id}` });
      return;
    }
    res.json({ session });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// DISPATCH ROUTE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/maestro/dispatch — Dispatch a single task to an agent
 * Body: { agentId, prompt, beadId?, worktree?, model?, yolo? }
 */
router.post(
  '/api/maestro/dispatch',
  wrap(async (req, res) => {
    const { agentId, prompt, beadId, worktree, model, yolo } = req.body as {
      agentId: string;
      prompt: string;
      beadId?: string;
      worktree?: boolean;
      model?: string;
      yolo?: boolean;
    };

    if (!agentId || !prompt) {
      res.status(400).json({ error: 'Missing required fields: agentId, prompt' });
      return;
    }

    await ensureDetected();
    const agent = getAgentDefinition(agentId);
    if (!agent) {
      res.status(404).json({ error: `Unknown agent: ${agentId}` });
      return;
    }

    const detected = getDetectedAgent(agentId);
    if (!detected?.installed) {
      res.status(400).json({ error: `Agent not installed: ${agentId}` });
      return;
    }

    // Optionally create a worktree for this dispatch
    let cwd = process.cwd();
    let worktreeRef: { id: string; path: string } | undefined;

    if (worktree) {
      try {
        const wt = await createWorktree(cwd, beadId ?? 'dispatch', beadId, agentId);
        cwd = wt.path;
        worktreeRef = { id: wt.id, path: wt.path };
      } catch (err) {
        log.warn({ err }, 'Failed to create worktree for dispatch — using main repo');
      }
    }

    // Create session
    const session = await createSession(agentId, beadId, undefined, worktreeRef?.path);

    // Build args
    const args = buildAgentArgs(agent, {
      prompt,
      model,
      yolo: yolo ?? true,
    });

    // Return immediately with session info — execution happens async
    res.status(202).json({
      session: {
        id: session.id,
        agentId,
        status: 'active',
        worktree: worktreeRef,
      },
      command: `${agent.binary} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
    });

    // Fire-and-forget: spawn agent in background
    const { spawn: spawnProcess } = await import('child_process');
    const proc = spawnProcess(agent.binary, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const chunks: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);

      // Parse usage from streaming output
      for (const line of text.split('\n').filter((l) => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.usage || parsed.type === 'usage') {
            const usage = parsed.usage ?? parsed;
            tokensIn += usage.input_tokens ?? usage.tokens_in ?? 0;
            tokensOut += usage.output_tokens ?? usage.tokens_out ?? 0;
            costUsd += usage.cost_usd ?? usage.cost ?? 0;
          }
          if (parsed.session_id) {
            // Capture agent's own session ID
            const { setAgentSessionId } = require('./session-tracker');
            setAgentSessionId(session.id, parsed.session_id);
          }
        } catch {
          // Not JSON
        }
      }

      broadcast('maestro:dispatch', {
        sessionId: session.id,
        chunk: text.slice(0, 2000),
      });
    });

    proc.on('close', async (code) => {
      const output = chunks.join('');
      await updateUsage(session.id, tokensIn, tokensOut, costUsd);

      if (code === 0) {
        await completeSession(session.id, output.slice(0, 10000));
      } else {
        await failSession(session.id, `Agent exited with code ${code}`);
      }

      log.info(
        { sessionId: session.id, agentId, code, tokensIn, tokensOut, costUsd },
        'Dispatch completed',
      );
    });

    proc.on('error', async (err) => {
      await failSession(session.id, err.message);
      log.error({ sessionId: session.id, err }, 'Dispatch error');
    });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────────────────────────────────────

router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ err }, 'Maestro route error');
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV !== 'production' ? err.message : undefined,
  });
});

export default router;
