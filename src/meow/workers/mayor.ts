/**
 * MAYOR — Chief of Staff
 *
 * Gas Town: "Mayor never writes code. Mayor orchestrates."
 * Creates convoys, dispatches work, handles handoffs and escalations.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import type {
  Bead,
  Convoy,
  ConvoyStatus,
  Molecule,
  MoleculeStep,
  WorkerIdentity,
  FeedEvent,
  FeedEventType,
  Mail,
} from '../types';

export interface MayorState {
  id: string;
  name: string;
  activeConvoys: Map<string, Convoy>;
  inbox: Mail[];
  lastHandoff?: Date;
}

export class Mayor {
  private state: MayorState;

  constructor() {
    this.state = {
      id: 'mayor',
      name: 'Mayor',
      activeConvoys: new Map(),
      inbox: [],
    };
  }

  /** Create a convoy — bundles related beads for coordinated delivery */
  createConvoy(name: string, beadIds: string[], rig?: string): Convoy {
    const convoy: Convoy = {
      id: `conv-${uuidv4().slice(0, 8)}`,
      name,
      status: 'assembling',
      beadIds,
      moleculeIds: [],
      createdBy: this.state.id,
      assignedRig: rig,
      createdAt: new Date(),
      progress: 0,
    };

    this.state.activeConvoys.set(convoy.id, convoy);
    this.emitFeed('convoy_dispatched', `Convoy "${name}" created with ${beadIds.length} beads`, { convoyId: convoy.id });

    addActivity({
      type: 'info',
      action: 'convoy_created',
      details: `Mayor created convoy "${name}" with ${beadIds.length} beads`,
      agentId: this.state.id,
      agentName: this.state.name,
    });

    return convoy;
  }

  /** Dispatch a convoy — move from assembling to dispatched */
  dispatchConvoy(convoyId: string): Convoy {
    const convoy = this.state.activeConvoys.get(convoyId);
    if (!convoy) throw new Error(`Convoy ${convoyId} not found`);
    if (convoy.status !== 'assembling') throw new Error(`Convoy ${convoyId} is ${convoy.status}, cannot dispatch`);

    convoy.status = 'dispatched';
    convoy.dispatchedAt = new Date();
    this.emitFeed('convoy_dispatched', `Convoy "${convoy.name}" dispatched`, { convoyId });

    return convoy;
  }

  /** Sling a bead to a specific rig/worker — assign work */
  async sling(beadId: string, rig: string, options?: { preferWorker?: string; tier?: 'S' | 'A' | 'B' }): Promise<void> {
    this.emitFeed('bead_updated', `Mayor slung bead ${beadId} to rig ${rig}`, {
      beadId,
      metadata: { rig, ...options },
    });

    addActivity({
      type: 'info',
      action: 'bead_slung',
      details: `Mayor assigned bead ${beadId} to rig ${rig}`,
      agentId: this.state.id,
      agentName: this.state.name,
    });
  }

  /** Dispatch molecule steps to workers based on type and availability */
  async dispatchMolecule(molecule: Molecule, readySteps: MoleculeStep[]): Promise<void> {
    for (const step of readySteps) {
      this.emitFeed('molecule_step_completed', `Dispatching step "${step.title}" (${step.type})`, {
        moleculeId: molecule.id,
        metadata: { stepId: step.id, workerType: step.type },
      });
    }

    addActivity({
      type: 'info',
      action: 'molecule_dispatched',
      details: `Mayor dispatched ${readySteps.length} steps from molecule ${molecule.id}`,
      agentId: this.state.id,
      agentName: this.state.name,
    });
  }

  /** Handle escalation from a Witness */
  async handleEscalation(issue: string, fromWorkerId: string, beadId?: string): Promise<void> {
    this.emitFeed('escalation', `Escalation from ${fromWorkerId}: ${issue}`, {
      beadId,
      metadata: { fromWorker: fromWorkerId, severity: 'high' },
    });

    addActivity({
      type: 'warning',
      action: 'escalation_received',
      details: `Escalation from ${fromWorkerId}: ${issue}`,
      agentId: this.state.id,
      agentName: this.state.name,
    });

    // TODO: WhatsApp notification to Overseer
  }

  /** Handoff — save state for session restart */
  async handoff(): Promise<Record<string, unknown>> {
    this.state.lastHandoff = new Date();

    const handoffData = {
      timestamp: this.state.lastHandoff,
      activeConvoys: Array.from(this.state.activeConvoys.values()),
      pendingMail: this.state.inbox.filter(m => !m.read).length,
    };

    addActivity({
      type: 'info',
      action: 'mayor_handoff',
      details: `Mayor handoff — ${handoffData.activeConvoys.length} active convoys`,
      agentId: this.state.id,
      agentName: this.state.name,
    });

    return handoffData;
  }

  /** Get a specific convoy by ID */
  getConvoy(convoyId: string): Convoy | undefined {
    return this.state.activeConvoys.get(convoyId);
  }

  /** List all convoys */
  listConvoys(): Convoy[] {
    return Array.from(this.state.activeConvoys.values());
  }

  /** Get status overview across all rigs */
  status(): {
    id: string;
    name: string;
    activeConvoys: number;
    unreadMail: number;
    lastHandoff?: Date;
  } {
    return {
      id: this.state.id,
      name: this.state.name,
      activeConvoys: this.state.activeConvoys.size,
      unreadMail: this.state.inbox.filter(m => !m.read).length,
      lastHandoff: this.state.lastHandoff,
    };
  }

  /** Receive mail */
  receiveMail(mail: Mail): void {
    this.state.inbox.push(mail);
    if (mail.priority === 'critical') {
      this.emitFeed('mail_sent', `Critical mail to Mayor: ${mail.subject}`, {
        metadata: { from: mail.from, priority: mail.priority },
      });
    }
  }

  /** Update convoy progress */
  updateConvoyProgress(convoyId: string, completedBeads: number, totalBeads: number): void {
    const convoy = this.state.activeConvoys.get(convoyId);
    if (!convoy) return;

    convoy.progress = totalBeads > 0 ? Math.round((completedBeads / totalBeads) * 100) : 0;

    if (convoy.progress >= 100) {
      convoy.status = 'delivered';
      convoy.deliveredAt = new Date();
      this.emitFeed('convoy_delivered', `Convoy "${convoy.name}" delivered!`, { convoyId });
    }
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { beadId?: string; moleculeId?: string; convoyId?: string; metadata?: Record<string, unknown> }
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: this.state.id,
      message,
      severity: type === 'escalation' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton Mayor instance */
export const mayor = new Mayor();
