/**
 * MAESTRO — Session Tracker
 *
 * Session management and cost tracking for agent dispatches.
 * Every time an agent CLI is invoked, a MaestroSession is created to track
 * token usage, cost, duration, and output. Supports stream-json and JSONL
 * output parsing for real-time cost accumulation.
 *
 * Gas Town: "Every drop of guzzoline is metered."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('maestro:session');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MaestroSession {
  id: string;
  agentId: string;
  agentSessionId?: string;
  beadId?: string;
  playbookRunId?: string;
  worktreePath?: string;
  status: SessionStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
}

export type SessionStatus = 'active' | 'completed' | 'failed' | 'crashed';

export interface SessionFilters {
  agentId?: string;
  beadId?: string;
  playbookRunId?: string;
  status?: SessionStatus;
  since?: Date;
  limit?: number;
  offset?: number;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  failedSessions: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgDurationMs: number;
  costByAgent: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing reference (USD per 1M tokens, approximate)
// ─────────────────────────────────────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-code': { input: 3.0, output: 15.0 },
  codex: { input: 2.5, output: 10.0 },
  'gemini-cli': { input: 0.075, output: 0.3 },
  opencode: { input: 3.0, output: 15.0 },
  aider: { input: 3.0, output: 15.0 },
  'factory-droid': { input: 3.0, output: 15.0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// ─────────────────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, MaestroSession>();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sessionId(): string {
  return `ms-${uuidv4().slice(0, 8)}`;
}

function estimateCost(agentId: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[agentId] ?? PRICING['claude-code'];
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB Persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistSession(session: MaestroSession): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO meow_maestro_sessions
       (id, agent_id, agent_session_id, bead_id, playbook_run_id, worktree_path,
        status, tokens_in, tokens_out, cost_usd, started_at, completed_at, output, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET
       agent_session_id = EXCLUDED.agent_session_id,
       status = EXCLUDED.status,
       tokens_in = EXCLUDED.tokens_in,
       tokens_out = EXCLUDED.tokens_out,
       cost_usd = EXCLUDED.cost_usd,
       completed_at = EXCLUDED.completed_at,
       output = EXCLUDED.output,
       error = EXCLUDED.error`,
    [
      session.id,
      session.agentId,
      session.agentSessionId ?? null,
      session.beadId ?? null,
      session.playbookRunId ?? null,
      session.worktreePath ?? null,
      session.status,
      session.tokensIn,
      session.tokensOut,
      session.costUsd,
      session.startedAt,
      session.completedAt ?? null,
      session.output ?? null,
      session.error ?? null,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — Session Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new session record. Called when an agent CLI is spawned.
 */
export async function createSession(
  agentId: string,
  beadId?: string,
  playbookRunId?: string,
  worktreePath?: string,
): Promise<MaestroSession> {
  const session: MaestroSession = {
    id: sessionId(),
    agentId,
    beadId,
    playbookRunId,
    worktreePath,
    status: 'active',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    startedAt: new Date(),
  };

  activeSessions.set(session.id, session);
  await persistSession(session);

  broadcast('maestro:session', {
    action: 'created',
    sessionId: session.id,
    agentId,
  });

  log.info({ sessionId: session.id, agentId }, 'Session created');
  return session;
}

/**
 * Update token usage and cost for an active session.
 * Accumulates — call this multiple times as streaming output arrives.
 */
export async function updateUsage(
  id: string,
  tokensIn: number,
  tokensOut: number,
  costUsd?: number,
): Promise<void> {
  const session = activeSessions.get(id);
  if (!session) {
    log.warn({ sessionId: id }, 'updateUsage called for unknown session');
    return;
  }

  session.tokensIn += tokensIn;
  session.tokensOut += tokensOut;

  // Use provided cost or estimate from pricing table
  if (costUsd !== undefined && costUsd > 0) {
    session.costUsd += costUsd;
  } else {
    session.costUsd = estimateCost(session.agentId, session.tokensIn, session.tokensOut);
  }

  await persistSession(session);

  broadcast('maestro:session', {
    action: 'usage',
    sessionId: id,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    costUsd: session.costUsd,
  });
}

/**
 * Set the agent's own session ID (e.g. Claude's session_id from stream-json).
 */
export async function setAgentSessionId(id: string, agentSessionId: string): Promise<void> {
  const session = activeSessions.get(id);
  if (!session) return;

  session.agentSessionId = agentSessionId;
  await persistSession(session);
}

/**
 * Mark a session as completed with output.
 */
