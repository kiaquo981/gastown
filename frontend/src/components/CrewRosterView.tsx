'use client';

/**
 * CrewRosterView — GT-009: Crew Roster (Long-lived Agent Roster)
 *
 * Permanent, long-lived agents in Gas Town (unlike ephemeral polecats).
 * VOID AESTHETIC: bg-[#0a0e27], borders white/5, text white/87, font-mono.
 * Auto-refresh every 8s with AbortController cleanup.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ───────────────────────────────────────────────────────────────

interface CrewMember {
  id: string;
  name: string;
  specialization: string;
  status: 'active' | 'paused' | 'idle';
  currentAssignment: string | null;
  capabilities: string[];
  metrics: { tasksCompleted: number; avgDuration: string; successRate: number };
  assignmentHistory?: AssignmentRecord[];
  contextState?: Record<string, unknown>;
}

interface AssignmentRecord {
  id: string;
  task: string;
  startedAt: string;
  completedAt: string | null;
  status: 'completed' | 'in_progress' | 'failed';
}

interface CrewStats {
  total: number;
  active: number;
  paused: number;
  idle: number;
  totalAssignments: number;
  avgCompletionTime: string;
  mostActive: { id: string; name: string; tasks: number } | null;
}

type StatusFilter = 'all' | 'active' | 'paused' | 'idle';

// ─── Constants ───────────────────────────────────────────────────────────

const POLL = 8000;

const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string; border: string }> = {
  active: { dot: 'bg-emerald-400', bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
  paused: { dot: 'bg-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
  idle:   { dot: 'bg-zinc-400', bg: 'bg-zinc-500/10', text: 'text-zinc-400', border: 'border-zinc-500/20' },
};

const FALLBACK_STATS: CrewStats = {
  total: 0, active: 0, paused: 0, idle: 0,
  totalAssignments: 0, avgCompletionTime: '--', mostActive: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function ss(s: string) { return STATUS_STYLES[s] || STATUS_STYLES.idle; }

function formatTime(ts: string | null): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return '--'; }
}

// ─── Sub-components ──────────────────────────────────────────────────────

function StatBadge({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
      <span className="text-sm font-mono text-white/[0.87]">{value}</span>
    </div>
  );
}

function ActionButton({ label, variant = 'default', onClick }: {
  label: string; variant?: 'default' | 'warn' | 'success'; onClick: () => void;
}) {
  const colors = {
    default: 'border-white/10 text-white/60 hover:bg-white/5',
    warn: 'border-amber-500/20 text-amber-400/80 hover:bg-amber-500/10',
    success: 'border-emerald-500/20 text-emerald-400/80 hover:bg-emerald-500/10',
  };
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border rounded-none transition-colors ${colors[variant]}`}>
      {label}
    </button>
  );
}

// ─── Crew Card ───────────────────────────────────────────────────────────

function CrewCard({ member, expanded, onToggle, onAction }: {
  member: CrewMember; expanded: boolean; onToggle: () => void;
  onAction: (action: string, id: string) => void;
}) {
  const st = ss(member.status);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className={`bg-[#0d1117] border ${expanded ? 'border-white/10' : 'border-white/5'} rounded-none transition-colors`}
    >
      {/* Card header — clickable */}
      <button onClick={onToggle} className="w-full text-left p-4 focus:outline-none">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-none ${st.dot}`} />
              <h3 className="text-sm font-mono text-white/[0.87] truncate">{member.name}</h3>
              <span className={`px-1.5 py-0.5 text-[10px] font-mono uppercase ${st.bg} ${st.text} border ${st.border} rounded-none`}>
                {member.status}
              </span>
            </div>
            <p className="text-xs font-mono text-white/40 mb-2">{member.specialization}</p>

            {member.currentAssignment && (
              <div className="flex items-center gap-1.5 mb-3">
                <span className="text-[10px] font-mono uppercase text-white/30">ASSIGNED:</span>
                <span className="text-xs font-mono text-violet-400/80 truncate">{member.currentAssignment}</span>
              </div>
            )}

            {/* Performance metrics */}
            <div className="flex gap-4">
              <StatBadge label="Tasks" value={member.metrics.tasksCompleted} />
              <StatBadge label="Avg Duration" value={member.metrics.avgDuration} />
              <StatBadge label="Success" value={`${member.metrics.successRate}%`} />
            </div>
          </div>
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}
            className="text-white/20 text-xs mt-1">&#x25BC;</motion.span>
        </div>

        {/* Capabilities tags */}
        {member.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {member.capabilities.slice(0, 6).map((cap) => (
              <span key={cap} className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-cyan-400/80 bg-cyan-500/10 border border-cyan-500/15 rounded-none">
                {cap}
              </span>
            ))}
            {member.capabilities.length > 6 && (
              <span className="text-[10px] font-mono text-white/30 self-center">+{member.capabilities.length - 6}</span>
            )}
          </div>
        )}
      </button>

      {/* Expanded detail panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/5 px-4 py-3 space-y-3">
              {/* Action buttons */}
              <div className="flex gap-2 flex-wrap">
                <ActionButton label="Assign Task" variant="success" onClick={() => onAction('assign', member.id)} />
                {member.status === 'active'
                  ? <ActionButton label="Pause" variant="warn" onClick={() => onAction('pause', member.id)} />
                  : <ActionButton label="Resume" variant="success" onClick={() => onAction('resume', member.id)} />
                }
                <ActionButton label="View Agent" onClick={() => {
                  const url = new URL(window.location.href);
                  url.searchParams.set('view', 'agents');
                  url.searchParams.set('filter', member.id);
                  window.history.pushState({}, '', url.toString());
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }} />
              </div>

              {/* Context state */}
              {member.contextState && Object.keys(member.contextState).length > 0 && (
                <div>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-white/30 block mb-1">CONTEXT STATE</span>
                  <pre className="text-[11px] font-mono text-white/40 bg-white/[0.02] border border-white/5 p-2 rounded-none overflow-x-auto max-h-24">
                    {JSON.stringify(member.contextState, null, 2)}
                  </pre>
                </div>
              )}

              {/* Assignment history */}
              {member.assignmentHistory && member.assignmentHistory.length > 0 && (
                <div>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-white/30 block mb-1">ASSIGNMENT HISTORY</span>
                  <div className="space-y-1">
                    {member.assignmentHistory.slice(0, 5).map((rec) => (
                      <div key={rec.id} className="flex items-center gap-2 text-[11px] font-mono">
                        <span className={`w-1.5 h-1.5 rounded-none ${
                          rec.status === 'completed' ? 'bg-emerald-400' : rec.status === 'failed' ? 'bg-red-400' : 'bg-blue-400'
                        }`} />
                        <span className="text-white/50 truncate flex-1">{rec.task}</span>
                        <span className="text-white/25 shrink-0">{formatTime(rec.completedAt || rec.startedAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

export default function CrewRosterView() {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [stats, setStats] = useState<CrewStats>(FALLBACK_STATS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [specFilter, setSpecFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // ── Fetch data ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [crewRes, statsRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/crew`, { signal }),
        fetch(`${API}/api/meow/crew/stats`, { signal }),
      ]);
      if (!mountedRef.current) return;

      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const d = await crewRes.value.json();
        setCrew(Array.isArray(d) ? d : d.crew || []);
      }
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const d = await statsRes.value.json();
        setStats((prev) => ({ ...prev, ...d }));
      }
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach crew roster endpoint');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${API}/api/meow/crew/${id}`, { signal: ctrl.signal });
      if (!res.ok || !mountedRef.current) return;
      const detail = await res.json();
      setCrew((prev) => prev.map((m) => (m.id === id ? { ...m, ...detail } : m)));
    } catch {
      // silent — detail is optional enrichment
    }
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleAction = useCallback(async (action: string, id: string) => {
    try {
      const ep = action === 'assign'
        ? `${API}/api/meow/crew/${id}/assign`
        : action === 'pause'
        ? `${API}/api/meow/crew/${id}/pause`
        : `${API}/api/meow/crew/${id}/resume`;
      await fetch(ep, { method: 'POST' });
      const ctrl = new AbortController();
      await fetchData(ctrl.signal);
    } catch {
      // silent
    }
  }, [fetchData]);

  // ── Lifecycle ──────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchData(ctrl.signal);

    const interval = setInterval(() => {
      const c = new AbortController();
      abortRef.current = c;
      fetchData(c.signal);
    }, POLL);

    return () => {
      mountedRef.current = false;
      ctrl.abort();
      abortRef.current?.abort();
      clearInterval(interval);
    };
  }, [fetchData]);

  // Fetch detail when card expanded
  useEffect(() => {
    if (expandedId) fetchDetail(expandedId);
  }, [expandedId, fetchDetail]);

  // ── Derived state ──────────────────────────────────────────────────────

  const specializations = useMemo(
    () => Array.from(new Set(crew.map((m) => m.specialization))).sort(),
    [crew],
  );

  const filtered = useMemo(() => crew.filter((m) => {
    if (statusFilter !== 'all' && m.status !== statusFilter) return false;
    if (specFilter !== 'all' && m.specialization !== specFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return m.name.toLowerCase().includes(q)
        || m.specialization.toLowerCase().includes(q)
        || m.capabilities.some((c) => c.toLowerCase().includes(q));
    }
    return true;
  }), [crew, statusFilter, specFilter, search]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0e27] text-white/[0.87] font-mono p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl tracking-wider uppercase text-white/[0.87]">Crew Roster</h1>
          <p className="text-xs text-white/30 mt-1">Long-lived agents &mdash; {stats.total} registered</p>
        </div>

        {/* Status breakdown pills */}
        <div className="flex gap-3">
          {(['active', 'paused', 'idle'] as const).map((s) => {
            const st = ss(s);
            const count = s === 'active' ? stats.active : s === 'paused' ? stats.paused : stats.idle;
            return (
              <div key={s} className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-none ${st.border} ${st.bg}`}>
                <div className={`w-1.5 h-1.5 rounded-none ${st.dot}`} />
                <span className={`text-[11px] uppercase ${st.text}`}>{s}</span>
                <span className="text-[11px] text-white/40">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search crew..."
          className="flex-1 bg-white/[0.03] border border-white/5 rounded-none px-3 py-2 text-xs font-mono text-white/[0.87] placeholder:text-white/20 focus:outline-none focus:border-white/15 transition-colors"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-white/[0.03] border border-white/5 rounded-none px-3 py-2 text-xs font-mono text-white/[0.87] focus:outline-none focus:border-white/15 appearance-none cursor-pointer"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="idle">Idle</option>
        </select>
        <select
          value={specFilter}
          onChange={(e) => setSpecFilter(e.target.value)}
          className="bg-white/[0.03] border border-white/5 rounded-none px-3 py-2 text-xs font-mono text-white/[0.87] focus:outline-none focus:border-white/15 appearance-none cursor-pointer"
        >
          <option value="all">All Specializations</option>
          {specializations.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-red-500/10 border border-red-500/20 rounded-none px-4 py-2 text-xs font-mono text-red-400"
        >
          {error}
        </motion.div>
      )}

      {/* Loading skeleton */}
      {loading && crew.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
              className="h-40 bg-white/[0.02] border border-white/5 rounded-none"
            />
          ))}
        </div>
      )}

      {/* Crew grid */}
      {filtered.length > 0 && (
        <motion.div layout className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {filtered.map((member) => (
              <CrewCard
                key={member.id}
                member={member}
                expanded={expandedId === member.id}
                onToggle={() => setExpandedId(expandedId === member.id ? null : member.id)}
                onAction={handleAction}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-white/20">
          <span className="text-3xl mb-3">&#x1F6E1;</span>
          <span className="text-sm font-mono">
            {crew.length === 0 ? 'No crew members registered' : 'No matches for current filters'}
          </span>
        </div>
      )}

      {/* Summary section */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
        <div className="bg-[#0d1117] border border-white/5 rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">TOTAL ASSIGNMENTS</span>
          <span className="text-2xl font-mono text-white/[0.87]">{stats.totalAssignments}</span>
        </div>
        <div className="bg-[#0d1117] border border-white/5 rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">AVG COMPLETION TIME</span>
          <span className="text-2xl font-mono text-white/[0.87]">{stats.avgCompletionTime}</span>
        </div>
        <div className="bg-[#0d1117] border border-white/5 rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/30 block mb-1">MOST ACTIVE</span>
          {stats.mostActive ? (
            <div>
              <span className="text-lg font-mono text-emerald-400">{stats.mostActive.name}</span>
              <span className="text-xs text-white/30 ml-2">{stats.mostActive.tasks} tasks</span>
            </div>
          ) : (
            <span className="text-lg font-mono text-white/20">--</span>
          )}
        </div>
      </div>

      {/* Auto-refresh indicator */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <motion.div
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-1.5 h-1.5 bg-emerald-400/60 rounded-none"
        />
        <span className="text-[10px] font-mono text-white/20">Auto-refresh {POLL / 1000}s</span>
      </div>
    </div>
  );
}
