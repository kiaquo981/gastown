'use client';

/**
 * RigView -- GT: Rig Manager
 *
 * Rigs are project containers wrapping git repos.
 * "gt rig add/list/config/dock/park"
 *
 * Sections: Rig List (grid), Rig Detail (slide-in panel), Add Rig Form.
 * AYU DARK: bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680,
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
  dim: '#4a5159',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

interface RigWorker {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface RigWorktree {
  path: string;
  branch: string;
  active: boolean;
}

interface Rig {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  remoteUrl?: string;
  status: 'active' | 'parked' | 'docked';
  workers: RigWorker[];
  workerCount: number;
  activeConvoys: number;
  beadStats: { open: number; in_progress: number; done: number };
  lastActivity?: string;
  namepoolStyle?: string;
  runtimeOverrides?: Record<string, unknown>;
  worktrees?: RigWorktree[];
}

type StatusFilter = 'all' | 'active' | 'parked' | 'docked';

// ── Constants ───────────────────────────────────────────────────────────────

const POLL = 10000;

const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string; border: string }> = {
  active: { dot: 'bg-[#c2d94c]', bg: 'bg-[#c2d94c]/10', text: 'text-[#c2d94c]', border: 'border-[#c2d94c]/20' },
  parked: { dot: 'bg-[#6c7680]', bg: 'bg-[#6c7680]/10', text: 'text-[#6c7680]', border: 'border-[#6c7680]/20' },
  docked: { dot: 'bg-[#ffb454]', bg: 'bg-[#ffb454]/10', text: 'text-[#ffb454]', border: 'border-[#ffb454]/20' },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function ss(s: string) { return STATUS_STYLES[s] || STATUS_STYLES.active; }

function timeAgo(ts: string | undefined): string {
  if (!ts) return '--';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function RigCard({ rig, selected, onSelect }: {
  rig: Rig; selected: boolean; onSelect: () => void;
}) {
  const st = ss(rig.status);
  const totalBeads = rig.beadStats.open + rig.beadStats.in_progress + rig.beadStats.done;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      onClick={onSelect}
      className={`bg-[#1a1f26] border rounded-none cursor-pointer transition-all hover:border-[#6c7680]/40 ${
        selected ? 'border-[#d2a6ff]/40' : 'border-[#2d363f]'
      }`}
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-none ${st.dot}`} />
            <h3 className="text-sm font-mono font-semibold text-[#e6e1cf] truncate">{rig.name}</h3>
          </div>
          <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase ${st.bg} ${st.text} border ${st.border} rounded-none`}>
            {rig.status}
          </span>
        </div>

        {/* Repo path */}
        <p className="text-[10px] text-[#4a5159] font-mono truncate mb-3">{rig.repoPath}</p>

        {/* Branch */}
        <div className="flex items-center gap-1.5 mb-3">
          <span className="text-[9px] text-[#4a5159] uppercase">branch:</span>
          <span className="text-[10px] text-[#95e6cb] font-mono">{rig.defaultBranch}</span>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-2">
            <span className="text-[9px] text-[#4a5159] uppercase block">Workers</span>
            <span className="text-sm font-mono text-[#e6e1cf]">{rig.workerCount}</span>
          </div>
          <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-2">
            <span className="text-[9px] text-[#4a5159] uppercase block">Convoys</span>
            <span className="text-sm font-mono text-[#e6e1cf]">{rig.activeConvoys}</span>
          </div>
          <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-2">
            <span className="text-[9px] text-[#4a5159] uppercase block">Beads</span>
            <span className="text-sm font-mono text-[#e6e1cf]">{totalBeads}</span>
          </div>
        </div>

        {/* Bead breakdown */}
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-[#c2d94c]">{rig.beadStats.done} done</span>
          <span className="text-[#ffb454]">{rig.beadStats.in_progress} wip</span>
          <span className="text-[#6c7680]">{rig.beadStats.open} open</span>
        </div>

        {/* Last activity */}
        <div className="mt-3 text-[9px] text-[#4a5159]">
          Last activity: {timeAgo(rig.lastActivity)}
        </div>
      </div>
    </motion.div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function RigView() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [selectedRig, setSelectedRig] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [formRepoPath, setFormRepoPath] = useState('');
  const [formName, setFormName] = useState('');
  const [formBranch, setFormBranch] = useState('main');
  const [actionLoading, setActionLoading] = useState(false);

  const mountedRef = useRef(true);

  // ── Fetch data ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [bldRes, crewRes, workersRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/town/buildings`, { signal }),
        fetch(`${API}/api/meow/crew`, { signal }),
        fetch(`${API}/api/meow/workers/overview`, { signal }),
      ]);
      if (!mountedRef.current) return;

      // Parse buildings -> rigs
      let buildings: Record<string, unknown>[] = [];
      if (bldRes.status === 'fulfilled' && bldRes.value.ok) {
        const d = await bldRes.value.json();
        buildings = Array.isArray(d) ? d : d.buildings || d.rigs || [];
      }

      // Parse workers
      const allWorkers: RigWorker[] = [];
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const d = await crewRes.value.json();
        const crew = Array.isArray(d) ? d : d.crew || [];
        crew.forEach((c: Record<string, unknown>) => allWorkers.push({
          id: String(c.id || c.name),
          name: String(c.name || c.id),
          role: String(c.specialization || c.role || 'crew'),
          status: String(c.status || 'idle'),
        }));
      }
      if (workersRes.status === 'fulfilled' && workersRes.value.ok) {
        const d = await workersRes.value.json();
        const wList = Array.isArray(d) ? d : d.workers || d.overview || [];
        wList.forEach((w: Record<string, unknown>) => {
          if (!allWorkers.find(a => a.id === String(w.id || w.name))) {
            allWorkers.push({
              id: String(w.id || w.name),
              name: String(w.name || w.id),
              role: String(w.role || w.type || 'polecat'),
              status: String(w.status || 'idle'),
            });
          }
        });
      }

      // Map buildings to rigs
      const rigList: Rig[] = buildings.map((b, i) => {
        const rigId = String(b.id || b.name || `rig-${i}`);
        const rigWorkers = allWorkers.filter(w => {
          const wRig = (b as Record<string, unknown>).rigId;
          return wRig ? String(wRig) === rigId : false;
        });

        return {
          id: rigId,
          name: String(b.name || b.id || `rig-${i}`),
          repoPath: String(b.repoPath || b.path || b.repo || '/unknown'),
          defaultBranch: String(b.defaultBranch || b.branch || 'main'),
          remoteUrl: b.remoteUrl ? String(b.remoteUrl) : undefined,
          status: (['active', 'parked', 'docked'].includes(String(b.status || ''))
            ? String(b.status) : 'active') as 'active' | 'parked' | 'docked',
          workers: rigWorkers,
          workerCount: Number(b.workerCount || rigWorkers.length || 0),
          activeConvoys: Number(b.activeConvoys || b.convoys || 0),
          beadStats: {
            open: Number((b.beadStats as Record<string, unknown>)?.open || b.openBeads || 0),
            in_progress: Number((b.beadStats as Record<string, unknown>)?.in_progress || b.wipBeads || 0),
            done: Number((b.beadStats as Record<string, unknown>)?.done || b.doneBeads || 0),
          },
          lastActivity: b.lastActivity ? String(b.lastActivity) : undefined,
          namepoolStyle: b.namepoolStyle ? String(b.namepoolStyle) : undefined,
          runtimeOverrides: (b.runtimeOverrides as Record<string, unknown>) || undefined,
          worktrees: Array.isArray(b.worktrees) ? (b.worktrees as RigWorktree[]) : undefined,
        };
      });

      setRigs(rigList);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach Gas Town endpoints');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    fetchData(ctrl.signal);
    const iv = setInterval(() => {
      const c = new AbortController();
      fetchData(c.signal);
    }, POLL);
    return () => { mountedRef.current = false; ctrl.abort(); clearInterval(iv); };
  }, [fetchData]);

  // ── Actions ───────────────────────────────────────────────────────────

  const addRig = useCallback(async () => {
    if (!formRepoPath.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API}/api/meow/town/rigs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: formRepoPath.trim(),
          name: formName.trim() || formRepoPath.trim().split('/').pop(),
          defaultBranch: formBranch.trim() || 'main',
        }),
      });
      if (res.ok) {
        setFormRepoPath('');
        setFormName('');
        setFormBranch('main');
        setShowAddForm(false);
        fetchData();
      }
    } catch { /* silent */ }
    finally { setActionLoading(false); }
  }, [formRepoPath, formName, formBranch, fetchData]);

  const rigAction = useCallback(async (rigId: string, action: 'park' | 'dock' | 'remove') => {
    setActionLoading(true);
    try {
      await fetch(`${API}/api/meow/town/rigs/${rigId}/${action}`, { method: 'POST' });
      if (action === 'remove') setSelectedRig(null);
      fetchData();
    } catch { /* silent */ }
    finally { setActionLoading(false); }
  }, [fetchData]);

  // ── Derived state ─────────────────────────────────────────────────────

  const filtered = useMemo(() => rigs.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return r.name.toLowerCase().includes(q)
        || r.repoPath.toLowerCase().includes(q)
        || r.defaultBranch.toLowerCase().includes(q);
    }
    return true;
  }), [rigs, statusFilter, search]);

  const detail = useMemo(() => rigs.find(r => r.id === selectedRig), [rigs, selectedRig]);

  const stats = useMemo(() => ({
    total: rigs.length,
    active: rigs.filter(r => r.status === 'active').length,
    parked: rigs.filter(r => r.status === 'parked').length,
    docked: rigs.filter(r => r.status === 'docked').length,
  }), [rigs]);

  // Auto-suggest name from path
  useEffect(() => {
    if (formRepoPath && !formName) {
      const parts = formRepoPath.trim().split('/').filter(Boolean);
      if (parts.length > 0) {
        setFormName(parts[parts.length - 1]);
      }
    }
  }, [formRepoPath, formName]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-4 space-y-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">RIGS</h1>
            <p className="text-xs text-[#4a5159] mt-0.5">
              Project containers wrapping git repos &mdash; {stats.total} registered
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Status pills */}
            {(['active', 'parked', 'docked'] as const).map(s => {
              const st = ss(s);
              return (
                <div key={s} className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-none ${st.border} ${st.bg}`}>
                  <div className={`w-1.5 h-1.5 rounded-none ${st.dot}`} />
                  <span className={`text-[11px] uppercase ${st.text}`}>{s}</span>
                  <span className="text-[11px] text-[#4a5159]">{stats[s]}</span>
                </div>
              );
            })}
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className={`px-3 py-1.5 text-xs border rounded-none transition-colors ${
                showAddForm
                  ? 'bg-[#f07178]/10 border-[#f07178]/20 text-[#f07178]'
                  : 'bg-[#d2a6ff]/15 border-[#d2a6ff]/30 text-[#d2a6ff] hover:bg-[#d2a6ff]/25'
              }`}
            >
              {showAddForm ? 'CANCEL' : '+ ADD RIG'}
            </button>
          </div>
        </div>
      </motion.div>

      {/* Error banner */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#f07178]/10 border border-[#f07178]/20 rounded-none px-4 py-2 text-xs font-mono text-[#f07178]"
        >
          {error}
        </motion.div>
      )}

      {/* Add Rig Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="bg-[#1a1f26] border border-[#d2a6ff]/20 rounded-none overflow-hidden"
          >
            <div className="p-4 space-y-3">
              <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold">New Rig</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Repo Path</label>
                  <input
                    value={formRepoPath}
                    onChange={e => setFormRepoPath(e.target.value)}
                    placeholder="/path/to/repo"
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f]"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Name</label>
                  <input
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    placeholder="auto-suggested from path"
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f]"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Default Branch</label>
                  <input
                    value={formBranch}
                    onChange={e => setFormBranch(e.target.value)}
                    placeholder="main"
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f]"
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={addRig}
                  disabled={!formRepoPath.trim() || actionLoading}
                  className="px-4 py-2 text-xs font-semibold bg-[#d2a6ff]/20 border border-[#d2a6ff]/30 text-[#d2a6ff] rounded-none hover:bg-[#d2a6ff]/30 transition-colors disabled:opacity-30"
                >
                  {actionLoading ? 'ADDING...' : 'ADD RIG'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search rigs..."
          className="flex-1 bg-[#2d363f]/20 border border-[#2d363f] rounded-none px-3 py-2 text-xs font-mono text-[#e6e1cf] placeholder:text-[#4a5159] focus:outline-none focus:border-white/15 transition-colors"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-[#2d363f]/20 border border-[#2d363f] rounded-none px-3 py-2 text-xs font-mono text-[#e6e1cf] focus:outline-none focus:border-white/15 appearance-none cursor-pointer"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="parked">Parked</option>
          <option value="docked">Docked</option>
        </select>
      </div>

      {/* Loading skeleton */}
      {loading && rigs.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
              className="h-44 bg-[#2d363f]/15 border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      {/* Main content area */}
      <div className="flex gap-5">
        {/* Rig grid */}
        <div className={`flex-1 ${detail ? 'hidden md:block md:flex-1' : ''}`}>
          {filtered.length > 0 ? (
            <motion.div layout className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              <AnimatePresence mode="popLayout">
                {filtered.map(rig => (
                  <RigCard
                    key={rig.id}
                    rig={rig}
                    selected={selectedRig === rig.id}
                    onSelect={() => setSelectedRig(selectedRig === rig.id ? null : rig.id)}
                  />
                ))}
              </AnimatePresence>
            </motion.div>
          ) : !loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-[#4a5159]">
              <span className="text-3xl mb-3">#</span>
              <span className="text-sm font-mono">
                {rigs.length === 0 ? 'No rigs registered' : 'No matches for current filters'}
              </span>
            </div>
          ) : null}
        </div>

        {/* Detail panel */}
        <AnimatePresence>
          {detail && (
            <motion.div
              initial={{ opacity: 0, x: 20, width: 0 }}
              animate={{ opacity: 1, x: 0, width: 400 }}
              exit={{ opacity: 0, x: 20, width: 0 }}
              className="shrink-0 overflow-hidden"
            >
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none h-full overflow-y-auto">
                {/* Detail header */}
                <div className="p-4 border-b border-[#2d363f]">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold text-[#e6e1cf]">{detail.name}</h2>
                    <button onClick={() => setSelectedRig(null)} className="text-[#4a5159] hover:text-[#e6e1cf] text-xs transition-colors">
                      {'\u2715'}
                    </button>
                  </div>
                  <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase ${ss(detail.status).bg} ${ss(detail.status).text} border ${ss(detail.status).border} rounded-none`}>
                    {detail.status}
                  </span>
                </div>

                <div className="p-4 space-y-4">
                  {/* Rig info */}
                  <div className="space-y-2">
                    <div>
                      <span className="text-[9px] text-[#4a5159] uppercase block">Repo Path</span>
                      <span className="text-xs text-[#95e6cb] font-mono break-all">{detail.repoPath}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-[#4a5159] uppercase block">Branch</span>
                      <span className="text-xs text-[#95e6cb] font-mono">{detail.defaultBranch}</span>
                    </div>
                    {detail.remoteUrl && (
                      <div>
                        <span className="text-[9px] text-[#4a5159] uppercase block">Remote URL</span>
                        <span className="text-xs text-[#6c7680] font-mono break-all">{detail.remoteUrl}</span>
                      </div>
                    )}
                    {detail.namepoolStyle && (
                      <div>
                        <span className="text-[9px] text-[#4a5159] uppercase block">Namepool Style</span>
                        <span className="text-xs text-[#6c7680] font-mono">{detail.namepoolStyle}</span>
                      </div>
                    )}
                  </div>

                  {/* Workers */}
                  <div>
                    <span className="text-[10px] text-[#4a5159] uppercase tracking-wider block mb-2">Workers ({detail.workers.length})</span>
                    {detail.workers.length > 0 ? (
                      <div className="space-y-1">
                        {detail.workers.map(w => (
                          <div key={w.id} className="flex items-center gap-2 px-2 py-1.5 bg-[#0f1419] border border-[#2d363f] rounded-none">
                            <span className={`w-1.5 h-1.5 rounded-none ${
                              w.status === 'active' || w.status === 'running' ? 'bg-[#c2d94c]' : 'bg-[#6c7680]'
                            }`} />
                            <span className="text-xs text-[#e6e1cf] truncate flex-1">{w.name}</span>
                            <span className="text-[9px] text-[#4a5159]">{w.role}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-[#4a5159]">No workers assigned</span>
                    )}
                  </div>

                  {/* Config / Overrides */}
                  {detail.runtimeOverrides && Object.keys(detail.runtimeOverrides).length > 0 && (
                    <div>
                      <span className="text-[10px] text-[#4a5159] uppercase tracking-wider block mb-1">Runtime Overrides</span>
                      <pre className="text-[10px] font-mono text-[#4a5159] bg-[#0f1419] border border-[#2d363f] p-2 rounded-none overflow-x-auto max-h-24">
                        {JSON.stringify(detail.runtimeOverrides, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Worktrees */}
                  {detail.worktrees && detail.worktrees.length > 0 && (
                    <div>
                      <span className="text-[10px] text-[#4a5159] uppercase tracking-wider block mb-2">Worktrees ({detail.worktrees.length})</span>
                      <div className="space-y-1">
                        {detail.worktrees.map((wt, i) => (
                          <div key={i} className="flex items-center gap-2 px-2 py-1.5 bg-[#0f1419] border border-[#2d363f] rounded-none">
                            <span className={`w-1.5 h-1.5 rounded-none ${wt.active ? 'bg-[#c2d94c]' : 'bg-[#6c7680]'}`} />
                            <span className="text-[10px] text-[#95e6cb] font-mono">{wt.branch}</span>
                            <span className="text-[9px] text-[#4a5159] truncate flex-1">{wt.path}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2 flex-wrap pt-2 border-t border-[#2d363f]">
                    {detail.status === 'active' ? (
                      <button
                        onClick={() => rigAction(detail.id, 'park')}
                        disabled={actionLoading}
                        className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border border-[#6c7680]/30 text-[#6c7680] rounded-none hover:bg-[#6c7680]/10 transition-colors disabled:opacity-30"
                      >
                        Park (Suspend)
                      </button>
                    ) : (
                      <button
                        onClick={() => rigAction(detail.id, 'dock')}
                        disabled={actionLoading}
                        className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border border-[#c2d94c]/30 text-[#c2d94c] rounded-none hover:bg-[#c2d94c]/10 transition-colors disabled:opacity-30"
                      >
                        Dock (Resume)
                      </button>
                    )}
                    <button
                      onClick={() => rigAction(detail.id, 'remove')}
                      disabled={actionLoading}
                      className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border border-[#f07178]/30 text-[#f07178] rounded-none hover:bg-[#f07178]/10 transition-colors disabled:opacity-30"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Auto-refresh indicator */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <motion.div
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-1.5 h-1.5 bg-[#d2a6ff]/60 rounded-none"
        />
        <span className="text-[10px] font-mono text-[#4a5159]">Auto-refresh {POLL / 1000}s</span>
      </div>
    </div>
  );
}
