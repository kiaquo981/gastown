/**
 * Convoy Advanced — EP-069→073
 * Notifications, API helpers, Templates, Merge Strategy, History
 */

import { mayor } from './workers/mayor';
import { mailRouter } from './mail';

/* ---------- Types ---------- */
interface ConvoyTemplate {
  id: string;
  name: string;
  description: string;
  defaultRig?: string;
  mergeStrategy: 'direct' | 'mr' | 'local';
  beadPattern?: string;
  tags: string[];
  createdAt: string;
}

interface ConvoyHistoryEntry {
  id: string;
  convoyId: string;
  event: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface ConvoyNotificationHandler {
  (event: string, convoyId: string, data?: Record<string, unknown>): void;
}

interface MergeStrategyConfig {
  strategy: 'direct' | 'mr' | 'local';
  autoRebase: boolean;
  requireApproval: boolean;
  targetBranch: string;
  deleteSourceAfterMerge: boolean;
}

/* ---------- Convoy Manager ---------- */
class ConvoyManager {
  private templates = new Map<string, ConvoyTemplate>();
  private history = new Map<string, ConvoyHistoryEntry[]>(); // convoyId → entries
  private mergeConfigs = new Map<string, MergeStrategyConfig>(); // convoyId → config
  private handlers: ConvoyNotificationHandler[] = [];
  private allHistory: ConvoyHistoryEntry[] = [];

  // ─── EP-069: Notifications ───────────────────────────────────────────────

  onConvoyEvent(handler: ConvoyNotificationHandler): void {
    this.handlers.push(handler);
  }

  offConvoyEvent(handler: ConvoyNotificationHandler): void {
    this.handlers = this.handlers.filter(h => h !== handler);
  }

  private notify(event: string, convoyId: string, data?: Record<string, unknown>): void {
    this.handlers.forEach(h => {
      try { h(event, convoyId, data); } catch { /* silent */ }
    });
    // Also send mail notification
    mailRouter.send({
      from: 'convoy-manager',
      to: 'mayor',
      priority: event.includes('fail') || event.includes('conflict') ? 'high' : 'normal',
      type: 'notification',
      delivery: 'direct',
      subject: `Convoy ${event}`,
      body: `Convoy ${convoyId}: ${event}`,
      metadata: data,
    });
    this.recordHistory(convoyId, event, data);
  }

  notifyCreated(convoyId: string, name: string): void {
    this.notify('convoy:created', convoyId, { name });
  }

  notifyDispatched(convoyId: string): void {
    this.notify('convoy:dispatched', convoyId);
  }

  notifyDelivered(convoyId: string): void {
    this.notify('convoy:delivered', convoyId);
  }

  notifyFailed(convoyId: string, error: string): void {
    this.notify('convoy:failed', convoyId, { error });
  }

  // ─── EP-070: API Helpers ─────────────────────────────────────────────────

  getConvoyDetail(convoyId: string) {
    const convoy = mayor.getConvoy(convoyId);
    if (!convoy) return null;
    return {
      ...convoy,
      history: this.getHistory(convoyId),
      mergeConfig: this.mergeConfigs.get(convoyId) || null,
    };
  }

  listConvoysEnriched() {
    const convoys = mayor.listConvoys();
    return convoys.map((c: any) => ({
      ...c,
      historyCount: (this.history.get(c.id) || []).length,
      mergeStrategy: this.mergeConfigs.get(c.id)?.strategy || 'direct',
    }));
  }

  // ─── EP-071: Templates ───────────────────────────────────────────────────

  registerTemplate(name: string, description: string, opts: Partial<ConvoyTemplate> = {}): ConvoyTemplate {
    const id = `ct-${Date.now().toString(36)}`;
    const template: ConvoyTemplate = {
      id,
      name,
      description,
      defaultRig: opts.defaultRig,
      mergeStrategy: opts.mergeStrategy || 'direct',
      beadPattern: opts.beadPattern,
      tags: opts.tags || [],
      createdAt: new Date().toISOString(),
    };
    this.templates.set(id, template);
    console.info(`[CONVOY] Template registered: ${name} (${id})`);
    return template;
  }

  getTemplate(id: string): ConvoyTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(): ConvoyTemplate[] {
    return [...this.templates.values()];
  }

  createFromTemplate(templateId: string, beadIds: string[], overrides?: { name?: string; rig?: string }): any {
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);
    const name = overrides?.name || `${template.name}-${Date.now().toString(36)}`;
    const rig = overrides?.rig || template.defaultRig || 'default';
    const convoy = mayor.createConvoy(name, beadIds, rig);
    if (convoy) {
      this.setMergeStrategy(convoy.id, { strategy: template.mergeStrategy, autoRebase: true, requireApproval: false, targetBranch: 'main', deleteSourceAfterMerge: true });
      this.notifyCreated(convoy.id, name);
    }
    return convoy;
  }

  // ─── EP-072: Merge Strategy ──────────────────────────────────────────────

  setMergeStrategy(convoyId: string, config: MergeStrategyConfig): void {
    this.mergeConfigs.set(convoyId, config);
    this.recordHistory(convoyId, 'merge-strategy:set', { strategy: config.strategy });
  }

  getMergeStrategy(convoyId: string): MergeStrategyConfig | null {
    return this.mergeConfigs.get(convoyId) || null;
  }

  getDefaultMergeStrategy(): MergeStrategyConfig {
    return { strategy: 'mr', autoRebase: true, requireApproval: true, targetBranch: 'main', deleteSourceAfterMerge: true };
  }

  // ─── EP-073: History ─────────────────────────────────────────────────────

  recordHistory(convoyId: string, event: string, data?: Record<string, unknown>): void {
    const entry: ConvoyHistoryEntry = {
      id: `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      convoyId,
      event,
      data,
      timestamp: new Date().toISOString(),
    };
    if (!this.history.has(convoyId)) this.history.set(convoyId, []);
    const entries = this.history.get(convoyId)!;
    entries.push(entry);
    if (entries.length > 500) entries.splice(0, entries.length - 500);

    this.allHistory.push(entry);
    if (this.allHistory.length > 2000) this.allHistory.splice(0, this.allHistory.length - 1000);
  }

  getHistory(convoyId: string): ConvoyHistoryEntry[] {
    return this.history.get(convoyId) || [];
  }

  getRecentHistory(limit = 50): ConvoyHistoryEntry[] {
    return this.allHistory.slice(-limit).reverse();
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  stats() {
    return {
      templates: this.templates.size,
      trackedConvoys: this.history.size,
      mergeConfigs: this.mergeConfigs.size,
      totalHistoryEntries: this.allHistory.length,
      handlers: this.handlers.length,
    };
  }
}

export const convoyManager = new ConvoyManager();
