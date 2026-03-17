'use client';

/**
 * DogKennelView -- GT: Dog Kennel
 *
 * Dogs are the Deacon's personal crew -- maintenance workers.
 * Inspired by Mick Herron's MI5 "Dogs".
 *
 * Sections: Kennel Status, Dog Grid, Boot the Dog Panel,
 * Dog Dispatch Console, Dog Activity Log.
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

interface Dog {
  id: string;
  name: string;
  status: 'idle' | 'working' | 'error';
  currentTask: string | null;
  rigAssignment: string | null;
  lastHeartbeat: string;
  sessionAge: string;
  tasksCompleted: number;
  description?: string;
}

interface BootStatus {
  status: 'running' | 'stopped' | 'unknown';
  lastCheck: string;
  deaconStatus: 'alive' | 'patrol' | 'stuck' | 'unknown';
  actionTaken: string;
  nextCheckIn: number; // seconds
  restartCount: number;
  uptime?: string;
}

interface DogActivity {
  id: string;
  timestamp: string;
  dogName: string;
  action: string;
  detail: string;
  result: 'success' | 'error' | 'info';
}

interface KennelStats {
  totalDogs: number;
  active: number;
  idle: number;
  error: number;
  deaconStatus: string;
  bootRunning: boolean;
}

type TabKey = 'kennel' | 'boot' | 'dispatch' | 'log';

// ── Constants ───────────────────────────────────────────────────────────────

const POLL = 8000;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'kennel', label: 'Kennel' },
  { key: 'boot', label: 'Boot the Dog' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'log', label: 'Activity Log' },
];

const DOG_STATUS: Record<string, { dot: string; text: string; bg: string; border: string }> = {
  idle:    { dot: 'bg-[#6c7680]', text: 'text-[#6c7680]', bg: 'bg-[#6c7680]/10', border: 'border-[#6c7680]/20' },
  working: { dot: 'bg-[#c2d94c]', text: 'text-[#c2d94c]', bg: 'bg-[#c2d94c]/10', border: 'border-[#c2d94c]/20' },
  error:   { dot: 'bg-[#f07178]', text: 'text-[#f07178]', bg: 'bg-[#f07178]/10', border: 'border-[#f07178]/20' },
};

const DEACON_STATUS: Record<string, { text: string; color: string }> = {
  alive:   { text: 'ALIVE', color: C.green },
  patrol:  { text: 'ON PATROL', color: C.yellow },
  stuck:   { text: 'STUCK', color: C.red },
  unknown: { text: 'UNKNOWN', color: C.muted },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function ds(s: string) { return DOG_STATUS[s] || DOG_STATUS.idle; }

function timeAgo(ts: string | undefined): string {
  if (!ts) return '--';
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

function fmtCountdown(secs: number): string {
  if (secs <= 0) return 'now';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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

function DogCard({ dog, onDispatch, onHealthCheck }: {
  dog: Dog; onDispatch: () => void; onHealthCheck: () => void;
}) {
  const st = ds(dog.status);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="bg-[#1a1f26] border border-[#2d363f] rounded-none"
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-none ${st.dot}`} />
            <h3 className="text-sm font-mono font-semibold text-[#e6e1cf]">{dog.name}</h3>
          </div>
          <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase ${st.bg} ${st.text} border ${st.border} rounded-none`}>
            {dog.status}
          </span>
        </div>

        {/* Current task */}
        {dog.currentTask && (
          <div className="mb-2">
            <span className="text-[9px] text-[#4a5159] uppercase">Task: </span>
            <span className="text-xs text-[#d2a6ff]/80 font-mono">{dog.currentTask}</span>
          </div>
        )}

        {/* Description */}
        {dog.description && (
          <p className="text-[10px] text-[#4a5159] mb-2">{dog.description}</p>
        )}

        {/* Rig + stats */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <span className="text-[9px] text-[#4a5159] uppercase block">Rig</span>
            <span className="text-xs text-[#95e6cb] font-mono">{dog.rigAssignment || '--'}</span>
          </div>
          <div>
            <span className="text-[9px] text-[#4a5159] uppercase block">Tasks Done</span>
            <span className="text-xs text-[#e6e1cf] font-mono">{dog.tasksCompleted}</span>
          </div>
        </div>

        {/* Heartbeat + session */}
        <div className="flex items-center gap-3 text-[10px] text-[#4a5159] mb-3">
          <span>Heartbeat: {timeAgo(dog.lastHeartbeat)}</span>
          <span>Session: {dog.sessionAge || '--'}</span>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onDispatch}
            className="px-2.5 py-1 text-[10px] font-mono uppercase border border-[#d2a6ff]/20 text-[#d2a6ff] rounded-none hover:bg-[#d2a6ff]/10 transition-colors"
          >
            Dispatch
          </button>
          <button
            onClick={onHealthCheck}
            className="px-2.5 py-1 text-[10px] font-mono uppercase border border-[#95e6cb]/20 text-[#95e6cb] rounded-none hover:bg-[#95e6cb]/10 transition-colors"
          >
            Health Check
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function DogKennelView() {
  const [tab, setTab] = useState<TabKey>('kennel');
  const [dogs, setDogs] = useState<Dog[]>([]);
  const [bootStatus, setBootStatus] = useState<BootStatus | null>(null);
  const [activities, setActivities] = useState<DogActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dispatch form
  const [dispatchDog, setDispatchDog] = useState('');
  const [dispatchTask, setDispatchTask] = useState('');
  const [dispatchPriority, setDispatchPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<string | null>(null);

  // Boot countdown
  const [bootCountdown, setBootCountdown] = useState(0);

  const mountedRef = useRef(true);

  // ── Fetch data ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [healthRes, reportRes, pulseRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/deacon/health`, { signal }),
        fetch(`${API}/api/meow/deacon/report`, { signal }),
        fetch(`${API}/api/meow/town/pulse`, { signal }),
      ]);
      if (!mountedRef.current) return;

      // Parse deacon health -> dogs + boot
      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const d = await healthRes.value.json();
        // Extract dogs
        const rawDogs = d.dogs || d.workers || [];
        setDogs(rawDogs.map((dog: Record<string, unknown>, i: number) => ({
          id: String(dog.id || dog.name || `dog-${i}`),
          name: String(dog.name || dog.id || `Dog-${i}`),
          status: (['idle', 'working', 'error'].includes(String(dog.status || ''))
            ? String(dog.status) : 'idle') as 'idle' | 'working' | 'error',
          currentTask: dog.currentTask ? String(dog.currentTask) : null,
          rigAssignment: dog.rigAssignment || dog.rig ? String(dog.rigAssignment || dog.rig) : null,
          lastHeartbeat: String(dog.lastHeartbeat || dog.lastRun || new Date().toISOString()),
          sessionAge: String(dog.sessionAge || dog.uptime || '--'),
          tasksCompleted: Number(dog.tasksCompleted || dog.itemsProcessed || 0),
          description: dog.description ? String(dog.description) : undefined,
        })));

        // Extract boot status
        if (d.boot || d.bootTheDog) {
          const boot = d.boot || d.bootTheDog || {};
          setBootStatus({
            status: String(boot.status || 'unknown') as 'running' | 'stopped' | 'unknown',
            lastCheck: String(boot.lastCheck || boot.lastChecked || new Date().toISOString()),
            deaconStatus: (['alive', 'patrol', 'stuck'].includes(String(boot.deaconStatus || ''))
              ? String(boot.deaconStatus) : 'unknown') as 'alive' | 'patrol' | 'stuck' | 'unknown',
            actionTaken: String(boot.actionTaken || boot.action || 'none'),
            nextCheckIn: Number(boot.nextCheckIn || 300),
            restartCount: Number(boot.restartCount || 0),
            uptime: boot.uptime ? String(boot.uptime) : undefined,
          });
          setBootCountdown(Number(boot.nextCheckIn || 300));
        }
      }

      // Parse report -> activities
      if (reportRes.status === 'fulfilled' && reportRes.value.ok) {
        const d = await reportRes.value.json();
        const entries = d.entries || d.report || d.activities || [];
        setActivities(entries.map((e: Record<string, unknown>, i: number) => ({
          id: String(e.id || `act-${i}`),
          timestamp: String(e.timestamp || e.ts || new Date().toISOString()),
          dogName: String(e.dogName || e.process || e.dog || 'unknown'),
          action: String(e.action || e.event || e.type || 'task'),
          detail: String(e.detail || e.message || e.description || ''),
          result: (['success', 'error', 'info'].includes(String(e.result || e.status || ''))
            ? String(e.result || e.status) : 'info') as 'success' | 'error' | 'info',
        })).slice(0, 100));
      }

      // Pulse for additional context
      if (pulseRes.status === 'fulfilled' && pulseRes.value.ok) {
        const d = await pulseRes.value.json();
        // Enrich boot status with pulse data if available
        if (d.deacon && !bootStatus) {
          setBootStatus(prev => prev || {
            status: 'unknown' as const,
            lastCheck: String(d.deacon.lastPatrol || new Date().toISOString()),
            deaconStatus: String(d.deacon.overall || 'unknown') as 'alive' | 'patrol' | 'stuck' | 'unknown',
            actionTaken: 'none',
            nextCheckIn: 300,
            restartCount: 0,
          });
        }
      }

      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach Deacon endpoints');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [bootStatus]);

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

  // Boot countdown timer
  useEffect(() => {
    if (bootCountdown <= 0) return;
    const iv = setInterval(() => {
      setBootCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(iv);
  }, [bootCountdown]);

  // ── Actions ───────────────────────────────────────────────────────────

  const handleDispatch = useCallback(async () => {
    if (!dispatchDog || !dispatchTask.trim()) return;
    setDispatching(true);
    setDispatchResult(null);
    try {
      const res = await fetch(`${API}/api/meow/deacon/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dogId: dispatchDog,
          task: dispatchTask.trim(),
          priority: dispatchPriority,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        setDispatchResult(d.message || `Dispatched to ${dispatchDog}`);
        setDispatchTask('');
        fetchData();
      } else {
        const d = await res.json().catch(() => ({}));
        setDispatchResult(`ERROR: ${d.error || res.statusText}`);
      }
    } catch {
      setDispatchResult('ERROR: Network failure');
    } finally {
      setDispatching(false);
    }
  }, [dispatchDog, dispatchTask, dispatchPriority, fetchData]);

  const healthCheckDog = useCallback(async (dogId: string) => {
    try {
      await fetch(`${API}/api/meow/deacon/dogs/${dogId}/health`, { method: 'POST' });
      fetchData();
    } catch { /* silent */ }
  }, [fetchData]);

  const dispatchDogById = useCallback((dogId: string) => {
    setDispatchDog(dogId);
    setTab('dispatch');
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────

  const kennelStats = useMemo<KennelStats>(() => ({
    totalDogs: dogs.length,
    active: dogs.filter(d => d.status === 'working').length,
    idle: dogs.filter(d => d.status === 'idle').length,
    error: dogs.filter(d => d.status === 'error').length,
    deaconStatus: bootStatus?.deaconStatus || 'unknown',
    bootRunning: bootStatus?.status === 'running',
  }), [dogs, bootStatus]);

  const deaconInfo = DEACON_STATUS[kennelStats.deaconStatus] || DEACON_STATUS.unknown;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-4 space-y-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">DOG KENNEL</h1>
            <p className="text-xs text-[#4a5159] mt-0.5">
              The Deacon&apos;s personal crew &mdash; maintenance workers
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1 border rounded-none" style={{ borderColor: deaconInfo.color + '30', background: deaconInfo.color + '10' }}>
              <div className="w-2 h-2 rounded-none" style={{ background: deaconInfo.color }} />
              <span className="text-[11px] font-mono uppercase" style={{ color: deaconInfo.color }}>Deacon: {deaconInfo.text}</span>
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 py-1 border rounded-none ${
              kennelStats.bootRunning ? 'border-[#c2d94c]/20 bg-[#c2d94c]/10' : 'border-[#f07178]/20 bg-[#f07178]/10'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-none ${kennelStats.bootRunning ? 'bg-[#c2d94c]' : 'bg-[#f07178]'}`} />
              <span className={`text-[11px] font-mono ${kennelStats.bootRunning ? 'text-[#c2d94c]' : 'text-[#f07178]'}`}>
                Boot: {kennelStats.bootRunning ? 'RUNNING' : 'STOPPED'}
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Kennel Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Dogs" value={kennelStats.totalDogs} />
        <StatCard label="Working" value={kennelStats.active} color={C.green} />
        <StatCard label="Idle" value={kennelStats.idle} color={C.muted} />
        <StatCard label="Error" value={kennelStats.error} color={C.red} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2d363f]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
              tab === t.key
                ? 'text-[#e6e1cf] border-b-2 border-[#ffb454]/60'
                : 'text-[#4a5159] hover:text-[#6c7680]'
            }`}
          >
            {t.label}
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
      {loading && dogs.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
              className="h-36 bg-[#2d363f]/15 border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* ── Kennel Tab ───────────────────────────────────────────────── */}
        {tab === 'kennel' && (
          <motion.div key="kennel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {dogs.length > 0 ? (
              <motion.div layout className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <AnimatePresence mode="popLayout">
                  {dogs.map(dog => (
                    <DogCard
                      key={dog.id}
                      dog={dog}
                      onDispatch={() => dispatchDogById(dog.id)}
                      onHealthCheck={() => healthCheckDog(dog.id)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            ) : !loading ? (
              <div className="flex flex-col items-center justify-center py-20 text-[#4a5159]">
                <span className="text-3xl mb-3">K</span>
                <span className="text-sm font-mono">No dogs in the kennel</span>
              </div>
            ) : null}
          </motion.div>
        )}

        {/* ── Boot the Dog Tab ─────────────────────────────────────────── */}
        {tab === 'boot' && (
          <motion.div key="boot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5">
              <h2 className="text-sm font-semibold text-[#e6e1cf] mb-4 uppercase tracking-wider">Boot the Dog</h2>
              <p className="text-[10px] text-[#4a5159] mb-4">
                Special dog that checks on the Deacon every 5 minutes. If the Deacon is stuck, Boot takes action.
              </p>

              {bootStatus ? (
                <div className="space-y-4">
                  {/* Boot stats grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3">
                      <span className="text-[9px] text-[#4a5159] uppercase block mb-1">Boot Status</span>
                      <span className={`text-sm font-mono uppercase ${
                        bootStatus.status === 'running' ? 'text-[#c2d94c]' : 'text-[#f07178]'
                      }`}>
                        {bootStatus.status}
                      </span>
                    </div>
                    <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3">
                      <span className="text-[9px] text-[#4a5159] uppercase block mb-1">Deacon Status</span>
                      <span className="text-sm font-mono" style={{ color: deaconInfo.color }}>{deaconInfo.text}</span>
                    </div>
                    <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3">
                      <span className="text-[9px] text-[#4a5159] uppercase block mb-1">Last Check</span>
                      <span className="text-xs font-mono text-[#e6e1cf]">{timeAgo(bootStatus.lastCheck)}</span>
                    </div>
                    <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3">
                      <span className="text-[9px] text-[#4a5159] uppercase block mb-1">Next Check</span>
                      <span className="text-xs font-mono text-[#ffb454]">{fmtCountdown(bootCountdown)}</span>
                    </div>
                  </div>

                  {/* Action taken */}
                  <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3">
                    <span className="text-[9px] text-[#4a5159] uppercase block mb-1">Last Action Taken</span>
                    <span className="text-xs font-mono text-[#d2a6ff]">{bootStatus.actionTaken}</span>
                  </div>

                  {/* Boot meta */}
                  <div className="flex items-center gap-4 text-[10px] text-[#4a5159]">
                    <span>Restart Count: {bootStatus.restartCount}</span>
                    {bootStatus.uptime && <span>Uptime: {bootStatus.uptime}</span>}
                  </div>

                  {/* Progress bar for countdown */}
                  <div className="h-1 bg-[#2d363f] rounded-none overflow-hidden">
                    <motion.div
                      className="h-full bg-[#ffb454]/40"
                      animate={{ width: `${Math.max(0, (bootCountdown / 300) * 100)}%` }}
                      transition={{ duration: 1 }}
                    />
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-[#4a5159]">
                  <span className="text-sm font-mono">Boot status unavailable</span>
                </div>
              )}
            </div>

            {/* Deacon report summary */}
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
              <h3 className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold mb-3">Deacon Status Report</h3>
              <div className="flex items-center gap-4">
                <div className="w-3 h-3 rounded-none" style={{ background: deaconInfo.color }} />
                <div>
                  <span className="text-sm font-mono" style={{ color: deaconInfo.color }}>{deaconInfo.text}</span>
                  <p className="text-[10px] text-[#4a5159] mt-0.5">
                    {kennelStats.deaconStatus === 'alive' && 'All systems nominal. Deacon is patrolling Gas Town.'}
                    {kennelStats.deaconStatus === 'patrol' && 'Deacon is currently running patrol checks.'}
                    {kennelStats.deaconStatus === 'stuck' && 'Deacon appears stuck. Boot should intervene.'}
                    {kennelStats.deaconStatus === 'unknown' && 'Unable to determine Deacon status.'}
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Dispatch Tab ─────────────────────────────────────────────── */}
        {tab === 'dispatch' && (
          <motion.div key="dispatch" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5 space-y-4">
              <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold">Dog Dispatch Console</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Dog selector */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Select Dog</label>
                  <select
                    value={dispatchDog}
                    onChange={e => setDispatchDog(e.target.value)}
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 focus:outline-none appearance-none cursor-pointer"
                  >
                    <option value="" className="bg-[#1a1f26]">-- select dog --</option>
                    {dogs.map(d => (
                      <option key={d.id} value={d.id} className="bg-[#1a1f26]">
                        {d.name} ({d.status})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Priority</label>
                  <div className="flex gap-2">
                    {(['low', 'normal', 'high'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => setDispatchPriority(p)}
                        className={`px-3 py-2 text-[10px] font-mono uppercase border rounded-none transition-colors ${
                          dispatchPriority === p
                            ? p === 'high'
                              ? 'border-[#f07178]/40 bg-[#f07178]/10 text-[#f07178]'
                              : p === 'normal'
                              ? 'border-[#ffb454]/40 bg-[#ffb454]/10 text-[#ffb454]'
                              : 'border-[#6c7680]/40 bg-[#6c7680]/10 text-[#6c7680]'
                            : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Task description */}
              <div>
                <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Task Description</label>
                <textarea
                  value={dispatchTask}
                  onChange={e => setDispatchTask(e.target.value)}
                  placeholder="Describe the maintenance task..."
                  rows={3}
                  className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f] resize-y"
                />
              </div>

              {/* Dispatch button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleDispatch}
                  disabled={dispatching || !dispatchDog || !dispatchTask.trim()}
                  className="px-5 py-2 text-xs font-mono font-bold uppercase tracking-widest bg-[#ffb454]/15 border-2 border-[#ffb454]/40 text-[#ffb454] rounded-none hover:bg-[#ffb454]/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {dispatching ? 'DISPATCHING...' : 'DISPATCH'}
                </button>
                <AnimatePresence>
                  {dispatchResult && (
                    <motion.span
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className={`text-xs font-mono ${
                        dispatchResult.startsWith('ERROR') ? 'text-[#f07178]' : 'text-[#c2d94c]'
                      }`}
                    >
                      {dispatchResult}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Activity Log Tab ─────────────────────────────────────────── */}
        {tab === 'log' && (
          <motion.div key="log" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {activities.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">No dog activity recorded</p>
              </div>
            ) : (
              <div className="space-y-0">
                {/* Table header */}
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-28">Timestamp</span>
                  <span className="w-24">Dog</span>
                  <span className="w-24">Action</span>
                  <span className="flex-1">Detail</span>
                  <span className="w-16 text-right">Result</span>
                </div>

                {activities.map((act, i) => (
                  <motion.div
                    key={act.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.015 }}
                    className="flex items-center gap-3 px-3 py-2 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-none flex-shrink-0 ${
                      act.result === 'success' ? 'bg-[#c2d94c]' : act.result === 'error' ? 'bg-[#f07178]' : 'bg-[#95e6cb]'
                    }`} />
                    <span className="w-28 text-[10px] text-[#4a5159]">{fmtDate(act.timestamp)}</span>
                    <span className="w-24 text-xs text-[#e6e1cf]/60 truncate">{act.dogName}</span>
                    <span className="w-24 text-[10px] text-[#d2a6ff] font-mono">{act.action}</span>
                    <span className="flex-1 text-[10px] text-[#4a5159] truncate">{act.detail}</span>
                    <span className={`w-16 text-[10px] text-right font-mono uppercase ${
                      act.result === 'success' ? 'text-[#c2d94c]' : act.result === 'error' ? 'text-[#f07178]' : 'text-[#95e6cb]'
                    }`}>
                      {act.result}
                    </span>
                  </motion.div>
                ))}
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
          className="w-1.5 h-1.5 bg-[#ffb454]/60 rounded-none"
        />
        <span className="text-[10px] font-mono text-[#4a5159]">Auto-refresh {POLL / 1000}s</span>
      </div>
    </div>
  );
}
