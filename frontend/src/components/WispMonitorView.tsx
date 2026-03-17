'use client';

/**
 * WispMonitorView -- GT-014: Wisp Monitor
 *
 * Ephemeral molecule TTL dashboard. Wisps are molecules in VAPOR phase with
 * a time-to-live that auto-expires. Monitors countdown, allows promote/burn.
 * Ayu Dark aesthetic: bg-[#0f1419], borders [#2d363f], text [#e6e1cf], font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WispStep {
  id: string;
  name: string;
  status: 'pending' | 'ready' | 'running' | 'done' | 'completed' | 'failed' | 'skipped';
  assignee?: string;
  completedAt?: string;
}

interface Wisp {
  id: string;
  name: string;
  formulaName: string;
  phase: 'vapor';
  status: 'active' | 'completed' | 'failed' | 'paused';
  steps: WispStep[];
  ttlMs?: number;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  vars?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

type SortMode = 'ttl-asc' | 'ttl-desc' | 'created-asc' | 'created-desc' | 'status';

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 3000;

const STATUS_CLS: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  completed: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  paused: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

const STEP_STATUS_CLS: Record<string, string> = {
  pending: 'bg-zinc-500/30 text-zinc-400',
  ready: 'bg-blue-500/30 text-blue-400',
  running: 'bg-amber-500/30 text-amber-400 animate-pulse',
  done: 'bg-emerald-500/30 text-emerald-400',
  failed: 'bg-red-500/30 text-red-400',
  skipped: 'bg-zinc-500/10 text-zinc-500',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'in the future';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function truncId(id: string): string {
  return id.length > 12 ? id.slice(0, 10) + '..' : id;
}

function getTtlRemaining(wisp: Wisp): number {
  if (wisp.expiresAt) {
    return Math.max(0, new Date(wisp.expiresAt).getTime() - Date.now());
  }
  if (wisp.ttlMs && wisp.createdAt) {
    const created = new Date(wisp.createdAt).getTime();
    const expires = created + wisp.ttlMs;
    return Math.max(0, expires - Date.now());
  }
  return -1; // unknown
}

function getTtlTotal(wisp: Wisp): number {
  if (wisp.ttlMs) return wisp.ttlMs;
  if (wisp.expiresAt && wisp.createdAt) {
    return new Date(wisp.expiresAt).getTime() - new Date(wisp.createdAt).getTime();
  }
  return -1;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 60000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function ttlBarColor(pct: number): string {
  if (pct > 50) return 'bg-emerald-400';
  if (pct > 25) return 'bg-amber-400';
  return 'bg-red-400';
}

function ttlGlowColor(pct: number): string {
  if (pct > 50) return 'shadow-[0_0_12px_rgba(52,211,153,0.15)]';
  if (pct > 25) return 'shadow-[0_0_12px_rgba(251,191,36,0.15)]';
  return 'shadow-[0_0_12px_rgba(248,113,113,0.15)]';
}

// ─── Skeleton ───────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-[#2d363f]/30 animate-pulse rounded-none ${className}`} />;
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
  subtext,
}: {
  label: string;
  value: string | number;
  color: string;
  subtext?: string;
}) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4 flex-1 min-w-[140px]">
      <div className="text-[10px] uppercase tracking-widest text-[#4a5159] mb-1">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {subtext && <div className="text-[9px] text-[#4a5159] mt-1">{subtext}</div>}
    </div>
  );
}

// ─── Wisp Card ──────────────────────────────────────────────────────────────

function WispCard({
  wisp,
  isSelected,
  onSelect,
  onPromote,
  onBurn,
  actionLoading,
}: {
  wisp: Wisp;
  isSelected: boolean;
  onSelect: () => void;
  onPromote: () => void;
  onBurn: () => void;
  actionLoading: string | null;
}) {
  const [now, setNow] = useState(Date.now());

  // Client-side countdown between polls
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const ttlRemaining = useMemo(() => getTtlRemaining(wisp), [wisp, now]);
  const ttlTotal = useMemo(() => getTtlTotal(wisp), [wisp]);
  const ttlPct = useMemo(
    () => (ttlTotal > 0 ? Math.max(0, Math.min(100, (ttlRemaining / ttlTotal) * 100)) : -1),
    [ttlRemaining, ttlTotal]
  );

  const doneSteps = wisp.steps.filter((s) => s.status === 'done' || s.status === 'completed').length;
  const isUrgent = ttlRemaining >= 0 && ttlRemaining < 60000;
  const isDead = ttlRemaining === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ y: -1 }}
      onClick={onSelect}
      className={`
        relative bg-[#1a1f26] border rounded-none p-4 cursor-pointer
        transition-all duration-200 font-mono
        ${isSelected ? 'border-[#2d363f] bg-[#1a1f26]' : 'border-[#2d363f] hover:border-[#2d363f]'}
        ${ttlPct >= 0 ? ttlGlowColor(ttlPct) : ''}
        ${isUrgent && !isDead ? 'animate-pulse' : ''}
      `}
    >
      {/* Status dot */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <span
          className={`text-[9px] px-1.5 py-0 border rounded-none ${
            STATUS_CLS[wisp.status] || STATUS_CLS.active
          }`}
        >
          {wisp.status}
        </span>
      </div>

      {/* Wisp ID */}
      <div className="text-[11px] text-[#e6e1cf]/80 mb-0.5 pr-16 truncate">{truncId(wisp.id)}</div>
      <div className="text-[10px] text-[#4a5159] truncate mb-3">
        {wisp.formulaName || wisp.name}
      </div>

      {/* TTL Countdown Bar */}
      {ttlPct >= 0 ? (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-[#4a5159] uppercase tracking-wider">TTL</span>
            <span
              className={`text-[10px] tabular-nums font-bold ${
                isDead ? 'text-red-400' : ttlPct < 25 ? 'text-red-400' : ttlPct < 50 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {isDead ? 'EXPIRED' : formatMs(ttlRemaining)}
            </span>
          </div>
          <div className="h-1.5 bg-[#2d363f]/30 rounded-none overflow-hidden">
            <motion.div
              className={`h-full rounded-none transition-colors duration-500 ${ttlBarColor(ttlPct)}`}
              initial={false}
              animate={{ width: `${ttlPct}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
          {/* Flashing red overlay when < 1min */}
          {isUrgent && !isDead && (
            <motion.div
              className="absolute inset-0 border-2 border-red-500/30 rounded-none pointer-events-none"
              animate={{ opacity: [0, 0.6, 0] }}
              transition={{ duration: 1, repeat: Infinity }}
            />
          )}
        </div>
      ) : (
        <div className="mb-3">
          <div className="text-[9px] text-[#4a5159] italic">TTL unknown</div>
        </div>
      )}

      {/* Step progress */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 h-1 bg-[#2d363f]/30 rounded-none overflow-hidden">
          <div
            className="h-full bg-violet-500/40 transition-all"
            style={{
              width: wisp.steps.length ? `${(doneSteps / wisp.steps.length) * 100}%` : '0%',
            }}
          />
        </div>
        <span className="text-[9px] text-[#4a5159] tabular-nums">
          {doneSteps}/{wisp.steps.length} steps
        </span>
      </div>

      {/* Created time */}
      <div className="text-[9px] text-[#4a5159] mb-3">
        {wisp.createdAt ? relativeTime(wisp.createdAt) : '--'}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPromote();
          }}
          disabled={actionLoading !== null}
          className="flex-1 text-[9px] uppercase tracking-widest px-2 py-1.5 border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 rounded-none hover:bg-cyan-500/20 disabled:opacity-30 transition-colors"
          title="Promote to LIQUID"
        >
          {actionLoading === `promote-${wisp.id}` ? '...' : 'Promote'}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onBurn();
          }}
          disabled={actionLoading !== null}
          className="flex-1 text-[9px] uppercase tracking-widest px-2 py-1.5 border border-red-500/30 bg-red-500/10 text-red-400 rounded-none hover:bg-red-500/20 disabled:opacity-30 transition-colors"
          title="Burn (destroy)"
        >
          {actionLoading === `burn-${wisp.id}` ? '...' : 'Expire'}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Detail Panel (right slide-over) ────────────────────────────────────────

