/**
 * LP-001 — Gemini Executor (Real Execution Engine)
 *
 * Real Gemini execution with tier-based model selection and cost tracking.
 * Tier mapping: S -> gemini-2.0-flash (opus-equivalent), A -> gemini-2.0-flash, B -> gemini-2.0-flash-lite
 * Persists costs to Supabase `meow_cost_log` + in-memory aggregation.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('gemini-executor');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/** Tier to Gemini model mapping */
const TIER_MODEL_MAP: Record<string, string> = {
  S: 'gemini-2.0-flash',
  A: 'gemini-2.0-flash',
  B: 'gemini-2.0-flash-lite',
};

/** Approximate cost per 1M tokens (USD) — Gemini pricing as of 2026 */
const COST_PER_1M_INPUT: Record<string, number> = {
  'gemini-2.0-flash': 0.10,
  'gemini-2.0-flash-lite': 0.02,
};

const COST_PER_1M_OUTPUT: Record<string, number> = {
  'gemini-2.0-flash': 0.40,
  'gemini-2.0-flash-lite': 0.10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export interface GeminiResult {
  result: string;
  usage: GeminiUsage;
}

export interface GeminiCallMetadata {
  moleculeId?: string;
  stepId?: string;
  workerId?: string;
  beadId?: string;
  skillName?: string;
}

interface CostEntry {
  moleculeId?: string;
  workerId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: Date;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cost tracking
// ─────────────────────────────────────────────────────────────────────────────

/** All cost entries (global) */
const costLog: CostEntry[] = [];

/** Per-molecule aggregated costs */
const moleculeCosts = new Map<string, CostEntry[]>();

/** Per-worker aggregated costs */
const workerCosts = new Map<string, CostEntry[]>();

// ─────────────────────────────────────────────────────────────────────────────
// Cost calculation
// ─────────────────────────────────────────────────────────────────────────────

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const inputRate = COST_PER_1M_INPUT[model] || COST_PER_1M_INPUT['gemini-2.0-flash'];
  const outputRate = COST_PER_1M_OUTPUT[model] || COST_PER_1M_OUTPUT['gemini-2.0-flash'];
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost persistence
// ─────────────────────────────────────────────────────────────────────────────

async function persistCost(entry: CostEntry, metadata?: GeminiCallMetadata): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO meow_cost_log (
        molecule_id, worker_id, model, input_tokens, output_tokens,
        cost_usd, bead_id, skill_name, step_id, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.moleculeId || null,
        entry.workerId || null,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        metadata?.beadId || null,
        metadata?.skillName || null,
        metadata?.stepId || null,
        entry.recordedAt,
      ]
    );
  } catch (err) {
    // Table may not exist yet — log and continue
    log.warn({ err }, 'Failed to persist cost to meow_cost_log (table may not exist)');
  }
}