export async function completeSession(id: string, output?: string): Promise<void> {
  const session = activeSessions.get(id);
  if (!session) {
    log.warn({ sessionId: id }, 'completeSession called for unknown session');
    return;
  }

  session.status = 'completed';
  session.completedAt = new Date();
  session.output = output?.slice(0, 50000); // Cap stored output at 50KB

  await persistSession(session);
  activeSessions.delete(id);

  const durationMs = session.completedAt.getTime() - session.startedAt.getTime();

  broadcast('maestro:session', {
    action: 'completed',
    sessionId: id,
    agentId: session.agentId,
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    costUsd: session.costUsd,
    durationMs,
  });

  log.info(
    { sessionId: id, agentId: session.agentId, durationMs, costUsd: session.costUsd },
    'Session completed',
  );
}

/**
 * Mark a session as failed with error message.
 */
export async function failSession(id: string, error: string): Promise<void> {
  const session = activeSessions.get(id);
  if (!session) {
    log.warn({ sessionId: id }, 'failSession called for unknown session');
    return;
  }

  session.status = 'failed';
  session.completedAt = new Date();
  session.error = error.slice(0, 10000);

  await persistSession(session);
  activeSessions.delete(id);

  broadcast('maestro:session', {
    action: 'failed',
    sessionId: id,
    agentId: session.agentId,
    error: session.error,
  });

  log.error({ sessionId: id, agentId: session.agentId, error }, 'Session failed');
}

/**
 * Mark a session as crashed (unexpected termination, no error message).
 */
export async function crashSession(id: string): Promise<void> {
  const session = activeSessions.get(id);
  if (!session) return;

  session.status = 'crashed';
  session.completedAt = new Date();
  session.error = 'Agent process terminated unexpectedly';

  await persistSession(session);
  activeSessions.delete(id);

  broadcast('maestro:session', { action: 'crashed', sessionId: id });
  log.error({ sessionId: id }, 'Session crashed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — Queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a session by ID. Checks in-memory first, then DB.
 */
export async function getSession(id: string): Promise<MaestroSession | null> {
  const cached = activeSessions.get(id);
  if (cached) return cached;

  const pool = getPool();
  if (!pool) return null;

  const { rows } = await pool.query(
    `SELECT id, agent_id, agent_session_id, bead_id, playbook_run_id, worktree_path,
       status, tokens_in, tokens_out, cost_usd, started_at, completed_at, output, error
     FROM meow_maestro_sessions WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    id: r.id,
    agentId: r.agent_id,
    agentSessionId: r.agent_session_id || undefined,
    beadId: r.bead_id || undefined,
    playbookRunId: r.playbook_run_id || undefined,
    worktreePath: r.worktree_path || undefined,
    status: r.status,
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    costUsd: Number(r.cost_usd),
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : undefined,
    output: r.output || undefined,
    error: r.error || undefined,
  };
}

/**
 * List sessions with optional filters.
 */
export async function listSessions(filters?: SessionFilters): Promise<MaestroSession[]> {
  const pool = getPool();
  if (!pool) {
    // Return only in-memory sessions
    let sessions = Array.from(activeSessions.values());
    if (filters?.agentId) sessions = sessions.filter((s) => s.agentId === filters.agentId);
    if (filters?.status) sessions = sessions.filter((s) => s.status === filters.status);
    return sessions;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.agentId) {
    conditions.push(`agent_id = $${paramIdx++}`);
    params.push(filters.agentId);
  }
  if (filters?.beadId) {
    conditions.push(`bead_id = $${paramIdx++}`);
    params.push(filters.beadId);
  }
  if (filters?.playbookRunId) {
    conditions.push(`playbook_run_id = $${paramIdx++}`);
    params.push(filters.playbookRunId);
  }
  if (filters?.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters?.since) {
    conditions.push(`started_at >= $${paramIdx++}`);
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  const { rows } = await pool.query(
    `SELECT id, agent_id, agent_session_id, bead_id, playbook_run_id, worktree_path,
       status, tokens_in, tokens_out, cost_usd, started_at, completed_at, output, error
     FROM meow_maestro_sessions
     ${where}
     ORDER BY started_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    agentSessionId: (r.agent_session_id as string) || undefined,
    beadId: (r.bead_id as string) || undefined,
    playbookRunId: (r.playbook_run_id as string) || undefined,
    worktreePath: (r.worktree_path as string) || undefined,
    status: r.status as SessionStatus,
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    costUsd: Number(r.cost_usd),
    startedAt: new Date(r.started_at as string),
    completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
    output: (r.output as string) || undefined,
    error: (r.error as string) || undefined,
  }));
}

/**
 * Get aggregate session statistics.
 */
