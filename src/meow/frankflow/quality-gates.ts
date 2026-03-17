/**
 * FrankFlow Quality Gates — Multi-Stack Quality Pipeline
 *
 * Auto-detects tech stacks in a working directory and runs appropriate
 * quality gates (lint, typecheck, test, build, audit). Supports npm,
 * python, go, rust, ruby, java, and elixir stacks.
 *
 * Ported from FrankFlow's multi-stack quality assurance pipeline.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('frankflow:quality');
const execFile = promisify(execFileCb);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TechStack = 'npm' | 'python' | 'go' | 'rust' | 'ruby' | 'java' | 'elixir';

export interface GateResult {
  gate: string;
  stack: TechStack;
  passed: boolean;
  output: string;
  durationMs: number;
  fixable?: boolean;
  coveragePct?: number;
}

export interface QualityReport {
  id: string;
  beadId?: string;
  branch?: string;
  stacks: TechStack[];
  gates: GateResult[];
  overallPassed: boolean;
  totalDurationMs: number;
  coveragePct?: number;
  timestamp: Date;
}

export interface RunGatesOpts {
  /** Bead ID to associate with the report */
  beadId?: string;
  /** Git branch being checked */
  branch?: string;
  /** Timeout per gate in ms. Default: 120_000 (2 min) */
  gateTimeoutMs?: number;
  /** Skip specific gates by name */
  skipGates?: string[];
  /** Only run specific gates by name */
  onlyGates?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GATE_TIMEOUT_MS = 120_000; // 2 minutes

