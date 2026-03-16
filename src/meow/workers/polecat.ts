/**
 * POLECAT — Ephemeral Worker
 *
 * Gas Town: "Polecats are disposable. They spawn, work, PR, and die."
 * 3-layer separation: Identity (permanent bead), Sandbox (git worktree), Session (ephemeral)
 * Each polecat gets an isolated git worktree to work in.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import type {
  WorkerIdentity,
  PolecatStatus,
  Bead,
  FeedEvent,
  FeedEventType,
} from '../types';

export interface PolecatInstance {
  id: string;
  identity: WorkerIdentity;
  beadId: string;
  worktreePath: string;
  branch: string;
  status: PolecatStatus;
  spawnedAt: Date;
  lastActiveAt: Date;
  retryCount: number;
  error?: string;
}

export interface PolecatManagerConfig {
  maxPolecats: number;              // Max concurrent polecats per rig
  worktreeBase: string;             // Base path for worktrees (e.g., .worktrees/)
  stallTimeoutMs: number;           // After this, polecat is "stalled"
  zombieTimeoutMs: number;          // After this, polecat is "zombie"
  reuseIdle: boolean;               // Reuse idle polecats instead of spawning new
}

const DEFAULT_CONFIG: PolecatManagerConfig = {
  maxPolecats: 5,
  worktreeBase: '.worktrees',
  stallTimeoutMs: 10 * 60 * 1000,    // 10 minutes
  zombieTimeoutMs: 30 * 60 * 1000,   // 30 minutes
  reuseIdle: true,
};

export class PolecatManager {
  private polecats: Map<string, PolecatInstance> = new Map();
  private queue: Array<{ beadId: string; skill: string; resolve: (p: PolecatInstance) => void }> = [];
  private config: PolecatManagerConfig;

  constructor(config?: Partial<PolecatManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Spawn a new polecat for a bead */
  async spawn(beadId: string, skill: string, options?: { tier?: 'S' | 'A' | 'B'; branch?: string }): Promise<PolecatInstance> {
    // Check if we can reuse an idle polecat
    if (this.config.reuseIdle) {
      const idle = this.findIdle();
      if (idle) {
        return this.reassign(idle.id, beadId, skill);
      }
    }

    // Check capacity
    const active = this.getActive();
    if (active.length >= this.config.maxPolecats) {
      // Queue the request
      return new Promise((resolve) => {
        this.queue.push({ beadId, skill, resolve });
        this.emitFeed('worker_idle', `Polecat queue: ${this.queue.length} waiting (max: ${this.config.maxPolecats})`, {
          metadata: { queueLength: this.queue.length },
        });
      });
    }

    return this.createPolecat(beadId, skill, options?.branch);
  }

  private createPolecat(beadId: string, skill: string, branch?: string): PolecatInstance {
    const id = `polecat-${uuidv4().slice(0, 6)}`;
    const branchName = branch || `feature/${beadId}-${skill}`;
    const worktreePath = `${this.config.worktreeBase}/${beadId}`;

    const polecat: PolecatInstance = {
      id,
      identity: {
        id,
        role: 'polecat',
        name: `Polecat ${id.slice(-6)}`,
        tier: 'B',
        model: 'sonnet',
        capabilities: [],
        worktree: worktreePath,
        branch: branchName,
        polecatStatus: 'spawning',
        currentBeadId: beadId,
        lastActiveAt: new Date(),
        tasksCompleted: 0,
      },
      beadId,
      worktreePath,
      branch: branchName,
      status: 'spawning',
      spawnedAt: new Date(),
      lastActiveAt: new Date(),
      retryCount: 0,
    };

    this.polecats.set(id, polecat);

    // Transition to working
    polecat.status = 'working';
    polecat.identity.polecatStatus = 'working';

    this.emitFeed('polecat_spawned', `Polecat ${id} spawned for bead ${beadId} (skill: ${skill})`, {
      beadId,
      metadata: { polecatId: id, skill, worktree: worktreePath, branch: branchName },
    });

    addActivity({
      type: 'info',
      action: 'polecat_spawned',
      details: `Polecat ${id} spawned for bead ${beadId}`,
      agentId: id,
      agentName: polecat.identity.name,
    });

    return polecat;
  }

  /** Mark polecat as completed */
  async complete(polecatId: string, prUrl?: string): Promise<void> {
    const polecat = this.polecats.get(polecatId);
    if (!polecat) throw new Error(`Polecat ${polecatId} not found`);

    polecat.status = 'idle';
    polecat.identity.polecatStatus = 'idle';
    polecat.identity.tasksCompleted++;
    polecat.lastActiveAt = new Date();

    this.emitFeed('polecat_completed', `Polecat ${polecatId} completed bead ${polecat.beadId}`, {
      beadId: polecat.beadId,
      metadata: { polecatId, prUrl },
    });

    addActivity({
      type: 'success',
      action: 'polecat_completed',
      details: `Polecat ${polecatId} completed bead ${polecat.beadId}${prUrl ? ` — PR: ${prUrl}` : ''}`,
      agentId: polecatId,
      agentName: polecat.identity.name,
    });

    // Process queue
    this.processQueue();
  }

  /** Mark polecat as failed */
  async fail(polecatId: string, error: string): Promise<void> {
    const polecat = this.polecats.get(polecatId);
    if (!polecat) throw new Error(`Polecat ${polecatId} not found`);

    polecat.status = 'stalled';
    polecat.identity.polecatStatus = 'stalled';
    polecat.error = error;
    polecat.lastActiveAt = new Date();

    this.emitFeed('polecat_stalled', `Polecat ${polecatId} stalled on bead ${polecat.beadId}: ${error}`, {
      beadId: polecat.beadId,
      metadata: { polecatId, error },
    });

    addActivity({
      type: 'error',
      action: 'polecat_stalled',
      details: `Polecat ${polecatId} stalled: ${error}`,
      agentId: polecatId,
      agentName: polecat.identity.name,
    });
  }

  /** Reassign idle polecat to new bead */
  private reassign(polecatId: string, beadId: string, skill: string): PolecatInstance {
    const polecat = this.polecats.get(polecatId);
    if (!polecat) throw new Error(`Polecat ${polecatId} not found`);

    polecat.beadId = beadId;
    polecat.identity.currentBeadId = beadId;
    polecat.branch = `feature/${beadId}-${skill}`;
    polecat.worktreePath = `${this.config.worktreeBase}/${beadId}`;
    polecat.identity.worktree = polecat.worktreePath;
    polecat.identity.branch = polecat.branch;
    polecat.status = 'working';
    polecat.identity.polecatStatus = 'working';
    polecat.lastActiveAt = new Date();
    polecat.error = undefined;
    polecat.retryCount = 0;

    this.emitFeed('polecat_spawned', `Polecat ${polecatId} reassigned to bead ${beadId}`, {
      beadId,
      metadata: { polecatId, skill, reused: true },
    });

    return polecat;
  }

  /** Find an idle polecat */
  private findIdle(): PolecatInstance | undefined {
    for (const [, polecat] of this.polecats) {
      if (polecat.status === 'idle') return polecat;
    }
    return undefined;
  }

  /** Get active (non-idle) polecats */
  private getActive(): PolecatInstance[] {
    return Array.from(this.polecats.values()).filter(
      p => p.status === 'working' || p.status === 'spawning'
    );
  }

  /** Process queued requests */
  private processQueue(): void {
    while (this.queue.length > 0 && this.getActive().length < this.config.maxPolecats) {
      const next = this.queue.shift();
      if (next) {
        const polecat = this.createPolecat(next.beadId, next.skill);
        next.resolve(polecat);
      }
    }
  }

  /** Health check — detect stalled and zombie polecats */
  healthCheck(): { stalled: string[]; zombies: string[]; active: number; idle: number; queued: number } {
    const now = Date.now();
    const stalled: string[] = [];
    const zombies: string[] = [];
    let active = 0;
    let idle = 0;

    for (const [id, polecat] of this.polecats) {
      const elapsed = now - polecat.lastActiveAt.getTime();

      if (polecat.status === 'working') {
        if (elapsed > this.config.zombieTimeoutMs) {
          polecat.status = 'zombie';
          polecat.identity.polecatStatus = 'zombie';
          zombies.push(id);
        } else if (elapsed > this.config.stallTimeoutMs) {
          polecat.status = 'stalled';
          polecat.identity.polecatStatus = 'stalled';
          stalled.push(id);
        } else {
          active++;
        }
      } else if (polecat.status === 'idle') {
        idle++;
      }
    }

    return { stalled, zombies, active, idle, queued: this.queue.length };
  }

  /** Cleanup — remove zombie polecats, reset stalled ones */
  async cleanup(): Promise<{ cleaned: number; reset: number }> {
    let cleaned = 0;
    let reset = 0;

    for (const [id, polecat] of this.polecats) {
      if (polecat.status === 'zombie') {
        this.polecats.delete(id);
        cleaned++;
      } else if (polecat.status === 'stalled' && polecat.retryCount < 3) {
        polecat.status = 'idle';
        polecat.identity.polecatStatus = 'idle';
        polecat.retryCount++;
        reset++;
      }
    }

    if (cleaned > 0 || reset > 0) {
      addActivity({
        type: 'info',
        action: 'polecat_cleanup',
        details: `Cleaned ${cleaned} zombies, reset ${reset} stalled polecats`,
      });
    }

    // Process queue after cleanup
    this.processQueue();

    return { cleaned, reset };
  }

  /** Get all polecats status */
  list(): PolecatInstance[] {
    return Array.from(this.polecats.values());
  }

  /** Get specific polecat */
  get(id: string): PolecatInstance | undefined {
    return this.polecats.get(id);
  }

  /** Get stats */
  stats(): { total: number; working: number; idle: number; stalled: number; zombie: number; queued: number } {
    let working = 0, idle = 0, stalled = 0, zombie = 0;
    for (const [, p] of this.polecats) {
      if (p.status === 'working' || p.status === 'spawning') working++;
      else if (p.status === 'idle') idle++;
      else if (p.status === 'stalled') stalled++;
      else if (p.status === 'zombie') zombie++;
    }
    return { total: this.polecats.size, working, idle, stalled, zombie, queued: this.queue.length };
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { beadId?: string; moleculeId?: string; convoyId?: string; metadata?: Record<string, unknown> }
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'polecat-manager',
      message,
      severity: type === 'polecat_stalled' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton PolecatManager */
export const polecatManager = new PolecatManager();
