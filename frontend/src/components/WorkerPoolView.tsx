'use client';

/**
 * WorkerPoolView — Worker Colony Dashboard (GT-005)
 *
 * Grid/table showing all Gas Town workers from the MEOW system.
 * Polls /api/meow/workers/overview every 5s for aggregated worker data.
 * VOID AESTHETIC: bg-[#0a0e27], borders white/5, text white/87, font-mono.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type WorkerStatus = 'alive' | 'stale' | 'dead';
type WorkerRole = 'Mayor' | 'Polecat' | 'Crew' | 'Deacon' | 'Boot' | 'GUPP' | 'Witness' | 'Overseer' | 'Mail';
type Tier = 'S' | 'A' | 'B' | 'C';

interface Worker {
  id: string;
  name: string;
  role: WorkerRole;
  status: WorkerStatus;
  tier: Tier;
  assignment?: string;
  heartbeat?: string;
  cost: number;
  tasksCompleted: number;
  capabilities?: string[];
}

interface OverviewData {
  mayor?: Record<string, unknown>;
  polecats?: Record<string, unknown>[] | Record<string, unknown>;
  deacon?: Record<string, unknown>;
  witness?: Record<string, unknown>;
  boot?: Record<string, unknown>;
  gupp?: Record<string, unknown>;
  mail?: Record<string, unknown>;
  crew?: Record<string, unknown>[] | Record<string, unknown>;
  overseer?: Record<string, unknown>;
}

interface GuppStats {
  totalHooks?: number;
  activeHooks?: number;
  fired?: number;
  pending?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ROLES: WorkerRole[] = ['Mayor', 'Polecat', 'Crew', 'Deacon', 'Boot', 'GUPP', 'Witness', 'Overseer', 'Mail'];
const STATUSES: WorkerStatus[] = ['alive', 'stale', 'dead'];

const ROLE_COLORS: Record<WorkerRole, { bg: string; text: string; border: string }> = {
  Mayor:    { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30' },
  Polecat:  { bg: 'bg-red-500/15',    text: 'text-red-400',    border: 'border-red-500/30' },
  Crew:     { bg: 'bg-blue-500/15',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  Deacon:   { bg: 'bg-violet-500/15', text: 'text-violet-400', border: 'border-violet-500/30' },
  Boot:     { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  GUPP:     { bg: 'bg-cyan-500/15',   text: 'text-cyan-400',   border: 'border-cyan-500/30' },
  Witness:  { bg: 'bg-pink-500/15',   text: 'text-pink-400',   border: 'border-pink-500/30' },
  Overseer: { bg: 'bg-orange-500/15', text: 'text-orange-400', border: 'border-orange-500/30' },
  Mail:     { bg: 'bg-teal-500/15',   text: 'text-teal-400',   border: 'border-teal-500/30' },
};

const STATUS_INDICATOR: Record<WorkerStatus, { dot: string; pulse: boolean; label: string }> = {
  alive: { dot: 'bg-emerald-400', pulse: true,  label: 'Alive' },
  stale: { dot: 'bg-amber-400',   pulse: false, label: 'Stale' },
  dead:  { dot: 'bg-red-400',     pulse: false, label: 'Dead' },
};

const TIER_RING: Record<Tier, { border: string; glow: string }> = {
  S: { border: 'border-amber-400/40',  glow: 'shadow-[0_0_12px_rgba(251,191,36,0.2)]' },
  A: { border: 'border-violet-400/40', glow: 'shadow-[0_0_12px_rgba(167,139,250,0.2)]' },
  B: { border: 'border-blue-400/40',   glow: 'shadow-[0_0_12px_rgba(96,165,250,0.2)]' },
  C: { border: 'border-slate-400/40',  glow: 'shadow-[0_0_12px_rgba(148,163,184,0.15)]' },
};

const POLL_INTERVAL = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'future';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function inferStatus(entry: Record<string, unknown>): WorkerStatus {
  const s = (entry.status as string || '').toLowerCase();
  if (s === 'alive' || s === 'active' || s === 'healthy' || s === 'running') return 'alive';
  if (s === 'stale' || s === 'degraded' || s === 'idle') return 'stale';
  if (s === 'dead' || s === 'down' || s === 'stopped') return 'dead';
  // Infer from heartbeat age
  const hb = entry.heartbeat as string || entry.lastHeartbeat as string || entry.lastSeen as string;
  if (hb) {
    const age = Date.now() - new Date(hb).getTime();
    if (age > 300000) return 'dead';
    if (age > 60000) return 'stale';
  }
  return 'alive';
}

function inferTier(entry: Record<string, unknown>, role: WorkerRole): Tier {
  const t = (entry.tier as string || '').toUpperCase();
  if (t === 'S' || t === 'A' || t === 'B' || t === 'C') return t as Tier;
  if (role === 'Mayor' || role === 'Overseer') return 'S';
  if (role === 'Deacon' || role === 'Witness') return 'A';
  if (role === 'Polecat' || role === 'Crew') return 'B';
  return 'C';
}

function extractWorkerName(entry: Record<string, unknown>, fallback: string): string {
  return (entry.name as string) || (entry.id as string) || (entry.workerId as string) || fallback;
}

function extractWorkerId(entry: Record<string, unknown>, role: string, index: number): string {
  return (entry.id as string) || (entry.workerId as string) || `${role.toLowerCase()}-${index}`;
}

/** Build a unified worker list from the overview endpoint data. */
function buildWorkersFromOverview(data: OverviewData): Worker[] {
  const workers: Worker[] = [];

  const addSingle = (entry: Record<string, unknown> | undefined, role: WorkerRole, idx: number) => {
    if (!entry || typeof entry !== 'object') return;
    workers.push({
      id: extractWorkerId(entry, role, idx),
      name: extractWorkerName(entry, role),
      role,
      status: inferStatus(entry),
      tier: inferTier(entry, role),
      assignment: (entry.assignment as string) || (entry.currentTask as string) || undefined,
      heartbeat: (entry.heartbeat as string) || (entry.lastHeartbeat as string) || (entry.lastSeen as string) || undefined,
      cost: Number(entry.cost ?? entry.costAccumulated ?? 0),
      tasksCompleted: Number(entry.tasksCompleted ?? entry.completed ?? 0),
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities as string[] : undefined,
    });
  };

  const addGroup = (entries: unknown, role: WorkerRole) => {
    if (Array.isArray(entries)) {
      entries.forEach((e, i) => addSingle(e as Record<string, unknown>, role, i));
    } else if (entries && typeof entries === 'object') {
      addSingle(entries as Record<string, unknown>, role, 0);
    }
  };

  addGroup(data.mayor ? [data.mayor] : [], 'Mayor');
  addGroup(data.polecats, 'Polecat');
  addGroup(data.crew, 'Crew');
  addGroup(data.deacon ? [data.deacon] : [], 'Deacon');
  addGroup(data.boot ? [data.boot] : [], 'Boot');
  addGroup(data.gupp ? [data.gupp] : [], 'GUPP');
  addGroup(data.witness ? [data.witness] : [], 'Witness');
  addGroup(data.overseer ? [data.overseer] : [], 'Overseer');
  addGroup(data.mail ? [data.mail] : [], 'Mail');

  return workers;
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-[#0d1117] border border-white/5 rounded-none p-4 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 bg-white/5 rounded-none" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 bg-white/5 rounded-none" />
          <div className="h-2 w-16 bg-white/5 rounded-none" />
        </div>
      </div>
      <div className="h-6 w-full bg-white/5 rounded-none" />
    </div>
  );
}

