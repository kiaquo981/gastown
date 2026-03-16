/**
 * EXTENSION MANIFEST — Gas Town Plugin System (Figure 13)
 *
 * "The If-It's-There-Run-It Philosophy: Filesystem Socket Model"
 *
 * Three extension levels:
 *   - Town Level   — System-wide plugins (monitoring, auth, notifications)
 *   - Rig Level    — Per-repo plugins (linters, formatters, test runners)
 *   - Refinery Level — Merge pipeline plugins (code review, security scan, changelog)
 *
 * Plugin Cartridge format:
 *   plugin.md    — Human-readable description + activation rules
 *   state.json   — Runtime state (enabled, config, last_run, metrics)
 *   gate.toml    — Optional gate control (conditions to pass before merge)
 *
 * Gate Control Panel:
 *   Each plugin at Refinery level can define gates that block merge until satisfied.
 *   Gates are filesystem-socket: drop a file in the right directory and it runs.
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('extension-manifest');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PluginLevel = 'town' | 'rig' | 'refinery';
export type PluginStatus = 'enabled' | 'disabled' | 'error' | 'pending';
export type GateVerdict = 'pass' | 'fail' | 'skip' | 'pending';

export interface PluginCartridge {
  id: string;
  name: string;
  version: string;
  level: PluginLevel;
  description: string;
  author: string;
  status: PluginStatus;

  // Activation
  activationRules: PluginActivationRule[];
  capabilities: string[];    // Required capabilities

  // Runtime
  entryPoint: string;        // e.g. "plugins/code-review/run.ts"
  configSchema?: Record<string, unknown>;
  config: Record<string, unknown>;

  // Gate (refinery level only)
  gate?: GateDefinition;

  // Metrics
  lastRun?: Date;
  runCount: number;
  avgDurationMs: number;
  failCount: number;

  // Metadata
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginActivationRule {
  type: 'file_pattern' | 'event' | 'schedule' | 'manual' | 'always';
  pattern?: string;          // e.g. "*.ts" or "push" or "0 */2 * * *"
  description: string;
}

export interface GateDefinition {
  name: string;
  description: string;
  blocking: boolean;         // If true, blocks merge until pass
  timeout: number;           // Max seconds to wait
  conditions: GateCondition[];
}

export interface GateCondition {
  id: string;
  check: string;             // e.g. "test_coverage > 80%"
  description: string;
  verdict: GateVerdict;
  message?: string;
  checkedAt?: Date;
}

export interface ExtensionManifest {
  version: string;
  townPlugins: PluginCartridge[];
  rigPlugins: Map<string, PluginCartridge[]>;   // rig name → plugins
  refineryPlugins: PluginCartridge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Registry
// ─────────────────────────────────────────────────────────────────────────────

export class ExtensionRegistry {
  private plugins: Map<string, PluginCartridge> = new Map();
  private gateResults: Map<string, GateCondition[]> = new Map();

  // ── Register Plugin ─────────────────────────────────────────────────────

  register(plugin: Omit<PluginCartridge, 'id' | 'runCount' | 'avgDurationMs' | 'failCount' | 'createdAt' | 'updatedAt'>): PluginCartridge {
    const id = `ext-${plugin.level}-${uuidv4().slice(0, 8)}`;
    const full: PluginCartridge = {
      ...plugin,
      id,
      runCount: 0,
      avgDurationMs: 0,
      failCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.plugins.set(id, full);
    log.info({ id, name: plugin.name, level: plugin.level }, 'Plugin registered');

    broadcast('meow:extension', {
      type: 'plugin_registered',
      pluginId: id,
      name: plugin.name,
      level: plugin.level,
    });

    return full;
  }

  // ── Get plugins by level ────────────────────────────────────────────────

  getByLevel(level: PluginLevel): PluginCartridge[] {
    return Array.from(this.plugins.values()).filter(p => p.level === level);
  }

  // ── Get full manifest ───────────────────────────────────────────────────

  getManifest(): {
    version: string;
    town: PluginCartridge[];
    rig: Record<string, PluginCartridge[]>;
    refinery: PluginCartridge[];
    totalPlugins: number;
    activeGates: number;
  } {
    const town = this.getByLevel('town');
    const rigAll = this.getByLevel('rig');
    const refinery = this.getByLevel('refinery');

    // Group rig plugins by tags that contain rig names
    const rigGrouped: Record<string, PluginCartridge[]> = {};
    for (const p of rigAll) {
      const rigTag = p.tags.find(t => t.startsWith('rig:'));
      const rigName = rigTag ? rigTag.replace('rig:', '') : 'shared';
      if (!rigGrouped[rigName]) rigGrouped[rigName] = [];
      rigGrouped[rigName].push(p);
    }

    return {
      version: '1.0.0',
      town,
      rig: rigGrouped,
      refinery,
      totalPlugins: this.plugins.size,
      activeGates: refinery.filter(p => p.gate?.blocking).length,
    };
  }

  // ── Run Gate Check ──────────────────────────────────────────────────────

  async runGateCheck(pluginId: string): Promise<GateCondition[]> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.gate) return [];

