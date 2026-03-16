/**
 * WORKER PERSISTENT MEMORY — SG-017 (Stage 06 Wave 5)
 *
 * Workers maintain episodic memory across sessions.
 * Each worker accumulates knowledge from past tasks — what worked,
 * what failed, patterns discovered, and preferences developed.
 *
 * Features:
 *   - Memory types: assignment_history, decisions_made, outcomes, learnings, preferences
 *   - On worker spawn: load relevant memories from DB (last 50 interactions)
 *   - On task completion: store new memories (what was done, outcome, lessons learned)
 *   - Memory consolidation: periodically merge short-term memories into long-term patterns
 *   - Context window budget: max 2000 tokens of memory injected into worker context
 *   - Relevance scoring: TF-IDF + recency to pick most relevant memories for current task
 *   - Forgetting curve: old memories decay unless reinforced by repetition
 *   - DB table: meow_worker_memory
 *   - Memory types tagged for easy filtering
 *   - Integration: memory loaded before task assignment
 *
 * Gas Town: "A worker who forgets the past is doomed to repeat its mistakes."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('worker-persistent-memory');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'assignment_history'
  | 'decisions_made'
  | 'outcomes'
  | 'learnings'
  | 'preferences';

export type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';

export type ConsolidationStatus = 'raw' | 'consolidated' | 'archived';

export interface WorkerMemory {
  id: string;
  workerId: string;
  type: MemoryType;
  importance: MemoryImportance;
  content: string;
  context: MemoryContext;
  relevanceScore: number;           // computed: TF-IDF + recency
  decayFactor: number;              // 0.0 - 1.0, decreases over time
  reinforcements: number;           // how many times this memory was accessed/reinforced
  consolidationStatus: ConsolidationStatus;
  parentMemoryId?: string;          // if consolidated from multiple memories
  tokenEstimate: number;            // estimated tokens for context injection
  tags: string[];
  createdAt: Date;
  lastAccessedAt: Date;
  lastReinforcedAt: Date;
}

export interface MemoryContext {
  taskId?: string;
  formulaName?: string;
  beadId?: string;
  moleculeId?: string;
  instanceId?: string;
  inputSummary?: string;
  outputSummary?: string;
  outcomePositive?: boolean;
  lessonsLearned?: string[];
  relatedMemoryIds?: string[];
}

export interface MemoryQuery {
  workerId: string;
  taskContext?: string;              // current task description for relevance matching
  types?: MemoryType[];
  minImportance?: MemoryImportance;
  maxTokenBudget?: number;           // default 2000
  limit?: number;
  includeArchived?: boolean;
}

export interface MemoryInjection {
  memories: WorkerMemory[];
  totalTokens: number;
  memoriesSkipped: number;
  relevanceThreshold: number;
}

export interface ConsolidationResult {
  workerId: string;
  memoriesProcessed: number;
  consolidated: number;
  archived: number;
  patternsFound: string[];
  aiUsed: boolean;
}

export interface WorkerMemoryStats {
  totalMemories: number;
  memoriesByType: Record<MemoryType, number>;
  memoriesByWorker: Record<string, number>;
  consolidationsRun: number;
  avgRelevanceScore: number;
  totalTokensStored: number;
  decayedCount: number;
  aiConsolidations: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MEMORIES_IN_CACHE = 5000;
const MAX_TOKEN_BUDGET = 2000;
const DEFAULT_LOAD_LIMIT = 50;
const DECAY_RATE_PER_DAY = 0.02;       // 2% per day
const REINFORCEMENT_BOOST = 0.15;
const MIN_DECAY_FACTOR = 0.05;
const CONSOLIDATION_THRESHOLD = 20;     // consolidate after 20 raw memories per type
const TOKEN_ESTIMATE_PER_CHAR = 0.3;    // rough estimate: 1 token ~ 3.3 chars
const MAX_MEMORY_AGE_DAYS = 365;
const IMPORTANCE_WEIGHTS: Record<MemoryImportance, number> = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
  critical: 4.0,
};

// ---------------------------------------------------------------------------
// TF-IDF helpers
// ---------------------------------------------------------------------------

interface TermFrequency {
  [term: string]: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function computeTF(tokens: string[]): TermFrequency {
  const tf: TermFrequency = {};
  for (const t of tokens) {
    tf[t] = (tf[t] ?? 0) + 1;
  }
  const max = Math.max(...Object.values(tf), 1);
  for (const t of Object.keys(tf)) {
    tf[t] = tf[t] / max;
  }
  return tf;
}

function computeIDF(documents: string[][]): TermFrequency {
  const idf: TermFrequency = {};
  const N = documents.length || 1;
  const allTerms = new Set(documents.flat());
  for (const term of allTerms) {
    const df = documents.filter(d => d.includes(term)).length;
    idf[term] = Math.log((N + 1) / (df + 1)) + 1;
  }
  return idf;
}

function tfidfScore(queryTokens: string[], docTokens: string[], idf: TermFrequency): number {
  const tf = computeTF(docTokens);
  let score = 0;
  for (const qt of queryTokens) {
    if (tf[qt] && idf[qt]) {
      score += tf[qt] * idf[qt];
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiMemory(prompt: string): Promise<string | null> {
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
                'You are a memory consolidation engine for an AI worker system. '
                + 'Analyze memories and extract patterns, lessons, and consolidated knowledge. '
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
    log.warn({ err }, 'Gemini memory call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// WorkerPersistentMemory
// ---------------------------------------------------------------------------

export class WorkerPersistentMemory {
  private cache = new Map<string, WorkerMemory>();          // id -> memory
  private workerIndex = new Map<string, Set<string>>();     // workerId -> memory IDs
  private stats: WorkerMemoryStats = {
    totalMemories: 0,
    memoriesByType: {
      assignment_history: 0,
      decisions_made: 0,
      outcomes: 0,
      learnings: 0,
      preferences: 0,
    },
    memoriesByWorker: {},
    consolidationsRun: 0,
    avgRelevanceScore: 0,
    totalTokensStored: 0,
    decayedCount: 0,
    aiConsolidations: 0,
  };
  private initialized = false;

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.loadRecentFromDb();
    this.initialized = true;

    log.info({
      cachedMemories: this.cache.size,
      workers: this.workerIndex.size,
    }, 'Worker persistent memory initialized');
  }

  // -------------------------------------------------------------------------
  // Load memories for a worker (on spawn)
  // -------------------------------------------------------------------------

  async loadWorkerMemories(
    workerId: string,
    limit = DEFAULT_LOAD_LIMIT,
  ): Promise<WorkerMemory[]> {
    // Try cache first
    const cached = this.getFromCache(workerId);
    if (cached.length >= limit) {
      return cached.slice(0, limit);
    }

    // Load from DB
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, worker_id, type, importance, content, context_json,
                  relevance_score, decay_factor, reinforcements,
                  consolidation_status, parent_memory_id, token_estimate,
                  tags, created_at, last_accessed_at, last_reinforced_at
           FROM meow_worker_memory
           WHERE worker_id = $1
             AND consolidation_status != 'archived'
             AND decay_factor > $2
           ORDER BY (relevance_score * decay_factor * CASE importance
             WHEN 'critical' THEN 4 WHEN 'high' THEN 2
             WHEN 'medium' THEN 1 ELSE 0.5 END) DESC
           LIMIT $3`,
          [workerId, MIN_DECAY_FACTOR, limit],
        );

        for (const row of rows) {
          const mem = this.rowToMemory(row);
          this.addToCache(mem);
        }
      } catch (err) {
        log.error({ err, workerId }, 'Failed to load worker memories from DB');
      }
    }

    return this.getFromCache(workerId).slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Store new memory (on task completion)
  // -------------------------------------------------------------------------

  async storeMemory(
    workerId: string,
    type: MemoryType,
    content: string,
    context: MemoryContext,
    importance: MemoryImportance = 'medium',
    tags: string[] = [],
  ): Promise<WorkerMemory> {
    const now = new Date();
    const tokenEstimate = Math.ceil(content.length * TOKEN_ESTIMATE_PER_CHAR);

    const memory: WorkerMemory = {
      id: uuidv4(),
      workerId,
      type,
      importance,
      content,
      context,
      relevanceScore: 1.0,
      decayFactor: 1.0,
      reinforcements: 0,
      consolidationStatus: 'raw',
      tokenEstimate,
      tags,
      createdAt: now,
      lastAccessedAt: now,
      lastReinforcedAt: now,
    };

    this.addToCache(memory);
    await this.persistMemory(memory);

    // Update stats
    this.stats.totalMemories += 1;
    this.stats.memoriesByType[type] = (this.stats.memoriesByType[type] ?? 0) + 1;
    this.stats.memoriesByWorker[workerId] = (this.stats.memoriesByWorker[workerId] ?? 0) + 1;
    this.stats.totalTokensStored += tokenEstimate;

    broadcast('meow:sovereign', {
      type: 'worker_memory:stored',
      workerId,
      memoryId: memory.id,
      memoryType: type,
      importance,
      tokenEstimate,
    });

    log.debug({
      workerId,
      memoryId: memory.id,
      memoryType: type,
      tokens: tokenEstimate,
    }, 'Worker memory stored');

    // Check if consolidation is needed
    const workerRaw = this.getFromCache(workerId)
      .filter(m => m.consolidationStatus === 'raw' && m.type === type);
    if (workerRaw.length >= CONSOLIDATION_THRESHOLD) {
      this.consolidateWorkerMemories(workerId, type).catch(err => {
        log.warn({ err, workerId, type }, 'Background consolidation failed');
      });
    }

    return memory;
  }

  // -------------------------------------------------------------------------
  // Query memories with relevance scoring for context injection
  // -------------------------------------------------------------------------

  async queryForInjection(query: MemoryQuery): Promise<MemoryInjection> {
    const maxTokens = query.maxTokenBudget ?? MAX_TOKEN_BUDGET;
    const memories = await this.loadWorkerMemories(query.workerId, query.limit ?? 100);

    // Filter by type and importance
    let filtered = memories;
    if (query.types && query.types.length > 0) {
      filtered = filtered.filter(m => query.types!.includes(m.type));
    }
    if (query.minImportance) {
      const minWeight = IMPORTANCE_WEIGHTS[query.minImportance];
      filtered = filtered.filter(m => IMPORTANCE_WEIGHTS[m.importance] >= minWeight);
    }
    if (!query.includeArchived) {
      filtered = filtered.filter(m => m.consolidationStatus !== 'archived');
    }

    // Score with TF-IDF + recency + importance
    if (query.taskContext) {
      const queryTokens = tokenize(query.taskContext);
      const allDocs = filtered.map(m => tokenize(m.content));
      const idf = computeIDF(allDocs);

      for (const mem of filtered) {
        const docTokens = tokenize(mem.content);
        const tfidf = tfidfScore(queryTokens, docTokens, idf);

        // Recency factor: newer memories score higher
        const ageHours = (Date.now() - mem.createdAt.getTime()) / 3_600_000;
        const recency = Math.max(0.1, 1 - (ageHours / (MAX_MEMORY_AGE_DAYS * 24)));

        // Combined score
        mem.relevanceScore = (tfidf * 0.5) + (recency * 0.25) +
          (IMPORTANCE_WEIGHTS[mem.importance] * 0.15) +
          (mem.decayFactor * 0.1);
      }
    }

    // Sort by relevance descending
    filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Greedy selection within token budget
    const selected: WorkerMemory[] = [];
    let usedTokens = 0;
    let skipped = 0;

    for (const mem of filtered) {
      if (usedTokens + mem.tokenEstimate > maxTokens) {
        skipped++;
        continue;
      }
      selected.push(mem);
      usedTokens += mem.tokenEstimate;

      // Reinforce accessed memories
      mem.lastAccessedAt = new Date();
      mem.reinforcements += 1;
      mem.lastReinforcedAt = new Date();
      mem.decayFactor = Math.min(1.0, mem.decayFactor + REINFORCEMENT_BOOST);
    }

    // Persist reinforcements in background
    this.persistReinforcementsBatch(selected).catch(err => {
      log.warn({ err }, 'Failed to persist memory reinforcements');
    });

    const threshold = selected.length > 0
      ? selected[selected.length - 1].relevanceScore
      : 0;

    return {
      memories: selected,
      totalTokens: usedTokens,
      memoriesSkipped: skipped,
      relevanceThreshold: threshold,
    };
  }

  // -------------------------------------------------------------------------
  // Memory consolidation: merge short-term into long-term patterns
  // -------------------------------------------------------------------------

  async consolidateWorkerMemories(
    workerId: string,
    type?: MemoryType,
  ): Promise<ConsolidationResult> {
    const memories = this.getFromCache(workerId)
      .filter(m => m.consolidationStatus === 'raw')
      .filter(m => !type || m.type === type);

    if (memories.length < 3) {
      return {
        workerId,
        memoriesProcessed: 0,
        consolidated: 0,
        archived: 0,
        patternsFound: [],
        aiUsed: false,
      };
    }

    // Group by type
    const groups = new Map<MemoryType, WorkerMemory[]>();
    for (const m of memories) {
      const g = groups.get(m.type) ?? [];
      g.push(m);
      groups.set(m.type, g);
    }

    let totalConsolidated = 0;
    let totalArchived = 0;
    const allPatterns: string[] = [];
    let aiUsed = false;

    for (const [memType, group] of groups) {
      if (group.length < 3) continue;

      // Try AI consolidation
      const prompt = JSON.stringify({
        task: 'consolidate_memories',
        workerId,
        memoryType: memType,
        memories: group.slice(0, 30).map(m => ({
          content: m.content,
          importance: m.importance,
          outcome: m.context.outcomePositive,
          tags: m.tags,
          age_hours: (Date.now() - m.createdAt.getTime()) / 3_600_000,
        })),
        instruction: 'Analyze these worker memories and extract: (1) recurring patterns, '
          + '(2) consolidated lessons, (3) key preferences. Return JSON: '
          + '{"patterns": ["string"], "consolidatedMemory": "string", '
          + '"importance": "low|medium|high|critical", "tags": ["string"]}',
      });

      const aiResponse = await callGeminiMemory(prompt);
      let consolidatedContent: string;
      let consolidatedImportance: MemoryImportance = 'medium';
      let consolidatedTags: string[] = [];

      if (aiResponse) {
        try {
          const match = aiResponse.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]) as {
              patterns?: string[];
              consolidatedMemory?: string;
              importance?: MemoryImportance;
              tags?: string[];
            };
            consolidatedContent = parsed.consolidatedMemory ?? this.heuristicConsolidate(group);
            consolidatedImportance = parsed.importance ?? 'medium';
            consolidatedTags = Array.isArray(parsed.tags) ? parsed.tags : [];
            if (parsed.patterns) allPatterns.push(...parsed.patterns);
            aiUsed = true;
          } else {
            consolidatedContent = this.heuristicConsolidate(group);
          }
        } catch {
          log.warn({ workerId, type: memType }, 'Failed to parse AI consolidation');
          consolidatedContent = this.heuristicConsolidate(group);
        }
      } else {
        consolidatedContent = this.heuristicConsolidate(group);
        allPatterns.push(`${memType}: ${group.length} memories consolidated heuristically`);
      }

      // Create consolidated memory
      const consolidatedMem: WorkerMemory = {
        id: uuidv4(),
        workerId,
        type: memType,
        importance: consolidatedImportance,
        content: consolidatedContent,
        context: {
          relatedMemoryIds: group.map(m => m.id),
        },
        relevanceScore: 1.0,
        decayFactor: 1.0,
        reinforcements: group.reduce((s, m) => s + m.reinforcements, 0),
        consolidationStatus: 'consolidated',
        tokenEstimate: Math.ceil(consolidatedContent.length * TOKEN_ESTIMATE_PER_CHAR),
        tags: [...new Set([...consolidatedTags, 'consolidated'])],
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        lastReinforcedAt: new Date(),
      };

      this.addToCache(consolidatedMem);
      await this.persistMemory(consolidatedMem);
      totalConsolidated += 1;

      // Archive the raw memories
      for (const m of group) {
        m.consolidationStatus = 'archived';
        this.cache.set(m.id, m);
        totalArchived += 1;
      }
      await this.archiveMemoriesBatch(group.map(m => m.id));
    }

    this.stats.consolidationsRun += 1;
    if (aiUsed) this.stats.aiConsolidations += 1;

    broadcast('meow:sovereign', {
      type: 'worker_memory:consolidated',
      workerId,
      memoriesProcessed: memories.length,
      consolidated: totalConsolidated,
      archived: totalArchived,
      patternsFound: allPatterns.length,
      aiUsed,
    });

    log.info({
      workerId,
      processed: memories.length,
      consolidated: totalConsolidated,
      archived: totalArchived,
      patterns: allPatterns.length,
    }, 'Memory consolidation complete');

    return {
      workerId,
      memoriesProcessed: memories.length,
      consolidated: totalConsolidated,
      archived: totalArchived,
      patternsFound: allPatterns,
      aiUsed,
    };
  }

  // -------------------------------------------------------------------------
  // Forgetting curve: apply decay to old memories
  // -------------------------------------------------------------------------

  async applyDecay(): Promise<{ decayed: number; forgotten: number }> {
    const now = Date.now();
    let decayed = 0;
    let forgotten = 0;

    for (const [id, mem] of this.cache) {
      if (mem.consolidationStatus === 'archived') continue;

      const daysSinceReinforced = (now - mem.lastReinforcedAt.getTime()) / 86_400_000;
      if (daysSinceReinforced < 1) continue;

      // Apply exponential decay: faster for low importance, slower for critical
      const importanceResistance = IMPORTANCE_WEIGHTS[mem.importance];
      const decay = DECAY_RATE_PER_DAY / importanceResistance;
      const newFactor = mem.decayFactor * Math.exp(-decay * daysSinceReinforced);

      mem.decayFactor = Math.max(MIN_DECAY_FACTOR, newFactor);
      this.cache.set(id, mem);
      decayed++;

      // Forget (archive) if below threshold for too long
      if (mem.decayFactor <= MIN_DECAY_FACTOR) {
        const daysBelowThreshold = (now - mem.lastAccessedAt.getTime()) / 86_400_000;
        if (daysBelowThreshold > 30) {
          mem.consolidationStatus = 'archived';
          forgotten++;
        }
      }
    }

    if (decayed > 0) {
      await this.persistDecayBatch();
      this.stats.decayedCount += decayed;
    }

    if (forgotten > 0) {
      log.info({ decayed, forgotten }, 'Memory decay applied');
    }

    return { decayed, forgotten };
  }

  // -------------------------------------------------------------------------
  // Format memories for worker context injection
  // -------------------------------------------------------------------------

  formatForInjection(memories: WorkerMemory[]): string {
    if (memories.length === 0) return '';

    const sections: string[] = ['=== WORKER MEMORY ==='];

    const byType = new Map<MemoryType, WorkerMemory[]>();
    for (const m of memories) {
      const g = byType.get(m.type) ?? [];
      g.push(m);
      byType.set(m.type, g);
    }

    const typeLabels: Record<MemoryType, string> = {
      assignment_history: 'Past Assignments',
      decisions_made: 'Past Decisions',
      outcomes: 'Outcomes',
      learnings: 'Lessons Learned',
      preferences: 'Preferences',
    };

    for (const [memType, mems] of byType) {
      sections.push(`\n[${typeLabels[memType]}]`);
      for (const m of mems.slice(0, 5)) {
        const age = Math.round((Date.now() - m.createdAt.getTime()) / 3_600_000);
        const ageLabel = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
        sections.push(`- (${ageLabel}, ${m.importance}) ${m.content}`);
      }
    }

    sections.push('\n=== END MEMORY ===');
    return sections.join('\n');
  }

  // -------------------------------------------------------------------------
  // Stats & status
  // -------------------------------------------------------------------------

  getStats(): WorkerMemoryStats {
    return { ...this.stats };
  }

  getWorkerMemoryCount(workerId: string): number {
    return this.workerIndex.get(workerId)?.size ?? 0;
  }

  getCachedCount(): number {
    return this.cache.size;
  }

  // -------------------------------------------------------------------------
  // Heuristic consolidation fallback
  // -------------------------------------------------------------------------

  private heuristicConsolidate(memories: WorkerMemory[]): string {
    const positiveOutcomes = memories.filter(m => m.context.outcomePositive === true);
    const negativeOutcomes = memories.filter(m => m.context.outcomePositive === false);
    const lessons = memories.flatMap(m => m.context.lessonsLearned ?? []);
    const uniqueLessons = [...new Set(lessons)].slice(0, 5);

    const parts: string[] = [];
    parts.push(`Consolidated from ${memories.length} memories.`);

    if (positiveOutcomes.length > 0) {
      parts.push(`Positive outcomes: ${positiveOutcomes.length}/${memories.length}.`);
    }
    if (negativeOutcomes.length > 0) {
      parts.push(`Negative outcomes: ${negativeOutcomes.length}/${memories.length}.`);
    }
    if (uniqueLessons.length > 0) {
      parts.push(`Key lessons: ${uniqueLessons.join('; ')}.`);
    }

    // Extract most common tags
    const tagCounts = new Map<string, number>();
    for (const m of memories) {
      for (const t of m.tags) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);
    if (topTags.length > 0) {
      parts.push(`Common themes: ${topTags.join(', ')}.`);
    }

    return parts.join(' ');
  }

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  private addToCache(mem: WorkerMemory): void {
    this.cache.set(mem.id, mem);
    const wset = this.workerIndex.get(mem.workerId) ?? new Set();
    wset.add(mem.id);
    this.workerIndex.set(mem.workerId, wset);

    // Evict oldest if cache too large
    if (this.cache.size > MAX_MEMORIES_IN_CACHE) {
      const entries = [...this.cache.entries()]
        .sort((a, b) => a[1].lastAccessedAt.getTime() - b[1].lastAccessedAt.getTime());
      const toRemove = entries.slice(0, Math.floor(MAX_MEMORIES_IN_CACHE * 0.2));
      for (const [id, m] of toRemove) {
        this.cache.delete(id);
        const ws = this.workerIndex.get(m.workerId);
        if (ws) ws.delete(id);
      }
    }
  }

  private getFromCache(workerId: string): WorkerMemory[] {
    const ids = this.workerIndex.get(workerId);
    if (!ids || ids.size === 0) return [];
    const result: WorkerMemory[] = [];
    for (const id of ids) {
      const m = this.cache.get(id);
      if (m) result.push(m);
    }
    return result.sort((a, b) => b.relevanceScore * b.decayFactor - a.relevanceScore * a.decayFactor);
  }

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  private async persistMemory(mem: WorkerMemory): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_worker_memory
           (id, worker_id, type, importance, content, context_json,
            relevance_score, decay_factor, reinforcements,
            consolidation_status, parent_memory_id, token_estimate,
            tags, created_at, last_accessed_at, last_reinforced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           relevance_score = $7, decay_factor = $8, reinforcements = $9,
           consolidation_status = $10, last_accessed_at = $15,
           last_reinforced_at = $16`,
        [
          mem.id,
          mem.workerId,
          mem.type,
          mem.importance,
          mem.content,
          JSON.stringify(mem.context),
          mem.relevanceScore,
          mem.decayFactor,
          mem.reinforcements,
          mem.consolidationStatus,
          mem.parentMemoryId ?? null,
          mem.tokenEstimate,
          JSON.stringify(mem.tags),
          mem.createdAt.toISOString(),
          mem.lastAccessedAt.toISOString(),
          mem.lastReinforcedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.error({ err, memoryId: mem.id }, 'Failed to persist worker memory');
    }
  }

  private async persistReinforcementsBatch(memories: WorkerMemory[]): Promise<void> {
    const pool = getPool();
    if (!pool || memories.length === 0) return;

    try {
      const ids = memories.map(m => m.id);
      await pool.query(
        `UPDATE meow_worker_memory
         SET reinforcements = reinforcements + 1,
             last_accessed_at = NOW(),
             last_reinforced_at = NOW(),
             decay_factor = LEAST(1.0, decay_factor + $1)
         WHERE id = ANY($2)`,
        [REINFORCEMENT_BOOST, ids],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist reinforcements batch');
    }
  }

  private async archiveMemoriesBatch(ids: string[]): Promise<void> {
    const pool = getPool();
    if (!pool || ids.length === 0) return;

    try {
      await pool.query(
        `UPDATE meow_worker_memory
         SET consolidation_status = 'archived'
         WHERE id = ANY($1)`,
        [ids],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to archive memories batch');
    }
  }

  private async persistDecayBatch(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    // Batch update decay factors for non-archived memories
    const updates: Array<{ id: string; decay: number; status: string }> = [];
    for (const [, mem] of this.cache) {
      if (mem.consolidationStatus === 'archived') continue;
      updates.push({
        id: mem.id,
        decay: mem.decayFactor,
        status: mem.consolidationStatus,
      });
    }

    if (updates.length === 0) return;

    // Process in batches of 100
    for (let i = 0; i < updates.length; i += 100) {
      const batch = updates.slice(i, i + 100);
      try {
        const ids = batch.map(u => u.id);
        const decays = batch.map(u => u.decay);
        const statuses = batch.map(u => u.status);
        await pool.query(
          `UPDATE meow_worker_memory AS m
           SET decay_factor = d.decay::double precision,
               consolidation_status = d.status
           FROM (SELECT UNNEST($1::uuid[]) AS id,
                        UNNEST($2::double precision[]) AS decay,
                        UNNEST($3::text[]) AS status) AS d
           WHERE m.id = d.id`,
          [ids, decays, statuses],
        );
      } catch (err) {
        log.warn({ err, batch: i }, 'Failed to persist decay batch');
      }
    }
  }

  private async loadRecentFromDb(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, worker_id, type, importance, content, context_json,
                relevance_score, decay_factor, reinforcements,
                consolidation_status, parent_memory_id, token_estimate,
                tags, created_at, last_accessed_at, last_reinforced_at
         FROM meow_worker_memory
         WHERE consolidation_status != 'archived'
           AND created_at >= NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [MAX_MEMORIES_IN_CACHE],
      );

      for (const row of rows) {
        const mem = this.rowToMemory(row);
        this.addToCache(mem);
      }

      this.stats.totalMemories = this.cache.size;
      log.info({ loaded: rows.length }, 'Loaded recent memories from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load recent memories from DB (table may not exist yet)');
    }
  }

  private rowToMemory(row: Record<string, unknown>): WorkerMemory {
    const ctx = typeof row.context_json === 'string'
      ? JSON.parse(row.context_json as string)
      : (row.context_json ?? {});
    const tags = typeof row.tags === 'string'
      ? JSON.parse(row.tags as string)
      : (row.tags ?? []);

    return {
      id: row.id as string,
      workerId: row.worker_id as string,
      type: row.type as MemoryType,
      importance: row.importance as MemoryImportance,
      content: row.content as string,
      context: ctx as MemoryContext,
      relevanceScore: Number(row.relevance_score) || 0,
      decayFactor: Number(row.decay_factor) || 1,
      reinforcements: Number(row.reinforcements) || 0,
      consolidationStatus: (row.consolidation_status as ConsolidationStatus) || 'raw',
      parentMemoryId: (row.parent_memory_id as string) || undefined,
      tokenEstimate: Number(row.token_estimate) || 0,
      tags: Array.isArray(tags) ? tags : [],
      createdAt: new Date(row.created_at as string),
      lastAccessedAt: new Date(row.last_accessed_at as string),
      lastReinforcedAt: new Date(row.last_reinforced_at as string),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WorkerPersistentMemory | null = null;

export function getWorkerPersistentMemory(): WorkerPersistentMemory {
  if (!instance) {
    instance = new WorkerPersistentMemory();
    log.info('WorkerPersistentMemory singleton created');
  }
  return instance;
}
