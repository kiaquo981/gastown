/**
 * BeadSyncOrchestrator — Stage 04 Wave 6 Index
 *
 * Imports all 4 sync modules and provides a unified orchestrator
 * that routes bead lifecycle events to the relevant sync targets.
 *
 * Singleton pattern via getBeadSyncOrchestrator().
 */

import { BeadPersistenceEnhanced } from './bead-supabase-persistence';
import { BeadProjectQueueSync } from './bead-project-queue-sync';
import { BeadGitHubSync } from './bead-github-sync';
import { BeadMegaBrainSync } from './bead-megabrain-sync';
import type { Bead } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type BeadEventType = 'created' | 'updated' | 'completed' | 'cancelled';

export interface SyncStatus {
  persistence: boolean;
  projectQueue: boolean;
  github: boolean;
  megabrain: boolean;
  startedAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[BeadSyncOrchestrator]';

export class BeadSyncOrchestrator {
  readonly persistence: BeadPersistenceEnhanced;
  readonly projectQueue: BeadProjectQueueSync;
  readonly github: BeadGitHubSync;
  readonly megabrain: BeadMegaBrainSync;

  private _started = false;
  private _startedAt: Date | null = null;

  constructor() {
    this.persistence = new BeadPersistenceEnhanced();
    this.projectQueue = new BeadProjectQueueSync();
    this.github = new BeadGitHubSync();
    this.megabrain = new BeadMegaBrainSync();
  }

  // ───────────── Lifecycle ─────────────

  start(): void {
    if (this._started) return;
    this._started = true;
    this._startedAt = new Date();

    // Start the project queue sync polling loop
    this.projectQueue.start();

    console.info(`${TAG} Started — persistence, projectQueue, github, megabrain active`);
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;

    this.projectQueue.stop();

    console.info(`${TAG} Stopped`);
  }

  // ───────────── Event Router ─────────────

  async onBeadEvent(event: BeadEventType, bead: Bead, output?: string): Promise<void> {
    const errors: string[] = [];

    // 1. Persistence — always refresh stats on any event
    try {
      await this.persistence.refreshStatsCache();
    } catch (err) {
      errors.push(`persistence: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Route by event type
    switch (event) {
      case 'created':
        await this.handleCreated(bead, errors);
        break;

      case 'updated':
        await this.handleUpdated(bead, errors);
        break;

      case 'completed':
        await this.handleCompleted(bead, output, errors);
        break;

      case 'cancelled':
        await this.handleCancelled(bead, errors);
        break;
    }

    if (errors.length > 0) {
      console.warn(`${TAG} Event "${event}" for bead ${bead.id} had ${errors.length} sync error(s):`, errors);
    }
  }

  // ───────────── Status ─────────────

  getStatus(): SyncStatus {
    return {
      persistence: true, // always available if DB is up
      projectQueue: this._started,
      github: this.github.isConfigured(),
      megabrain: true, // always available if DB is up
      startedAt: this._startedAt,
    };
  }

  // ───────────── Internal Handlers ─────────────

  private async handleCreated(bead: Bead, errors: string[]): Promise<void> {
    // If bead has 'github' label, create a GitHub issue
    if (bead.labels?.github === 'true' || bead.labels?.github === '1') {
      if (this.github.isConfigured()) {
        try {
          await this.github.createIssueFromBead(bead);
        } catch (err) {
          errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // If bead is created in 'ready' status, sync to project queue
    if (bead.status === 'ready') {
      try {
        await this.projectQueue.syncBeadToTask(bead.id);
      } catch (err) {
        errors.push(`projectQueue: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleUpdated(bead: Bead, errors: string[]): Promise<void> {
    // Sync status to GitHub if configured and mapped
    if (this.github.isConfigured() && bead.labels?.github_issue) {
      try {
        await this.github.syncBeadStatusToIssue(bead.id, bead.status);
      } catch (err) {
        errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // If bead became 'ready', sync to project queue
    if (bead.status === 'ready') {
      try {
        await this.projectQueue.syncBeadToTask(bead.id);
      } catch (err) {
        errors.push(`projectQueue: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleCompleted(bead: Bead, output: string | undefined, errors: string[]): Promise<void> {
    // Feed into MegaBrain knowledge base
    try {
      await this.megabrain.onBeadCompleted(bead, output);
    } catch (err) {
      errors.push(`megabrain: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Sync to GitHub if mapped
    if (this.github.isConfigured() && bead.labels?.github_issue) {
      try {
        await this.github.syncBeadStatusToIssue(bead.id, bead.status);
      } catch (err) {
        errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleCancelled(bead: Bead, errors: string[]): Promise<void> {
    // Remove from project queue
    try {
      await this.projectQueue.onBeadCancelled(bead.id);
    } catch (err) {
      errors.push(`projectQueue: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Close GitHub issue if mapped
    if (this.github.isConfigured() && bead.labels?.github_issue) {
      try {
        await this.github.syncBeadStatusToIssue(bead.id, 'cancelled');
      } catch (err) {
        errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

let instance: BeadSyncOrchestrator | null = null;

export function getBeadSyncOrchestrator(): BeadSyncOrchestrator {
  if (!instance) {
    instance = new BeadSyncOrchestrator();
  }
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export { BeadPersistenceEnhanced } from './bead-supabase-persistence';
export { BeadProjectQueueSync } from './bead-project-queue-sync';
export { BeadGitHubSync } from './bead-github-sync';
export { BeadMegaBrainSync } from './bead-megabrain-sync';

export type { BeadQueryFilters, BeadQueryResult, BeadStats } from './bead-supabase-persistence';
export type { SyncReport } from './bead-github-sync';
export type { MegaBrainFragment, IngestionStats } from './bead-megabrain-sync';
