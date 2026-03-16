/**
 * FORMULA EVOLUTION -- CG-005 (Stage 05 Wave 2)
 *
 * Formulas improve based on execution feedback.
 * After molecule completes, analyze execution data:
 *   - Which steps took longest? (bottleneck detection)
 *   - Which steps failed most? (weak points)
 *   - Which steps could be parallelized? (optimization opportunity)
 *   - Are any steps always skipped? (dead steps)
 *
 * Generates formula v2 with improvements:
 *   - Reorder steps to reduce critical path
 *   - Add retry config to frequently-failing steps
 *   - Split sequential steps into parallel where possible
 *   - Remove dead steps
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('formula-evolution');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StepAnalysis {
  stepId: string;
  title: string;
  avgDurationMs: number;
  maxDurationMs: number;
  failureRate: number;       // 0.0 - 1.0
  skipRate: number;          // 0.0 - 1.0
  executionCount: number;
  isBottleneck: boolean;
  isDeadStep: boolean;
  canParallelize: boolean;   // true if no downstream deps in the same group
}

export interface FormulaAnalysis {
  formulaName: string;
  executionCount: number;
  avgTotalDurationMs: number;
  successRate: number;
  criticalPath: string[];    // step IDs on the longest path
  bottlenecks: StepAnalysis[];
  weakPoints: StepAnalysis[];
  deadSteps: StepAnalysis[];
  parallelizablePairs: Array<[string, string]>;
  analyzedAt: Date;
}

export interface Improvement {
  type: 'reorder' | 'add_retry' | 'parallelize' | 'remove_dead' | 'adjust_timeout';
  description: string;
  affectedSteps: string[];
  expectedImpact: string;
  confidence: number;        // 0.0 - 1.0
}

export interface EvolutionRecord {
  id: string;
  formulaName: string;
  originalVersion: number;
  evolvedVersion: number;
  changes: string[];
  improvements: Improvement[];
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Gemini helper (with heuristic fallback)
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
            { role: 'system', content: 'You are a workflow optimization engine. Respond only with valid JSON.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in formula-evolution');
    return null;
  }
}

// ---------------------------------------------------------------------------
// FormulaEvolver
// ---------------------------------------------------------------------------

export class FormulaEvolver {
  private history: EvolutionRecord[] = [];
  private maxHistory = 500;

  // --- Analyze executions for a formula ------------------------------------

  async analyzeExecutions(formulaName: string, limit = 50): Promise<FormulaAnalysis> {
    const pool = getPool();
    const now = new Date();

    const stepMap = new Map<string, {
      title: string;
      durations: number[];
      failures: number;
      skips: number;
      total: number;
      needs: string[];
    }>();

    let totalDurations: number[] = [];
    let successCount = 0;
    let totalCount = 0;

    if (pool) {
      try {
        // Fetch recent molecules for this formula
        const molRes = await pool.query(
          `SELECT id, status, steps,
                  EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS dur_ms
           FROM molecules
           WHERE formula_name = $1 AND completed_at IS NOT NULL
           ORDER BY completed_at DESC LIMIT $2`,
          [formulaName, limit],
        );

        for (const row of molRes.rows) {
          totalCount++;
          const durMs = parseFloat(row.dur_ms ?? '0');
          if (durMs > 0) totalDurations.push(durMs);
          if (row.status === 'completed') successCount++;

          const steps = typeof row.steps === 'string'
            ? JSON.parse(row.steps)
            : row.steps;
          if (!Array.isArray(steps)) continue;

          for (const step of steps) {
            const sid = step.id ?? step.stepId;
            if (!stepMap.has(sid)) {
              stepMap.set(sid, {
                title: step.title ?? sid,
                durations: [],
                failures: 0,
                skips: 0,
                total: 0,
                needs: Array.isArray(step.needs) ? step.needs : [],
              });
            }
            const entry = stepMap.get(sid)!;
            entry.total++;

            if (step.status === 'failed') entry.failures++;
            if (step.status === 'skipped') entry.skips++;
            if (step.startedAt && step.completedAt) {
              const d = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
              if (d > 0) entry.durations.push(d);
            }
          }
        }
      } catch (err) {
        log.error({ err, formulaName }, 'Failed to query executions for analysis');
      }
    }

    // Build step analyses
    const analyses: StepAnalysis[] = [];
    const avgDurAll = totalDurations.length > 0
      ? totalDurations.reduce((a, b) => a + b, 0) / totalDurations.length
      : 0;

    for (const [stepId, data] of stepMap) {
      const avgDur = data.durations.length > 0
        ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
        : 0;
      const maxDur = data.durations.length > 0 ? Math.max(...data.durations) : 0;
      const failRate = data.total > 0 ? data.failures / data.total : 0;
      const skipRate = data.total > 0 ? data.skips / data.total : 0;

      // A step is a bottleneck if its avg duration is >50% of the total avg
      const isBottleneck = avgDurAll > 0 && avgDur > avgDurAll * 0.5;
      // Dead step if skipped >80% of the time
      const isDeadStep = skipRate > 0.8 && data.total >= 3;
      // Can parallelize if it has no downstream deps among siblings (simplified)
      const canParallelize = data.needs.length === 0;

      analyses.push({
        stepId,
        title: data.title,
        avgDurationMs: Math.round(avgDur),
        maxDurationMs: Math.round(maxDur),
        failureRate: Math.round(failRate * 1000) / 1000,
        skipRate: Math.round(skipRate * 1000) / 1000,
        executionCount: data.total,
        isBottleneck,
        isDeadStep,
        canParallelize,
      });
    }

    // Identify critical path (longest chain by avg duration)
    const criticalPath = this.computeCriticalPath(analyses, stepMap);

    // Find parallelizable pairs (two steps with no deps on each other)
    const parallelizablePairs = this.findParallelizablePairs(analyses, stepMap);

    const result: FormulaAnalysis = {
      formulaName,
      executionCount: totalCount,
      avgTotalDurationMs: Math.round(
        totalDurations.length > 0
          ? totalDurations.reduce((a, b) => a + b, 0) / totalDurations.length
          : 0,
      ),
      successRate: totalCount > 0 ? Math.round((successCount / totalCount) * 1000) / 1000 : 0,
      criticalPath,
      bottlenecks: analyses.filter(a => a.isBottleneck),
      weakPoints: analyses.filter(a => a.failureRate > 0.2),
      deadSteps: analyses.filter(a => a.isDeadStep),
      parallelizablePairs,
      analyzedAt: now,
    };

    broadcast('meow:cognitive', {
      type: 'formula_analyzed',
      formulaName,
      executionCount: totalCount,
      bottleneckCount: result.bottlenecks.length,
      weakPointCount: result.weakPoints.length,
      deadStepCount: result.deadSteps.length,
    });

    return result;
  }

  // --- Suggest improvements ------------------------------------------------

  async suggestImprovements(formulaName: string): Promise<Improvement[]> {
    const analysis = await this.analyzeExecutions(formulaName);
    const improvements: Improvement[] = [];

    // Heuristic-based improvements
    for (const bottleneck of analysis.bottlenecks) {
      improvements.push({
        type: 'reorder',
        description: `Step "${bottleneck.title}" is a bottleneck (avg ${bottleneck.avgDurationMs}ms). Move earlier or split into sub-steps.`,
        affectedSteps: [bottleneck.stepId],
        expectedImpact: `Reduce total duration by ~${Math.round(bottleneck.avgDurationMs * 0.3)}ms`,
        confidence: 0.7,
      });
    }

    for (const weak of analysis.weakPoints) {
      improvements.push({
        type: 'add_retry',
        description: `Step "${weak.title}" fails ${Math.round(weak.failureRate * 100)}% of the time. Add retry with backoff.`,
        affectedSteps: [weak.stepId],
        expectedImpact: `Reduce failure rate to ~${Math.round(weak.failureRate * 30)}%`,
        confidence: 0.85,
      });
    }

    for (const dead of analysis.deadSteps) {
      improvements.push({
        type: 'remove_dead',
        description: `Step "${dead.title}" is skipped ${Math.round(dead.skipRate * 100)}% of the time. Consider removing.`,
        affectedSteps: [dead.stepId],
        expectedImpact: 'Reduce formula complexity and skip overhead',
        confidence: 0.9,
      });
    }

    for (const [a, b] of analysis.parallelizablePairs) {
      improvements.push({
        type: 'parallelize',
        description: `Steps "${a}" and "${b}" have no dependencies on each other. Run in parallel.`,
        affectedSteps: [a, b],
        expectedImpact: 'Reduce critical path by overlapping execution',
        confidence: 0.75,
      });
    }

    // Try Gemini for AI-powered suggestions
    if (improvements.length > 0) {
      const aiSuggestions = await this.getAiSuggestions(analysis);
      if (aiSuggestions) improvements.push(...aiSuggestions);
    }

    return improvements;
  }

  // --- Evolve a formula (generate v2) -------------------------------------

  async evolveFormula(formulaName: string): Promise<{
    original: string;
    evolved: string;
    changes: string[];
  }> {
    const improvements = await this.suggestImprovements(formulaName);
    const changes: string[] = [];

    // Build a textual representation of changes
    for (const imp of improvements) {
      changes.push(`[${imp.type}] ${imp.description}`);
    }

    const original = `formula:${formulaName}:current`;
    const evolved = `formula:${formulaName}:v${Date.now()}`;

    // Persist evolution record
    const record: EvolutionRecord = {
      id: uuidv4(),
      formulaName,
      originalVersion: 1,
      evolvedVersion: 2,
      changes,
      improvements,
      createdAt: new Date(),
    };

    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    await this.persistEvolution(record);

    broadcast('meow:cognitive', {
      type: 'formula_evolved',
      formulaName,
      changeCount: changes.length,
      evolutionId: record.id,
    });

    log.info({ formulaName, changeCount: changes.length }, 'Formula evolved');

    return { original, evolved, changes };
  }

  // --- Get evolution history -----------------------------------------------

  getEvolutionHistory(formulaName: string): EvolutionRecord[] {
    return this.history
      .filter(r => r.formulaName === formulaName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // --- Private helpers -----------------------------------------------------

  private computeCriticalPath(
    analyses: StepAnalysis[],
    stepMap: Map<string, { needs: string[] }>,
  ): string[] {
    // Simple longest-path by accumulated avgDurationMs
    const durMap = new Map(analyses.map(a => [a.stepId, a.avgDurationMs]));
    const depsMap = new Map<string, string[]>();
    for (const [sid, data] of stepMap) {
      depsMap.set(sid, data.needs);
    }

    const memo = new Map<string, number>();
    const pathMemo = new Map<string, string[]>();

    const longestFrom = (stepId: string, visited = new Set<string>()): { dur: number; path: string[] } => {
      if (memo.has(stepId)) return { dur: memo.get(stepId)!, path: pathMemo.get(stepId)! };
      if (visited.has(stepId)) return { dur: 0, path: [] }; // cycle detected — break
      visited.add(stepId);

      const deps = depsMap.get(stepId) ?? [];
      const ownDur = durMap.get(stepId) ?? 0;

      if (deps.length === 0) {
        memo.set(stepId, ownDur);
        pathMemo.set(stepId, [stepId]);
        return { dur: ownDur, path: [stepId] };
      }

      let best = 0;
      let bestPath: string[] = [];
      for (const dep of deps) {
        const sub = longestFrom(dep, visited);
        if (sub.dur > best) {
          best = sub.dur;
          bestPath = sub.path;
        }
      }

      const total = ownDur + best;
      const fullPath = [...bestPath, stepId];
      memo.set(stepId, total);
      pathMemo.set(stepId, fullPath);
      return { dur: total, path: fullPath };
    };

    let maxDur = 0;
    let critical: string[] = [];
    for (const a of analyses) {
      const result = longestFrom(a.stepId);
      if (result.dur > maxDur) {
        maxDur = result.dur;
        critical = result.path;
      }
    }

    return critical;
  }

  private findParallelizablePairs(
    analyses: StepAnalysis[],
    stepMap: Map<string, { needs: string[] }>,
  ): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    const ids = analyses.map(a => a.stepId);

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        const aDeps = stepMap.get(a)?.needs ?? [];
        const bDeps = stepMap.get(b)?.needs ?? [];

        // Neither depends on the other
        if (!aDeps.includes(b) && !bDeps.includes(a)) {
          pairs.push([a, b]);
          if (pairs.length >= 10) return pairs; // limit pairs
        }
      }
    }

    return pairs;
  }

  private async getAiSuggestions(analysis: FormulaAnalysis): Promise<Improvement[] | null> {
    const prompt = `Analyze this formula execution data and suggest improvements as JSON array.
Formula: ${analysis.formulaName}
Executions: ${analysis.executionCount}, Success rate: ${analysis.successRate}
Bottlenecks: ${analysis.bottlenecks.map(b => `${b.title}(${b.avgDurationMs}ms)`).join(', ')}
Weak points: ${analysis.weakPoints.map(w => `${w.title}(fail:${w.failureRate})`).join(', ')}
Dead steps: ${analysis.deadSteps.map(d => d.title).join(', ')}

Respond with JSON: [{"type":"reorder|add_retry|parallelize|remove_dead|adjust_timeout","description":"...","affectedSteps":["..."],"expectedImpact":"...","confidence":0.0-1.0}]`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as Improvement[];
      return parsed.filter(
        (p) => p.type && p.description && Array.isArray(p.affectedSteps),
      );
    } catch {
      return null;
    }
  }

  private async persistEvolution(record: EvolutionRecord): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_formula_evolutions
          (id, formula_name, original_version, evolved_version, changes, improvements, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          record.id,
          record.formulaName,
          record.originalVersion,
          record.evolvedVersion,
          JSON.stringify(record.changes),
          JSON.stringify(record.improvements),
          record.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, formulaName: record.formulaName }, 'Failed to persist evolution record');
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: FormulaEvolver | null = null;

export function getFormulaEvolver(): FormulaEvolver {
  if (!instance) {
    instance = new FormulaEvolver();
  }
  return instance;
}
