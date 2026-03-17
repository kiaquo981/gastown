'use client';

/**
 * KRCView -- Key Record Chronicle
 *
 * TTL-based ephemeral data lifecycle management. Events are born,
 * live for their configured TTL, then are pruned to keep the
 * system lean. Configurable per event type with retention floors.
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

interface EventTypeConfig {
  type: string;
  ttlDays: number;
  eventCount: number;
  oldestEvent: string | null;
  newestEvent: string | null;
  category: string;
}

interface PruneOperation {
  id: string;
  timestamp: string;
  eventsPruned: number;
  spaceFreedKb: number;
  durationMs: number;
  eventTypes: string[];
}

interface KRCEvent {
  id: string;
  type: string;
  timestamp: string;
  ageDays: number;
  data: Record<string, unknown>;
  ttlDays: number;
  expiresAt: string;
}

interface KRCOverview {
  totalEvents: number;
  eventsPruned: number;
  diskSavedMb: number;
  defaultTtlDays: number;
  pruneIntervalHours: number;
  minRetainCount: number;
}

type TabId = 'overview' | 'ttl-config' | 'prune-history' | 'decay' | 'explorer';

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '--';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '--';
  }
}

function ttlColor(days: number): string {
  if (days <= 1) return C.red;
  if (days <= 7) return C.yellow;
  if (days <= 30) return C.cyan;
  return C.green;
}

function categoryColor(cat: string): string {
  const map: Record<string, string> = {
    patrol: C.cyan,
    session: C.purple,
    nudge: C.yellow,
    mail: C.green,
    convoy: '#e06c75',
    merge: C.muted,
  };
  return map[cat] || C.muted;
}

// ── Mock Data ───────────────────────────────────────────────────────────────

const MOCK_EVENT_TYPES: EventTypeConfig[] = [
  { type: 'patrol-receipts', ttlDays: 1, eventCount: 482, oldestEvent: null, newestEvent: null, category: 'patrol' },
  { type: 'session-events', ttlDays: 7, eventCount: 1240, oldestEvent: null, newestEvent: null, category: 'session' },
  { type: 'nudge-history', ttlDays: 3, eventCount: 318, oldestEvent: null, newestEvent: null, category: 'nudge' },
  { type: 'mail-read', ttlDays: 14, eventCount: 856, oldestEvent: null, newestEvent: null, category: 'mail' },
  { type: 'convoy-history', ttlDays: 30, eventCount: 2150, oldestEvent: null, newestEvent: null, category: 'convoy' },
  { type: 'merge-events', ttlDays: 90, eventCount: 540, oldestEvent: null, newestEvent: null, category: 'merge' },
  { type: 'agent-heartbeats', ttlDays: 1, eventCount: 8200, oldestEvent: null, newestEvent: null, category: 'patrol' },
  { type: 'bead-lifecycle', ttlDays: 14, eventCount: 1680, oldestEvent: null, newestEvent: null, category: 'session' },
  { type: 'quality-gate-results', ttlDays: 30, eventCount: 420, oldestEvent: null, newestEvent: null, category: 'patrol' },
  { type: 'wisp-traces', ttlDays: 3, eventCount: 2800, oldestEvent: null, newestEvent: null, category: 'session' },
  { type: 'compact-logs', ttlDays: 7, eventCount: 95, oldestEvent: null, newestEvent: null, category: 'session' },
  { type: 'handoff-records', ttlDays: 30, eventCount: 64, oldestEvent: null, newestEvent: null, category: 'session' },
];

function generateMockEventTypes(): EventTypeConfig[] {
  const now = Date.now();
  return MOCK_EVENT_TYPES.map((et, i) => ({
    ...et,
    oldestEvent: new Date(now - et.ttlDays * 86_400_000 * 0.9 - i * 3_600_000).toISOString(),
    newestEvent: new Date(now - i * 600_000).toISOString(),
  }));
}

function generateMockPruneOps(): PruneOperation[] {
  const now = Date.now();
  return Array.from({ length: 12 }, (_, i) => ({
    id: `prune-${i}`,
    timestamp: new Date(now - i * 3_600_000).toISOString(),
    eventsPruned: 50 + Math.floor(Math.random() * 400),
    spaceFreedKb: 100 + Math.floor(Math.random() * 2000),
    durationMs: 100 + Math.floor(Math.random() * 1500),
    eventTypes: MOCK_EVENT_TYPES
      .filter(() => Math.random() > 0.5)
      .slice(0, 3)
      .map(et => et.type),
  }));
}

function generateMockEvents(typeFilter: string | null): KRCEvent[] {
  const now = Date.now();
  const types = typeFilter
    ? MOCK_EVENT_TYPES.filter(et => et.type === typeFilter)
    : MOCK_EVENT_TYPES;

  return Array.from({ length: 40 }, (_, i) => {
    const et = types[i % types.length];
    const age = Math.random() * et.ttlDays;
    const ts = new Date(now - age * 86_400_000).toISOString();
    return {
      id: `evt-${i}-${Math.random().toString(36).slice(2, 8)}`,
      type: et.type,
      timestamp: ts,
      ageDays: Math.round(age * 10) / 10,
      data: {
        sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
        agent: ['polecat-alpha', 'deacon', 'witness', 'mayor', 'scout'][i % 5],
        detail: `Event detail for ${et.type} #${i}`,
      },
      ttlDays: et.ttlDays,
      expiresAt: new Date(new Date(ts).getTime() + et.ttlDays * 86_400_000).toISOString(),
    };
  }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ── Decay Chart SVG ─────────────────────────────────────────────────────────

function DecayChart({
  eventTypes,
  minRetain,
}: {
  eventTypes: EventTypeConfig[];
  minRetain: number;
}) {
  const w = 600;
  const h = 240;
  const pad = { top: 20, bottom: 30, left: 50, right: 20 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  // X axis: days (0 to max TTL)
  const maxTtl = Math.max(...eventTypes.map(et => et.ttlDays), 7);
  const maxCount = Math.max(...eventTypes.map(et => et.eventCount), 100);

  // Generate decay lines per event type
  const lines = eventTypes.map(et => {
    const points: { x: number; y: number }[] = [];
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const day = (i / steps) * maxTtl;
      // Exponential decay model: count * e^(-day/ttl) but floor at minRetain
      const decayed = Math.max(et.eventCount * Math.exp(-day / (et.ttlDays * 0.5)), minRetain);
      const x = pad.left + (day / maxTtl) * innerW;
      const y = pad.top + innerH - (decayed / maxCount) * innerH;
      points.push({ x, y });
    }
    return {
      type: et.type,
      color: categoryColor(et.category),
      path: points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' '),
    };
  });

  // Retention floor line
  const floorY = pad.top + innerH - (minRetain / maxCount) * innerH;

  return (
    <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {/* Grid */}
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + innerH} stroke={C.border} strokeWidth={0.5} />
      <line x1={pad.left} y1={pad.top + innerH} x2={pad.left + innerW} y2={pad.top + innerH} stroke={C.border} strokeWidth={0.5} />

      {/* Horizontal grid lines */}
      {[0.25, 0.5, 0.75].map(pct => {
        const y = pad.top + innerH * (1 - pct);
        return <line key={pct} x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} stroke={C.border} strokeWidth={0.3} strokeDasharray="4,4" />;
      })}

      {/* Retention floor */}
      <line
        x1={pad.left} y1={floorY}
        x2={pad.left + innerW} y2={floorY}
        stroke={C.red} strokeWidth={1} strokeDasharray="6,3" opacity={0.5}
      />
      <text x={pad.left + innerW + 4} y={floorY + 3} fill={C.red} fontFamily="monospace" fontSize={8} opacity={0.7}>
        min_retain
      </text>

      {/* Decay curves */}
      {lines.map(line => (
        <motion.path
          key={line.type}
          d={line.path}
          fill="none"
          stroke={line.color}
          strokeWidth={1.5}
          opacity={0.7}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
        />
      ))}

      {/* X axis labels */}
      {[0, 7, 14, 30, 60, 90].filter(d => d <= maxTtl).map(day => {
        const x = pad.left + (day / maxTtl) * innerW;
        return (
          <text key={day} x={x} y={h - 8} textAnchor="middle" fill={C.muted} fontFamily="monospace" fontSize={8}>
            {day}d
          </text>
        );
      })}

      {/* Y axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = pad.top + innerH * (1 - pct);
        const val = Math.round(maxCount * pct);
        return (
          <text key={pct} x={pad.left - 6} y={y + 3} textAnchor="end" fill={C.muted} fontFamily="monospace" fontSize={8}>
            {val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
          </text>
        );
      })}
    </svg>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function KRCView() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [eventTypes, setEventTypes] = useState<EventTypeConfig[]>([]);
  const [pruneOps, setPruneOps] = useState<PruneOperation[]>([]);
  const [events, setEvents] = useState<KRCEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [pruning, setPruning] = useState(false);

  // Overview config
  const [overview, setOverview] = useState<KRCOverview>({
    totalEvents: 0,
    eventsPruned: 0,
    diskSavedMb: 0,
    defaultTtlDays: 7,
    pruneIntervalHours: 1,
    minRetainCount: 100,
  });

  // Explorer filters
  const [explorerTypeFilter, setExplorerTypeFilter] = useState<string | null>(null);
  const [explorerAgeFilter, setExplorerAgeFilter] = useState<number | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    // Try to get timeline data from backend
    try {
      const res = await fetch(`${API}/api/meow/town/timeline`);
      if (res.ok) {
        // Enrich event data from real timeline
      }
    } catch {
      // silent
    }

    const types = generateMockEventTypes();
    setEventTypes(types);
    setPruneOps(generateMockPruneOps());
    setEvents(generateMockEvents(null));

    const totalEvents = types.reduce((s, et) => s + et.eventCount, 0);
    const totalPruned = 12_400 + Math.floor(Math.random() * 3000);
    setOverview({
      totalEvents,
      eventsPruned: totalPruned,
      diskSavedMb: Math.round(totalPruned * 0.3) / 100,
      defaultTtlDays: 7,
      pruneIntervalHours: 1,
      minRetainCount: 100,
    });

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const handlePruneNow = useCallback(async () => {
    setPruning(true);
    await new Promise(r => setTimeout(r, 1500));
    const pruned = 30 + Math.floor(Math.random() * 200);
    const freed = 50 + Math.floor(Math.random() * 500);
    const newOp: PruneOperation = {
      id: `prune-manual-${Date.now()}`,
      timestamp: new Date().toISOString(),
      eventsPruned: pruned,
      spaceFreedKb: freed,
      durationMs: 300 + Math.floor(Math.random() * 800),
      eventTypes: eventTypes.filter(() => Math.random() > 0.6).slice(0, 4).map(et => et.type),
    };
    setPruneOps(prev => [newOp, ...prev]);
    setOverview(prev => ({
      ...prev,
      totalEvents: prev.totalEvents - pruned,
      eventsPruned: prev.eventsPruned + pruned,
      diskSavedMb: prev.diskSavedMb + freed / 1024,
    }));
    setPruning(false);
  }, [eventTypes]);

  const handleUpdateTtl = useCallback((type: string, newTtl: number) => {
    setEventTypes(prev => prev.map(et =>
      et.type === type ? { ...et, ttlDays: newTtl } : et
    ));
  }, []);

  const handleDeleteEvent = useCallback((eventId: string) => {
    setEvents(prev => prev.filter(e => e.id !== eventId));
  }, []);

  // ── Filtered events for explorer ──────────────────────────────────────────

  const filteredEvents = useMemo(() => {
    let result = events;
    if (explorerTypeFilter) {
      result = result.filter(e => e.type === explorerTypeFilter);
    }
    if (explorerAgeFilter !== null) {
      result = result.filter(e => e.ageDays <= explorerAgeFilter);
    }
    return result;
  }, [events, explorerTypeFilter, explorerAgeFilter]);

  // ── Tab Config ────────────────────────────────────────────────────────────

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'ttl-config', label: 'TTL Config' },
    { id: 'prune-history', label: 'Prune History' },
    { id: 'decay', label: 'Decay Visualization' },
    { id: 'explorer', label: 'Event Explorer' },
  ];

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: C.bg, color: C.muted }}>
        <div className="text-sm animate-pulse">Loading KRC engine...</div>
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
            Key Record Chronicle
          </h1>
          <span
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
            style={{ background: `${C.cyan}15`, color: C.cyan, border: `1px solid ${C.cyan}30` }}
          >
            TTL-based lifecycle
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px]" style={{ color: C.muted }}>
            {overview.totalEvents.toLocaleString()} events
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
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[1400px] mx-auto">
          <AnimatePresence mode="wait">

            {/* ═══════════ Overview ═══════════ */}
            {activeTab === 'overview' && (
              <motion.div
                key="overview"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* KPIs */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Total Events</div>
                    <div className="text-2xl font-bold" style={{ color: C.cyan }}>{overview.totalEvents.toLocaleString()}</div>
                  </div>
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Events Pruned</div>
                    <div className="text-2xl font-bold" style={{ color: C.green }}>{overview.eventsPruned.toLocaleString()}</div>
                  </div>
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Disk Saved</div>
                    <div className="text-2xl font-bold" style={{ color: C.purple }}>{overview.diskSavedMb.toFixed(1)} MB</div>
                  </div>
                  <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: C.muted }}>Event Types</div>
                    <div className="text-2xl font-bold" style={{ color: C.yellow }}>{eventTypes.length}</div>
                  </div>
                </div>

                {/* Configuration Summary */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="border p-4" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Default TTL</div>
                    <div className="text-lg font-bold" style={{ color: C.cyan }}>{overview.defaultTtlDays} days</div>
                  </div>
                  <div className="border p-4" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Prune Interval</div>
                    <div className="text-lg font-bold" style={{ color: C.yellow }}>{overview.pruneIntervalHours}h</div>
                  </div>
                  <div className="border p-4" style={{ background: C.card, borderColor: C.border }}>
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Min Retain</div>
                    <div className="text-lg font-bold" style={{ color: C.red }}>{overview.minRetainCount}</div>
                  </div>
                </div>

                {/* Event Type Summary */}
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>Event Types</h2>
                    <div className="flex-1 h-px" style={{ background: C.border }} />
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                    {eventTypes.map((et, idx) => {
                      const tColor = ttlColor(et.ttlDays);
                      const cColor = categoryColor(et.category);
                      return (
                        <motion.div
                          key={et.type}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.03 }}
                          className="border p-3 flex items-center gap-3"
                          style={{ background: C.card, borderColor: C.border }}
                        >
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: cColor }} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] truncate" style={{ color: C.text }}>{et.type}</div>
                            <div className="text-[9px]" style={{ color: C.muted }}>{et.eventCount.toLocaleString()} events</div>
                          </div>
                          <span
                            className="text-[10px] px-1.5 py-0.5 shrink-0"
                            style={{ color: tColor, background: `${tColor}15`, border: `1px solid ${tColor}30` }}
                          >
                            {et.ttlDays}d
                          </span>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ TTL Config ═══════════ */}
            {activeTab === 'ttl-config' && (
              <motion.div
                key="ttl-config"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                <div className="text-[11px] mb-2" style={{ color: C.muted }}>
                  Configure TTL per event type. Events older than their TTL are pruned, subject to the minimum retain count ({overview.minRetainCount}).
                </div>

                {/* Config Table */}
                <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                  <div
                    className="grid grid-cols-[200px_80px_80px_120px_120px_120px] gap-2 px-4 py-2 text-[10px] uppercase"
                    style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                  >
                    <span>Event Type</span>
                    <span>Category</span>
                    <span>TTL</span>
                    <span>Count</span>
                    <span>Oldest</span>
                    <span>Newest</span>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto">
                    {eventTypes.map((et, idx) => {
                      const tColor = ttlColor(et.ttlDays);
                      const cColor = categoryColor(et.category);
                      return (
                        <motion.div
                          key={et.type}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.03 }}
                          className="grid grid-cols-[200px_80px_80px_120px_120px_120px] gap-2 px-4 py-3 items-center border-b"
                          style={{ borderColor: C.border }}
                        >
                          <span className="text-[11px]" style={{ color: C.text }}>{et.type}</span>
                          <span
                            className="text-[9px] uppercase px-1.5 py-0.5 w-fit"
                            style={{ color: cColor, background: `${cColor}15`, border: `1px solid ${cColor}30` }}
                          >
                            {et.category}
                          </span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min={1}
                              max={365}
                              value={et.ttlDays}
                              onChange={e => handleUpdateTtl(et.type, Number(e.target.value) || 1)}
                              className="w-12 px-1 py-0.5 text-[10px] text-center rounded-none focus:outline-none"
                              style={{ background: C.bg, border: `1px solid ${tColor}40`, color: tColor }}
                            />
                            <span className="text-[9px]" style={{ color: C.muted }}>d</span>
                          </div>
                          <span className="text-[10px]" style={{ color: C.cyan }}>{et.eventCount.toLocaleString()}</span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(et.oldestEvent)}</span>
                          <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(et.newestEvent)}</span>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* ═══════════ Prune History ═══════════ */}
            {activeTab === 'prune-history' && (
              <motion.div
                key="prune-history"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                {/* Prune Now button */}
                <div className="flex items-center gap-3">
                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={handlePruneNow}
                    disabled={pruning}
                    className="px-4 py-2 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-40"
                    style={{ color: C.red, borderColor: `${C.red}40`, background: `${C.red}10` }}
                  >
                    {pruning ? (
                      <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ duration: 1, repeat: Infinity }}>
                        Pruning...
                      </motion.span>
                    ) : 'Prune Now'}
                  </motion.button>
                  <span className="text-[10px]" style={{ color: C.muted }}>
                    Auto-prune every {overview.pruneIntervalHours}h
                  </span>
                </div>

                {/* Prune History List */}
                <div className="space-y-2">
                  {pruneOps.map((op, idx) => (
                    <motion.div
                      key={op.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03 }}
                      className="border px-4 py-3 flex items-center gap-4"
                      style={{ background: C.card, borderColor: C.border }}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: C.red }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] font-bold" style={{ color: C.red }}>
                            -{op.eventsPruned} events
                          </span>
                          <span className="text-[10px]" style={{ color: C.green }}>
                            {(op.spaceFreedKb / 1024).toFixed(2)} MB freed
                          </span>
                          <span className="text-[10px]" style={{ color: C.muted }}>
                            {op.durationMs}ms
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {op.eventTypes.map(t => (
                            <span key={t} className="text-[9px] px-1 py-0.5" style={{ color: C.muted, background: `${C.border}80` }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="text-[10px] shrink-0" style={{ color: C.muted }}>
                        {formatTimestamp(op.timestamp)}
                      </span>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ═══════════ Decay Visualization ═══════════ */}
            {activeTab === 'decay' && (
              <motion.div
                key="decay"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="text-[11px] mb-2" style={{ color: C.muted }}>
                  Data volume over time per event type. The red dashed line shows the minimum retention floor ({overview.minRetainCount} events).
                </div>

                <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                  <DecayChart eventTypes={eventTypes} minRetain={overview.minRetainCount} />
                </div>

                {/* Legend */}
                <div className="flex flex-wrap gap-3">
                  {eventTypes.map(et => (
                    <div key={et.type} className="flex items-center gap-1.5">
                      <div className="w-3 h-1" style={{ background: categoryColor(et.category) }} />
                      <span className="text-[10px]" style={{ color: C.muted }}>{et.type}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ═══════════ Event Explorer ═══════════ */}
            {activeTab === 'explorer' && (
              <motion.div
                key="explorer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                {/* Filters */}
                <div className="flex items-center gap-4">
                  <div>
                    <label className="text-[10px] uppercase block mb-1" style={{ color: C.muted }}>Type</label>
                    <select
                      value={explorerTypeFilter || ''}
                      onChange={e => {
                        const val = e.target.value || null;
                        setExplorerTypeFilter(val);
                        setEvents(generateMockEvents(val));
                      }}
                      className="px-3 py-1.5 text-xs rounded-none focus:outline-none"
                      style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
                    >
                      <option value="">All types</option>
                      {eventTypes.map(et => (
                        <option key={et.type} value={et.type}>{et.type}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase block mb-1" style={{ color: C.muted }}>Max Age (days)</label>
                    <input
                      type="number"
                      value={explorerAgeFilter ?? ''}
                      onChange={e => setExplorerAgeFilter(e.target.value ? Number(e.target.value) : null)}
                      placeholder="Any"
                      className="w-24 px-3 py-1.5 text-xs rounded-none focus:outline-none"
                      style={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
                    />
                  </div>
                  <div className="flex-1" />
                  <span className="text-[10px]" style={{ color: C.muted }}>
                    {filteredEvents.length} events
                  </span>
                </div>

                {/* Events List */}
                <div className="border overflow-hidden" style={{ borderColor: C.border }}>
                  <div
                    className="grid grid-cols-[60px_160px_160px_60px_80px_1fr] gap-2 px-4 py-2 text-[10px] uppercase"
                    style={{ background: C.card, color: C.muted, borderBottom: `1px solid ${C.border}` }}
                  >
                    <span>ID</span>
                    <span>Type</span>
                    <span>Timestamp</span>
                    <span>Age</span>
                    <span>Expires</span>
                    <span></span>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto">
                    {filteredEvents.map((event, idx) => {
                      const isExpanded = expandedEvent === event.id;
                      const ageRatio = event.ageDays / event.ttlDays;
                      const ageColor = ageRatio > 0.8 ? C.red : ageRatio > 0.5 ? C.yellow : C.green;

                      return (
                        <div key={event.id}>
                          <motion.button
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.015 }}
                            className="w-full text-left grid grid-cols-[60px_160px_160px_60px_80px_1fr] gap-2 px-4 py-2.5 transition-colors"
                            style={{
                              background: isExpanded ? `${C.border}40` : 'transparent',
                              borderBottom: `1px solid ${C.border}`,
                            }}
                            onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                          >
                            <span className="text-[10px] truncate" style={{ color: C.muted }}>{event.id.slice(0, 8)}</span>
                            <span className="text-[10px]" style={{ color: categoryColor(eventTypes.find(et => et.type === event.type)?.category || '') }}>
                              {event.type}
                            </span>
                            <span className="text-[10px]" style={{ color: C.text }}>{formatTimestamp(event.timestamp)}</span>
                            <span className="text-[10px]" style={{ color: ageColor }}>{event.ageDays}d</span>
                            <span className="text-[10px]" style={{ color: C.muted }}>{timeAgo(event.expiresAt)}</span>
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={e => { e.stopPropagation(); handleDeleteEvent(event.id); }}
                                className="text-[10px] px-2 py-0.5 border transition-colors hover:opacity-80"
                                style={{ color: C.red, borderColor: `${C.red}30`, background: `${C.red}08` }}
                              >
                                Delete
                              </button>
                              <span className="text-[10px]" style={{ color: C.muted }}>
                                {isExpanded ? '\u25B2' : '\u25BC'}
                              </span>
                            </div>
                          </motion.button>

                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                              >
                                <pre
                                  className="px-4 py-3 text-[10px] whitespace-pre-wrap"
                                  style={{ background: C.bg, color: C.cyan, borderBottom: `1px solid ${C.border}` }}
                                >
                                  {JSON.stringify(event.data, null, 2)}
                                </pre>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
