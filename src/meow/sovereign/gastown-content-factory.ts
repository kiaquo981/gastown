/**
 * GAS TOWN CONTENT FACTORY INSTANCE -- SG-007 (Stage 06 Wave 2)
 *
 * Dedicated Gas Town instance for content production.
 * Shared service across DropLatam + DropGlobal — serves both.
 *
 * Features:
 *   - Content types: video (short/long), carousel, static images, UGC, copy
 *   - Tools: Gemini (copy), Fal.ai (images), ElevenLabs (voice), HeyGen (video)
 *   - Own worker pool: specialized in creative/content generation
 *   - Own formula set: content-pipeline, content-batch, ab-creative
 *   - Capacity tracking: max concurrent generations, queue depth, avg generation time
 *   - Priority system: urgent requests from other instances jump queue
 *   - Metrics: content pieces produced, avg quality score, generation time, cost per piece
 *
 * Gas Town: "The Factory never sleeps. Feed it briefs, it spits out gold."
 */

import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gastown-content-factory');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentType = 'video-short' | 'video-long' | 'carousel' | 'static-image' | 'ugc' | 'copy';

export type ContentTool = 'gemini' | 'fal-ai' | 'elevenlabs' | 'heygen';

export type ContentPriority = 'urgent' | 'high' | 'normal' | 'low';

export type ContentStatus = 'queued' | 'generating' | 'reviewing' | 'approved' | 'rejected' | 'failed';

export type ContentFormulaName =
  | 'content-pipeline'
  | 'content-batch'
  | 'ab-creative'
  | 'ugc-generation'
  | 'copy-variants'
  | 'video-production';

export type InstanceStatus = 'idle' | 'running' | 'paused' | 'error' | 'draining';

export type ContentWorkerSpec =
  | 'copy-generator'
  | 'image-generator'
  | 'video-producer'
  | 'ugc-creator'
  | 'quality-reviewer'
  | 'creative-strategist';

export interface ContentWorker {
  id: string;
  name: string;
  specialization: ContentWorkerSpec;
  tools: ContentTool[];
  taskCount: number;
  avgGenerationTimeMs: number;
  qualityScore: number;          // 0.0 - 1.0 running average
  borrowed: boolean;
  borrowedTo?: string;           // instance id that borrowed this worker
  createdAt: Date;
}

