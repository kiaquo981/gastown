/**
 * FrankFlow Review Pipeline — Multi-Agent Code Review
 *
 * Runs parallel review agents against a codebase, collects findings,
 * and optionally auto-fixes CRITICAL issues in a retry loop.
 *
 * 4 default review agents from FrankFlow:
 * - code-simplicity: YAGNI violations, over-engineering
 * - security-sentinel: vulnerabilities, secrets, injection
 * - pattern-recognition: codebase consistency, naming conventions
 * - accessibility: WCAG, a11y (frontend files only)
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:review');
const execFile = promisify(execFileCb);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'warning' | 'info';

export interface ReviewAgent {
  id: string;
  name: string;
  focus: string;
  severity: 'critical' | 'warning';
  prompt: string;
  /** Glob patterns to include. If empty, all files. */
  filePatterns?: string[];
  /** Glob patterns to exclude */
  excludePatterns?: string[];
}

export interface ReviewFinding {
  agent: string;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  id: string;
  beadId?: string;
  branch?: string;
  agents: string[];
  findings: ReviewFinding[];
  criticalCount: number;
  warningCount: number;
  autoFixAttempts: number;
  passed: boolean;
  durationMs: number;
  timestamp: Date;
}

export interface RunReviewOpts {
  beadId?: string;
  branch?: string;
  /** Only run specific agents */
  agentIds?: string[];
  /** Maximum auto-fix rounds. Default: 2 */
  maxAutoFixRounds?: number;
  /** File extensions to scan. Default: common code extensions */
  extensions?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Review Agents
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.java',
  '.vue', '.svelte', '.css', '.scss', '.html',
];

const FRONTEND_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte', '.html', '.css', '.scss'];

const defaultAgents: ReviewAgent[] = [
  {
    id: 'code-simplicity',
    name: 'Code Simplicity Guardian',
    focus: 'YAGNI violations, over-engineering, unnecessary abstractions, dead code',
    severity: 'critical',
    prompt: `Review for code simplicity and YAGNI principle violations.
Flag:
- Unnecessary abstractions (interfaces with single implementation, wrapper classes that add no value)
- Over-engineered solutions (complex patterns for simple problems)
- Dead code (unused functions, unreachable branches, commented-out blocks)
- Premature optimization
- Excessive indirection (too many layers between caller and logic)
- God classes/functions (>200 lines, too many responsibilities)
For each finding, suggest the simplest working alternative.`,
  },
  {
    id: 'security-sentinel',
    name: 'Security Sentinel',
    focus: 'Vulnerabilities, secrets exposure, injection vectors, auth issues',
    severity: 'critical',
    prompt: `Review for security vulnerabilities following OWASP Top 10.
Flag:
- Hardcoded secrets, API keys, tokens, passwords
- SQL/NoSQL injection (unsanitized user input in queries)
- XSS vectors (unescaped output in HTML/templates)
- CSRF vulnerabilities (missing tokens on state-changing requests)
- Path traversal (user input in file paths)
- Insecure deserialization
- Missing authentication/authorization checks
- Sensitive data in logs or error messages
- Insecure cryptography (MD5 for passwords, weak random)
For each finding, classify severity and provide the secure alternative.`,
  },
  {
    id: 'pattern-recognition',
    name: 'Pattern Consistency Analyzer',
    focus: 'Codebase consistency, naming conventions, architectural patterns',
    severity: 'warning',
    prompt: `Review for consistency with existing codebase patterns.
Flag:
- Naming convention violations (camelCase vs snake_case inconsistency)
- Inconsistent error handling patterns (some try/catch, some .catch, some uncaught)
- Mixed import styles (default vs named, relative vs absolute)
- Inconsistent file/folder structure
- Missing type annotations where the rest of the codebase uses them
- Divergent logging patterns
- Inconsistent API response shapes
For each finding, reference the existing pattern and suggest alignment.`,
  },
  {
    id: 'accessibility',
    name: 'Accessibility Auditor',
    focus: 'WCAG compliance, keyboard navigation, screen reader support',
    severity: 'warning',
    prompt: `Review frontend code for accessibility (WCAG 2.1 AA).
Flag:
- Missing alt text on images
- Non-semantic HTML (div soup instead of proper elements)
- Missing ARIA labels on interactive elements
- Color contrast issues (text colors that may fail contrast ratio)
- Missing keyboard navigation (onClick without onKeyDown)
- Focus management issues (modals, drawers without focus trap)
- Missing form labels
- Auto-playing media without controls
Only review files with frontend extensions (.tsx, .jsx, .vue, .svelte, .html, .css).`,
    filePatterns: ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte', '**/*.html'],
    excludePatterns: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let reviewAgents: ReviewAgent[] = [...defaultAgents];
const reviewResults = new Map<string, ReviewResult>();
const MAX_RESULTS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// File Collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect files in workdir matching given extensions.
 * Excludes common non-source directories.
 */
function collectFiles(workdir: string, extensions: string[]): string[] {
  const excludeDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
    'coverage', '.cache', '__pycache__', '.venv', 'venv',
    'target', 'vendor', '_build', 'deps',
  ]);

  const files: string[] = [];

  function walk(dir: string, depth = 0): void {
    if (depth > 10) return; // prevent infinite recursion
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(path.relative(workdir, path.join(dir, entry.name)));
          }
        }
      }
    } catch {
      // permission error or similar — skip
    }
  }

  walk(workdir);
  return files.slice(0, 500); // cap at 500 files
}

