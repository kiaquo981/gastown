'use client';

/**
 * QuotaView -- API Quota Management & Key Rotation
 *
 * `gt quota` -- "Gas Town is expensive as hell." Tracks API usage,
 * cost per agent/convoy/rig, rate limit events, and manages key
 * rotation strategies across providers.
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

type ProviderName = 'claude' | 'codex' | 'gemini' | 'openai' | 'openrouter';
type KeyStatus = 'active' | 'rate-limited' | 'expired' | 'cooldown';
type RotationStrategy = 'round-robin' | 'least-used' | 'random';
type TabId = 'dashboard' | 'keys' | 'rate-limits' | 'costs' | 'rotation';

interface ProviderUsage {
  provider: ProviderName;
  callsToday: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  dailyTrend: number[];
}

interface ApiKey {
  id: string;
  provider: ProviderName;
  email: string;
  keyMasked: string;
  status: KeyStatus;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  lastUsed: string;
}

interface RateLimitEvent {
  id: string;
  provider: ProviderName;
  timestamp: string;
  retryAfterMs: number;
  recovered: boolean;
  keyId: string;
}

interface AgentCost {
  agentName: string;
  provider: ProviderName;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  callCount: number;
}

interface RotationConfig {
  autoRotateOnLimit: boolean;
  strategy: RotationStrategy;
  cooldownMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
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

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function usageColor(pct: number): string {
  if (pct < 50) return C.green;
  if (pct < 80) return C.yellow;
  return C.red;
}

function keyStatusColor(status: KeyStatus): string {
  if (status === 'active') return C.green;
  if (status === 'rate-limited') return C.red;
  if (status === 'expired') return C.muted;
  return C.yellow;
}

const PROVIDER_COLORS: Record<ProviderName, string> = {
  claude: C.purple,
  codex: C.cyan,
  gemini: C.yellow,
  openai: C.green,
  openrouter: '#e06c75',
};

// ── Sparkline SVG ───────────────────────────────────────────────────────────

function Sparkline({ values, width = 120, height = 28, color }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  const c = color || C.cyan;

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline points={points} fill="none" stroke={c} strokeWidth={1.5} opacity={0.8} />
    </svg>
  );
}

// ── Usage Bar ───────────────────────────────────────────────────────────────

function UsageBar({ used, limit, label }: { used: number; limit: number; label?: string }) {
  const pct = Math.min(Math.round((used / limit) * 100), 100);
  const color = usageColor(pct);

  return (
    <div className="w-full">
      {label && <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: C.muted }}>{label}</div>}
      <div className="h-2 rounded-none" style={{ background: C.border }}>
        <motion.div
          className="h-full rounded-none"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
      <div className="flex justify-between text-[9px] mt-0.5">
        <span style={{ color }}>{pct}%</span>
        <span style={{ color: C.muted }}>{formatTokens(used)} / {formatTokens(limit)}</span>
      </div>
    </div>
  );
}

// ── Mock Data ───────────────────────────────────────────────────────────────

function generateMockProviderUsage(): ProviderUsage[] {
  return [
    { provider: 'claude', callsToday: 342, tokensIn: 1_850_000, tokensOut: 620_000, costUsd: 28.40, dailyTrend: [18, 22, 26, 24, 30, 28, 28] },
    { provider: 'gemini', callsToday: 580, tokensIn: 2_100_000, tokensOut: 890_000, costUsd: 4.20, dailyTrend: [3, 3.5, 4, 3.8, 4.5, 4.1, 4.2] },
    { provider: 'codex', callsToday: 128, tokensIn: 420_000, tokensOut: 310_000, costUsd: 12.80, dailyTrend: [8, 10, 11, 13, 12, 14, 13] },
    { provider: 'openai', callsToday: 95, tokensIn: 380_000, tokensOut: 150_000, costUsd: 3.60, dailyTrend: [2, 3, 2.5, 3, 4, 3.5, 3.6] },
    { provider: 'openrouter', callsToday: 64, tokensIn: 210_000, tokensOut: 85_000, costUsd: 1.90, dailyTrend: [1, 1.5, 2, 1.8, 2.2, 1.9, 1.9] },
  ];
}

function generateMockApiKeys(): ApiKey[] {
  const now = Date.now();
  return [
    { id: 'key-1', provider: 'claude', email: 'team@gastown.dev', keyMasked: 'sk-ant-...3f8a', status: 'active', dailyLimit: 500, usedToday: 342, remaining: 158, lastUsed: new Date(now - 120_000).toISOString() },
    { id: 'key-2', provider: 'claude', email: 'backup@gastown.dev', keyMasked: 'sk-ant-...9c2b', status: 'cooldown', dailyLimit: 500, usedToday: 0, remaining: 500, lastUsed: new Date(now - 3_600_000).toISOString() },
    { id: 'key-3', provider: 'gemini', email: 'ai@gastown.dev', keyMasked: 'AIza...zA0', status: 'active', dailyLimit: 1000, usedToday: 580, remaining: 420, lastUsed: new Date(now - 60_000).toISOString() },
    { id: 'key-4', provider: 'codex', email: 'codex@gastown.dev', keyMasked: 'sk-co-...7d4e', status: 'active', dailyLimit: 300, usedToday: 128, remaining: 172, lastUsed: new Date(now - 240_000).toISOString() },
    { id: 'key-5', provider: 'openai', email: 'ops@gastown.dev', keyMasked: 'sk-proj-...1f9a', status: 'active', dailyLimit: 200, usedToday: 95, remaining: 105, lastUsed: new Date(now - 180_000).toISOString() },
    { id: 'key-6', provider: 'openrouter', email: 'router@gastown.dev', keyMasked: 'sk-or-...8b3c', status: 'rate-limited', dailyLimit: 200, usedToday: 200, remaining: 0, lastUsed: new Date(now - 30_000).toISOString() },
    { id: 'key-7', provider: 'openai', email: 'old@gastown.dev', keyMasked: 'sk-proj-...0x2d', status: 'expired', dailyLimit: 200, usedToday: 0, remaining: 0, lastUsed: new Date(now - 86_400_000 * 7).toISOString() },
  ];
}

function generateMockRateLimits(): RateLimitEvent[] {
  const now = Date.now();
  return Array.from({ length: 12 }, (_, i) => ({
    id: `rl-${i}`,
    provider: (['claude', 'claude', 'openrouter', 'claude', 'gemini', 'codex'] as ProviderName[])[i % 6],
    timestamp: new Date(now - i * 900_000).toISOString(),
    retryAfterMs: [15000, 30000, 60000, 15000, 45000, 30000][i % 6],
    recovered: i > 1,
    keyId: `key-${(i % 4) + 1}`,
  }));
}

function generateMockAgentCosts(): AgentCost[] {
  return [
    { agentName: 'polecat-alpha', provider: 'claude', tokensIn: 420_000, tokensOut: 180_000, costUsd: 8.20, callCount: 85 },
    { agentName: 'polecat-bravo', provider: 'claude', tokensIn: 380_000, tokensOut: 120_000, costUsd: 6.40, callCount: 72 },
    { agentName: 'deacon', provider: 'gemini', tokensIn: 620_000, tokensOut: 280_000, costUsd: 1.80, callCount: 140 },
    { agentName: 'witness', provider: 'gemini', tokensIn: 480_000, tokensOut: 210_000, costUsd: 1.20, callCount: 110 },
    { agentName: 'refinery-agent', provider: 'codex', tokensIn: 210_000, tokensOut: 160_000, costUsd: 6.40, callCount: 64 },
    { agentName: 'mayor', provider: 'claude', tokensIn: 520_000, tokensOut: 180_000, costUsd: 9.60, callCount: 98 },
    { agentName: 'sheriff', provider: 'codex', tokensIn: 110_000, tokensOut: 80_000, costUsd: 3.20, callCount: 38 },
    { agentName: 'scout', provider: 'gemini', tokensIn: 340_000, tokensOut: 120_000, costUsd: 0.80, callCount: 80 },
  ];
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function QuotaView() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [providers, setProviders] = useState<ProviderUsage[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [rateLimits, setRateLimits] = useState<RateLimitEvent[]>([]);
  const [agentCosts, setAgentCosts] = useState<AgentCost[]>([]);
  const [rotationConfig, setRotationConfig] = useState<RotationConfig>({
    autoRotateOnLimit: true,
    strategy: 'round-robin',
    cooldownMs: 30_000,
  });
  const [loading, setLoading] = useState(true);

  // Add account form
  const [newProvider, setNewProvider] = useState<ProviderName>('claude');
  const [newEmail, setNewEmail] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [addingKey, setAddingKey] = useState(false);

  // Budget alert
  const [budgetThreshold, setBudgetThreshold] = useState(50);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    // Try to get real stats
    try {
      const res = await fetch(`${API}/api/maestro/sessions/stats`);
      if (res.ok) {
        // Enrich with real data
      }
    } catch {
      // silent
    }

    if (providers.length === 0) setProviders(generateMockProviderUsage());
    if (apiKeys.length === 0) setApiKeys(generateMockApiKeys());
    if (rateLimits.length === 0) setRateLimits(generateMockRateLimits());
    if (agentCosts.length === 0) setAgentCosts(generateMockAgentCosts());
    setLoading(false);
  }, [providers.length, apiKeys.length, rateLimits.length, agentCosts.length]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const totalCallsToday = useMemo(() => providers.reduce((s, p) => s + p.callsToday, 0), [providers]);
  const totalTokensToday = useMemo(() => providers.reduce((s, p) => s + p.tokensIn + p.tokensOut, 0), [providers]);
  const totalCostToday = useMemo(() => providers.reduce((s, p) => s + p.costUsd, 0), [providers]);
  const overBudget = totalCostToday > budgetThreshold;

  // Rate limit pattern detection
  const rateLimitPattern = useMemo(() => {
    const claudeEvents = rateLimits.filter(e => e.provider === 'claude');
    if (claudeEvents.length >= 3) {
      const intervals = [];
      for (let i = 1; i < claudeEvents.length; i++) {
        const diff = new Date(claudeEvents[i - 1].timestamp).getTime() - new Date(claudeEvents[i].timestamp).getTime();
        intervals.push(diff);
      }
      const avg = intervals.reduce((s, d) => s + d, 0) / intervals.length;
      if (avg < 3_600_000) {
        return `You are hitting Claude rate limits every ~${Math.round(avg / 60_000)}min`;
      }
    }
    return null;
  }, [rateLimits]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleRotateKey = useCallback((keyId: string) => {
    setApiKeys(prev => prev.map(k =>
      k.id === keyId ? { ...k, status: 'cooldown' as KeyStatus } : k
    ));
    // Simulate activating next key for same provider
    const key = apiKeys.find(k => k.id === keyId);
    if (key) {
      setApiKeys(prev => {
        const sameProvider = prev.filter(k => k.provider === key.provider && k.id !== keyId);
        if (sameProvider.length > 0) {
          const next = sameProvider.find(k => k.status !== 'expired') || sameProvider[0];
          return prev.map(k => k.id === next.id ? { ...k, status: 'active' as KeyStatus } : k);
        }
        return prev;
      });
    }
  }, [apiKeys]);

  const handleAddKey = useCallback(async () => {
    if (!newEmail.trim() || !newApiKey.trim()) return;
    setAddingKey(true);
    await new Promise(r => setTimeout(r, 600));
    const newKeyObj: ApiKey = {
      id: `key-${Date.now()}`,
      provider: newProvider,
      email: newEmail.trim(),
      keyMasked: newApiKey.slice(0, 6) + '...' + newApiKey.slice(-4),
      status: 'active',
      dailyLimit: 500,
      usedToday: 0,
      remaining: 500,
      lastUsed: new Date().toISOString(),
    };
    setApiKeys(prev => [...prev, newKeyObj]);
    setNewEmail('');
    setNewApiKey('');
    setAddingKey(false);
  }, [newProvider, newEmail, newApiKey]);

  // ── Tab Config ────────────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'keys', label: 'API Keys' },
    { id: 'rate-limits', label: 'Rate Limits' },
    { id: 'costs', label: 'Cost Tracking' },
    { id: 'rotation', label: 'Key Rotation' },
  ];

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: C.bg, color: C.muted }}>
        <div className="text-sm animate-pulse">Loading quota data...</div>
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
            Quota Manager
          </h1>
          <span
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: `${C.yellow}15`, color: C.yellow, border: `1px solid ${C.yellow}30` }}
          >
            gas town is expensive as hell
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px]" style={{ color: overBudget ? C.red : C.green }}>
            {overBudget ? 'OVER BUDGET' : 'Within Budget'}
          </span>
          <button
            onClick={fetchData}
            className="px-3 py-1 text-[10px] transition-colors hover:opacity-80"
            style={{ background: C.border, color: C.muted, border: `1px solid ${C.border}` }}
          >
            Refresh
          </button>
        </div>
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
                background: active ? `${C.yellow}15` : 'transparent',
                color: active ? C.yellow : C.muted,
                border: `1px solid ${active ? `${C.yellow}40` : 'transparent'}`,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1400px] mx-auto">
          <AnimatePresence mode="wait">

            {/* ═══════════ Dashboard ═══════════ */}
            {activeTab === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Top KPIs */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>API Calls Today</div>
                    <div className="text-2xl font-bold" style={{ color: C.cyan }}>{totalCallsToday.toLocaleString()}</div>
                  </div>
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Tokens Consumed</div>
                    <div className="text-2xl font-bold" style={{ color: C.purple }}>{formatTokens(totalTokensToday)}</div>
                  </div>
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Estimated Cost</div>
                    <div className="text-2xl font-bold" style={{ color: overBudget ? C.red : C.green }}>
                      {formatUsd(totalCostToday)}
                    </div>
                    <div className="mt-2">
                      <UsageBar used={totalCostToday} limit={budgetThreshold} />
                    </div>
                  </div>
                </div>

                {/* Per-Provider Breakdown */}
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>Per-Provider Breakdown</h2>
                    <div className="flex-1 h-px" style={{ background: C.border }} />
                  </div>
                  <div className="space-y-3">
                    {providers.map((prov, idx) => {
                      const provColor = PROVIDER_COLORS[prov.provider];
                      return (
                        <motion.div
                          key={prov.provider}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="border px-5 py-4 flex items-center gap-6"
                          style={{ background: C.card, borderColor: C.border }}
                        >
                          <div className="w-24">
                            <span
                              className="text-[11px] font-bold uppercase"
                              style={{ color: provColor }}
                            >
                              {prov.provider}
                            </span>
                          </div>
                          <div className="w-20">
                            <div className="text-[9px] uppercase" style={{ color: C.muted }}>Calls</div>
                            <div className="text-sm font-bold" style={{ color: C.text }}>{prov.callsToday}</div>
                          </div>
                          <div className="w-24">
                            <div className="text-[9px] uppercase" style={{ color: C.muted }}>Tokens</div>
                            <div className="text-[11px]" style={{ color: C.text }}>
                              {formatTokens(prov.tokensIn)} in / {formatTokens(prov.tokensOut)} out
                            </div>
                          </div>
                          <div className="w-20">
                            <div className="text-[9px] uppercase" style={{ color: C.muted }}>Cost</div>
                            <div className="text-sm font-bold" style={{ color: provColor }}>{formatUsd(prov.costUsd)}</div>
                          </div>
                          <div className="flex-1">
                            <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>7-Day Trend</div>
                            <Sparkline values={prov.dailyTrend} width={140} height={24} color={provColor} />
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ API Keys ═══════════ */}
            {activeTab === 'keys' && (
              <motion.div
                key="keys"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Keys Table */}
                <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                  <div
                    className="grid grid-cols-[100px_160px_120px_80px_1fr_80px_100px_80px] gap-2 px-4 py-2 text-[10px] uppercase"
                    style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                  >
                    <span>Provider</span>
                    <span>Email</span>
                    <span>Key</span>
                    <span>Status</span>
                    <span>Usage</span>
                    <span>Remaining</span>
                    <span>Last Used</span>
                    <span></span>
                  </div>
                  <div className="max-h-[400px] overflow-y-auto">
                    {apiKeys.map((key, idx) => {
                      const sColor = keyStatusColor(key.status);
                      const provColor = PROVIDER_COLORS[key.provider];
                      const usePct = key.dailyLimit > 0 ? Math.round((key.usedToday / key.dailyLimit) * 100) : 0;
                      return (
                        <motion.div
                          key={key.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.03 }}
                          className="grid grid-cols-[100px_160px_120px_80px_1fr_80px_100px_80px] gap-2 px-4 py-3 items-center border-b"
                          style={{ borderColor: C.border }}
                        >
                          <span className="text-[11px] uppercase font-bold" style={{ color: provColor }}>{key.provider}</span>
                          <span className="text-[10px] truncate" style={{ color: C.text }}>{key.email}</span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{key.keyMasked}</span>
                          <span
                            className="text-[9px] uppercase px-1.5 py-0.5 w-fit"
                            style={{ color: sColor, background: `${sColor}15`, border: `1px solid ${sColor}30` }}
                          >
                            {key.status}
                          </span>
                          <div>
                            <div className="h-1.5 rounded-none" style={{ background: C.border }}>
                              <motion.div
                                className="h-full"
                                style={{ background: usageColor(usePct) }}
                                initial={{ width: 0 }}
                                animate={{ width: `${usePct}%` }}
                                transition={{ duration: 0.6 }}
                              />
                            </div>
                            <div className="text-[9px] mt-0.5" style={{ color: C.muted }}>
                              {key.usedToday} / {key.dailyLimit}
                            </div>
                          </div>
                          <span className="text-[10px]" style={{ color: key.remaining === 0 ? C.red : C.green }}>
                            {key.remaining}
                          </span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(key.lastUsed)}</span>
                          <button
                            onClick={() => handleRotateKey(key.id)}
                            disabled={key.status === 'expired' || key.status === 'cooldown'}
                            className="text-[10px] px-2 py-1 border transition-colors hover:opacity-80 disabled:opacity-30"
                            style={{ color: C.cyan, borderColor: `${C.cyan}30` }}
                          >
                            Rotate
                          </button>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>

                {/* Add Account Form */}
                <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                  <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: C.text }}>Add Account</h2>
                  <div className="flex items-end gap-3">
                    <div>
                      <label className="text-[10px] uppercase block mb-1" style={{ color: C.muted }}>Provider</label>
                      <div className="flex items-center gap-1">
                        {(['claude', 'gemini', 'codex', 'openai', 'openrouter'] as ProviderName[]).map(p => (
                          <button
                            key={p}
                            onClick={() => setNewProvider(p)}
                            className="px-2 py-1 text-[10px] uppercase transition-all"
                            style={{
                              background: newProvider === p ? `${PROVIDER_COLORS[p]}15` : 'transparent',
                              color: newProvider === p ? PROVIDER_COLORS[p] : C.muted,
                              border: `1px solid ${newProvider === p ? `${PROVIDER_COLORS[p]}40` : C.border}`,
                            }}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] uppercase block mb-1" style={{ color: C.muted }}>Email</label>
                      <input
                        type="text"
                        value={newEmail}
                        onChange={e => setNewEmail(e.target.value)}
                        placeholder="account@email.com"
                        className="w-full px-3 py-2 text-xs rounded-none focus:outline-none"
                        style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] uppercase block mb-1" style={{ color: C.muted }}>API Key</label>
                      <input
                        type="password"
                        value={newApiKey}
                        onChange={e => setNewApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full px-3 py-2 text-xs rounded-none focus:outline-none"
                        style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </div>
                    <button
                      onClick={handleAddKey}
                      disabled={addingKey || !newEmail.trim() || !newApiKey.trim()}
                      className="px-4 py-2 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-30"
                      style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                    >
                      {addingKey ? 'Adding...' : 'Add'}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Rate Limits ═══════════ */}
            {activeTab === 'rate-limits' && (
              <motion.div
                key="rate-limits"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Pattern Detection Alert */}
                {rateLimitPattern && (
                  <div className="border p-4" style={{ background: `${C.red}08`, borderColor: `${C.red}30` }}>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: C.red }} />
                      <span className="text-xs font-bold" style={{ color: C.red }}>PATTERN DETECTED</span>
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: C.text }}>{rateLimitPattern}</div>
                  </div>
                )}

                {/* Events List */}
                <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                  <div
                    className="grid grid-cols-[100px_160px_100px_80px_80px] gap-2 px-4 py-2 text-[10px] uppercase"
                    style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                  >
                    <span>Provider</span>
                    <span>Timestamp</span>
                    <span>Retry After</span>
                    <span>Recovered</span>
                    <span>Key</span>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto">
                    {rateLimits.map((event, idx) => {
                      const provColor = PROVIDER_COLORS[event.provider];
                      return (
                        <motion.div
                          key={event.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.03 }}
                          className="grid grid-cols-[100px_160px_100px_80px_80px] gap-2 px-4 py-3 items-center border-b"
                          style={{ borderColor: C.border }}
                        >
                          <span className="text-[11px] uppercase font-bold" style={{ color: provColor }}>{event.provider}</span>
                          <span className="text-[10px]" style={{ color: C.text }}>{formatTimestamp(event.timestamp)}</span>
                          <span className="text-[10px]" style={{ color: C.yellow }}>{(event.retryAfterMs / 1000).toFixed(0)}s</span>
                          <span
                            className="text-[10px] uppercase"
                            style={{ color: event.recovered ? C.green : C.red }}
                          >
                            {event.recovered ? 'yes' : 'no'}
                          </span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{event.keyId}</span>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Cost Tracking ═══════════ */}
            {activeTab === 'costs' && (
              <motion.div
                key="costs"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Cost per Agent */}
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>Cost per Agent</h2>
                    <div className="flex-1 h-px" style={{ background: C.border }} />
                  </div>
                  <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                    <div
                      className="grid grid-cols-[160px_100px_120px_120px_80px_80px] gap-2 px-4 py-2 text-[10px] uppercase"
                      style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                    >
                      <span>Agent</span>
                      <span>Provider</span>
                      <span>Tokens In</span>
                      <span>Tokens Out</span>
                      <span>Cost</span>
                      <span>Calls</span>
                    </div>
                    {agentCosts
                      .sort((a, b) => b.costUsd - a.costUsd)
                      .map((agent, idx) => {
                        const provColor = PROVIDER_COLORS[agent.provider];
                        return (
                          <motion.div
                            key={agent.agentName}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.04 }}
                            className="grid grid-cols-[160px_100px_120px_120px_80px_80px] gap-2 px-4 py-3 items-center border-b"
                            style={{ borderColor: C.border }}
                          >
                            <span className="text-[11px]" style={{ color: C.text }}>{agent.agentName}</span>
                            <span className="text-[10px] uppercase" style={{ color: provColor }}>{agent.provider}</span>
                            <span className="text-[10px]" style={{ color: C.muted }}>{formatTokens(agent.tokensIn)}</span>
                            <span className="text-[10px]" style={{ color: C.muted }}>{formatTokens(agent.tokensOut)}</span>
                            <span className="text-[11px] font-bold" style={{ color: C.yellow }}>{formatUsd(agent.costUsd)}</span>
                            <span className="text-[10px]" style={{ color: C.cyan }}>{agent.callCount}</span>
                          </motion.div>
                        );
                      })}
                  </div>
                </div>

                {/* Budget Alert Config */}
                <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                  <h2 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: C.text }}>Budget Alert</h2>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px]" style={{ color: C.muted }}>Daily threshold:</span>
                    <input
                      type="number"
                      value={budgetThreshold}
                      onChange={e => setBudgetThreshold(Number(e.target.value) || 0)}
                      className="w-24 px-3 py-1.5 text-xs rounded-none focus:outline-none"
                      style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                    />
                    <span className="text-[10px]" style={{ color: C.muted }}>USD</span>
                    <div className="flex-1" />
                    <span className="text-[10px]" style={{ color: overBudget ? C.red : C.green }}>
                      Current: {formatUsd(totalCostToday)} / {formatUsd(budgetThreshold)}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Key Rotation ═══════════ */}
            {activeTab === 'rotation' && (
              <motion.div
                key="rotation"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="border p-6" style={{ background: C.card, borderColor: C.border }}>
                  <h2 className="text-xs font-bold uppercase tracking-wider mb-5" style={{ color: C.text }}>
                    Key Rotation Settings
                  </h2>

                  {/* Auto-rotate toggle */}
                  <div className="flex items-center gap-4 mb-5">
                    <span className="text-[11px]" style={{ color: C.text }}>Auto-rotate on rate limit</span>
                    <button
                      onClick={() => setRotationConfig(prev => ({ ...prev, autoRotateOnLimit: !prev.autoRotateOnLimit }))}
                      className="px-3 py-1.5 text-[10px] uppercase border transition-colors"
                      style={{
                        color: rotationConfig.autoRotateOnLimit ? C.green : C.red,
                        borderColor: `${rotationConfig.autoRotateOnLimit ? C.green : C.red}40`,
                        background: `${rotationConfig.autoRotateOnLimit ? C.green : C.red}10`,
                      }}
                    >
                      {rotationConfig.autoRotateOnLimit ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  {/* Strategy selector */}
                  <div className="mb-5">
                    <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Rotation Strategy</div>
                    <div className="flex items-center gap-2">
                      {(['round-robin', 'least-used', 'random'] as RotationStrategy[]).map(s => (
                        <button
                          key={s}
                          onClick={() => setRotationConfig(prev => ({ ...prev, strategy: s }))}
                          className="px-3 py-1.5 text-[10px] uppercase tracking-wider transition-all"
                          style={{
                            background: rotationConfig.strategy === s ? `${C.purple}15` : 'transparent',
                            color: rotationConfig.strategy === s ? C.purple : C.muted,
                            border: `1px solid ${rotationConfig.strategy === s ? `${C.purple}40` : C.border}`,
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Cooldown */}
                  <div>
                    <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Cooldown Period</div>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        value={rotationConfig.cooldownMs / 1000}
                        onChange={e => setRotationConfig(prev => ({ ...prev, cooldownMs: (Number(e.target.value) || 30) * 1000 }))}
                        className="w-24 px-3 py-1.5 text-xs rounded-none focus:outline-none"
                        style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                      />
                      <span className="text-[10px]" style={{ color: C.muted }}>seconds between rotations</span>
                    </div>
                  </div>
                </div>

                {/* Strategy descriptions */}
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { name: 'Round Robin', desc: 'Rotate through keys sequentially. Even distribution of load across all accounts.', color: C.cyan },
                    { name: 'Least Used', desc: 'Switch to the key with fewest calls today. Maximizes remaining quota.', color: C.green },
                    { name: 'Random', desc: 'Pick a random available key. Unpredictable pattern, harder to rate-limit.', color: C.purple },
                  ].map(item => (
                    <div key={item.name} className="border p-4" style={{ background: C.card, borderColor: C.border }}>
                      <div className="text-[11px] font-bold mb-2" style={{ color: item.color }}>{item.name}</div>
                      <div className="text-[10px]" style={{ color: C.muted }}>{item.desc}</div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