export interface ContentRequest {
  id: string;
  requesterId: string;           // instance id requesting content
  requesterType: 'droplatam' | 'dropglobal' | 'internal';
  contentType: ContentType;
  priority: ContentPriority;
  status: ContentStatus;
  brief: string;
  targetAudience?: string;
  targetMarket?: string;
  toolsRequired: ContentTool[];
  assignedWorkerId?: string;
  outputUrl?: string;
  qualityScore?: number;
  generationTimeMs?: number;
  costUsd: number;
  retryCount: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CapacityTracking {
  maxConcurrentGenerations: number;
  activeGenerations: number;
  queueDepth: number;
  avgGenerationTimeMs: number;
  peakConcurrency: number;
  utilizationPct: number;        // active / max * 100
}

export interface ContentMetrics {
  totalProduced: number;
  totalFailed: number;
  avgQualityScore: number;
  avgGenerationTimeMs: number;
  avgCostPerPieceUsd: number;
  byType: Record<ContentType, { count: number; avgTimeMs: number; avgQuality: number }>;
  byRequester: Record<string, { count: number; totalCostUsd: number }>;
  byTool: Record<ContentTool, { count: number; avgTimeMs: number; failRate: number }>;
  updatedAt: Date;
}

export interface ContentBudget {
  id: string;
  monthlyLimitUsd: number;
  spentUsd: number;
  utilizationPct: number;
  perToolSpent: Partial<Record<ContentTool, number>>;
  perRequesterSpent: Record<string, number>;
  period: string;
  updatedAt: Date;
}

export interface ContentFactoryConfig {
  defaultFormulas: ContentFormulaName[];
  workerAllocation: Partial<Record<ContentWorkerSpec, number>>;
  budgetLimitUsd: number;
  maxConcurrentGenerations: number;
  maxQueueDepth: number;
  defaultQualityThreshold: number;
  urgentQueueBoost: number;      // how many positions to bump urgent requests
  autoRetryOnFailure: boolean;
  maxRetries: number;
  lendWorkersEnabled: boolean;
}

export interface InstanceEvent {
  id: string;
  instanceId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ContentFactoryStats {
  status: InstanceStatus;
  totalWorkers: number;
  lentWorkers: number;
  capacity: CapacityTracking;
  metrics: ContentMetrics;
  budgetUtilizationPct: number;
  formulasExecuted: Record<string, number>;
  upSince: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ContentFactoryConfig = {
  defaultFormulas: ['content-pipeline', 'content-batch', 'ab-creative'],
  workerAllocation: {
    'copy-generator': 3,
    'image-generator': 2,
    'video-producer': 2,
    'ugc-creator': 1,
    'quality-reviewer': 2,
    'creative-strategist': 1,
  },
  budgetLimitUsd: 3000,
  maxConcurrentGenerations: 10,
  maxQueueDepth: 100,
  defaultQualityThreshold: 0.7,
  urgentQueueBoost: 10,
  autoRetryOnFailure: true,
  maxRetries: 2,
  lendWorkersEnabled: true,
};

const DEFAULT_FORMULAS: Record<ContentFormulaName, {
  description: string;
  requiredSpecializations: ContentWorkerSpec[];
  avgDurationMs: number;
}> = {
  'content-pipeline': {
    description: 'End-to-end content production: brief → generate → review → deliver',
    requiredSpecializations: ['creative-strategist', 'copy-generator', 'quality-reviewer'],
    avgDurationMs: 1_800_000,
  },
  'content-batch': {
    description: 'Batch produce multiple content pieces: images, copy, and video simultaneously',
    requiredSpecializations: ['copy-generator', 'image-generator', 'video-producer'],
    avgDurationMs: 3_600_000,
  },
  'ab-creative': {
    description: 'Generate A/B variants for creative testing with controlled variations',
    requiredSpecializations: ['copy-generator', 'image-generator', 'creative-strategist'],
    avgDurationMs: 2_400_000,
  },
  'ugc-generation': {
    description: 'Produce UGC-style content using AI avatars and authentic copy patterns',
    requiredSpecializations: ['ugc-creator', 'video-producer'],
    avgDurationMs: 2_400_000,
  },
  'copy-variants': {
    description: 'Generate multiple copy variants for headlines, ads, emails, and landing pages',
    requiredSpecializations: ['copy-generator', 'creative-strategist'],
    avgDurationMs: 600_000,
  },
  'video-production': {
    description: 'Full video production: script → voiceover → visuals → edit → export',
    requiredSpecializations: ['video-producer', 'copy-generator'],
    avgDurationMs: 4_800_000,
  },
};

const TOOL_COSTS_PER_CALL: Record<ContentTool, number> = {
  'gemini': 0.002,
  'fal-ai': 0.05,
  'elevenlabs': 0.03,
  'heygen': 0.10,
};

const CONTENT_TYPE_TOOLS: Record<ContentType, ContentTool[]> = {
  'video-short': ['gemini', 'heygen', 'elevenlabs'],
  'video-long': ['gemini', 'heygen', 'elevenlabs'],
  'carousel': ['gemini', 'fal-ai'],
  'static-image': ['fal-ai'],
  'ugc': ['gemini', 'heygen', 'elevenlabs'],
  'copy': ['gemini'],
};

const MAX_EVENTS = 2000;
const MAX_WORKERS = 50;
const MAX_REQUESTS = 5000;

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
                'You are a creative content strategist specializing in direct-response marketing. '
                + 'Generate content briefs, quality assessments, and creative strategies. '
                + 'Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.5,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in gastown-content-factory');
    return null;
  }
}

// ---------------------------------------------------------------------------
// GasTownContentFactory
// ---------------------------------------------------------------------------

export class GasTownContentFactory {
  readonly instanceId: string;
  private status: InstanceStatus = 'idle';
  private config: ContentFactoryConfig;
  private workers = new Map<string, ContentWorker>();
  private queue: ContentRequest[] = [];
  private activeRequests = new Map<string, ContentRequest>();
  private completedRequests: ContentRequest[] = [];
  private budget: ContentBudget;
  private events: InstanceEvent[] = [];
  private formulaExecutions = new Map<string, number>();
  private peakConcurrency = 0;
  private upSince: Date;