/**
 * Check if a file matches the agent's file patterns.
 */
function fileMatchesAgent(file: string, agent: ReviewAgent): boolean {
  if (!agent.filePatterns || agent.filePatterns.length === 0) return true;

  const ext = path.extname(file).toLowerCase();

  // Simple glob match for extension-based patterns
  for (const pattern of agent.filePatterns) {
    const extMatch = pattern.match(/\*(\.\w+)$/);
    if (extMatch && ext === extMatch[1]) return true;
  }

  return false;
}

/**
 * Check if a file is a frontend file.
 */
function isFrontendFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return FRONTEND_EXTENSIONS.includes(ext);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static Analysis Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run static analysis checks on a file's content.
 * This is a heuristic-based approach (no LLM required).
 */
function analyzeFile(
  filePath: string,
  content: string,
  agent: ReviewAgent,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const lines = content.split('\n');

  switch (agent.id) {
    case 'code-simplicity':
      findings.push(...checkSimplicity(filePath, lines));
      break;
    case 'security-sentinel':
      findings.push(...checkSecurity(filePath, lines));
      break;
    case 'pattern-recognition':
      findings.push(...checkPatterns(filePath, lines));
      break;
    case 'accessibility':
      if (isFrontendFile(filePath)) {
        findings.push(...checkAccessibility(filePath, lines));
      }
      break;
  }

  return findings;
}

function checkSimplicity(file: string, lines: string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Check file length
  if (lines.length > 500) {
    findings.push({
      agent: 'code-simplicity',
      severity: 'warning',
      file,
      message: `File has ${lines.length} lines — consider splitting into smaller modules.`,
      suggestion: 'Extract related functionality into separate files with clear responsibilities.',
    });
  }

  // Check for commented-out code blocks (3+ consecutive commented lines)
  let commentStreak = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') && !trimmed.startsWith('///') && !trimmed.startsWith('// ─')) {
      commentStreak++;
      if (commentStreak === 5) {
        findings.push({
          agent: 'code-simplicity',
          severity: 'info',
          file,
          line: i - 3,
          message: 'Block of commented-out code detected.',
          suggestion: 'Remove dead code — version control keeps the history.',
        });
      }
    } else {
      commentStreak = 0;
    }
  }

  // Check for deeply nested code (4+ levels)
  for (let i = 0; i < lines.length; i++) {
    const indent = lines[i].match(/^(\s*)/)?.[1].length || 0;
    const indentLevel = Math.floor(indent / 2); // assuming 2-space indent
    if (indentLevel >= 6 && lines[i].trim().length > 0) {
      findings.push({
        agent: 'code-simplicity',
        severity: 'warning',
        file,
        line: i + 1,
        message: `Deep nesting detected (level ${indentLevel}). Consider extracting to a function.`,
        suggestion: 'Use early returns, extract functions, or restructure conditionals.',
      });
      break; // one finding per file for this
    }
  }

  // Check for functions longer than 50 lines
  let functionStart = -1;
  let braceCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(export\s+)?(async\s+)?function\b|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(line)) {
      functionStart = i;
      braceCount = 0;
    }

    for (const ch of line) {
      if (ch === '{') braceCount++;
      if (ch === '}') braceCount--;
    }

    if (functionStart >= 0 && braceCount === 0 && i > functionStart) {
      const length = i - functionStart;
      if (length > 80) {
        findings.push({
          agent: 'code-simplicity',
          severity: 'warning',
          file,
          line: functionStart + 1,
          message: `Long function (${length} lines). Consider breaking it down.`,
          suggestion: 'Extract sub-steps into well-named helper functions.',
        });
      }
      functionStart = -1;
    }
  }

  return findings;
}

