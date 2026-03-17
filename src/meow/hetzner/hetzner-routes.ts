/**
 * HETZNER — API Routes
 *
 * Express router for remote worker management, command execution,
 * Claude Code dispatch, and workspace sync operations.
 *
 * All routes prefixed with /api/hetzner/ (mounted by index.ts).
 *
 * Gas Town: "Control the rigs from the tower."
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../../lib/logger';
import {
  registerWorker,
  removeWorker,
  listWorkers,
  getWorker,
  heartbeatWorker,
  heartbeatAll,
  getOnlineWorkers,
  getAvailableWorker,
  loadDefaultWorkers,
  getAggregateStats,
} from './remote-worker-registry';
import type { RegisterWorkerConfig, WorkerRole } from './remote-worker-registry';
import {
  executeRemote,
  dispatchClaude,
  dispatchBeadToRemote,
  getExecution,
  listExecutions,
  killExecution,
  getExecutionStats,
} from './remote-executor';
import {
  syncRepoToWorker,
  syncResultsFromWorker,
  setupWorkerWorkspace,
  getWorkerGitStatus,
  createWorkerBranch,
  pushWorkerBranch,
} from './remote-sync';

const log = createLogger('hetzner:routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch(err => {
      log.error({ err, path: req.path }, 'Route error');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/hetzner/workers — List all remote workers
 */
router.get('/workers', (_req: Request, res: Response) => {
  const workers = listWorkers();
  res.json({ workers, count: workers.length });
});

/**
 * GET /api/hetzner/workers/online — List online workers only
 */
router.get('/workers/online', (_req: Request, res: Response) => {
  const workers = getOnlineWorkers();
  res.json({ workers, count: workers.length });
});

/**
 * GET /api/hetzner/workers/available — Get next available worker
 */
router.get('/workers/available', (req: Request, res: Response) => {
  const role = req.query.role as WorkerRole | undefined;
  const worker = getAvailableWorker(role);
  if (!worker) {
    res.status(404).json({ error: 'No available workers' });
    return;
  }
  res.json({ worker });
});

/**
 * GET /api/hetzner/workers/:id — Get worker detail
 */
router.get('/workers/:id', (req: Request, res: Response) => {
  const worker = getWorker(req.params.id);
  if (!worker) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }
  res.json({ worker });
});

/**
 * POST /api/hetzner/workers — Register a new worker
 */
router.post('/workers', (req: Request, res: Response) => {
  const { hostname, host, port, user, role, capabilities } = req.body as RegisterWorkerConfig & { capabilities?: string[] };

  if (!hostname || !host || !port) {
    res.status(400).json({ error: 'hostname, host, and port are required' });
    return;
  }

  const worker = registerWorker({ hostname, host, port, user, role, capabilities });
  res.status(201).json({ worker });
});

/**
 * DELETE /api/hetzner/workers/:id — Remove a worker
 */
router.delete('/workers/:id', (req: Request, res: Response) => {
  const removed = removeWorker(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }
  res.json({ removed: true });
});

/**
 * POST /api/hetzner/workers/:id/heartbeat — Check one worker
 */
router.post('/workers/:id/heartbeat', asyncHandler(async (req: Request, res: Response) => {
  const worker = getWorker(req.params.id);
  if (!worker) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }

  const reachable = await heartbeatWorker(req.params.id);
  res.json({ workerId: req.params.id, reachable, status: worker.status, lastHeartbeat: worker.lastHeartbeat });
}));

/**
 * POST /api/hetzner/heartbeat-all — Check all workers
 */
router.post('/heartbeat-all', asyncHandler(async (_req: Request, res: Response) => {
  const result = await heartbeatAll();
  res.json(result);
}));

/**
 * POST /api/hetzner/load-defaults — Load FrankFlow team as workers
 */
