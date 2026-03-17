'use client';

/**
 * ObservabilityTowerView — GT-034: Observability Dashboard
 *
 * Main monitoring view: KPI cards, cost/error/completion charts (CSS-based),
 * filtering by molecule/worker/skill/time, live data badge.
 * Ayu Dark aesthetic: bg-[#0f1419], borders [#2d363f], text [#e6e1cf], font-mono.
 * Polls /api/meow/observability/stats every 6s.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ObservabilityStats {
  totalSpans: number;
  costBurnRate: number;
  errorRate: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  moleculeCompletionRate: number;
  activeMolecules: number;
  activeWorkers: number;
  costTimeline: { ts: string; value: number }[];
  errorTimeline: { ts: string; value: number }[];
  completionTimeline: { ts: string; value: number }[];
}

type TimeRange = '1h' | '6h' | '24h' | '7d';

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 6000;

// ─── Fallback ───────────────────────────────────────────────────────────────

function generateTimeline(count: number, baseFn: (i: number) => number): { ts: string; value: number }[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(now - (count - i) * 300000).toISOString(),
    value: baseFn(i),
  }));
}

const FALLBACK_STATS: ObservabilityStats = {
  totalSpans: 14832,
  costBurnRate: 2.47,
  errorRate: 0.032,
  latencyP50: 120,
  latencyP95: 450,
  latencyP99: 1200,
  moleculeCompletionRate: 0.89,
  activeMolecules: 7,
  activeWorkers: 4,
  costTimeline: generateTimeline(24, i => 1.5 + Math.sin(i * 0.3) * 0.8 + Math.random() * 0.4),
  errorTimeline: generateTimeline(24, i => 0.02 + Math.sin(i * 0.5) * 0.015 + Math.random() * 0.01),
  completionTimeline: generateTimeline(24, i => 0.8 + Math.sin(i * 0.2) * 0.1 + Math.random() * 0.05),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(v: number): string {
  return `$${v.toFixed(2)}`;
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch { return '??'; }
}

// ─── MiniChart Component ────────────────────────────────────────────────────

function MiniChart({
  data,
  color,
  label,
  formatter,
  height = 100,
}: {
  data: { ts: string; value: number }[];
  color: string;
  label: string;
  formatter: (v: number) => string;
  height?: number;
}) {
  const safeData = data ?? [];
  const max = safeData.length > 0 ? Math.max(...safeData.map(d => d.value), 0.001) : 0.001;
  const min = safeData.length > 0 ? Math.min(...safeData.map(d => d.value)) : 0;
  const range = max - min || 1;
  const latest = safeData.length > 0 ? safeData[safeData.length - 1]?.value ?? 0 : 0;

  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] text-[#4a5159] uppercase tracking-wider">{label}</div>
        <div className={`text-sm font-bold ${color}`}>{formatter(latest)}</div>
      </div>
      <div className="flex items-end gap-px" style={{ height: `${height}px` }}>
        {safeData.map((point, i) => {
          const h = ((point.value - min) / range) * height;
          return (
            <div
              key={i}
              className="flex-1 group relative"
              style={{ height: `${height}px` }}
            >
              <div className="absolute bottom-0 w-full flex flex-col items-center">
                <div
                  className={`w-full ${color.replace('text-', 'bg-').replace('400', '500/30')} border-t ${color.replace('text-', 'border-').replace('400', '500/50')}`}
                  style={{ height: `${Math.max(1, h)}px` }}
                />
              </div>
              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
                <div className="bg-[#0f1419] border border-[#2d363f] rounded-none px-2 py-1 text-[9px] text-[#6c7680] whitespace-nowrap">
                  {formatter(point.value)} {formatTime(point.ts)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Time axis */}
      <div className="flex justify-between mt-1">
        <span className="text-[8px] text-[#4a5159]">{safeData.length > 0 ? formatTime(safeData[0].ts) : ''}</span>
        <span className="text-[8px] text-[#4a5159]">{safeData.length > 0 ? formatTime(safeData[safeData.length - 1].ts) : ''}</span>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ObservabilityTowerView() {
  const [stats, setStats] = useState<ObservabilityStats>(FALLBACK_STATS);
  const [connected, setConnected] = useState(false);
  const [timeRange, setTimeRange] = useState<TimeRange>('6h');
  const [filterMolecule, setFilterMolecule] = useState('');
  const [filterWorker, setFilterWorker] = useState('');
  const [filterSkill, setFilterSkill] = useState('');
  const [lastUpdate, setLastUpdate] = useState<string>(new Date().toISOString());
  const abortRef = useRef<AbortController | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (timeRange) params.set('range', timeRange);
      if (filterMolecule) params.set('molecule', filterMolecule);
      if (filterWorker) params.set('worker', filterWorker);
      if (filterSkill) params.set('skill', filterSkill);

      const res = await fetch(`${API}/api/meow/observability/stats?${params}`, { signal });
      if (res.ok) {
        const data = await res.json();
        setStats(prev => ({ ...prev, ...data }));
        setLastUpdate(new Date().toISOString());
      }
      setConnected(true);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setConnected(false);
    }
  }, [timeRange, filterMolecule, filterWorker, filterSkill]);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    fetchData(ac.signal);
    const iv = setInterval(() => fetchData(ac.signal), POLL_INTERVAL);
    return () => { ac.abort(); clearInterval(iv); };
  }, [fetchData]);

  // ─── KPIs ───────────────────────────────────────────────────────────────

  const kpis = useMemo(() => [
    { label: 'Total Spans', value: stats.totalSpans.toLocaleString(), color: 'text-cyan-400' },
    { label: 'Cost Burn $/hr', value: formatCost(stats.costBurnRate), color: stats.costBurnRate > 5 ? 'text-red-400' : 'text-emerald-400' },
    { label: 'Error Rate', value: formatPct(stats.errorRate), color: stats.errorRate > 0.05 ? 'text-red-400' : 'text-emerald-400' },
    { label: 'Latency P50', value: formatMs(stats.latencyP50), color: 'text-[#6c7680]' },
    { label: 'Latency P95', value: formatMs(stats.latencyP95), color: stats.latencyP95 > 500 ? 'text-amber-400' : 'text-[#6c7680]' },
    { label: 'Latency P99', value: formatMs(stats.latencyP99), color: stats.latencyP99 > 2000 ? 'text-red-400' : 'text-[#6c7680]' },
    { label: 'Active Molecules', value: stats.activeMolecules, color: 'text-violet-400' },
    { label: 'Active Workers', value: stats.activeWorkers, color: 'text-amber-400' },
  ], [stats]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{'\u{1F3EF}'}</span>
          <div>
            <h1 className="text-lg font-bold tracking-wide">OBSERVABILITY TOWER</h1>
            <p className="text-xs text-[#4a5159]">GT-034 // System-wide monitoring dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {connected && (
            <motion.span
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-none"
            >
              LIVE
            </motion.span>
          )}
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-[10px] text-[#4a5159]">Updated {formatTime(lastUpdate)}</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(['1h', '6h', '24h', '7d'] as const).map(r => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={`px-3 py-1 text-[10px] uppercase tracking-wider border rounded-none transition-colors ${
                timeRange === r
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400'
                  : 'border-[#2d363f] bg-[#1a1f26] text-[#4a5159] hover:text-[#6c7680]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={filterMolecule}
          onChange={e => setFilterMolecule(e.target.value)}
          placeholder="Molecule..."
          className="bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-1 text-xs text-[#6c7680] placeholder:text-[#4a5159] outline-none focus:border-cyan-500/30 w-36"
        />
        <input
          type="text"
          value={filterWorker}
          onChange={e => setFilterWorker(e.target.value)}
          placeholder="Worker..."
          className="bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-1 text-xs text-[#6c7680] placeholder:text-[#4a5159] outline-none focus:border-cyan-500/30 w-36"
        />
        <input
          type="text"
          value={filterSkill}
          onChange={e => setFilterSkill(e.target.value)}
          placeholder="Skill..."
          className="bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-1 text-xs text-[#6c7680] placeholder:text-[#4a5159] outline-none focus:border-cyan-500/30 w-36"
        />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpis.map((kpi, i) => (
          <motion.div
            key={kpi.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className="bg-[#1a1f26] border border-[#2d363f] p-4 rounded-none"
          >
            <div className="text-[10px] text-[#4a5159] uppercase tracking-wider">{kpi.label}</div>
            <div className={`text-2xl font-bold mt-1 ${kpi.color}`}>{kpi.value}</div>
          </motion.div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <MiniChart
          data={stats.costTimeline}
          color="text-amber-400"
          label="Cost Over Time ($/hr)"
          formatter={formatCost}
          height={120}
        />
        <MiniChart
          data={stats.errorTimeline}
          color="text-red-400"
          label="Error Rate Trend"
          formatter={formatPct}
          height={120}
        />
        <MiniChart
          data={stats.completionTimeline}
          color="text-emerald-400"
          label="Molecule Completion Rate"
          formatter={formatPct}
          height={120}
        />
      </div>

      {/* Completion Rate Summary */}
      <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
        <div className="text-[10px] text-[#4a5159] uppercase tracking-wider mb-3">Molecule Completion</div>
        <div className="h-2 bg-[#2d363f]/30 rounded-none overflow-hidden">
          <motion.div
            className="h-full bg-emerald-400/50"
            initial={{ width: 0 }}
            animate={{ width: `${stats.moleculeCompletionRate * 100}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
        <div className="flex justify-between mt-2">
          <span className="text-xs text-[#4a5159]">{formatPct(stats.moleculeCompletionRate)} completed</span>
          <span className="text-xs text-[#4a5159]">{stats.activeMolecules} active molecules</span>
        </div>
      </div>

      {/* Latency Distribution */}
      <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
        <div className="text-[10px] text-[#4a5159] uppercase tracking-wider mb-4">Latency Distribution</div>
        <div className="flex items-end gap-6">
          {[
            { label: 'P50', value: stats.latencyP50, color: 'bg-cyan-500/40' },
            { label: 'P95', value: stats.latencyP95, color: 'bg-amber-500/40' },
            { label: 'P99', value: stats.latencyP99, color: 'bg-red-500/40' },
          ].map(p => {
            const maxVal = Math.max(stats.latencyP99, 1);
            const h = (p.value / maxVal) * 80;
            return (
              <div key={p.label} className="flex flex-col items-center gap-1 flex-1">
                <span className="text-xs text-[#6c7680]">{formatMs(p.value)}</span>
                <div className={`w-full ${p.color} rounded-none`} style={{ height: `${Math.max(4, h)}px` }} />
                <span className="text-[10px] text-[#4a5159]">{p.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
