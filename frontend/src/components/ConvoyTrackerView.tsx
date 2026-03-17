'use client';

/**
 * ConvoyTrackerView — GT-015: Visual work-order bundle tracker
 *
 * Convoys bundle beads (tasks) into work-orders dispatched by the Mayor.
 * Horizontal swim-lane pipeline showing convoy lifecycle stages.
 * VOID AESTHETIC: bg-[#0a0e17], border-white/5, text-white/[0.87], font-mono, rounded-none.
 * Polls GET /api/meow/convoys every 5s.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type ConvoyStatus = 'assembling' | 'dispatched' | 'in_progress' | 'delivered' | 'failed';

interface Convoy {
  id: string;
  name: string;
  status: ConvoyStatus;
  beadIds: string[];
  moleculeIds: string[];
  createdBy: string;
  assignedRig?: string;
  progress: number;
  createdAt: string;
  dispatchedAt?: string;
  deliveredAt?: string;
}

interface Bead {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5000;

const STAGES: { key: ConvoyStatus; label: string }[] = [
  { key: 'assembling', label: 'Assembling' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'delivered', label: 'Delivered' },
];

const STATUS_COLORS: Record<ConvoyStatus, { dot: string; border: string; bg: string; text: string; glow: string }> = {
  assembling:  { dot: 'bg-blue-400',    border: 'border-blue-500/30',    bg: 'bg-blue-500/10',    text: 'text-blue-400',    glow: 'shadow-[0_0_12px_rgba(59,130,246,0.15)]' },
  dispatched:  { dot: 'bg-amber-400',   border: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-400',   glow: 'shadow-[0_0_12px_rgba(245,158,11,0.15)]' },
  in_progress: { dot: 'bg-cyan-400',    border: 'border-cyan-500/30',    bg: 'bg-cyan-500/10',    text: 'text-cyan-400',    glow: 'shadow-[0_0_12px_rgba(6,182,212,0.15)]' },
  delivered:   { dot: 'bg-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400', glow: 'shadow-[0_0_12px_rgba(52,211,153,0.15)]' },
  failed:      { dot: 'bg-red-400',     border: 'border-red-500/30',     bg: 'bg-red-500/10',     text: 'text-red-400',     glow: 'shadow-[0_0_12px_rgba(239,68,68,0.15)]' },
};

const PRIORITY_BADGE: Record<string, string> = {
  p0: 'bg-red-500/20 text-red-400 border-red-500/30',
  p1: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  p2: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  p3: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch { return iso; }
}

function stageIndex(status: ConvoyStatus): number {
  const idx = STAGES.findIndex(s => s.key === status);
  return idx >= 0 ? idx : -1;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ConvoyTrackerView() {
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [beadCache, setBeadCache] = useState<Record<string, Bead>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState<ConvoyStatus | 'all'>('all');
  const [filterRig, setFilterRig] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Detail panel
  const [selectedConvoy, setSelectedConvoy] = useState<Convoy | null>(null);
  const [detailBeads, setDetailBeads] = useState<Bead[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRig, setNewRig] = useState('');
  const [selectedBeadIds, setSelectedBeadIds] = useState<string[]>([]);
  const [availableBeads, setAvailableBeads] = useState<Bead[]>([]);
  const [beadSearch, setBeadSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [dispatching, setDispatching] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch Convoys ──────────────────────────────────────────────────────

  const fetchConvoys = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/convoys?limit=50`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data?.convoys) ? data.convoys : Array.isArray(data) ? data : [];
      setConvoys(list);
      setDataSource(data.source || 'db');
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Failed to load convoys');
      setDataSource('mock');
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Fetch Beads for Detail ─────────────────────────────────────────────

  const fetchConvoyBeads = useCallback(async (beadIds: string[]) => {
    if (beadIds.length === 0) { setDetailBeads([]); return; }
    setLoadingDetail(true);
    try {
      const res = await fetch(`${API}/api/beads?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all: Bead[] = Array.isArray(data?.beads) ? data.beads : Array.isArray(data) ? data : [];
      const idSet = new Set(beadIds);
      const matched = all.filter(b => idSet.has(b.id));
      setDetailBeads(matched);
      // Cache beads
      const cache: Record<string, Bead> = {};
      all.forEach(b => { cache[b.id] = b; });
      setBeadCache(prev => ({ ...prev, ...cache }));
    } catch {
      setDetailBeads([]);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // ─── Fetch Available Beads for Create ───────────────────────────────────

  const fetchAvailableBeads = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/beads?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAvailableBeads(Array.isArray(data?.beads) ? data.beads : Array.isArray(data) ? data : []);
    } catch {
      setAvailableBeads([]);
    }
  }, []);

  // ─── Polling Lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    fetchConvoys(ac.signal);
    return () => { ac.abort(); };
  }, [fetchConvoys]);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const ac = new AbortController();
      abortRef.current = ac;
      fetchConvoys(ac.signal);
    }, POLL_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchConvoys]);

  // Load detail beads when convoy selected
  useEffect(() => {
    if (selectedConvoy) fetchConvoyBeads(selectedConvoy.beadIds);
  }, [selectedConvoy, fetchConvoyBeads]);

  // Load available beads when create modal opens
  useEffect(() => {
    if (showCreate) fetchAvailableBeads();
  }, [showCreate, fetchAvailableBeads]);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCreate) setShowCreate(false);
        else if (selectedConvoy) setSelectedConvoy(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showCreate, selectedConvoy]);

  // ─── Actions ────────────────────────────────────────────────────────────

  const dispatchConvoy = async (convoyId: string) => {
    setDispatching(convoyId);
    try {
      const res = await fetch(`${API}/api/meow/mayor/convoy/${convoyId}/dispatch`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConvoys(prev => prev.map(c => c.id === convoyId ? { ...c, status: 'dispatched' as ConvoyStatus, dispatchedAt: new Date().toISOString() } : c));
      if (selectedConvoy?.id === convoyId) {
        setSelectedConvoy(prev => prev ? { ...prev, status: 'dispatched', dispatchedAt: new Date().toISOString() } : null);
      }
    } catch (err) {
      console.error('[ConvoyTracker] dispatch failed:', err);
    } finally {
      setDispatching(null);
    }
  };

  const createConvoy = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/meow/mayor/convoy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          beadIds: selectedBeadIds,
          assignedRig: newRig.trim() || undefined,
          createdBy: 'hive-os',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Auto-dispatch after creation
      if (data.id || data.convoy?.id) {
        const id = data.id || data.convoy?.id;
        await dispatchConvoy(id);
      }
      // Reset form
      setNewName('');
      setNewRig('');
      setSelectedBeadIds([]);
      setBeadSearch('');
      setShowCreate(false);
      fetchConvoys();
    } catch (err) {
      console.error('[ConvoyTracker] create failed:', err);
    } finally {
      setCreating(false);
    }
  };

  // ─── Derived Data ───────────────────────────────────────────────────────

  const allRigs = useMemo(() => [...new Set(convoys.map(c => c.assignedRig).filter(Boolean))] as string[], [convoys]);

  const filtered = useMemo(() => {
    return convoys.filter(c => {
      if (filterStatus !== 'all' && c.status !== filterStatus) return false;
      if (filterRig !== 'all' && c.assignedRig !== filterRig) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [convoys, filterStatus, filterRig, searchQuery]);

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    return {
      total: convoys.length,
      assembling: convoys.filter(c => c.status === 'assembling').length,
      inProgress: convoys.filter(c => c.status === 'in_progress').length,
      deliveredToday: convoys.filter(c => c.status === 'delivered' && c.deliveredAt && new Date(c.deliveredAt).toDateString() === today).length,
      failed: convoys.filter(c => c.status === 'failed').length,
    };
  }, [convoys]);

  const filteredAvailableBeads = useMemo(() => {
    if (!beadSearch.trim()) return availableBeads;
    const q = beadSearch.toLowerCase();
    return availableBeads.filter(b => b.title.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
  }, [availableBeads, beadSearch]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-[#0a0e17] font-mono text-white/[0.87] overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex-none px-6 py-4 border-b border-white/5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold tracking-[0.15em] uppercase text-white/90">Convoy Tracker</h1>
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Work-Order Bundles</span>
            {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-none">LIVE</span>}
            {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-none">OFFLINE</span>}
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-1.5 text-xs bg-white/5 border border-white/10 hover:bg-white/10 transition-colors rounded-none"
          >
            + New Convoy
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex gap-3 mb-4 overflow-x-auto">
          {[
            { label: 'Total', value: stats.total, color: 'text-white/80' },
            { label: 'Assembling', value: stats.assembling, color: 'text-blue-400' },
            { label: 'In Progress', value: stats.inProgress, color: 'text-cyan-400' },
            { label: 'Delivered Today', value: stats.deliveredToday, color: 'text-emerald-400' },
            { label: 'Failed', value: stats.failed, color: 'text-red-400' },
          ].map(s => (
            <div key={s.label} className="px-3 py-2 bg-[#080b14] border border-white/5 min-w-[110px] rounded-none">
              <div className="text-[10px] text-white/40 uppercase tracking-wider">{s.label}</div>
              <div className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Search convoys..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#080b14] border border-white/10 text-white/90 placeholder-white/30 w-56 focus:outline-none focus:border-white/20 rounded-none"
          />
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as ConvoyStatus | 'all')} className="px-2 py-1.5 text-xs bg-[#080b14] border border-white/10 text-white/70 rounded-none">
            <option value="all">All Status</option>
            <option value="assembling">Assembling</option>
            <option value="dispatched">Dispatched</option>
            <option value="in_progress">In Progress</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
          </select>
          <select value={filterRig} onChange={e => setFilterRig(e.target.value)} className="px-2 py-1.5 text-xs bg-[#080b14] border border-white/10 text-white/70 rounded-none">
            <option value="all">All Rigs</option>
            {allRigs.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={() => fetchConvoys()} className="px-2 py-1.5 text-xs text-white/40 hover:text-white/70 border border-white/10 bg-[#080b14] rounded-none">
            Refresh
          </button>
        </div>
      </header>

      {/* ── Pipeline (swim lanes) ──────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && !loading && convoys.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center h-full gap-4"
          >
            <div className="text-sm text-red-400/80 font-mono uppercase tracking-widest">{error}</div>
            <p className="text-xs text-white/30 max-w-xs text-center">Unable to reach convoy endpoint. Check the orchestrator.</p>
            <button onClick={() => { setLoading(true); fetchConvoys(); }} className="text-[10px] uppercase tracking-widest px-4 py-2 border border-white/10 hover:border-white/20 text-white/60 rounded-none">
              Retry
            </button>
          </motion.div>
        ) : loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 bg-[#080b14] border border-white/5 animate-pulse rounded-none" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-white/30">
            <div className="text-4xl opacity-20">&#x1F69B;</div>
            <div className="text-xs uppercase tracking-widest">No convoys found</div>
            <p className="text-[10px] text-white/20">Create a convoy to bundle beads into work-orders.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Stage header row */}
            <div className="flex items-center gap-0 mb-2 px-44">
              {STAGES.map((stage, i) => (
                <div key={stage.key} className="flex-1 flex items-center">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-none ${STATUS_COLORS[stage.key].dot}`} />
                    <span className="text-[10px] uppercase tracking-wider text-white/40">{stage.label}</span>
                  </div>
                  {i < STAGES.length - 1 && <div className="flex-1 h-px bg-white/[0.06] mx-3" />}
                </div>
              ))}
            </div>

            {/* Convoy lanes */}
            <AnimatePresence>
              {filtered.map((convoy, idx) => {
                const colors = STATUS_COLORS[convoy.status];
                const currentIdx = stageIndex(convoy.status);
                const isFailed = convoy.status === 'failed';

                return (
                  <motion.div
                    key={convoy.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ delay: idx * 0.04, duration: 0.3 }}
                    onClick={() => setSelectedConvoy(convoy)}
                    className={`
                      relative bg-[#080b14] border rounded-none p-4 cursor-pointer
                      transition-all duration-200 hover:border-white/10
                      ${selectedConvoy?.id === convoy.id ? 'border-white/20 bg-white/[0.02]' : 'border-white/5'}
                      ${colors.glow}
                    `}
                  >
                    <div className="flex items-start gap-4">
                      {/* Left: convoy info */}
                      <div className="w-40 flex-shrink-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-1.5 py-0.5 text-[10px] border rounded-none ${colors.bg} ${colors.text} ${colors.border}`}>
                            {convoy.status.replace('_', ' ').toUpperCase()}
                          </span>
                        </div>
                        <div className="text-sm text-white/90 font-bold truncate mb-1">{convoy.name}</div>
                        <div className="text-[10px] text-white/30 font-mono">{convoy.id.slice(0, 12)}</div>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-[10px] text-white/40">{convoy.beadIds.length} beads</span>
                          <span className="text-[10px] text-white/20">|</span>
                          <span className="text-[10px] text-white/40">{convoy.moleculeIds.length} mol</span>
                          {convoy.assignedRig && (
                            <>
                              <span className="text-[10px] text-white/20">|</span>
                              <span className="text-[10px] text-cyan-400/60">{convoy.assignedRig}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Center: stage pipeline visualization */}
                      <div className="flex-1 flex items-center gap-0 min-w-0">
                        {STAGES.map((stage, i) => {
                          const isCompleted = !isFailed && currentIdx > i;
                          const isCurrent = !isFailed && currentIdx === i;
                          const isPending = !isFailed && currentIdx < i;
                          const stageColors = STATUS_COLORS[stage.key];

                          return (
                            <div key={stage.key} className="flex-1 flex items-center">
                              {/* Node */}
                              <div className={`
                                relative w-8 h-8 flex items-center justify-center border rounded-none flex-shrink-0
                                ${isCompleted ? 'bg-emerald-500/20 border-emerald-500/30' :
                                  isCurrent ? `${stageColors.bg} ${stageColors.border}` :
                                  isFailed && currentIdx === i ? 'bg-red-500/20 border-red-500/30' :
                                  'bg-white/[0.02] border-white/5'}
                              `}>
                                {isCompleted && <span className="text-emerald-400 text-xs">&#10003;</span>}
                                {isCurrent && (
                                  <>
                                    <div className={`w-2.5 h-2.5 rounded-none ${stageColors.dot}`} />
                                    <motion.div
                                      className={`absolute inset-0 border rounded-none ${stageColors.border}`}
                                      animate={{ opacity: [0.3, 0.8, 0.3] }}
                                      transition={{ duration: 2, repeat: Infinity }}
                                    />
                                  </>
                                )}
                                {isFailed && currentIdx === i && <span className="text-red-400 text-xs">&#x2717;</span>}
                                {isPending && <div className="w-1.5 h-1.5 rounded-none bg-white/10" />}
                              </div>
                              {/* Connector line */}
                              {i < STAGES.length - 1 && (
                                <div className={`flex-1 h-px mx-1 ${
                                  isCompleted ? 'bg-emerald-500/30' :
                                  isCurrent ? `${stageColors.dot} opacity-30` :
                                  'bg-white/[0.06]'
                                }`} />
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Right: progress + time */}
                      <div className="w-28 flex-shrink-0 text-right">
                        <div className="text-xs tabular-nums text-white/60 mb-1">{convoy.progress}%</div>
                        <div className="w-full h-1.5 bg-white/5 rounded-none overflow-hidden">
                          <motion.div
                            className={`h-full rounded-none ${
                              isFailed ? 'bg-red-500/60' :
                              convoy.status === 'delivered' ? 'bg-emerald-500/60' :
                              'bg-cyan-500/40'
                            }`}
                            initial={{ width: 0 }}
                            animate={{ width: `${convoy.progress}%` }}
                            transition={{ duration: 0.6, ease: 'easeOut' }}
                          />
                        </div>
                        <div className="text-[10px] text-white/25 mt-1.5 tabular-nums">
                          {relativeTime(convoy.createdAt)}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ── Detail Panel (slide-over) ──────────────────────────────────── */}
      <AnimatePresence>
        {selectedConvoy && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="fixed inset-y-0 right-0 w-[440px] bg-[#0a0e17] border-l border-white/5 z-50 flex flex-col overflow-hidden shadow-2xl"
          >
            {/* Header */}
            <div className="flex-none px-5 py-4 border-b border-white/5 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-white/70 uppercase tracking-wider">Convoy Detail</span>
                <div className="text-[10px] text-white/30 font-mono mt-0.5">{selectedConvoy.id}</div>
              </div>
              <button onClick={() => setSelectedConvoy(null)} className="text-white/30 hover:text-white/60 text-sm">X</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Name + status */}
              <div>
                <div className="text-sm font-bold text-white/90 mb-2">{selectedConvoy.name}</div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 text-[10px] border rounded-none ${STATUS_COLORS[selectedConvoy.status].bg} ${STATUS_COLORS[selectedConvoy.status].text} ${STATUS_COLORS[selectedConvoy.status].border}`}>
                    {selectedConvoy.status.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="text-xs text-white/40 tabular-nums">{selectedConvoy.progress}% complete</span>
                </div>
              </div>

              {/* Metadata grid */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-white/30 uppercase mb-1">Created By</div>
                  <div className="text-xs text-white/60">{selectedConvoy.createdBy}</div>
                </div>
                {selectedConvoy.assignedRig && (
                  <div>
                    <div className="text-[10px] text-white/30 uppercase mb-1">Assigned Rig</div>
                    <div className="text-xs text-cyan-400/80">{selectedConvoy.assignedRig}</div>
                  </div>
                )}
                <div>
                  <div className="text-[10px] text-white/30 uppercase mb-1">Beads</div>
                  <div className="text-xs text-white/60">{selectedConvoy.beadIds.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-white/30 uppercase mb-1">Molecules</div>
                  <div className="text-xs text-white/60">{selectedConvoy.moleculeIds.length}</div>
                </div>
              </div>

              {/* Timeline */}
              <div>
                <div className="text-[10px] text-white/30 uppercase mb-3">Timeline</div>
                <div className="relative pl-6 space-y-3">
                  <div className="absolute left-2 top-1 bottom-1 w-px bg-white/10" />
                  {[
                    { label: 'Created', ts: selectedConvoy.createdAt, active: true },
                    { label: 'Dispatched', ts: selectedConvoy.dispatchedAt, active: !!selectedConvoy.dispatchedAt },
                    { label: 'In Progress', ts: selectedConvoy.status === 'in_progress' ? selectedConvoy.dispatchedAt : undefined, active: stageIndex(selectedConvoy.status) >= 2 },
                    { label: 'Delivered', ts: selectedConvoy.deliveredAt, active: !!selectedConvoy.deliveredAt },
                  ].map((evt, i) => (
                    <div key={i} className="relative flex items-start gap-3">
                      <div className={`absolute left-[-16px] top-1 w-2.5 h-2.5 rounded-none border ${
                        evt.active ? 'bg-emerald-500/30 border-emerald-500/40' : 'bg-white/5 border-white/10'
                      }`} />
                      <div>
                        <div className={`text-xs ${evt.active ? 'text-white/70' : 'text-white/25'}`}>{evt.label}</div>
                        {evt.ts && <div className="text-[10px] text-white/30 tabular-nums">{formatTimestamp(evt.ts)}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Beads list */}
              <div>
                <div className="text-[10px] text-white/30 uppercase mb-2">Beads ({selectedConvoy.beadIds.length})</div>
                {loadingDetail ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-10 bg-white/[0.02] border border-white/5 animate-pulse rounded-none" />
                    ))}
                  </div>
                ) : detailBeads.length === 0 ? (
                  <div className="text-xs text-white/20 italic">No beads loaded</div>
                ) : (
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {detailBeads.map(bead => (
                      <div key={bead.id} className="flex items-center justify-between px-3 py-2 bg-white/[0.02] border border-white/5 rounded-none">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-white/80 truncate">{bead.title}</div>
                          <div className="text-[10px] text-white/30 font-mono">{bead.id.slice(0, 10)}</div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                          {bead.priority && (
                            <span className={`px-1.5 py-0.5 text-[10px] border rounded-none ${PRIORITY_BADGE[bead.priority] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}`}>
                              {bead.priority.toUpperCase()}
                            </span>
                          )}
                          <span className={`px-1.5 py-0.5 text-[10px] border rounded-none ${
                            bead.status === 'done' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                            bead.status === 'in_progress' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                            'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
                          }`}>
                            {bead.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Molecules list */}
              {selectedConvoy.moleculeIds.length > 0 && (
                <div>
                  <div className="text-[10px] text-white/30 uppercase mb-2">Molecules ({selectedConvoy.moleculeIds.length})</div>
                  <div className="space-y-1 max-h-[120px] overflow-y-auto">
                    {selectedConvoy.moleculeIds.map(mid => (
                      <div key={mid} className="flex items-center px-3 py-1.5 bg-white/[0.02] border border-white/5 rounded-none">
                        <span className="text-[10px] text-white/50 font-mono">{mid}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex-none px-5 py-3 border-t border-white/5 flex gap-2">
              {selectedConvoy.status === 'assembling' && (
                <button
                  onClick={() => dispatchConvoy(selectedConvoy.id)}
                  disabled={dispatching === selectedConvoy.id}
                  className="px-4 py-1.5 text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors rounded-none disabled:opacity-40"
                >
                  {dispatching === selectedConvoy.id ? 'Dispatching...' : 'Dispatch'}
                </button>
              )}
              <button
                onClick={() => setSelectedConvoy(null)}
                className="px-3 py-1.5 text-xs bg-white/5 border border-white/10 hover:bg-white/10 transition-colors rounded-none"
              >
                Close
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Create Modal ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShowCreate(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-[560px] max-h-[80vh] bg-[#0d1117] border border-white/10 flex flex-col rounded-none"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
                <span className="text-sm font-bold text-white/80">New Convoy</span>
                <button onClick={() => setShowCreate(false)} className="text-white/30 hover:text-white/60 text-sm">X</button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                <div>
                  <label className="block text-[10px] text-white/30 uppercase mb-1">Convoy Name *</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="e.g., Sprint-42 Delivery"
                    className="w-full px-3 py-2 text-xs bg-[#080b14] border border-white/10 text-white/90 placeholder-white/20 focus:outline-none focus:border-white/20 rounded-none"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-white/30 uppercase mb-1">Assigned Rig</label>
                  <input
                    type="text"
                    value={newRig}
                    onChange={e => setNewRig(e.target.value)}
                    placeholder="Rig name (optional)"
                    className="w-full px-3 py-2 text-xs bg-[#080b14] border border-white/10 text-white/90 placeholder-white/20 focus:outline-none focus:border-white/20 rounded-none"
                  />
                </div>

                {/* Bead selector */}
                <div>
                  <label className="block text-[10px] text-white/30 uppercase mb-1">
                    Select Beads ({selectedBeadIds.length} selected)
                  </label>
                  <input
                    type="text"
                    value={beadSearch}
                    onChange={e => setBeadSearch(e.target.value)}
                    placeholder="Search beads..."
                    className="w-full px-3 py-1.5 text-xs bg-[#080b14] border border-white/10 text-white/90 placeholder-white/20 focus:outline-none focus:border-white/20 rounded-none mb-2"
                  />
                  <div className="max-h-[200px] overflow-y-auto border border-white/5 rounded-none">
                    {filteredAvailableBeads.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-white/20 text-center">No beads available</div>
                    ) : (
                      filteredAvailableBeads.map(bead => {
                        const isSelected = selectedBeadIds.includes(bead.id);
                        return (
                          <button
                            key={bead.id}
                            onClick={() => {
                              setSelectedBeadIds(prev =>
                                isSelected ? prev.filter(id => id !== bead.id) : [...prev, bead.id]
                              );
                            }}
                            className={`w-full text-left flex items-center gap-2 px-3 py-2 text-xs border-b border-white/[0.03] transition-colors ${
                              isSelected ? 'bg-cyan-500/10 text-cyan-400' : 'text-white/60 hover:bg-white/[0.03]'
                            }`}
                          >
                            <span className={`w-3.5 h-3.5 flex items-center justify-center border rounded-none flex-shrink-0 ${
                              isSelected ? 'bg-cyan-500/30 border-cyan-500/40' : 'border-white/10'
                            }`}>
                              {isSelected && <span className="text-[8px]">&#10003;</span>}
                            </span>
                            <span className="truncate flex-1">{bead.title}</span>
                            <span className="text-[10px] text-white/25 font-mono flex-shrink-0">{bead.id.slice(0, 8)}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-white/5">
                <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-white/40 border border-white/10 hover:bg-white/5 rounded-none">
                  Cancel
                </button>
                <button
                  onClick={createConvoy}
                  disabled={!newName.trim() || creating}
                  className="px-4 py-1.5 text-xs bg-white/10 border border-white/20 hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded-none"
                >
                  {creating ? 'Creating...' : 'Create & Dispatch'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