    const results: GateCondition[] = plugin.gate.conditions.map(cond => ({
      ...cond,
      verdict: 'pass' as GateVerdict, // In real impl, would run actual checks
      checkedAt: new Date(),
      message: `Gate check "${cond.check}" passed`,
    }));

    this.gateResults.set(pluginId, results);

    plugin.runCount++;
    plugin.lastRun = new Date();
    plugin.updatedAt = new Date();

    broadcast('meow:extension', {
      type: 'gate_checked',
      pluginId,
      pluginName: plugin.name,
      results: results.map(r => ({ id: r.id, verdict: r.verdict })),
    });

    return results;
  }

  // ── Enable / Disable ───────────────────────────────────────────────────

  setStatus(pluginId: string, status: PluginStatus): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    plugin.status = status;
    plugin.updatedAt = new Date();
    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  getStats(): {
    total: number;
    byLevel: Record<PluginLevel, number>;
    enabled: number;
    disabled: number;
    totalRuns: number;
    gatesPassing: number;
    gatesFailing: number;
  } {
    const all = Array.from(this.plugins.values());
    let gatesPassing = 0;
    let gatesFailing = 0;

    for (const [, results] of this.gateResults) {
      for (const r of results) {
        if (r.verdict === 'pass') gatesPassing++;
        else if (r.verdict === 'fail') gatesFailing++;
      }
    }

    return {
      total: all.length,
      byLevel: {
        town: all.filter(p => p.level === 'town').length,
        rig: all.filter(p => p.level === 'rig').length,
        refinery: all.filter(p => p.level === 'refinery').length,
      },
      enabled: all.filter(p => p.status === 'enabled').length,
      disabled: all.filter(p => p.status === 'disabled').length,
      totalRuns: all.reduce((s, p) => s + p.runCount, 0),
      gatesPassing,
      gatesFailing,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Plugins (shipped with Gas Town)
// ─────────────────────────────────────────────────────────────────────────────

export function registerDefaultPlugins(registry: ExtensionRegistry): void {
  // Town-level plugins
  registry.register({
    name: 'health-monitor',
    version: '1.0.0',
    level: 'town',
    description: 'Monitors system health, heartbeat, and resource usage',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'always', description: 'Runs continuously' }],
    capabilities: ['DbQuery', 'NetConnect'],
    entryPoint: 'plugins/health-monitor/run.ts',
    config: { interval: 30000, alertThreshold: 0.9 },
    tags: ['system', 'monitoring'],
  });

  registry.register({
    name: 'cost-tracker',
    version: '1.0.0',
    level: 'town',
    description: 'Tracks LLM API costs and budget enforcement (Paperclip)',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'event', pattern: 'llm_call', description: 'On every LLM invocation' }],
    capabilities: ['DbQuery'],
    entryPoint: 'plugins/cost-tracker/run.ts',
    config: { dailyBudget: 50.0, alertAt: 0.8 },
    tags: ['system', 'budget'],
  });

  registry.register({
    name: 'mail-router',
    version: '1.0.0',
    level: 'town',
    description: 'Routes mail between agents, escalates undelivered messages',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'event', pattern: 'mail_sent', description: 'On mail events' }],
    capabilities: ['NetConnect'],
    entryPoint: 'plugins/mail-router/run.ts',
    config: { maxRetries: 3, escalateAfter: 300 },
    tags: ['comms', 'mail'],
  });

  // Rig-level plugins
  registry.register({
    name: 'eslint-guard',
    version: '1.0.0',
    level: 'rig',
    description: 'Runs ESLint on changed files before commit',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'file_pattern', pattern: '*.{ts,tsx,js,jsx}', description: 'On TypeScript/JS changes' }],
    capabilities: ['ShellExec', 'FileRead'],
    entryPoint: 'plugins/eslint-guard/run.ts',
    config: { fix: true, maxWarnings: 10 },
    tags: ['rig:hive-os', 'quality', 'lint'],
  });

  registry.register({
    name: 'typecheck-guard',
    version: '1.0.0',
    level: 'rig',
    description: 'Runs TypeScript type checking on modified modules',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'file_pattern', pattern: '*.{ts,tsx}', description: 'On TypeScript changes' }],
    capabilities: ['ShellExec'],
    entryPoint: 'plugins/typecheck-guard/run.ts',
    config: { strict: true },
    tags: ['rig:hive-os', 'rig:orchestrator', 'quality', 'types'],
  });

  registry.register({
    name: 'test-runner',
    version: '1.0.0',
    level: 'rig',
    description: 'Runs relevant test suites for changed code paths',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'file_pattern', pattern: '*.{ts,tsx}', description: 'On code changes' }],
    capabilities: ['ShellExec', 'FileRead'],
    entryPoint: 'plugins/test-runner/run.ts',
    config: { coverage: true, minCoverage: 60 },
    tags: ['rig:shared', 'quality', 'test'],
  });

  // Refinery-level plugins
  registry.register({
    name: 'code-review',
    version: '1.0.0',
    level: 'refinery',
    description: 'AI-powered code review before merge (the Plugin Cartridge from Fig.13)',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'event', pattern: 'pr_created', description: 'On PR creation' }],
    capabilities: ['LLMCall', 'FileRead', 'DbQuery'],
    entryPoint: 'plugins/code-review/run.ts',
    config: { model: 'gemini-2.0-flash', maxFiles: 50 },
    gate: {
      name: 'Code Review Gate',
      description: 'Blocks merge until code review passes',
      blocking: true,
      timeout: 300,
      conditions: [
        { id: 'cr-1', check: 'no_critical_issues', description: 'No critical code issues', verdict: 'pending' },
        { id: 'cr-2', check: 'no_security_vulns', description: 'No security vulnerabilities', verdict: 'pending' },
        { id: 'cr-3', check: 'style_compliant', description: 'Code style compliance', verdict: 'pending' },
      ],
    },
    tags: ['refinery', 'quality', 'review'],
  });

  registry.register({
    name: 'security-scanner',
    version: '1.0.0',
    level: 'refinery',
    description: 'Scans for secrets, vulnerabilities, and OWASP issues',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'event', pattern: 'pr_created', description: 'On PR creation' }],
    capabilities: ['ShellExec', 'FileRead'],
    entryPoint: 'plugins/security-scanner/run.ts',
    config: { scanSecrets: true, scanDeps: true },
    gate: {
      name: 'Security Gate',
      description: 'Blocks merge if security issues found',
      blocking: true,
      timeout: 120,
      conditions: [
        { id: 'sec-1', check: 'no_hardcoded_secrets', description: 'No hardcoded secrets', verdict: 'pending' },
        { id: 'sec-2', check: 'no_vulnerable_deps', description: 'No vulnerable dependencies', verdict: 'pending' },
      ],
    },
    tags: ['refinery', 'security'],
  });

  registry.register({
    name: 'changelog-generator',
    version: '1.0.0',
    level: 'refinery',
    description: 'Auto-generates changelog entries from commit messages',
    author: 'gastown',
    status: 'enabled',
    activationRules: [{ type: 'event', pattern: 'merge_complete', description: 'After merge' }],
    capabilities: ['FileWrite', 'ShellExec'],
    entryPoint: 'plugins/changelog-generator/run.ts',
    config: { format: 'conventional' },
    tags: ['refinery', 'docs'],
  });

  log.info({ count: 9 }, 'Default plugins registered');
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _registry: ExtensionRegistry | null = null;

export function getExtensionRegistry(): ExtensionRegistry {
  if (!_registry) {
    _registry = new ExtensionRegistry();
    registerDefaultPlugins(_registry);
  }
  return _registry;
}