const STACK_INDICATORS: Record<TechStack, string[]> = {
  npm: ['package.json'],
  python: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  go: ['go.mod'],
  rust: ['Cargo.toml'],
  ruby: ['Gemfile'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  elixir: ['mix.exs'],
};

const COVERAGE_THRESHOLDS = { warn: 60, fail: 30 };

// ─────────────────────────────────────────────────────────────────────────────
// State — report store
// ─────────────────────────────────────────────────────────────────────────────

const reports = new Map<string, QualityReport>();
const MAX_REPORTS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Stack Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-detect tech stacks by checking for indicator files.
 */
export function detectStacks(workdir: string): TechStack[] {
  const detected: TechStack[] = [];

  for (const [stack, indicators] of Object.entries(STACK_INDICATORS) as [TechStack, string[]][]) {
    for (const file of indicators) {
      if (fs.existsSync(path.join(workdir, file))) {
        detected.push(stack);
        break;
      }
    }
  }

  log.debug({ workdir, stacks: detected }, 'Tech stacks detected');
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Execution Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface GateDef {
  name: string;
  stack: TechStack;
  cmd: string;
  args: string[];
  fixable?: boolean;
  fixCmd?: string;
  fixArgs?: string[];
  coverageParser?: (output: string) => number | undefined;
}

/**
 * Execute a single command and capture its output.
 * Returns { passed, output, durationMs }.
 */
async function executeGate(
  gateDef: GateDef,
  workdir: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

  try {
    const { stdout, stderr } = await execFile(gateDef.cmd, gateDef.args, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    const output = (stdout + '\n' + stderr).trim();
    const durationMs = Date.now() - start;
    const coveragePct = gateDef.coverageParser?.(output);

    return {
      gate: gateDef.name,
      stack: gateDef.stack,
      passed: true,
      output: output.slice(0, 5000),
      durationMs,
      fixable: gateDef.fixable,
      coveragePct,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const error = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = ((error.stdout || '') + '\n' + (error.stderr || '') + '\n' + (error.message || '')).trim();

    const isTimeout = error.killed === true;

    return {
      gate: gateDef.name,
      stack: gateDef.stack,
      passed: false,
      output: (isTimeout ? '[TIMEOUT] ' : '') + output.slice(0, 5000),
      durationMs,
      fixable: gateDef.fixable,
    };
  }
}

/**
 * Attempt auto-fix for a gate (lint/format), then re-run.
 */
async function attemptAutoFix(
  gateDef: GateDef,
  workdir: string,
  timeoutMs: number,
): Promise<GateResult | null> {
  if (!gateDef.fixCmd || !gateDef.fixArgs) return null;

  try {
    await execFile(gateDef.fixCmd, gateDef.fixArgs, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });

    // Re-run the gate after fix
    const result = await executeGate(gateDef, workdir, timeoutMs);
    if (result.passed) {
      result.output = '[AUTO-FIXED] ' + result.output;
    }
    return result;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Definitions by Stack
// ─────────────────────────────────────────────────────────────────────────────

function parseCoverageFromOutput(output: string): number | undefined {
  // Try common coverage formats
  // "All files | 85.5 | ..."
  const istanbulMatch = output.match(/All files\s*\|\s*([\d.]+)/);
  if (istanbulMatch) return parseFloat(istanbulMatch[1]);

  // "Coverage: 85.5%"
  const percentMatch = output.match(/coverage[:\s]*([\d.]+)\s*%/i);
  if (percentMatch) return parseFloat(percentMatch[1]);

  // "Lines: 85.5%"
  const linesMatch = output.match(/Lines\s*:\s*([\d.]+)\s*%/i);
  if (linesMatch) return parseFloat(linesMatch[1]);

  // pytest: "TOTAL    85%"
  const pytestMatch = output.match(/TOTAL\s+\d+\s+\d+\s+([\d.]+)%/);
  if (pytestMatch) return parseFloat(pytestMatch[1]);

  return undefined;
}

function getGateDefsForStack(stack: TechStack, workdir: string): GateDef[] {
  switch (stack) {
    case 'npm': {
      const defs: GateDef[] = [];

      // Check if specific tools exist in package.json
      let pkg: Record<string, unknown> = {};
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(workdir, 'package.json'), 'utf-8'));
      } catch {
        // empty
      }
      const scripts = (pkg.scripts || {}) as Record<string, string>;
      const devDeps = {
        ...(pkg.devDependencies || {}),
        ...(pkg.dependencies || {}),
      } as Record<string, string>;

      // Lint
      if (devDeps.eslint || scripts.lint) {
        defs.push({
          name: 'lint',
          stack: 'npm',
          cmd: 'npx',
          args: ['eslint', '.', '--ext', '.ts,.tsx,.js,.jsx', '--max-warnings', '0'],
          fixable: true,
          fixCmd: 'npx',
          fixArgs: ['eslint', '.', '--ext', '.ts,.tsx,.js,.jsx', '--fix'],
        });
      }

      // Typecheck
      if (devDeps.typescript || fs.existsSync(path.join(workdir, 'tsconfig.json'))) {
        defs.push({
          name: 'typecheck',
          stack: 'npm',
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
        });
      }

      // Test
      if (devDeps.vitest) {
        defs.push({
          name: 'test',
          stack: 'npm',
          cmd: 'npx',
          args: ['vitest', 'run', '--reporter=verbose'],
          coverageParser: parseCoverageFromOutput,
        });
      } else if (devDeps.jest) {
        defs.push({
          name: 'test',
          stack: 'npm',
          cmd: 'npx',
          args: ['jest', '--ci', '--verbose'],
          coverageParser: parseCoverageFromOutput,
        });
      }

      // Build
      if (scripts.build) {
        defs.push({
          name: 'build',
          stack: 'npm',
          cmd: 'npm',
          args: ['run', 'build'],
        });
      }

      // Audit
      defs.push({
        name: 'audit',
        stack: 'npm',
        cmd: 'npm',
        args: ['audit', '--production', '--audit-level=high'],
      });

      return defs;
    }

    case 'python':
      return [
        {
          name: 'lint',
          stack: 'python',
          cmd: 'ruff',
          args: ['check', '.'],
          fixable: true,
          fixCmd: 'ruff',
          fixArgs: ['check', '.', '--fix'],
        },
        {
          name: 'typecheck',
          stack: 'python',
          cmd: 'mypy',
          args: ['.'],
        },
        {
          name: 'test',
          stack: 'python',
          cmd: 'pytest',
          args: ['-v', '--tb=short'],
          coverageParser: parseCoverageFromOutput,
        },
        {
          name: 'audit',
          stack: 'python',
          cmd: 'pip-audit',
          args: [],
        },
      ];

    case 'go':
      return [
        {
          name: 'lint',
          stack: 'go',
          cmd: 'go',
          args: ['vet', './...'],
        },
        {
          name: 'lint-advanced',
          stack: 'go',
          cmd: 'golangci-lint',
          args: ['run'],
        },
        {
          name: 'test',
          stack: 'go',
          cmd: 'go',
          args: ['test', '-v', '-race', './...'],
          coverageParser: parseCoverageFromOutput,
        },
        {
          name: 'audit',
          stack: 'go',
          cmd: 'govulncheck',
          args: ['./...'],
        },
      ];

    case 'rust':
      return [
        {
          name: 'check',
          stack: 'rust',
          cmd: 'cargo',
          args: ['check'],
        },
        {
          name: 'lint',
          stack: 'rust',
          cmd: 'cargo',
          args: ['clippy', '--', '-D', 'warnings'],
        },
        {
          name: 'test',
          stack: 'rust',
          cmd: 'cargo',
          args: ['test'],
          coverageParser: parseCoverageFromOutput,
        },
        {
          name: 'audit',
          stack: 'rust',
          cmd: 'cargo',
          args: ['audit'],
        },
      ];

    case 'ruby':
      return [
        {
          name: 'lint',
          stack: 'ruby',
          cmd: 'rubocop',
          args: ['--format', 'simple'],
          fixable: true,
          fixCmd: 'rubocop',
          fixArgs: ['--auto-correct'],
        },
        {
          name: 'test',
          stack: 'ruby',
          cmd: 'bundle',
          args: ['exec', 'rspec', '--format', 'documentation'],
          coverageParser: parseCoverageFromOutput,
        },
        {
          name: 'audit',
          stack: 'ruby',
          cmd: 'bundle',
          args: ['audit', 'check'],
        },
      ];

    case 'java':
      return [
        {
          name: 'compile',
          stack: 'java',
          cmd: 'mvn',
          args: ['compile', '-q'],
        },
        {
          name: 'test',
          stack: 'java',
          cmd: 'mvn',
          args: ['test', '-q'],
          coverageParser: parseCoverageFromOutput,
        },
        {
          name: 'audit',
          stack: 'java',
          cmd: 'mvn',
          args: ['dependency-check:check', '-q'],
        },
      ];

    case 'elixir':
      return [
        {
          name: 'compile',
          stack: 'elixir',
          cmd: 'mix',
          args: ['compile', '--warnings-as-errors'],
        },
        {
          name: 'lint',
          stack: 'elixir',
          cmd: 'mix',
          args: ['credo', '--strict'],
        },
        {
          name: 'test',
          stack: 'elixir',
          cmd: 'mix',
          args: ['test', '--trace'],
          coverageParser: parseCoverageFromOutput,
        },
      ];

    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all applicable quality gates for detected stacks.
 */
export async function runGates(
  workdir: string,
  stacks?: TechStack[],
  opts?: RunGatesOpts,
): Promise<QualityReport> {
  const resolvedStacks = stacks || detectStacks(workdir);
  const timeoutMs = opts?.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const reportId = uuidv4();
  const startTime = Date.now();

  log.info({ workdir, stacks: resolvedStacks, reportId }, 'Running quality gates');
  broadcast('frankflow:quality', { action: 'started', reportId, stacks: resolvedStacks });

  const gateResults: GateResult[] = [];

  for (const stack of resolvedStacks) {
    const gateDefs = getGateDefsForStack(stack, workdir);

    for (const gateDef of gateDefs) {
      // Skip/only filter
      if (opts?.skipGates?.includes(gateDef.name)) continue;
      if (opts?.onlyGates && !opts.onlyGates.includes(gateDef.name)) continue;

      log.debug({ gate: gateDef.name, stack }, 'Running gate');
      const result = await executeGate(gateDef, workdir, timeoutMs);
      gateResults.push(result);

      broadcast('frankflow:quality', {
        action: 'gate-result',
        reportId,
        gate: result.gate,
        stack: result.stack,
        passed: result.passed,
        durationMs: result.durationMs,
      });
    }
  }

  // Calculate overall coverage
  const coverageResults = gateResults.filter(g => g.coveragePct !== undefined);
  const avgCoverage =
    coverageResults.length > 0
      ? coverageResults.reduce((sum, g) => sum + (g.coveragePct || 0), 0) / coverageResults.length
      : undefined;

  const report: QualityReport = {
    id: reportId,
    beadId: opts?.beadId,
    branch: opts?.branch,
    stacks: resolvedStacks,
    gates: gateResults,
    overallPassed: gateResults.every(g => g.passed),
    totalDurationMs: Date.now() - startTime,
    coveragePct: avgCoverage !== undefined ? Math.round(avgCoverage * 10) / 10 : undefined,
    timestamp: new Date(),
  };

  // Store report
  reports.set(reportId, report);
  if (reports.size > MAX_REPORTS) {
    // Remove oldest
    const oldest = Array.from(reports.entries())
      .sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime())
      .slice(0, reports.size - MAX_REPORTS);
    for (const [key] of oldest) reports.delete(key);
  }

  log.info(
    {
      reportId,
      stacks: resolvedStacks,
      passed: report.overallPassed,
      gates: gateResults.length,
      failed: gateResults.filter(g => !g.passed).length,
      totalMs: report.totalDurationMs,
      coverage: report.coveragePct,
    },
    'Quality gates complete',
  );

  broadcast('frankflow:quality', {
    action: 'complete',
    reportId,
    passed: report.overallPassed,
    totalMs: report.totalDurationMs,
  });

  return report;
}

/**
 * Run gates with auto-fix: run all gates, auto-fix any fixable failures, re-run.
 */
export async function runGatesWithFix(workdir: string, opts?: RunGatesOpts): Promise<QualityReport> {
  const stacks = detectStacks(workdir);
  const timeoutMs = opts?.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const reportId = uuidv4();
  const startTime = Date.now();

  log.info({ workdir, stacks, reportId }, 'Running quality gates with auto-fix');

  const gateResults: GateResult[] = [];

  for (const stack of stacks) {
    const gateDefs = getGateDefsForStack(stack, workdir);

    for (const gateDef of gateDefs) {
      if (opts?.skipGates?.includes(gateDef.name)) continue;
      if (opts?.onlyGates && !opts.onlyGates.includes(gateDef.name)) continue;

      let result = await executeGate(gateDef, workdir, timeoutMs);

      // Attempt auto-fix if failed and fixable
      if (!result.passed && gateDef.fixable && gateDef.fixCmd) {
        log.info({ gate: gateDef.name, stack }, 'Attempting auto-fix');
        const fixed = await attemptAutoFix(gateDef, workdir, timeoutMs);
        if (fixed) {
          result = fixed;
        }
      }

      gateResults.push(result);
    }
  }

  const coverageResults = gateResults.filter(g => g.coveragePct !== undefined);
  const avgCoverage =
    coverageResults.length > 0
      ? coverageResults.reduce((sum, g) => sum + (g.coveragePct || 0), 0) / coverageResults.length
      : undefined;

  const report: QualityReport = {
    id: reportId,
    beadId: opts?.beadId,
    branch: opts?.branch,
    stacks,
    gates: gateResults,
    overallPassed: gateResults.every(g => g.passed),
    totalDurationMs: Date.now() - startTime,
    coveragePct: avgCoverage !== undefined ? Math.round(avgCoverage * 10) / 10 : undefined,
    timestamp: new Date(),
  };

  reports.set(reportId, report);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a quality report by ID.
 */
export function getGateReport(reportId: string): QualityReport | undefined {
  return reports.get(reportId);
}

/**
 * List reports with optional filters.
 */
export function listReports(filters?: {
  beadId?: string;
  branch?: string;
  passed?: boolean;
  limit?: number;
}): QualityReport[] {
  let results = Array.from(reports.values());

  if (filters?.beadId) results = results.filter(r => r.beadId === filters.beadId);
  if (filters?.branch) results = results.filter(r => r.branch === filters.branch);
  if (filters?.passed !== undefined) results = results.filter(r => r.overallPassed === filters.passed);

  results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return results.slice(0, filters?.limit ?? 50);
}

/**
 * Get coverage thresholds.
 */
export function getCoverageThresholds(): { warn: number; fail: number } {
  return { ...COVERAGE_THRESHOLDS };
}

/**
 * Get aggregate stats across all reports.
 */
export function getQualityStats(): {
  totalReports: number;
  passRate: number;
  avgDurationMs: number;
  avgCoverage: number | null;
  failedGatesByName: Record<string, number>;
} {
  const all = Array.from(reports.values());
  if (all.length === 0) {
    return { totalReports: 0, passRate: 100, avgDurationMs: 0, avgCoverage: null, failedGatesByName: {} };
  }

  const passedCount = all.filter(r => r.overallPassed).length;
  const avgDuration = all.reduce((s, r) => s + r.totalDurationMs, 0) / all.length;

  const withCoverage = all.filter(r => r.coveragePct !== undefined);
  const avgCoverage =
    withCoverage.length > 0
      ? withCoverage.reduce((s, r) => s + (r.coveragePct || 0), 0) / withCoverage.length
      : null;

  const failedGatesByName: Record<string, number> = {};
  for (const report of all) {
    for (const gate of report.gates) {
      if (!gate.passed) {
        failedGatesByName[gate.gate] = (failedGatesByName[gate.gate] || 0) + 1;
      }
    }
  }

  return {
    totalReports: all.length,
    passRate: Math.round((passedCount / all.length) * 1000) / 10,
    avgDurationMs: Math.round(avgDuration),
    avgCoverage: avgCoverage !== null ? Math.round(avgCoverage * 10) / 10 : null,
    failedGatesByName,
  };
}
