/**
 * CROSS-MOLECULE KNOWLEDGE -- CG-024 (Stage 05 Wave 6)
 *
 * Share knowledge between molecules executing related work.
 *
 * Detects molecules working on related topics (same formula, same product,
 * same campaign) and creates a shared knowledge bus:
 *   - Discoveries from molecule A become available to molecule B
 *   - Errors encountered are broadcast to prevent duplication
 *   - Intermediate results are shared for downstream use
 *   - Decisions made are recorded for consistency
 *
 * Knowledge bus:
 *   - In-memory knowledge graph with topic-based subscriptions
 *   - DB persistence for durability across restarts
 *   - Conflict resolution for contradictory knowledge
 *   - TTL: entries expire after configurable duration (default 24h)
 *   - Privacy: molecules can mark knowledge as private
 *
 * Performance:
 *   - Max 100 active subscriptions with LRU eviction
 *   - Batch notification delivery
 *   - Lazy DB persistence (write-behind)
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Molecule, FeedEvent } from '../types';

const log = createLogger('cross-molecule-knowledge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnowledgeType =
  | 'discovery'
  | 'error_encountered'
  | 'intermediate_result'
  | 'decision_made'
  | 'optimization'
  | 'warning';

export type ConflictResolution =
  | 'latest_wins'
  | 'highest_confidence'
  | 'manual_review';

export interface KnowledgeEntry {
  id: string;
  moleculeId: string;
  topic: string;                    // topic key for subscription matching
  type: KnowledgeType;
  title: string;
  content: string;
  confidence: number;               // 0.0 - 1.0
  isPrivate: boolean;               // if true, not shared with other molecules
  tags: string[];
  expiresAt: Date;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSubscription {
  id: string;
  moleculeId: string;
  topics: string[];
  callback?: (entry: KnowledgeEntry) => void;
  createdAt: Date;
  lastNotifiedAt: Date;
}

export interface KnowledgeConflict {
  id: string;
  topic: string;
  entryA: KnowledgeEntry;
  entryB: KnowledgeEntry;
  resolution: ConflictResolution;
  resolvedEntry?: KnowledgeEntry;
  resolvedAt?: Date;
}

export interface TopicGraph {
  topics: Map<string, KnowledgeEntry[]>;
  edges: Map<string, Set<string>>;    // topic -> related topics
}

export interface CrossMoleculeConfig {
  defaultTTLMs: number;               // default 24h
  maxSubscriptions: number;           // default 100
  maxEntriesPerTopic: number;         // default 200
  conflictResolution: ConflictResolution;
  persistBatchSize: number;           // write-behind batch size
  persistIntervalMs: number;          // write-behind interval
}

export interface KnowledgeBusStats {
  totalEntries: number;
  totalTopics: number;
  activeSubscriptions: number;
  conflictsDetected: number;
  conflictsResolved: number;
  expiredEntries: number;
  privateEntries: number;
  entriesByType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CrossMoleculeConfig = {
  defaultTTLMs: 24 * 60 * 60 * 1000,   // 24 hours
  maxSubscriptions: 100,
  maxEntriesPerTopic: 200,
  conflictResolution: 'latest_wins',
  persistBatchSize: 50,
  persistIntervalMs: 30_000,            // 30 seconds
};

// ---------------------------------------------------------------------------
// CrossMoleculeKnowledge
// ---------------------------------------------------------------------------

export class CrossMoleculeKnowledge {
  private config: CrossMoleculeConfig;
  private graph: TopicGraph;
  private subscriptions = new Map<string, KnowledgeSubscription>();
  private conflicts: KnowledgeConflict[] = [];
  private pendingPersist: KnowledgeEntry[] = [];
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private expiredCount = 0;

  constructor(config?: Partial<CrossMoleculeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.graph = {
      topics: new Map(),
      edges: new Map(),
    };

    // Start write-behind persistence
    this.startPersistLoop();
  }

  // --- Publish knowledge entry ----------------------------------------------

  async publish(
    moleculeId: string,
    topic: string,
    type: KnowledgeType,
    title: string,
    content: string,
    opts?: {
      confidence?: number;
      isPrivate?: boolean;
      tags?: string[];
      ttlMs?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<KnowledgeEntry> {
    const now = new Date();
    const ttl = opts?.ttlMs ?? this.config.defaultTTLMs;

    const entry: KnowledgeEntry = {
      id: uuidv4(),
      moleculeId,
      topic,
      type,
      title,
      content,
      confidence: opts?.confidence ?? 0.7,
      isPrivate: opts?.isPrivate ?? false,
      tags: opts?.tags ?? [],
      expiresAt: new Date(now.getTime() + ttl),
      createdAt: now,
      metadata: opts?.metadata,
    };

    // Add to topic graph
    if (!this.graph.topics.has(topic)) {
      this.graph.topics.set(topic, []);
    }
    const topicEntries = this.graph.topics.get(topic)!;

    // Check for conflicts before adding
    if (!entry.isPrivate) {
      await this.detectConflicts(entry, topicEntries);
    }

    topicEntries.push(entry);

    // Enforce per-topic limit
    if (topicEntries.length > this.config.maxEntriesPerTopic) {
      topicEntries.splice(0, topicEntries.length - this.config.maxEntriesPerTopic);
    }

    // Queue for persistence
    this.pendingPersist.push(entry);

    // Notify subscribers (skip if private)
    if (!entry.isPrivate) {
      this.notifySubscribers(entry);
    }

    // Build topic edges from tags
    for (const tag of entry.tags) {
      if (tag !== topic) {
        if (!this.graph.edges.has(topic)) {
          this.graph.edges.set(topic, new Set());
        }
        this.graph.edges.get(topic)!.add(tag);
      }
    }

    broadcast('meow:cognitive', {
      type: 'cross_molecule_published',
      entryId: entry.id,
      moleculeId,
      topic,
      knowledgeType: entry.type,
      title: entry.title,
      isPrivate: entry.isPrivate,
    });

    log.info(
      { entryId: entry.id, moleculeId, topic, knowledgeType: type },
      'Knowledge entry published',
    );

    return entry;
  }

  // --- Subscribe to topics --------------------------------------------------

  subscribe(
    moleculeId: string,
    topics: string[],
    callback?: (entry: KnowledgeEntry) => void,
  ): KnowledgeSubscription {
    // Enforce max subscriptions with LRU eviction
    if (this.subscriptions.size >= this.config.maxSubscriptions) {
      this.evictOldestSubscription();
    }

    const sub: KnowledgeSubscription = {
      id: uuidv4(),
      moleculeId,
      topics,
      callback,
      createdAt: new Date(),
      lastNotifiedAt: new Date(),
    };

    this.subscriptions.set(sub.id, sub);

    log.info(
      { subscriptionId: sub.id, moleculeId, topics },
      'Molecule subscribed to knowledge topics',
    );

    broadcast('meow:cognitive', {
      type: 'cross_molecule_subscribed',
      subscriptionId: sub.id,
      moleculeId,
      topics,
    });

    return sub;
  }

  // --- Unsubscribe ----------------------------------------------------------

  unsubscribe(subscriptionId: string): boolean {
    const removed = this.subscriptions.delete(subscriptionId);
    if (removed) {
      log.info({ subscriptionId }, 'Subscription removed');
    }
    return removed;
  }

  // --- Query knowledge for a topic ------------------------------------------

  queryTopic(
    topic: string,
    opts?: {
      type?: KnowledgeType;
      moleculeId?: string;
      includeRelated?: boolean;
      includePrivate?: boolean;
      limit?: number;
    },
  ): KnowledgeEntry[] {
    const now = Date.now();
    let entries = this.graph.topics.get(topic) ?? [];

    // Include related topics
    if (opts?.includeRelated) {
      const relatedTopics = this.graph.edges.get(topic);
      if (relatedTopics) {
        for (const rt of relatedTopics) {
          const relEntries = this.graph.topics.get(rt) ?? [];
          entries = entries.concat(relEntries);
        }
      }
    }

    // Filter
    entries = entries.filter(e => {
      if (e.expiresAt.getTime() < now) return false;
      if (!opts?.includePrivate && e.isPrivate) return false;
      if (opts?.type && e.type !== opts.type) return false;
      if (opts?.moleculeId && e.moleculeId !== opts.moleculeId) return false;
      return true;
    });

    // Sort by recency + confidence
    entries.sort((a, b) => {
      const scoreA = a.confidence * 0.4 + (a.createdAt.getTime() / now) * 0.6;
      const scoreB = b.confidence * 0.4 + (b.createdAt.getTime() / now) * 0.6;
      return scoreB - scoreA;
    });

    return entries.slice(0, opts?.limit ?? 50);
  }

  // --- Query knowledge from a molecule's perspective ------------------------

  queryForMolecule(molecule: Molecule): KnowledgeEntry[] {
    const topics = this.inferTopics(molecule);
    const results: KnowledgeEntry[] = [];
    const seen = new Set<string>();

    for (const topic of topics) {
      const entries = this.queryTopic(topic, { includeRelated: true, limit: 10 });
      for (const e of entries) {
        if (!seen.has(e.id) && e.moleculeId !== molecule.id) {
          seen.add(e.id);
          results.push(e);
        }
      }
    }

    return results.slice(0, 30);
  }

  // --- Auto-detect related molecules ----------------------------------------

  detectRelatedMolecules(moleculeId: string): string[] {
    const related = new Set<string>();

    // Find all topics this molecule has published to
    const moleculeTopics: string[] = [];
    for (const [topic, entries] of this.graph.topics) {
      if (entries.some(e => e.moleculeId === moleculeId)) {
        moleculeTopics.push(topic);
      }
    }

    // Find other molecules publishing to same/related topics
    for (const topic of moleculeTopics) {
      const entries = this.graph.topics.get(topic) ?? [];
      for (const e of entries) {
        if (e.moleculeId !== moleculeId) {
          related.add(e.moleculeId);
        }
      }

      // Check related topics too
      const relatedTopics = this.graph.edges.get(topic);
      if (relatedTopics) {
        for (const rt of relatedTopics) {
          const relEntries = this.graph.topics.get(rt) ?? [];
          for (const e of relEntries) {
            if (e.moleculeId !== moleculeId) {
              related.add(e.moleculeId);
            }
          }
        }
      }
    }

    return Array.from(related);
  }

  // --- Garbage collect expired entries --------------------------------------

  gc(): number {
    const now = Date.now();
    let removed = 0;

    for (const [topic, entries] of this.graph.topics) {
      const before = entries.length;
      const valid = entries.filter(e => e.expiresAt.getTime() >= now);
      if (valid.length < before) {
        this.graph.topics.set(topic, valid);
        removed += before - valid.length;
      }

      // Remove empty topics
      if (valid.length === 0) {
        this.graph.topics.delete(topic);
        this.graph.edges.delete(topic);
      }
    }

    this.expiredCount += removed;

    if (removed > 0) {
      log.info({ removed }, 'Expired knowledge entries garbage collected');
      broadcast('meow:cognitive', {
        type: 'cross_molecule_gc',
        removedCount: removed,
      });
    }

    return removed;
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): KnowledgeBusStats {
    let totalEntries = 0;
    let privateEntries = 0;
    const entriesByType: Record<string, number> = {};

    for (const entries of this.graph.topics.values()) {
      totalEntries += entries.length;
      for (const e of entries) {
        if (e.isPrivate) privateEntries++;
        entriesByType[e.type] = (entriesByType[e.type] ?? 0) + 1;
      }
    }

    return {
      totalEntries,
      totalTopics: this.graph.topics.size,
      activeSubscriptions: this.subscriptions.size,
      conflictsDetected: this.conflicts.length,
      conflictsResolved: this.conflicts.filter(c => !!c.resolvedAt).length,
      expiredEntries: this.expiredCount,
      privateEntries,
      entriesByType,
    };
  }

  // --- Update config --------------------------------------------------------

  updateConfig(updates: Partial<CrossMoleculeConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'CrossMoleculeKnowledge config updated');
  }

  // --- Shutdown (flush pending writes) --------------------------------------

  async shutdown(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flushPendingPersist();
    log.info('CrossMoleculeKnowledge shutdown complete');
  }

  // --- Load from DB on startup ----------------------------------------------

  async loadFromDB(): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;

    try {
      const { rows } = await pool.query(
        `SELECT id, molecule_id, topic, type, title, content,
                confidence, is_private, tags, expires_at, created_at, metadata
         FROM meow_cross_molecule_knowledge
         WHERE expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 5000`,
      );

      let loaded = 0;
      for (const r of rows as Array<Record<string, unknown>>) {
        const entry: KnowledgeEntry = {
          id: r.id as string,
          moleculeId: r.molecule_id as string,
          topic: r.topic as string,
          type: r.type as KnowledgeType,
          title: (r.title as string) ?? '',
          content: (r.content as string) ?? '',
          confidence: parseFloat((r.confidence as string) ?? '0.7'),
          isPrivate: (r.is_private as boolean) ?? false,
          tags: this.parseJsonArray(r.tags),
          expiresAt: new Date((r.expires_at as string) ?? Date.now()),
          createdAt: new Date((r.created_at as string) ?? Date.now()),
          metadata: typeof r.metadata === 'string'
            ? JSON.parse(r.metadata)
            : (r.metadata as Record<string, unknown>) ?? {},
        };

        if (!this.graph.topics.has(entry.topic)) {
          this.graph.topics.set(entry.topic, []);
        }
        this.graph.topics.get(entry.topic)!.push(entry);
        loaded++;
      }

      log.info({ loaded }, 'Loaded cross-molecule knowledge from DB');
      return loaded;
    } catch (err) {
      log.warn({ err }, 'Failed to load cross-molecule knowledge from DB');
      return 0;
    }
  }

  // --- Private helpers ------------------------------------------------------

  private inferTopics(molecule: Molecule): string[] {
    const topics: string[] = [];

    // Formula name as topic
    if (molecule.formulaName) topics.push(`formula:${molecule.formulaName}`);

    // Variables as topics
    const vars = molecule.vars ?? {};
    if (vars.product) topics.push(`product:${vars.product}`);
    if (vars.campaign) topics.push(`campaign:${vars.campaign}`);
    if (vars.country) topics.push(`country:${vars.country}`);
    if (vars.audience) topics.push(`audience:${vars.audience}`);
    if (vars.niche) topics.push(`niche:${vars.niche}`);

    // Convoy as topic
    if (molecule.convoyId) topics.push(`convoy:${molecule.convoyId}`);

    return topics;
  }

  private notifySubscribers(entry: KnowledgeEntry): void {
    const now = new Date();
    let notified = 0;

    for (const sub of this.subscriptions.values()) {
      // Skip if same molecule
      if (sub.moleculeId === entry.moleculeId) continue;

      // Check topic match
      const matches = sub.topics.some(t =>
        t === entry.topic ||
        entry.topic.startsWith(t + ':') ||
        entry.tags.includes(t),
      );

      if (matches) {
        sub.lastNotifiedAt = now;

        if (sub.callback) {
          try {
            sub.callback(entry);
          } catch (err) {
            log.warn(
              { err, subscriptionId: sub.id, entryId: entry.id },
              'Subscription callback error',
            );
          }
        }

        notified++;
      }
    }

    if (notified > 0) {
      log.info(
        { entryId: entry.id, topic: entry.topic, notifiedCount: notified },
        'Subscribers notified of new knowledge',
      );
    }
  }

  private async detectConflicts(
    newEntry: KnowledgeEntry,
    existing: KnowledgeEntry[],
  ): Promise<void> {
    // Look for entries of same type + topic from different molecules
    const potentialConflicts = existing.filter(e =>
      e.moleculeId !== newEntry.moleculeId &&
      e.type === newEntry.type &&
      !e.isPrivate &&
      e.expiresAt.getTime() > Date.now(),
    );

    for (const existing of potentialConflicts) {
      // Simple heuristic: if titles are similar but content differs significantly
      const titleSimilarity = this.jaccardSimilarity(
        new Set(existing.title.toLowerCase().split(/\s+/)),
        new Set(newEntry.title.toLowerCase().split(/\s+/)),
      );

      const contentSimilarity = this.jaccardSimilarity(
        new Set(existing.content.toLowerCase().split(/\s+/).slice(0, 50)),
        new Set(newEntry.content.toLowerCase().split(/\s+/).slice(0, 50)),
      );

      // High title similarity but low content similarity = conflict
      if (titleSimilarity > 0.5 && contentSimilarity < 0.3) {
        const conflict: KnowledgeConflict = {
          id: uuidv4(),
          topic: newEntry.topic,
          entryA: existing,
          entryB: newEntry,
          resolution: this.config.conflictResolution,
        };

        // Auto-resolve based on strategy
        this.resolveConflict(conflict);
        this.conflicts.push(conflict);

        broadcast('meow:cognitive', {
          type: 'cross_molecule_conflict',
          conflictId: conflict.id,
          topic: newEntry.topic,
          moleculeA: existing.moleculeId,
          moleculeB: newEntry.moleculeId,
          resolution: conflict.resolution,
        });

        log.info(
          { conflictId: conflict.id, topic: newEntry.topic },
          'Knowledge conflict detected and resolved',
        );
      }
    }
  }

  private resolveConflict(conflict: KnowledgeConflict): void {
    switch (conflict.resolution) {
      case 'latest_wins':
        conflict.resolvedEntry =
          conflict.entryA.createdAt > conflict.entryB.createdAt
            ? conflict.entryA
            : conflict.entryB;
        break;

      case 'highest_confidence':
        conflict.resolvedEntry =
          conflict.entryA.confidence >= conflict.entryB.confidence
            ? conflict.entryA
            : conflict.entryB;
        break;

      case 'manual_review':
        // Don't auto-resolve, flag for review
        log.info(
          { conflictId: conflict.id },
          'Conflict flagged for manual review',
        );
        return;
    }

    conflict.resolvedAt = new Date();
  }

  private jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private evictOldestSubscription(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, sub] of this.subscriptions) {
      if (sub.lastNotifiedAt.getTime() < oldestTime) {
        oldestTime = sub.lastNotifiedAt.getTime();
        oldestId = id;
      }
    }

    if (oldestId) {
      this.subscriptions.delete(oldestId);
      log.info({ subscriptionId: oldestId }, 'Evicted oldest subscription (LRU)');
    }
  }

  private startPersistLoop(): void {
    this.persistTimer = setInterval(() => {
      this.flushPendingPersist().catch(err =>
        log.warn({ err }, 'Write-behind persistence flush failed'),
      );
    }, this.config.persistIntervalMs);
  }

  private async flushPendingPersist(): Promise<void> {
    if (this.pendingPersist.length === 0) return;

    const pool = getPool();
    if (!pool) return;

    const batch = this.pendingPersist.splice(0, this.config.persistBatchSize);

    for (const entry of batch) {
      try {
        await pool.query(
          `INSERT INTO meow_cross_molecule_knowledge
            (id, molecule_id, topic, type, title, content,
             confidence, is_private, tags, expires_at, created_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.moleculeId,
            entry.topic,
            entry.type,
            entry.title,
            entry.content.slice(0, 10000),
            entry.confidence,
            entry.isPrivate,
            JSON.stringify(entry.tags),
            entry.expiresAt.toISOString(),
            entry.createdAt.toISOString(),
            JSON.stringify(entry.metadata ?? {}),
          ],
        );
      } catch (err) {
        log.warn({ err, entryId: entry.id }, 'Failed to persist knowledge entry');
      }
    }

    if (batch.length > 0) {
      log.info({ flushed: batch.length }, 'Write-behind knowledge persistence flush');
    }
  }

  private parseJsonArray(val: unknown): string[] {
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') {
      try { return JSON.parse(val) as string[]; } catch { return []; }
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CrossMoleculeKnowledge | null = null;

export function getCrossMoleculeKnowledge(
  config?: Partial<CrossMoleculeConfig>,
): CrossMoleculeKnowledge {
  if (!instance) {
    instance = new CrossMoleculeKnowledge(config);
    log.info('CrossMoleculeKnowledge singleton created');
  }
  return instance;
}
