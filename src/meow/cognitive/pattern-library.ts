/**
 * PATTERN LIBRARY -- CG-008 (Stage 05 Wave 2)
 *
 * MegaBrain auto-extracts patterns from successful molecules.
 * After successful molecule completion:
 *   1. Extract patterns: "campaigns in [country] with [hook type] convert at [rate]"
 *   2. Categorize: market_insight, creative_pattern, pricing_strategy, audience_behavior
 *   3. Store in MegaBrain (megabrain_fragments) with FTS for semantic search
 *   4. Surface relevant patterns when new molecules start (context injection)
 *
 * Pattern types:
 *   - success_pattern: what worked and why
 *   - failure_pattern: what failed and why
 *   - optimization: discovered shortcuts or improvements
 *   - market_signal: observed market trends from data
 *
 * Uses Gemini for pattern extraction, FTS for search.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Molecule } from '../types';

const log = createLogger('pattern-library');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternCategory =
  | 'market_insight'
  | 'creative_pattern'
  | 'pricing_strategy'
  | 'audience_behavior'
  | 'operational'
  | 'technical';

export type PatternType =
  | 'success_pattern'
  | 'failure_pattern'
  | 'optimization'
  | 'market_signal';

export interface Pattern {
  id: string;
  formulaName: string;
  moleculeId: string;
  category: PatternCategory;
  patternType: PatternType;
  title: string;
  description: string;
  evidence: string;           // raw data that supports the pattern
  confidence: number;         // 0.0 - 1.0
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface PatternStats {
  totalPatterns: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
  avgConfidence: number;
  oldestPattern: Date | null;
  newestPattern: Date | null;
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
              content: 'You are a pattern extraction engine for an AI orchestration system. Extract actionable patterns from molecule execution data. Always respond with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.4,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in pattern-library');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic pattern extraction (fallback when no Gemini key)
// ---------------------------------------------------------------------------

function extractPatternsHeuristic(molecule: Molecule): Pattern[] {
  const patterns: Pattern[] = [];
  const now = new Date();
  const isSuccess = molecule.status === 'completed';

  // Pattern 1: overall success/failure pattern
  const stepSummary = molecule.steps.map(s => {
    const dur = s.startedAt && s.completedAt
      ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
      : 0;
    return `${s.title}(${s.status}, ${dur}ms)`;
  }).join(', ');

  patterns.push({
    id: uuidv4(),
    formulaName: molecule.formulaName,
    moleculeId: molecule.id,
    category: 'operational',
    patternType: isSuccess ? 'success_pattern' : 'failure_pattern',
    title: isSuccess
      ? `Formula "${molecule.formulaName}" completed successfully`
      : `Formula "${molecule.formulaName}" failed`,
    description: isSuccess
      ? `Completed ${molecule.steps.length} steps. Steps: ${stepSummary}`
      : `Failed with error: ${molecule.error ?? 'unknown'}. Steps: ${stepSummary}`,
    evidence: JSON.stringify({
      status: molecule.status,
      stepCount: molecule.steps.length,
      completedSteps: molecule.completedSteps.length,
      vars: molecule.vars,
    }),
    confidence: 0.6,
    tags: [molecule.formulaName, isSuccess ? 'success' : 'failure'],
    createdAt: now,
  });

  // Pattern 2: bottleneck detection
  const stepDurations = molecule.steps
    .filter(s => s.startedAt && s.completedAt)
    .map(s => ({
      id: s.id,
      title: s.title,
      dur: new Date(s.completedAt!).getTime() - new Date(s.startedAt!).getTime(),
    }))
    .sort((a, b) => b.dur - a.dur);

  if (stepDurations.length > 0) {
    const slowest = stepDurations[0];
    const totalDur = stepDurations.reduce((s, d) => s + d.dur, 0);
    const pct = totalDur > 0 ? Math.round((slowest.dur / totalDur) * 100) : 0;

    if (pct > 40) {
      patterns.push({
        id: uuidv4(),
        formulaName: molecule.formulaName,
        moleculeId: molecule.id,
        category: 'operational',
        patternType: 'optimization',
        title: `Bottleneck: "${slowest.title}" takes ${pct}% of total time`,
        description: `Step "${slowest.title}" took ${slowest.dur}ms (${pct}% of ${totalDur}ms total). Consider splitting or caching.`,
        evidence: JSON.stringify(stepDurations.slice(0, 5)),
        confidence: 0.7,
        tags: [molecule.formulaName, 'bottleneck', slowest.id],
        createdAt: now,
      });
    }
  }

  // Pattern 3: variable-based insight
  const vars = molecule.vars ?? {};
  if (vars.country || vars.product || vars.hook_type) {
    patterns.push({
      id: uuidv4(),
      formulaName: molecule.formulaName,
      moleculeId: molecule.id,
      category: vars.country ? 'market_insight' : 'creative_pattern',
      patternType: isSuccess ? 'success_pattern' : 'failure_pattern',
      title: `${isSuccess ? 'Successful' : 'Failed'} execution with ${Object.keys(vars).join(', ')}`,
      description: `Formula "${molecule.formulaName}" ${isSuccess ? 'succeeded' : 'failed'} with vars: ${JSON.stringify(vars)}`,
      evidence: JSON.stringify({ vars, status: molecule.status }),
      confidence: 0.5,
      tags: [
        molecule.formulaName,
        ...(vars.country ? [vars.country] : []),
        ...(vars.product ? [vars.product] : []),
      ],
      createdAt: now,
    });
  }

  // Pattern 4: failed steps insight
  const failedSteps = molecule.steps.filter(s => s.status === 'failed');
  for (const step of failedSteps.slice(0, 2)) {
    patterns.push({
      id: uuidv4(),
      formulaName: molecule.formulaName,
      moleculeId: molecule.id,
      category: 'technical',
      patternType: 'failure_pattern',
      title: `Step "${step.title}" failed: ${(step.error ?? 'unknown').slice(0, 100)}`,
      description: `Step ${step.id} ("${step.title}") failed in formula "${molecule.formulaName}". Error: ${step.error ?? 'unknown'}`,
      evidence: JSON.stringify({ stepId: step.id, error: step.error, skill: step.skill }),
      confidence: 0.8,
      tags: [molecule.formulaName, 'step_failure', step.id],
      createdAt: now,
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// PatternLibrary
// ---------------------------------------------------------------------------

export class PatternLibrary {
  private patterns: Pattern[] = [];
  private maxInMemory = 5_000;

  // --- Extract patterns from a completed molecule -------------------------

  async extractPatterns(molecule: Molecule): Promise<Pattern[]> {
    // Try AI-powered extraction first
    const aiPatterns = await this.extractWithGemini(molecule);
    if (aiPatterns && aiPatterns.length > 0) {
      for (const p of aiPatterns) {
        await this.storePattern(p);
      }
      log.info({ moleculeId: molecule.id, patternCount: aiPatterns.length }, 'AI patterns extracted');
      return aiPatterns;
    }

    // Fallback to heuristic extraction
    const heuristicPatterns = extractPatternsHeuristic(molecule);
    for (const p of heuristicPatterns) {
      await this.storePattern(p);
    }
    log.info({ moleculeId: molecule.id, patternCount: heuristicPatterns.length }, 'Heuristic patterns extracted');
    return heuristicPatterns;
  }

  // --- Search patterns (FTS) ----------------------------------------------

  async searchPatterns(query: string, limit = 20): Promise<Pattern[]> {
    const pool = getPool();
    if (pool) {
      try {
        const { rows } = await pool.query(
          `SELECT id, formula_name, molecule_id, category, pattern_type,
                  title, description, evidence, confidence, tags, metadata, created_at
           FROM megabrain_fragments
           WHERE category = 'meow_pattern'
             AND content ILIKE '%' || $1 || '%'
           ORDER BY created_at DESC
           LIMIT $2`,
          [query, limit],
        );

        return rows.map((r: Record<string, unknown>) => this.rowToPattern(r));
      } catch (err) {
        log.warn({ err, query }, 'FTS search failed, falling back to in-memory');
      }
    }

    // In-memory fallback
    const lowerQuery = query.toLowerCase();
    return this.patterns
      .filter(p =>
        p.title.toLowerCase().includes(lowerQuery) ||
        p.description.toLowerCase().includes(lowerQuery) ||
        p.tags.some(t => t.toLowerCase().includes(lowerQuery)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  // --- Get context for a new molecule (context injection) ------------------

  async getContextForMolecule(
    formulaName: string,
    vars: Record<string, string>,
  ): Promise<string> {
    const pool = getPool();
    const relevantPatterns: Pattern[] = [];

    if (pool) {
      try {
        // Search by formula name
        const { rows: formulaRows } = await pool.query(
          `SELECT id, formula_name, molecule_id, category, pattern_type,
                  title, description, evidence, confidence, tags, metadata, created_at
           FROM megabrain_fragments
           WHERE category = 'meow_pattern'
             AND (content ILIKE '%' || $1 || '%')
           ORDER BY confidence DESC, created_at DESC
           LIMIT 10`,
          [formulaName],
        );
        relevantPatterns.push(...formulaRows.map((r: Record<string, unknown>) => this.rowToPattern(r)));

        // Search by vars (country, product, etc.)
        for (const [key, val] of Object.entries(vars)) {
          if (['country', 'product', 'hook_type', 'audience'].includes(key)) {
            const { rows: varRows } = await pool.query(
              `SELECT id, formula_name, molecule_id, category, pattern_type,
                      title, description, evidence, confidence, tags, metadata, created_at
               FROM megabrain_fragments
               WHERE category = 'meow_pattern'
                 AND content ILIKE '%' || $1 || '%'
               ORDER BY confidence DESC, created_at DESC
               LIMIT 5`,
              [val],
            );
            relevantPatterns.push(...varRows.map((r: Record<string, unknown>) => this.rowToPattern(r)));
          }
        }
      } catch (err) {
        log.warn({ err, formulaName }, 'Failed to fetch context patterns from DB');
      }
    }

    // Fallback to in-memory patterns
    if (relevantPatterns.length === 0) {
      const memPatterns = this.patterns
        .filter(p =>
          p.formulaName === formulaName ||
          Object.values(vars).some(v => p.tags.includes(v)),
        )
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10);
      relevantPatterns.push(...memPatterns);
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    const unique = relevantPatterns.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    if (unique.length === 0) {
      return '(No prior patterns found for this formula/context)';
    }

    // Build context string
    const lines = unique.slice(0, 8).map((p, i) => {
      const typeLabel = p.patternType.replace('_', ' ').toUpperCase();
      return `${i + 1}. [${typeLabel}] ${p.title} (confidence: ${p.confidence})\n   ${p.description}`;
    });

    return `=== LEARNED PATTERNS (${unique.length} relevant) ===\n${lines.join('\n\n')}`;
  }

  // --- Stats --------------------------------------------------------------

  getStats(): PatternStats {
    const byCategory: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let totalConf = 0;

    for (const p of this.patterns) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
      byType[p.patternType] = (byType[p.patternType] ?? 0) + 1;
      totalConf += p.confidence;
    }

    const sorted = [...this.patterns].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return {
      totalPatterns: this.patterns.length,
      byCategory,
      byType,
      avgConfidence: this.patterns.length > 0
        ? Math.round((totalConf / this.patterns.length) * 1000) / 1000
        : 0,
      oldestPattern: sorted.length > 0 ? sorted[0].createdAt : null,
      newestPattern: sorted.length > 0 ? sorted[sorted.length - 1].createdAt : null,
    };
  }

  // --- Prune old patterns -------------------------------------------------

  async pruneOldPatterns(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const beforeCount = this.patterns.length;
    this.patterns = this.patterns.filter(p => p.createdAt >= cutoff);
    const removed = beforeCount - this.patterns.length;

    const pool = getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `DELETE FROM megabrain_fragments
           WHERE category = 'meow_pattern' AND created_at < $1`,
          [cutoff.toISOString()],
        );
        const dbRemoved = res.rowCount ?? 0;
        log.info({ olderThanDays, memoryRemoved: removed, dbRemoved }, 'Old patterns pruned');
      } catch (err) {
        log.warn({ err }, 'Failed to prune patterns from DB');
      }
    }

    broadcast('meow:cognitive', {
      type: 'patterns_pruned',
      removedCount: removed,
      olderThanDays,
    });

    return removed;
  }

  // --- Private helpers ----------------------------------------------------

  private async extractWithGemini(molecule: Molecule): Promise<Pattern[] | null> {
    const stepSummary = molecule.steps.map(s => {
      const dur = s.startedAt && s.completedAt
        ? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
        : 0;
      return { id: s.id, title: s.title, status: s.status, skill: s.skill, durationMs: dur, error: s.error };
    });

    const prompt = `Extract actionable patterns from this molecule execution.

Formula: ${molecule.formulaName}
Status: ${molecule.status}
Variables: ${JSON.stringify(molecule.vars)}
Steps: ${JSON.stringify(stepSummary)}
Error: ${molecule.error ?? 'none'}

Extract 2-5 patterns. Respond with JSON array:
[{
  "category": "market_insight|creative_pattern|pricing_strategy|audience_behavior|operational|technical",
  "patternType": "success_pattern|failure_pattern|optimization|market_signal",
  "title": "short title",
  "description": "detailed description",
  "confidence": 0.0-1.0,
  "tags": ["tag1","tag2"]
}]`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]) as Array<{
        category: PatternCategory;
        patternType: PatternType;
        title: string;
        description: string;
        confidence: number;
        tags: string[];
      }>;

      return parsed
        .filter(p => p.title && p.description && p.category && p.patternType)
        .map(p => ({
          id: uuidv4(),
          formulaName: molecule.formulaName,
          moleculeId: molecule.id,
          category: p.category,
          patternType: p.patternType,
          title: p.title,
          description: p.description,
          evidence: JSON.stringify({ vars: molecule.vars, status: molecule.status }),
          confidence: Math.max(0, Math.min(1, p.confidence ?? 0.5)),
          tags: Array.isArray(p.tags) ? p.tags : [],
          createdAt: new Date(),
        }));
    } catch {
      log.warn({ moleculeId: molecule.id }, 'Failed to parse Gemini pattern response');
      return null;
    }
  }

  private async storePattern(pattern: Pattern): Promise<void> {
    // In-memory
    this.patterns.push(pattern);
    if (this.patterns.length > this.maxInMemory) {
      this.patterns = this.patterns.slice(-this.maxInMemory);
    }

    // DB: store in megabrain_fragments
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO megabrain_fragments
            (id, content, category, source, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING`,
          [
            pattern.id,
            `[${pattern.patternType}] ${pattern.title}\n${pattern.description}\nEvidence: ${pattern.evidence}`,
            'meow_pattern',
            `molecule:${pattern.moleculeId}`,
            JSON.stringify({
              formulaName: pattern.formulaName,
              moleculeId: pattern.moleculeId,
              patternCategory: pattern.category,
              patternType: pattern.patternType,
              confidence: pattern.confidence,
              tags: pattern.tags,
              ...(pattern.metadata ?? {}),
            }),
            pattern.createdAt.toISOString(),
          ],
        );
      } catch (err) {
        log.warn({ err, patternId: pattern.id }, 'Failed to persist pattern to megabrain_fragments');
      }
    }

    broadcast('meow:cognitive', {
      type: 'pattern_stored',
      patternId: pattern.id,
      category: pattern.category,
      patternType: pattern.patternType,
      title: pattern.title,
      formulaName: pattern.formulaName,
    });
  }

  private rowToPattern(r: Record<string, unknown>): Pattern {
    const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as Record<string, unknown> ?? {};
    return {
      id: r.id as string,
      formulaName: (meta.formulaName as string) ?? (r.formula_name as string) ?? '',
      moleculeId: (meta.moleculeId as string) ?? (r.molecule_id as string) ?? '',
      category: (meta.patternCategory as PatternCategory) ?? (r.category as PatternCategory) ?? 'operational',
      patternType: (meta.patternType as PatternType) ?? (r.pattern_type as PatternType) ?? 'success_pattern',
      title: (r.title as string) ?? '',
      description: (r.description as string) ?? (r.content as string) ?? '',
      evidence: (r.evidence as string) ?? '',
      confidence: typeof meta.confidence === 'number' ? meta.confidence : parseFloat((r.confidence as string) ?? '0.5'),
      tags: Array.isArray(meta.tags) ? meta.tags as string[] : [],
      metadata: meta,
      createdAt: new Date((r.created_at as string) ?? Date.now()),
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: PatternLibrary | null = null;

export function getPatternLibrary(): PatternLibrary {
  if (!instance) {
    instance = new PatternLibrary();
  }
  return instance;
}
