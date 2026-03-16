/**
 * GT COMMANDS — The Missing CLI Commands from Steve Yegge's Gas Town
 *
 * Implements the 4 core operational commands that define Gas Town's workflow:
 *   gt sling    — Assign work (bead) to an agent's hook
 *   gt nudge    — Real-time poke/message to an agent
 *   gt seance   — Talk to predecessor sessions (recover context from dead sessions)
 *   gt handoff  — Graceful session restart (transfer state between sessions)
 *   gt convoy   — Convoy management (list, create, status, close)
 *
 * "Physics over politeness. If there is work on your hook, YOU MUST RUN IT." — GUPP
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gt-commands');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SlingResult {
  id: string;
  beadId: string;
  agentAddress: string;  // e.g. "gastown/polecats/nux"
  hookCreated: boolean;
  nudgeSent: boolean;
  timestamp: Date;
}

export interface NudgeMessage {
  id: string;
  from: string;          // sender address
  to: string;            // recipient address
  type: 'poke' | 'priority_change' | 'deadline' | 'info' | 'abort';
  message: string;
  beadId?: string;       // optional bead reference
  urgency: 'low' | 'normal' | 'high' | 'critical';
  deliveredAt?: Date;
  readAt?: Date;
  timestamp: Date;
}

export interface SeanceSession {
  id: string;
  originalSessionId: string;
  originalAgent: string;
  deathReason: string;    // 'timeout' | 'crash' | 'oom' | 'manual' | 'unknown'
  lastWords: string;      // Last output before death
  contextSnapshot: string; // Recovered context
  beadsInProgress: string[];
  conversationSummary: string;
  resurrectedAt?: Date;
  resurrectedBy?: string;
  timestamp: Date;
}

export interface HandoffPayload {
  id: string;
  fromSession: string;
  toSession: string;
  agent: string;
  beadId?: string;
  contextTransferred: string;   // serialized state
  filesModified: string[];
  gitBranch?: string;
  gitLastCommit?: string;
  pendingWork: string;
  reason: 'graceful' | 'stale' | 'stuck' | 'upgrade' | 'rebalance';
  completedAt?: Date;
  timestamp: Date;
}

export interface ConvoyCommand {
  action: 'list' | 'create' | 'status' | 'close' | 'add-bead';
  convoyId?: string;
  title?: string;
  beadIds?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// GT SLING — "Assign work to an agent's hook"
// ─────────────────────────────────────────────────────────────────────────────

export async function gtSling(
  beadId: string,
  agentAddress: string,
  operatorId?: string,
): Promise<SlingResult> {
  const id = uuidv4();
  const pool = getPool();

  log.info({ beadId, agentAddress }, 'gt sling: assigning bead to agent hook');

  // 1. Verify bead exists and is available
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT id, status, title FROM meow_beads WHERE id = $1`, [beadId],
      );
      if (rows.length === 0) throw new Error(`Bead ${beadId} not found`);
      if (rows[0].status === 'done' || rows[0].status === 'cancelled') {
        throw new Error(`Bead ${beadId} is already ${rows[0].status}`);
      }

      // 2. Create or update the hook
      await pool.query(
        `INSERT INTO meow_hooks (id, bead_id, agent_address, status, slung_by, created_at)
         VALUES ($1, $2, $3, 'active', $4, NOW())
         ON CONFLICT (bead_id) DO UPDATE SET agent_address = $3, status = 'active', slung_by = $4, updated_at = NOW()`,
        [id, beadId, agentAddress, operatorId ?? 'system'],
      );

      // 3. Update bead status to in_progress
      await pool.query(
        `UPDATE meow_beads SET status = 'in_progress', assigned_to = $1, updated_at = NOW() WHERE id = $2`,
        [agentAddress, beadId],
      );
    } catch (err) {
      log.warn({ err }, 'gt sling: DB operation failed, continuing in-memory');
    }
  }

  // 4. Send nudge to the agent (GUPP: physics over politeness)
  const nudge: NudgeMessage = {
    id: uuidv4(),
    from: operatorId ?? 'mayor',
    to: agentAddress,
    type: 'poke',
    message: `GUPP: Work slung to your hook — bead ${beadId}. YOU MUST RUN IT.`,
    beadId,
    urgency: 'high',
    timestamp: new Date(),
  };

  broadcast('meow:nudge', { ...nudge, event: 'sling' });
  broadcast('meow:activity', {
    type: 'sling',
    icon: '📋',
    category: 'work',
    actor: operatorId ?? 'mayor',
    summary: `Slung ${beadId} → ${agentAddress}`,
    timestamp: new Date().toISOString(),
  });

  log.info({ id, beadId, agentAddress }, 'gt sling: hook created, nudge sent');

  return {
    id,
    beadId,
    agentAddress,
    hookCreated: true,
    nudgeSent: true,
    timestamp: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GT NUDGE — "Real-time poke/message to an agent"
// ─────────────────────────────────────────────────────────────────────────────

export async function gtNudge(
  to: string,
  message: string,
  opts: {
    from?: string;
    type?: NudgeMessage['type'];
    urgency?: NudgeMessage['urgency'];
    beadId?: string;
  } = {},
): Promise<NudgeMessage> {
  const nudge: NudgeMessage = {
    id: uuidv4(),
    from: opts.from ?? 'overseer',
    to,
    type: opts.type ?? 'poke',
    message,
    beadId: opts.beadId,
    urgency: opts.urgency ?? 'normal',
    timestamp: new Date(),
  };

  const pool = getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO meow_nudges (id, sender, recipient, type, message, bead_id, urgency, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT DO NOTHING`,
        [nudge.id, nudge.from, nudge.to, nudge.type, nudge.message, nudge.beadId, nudge.urgency],
      );
    } catch (err) {
      log.warn({ err }, 'gt nudge: DB persistence failed');
    }
  }

  broadcast('meow:nudge', nudge);
  broadcast('meow:activity', {
    type: 'nudge',
    icon: '👉',
    category: 'comms',
    actor: nudge.from,
    summary: `Nudged ${to}: "${message.slice(0, 60)}"`,
    timestamp: new Date().toISOString(),
  });

  log.info({ to, type: nudge.type, urgency: nudge.urgency }, 'gt nudge: message delivered');
  return nudge;
}

// ─────────────────────────────────────────────────────────────────────────────
// GT SEANCE — "Talk to predecessor sessions via /resume"
// ─────────────────────────────────────────────────────────────────────────────

export async function gtSeance(
  sessionId: string,
  requestedBy?: string,
): Promise<SeanceSession> {
  const id = uuidv4();
  const pool = getPool();

  log.info({ sessionId, requestedBy }, 'gt seance: recovering context from dead session');

  let lastWords = '';
  let contextSnapshot = '';
  let beadsInProgress: string[] = [];
  let conversationSummary = '';
  let deathReason = 'unknown';
  let originalAgent = '';

  if (pool) {
    try {
      // 1. Find the dead session's last known state
      const { rows: sessionRows } = await pool.query(
        `SELECT s.id, s.agent_name, s.status, s.death_reason, s.last_output, s.context_json,
                s.git_branch, s.last_commit_sha, s.created_at, s.died_at
         FROM meow_sessions s WHERE s.id = $1 OR s.session_name = $1
         ORDER BY s.created_at DESC LIMIT 1`,
        [sessionId],
      );

      if (sessionRows.length > 0) {
        const sess = sessionRows[0];
        originalAgent = sess.agent_name ?? '';
        deathReason = sess.death_reason ?? 'unknown';
        lastWords = sess.last_output ?? '';
        contextSnapshot = sess.context_json ?? '';
      }

      // 2. Find beads that were in progress when session died
      const { rows: beadRows } = await pool.query(
        `SELECT id FROM meow_beads
         WHERE assigned_to LIKE $1 AND status = 'in_progress'`,
        [`%${originalAgent}%`],
      );
      beadsInProgress = beadRows.map((r: { id: string }) => r.id);

      // 3. Recover conversation summary from handoff trail
      const { rows: handoffRows } = await pool.query(
        `SELECT context_transferred, pending_work FROM meow_handoffs
         WHERE from_session = $1 ORDER BY created_at DESC LIMIT 1`,
        [sessionId],
      );
      if (handoffRows.length > 0) {
        conversationSummary = handoffRows[0].context_transferred ?? '';
      }

      // 4. Record the seance event
      await pool.query(
        `INSERT INTO meow_seances (id, original_session_id, original_agent, death_reason,
         last_words, beads_in_progress, resurrected_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT DO NOTHING`,
        [id, sessionId, originalAgent, deathReason, lastWords,
         JSON.stringify(beadsInProgress), requestedBy ?? 'system'],
      );
    } catch (err) {
      log.warn({ err }, 'gt seance: DB recovery partial');
    }
  }

  const seance: SeanceSession = {
    id,
    originalSessionId: sessionId,
    originalAgent,
    deathReason,
    lastWords: lastWords.slice(0, 2000),
    contextSnapshot: contextSnapshot.slice(0, 5000),
    beadsInProgress,
    conversationSummary: conversationSummary.slice(0, 3000),
    resurrectedAt: new Date(),
    resurrectedBy: requestedBy,
    timestamp: new Date(),
  };

  broadcast('meow:activity', {
    type: 'seance',
    icon: '👻',
    category: 'agent',
    actor: requestedBy ?? 'system',
    summary: `Seance on ${sessionId}: recovered ${beadsInProgress.length} beads, agent=${originalAgent}`,
    timestamp: new Date().toISOString(),
  });

  log.info({ id, sessionId, beadsRecovered: beadsInProgress.length }, 'gt seance: context recovered');
  return seance;
}

// ─────────────────────────────────────────────────────────────────────────────
// GT HANDOFF — "Graceful session restart / state transfer"
// ─────────────────────────────────────────────────────────────────────────────

export async function gtHandoff(
  fromSession: string,
  toSession: string,
  agent: string,
  opts: {
    beadId?: string;
    reason?: HandoffPayload['reason'];
    contextTransferred?: string;
    filesModified?: string[];
    gitBranch?: string;
    gitLastCommit?: string;
    pendingWork?: string;
  } = {},
): Promise<HandoffPayload> {
  const id = uuidv4();
  const pool = getPool();

  log.info({ fromSession, toSession, agent }, 'gt handoff: transferring session state');

  const payload: HandoffPayload = {
    id,
    fromSession,
    toSession,
    agent,
    beadId: opts.beadId,
    contextTransferred: opts.contextTransferred ?? '',
    filesModified: opts.filesModified ?? [],
    gitBranch: opts.gitBranch,
    gitLastCommit: opts.gitLastCommit,
    pendingWork: opts.pendingWork ?? '',
    reason: opts.reason ?? 'graceful',
    timestamp: new Date(),
  };

  if (pool) {
    try {
      // 1. Record the handoff
      await pool.query(
        `INSERT INTO meow_handoffs (id, from_session, to_session, agent, bead_id,
         context_transferred, files_modified, git_branch, git_last_commit,
         pending_work, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT DO NOTHING`,
        [id, fromSession, toSession, agent, opts.beadId,
         payload.contextTransferred, JSON.stringify(payload.filesModified),
         opts.gitBranch, opts.gitLastCommit, payload.pendingWork, payload.reason],
      );

      // 2. Update session records
      await pool.query(
        `UPDATE meow_sessions SET status = 'handed_off', handed_off_to = $1, updated_at = NOW()
         WHERE id = $2 OR session_name = $2`,
        [toSession, fromSession],
      );

      // 3. Transfer hook if bead exists
      if (opts.beadId) {
        await pool.query(
          `UPDATE meow_hooks SET session_id = $1, updated_at = NOW()
           WHERE bead_id = $2`,
          [toSession, opts.beadId],
        );
      }
    } catch (err) {
      log.warn({ err }, 'gt handoff: DB persistence partial');
    }
  }

  broadcast('meow:activity', {
    type: 'handoff',
    icon: '🤝',
    category: 'agent',
    actor: agent,
    summary: `Handoff: ${fromSession} → ${toSession} (${payload.reason})`,
    timestamp: new Date().toISOString(),
  });

  log.info({ id, fromSession, toSession, reason: payload.reason }, 'gt handoff: state transferred');
  payload.completedAt = new Date();
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// GT CONVOY — "Convoy management commands"
// ─────────────────────────────────────────────────────────────────────────────

export async function gtConvoy(cmd: ConvoyCommand): Promise<string> {
  const pool = getPool();

  switch (cmd.action) {
    case 'list': {
      if (!pool) return 'No convoys (DB unavailable)';
      try {
        const { rows } = await pool.query(
          `SELECT id, title, status, progress_done, progress_total,
                  created_at FROM meow_convoys ORDER BY created_at DESC LIMIT 20`,
        );
        if (rows.length === 0) return 'No active convoys.';
        return rows.map((c: Record<string, unknown>) =>
          `${c.status === 'delivered' ? '✓' : c.status === 'in_progress' ? '>' : '~'} ${c.id} — ${c.title} [${c.progress_done}/${c.progress_total}]`
        ).join('\n');
      } catch { return 'Error fetching convoys.'; }
    }

    case 'create': {
      if (!cmd.title) return 'Usage: convoy create "<title>"';
      const convoyId = `gt-c-${uuidv4().slice(0, 6)}`;
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO meow_convoys (id, title, status, progress_done, progress_total, created_at)
             VALUES ($1, $2, 'assembling', 0, 0, NOW()) ON CONFLICT DO NOTHING`,
            [convoyId, cmd.title],
          );
        } catch (err) { log.warn({ err }, 'convoy create DB fail'); }
      }
      broadcast('meow:activity', {
        type: 'convoy_created', icon: '🚚', category: 'work',
        actor: 'overseer', summary: `Convoy created: ${convoyId} "${cmd.title}"`,
        timestamp: new Date().toISOString(),
      });
      return `Convoy ${convoyId} created: "${cmd.title}"`;
    }

    case 'status': {
      if (!cmd.convoyId) return 'Usage: convoy status <convoy-id>';
      if (!pool) return 'DB unavailable';
      try {
        const { rows } = await pool.query(
          `SELECT c.*, array_agg(b.id) as bead_ids FROM meow_convoys c
           LEFT JOIN meow_beads b ON b.convoy_id = c.id
           WHERE c.id = $1 GROUP BY c.id`,
          [cmd.convoyId],
        );
        if (rows.length === 0) return `Convoy ${cmd.convoyId} not found.`;
        const c = rows[0];
        return [
          `=== CONVOY: ${c.id} ===`,
          `Title    : ${c.title}`,
          `Status   : ${c.status}`,
          `Progress : ${c.progress_done}/${c.progress_total}`,
          `Beads    : ${(c.bead_ids ?? []).filter(Boolean).join(', ') || 'none'}`,
          `Created  : ${c.created_at}`,
        ].join('\n');
      } catch { return 'Error fetching convoy status.'; }
    }

    case 'close': {
      if (!cmd.convoyId) return 'Usage: convoy close <convoy-id>';
      if (pool) {
        try {
          await pool.query(
            `UPDATE meow_convoys SET status = 'delivered', updated_at = NOW() WHERE id = $1`,
            [cmd.convoyId],
          );
        } catch (err) { log.warn({ err }, 'convoy close DB fail'); }
      }
      broadcast('meow:activity', {
        type: 'convoy_closed', icon: '✅', category: 'work',
        actor: 'overseer', summary: `Convoy ${cmd.convoyId} delivered`,
        timestamp: new Date().toISOString(),
      });
      return `Convoy ${cmd.convoyId} closed.`;
    }

    case 'add-bead': {
      if (!cmd.convoyId || !cmd.beadIds?.length) return 'Usage: convoy add-bead <convoy-id> <bead-ids...>';
      if (pool) {
        try {
          for (const beadId of cmd.beadIds) {
            await pool.query(
              `UPDATE meow_beads SET convoy_id = $1, updated_at = NOW() WHERE id = $2`,
              [cmd.convoyId, beadId],
            );
          }
          await pool.query(
            `UPDATE meow_convoys SET progress_total = progress_total + $1, updated_at = NOW() WHERE id = $2`,
            [cmd.beadIds.length, cmd.convoyId],
          );
        } catch (err) { log.warn({ err }, 'convoy add-bead DB fail'); }
      }
      return `Added ${cmd.beadIds.length} bead(s) to convoy ${cmd.convoyId}.`;
    }

    default:
      return `Unknown convoy action: ${cmd.action}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports for CLI integration
// ─────────────────────────────────────────────────────────────────────────────

export const GT_COMMANDS = {
  sling: gtSling,
  nudge: gtNudge,
  seance: gtSeance,
  handoff: gtHandoff,
  convoy: gtConvoy,
} as const;
