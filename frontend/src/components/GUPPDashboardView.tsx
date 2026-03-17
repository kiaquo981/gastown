'use client';

/**
 * GUPPDashboardView — "Physics over Politeness" Propulsion Dashboard
 *
 * GUPP (Gas Town's propulsion engine) places hooks on agents.
 * Agents MUST execute work on their hook — no negotiation.
 *
 * Endpoints:
 *   GET  /api/meow/gupp/stats          — overall GUPP stats
 *   GET  /api/meow/gupp/hooks          — all hooks
 *   GET  /api/meow/gupp/hooks/pending  — pending hooks only
 *   POST /api/meow/gupp/hooks          — place new hook
 *   POST /api/meow/gupp/hooks/:id/claim    — claim hook
 *   POST /api/meow/gupp/hooks/:id/complete — complete hook
 *   POST /api/meow/gupp/scan           — trigger scan
 *
 * Ayu Dark palette:
 *   bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680
 *   border #2d363f, green #c2d94c, yellow #ffb454, red #f07178, cyan #95e6cb
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type HookStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
type HookPriority = 'critical' | 'high' | 'normal' | 'low';

interface GUPPHook {
  id: string;
  beadId: string;
  agentAddress: string;
  skill: string;
  priority: HookPriority;
  status: HookStatus;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  result?: string;
  latencyMs?: number;
  executionMs?: number;
}

interface GUPPStats {
  totalHooks: number;
  pending: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  avgLatencyMs: number;
  avgExecutionMs: number;
  maxPendingHooks: number;
  loopRunning: boolean;
  lastScanAt?: string;
  backpressure?: boolean;
}

interface NudgeMessage {
  id: string;
  agentAddress: string;
  beadId: string;
  skill: string;
  timestamp: string;
  message: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 4000;

const STATUS_CONFIG: Record<HookStatus, { label: string; color: string; bg: string; border: string }> = {
  pending:   { label: 'PENDING',   color: '#ffb454', bg: 'rgba(255,180,84,0.08)',  border: 'rgba(255,180,84,0.25)' },
  claimed:   { label: 'CLAIMED',   color: '#95e6cb', bg: 'rgba(149,230,203,0.08)', border: 'rgba(149,230,203,0.25)' },
  running:   { label: 'RUNNING',   color: '#59c2ff', bg: 'rgba(89,194,255,0.08)',  border: 'rgba(89,194,255,0.25)' },
  completed: { label: 'COMPLETED', color: '#c2d94c', bg: 'rgba(194,217,76,0.08)',  border: 'rgba(194,217,76,0.25)' },
  failed:    { label: 'FAILED',    color: '#f07178', bg: 'rgba(240,113,120,0.08)', border: 'rgba(240,113,120,0.25)' },
};

const PRIORITY_CONFIG: Record<HookPriority, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: 'CRIT', color: '#f07178', bg: 'rgba(240,113,120,0.12)', border: 'rgba(240,113,120,0.3)' },
  high:     { label: 'HIGH', color: '#ffb454', bg: 'rgba(255,180,84,0.10)',  border: 'rgba(255,180,84,0.25)' },
  normal:   { label: 'NORM', color: '#e6e1cf', bg: 'rgba(230,225,207,0.05)', border: 'rgba(230,225,207,0.12)' },
  low:      { label: 'LOW',  color: '#6c7680', bg: 'rgba(108,118,128,0.08)', border: 'rgba(108,118,128,0.15)' },
};

const PIPELINE_STAGES: HookStatus[] = ['pending', 'claimed', 'running', 'completed', 'failed'];

const SKILLS = [
  'code:generate', 'code:review', 'code:refactor', 'code:test',
  'research:web', 'research:docs', 'research:analyze',
  'deploy:staging', 'deploy:production',
  'write:copy', 'write:docs',
  'design:ui', 'design:system',
  'ops:monitor', 'ops:fix', 'ops:scale',
];

const NUDGE_PHRASES = [
  'GUPP: Work slung to your hook -- YOU MUST RUN IT.',
  'GUPP: Hook placed. Physics, not politeness. Execute.',
  'GUPP: No negotiation. Bead assigned. Run it now.',
  'GUPP: Propulsion hook engaged. Agent must comply.',
  'GUPP: Work attached. Resistance is overhead. Execute.',
  'GUPP: Hook deployed. The physics of work compel you.',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso: string | undefined): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'future';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function truncateId(id: string, len = 8): string {
  if (!id) return '--';
  return id.length > len ? id.slice(0, len) : id;
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/** Stat badge used in the top banner */
function StatBadge({
  label,
  value,
  color,
  suffix,
}: {
  label: string;
  value: number | string;
  color: string;
  suffix?: string;
}) {
  return (
    <div
      className="px-4 py-3 border rounded-none min-w-[100px]"
      style={{ borderColor: '#2d363f', background: '#1a1f26' }}
    >
      <div className="text-[9px] uppercase tracking-widest" style={{ color: '#6c7680' }}>
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums mt-0.5" style={{ color }}>
        {value}
        {suffix && <span className="text-xs ml-1 font-normal" style={{ color: '#6c7680' }}>{suffix}</span>}
      </div>
    </div>
  );
}

