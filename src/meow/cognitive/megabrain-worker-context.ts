/**
 * MEGABRAIN WORKER CONTEXT -- CG-021 (Stage 05 Wave 6)
 *
 * Inject relevant MegaBrain knowledge into worker context before task execution.
 *
 * Before a worker starts a bead, this module:
 *   1. Extracts keywords from bead description + assigned skill
 *   2. Queries megabrain_fragments with TF-IDF + recency scoring
 *   3. Composes a context window (max 3000 tokens) of injected knowledge
 *   4. Tracks which fragments were injected and outcome correlation
 *
 * Fragment categories:
 *   - heuristics: decision rules (IF-THEN patterns)
 *   - patterns: observed recurring behaviors
 *   - lessons_learned: post-mortem insights
 *   - domain_knowledge: factual reference data
 *
 * Worker-specific: only injects knowledge relevant to the worker's assigned skill.
 * LRU cache for hot fragments (max 500 entries).
 * Feedback loop: boost fragment relevance when bead succeeds.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, WorkerIdentity } from '../types';

const log = createLogger('megabrain-worker-context');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FragmentCategory =
  | 'heuristics'
  | 'patterns'
  | 'lessons_learned'
  | 'domain_knowledge';

export interface MegaBrainFragment {
  id: string;
  content: string;
  category: string;
  source: string;
  relevanceScore: number;
  recencyScore: number;
  combinedScore: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface InjectionRecord {
  id: string;
  beadId: string;
  workerId: string;
  fragmentIds: string[];
  totalTokensInjected: number;
  injectedAt: Date;
  beadOutcome?: 'success' | 'failure' | 'pending';
  outcomeRecordedAt?: Date;
}

export interface ContextWindow {
  fragments: MegaBrainFragment[];
  totalTokens: number;
  injectionId: string;
  composedText: string;
}

export interface ContextStats {
  totalInjections: number;
  avgFragmentsPerInjection: number;
  cacheHitRate: number;
  successCorrelation: number;
  topCategories: Record<string, number>;
}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// TF-IDF helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const len = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / len);
  }
  return tf;
}

function computeIDF(documents: string[][]): Map<string, number> {
  const docCount = documents.length || 1;
  const df = new Map<string, number>();
  for (const doc of documents) {
    const unique = new Set(doc);
    for (const t of unique) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [k, v] of df) {
    idf.set(k, Math.log((docCount + 1) / (v + 1)) + 1);
  }
  return idf;
}

function tfidfScore(queryTokens: string[], docTokens: string[], idf: Map<string, number>): number {
  const docTF = computeTF(docTokens);
  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTF.get(qt) ?? 0;
    const idfVal = idf.get(qt) ?? 1;
    score += tf * idfVal;
  }
  return score;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

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
              content: 'You are a knowledge relevance engine. Given a task description and a set of knowledge fragments, rank them by relevance. Respond with valid JSON only.',
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
    log.warn({ err }, 'Gemini call failed in megabrain-worker-context');
    return null;
  }
}

// ---------------------------------------------------------------------------
// MegaBrainWorkerContext
// ---------------------------------------------------------------------------

export class MegaBrainWorkerContext {
  private fragmentCache = new LRUCache<string, MegaBrainFragment>(500);
  private injections: InjectionRecord[] = [];
  private maxInjections = 10_000;
  private cacheHits = 0;
  private cacheMisses = 0;

  private static readonly MAX_CONTEXT_TOKENS = 3000;
  private static readonly RECENCY_DECAY_DAYS = 30;
  private static readonly RELEVANT_CATEGORIES: FragmentCategory[] = [
    'heuristics',
    'patterns',
    'lessons_learned',
    'domain_knowledge',
  ];

  // --- Build context window for a worker + bead ----------------------------

  async buildContextWindow(
    bead: Bead,
    worker: WorkerIdentity,
  ): Promise<ContextWindow> {
    const injectionId = uuidv4();
    const keywords = this.extractKeywords(bead, worker);

    log.info(
      { beadId: bead.id, workerId: worker.id, keywordCount: keywords.length },
      'Building MegaBrain context window',
    );

    // Fetch candidate fragments
    const candidates = await this.fetchCandidateFragments(keywords, bead.skill);

    // Score and rank
    const scored = this.scoreFragments(candidates, keywords);

    // Compose window within token budget
    const window = this.composeWindow(scored, injectionId);

    // Record injection
    const record: InjectionRecord = {
      id: injectionId,
      beadId: bead.id,
      workerId: worker.id,
      fragmentIds: window.fragments.map(f => f.id),
      totalTokensInjected: window.totalTokens,
      injectedAt: new Date(),
      beadOutcome: 'pending',
    };
    this.injections.push(record);
    if (this.injections.length > this.maxInjections) {
      this.injections = this.injections.slice(-this.maxInjections);
    }

    // Persist injection record
    await this.persistInjection(record);

    broadcast('meow:cognitive', {
      type: 'megabrain_context_injected',
      beadId: bead.id,
      workerId: worker.id,
      fragmentCount: window.fragments.length,
      totalTokens: window.totalTokens,
      injectionId,
    });

    return window;
  }

  // --- Record bead outcome for feedback loop --------------------------------

  async recordBeadOutcome(
    beadId: string,
    success: boolean,
  ): Promise<void> {
    const outcome = success ? 'success' : 'failure';
    const now = new Date();

    // Find injection records for this bead
    const records = this.injections.filter(r => r.beadId === beadId && r.beadOutcome === 'pending');

    for (const record of records) {
      record.beadOutcome = outcome;
      record.outcomeRecordedAt = now;

      // If success, boost fragment relevance scores
      if (success) {
        await this.boostFragments(record.fragmentIds, 0.05);
      }
    }

    // Persist outcome update
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE meow_context_injections
           SET bead_outcome = $1, outcome_recorded_at = $2
           WHERE bead_id = $3 AND bead_outcome = 'pending'`,
          [outcome, now.toISOString(), beadId],
        );
      } catch (err) {
        log.warn({ err, beadId }, 'Failed to update injection outcome in DB');
      }
    }

    broadcast('meow:cognitive', {
      type: 'megabrain_outcome_recorded',
      beadId,
      outcome,
      injectionCount: records.length,
    });
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): ContextStats {
    const totalInjections = this.injections.length;
    const avgFragments = totalInjections > 0
      ? Math.round(
          (this.injections.reduce((s, r) => s + r.fragmentIds.length, 0) / totalInjections) * 10,
        ) / 10
      : 0;

    const totalCacheOps = this.cacheHits + this.cacheMisses;
    const cacheHitRate = totalCacheOps > 0
      ? Math.round((this.cacheHits / totalCacheOps) * 1000) / 1000
      : 0;

    // Success correlation: of injections where outcome is known, what % succeeded
    const resolved = this.injections.filter(r => r.beadOutcome !== 'pending');
    const successes = resolved.filter(r => r.beadOutcome === 'success').length;
    const successCorrelation = resolved.length > 0
      ? Math.round((successes / resolved.length) * 1000) / 1000
      : 0;

    // Top categories from cached fragments
    const topCategories: Record<string, number> = {};
    for (const record of this.injections.slice(-500)) {
      for (const fid of record.fragmentIds) {
        const frag = this.fragmentCache.get(fid);
        if (frag) {
          topCategories[frag.category] = (topCategories[frag.category] ?? 0) + 1;
        }
      }
    }

    return {
      totalInjections,
      avgFragmentsPerInjection: avgFragments,
      cacheHitRate,
      successCorrelation,
      topCategories,
    };
  }

  // --- Clear cache ----------------------------------------------------------

  clearCache(): void {
    this.fragmentCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    log.info('Fragment cache cleared');
  }

  // --- Private helpers ------------------------------------------------------

  private extractKeywords(bead: Bead, worker: WorkerIdentity): string[] {
    const parts: string[] = [];

    if (bead.description) parts.push(bead.description);
    if (bead.title) parts.push(bead.title);
    if (bead.skill) parts.push(bead.skill);
    if (bead.formula) parts.push(bead.formula);
    if (bead.bu) parts.push(bead.bu);
    if (bead.labels) {
      for (const val of Object.values(bead.labels)) {
        parts.push(val);
      }
    }

    // Worker-specific context
    if (worker.name) parts.push(worker.name);
    if (worker.agentDefId) parts.push(worker.agentDefId);

    return tokenize(parts.join(' '));
  }

  private async fetchCandidateFragments(
    keywords: string[],
    skill?: string,
  ): Promise<MegaBrainFragment[]> {
    const fragments: MegaBrainFragment[] = [];
    const pool = getPool();

    if (pool) {
      try {
        // Build search query using keywords
        const searchTerms = keywords.slice(0, 15).join(' | ');

        const { rows } = await pool.query(
          `SELECT id, content, category, source, metadata, created_at
           FROM megabrain_fragments
           WHERE (
             content ILIKE ANY(ARRAY[${keywords.slice(0, 10).map((_, i) => `'%' || $${i + 1} || '%'`).join(',')}])
             OR category IN ('heuristics', 'patterns', 'lessons_learned', 'domain_knowledge', 'meow_pattern')
           )
           ORDER BY created_at DESC
           LIMIT 100`,
          keywords.slice(0, 10),
        );

        for (const r of rows as Array<Record<string, unknown>>) {
          const id = r.id as string;

          // Check cache first
          if (this.fragmentCache.has(id)) {
            this.cacheHits++;
            fragments.push(this.fragmentCache.get(id)!);
            continue;
          }

          this.cacheMisses++;

          const frag: MegaBrainFragment = {
            id,
            content: (r.content as string) ?? '',
            category: (r.category as string) ?? 'domain_knowledge',
            source: (r.source as string) ?? '',
            relevanceScore: 0,
            recencyScore: 0,
            combinedScore: 0,
            createdAt: new Date((r.created_at as string) ?? Date.now()),
            metadata: typeof r.metadata === 'string'
              ? JSON.parse(r.metadata)
              : (r.metadata as Record<string, unknown>) ?? {},
          };

          this.fragmentCache.set(id, frag);
          fragments.push(frag);
        }

        // Skill-specific query if skill provided
        if (skill) {
          const { rows: skillRows } = await pool.query(
            `SELECT id, content, category, source, metadata, created_at
             FROM megabrain_fragments
             WHERE content ILIKE '%' || $1 || '%'
             ORDER BY created_at DESC
             LIMIT 30`,
            [skill],
          );

          for (const r of skillRows as Array<Record<string, unknown>>) {
            const id = r.id as string;
            if (fragments.some(f => f.id === id)) continue;

            if (this.fragmentCache.has(id)) {
              this.cacheHits++;
              fragments.push(this.fragmentCache.get(id)!);
              continue;
            }

            this.cacheMisses++;

            const frag: MegaBrainFragment = {
              id,
              content: (r.content as string) ?? '',
              category: (r.category as string) ?? 'domain_knowledge',
              source: (r.source as string) ?? '',
              relevanceScore: 0,
              recencyScore: 0,
              combinedScore: 0,
              createdAt: new Date((r.created_at as string) ?? Date.now()),
              metadata: typeof r.metadata === 'string'
                ? JSON.parse(r.metadata)
                : (r.metadata as Record<string, unknown>) ?? {},
            };

            this.fragmentCache.set(id, frag);
            fragments.push(frag);
          }
        }
      } catch (err) {
        log.warn({ err }, 'Failed to fetch candidate fragments from DB');
      }
    }

    // Fallback: return whatever is in cache if DB failed
    if (fragments.length === 0) {
      log.info('No DB fragments, using heuristic empty context');
    }

    return fragments;
  }

  private scoreFragments(
    fragments: MegaBrainFragment[],
    queryKeywords: string[],
  ): MegaBrainFragment[] {
    if (fragments.length === 0) return [];

    const now = Date.now();
    const decayMs = MegaBrainWorkerContext.RECENCY_DECAY_DAYS * 24 * 60 * 60 * 1000;

    // Prepare TF-IDF
    const docTokens = fragments.map(f => tokenize(f.content));
    const idf = computeIDF(docTokens);

    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments[i];

      // TF-IDF relevance
      frag.relevanceScore = tfidfScore(queryKeywords, docTokens[i], idf);

      // Recency score: exponential decay
      const age = now - frag.createdAt.getTime();
      frag.recencyScore = Math.exp(-age / decayMs);

      // Category bonus
      let categoryBonus = 0;
      if (frag.category === 'heuristics') categoryBonus = 0.15;
      else if (frag.category === 'patterns' || frag.category === 'meow_pattern') categoryBonus = 0.10;
      else if (frag.category === 'lessons_learned') categoryBonus = 0.12;
      else if (frag.category === 'domain_knowledge') categoryBonus = 0.05;

      // Combined: 60% relevance, 25% recency, 15% category
      frag.combinedScore =
        frag.relevanceScore * 0.60 +
        frag.recencyScore * 0.25 +
        categoryBonus;
    }

    // Sort by combined score descending
    return fragments.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  private composeWindow(
    rankedFragments: MegaBrainFragment[],
    injectionId: string,
  ): ContextWindow {
    const selected: MegaBrainFragment[] = [];
    let totalTokens = 0;
    const maxTokens = MegaBrainWorkerContext.MAX_CONTEXT_TOKENS;

    // Header tokens
    const header = '=== MEGABRAIN KNOWLEDGE INJECTION ===\n';
    totalTokens += estimateTokens(header);

    for (const frag of rankedFragments) {
      const fragText = this.formatFragment(frag, selected.length + 1);
      const fragTokens = estimateTokens(fragText);

      if (totalTokens + fragTokens > maxTokens) break;

      selected.push(frag);
      totalTokens += fragTokens;
    }

    // Compose text
    let composedText = header;
    if (selected.length === 0) {
      composedText += '(No relevant knowledge fragments found)\n';
    } else {
      composedText += `Injecting ${selected.length} relevant fragments (${totalTokens} tokens):\n\n`;
      for (let i = 0; i < selected.length; i++) {
        composedText += this.formatFragment(selected[i], i + 1) + '\n';
      }
    }

    return {
      fragments: selected,
      totalTokens,
      injectionId,
      composedText,
    };
  }

  private formatFragment(frag: MegaBrainFragment, index: number): string {
    const catLabel = frag.category.toUpperCase().replace(/_/g, ' ');
    const score = Math.round(frag.combinedScore * 100) / 100;
    const content = frag.content.length > 500
      ? frag.content.slice(0, 497) + '...'
      : frag.content;

    return `[${index}] [${catLabel}] (score: ${score})\n${content}\n---`;
  }

  private async boostFragments(fragmentIds: string[], boostAmount: number): Promise<void> {
    const pool = getPool();
    if (!pool || fragmentIds.length === 0) return;

    try {
      // Update relevance_score in megabrain_fragments metadata
      await pool.query(
        `UPDATE megabrain_fragments
         SET metadata = jsonb_set(
           COALESCE(metadata::jsonb, '{}'::jsonb),
           '{relevance_boost}',
           to_jsonb(COALESCE((metadata::jsonb->>'relevance_boost')::numeric, 0) + $1)
         )
         WHERE id = ANY($2::text[])`,
        [boostAmount, fragmentIds],
      );

      log.info(
        { fragmentCount: fragmentIds.length, boostAmount },
        'Boosted fragment relevance scores',
      );
    } catch (err) {
      log.warn({ err }, 'Failed to boost fragment scores in DB');
    }
  }

  private async persistInjection(record: InjectionRecord): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_context_injections
          (id, bead_id, worker_id, fragment_ids, total_tokens, injected_at, bead_outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          record.id,
          record.beadId,
          record.workerId,
          JSON.stringify(record.fragmentIds),
          record.totalTokensInjected,
          record.injectedAt.toISOString(),
          record.beadOutcome,
        ],
      );
    } catch (err) {
      log.warn({ err, injectionId: record.id }, 'Failed to persist injection record');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: MegaBrainWorkerContext | null = null;

export function getMegaBrainWorkerContext(): MegaBrainWorkerContext {
  if (!instance) {
    instance = new MegaBrainWorkerContext();
    log.info('MegaBrainWorkerContext singleton created');
  }
  return instance;
}
