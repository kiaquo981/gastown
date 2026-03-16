/**
 * BeadMegaBrainSync — LP-032 Stage 04 Wave 6
 *
 * Feed completed bead data into MegaBrain knowledge base.
 * When a bead is completed:
 *   - Extract: what was done, decisions made, outcomes, patterns
 *   - Format as MegaBrain fragment
 *   - Insert into megabrain_fragments table
 *
 * Makes patterns searchable: "what worked for regional campaigns?"
 * Uses Gemini for AI-powered pattern extraction.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Bead } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MegaBrainFragment {
  id?: string;
  content: string;
  category: 'bead_outcome' | 'bead_pattern' | 'bead_decision';
  source: string;
  metadata: Record<string, unknown>;
  embedding_text: string;
  created_at?: Date;
}

export interface IngestionStats {
  total: number;
  lastIngested: Date | null;
  byCategory: Record<string, number>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[BeadMegaBrainSync]';
const SOURCE = 'meow:beads';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_TIMEOUT_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getGeminiKey(): string | null {
  return process.env.GEMINI_API_KEY || null;
}

async function callGemini(prompt: string): Promise<string> {
  const key = getGeminiKey();
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a knowledge extraction agent. Extract actionable patterns, decisions, and outcomes from work items. Be concise. Output only the requested format, no preamble.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timeout);
  }
}

function buildOutcomeFragment(bead: Bead, output?: string): MegaBrainFragment {
  const parts: string[] = [
    `Bead "${bead.title}" (${bead.id}) completed.`,
  ];
  if (bead.description) parts.push(`Description: ${bead.description}`);
  if (bead.bu) parts.push(`BU: ${bead.bu}`);
  if (bead.rig) parts.push(`Rig: ${bead.rig}`);
  if (bead.skill) parts.push(`Skill: ${bead.skill}`);
  if (bead.assignee) parts.push(`Assignee: ${bead.assignee}`);
  if (output) parts.push(`Output: ${output}`);

  const durationMs = bead.completedAt && bead.startedAt
    ? bead.completedAt.getTime() - bead.startedAt.getTime()
    : undefined;
  if (durationMs) parts.push(`Duration: ${Math.round(durationMs / 60000)} minutes`);

  const content = parts.join('\n');

  return {
    content,
    category: 'bead_outcome',
    source: SOURCE,
    metadata: {
      beadId: bead.id,
      priority: bead.priority,
      bu: bead.bu,
      rig: bead.rig,
      skill: bead.skill,
      tier: bead.tier,
      durationMs,
      labels: bead.labels,
      completedBy: bead.completedBy,
    },
    embedding_text: `${bead.title} ${bead.description || ''} ${bead.bu || ''} ${bead.rig || ''} ${bead.skill || ''} ${output || ''}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class BeadMegaBrainSync {

  // ───────────── On Bead Completed ─────────────

  async onBeadCompleted(bead: Bead, output?: string): Promise<void> {
    const pool = getPool();
    if (!pool) {
      console.warn(`${TAG} Database not available, skipping ingestion for ${bead.id}`);
      return;
    }

    try {
      // 1. Always ingest the outcome fragment
      const outcomeFragment = buildOutcomeFragment(bead, output);
      await this.ingestFragment(outcomeFragment);

      // 2. Try AI-powered pattern extraction (non-blocking)
      this.extractAndIngestPatterns(bead, output).catch((err) => {
        console.warn(`${TAG} Pattern extraction failed for ${bead.id} (non-critical):`, err);
      });

      broadcast('meow:megabrain', { action: 'bead_ingested', beadId: bead.id });
      console.info(`${TAG} Ingested bead ${bead.id} into MegaBrain`);
    } catch (err) {
      console.error(`${TAG} Failed to ingest bead ${bead.id}:`, err);
    }
  }

  // ───────────── Pattern Extraction ─────────────

  async extractPatterns(bead: Bead): Promise<string[]> {
    const key = getGeminiKey();
    if (!key) {
      // Fallback: basic pattern extraction without AI
      return this.extractPatternsBasic(bead);
    }

    const prompt = [
      'Extract actionable patterns from this completed work item.',
      'Return a JSON array of strings, each being a concise pattern (max 100 chars).',
      'Focus on: what worked, what decisions were made, reusable approaches.',
      '',
      `Title: ${bead.title}`,
      bead.description ? `Description: ${bead.description}` : '',
      bead.bu ? `Business Unit: ${bead.bu}` : '',
      bead.rig ? `Rig/Project: ${bead.rig}` : '',
      bead.skill ? `Skill: ${bead.skill}` : '',
      bead.priority ? `Priority: ${bead.priority}` : '',
      bead.tier ? `Tier: ${bead.tier}` : '',
      Object.keys(bead.labels).length > 0 ? `Labels: ${JSON.stringify(bead.labels)}` : '',
    ].filter(Boolean).join('\n');

    try {
      const result = await callGemini(prompt);
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed)) {
        return parsed.filter((p): p is string => typeof p === 'string').slice(0, 10);
      }
      return [];
    } catch {
      return this.extractPatternsBasic(bead);
    }
  }

  async searchRelatedKnowledge(query: string, limit: number = 10): Promise<MegaBrainFragment[]> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    try {
      const res = await pool.query(
        `SELECT id, content, category, source, metadata, embedding_text, created_at,
                ts_rank(
                  to_tsvector('english', coalesce(content, '') || ' ' || coalesce(embedding_text, '')),
                  plainto_tsquery('english', $1)
                ) AS rank
         FROM megabrain_fragments
         WHERE source = $2
           AND to_tsvector('english', coalesce(content, '') || ' ' || coalesce(embedding_text, ''))
               @@ plainto_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT $3`,
        [query, SOURCE, limit],
      );

      return res.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        content: row.content as string,
        category: row.category as MegaBrainFragment['category'],
        source: row.source as string,
        metadata: (row.metadata as Record<string, unknown>) || {},
        embedding_text: (row.embedding_text as string) || '',
        created_at: row.created_at ? new Date(row.created_at as string) : undefined,
      }));
    } catch (err) {
      console.error(`${TAG} Search failed for query "${query}":`, err);
      return [];
    }
  }

  async getIngestionStats(): Promise<IngestionStats> {
    const pool = getPool();
    if (!pool) return { total: 0, lastIngested: null, byCategory: {} };

    try {
      const [totalRes, lastRes, catRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM megabrain_fragments WHERE source = $1`, [SOURCE]),
        pool.query(`SELECT MAX(created_at) AS last_at FROM megabrain_fragments WHERE source = $1`, [SOURCE]),
        pool.query(
          `SELECT category, COUNT(*)::int AS count FROM megabrain_fragments WHERE source = $1 GROUP BY category`,
          [SOURCE],
        ),
      ]);

      const byCategory: Record<string, number> = {};
      for (const row of catRes.rows) {
        byCategory[row.category] = row.count;
      }

      return {
        total: totalRes.rows[0]?.total || 0,
        lastIngested: lastRes.rows[0]?.last_at ? new Date(lastRes.rows[0].last_at) : null,
        byCategory,
      };
    } catch (err) {
      console.error(`${TAG} Failed to get ingestion stats:`, err);
      return { total: 0, lastIngested: null, byCategory: {} };
    }
  }

  // ───────────── Internal ─────────────

  private async ingestFragment(fragment: MegaBrainFragment): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not available');

    await pool.query(
      `INSERT INTO megabrain_fragments (content, category, source, metadata, embedding_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        fragment.content,
        fragment.category,
        fragment.source,
        JSON.stringify(fragment.metadata),
        fragment.embedding_text,
      ],
    );
  }

  private async extractAndIngestPatterns(bead: Bead, output?: string): Promise<void> {
    const patterns = await this.extractPatterns(bead);
    if (patterns.length === 0) return;

    for (const pattern of patterns) {
      const fragment: MegaBrainFragment = {
        content: pattern,
        category: 'bead_pattern',
        source: SOURCE,
        metadata: {
          beadId: bead.id,
          bu: bead.bu,
          rig: bead.rig,
          skill: bead.skill,
          extractedFrom: bead.title,
        },
        embedding_text: `${pattern} ${bead.bu || ''} ${bead.rig || ''} ${bead.skill || ''}`,
      };

      try {
        await this.ingestFragment(fragment);
      } catch (err) {
        console.warn(`${TAG} Failed to ingest pattern for ${bead.id}:`, err);
      }
    }

    console.info(`${TAG} Ingested ${patterns.length} patterns from bead ${bead.id}`);
  }

  private extractPatternsBasic(bead: Bead): string[] {
    const patterns: string[] = [];

    if (bead.skill) {
      patterns.push(`Skill "${bead.skill}" used for: ${bead.title}`);
    }
    if (bead.bu && bead.rig) {
      patterns.push(`${bead.bu}/${bead.rig}: ${bead.title} completed at priority ${bead.priority}`);
    }
    if (bead.tier === 'S' && bead.priority === 'critical') {
      patterns.push(`Critical S-tier bead: ${bead.title} — high-priority pattern`);
    }
    if (bead.completedAt && bead.startedAt) {
      const mins = Math.round((bead.completedAt.getTime() - bead.startedAt.getTime()) / 60000);
      if (mins > 0) {
        patterns.push(`${bead.skill || 'task'} took ${mins}min for "${bead.title}"`);
      }
    }

    return patterns.slice(0, 5);
  }
}
