/**
 * LP-003 — Crew-Agent Bridge (Real Execution Engine)
 *
 * Bridge between MEOW Crew members and existing Gas Town agents.
 * Maps crew member IDs to Gas Town agent definitions from the agents store.
 * Maintains session context per crew member (persisted to Supabase).
 */

import { agents } from '../../stores';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { WorkerIdentity } from '../types';

const log = createLogger('crew-agent-bridge');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CrewAgentContext {
  crewId: string;
  agentId: string;
  agentName: string;
  systemPrompt: string;
  tools: string[];
  knowledge: string[];
  tier: 'S' | 'A' | 'B';
  model: string;
  /** Additional metadata from the Gas Town agent definition */
  metadata: Record<string, unknown>;
}

export interface CrewSession {
  crewId: string;
  agentId: string;
  conversationHistory: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
  workingMemory: Record<string, unknown>;
  beadsCompleted: string[];
  lastActiveAt: string;
  createdAt: string;
}

interface CrewMapping {
  crewId: string;
  agentId: string;
  agentName: string;
  tier: 'S' | 'A' | 'B';
  mappedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory stores
// ─────────────────────────────────────────────────────────────────────────────

/** Crew ID -> Agent mapping */
const crewMappings = new Map<string, CrewMapping>();

/** Crew ID -> Active session */
const crewSessions = new Map<string, CrewSession>();

// ─────────────────────────────────────────────────────────────────────────────
// Agent resolution helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract tier from an agent definition.
 * Gas Town agents have a `tier` field or we infer from model name.
 */
function resolveAgentTier(agentDef: Record<string, unknown>): 'S' | 'A' | 'B' {
  const tier = agentDef.tier as string | undefined;
  if (tier === 'S' || tier === 'A' || tier === 'B') return tier;

  const model = (agentDef.model as string || '').toLowerCase();
  if (model.includes('opus')) return 'S';
  if (model.includes('sonnet') || model.includes('flash')) return 'A';
  return 'B';
}

/**
 * Extract system prompt from an agent definition.
 * Gas Town agents can have `systemPrompt`, `prompt`, `instructions`, etc.
 */
function resolveSystemPrompt(agentDef: Record<string, unknown>): string {
  return (
    (agentDef.systemPrompt as string) ||
    (agentDef.prompt as string) ||
    (agentDef.instructions as string) ||
    (agentDef.system as string) ||
    `You are ${agentDef.name || 'an AI agent'}.`
  );
}

/**
 * Extract tools list from an agent definition.
 */
function resolveTools(agentDef: Record<string, unknown>): string[] {
  if (Array.isArray(agentDef.tools)) {
    return agentDef.tools.map((t: unknown) => {
      if (typeof t === 'string') return t;
      if (typeof t === 'object' && t !== null && 'name' in t) return (t as { name: string }).name;
      return String(t);
    });
  }
  return [];
}

/**
 * Extract knowledge/context from an agent definition.
 */
function resolveKnowledge(agentDef: Record<string, unknown>): string[] {
  if (Array.isArray(agentDef.knowledge)) return agentDef.knowledge as string[];
  if (Array.isArray(agentDef.context)) return agentDef.context as string[];
  if (typeof agentDef.knowledge === 'string') return [agentDef.knowledge as string];
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core bridge functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the Gas Town agent context for a crew member.
 * Looks up the crew member's linked agentDefId and loads the full agent definition.
 */
export function getCrewAgentContext(crewId: string): CrewAgentContext | null {
  // Check if we have a cached mapping
  const mapping = crewMappings.get(crewId);

  // Try to find the agent definition
  let agentDef: Record<string, unknown> | undefined;
  let agentId = mapping?.agentId;

  if (agentId) {
    agentDef = agents.get(agentId) as unknown as Record<string, unknown> | undefined;
  }

  // If no mapping or agent not found, try to find by crew ID pattern
  if (!agentDef) {
    // Try direct lookup (crewId might be the agentId)
    agentDef = agents.get(crewId) as unknown as Record<string, unknown> | undefined;
    if (agentDef) {
      agentId = crewId;
    } else {
      // Try fuzzy matching — strip prefix like 'crew-' or 'wk-crew-'
      const stripped = crewId.replace(/^(crew-|wk-crew-)/, '');
      for (const [id, def] of agents) {
        const agent = def as unknown as Record<string, unknown>;
        const name = ((agent.name as string) || '').toLowerCase();
        if (id === stripped || name.includes(stripped.toLowerCase())) {
          agentDef = agent;
          agentId = id;
          break;
        }
      }
    }
  }

  if (!agentDef || !agentId) {
    log.warn({ crewId }, 'No matching Gas Town agent found for crew member');
    return null;
  }

  const context: CrewAgentContext = {
    crewId,
    agentId,
    agentName: (agentDef.name as string) || agentId,
    systemPrompt: resolveSystemPrompt(agentDef),
    tools: resolveTools(agentDef),
    knowledge: resolveKnowledge(agentDef),
    tier: resolveAgentTier(agentDef),
    model: (agentDef.model as string) || 'gemini-2.0-flash',
    metadata: {
      role: agentDef.role,
      squad: agentDef.squad,
      bu: agentDef.bu,
      description: agentDef.description,
    },
  };

  // Cache the mapping
  crewMappings.set(crewId, {
    crewId,
    agentId,
    agentName: context.agentName,
    tier: context.tier,
    mappedAt: new Date(),
  });

  return context;
}

/**
 * Sync all crew members with their Gas Town agent counterparts.
 * Returns a report of all mappings found.
 */
export function syncCrewWithAgents(): Array<CrewMapping> {
  const mappings: CrewMapping[] = [];
  const agentEntries = Array.from(agents.entries());

  log.info({ agentCount: agentEntries.length }, 'Syncing crew with Gas Town agents');

  for (const [agentId, def] of agentEntries) {
    const agentDef = def as unknown as Record<string, unknown>;
    const tier = resolveAgentTier(agentDef);
    const agentName = (agentDef.name as string) || agentId;

    // Create a crew mapping for each agent
    const crewId = `crew-${agentId}`;
    const mapping: CrewMapping = {
      crewId,
      agentId,
      agentName,
      tier,
      mappedAt: new Date(),
    };

    crewMappings.set(crewId, mapping);
    // Also map by agent ID directly
    crewMappings.set(agentId, mapping);
    mappings.push(mapping);
  }

  broadcast('meow:feed', {
    type: 'system_health',
    source: 'crew-agent-bridge',
    message: `Synced ${mappings.length} crew members with Gas Town agents (from ${agentEntries.length} agents)`,
    severity: 'info',
    timestamp: new Date(),
  });

  log.info({ synced: mappings.length }, 'Crew-agent sync complete');
  return mappings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save a crew member's session context to both in-memory and Supabase.
 */
export async function saveCrewSession(crewId: string, session: Partial<CrewSession>): Promise<void> {
  const existing = crewSessions.get(crewId);
  const mapping = crewMappings.get(crewId);

  const fullSession: CrewSession = {
    crewId,
    agentId: session.agentId || existing?.agentId || mapping?.agentId || crewId,
    conversationHistory: session.conversationHistory || existing?.conversationHistory || [],
    workingMemory: session.workingMemory || existing?.workingMemory || {},
    beadsCompleted: session.beadsCompleted || existing?.beadsCompleted || [],
    lastActiveAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  // Cap conversation history to prevent unbounded growth
  if (fullSession.conversationHistory.length > 100) {
    fullSession.conversationHistory = fullSession.conversationHistory.slice(-80);
  }

  crewSessions.set(crewId, fullSession);

  // Persist to Supabase
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO meow_crew_sessions (
        crew_id, agent_id, conversation_history, working_memory,
        beads_completed, last_active_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (crew_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        conversation_history = EXCLUDED.conversation_history,
        working_memory = EXCLUDED.working_memory,
        beads_completed = EXCLUDED.beads_completed,
        last_active_at = EXCLUDED.last_active_at`,
      [
        fullSession.crewId,
        fullSession.agentId,
        JSON.stringify(fullSession.conversationHistory),
        JSON.stringify(fullSession.workingMemory),
        fullSession.beadsCompleted,
        fullSession.lastActiveAt,
        fullSession.createdAt,
      ]
    );

    log.info({ crewId, historyLen: fullSession.conversationHistory.length }, 'Crew session saved');
  } catch (err) {
    log.warn({ err, crewId }, 'Failed to persist crew session (table may not exist)');
  }
}

/**
 * Load a crew member's session from Supabase (fallback to in-memory).
 */
export async function loadCrewSession(crewId: string): Promise<CrewSession | null> {
  // Check in-memory first
  const cached = crewSessions.get(crewId);

  // Try DB for potentially newer data
  const pool = getPool();
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM meow_crew_sessions WHERE crew_id = $1',
        [crewId],
      );

      if (rows.length > 0) {
        const row = rows[0];
        const session: CrewSession = {
          crewId: row.crew_id as string,
          agentId: row.agent_id as string,
          conversationHistory: (row.conversation_history as CrewSession['conversationHistory']) || [],
          workingMemory: (row.working_memory as Record<string, unknown>) || {},
          beadsCompleted: (row.beads_completed as string[]) || [],
          lastActiveAt: row.last_active_at as string,
          createdAt: row.created_at as string,
        };

        // Update in-memory cache
        crewSessions.set(crewId, session);
        return session;
      }
    } catch (err) {
      log.warn({ err, crewId }, 'Failed to load crew session from DB');
    }
  }

  return cached || null;
}

/**
 * Add a message to a crew member's conversation history.
 */
export async function addToConversation(
  crewId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const session = await loadCrewSession(crewId) || {
    crewId,
    agentId: crewMappings.get(crewId)?.agentId || crewId,
    conversationHistory: [],
    workingMemory: {},
    beadsCompleted: [],
    lastActiveAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  session.conversationHistory.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });

  await saveCrewSession(crewId, session);
}

/**
 * Record bead completion in a crew member's session.
 */
export async function recordBeadCompletion(crewId: string, beadId: string): Promise<void> {
  const session = await loadCrewSession(crewId);
  if (!session) return;

  if (!session.beadsCompleted.includes(beadId)) {
    session.beadsCompleted.push(beadId);
    await saveCrewSession(crewId, session);
  }
}

/**
 * Update working memory for a crew member.
 */
export async function updateWorkingMemory(
  crewId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const session = await loadCrewSession(crewId) || {
    crewId,
    agentId: crewMappings.get(crewId)?.agentId || crewId,
    conversationHistory: [],
    workingMemory: {},
    beadsCompleted: [],
    lastActiveAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  session.workingMemory[key] = value;
  await saveCrewSession(crewId, session);
}

// ─────────────────────────────────────────────────────────────────────────────
// Query / status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all crew-agent mappings.
 */
export function listCrewMappings(): CrewMapping[] {
  return Array.from(crewMappings.values());
}

/**
 * Get mapping count stats.
 */
export function getCrewBridgeStats(): {
  totalMappings: number;
  activeSessions: number;
  agentsAvailable: number;
  byTier: Record<string, number>;
} {
  const byTier: Record<string, number> = { S: 0, A: 0, B: 0 };

  for (const mapping of crewMappings.values()) {
    byTier[mapping.tier] = (byTier[mapping.tier] || 0) + 1;
  }

  return {
    totalMappings: crewMappings.size,
    activeSessions: crewSessions.size,
    agentsAvailable: agents.size,
    byTier,
  };
}

/**
 * Clear all cached mappings and sessions (useful for re-sync).
 */
export function clearCrewBridge(): void {
  crewMappings.clear();
  crewSessions.clear();
  log.info('Crew bridge cleared');
}