  constructor(config?: Partial<ContentFactoryConfig>) {
    this.instanceId = `content-factory-${process.env.MEOW_INSTANCE_ID || os.hostname().slice(0, 8) || 'default'}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.upSince = new Date();

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.budget = {
      id: uuidv4(),
      monthlyLimitUsd: this.config.budgetLimitUsd,
      spentUsd: 0,
      utilizationPct: 0,
      perToolSpent: {},
      perRequesterSpent: {},
      period,
      updatedAt: now,
    };

    log.info({ instanceId: this.instanceId, config: this.config }, 'Content Factory created');
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (this.status === 'running') return;

    this.status = 'running';
    this.upSince = new Date();

    await this.provisionWorkers();
    await this.loadFromDb();

    this.emitEvent('instance_started', { config: this.config });

    broadcast('meow:sovereign', {
      type: 'content_factory_started',
      instanceId: this.instanceId,
      workerCount: this.workers.size,
      maxConcurrent: this.config.maxConcurrentGenerations,
    });

    log.info({ instanceId: this.instanceId }, 'Content Factory started');
  }

  async stop(): Promise<void> {
    this.status = 'draining';

    const drainStart = Date.now();
    while (this.activeRequests.size > 0 && Date.now() - drainStart < 60_000) {
      await new Promise(r => setTimeout(r, 1000));
    }

    this.status = 'idle';
    await this.persistState();

    this.emitEvent('instance_stopped', { drained: this.activeRequests.size === 0 });
    broadcast('meow:sovereign', { type: 'content_factory_stopped', instanceId: this.instanceId });
    log.info({ instanceId: this.instanceId }, 'Content Factory stopped');
  }

  pause(): void {
    this.status = 'paused';
    this.emitEvent('instance_paused', {});
    broadcast('meow:sovereign', { type: 'content_factory_paused', instanceId: this.instanceId });
  }

  resume(): void {
    this.status = 'running';
    this.emitEvent('instance_resumed', {});
    broadcast('meow:sovereign', { type: 'content_factory_resumed', instanceId: this.instanceId });
    // Process queue after resume
    this.processQueue();
  }

  getStatus(): InstanceStatus {
    return this.status;
  }

  // --- Worker management -----------------------------------------------------

  async provisionWorkers(): Promise<void> {
    for (const [spec, count] of Object.entries(this.config.workerAllocation)) {
      const specialization = spec as ContentWorkerSpec;
      const existingCount = Array.from(this.workers.values())
        .filter(w => w.specialization === specialization && !w.borrowed).length;

      for (let i = existingCount; i < (count ?? 0); i++) {
        if (this.workers.size >= MAX_WORKERS) break;
        const tools = this.getToolsForSpec(specialization);
        const worker: ContentWorker = {
          id: uuidv4(),
          name: `factory-${specialization}-${i + 1}`,
          specialization,
          tools,
          taskCount: 0,
          avgGenerationTimeMs: 0,
          qualityScore: 0.8,
          borrowed: false,
          createdAt: new Date(),
        };
        this.workers.set(worker.id, worker);
      }
    }

    log.info({ workerCount: this.workers.size }, 'Workers provisioned for Content Factory');
  }

  lendWorker(targetInstanceId: string, specialization?: ContentWorkerSpec): ContentWorker | null {
    if (!this.config.lendWorkersEnabled) return null;

    const available = Array.from(this.workers.values()).find(w =>
      !w.borrowed &&
      (!specialization || w.specialization === specialization) &&
      !this.isWorkerBusy(w.id),
    );

    if (!available) return null;

    available.borrowed = true;
    available.borrowedTo = targetInstanceId;

    this.emitEvent('worker_lent', { workerId: available.id, toInstance: targetInstanceId });

    broadcast('meow:sovereign', {
      type: 'content_factory_worker_lent',
      instanceId: this.instanceId,
      workerId: available.id,
      toInstance: targetInstanceId,
    });

    log.info({ workerId: available.id, toInstance: targetInstanceId }, 'Worker lent to other instance');
    return available;
  }

  returnWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.borrowed) return false;

    const fromInstance = worker.borrowedTo;
    worker.borrowed = false;
    worker.borrowedTo = undefined;

    this.emitEvent('worker_returned', { workerId, fromInstance });
    return true;
  }

  getAvailableWorkers(spec?: ContentWorkerSpec): ContentWorker[] {
    return Array.from(this.workers.values()).filter(w =>
      !w.borrowed && (!spec || w.specialization === spec),
    );
  }

  // --- Content request management --------------------------------------------

  submitRequest(request: Omit<ContentRequest, 'id' | 'status' | 'costUsd' | 'retryCount' | 'createdAt'>): ContentRequest {
    const full: ContentRequest = {
      ...request,
      id: uuidv4(),
      status: 'queued',
      costUsd: 0,
      retryCount: 0,
      createdAt: new Date(),
      toolsRequired: request.toolsRequired.length > 0
        ? request.toolsRequired
        : CONTENT_TYPE_TOOLS[request.contentType] ?? ['gemini'],
    };

    // Insert into queue based on priority
    if (full.priority === 'urgent') {
      // Jump the queue by urgentQueueBoost positions
      const insertAt = Math.max(0, this.queue.length - this.config.urgentQueueBoost);
      this.queue.splice(insertAt, 0, full);
    } else if (full.priority === 'high') {
      const firstNormal = this.queue.findIndex(r => r.priority === 'normal' || r.priority === 'low');
      if (firstNormal >= 0) {
        this.queue.splice(firstNormal, 0, full);
      } else {
        this.queue.push(full);
      }
    } else {
      this.queue.push(full);
    }

    // Enforce max queue depth
    if (this.queue.length > this.config.maxQueueDepth) {
      const dropped = this.queue.pop()!;
      dropped.status = 'rejected';
      this.completedRequests.push(dropped);
      log.warn({ requestId: dropped.id }, 'Content request dropped due to queue overflow');
    }

    this.emitEvent('request_submitted', {
      requestId: full.id,
      contentType: full.contentType,
      priority: full.priority,
      requester: full.requesterId,
    });

    broadcast('meow:sovereign', {
      type: 'content_factory_request_queued',
      instanceId: this.instanceId,
      requestId: full.id,
      contentType: full.contentType,
      priority: full.priority,
      queueDepth: this.queue.length,
    });

    // Try to process immediately
    this.processQueue();

    return full;
  }

  private processQueue(): void {
    if (this.status !== 'running') return;

    while (
      this.queue.length > 0 &&
      this.activeRequests.size < this.config.maxConcurrentGenerations
    ) {
      const request = this.queue.shift()!;
      this.startGeneration(request);
    }
  }

  private startGeneration(request: ContentRequest): void {
    const worker = this.findBestWorker(request);
    if (!worker) {
      // Put back in queue
      this.queue.unshift(request);
      return;
    }

    request.status = 'generating';
    request.startedAt = new Date();
    request.assignedWorkerId = worker.id;

    this.activeRequests.set(request.id, request);

    // Track peak concurrency
    if (this.activeRequests.size > this.peakConcurrency) {
      this.peakConcurrency = this.activeRequests.size;
    }

    broadcast('meow:sovereign', {
      type: 'content_factory_generation_started',
      instanceId: this.instanceId,
      requestId: request.id,
      contentType: request.contentType,
      workerId: worker.id,
      activeCount: this.activeRequests.size,
    });

    log.info(
      { requestId: request.id, contentType: request.contentType, workerId: worker.id },
      'Content generation started',
    );
  }

  completeGeneration(
    requestId: string,
    success: boolean,
    opts?: { outputUrl?: string; qualityScore?: number },
  ): void {
    const request = this.activeRequests.get(requestId);
    if (!request) return;

    this.activeRequests.delete(requestId);

    const now = new Date();
    request.completedAt = now;
    request.generationTimeMs = request.startedAt
      ? now.getTime() - request.startedAt.getTime()
      : 0;

    if (success) {
      request.status = 'approved';
      request.outputUrl = opts?.outputUrl;
      request.qualityScore = opts?.qualityScore ?? 0.8;

      // Calculate cost based on tools used
      const cost = request.toolsRequired.reduce(
        (sum, tool) => sum + (TOOL_COSTS_PER_CALL[tool] ?? 0),
        0,
      );
      request.costUsd = Math.round(cost * 10000) / 10000;

      // Record spend
      this.recordSpend(request.costUsd, request.toolsRequired, request.requesterId);

      // Update worker stats
      if (request.assignedWorkerId) {
        const worker = this.workers.get(request.assignedWorkerId);
        if (worker) {
          worker.taskCount++;
          const n = worker.taskCount;
          worker.avgGenerationTimeMs =
            ((worker.avgGenerationTimeMs * (n - 1)) + (request.generationTimeMs ?? 0)) / n;
          worker.qualityScore =
            ((worker.qualityScore * (n - 1)) + (request.qualityScore ?? 0.8)) / n;
        }
      }
    } else {
      request.status = 'failed';

      // Auto-retry if enabled
      if (
        this.config.autoRetryOnFailure &&
        request.retryCount < this.config.maxRetries
      ) {
        request.retryCount++;
        request.status = 'queued';
        request.startedAt = undefined;
        request.completedAt = undefined;
        request.assignedWorkerId = undefined;
        this.queue.unshift(request); // Priority retry at front
        log.info({ requestId, retryCount: request.retryCount }, 'Content generation retrying');
        this.processQueue();
        return;
      }
    }

    this.completedRequests.push(request);
    if (this.completedRequests.length > MAX_REQUESTS) {
      this.completedRequests = this.completedRequests.slice(-MAX_REQUESTS);
    }

    this.emitEvent('generation_completed', {
      requestId,
      success,
      generationTimeMs: request.generationTimeMs,
      qualityScore: request.qualityScore,
      costUsd: request.costUsd,
    });

    broadcast('meow:sovereign', {
      type: 'content_factory_generation_completed',
      instanceId: this.instanceId,
      requestId,
      success,
      contentType: request.contentType,
      generationTimeMs: request.generationTimeMs,
      activeCount: this.activeRequests.size,
    });

    // Process next in queue
    this.processQueue();
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getActiveGenerations(): ContentRequest[] {
    return Array.from(this.activeRequests.values());
  }

  // --- AI quality assessment -------------------------------------------------

  async assessContentQuality(contentDescription: string, contentType: ContentType): Promise<{
    score: number;
    feedback: string[];
    passesThreshold: boolean;
  }> {
    const prompt = `Assess the quality of this ${contentType} content for direct-response marketing:

Content: ${contentDescription.slice(0, 2000)}

Rate on 0-100 scale and provide specific feedback.
Respond JSON: {"score": 0-100, "feedback": ["string"], "improvements": ["string"]}`;

    const raw = await callGemini(prompt);
    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            score: number;
            feedback: string[];
            improvements: string[];
          };
          const normalizedScore = Math.max(0, Math.min(1, (parsed.score ?? 50) / 100));
          return {
            score: normalizedScore,
            feedback: [...(parsed.feedback ?? []), ...(parsed.improvements ?? [])],
            passesThreshold: normalizedScore >= this.config.defaultQualityThreshold,
          };
        }
      } catch {
        log.warn('Failed to parse AI quality assessment');
      }
    }

    // Heuristic fallback
    const score = 0.75;
    return {
      score,
      feedback: ['AI assessment unavailable, using default quality score'],
      passesThreshold: score >= this.config.defaultQualityThreshold,
    };
  }

  // --- Budget management -----------------------------------------------------

  private recordSpend(amount: number, tools: ContentTool[], requesterId: string): void {
    this.budget.spentUsd += amount;
    this.budget.utilizationPct = this.budget.monthlyLimitUsd > 0
      ? (this.budget.spentUsd / this.budget.monthlyLimitUsd) * 100
      : 0;

    for (const tool of tools) {
      this.budget.perToolSpent[tool] =
        (this.budget.perToolSpent[tool] ?? 0) + (TOOL_COSTS_PER_CALL[tool] ?? 0);
    }

    this.budget.perRequesterSpent[requesterId] =
      (this.budget.perRequesterSpent[requesterId] ?? 0) + amount;

    this.budget.updatedAt = new Date();

    if (this.budget.utilizationPct >= 90) {
      broadcast('meow:sovereign', {
        type: 'content_factory_budget_critical',
        instanceId: this.instanceId,
        utilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
      });
    }
  }

  checkBudget(estimatedCostUsd: number): { allowed: boolean; reason?: string } {
    const projected = this.budget.spentUsd + estimatedCostUsd;
    if (this.budget.monthlyLimitUsd > 0 && projected >= this.budget.monthlyLimitUsd) {
      return {
        allowed: false,
        reason: `Content Factory budget exceeded: $${projected.toFixed(2)} / $${this.budget.monthlyLimitUsd}`,
      };
    }
    return { allowed: true };
  }

  getBudget(): ContentBudget {
    return { ...this.budget };
  }

  // --- Capacity tracking -----------------------------------------------------

  getCapacity(): CapacityTracking {
    return {
      maxConcurrentGenerations: this.config.maxConcurrentGenerations,
      activeGenerations: this.activeRequests.size,
      queueDepth: this.queue.length,
      avgGenerationTimeMs: this.computeAvgGenerationTime(),
      peakConcurrency: this.peakConcurrency,
      utilizationPct: this.config.maxConcurrentGenerations > 0
        ? Math.round((this.activeRequests.size / this.config.maxConcurrentGenerations) * 1000) / 10
        : 0,
    };
  }

  // --- Metrics ---------------------------------------------------------------

  getMetrics(): ContentMetrics {
    const now = new Date();
    const completed = this.completedRequests.filter(r => r.status === 'approved' || r.status === 'failed');
    const successful = completed.filter(r => r.status === 'approved');
    const failed = completed.filter(r => r.status === 'failed');

    const avgQuality = successful.length > 0
      ? successful.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / successful.length
      : 0;

    const avgGenTime = successful.length > 0
      ? successful.reduce((s, r) => s + (r.generationTimeMs ?? 0), 0) / successful.length
      : 0;

    const totalCost = completed.reduce((s, r) => s + r.costUsd, 0);
    const avgCost = completed.length > 0 ? totalCost / completed.length : 0;

    // Breakdown by type
    const byType: Record<string, { count: number; avgTimeMs: number; avgQuality: number }> = {};
    const contentTypes: ContentType[] = ['video-short', 'video-long', 'carousel', 'static-image', 'ugc', 'copy'];
    for (const ct of contentTypes) {
      const typed = successful.filter(r => r.contentType === ct);
      byType[ct] = {
        count: typed.length,
        avgTimeMs: typed.length > 0
          ? Math.round(typed.reduce((s, r) => s + (r.generationTimeMs ?? 0), 0) / typed.length)
          : 0,
        avgQuality: typed.length > 0
          ? Math.round((typed.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / typed.length) * 100) / 100
          : 0,
      };
    }

    // Breakdown by requester
    const byRequester: Record<string, { count: number; totalCostUsd: number }> = {};
    for (const r of completed) {
      if (!byRequester[r.requesterId]) {
        byRequester[r.requesterId] = { count: 0, totalCostUsd: 0 };
      }
      byRequester[r.requesterId].count++;
      byRequester[r.requesterId].totalCostUsd += r.costUsd;
    }

    // Breakdown by tool
    const byTool: Record<string, { count: number; avgTimeMs: number; failRate: number }> = {};
    const tools: ContentTool[] = ['gemini', 'fal-ai', 'elevenlabs', 'heygen'];
    for (const tool of tools) {
      const toolRequests = completed.filter(r => r.toolsRequired.includes(tool));
      const toolFailed = toolRequests.filter(r => r.status === 'failed');
      byTool[tool] = {
        count: toolRequests.length,
        avgTimeMs: toolRequests.length > 0
          ? Math.round(toolRequests.reduce((s, r) => s + (r.generationTimeMs ?? 0), 0) / toolRequests.length)
          : 0,
        failRate: toolRequests.length > 0
          ? Math.round((toolFailed.length / toolRequests.length) * 1000) / 1000
          : 0,
      };
    }

    return {
      totalProduced: successful.length,
      totalFailed: failed.length,
      avgQualityScore: Math.round(avgQuality * 1000) / 1000,
      avgGenerationTimeMs: Math.round(avgGenTime),
      avgCostPerPieceUsd: Math.round(avgCost * 10000) / 10000,
      byType: byType as ContentMetrics['byType'],
      byRequester,
      byTool: byTool as ContentMetrics['byTool'],
      updatedAt: now,
    };
  }

  // --- Formulas --------------------------------------------------------------

  getAvailableFormulas(): typeof DEFAULT_FORMULAS {
    return { ...DEFAULT_FORMULAS };
  }

  // --- Config ----------------------------------------------------------------

  getConfig(): ContentFactoryConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<ContentFactoryConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emitEvent('config_updated', { updates });
    log.info({ updates }, 'Content Factory config updated');
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): ContentFactoryStats {
    const lentCount = Array.from(this.workers.values()).filter(w => w.borrowed).length;

    return {
      status: this.status,
      totalWorkers: this.workers.size,
      lentWorkers: lentCount,
      capacity: this.getCapacity(),
      metrics: this.getMetrics(),
      budgetUtilizationPct: Math.round(this.budget.utilizationPct * 10) / 10,
      formulasExecuted: Object.fromEntries(this.formulaExecutions),
      upSince: this.upSince,
    };
  }

  // --- Events ----------------------------------------------------------------

  getRecentEvents(limit = 50): InstanceEvent[] {
    return this.events.slice(-limit);
  }

  // --- Persistence -----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT content_type, total_produced, total_failed, avg_quality_score,
                avg_generation_time_ms, avg_cost_per_piece_usd, updated_at
         FROM meow_instance_content
         WHERE instance_id = $1
         ORDER BY updated_at DESC
         LIMIT 20`,
        [this.instanceId],
      );