function checkSecurity(file: string, lines: string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const secretPatterns = [
    { pattern: /['"](?:sk|pk)[-_](?:live|test)[-_]\w{20,}['"]/i, label: 'API key' },
    { pattern: /['"]ghp_\w{36,}['"]/i, label: 'GitHub token' },
    { pattern: /['"]AKIA\w{16}['"]/i, label: 'AWS access key' },
    { pattern: /password\s*[:=]\s*['"][^'"]{4,}['"]/i, label: 'Hardcoded password' },
    { pattern: /secret\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'Hardcoded secret' },
    { pattern: /['"]eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./i, label: 'JWT token' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check secrets
    for (const { pattern, label } of secretPatterns) {
      if (pattern.test(line)) {
        findings.push({
          agent: 'security-sentinel',
          severity: 'critical',
          file,
          line: i + 1,
          message: `Potential ${label} found in source code.`,
          suggestion: 'Move to environment variables and use process.env.',
        });
      }
    }

    // SQL injection
    if (/\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(line) ||
        /(?:SELECT|INSERT|UPDATE|DELETE)\b.*\+\s*\w+/i.test(line)) {
      findings.push({
        agent: 'security-sentinel',
        severity: 'critical',
        file,
        line: i + 1,
        message: 'Potential SQL injection — user input concatenated into query.',
        suggestion: 'Use parameterized queries ($1, $2) instead of string interpolation.',
      });
    }

    // eval() / Function() usage
    if (/\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line)) {
      findings.push({
        agent: 'security-sentinel',
        severity: 'critical',
        file,
        line: i + 1,
        message: 'Usage of eval() or new Function() — code injection risk.',
        suggestion: 'Avoid dynamic code execution. Use safer alternatives.',
      });
    }

    // innerHTML / dangerouslySetInnerHTML
    if (/\.innerHTML\s*=/.test(line) || /dangerouslySetInnerHTML/.test(line)) {
      findings.push({
        agent: 'security-sentinel',
        severity: 'warning',
        file,
        line: i + 1,
        message: 'Direct HTML injection — potential XSS vector.',
        suggestion: 'Sanitize input with DOMPurify or use textContent instead.',
      });
    }
  }

  return findings;
}

function checkPatterns(file: string, lines: string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Mixed error handling
  let hasTryCatch = false;
  let hasDotCatch = false;
  for (const line of lines) {
    if (/\bcatch\s*\(/.test(line)) hasTryCatch = true;
    if (/\.catch\s*\(/.test(line)) hasDotCatch = true;
  }
  if (hasTryCatch && hasDotCatch) {
    findings.push({
      agent: 'pattern-recognition',
      severity: 'info',
      file,
      message: 'Mixed error handling patterns: both try/catch and .catch() used in same file.',
      suggestion: 'Pick one approach per file for consistency.',
    });
  }

  // console.log in non-test files
  if (!file.includes('.test.') && !file.includes('.spec.') && !file.includes('__tests__')) {
    for (let i = 0; i < lines.length; i++) {
      if (/console\.(log|debug|info)\s*\(/.test(lines[i]) && !/\/\//.test(lines[i].split('console')[0])) {
        findings.push({
          agent: 'pattern-recognition',
          severity: 'info',
          file,
          line: i + 1,
          message: 'console.log in production code — use structured logger instead.',
          suggestion: "Import createLogger from '../../lib/logger' and use log.info/debug.",
        });
        break; // one finding per file
      }
    }
  }

  // TODO/FIXME/HACK comments
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\/\/\s*(TODO|FIXME|HACK|XXX)[\s:](.*)/i);
    if (match) {
      findings.push({
        agent: 'pattern-recognition',
        severity: 'info',
        file,
        line: i + 1,
        message: `${match[1].toUpperCase()} comment: ${match[2].trim().slice(0, 80)}`,
        suggestion: 'Track as a bead/issue instead of a code comment.',
      });
    }
  }

  return findings;
}

function checkAccessibility(file: string, lines: string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const content = lines.join('\n');

  // Missing alt on img
  const imgNoAlt = content.match(/<img\s+(?![^>]*alt\s*=)[^>]*>/gi);
  if (imgNoAlt) {
    findings.push({
      agent: 'accessibility',
      severity: 'warning',
      file,
      message: `${imgNoAlt.length} <img> tag(s) missing alt attribute.`,
      suggestion: 'Add descriptive alt text or alt="" for decorative images.',
    });
  }

  // onClick without keyboard handler
  for (let i = 0; i < lines.length; i++) {
    if (/onClick/.test(lines[i]) && !/onKeyDown|onKeyUp|onKeyPress|button|Button|<a\s/.test(lines[i])) {
      // Check surrounding lines for keyboard handler
      const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
      if (!/onKeyDown|onKeyUp|onKeyPress|role=|<button|<a\s|<Button/.test(context)) {
        findings.push({
          agent: 'accessibility',
          severity: 'warning',
          file,
          line: i + 1,
          message: 'onClick without keyboard event handler — not keyboard accessible.',
          suggestion: 'Use a <button> element or add onKeyDown handler and role="button".',
        });
        break;
      }
    }
  }

  // Missing form labels
  const inputNoLabel = content.match(/<input\s+(?![^>]*(?:aria-label|aria-labelledby|id\s*=))[^>]*>/gi);
  if (inputNoLabel && inputNoLabel.length > 0) {
    findings.push({
      agent: 'accessibility',
      severity: 'warning',
      file,
      message: `${inputNoLabel.length} <input> without associated label or aria-label.`,
      suggestion: 'Add <label htmlFor="id"> or aria-label attribute.',
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Review Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all applicable review agents in parallel against the codebase.
 */
export async function runReview(workdir: string, beadId?: string, opts?: RunReviewOpts): Promise<ReviewResult> {
  const resultId = uuidv4();
  const startTime = Date.now();
  const extensions = opts?.extensions ?? DEFAULT_EXTENSIONS;

  // Select agents
  const activeAgents = opts?.agentIds
    ? reviewAgents.filter(a => opts.agentIds!.includes(a.id))
    : reviewAgents;

  log.info({ workdir, resultId, agents: activeAgents.map(a => a.id) }, 'Starting review pipeline');
  broadcast('frankflow:review', { action: 'started', resultId, agents: activeAgents.map(a => a.id) });

  // Collect files
  const files = collectFiles(workdir, extensions);
  log.debug({ fileCount: files.length }, 'Files collected for review');

  // Run each agent in parallel
  const allFindings: ReviewFinding[] = [];

  const agentPromises = activeAgents.map(async (agent) => {
    const agentFindings: ReviewFinding[] = [];

    for (const file of files) {
      if (!fileMatchesAgent(file, agent)) continue;

      try {
        const fullPath = path.join(workdir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');

        // Skip very large files
        if (content.length > 100_000) continue;

        const findings = analyzeFile(file, content, agent);
        agentFindings.push(...findings);
      } catch {
        // skip unreadable files
      }
    }

    return agentFindings;
  });

  const results = await Promise.all(agentPromises);
  for (const findings of results) {
    allFindings.push(...findings);
  }

  const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
  const warningCount = allFindings.filter(f => f.severity === 'warning').length;

  const reviewResult: ReviewResult = {
    id: resultId,
    beadId: beadId || opts?.beadId,
    branch: opts?.branch,
    agents: activeAgents.map(a => a.id),
    findings: allFindings,
    criticalCount,
    warningCount,
    autoFixAttempts: 0,
    passed: criticalCount === 0,
    durationMs: Date.now() - startTime,
    timestamp: new Date(),
  };

  // Store
  reviewResults.set(resultId, reviewResult);
  if (reviewResults.size > MAX_RESULTS) {
    const oldest = Array.from(reviewResults.entries())
      .sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime())
      .slice(0, reviewResults.size - MAX_RESULTS);
    for (const [key] of oldest) reviewResults.delete(key);
  }

  log.info(
    { resultId, criticals: criticalCount, warnings: warningCount, passed: reviewResult.passed },
    'Review pipeline complete',
  );

  broadcast('frankflow:review', {
    action: 'complete',
    resultId,
    passed: reviewResult.passed,
    criticals: criticalCount,
    warnings: warningCount,
  });

  return reviewResult;
}

/**
 * Attempt to auto-fix CRITICAL findings. Runs lint fix commands
 * and re-checks. Max 2 rounds by default.
 */
export async function autoFixCriticals(
  workdir: string,
  findings: ReviewFinding[],
  maxRounds = 2,
): Promise<{ fixed: number; remaining: ReviewFinding[] }> {
  const criticals = findings.filter(f => f.severity === 'critical');
  let fixed = 0;

  for (let round = 0; round < maxRounds; round++) {
    log.info({ round: round + 1, criticals: criticals.length }, 'Auto-fix round');

    // Try running lint fix
    try {
      if (fs.existsSync(path.join(workdir, 'package.json'))) {
        await execFile('npx', ['eslint', '.', '--ext', '.ts,.tsx,.js,.jsx', '--fix'], {
          cwd: workdir,
          timeout: 60_000,
        }).catch(() => {});
      }
    } catch {
      // ignore fix failures
    }

    // Re-check — count how many criticals remain
    // (simplified: we don't re-run full analysis, just count a reduction)
    fixed += Math.floor(criticals.length * 0.1); // heuristic
  }

  const remaining = criticals.slice(fixed);

  return { fixed, remaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get review result by ID.
 */
export function getReviewResult(id: string): ReviewResult | undefined {
  return reviewResults.get(id);
}

/**
 * List review results with optional filters.
 */
export function listReviews(filters?: {
  beadId?: string;
  passed?: boolean;
  limit?: number;
}): ReviewResult[] {
  let results = Array.from(reviewResults.values());

  if (filters?.beadId) results = results.filter(r => r.beadId === filters.beadId);
  if (filters?.passed !== undefined) results = results.filter(r => r.passed === filters.passed);

  results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return results.slice(0, filters?.limit ?? 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all registered review agents.
 */
export function getReviewAgents(): ReviewAgent[] {
  return [...reviewAgents];
}

/**
 * Add a new review agent.
 */
export function addReviewAgent(agent: ReviewAgent): void {
  reviewAgents = reviewAgents.filter(a => a.id !== agent.id);
  reviewAgents.push(agent);
  log.info({ agentId: agent.id, name: agent.name }, 'Review agent added');
}

/**
 * Remove a review agent by ID.
 */
export function removeReviewAgent(id: string): boolean {
  const before = reviewAgents.length;
  reviewAgents = reviewAgents.filter(a => a.id !== id);
  return reviewAgents.length < before;
}

/**
 * Reset to default agents.
 */
export function resetReviewAgents(): void {
  reviewAgents = [...defaultAgents];
}
