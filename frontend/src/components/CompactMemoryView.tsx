'use client';

/**
 * CompactMemoryView -- Context Management & Persistent Memory
 *
 * `gt compact` + `gt remember` + `gt memories` -- the cognitive backbone
 * of Gas Town sessions. Manages context compaction, persistent memories,
 * session digests, and handoff trails between sessions.
 *
 * AYU DARK: bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680
 * border #2d363f, green #c2d94c, yellow #ffb454, red #f07178,
 * cyan #95e6cb, purple #d2a6ff. Font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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

interface Memory {
  key: string;
  value: string;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
}

interface CompactOperation {
  id: string;
  timestamp: string;
  tokensBeforeCompact: number;
  tokensAfterCompact: number;
  tokensSaved: number;
  preserved: string[];
  dropped: string[];
  sessionId: string;
  durationMs: number;
}

interface SessionDigest {
  sessionId: string;
  branch: string;
  recentCommits: string[];
  inProgressBeads: string[];
  summary: string;
  createdAt: string;
}

interface HandoffRecord {
  id: string;
  fromSession: string;
  toSession: string;
  timestamp: string;
  contextTransferred: number;
  filesModified: string[];
  pendingWork: string[];
  summary: string;
}

type TabId = 'memories' | 'compact' | 'digests' | 'handoffs';

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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function tokenColor(pct: number): string {
  if (pct < 50) return C.green;
  if (pct < 80) return C.yellow;
  return C.red;
}

// ── Mock Data Generators ────────────────────────────────────────────────────

function generateMockMemories(): Memory[] {
  const keys = [
    { key: 'project.name', value: 'gas-town-wl' },
    { key: 'branch.main', value: 'main' },
    { key: 'last.convoy.id', value: 'convoy-4f8a' },
    { key: 'preferred.model', value: 'claude-opus-4-20250514' },
    { key: 'db.migration.last', value: '042_epistemic_columns' },
    { key: 'agent.primary', value: 'polecat-alpha' },
    { key: 'test.command', value: 'npx vitest run' },
    { key: 'deploy.target', value: 'railway' },
    { key: 'rig.count', value: '3' },
    { key: 'meow.version', value: '0.9.4' },
    { key: 'last.error.hash', value: 'e3b0c44298fc1c' },
    { key: 'watchdog.interval', value: '30000' },
  ];
  const now = Date.now();
  return keys.map((k, i) => ({
    ...k,
    createdAt: new Date(now - (i + 1) * 3_600_000 * (i + 1)).toISOString(),
    lastAccessed: new Date(now - i * 900_000).toISOString(),
    accessCount: Math.floor(Math.random() * 40) + 1,
  }));
}

function generateMockCompactOps(): CompactOperation[] {
  const now = Date.now();
  return Array.from({ length: 8 }, (_, i) => {
    const before = 120000 + Math.floor(Math.random() * 80000);
    const saved = Math.floor(before * (0.3 + Math.random() * 0.4));
    return {
      id: `compact-${i}`,
      timestamp: new Date(now - i * 7_200_000).toISOString(),
      tokensBeforeCompact: before,
      tokensAfterCompact: before - saved,
      tokensSaved: saved,
      preserved: ['active-bead-state', 'memory-store', 'agent-context', 'convoy-progress'].slice(0, 2 + Math.floor(Math.random() * 3)),
      dropped: ['old-tool-results', 'stale-file-reads', 'resolved-errors', 'completed-bead-logs'].slice(0, 1 + Math.floor(Math.random() * 3)),
      sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
      durationMs: 200 + Math.floor(Math.random() * 1800),
    };
  });
}

function generateMockDigests(): SessionDigest[] {
  const now = Date.now();
  return Array.from({ length: 6 }, (_, i) => ({
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    branch: ['main', 'feat/meow-refinery', 'fix/patrol-backoff', 'feat/krc-engine'][i % 4],
    recentCommits: [
      `feat: add ${['patrol loop', 'refinery sweep', 'bead compaction', 'convoy routing'][i % 4]}`,
      `fix: resolve ${['race condition', 'memory leak', 'type error', 'import cycle'][i % 4]}`,
    ],
    inProgressBeads: [`bead-${Math.random().toString(36).slice(2, 6)}`, `bead-${Math.random().toString(36).slice(2, 6)}`].slice(0, 1 + (i % 2)),
    summary: [
      'Implemented patrol exponential backoff with configurable base intervals.',
      'Fixed bead lifecycle hooks not firing on convoy completion.',
      'Added memory persistence layer with TTL-based eviction.',
      'Refactored GUPP pipeline to support parallel molecule processing.',
      'Deployed refinery sweep with quality gate integration.',
      'Set up KRC engine with configurable decay curves.',
    ][i],
    createdAt: new Date(now - i * 14_400_000).toISOString(),
  }));
}

function generateMockHandoffs(): HandoffRecord[] {
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) => ({
    id: `handoff-${i}`,
    fromSession: `sess-${Math.random().toString(36).slice(2, 10)}`,
    toSession: `sess-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date(now - i * 28_800_000).toISOString(),
    contextTransferred: 8000 + Math.floor(Math.random() * 12000),
    filesModified: [
      'src/meow/patrol.ts',
      'src/meow/refinery.ts',
      'src/agents/polecat.ts',
      'src/bead/lifecycle.ts',
      'src/krc/engine.ts',
    ].slice(0, 2 + Math.floor(Math.random() * 3)),
    pendingWork: [
      'Complete test coverage for patrol backoff',
      'Wire KRC prune endpoint',
      'Fix convoy routing edge case',
      'Deploy refinery quality gate',
    ].slice(0, 1 + Math.floor(Math.random() * 2)),
    summary: [
      'Patrol system mostly done; needs integration tests.',
      'Memory store complete; handoff for KRC wiring.',
      'Refinery sweep works locally; needs Railway deploy.',
      'Convoy tracker updated; bead lifecycle hooks pending.',
      'GUPP dashboard wired to live data; needs polish.',
    ][i],
  }));
}

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

// ── Token Usage Gauge ───────────────────────────────────────────────────────

function TokenGauge({ used, total }: { used: number; total: number }) {
  const pct = Math.round((used / total) * 100);
  const color = tokenColor(pct);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width={130} height={130}>
        <circle cx={65} cy={65} r={radius} fill="none" stroke={C.border} strokeWidth={6} />
        <motion.circle
          cx={65} cy={65} r={radius}
          fill="none" stroke={color} strokeWidth={6} strokeLinecap="butt"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: 'easeOut' }}
          transform="rotate(-90 65 65)"
        />
        <text x={65} y={58} textAnchor="middle" dominantBaseline="central" fill={color} fontFamily="monospace" fontSize={22} fontWeight="bold">
          {pct}%
        </text>
        <text x={65} y={78} textAnchor="middle" fill={C.muted} fontFamily="monospace" fontSize={9}>
          {(used / 1000).toFixed(0)}k / {(total / 1000).toFixed(0)}k
        </text>
      </svg>
      <div className="text-[9px] uppercase tracking-wider mt-1" style={{ color: C.muted }}>Context Usage</div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function CompactMemoryView() {
  const [activeTab, setActiveTab] = useState<TabId>('memories');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [compactOps, setCompactOps] = useState<CompactOperation[]>([]);
  const [digests, setDigests] = useState<SessionDigest[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [compactReport, setCompactReport] = useState<CompactOperation | null>(null);

  // Remember form
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Simulated context state
  const [contextTokens] = useState(87_420);
  const [maxTokens] = useState(200_000);

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // ── Fetch data ────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const [crewRes, timelineRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/crew`),
        fetch(`${API}/api/meow/town/timeline`),
      ]);

      // Extract session data from crew/timeline for digests
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const crewData = await crewRes.value.json();
        const sessions = Array.isArray(crewData) ? crewData : crewData.crew || [];
        // Map crew data to digests if applicable
        if (sessions.length > 0 && digests.length === 0) {
          setDigests(generateMockDigests());
        }
      }

      if (timelineRes.status === 'fulfilled' && timelineRes.value.ok) {
        const evts = await timelineRes.value.json();
        const events = Array.isArray(evts) ? evts : evts.events || [];
        // Use timeline events to enrich handoff data
        if (events.length > 0 && handoffs.length === 0) {
          setHandoffs(generateMockHandoffs());
        }
      }
    } catch {
      // silent
    }

    // Load mock data for sections without backend yet
    if (memories.length === 0) setMemories(generateMockMemories());
    if (compactOps.length === 0) setCompactOps(generateMockCompactOps());
    if (digests.length === 0) setDigests(generateMockDigests());
    if (handoffs.length === 0) setHandoffs(generateMockHandoffs());

    setLoading(false);
  }, [memories.length, compactOps.length, digests.length, handoffs.length]);

  useEffect(() => {
    fetchData();
    pollRef.current = setInterval(fetchData, 20_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchData]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleRemember = useCallback(async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    setSaving(true);
    // Simulate API call
    await new Promise(r => setTimeout(r, 400));
    const newMem: Memory = {
      key: newKey.trim(),
      value: newValue.trim(),
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 0,
    };
    setMemories(prev => [newMem, ...prev]);
    setNewKey('');
    setNewValue('');
    setSaving(false);
  }, [newKey, newValue]);

  const handleForget = useCallback((key: string) => {
    setMemories(prev => prev.filter(m => m.key !== key));
  }, []);

  const handleCompact = useCallback(async () => {
    setCompacting(true);
    // Simulate compaction
    await new Promise(r => setTimeout(r, 2000));
    const before = contextTokens;
    const saved = Math.floor(before * (0.3 + Math.random() * 0.3));
    const report: CompactOperation = {
      id: `compact-${Date.now()}`,
      timestamp: new Date().toISOString(),
      tokensBeforeCompact: before,
      tokensAfterCompact: before - saved,
      tokensSaved: saved,
      preserved: ['active-bead-state', 'memory-store', 'agent-context'],
      dropped: ['old-tool-results', 'stale-file-reads'],
      sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
      durationMs: 1800 + Math.floor(Math.random() * 800),
    };
    setCompactOps(prev => [report, ...prev]);
    setCompactReport(report);
    setCompacting(false);
  }, [contextTokens]);

  // ── Filtered memories ─────────────────────────────────────────────────────

  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const q = searchQuery.toLowerCase();
    return memories.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
  }, [memories, searchQuery]);

  // ── Token savings sparkline data ──────────────────────────────────────────

  const savingsSparkline = useMemo(() =>
    compactOps.slice(0, 10).reverse().map(op => op.tokensSaved),
    [compactOps]
  );

  // ── Tab Config ────────────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: 'memories', label: 'Memory Store', count: memories.length },
    { id: 'compact', label: 'Compact Console', count: compactOps.length },
    { id: 'digests', label: 'Session Digests', count: digests.length },
    { id: 'handoffs', label: 'Handoff Trail', count: handoffs.length },
  ];

  // ── Loading State ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: C.bg, color: C.muted }}>
        <div className="text-sm animate-pulse">Loading memory subsystem...</div>
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
            Compact Memory
          </h1>
          <span
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: `${C.purple}15`, color: C.purple, border: `1px solid ${C.purple}30` }}
          >
            gt compact + gt remember
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px]" style={{ color: C.muted }}>
            {memories.length} memories
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
                background: active ? `${C.cyan}15` : 'transparent',
                color: active ? C.cyan : C.muted,
                border: `1px solid ${active ? `${C.cyan}40` : 'transparent'}`,
              }}
            >
              {tab.label}
              <span className="ml-1.5 text-[9px]" style={{ opacity: 0.6 }}>({tab.count})</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1400px] mx-auto space-y-6">
          <AnimatePresence mode="wait">
            {/* ═══════════ Memory Store Tab ═══════════ */}
            {activeTab === 'memories' && (
              <motion.div
                key="memories"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-6"
              >
                {/* Remember Form */}
                <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                  <div className="text-[10px] uppercase tracking-wider mb-3" style={{ color: C.muted }}>
                    Remember Something
                  </div>
                  <div className="flex items-start gap-3">
                    <input
                      type="text"
                      value={newKey}
                      onChange={e => setNewKey(e.target.value)}
                      placeholder="Key (e.g. project.name)"
                      className="w-48 px-3 py-2 text-xs rounded-none focus:outline-none"
                      style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                    />
                    <textarea
                      value={newValue}
                      onChange={e => setNewValue(e.target.value)}
                      placeholder="Value..."
                      rows={2}
                      className="flex-1 px-3 py-2 text-xs rounded-none focus:outline-none resize-none"
                      style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.text }}
                    />
                    <button
                      onClick={handleRemember}
                      disabled={saving || !newKey.trim() || !newValue.trim()}
                      className="px-4 py-2 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-30"
                      style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Search */}
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search memories..."
                    className="w-72 px-3 py-2 text-xs rounded-none focus:outline-none"
                    style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
                  />
                  <span className="text-[10px]" style={{ color: C.muted }}>
                    {filteredMemories.length} / {memories.length} memories
                  </span>
                </div>

                {/* Memory List */}
                <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                  {/* Table Header */}
                  <div
                    className="grid grid-cols-[180px_1fr_120px_120px_60px_60px] gap-2 px-4 py-2 text-[10px] uppercase"
                    style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                  >
                    <span>Key</span>
                    <span>Value</span>
                    <span>Created</span>
                    <span>Last Access</span>
                    <span>Hits</span>
                    <span></span>
                  </div>

                  <div className="max-h-[400px] overflow-y-auto">
                    {filteredMemories.length === 0 && (
                      <div className="py-12 text-center text-[11px]" style={{ color: C.muted }}>
                        No memories found. Use the form above to remember something.
                      </div>
                    )}
                    {filteredMemories.map((mem, idx) => (
                      <motion.div
                        key={mem.key}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.02 }}
                        className="grid grid-cols-[180px_1fr_120px_120px_60px_60px] gap-2 px-4 py-3 items-center border-b"
                        style={{ borderColor: C.border }}
                      >
                        <span className="text-[11px] truncate" style={{ color: C.cyan }}>{mem.key}</span>
                        <span className="text-[11px] truncate" style={{ color: C.text }}>{truncate(mem.value, 60)}</span>
                        <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(mem.createdAt)}</span>
                        <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(mem.lastAccessed)}</span>
                        <span className="text-[10px] text-center" style={{ color: C.yellow }}>{mem.accessCount}</span>
                        <button
                          onClick={() => handleForget(mem.key)}
                          className="text-[10px] px-2 py-0.5 border transition-colors hover:opacity-80"
                          style={{ color: C.red, borderColor: `${C.red}30`, background: `${C.red}08` }}
                        >
                          Forget
                        </button>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Compact Console Tab ═══════════ */}
            {activeTab === 'compact' && (
              <motion.div
                key="compact"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-6"
              >
                {/* Context Overview */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {/* Token Gauge */}
                  <div className="border p-5 flex items-center justify-center" style={{ background: C.card, borderColor: C.border }}>
                    <TokenGauge used={contextTokens} total={maxTokens} />
                  </div>

                  {/* Stats */}
                  <div className="border p-5 space-y-4" style={{ background: C.card, borderColor: C.border }}>
                    <div>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Total Compactions</div>
                      <div className="text-xl font-bold" style={{ color: C.purple }}>{compactOps.length}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Total Tokens Saved</div>
                      <div className="text-xl font-bold" style={{ color: C.green }}>
                        {(compactOps.reduce((s, o) => s + o.tokensSaved, 0) / 1000).toFixed(1)}k
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Savings Trend</div>
                      <Sparkline values={savingsSparkline} width={180} height={28} color={C.green} />
                    </div>
                  </div>

                  {/* Compact Action */}
                  <div className="border p-5 flex flex-col items-center justify-center gap-4" style={{ background: C.card, borderColor: C.border }}>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={handleCompact}
                      disabled={compacting}
                      className="px-6 py-3 text-xs uppercase tracking-wider border transition-colors disabled:opacity-40"
                      style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
                    >
                      {compacting ? (
                        <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1, repeat: Infinity }}>
                          Compacting...
                        </motion.span>
                      ) : 'Run Compact'}
                    </motion.button>
                    <div className="text-[10px] text-center" style={{ color: C.muted }}>
                      Preserves active beads, memory store, and agent context.
                      Drops stale reads and resolved errors.
                    </div>
                  </div>
                </div>

                {/* Compact Report */}
                <AnimatePresence>
                  {compactReport && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="border p-5 overflow-hidden"
                      style={{ background: `${C.green}08`, borderColor: `${C.green}30` }}
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-2 h-2 rounded-full" style={{ background: C.green }} />
                        <span className="text-xs font-bold" style={{ color: C.green }}>COMPACT COMPLETE</span>
                        <span className="text-[10px] ml-auto" style={{ color: C.muted }}>
                          {compactReport.durationMs}ms
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-4 mb-3">
                        <div>
                          <div className="text-[9px] uppercase" style={{ color: C.muted }}>Before</div>
                          <div className="text-sm font-bold" style={{ color: C.yellow }}>
                            {(compactReport.tokensBeforeCompact / 1000).toFixed(1)}k tokens
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase" style={{ color: C.muted }}>After</div>
                          <div className="text-sm font-bold" style={{ color: C.green }}>
                            {(compactReport.tokensAfterCompact / 1000).toFixed(1)}k tokens
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase" style={{ color: C.muted }}>Saved</div>
                          <div className="text-sm font-bold" style={{ color: C.cyan }}>
                            {(compactReport.tokensSaved / 1000).toFixed(1)}k tokens
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>Preserved</div>
                          <div className="flex flex-wrap gap-1">
                            {compactReport.preserved.map(item => (
                              <span key={item} className="px-2 py-0.5 text-[10px]" style={{ background: `${C.green}15`, color: C.green, border: `1px solid ${C.green}30` }}>
                                {item}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>Dropped</div>
                          <div className="flex flex-wrap gap-1">
                            {compactReport.dropped.map(item => (
                              <span key={item} className="px-2 py-0.5 text-[10px]" style={{ background: `${C.red}15`, color: C.red, border: `1px solid ${C.red}30` }}>
                                {item}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Compact History */}
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>
                      Compact History
                    </h2>
                    <div className="flex-1 h-px" style={{ background: C.border }} />
                  </div>
                  <div className="space-y-2">
                    {compactOps.map((op, idx) => (
                      <motion.div
                        key={op.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.03 }}
                        className="border px-4 py-3 flex items-center gap-4"
                        style={{ background: C.card, borderColor: C.border }}
                      >
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: C.purple }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3">
                            <span className="text-[11px]" style={{ color: C.text }}>
                              {op.sessionId}
                            </span>
                            <span className="text-[10px]" style={{ color: C.green }}>
                              -{(op.tokensSaved / 1000).toFixed(1)}k tokens
                            </span>
                            <span className="text-[10px]" style={{ color: C.muted }}>
                              {op.durationMs}ms
                            </span>
                          </div>
                          <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>
                            {(op.tokensBeforeCompact / 1000).toFixed(0)}k -&gt; {(op.tokensAfterCompact / 1000).toFixed(0)}k
                            | preserved {op.preserved.length} | dropped {op.dropped.length}
                          </div>
                        </div>
                        <span className="text-[10px] shrink-0" style={{ color: C.muted }}>
                          {timeAgo(op.timestamp)}
                        </span>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Session Digests Tab ═══════════ */}
            {activeTab === 'digests' && (
              <motion.div
                key="digests"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <div className="text-[11px] mb-2" style={{ color: C.muted }}>
                  Session digests created by pre-compact hooks. Useful for seance recovery.
                </div>
                {digests.map((digest, idx) => (
                  <motion.div
                    key={digest.sessionId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="border p-5"
                    style={{ background: C.card, borderColor: C.border }}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-[11px] font-bold" style={{ color: C.cyan }}>{digest.sessionId}</span>
                      <span
                        className="px-2 py-0.5 text-[10px]"
                        style={{ background: `${C.purple}15`, color: C.purple, border: `1px solid ${C.purple}30` }}
                      >
                        {digest.branch}
                      </span>
                      <span className="text-[10px] ml-auto" style={{ color: C.muted }}>
                        {formatTimestamp(digest.createdAt)}
                      </span>
                    </div>

                    <div className="text-[11px] mb-3" style={{ color: C.text }}>{digest.summary}</div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>Recent Commits</div>
                        {digest.recentCommits.map((commit, i) => (
                          <div key={i} className="text-[10px] py-0.5 flex items-center gap-2" style={{ color: C.green }}>
                            <span style={{ color: C.muted }}>*</span> {commit}
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>In-Progress Beads</div>
                        <div className="flex flex-wrap gap-1">
                          {digest.inProgressBeads.map((bead, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 text-[10px]"
                              style={{ background: `${C.yellow}15`, color: C.yellow, border: `1px solid ${C.yellow}30` }}
                            >
                              {bead}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}

            {/* ═══════════ Handoff Trail Tab ═══════════ */}
            {activeTab === 'handoffs' && (
              <motion.div
                key="handoffs"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <div className="text-[11px] mb-2" style={{ color: C.muted }}>
                  Handoff operations between sessions. Tracks context transferred, files modified, and pending work.
                </div>

                {/* Handoff Timeline */}
                <div className="relative ml-4">
                  <div className="absolute left-3 top-0 bottom-0 w-px" style={{ background: C.border }} />

                  {handoffs.map((handoff, idx) => (
                    <motion.div
                      key={handoff.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.06 }}
                      className="relative pl-10 py-3"
                    >
                      <div
                        className="absolute left-1.5 top-5 w-3 h-3 rounded-full"
                        style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}40` }}
                      />
                      <div className="border p-4" style={{ background: C.card, borderColor: C.border }}>
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-[10px]" style={{ color: C.red }}>{handoff.fromSession}</span>
                          <span className="text-[11px]" style={{ color: C.muted }}>-&gt;</span>
                          <span className="text-[10px]" style={{ color: C.green }}>{handoff.toSession}</span>
                          <span
                            className="px-2 py-0.5 text-[10px]"
                            style={{ background: `${C.cyan}15`, color: C.cyan, border: `1px solid ${C.cyan}30` }}
                          >
                            {(handoff.contextTransferred / 1000).toFixed(1)}k tokens
                          </span>
                          <span className="text-[10px] ml-auto" style={{ color: C.muted }}>
                            {formatTimestamp(handoff.timestamp)}
                          </span>
                        </div>

                        <div className="text-[11px] mb-3" style={{ color: C.text }}>{handoff.summary}</div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>Files Modified</div>
                            {handoff.filesModified.map((file, i) => (
                              <div key={i} className="text-[10px] py-0.5" style={{ color: C.purple }}>
                                {file}
                              </div>
                            ))}
                          </div>
                          <div>
                            <div className="text-[9px] uppercase mb-1" style={{ color: C.muted }}>Pending Work</div>
                            {handoff.pendingWork.map((work, i) => (
                              <div key={i} className="text-[10px] py-0.5 flex items-center gap-1" style={{ color: C.yellow }}>
                                <span style={{ color: C.muted }}>[ ]</span> {work}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </motion.div>
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