function recordCostInMemory(entry: CostEntry): void {
  costLog.push(entry);

  // Cap in-memory log at 10,000 entries
  if (costLog.length > 10_000) {
    costLog.splice(0, costLog.length - 8_000);
  }

  if (entry.moleculeId) {
    const existing = moleculeCosts.get(entry.moleculeId) || [];
    existing.push(entry);
    moleculeCosts.set(entry.moleculeId, existing);
  }

  if (entry.workerId) {
    const existing = workerCosts.get(entry.workerId) || [];
    existing.push(entry);
    workerCosts.set(entry.workerId, existing);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main execution function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a Gemini LLM call with tier-based model selection and cost tracking.
 *
 * @param prompt - The user message / prompt
 * @param systemPrompt - System instruction for the model
 * @param tier - Agent tier: S, A, or B (determines model)
 * @param metadata - Optional tracking metadata (moleculeId, workerId, etc.)
 * @returns Result text and token usage with cost
 */
export async function executeWithGemini(
  prompt: string,
  systemPrompt: string,
  tier: 'S' | 'A' | 'B' = 'A',
  metadata?: GeminiCallMetadata,
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('No GEMINI_API_KEY — returning simulated response');
    return {
      result: `[GEMINI_API_KEY not set] Simulated response for tier ${tier}: ${prompt.slice(0, 100)}...`,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'simulated' },
    };
  }

  const model = TIER_MODEL_MAP[tier] || 'gemini-2.0-flash';
  const startMs = Date.now();

  log.info({
    tier,
    model,
    promptLen: prompt.length,
    moleculeId: metadata?.moleculeId,
    workerId: metadata?.workerId,
  }, 'Executing Gemini call');

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: tier === 'S' ? 8192 : tier === 'A' ? 4096 : 2048,
        temperature: tier === 'S' ? 0.3 : tier === 'A' ? 0.5 : 0.7,
      }),
    });

    const durationMs = Date.now() - startMs;

    if (!response.ok) {
      const errorText = await response.text();
      log.error({ status: response.status, body: errorText.slice(0, 300), model }, 'Gemini API error');
      throw new Error(`Gemini API returned ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const resultText = data.choices?.[0]?.message?.content || '';
    const inputTokens = data.usage?.prompt_tokens || Math.ceil(prompt.length / 4);
    const outputTokens = data.usage?.completion_tokens || Math.ceil(resultText.length / 4);
    const costUsd = calculateCost(model, inputTokens, outputTokens);

    // Record cost
    const costEntry: CostEntry = {
      moleculeId: metadata?.moleculeId,
      workerId: metadata?.workerId,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      recordedAt: new Date(),
    };

    recordCostInMemory(costEntry);
    persistCost(costEntry, metadata).catch(() => {}); // fire-and-forget

    // Broadcast execution event
    broadcast('meow:feed', {
      type: 'system_health',
      source: 'gemini-executor',
      message: `Gemini ${model} call completed (${durationMs}ms, ${inputTokens}+${outputTokens} tokens, $${costUsd.toFixed(6)})`,
      severity: 'info',
      metadata: {
        model,
        tier,
        durationMs,
        inputTokens,
        outputTokens,
        costUsd,
        moleculeId: metadata?.moleculeId,
        workerId: metadata?.workerId,
      },
      timestamp: new Date(),
    });

    log.info({
      model,
      tier,
      durationMs,
      inputTokens,
      outputTokens,
      costUsd,
      resultLen: resultText.length,
    }, 'Gemini call completed');

    return {
      result: resultText,
      usage: { inputTokens, outputTokens, costUsd, model },
    };

  } catch (err) {
    const durationMs = Date.now() - startMs;
    const error = err instanceof Error ? err.message : String(err);

    log.error({ err, model, tier, durationMs }, 'Gemini execution failed');

    broadcast('meow:feed', {
      type: 'worker_error',
      source: 'gemini-executor',
      message: `Gemini ${model} call failed after ${durationMs}ms: ${error}`,
      severity: 'error',
      metadata: { model, tier, error, moleculeId: metadata?.moleculeId },
      timestamp: new Date(),
    });

    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-turn conversation support
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Execute a multi-turn Gemini call with full conversation history.
 */
export async function executeConversation(
  messages: ConversationMessage[],
  tier: 'S' | 'A' | 'B' = 'A',
  metadata?: GeminiCallMetadata,
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      result: `[GEMINI_API_KEY not set] Simulated conversation response`,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: 'simulated' },
    };
  }

  const model = TIER_MODEL_MAP[tier] || 'gemini-2.0-flash';
  const startMs = Date.now();

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: tier === 'S' ? 8192 : tier === 'A' ? 4096 : 2048,
        temperature: tier === 'S' ? 0.3 : 0.5,
      }),
    });

    const durationMs = Date.now() - startMs;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API returned ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const resultText = data.choices?.[0]?.message?.content || '';
    const totalPromptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const inputTokens = data.usage?.prompt_tokens || Math.ceil(totalPromptChars / 4);
    const outputTokens = data.usage?.completion_tokens || Math.ceil(resultText.length / 4);
    const costUsd = calculateCost(model, inputTokens, outputTokens);

    const costEntry: CostEntry = {
      moleculeId: metadata?.moleculeId,
      workerId: metadata?.workerId,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      recordedAt: new Date(),
    };

    recordCostInMemory(costEntry);
    persistCost(costEntry, metadata).catch(() => {});

    log.info({ model, durationMs, inputTokens, outputTokens, costUsd }, 'Conversation call completed');

    return {
      result: resultText,
      usage: { inputTokens, outputTokens, costUsd, model },
    };

  } catch (err) {
    log.error({ err, model, tier }, 'Conversation execution failed');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost summary / reporting
// ─────────────────────────────────────────────────────────────────────────────

function aggregateEntries(entries: CostEntry[]): CostSummary {
  const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const entry of entries) {
    totalInputTokens += entry.inputTokens;
    totalOutputTokens += entry.outputTokens;
    totalCostUsd += entry.costUsd;

    if (!byModel[entry.model]) {
      byModel[entry.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
    }
    byModel[entry.model].inputTokens += entry.inputTokens;
    byModel[entry.model].outputTokens += entry.outputTokens;
    byModel[entry.model].costUsd += entry.costUsd;
    byModel[entry.model].calls += 1;
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    callCount: entries.length,
    byModel,
  };
}

/**
 * Get cost summary, optionally filtered by moleculeId.
 */
export function getCostSummary(moleculeId?: string): CostSummary {
  if (moleculeId) {
    const entries = moleculeCosts.get(moleculeId) || [];
    return aggregateEntries(entries);
  }
  return aggregateEntries(costLog);
}

/**
 * Get cost summary for a specific worker.
 */
export function getWorkerCostSummary(workerId: string): CostSummary {
  const entries = workerCosts.get(workerId) || [];
  return aggregateEntries(entries);
}

/**
 * Get the top cost consumers (molecules or workers) sorted by cost descending.
 */
export function getTopCostConsumers(
  dimension: 'molecule' | 'worker',
  limit: number = 20,
): Array<{ id: string; summary: CostSummary }> {
  const source = dimension === 'molecule' ? moleculeCosts : workerCosts;
  const results: Array<{ id: string; summary: CostSummary }> = [];

  for (const [id, entries] of source) {
    results.push({ id, summary: aggregateEntries(entries) });
  }

  return results
    .sort((a, b) => b.summary.totalCostUsd - a.summary.totalCostUsd)
    .slice(0, limit);
}

/**
 * Fetch cost summary from Supabase for longer-term historical data.
 */
export async function getCostSummaryFromDB(filters?: {
  moleculeId?: string;
  workerId?: string;
  since?: Date;
}): Promise<CostSummary> {
  const pool = getPool();
  if (!pool) return aggregateEntries([]);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.moleculeId) {
    conditions.push(`molecule_id = $${paramIdx++}`);
    params.push(filters.moleculeId);
  }
  if (filters?.workerId) {
    conditions.push(`worker_id = $${paramIdx++}`);
    params.push(filters.workerId);
  }
  if (filters?.since) {
    conditions.push(`recorded_at >= $${paramIdx++}`);
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT
        COALESCE(SUM(input_tokens), 0)::int AS total_input,
        COALESCE(SUM(output_tokens), 0)::int AS total_output,
        COALESCE(SUM(cost_usd), 0)::float AS total_cost,
        COUNT(*)::int AS call_count,
        model
       FROM meow_cost_log ${where}
       GROUP BY model`,
      params,
    );

    const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    let callCount = 0;

    for (const row of rows) {
      const m = row.model as string;
      byModel[m] = {
        inputTokens: row.total_input,
        outputTokens: row.total_output,
        costUsd: row.total_cost,
        calls: row.call_count,
      };
      totalInputTokens += row.total_input;
      totalOutputTokens += row.total_output;
      totalCostUsd += row.total_cost;
      callCount += row.call_count;
    }

    return { totalInputTokens, totalOutputTokens, totalCostUsd, callCount, byModel };
  } catch (err) {
    log.warn({ err }, 'Failed to fetch cost summary from DB');
    return aggregateEntries([]);
  }
}
