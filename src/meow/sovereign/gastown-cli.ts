/**
 * GAS TOWN CLI — SG-022 (Stage 06 Wave 6)
 *
 * CLI command handler for terminal-style interface to Gas Town.
 * Exposed as POST /api/meow/cli endpoint — not actual terminal, but HTTP-based.
 * Parses simple `command subcommand --flags` format and routes to appropriate services.
 *
 * Commands:
 *   cook <formula> [--priority N] [--dry-run]         Run a formula
 *   status [--full]                                    System overview
 *   workers [list|detail <id>] [--tier S|A|B|C]       List/detail workers
 *   beads [list|create <title>] [--type T] [--limit N] List or create beads
 *   mail <recipient> <subject> [--body B]              Send mail through Gas Town
 *   schedule [today|generate] [--timezone TZ]          View or generate daily plan
 *   help [command]                                      Show usage information
 *
 * Features:
 *   - Command parsing: simple `command subcommand --flags` format
 *   - Output formatting: structured text output (tables, status indicators)
 *   - Command history: track recent commands for audit trail
 *   - Batch mode: execute multiple commands from array
 *   - Help system: --help flag on any command shows usage
 *   - DB table: meow_cli_history for command audit trail
 *
 * Gas Town: "Even a refinery needs a control panel — type, and the town obeys."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import { gtSling, gtNudge, gtSeance, gtHandoff, gtConvoy } from './gt-commands';
import { getExtensionRegistry } from './extension-manifest';
import { getMolMall, type FormulaCategory } from './mol-mall';
import { getGuzzolineEngine, checkNDI, BOND_OPERATOR_TABLE, COMPOUND_FORMULAS } from './guzzoline-ndi';

const log = createLogger('gastown-cli');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CliCommandName = 'cook' | 'status' | 'workers' | 'beads' | 'mail' | 'schedule' | 'help' | 'sling' | 'nudge' | 'seance' | 'handoff' | 'convoy' | 'plugins' | 'mall' | 'guzzoline';

export type CliOutputFormat = 'text' | 'json' | 'table';

export interface ParsedCommand {
  command: CliCommandName;
  subcommand?: string;
  args: string[];
  flags: Record<string, string | boolean>;
  raw: string;
}

export interface CliResult {
  id: string;
  command: string;
  success: boolean;
  output: string;
  format: CliOutputFormat;
  durationMs: number;
  timestamp: Date;
}

export interface CliHistoryEntry {
  id: string;
  commandRaw: string;
  commandParsed: ParsedCommand;
  operatorId?: string;
  success: boolean;
  outputPreview: string;
  durationMs: number;
  source: 'http' | 'batch';
  createdAt: Date;
}

export interface BatchResult {
  id: string;
  totalCommands: number;
  succeeded: number;
  failed: number;
  results: CliResult[];
  durationMs: number;
}

export interface CommandHelp {
  command: string;
  description: string;
  usage: string;
  examples: string[];
  flags: Array<{ flag: string; description: string; default?: string }>;
}

export interface CliStats {
  totalCommandsExecuted: number;
  commandsLast24h: number;
  successRate: number;
  avgDurationMs: number;
  topCommands: Array<{ command: string; count: number }>;
  lastCommandAt?: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_MEMORY = 2000;
const MAX_BATCH_COMMANDS = 50;
const MAX_OUTPUT_LENGTH = 10_000;

/** Help definitions for all commands */
const COMMAND_HELP: Record<CliCommandName, CommandHelp> = {
  cook: {
    command: 'cook',
    description: 'Run a Gas Town formula',
    usage: 'cook <formula-name> [--priority N] [--dry-run] [--params JSON]',
    examples: [
      'cook campaign-launch --priority 1',
      'cook daily-audit --dry-run',
      'cook market-research --params \'{"country":"BR"}\'',
    ],
    flags: [
      { flag: '--priority', description: 'Execution priority (1-10, lower = higher)', default: '5' },
      { flag: '--dry-run', description: 'Validate without executing' },
      { flag: '--params', description: 'JSON parameters for the formula' },
    ],
  },
  status: {
    command: 'status',
    description: 'Show Gas Town system overview',
    usage: 'status [--full] [--format json|text]',
    examples: ['status', 'status --full', 'status --format json'],
    flags: [
      { flag: '--full', description: 'Include detailed breakdown' },
      { flag: '--format', description: 'Output format', default: 'text' },
    ],
  },
  workers: {
    command: 'workers',
    description: 'List or inspect Gas Town workers',
    usage: 'workers [list|detail <worker-id>] [--tier S|A|B|C] [--status active|idle]',
    examples: [
      'workers list',
      'workers list --tier S',
      'workers detail ag-ecom-01',
      'workers --status active',
    ],
    flags: [
      { flag: '--tier', description: 'Filter by worker tier (S, A, B, C)' },
      { flag: '--status', description: 'Filter by status' },
      { flag: '--limit', description: 'Max results', default: '50' },
    ],
  },
  beads: {
    command: 'beads',
    description: 'List or create Gas Town beads',
    usage: 'beads [list|create <title>] [--type T] [--priority N] [--status S]',
    examples: [
      'beads list',
      'beads list --status pending --limit 20',
      'beads create "Launch Q2 Campaign" --type campaign --priority 2',
    ],
    flags: [
      { flag: '--type', description: 'Bead type filter or assignment' },
      { flag: '--priority', description: 'Priority (1-10)', default: '5' },
      { flag: '--status', description: 'Filter by status' },
      { flag: '--limit', description: 'Max results', default: '50' },
    ],
  },
  mail: {
    command: 'mail',
    description: 'Send a message through Gas Town mail system',
    usage: 'mail <recipient> <subject> [--body TEXT] [--priority normal|high|urgent]',
    examples: [
      'mail operator "Daily Report Ready" --body "Check the dashboard"',
      'mail all "System Maintenance" --priority urgent --body "Downtime at 22:00"',
    ],
    flags: [
      { flag: '--body', description: 'Message body text' },
      { flag: '--priority', description: 'Mail priority', default: 'normal' },
    ],
  },
  schedule: {
    command: 'schedule',
    description: 'View or generate the daily execution schedule',
    usage: 'schedule [today|generate] [--timezone TZ] [--format text|json]',
    examples: [
      'schedule today',
      'schedule generate --timezone America/Sao_Paulo',
      'schedule today --format json',
    ],
    flags: [
      { flag: '--timezone', description: 'Timezone for schedule', default: 'America/Sao_Paulo' },
      { flag: '--format', description: 'Output format', default: 'text' },
    ],
  },
  help: {
    command: 'help',
    description: 'Show help for Gas Town CLI commands',
    usage: 'help [command-name]',
    examples: ['help', 'help cook', 'help workers'],
    flags: [],
  },
  sling: {
    command: 'sling',
    description: 'Assign a bead to an agent hook (GUPP enforcement)',
    usage: 'sling <bead-id> <agent-address> [--operator ID]',
    examples: ['sling bead-123 gastown/polecats/nux', 'sling bead-456 gastown/crew/witness --operator mayor'],
    flags: [{ flag: '--operator', description: 'Who is slinging', default: 'system' }],
  },
  nudge: {
    command: 'nudge',
    description: 'Send a real-time poke/message to an agent',
    usage: 'nudge <agent-address> "<message>" [--type T] [--urgency U]',
    examples: ['nudge gastown/polecats/nux "Check PR #42"', 'nudge all "Deploy in 5 min" --urgency critical'],
    flags: [
      { flag: '--type', description: 'Message type: poke, priority_change, deadline, info, abort', default: 'poke' },
      { flag: '--urgency', description: 'low, normal, high, critical', default: 'normal' },
      { flag: '--from', description: 'Sender address', default: 'overseer' },
    ],
  },
  seance: {
    command: 'seance',
    description: 'Recover context from a dead/terminated session',
    usage: 'seance <session-id> [--requested-by NAME]',
    examples: ['seance gt-gastown-app-nux', 'seance sess-abc123 --requested-by mayor'],
    flags: [{ flag: '--requested-by', description: 'Who requested the seance', default: 'system' }],
  },
  handoff: {
    command: 'handoff',
    description: 'Transfer session state gracefully between sessions',
    usage: 'handoff <from-session> <to-session> <agent> [--reason R]',
    examples: ['handoff sess-old sess-new nux --reason upgrade', 'handoff sess-123 sess-456 toast --reason stale'],
    flags: [
      { flag: '--reason', description: 'Reason: graceful, stale, stuck, upgrade, rebalance', default: 'graceful' },
      { flag: '--bead', description: 'Bead ID to transfer' },
      { flag: '--branch', description: 'Git branch being worked on' },
    ],
  },
  convoy: {
    command: 'convoy',
    description: 'Manage work convoys (list, create, status, close, add-bead)',
    usage: 'convoy <action> [args] [--flags]',
    examples: [
      'convoy list',
      'convoy create "Wave 7 Deploy"',
      'convoy status gt-c-abc123',
      'convoy close gt-c-abc123',
      'convoy add-bead gt-c-abc123 bead-1 bead-2',
    ],
    flags: [],
  },
  plugins: {
    command: 'plugins',
    description: 'View and manage Gas Town extension plugins',
    usage: 'plugins [list|stats|enable|disable] [--level L]',
    examples: ['plugins list', 'plugins list --level refinery', 'plugins stats', 'plugins enable ext-ref-abc12345'],
    flags: [
      { flag: '--level', description: 'Filter by level: town, rig, refinery' },
    ],
  },
  mall: {
    command: 'mall',
    description: 'Browse the Mol Mall formula marketplace',
    usage: 'mall [browse|search|install|stats] [--category C]',
    examples: ['mall browse', 'mall search patrol', 'mall install mol-polecat-work', 'mall stats'],
    flags: [
      { flag: '--category', description: 'Filter by category: workflow, patrol, release, test, deploy, analysis' },
    ],
  },
  guzzoline: {
    command: 'guzzoline',
    description: 'View fuel reservoir, NDI status, bond operators, compounds',
    usage: 'guzzoline [reservoir|ndi|bonds|compounds] [--agent-id A] [--bead-id B]',
    examples: ['guzzoline reservoir', 'guzzoline ndi --agent-id ag-01 --bead-id bead-123', 'guzzoline bonds', 'guzzoline compounds'],
    flags: [
      { flag: '--agent-id', description: 'Agent ID for NDI check' },
      { flag: '--bead-id', description: 'Bead ID for NDI check' },
      { flag: '--molecule-id', description: 'Molecule ID for NDI check' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

function parseCommand(raw: string): ParsedCommand | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  if (tokens.length === 0) return null;

  const command = tokens[0].toLowerCase() as CliCommandName;
  const validCommands: CliCommandName[] = ['cook', 'status', 'workers', 'beads', 'mail', 'schedule', 'help', 'sling', 'nudge', 'seance', 'handoff', 'convoy', 'plugins', 'mall', 'guzzoline'];
  if (!validCommands.includes(command)) return null;

  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  let subcommand: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const flagName = token.slice(2);
      // Check if next token is a value (not a flag)
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[flagName] = tokens[i + 1];
        i++;
      } else {
        flags[flagName] = true;
      }
    } else if (!subcommand && i === 1) {
      subcommand = token;
    } else {
      args.push(token);
    }
  }

  // Check for --help flag
  if (flags.help) {
    return { command: 'help', subcommand: command, args: [], flags: {}, raw: trimmed };
  }

  return { command, subcommand, args, flags, raw: trimmed };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(h.length, maxRow);
  });

  const sep = colWidths.map(w => '-'.repeat(w + 2)).join('+');
  const headerLine = headers.map((h, i) => ` ${h.padEnd(colWidths[i])} `).join('|');

  const bodyLines = rows.map(row =>
    row.map((cell, i) => ` ${(cell ?? '').padEnd(colWidths[i])} `).join('|'),
  );

  return [headerLine, sep, ...bodyLines].join('\n');
}

