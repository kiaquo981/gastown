/**
 * FrankFlow Pattern Learner — Adaptive Error Memory
 *
 * Learns from failures across sessions. Records error patterns, categorizes them,
 * tracks frequency, and surfaces recurring issues as "Active Memory" context
 * that can be injected into agent prompts.
 *
 * Ported from FrankFlow's cross-session error intelligence system.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:pattern-learner');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | 'imports'
  | 'types'
  | 'tests'
  | 'lint'
  | 'auth'
  | 'not_found'
  | 'syntax'
  | 'network'
  | 'memory';

export interface ErrorPattern {
  id: string;
  hash: string;
  category: ErrorCategory;
  pattern: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  resolution?: string;
  beadIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PATTERNS_DIR = path.join(process.cwd(), '.gastown', 'patterns');
const PATTERNS_FILE = path.join(PATTERNS_DIR, 'error-patterns.json');
const MAX_BEAD_IDS_PER_PATTERN = 50;
const MAX_PATTERNS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Error Category Detection — regex-based classification
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ category: ErrorCategory; patterns: RegExp[] }> = [
  {
    category: 'imports',
    patterns: [
      /Cannot find module/i,
      /Module not found/i,
      /import.*not found/i,
      /Could not resolve/i,
      /No matching export/i,
      /does not provide an export/i,
      /ENOENT.*node_modules/i,
      /Cannot resolve dependency/i,
      /Missing dependency/i,
      /require\(.*\) is not defined/i,
    ],
  },
  {
    category: 'types',
    patterns: [
      /Type '.*' is not assignable/i,
      /Property '.*' does not exist on type/i,
      /Argument of type/i,
      /TS\d{4}/,
      /type error/i,
      /Expected \d+ arguments?, but got \d+/i,
      /Cannot read propert/i,
      /is not a function/i,
      /undefined is not an object/i,
      /null is not an object/i,
    ],
  },
  {
    category: 'tests',
    patterns: [
      /test failed/i,
      /assertion failed/i,
      /expect\(.*\)\.to/i,
      /FAIL\s/,
      /Test suite failed/i,
      /timeout.*test/i,
      /describe\s*\(/,
      /it\s*\(\s*['"]/,
      /AssertionError/i,
      /test.*error/i,
    ],
  },
  {
    category: 'lint',
    patterns: [
      /eslint/i,
      /prettier/i,
      /lint.*error/i,
      /no-unused-vars/i,
      /Parsing error/i,
      /Expected indentation/i,
      /Unexpected token/i,
      /ruff.*error/i,
      /flake8/i,
      /stylelint/i,
    ],
  },
  {
    category: 'auth',
    patterns: [
      /unauthorized/i,
      /forbidden/i,
      /authentication failed/i,
      /invalid token/i,
      /expired token/i,
      /401/,
      /403/,
      /EACCES/,
      /permission denied/i,
      /access denied/i,
    ],
  },
  {
    category: 'not_found',
    patterns: [
      /not found/i,
      /404/,
      /ENOENT/,
      /no such file/i,
      /does not exist/i,
      /path.*not.*found/i,
      /resource not found/i,
      /route not found/i,
    ],
  },
  {
    category: 'syntax',
    patterns: [
      /SyntaxError/,
      /Unexpected token/i,
      /Unexpected end of/i,
      /Invalid or unexpected/i,
      /Unterminated string/i,
      /Missing semicolon/i,
      /Unexpected identifier/i,
      /JSON.*parse.*error/i,
      /YAML.*parse/i,
      /Malformed/i,
    ],
  },
  {
    category: 'network',
    patterns: [
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
      /socket hang up/i,
      /network error/i,
      /fetch failed/i,
      /request failed/i,
      /DNS.*failed/i,
      /connection refused/i,
    ],
  },
  {
    category: 'memory',
    patterns: [
      /out of memory/i,
      /heap.*limit/i,
      /ENOMEM/,
      /OOM/,
      /JavaScript heap/i,
      /allocation failed/i,
      /memory.*exceeded/i,
      /stack overflow/i,
      /Maximum call stack/i,
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/** In-memory pattern store, synced to disk */
let patterns: Map<string, ErrorPattern> = new Map();
let loaded = false;