function DetailPanel({
  wisp,
  onClose,
  onPromote,
  onBurn,
  actionLoading,
}: {
  wisp: Wisp;
  onClose: () => void;
  onPromote: () => void;
  onBurn: () => void;
  actionLoading: string | null;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const ttlRemaining = useMemo(() => getTtlRemaining(wisp), [wisp, now]);
  const ttlTotal = useMemo(() => getTtlTotal(wisp), [wisp]);
  const ttlPct = useMemo(
    () => (ttlTotal > 0 ? Math.max(0, Math.min(100, (ttlRemaining / ttlTotal) * 100)) : -1),
    [ttlRemaining, ttlTotal]
  );

  const doneSteps = wisp.steps.filter((s) => s.status === 'done' || s.status === 'completed').length;

  return (
    <motion.div
      initial={{ x: 340, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 340, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className="w-[340px] h-full border-l border-[#2d363f] bg-[#1a1f26] flex flex-col overflow-hidden flex-shrink-0"
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#2d363f] flex items-center justify-between">
        <div>
          <div className="text-xs font-bold text-[#e6e1cf] uppercase tracking-wider">Wisp Detail</div>
          <div className="text-[10px] text-[#4a5159] mt-0.5">{truncId(wisp.id)}</div>
        </div>
        <button
          onClick={onClose}
          className="text-[10px] text-[#4a5159] hover:text-[#6c7680] transition-colors px-2 py-1 border border-[#2d363f] rounded-none hover:border-[#2d363f]"
        >
          CLOSE
        </button>
      </div>

      {/* Metadata section */}
      <div className="px-4 py-3 border-b border-[#2d363f] overflow-y-auto flex-shrink-0">
        <div className="text-[10px] uppercase tracking-widest text-[#4a5159] mb-2">Metadata</div>
        <div className="space-y-1.5">
          {[
            { label: 'ID', value: wisp.id },
            { label: 'Phase', value: 'VAPOR' },
            { label: 'Status', value: wisp.status },
            { label: 'TTL Total', value: ttlTotal > 0 ? formatMs(ttlTotal) : 'unknown' },
            { label: 'TTL Remaining', value: ttlRemaining >= 0 ? formatMs(ttlRemaining) : 'unknown' },
            { label: 'Expires At', value: wisp.expiresAt || '--' },
            { label: 'Created At', value: wisp.createdAt || '--' },
            { label: 'Formula', value: wisp.formulaName || wisp.name || '--' },
          ].map((row) => (
            <div key={row.label} className="flex justify-between items-start gap-2">
              <span className="text-[10px] text-[#4a5159] flex-shrink-0">{row.label}</span>
              <span className="text-[10px] text-[#e6e1cf]/80 text-right break-all font-mono">
                {row.value}
              </span>
            </div>
          ))}
        </div>

        {/* TTL bar */}
        {ttlPct >= 0 && (
          <div className="mt-3">
            <div className="h-2 bg-[#2d363f]/30 rounded-none overflow-hidden">
              <motion.div
                className={`h-full rounded-none ${ttlBarColor(ttlPct)}`}
                animate={{ width: `${ttlPct}%` }}
                transition={{ duration: 0.8 }}
              />
            </div>
            <div className="text-[9px] text-[#4a5159] mt-1 text-center tabular-nums">
              {ttlPct.toFixed(1)}% remaining
            </div>
          </div>
        )}
      </div>

      {/* Steps section */}
      <div className="flex-1 px-4 py-3 border-b border-[#2d363f] overflow-y-auto min-h-0">
        <div className="text-[10px] uppercase tracking-widest text-[#4a5159] mb-2">
          Steps ({doneSteps}/{wisp.steps.length})
        </div>
        {wisp.steps.length === 0 ? (
          <div className="text-[10px] text-[#4a5159] italic">No steps defined</div>
        ) : (
          <div className="space-y-1">
            {wisp.steps.map((step) => (
              <div
                key={step.id}
                className="flex items-center gap-2 py-1 border-b border-[#2d363f]/30"
              >
                <div
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    STEP_STATUS_CLS[step.status]?.split(' ')[0] || 'bg-zinc-500/30'
                  }`}
                />
                <span className="text-[10px] text-[#6c7680] truncate flex-1">{step.name}</span>
                <span
                  className={`text-[8px] px-1 py-0 border rounded-none ${
                    STEP_STATUS_CLS[step.status] || 'bg-zinc-500/10 text-zinc-500'
                  } border-[#2d363f]`}
                >
                  {step.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Vars section */}
      {wisp.vars && Object.keys(wisp.vars).length > 0 && (
        <div className="px-4 py-3 border-b border-[#2d363f] overflow-y-auto max-h-[120px] flex-shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-[#4a5159] mb-2">Variables</div>
          <pre className="text-[9px] text-[#4a5159] bg-black/30 p-2 rounded-none overflow-auto max-h-[80px]">
            {JSON.stringify(wisp.vars, null, 2)}
          </pre>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-4 mt-auto flex-shrink-0">
        <div className="text-[10px] uppercase tracking-widest text-[#4a5159] mb-2">Actions</div>
        <div className="space-y-2">
          <button
            onClick={onPromote}
            disabled={actionLoading !== null}
            className="w-full text-[10px] uppercase tracking-widest px-3 py-2.5 border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 rounded-none hover:bg-cyan-500/20 disabled:opacity-30 transition-colors"
          >
            {actionLoading === `promote-${wisp.id}` ? 'Promoting...' : 'Promote to LIQUID'}
          </button>
          <button
            onClick={onBurn}
            disabled={actionLoading !== null}
            className="w-full text-[10px] uppercase tracking-widest px-3 py-2.5 border border-red-500/30 bg-red-500/10 text-red-400 rounded-none hover:bg-red-500/20 disabled:opacity-30 transition-colors"
          >
            {actionLoading === `burn-${wisp.id}` ? 'Burning...' : 'Expire Now (Burn)'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function WispMonitorView() {
  const [wisps, setWisps] = useState<Wisp[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('ttl-asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch wisps ───────────────────────────────────────────────────────

  const fetchWisps = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/molecules?phase=vapor&limit=100`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: Wisp[] = Array.isArray(data) ? data : data.molecules ?? [];
      setWisps(items);
      setConnected(true);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setConnected(false);
      setError('Failed to reach MEOW engine');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Polling lifecycle (3s for time-sensitive wisps) ────────────────────

  useEffect(() => {
    abortRef.current = new AbortController();
    fetchWisps(abortRef.current.signal);

    intervalRef.current = setInterval(() => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      fetchWisps(ctrl.signal);
    }, POLL_INTERVAL);

    return () => {
      abortRef.current?.abort();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchWisps]);

  // ── Actions ───────────────────────────────────────────────────────────

  const promoteWisp = useCallback(
    async (wispId: string) => {
      setActionLoading(`promote-${wispId}`);
      try {
        const res = await fetch(`${API}/api/meow/pour/${wispId}`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        await fetchWisps(ctrl.signal);
        // If the promoted wisp was selected, deselect
        if (selectedId === wispId) setSelectedId(null);
      } catch {
        // Data refreshes on next poll
      } finally {
        setActionLoading(null);
      }
    },
    [fetchWisps, selectedId]
  );

  const burnWisp = useCallback(
    async (wispId: string) => {
      setActionLoading(`burn-${wispId}`);
      try {
        const res = await fetch(`${API}/api/meow/wisp/${wispId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        await fetchWisps(ctrl.signal);
        if (selectedId === wispId) setSelectedId(null);
      } catch {
        // Data refreshes on next poll
      } finally {
        setActionLoading(null);
      }
    },
    [fetchWisps, selectedId]
  );

  // ── Derived data ──────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = wisps.length;
    let totalTtl = 0;
    let ttlCount = 0;
    let expiringSoon = 0;

    wisps.forEach((w) => {
      const remaining = getTtlRemaining(w);
      if (remaining >= 0) {
        totalTtl += remaining;
        ttlCount++;
        if (remaining < 60000) expiringSoon++;
      }
    });

    const avgTtl = ttlCount > 0 ? totalTtl / ttlCount : -1;

    return { total, avgTtl, expiringSoon };
  }, [wisps]);

  const sorted = useMemo(() => {
    const arr = [...wisps];
    switch (sortMode) {
      case 'ttl-asc':
        arr.sort((a, b) => {
          const ra = getTtlRemaining(a);
          const rb = getTtlRemaining(b);
          if (ra < 0 && rb < 0) return 0;
          if (ra < 0) return 1;
          if (rb < 0) return -1;
          return ra - rb;
        });
        break;
      case 'ttl-desc':
        arr.sort((a, b) => {
          const ra = getTtlRemaining(a);
          const rb = getTtlRemaining(b);
          if (ra < 0 && rb < 0) return 0;
          if (ra < 0) return 1;
          if (rb < 0) return -1;
          return rb - ra;
        });
        break;
      case 'created-asc':
        arr.sort((a, b) => {
          const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return ca - cb;
        });
        break;
      case 'created-desc':
        arr.sort((a, b) => {
          const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return cb - ca;
        });
        break;
      case 'status':
        arr.sort((a, b) => a.status.localeCompare(b.status));
        break;
    }
    return arr;
  }, [wisps, sortMode]);

  const selectedWisp = useMemo(
    () => wisps.find((w) => w.id === selectedId) ?? null,
    [wisps, selectedId]
  );

  // ── Sort options ──────────────────────────────────────────────────────

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: 'ttl-asc', label: 'TTL (Urgent First)' },
    { value: 'ttl-desc', label: 'TTL (Most Time)' },
    { value: 'created-desc', label: 'Newest First' },
    { value: 'created-asc', label: 'Oldest First' },
    { value: 'status', label: 'Status' },
  ];

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-[#0f1419] font-mono text-[#e6e1cf] overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-[#2d363f] bg-[#1a1f26]/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          <h1 className="text-sm font-bold tracking-[0.2em] uppercase text-[#e6e1cf]">
            Wisp Monitor
          </h1>
          <span className="text-[10px] px-2 py-0.5 bg-violet-500/10 border border-violet-500/30 text-violet-400 rounded-none">
            VAPOR PHASE
          </span>
          <span className="text-[10px] px-2 py-0.5 bg-[#2d363f]/30 border border-[#2d363f] text-[#4a5159] rounded-none">
            {wisps.length} wisps
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[#4a5159]">
            {connected ? 'LIVE' : 'OFFLINE'} &middot; {POLL_INTERVAL / 1000}s
          </span>
        </div>
      </header>

      {/* ── Stats Bar ──────────────────────────────────────────────────── */}
      <div className="flex items-stretch gap-3 px-5 py-3 border-b border-[#2d363f] flex-shrink-0 overflow-x-auto">
        <StatCard
          label="Active Wisps"
          value={stats.total}
          color="text-violet-400"
        />
        <StatCard
          label="Avg TTL Remaining"
          value={stats.avgTtl >= 0 ? formatMs(stats.avgTtl) : '--'}
          color="text-cyan-400"
        />
        <StatCard
          label="Expiring < 1min"
          value={stats.expiringSoon}
          color={stats.expiringSoon > 0 ? 'text-red-400' : 'text-emerald-400'}
          subtext={stats.expiringSoon > 0 ? 'Urgent attention needed' : 'All clear'}
        />
        <StatCard
          label="Promoted Today"
          value="--"
          color="text-cyan-400"
          subtext="Requires history data"
        />
        <StatCard
          label="Burned Today"
          value="--"
          color="text-red-400"
          subtext="Requires history data"
        />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-[#2d363f] flex-shrink-0">
        <span className="text-[10px] uppercase tracking-widest text-[#4a5159]">Sort:</span>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setSortMode(opt.value)}
            className={`text-[10px] px-2.5 py-1 border rounded-none transition-all ${
              sortMode === opt.value
                ? 'border-violet-500/30 text-violet-400 bg-violet-500/10'
                : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680] hover:border-[#2d363f]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Main Content ───────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* ── Wisp Grid ───────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-[200px] w-full" />
              ))}
            </div>
          ) : error ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-full gap-4"
            >
              <div className="text-4xl opacity-20">&#x1F4A8;</div>
              <div className="text-sm text-red-400/80 uppercase tracking-widest">{error}</div>
              <p className="text-xs text-[#4a5159] max-w-xs text-center">
                Unable to reach the MEOW engine wisp endpoint. Check that the orchestrator is running.
              </p>
              <button
                onClick={() => {
                  setLoading(true);
                  setError(null);
                  const ctrl = new AbortController();
                  abortRef.current = ctrl;
                  fetchWisps(ctrl.signal);
                }}
                className="mt-2 text-[10px] uppercase tracking-widest px-4 py-2 border border-[#2d363f] hover:border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf] rounded-none transition-colors"
              >
                Retry
              </button>
            </motion.div>
          ) : sorted.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-full gap-4"
            >
              <div className="text-4xl opacity-15">&#x1F4A8;</div>
              <div className="text-sm text-[#4a5159] uppercase tracking-widest">
                No Active Wisps
              </div>
              <p className="text-xs text-[#4a5159] max-w-sm text-center leading-relaxed">
                No active wisps. Cook a formula and choose &ldquo;Wisp&rdquo; to create ephemeral molecules.
              </p>
              {/* Decorative vapor particles */}
              <div className="relative w-40 h-20 mt-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute w-1.5 h-1.5 rounded-full bg-violet-400/20"
                    style={{
                      left: `${20 + Math.random() * 60}%`,
                      top: `${30 + Math.random() * 40}%`,
                    }}
                    animate={{
                      opacity: [0, 0.4, 0],
                      y: [0, -20, -40],
                    }}
                    transition={{
                      duration: 3 + Math.random() * 2,
                      repeat: Infinity,
                      delay: Math.random() * 2,
                    }}
                  />
                ))}
              </div>
            </motion.div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              <AnimatePresence mode="popLayout">
                {sorted.map((wisp) => (
                  <WispCard
                    key={wisp.id}
                    wisp={wisp}
                    isSelected={selectedId === wisp.id}
                    onSelect={() => setSelectedId(selectedId === wisp.id ? null : wisp.id)}
                    onPromote={() => promoteWisp(wisp.id)}
                    onBurn={() => burnWisp(wisp.id)}
                    actionLoading={actionLoading}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </main>

        {/* ── Right Detail Panel ──────────────────────────────────────── */}
        <AnimatePresence mode="wait">
          {selectedWisp && (
            <DetailPanel
              key={selectedWisp.id}
              wisp={selectedWisp}
              onClose={() => setSelectedId(null)}
              onPromote={() => promoteWisp(selectedWisp.id)}
              onBurn={() => burnWisp(selectedWisp.id)}
              actionLoading={actionLoading}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="flex items-center justify-between px-5 py-2 border-t border-[#2d363f] bg-[#1a1f26]/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-[#4a5159]">
            WISPS: {wisps.length}
          </span>
          <span className="text-[10px] text-[#4a5159]">
            SORT: {SORT_OPTIONS.find((o) => o.value === sortMode)?.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {stats.expiringSoon > 0 && (
            <span className="text-[10px] px-2 py-0.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded-none animate-pulse">
              {stats.expiringSoon} CRITICAL
            </span>
          )}
          <span className="text-[10px] text-[#4a5159]">
            poll: {POLL_INTERVAL / 1000}s
          </span>
        </div>
      </footer>
    </div>
  );
}
