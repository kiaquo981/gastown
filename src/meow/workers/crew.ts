/**
 * CREW — Long-Lived Named Agents (EP-046)
 *
 * Gas Town: "Crew don't die. Crew remember. Crew persist."
 *
 * Unlike polecats (ephemeral), crew members are permanent agents with
 * persistent identity and context. Persistent named agents.
 * No Witness supervision — crew answers only to the Mayor.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import { Capability } from '../types';
import type { WorkerIdentity, FeedEvent, FeedEventType, Mail } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CrewMember {
  identity: WorkerIdentity;
  status: 'idle' | 'working' | 'paused' | 'offline';
  currentTask?: string;
  inbox: Mail[];
  sessionsCompleted: number;
  context: Record<string, unknown>;   // Persistent context between sessions
  startedAt: Date;
  lastActiveAt: Date;
}

export interface CrewManagerConfig {
  maxCrewSize: number;               // Max crew members (default 10)
}

export interface CrewStats {
  totalMembers: number;
  active: number;
  idle: number;
  paused: number;
  offline: number;
  totalSessionsCompleted: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CrewManagerConfig = {
  maxCrewSize: 10,
};

// Pre-registered crew mapped to existing Gas Town entities
const DEFAULT_CREW: Array<{ id: string; name: string; tier: WorkerIdentity['tier']; model: WorkerIdentity['model']; agentDefId: string }> = [
  { id: 'crew-mayor',       name: 'Mayor',       tier: 'S', model: 'opus',   agentDefId: 'mayor' },
  { id: 'crew-strategist',  name: 'Strategist',  tier: 'S', model: 'opus',   agentDefId: 'strategist' },
  { id: 'crew-specialist',  name: 'Specialist',  tier: 'A', model: 'sonnet', agentDefId: 'specialist' },
];

// ─────────────────────────────────────────────────────────────────────────────
// CrewManager
// ─────────────────────────────────────────────────────────────────────────────

export class CrewManager {
  private config: CrewManagerConfig;
  private members: Map<string, CrewMember> = new Map();

  constructor(config?: Partial<CrewManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initDefaultCrew();
  }

  /** Initialize default crew members */
  private initDefaultCrew(): void {
    const now = new Date();
    for (const def of DEFAULT_CREW) {
      const member: CrewMember = {
        identity: {
          id: def.id,
          role: 'crew',
          name: def.name,
          tier: def.tier,
          model: def.model,
          capabilities: [Capability.FileRead, Capability.FileWrite, Capability.LLMCall, Capability.ShellExec, Capability.NetConnect, Capability.ToolInvoke],
          agentDefId: def.agentDefId,
          tasksCompleted: 0,
        },
        status: 'idle',
        inbox: [],
        sessionsCompleted: 0,
        context: {},
        startedAt: now,
        lastActiveAt: now,
      };
      this.members.set(def.id, member);
    }
  }

  /** Register a new crew member */
  register(id: string, name: string, tier: WorkerIdentity['tier'], model: WorkerIdentity['model'], agentDefId?: string): CrewMember {
    if (this.members.has(id)) throw new Error(`Crew member ${id} already exists`);
    if (this.members.size >= this.config.maxCrewSize) throw new Error(`Crew at max capacity (${this.config.maxCrewSize})`);

    const now = new Date();
    const member: CrewMember = {
      identity: {
        id,
        role: 'crew',
        name,
        tier,
        model,
        capabilities: [Capability.FileRead, Capability.FileWrite, Capability.LLMCall, Capability.ToolInvoke],
        agentDefId,
        tasksCompleted: 0,
      },
      status: 'idle',
      inbox: [],
      sessionsCompleted: 0,
      context: {},
      startedAt: now,
      lastActiveAt: now,
    };

    this.members.set(id, member);

    this.emitFeed('polecat_spawned', `Crew member "${name}" registered (${tier}/${model})`, {
      metadata: { crewId: id, tier, model },
    });

    addActivity({
      type: 'info',
      action: 'crew_registered',
      details: `Crew member "${name}" (${id}) registered`,
    });

    return member;
  }

  /** Assign work to a crew member */
  assignWork(crewId: string, taskDescription: string): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    if (member.status === 'paused') throw new Error(`Crew member ${crewId} is paused`);

    member.status = 'working';
    member.currentTask = taskDescription;
    member.lastActiveAt = new Date();

    this.emitFeed('bead_updated', `Crew "${member.identity.name}" assigned: ${taskDescription}`, {
      metadata: { crewId, task: taskDescription },
    });
  }

  /** Mark crew work as complete */
  completeWork(crewId: string): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);

    member.status = 'idle';
    member.currentTask = undefined;
    member.sessionsCompleted++;
    member.identity.tasksCompleted++;
    member.lastActiveAt = new Date();

    addActivity({
      type: 'info',
      action: 'crew_work_completed',
      details: `Crew "${member.identity.name}" completed work (session #${member.sessionsCompleted})`,
    });
  }

  /** Pause a crew member */
  pause(crewId: string): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    member.status = 'paused';
  }

  /** Resume a paused crew member */
  resume(crewId: string): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    member.status = 'idle';
    member.lastActiveAt = new Date();
  }

  /** Deliver mail to a crew member */
  deliverMail(crewId: string, mail: Mail): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    member.inbox.push(mail);
  }

  /** Save context for a crew member (persists between sessions) */
  saveContext(crewId: string, key: string, value: unknown): void {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    member.context[key] = value;
  }

  /** Get context for a crew member */
  getContext(crewId: string): Record<string, unknown> {
    const member = this.members.get(crewId);
    if (!member) throw new Error(`Crew member ${crewId} not found`);
    return { ...member.context };
  }

  /** Get a specific crew member */
  get(crewId: string): CrewMember | undefined {
    return this.members.get(crewId);
  }

  /** List all crew members */
  list(): CrewMember[] {
    return Array.from(this.members.values());
  }

  /** Get crew stats */
  stats(): CrewStats {
    const members = Array.from(this.members.values());
    return {
      totalMembers: members.length,
      active: members.filter(m => m.status === 'working').length,
      idle: members.filter(m => m.status === 'idle').length,
      paused: members.filter(m => m.status === 'paused').length,
      offline: members.filter(m => m.status === 'offline').length,
      totalSessionsCompleted: members.reduce((sum, m) => sum + m.sessionsCompleted, 0),
    };
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'crew-manager',
      message,
      severity: 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton CrewManager instance */
export const crewManager = new CrewManager();