router.post('/load-defaults', (_req: Request, res: Response) => {
  const workers = loadDefaultWorkers();
  res.json({ workers, count: workers.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution & Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/hetzner/execute — Execute raw command on a worker
 */
router.post('/execute', asyncHandler(async (req: Request, res: Response) => {
  const { workerId, command, timeout, cwd } = req.body as {
    workerId: string;
    command: string;
    timeout?: number;
    cwd?: string;
  };

  if (!workerId || !command) {
    res.status(400).json({ error: 'workerId and command are required' });
    return;
  }

  log.info({ workerId, command: command.slice(0, 80) }, 'Execute request');
  const execution = await executeRemote(workerId, command, { timeout, cwd });
  res.json({ execution });
}));

/**
 * POST /api/hetzner/dispatch — Dispatch Claude Code to a worker
 */
router.post('/dispatch', asyncHandler(async (req: Request, res: Response) => {
  const { workerId, beadId, prompt, model, yolo, cwd, timeout } = req.body as {
    workerId?: string;
    beadId?: string;
    prompt: string;
    model?: string;
    yolo?: boolean;
    cwd?: string;
    timeout?: number;
  };

  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  log.info({ workerId, beadId, promptLen: prompt.length }, 'Dispatch request');

  if (beadId) {
    // Full bead dispatch — auto-selects worker if not provided
    const result = await dispatchBeadToRemote(beadId, prompt, workerId, { model, yolo, cwd, timeout });
    res.json({ result });
  } else if (workerId) {
    // Direct Claude dispatch to specific worker
    const result = await dispatchClaude(workerId, prompt, { model, yolo, cwd, timeout });
    res.json({ result });
  } else {
    // Auto-select worker
    const available = getAvailableWorker();
    if (!available) {
      res.status(503).json({ error: 'No available workers' });
      return;
    }
    const result = await dispatchClaude(available.id, prompt, { model, yolo, cwd, timeout });
    res.json({ result });
  }
}));

/**
 * GET /api/hetzner/executions — List recent executions
 */
router.get('/executions', (req: Request, res: Response) => {
  const workerId = req.query.workerId as string | undefined;
  const limit = parseInt(req.query.limit as string || '50', 10);
  const execs = listExecutions(workerId, limit);
  res.json({ executions: execs, count: execs.length });
});

/**
 * GET /api/hetzner/executions/:id — Get execution detail
 */
router.get('/executions/:id', (req: Request, res: Response) => {
  const exec = getExecution(req.params.id);
  if (!exec) {
    res.status(404).json({ error: 'Execution not found' });
    return;
  }
  res.json({ execution: exec });
});

/**
 * POST /api/hetzner/executions/:id/kill — Kill a running execution
 */
router.post('/executions/:id/kill', (req: Request, res: Response) => {
  const killed = killExecution(req.params.id);
  if (!killed) {
    res.status(404).json({ error: 'No active process found for this execution' });
    return;
  }
  res.json({ killed: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sync & Git
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/hetzner/sync — Sync repo to a worker
 */
router.post('/sync', asyncHandler(async (req: Request, res: Response) => {
  const { workerId, repoUrl, branch } = req.body as {
    workerId: string;
    repoUrl: string;
    branch?: string;
  };

  if (!workerId || !repoUrl) {
    res.status(400).json({ error: 'workerId and repoUrl are required' });
    return;
  }

  log.info({ workerId, repoUrl, branch }, 'Sync request');
  const result = await syncRepoToWorker(workerId, repoUrl, branch);
  res.json({ result });
}));

/**
 * POST /api/hetzner/sync/download — Download results from worker
 */
router.post('/sync/download', asyncHandler(async (req: Request, res: Response) => {
  const { workerId, remotePath, localPath } = req.body as {
    workerId: string;
    remotePath: string;
    localPath: string;
  };

  if (!workerId || !remotePath || !localPath) {
    res.status(400).json({ error: 'workerId, remotePath, and localPath are required' });
    return;
  }

  const result = await syncResultsFromWorker(workerId, remotePath, localPath);
  res.json({ result });
}));

/**
 * POST /api/hetzner/setup — Full workspace setup on a worker
 */
router.post('/setup', asyncHandler(async (req: Request, res: Response) => {
  const { workerId, repoUrl, branch } = req.body as {
    workerId: string;
    repoUrl: string;
    branch?: string;
  };

  if (!workerId || !repoUrl) {
    res.status(400).json({ error: 'workerId and repoUrl are required' });
    return;
  }

  log.info({ workerId, repoUrl, branch }, 'Workspace setup request');
  const result = await setupWorkerWorkspace(workerId, repoUrl, branch);
  res.json({ result });
}));

/**
 * GET /api/hetzner/workers/:id/git-status — Get git status on remote
 */
router.get('/workers/:id/git-status', asyncHandler(async (req: Request, res: Response) => {
  const worker = getWorker(req.params.id);
  if (!worker) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }

  const repoName = req.query.repo as string | undefined;
  const status = await getWorkerGitStatus(req.params.id, repoName);
  res.json({ status });
}));

/**
 * POST /api/hetzner/workers/:id/branch — Create a branch on remote
 */
router.post('/workers/:id/branch', asyncHandler(async (req: Request, res: Response) => {
  const { branchName, repoName } = req.body as { branchName: string; repoName?: string };

  if (!branchName) {
    res.status(400).json({ error: 'branchName is required' });
    return;
  }

  const result = await createWorkerBranch(req.params.id, branchName, repoName);
  res.json({ result });
}));

/**
 * POST /api/hetzner/workers/:id/push — Push branch on remote
 */
router.post('/workers/:id/push', asyncHandler(async (req: Request, res: Response) => {
  const worker = getWorker(req.params.id);
  if (!worker) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }

  const repoName = req.body.repoName as string | undefined;
  const result = await pushWorkerBranch(req.params.id, repoName);
  res.json({ result });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/hetzner/stats — Aggregate stats
 */
router.get('/stats', (_req: Request, res: Response) => {
  const workerStats = getAggregateStats();
  const execStats = getExecutionStats();
  res.json({ workers: workerStats, executions: execStats });
});

export default router;
