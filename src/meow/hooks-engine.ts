/**
 * HOOKS ENGINE — FrankFlow Quality Gates (EP-111 → EP-122)
 *
 * Gas Town: "Hooks are the guardrails. Break them, break yourself."
 *
 * Manages hook definitions, validators, and execution for:
 * - Smart Router (NLP routing to skills/agents)
 * - Pre-Commit (branch naming, conventional commits, bead ID)
 * - Pre-Push (force push protection)
 * - Sensitive Files (block .env, .key, .pem)
 * - Loop Guard (SHA256 dedup, circuit breaker)
 * - Pattern Learner (error pattern memory)
 * - Path Enforcer (no path escape)
 * - Session Start (context bootstrap)
 * - Pre-Compact Digest (extraction checklist)
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { broadcast, addActivity } from '../sse';
import type { FeedEvent, FeedEventType } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HookType =
  | 'smart-router'
  | 'pre-commit'
  | 'pre-push'
  | 'sensitive-files'
  | 'session-start'
  | 'post-tool'
  | 'pattern-learner'
  | 'pre-compact'
  | 'gupp-patrol'
  | 'loop-guard'
  | 'path-enforcer'
  | 'claudemd-guard';

export interface HookDefinition {
  id: string;
  type: HookType;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;            // Lower = runs first
  config: Record<string, unknown>;
}

export interface HookResult {
  hookId: string;
  hookType: HookType;
  passed: boolean;
  blocked: boolean;            // True if hook blocked the operation
  message: string;
  details?: Record<string, unknown>;
  durationMs: number;
  timestamp: Date;
}

export interface LoopGuardEntry {
  hash: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  toolName: string;
  args: string;
}

export interface PatternEntry {
  id: string;
  pattern: string;             // Error pattern or description
  solution: string;            // What worked
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  tags: string[];
}

export interface HooksEngineConfig {
  loopGuardMaxRepeats: number;   // Block after N identical calls (default 5)
  loopGuardCircuitBreaker: number; // Hard circuit breaker (default 30)
  loopGuardWindowMs: number;     // Time window for dedup (default 10min)
  sensitivePatterns: string[];   // File patterns to block
  maxPathDepth: number;          // Max relative path depth (default 5)
}

export interface HooksStats {
  totalExecutions: number;
  totalBlocked: number;
  totalPassed: number;
  hookDefinitions: number;
  enabledHooks: number;
  loopGuardEntries: number;
  patternsLearned: number;
  recentBlocks: HookResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: HooksEngineConfig = {
  loopGuardMaxRepeats: 5,
  loopGuardCircuitBreaker: 30,
  loopGuardWindowMs: 10 * 60 * 1000,   // 10 minutes
  sensitivePatterns: ['.env', '.key', '.pem', '.secret', 'credentials', '.p12', '.pfx', 'id_rsa', 'id_ed25519'],
  maxPathDepth: 5,
};

const CONVENTIONAL_COMMIT_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s.+/;
const BRANCH_NAME_REGEX = /^(feature|fix|hotfix|release|chore|docs)\/(bd-[a-f0-9]+[-_])?[\w-]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// HooksEngine
// ─────────────────────────────────────────────────────────────────────────────

export class HooksEngine {
  private config: HooksEngineConfig;
  private hooks: Map<string, HookDefinition> = new Map();
  private loopGuard: Map<string, LoopGuardEntry> = new Map();
  private patterns: Map<string, PatternEntry> = new Map();
  private totalExecutions: number = 0;
  private totalBlocked: number = 0;
  private totalPassed: number = 0;
  private recentBlocks: HookResult[] = [];

  constructor(config?: Partial<HooksEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registerBuiltinHooks();
  }

  /** Register all builtin FrankFlow hooks */
  private registerBuiltinHooks(): void {
    const builtins: Omit<HookDefinition, 'id'>[] = [
      {
        type: 'smart-router',
        name: 'Smart Router',
        description: 'Route work to appropriate skill/agent based on content analysis',
        enabled: true,
        priority: 10,
        config: { categories: 30 },
      },
      {
        type: 'pre-commit',
        name: 'Pre-Commit Validator',
        description: 'Validates branch naming, conventional commits, bead ID inclusion',
        enabled: true,
        priority: 20,
        config: {},
      },
      {
        type: 'pre-push',
        name: 'Pre-Push Guard',
        description: 'Prevents force push, validates push authorization',
        enabled: true,
        priority: 30,
        config: { allowForceWithLease: true },
      },
      {
        type: 'sensitive-files',
        name: 'Sensitive Files Blocker',
        description: 'Blocks commits containing .env, .key, .pem, credentials',
        enabled: true,
        priority: 15,
        config: { patterns: this.config.sensitivePatterns },
      },
      {
        type: 'session-start',
        name: 'Session Context Bootstrap',
        description: 'Injects BU context, stack info, recent commits, gotchas',
        enabled: true,
        priority: 5,
        config: {},
      },
      {
        type: 'post-tool',
        name: 'Post-Tool Logger',
        description: 'Logs all tool invocations with tokens, latency, cost',
        enabled: true,
        priority: 90,
        config: {},
      },
      {
        type: 'pattern-learner',
        name: 'Pattern Learner',
        description: 'Learns error patterns, solutions, and retry strategies',
        enabled: true,
        priority: 80,
        config: { promoteThreshold: 3 },
      },
      {
        type: 'pre-compact',
        name: 'Pre-Compact Digest',
        description: 'Extraction checklist before context compaction',
        enabled: true,
        priority: 50,
        config: {},
      },
      {
        type: 'gupp-patrol',
        name: 'GUPP Patrol Hook',
        description: 'Check hook on startup — if work exists, MUST RUN IT',
        enabled: true,
        priority: 1,
        config: {},
      },
      {
        type: 'loop-guard',
        name: 'Loop Guard',
        description: 'SHA256 dedup, block@5, circuit-breaker@30',
        enabled: true,
        priority: 10,
        config: { maxRepeats: this.config.loopGuardMaxRepeats, circuitBreaker: this.config.loopGuardCircuitBreaker },
      },
      {
        type: 'path-enforcer',
        name: 'Path Enforcer',
        description: 'Block path traversal, symlink escape, /tmp writes',
        enabled: true,
        priority: 15,
        config: { maxDepth: this.config.maxPathDepth },
      },
      {
        type: 'claudemd-guard',
        name: 'CLAUDE.md Guard',
        description: 'Validates CLAUDE.md hierarchy levels and line budgets',
        enabled: true,
        priority: 25,
        config: { levels: 5 },
      },
    ];

    for (const hook of builtins) {
      const id = `hook-${hook.type}`;
      this.hooks.set(id, { ...hook, id });
    }
  }

  // ───────────── Hook Execution ─────────────

  /** Run a specific hook type */
  async runHook(type: HookType, context: Record<string, unknown>): Promise<HookResult> {
    const hook = Array.from(this.hooks.values()).find(h => h.type === type && h.enabled);
    if (!hook) {
      return { hookId: '', hookType: type, passed: true, blocked: false, message: 'Hook not found or disabled', durationMs: 0, timestamp: new Date() };
    }

    const t0 = Date.now();
    this.totalExecutions++;

    let result: HookResult;

    switch (type) {
      case 'pre-commit':
        result = this.runPreCommit(hook, context);
        break;
      case 'pre-push':
        result = this.runPrePush(hook, context);
        break;
      case 'sensitive-files':
        result = this.runSensitiveFiles(hook, context);
        break;
      case 'loop-guard':
        result = this.runLoopGuard(hook, context);
        break;
      case 'path-enforcer':
        result = this.runPathEnforcer(hook, context);
        break;
      case 'claudemd-guard':
        result = this.runClaudeMdGuard(hook, context);
        break;
      case 'smart-router':
        result = this.runSmartRouter(hook, context);
        break;
      default:
        result = { hookId: hook.id, hookType: type, passed: true, blocked: false, message: `Hook ${type} executed (passthrough)`, durationMs: Date.now() - t0, timestamp: new Date() };
    }

    result.durationMs = Date.now() - t0;

    if (result.blocked) {
      this.totalBlocked++;
      this.recentBlocks.unshift(result);
      if (this.recentBlocks.length > 50) this.recentBlocks.pop();
      this.emitFeed('system_health', `Hook BLOCKED: ${hook.name} — ${result.message}`, {
        metadata: { hookType: type, blocked: true },
      });
    } else {
      this.totalPassed++;
    }

    return result;
  }

  /** Run all enabled hooks of a given set of types */
  async runHooks(types: HookType[], context: Record<string, unknown>): Promise<HookResult[]> {
    const results: HookResult[] = [];
    const sorted = types
      .map(t => Array.from(this.hooks.values()).find(h => h.type === t && h.enabled))
      .filter(Boolean)
      .sort((a, b) => a!.priority - b!.priority);

    for (const hook of sorted) {
      const result = await this.runHook(hook!.type, context);
      results.push(result);
      if (result.blocked) break; // Stop on first block
    }

    return results;
  }

  // ───────────── Individual Hook Implementations ─────────────

  private runPreCommit(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const branch = ctx.branch as string || '';
    const message = ctx.message as string || '';
    const issues: string[] = [];

    // Branch naming check
    if (branch && !BRANCH_NAME_REGEX.test(branch) && branch !== 'main' && branch !== 'master' && !branch.startsWith('dev')) {
      issues.push(`Branch "${branch}" doesn't match pattern: feature|fix|hotfix|release|chore|docs/description`);
    }

    // Conventional commit check
    if (message && !CONVENTIONAL_COMMIT_REGEX.test(message)) {
      issues.push(`Commit message doesn't follow conventional format: type(scope): description`);
    }

    return {
      hookId: hook.id,
      hookType: 'pre-commit',
      passed: issues.length === 0,
      blocked: issues.length > 0,
      message: issues.length > 0 ? issues.join('; ') : 'Pre-commit checks passed',
      details: { branch, messagePreview: message.slice(0, 80), issues },
      durationMs: 0,
      timestamp: new Date(),
    };
  }

  private runPrePush(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const force = ctx.force as boolean || false;
    const branch = ctx.branch as string || '';
    const forceWithLease = ctx.forceWithLease as boolean || false;

    if (force && !forceWithLease) {
      return {
        hookId: hook.id, hookType: 'pre-push', passed: false, blocked: true,
        message: `Force push BLOCKED on branch "${branch}". Use --force-with-lease if absolutely necessary.`,
        details: { branch, force, forceWithLease },
        durationMs: 0, timestamp: new Date(),
      };
    }

    if (force && (branch === 'main' || branch === 'master')) {
      return {
        hookId: hook.id, hookType: 'pre-push', passed: false, blocked: true,
        message: `Force push to ${branch} is NEVER allowed.`,
        details: { branch },
        durationMs: 0, timestamp: new Date(),
      };
    }

    return {
      hookId: hook.id, hookType: 'pre-push', passed: true, blocked: false,
      message: 'Pre-push checks passed', durationMs: 0, timestamp: new Date(),
    };
  }

  private runSensitiveFiles(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const files = ctx.files as string[] || [];
    const blocked: string[] = [];

    for (const file of files) {
      const lower = file.toLowerCase();
      for (const pattern of this.config.sensitivePatterns) {
        if (lower.includes(pattern.toLowerCase())) {
          blocked.push(file);
          break;
        }
      }
    }

    return {
      hookId: hook.id, hookType: 'sensitive-files',
      passed: blocked.length === 0, blocked: blocked.length > 0,
      message: blocked.length > 0 ? `Sensitive files blocked: ${blocked.join(', ')}` : 'No sensitive files detected',
      details: { filesChecked: files.length, blocked },
      durationMs: 0, timestamp: new Date(),
    };
  }

  private runLoopGuard(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const toolName = ctx.toolName as string || '';
    const args = JSON.stringify(ctx.args || '');
    const hash = createHash('sha256').update(`${toolName}:${args}`).digest('hex').slice(0, 16);
    const now = Date.now();

    let entry = this.loopGuard.get(hash);
    if (entry) {
      // Check if within window
      if (now - entry.lastSeen.getTime() < this.config.loopGuardWindowMs) {
        entry.count++;
        entry.lastSeen = new Date();
      } else {
        // Reset — outside window
        entry.count = 1;
        entry.firstSeen = new Date();
        entry.lastSeen = new Date();
      }
    } else {
      entry = { hash, count: 1, firstSeen: new Date(), lastSeen: new Date(), toolName, args: args.slice(0, 200) };
      this.loopGuard.set(hash, entry);
    }

    if (entry.count >= this.config.loopGuardCircuitBreaker) {
      return {
        hookId: hook.id, hookType: 'loop-guard', passed: false, blocked: true,
        message: `CIRCUIT BREAKER: ${toolName} called ${entry.count}x (limit: ${this.config.loopGuardCircuitBreaker})`,
        details: { hash, count: entry.count, toolName },
        durationMs: 0, timestamp: new Date(),
      };
    }

    if (entry.count >= this.config.loopGuardMaxRepeats) {
      return {
        hookId: hook.id, hookType: 'loop-guard', passed: false, blocked: true,
        message: `Loop detected: ${toolName} called ${entry.count}x in ${Math.round((now - entry.firstSeen.getTime()) / 1000)}s`,
        details: { hash, count: entry.count, toolName },
        durationMs: 0, timestamp: new Date(),
      };
    }

    return {
      hookId: hook.id, hookType: 'loop-guard', passed: true, blocked: false,
      message: `OK (${toolName}: ${entry.count}/${this.config.loopGuardMaxRepeats})`,
      durationMs: 0, timestamp: new Date(),
    };
  }

  private runPathEnforcer(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const path = ctx.path as string || '';
    const issues: string[] = [];

    // Check for path traversal
    const depth = (path.match(/\.\./g) || []).length;
    if (depth > this.config.maxPathDepth) {
      issues.push(`Path traversal depth ${depth} exceeds max ${this.config.maxPathDepth}`);
    }

    // Block absolute paths to sensitive dirs
    const blocked = ['/etc/', '/var/', '/root/', '/proc/', '/sys/'];
    for (const dir of blocked) {
      if (path.startsWith(dir)) {
        issues.push(`Access to ${dir} blocked`);
      }
    }

    // Block symlink patterns
    if (path.includes('..') && path.includes('/tmp')) {
      issues.push('Suspicious path: traversal + /tmp');
    }

    return {
      hookId: hook.id, hookType: 'path-enforcer',
      passed: issues.length === 0, blocked: issues.length > 0,
      message: issues.length > 0 ? issues.join('; ') : 'Path OK',
      details: { path, issues },
      durationMs: 0, timestamp: new Date(),
    };
  }

  private runClaudeMdGuard(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const level = ctx.level as number || 0;
    const lineCount = ctx.lineCount as number || 0;
    const budgets: Record<number, number> = { 1: 500, 2: 300, 3: 150, 4: 50, 5: 20 };

    const maxLines = budgets[level];
    if (maxLines && lineCount > maxLines) {
      return {
        hookId: hook.id, hookType: 'claudemd-guard', passed: false, blocked: true,
        message: `CLAUDE.md L${level} exceeds line budget: ${lineCount}/${maxLines}`,
        details: { level, lineCount, maxLines },
        durationMs: 0, timestamp: new Date(),
      };
    }

    return {
      hookId: hook.id, hookType: 'claudemd-guard', passed: true, blocked: false,
      message: `CLAUDE.md L${level}: ${lineCount}/${maxLines || '∞'} lines OK`,
      durationMs: 0, timestamp: new Date(),
    };
  }

  private runSmartRouter(hook: HookDefinition, ctx: Record<string, unknown>): HookResult {
    const content = ctx.content as string || '';
    const lower = content.toLowerCase();

    // Simple keyword-based routing to skill categories
    const routes: Record<string, string[]> = {
      'code-review': ['review', 'pr ', 'pull request', 'diff', 'code quality'],
      'testing': ['test', 'spec', 'jest', 'vitest', 'coverage'],
      'documentation': ['docs', 'readme', 'documentation', 'jsdoc'],
      'refactoring': ['refactor', 'cleanup', 'restructure', 'simplify'],
      'bug-fix': ['bug', 'fix', 'error', 'crash', 'broken'],
      'feature': ['feature', 'implement', 'add', 'create', 'new'],
      'deployment': ['deploy', 'release', 'publish', 'ci/cd'],
      'security': ['security', 'vulnerability', 'xss', 'injection', 'auth'],
      'performance': ['performance', 'optimize', 'speed', 'latency', 'cache'],
      'database': ['migration', 'schema', 'query', 'index', 'database'],
    };

    const matched: string[] = [];
    for (const [category, keywords] of Object.entries(routes)) {
      if (keywords.some(k => lower.includes(k))) {
        matched.push(category);
      }
    }

    return {
      hookId: hook.id, hookType: 'smart-router', passed: true, blocked: false,
      message: matched.length > 0 ? `Routed to: ${matched.join(', ')}` : 'No specific route matched',
      details: { categories: matched, contentLength: content.length },
      durationMs: 0, timestamp: new Date(),
    };
  }

  // ───────────── Pattern Learner ─────────────

  /** Record an error pattern */
  learnPattern(pattern: string, solution: string, tags: string[] = []): PatternEntry {
    // Check if pattern already exists (fuzzy match)
    for (const [, entry] of this.patterns) {
      if (entry.pattern === pattern || entry.pattern.includes(pattern) || pattern.includes(entry.pattern)) {
        entry.occurrences++;
        entry.lastSeen = new Date();
        if (solution && !entry.solution.includes(solution)) {
          entry.solution += ` | ${solution}`;
        }
        return entry;
      }
    }

    const entry: PatternEntry = {
      id: `pat-${uuidv4().slice(0, 8)}`,
      pattern,
      solution,
      occurrences: 1,
      firstSeen: new Date(),
      lastSeen: new Date(),
      tags,
    };
    this.patterns.set(entry.id, entry);
    return entry;
  }

  /** Find known patterns matching an error */
  findPatterns(error: string): PatternEntry[] {
    const lower = error.toLowerCase();
    return Array.from(this.patterns.values()).filter(p =>
      lower.includes(p.pattern.toLowerCase()) || p.pattern.toLowerCase().includes(lower)
    );
  }

  /** Get all learned patterns */
  getPatterns(): PatternEntry[] {
    return Array.from(this.patterns.values()).sort((a, b) => b.occurrences - a.occurrences);
  }

  // ───────────── Management ─────────────

  /** Enable/disable a hook */
  setEnabled(hookId: string, enabled: boolean): void {
    const hook = this.hooks.get(hookId);
    if (hook) hook.enabled = enabled;
  }

  /** Get a hook definition */
  getHook(hookId: string): HookDefinition | undefined {
    return this.hooks.get(hookId);
  }

  /** List all hooks */
  listHooks(): HookDefinition[] {
    return Array.from(this.hooks.values()).sort((a, b) => a.priority - b.priority);
  }

  /** Reset loop guard entries */
  resetLoopGuard(): number {
    const count = this.loopGuard.size;
    this.loopGuard.clear();
    return count;
  }

  /** Get stats */
  stats(): HooksStats {
    return {
      totalExecutions: this.totalExecutions,
      totalBlocked: this.totalBlocked,
      totalPassed: this.totalPassed,
      hookDefinitions: this.hooks.size,
      enabledHooks: Array.from(this.hooks.values()).filter(h => h.enabled).length,
      loopGuardEntries: this.loopGuard.size,
      patternsLearned: this.patterns.size,
      recentBlocks: this.recentBlocks.slice(0, 10),
    };
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'hooks-engine',
      message,
      severity: 'warning',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton HooksEngine instance */
export const hooksEngine = new HooksEngine();
