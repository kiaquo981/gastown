/**
 * OVERSEER — Human Operator Interface (EP-047)
 *
 * Gas Town: "The Overseer sees all, approves all, stops all."
 *
 * Provides the human (you) with:
 * - Gate approvals/rejections for molecules
 * - Pause/resume any worker, molecule, or convoy
 * - WhatsApp escalation delivery
 * - System-wide overview
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../../sse';
import type { FeedEvent, FeedEventType } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GateRequest {
  id: string;
  moleculeId: string;
  stepId: string;
  gateType: 'human-approval' | 'test-pass' | 'budget-check';
  title: string;
  description: string;
  requestedBy: string;          // Worker ID that requested
  status: 'pending' | 'approved' | 'rejected';
  decision?: string;            // Reason for approval/rejection
  createdAt: Date;
  decidedAt?: Date;
}

export interface OverseerConfig {
  whatsappEnabled: boolean;
  autoApproveTestPass: boolean;  // Auto-approve test-pass gates
}

export interface OverseerStats {
  pendingGates: number;
  totalApproved: number;
  totalRejected: number;
  totalEscalations: number;
  pausedEntities: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OverseerConfig = {
  whatsappEnabled: true,
  autoApproveTestPass: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Overseer
// ─────────────────────────────────────────────────────────────────────────────

export class Overseer {
  private config: OverseerConfig;
  private gates: Map<string, GateRequest> = new Map();
  private pausedEntities: Set<string> = new Set();
  private totalApproved: number = 0;
  private totalRejected: number = 0;
  private totalEscalations: number = 0;

  constructor(config?: Partial<OverseerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Request a gate approval from the Overseer */
  requestGate(moleculeId: string, stepId: string, gateType: GateRequest['gateType'], title: string, description: string, requestedBy: string): GateRequest {
    const gate: GateRequest = {
      id: `gate-${uuidv4().slice(0, 8)}`,
      moleculeId,
      stepId,
      gateType,
      title,
      description,
      requestedBy,
      status: 'pending',
      createdAt: new Date(),
    };

    // Auto-approve test-pass gates if configured
    if (gateType === 'test-pass' && this.config.autoApproveTestPass) {
      gate.status = 'approved';
      gate.decision = 'Auto-approved (test-pass)';
      gate.decidedAt = new Date();
      this.totalApproved++;
    }

    this.gates.set(gate.id, gate);

    if (gate.status === 'pending') {
      this.emitFeed('system_health', `Gate approval requested: ${title}`, {
        metadata: { gateId: gate.id, gateType, moleculeId, stepId },
      });

      addActivity({
        type: 'warning',
        action: 'gate_requested',
        details: `Gate "${title}" awaiting Overseer approval (${gateType})`,
      });

      // WhatsApp notification for human-approval gates
      if (gateType === 'human-approval') {
        this.notifyWhatsApp(`🚦 *GATE APPROVAL NEEDED*\n\n${title}\n${description}\n\nGate ID: ${gate.id}`);
      }
    }

    return gate;
  }

  /** Approve a gate */
  approveGate(gateId: string, reason?: string): GateRequest {
    const gate = this.gates.get(gateId);
    if (!gate) throw new Error(`Gate ${gateId} not found`);
    if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is already ${gate.status}`);

    gate.status = 'approved';
    gate.decision = reason || 'Approved by Overseer';
    gate.decidedAt = new Date();
    this.totalApproved++;

    this.emitFeed('molecule_step_completed', `Gate "${gate.title}" APPROVED`, {
      moleculeId: gate.moleculeId,
      metadata: { gateId, decision: gate.decision },
    });

    addActivity({
      type: 'info',
      action: 'gate_approved',
      details: `Gate "${gate.title}" approved: ${gate.decision}`,
    });

    return gate;
  }

  /** Reject a gate */
  rejectGate(gateId: string, reason: string): GateRequest {
    const gate = this.gates.get(gateId);
    if (!gate) throw new Error(`Gate ${gateId} not found`);
    if (gate.status !== 'pending') throw new Error(`Gate ${gateId} is already ${gate.status}`);

    gate.status = 'rejected';
    gate.decision = reason;
    gate.decidedAt = new Date();
    this.totalRejected++;

    this.emitFeed('molecule_failed', `Gate "${gate.title}" REJECTED: ${reason}`, {
      moleculeId: gate.moleculeId,
      metadata: { gateId, decision: reason },
    });

    addActivity({
      type: 'error',
      action: 'gate_rejected',
      details: `Gate "${gate.title}" rejected: ${reason}`,
    });

    return gate;
  }

  /** Pause an entity (molecule, polecat, convoy, crew member) */
  pauseEntity(entityId: string, reason?: string): void {
    this.pausedEntities.add(entityId);

    this.emitFeed('system_health', `Overseer paused: ${entityId}`, {
      metadata: { entityId, reason },
    });

    addActivity({
      type: 'warning',
      action: 'entity_paused',
      details: `Overseer paused ${entityId}${reason ? ': ' + reason : ''}`,
    });
  }

  /** Resume a paused entity */
  resumeEntity(entityId: string): void {
    this.pausedEntities.delete(entityId);

    addActivity({
      type: 'info',
      action: 'entity_resumed',
      details: `Overseer resumed ${entityId}`,
    });
  }

  /** Check if an entity is paused */
  isPaused(entityId: string): boolean {
    return this.pausedEntities.has(entityId);
  }

  /** Handle escalation — log + WhatsApp */
  async escalate(issue: string, fromWorkerId: string, severity: 'warning' | 'error' | 'critical' = 'warning'): Promise<void> {
    this.totalEscalations++;

    this.emitFeed('escalation', `Escalation from ${fromWorkerId}: ${issue}`, {
      metadata: { fromWorker: fromWorkerId, severity },
    });

    addActivity({
      type: severity === 'critical' ? 'error' : 'warning',
      action: 'escalation_received',
      details: `[${severity.toUpperCase()}] ${fromWorkerId}: ${issue}`,
    });

    if (severity === 'critical' || severity === 'error') {
      await this.notifyWhatsApp(`🚨 *ESCALATION — ${severity.toUpperCase()}*\n\nFrom: ${fromWorkerId}\n${issue}\n\n${new Date().toISOString()}`);
    }
  }

  /** Get all pending gates */
  getPendingGates(): GateRequest[] {
    return Array.from(this.gates.values()).filter(g => g.status === 'pending');
  }

  /** Get all gates */
  getAllGates(): GateRequest[] {
    return Array.from(this.gates.values());
  }

  /** Get a specific gate */
  getGate(gateId: string): GateRequest | undefined {
    return this.gates.get(gateId);
  }

  /** Get stats */
  stats(): OverseerStats {
    return {
      pendingGates: Array.from(this.gates.values()).filter(g => g.status === 'pending').length,
      totalApproved: this.totalApproved,
      totalRejected: this.totalRejected,
      totalEscalations: this.totalEscalations,
      pausedEntities: Array.from(this.pausedEntities),
    };
  }

  /** Send WhatsApp notification via Evolution API */
  private async notifyWhatsApp(text: string): Promise<void> {
    if (!this.config.whatsappEnabled) return;

    const phone = process.env.OPERATOR_PHONE;
    const evoUrl = process.env.EVOLUTION_API_URL;
    const evoInstance = process.env.EVOLUTION_INSTANCE;
    const evoKey = process.env.EVOLUTION_API_KEY;

    if (!phone || !evoUrl || !evoInstance || !evoKey) return;

    try {
      const response = await fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': evoKey,
        },
        body: JSON.stringify({ number: phone, text }),
      });

      if (response.ok) {
        addActivity({
          type: 'info',
          action: 'overseer_wa_sent',
          details: `Overseer WhatsApp notification sent`,
        });
      }
    } catch (err) {
      addActivity({
        type: 'warning',
        action: 'overseer_wa_failed',
        details: `Overseer WhatsApp failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { moleculeId?: string; metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'overseer',
      message,
      severity: type === 'escalation' ? 'error' : type === 'system_health' ? 'warning' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton Overseer instance */
export const overseer = new Overseer();