export async function getSessionStats(since?: Date): Promise<SessionStats> {
  const pool = getPool();

  if (!pool) {
    // In-memory only stats
    const sessions = Array.from(activeSessions.values());
    return computeStatsFromSessions(sessions);
  }

  const sinceClause = since ? `WHERE started_at >= $1` : '';
  const params = since ? [since] : [];

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'active') as active,
       COUNT(*) FILTER (WHERE status = 'completed') as completed,
       COUNT(*) FILTER (WHERE status = 'failed') as failed,
       COALESCE(SUM(tokens_in), 0) as total_tokens_in,
       COALESCE(SUM(tokens_out), 0) as total_tokens_out,
       COALESCE(SUM(cost_usd), 0) as total_cost,
       COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
         FILTER (WHERE completed_at IS NOT NULL), 0) as avg_duration_ms
     FROM meow_maestro_sessions ${sinceClause}`,
    params,
  );

  // Cost by agent
  const { rows: agentRows } = await pool.query(
    `SELECT agent_id, COALESCE(SUM(cost_usd), 0) as cost
     FROM meow_maestro_sessions ${sinceClause}
     GROUP BY agent_id`,
    params,
  );

  const costByAgent: Record<string, number> = {};
  for (const r of agentRows) {
    costByAgent[r.agent_id] = Number(r.cost);
  }

  const r = rows[0];
  return {
    totalSessions: Number(r.total),
    activeSessions: Number(r.active),
    completedSessions: Number(r.completed),
    failedSessions: Number(r.failed),
    totalTokensIn: Number(r.total_tokens_in),
    totalTokensOut: Number(r.total_tokens_out),
    totalCostUsd: Number(r.total_cost),
    avgDurationMs: Math.round(Number(r.avg_duration_ms)),
    costByAgent,
  };
}

/**
 * Get total cost since a given date.
 */
export async function getTotalCost(since?: Date): Promise<number> {
  const pool = getPool();
  if (!pool) {
    const sessions = Array.from(activeSessions.values());
    return sessions.reduce((sum, s) => sum + s.costUsd, 0);
  }

  const sinceClause = since ? `WHERE started_at >= $1` : '';
  const params = since ? [since] : [];

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM meow_maestro_sessions ${sinceClause}`,
    params,
  );

  return Number(rows[0].total);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Output Parsers
// ─────────────────────────────────────────────────────────────────────────────

interface StreamJsonEvent {
  type: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_usd?: number;
  result?: string;
  subtype?: string;
}

/**
 * Parse a single line from Claude's `--output-format stream-json` output.
 * Returns parsed event or null if not parseable.
 */
export function parseStreamJson(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as StreamJsonEvent;
    return parsed;
  } catch {
    return null;
  }
}

interface JsonlEvent {
  type?: string;
  message?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  error?: string;
  output?: string;
}

/**
 * Parse a single line from Codex's JSONL output format.
 * Returns parsed event or null if not parseable.
 */
export function parseJsonl(line: string): JsonlEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as JsonlEvent;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extract usage data from a parsed stream-json event.
 * Returns { tokensIn, tokensOut, costUsd } deltas.
 */
export function extractUsageFromStreamJson(
  event: StreamJsonEvent,
): { tokensIn: number; tokensOut: number; costUsd: number } | null {
  if (event.type === 'usage' && event.usage) {
    return {
      tokensIn: (event.usage.input_tokens ?? 0) +
        (event.usage.cache_creation_input_tokens ?? 0) +
        (event.usage.cache_read_input_tokens ?? 0),
      tokensOut: event.usage.output_tokens ?? 0,
      costUsd: event.cost_usd ?? 0,
    };
  }
  return null;
}

/**
 * Extract usage data from a parsed JSONL event.
 */
export function extractUsageFromJsonl(
  event: JsonlEvent,
): { tokensIn: number; tokensOut: number; costUsd: number } | null {
  if (event.tokens_in !== undefined || event.tokens_out !== undefined) {
    return {
      tokensIn: event.tokens_in ?? 0,
      tokensOut: event.tokens_out ?? 0,
      costUsd: event.cost ?? 0,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeStatsFromSessions(sessions: MaestroSession[]): SessionStats {
  const costByAgent: Record<string, number> = {};
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let completedCount = 0;

  for (const s of sessions) {
    totalTokensIn += s.tokensIn;
    totalTokensOut += s.tokensOut;
    totalCostUsd += s.costUsd;
    costByAgent[s.agentId] = (costByAgent[s.agentId] ?? 0) + s.costUsd;

    if (s.completedAt) {
      totalDurationMs += s.completedAt.getTime() - s.startedAt.getTime();
      completedCount++;
    }
  }

  return {
    totalSessions: sessions.length,
    activeSessions: sessions.filter((s) => s.status === 'active').length,
    completedSessions: sessions.filter((s) => s.status === 'completed').length,
    failedSessions: sessions.filter((s) => s.status === 'failed').length,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    avgDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : 0,
    costByAgent,
  };
}
