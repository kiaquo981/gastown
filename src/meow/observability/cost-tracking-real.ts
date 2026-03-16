/**
 * REAL COST TRACKING — LP-036 (Stage 04 Wave 8)
 *
 * Tracks every external API call cost with per-provider pricing.
 * Aggregation: per-call, per-step, per-molecule, per-worker, per-day.
 * Persists to Supabase `meow_cost_log` table.
 * Broadcasts updates via 'meow:costs'.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CostProvider =
  | 'gemini'
  | 'elevenlabs'
  | 'fal'
  | 'heygen'
  | 'meta_ads'
  | 'openrouter'
  | 'other';

export interface CostEntry {
  id: string;
  provider: CostProvider;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number;              // characters (ElevenLabs), images (Fal), minutes (HeyGen)
  costUsd: number;
  moleculeId?: string;
  workerId?: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface CostBreakdown {
  provider: CostProvider;
  model?: string;
  totalCostUsd: number;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUnits: number;
}

export interface DailyCostSummary {
  date: string;               // YYYY-MM-DD
  byProvider: Record<string, CostBreakdown>;
  totalUsd: number;
  callCount: number;
}

export interface BudgetStatus {
  spent: number;
  limit: number;
  remaining: number;
  projectedMonthly: number;
  utilizationPct: number;
  daysInPeriod: number;
  daysElapsed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing tables (USD)
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_PRICING: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  'gemini-2.0-flash':      { inputPer1K: 0.00025, outputPer1K: 0.001 },
  'gemini-2.0-flash-lite': { inputPer1K: 0.000125, outputPer1K: 0.0005 },
  'gemini-1.5-pro':        { inputPer1K: 0.00125, outputPer1K: 0.005 },
  default:                  { inputPer1K: 0.00025, outputPer1K: 0.001 },
};

const ELEVENLABS_RATE_PER_CHAR = 0.00003;   // ~$0.30 per 10K characters
const FAL_RATE_PER_IMAGE       = 0.04;       // FLUX schnell avg
const HEYGEN_RATE_PER_MINUTE   = 0.10;       // avatar video

// ─────────────────────────────────────────────────────────────────────────────
// RealCostTracker
// ─────────────────────────────────────────────────────────────────────────────

export class RealCostTracker {
  private entries: CostEntry[] = [];
  private monthlyBudgetUsd: number;
  private maxInMemory = 10_000;

  constructor(monthlyBudgetUsd = 500) {
    this.monthlyBudgetUsd = monthlyBudgetUsd;
  }

  // ─── Cost calculation ────────────────────────────────────────────────

  private computeCost(
    provider: CostProvider,
    model?: string,
    inputTokens?: number,
    outputTokens?: number,
    units?: number,
  ): number {
    switch (provider) {
      case 'gemini':
      case 'openrouter': {
        const pricing = GEMINI_PRICING[model ?? 'default'] ?? GEMINI_PRICING.default;
        const inCost = ((inputTokens ?? 0) / 1000) * pricing.inputPer1K;
        const outCost = ((outputTokens ?? 0) / 1000) * pricing.outputPer1K;
        return inCost + outCost;
      }
      case 'elevenlabs':
        return (units ?? 0) * ELEVENLABS_RATE_PER_CHAR;
      case 'fal':
        return (units ?? 0) * FAL_RATE_PER_IMAGE;
      case 'heygen':
        return (units ?? 0) * HEYGEN_RATE_PER_MINUTE;
      case 'meta_ads':
        return 0; // API calls are free; ad spend tracked separately
      default:
        return 0;
    }
  }

  // ─── Track a call ────────────────────────────────────────────────────

  async trackCall(
    provider: CostProvider,
    model: string | undefined,
    tokens: { input?: number; output?: number; units?: number },
    ids?: { moleculeId?: string; workerId?: string; stepId?: string },
    metadata?: Record<string, unknown>,
  ): Promise<CostEntry> {
    const costUsd = this.computeCost(
      provider,
      model,
      tokens.input,
      tokens.output,
      tokens.units,
    );

    const entry: CostEntry = {
      id: uuidv4(),
      provider,
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      units: tokens.units,
      costUsd,
      moleculeId: ids?.moleculeId,
      workerId: ids?.workerId,
      stepId: ids?.stepId,
      metadata,
      timestamp: new Date(),
    };

    // In-memory buffer with eviction
    this.entries.push(entry);
    if (this.entries.length > this.maxInMemory) {
      this.entries = this.entries.slice(-this.maxInMemory);
    }

    // Persist to DB
    await this.persistEntry(entry);

    // Broadcast update
    broadcast('meow:costs', {
      type: 'cost_tracked',
      entry: {
        id: entry.id,
        provider: entry.provider,
        costUsd: entry.costUsd,
        moleculeId: entry.moleculeId,
        timestamp: entry.timestamp.toISOString(),
      },
    });

    return entry;
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  getCostsByMolecule(moleculeId: string): CostBreakdown[] {
    const filtered = this.entries.filter(e => e.moleculeId === moleculeId);
    return this.aggregate(filtered);
  }

  getCostsByWorker(workerId: string): CostBreakdown[] {
    const filtered = this.entries.filter(e => e.workerId === workerId);
    return this.aggregate(filtered);
  }

  getDailyCosts(date?: Date): DailyCostSummary {
    const target = date ?? new Date();
    const dateStr = target.toISOString().slice(0, 10);
    const filtered = this.entries.filter(
      e => e.timestamp.toISOString().slice(0, 10) === dateStr,
    );

    const byProvider: Record<string, CostBreakdown> = {};
    let totalUsd = 0;

    for (const entry of filtered) {
      const key = entry.provider;
      if (!byProvider[key]) {
        byProvider[key] = {
          provider: entry.provider,
          model: entry.model,
          totalCostUsd: 0,
          callCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalUnits: 0,
        };
      }
      byProvider[key].totalCostUsd += entry.costUsd;
      byProvider[key].callCount += 1;
      byProvider[key].totalInputTokens += entry.inputTokens ?? 0;
      byProvider[key].totalOutputTokens += entry.outputTokens ?? 0;
      byProvider[key].totalUnits += entry.units ?? 0;
      totalUsd += entry.costUsd;
    }

    return { date: dateStr, byProvider, totalUsd, callCount: filtered.length };
  }

  getTotalCost(since?: Date): number {
    const cutoff = since ?? new Date(0);
    return this.entries
      .filter(e => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  getBudgetStatus(): BudgetStatus {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = Math.max(1, now.getDate());
    const spent = this.getTotalCost(monthStart);
    const dailyRate = spent / daysElapsed;
    const projectedMonthly = dailyRate * daysInMonth;

    return {
      spent: Math.round(spent * 100) / 100,
      limit: this.monthlyBudgetUsd,
      remaining: Math.round((this.monthlyBudgetUsd - spent) * 100) / 100,
      projectedMonthly: Math.round(projectedMonthly * 100) / 100,
      utilizationPct: Math.round((spent / this.monthlyBudgetUsd) * 10000) / 100,
      daysInPeriod: daysInMonth,
      daysElapsed,
    };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private aggregate(entries: CostEntry[]): CostBreakdown[] {
    const map = new Map<string, CostBreakdown>();

    for (const e of entries) {
      const key = `${e.provider}::${e.model ?? 'default'}`;
      const existing = map.get(key);
      if (existing) {
        existing.totalCostUsd += e.costUsd;
        existing.callCount += 1;
        existing.totalInputTokens += e.inputTokens ?? 0;
        existing.totalOutputTokens += e.outputTokens ?? 0;
        existing.totalUnits += e.units ?? 0;
      } else {
        map.set(key, {
          provider: e.provider,
          model: e.model,
          totalCostUsd: e.costUsd,
          callCount: 1,
          totalInputTokens: e.inputTokens ?? 0,
          totalOutputTokens: e.outputTokens ?? 0,
          totalUnits: e.units ?? 0,
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  private async persistEntry(entry: CostEntry): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_cost_log
          (id, provider, model, input_tokens, output_tokens, units, cost_usd,
           molecule_id, worker_id, step_id, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          entry.id,
          entry.provider,
          entry.model ?? null,
          entry.inputTokens ?? 0,
          entry.outputTokens ?? 0,
          entry.units ?? 0,
          entry.costUsd,
          entry.moleculeId ?? null,
          entry.workerId ?? null,
          entry.stepId ?? null,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          entry.timestamp.toISOString(),
        ],
      );
    } catch (err) {
      console.error('[CostTracker] Failed to persist cost entry:', err);
    }
  }

  /** Load historical entries from DB on startup */
  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      const { rows } = await pool.query(
        `SELECT id, provider, model, input_tokens, output_tokens, units, cost_usd,
                molecule_id, worker_id, step_id, metadata, created_at
         FROM meow_cost_log
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [since.toISOString(), this.maxInMemory],
      );

      this.entries = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        provider: r.provider as CostProvider,
        model: (r.model as string) ?? undefined,
        inputTokens: r.input_tokens as number,
        outputTokens: r.output_tokens as number,
        units: r.units as number,
        costUsd: parseFloat(r.cost_usd as string),
        moleculeId: (r.molecule_id as string) ?? undefined,
        workerId: (r.worker_id as string) ?? undefined,
        stepId: (r.step_id as string) ?? undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
        timestamp: new Date(r.created_at as string),
      }));

      console.info(`[CostTracker] Loaded ${this.entries.length} cost entries from DB`);
    } catch (err) {
      console.error('[CostTracker] Failed to load from DB:', err);
    }
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}
