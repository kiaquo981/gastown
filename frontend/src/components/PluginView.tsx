'use client';

/**
 * PluginView -- Gas Town Plugin Management
 *
 * "Gas Town defines a plugin as coordinated or scheduled attention
 *  from an agent." Plugins run in patrol steps: compactor-dog,
 *  git-hygiene, github-sheriff, quality-review, session-hygiene,
 *  stuck-agent-dog, dolt-snapshots, dolt-archive, rebuild-gt.
 *
 * AYU DARK: bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680
 * border #2d363f, green #c2d94c, yellow #ffb454, red #f07178,
 * cyan #95e6cb, purple #d2a6ff. Font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ── Ayu Dark palette ────────────────────────────────────────────────────────
const C = {
  bg: '#0f1419',
  card: '#1a1f26',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

type PluginType = 'town-level' | 'rig-level';
type PluginStatus = 'enabled' | 'disabled' | 'errored';
type RunResult = 'success' | 'error' | 'skipped';
type RunTrigger = 'patrol' | 'manual' | 'schedule';

interface Plugin {
  id: string;
  name: string;
  description: string;
  type: PluginType;
  status: PluginStatus;
  category: string;
  lastRun: string | null;
  runCount: number;
  avgDurationMs: number;
  schedule?: string;
  config: Record<string, string>;
}

interface PluginRun {
  id: string;
  pluginId: string;
  pluginName: string;
  trigger: RunTrigger;
  timestamp: string;
  durationMs: number;
  result: RunResult;
  output?: string;
}

type TabId = 'installed' | 'log' | 'install' | 'config';

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '--';
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusColor(status: PluginStatus): string {
  if (status === 'enabled') return C.green;
  if (status === 'disabled') return C.muted;
  return C.red;
}

function resultColor(result: RunResult): string {
  if (result === 'success') return C.green;
  if (result === 'error') return C.red;
  return C.yellow;
}

function triggerColor(trigger: RunTrigger): string {
  if (trigger === 'patrol') return C.cyan;
  if (trigger === 'manual') return C.purple;
  return C.yellow;
}

// ── Mock Data ───────────────────────────────────────────────────────────────

const PLUGIN_CATALOG: Omit<Plugin, 'lastRun' | 'runCount' | 'avgDurationMs' | 'config'>[] = [
  { id: 'compactor-dog', name: 'Compactor Dog', description: 'Dolt compaction: shrinks the database by merging old commits and removing garbage.', type: 'town-level', status: 'enabled', category: 'maintenance' },
  { id: 'git-hygiene', name: 'Git Hygiene', description: 'Cleans up stale branches, prunes remote references, and enforces commit message conventions.', type: 'rig-level', status: 'enabled', category: 'code-quality' },
  { id: 'github-sheriff', name: 'GitHub Sheriff', description: 'Monitors PRs and issues, enforces review policies, auto-labels stale items.', type: 'town-level', status: 'enabled', category: 'code-quality' },
  { id: 'quality-review', name: 'Quality Review', description: 'Runs automated code quality checks: lint, type-check, test coverage thresholds.', type: 'rig-level', status: 'enabled', category: 'code-quality' },
  { id: 'session-hygiene', name: 'Session Hygiene', description: 'Cleans up dead sessions, archives old session data, frees resources.', type: 'town-level', status: 'enabled', category: 'maintenance' },
  { id: 'stuck-agent-dog', name: 'Stuck Agent Dog', description: 'Detects agents stuck in infinite loops or waiting too long, kills and restarts them.', type: 'town-level', status: 'enabled', category: 'monitoring' },
  { id: 'dolt-snapshots', name: 'Dolt Snapshots', description: 'Creates periodic state snapshots of the Dolt database for point-in-time recovery.', type: 'town-level', status: 'disabled', category: 'backup' },
  { id: 'dolt-archive', name: 'Dolt Archive', description: 'Archives old data beyond retention window to cold storage, keeping the DB lean.', type: 'town-level', status: 'disabled', category: 'backup' },
  { id: 'rebuild-gt', name: 'Rebuild GT', description: 'Recompiles the gt binary from source when configuration or plugins change.', type: 'town-level', status: 'enabled', category: 'maintenance' },
];

function generateMockPlugins(): Plugin[] {
  const now = Date.now();
  return PLUGIN_CATALOG.map((p, i) => ({
    ...p,
    lastRun: p.status === 'enabled' ? new Date(now - i * 1_200_000).toISOString() : null,
    runCount: p.status === 'enabled' ? 20 + Math.floor(Math.random() * 200) : 0,
    avgDurationMs: 500 + Math.floor(Math.random() * 8000),
    config: {},
  }));
}

function generateMockRuns(): PluginRun[] {
  const now = Date.now();
  const plugins = PLUGIN_CATALOG.filter(p => p.status === 'enabled');
  return Array.from({ length: 24 }, (_, i) => {
    const plugin = plugins[i % plugins.length];
    const success = Math.random() > 0.15;
    return {
      id: `run-${i}`,
      pluginId: plugin.id,
      pluginName: plugin.name,
      trigger: (['patrol', 'patrol', 'patrol', 'manual', 'schedule'] as RunTrigger[])[i % 5],
      timestamp: new Date(now - i * 900_000).toISOString(),
      durationMs: 200 + Math.floor(Math.random() * 6000),
      result: success ? 'success' : (Math.random() > 0.5 ? 'error' : 'skipped') as RunResult,
      output: success
        ? `[${plugin.name}] Completed successfully. ${Math.floor(Math.random() * 20)} items processed.`
        : `[${plugin.name}] Error: ${['timeout after 30s', 'permission denied on .git/config', 'Dolt lock held by another process', 'rate limit exceeded'][i % 4]}`,
    };
  });
}

// ── Plugin Card Component ───────────────────────────────────────────────────

function PluginCard({
  plugin,
  onToggle,
  onRunNow,
  running,
}: {
  plugin: Plugin;
  onToggle: () => void;
  onRunNow: () => void;
  running: boolean;
}) {
  const sColor = statusColor(plugin.status);
  const typeColor = plugin.type === 'town-level' ? C.cyan : C.purple;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="border p-4"
      style={{ background: C.card, borderColor: C.border }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-bold" style={{ color: C.text }}>{plugin.name}</span>
            <motion.span
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5"
              style={{ color: sColor, background: `${sColor}15`, border: `1px solid ${sColor}30` }}
              animate={plugin.status === 'enabled' ? { opacity: [1, 0.6, 1] } : {}}
              transition={{ duration: 2, repeat: Infinity }}
            >
              {plugin.status}
            </motion.span>
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>{plugin.description}</div>
        </div>
      </div>

      {/* Type + Category Badges */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className="px-1.5 py-0.5 text-[9px] uppercase"
          style={{ color: typeColor, background: `${typeColor}15`, border: `1px solid ${typeColor}30` }}
        >
          {plugin.type}
        </span>
        <span
          className="px-1.5 py-0.5 text-[9px] uppercase"
          style={{ color: C.yellow, background: `${C.yellow}15`, border: `1px solid ${C.yellow}30` }}
        >
          {plugin.category}
        </span>
      </div>

      {/* Stats Row */}
      <div className="flex items-center gap-4 mb-3 text-[10px]">
        <div>
          <span style={{ color: C.muted }}>Last run: </span>
          <span style={{ color: C.text }}>{timeAgo(plugin.lastRun)}</span>
        </div>
        <div>
          <span style={{ color: C.muted }}>Runs: </span>
          <span style={{ color: C.cyan }}>{plugin.runCount}</span>
        </div>
        <div>
          <span style={{ color: C.muted }}>Avg: </span>
          <span style={{ color: C.purple }}>{formatMs(plugin.avgDurationMs)}</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onToggle}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
          style={{
            color: plugin.status === 'enabled' ? C.red : C.green,
            borderColor: `${plugin.status === 'enabled' ? C.red : C.green}40`,
            background: `${plugin.status === 'enabled' ? C.red : C.green}10`,
          }}
        >
          {plugin.status === 'enabled' ? 'Disable' : 'Enable'}
        </button>
        <button
          onClick={onRunNow}
          disabled={running || plugin.status !== 'enabled'}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-30"
          style={{ color: C.cyan, borderColor: `${C.border}`, background: 'transparent' }}
        >
          {running ? 'Running...' : 'Run Now'}
        </button>
      </div>
    </motion.div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function PluginView() {
  const [activeTab, setActiveTab] = useState<TabId>('installed');
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [runs, setRuns] = useState<PluginRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningPlugin, setRunningPlugin] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');

  // Install form
  const [installName, setInstallName] = useState('');
  const [installType, setInstallType] = useState<PluginType>('town-level');
  const [installScript, setInstallScript] = useState('');
  const [installing, setInstalling] = useState(false);

  // Config state
  const [selectedPluginConfig, setSelectedPluginConfig] = useState<string | null>(null);
  const [configKey, setConfigKey] = useState('');
  const [configValue, setConfigValue] = useState('');

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    // Try to load from backend, fall back to mock
    try {
      const res = await fetch(`${API}/api/meow/town/timeline`);
      if (res.ok) {
        // We have a live backend; use timeline events to enrich plugin data
      }
    } catch {
      // silent
    }

    if (plugins.length === 0) setPlugins(generateMockPlugins());
    if (runs.length === 0) setRuns(generateMockRuns());
    setLoading(false);
  }, [plugins.length, runs.length]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleToggle = useCallback((pluginId: string) => {
    setPlugins(prev => prev.map(p =>
      p.id === pluginId
        ? { ...p, status: (p.status === 'enabled' ? 'disabled' : 'enabled') as PluginStatus }
        : p
    ));
  }, []);

  const handleRunNow = useCallback(async (pluginId: string) => {
    setRunningPlugin(pluginId);
    // Simulate execution
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
    const plugin = plugins.find(p => p.id === pluginId);
    if (plugin) {
      const newRun: PluginRun = {
        id: `run-manual-${Date.now()}`,
        pluginId,
        pluginName: plugin.name,
        trigger: 'manual',
        timestamp: new Date().toISOString(),
        durationMs: 800 + Math.floor(Math.random() * 3000),
        result: Math.random() > 0.2 ? 'success' : 'error',
        output: `[${plugin.name}] Manual run completed. ${Math.floor(Math.random() * 15)} items processed.`,
      };
      setRuns(prev => [newRun, ...prev]);
      setPlugins(prev => prev.map(p =>
        p.id === pluginId
          ? { ...p, lastRun: newRun.timestamp, runCount: p.runCount + 1 }
          : p
      ));
    }
    setRunningPlugin(null);
  }, [plugins]);

  const handleInstall = useCallback(async () => {
    if (!installName.trim() || !installScript.trim()) return;
    setInstalling(true);
    await new Promise(r => setTimeout(r, 1000));
    const newPlugin: Plugin = {
      id: installName.toLowerCase().replace(/\s+/g, '-'),
      name: installName.trim(),
      description: `Custom plugin: ${installScript.trim()}`,
      type: installType,
      status: 'disabled',
      category: 'custom',
      lastRun: null,
      runCount: 0,
      avgDurationMs: 0,
      config: {},
    };
    setPlugins(prev => [...prev, newPlugin]);
    setInstallName('');
    setInstallScript('');
    setInstalling(false);
  }, [installName, installType, installScript]);

  const handleSaveConfig = useCallback((pluginId: string) => {
    if (!configKey.trim()) return;
    setPlugins(prev => prev.map(p =>
      p.id === pluginId
        ? { ...p, config: { ...p.config, [configKey]: configValue } }
        : p
    ));
    setConfigKey('');
    setConfigValue('');
  }, [configKey, configValue]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const categories = useMemo(() => {
    const cats = new Set(plugins.map(p => p.category));
    return ['all', ...Array.from(cats)];
  }, [plugins]);

  const filteredPlugins = useMemo(() => {
    if (filterCategory === 'all') return plugins;
    return plugins.filter(p => p.category === filterCategory);
  }, [plugins, filterCategory]);

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: 'installed', label: 'Installed', count: plugins.length },
    { id: 'log', label: 'Execution Log', count: runs.length },
    { id: 'install', label: 'Install', count: 0 },
    { id: 'config', label: 'Config', count: 0 },
  ];

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: C.bg, color: C.muted }}>
        <div className="text-sm animate-pulse">Loading plugin registry...</div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col font-mono" style={{ background: C.bg, color: C.text }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-4">
          <h1 className="text-sm uppercase tracking-widest" style={{ color: C.text }}>
            Plugin Registry
          </h1>
          <span
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: `${C.green}15`, color: C.green, border: `1px solid ${C.green}30` }}
          >
            {plugins.filter(p => p.status === 'enabled').length} active
          </span>
          <span
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: `${C.muted}15`, color: C.muted, border: `1px solid ${C.muted}30` }}
          >
            {plugins.filter(p => p.status === 'disabled').length} disabled
          </span>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1 text-[10px] transition-colors hover:opacity-80"
          style={{ background: C.border, color: C.muted, border: `1px solid ${C.border}` }}
        >
          Refresh
        </button>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center gap-1 px-6 py-2 border-b shrink-0" style={{ borderColor: C.border }}>
        {tabs.map(tab => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider transition-all"
              style={{
                background: active ? `${C.purple}15` : 'transparent',
                color: active ? C.purple : C.muted,
                border: `1px solid ${active ? `${C.purple}40` : 'transparent'}`,
              }}
            >
              {tab.label}
              {tab.count > 0 && <span className="ml-1.5 text-[9px]" style={{ opacity: 0.6 }}>({tab.count})</span>}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1400px] mx-auto">
          <AnimatePresence mode="wait">

            {/* ═══════════ Installed Plugins ═══════════ */}
            {activeTab === 'installed' && (
              <motion.div
                key="installed"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                {/* Category Filter */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase" style={{ color: C.muted }}>Filter:</span>
                  {categories.map(cat => (
                    <button
                      key={cat}
                      onClick={() => setFilterCategory(cat)}
                      className="px-2 py-1 text-[10px] uppercase tracking-wider transition-all"
                      style={{
                        background: filterCategory === cat ? `${C.yellow}15` : 'transparent',
                        color: filterCategory === cat ? C.yellow : C.muted,
                        border: `1px solid ${filterCategory === cat ? `${C.yellow}40` : 'transparent'}`,
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                {/* Plugin Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredPlugins.map(plugin => (
                    <PluginCard
                      key={plugin.id}
                      plugin={plugin}
                      onToggle={() => handleToggle(plugin.id)}
                      onRunNow={() => handleRunNow(plugin.id)}
                      running={runningPlugin === plugin.id}
                    />
                  ))}
                </div>
              </motion.div>
            )}

            {/* ═══════════ Execution Log ═══════════ */}
            {activeTab === 'log' && (
              <motion.div
                key="log"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-2"
              >
                <div className="text-[11px] mb-3" style={{ color: C.muted }}>
                  Recent plugin executions. Click to expand output.
                </div>

                {/* Log Header */}
                <div
                  className="grid grid-cols-[200px_100px_80px_80px_1fr_120px] gap-2 px-4 py-2 text-[10px] uppercase"
                  style={{ background: C.card, color: C.muted, border: `1px solid ${C.border}` }}
                >
                  <span>Plugin</span>
                  <span>Trigger</span>
                  <span>Result</span>
                  <span>Duration</span>
                  <span>Output</span>
                  <span>Timestamp</span>
                </div>

                <div className="max-h-[600px] overflow-y-auto space-y-1">
                  {runs.map((run, idx) => {
                    const isExpanded = expandedRun === run.id;
                    return (
                      <motion.div
                        key={run.id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.02 }}
                      >
                        <button
                          className="w-full text-left grid grid-cols-[200px_100px_80px_80px_1fr_120px] gap-2 px-4 py-2.5 transition-colors"
                          style={{
                            background: isExpanded ? `${C.border}40` : C.card,
                            border: `1px solid ${C.border}`,
                          }}
                          onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                        >
                          <span className="text-[11px] truncate" style={{ color: C.text }}>{run.pluginName}</span>
                          <span
                            className="text-[10px] px-1.5 py-0.5 self-center w-fit"
                            style={{ color: triggerColor(run.trigger), background: `${triggerColor(run.trigger)}15`, border: `1px solid ${triggerColor(run.trigger)}30` }}
                          >
                            {run.trigger}
                          </span>
                          <span
                            className="text-[10px] px-1.5 py-0.5 self-center w-fit uppercase"
                            style={{ color: resultColor(run.result), background: `${resultColor(run.result)}15`, border: `1px solid ${resultColor(run.result)}30` }}
                          >
                            {run.result}
                          </span>
                          <span className="text-[10px]" style={{ color: C.purple }}>{formatMs(run.durationMs)}</span>
                          <span className="text-[10px] truncate" style={{ color: C.muted }}>{run.output || '--'}</span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(run.timestamp)}</span>
                        </button>

                        <AnimatePresence>
                          {isExpanded && run.output && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <pre
                                className="px-4 py-3 text-[10px] whitespace-pre-wrap"
                                style={{ background: C.bg, color: C.cyan, border: `1px solid ${C.border}`, borderTop: 'none' }}
                              >
                                {run.output}
                              </pre>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* ═══════════ Install Plugin ═══════════ */}
            {activeTab === 'install' && (
              <motion.div
                key="install"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="border p-6" style={{ background: C.card, borderColor: C.border }}>
                  <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: C.text }}>
                    Install New Plugin
                  </h2>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: C.muted }}>Plugin Name</label>
                      <input
                        type="text"
                        value={installName}
                        onChange={e => setInstallName(e.target.value)}
                        placeholder="e.g. my-custom-plugin"
                        className="w-full px-3 py-2 text-xs rounded-none focus:outline-none"
                        style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: C.muted }}>Type</label>
                      <div className="flex items-center gap-3">
                        {(['town-level', 'rig-level'] as PluginType[]).map(type => (
                          <button
                            key={type}
                            onClick={() => setInstallType(type)}
                            className="px-3 py-1.5 text-[10px] uppercase tracking-wider transition-all"
                            style={{
                              background: installType === type ? `${C.cyan}15` : 'transparent',
                              color: installType === type ? C.cyan : C.muted,
                              border: `1px solid ${installType === type ? `${C.cyan}40` : C.border}`,
                            }}
                          >
                            {type}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: C.muted }}>Script Path / URL</label>
                      <input
                        type="text"
                        value={installScript}
                        onChange={e => setInstallScript(e.target.value)}
                        placeholder="e.g. ./plugins/my-plugin.sh or https://..."
                        className="w-full px-3 py-2 text-xs rounded-none focus:outline-none"
                        style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </div>
                    <button
                      onClick={handleInstall}
                      disabled={installing || !installName.trim() || !installScript.trim()}
                      className="px-5 py-2.5 text-xs uppercase tracking-wider border transition-colors disabled:opacity-30"
                      style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                    >
                      {installing ? 'Installing...' : 'Install Plugin'}
                    </button>
                  </div>
                </div>

                {/* Known Plugin Categories Description */}
                <div className="border p-6" style={{ background: C.card, borderColor: C.border }}>
                  <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: C.text }}>
                    Plugin Categories (from Yegge&apos;s repo)
                  </h2>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                    {[
                      { cat: 'maintenance', desc: 'compactor-dog, session-hygiene, rebuild-gt -- keep the system healthy and lean.' },
                      { cat: 'code-quality', desc: 'git-hygiene, github-sheriff, quality-review -- enforce standards and catch issues.' },
                      { cat: 'monitoring', desc: 'stuck-agent-dog -- detect and recover from stuck states.' },
                      { cat: 'backup', desc: 'dolt-snapshots, dolt-archive -- point-in-time recovery and cold storage.' },
                      { cat: 'custom', desc: 'User-installed plugins. Any script or URL that follows the plugin interface.' },
                    ].map(item => (
                      <div key={item.cat} className="p-3 border" style={{ borderColor: C.border, background: C.bg }}>
                        <div className="text-[10px] uppercase font-bold mb-1" style={{ color: C.yellow }}>{item.cat}</div>
                        <div className="text-[10px]" style={{ color: C.muted }}>{item.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Plugin Config ═══════════ */}
            {activeTab === 'config' && (
              <motion.div
                key="config"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                <div className="text-[11px] mb-2" style={{ color: C.muted }}>
                  Per-plugin configuration and schedule settings.
                </div>

                {/* Plugin selector */}
                <div className="flex flex-wrap gap-2">
                  {plugins.map(plugin => (
                    <button
                      key={plugin.id}
                      onClick={() => setSelectedPluginConfig(plugin.id === selectedPluginConfig ? null : plugin.id)}
                      className="px-3 py-1.5 text-[10px] uppercase tracking-wider transition-all"
                      style={{
                        background: selectedPluginConfig === plugin.id ? `${C.purple}15` : 'transparent',
                        color: selectedPluginConfig === plugin.id ? C.purple : C.muted,
                        border: `1px solid ${selectedPluginConfig === plugin.id ? `${C.purple}40` : C.border}`,
                      }}
                    >
                      {plugin.name}
                    </button>
                  ))}
                </div>

                {/* Config Editor */}
                {selectedPluginConfig && (() => {
                  const plugin = plugins.find(p => p.id === selectedPluginConfig);
                  if (!plugin) return null;
                  return (
                    <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                      <div className="flex items-center gap-3 mb-4">
                        <span className="text-xs font-bold" style={{ color: C.text }}>{plugin.name}</span>
                        <span className="text-[10px]" style={{ color: statusColor(plugin.status) }}>{plugin.status}</span>
                      </div>

                      {/* Existing config entries */}
                      {Object.keys(plugin.config).length > 0 && (
                        <div className="mb-4">
                          <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Current Config</div>
                          {Object.entries(plugin.config).map(([k, v]) => (
                            <div key={k} className="flex items-center gap-3 py-1 px-2" style={{ background: C.bg }}>
                              <span className="text-[10px]" style={{ color: C.cyan }}>{k}</span>
                              <span className="text-[10px]" style={{ color: C.muted }}>=</span>
                              <span className="text-[10px]" style={{ color: C.text }}>{v}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add config */}
                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          value={configKey}
                          onChange={e => setConfigKey(e.target.value)}
                          placeholder="Key"
                          className="w-40 px-3 py-2 text-xs rounded-none focus:outline-none"
                          style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                        />
                        <input
                          type="text"
                          value={configValue}
                          onChange={e => setConfigValue(e.target.value)}
                          placeholder="Value"
                          className="flex-1 px-3 py-2 text-xs rounded-none focus:outline-none"
                          style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                        />
                        <button
                          onClick={() => handleSaveConfig(selectedPluginConfig)}
                          disabled={!configKey.trim()}
                          className="px-4 py-2 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-30"
                          style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                        >
                          Set
                        </button>
                      </div>

                      {/* Schedule */}
                      <div className="mt-4 pt-4 border-t" style={{ borderColor: C.border }}>
                        <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Schedule</div>
                        <div className="text-[10px]" style={{ color: C.text }}>
                          {plugin.schedule || 'Runs on patrol step (default)'}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
