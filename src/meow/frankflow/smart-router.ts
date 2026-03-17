/**
 * FrankFlow Smart Router — Intent Detection & Specialist Routing
 *
 * Matches incoming task text against pattern-based routing categories
 * to determine the best specialist (agent/worker) and inject relevant context.
 *
 * 13 built-in categories from FrankFlow + extensible custom categories.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:router');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteCategory {
  id: string;
  patterns: RegExp[];
  specialist: string;
  contextInjection: string;
  priority: number;
  workflow?: string;
}

export interface RouteResult {
  category: string;
  specialist: string;
  confidence: number;
  contextInjection: string;
  workflow?: string;
  matchedPatterns: string[];
}

interface RouteHistoryEntry {
  id: string;
  text: string;
  result: RouteResult;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Categories — ported from FrankFlow
// ─────────────────────────────────────────────────────────────────────────────

const defaultCategories: RouteCategory[] = [
  {
    id: 'debug',
    patterns: [
      /\b(debug|bug|fix|crash|error|broken|failing|exception|stack\s?trace)\b/i,
      /\b(not\s+work|doesn'?t\s+work|issue|regression|breakpoint)\b/i,
    ],
    specialist: 'debugger',
    contextInjection:
      'Focus on identifying the root cause. Check stack traces, reproduce the issue, and verify the fix does not introduce regressions.',
    priority: 90,
    workflow: 'debug-cycle',
  },
  {
    id: 'security',
    patterns: [
      /\b(security|vuln|CVE|auth|XSS|CSRF|inject|sanitiz|escap|token|secret|password|credential)\b/i,
      /\b(OWASP|penetration|exploit|hardening|encryption|cipher|RBAC|permission)\b/i,
    ],
    specialist: 'security-sentinel',
    contextInjection:
      'Apply OWASP Top 10 principles. Check for injection, auth bypass, data exposure, CSRF, XSS. Validate all inputs. Audit secrets handling.',
    priority: 95,
    workflow: 'security-review',
  },
  {
    id: 'review',
    patterns: [
      /\b(review|PR|pull\s?request|code\s?review|approve|merge|diff)\b/i,
      /\b(feedback|suggestion|comment|change\s?request)\b/i,
    ],
    specialist: 'reviewer',
    contextInjection:
      'Review for correctness, readability, performance, and security. Check edge cases and error handling. Verify tests cover the changes.',
    priority: 80,
    workflow: 'review-pipeline',
  },
  {
    id: 'performance',
    patterns: [
      /\b(perf|performance|slow|latency|optimize|speed|cache|memory\s?leak|bottleneck)\b/i,
      /\b(profil|benchmark|throughput|response\s?time|N\+1|query\s?plan)\b/i,
    ],
    specialist: 'performance-engineer',
    contextInjection:
      'Profile before optimizing. Identify the hotspot. Measure before and after. Consider caching, batching, indexing, and algorithm improvements.',
    priority: 75,
  },
  {
    id: 'testing',
    patterns: [
      /\b(test|spec|coverage|assert|mock|stub|fixture|e2e|integration|unit\s?test)\b/i,
      /\b(vitest|jest|playwright|cypress|pytest|testing\s?library)\b/i,
    ],
    specialist: 'qa-engineer',
    contextInjection:
      'Write tests that verify behavior, not implementation. Cover happy paths, edge cases, and error scenarios. Aim for meaningful coverage, not just percentage.',
    priority: 70,
    workflow: 'test-suite',
  },
  {
    id: 'spec',
    patterns: [
      /\b(spec|specification|requirement|acceptance\s?criteria|user\s?story|PRD)\b/i,
      /\b(design\s?doc|RFC|ADR|proposal|scope)\b/i,
    ],
    specialist: 'architect',
    contextInjection:
      'Break the spec into clear tasks with acceptance criteria. Identify dependencies, risks, and open questions. Propose a phased implementation plan.',
    priority: 85,
    workflow: 'spec-sync',
  },
  {
    id: 'feature',
    patterns: [
      /\b(feature|implement|build|create|add|new|develop|functionality)\b/i,
      /\b(endpoint|API|component|module|service|page|view)\b/i,
    ],
    specialist: 'developer',
    contextInjection:
      'Follow existing codebase patterns. Implement incrementally with tests. Consider error handling, edge cases, and backwards compatibility.',
    priority: 50,
  },
  {
    id: 'refactor',
    patterns: [
      /\b(refactor|clean\s?up|restructure|simplify|extract|decompose|DRY|SOLID)\b/i,
      /\b(tech\s?debt|code\s?smell|legacy|migrate|modernize)\b/i,
    ],
    specialist: 'refactorer',
    contextInjection:
      'Refactor in small, tested steps. Preserve existing behavior (characterization tests first). Use automated refactoring tools where possible.',
    priority: 60,
  },
  {
    id: 'infra',
    patterns: [
      /\b(infra|deploy|CI|CD|pipeline|docker|kubernetes|terraform|ansible)\b/i,
      /\b(railway|vercel|AWS|GCP|Azure|helm|nginx|monitoring|alert)\b/i,
    ],
    specialist: 'devops',
    contextInjection:
      'Infrastructure changes must be idempotent. Test in staging first. Document rollback procedures. Monitor after deployment.',
    priority: 65,
    workflow: 'deploy-pipeline',
  },
  {
    id: 'database',
    patterns: [
      /\b(database|DB|SQL|migration|schema|table|index|query|postgres|supabase)\b/i,
      /\b(foreign\s?key|constraint|trigger|view|materialized|partition)\b/i,
    ],
    specialist: 'dba',
    contextInjection:
      'Write reversible migrations. Test on a copy first. Check for N+1 queries. Add indexes for common query patterns. Validate data integrity.',
    priority: 70,
    workflow: 'migration-pipeline',
  },
  {
    id: 'docs',
    patterns: [
      /\b(doc|documentation|readme|comment|JSDoc|API\s?doc|guide|tutorial)\b/i,
      /\b(changelog|release\s?note|storybook|swagger|openapi)\b/i,
    ],
    specialist: 'technical-writer',
    contextInjection:
      'Documentation should be clear, concise, and up-to-date. Include code examples. Write for the audience (dev vs user). Keep in sync with code.',
    priority: 40,
  },
  {
    id: 'ui',
    patterns: [
      /\b(UI|UX|frontend|component|layout|style|CSS|Tailwind|responsive|accessibility)\b/i,
      /\b(design|Figma|animation|interaction|form|modal|sidebar|navigation)\b/i,
    ],
    specialist: 'frontend-dev',
    contextInjection:
      'Follow the design system. Ensure responsive behavior across breakpoints. Test keyboard navigation and screen readers. Optimize for perceived performance.',
    priority: 55,
    workflow: 'ui-review',
  },
  {
    id: 'workflow',
    patterns: [
      /\b(workflow|automation|pipeline|cron|scheduled|trigger|webhook|event)\b/i,
      /\b(orchestrat|agent|multi.?step|saga|state\s?machine)\b/i,
    ],
    specialist: 'orchestrator',
    contextInjection:
      'Design for idempotency and failure recovery. Add checkpoints for long-running workflows. Log state transitions. Handle timeouts gracefully.',
    priority: 60,
    workflow: 'workflow-design',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let categories: RouteCategory[] = [...defaultCategories];
const routeHistory: RouteHistoryEntry[] = [];
const MAX_HISTORY = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Core Routing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route a task text to the best matching specialist.
 *
 * Scoring:
 * - Each pattern match contributes (category.priority / 100)
 * - Multiple matches in the same category stack (up to a point)
 * - The category with the highest total score wins
 * - Confidence is normalized to 0-1 based on max possible score
 */
