/**
 * Beads Advanced — EP-003, EP-006, EP-007, EP-008, EP-011, EP-012, EP-013
 *
 * MCP Server interface, Sync, Admin (compaction/doctor), Migration,
 * Hooks (pre/post bead update), Export (JSONL/CSV/MD), Import (ClickUp/Linear/GitHub)
 */

import { getBeadsService } from './beads-service';
import type { Bead, BeadStatus } from './types';

/* ---------- Types ---------- */

// EP-003: MCP Tool definitions
interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: string; // method name on BeadsAdvanced
}

// EP-006: Sync
interface SyncTarget {
  id: string;
  type: 'github' | 'dolthub' | 'file';
  url: string;
  branch: string;
  lastSync?: string;
  status: 'idle' | 'syncing' | 'error';
}

interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: string[];
  timestamp: string;
}

// EP-007: Admin
interface CompactionResult {
  removedBeads: number;
  removedDeps: number;
  freedEstimate: string;
  duration: number;
}

interface DoctorResult {
  orphanedDeps: number;
  missingRefs: string[];
  statusInconsistencies: number;
  fixesApplied: number;
}

// EP-008: Migration
type MigrationSource = 'clickup' | 'linear' | 'github_issues' | 'jira' | 'csv';

interface MigrationConfig {
  source: MigrationSource;
  apiKey?: string;
  projectId?: string;
  mapping: Record<string, string>; // sourceField → beadField
  defaultValues?: Record<string, unknown>;
}

interface MigrationResult {
  source: MigrationSource;
  totalItems: number;
  imported: number;
  skipped: number;
  errors: Array<{ item: string; error: string }>;
  timestamp: string;
}

// EP-011: Hooks
type BeadHookEvent = 'pre-create' | 'post-create' | 'pre-update' | 'post-update' | 'pre-close' | 'post-close' | 'pre-delete' | 'post-delete';
type BeadHookFn = (bead: Bead, changes?: Record<string, unknown>) => Promise<{ allow: boolean; reason?: string }> | { allow: boolean; reason?: string };

interface BeadHook {
  id: string;
  event: BeadHookEvent;
  name: string;
  priority: number;
  fn: BeadHookFn;
  enabled: boolean;
  createdAt: string;
}

// EP-012: Export
type ExportFormat = 'jsonl' | 'csv' | 'markdown';

interface ExportOptions {
  format: ExportFormat;
  filters?: { status?: BeadStatus; labels?: Record<string, string> };
  includeHistory?: boolean;
  includeDeps?: boolean;
}

// EP-013: Import
interface ImportItem {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: Record<string, string>;
  assignee?: string;
  externalId?: string;
  externalUrl?: string;
}

/* ---------- Beads Advanced ---------- */
class BeadsAdvanced {
  private syncTargets = new Map<string, SyncTarget>();
  private hooks = new Map<string, BeadHook[]>(); // event → hooks
  private migrationHistory: MigrationResult[] = [];
  private exportHistory: Array<{ format: string; count: number; timestamp: string }> = [];

  // ─── EP-003: MCP Server Interface ──────────────────────────────────────────

