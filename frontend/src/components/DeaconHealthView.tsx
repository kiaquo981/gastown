'use client';

/**
 * DeaconHealthView — GT-010: Deacon Health Dashboard (26 Patrol Checks)
 *
 * The Deacon runs 26 health checks across Gas Town.
 * Ayu Dark aesthetic: bg-[#0f1419], borders [#2d363f], text [#e6e1cf], font-mono.
 * Auto-refresh every 10s with AbortController cleanup.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ───────────────────────────────────────────────────────────────

interface HealthCheck {
  name: string;
  status: 'pass' | 'warning' | 'fail';
  lastChecked: string;
  details?: string;
  latencyMs?: number;
}

interface DogWorker {
  name: string;
  status: 'running' | 'stopped' | 'error';
  lastRun: string;
  itemsProcessed: number;
  description?: string;
}

interface DeaconHealth {
  overall: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  checks: HealthCheck[];
  dogs: DogWorker[];
  lastPatrol: string;
  patrolDuration?: string;
}

interface BootStatus {
  status: 'running' | 'stopped' | 'unknown';
  restartCount: number;
  monitoredProcesses: string[];
  uptime?: string;
  lastCheck?: string;
}

interface BootReport {
  entries: BootEntry[];
  summary?: string;
}

interface BootEntry {
  ts: string;
  event: string;
  process: string;
  detail?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const POLL = 10000;

const CHECK_STYLES: Record<string, { dot: string; bg: string; text: string; border: string; glow: string }> = {
  pass:    { dot: 'bg-emerald-400', bg: 'bg-emerald-500/8', text: 'text-emerald-400', border: 'border-emerald-500/15', glow: 'shadow-[0_0_8px_rgba(34,197,94,0.1)]' },
  warning: { dot: 'bg-amber-400',   bg: 'bg-amber-500/8',   text: 'text-amber-400',   border: 'border-amber-500/15',  glow: 'shadow-[0_0_8px_rgba(234,179,8,0.1)]' },
  fail:    { dot: 'bg-red-400',     bg: 'bg-red-500/8',     text: 'text-red-400',     border: 'border-red-500/15',    glow: 'shadow-[0_0_8px_rgba(239,68,68,0.1)]' },
};

const OVERALL_STYLES: Record<string, { bg: string; text: string; border: string; glow: string }> = {
  HEALTHY:  { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', glow: 'shadow-[0_0_20px_rgba(34,197,94,0.12)]' },
  DEGRADED: { bg: 'bg-amber-500/10',   text: 'text-amber-400',   border: 'border-amber-500/20',  glow: 'shadow-[0_0_20px_rgba(234,179,8,0.12)]' },
  DOWN:     { bg: 'bg-red-500/10',     text: 'text-red-400',     border: 'border-red-500/20',    glow: 'shadow-[0_0_20px_rgba(239,68,68,0.12)]' },
};

const DOG_ICONS: Record<string, string> = {
  compactor: '\u{1F5DC}',
  doctor: '\u{1FA7A}',
  janitor: '\u{1F9F9}',
  wisp_reaper: '\u{1F480}',
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function csStyle(s: string) { return CHECK_STYLES[s] || CHECK_STYLES.fail; }
function osStyle(s: string) { return OVERALL_STYLES[s] || OVERALL_STYLES.DOWN; }

function fmtShort(ts: string | null | undefined): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '--'; }
}

function fmtFull(ts: string | null | undefined): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '--'; }
}

// ─── HealthCheckCard ─────────────────────────────────────────────────────

function CheckCard({ check, index, expandedCheck, onToggle }: {
  check: HealthCheck; index: number; expandedCheck: string | null; onToggle: (name: string) => void;
}) {
  const st = csStyle(check.status);
  const isExpanded = expandedCheck === check.name;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, delay: index * 0.03 }}
      className={`bg-[#1a1f26] border ${st.border} rounded-none ${st.glow} cursor-pointer transition-all hover:border-[#2d363f]`}
      onClick={() => onToggle(check.name)}
    >
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <motion.div
              animate={
                check.status === 'pass' ? { scale: [1, 1.2, 1] }
                : check.status === 'fail' ? { opacity: [1, 0.4, 1] }
                : {}
              }
              transition={{ duration: 2, repeat: Infinity }}
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.dot}`}
            />
            <span className="text-xs font-mono text-[#e6e1cf] truncate">{check.name}</span>
          </div>
          <span className={`text-[10px] font-mono uppercase ${st.text}`}>{check.status}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-white/25">{fmtShort(check.lastChecked)}</span>
          {check.latencyMs !== undefined && (
            <span className="text-[10px] font-mono text-white/20">{check.latencyMs}ms</span>
          )}
        </div>
      </div>

      {/* Expandable details on click */}
      <AnimatePresence>
        {isExpanded && check.details && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[#2d363f] px-3 py-2">
              <p className="text-[11px] font-mono text-[#4a5159] leading-relaxed">{check.details}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── DogCard ─────────────────────────────────────────────────────────────

function DogCard({ dog }: { dog: DogWorker }) {
  const dotCls = dog.status === 'running' ? 'bg-emerald-400' : dog.status === 'error' ? 'bg-red-400' : 'bg-zinc-400';
  const txtCls = dog.status === 'running' ? 'text-emerald-400' : dog.status === 'error' ? 'text-red-400' : 'text-zinc-400';
  const icon = DOG_ICONS[dog.name] || '\u{1F415}';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4"
    >
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-mono text-[#e6e1cf] capitalize">{dog.name.replace('_', ' ')}</h4>
            <div className={`w-1.5 h-1.5 rounded-none ${dotCls}`} />
            <span className={`text-[10px] font-mono uppercase ${txtCls}`}>{dog.status}</span>
          </div>
          {dog.description && (
            <p className="text-[10px] font-mono text-white/25 mt-0.5 truncate">{dog.description}</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-white/25 block">Last Run</span>
          <span className="text-xs font-mono text-white/50">{fmtShort(dog.lastRun)}</span>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-white/25 block">Processed</span>
          <span className="text-xs font-mono text-[#e6e1cf]">{(dog.itemsProcessed ?? 0).toLocaleString()}</span>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

export default function DeaconHealthView() {
  const [health, setHealth] = useState<DeaconHealth | null>(null);
  const [bootStatus, setBootStatus] = useState<BootStatus | null>(null);
  const [bootReport, setBootReport] = useState<BootReport | null>(null);
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  const [showBootReport, setShowBootReport] = useState(false);
  const [patrolRunning, setPatrolRunning] = useState(false);
  const [forceCheckRunning, setForceCheckRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // ── Fetch data ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [hR, bR, brR] = await Promise.allSettled([
        fetch(`${API}/api/meow/deacon/health`, { signal }),
        fetch(`${API}/api/meow/boot/status`, { signal }),
        fetch(`${API}/api/meow/boot/report`, { signal }),
      ]);
      if (!mountedRef.current) return;

      if (hR.status === 'fulfilled' && hR.value.ok) {
        setHealth(await hR.value.json());
      }
      if (bR.status === 'fulfilled' && bR.value.ok) {
        setBootStatus(await bR.value.json());
      }
      if (brR.status === 'fulfilled' && brR.value.ok) {
        setBootReport(await brR.value.json());
      }
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach Deacon health endpoint');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────

  const forcePatrol = useCallback(async () => {
    setPatrolRunning(true);
    try {
      await fetch(`${API}/api/meow/deacon/patrol`, { method: 'POST' });
      const ctrl = new AbortController();
      await fetchData(ctrl.signal);
    } catch {
      // silent
    } finally {
      if (mountedRef.current) setPatrolRunning(false);
    }
  }, [fetchData]);

  const forceBootCheck = useCallback(async () => {
    setForceCheckRunning(true);
    try {
      await fetch(`${API}/api/meow/boot/check`, { method: 'POST' });
      const ctrl = new AbortController();
      await fetchData(ctrl.signal);
    } catch {
      // silent
    } finally {
      if (mountedRef.current) setForceCheckRunning(false);
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

  // ── Derived state ──────────────────────────────────────────────────────

  const checks = health?.checks || [];
  const dogs = health?.dogs || [];
  const overall = health?.overall || 'DOWN';
  const ost = osStyle(overall);

  const summary = useMemo(() => {
    const passed = checks.filter((c) => c.status === 'pass').length;
    const warned = checks.filter((c) => c.status === 'warning').length;
    const total = checks.length;
    const uptimePct = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
    return { passed, warned, failed: total - passed - warned, total, uptimePct };
  }, [checks]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">Deacon Health Center</h1>
            <p className="text-xs text-[#4a5159] mt-1">26 patrol checks &mdash; Gas Town infrastructure</p>
          </div>

          {/* Overall health badge */}
          <motion.div
            animate={overall === 'DOWN' ? { opacity: [1, 0.5, 1] } : {}}
            transition={{ duration: 1.5, repeat: Infinity }}
            className={`px-3 py-1.5 border rounded-none ${ost.bg} ${ost.border} ${ost.glow}`}
          >
            <span className={`text-sm font-mono font-bold tracking-wider ${ost.text}`}>{overall}</span>
          </motion.div>
        </div>

        {/* Force patrol button */}
        <button
          onClick={forcePatrol}
          disabled={patrolRunning}
          className="px-4 py-2 bg-white/[0.03] border border-[#2d363f] rounded-none text-xs font-mono uppercase tracking-wider text-[#6c7680] hover:bg-white/[0.06] hover:border-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {patrolRunning ? 'Patrolling...' : 'Force Patrol'}
        </button>
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
      {loading && !health && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.2, 0.5, 0.2] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.05 }}
              className="h-20 bg-white/[0.02] border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      {/* Health Check Grid — 26 checks in 4 columns */}
      {checks.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-wider text-[#4a5159]">PATROL CHECKS</span>
            <span className="text-[10px] font-mono text-white/15">{summary.passed}/{summary.total} passing</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {checks.map((check, i) => (
              <CheckCard
                key={check.name}
                check={check}
                index={i}
                expandedCheck={expandedCheck}
                onToggle={(name) => setExpandedCheck(expandedCheck === name ? null : name)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Dogs Section — 4 special workers */}
      {dogs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-wider text-[#4a5159]">DEACON DOGS</span>
            <span className="text-[10px] font-mono text-white/15">Special workers</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {dogs.map((dog) => (
              <DogCard key={dog.name} dog={dog} />
            ))}
          </div>
        </div>
      )}

      {/* Boot Watchdog Panel */}
      <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none">
        <div className="flex items-center justify-between p-4 border-b border-[#2d363f]">
          <div className="flex items-center gap-3">
            <span className="text-[10px] uppercase tracking-wider text-[#4a5159]">BOOT WATCHDOG</span>
            {bootStatus && (
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-none ${
                  bootStatus.status === 'running' ? 'bg-emerald-400'
                  : bootStatus.status === 'stopped' ? 'bg-zinc-400' : 'bg-amber-400'
                }`} />
                <span className={`text-[10px] font-mono uppercase ${
                  bootStatus.status === 'running' ? 'text-emerald-400'
                  : bootStatus.status === 'stopped' ? 'text-zinc-400' : 'text-amber-400'
                }`}>
                  {bootStatus.status}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowBootReport(!showBootReport)}
              className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-[#4a5159] border border-[#2d363f] rounded-none hover:bg-white/[0.03] transition-colors"
            >
              {showBootReport ? 'Hide Report' : 'Show Report'}
            </button>
            <button
              onClick={forceBootCheck}
              disabled={forceCheckRunning}
              className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-[#6c7680] border border-[#2d363f] rounded-none hover:bg-white/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {forceCheckRunning ? 'Checking...' : 'Force Check'}
            </button>
          </div>
        </div>

        {/* Boot status metrics */}
        {bootStatus && (
          <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">STATUS</span>
              <span className={`text-sm font-mono capitalize ${
                bootStatus.status === 'running' ? 'text-emerald-400' : 'text-zinc-400'
              }`}>
                {bootStatus.status}
              </span>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">RESTART COUNT</span>
              <span className="text-sm font-mono text-[#e6e1cf]">{bootStatus.restartCount}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">UPTIME</span>
              <span className="text-sm font-mono text-[#e6e1cf]">{bootStatus.uptime || '--'}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">LAST CHECK</span>
              <span className="text-sm font-mono text-white/50">{fmtShort(bootStatus.lastCheck)}</span>
            </div>
          </div>
        )}

        {/* Monitored processes */}
        {bootStatus && (bootStatus.monitoredProcesses || []).length > 0 && (
          <div className="px-4 pb-4">
            <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-2">MONITORED PROCESSES</span>
            <div className="flex flex-wrap gap-2">
              {(bootStatus.monitoredProcesses || []).map((proc) => (
                <span
                  key={proc}
                  className="px-2 py-0.5 text-[10px] font-mono text-violet-400/70 bg-violet-500/8 border border-violet-500/15 rounded-none"
                >
                  {proc}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Boot report expandable */}
        <AnimatePresence>
          {showBootReport && bootReport && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="border-t border-[#2d363f] p-4">
                {bootReport.summary && (
                  <p className="text-xs font-mono text-[#4a5159] mb-3">{bootReport.summary}</p>
                )}
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {(bootReport.entries || []).map((entry, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] font-mono">
                      <span className="text-white/20 shrink-0 w-16">{fmtShort(entry.ts)}</span>
                      <span className={`shrink-0 ${
                        entry.event.includes('error') || entry.event.includes('fail')
                          ? 'text-red-400/70'
                          : entry.event.includes('restart')
                          ? 'text-amber-400/70'
                          : 'text-[#4a5159]'
                      }`}>
                        [{entry.event}]
                      </span>
                      <span className="text-[#4a5159]">{entry.process}</span>
                      {entry.detail && (
                        <span className="text-white/20 truncate">{entry.detail}</span>
                      )}
                    </div>
                  ))}
                  {(bootReport.entries || []).length === 0 && (
                    <span className="text-[11px] font-mono text-white/20">No boot events recorded</span>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Summary — 4 KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">CHECKS PASSED</span>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-mono text-emerald-400">{summary.passed}</span>
            <span className="text-sm font-mono text-white/20">/ {summary.total}</span>
          </div>
        </div>
        <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">WARNINGS</span>
          <span className={`text-2xl font-mono ${summary.warned > 0 ? 'text-amber-400' : 'text-white/20'}`}>
            {summary.warned}
          </span>
        </div>
        <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">LAST PATROL</span>
          <span className="text-sm font-mono text-white/50">{fmtFull(health?.lastPatrol)}</span>
          {health?.patrolDuration && (
            <span className="text-[10px] font-mono text-white/20 block mt-0.5">{health.patrolDuration}</span>
          )}
        </div>
        <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
          <span className="text-[10px] uppercase tracking-wider text-white/25 block mb-1">UPTIME SCORE</span>
          <span className={`text-2xl font-mono ${
            Number(summary.uptimePct) >= 90 ? 'text-emerald-400'
            : Number(summary.uptimePct) >= 70 ? 'text-amber-400'
            : 'text-red-400'
          }`}>
            {summary.uptimePct}%
          </span>
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