// ─── Worker Card ────────────────────────────────────────────────────────────

function WorkerCard({
  worker,
  index,
  onClick,
}: {
  worker: Worker;
  index: number;
  onClick: () => void;
}) {
  const roleColor = ROLE_COLORS[worker.role] || ROLE_COLORS.Crew;
  const statusInd = STATUS_INDICATOR[worker.status] || STATUS_INDICATOR.alive;
  const tierRing = TIER_RING[worker.tier] || TIER_RING.C;

  return (
    <motion.button
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.35, ease: 'easeOut' }}
      whileHover={{ scale: 1.02, y: -1 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`
        relative w-full text-left font-mono
        bg-[#0d1117] border-2 rounded-none p-4
        transition-all duration-200 cursor-pointer
        hover:bg-[#111827] hover:border-white/10
        ${tierRing.border} ${tierRing.glow}
      `}
    >
      {/* Status indicator */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-white/30">
          {statusInd.label}
        </span>
        <div className={`w-2 h-2 rounded-full ${statusInd.dot}`}>
          {statusInd.pulse && (
            <div className={`absolute inset-0 w-2 h-2 rounded-full ${statusInd.dot} animate-ping opacity-40`} />
          )}
        </div>
      </div>

      {/* Name + Role */}
      <div className="flex items-center gap-2.5 mb-3 pr-16">
        <div className="w-8 h-8 flex items-center justify-center bg-white/[0.03] border border-white/5 rounded-none flex-shrink-0">
          <span className="text-sm">
            {worker.role === 'Mayor' ? '\u{1F451}' :
             worker.role === 'Polecat' ? '\u{1F43E}' :
             worker.role === 'Crew' ? '\u{1F41D}' :
             worker.role === 'Deacon' ? '\u{1F4DC}' :
             worker.role === 'Boot' ? '\u{1F462}' :
             worker.role === 'GUPP' ? '\u{1FA9D}' :
             worker.role === 'Witness' ? '\u{1F441}' :
             worker.role === 'Overseer' ? '\u{1F52D}' :
             worker.role === 'Mail' ? '\u{1F4EC}' : '\u{2699}'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold text-white/90 truncate">
            {worker.name}
          </div>
          <span
            className={`
              inline-block mt-0.5 px-1.5 py-0.5 text-[9px] uppercase tracking-wider
              border rounded-none
              ${roleColor.bg} ${roleColor.text} ${roleColor.border}
            `}
          >
            {worker.role}
          </span>
        </div>
      </div>

      {/* Tier badge */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[9px] uppercase tracking-widest text-white/30">Tier</span>
        <span
          className={`
            text-[10px] font-bold px-1.5 py-0.5 border rounded-none
            ${worker.tier === 'S' ? 'text-amber-400 border-amber-400/30 bg-amber-400/10' :
              worker.tier === 'A' ? 'text-violet-400 border-violet-400/30 bg-violet-400/10' :
              worker.tier === 'B' ? 'text-blue-400 border-blue-400/30 bg-blue-400/10' :
              'text-slate-400 border-slate-400/30 bg-slate-400/10'}
          `}
        >
          {worker.tier}
        </span>
      </div>

      {/* Assignment */}
      {worker.assignment && (
        <div className="mb-2">
          <span className="text-[9px] uppercase tracking-widest text-white/30">Task: </span>
          <span className="text-[10px] text-white/60 truncate">{worker.assignment}</span>
        </div>
      )}

      {/* Bottom stats row */}
      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-white/25">HB:</span>
          <span className="text-[10px] text-white/40 tabular-nums">
            {worker.heartbeat ? relativeTime(worker.heartbeat) : '--'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-white/25">$</span>
          <span className="text-[10px] text-white/50 tabular-nums">
            {worker.cost.toFixed(4)}
          </span>
        </div>
      </div>
    </motion.button>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function WorkerPoolView() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [guppStats, setGuppStats] = useState<GuppStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [poolCapacity, setPoolCapacity] = useState({ used: 0, total: 0 });

  // Filters
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [overviewRes, crewRes, polecatsRes, guppRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/workers/overview`, { signal }),
        fetch(`${API}/api/meow/crew`, { signal }),
        fetch(`${API}/api/meow/polecats`, { signal }),
        fetch(`${API}/api/meow/gupp/stats`, { signal }),
      ]);

      let allWorkers: Worker[] = [];

      // Build from overview (primary)
      if (overviewRes.status === 'fulfilled' && overviewRes.value.ok) {
        const data: OverviewData = await overviewRes.value.json();
        allWorkers = buildWorkersFromOverview(data);
      }

      // Supplement with crew endpoint if overview didn't provide crew
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const crewData = await crewRes.value.json();
        const crewArr = Array.isArray(crewData) ? crewData : (crewData.members || crewData.crew || []);
        const existingCrewIds = new Set(allWorkers.filter(w => w.role === 'Crew').map(w => w.id));
        crewArr.forEach((c: Record<string, unknown>, i: number) => {
          const wid = extractWorkerId(c, 'Crew', i + 100);
          if (!existingCrewIds.has(wid)) {
            allWorkers.push({
              id: wid,
              name: extractWorkerName(c, `Crew-${i}`),
              role: 'Crew',
              status: inferStatus(c),
              tier: inferTier(c, 'Crew'),
              assignment: (c.assignment as string) || (c.currentTask as string) || undefined,
              heartbeat: (c.heartbeat as string) || (c.lastHeartbeat as string) || undefined,
              cost: Number(c.cost ?? c.costAccumulated ?? 0),
              tasksCompleted: Number(c.tasksCompleted ?? c.completed ?? 0),
              capabilities: Array.isArray(c.capabilities) ? c.capabilities as string[] : undefined,
            });
          }
        });
      }

      // Supplement with polecats endpoint
      if (polecatsRes.status === 'fulfilled' && polecatsRes.value.ok) {
        const polecatData = await polecatsRes.value.json();
        const polecatArr = Array.isArray(polecatData) ? polecatData : (polecatData.polecats || []);
        const existingPolecatIds = new Set(allWorkers.filter(w => w.role === 'Polecat').map(w => w.id));
        polecatArr.forEach((p: Record<string, unknown>, i: number) => {
          const wid = extractWorkerId(p, 'Polecat', i + 100);
          if (!existingPolecatIds.has(wid)) {
            allWorkers.push({
              id: wid,
              name: extractWorkerName(p, `Polecat-${i}`),
              role: 'Polecat',
              status: inferStatus(p),
              tier: inferTier(p, 'Polecat'),
              assignment: (p.assignment as string) || (p.currentTask as string) || undefined,
              heartbeat: (p.heartbeat as string) || (p.lastHeartbeat as string) || undefined,
              cost: Number(p.cost ?? p.costAccumulated ?? 0),
              tasksCompleted: Number(p.tasksCompleted ?? p.completed ?? 0),
              capabilities: Array.isArray(p.capabilities) ? p.capabilities as string[] : undefined,
            });
          }
        });
      }

      // GUPP stats
      if (guppRes.status === 'fulfilled' && guppRes.value.ok) {
        const gs = await guppRes.value.json();
        setGuppStats(gs);
      }

      setWorkers(allWorkers);

      // Pool capacity
      const alive = allWorkers.filter(w => w.status === 'alive').length;
      const total = Math.max(allWorkers.length, alive);
      setPoolCapacity({ used: alive, total: total || 1 });

      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Worker Colony Offline');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Polling lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    abortRef.current = new AbortController();
    fetchData(abortRef.current.signal);
    return () => { abortRef.current?.abort(); };
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    intervalRef.current = setInterval(() => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetchData(ctrl.signal);
    }, POLL_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchData]);

  // ── Derived state ────────────────────────────────────────────────────────

  const filteredWorkers = useMemo(() => {
    return workers.filter((w) => {
      if (roleFilter !== 'all' && w.role !== roleFilter) return false;
      if (statusFilter !== 'all' && w.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          w.name.toLowerCase().includes(q) ||
          w.role.toLowerCase().includes(q) ||
          (w.assignment || '').toLowerCase().includes(q) ||
          w.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [workers, roleFilter, statusFilter, searchQuery]);

  const stats = useMemo(() => {
    const total = workers.length;
    const alive = workers.filter((w) => w.status === 'alive').length;
    const stale = workers.filter((w) => w.status === 'stale').length;
    const dead = workers.filter((w) => w.status === 'dead').length;
    const idle = workers.filter((w) => w.status === 'alive' && !w.assignment).length;
    return { total, alive, stale, dead, idle };
  }, [workers]);

  const capacityPct = poolCapacity.total > 0
    ? Math.round((poolCapacity.used / poolCapacity.total) * 100)
    : 0;

  // ── Worker detail dispatch ──────────────────────────────────────────────

  const openWorkerDetail = useCallback((workerId: string) => {
    window.dispatchEvent(
      new CustomEvent('open-worker-detail', { detail: { workerId } })
    );
  }, []);

  // ── Retry ──────────────────────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchData(ctrl.signal);
  }, [fetchData]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-[#0a0e27] font-mono text-white/[0.87] overflow-hidden">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <header className="flex-shrink-0 px-6 py-3 border-b border-white/5 bg-[#0a0e27]/80 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold tracking-[0.2em] uppercase text-white/90">
              Worker Colony
            </h1>
            <span className="text-[10px] px-2 py-0.5 bg-white/5 border border-white/10 text-white/40">
              MEOW Workers
            </span>
          </div>

          <div className="flex items-center gap-3">
            {guppStats && (
              <span className="text-[10px] text-cyan-400/60">
                GUPP: {guppStats.activeHooks ?? guppStats.totalHooks ?? 0} hooks
              </span>
            )}
            <button
              onClick={() => setAutoRefresh((p) => !p)}
              className={`
                text-[10px] uppercase tracking-widest px-3 py-1.5 border rounded-none
                transition-colors duration-200
                ${autoRefresh
                  ? 'border-emerald-500/20 text-emerald-400 bg-emerald-500/5'
                  : 'border-white/5 text-white/40 bg-transparent hover:text-white/60'}
              `}
            >
              {autoRefresh ? 'Live' : 'Paused'}
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-3 mb-3 overflow-x-auto">
          {[
            { label: 'Total', value: stats.total, color: 'text-white/80' },
            { label: 'Active', value: stats.alive, color: 'text-emerald-400' },
            { label: 'Idle', value: stats.idle, color: 'text-blue-400' },
            { label: 'Stale', value: stats.stale, color: 'text-amber-400' },
            { label: 'Dead', value: stats.dead, color: 'text-red-400' },
          ].map((s) => (
            <div
              key={s.label}
              className="px-3 py-2 bg-[#0d1117] border border-white/5 min-w-[80px]"
            >
              <div className="text-[9px] uppercase tracking-widest text-white/30">{s.label}</div>
              <div className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Search workers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#0d1117] border border-white/10
              text-white/90 placeholder-white/30 w-56
              focus:outline-none focus:border-white/20 rounded-none"
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-2 py-1.5 text-xs bg-[#0d1117] border border-white/10 text-white/70 rounded-none"
          >
            <option value="all">All Roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1.5 text-xs bg-[#0d1117] border border-white/10 text-white/70 rounded-none"
          >
            <option value="all">All Statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <button
            onClick={handleRetry}
            className="px-2 py-1.5 text-xs text-white/40 hover:text-white/70
              border border-white/10 bg-[#0d1117] rounded-none transition-colors"
          >
            Refresh
          </button>
          <span className="text-[10px] text-white/20 ml-auto tabular-nums">
            {filteredWorkers.length} / {workers.length} shown
          </span>
        </div>
      </header>

      {/* ── Grid ──────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto p-6">
        {error ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center h-full gap-4"
          >
            <div className="text-4xl opacity-30">{'\u{1F3ED}'}</div>
            <div className="text-sm text-red-400/80 font-mono uppercase tracking-widest">
              {error}
            </div>
            <p className="text-xs text-white/30 max-w-xs text-center">
              Unable to reach the MEOW workers overview endpoint. Check that the orchestrator is
              running.
            </p>
            <button
              onClick={handleRetry}
              className="mt-2 text-[10px] uppercase tracking-widest px-4 py-2
                border border-white/10 hover:border-white/20 text-white/60
                hover:text-white/90 rounded-none transition-colors"
            >
              Retry Connection
            </button>
          </motion.div>
        ) : loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : filteredWorkers.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center h-64 gap-3"
          >
            <div className="text-3xl opacity-20">{'\u{1F41D}'}</div>
            <div className="text-xs text-white/30 uppercase tracking-wider">
              No workers match current filters
            </div>
          </motion.div>
        ) : (
          <AnimatePresence mode="popLayout">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredWorkers.map((worker, index) => (
                <WorkerCard
                  key={worker.id}
                  worker={worker}
                  index={index}
                  onClick={() => openWorkerDetail(worker.id)}
                />
              ))}
            </div>
          </AnimatePresence>
        )}
      </main>

      {/* ── Pool Capacity Bar ──────────────────────────────────────────── */}
      <footer className="flex-shrink-0 px-6 py-3 border-t border-white/5 bg-[#0a0e27]/80 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-widest text-white/30">
            Pool Capacity
          </span>
          <span className="text-[10px] text-white/40 tabular-nums">
            {poolCapacity.used} / {poolCapacity.total} active
          </span>
        </div>
        <div className="w-full h-2 bg-white/5 rounded-none overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${capacityPct}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className={`h-full rounded-none ${
              capacityPct >= 90
                ? 'bg-red-500/60'
                : capacityPct >= 70
                ? 'bg-amber-500/60'
                : 'bg-emerald-500/60'
            }`}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <div className="flex items-center gap-4">
            {(['alive', 'stale', 'dead'] as WorkerStatus[]).map((s) => (
              <div key={s} className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${STATUS_INDICATOR[s].dot}`} />
                <span className="text-[9px] text-white/25 uppercase">{s}</span>
              </div>
            ))}
          </div>
          <span className="text-[10px] text-white/20 tabular-nums">{capacityPct}%</span>
        </div>
      </footer>
    </div>
  );
}