function statusIndicator(status: string): string {
  const indicators: Record<string, string> = {
    active: '[+]',
    idle: '[-]',
    pending: '[~]',
    running: '[>]',
    completed: '[v]',
    failed: '[x]',
    healthy: '[+]',
    degraded: '[!]',
    down: '[X]',
  };
  return indicators[status] ?? `[${status}]`;
}

// ---------------------------------------------------------------------------
// GasTownCli
// ---------------------------------------------------------------------------

export class GasTownCli {
  private history: CliHistoryEntry[] = [];
  private totalExecuted = 0;
  private successCount = 0;
  private totalDurationMs = 0;

  // -------------------------------------------------------------------------
  // Execute single command
  // -------------------------------------------------------------------------

  async execute(rawCommand: string, operatorId?: string): Promise<CliResult> {
    const startTime = Date.now();
    const resultId = uuidv4();

    const parsed = parseCommand(rawCommand);
    if (!parsed) {
      const result: CliResult = {
        id: resultId,
        command: rawCommand,
        success: false,
        output: `Unknown command: "${rawCommand}"\nType "help" for available commands.`,
        format: 'text',
        durationMs: Date.now() - startTime,
        timestamp: new Date(),
      };
      await this.recordHistory(result, rawCommand, parsed, operatorId, 'http');
      return result;
    }

    try {
      const output = await this.dispatch(parsed);
      const format: CliOutputFormat = (parsed.flags.format === 'json') ? 'json' : 'text';
      const durationMs = Date.now() - startTime;

      const result: CliResult = {
        id: resultId,
        command: rawCommand,
        success: true,
        output: output.slice(0, MAX_OUTPUT_LENGTH),
        format,
        durationMs,
        timestamp: new Date(),
      };

      this.totalExecuted += 1;
      this.successCount += 1;
      this.totalDurationMs += durationMs;

      await this.recordHistory(result, rawCommand, parsed, operatorId, 'http');

      broadcast('meow:sovereign', {
        type: 'cli:command_executed',
        command: parsed.command,
        success: true,
        durationMs,
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);

      const result: CliResult = {
        id: resultId,
        command: rawCommand,
        success: false,
        output: `Error executing "${parsed.command}": ${errMsg}`,
        format: 'text',
        durationMs,
        timestamp: new Date(),
      };

      this.totalExecuted += 1;
      this.totalDurationMs += durationMs;

      await this.recordHistory(result, rawCommand, parsed, operatorId, 'http');
      log.error({ err, command: rawCommand }, 'CLI command execution failed');

      return result;
    }
  }

  // -------------------------------------------------------------------------
  // Batch execution
  // -------------------------------------------------------------------------

  async executeBatch(commands: string[], operatorId?: string): Promise<BatchResult> {
    const startTime = Date.now();
    const batchId = uuidv4();

    if (commands.length > MAX_BATCH_COMMANDS) {
      return {
        id: batchId,
        totalCommands: commands.length,
        succeeded: 0,
        failed: commands.length,
        results: [{
          id: uuidv4(),
          command: 'batch',
          success: false,
          output: `Batch too large: ${commands.length} commands (max: ${MAX_BATCH_COMMANDS})`,
          format: 'text',
          durationMs: 0,
          timestamp: new Date(),
        }],
        durationMs: Date.now() - startTime,
      };
    }

    const results: CliResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const cmd of commands) {
      const result = await this.execute(cmd, operatorId);
      results.push(result);
      if (result.success) succeeded++;
      else failed++;
    }

    log.info({ batchId, total: commands.length, succeeded, failed }, 'Batch execution completed');

    broadcast('meow:sovereign', {
      type: 'cli:batch_completed',
      batchId,
      totalCommands: commands.length,
      succeeded,
      failed,
    });

    return {
      id: batchId,
      totalCommands: commands.length,
      succeeded,
      failed,
      results,
      durationMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  private async dispatch(parsed: ParsedCommand): Promise<string> {
    switch (parsed.command) {
      case 'cook':    return this.cmdCook(parsed);
      case 'status':  return this.cmdStatus(parsed);
      case 'workers': return this.cmdWorkers(parsed);
      case 'beads':   return this.cmdBeads(parsed);
      case 'mail':    return this.cmdMail(parsed);
      case 'schedule':return this.cmdSchedule(parsed);
      case 'help':    return this.cmdHelp(parsed);
      case 'sling':    return this.cmdSling(parsed);
      case 'nudge':    return this.cmdNudge(parsed);
      case 'seance':   return this.cmdSeance(parsed);
      case 'handoff':  return this.cmdHandoff(parsed);
      case 'convoy':   return this.cmdConvoy(parsed);
      case 'plugins':  return this.cmdPlugins(parsed);
      case 'mall':     return this.cmdMall(parsed);
      case 'guzzoline':return this.cmdGuzzoline(parsed);
      default:
        return `Unknown command: ${parsed.command}`;
    }
  }

  // -------------------------------------------------------------------------
  // cook
  // -------------------------------------------------------------------------

  private async cmdCook(parsed: ParsedCommand): Promise<string> {
    const formulaName = parsed.subcommand;
    if (!formulaName) return 'Usage: cook <formula-name> [--priority N] [--dry-run]';

    const priority = parseInt(parsed.flags.priority as string, 10) || 5;
    const dryRun = !!parsed.flags['dry-run'];
    const paramsStr = parsed.flags.params as string;
    let params: Record<string, unknown> = {};

    if (paramsStr) {
      try { params = JSON.parse(paramsStr); }
      catch { return 'Error: --params must be valid JSON'; }
    }

    if (dryRun) {
      return [
        `=== DRY RUN: ${formulaName} ===`,
        `Priority: ${priority}`,
        `Params: ${JSON.stringify(params)}`,
        '',
        '[v] Formula name validated',
        '[v] Parameters parsed',
        '[~] Would queue for execution',
        '',
        'Dry run complete — no changes made.',
      ].join('\n');
    }

    const triggerId = uuidv4();
    try {
      const pool = getPool();
      if (!pool) throw new Error('DB not available');
      await pool.query(
        `INSERT INTO meow_formula_triggers (id, formula_name, params, priority, status, triggered_via, created_at)
         VALUES ($1, $2, $3, $4, 'queued', 'cli', NOW())
         ON CONFLICT DO NOTHING`,
        [triggerId, formulaName, JSON.stringify(params), priority],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist formula trigger from CLI');
    }

    broadcast('meow:sovereign', {
      type: 'cli:formula_triggered',
      triggerId,
      formulaName,
      priority,
    });

    return [
      `=== COOK: ${formulaName} ===`,
      `Trigger ID: ${triggerId}`,
      `Priority: ${priority}`,
      `Status: queued`,
      `Params: ${JSON.stringify(params)}`,
      '',
      `[+] Formula queued for execution.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  private async cmdStatus(parsed: ParsedCommand): Promise<string> {
    const full = !!parsed.flags.full;
    const pool = getPool();
    if (!pool) return '[x] DB not available — cannot fetch status.';

    try {
      const [beadRes, workerRes, formulaRes, costRes] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int as count FROM meow_beads GROUP BY status`),
        pool.query(`SELECT status, COUNT(*)::int as count FROM meow_workers GROUP BY status`),
        pool.query(`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE status = 'running')::int as running FROM meow_formulas`),
        pool.query(`SELECT COALESCE(SUM(cost_usd), 0)::float as total FROM meow_cost_log WHERE created_at > NOW() - INTERVAL '24 hours'`),
      ]);

      const beadsByStatus = beadRes.rows.reduce((acc: Record<string, number>, r: { status: string; count: number }) => {
        acc[r.status] = r.count; return acc;
      }, {});

      const workersByStatus = workerRes.rows.reduce((acc: Record<string, number>, r: { status: string; count: number }) => {
        acc[r.status] = r.count; return acc;
      }, {});

      const lines = [
        '╔══════════════════════════════════════╗',
        '║      GAS TOWN — STATUS OVERVIEW      ║',
        '╚══════════════════════════════════════╝',
        '',
        `  Formulas : ${formulaRes.rows[0]?.total ?? 0} total, ${formulaRes.rows[0]?.running ?? 0} running`,
        `  Beads    : pending=${beadsByStatus.pending ?? 0} active=${beadsByStatus.active ?? 0} done=${beadsByStatus.completed ?? 0}`,
        `  Workers  : active=${workersByStatus.active ?? 0} idle=${workersByStatus.idle ?? 0}`,
        `  Cost 24h : $${(costRes.rows[0]?.total ?? 0).toFixed(2)}`,
        `  CLI cmds : ${this.totalExecuted} executed`,
        '',
      ];

      if (full) {
        lines.push('--- Beads Breakdown ---');
        for (const [status, count] of Object.entries(beadsByStatus)) {
          lines.push(`  ${statusIndicator(status)} ${status}: ${count}`);
        }
        lines.push('');
        lines.push('--- Workers Breakdown ---');
        for (const [status, count] of Object.entries(workersByStatus)) {
          lines.push(`  ${statusIndicator(status)} ${status}: ${count}`);
        }
        lines.push('');
      }

      lines.push(`[+] Status retrieved at ${new Date().toISOString()}`);

      if (parsed.flags.format === 'json') {
        return JSON.stringify({ beadsByStatus, workersByStatus, formulas: formulaRes.rows[0], cost24h: costRes.rows[0]?.total }, null, 2);
      }

      return lines.join('\n');
    } catch (err) {
      log.warn({ err }, 'CLI status query failed, returning heuristic');
      return [
        '=== GAS TOWN STATUS (heuristic) ===',
        `  CLI commands executed: ${this.totalExecuted}`,
        `  Success rate: ${this.totalExecuted > 0 ? Math.round((this.successCount / this.totalExecuted) * 100) : 100}%`,
        `  Avg command time: ${this.totalExecuted > 0 ? Math.round(this.totalDurationMs / this.totalExecuted) : 0}ms`,
        '',
        '[!] Could not query database — showing local stats only.',
      ].join('\n');
    }
  }