function ensureDir(): void {
  if (!fs.existsSync(PATTERNS_DIR)) {
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
  }
}

/**
 * Load patterns from disk into memory.
 */
function loadPatterns(): void {
  if (loaded) return;

  try {
    ensureDir();
    if (fs.existsSync(PATTERNS_FILE)) {
      const raw = fs.readFileSync(PATTERNS_FILE, 'utf-8');
      const arr: ErrorPattern[] = JSON.parse(raw);
      patterns = new Map();
      for (const p of arr) {
        // Rehydrate dates
        p.firstSeen = new Date(p.firstSeen);
        p.lastSeen = new Date(p.lastSeen);
        patterns.set(p.hash, p);
      }
      log.info({ count: patterns.size }, 'Error patterns loaded from disk');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load error patterns — starting fresh');
    patterns = new Map();
  }

  loaded = true;
}

/**
 * Save patterns to disk.
 */
function savePatterns(): void {
  try {
    ensureDir();
    const arr = Array.from(patterns.values());
    // Sort by count descending before saving
    arr.sort((a, b) => b.count - a.count);
    // Trim if too many
    const trimmed = arr.slice(0, MAX_PATTERNS);
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
  } catch (err) {
    log.warn({ err }, 'Failed to save error patterns');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization & Hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an error message for consistent hashing:
 * - Strip line numbers (e.g., `:42:`)
 * - Strip absolute paths
 * - Strip UUIDs
 * - Strip timestamps
 * - Collapse whitespace
 * - Lowercase
 */
export function normalizeError(error: string): string {
  let normalized = error;

  // Strip absolute paths (Unix + Windows)
  normalized = normalized.replace(/\/[^\s:'"]+/g, '<PATH>');
  normalized = normalized.replace(/[A-Z]:\\[^\s:'"]+/gi, '<PATH>');

  // Strip line:column numbers
  normalized = normalized.replace(/:\d+:\d+/g, ':<LINE>');
  normalized = normalized.replace(/\bline\s+\d+/gi, 'line <LINE>');

  // Strip UUIDs
  normalized = normalized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');

  // Strip hex hashes (8+ chars)
  normalized = normalized.replace(/\b[0-9a-f]{8,}\b/gi, '<HASH>');

  // Strip timestamps (ISO format)
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>');

  // Strip numeric IDs
  normalized = normalized.replace(/\b\d{4,}\b/g, '<ID>');

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Lowercase
  normalized = normalized.toLowerCase();

  return normalized;
}

/**
 * Hash a normalized error string using MD5 (fast, sufficient for dedup).
 */
function hashError(normalizedError: string): string {
  return crypto.createHash('md5').update(normalizedError).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Categorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Categorize an error message into one of the predefined categories.
 * Returns the best-matching category based on pattern matches.
 */
export function categorizeError(error: string): ErrorCategory {
  const msg = typeof error === 'string' ? error : String(error);

  let bestCategory: ErrorCategory = 'syntax'; // default fallback
  let bestScore = 0;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(msg)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  return bestCategory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an error occurrence. If the normalized pattern was seen before,
 * increment its count. Otherwise, create a new pattern entry.
 */
export function recordError(error: string, beadId?: string): ErrorPattern {
  loadPatterns();

  const normalized = normalizeError(error);
  const hash = hashError(normalized);
  const category = categorizeError(error);
  const now = new Date();

  const existing = patterns.get(hash);

  if (existing) {
    // Update existing pattern
    existing.lastSeen = now;
    existing.count++;
    if (beadId && !existing.beadIds.includes(beadId)) {
      existing.beadIds.push(beadId);
      if (existing.beadIds.length > MAX_BEAD_IDS_PER_PATTERN) {
        existing.beadIds = existing.beadIds.slice(-MAX_BEAD_IDS_PER_PATTERN);
      }
    }

    log.debug({ hash, category, count: existing.count }, 'Error pattern updated');
    savePatterns();

    broadcast('frankflow:pattern', {
      action: 'updated',
      hash,
      category,
      count: existing.count,
    });

    return existing;
  }

  // Create new pattern
  const pattern: ErrorPattern = {
    id: uuidv4(),
    hash,
    category,
    pattern: error.length > 500 ? error.slice(0, 500) + '...' : error,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    beadIds: beadId ? [beadId] : [],
  };

  patterns.set(hash, pattern);
  log.info({ hash, category, pattern: pattern.pattern.slice(0, 80) }, 'New error pattern recorded');
  savePatterns();

  broadcast('frankflow:pattern', {
    action: 'new',
    hash,
    category,
    pattern: pattern.pattern.slice(0, 80),
  });

  return pattern;
}

/**
 * Get active (recurring) patterns, sorted by count descending.
 */
export function getActivePatterns(minCount = 2): ErrorPattern[] {
  loadPatterns();

  return Array.from(patterns.values())
    .filter(p => p.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all patterns (including single-occurrence).
 */
export function getAllPatterns(): ErrorPattern[] {
  loadPatterns();
  return Array.from(patterns.values()).sort((a, b) => b.count - a.count);
}

/**
 * Get patterns filtered by category.
 */
export function getPatternsByCategory(category: ErrorCategory): ErrorPattern[] {
  loadPatterns();

  return Array.from(patterns.values())
    .filter(p => p.category === category)
    .sort((a, b) => b.count - a.count);
}

/**
 * Set a known resolution/fix for a pattern.
 */
export function setResolution(patternId: string, resolution: string): boolean {
  loadPatterns();

  for (const [, pattern] of patterns) {
    if (pattern.id === patternId) {
      pattern.resolution = resolution;
      savePatterns();
      log.info({ patternId, resolution: resolution.slice(0, 80) }, 'Resolution set for pattern');
      return true;
    }
  }

  log.warn({ patternId }, 'Pattern not found for resolution');
  return false;
}

/**
 * Generate "Active Memory" context text — a formatted summary of
 * top recurring error patterns that can be injected into agent prompts.
 *
 * This is FrankFlow's key innovation: agents learn from past failures
 * without explicit re-training.
 */
export function generateSessionContext(maxPatterns = 10): string {
  loadPatterns();

  const active = getActivePatterns(2).slice(0, maxPatterns);

  if (active.length === 0) {
    return '';
  }

  const lines: string[] = [
    '=== ACTIVE ERROR MEMORY (FrankFlow Pattern Learner) ===',
    '',
    `Tracking ${patterns.size} unique error patterns. ${active.length} recurring patterns active.`,
    '',
  ];

  for (const p of active) {
    const age = timeSince(p.firstSeen);
    const lastHit = timeSince(p.lastSeen);
    const beadCount = p.beadIds.length;

    lines.push(`[${p.category.toUpperCase()}] x${p.count} (first: ${age}, last: ${lastHit}, ${beadCount} beads)`);
    lines.push(`  Pattern: ${p.pattern.slice(0, 120)}`);

    if (p.resolution) {
      lines.push(`  KNOWN FIX: ${p.resolution}`);
    }

    lines.push('');
  }

  lines.push('=== END ACTIVE ERROR MEMORY ===');

  return lines.join('\n');
}

/**
 * Get pattern by ID.
 */
export function getPattern(patternId: string): ErrorPattern | undefined {
  loadPatterns();
  for (const [, pattern] of patterns) {
    if (pattern.id === patternId) return pattern;
  }
  return undefined;
}

/**
 * Get summary stats for the pattern learner.
 */
export function getPatternStats(): {
  total: number;
  recurring: number;
  withResolution: number;
  byCategory: Record<string, number>;
  topPatterns: Array<{ category: string; count: number; pattern: string }>;
} {
  loadPatterns();

  const all = Array.from(patterns.values());
  const byCategory: Record<string, number> = {};

  for (const p of all) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  }

  const topPatterns = all
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(p => ({
      category: p.category,
      count: p.count,
      pattern: p.pattern.slice(0, 80),
    }));

  return {
    total: all.length,
    recurring: all.filter(p => p.count >= 2).length,
    withResolution: all.filter(p => p.resolution).length,
    byCategory,
    topPatterns,
  };
}

/**
 * Clear all patterns (for testing or reset).
 */
export function clearPatterns(): void {
  patterns.clear();
  loaded = false;
  try {
    if (fs.existsSync(PATTERNS_FILE)) {
      fs.unlinkSync(PATTERNS_FILE);
    }
  } catch {
    // ignore
  }
  log.info('Error patterns cleared');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