export function routeTask(text: string): RouteResult {
  if (!text || text.trim().length === 0) {
    return {
      category: 'feature',
      specialist: 'developer',
      confidence: 0.1,
      contextInjection: 'No specific context detected. Implementing as a general feature task.',
      matchedPatterns: [],
    };
  }

  const scores: Map<string, { score: number; matches: string[] }> = new Map();

  // Sort by priority descending so high-priority categories are checked first
  const sorted = [...categories].sort((a, b) => b.priority - a.priority);

  for (const cat of sorted) {
    let catScore = 0;
    const catMatches: string[] = [];

    for (const pattern of cat.patterns) {
      const matches = text.match(new RegExp(pattern, 'gi'));
      if (matches) {
        const matchCount = matches.length;
        // Each match adds priority weight, diminishing for repeated matches
        catScore += (cat.priority / 100) * (1 + Math.log2(matchCount));
        catMatches.push(...matches.map(m => m.trim()));
      }
    }

    if (catScore > 0) {
      scores.set(cat.id, { score: catScore, matches: [...new Set(catMatches)] });
    }
  }

  // Find the best match
  let bestCategory: RouteCategory | null = null;
  let bestScore = 0;
  let bestMatches: string[] = [];

  for (const [catId, { score, matches }] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestMatches = matches;
      bestCategory = categories.find(c => c.id === catId) || null;
    }
  }

  // Fallback to 'feature' if no match
  if (!bestCategory) {
    bestCategory = categories.find(c => c.id === 'feature')!;
    bestScore = 0.1;
    bestMatches = [];
  }

  // Normalize confidence: max realistic score is ~3 (high priority + multiple matches)
  const confidence = Math.min(bestScore / 3, 1);

  const result: RouteResult = {
    category: bestCategory.id,
    specialist: bestCategory.specialist,
    confidence: Math.round(confidence * 100) / 100,
    contextInjection: bestCategory.contextInjection,
    workflow: bestCategory.workflow,
    matchedPatterns: bestMatches.slice(0, 10), // limit to avoid huge arrays
  };

  // Record in history
  routeHistory.unshift({ id: uuidv4(), text: text.slice(0, 200), result, timestamp: new Date() });
  if (routeHistory.length > MAX_HISTORY) routeHistory.splice(MAX_HISTORY);

  log.info(
    { category: result.category, specialist: result.specialist, confidence: result.confidence },
    'Task routed',
  );

  broadcast('frankflow:route', {
    category: result.category,
    specialist: result.specialist,
    confidence: result.confidence,
  });

  return result;
}