      log.info({ instanceId: this.instanceId, loaded: rows.length }, 'Content Factory state loaded from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load Content Factory state from DB');
    }
  }

  async persistState(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    const metrics = this.getMetrics();

    try {
      await pool.query(
        `INSERT INTO meow_instance_content
          (id, instance_id, content_type, total_produced, total_failed,
           avg_quality_score, avg_generation_time_ms, avg_cost_per_piece_usd,
           metrics_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (instance_id, content_type) DO UPDATE SET
           total_produced = EXCLUDED.total_produced,
           total_failed = EXCLUDED.total_failed,
           avg_quality_score = EXCLUDED.avg_quality_score,
           avg_generation_time_ms = EXCLUDED.avg_generation_time_ms,
           avg_cost_per_piece_usd = EXCLUDED.avg_cost_per_piece_usd,
           metrics_json = EXCLUDED.metrics_json,
           updated_at = EXCLUDED.updated_at`,
        [
          uuidv4(),
          this.instanceId,
          'all',
          metrics.totalProduced,
          metrics.totalFailed,
          metrics.avgQualityScore,
          metrics.avgGenerationTimeMs,
          metrics.avgCostPerPieceUsd,
          JSON.stringify(metrics),
          metrics.updatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist Content Factory state');
    }
  }

  // --- Private helpers -------------------------------------------------------

  private findBestWorker(request: ContentRequest): ContentWorker | null {
    const requiredTools = request.toolsRequired;
    const candidates = Array.from(this.workers.values()).filter(w =>
      !w.borrowed &&
      !this.isWorkerBusy(w.id) &&
      w.tools.some(t => requiredTools.includes(t)),
    );

    if (candidates.length === 0) return null;

    // Sort by quality score descending, then by task count ascending
    candidates.sort((a, b) => {
      const qualityDiff = b.qualityScore - a.qualityScore;
      if (Math.abs(qualityDiff) > 0.05) return qualityDiff;
      return a.taskCount - b.taskCount;
    });

    return candidates[0];
  }

  private isWorkerBusy(workerId: string): boolean {
    for (const request of this.activeRequests.values()) {
      if (request.assignedWorkerId === workerId) return true;
    }
    return false;
  }

  private getToolsForSpec(spec: ContentWorkerSpec): ContentTool[] {
    switch (spec) {
      case 'copy-generator': return ['gemini'];
      case 'image-generator': return ['fal-ai', 'gemini'];
      case 'video-producer': return ['heygen', 'elevenlabs', 'gemini'];
      case 'ugc-creator': return ['heygen', 'elevenlabs', 'gemini'];
      case 'quality-reviewer': return ['gemini'];
      case 'creative-strategist': return ['gemini'];
      default: return ['gemini'];
    }
  }

  private computeAvgGenerationTime(): number {
    const recent = this.completedRequests
      .filter(r => r.status === 'approved' && r.generationTimeMs)
      .slice(-100);

    if (recent.length === 0) return 0;
    return Math.round(
      recent.reduce((s, r) => s + (r.generationTimeMs ?? 0), 0) / recent.length,
    );
  }

  private emitEvent(type: string, payload: Record<string, unknown>): void {
    const event: InstanceEvent = {
      id: uuidv4(),
      instanceId: this.instanceId,
      type,
      payload,
      createdAt: new Date(),
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GasTownContentFactory | null = null;

export function getGasTownContentFactory(
  config?: Partial<ContentFactoryConfig>,
): GasTownContentFactory {
  if (!instance) {
    instance = new GasTownContentFactory(config);
    log.info('GasTownContentFactory singleton created');
  }
  return instance;
}