  // -------------------------------------------------------------------------
  // workers
  // -------------------------------------------------------------------------

  private async cmdWorkers(parsed: ParsedCommand): Promise<string> {
    const sub = parsed.subcommand ?? 'list';
    const pool = getPool();
    if (!pool) return '[x] DB not available — cannot fetch workers.';

    if (sub === 'detail') {
      const workerId = parsed.args[0];
      if (!workerId) return 'Usage: workers detail <worker-id>';

      try {
        const { rows } = await pool.query(
          `SELECT id, name, role, status, tier, current_task, xp, level, skills, created_at
           FROM meow_workers WHERE id = $1`, [workerId],
        );
        if (rows.length === 0) return `Worker not found: ${workerId}`;

        const w = rows[0];
        return [
          `=== WORKER DETAIL: ${w.name} ===`,
          `  ID      : ${w.id}`,
          `  Role    : ${w.role}`,
          `  Tier    : ${w.tier}`,
          `  Status  : ${statusIndicator(w.status)} ${w.status}`,
          `  Level   : ${w.level}`,
          `  XP      : ${w.xp}`,
          `  Task    : ${w.current_task ?? 'none'}`,
          `  Skills  : ${w.skills ?? 'N/A'}`,
          `  Since   : ${w.created_at}`,
        ].join('\n');
      } catch (err) {
        return `Error fetching worker: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // List mode
    const tier = parsed.flags.tier as string | undefined;
    const status = parsed.flags.status as string | undefined;
    const limit = Math.min(parseInt(parsed.flags.limit as string, 10) || 50, 200);

    try {
      let sql = 'SELECT id, name, role, status, tier, level, xp FROM meow_workers WHERE 1=1';
      const params: unknown[] = [];
      let paramIdx = 1;

      if (tier) { sql += ` AND tier = $${paramIdx++}`; params.push(tier.toUpperCase()); }
      if (status) { sql += ` AND status = $${paramIdx++}`; params.push(status); }
      sql += ` ORDER BY tier, name LIMIT ${limit}`;

      const { rows } = await pool.query(sql, params);

      if (rows.length === 0) return 'No workers found matching criteria.';

      const headers = ['ID', 'Name', 'Role', 'Tier', 'Status', 'Lvl', 'XP'];
      const tableRows = rows.map((w: Record<string, unknown>) => [
        String(w.id).slice(0, 20),
        String(w.name).slice(0, 20),
        String(w.role ?? '').slice(0, 15),
        String(w.tier ?? ''),
        `${statusIndicator(String(w.status))} ${w.status}`,
        String(w.level ?? 0),
        String(w.xp ?? 0),
      ]);

      return `=== WORKERS (${rows.length}) ===\n\n` + formatTable(headers, tableRows);
    } catch (err) {
      return `Error listing workers: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // beads
  // -------------------------------------------------------------------------

  private async cmdBeads(parsed: ParsedCommand): Promise<string> {
    const sub = parsed.subcommand ?? 'list';
    const pool = getPool();
    if (!pool) return '[x] DB not available — cannot access beads.';

    if (sub === 'create') {
      const title = parsed.args[0];
      if (!title) return 'Usage: beads create "<title>" [--type T] [--priority N]';

      const type = (parsed.flags.type as string) ?? 'general';
      const priority = parseInt(parsed.flags.priority as string, 10) || 5;
      const beadId = uuidv4();

      try {
        await pool.query(
          `INSERT INTO meow_beads (id, title, type, priority, status, created_at)
           VALUES ($1, $2, $3, $4, 'pending', NOW())
           ON CONFLICT DO NOTHING`,
          [beadId, title, type, priority],
        );
      } catch (err) {
        log.warn({ err }, 'Failed to persist bead from CLI');
      }

      broadcast('meow:sovereign', {
        type: 'cli:bead_created',
        beadId,
        title,
      });

      return [
        `=== BEAD CREATED ===`,
        `  ID       : ${beadId}`,
        `  Title    : ${title}`,
        `  Type     : ${type}`,
        `  Priority : ${priority}`,
        `  Status   : pending`,
        '',
        `[+] Bead queued for processing.`,
      ].join('\n');
    }

    // List mode
    const statusFilter = parsed.flags.status as string | undefined;
    const typeFilter = parsed.flags.type as string | undefined;
    const limit = Math.min(parseInt(parsed.flags.limit as string, 10) || 50, 200);

    try {
      let sql = 'SELECT id, title, type, status, priority, created_at FROM meow_beads WHERE 1=1';
      const params: unknown[] = [];
      let paramIdx = 1;

      if (statusFilter) { sql += ` AND status = $${paramIdx++}`; params.push(statusFilter); }
      if (typeFilter) { sql += ` AND type = $${paramIdx++}`; params.push(typeFilter); }
      sql += ` ORDER BY created_at DESC LIMIT ${limit}`;

      const { rows } = await pool.query(sql, params);

      if (rows.length === 0) return 'No beads found matching criteria.';

      const headers = ['ID', 'Title', 'Type', 'Status', 'Pri', 'Created'];
      const tableRows = rows.map((b: Record<string, unknown>) => [
        String(b.id).slice(0, 12),
        String(b.title).slice(0, 30),
        String(b.type ?? '').slice(0, 12),
        `${statusIndicator(String(b.status))} ${b.status}`,
        String(b.priority ?? 5),
        String(b.created_at).slice(0, 19),
      ]);

      return `=== BEADS (${rows.length}) ===\n\n` + formatTable(headers, tableRows);
    } catch (err) {
      return `Error listing beads: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // mail
  // -------------------------------------------------------------------------

  private async cmdMail(parsed: ParsedCommand): Promise<string> {
    const recipient = parsed.subcommand;
    const subject = parsed.args[0];
    if (!recipient || !subject) return 'Usage: mail <recipient> "<subject>" [--body TEXT] [--priority normal|high|urgent]';

    const body = (parsed.flags.body as string) ?? '';
    const priority = (parsed.flags.priority as string) ?? 'normal';
    const mailId = uuidv4();

    try {
      const pool = getPool();
      if (!pool) throw new Error('DB not available');
      await pool.query(
        `INSERT INTO meow_mail (id, recipient, subject, body, priority, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'queued', NOW())
         ON CONFLICT DO NOTHING`,
        [mailId, recipient, subject, body, priority],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist mail from CLI');
    }

    broadcast('meow:sovereign', {
      type: 'cli:mail_sent',
      mailId,
      recipient,
      subject,
      priority,
    });

    return [
      `=== MAIL QUEUED ===`,
      `  ID        : ${mailId}`,
      `  To        : ${recipient}`,
      `  Subject   : ${subject}`,
      `  Priority  : ${priority}`,
      `  Body      : ${body ? body.slice(0, 80) + (body.length > 80 ? '...' : '') : '(empty)'}`,
      '',
      `[+] Mail queued for delivery.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // schedule
  // -------------------------------------------------------------------------

  private async cmdSchedule(parsed: ParsedCommand): Promise<string> {
    const sub = parsed.subcommand ?? 'today';
    const timezone = (parsed.flags.timezone as string) ?? 'America/Sao_Paulo';
    const pool = getPool();
    if (!pool) return '[x] DB not available — cannot access schedule.';

    if (sub === 'generate') {
      broadcast('meow:sovereign', {
        type: 'cli:schedule_generate_requested',
        timezone,
      });

      return [
        '=== SCHEDULE GENERATION REQUESTED ===',
        `  Timezone: ${timezone}`,
        `  Status: Signal sent to SelfScheduler`,
        '',
        '[~] Schedule will be generated and broadcast on SSE.',
      ].join('\n');
    }

    // Today view
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `SELECT id, date, total_slots, completed_slots, failed_slots, generated_at, ai_generated
         FROM meow_daily_schedule WHERE date = $1 ORDER BY generated_at DESC LIMIT 1`,
        [today],
      );

      if (rows.length === 0) {
        return [
          `=== SCHEDULE: ${today} ===`,
          '',
          'No schedule generated for today.',
          'Run "schedule generate" to create one.',
        ].join('\n');
      }

      const sched = rows[0];
      const { rows: slots } = await pool.query(
        `SELECT formula_name, status, priority, scheduled_start_at, scheduled_end_at, rationale
         FROM meow_schedule_slots WHERE schedule_id = $1 ORDER BY scheduled_start_at`,
        [sched.id],
      );

      const lines = [
        `=== SCHEDULE: ${today} ===`,
        `  Generated  : ${sched.generated_at}`,
        `  AI-powered : ${sched.ai_generated ? 'yes' : 'no'}`,
        `  Total slots: ${sched.total_slots}`,
        `  Completed  : ${sched.completed_slots}`,
        `  Failed     : ${sched.failed_slots}`,
        '',
      ];

      if (slots.length > 0) {
        const headers = ['Time', 'Formula', 'Status', 'Pri'];
        const tableRows = slots.map((s: Record<string, unknown>) => [
          String(s.scheduled_start_at).slice(11, 16),
          String(s.formula_name).slice(0, 25),
          `${statusIndicator(String(s.status))} ${s.status}`,
          String(s.priority ?? ''),
        ]);
        lines.push(formatTable(headers, tableRows));
      }

      if (parsed.flags.format === 'json') {
        return JSON.stringify({ schedule: sched, slots }, null, 2);
      }

      return lines.join('\n');
    } catch (err) {
      return `Error fetching schedule: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // help
  // -------------------------------------------------------------------------

  private cmdHelp(parsed: ParsedCommand): string {
    const target = parsed.subcommand;

    if (target && COMMAND_HELP[target as CliCommandName]) {
      const h = COMMAND_HELP[target as CliCommandName];
      const lines = [
        `=== HELP: ${h.command} ===`,
        '',
        `  ${h.description}`,
        '',
        `  Usage: ${h.usage}`,
        '',
      ];

      if (h.flags.length > 0) {
        lines.push('  Flags:');
        for (const f of h.flags) {
          lines.push(`    ${f.flag.padEnd(20)} ${f.description}${f.default ? ` (default: ${f.default})` : ''}`);
        }
        lines.push('');
      }

      if (h.examples.length > 0) {
        lines.push('  Examples:');
        for (const ex of h.examples) {
          lines.push(`    $ ${ex}`);
        }
      }

      return lines.join('\n');
    }

    // General help
    const lines = [
      '╔══════════════════════════════════════╗',
      '║       GAS TOWN CLI — HELP            ║',
      '╚══════════════════════════════════════╝',
      '',
    ];

    for (const [cmd, h] of Object.entries(COMMAND_HELP)) {
      lines.push(`  ${cmd.padEnd(12)} ${h.description}`);
    }

    lines.push('');
    lines.push('  Use "help <command>" for detailed help on a specific command.');
    lines.push('  Use "--help" flag on any command for quick usage info.');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // sling
  // -------------------------------------------------------------------------

  private async cmdSling(parsed: ParsedCommand): Promise<string> {
    const beadId = parsed.subcommand;
    const agentAddress = parsed.args[0];
    if (!beadId || !agentAddress) return 'Usage: sling <bead-id> <agent-address>';

    const operator = parsed.flags.operator as string | undefined;
    const result = await gtSling(beadId, agentAddress, operator);

    return [
      `=== GT SLING ===`,
      `  Bead     : ${result.beadId}`,
      `  Agent    : ${result.agentAddress}`,
      `  Hook     : ${result.hookCreated ? '[+] created' : '[x] failed'}`,
      `  Nudge    : ${result.nudgeSent ? '[+] sent (GUPP enforced)' : '[x] not sent'}`,
      '',
      `[+] Work slung. "If there is work on your hook, YOU MUST RUN IT."`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // nudge
  // -------------------------------------------------------------------------

  private async cmdNudge(parsed: ParsedCommand): Promise<string> {
    const to = parsed.subcommand;
    const message = parsed.args[0];
    if (!to || !message) return 'Usage: nudge <agent-address> "<message>" [--type T] [--urgency U]';

    const nudge = await gtNudge(to, message, {
      from: parsed.flags.from as string | undefined,
      type: (parsed.flags.type as 'poke' | 'priority_change' | 'deadline' | 'info' | 'abort') ?? 'poke',
      urgency: (parsed.flags.urgency as 'low' | 'normal' | 'high' | 'critical') ?? 'normal',
    });

    return [
      `=== GT NUDGE ===`,
      `  To       : ${nudge.to}`,
      `  Type     : ${nudge.type}`,
      `  Urgency  : ${nudge.urgency}`,
      `  Message  : "${nudge.message.slice(0, 100)}"`,
      '',
      `[+] Nudge delivered.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // seance
  // -------------------------------------------------------------------------

  private async cmdSeance(parsed: ParsedCommand): Promise<string> {
    const sessionId = parsed.subcommand;
    if (!sessionId) return 'Usage: seance <session-id>';

    const requestedBy = parsed.flags['requested-by'] as string | undefined;
    const seance = await gtSeance(sessionId, requestedBy);

    return [
      `=== GT SEANCE ===`,
      `  Session    : ${seance.originalSessionId}`,
      `  Agent      : ${seance.originalAgent || '(unknown)'}`,
      `  Death      : ${seance.deathReason}`,
      `  Beads      : ${seance.beadsInProgress.length > 0 ? seance.beadsInProgress.join(', ') : 'none found'}`,
      `  Last Words : "${seance.lastWords.slice(0, 120) || '(no output recovered)'}"`,
      `  Context    : ${seance.contextSnapshot ? `${seance.contextSnapshot.length} bytes recovered` : 'none'}`,
      '',
      seance.beadsInProgress.length > 0
        ? `[+] Seance complete. ${seance.beadsInProgress.length} bead(s) can be re-slung.`
        : `[~] Seance complete. No active beads found — session may have finished cleanly.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // handoff
  // -------------------------------------------------------------------------

  private async cmdHandoff(parsed: ParsedCommand): Promise<string> {
    const fromSession = parsed.subcommand;
    const toSession = parsed.args[0];
    const agent = parsed.args[1];
    if (!fromSession || !toSession || !agent) return 'Usage: handoff <from-session> <to-session> <agent> [--reason R]';

    const payload = await gtHandoff(fromSession, toSession, agent, {
      reason: (parsed.flags.reason as 'graceful' | 'stale' | 'stuck' | 'upgrade' | 'rebalance') ?? 'graceful',
      beadId: parsed.flags.bead as string | undefined,
      gitBranch: parsed.flags.branch as string | undefined,
    });

    return [
      `=== GT HANDOFF ===`,
      `  From     : ${payload.fromSession}`,
      `  To       : ${payload.toSession}`,
      `  Agent    : ${payload.agent}`,
      `  Reason   : ${payload.reason}`,
      `  Bead     : ${payload.beadId ?? 'none'}`,
      `  Branch   : ${payload.gitBranch ?? 'none'}`,
      `  Files    : ${payload.filesModified.length} transferred`,
      '',
      `[+] Handoff complete. Session state transferred.`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // convoy
  // -------------------------------------------------------------------------

  private async cmdConvoy(parsed: ParsedCommand): Promise<string> {
    const action = (parsed.subcommand ?? 'list') as 'list' | 'create' | 'status' | 'close' | 'add-bead';
    const result = await gtConvoy({
      action,
      convoyId: parsed.args[0],
      title: action === 'create' ? parsed.args[0] : undefined,
      beadIds: action === 'add-bead' ? parsed.args.slice(1) : undefined,
    });
    return `=== GT CONVOY (${action}) ===\n\n${result}`;
  }

  // -------------------------------------------------------------------------
  // plugins
  // -------------------------------------------------------------------------

  private cmdPlugins(parsed: ParsedCommand): string {
    const sub = parsed.subcommand ?? 'list';
    const registry = getExtensionRegistry();
    const level = parsed.flags.level as string | undefined;

    if (sub === 'stats') {
      const s = registry.getStats();
      return [
        `=== EXTENSION PLUGINS — STATS ===`,
        `  Total       : ${s.total}`,
        `  Town        : ${s.byLevel.town}`,
        `  Rig         : ${s.byLevel.rig}`,
        `  Refinery    : ${s.byLevel.refinery}`,
        `  Enabled     : ${s.enabled}`,
        `  Disabled    : ${s.disabled}`,
        `  Total Runs  : ${s.totalRuns}`,
        `  Gates Pass  : ${s.gatesPassing}`,
        `  Gates Fail  : ${s.gatesFailing}`,
      ].join('\n');
    }

    if (sub === 'enable' || sub === 'disable') {
      const pluginId = parsed.args[0];
      if (!pluginId) return `Usage: plugins ${sub} <plugin-id>`;
      const ok = registry.setStatus(pluginId, sub === 'enable' ? 'enabled' : 'disabled');
      return ok ? `[+] Plugin ${pluginId} ${sub}d.` : `[x] Plugin ${pluginId} not found.`;
    }

    // List
    const manifest = registry.getManifest();
    const lines = [
      `=== EXTENSION PLUGINS${level ? ` (${level})` : ''} ===`,
      '',
    ];

    const showLevel = (name: string, plugins: { id: string; name: string; status: string; description: string }[]) => {
      if (level && level !== name) return;
      lines.push(`── ${name.toUpperCase()} (${plugins.length}) ──`);
      for (const p of plugins) {
        const st = p.status === 'enabled' ? '[+]' : p.status === 'disabled' ? '[-]' : '[!]';
        lines.push(`  ${st} ${p.id}  ${p.name} — ${p.description.slice(0, 60)}`);
      }
      lines.push('');
    };

    showLevel('town', manifest.town);
    showLevel('refinery', manifest.refinery);
    for (const [rigName, plugins] of Object.entries(manifest.rig)) {
      showLevel(`rig:${rigName}`, plugins);
    }

    lines.push(`Total: ${manifest.totalPlugins} plugins, ${manifest.activeGates} blocking gates`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // mall
  // -------------------------------------------------------------------------

  private cmdMall(parsed: ParsedCommand): string {
    const sub = parsed.subcommand ?? 'browse';
    const mall = getMolMall();
    const category = parsed.flags.category as FormulaCategory | undefined;

    if (sub === 'stats') {
      const s = mall.getStats();
      return [
        `=== MOL MALL — STATS ===`,
        `  Total Formulas  : ${s.totalFormulas}`,
        `  Total Installs  : ${s.totalInstalls}`,
        `  Total Reviews   : ${s.totalReviews}`,
        `  Categories      : ${Object.keys(s.byCategory).join(', ')}`,
        '',
        '  Top Formulas:',
        ...s.topFormulas.map(f => `    ${f.name} — ${f.installs} installs, ★${f.rating.toFixed(1)}`),
      ].join('\n');
    }

    if (sub === 'install') {
      const formulaId = parsed.args[0];
      const rigName = parsed.args[1] ?? 'default';
      if (!formulaId) return 'Usage: mall install <formula-id> [rig-name]';
      const result = mall.install(formulaId, rigName, 'cli-user');
      return result
        ? `[+] Installed formula "${result.formulaId}" to rig "${result.rigName}"`
        : `[x] Formula "${formulaId}" not found in Mol Mall.`;
    }

    if (sub === 'search') {
      const query = parsed.args[0];
      if (!query) return 'Usage: mall search <query>';
      const results = mall.browse({ search: query, category });
      if (results.length === 0) return `No formulas matching "${query}".`;
      const lines = [`=== MOL MALL — SEARCH: "${query}" (${results.length}) ===`, ''];
      for (const f of results) {
        lines.push(`  ${f.name} v${f.version} [${f.category}] ★${f.rating.toFixed(1)} (${f.installs} installs)`);
        lines.push(`    ${f.description.slice(0, 80)}`);
      }
      return lines.join('\n');
    }

    // Browse
    const formulas = mall.browse({ category });
    const lines = [`=== MOL MALL — BROWSE${category ? ` (${category})` : ''} ===`, ''];
    for (const f of formulas) {
      lines.push(`  ${f.name} v${f.version} [${f.category}] ★${f.rating.toFixed(1)} (${f.installs} installs)`);
      lines.push(`    ${f.description.slice(0, 80)}`);
      lines.push(`    Steps: ${f.stepCount} | Author: ${f.author}`);
      lines.push('');
    }
    lines.push(`${formulas.length} formula(s) available.`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // guzzoline
  // -------------------------------------------------------------------------

  private cmdGuzzoline(parsed: ParsedCommand): string {
    const sub = parsed.subcommand ?? 'reservoir';

    if (sub === 'ndi') {
      const agentId = (parsed.flags['agent-id'] as string) ?? 'ag-unknown';
      const beadId = (parsed.flags['bead-id'] as string) ?? 'bead-unknown';
      const moleculeId = parsed.flags['molecule-id'] as string | undefined;
      const ndi = checkNDI(agentId, beadId, moleculeId);

      const lines = [
        `=== NDI — NONDETERMINISTIC IDEMPOTENCE ===`,
        `  Agent    : ${ndi.agentId}`,
        `  Bead     : ${ndi.beadId}`,
        `  Molecule : ${ndi.moleculeId ?? '(none)'}`,
        `  Status   : ${ndi.overallStatus}`,
        `  Idempotent: ${ndi.idempotent ? 'YES — safe to retry' : 'NO — manual intervention needed'}`,
        '',
        '  PILLARS:',
      ];
      for (const p of ndi.pillars) {
        const icon = p.status === 'intact' ? '[+]' : p.status === 'degraded' ? '[!]' : '[x]';
        lines.push(`    ${icon} ${p.name} — ${p.status} @ ${p.location}`);
        if (p.recoveryMethod) lines.push(`        Recovery: ${p.recoveryMethod}`);
      }
      return lines.join('\n');
    }

    if (sub === 'bonds') {
      const lines = [`=== BOND OPERATOR TABLE ===`, '', '  MEOW Algebra: Operand A + Operand B → Result', ''];
      for (const op of BOND_OPERATOR_TABLE) {
        lines.push(`  ${op.operator.toUpperCase().padEnd(12)} ${op.operandA} + ${op.operandB} → ${op.result}`);
        lines.push(`    ${op.description}`);
        lines.push(`    Phase: ${op.phase} | Reversible: ${op.reversible ? 'yes' : 'no'}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    if (sub === 'compounds') {
      const lines = [`=== COMPOUND FORMULAS ===`, ''];
      for (const cf of COMPOUND_FORMULAS) {
        lines.push(`  ${cf.id} — ${cf.name} [${cf.strategy}]`);
        lines.push(`    ${cf.description}`);
        lines.push(`    Sub-formulas:`);
        for (const sf of cf.subFormulas) {
          lines.push(`      ${sf.order}. ${sf.formulaName}${sf.condition ? ` (if ${sf.condition})` : ''}`);
        }
        if (cf.synthesisStep) lines.push(`    Synthesis: ${cf.synthesisStep.type}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    // Reservoir (default)
    const engine = getGuzzolineEngine();
    const r = engine.getReservoir();
    const barLen = 30;
    const filled = Math.round((r.level / r.capacity) * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const fuelColor = r.level < 20 ? 'CRITICAL' : r.level < 40 ? 'LOW' : r.level < 70 ? 'NORMAL' : 'FULL';

    const lines = [
      `=== GUZZOLINE RESERVOIR ===`,
      '',
      `  Level: [${bar}] ${r.level.toFixed(1)}/${r.capacity} (${fuelColor})`,
      `  Burn Rate    : ${r.burnRate}/hr`,
      `  Fill Rate    : ${r.fillRate}/hr`,
      `  Net Rate     : ${(r.fillRate - r.burnRate).toFixed(1)}/hr`,
      `  Hours Left   : ${r.hoursRemaining >= 999 ? '∞ (surplus)' : r.hoursRemaining.toFixed(1) + 'h'}`,
      '',
      '  BREAKDOWN:',
      `    Beads Ready      : ${r.breakdown.beadsReady}`,
      `    Polecat Slots    : ${r.breakdown.polecatSlots}`,
      `    Budget Remaining : $${r.breakdown.budgetRemaining.toFixed(2)}`,
      `    API Quota        : ${r.breakdown.apiQuota}%`,
      `    Merge Queue Space: ${r.breakdown.mergeQueueSpace}%`,
      '',
      '  GENERATORS:',
    ];
    for (const g of r.generators) {
      lines.push(`    [+] ${g.name} (${g.type}) — ${g.rate}/hr`);
    }
    lines.push('', '  CONSUMERS:');
    for (const c of r.consumers) {
      lines.push(`    [-] ${c.name} (${c.type}) — ${c.rate}/hr`);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Stats & history
  // -------------------------------------------------------------------------

  getStats(): CliStats {
    const last24h = this.history.filter(
      h => h.createdAt.getTime() > Date.now() - 86_400_000,
    );

    const cmdCounts = new Map<string, number>();
    for (const entry of last24h) {
      const cmd = entry.commandParsed?.command ?? 'unknown';
      cmdCounts.set(cmd, (cmdCounts.get(cmd) ?? 0) + 1);
    }

    return {
      totalCommandsExecuted: this.totalExecuted,
      commandsLast24h: last24h.length,
      successRate: this.totalExecuted > 0
        ? Math.round((this.successCount / this.totalExecuted) * 100)
        : 100,
      avgDurationMs: this.totalExecuted > 0
        ? Math.round(this.totalDurationMs / this.totalExecuted)
        : 0,
      topCommands: [...cmdCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([command, count]) => ({ command, count })),
      lastCommandAt: this.history.length > 0
        ? this.history[this.history.length - 1].createdAt
        : undefined,
    };
  }

  getHistory(limit = 50): CliHistoryEntry[] {
    return this.history.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async recordHistory(
    result: CliResult,
    rawCommand: string,
    parsed: ParsedCommand | null,
    operatorId?: string,
    source: 'http' | 'batch' = 'http',
  ): Promise<void> {
    const entry: CliHistoryEntry = {
      id: result.id,
      commandRaw: rawCommand,
      commandParsed: parsed ?? { command: 'help' as CliCommandName, args: [], flags: {}, raw: rawCommand },
      operatorId,
      success: result.success,
      outputPreview: result.output.slice(0, 200),
      durationMs: result.durationMs,
      source,
      createdAt: result.timestamp,
    };

    this.history.push(entry);
    if (this.history.length > MAX_HISTORY_MEMORY) {
      this.history = this.history.slice(-Math.floor(MAX_HISTORY_MEMORY * 0.8));
    }

    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_cli_history (id, command_raw, command_parsed, operator_id, success, output_preview, duration_ms, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT DO NOTHING`,
        [
          entry.id, rawCommand, JSON.stringify(parsed),
          operatorId ?? null, entry.success, entry.outputPreview,
          entry.durationMs, source,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist CLI history entry');
    }
  }

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_cli_history ORDER BY created_at DESC LIMIT $1`,
        [MAX_HISTORY_MEMORY],
      );

      for (const row of rows.reverse()) {
        this.history.push({
          id: row.id,
          commandRaw: row.command_raw,
          commandParsed: typeof row.command_parsed === 'string' ? JSON.parse(row.command_parsed) : row.command_parsed,
          operatorId: row.operator_id,
          success: row.success,
          outputPreview: row.output_preview,
          durationMs: row.duration_ms,
          source: row.source ?? 'http',
          createdAt: new Date(row.created_at),
        });
      }

      this.totalExecuted = this.history.length;
      this.successCount = this.history.filter(h => h.success).length;

      log.info({ commands: rows.length }, 'Loaded CLI history from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load CLI history from DB');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: GasTownCli | null = null;

export function getGasTownCli(): GasTownCli {
  if (!instance) {
    instance = new GasTownCli();
  }
  return instance;
}
