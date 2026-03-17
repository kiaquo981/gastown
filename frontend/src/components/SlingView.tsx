'use client';

/**
 * SlingView -- GT: Sling Console
 *
 * "gt sling" is THE core command of Gas Town.
 * "You sling work to workers, and it goes on their hook."
 *
 * Sections: Sling Console, Active Hooks, Sling History, Quick Shortcuts.
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

interface Bead {
  id: string;
  title: string;
  status: string;
  priority?: string;
  rigId?: string;
}

interface Worker {
  id: string;
  name: string;
  role: string;
  status: string;
  currentBead?: string;
}

interface ActiveHook {
  id: string;
  workerId: string;
  workerName: string;
  workerRole: string;
  beadId: string;
  beadTitle: string;
  slungAt: string;
  status: 'hooked' | 'working' | 'stale';
}

interface SlingRecord {
  id: string;
  timestamp: string;
  beadId: string;
  beadTitle: string;
  targetWorker: string;
  outcome: 'hooked' | 'completed' | 'failed' | 'unslung';
}

type SlingOption = 'immediate' | 'defer' | 'force';
type TabKey = 'console' | 'hooks' | 'history';

// ── Constants ───────────────────────────────────────────────────────────────

const POLL = 6000;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'console', label: 'Sling Console' },
  { key: 'hooks', label: 'Active Hooks' },
  { key: 'history', label: 'History' },
];

const STATUS_COLORS: Record<string, { dot: string; text: string }> = {
  hooked:    { dot: 'bg-[#ffb454]', text: 'text-[#ffb454]' },
  working:   { dot: 'bg-[#c2d94c]', text: 'text-[#c2d94c]' },
  stale:     { dot: 'bg-[#f07178]', text: 'text-[#f07178]' },
  completed: { dot: 'bg-[#95e6cb]', text: 'text-[#95e6cb]' },
  failed:    { dot: 'bg-[#f07178]', text: 'text-[#f07178]' },
  unslung:   { dot: 'bg-[#6c7680]', text: 'text-[#6c7680]' },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDate(ts: string | undefined): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '--'; }
}

function sc(status: string) {
  return STATUS_COLORS[status] || STATUS_COLORS.hooked;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-3">
      <span className="text-[10px] uppercase tracking-wider text-[#4a5159] block mb-1">{label}</span>
      <span className="text-lg font-mono" style={{ color: color || C.text }}>{value}</span>
    </div>
  );
}

function ActionBtn({ label, variant = 'default', onClick, disabled = false }: {
  label: string; variant?: 'default' | 'green' | 'yellow' | 'red' | 'purple'; onClick: () => void; disabled?: boolean;
}) {
  const cls: Record<string, string> = {
    default: 'border-[#2d363f] text-[#6c7680] hover:bg-[#2d363f]/30',
    green: 'border-[#c2d94c]/30 text-[#c2d94c] hover:bg-[#c2d94c]/10',
    yellow: 'border-[#ffb454]/30 text-[#ffb454] hover:bg-[#ffb454]/10',
    red: 'border-[#f07178]/30 text-[#f07178] hover:bg-[#f07178]/10',
    purple: 'border-[#d2a6ff]/30 text-[#d2a6ff] hover:bg-[#d2a6ff]/10',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border rounded-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${cls[variant]}`}
    >
      {label}
    </button>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SlingView() {
  const [tab, setTab] = useState<TabKey>('console');
  const [beads, setBeads] = useState<Bead[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [hooks, setHooks] = useState<ActiveHook[]>([]);
  const [history, setHistory] = useState<SlingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sling form state
  const [selectedBead, setSelectedBead] = useState('');
  const [selectedWorker, setSelectedWorker] = useState('');
  const [slingOption, setSlingOption] = useState<SlingOption>('immediate');
  const [beadSearch, setBeadSearch] = useState('');
  const [slinging, setSlinging] = useState(false);
  const [slingResult, setSlingResult] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [batchBeads, setBatchBeads] = useState<string[]>([]);

  const mountedRef = useRef(true);

  // ── Fetch data ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [beadsRes, crewRes, workersRes] = await Promise.allSettled([
        fetch(`${API}/api/beads?status=ready&limit=200`, { signal }),
        fetch(`${API}/api/meow/crew`, { signal }),
        fetch(`${API}/api/meow/workers/overview`, { signal }),
      ]);
      if (!mountedRef.current) return;

      if (beadsRes.status === 'fulfilled' && beadsRes.value.ok) {
        const d = await beadsRes.value.json();
        setBeads(Array.isArray(d) ? d : d.beads || []);
      }

      const allWorkers: Worker[] = [];
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const d = await crewRes.value.json();
        const crew = Array.isArray(d) ? d : d.crew || [];
        crew.forEach((c: Record<string, unknown>) => allWorkers.push({
          id: String(c.id || c.name),
          name: String(c.name || c.id),
          role: String(c.specialization || c.role || 'crew'),
          status: String(c.status || 'idle'),
          currentBead: c.currentAssignment ? String(c.currentAssignment) : undefined,
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
              currentBead: w.currentBead ? String(w.currentBead) : undefined,
            });
          }
        });
      }
      setWorkers(allWorkers);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach Gas Town endpoints');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const fetchHooks = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/gupp/hooks/pending`, { signal });
      if (!mountedRef.current) return;
      if (res.ok) {
        const d = await res.json();
        const raw = Array.isArray(d) ? d : d.hooks || d.pending || [];
        setHooks(raw.map((h: Record<string, unknown>, i: number) => ({
          id: String(h.id || `hook-${i}`),
          workerId: String(h.workerId || h.agentAddress || ''),
          workerName: String(h.workerName || h.agentAddress || 'unknown'),
          workerRole: String(h.workerRole || h.role || 'worker'),
          beadId: String(h.beadId || ''),
          beadTitle: String(h.beadTitle || h.title || h.beadId || ''),
          slungAt: String(h.slungAt || h.createdAt || h.claimedAt || new Date().toISOString()),
          status: (['hooked', 'working', 'stale'].includes(String(h.status || ''))
            ? String(h.status) : 'hooked') as 'hooked' | 'working' | 'stale',
        })));
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    fetchData(ctrl.signal);
    fetchHooks(ctrl.signal);
    const iv = setInterval(() => {
      const c = new AbortController();
      fetchData(c.signal);
      fetchHooks(c.signal);
    }, POLL);
    return () => { mountedRef.current = false; ctrl.abort(); clearInterval(iv); };
  }, [fetchData, fetchHooks]);

  // ── Sling action ──────────────────────────────────────────────────────

  const doSling = useCallback(async (beadId: string, workerId: string) => {
    setSlinging(true);
    setSlingResult(null);
    try {
      const res = await fetch(`${API}/api/meow/mayor/sling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beadId,
          agentAddress: workerId,
          option: slingOption,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        const msg = d.message || `Slung bead ${beadId} to ${workerId}`;
        setSlingResult(msg);
        setHistory(prev => [{
          id: `sl-${Date.now()}`,
          timestamp: new Date().toISOString(),
          beadId,
          beadTitle: beads.find(b => b.id === beadId)?.title || beadId,
          targetWorker: workers.find(w => w.id === workerId)?.name || workerId,
          outcome: 'hooked' as const,
        }, ...prev].slice(0, 100));
        // Refresh hooks
        fetchHooks();
      } else {
        const d = await res.json().catch(() => ({}));
        setSlingResult(`ERROR: ${d.error || res.statusText}`);
      }
    } catch {
      setSlingResult('ERROR: Network failure');
    } finally {
      setSlinging(false);
    }
  }, [slingOption, beads, workers, fetchHooks]);

  const handleSling = useCallback(() => {
    if (batchMode && batchBeads.length > 0 && selectedWorker) {
      batchBeads.forEach((bid, i) => {
        setTimeout(() => doSling(bid, selectedWorker), i * 200);
      });
      setBatchBeads([]);
    } else if (selectedBead && selectedWorker) {
      doSling(selectedBead, selectedWorker);
    }
  }, [batchMode, batchBeads, selectedBead, selectedWorker, doSling]);

  const unslingHook = useCallback(async (hookId: string) => {
    try {
      await fetch(`${API}/api/meow/gupp/hooks/${hookId}/unsling`, { method: 'POST' });
      fetchHooks();
    } catch { /* silent */ }
  }, [fetchHooks]);

  const nudgeHook = useCallback(async (hookId: string) => {
    try {
      await fetch(`${API}/api/meow/gupp/hooks/${hookId}/claim`, { method: 'POST' });
      fetchHooks();
    } catch { /* silent */ }
  }, [fetchHooks]);

  // ── Derived state ─────────────────────────────────────────────────────

  const filteredBeads = useMemo(() => {
    if (!beadSearch) return beads.slice(0, 50);
    const q = beadSearch.toLowerCase();
    return beads.filter(b =>
      b.title.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [beads, beadSearch]);

  const availableWorkers = useMemo(() =>
    workers.filter(w => w.status !== 'error'),
  [workers]);

  const polecats = useMemo(() => workers.filter(w => w.role === 'polecat' || w.role === 'ephemeral'), [workers]);
  const crewMembers = useMemo(() => workers.filter(w => w.role !== 'polecat' && w.role !== 'ephemeral'), [workers]);

  const hookStats = useMemo(() => ({
    total: hooks.length,
    hooked: hooks.filter(h => h.status === 'hooked').length,
    working: hooks.filter(h => h.status === 'working').length,
    stale: hooks.filter(h => h.status === 'stale').length,
  }), [hooks]);

  const toggleBatch = useCallback((beadId: string) => {
    setBatchBeads(prev =>
      prev.includes(beadId) ? prev.filter(b => b !== beadId) : [...prev, beadId]
    );
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-4 space-y-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">SLING</h1>
            <p className="text-xs text-[#4a5159] mt-0.5">
              Sling work to workers &mdash; the core of Gas Town
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[#4a5159]">
            <span>{beads.length} beads ready</span>
            <span className="w-px h-4" style={{ background: C.border }} />
            <span>{workers.length} workers</span>
            <span className="w-px h-4" style={{ background: C.border }} />
            <span>{hooks.length} active hooks</span>
          </div>
        </div>
      </motion.div>

      {/* Tabs */}
      <div className="flex border-b border-[#2d363f]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
              tab === t.key
                ? 'text-[#e6e1cf] border-b-2 border-[#d2a6ff]/60'
                : 'text-[#4a5159] hover:text-[#6c7680]'
            }`}
          >
            {t.label}
            {t.key === 'hooks' && hooks.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[9px] bg-[#ffb454]/10 text-[#ffb454] border border-[#ffb454]/20 rounded-none">
                {hooks.length}
              </span>
            )}
          </button>
        ))}
      </div>

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

      {/* Loading skeleton */}
      {loading && beads.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
              className="h-32 bg-[#2d363f]/15 border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* ── Console Tab ──────────────────────────────────────────────── */}
        {tab === 'console' && (
          <motion.div key="console" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-5">
            {/* Sling Console */}
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold">Sling Console</p>
                <label className="flex items-center gap-2 text-[10px] text-[#4a5159] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={batchMode}
                    onChange={e => { setBatchMode(e.target.checked); setBatchBeads([]); }}
                    className="accent-[#d2a6ff]"
                  />
                  Batch Mode
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Bead selector */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">
                    {batchMode ? 'Select Beads' : 'Bead'}
                  </label>
                  <input
                    type="text"
                    value={beadSearch}
                    onChange={e => setBeadSearch(e.target.value)}
                    placeholder="Search beads..."
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f] mb-2"
                  />
                  {batchMode ? (
                    <div className="max-h-40 overflow-y-auto space-y-1 bg-[#0f1419] border border-[#2d363f] rounded-none p-2">
                      {filteredBeads.map(b => (
                        <label key={b.id} className="flex items-center gap-2 text-xs text-[#6c7680] cursor-pointer hover:text-[#e6e1cf] transition-colors">
                          <input
                            type="checkbox"
                            checked={batchBeads.includes(b.id)}
                            onChange={() => toggleBatch(b.id)}
                            className="accent-[#d2a6ff]"
                          />
                          <span className="font-mono text-[10px] text-[#4a5159]">{b.id.slice(0, 8)}</span>
                          <span className="truncate">{b.title}</span>
                        </label>
                      ))}
                      {filteredBeads.length === 0 && (
                        <span className="text-[10px] text-[#4a5159]">No ready beads found</span>
                      )}
                    </div>
                  ) : (
                    <select
                      value={selectedBead}
                      onChange={e => setSelectedBead(e.target.value)}
                      className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 focus:outline-none appearance-none cursor-pointer"
                    >
                      <option value="" className="bg-[#1a1f26]">-- select bead --</option>
                      {filteredBeads.map(b => (
                        <option key={b.id} value={b.id} className="bg-[#1a1f26]">
                          [{b.id.slice(0, 8)}] {b.title}
                        </option>
                      ))}
                    </select>
                  )}
                  {batchMode && batchBeads.length > 0 && (
                    <span className="text-[10px] text-[#d2a6ff] mt-1 block">{batchBeads.length} beads selected</span>
                  )}
                </div>

                {/* Target worker selector */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Target Worker</label>
                  <select
                    value={selectedWorker}
                    onChange={e => setSelectedWorker(e.target.value)}
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 focus:outline-none appearance-none cursor-pointer"
                  >
                    <option value="" className="bg-[#1a1f26]">-- select worker --</option>
                    {polecats.length > 0 && (
                      <optgroup label="Polecats" className="bg-[#1a1f26]">
                        {polecats.map(w => (
                          <option key={w.id} value={w.id} className="bg-[#1a1f26]">
                            {w.name} ({w.status})
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {crewMembers.length > 0 && (
                      <optgroup label="Crew" className="bg-[#1a1f26]">
                        {crewMembers.map(w => (
                          <option key={w.id} value={w.id} className="bg-[#1a1f26]">
                            {w.name} ({w.status}) -- {w.role}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {/* Options */}
                  <div className="mt-3">
                    <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Option</label>
                    <div className="flex gap-2">
                      {(['immediate', 'defer', 'force'] as const).map(opt => (
                        <button
                          key={opt}
                          onClick={() => setSlingOption(opt)}
                          className={`px-3 py-1.5 text-[10px] font-mono uppercase border rounded-none transition-colors ${
                            slingOption === opt
                              ? 'border-[#d2a6ff]/40 bg-[#d2a6ff]/10 text-[#d2a6ff]'
                              : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'
                          }`}
                        >
                          {opt === 'immediate' ? 'Start Now' : opt === 'defer' ? 'Defer' : 'Force Restart'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* SLING button */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSling}
                  disabled={slinging || (!selectedBead && !batchMode) || (batchMode && batchBeads.length === 0) || !selectedWorker}
                  className="px-6 py-2.5 text-sm font-mono font-bold uppercase tracking-widest bg-[#d2a6ff]/15 border-2 border-[#d2a6ff]/40 text-[#d2a6ff] rounded-none hover:bg-[#d2a6ff]/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {slinging ? 'SLINGING...' : batchMode ? `SLING ${batchBeads.length} BEADS` : 'SLING'}
                </button>

                {/* Result feedback */}
                <AnimatePresence>
                  {slingResult && (
                    <motion.span
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className={`text-xs font-mono ${
                        slingResult.startsWith('ERROR') ? 'text-[#f07178]' : 'text-[#c2d94c]'
                      }`}
                    >
                      {slingResult}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Quick Sling Shortcuts */}
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
              <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold mb-3">Quick Sling</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <button
                  onClick={() => {
                    const p = polecats.find(w => w.status === 'idle');
                    if (p && selectedBead) doSling(selectedBead, p.id);
                  }}
                  disabled={!selectedBead || polecats.filter(w => w.status === 'idle').length === 0}
                  className="px-3 py-3 text-xs font-mono text-left bg-[#0f1419] border border-[#2d363f] rounded-none hover:border-[#ffb454]/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="block text-[#ffb454] font-semibold mb-0.5">Sling to Polecat</span>
                  <span className="text-[10px] text-[#4a5159]">Auto-pick idle polecat</span>
                </button>

                <button
                  onClick={() => {
                    const c = crewMembers.find(w => w.status === 'idle' || w.status === 'active');
                    if (c && selectedBead) doSling(selectedBead, c.id);
                  }}
                  disabled={!selectedBead || crewMembers.length === 0}
                  className="px-3 py-3 text-xs font-mono text-left bg-[#0f1419] border border-[#2d363f] rounded-none hover:border-[#95e6cb]/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="block text-[#95e6cb] font-semibold mb-0.5">Sling to Crew</span>
                  <span className="text-[10px] text-[#4a5159]">Pick crew member</span>
                </button>

                <button
                  onClick={() => { setBatchMode(true); setTab('console'); }}
                  className="px-3 py-3 text-xs font-mono text-left bg-[#0f1419] border border-[#2d363f] rounded-none hover:border-[#d2a6ff]/30 transition-colors"
                >
                  <span className="block text-[#d2a6ff] font-semibold mb-0.5">Batch Sling</span>
                  <span className="text-[10px] text-[#4a5159]">Multiple beads at once</span>
                </button>

                <button
                  onClick={async () => {
                    if (!selectedWorker) return;
                    try {
                      const res = await fetch(`${API}/api/meow/chemistry/cook`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ formulaId: 'default', target: selectedWorker }),
                      });
                      if (res.ok) {
                        const d = await res.json();
                        setSlingResult(`Formula cooked: ${d.moleculeId || 'ok'}`);
                      }
                    } catch { /* silent */ }
                  }}
                  disabled={!selectedWorker}
                  className="px-3 py-3 text-xs font-mono text-left bg-[#0f1419] border border-[#2d363f] rounded-none hover:border-[#c2d94c]/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="block text-[#c2d94c] font-semibold mb-0.5">Sling Formula</span>
                  <span className="text-[10px] text-[#4a5159]">Cook + sling in one step</span>
                </button>
              </div>
            </div>

            {/* Hook stats summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Active Hooks" value={hookStats.total} color={C.yellow} />
              <StatCard label="Hooked" value={hookStats.hooked} color={C.yellow} />
              <StatCard label="Working" value={hookStats.working} color={C.green} />
              <StatCard label="Stale" value={hookStats.stale} color={C.red} />
            </div>
          </motion.div>
        )}

        {/* ── Active Hooks Tab ─────────────────────────────────────────── */}
        {tab === 'hooks' && (
          <motion.div key="hooks" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {hooks.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">No active hooks</p>
                <p className="text-[10px] text-[#4a5159] mt-1">Sling some work to get started</p>
              </div>
            ) : (
              <div className="space-y-0">
                {/* Table header */}
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-32">Worker</span>
                  <span className="w-20">Role</span>
                  <span className="w-24">Bead ID</span>
                  <span className="flex-1">Bead Title</span>
                  <span className="w-24">Slung At</span>
                  <span className="w-16">Age</span>
                  <span className="w-16">Status</span>
                  <span className="w-28 text-right">Actions</span>
                </div>

                {hooks.map((hook, i) => {
                  const st = sc(hook.status);
                  return (
                    <motion.div
                      key={hook.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.02 }}
                      className="flex items-center gap-3 px-3 py-2.5 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                    >
                      <span className={`w-2 h-2 rounded-none flex-shrink-0 ${st.dot}`} />
                      <span className="w-32 text-xs text-[#e6e1cf] truncate">{hook.workerName}</span>
                      <span className="w-20 text-[10px] text-[#4a5159]">{hook.workerRole}</span>
                      <span className="w-24 text-[10px] text-[#6c7680] font-mono">{hook.beadId.slice(0, 10)}</span>
                      <span className="flex-1 text-xs text-[#6c7680] truncate">{hook.beadTitle}</span>
                      <span className="w-24 text-[10px] text-[#4a5159]">{fmtDate(hook.slungAt)}</span>
                      <span className="w-16 text-[10px] text-[#4a5159]">{timeAgo(hook.slungAt)}</span>
                      <span className={`w-16 text-[10px] font-mono uppercase ${st.text}`}>{hook.status}</span>
                      <div className="w-28 flex justify-end gap-1">
                        <button
                          onClick={() => nudgeHook(hook.id)}
                          className="px-2 py-1 text-[9px] font-mono uppercase border border-[#ffb454]/20 text-[#ffb454] rounded-none hover:bg-[#ffb454]/10 transition-colors"
                        >
                          Nudge
                        </button>
                        <button
                          onClick={() => unslingHook(hook.id)}
                          className="px-2 py-1 text-[9px] font-mono uppercase border border-[#f07178]/20 text-[#f07178] rounded-none hover:bg-[#f07178]/10 transition-colors"
                        >
                          Unsling
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}

        {/* ── History Tab ──────────────────────────────────────────────── */}
        {tab === 'history' && (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {history.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">No sling history yet</p>
                <p className="text-[10px] text-[#4a5159] mt-1">Sling operations will appear here</p>
              </div>
            ) : (
              <div className="space-y-0">
                {/* Table header */}
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-32">Timestamp</span>
                  <span className="w-24">Bead ID</span>
                  <span className="flex-1">Bead Title</span>
                  <span className="w-28">Target Worker</span>
                  <span className="w-20 text-right">Outcome</span>
                </div>

                {history.map((rec, i) => {
                  const st = sc(rec.outcome);
                  return (
                    <motion.div
                      key={rec.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.015 }}
                      className="flex items-center gap-3 px-3 py-2 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                    >
                      <span className={`w-2 h-2 rounded-none flex-shrink-0 ${st.dot}`} />
                      <span className="w-32 text-[10px] text-[#4a5159]">{fmtDate(rec.timestamp)}</span>
                      <span className="w-24 text-[10px] text-[#6c7680] font-mono">{rec.beadId.slice(0, 10)}</span>
                      <span className="flex-1 text-xs text-[#6c7680] truncate">{rec.beadTitle}</span>
                      <span className="w-28 text-xs text-[#e6e1cf]/60 truncate">{rec.targetWorker}</span>
                      <span className={`w-20 text-[10px] text-right font-mono uppercase ${st.text}`}>{rec.outcome}</span>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

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