/**
 * Route a bead to an appropriate worker based on its title and description.
 * Fetches bead from DB if pool is available, otherwise returns null.
 */
export async function routeBeadToWorker(
  beadId: string,
): Promise<(RouteResult & { beadId: string }) | null> {
  const pool = getPool();
  if (!pool) {
    log.warn({ beadId }, 'DB not available — cannot route bead');
    return null;
  }

  try {
    const res = await pool.query(
      'SELECT id, title, description FROM beads WHERE id = $1',
      [beadId],
    );

    if (res.rows.length === 0) {
      log.warn({ beadId }, 'Bead not found');
      return null;
    }

    const bead = res.rows[0];
    const text = `${bead.title || ''} ${bead.description || ''}`;
    const result = routeTask(text);

    log.info({ beadId, category: result.category, specialist: result.specialist }, 'Bead routed');

    return { ...result, beadId };
  } catch (err) {
    log.error({ beadId, err }, 'Failed to route bead');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Category Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all registered routing categories.
 */
export function getCategories(): RouteCategory[] {
  return [...categories];
}

/**
 * Add a new routing category.
 * Patterns are provided as string regexes and compiled into RegExp objects.
 */
export function addCategory(category: RouteCategory): void {
  // Remove existing with same ID if present
  categories = categories.filter(c => c.id !== category.id);
  categories.push(category);
  categories.sort((a, b) => b.priority - a.priority);

  log.info({ categoryId: category.id, specialist: category.specialist }, 'Route category added');
}

/**
 * Add a category from plain objects (e.g., from API requests).
 * Converts string patterns to RegExp.
 */
export function addCategoryFromStrings(input: {
  id: string;
  patterns: string[];
  specialist: string;
  contextInjection: string;
  priority: number;
  workflow?: string;
}): void {
  const compiledPatterns = input.patterns.map(p => new RegExp(p, 'i'));
  addCategory({
    ...input,
    patterns: compiledPatterns,
  });
}

/**
 * Remove a routing category by ID.
 */
export function removeCategory(id: string): boolean {
  const before = categories.length;
  categories = categories.filter(c => c.id !== id);
  const removed = categories.length < before;

  if (removed) {
    log.info({ categoryId: id }, 'Route category removed');
  }

  return removed;
}

/**
 * Reset to default categories.
 */
export function resetCategories(): void {
  categories = [...defaultCategories];
  log.info('Route categories reset to defaults');
}

// ─────────────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get recent routing decisions.
 */
export function getRouteHistory(limit = 50): RouteHistoryEntry[] {
  return routeHistory.slice(0, limit);
}

/**
 * Get routing statistics.
 */
export function getRouteStats(): {
  totalRouted: number;
  byCategory: Record<string, number>;
  avgConfidence: number;
} {
  const byCategory: Record<string, number> = {};
  let totalConfidence = 0;

  for (const entry of routeHistory) {
    byCategory[entry.result.category] = (byCategory[entry.result.category] || 0) + 1;
    totalConfidence += entry.result.confidence;
  }

  return {
    totalRouted: routeHistory.length,
    byCategory,
    avgConfidence:
      routeHistory.length > 0
        ? Math.round((totalConfidence / routeHistory.length) * 100) / 100
        : 0,
  };
}