/** A single hook card in the pipeline visualization */
function PipelineHookCard({ hook }: { hook: GUPPHook }) {
  const sc = STATUS_CONFIG[hook.status];
  const pc = PRIORITY_CONFIG[hook.priority];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ duration: 0.25 }}
      className="px-3 py-2 border rounded-none text-[10px] font-mono w-full"
      style={{ borderColor: sc.border, background: sc.bg }}
    >
      <div className="flex items-center justify-between mb-1">
        <span style={{ color: '#e6e1cf' }} className="font-semibold truncate max-w-[90px]">
          {hook.skill}
        </span>
        <span
          className="px-1.5 py-0.5 border rounded-none text-[8px]"
          style={{ color: pc.color, borderColor: pc.border, background: pc.bg }}
        >
          {pc.label}
        </span>
      </div>
      <div className="flex items-center gap-2" style={{ color: '#6c7680' }}>
        <span className="truncate max-w-[70px]" title={hook.beadId}>
          {truncateId(hook.beadId)}
        </span>
        <span className="truncate max-w-[60px]" title={hook.agentAddress}>
          {truncateId(hook.agentAddress, 10)}
        </span>
      </div>
      <div className="mt-1" style={{ color: '#6c7680' }}>
        {timeAgo(hook.createdAt)} ago
      </div>
    </motion.div>
  );
}

