/**
 * GAS TOWN FEDERATION -- SG-008 (Stage 06 Wave 2)
 *
 * Meta-layer that connects all Gas Town instances.
 * Provides inter-instance communication, resource brokering,
 * knowledge sharing, and conflict resolution.
 *
 * Features:
 *   - Federation Mail: inter-instance messaging system
 *   - Knowledge sharing: discoveries in one instance available to others
 *   - Resource brokering: one instance can request workers/budget from another
 *   - Campaign coordination: ensure DropLatam and DropGlobal don't compete
 *   - Federation status: health of all instances, resource utilization
 *   - Federation events: instance_started, instance_stopped, resource_transferred, etc.
 *   - Conflict resolution: when two instances want same resource, federation arbitrates
 *   - Periodic federation sync (default every 5min)
 *   - Federation dashboard data endpoint
 *
 * Gas Town: "The Federation is the glue. Without it, the rigs are just islands."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gastown-federation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FederationInstanceType = 'droplatam' | 'dropglobal' | 'content-factory';

export type FederationEventType =
  | 'instance_started'
  | 'instance_stopped'
  | 'instance_paused'
  | 'instance_resumed'
  | 'instance_error'
  | 'resource_requested'
  | 'resource_transferred'
  | 'resource_returned'
  | 'resource_denied'
  | 'knowledge_shared'
  | 'knowledge_consumed'
  | 'conflict_detected'
  | 'conflict_resolved'
  | 'sync_completed'
  | 'budget_transfer'
  | 'campaign_coordination';

export type ResourceType = 'worker' | 'budget' | 'capacity';

export type ConflictType = 'resource_contention' | 'audience_overlap' | 'budget_contention';

export type ConflictResolution = 'priority_wins' | 'split_resource' | 'queue_second' | 'deny_both';

export type MailPriority = 'urgent' | 'high' | 'normal' | 'low';

export type MailStatus = 'pending' | 'delivered' | 'read' | 'expired';

export interface FederationInstance {
  id: string;
  type: FederationInstanceType;
  status: 'running' | 'idle' | 'paused' | 'error' | 'draining';
  workerCount: number;
  activeMolecules: number;
  budgetUtilizationPct: number;
  healthScore: number;            // 0 - 100
  lastHeartbeat: Date;
  metadata: Record<string, unknown>;
  registeredAt: Date;
}

export interface FederationMail {
  id: string;
  fromInstanceId: string;
  toInstanceId: string;
  subject: string;
  body: string;
  priority: MailPriority;
  status: MailStatus;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  deliveredAt?: Date;
  readAt?: Date;
  expiresAt: Date;
}

export interface ResourceRequest {
  id: string;
  requesterId: string;
  requesterType: FederationInstanceType;
  targetId?: string;              // specific instance, or null for federation to decide
  resourceType: ResourceType;
  amount: number;                 // worker count, budget USD, capacity slots
  reason: string;
  priority: MailPriority;
  status: 'pending' | 'approved' | 'denied' | 'transferred' | 'returned';
  resolvedBy?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface KnowledgeShare {
  id: string;
  sourceInstanceId: string;
  sourceType: FederationInstanceType;
  topic: string;
  title: string;
  content: string;
  confidence: number;
  consumedBy: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface FederationConflict {
  id: string;
  type: ConflictType;
  instanceA: string;
  instanceB: string;
  description: string;
  resourceType?: ResourceType;
  resolution?: ConflictResolution;
  resolvedDetails?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface FederationEvent {
  id: string;
  type: FederationEventType;
  instanceId?: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface FederationConfig {
  syncIntervalMs: number;         // default 5 min
  mailTtlMs: number;              // default 24h
  knowledgeTtlMs: number;         // default 48h
  maxMailPerInstance: number;
  maxKnowledgeEntries: number;
  maxEvents: number;
  conflictResolutionDefault: ConflictResolution;
  instancePriorities: Record<FederationInstanceType, number>;  // higher = more priority
  autoResourceBrokering: boolean;
  audienceOverlapThreshold: number; // 0.0 - 1.0
}

export interface FederationDashboard {
  instances: FederationInstance[];
  totalWorkers: number;
  totalActiveMolecules: number;
  avgBudgetUtilization: number;
  avgHealthScore: number;
  pendingMails: number;
  pendingResourceRequests: number;
  activeConflicts: number;
  knowledgeEntries: number;
  recentEvents: FederationEvent[];
  lastSyncAt: Date;
}

export interface FederationStats {
  registeredInstances: number;
  runningInstances: number;
  totalMailsSent: number;
  totalMailsDelivered: number;
  totalResourceRequests: number;
  totalResourceTransfers: number;
  totalKnowledgeShared: number;
  totalConflictsDetected: number;
  totalConflictsResolved: number;
  totalSyncs: number;
  lastSyncAt: Date | null;
  upSince: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FederationConfig = {
  syncIntervalMs: 5 * 60 * 1000,   // 5 minutes
  mailTtlMs: 24 * 60 * 60 * 1000,  // 24 hours
  knowledgeTtlMs: 48 * 60 * 60 * 1000, // 48 hours
  maxMailPerInstance: 200,
  maxKnowledgeEntries: 1000,
  maxEvents: 5000,
  conflictResolutionDefault: 'priority_wins',
  instancePriorities: {
    'droplatam': 2,
    'dropglobal': 3,
    'content-factory': 1,
  },
  autoResourceBrokering: true,
  audienceOverlapThreshold: 0.3,
};

const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are a resource management AI for a multi-instance orchestration platform. '
                + 'You arbitrate resource conflicts and optimize cross-instance operations. '
                + 'Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in gastown-federation');
    return null;
  }
}

// ---------------------------------------------------------------------------
// GasTownFederation
// ---------------------------------------------------------------------------

export class GasTownFederation {
  private config: FederationConfig;
  private instances = new Map<string, FederationInstance>();
  private mailbox: FederationMail[] = [];
  private resourceRequests: ResourceRequest[] = [];
  private knowledgeStore: KnowledgeShare[] = [];
  private conflicts: FederationConflict[] = [];
  private events: FederationEvent[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private lastSyncAt: Date | null = null;
  private syncCount = 0;
  private upSince: Date;

  // Counters for stats
  private totalMailsSent = 0;
  private totalMailsDelivered = 0;
  private totalResourceTransfers = 0;
  private totalKnowledgeShared = 0;
  private totalConflictsDetected = 0;
  private totalConflictsResolved = 0;

  constructor(config?: Partial<FederationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.upSince = new Date();
    log.info({ config: this.config }, 'Federation created');
  }

  // --- Lifecycle -------------------------------------------------------------

  start(): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(() => {
      this.performSync().catch(err =>
        log.error({ err }, 'Federation sync failed'),
      );
    }, this.config.syncIntervalMs);

    this.emitEvent('sync_completed', {}, 'federation');

    broadcast('meow:sovereign', {
      type: 'federation_started',
      syncIntervalMs: this.config.syncIntervalMs,
      instanceCount: this.instances.size,
    });

    log.info('Federation started');
  }

  async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    await this.persistState();

    broadcast('meow:sovereign', { type: 'federation_stopped' });
    log.info('Federation stopped');
  }

  // --- Instance registry -----------------------------------------------------

  registerInstance(
    id: string,
    type: FederationInstanceType,
    metadata?: Record<string, unknown>,
  ): FederationInstance {
    const now = new Date();
    const existing = this.instances.get(id);
    if (existing) {
      existing.status = 'running';
      existing.lastHeartbeat = now;
      existing.metadata = { ...existing.metadata, ...metadata };
      this.emitEvent('instance_started', { instanceId: id, type }, id);
      return existing;
    }

    const inst: FederationInstance = {
      id,
      type,
      status: 'running',
      workerCount: 0,
      activeMolecules: 0,
      budgetUtilizationPct: 0,
      healthScore: 100,
      lastHeartbeat: now,
      metadata: metadata ?? {},
      registeredAt: now,
    };

    this.instances.set(id, inst);

    this.emitEvent('instance_started', { instanceId: id, type }, id);

    broadcast('meow:sovereign', {
      type: 'federation_instance_registered',
      instanceId: id,
      instanceType: type,
      totalInstances: this.instances.size,
    });

    log.info({ instanceId: id, type }, 'Instance registered with federation');
    return inst;
  }

  unregisterInstance(id: string): void {
    const inst = this.instances.get(id);
    if (!inst) return;

    inst.status = 'idle';
    this.emitEvent('instance_stopped', { instanceId: id }, id);

    broadcast('meow:sovereign', {
      type: 'federation_instance_unregistered',
      instanceId: id,
    });

    log.info({ instanceId: id }, 'Instance unregistered from federation');
  }

  heartbeat(id: string, status: Partial<FederationInstance>): void {
    const inst = this.instances.get(id);
    if (!inst) return;

    inst.lastHeartbeat = new Date();
    if (status.workerCount != null) inst.workerCount = status.workerCount;
    if (status.activeMolecules != null) inst.activeMolecules = status.activeMolecules;
    if (status.budgetUtilizationPct != null) inst.budgetUtilizationPct = status.budgetUtilizationPct;
    if (status.status) inst.status = status.status;
  }

  getInstances(): FederationInstance[] {
    return Array.from(this.instances.values());
  }

  getInstance(id: string): FederationInstance | null {
    return this.instances.get(id) ?? null;
  }

  // --- Federation Mail -------------------------------------------------------

  sendMail(
    fromId: string,
    toId: string,
    subject: string,
    body: string,
    priority: MailPriority = 'normal',
    metadata?: Record<string, unknown>,
  ): FederationMail {
    const now = new Date();
    const mail: FederationMail = {
      id: uuidv4(),
      fromInstanceId: fromId,
      toInstanceId: toId,
      subject,
      body,
      priority,
      status: 'pending',
      metadata,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.mailTtlMs),
    };

    this.mailbox.push(mail);
    this.totalMailsSent++;

    // Enforce per-instance limit
    const instanceMails = this.mailbox.filter(m => m.toInstanceId === toId);
    if (instanceMails.length > this.config.maxMailPerInstance) {
      const toRemove = instanceMails
        .filter(m => m.status === 'read' || m.status === 'expired')
        .slice(0, instanceMails.length - this.config.maxMailPerInstance);
      for (const m of toRemove) {
        const idx = this.mailbox.indexOf(m);
        if (idx >= 0) this.mailbox.splice(idx, 1);
      }
    }

    // Auto-deliver
    mail.status = 'delivered';
    mail.deliveredAt = now;
    this.totalMailsDelivered++;

    this.emitEvent('knowledge_shared', {
      mailId: mail.id,
      from: fromId,
      to: toId,
      subject,
      priority,
    }, fromId);

    broadcast('meow:sovereign', {
      type: 'federation_mail_sent',
      mailId: mail.id,
      from: fromId,
      to: toId,
      subject,
      priority,
    });

    return mail;
  }

  getMailForInstance(instanceId: string, unreadOnly = false): FederationMail[] {
    const now = Date.now();
    return this.mailbox.filter(m =>
      m.toInstanceId === instanceId &&
      m.expiresAt.getTime() > now &&
      (!unreadOnly || m.status !== 'read'),
    );
  }

  markMailRead(mailId: string): void {
    const mail = this.mailbox.find(m => m.id === mailId);
    if (mail) {
      mail.status = 'read';
      mail.readAt = new Date();
    }
  }

  // --- Resource brokering ----------------------------------------------------

  requestResource(
    requesterId: string,
    resourceType: ResourceType,
    amount: number,
    reason: string,
    priority: MailPriority = 'normal',
    targetId?: string,
  ): ResourceRequest {
    const requesterInst = this.instances.get(requesterId);
    const request: ResourceRequest = {
      id: uuidv4(),
      requesterId,
      requesterType: requesterInst?.type ?? 'droplatam',
      targetId,
      resourceType,
      amount,
      reason,
      priority,
      status: 'pending',
      createdAt: new Date(),
    };

    this.resourceRequests.push(request);

    this.emitEvent('resource_requested', {
      requestId: request.id,
      requesterId,
      resourceType,
      amount,
      reason,
    }, requesterId);

    broadcast('meow:sovereign', {
      type: 'federation_resource_requested',
      requestId: request.id,
      requesterId,
      resourceType,
      amount,
    });

    // Auto-broker if enabled
    if (this.config.autoResourceBrokering) {
      this.brokerResource(request);
    }

    return request;
  }

  private brokerResource(request: ResourceRequest): void {
    // Find best provider for this resource
    const provider = this.findBestProvider(request);

    if (!provider) {
      request.status = 'denied';
      request.resolvedAt = new Date();
      request.resolvedBy = 'federation-auto';

      this.emitEvent('resource_denied', {
        requestId: request.id,
        reason: 'No provider available',
      }, request.requesterId);

      broadcast('meow:sovereign', {
        type: 'federation_resource_denied',
        requestId: request.id,
        requesterId: request.requesterId,
      });

      return;
    }

    request.status = 'transferred';
    request.resolvedAt = new Date();
    request.resolvedBy = provider.id;
    this.totalResourceTransfers++;

    this.emitEvent('resource_transferred', {
      requestId: request.id,
      from: provider.id,
      to: request.requesterId,
      resourceType: request.resourceType,
      amount: request.amount,
    }, request.requesterId);

    // Notify both parties via mail
    this.sendMail(
      'federation',
      provider.id,
      `Resource transferred to ${request.requesterId}`,
      `${request.amount} ${request.resourceType}(s) transferred. Reason: ${request.reason}`,
      'high',
    );

    this.sendMail(
      'federation',
      request.requesterId,
      `Resource received from ${provider.id}`,
      `${request.amount} ${request.resourceType}(s) received from ${provider.id}`,
      'high',
    );

    broadcast('meow:sovereign', {
      type: 'federation_resource_transferred',
      requestId: request.id,
      from: provider.id,
      to: request.requesterId,
      resourceType: request.resourceType,
      amount: request.amount,
    });

    log.info({
      requestId: request.id,
      from: provider.id,
      to: request.requesterId,
      resourceType: request.resourceType,
      amount: request.amount,
    }, 'Resource brokered');
  }

  private findBestProvider(request: ResourceRequest): FederationInstance | null {
    if (request.targetId) {
      const target = this.instances.get(request.targetId);
      if (target && target.status === 'running') return target;
    }

    // Find running instances that are not the requester
    const candidates = Array.from(this.instances.values()).filter(inst =>
      inst.id !== request.requesterId &&
      inst.status === 'running' &&
      inst.healthScore > 50,
    );

    if (candidates.length === 0) return null;

    // For workers, prefer content-factory; for budget, prefer lowest utilization
    if (request.resourceType === 'worker') {
      const factory = candidates.find(c => c.type === 'content-factory');
      if (factory && factory.workerCount > request.amount) return factory;
    }

    // Sort by lowest budget utilization (can spare resources)
    candidates.sort((a, b) => a.budgetUtilizationPct - b.budgetUtilizationPct);
    return candidates[0];
  }

  getPendingRequests(): ResourceRequest[] {
    return this.resourceRequests.filter(r => r.status === 'pending');
  }

  getResourceHistory(instanceId?: string, limit = 50): ResourceRequest[] {
    let filtered = this.resourceRequests;
    if (instanceId) {
      filtered = filtered.filter(r => r.requesterId === instanceId || r.resolvedBy === instanceId);
    }
    return filtered.slice(-limit);
  }

  // --- Knowledge sharing -----------------------------------------------------

  shareKnowledge(
    sourceInstanceId: string,
    topic: string,
    title: string,
    content: string,
    confidence = 0.8,
  ): KnowledgeShare {
    const now = new Date();
    const sourceInst = this.instances.get(sourceInstanceId);

    const entry: KnowledgeShare = {
      id: uuidv4(),
      sourceInstanceId,
      sourceType: sourceInst?.type ?? 'droplatam',
      topic,
      title,
      content,
      confidence: Math.max(0, Math.min(1, confidence)),
      consumedBy: [],
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.knowledgeTtlMs),
    };

    this.knowledgeStore.push(entry);
    this.totalKnowledgeShared++;

    // Enforce max entries
    if (this.knowledgeStore.length > this.config.maxKnowledgeEntries) {
      this.knowledgeStore = this.knowledgeStore.slice(-this.config.maxKnowledgeEntries);
    }

    this.emitEvent('knowledge_shared', {
      knowledgeId: entry.id,
      sourceInstanceId,
      topic,
      title,
    }, sourceInstanceId);

    broadcast('meow:sovereign', {
      type: 'federation_knowledge_shared',
      knowledgeId: entry.id,
      sourceInstanceId,
      topic,
      title,
    });

    // Auto-notify other instances
    for (const [instId, inst] of this.instances) {
      if (instId !== sourceInstanceId && inst.status === 'running') {
        this.sendMail(
          sourceInstanceId,
          instId,
          `Knowledge shared: ${title}`,
          `Topic: ${topic}\n${content.slice(0, 500)}`,
          'normal',
        );
      }
    }

    return entry;
  }

  queryKnowledge(topic?: string, sourceType?: FederationInstanceType, limit = 20): KnowledgeShare[] {
    const now = Date.now();
    return this.knowledgeStore
      .filter(k =>
        k.expiresAt.getTime() > now &&
        (!topic || k.topic === topic || k.topic.includes(topic)) &&
        (!sourceType || k.sourceType === sourceType),
      )
      .sort((a, b) => b.confidence - a.confidence || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  consumeKnowledge(knowledgeId: string, consumerId: string): KnowledgeShare | null {
    const entry = this.knowledgeStore.find(k => k.id === knowledgeId);
    if (!entry) return null;

    if (!entry.consumedBy.includes(consumerId)) {
      entry.consumedBy.push(consumerId);

      this.emitEvent('knowledge_consumed', {
        knowledgeId,
        consumerId,
        topic: entry.topic,
      }, consumerId);
    }

    return entry;
  }

  // --- Conflict resolution ---------------------------------------------------

  detectConflict(
    type: ConflictType,
    instanceA: string,
    instanceB: string,
    description: string,
    resourceType?: ResourceType,
  ): FederationConflict {
    const conflict: FederationConflict = {
      id: uuidv4(),
      type,
      instanceA,
      instanceB,
      description,
      resourceType,
      createdAt: new Date(),
    };

    this.conflicts.push(conflict);
    this.totalConflictsDetected++;

    this.emitEvent('conflict_detected', {
      conflictId: conflict.id,
      type,
      instanceA,
      instanceB,
      description,
    });

    broadcast('meow:sovereign', {
      type: 'federation_conflict_detected',
      conflictId: conflict.id,
      conflictType: type,
      instanceA,
      instanceB,
    });

    // Auto-resolve
    this.resolveConflict(conflict);

    return conflict;
  }

  private resolveConflict(conflict: FederationConflict): void {
    const instA = this.instances.get(conflict.instanceA);
    const instB = this.instances.get(conflict.instanceB);

    const priorityA = instA ? (this.config.instancePriorities[instA.type] ?? 0) : 0;
    const priorityB = instB ? (this.config.instancePriorities[instB.type] ?? 0) : 0;

    switch (this.config.conflictResolutionDefault) {
      case 'priority_wins':
        if (priorityA >= priorityB) {
          conflict.resolution = 'priority_wins';
          conflict.resolvedDetails = `${conflict.instanceA} wins (priority ${priorityA} >= ${priorityB})`;
        } else {
          conflict.resolution = 'priority_wins';
          conflict.resolvedDetails = `${conflict.instanceB} wins (priority ${priorityB} > ${priorityA})`;
        }
        break;

      case 'split_resource':
        conflict.resolution = 'split_resource';
        conflict.resolvedDetails = 'Resource split evenly between both instances';
        break;

      case 'queue_second':
        if (priorityA >= priorityB) {
          conflict.resolution = 'queue_second';
          conflict.resolvedDetails = `${conflict.instanceB} queued; ${conflict.instanceA} goes first`;
        } else {
          conflict.resolution = 'queue_second';
          conflict.resolvedDetails = `${conflict.instanceA} queued; ${conflict.instanceB} goes first`;
        }
        break;

      case 'deny_both':
        conflict.resolution = 'deny_both';
        conflict.resolvedDetails = 'Both requests denied pending manual review';
        break;
    }

    conflict.resolvedAt = new Date();
    this.totalConflictsResolved++;

    this.emitEvent('conflict_resolved', {
      conflictId: conflict.id,
      resolution: conflict.resolution,
      details: conflict.resolvedDetails,
    });

    broadcast('meow:sovereign', {
      type: 'federation_conflict_resolved',
      conflictId: conflict.id,
      resolution: conflict.resolution,
      details: conflict.resolvedDetails,
    });

    log.info({
      conflictId: conflict.id,
      resolution: conflict.resolution,
    }, 'Conflict resolved');
  }

  getActiveConflicts(): FederationConflict[] {
    return this.conflicts.filter(c => !c.resolvedAt);
  }

  getConflictHistory(limit = 50): FederationConflict[] {
    return this.conflicts.slice(-limit);
  }

  // --- AI-powered campaign coordination --------------------------------------

  async coordinateCampaigns(
    dropLatamAudiences: string[],
    dropGlobalAudiences: string[],
  ): Promise<{
    hasOverlap: boolean;
    overlappingAudiences: string[];
    recommendation: string;
  }> {
    // Simple overlap detection
    const overlap = dropLatamAudiences.filter(a =>
      dropGlobalAudiences.some(b =>
        a.toLowerCase() === b.toLowerCase() ||
        a.toLowerCase().includes(b.toLowerCase()) ||
        b.toLowerCase().includes(a.toLowerCase()),
      ),
    );

    const hasOverlap = overlap.length > 0;

    if (!hasOverlap) {
      return {
        hasOverlap: false,
        overlappingAudiences: [],
        recommendation: 'No audience overlap detected. Both instances can proceed independently.',
      };
    }

    // Try AI for detailed recommendation
    const prompt = `Analyze audience overlap between two ecommerce operations:

DropLatam (COD, LATAM markets) audiences: ${dropLatamAudiences.join(', ')}
DropGlobal (Brand, EU+US markets) audiences: ${dropGlobalAudiences.join(', ')}

Overlapping: ${overlap.join(', ')}

Recommend how to avoid audience cannibalization.
Respond JSON: {"recommendation": "string", "suggestedSplit": "string"}`;

    const raw = await callGemini(prompt);
    let recommendation = `${overlap.length} audience(s) overlap. Consider splitting by geography or excluding overlapping segments from one instance.`;

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { recommendation: string; suggestedSplit: string };
          recommendation = `${parsed.recommendation} Split: ${parsed.suggestedSplit}`;
        }
      } catch {
        log.warn('Failed to parse AI campaign coordination response');
      }
    }

    // Detect conflict
    if (overlap.length >= dropLatamAudiences.length * this.config.audienceOverlapThreshold) {
      this.detectConflict(
        'audience_overlap',
        'droplatam',
        'dropglobal',
        `${overlap.length} overlapping audiences: ${overlap.slice(0, 5).join(', ')}`,
      );
    }

    return {
      hasOverlap: true,
      overlappingAudiences: overlap,
      recommendation,
    };
  }

  // --- Federation sync -------------------------------------------------------

  async performSync(): Promise<void> {
    const now = new Date();

    // 1. Check heartbeats — mark stale instances
    for (const [id, inst] of this.instances) {
      if (
        inst.status === 'running' &&
        now.getTime() - inst.lastHeartbeat.getTime() > HEARTBEAT_TIMEOUT_MS
      ) {
        inst.status = 'error';
        inst.healthScore = Math.max(0, inst.healthScore - 30);

        this.emitEvent('instance_error', {
          instanceId: id,
          reason: 'Heartbeat timeout',
        }, id);

        broadcast('meow:sovereign', {
          type: 'federation_instance_unhealthy',
          instanceId: id,
          lastHeartbeat: inst.lastHeartbeat.toISOString(),
        });

        log.warn({ instanceId: id }, 'Instance missed heartbeat');
      }
    }

    // 2. Expire old mail
    const expiredMails = this.mailbox.filter(m => m.expiresAt.getTime() < now.getTime());
    for (const m of expiredMails) {
      m.status = 'expired';
    }
    this.mailbox = this.mailbox.filter(m => m.status !== 'expired' || now.getTime() - m.expiresAt.getTime() < 3_600_000);

    // 3. Expire old knowledge
    this.knowledgeStore = this.knowledgeStore.filter(k => k.expiresAt.getTime() > now.getTime());

    // 4. Recalculate health scores
    for (const inst of this.instances.values()) {
      if (inst.status === 'running') {
        let score = 100;
        if (inst.budgetUtilizationPct > 90) score -= 30;
        else if (inst.budgetUtilizationPct > 75) score -= 15;

        const timeSinceHeartbeat = now.getTime() - inst.lastHeartbeat.getTime();
        if (timeSinceHeartbeat > 5 * 60 * 1000) score -= 20;
        else if (timeSinceHeartbeat > 2 * 60 * 1000) score -= 10;

        inst.healthScore = Math.max(0, Math.min(100, score));
      }
    }

    // 5. Persist state
    await this.persistState();

    this.lastSyncAt = now;
    this.syncCount++;

    this.emitEvent('sync_completed', {
      instanceCount: this.instances.size,
      mailCount: this.mailbox.length,
      knowledgeCount: this.knowledgeStore.length,
      conflictCount: this.conflicts.length,
    });

    broadcast('meow:sovereign', {
      type: 'federation_sync_completed',
      instanceCount: this.instances.size,
      syncNumber: this.syncCount,
    });

    log.info({ syncNumber: this.syncCount, instanceCount: this.instances.size }, 'Federation sync completed');
  }

  // --- Dashboard data --------------------------------------------------------

  getDashboard(): FederationDashboard {
    const instances = Array.from(this.instances.values());
    const running = instances.filter(i => i.status === 'running');

    return {
      instances,
      totalWorkers: instances.reduce((s, i) => s + i.workerCount, 0),
      totalActiveMolecules: instances.reduce((s, i) => s + i.activeMolecules, 0),
      avgBudgetUtilization: running.length > 0
        ? Math.round((running.reduce((s, i) => s + i.budgetUtilizationPct, 0) / running.length) * 10) / 10
        : 0,
      avgHealthScore: running.length > 0
        ? Math.round(running.reduce((s, i) => s + i.healthScore, 0) / running.length)
        : 0,
      pendingMails: this.mailbox.filter(m => m.status === 'pending' || m.status === 'delivered').length,
      pendingResourceRequests: this.resourceRequests.filter(r => r.status === 'pending').length,
      activeConflicts: this.conflicts.filter(c => !c.resolvedAt).length,
      knowledgeEntries: this.knowledgeStore.length,
      recentEvents: this.events.slice(-20),
      lastSyncAt: this.lastSyncAt ?? new Date(),
    };
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): FederationStats {
    return {
      registeredInstances: this.instances.size,
      runningInstances: Array.from(this.instances.values()).filter(i => i.status === 'running').length,
      totalMailsSent: this.totalMailsSent,
      totalMailsDelivered: this.totalMailsDelivered,
      totalResourceRequests: this.resourceRequests.length,
      totalResourceTransfers: this.totalResourceTransfers,
      totalKnowledgeShared: this.totalKnowledgeShared,
      totalConflictsDetected: this.totalConflictsDetected,
      totalConflictsResolved: this.totalConflictsResolved,
      totalSyncs: this.syncCount,
      lastSyncAt: this.lastSyncAt,
      upSince: this.upSince,
    };
  }

  // --- Config ----------------------------------------------------------------

  getConfig(): FederationConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<FederationConfig>): void {
    this.config = { ...this.config, ...updates };

    // Restart sync timer if interval changed
    if (updates.syncIntervalMs && this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => {
        this.performSync().catch(err => log.error({ err }, 'Federation sync failed'));
      }, this.config.syncIntervalMs);
    }

    log.info({ updates }, 'Federation config updated');
  }

  // --- Events ----------------------------------------------------------------

  getRecentEvents(limit = 50): FederationEvent[] {
    return this.events.slice(-limit);
  }

  // --- Persistence -----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, type, instance_id, payload, created_at
         FROM meow_federation_events
         ORDER BY created_at DESC
         LIMIT 200`,
      );

      for (const r of rows as Array<Record<string, unknown>>) {
        this.events.push({
          id: r.id as string,
          type: r.type as FederationEventType,
          instanceId: r.instance_id as string,
          payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload as Record<string, unknown>) ?? {},
          createdAt: new Date(r.created_at as string),
        });
      }

      log.info({ loaded: rows.length }, 'Federation events loaded from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load federation events from DB');
    }
  }

  async persistState(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    // Persist recent events
    const recentEvents = this.events.slice(-50);
    for (const event of recentEvents) {
      try {
        await pool.query(
          `INSERT INTO meow_federation_events
            (id, type, instance_id, payload, created_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO NOTHING`,
          [
            event.id,
            event.type,
            event.instanceId ?? null,
            JSON.stringify(event.payload),
            event.createdAt.toISOString(),
          ],
        );
      } catch (err) {
        log.warn({ err, eventId: event.id }, 'Failed to persist federation event');
      }
    }
  }

  // --- Private helpers -------------------------------------------------------

  private emitEvent(type: FederationEventType, payload: Record<string, unknown>, instanceId?: string): void {
    const event: FederationEvent = {
      id: uuidv4(),
      type,
      instanceId,
      payload,
      createdAt: new Date(),
    };

    this.events.push(event);
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(-this.config.maxEvents);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GasTownFederation | null = null;

export function getGasTownFederation(
  config?: Partial<FederationConfig>,
): GasTownFederation {
  if (!instance) {
    instance = new GasTownFederation(config);
    log.info('GasTownFederation singleton created');
  }
  return instance;
}