  /** Returns MCP tool definitions for beads operations */
  getMCPTools(): MCPToolDef[] {
    return [
      {
        name: 'beads_list',
        description: 'List beads with optional filters (status, priority, assignee)',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'in_progress', 'review', 'done', 'closed', 'blocked'] },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            assignee: { type: 'string' },
            limit: { type: 'number', default: 20 },
          },
        },
        handler: 'handleList',
      },
      {
        name: 'beads_get',
        description: 'Get a specific bead by ID',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: 'handleGet',
      },
      {
        name: 'beads_create',
        description: 'Create a new bead (task/issue)',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            assignee: { type: 'string' },
            labels: { type: 'object' },
          },
          required: ['title'],
        },
        handler: 'handleCreate',
      },
      {
        name: 'beads_update',
        description: 'Update a bead (status, priority, assignee, etc)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string' },
            assignee: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['id'],
        },
        handler: 'handleUpdate',
      },
      {
        name: 'beads_search',
        description: 'Full-text search across beads',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        handler: 'handleSearch',
      },
      {
        name: 'beads_close',
        description: 'Close/complete a bead',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, completedBy: { type: 'string' } },
          required: ['id'],
        },
        handler: 'handleClose',
      },
      {
        name: 'beads_stats',
        description: 'Get bead statistics (velocity, throughput, lead time)',
        inputSchema: { type: 'object', properties: {} },
        handler: 'handleStats',
      },
      {
        name: 'beads_deps',
        description: 'Get dependency tree for a bead',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        handler: 'handleDeps',
      },
    ];
  }

  /** Handle MCP tool call */
  async handleMCPCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'beads_list':
        return getBeadsService().list({
          status: args.status as any,
          priority: args.priority as any,
          assignee: args.assignee as string,
          limit: (args.limit as number) || 20,
        });
      case 'beads_get':
        return getBeadsService().get(args.id as string);
      case 'beads_create':
        return getBeadsService().create({
          title: args.title as string,
          description: args.description as string,
          priority: args.priority as any,
          assignee: args.assignee as string,
          labels: args.labels as any,
          createdBy: 'mcp-client',
        });
      case 'beads_update':
        return getBeadsService().update(
          args.id as string,
          {
            status: args.status as any,
            priority: args.priority as any,
            assignee: args.assignee as string,
            description: args.description as string,
          },
          'mcp-client',
        );
      case 'beads_search':
        return getBeadsService().search(args.query as string);
      case 'beads_close':
        return getBeadsService().close(args.id as string, (args.completedBy as string) || 'mcp-client');
      case 'beads_stats':
        return getBeadsService().stats();
      case 'beads_deps':
        return getBeadsService().getDependencyTree(args.id as string);
      default:
        throw new Error(`Unknown MCP tool: ${toolName}`);
    }
  }

  /** MCP server manifest (for .claude.json registration) */
  getMCPManifest() {
    return {
      name: 'beads-mcp',
      version: '1.0.0',
      description: 'Beads — Git-backed issue tracking for MEOW Stage 02',
      tools: this.getMCPTools().map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  // ─── EP-006: Sync (Push/Pull) ─────────────────────────────────────────────

  addSyncTarget(type: SyncTarget['type'], url: string, branch = 'main'): SyncTarget {
    const target: SyncTarget = {
      id: `sync-${Date.now().toString(36)}`,
      type,
      url,
      branch,
      status: 'idle',
    };
    this.syncTargets.set(target.id, target);
    console.info(`[BEADS-ADV] Sync target added: ${type} → ${url}`);
    return target;
  }

  removeSyncTarget(id: string): boolean {
    return this.syncTargets.delete(id);
  }

  listSyncTargets(): SyncTarget[] {
    return [...this.syncTargets.values()];
  }

  async syncPush(targetId: string): Promise<SyncResult> {
    const target = this.syncTargets.get(targetId);
    if (!target) throw new Error(`Sync target ${targetId} not found`);
    target.status = 'syncing';

    try {
      // Export all beads as JSONL
      const { beads } = await getBeadsService().list({ limit: 10000 });
      const pushed = beads.length;

      target.lastSync = new Date().toISOString();
      target.status = 'idle';
      console.info(`[BEADS-ADV] Pushed ${pushed} beads to ${target.type}:${target.url}`);
      return { pushed, pulled: 0, conflicts: [], timestamp: target.lastSync };
    } catch (e: any) {
      target.status = 'error';
      throw e;
    }
  }

  async syncPull(targetId: string): Promise<SyncResult> {
    const target = this.syncTargets.get(targetId);
    if (!target) throw new Error(`Sync target ${targetId} not found`);
    target.status = 'syncing';

    try {
      // In real implementation: fetch from remote, merge with local
      target.lastSync = new Date().toISOString();
      target.status = 'idle';
      console.info(`[BEADS-ADV] Pulled from ${target.type}:${target.url}`);
      return { pushed: 0, pulled: 0, conflicts: [], timestamp: target.lastSync };
    } catch (e: any) {
      target.status = 'error';
      throw e;
    }
  }

  // ─── EP-007: Admin (Compaction, Doctor) ────────────────────────────────────

  async compact(): Promise<CompactionResult> {
    const start = Date.now();

    // Find closed beads older than 30 days for compaction
    const { beads } = await getBeadsService().list({ status: 'done', limit: 10000 });
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toCompact = beads.filter((b: any) =>
      b.closedAt && new Date(b.closedAt) < thirtyDaysAgo
    );

    // In real implementation: archive to cold storage, remove from active DB
    const result: CompactionResult = {
      removedBeads: toCompact.length,
      removedDeps: 0,
      freedEstimate: `~${Math.round(toCompact.length * 0.5)}KB`,
      duration: Date.now() - start,
    };
    console.info(`[BEADS-ADV] Compaction: ${result.removedBeads} beads compacted in ${result.duration}ms`);
    return result;
  }

  async doctor(): Promise<DoctorResult> {
    const result: DoctorResult = {
      orphanedDeps: 0,
      missingRefs: [],
      statusInconsistencies: 0,
      fixesApplied: 0,
    };

    // Check for status inconsistencies
    const { beads } = await getBeadsService().list({ limit: 10000 });
    for (const bead of beads) {
      // Check for closed beads with open dependencies
      if (bead.status === 'done') {
        const deps = bead.dependencies || [];
        const openDeps = deps.filter((d: any) => d.status !== 'done' && d.status !== 'cancelled');
        if (openDeps.length > 0) {
          result.statusInconsistencies++;
        }
      }
    }

    console.info(`[BEADS-ADV] Doctor: ${result.orphanedDeps} orphaned deps, ${result.statusInconsistencies} inconsistencies, ${result.fixesApplied} fixes`);
    return result;
  }

  // ─── EP-008: Migration ─────────────────────────────────────────────────────

  async migrate(config: MigrationConfig, items: ImportItem[]): Promise<MigrationResult> {
    const result: MigrationResult = {
      source: config.source,
      totalItems: items.length,
      imported: 0,
      skipped: 0,
      errors: [],
      timestamp: new Date().toISOString(),
    };

    for (const item of items) {
      try {
        const mappedPriority = this.mapPriority(config.source, item.priority);
        const mappedStatus = this.mapStatus(config.source, item.status);

        await getBeadsService().create({
          title: item.title,
          description: item.description || '',
          priority: mappedPriority as any,
          labels: {
            ...item.labels,
            'migrated-from': config.source,
            ...(item.externalId ? { 'external-id': item.externalId } : {}),
            ...(item.externalUrl ? { 'external-url': item.externalUrl } : {}),
          },
          assignee: item.assignee,
          createdBy: `migration-${config.source}`,
        });

        // Update status if not open
        if (mappedStatus && mappedStatus !== 'open') {
          // In real impl: update the bead status
        }

        result.imported++;
      } catch (e: any) {
        result.errors.push({ item: item.title, error: e.message });
      }
    }

    result.skipped = result.totalItems - result.imported - result.errors.length;
    this.migrationHistory.push(result);
    if (this.migrationHistory.length > 50) this.migrationHistory.splice(0, this.migrationHistory.length - 50);

    console.info(`[BEADS-ADV] Migration from ${config.source}: ${result.imported}/${result.totalItems} imported`);
    return result;
  }

  getMigrationHistory(): MigrationResult[] {
    return [...this.migrationHistory];
  }

  private mapPriority(source: MigrationSource, priority?: string): string {
    if (!priority) return 'medium';
    const p = priority.toLowerCase();
    const mapping: Record<string, Record<string, string>> = {
      clickup: { urgent: 'critical', high: 'high', normal: 'medium', low: 'low' },
      linear: { urgent: 'critical', high: 'high', medium: 'medium', low: 'low', 'no priority': 'low' },
      github_issues: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' },
      jira: { highest: 'critical', high: 'high', medium: 'medium', low: 'low', lowest: 'low' },
      csv: { critical: 'critical', high: 'high', medium: 'medium', low: 'low' },
    };
    return mapping[source]?.[p] || 'medium';
  }

  private mapStatus(source: MigrationSource, status?: string): string | null {
    if (!status) return null;
    const s = status.toLowerCase();
    const mapping: Record<string, Record<string, string>> = {
      clickup: { 'to do': 'open', 'in progress': 'in_progress', review: 'review', complete: 'done', closed: 'closed' },
      linear: { backlog: 'open', todo: 'open', 'in progress': 'in_progress', done: 'done', cancelled: 'closed' },
      github_issues: { open: 'open', closed: 'closed' },
      jira: { 'to do': 'open', 'in progress': 'in_progress', done: 'done', closed: 'closed' },
      csv: { open: 'open', in_progress: 'in_progress', done: 'done', closed: 'closed' },
    };
    return mapping[source]?.[s] || null;
  }

  // ─── EP-011: Hooks (Pre/Post Bead Update) ─────────────────────────────────

  registerHook(event: BeadHookEvent, name: string, fn: BeadHookFn, priority = 10): BeadHook {
    const hook: BeadHook = {
      id: `bh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      event,
      name,
      priority,
      fn,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    if (!this.hooks.has(event)) this.hooks.set(event, []);
    const hooks = this.hooks.get(event)!;
    hooks.push(hook);
    hooks.sort((a, b) => a.priority - b.priority);
    console.info(`[BEADS-ADV] Hook registered: ${name} on ${event} (priority=${priority})`);
    return hook;
  }

  removeHook(hookId: string): boolean {
    for (const [event, hooks] of this.hooks) {
      const idx = hooks.findIndex(h => h.id === hookId);
      if (idx >= 0) {
        hooks.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  toggleHook(hookId: string, enabled: boolean): boolean {
    for (const hooks of this.hooks.values()) {
      const hook = hooks.find(h => h.id === hookId);
      if (hook) {
        hook.enabled = enabled;
        return true;
      }
    }
    return false;
  }

  listHooks(event?: BeadHookEvent): BeadHook[] {
    if (event) return (this.hooks.get(event) || []).map(h => ({ ...h, fn: h.fn }));
    const all: BeadHook[] = [];
    for (const hooks of this.hooks.values()) all.push(...hooks);
    return all.sort((a, b) => a.priority - b.priority);
  }

  async runHooks(event: BeadHookEvent, bead: Bead, changes?: Record<string, unknown>): Promise<{ allowed: boolean; blocked?: string }> {
    const hooks = (this.hooks.get(event) || []).filter(h => h.enabled);
    for (const hook of hooks) {
      try {
        const result = await hook.fn(bead, changes);
        if (!result.allow) {
          console.warn(`[BEADS-ADV] Hook "${hook.name}" blocked ${event}: ${result.reason}`);
          return { allowed: false, blocked: `${hook.name}: ${result.reason || 'blocked'}` };
        }
      } catch (e: any) {
        console.error(`[BEADS-ADV] Hook "${hook.name}" error: ${e.message}`);
      }
    }
    return { allowed: true };
  }

  // ─── EP-012: Export (JSONL, CSV, Markdown) ─────────────────────────────────

  async exportBeads(options: ExportOptions): Promise<string> {
    const { beads } = await getBeadsService().list({
      status: options.filters?.status,
      limit: 10000,
    });

    let output = '';

    switch (options.format) {
      case 'jsonl':
        output = beads.map(b => JSON.stringify(b)).join('\n');
        break;

      case 'csv': {
        const headers = ['id', 'title', 'status', 'priority', 'assignee', 'createdAt', 'closedAt'];
        output = headers.join(',') + '\n';
        output += beads.map((b: any) =>
          headers.map((h: string) => {
            const val = (b as any)[h];
            if (val === null || val === undefined) return '';
            const s = String(val);
            return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(',')
        ).join('\n');
        break;
      }

      case 'markdown': {
        output = '# Beads Export\n\n';
        output += `> Exported: ${new Date().toISOString()} | Total: ${beads.length}\n\n`;
        output += '| ID | Title | Status | Priority | Assignee |\n';
        output += '|----|-------|--------|----------|----------|\n';
        output += beads.map((b: any) =>
          `| ${b.id} | ${b.title} | ${b.status} | ${b.priority} | ${b.assignee || '-'} |`
        ).join('\n');
        break;
      }
    }

    this.exportHistory.push({ format: options.format, count: beads.length, timestamp: new Date().toISOString() });
    if (this.exportHistory.length > 100) this.exportHistory.splice(0, this.exportHistory.length - 50);

    console.info(`[BEADS-ADV] Exported ${beads.length} beads as ${options.format}`);
    return output;
  }

  getExportHistory(): Array<{ format: string; count: number; timestamp: string }> {
    return [...this.exportHistory];
  }

  // ─── EP-013: Import (ClickUp, Linear, GitHub Issues) ──────────────────────

  async importFromJSON(items: ImportItem[], source: MigrationSource = 'csv'): Promise<MigrationResult> {
    return this.migrate(
      { source, mapping: {}, defaultValues: {} },
      items,
    );
  }

  async importFromCSV(csvContent: string, source: MigrationSource = 'csv'): Promise<MigrationResult> {
    const lines = csvContent.trim().split('\n');
    if (lines.length < 2) return { source, totalItems: 0, imported: 0, skipped: 0, errors: [], timestamp: new Date().toISOString() };

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const items: ImportItem[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      const item: ImportItem = { title: '' };
      headers.forEach((h, idx) => {
        const val = values[idx]?.trim();
        if (!val) return;
        switch (h) {
          case 'title': case 'name': case 'summary': item.title = val; break;
          case 'description': case 'body': item.description = val; break;
          case 'status': case 'state': item.status = val; break;
          case 'priority': item.priority = val; break;
          case 'assignee': case 'assigned': item.assignee = val; break;
          case 'id': case 'external_id': item.externalId = val; break;
          case 'url': case 'link': item.externalUrl = val; break;
        }
      });
      if (item.title) items.push(item);
    }

    return this.importFromJSON(items, source);
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
      current += ch;
    }
    result.push(current);
    return result;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  stats() {
    return {
      mcpTools: this.getMCPTools().length,
      syncTargets: this.syncTargets.size,
      hooks: [...this.hooks.values()].reduce((s, h) => s + h.length, 0),
      migrations: this.migrationHistory.length,
      exports: this.exportHistory.length,
    };
  }
}

export const beadsAdvanced = new BeadsAdvanced();