/** Backpressure gauge */
function BackpressureGauge({
  current,
  max,
  active,
}: {
  current: number;
  max: number;
  active: boolean;
}) {
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const level = pct >= 80 ? 'critical' : pct >= 50 ? 'warning' : 'normal';
  const barColor = level === 'critical' ? '#f07178' : level === 'warning' ? '#ffb454' : '#c2d94c';
  const labelColor = level === 'critical' ? '#f07178' : level === 'warning' ? '#ffb454' : '#c2d94c';

  return (
    <div
      className="border rounded-none p-4"
      style={{ borderColor: '#2d363f', background: '#1a1f26' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#e6e1cf' }}>
            Backpressure
          </span>
          {active && (
            <motion.span
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="px-2 py-0.5 text-[9px] border rounded-none font-semibold"
              style={{ color: '#f07178', borderColor: 'rgba(240,113,120,0.3)', background: 'rgba(240,113,120,0.1)' }}
            >
              ACTIVE
            </motion.span>
          )}
        </div>
        <span className="text-[10px] tabular-nums" style={{ color: '#6c7680' }}>
          {current} / {max} pending
        </span>
      </div>

      {/* Bar */}
      <div className="w-full h-3 rounded-none overflow-hidden" style={{ background: '#0f1419' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="h-full rounded-none"
          style={{ background: barColor }}
        />
      </div>

      {/* Ticks */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-[9px]" style={{ color: '#c2d94c' }}>0%</span>
        <span className="text-[9px]" style={{ color: '#ffb454' }}>50%</span>
        <span className="text-[9px]" style={{ color: '#f07178' }}>80%</span>
        <span className="text-[9px]" style={{ color: '#f07178' }}>100%</span>
      </div>

      {/* Status */}
      <div className="mt-3 text-center">
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: labelColor }}>
          {level === 'critical'
            ? 'CRITICAL -- Backpressure active, hooks throttled'
            : level === 'warning'
            ? 'WARNING -- Approaching capacity, monitor closely'
            : 'NORMAL -- Pipeline flowing freely'}
        </span>
      </div>
    </div>
  );
}

/** Nudge feed item */
function NudgeFeedItem({ nudge, index }: { nudge: NudgeMessage; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05, duration: 0.3 }}
      className="flex items-start gap-3 px-3 py-2 border-b"
      style={{ borderColor: '#2d363f' }}
    >
      <motion.div
        animate={{ scale: [1, 1.3, 1] }}
        transition={{ duration: 0.6, delay: index * 0.1 }}
        className="w-2 h-2 mt-1.5 rounded-none flex-shrink-0"
        style={{ background: '#ffb454' }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold" style={{ color: '#ffb454' }}>
          {nudge.message}
        </p>
        <div className="flex items-center gap-3 mt-1 text-[9px]" style={{ color: '#6c7680' }}>
          <span>Agent: {truncateId(nudge.agentAddress, 12)}</span>
          <span>Bead: {truncateId(nudge.beadId)}</span>
          <span>Skill: {nudge.skill}</span>
          <span className="ml-auto">{timeAgo(nudge.timestamp)}</span>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function GUPPDashboardView() {
  // State
  const [stats, setStats] = useState<GUPPStats | null>(null);
  const [hooks, setHooks] = useState<GUPPHook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [nudges, setNudges] = useState<NudgeMessage[]>([]);

  // Active hooks table
  const [expandedHookId, setExpandedHookId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');

  // Place hook form
  const [showPlaceForm, setShowPlaceForm] = useState(false);
  const [formBeadId, setFormBeadId] = useState('');
  const [formAgent, setFormAgent] = useState('');
  const [formSkill, setFormSkill] = useState(SKILLS[0]);
  const [formPriority, setFormPriority] = useState<HookPriority>('normal');
  const [placing, setPlacing] = useState(false);

  // Action states
  const [scanning, setScanning] = useState(false);
  const [togglingLoop, setTogglingLoop] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nudgeIdRef = useRef(0);

  // ── Fetch ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [statsRes, hooksRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/gupp/stats`, { signal }),
        fetch(`${API}/api/meow/gupp/hooks`, { signal }),
      ]);

      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const data = await statsRes.value.json();
        setStats(data);
      }

      if (hooksRes.status === 'fulfilled' && hooksRes.value.ok) {
        const data = await hooksRes.value.json();
        const hookList = Array.isArray(data) ? data : (data.hooks || []);
        setHooks(hookList);
      }

      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('GUPP Propulsion Offline');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Polling lifecycle ──────────────────────────────────────────────────

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

  // ── Actions ────────────────────────────────────────────────────────────

  const addNudge = useCallback((agentAddress: string, beadId: string, skill: string) => {
    nudgeIdRef.current += 1;
    const nudge: NudgeMessage = {
      id: `nudge-${nudgeIdRef.current}`,
      agentAddress,
      beadId,
      skill,
      timestamp: new Date().toISOString(),
      message: NUDGE_PHRASES[nudgeIdRef.current % NUDGE_PHRASES.length],
    };
    setNudges(prev => [nudge, ...prev].slice(0, 50));
  }, []);

  const placeHook = useCallback(async () => {
    if (!formBeadId.trim() || !formAgent.trim()) return;
    setPlacing(true);
    try {
      const res = await fetch(`${API}/api/meow/gupp/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beadId: formBeadId.trim(),
          agentAddress: formAgent.trim(),
          skill: formSkill,
          priority: formPriority,
        }),
      });
      if (res.ok) {
        addNudge(formAgent.trim(), formBeadId.trim(), formSkill);
        setFormBeadId('');
        setFormAgent('');
        setFormSkill(SKILLS[0]);
        setFormPriority('normal');
        setShowPlaceForm(false);
        fetchData();
      }
    } catch {
      /* network error */
    } finally {
      setPlacing(false);
    }
  }, [formBeadId, formAgent, formSkill, formPriority, addNudge, fetchData]);

  const claimHook = useCallback(async (hookId: string) => {
    try {
      const res = await fetch(`${API}/api/meow/gupp/hooks/${hookId}/claim`, { method: 'POST' });
      if (res.ok) fetchData();
    } catch { /* */ }
  }, [fetchData]);

  const completeHook = useCallback(async (hookId: string) => {
    try {
      const res = await fetch(`${API}/api/meow/gupp/hooks/${hookId}/complete`, { method: 'POST' });
      if (res.ok) fetchData();
    } catch { /* */ }
  }, [fetchData]);

  const triggerScan = useCallback(async () => {
    setScanning(true);
    try {
      await fetch(`${API}/api/meow/gupp/scan`, { method: 'POST' });
      fetchData();
    } catch { /* */ } finally {
      setScanning(false);
    }
  }, [fetchData]);

  const toggleLoop = useCallback(async () => {
    setTogglingLoop(true);
    try {
      const endpoint = stats?.loopRunning ? 'stop' : 'start';
      await fetch(`${API}/api/meow/gupp/${endpoint}`, { method: 'POST' });
      fetchData();
    } catch { /* */ } finally {
      setTogglingLoop(false);
    }
  }, [stats, fetchData]);

  const recoverNDI = useCallback(async () => {
    try {
      await fetch(`${API}/api/meow/gupp/recover-ndi`, { method: 'POST' });
      fetchData();
    } catch { /* */ }
  }, [fetchData]);

  // ── Derived state ──────────────────────────────────────────────────────

  const hooksByStage = useMemo(() => {
    const grouped: Record<HookStatus, GUPPHook[]> = {
      pending: [], claimed: [], running: [], completed: [], failed: [],
    };
    hooks.forEach(h => {
      if (grouped[h.status]) grouped[h.status].push(h);
    });
    return grouped;
  }, [hooks]);

  const filteredHooks = useMemo(() => {
    return hooks.filter(h => {
      if (statusFilter !== 'all' && h.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && h.priority !== priorityFilter) return false;
      if (agentFilter.trim()) {
        const q = agentFilter.toLowerCase();
        return (
          h.agentAddress.toLowerCase().includes(q) ||
          h.beadId.toLowerCase().includes(q) ||
          h.skill.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [hooks, statusFilter, priorityFilter, agentFilter]);

  const uniqueAgents = useMemo(() => {
    const set = new Set(hooks.map(h => h.agentAddress));
    return Array.from(set);
  }, [hooks]);

  const backpressurePending = stats?.pending ?? 0;
  const backpressureMax = stats?.maxPendingHooks ?? 100;
  const backpressureActive = stats?.backpressure ?? (backpressurePending / backpressureMax > 0.8);

  // ── Render ─────────────────────────────────────────────────────────────

  if (error && loading) {
    return (
      <div className="min-h-screen font-mono flex items-center justify-center" style={{ background: '#0f1419' }}>
        <div className="text-center">
          <div className="text-3xl mb-3 opacity-30">&#x2693;</div>
          <div className="text-sm font-bold uppercase tracking-widest mb-2" style={{ color: '#f07178' }}>
            {error}
          </div>
          <p className="text-xs mb-4" style={{ color: '#6c7680' }}>
            Unable to reach GUPP propulsion endpoints. Check orchestrator status.
          </p>
          <button
            onClick={() => { setLoading(true); setError(null); fetchData(); }}
            className="px-4 py-2 text-xs uppercase tracking-widest border rounded-none"
            style={{ color: '#e6e1cf', borderColor: '#2d363f' }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-mono" style={{ background: '#0f1419', color: '#e6e1cf' }}>
      <div className="max-w-[1440px] mx-auto p-6 space-y-6">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between"
        >
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-bold tracking-[0.2em] uppercase" style={{ color: '#e6e1cf' }}>
              GUPP Dashboard
            </h1>
            <span
              className="text-[10px] px-2 py-0.5 border rounded-none"
              style={{ borderColor: '#2d363f', color: '#6c7680', background: '#1a1f26' }}
            >
              Physics over Politeness
            </span>
            {stats?.loopRunning && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="text-[10px] px-2 py-0.5 border rounded-none"
                style={{ color: '#c2d94c', borderColor: 'rgba(194,217,76,0.3)', background: 'rgba(194,217,76,0.08)' }}
              >
                LOOP RUNNING
              </motion.span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(p => !p)}
              className="px-3 py-1.5 text-[10px] uppercase tracking-widest border rounded-none transition-colors"
              style={{
                borderColor: autoRefresh ? 'rgba(194,217,76,0.25)' : '#2d363f',
                color: autoRefresh ? '#c2d94c' : '#6c7680',
                background: autoRefresh ? 'rgba(194,217,76,0.06)' : 'transparent',
              }}
            >
              {autoRefresh ? 'Live' : 'Paused'}
            </button>
            <button
              onClick={() => fetchData()}
              className="px-3 py-1.5 text-[10px] uppercase tracking-widest border rounded-none"
              style={{ borderColor: '#2d363f', color: '#6c7680' }}
            >
              Refresh
            </button>
          </div>
        </motion.header>

        {/* ── 1. GUPP Stats Banner ───────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          {loading ? (
            <div className="flex gap-3 overflow-x-auto">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse px-4 py-3 border rounded-none min-w-[100px] h-[62px]"
                  style={{ borderColor: '#2d363f', background: '#1a1f26' }}
                />
              ))}
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto">
              <StatBadge label="Total Hooks" value={stats?.totalHooks ?? 0} color="#e6e1cf" />
              <StatBadge label="Pending"     value={stats?.pending ?? 0}    color="#ffb454" />
              <StatBadge label="Claimed"     value={stats?.claimed ?? 0}    color="#95e6cb" />
              <StatBadge label="Running"     value={stats?.running ?? 0}    color="#59c2ff" />
              <StatBadge label="Completed"   value={stats?.completed ?? 0}  color="#c2d94c" />
              <StatBadge label="Failed"      value={stats?.failed ?? 0}     color="#f07178" />
              <StatBadge
                label="Avg Latency"
                value={formatMs(stats?.avgLatencyMs)}
                color="#95e6cb"
              />
              <StatBadge
                label="Avg Exec"
                value={formatMs(stats?.avgExecutionMs)}
                color="#59c2ff"
              />
            </div>
          )}
        </motion.section>

        {/* ── 2. Hook Pipeline ───────────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="border rounded-none p-4"
          style={{ borderColor: '#2d363f', background: '#1a1f26' }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#e6e1cf' }}>
              Hook Pipeline
            </h2>
            <span className="text-[9px]" style={{ color: '#6c7680' }}>
              {hooks.length} total hooks in system
            </span>
          </div>

          <div className="grid grid-cols-5 gap-3">
            {PIPELINE_STAGES.map((stage, stageIdx) => {
              const sc = STATUS_CONFIG[stage];
              const stageHooks = hooksByStage[stage] || [];
              return (
                <div key={stage}>
                  {/* Stage header */}
                  <div
                    className="flex items-center justify-between px-3 py-2 border rounded-none mb-2"
                    style={{ borderColor: sc.border, background: sc.bg }}
                  >
                    <span className="text-[10px] font-bold tracking-wider" style={{ color: sc.color }}>
                      {sc.label}
                    </span>
                    <span className="text-[10px] font-bold tabular-nums" style={{ color: sc.color }}>
                      {stageHooks.length}
                    </span>
                  </div>

                  {/* Arrow between stages */}
                  {stageIdx < 3 && (
                    <div className="hidden" /> // arrows handled by grid gap
                  )}

                  {/* Hook cards */}
                  <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                    <AnimatePresence mode="popLayout">
                      {stageHooks.slice(0, 10).map(hook => (
                        <PipelineHookCard key={hook.id} hook={hook} />
                      ))}
                    </AnimatePresence>
                    {stageHooks.length > 10 && (
                      <div className="text-center text-[9px] py-1" style={{ color: '#6c7680' }}>
                        +{stageHooks.length - 10} more
                      </div>
                    )}
                    {stageHooks.length === 0 && (
                      <div
                        className="text-center py-4 text-[10px] border border-dashed rounded-none"
                        style={{ borderColor: '#2d363f', color: '#6c7680' }}
                      >
                        Empty
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.section>

        {/* ── 3. Active Hooks Table ──────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="border rounded-none"
          style={{ borderColor: '#2d363f', background: '#1a1f26' }}
        >
          {/* Table header + filters */}
          <div className="px-4 py-3 border-b" style={{ borderColor: '#2d363f' }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#e6e1cf' }}>
                Active Hooks
              </h2>
              <span className="text-[9px] tabular-nums" style={{ color: '#6c7680' }}>
                {filteredHooks.length} / {hooks.length} shown
              </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="text"
                placeholder="Filter by agent, bead, skill..."
                value={agentFilter}
                onChange={e => setAgentFilter(e.target.value)}
                className="px-3 py-1.5 text-xs border rounded-none w-56 focus:outline-none"
                style={{
                  background: '#0f1419',
                  borderColor: '#2d363f',
                  color: '#e6e1cf',
                }}
              />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="px-2 py-1.5 text-xs border rounded-none focus:outline-none"
                style={{ background: '#0f1419', borderColor: '#2d363f', color: '#e6e1cf' }}
              >
                <option value="all">All Status</option>
                {PIPELINE_STAGES.map(s => (
                  <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                ))}
              </select>
              <select
                value={priorityFilter}
                onChange={e => setPriorityFilter(e.target.value)}
                className="px-2 py-1.5 text-xs border rounded-none focus:outline-none"
                style={{ background: '#0f1419', borderColor: '#2d363f', color: '#e6e1cf' }}
              >
                <option value="all">All Priority</option>
                {(['critical', 'high', 'normal', 'low'] as HookPriority[]).map(p => (
                  <option key={p} value={p}>{PRIORITY_CONFIG[p].label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Column headers */}
          <div
            className="flex items-center gap-3 px-4 py-2 text-[9px] uppercase tracking-wider border-b"
            style={{ color: '#6c7680', borderColor: '#2d363f' }}
          >
            <span className="w-[70px]">ID</span>
            <span className="w-[80px]">Bead</span>
            <span className="w-[120px]">Agent</span>
            <span className="w-[120px]">Skill</span>
            <span className="w-[60px]">Priority</span>
            <span className="w-[80px]">Status</span>
            <span className="w-[60px]">Age</span>
            <span className="flex-1 text-right">Actions</span>
          </div>

          {/* Rows */}
          <div className="max-h-[400px] overflow-y-auto">
            {filteredHooks.length === 0 ? (
              <div className="text-center py-8 text-[10px]" style={{ color: '#6c7680' }}>
                No hooks match current filters
              </div>
            ) : (
              <AnimatePresence>
                {filteredHooks.map((hook, idx) => {
                  const sc = STATUS_CONFIG[hook.status];
                  const pc = PRIORITY_CONFIG[hook.priority];
                  const isExpanded = expandedHookId === hook.id;

                  return (
                    <motion.div
                      key={hook.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: idx * 0.015 }}
                    >
                      {/* Row */}
                      <div
                        className="flex items-center gap-3 px-4 py-2.5 border-b cursor-pointer transition-colors"
                        style={{ borderColor: '#2d363f' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(230,225,207,0.02)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                        onClick={() => setExpandedHookId(isExpanded ? null : hook.id)}
                      >
                        <span className="w-[70px] text-[10px] tabular-nums" style={{ color: '#6c7680' }}>
                          {truncateId(hook.id)}
                        </span>
                        <span className="w-[80px] text-[10px] tabular-nums truncate" style={{ color: '#e6e1cf' }}>
                          {truncateId(hook.beadId)}
                        </span>
                        <span className="w-[120px] text-[10px] truncate" style={{ color: '#e6e1cf' }}>
                          {truncateId(hook.agentAddress, 16)}
                        </span>
                        <span className="w-[120px] text-[10px] truncate" style={{ color: '#95e6cb' }}>
                          {hook.skill}
                        </span>
                        <span className="w-[60px]">
                          <span
                            className="px-1.5 py-0.5 text-[8px] border rounded-none"
                            style={{ color: pc.color, borderColor: pc.border, background: pc.bg }}
                          >
                            {pc.label}
                          </span>
                        </span>
                        <span className="w-[80px]">
                          <span
                            className="px-1.5 py-0.5 text-[8px] border rounded-none"
                            style={{ color: sc.color, borderColor: sc.border, background: sc.bg }}
                          >
                            {sc.label}
                          </span>
                        </span>
                        <span className="w-[60px] text-[10px] tabular-nums" style={{ color: '#6c7680' }}>
                          {timeAgo(hook.createdAt)}
                        </span>
                        <div className="flex-1 flex items-center justify-end gap-2">
                          {hook.status === 'pending' && (
                            <button
                              onClick={e => { e.stopPropagation(); claimHook(hook.id); }}
                              className="px-2 py-1 text-[9px] uppercase tracking-wider border rounded-none"
                              style={{ color: '#95e6cb', borderColor: 'rgba(149,230,203,0.3)', background: 'rgba(149,230,203,0.08)' }}
                            >
                              Claim
                            </button>
                          )}
                          {(hook.status === 'claimed' || hook.status === 'running') && (
                            <button
                              onClick={e => { e.stopPropagation(); completeHook(hook.id); }}
                              className="px-2 py-1 text-[9px] uppercase tracking-wider border rounded-none"
                              style={{ color: '#c2d94c', borderColor: 'rgba(194,217,76,0.3)', background: 'rgba(194,217,76,0.08)' }}
                            >
                              Complete
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Expanded detail */}
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden border-b"
                            style={{ borderColor: '#2d363f', background: '#0f1419' }}
                          >
                            <div className="p-4 space-y-3">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Full ID
                                  </span>
                                  <span className="text-[10px] tabular-nums break-all" style={{ color: '#e6e1cf' }}>
                                    {hook.id}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Full Bead ID
                                  </span>
                                  <span className="text-[10px] tabular-nums break-all" style={{ color: '#e6e1cf' }}>
                                    {hook.beadId}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Full Agent
                                  </span>
                                  <span className="text-[10px] break-all" style={{ color: '#e6e1cf' }}>
                                    {hook.agentAddress}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Created
                                  </span>
                                  <span className="text-[10px] tabular-nums" style={{ color: '#e6e1cf' }}>
                                    {hook.createdAt ? new Date(hook.createdAt).toLocaleString() : '--'}
                                  </span>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Claimed At
                                  </span>
                                  <span className="text-[10px] tabular-nums" style={{ color: '#e6e1cf' }}>
                                    {hook.claimedAt ? new Date(hook.claimedAt).toLocaleString() : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Completed At
                                  </span>
                                  <span className="text-[10px] tabular-nums" style={{ color: '#e6e1cf' }}>
                                    {hook.completedAt ? new Date(hook.completedAt).toLocaleString() : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Latency
                                  </span>
                                  <span className="text-[10px] tabular-nums" style={{ color: '#95e6cb' }}>
                                    {formatMs(hook.latencyMs)}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Execution Time
                                  </span>
                                  <span className="text-[10px] tabular-nums" style={{ color: '#59c2ff' }}>
                                    {formatMs(hook.executionMs)}
                                  </span>
                                </div>
                              </div>

                              {hook.error && (
                                <div
                                  className="px-3 py-2 border rounded-none"
                                  style={{ borderColor: 'rgba(240,113,120,0.25)', background: 'rgba(240,113,120,0.05)' }}
                                >
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#f07178' }}>
                                    Error
                                  </span>
                                  <span className="text-[10px] break-all" style={{ color: '#f07178' }}>
                                    {hook.error}
                                  </span>
                                </div>
                              )}

                              {hook.result && (
                                <div>
                                  <span className="text-[9px] uppercase tracking-wider block mb-1" style={{ color: '#6c7680' }}>
                                    Result
                                  </span>
                                  <pre
                                    className="text-[10px] whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto p-2 border rounded-none"
                                    style={{ color: '#e6e1cf', borderColor: '#2d363f', background: '#0f1419' }}
                                  >
                                    {hook.result}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </motion.section>

        {/* ── Bottom Grid: Backpressure + Form + Nudges + Actions ─────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* ── 4. Backpressure Indicator ─────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <BackpressureGauge
              current={backpressurePending}
              max={backpressureMax}
              active={backpressureActive}
            />
          </motion.div>

          {/* ── 7. Action Buttons ─────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="border rounded-none p-4 space-y-3"
            style={{ borderColor: '#2d363f', background: '#1a1f26' }}
          >
            <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#e6e1cf' }}>
              GUPP Controls
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={triggerScan}
                disabled={scanning}
                className="px-4 py-3 text-xs font-bold uppercase tracking-wider border rounded-none transition-opacity disabled:opacity-40"
                style={{
                  borderColor: 'rgba(149,230,203,0.3)',
                  color: '#95e6cb',
                  background: 'rgba(149,230,203,0.06)',
                }}
              >
                {scanning ? 'Scanning...' : 'Trigger Scan'}
              </button>

              <button
                onClick={toggleLoop}
                disabled={togglingLoop}
                className="px-4 py-3 text-xs font-bold uppercase tracking-wider border rounded-none transition-opacity disabled:opacity-40"
                style={{
                  borderColor: stats?.loopRunning ? 'rgba(240,113,120,0.3)' : 'rgba(194,217,76,0.3)',
                  color: stats?.loopRunning ? '#f07178' : '#c2d94c',
                  background: stats?.loopRunning ? 'rgba(240,113,120,0.06)' : 'rgba(194,217,76,0.06)',
                }}
              >
                {togglingLoop ? '...' : stats?.loopRunning ? 'Stop GUPP Loop' : 'Start GUPP Loop'}
              </button>

              <button
                onClick={recoverNDI}
                className="px-4 py-3 text-xs font-bold uppercase tracking-wider border rounded-none"
                style={{
                  borderColor: 'rgba(255,180,84,0.3)',
                  color: '#ffb454',
                  background: 'rgba(255,180,84,0.06)',
                }}
              >
                Recover NDI
              </button>

              <button
                onClick={() => { setShowPlaceForm(p => !p); }}
                className="px-4 py-3 text-xs font-bold uppercase tracking-wider border rounded-none"
                style={{
                  borderColor: showPlaceForm ? 'rgba(240,113,120,0.3)' : 'rgba(89,194,255,0.3)',
                  color: showPlaceForm ? '#f07178' : '#59c2ff',
                  background: showPlaceForm ? 'rgba(240,113,120,0.06)' : 'rgba(89,194,255,0.06)',
                }}
              >
                {showPlaceForm ? 'Cancel' : 'Place Hook'}
              </button>
            </div>

            {stats?.lastScanAt && (
              <div className="text-[9px] pt-2" style={{ color: '#6c7680' }}>
                Last scan: {new Date(stats.lastScanAt).toLocaleString()}
              </div>
            )}
          </motion.div>
        </div>

        {/* ── 5. Place Hook Form (expandable) ────────────────────────────── */}
        <AnimatePresence>
          {showPlaceForm && (
            <motion.section
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div
                className="border rounded-none p-5 space-y-4"
                style={{ borderColor: 'rgba(89,194,255,0.25)', background: '#1a1f26' }}
              >
                <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#59c2ff' }}>
                  Place New Hook
                </h2>
                <p className="text-[10px]" style={{ color: '#6c7680' }}>
                  Sling work onto an agent&apos;s hook. Once placed, the agent MUST execute it.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Bead ID */}
                  <div>
                    <label className="text-[9px] uppercase tracking-wider block mb-1.5" style={{ color: '#6c7680' }}>
                      Bead ID
                    </label>
                    <input
                      type="text"
                      value={formBeadId}
                      onChange={e => setFormBeadId(e.target.value)}
                      placeholder="bead-xxxx-xxxx"
                      className="w-full px-3 py-2 text-xs border rounded-none focus:outline-none"
                      style={{
                        background: '#0f1419',
                        borderColor: '#2d363f',
                        color: '#e6e1cf',
                      }}
                    />
                  </div>

                  {/* Agent Address */}
                  <div>
                    <label className="text-[9px] uppercase tracking-wider block mb-1.5" style={{ color: '#6c7680' }}>
                      Agent Address
                    </label>
                    <input
                      type="text"
                      value={formAgent}
                      onChange={e => setFormAgent(e.target.value)}
                      placeholder="agent@gastown"
                      list="agent-suggestions"
                      className="w-full px-3 py-2 text-xs border rounded-none focus:outline-none"
                      style={{
                        background: '#0f1419',
                        borderColor: '#2d363f',
                        color: '#e6e1cf',
                      }}
                    />
                    <datalist id="agent-suggestions">
                      {uniqueAgents.map(a => (
                        <option key={a} value={a} />
                      ))}
                    </datalist>
                  </div>

                  {/* Skill */}
                  <div>
                    <label className="text-[9px] uppercase tracking-wider block mb-1.5" style={{ color: '#6c7680' }}>
                      Skill
                    </label>
                    <select
                      value={formSkill}
                      onChange={e => setFormSkill(e.target.value)}
                      className="w-full px-3 py-2 text-xs border rounded-none focus:outline-none"
                      style={{
                        background: '#0f1419',
                        borderColor: '#2d363f',
                        color: '#e6e1cf',
                      }}
                    >
                      {SKILLS.map(s => (
                        <option key={s} value={s} style={{ background: '#1a1f26' }}>{s}</option>
                      ))}
                    </select>
                  </div>

                  {/* Priority */}
                  <div>
                    <label className="text-[9px] uppercase tracking-wider block mb-1.5" style={{ color: '#6c7680' }}>
                      Priority
                    </label>
                    <div className="flex gap-2">
                      {(['critical', 'high', 'normal', 'low'] as HookPriority[]).map(p => {
                        const pc = PRIORITY_CONFIG[p];
                        const selected = formPriority === p;
                        return (
                          <button
                            key={p}
                            onClick={() => setFormPriority(p)}
                            className="flex-1 px-2 py-2 text-[10px] uppercase tracking-wider border rounded-none transition-all"
                            style={{
                              borderColor: selected ? pc.border : '#2d363f',
                              color: selected ? pc.color : '#6c7680',
                              background: selected ? pc.bg : 'transparent',
                            }}
                          >
                            {pc.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={placeHook}
                    disabled={placing || !formBeadId.trim() || !formAgent.trim()}
                    className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider border rounded-none transition-opacity disabled:opacity-30"
                    style={{
                      borderColor: 'rgba(89,194,255,0.4)',
                      color: '#59c2ff',
                      background: 'rgba(89,194,255,0.1)',
                    }}
                  >
                    {placing ? 'Placing...' : 'Place Hook'}
                  </button>
                  <button
                    onClick={() => setShowPlaceForm(false)}
                    className="px-4 py-2.5 text-xs uppercase tracking-wider border rounded-none"
                    style={{ borderColor: '#2d363f', color: '#6c7680' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* ── 6. GUPP Nudge System ───────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="border rounded-none"
          style={{ borderColor: '#2d363f', background: '#1a1f26' }}
        >
          <div
            className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: '#2d363f' }}
          >
            <div className="flex items-center gap-3">
              <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#ffb454' }}>
                GUPP Nudge Feed
              </h2>
              <span className="text-[9px]" style={{ color: '#6c7680' }}>
                &quot;Work slung to your hook -- YOU MUST RUN IT&quot;
              </span>
            </div>
            {nudges.length > 0 && (
              <button
                onClick={() => setNudges([])}
                className="text-[9px] uppercase tracking-wider px-2 py-1 border rounded-none"
                style={{ borderColor: '#2d363f', color: '#6c7680' }}
              >
                Clear
              </button>
            )}
          </div>

          <div className="max-h-[240px] overflow-y-auto">
            {nudges.length === 0 ? (
              <div className="py-8 text-center">
                <div className="text-2xl mb-2 opacity-20">&#x26A1;</div>
                <p className="text-[10px]" style={{ color: '#6c7680' }}>
                  No nudges yet. Place a hook to see GUPP in action.
                </p>
              </div>
            ) : (
              <AnimatePresence>
                {nudges.map((nudge, i) => (
                  <NudgeFeedItem key={nudge.id} nudge={nudge} index={i} />
                ))}
              </AnimatePresence>
            )}
          </div>
        </motion.section>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer
          className="flex items-center justify-between py-3 border-t text-[9px]"
          style={{ borderColor: '#2d363f', color: '#6c7680' }}
        >
          <span>
            GUPP Propulsion Engine &middot; Gas Town &middot; Physics over Politeness
          </span>
          <span className="tabular-nums">
            {hooks.length} hooks &middot; {uniqueAgents.length} agents &middot; Poll {POLL_INTERVAL / 1000}s
          </span>
        </footer>
      </div>
    </div>
  );
}
