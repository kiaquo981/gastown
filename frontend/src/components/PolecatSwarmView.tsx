'use client';

/**
 * PolecatSwarmView — GT-008 Polecat Swarm Monitor
 *
 * Monitors ephemeral polecat workers that handle isolated tasks in worktrees.
 * Swim-lane cards, lifecycle indicators, witness panel, zombie detection.
 *
 * API: GET /api/meow/polecats, GET /api/meow/polecats/stats,
 *      GET /api/meow/polecats/health, GET /api/meow/witness/report
 * Ayu Dark aesthetic: bg-[#0f1419], border-[#2d363f], text-[#e6e1cf], font-mono, rounded-none
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type PolecatLifecycle = 'SPAWNED' | 'WORKING' | 'PR_CREATED' | 'CLEANUP' | 'DONE' | 'ZOMBIE';

interface Polecat {
  id: string;
  name: string;
  beadId: string;
  beadName?: string;
  worktreeBranch: string;
  spawnTime: string;
  status: PolecatLifecycle;
  lastHeartbeat?: string;
  isZombie: boolean;
  progress: number; // 0-100
  prUrl?: string;
  exitCode?: number;
}

interface PolecatStats {
  totalSpawned: number;
  active: number;
  completed: number;
  failed: number;
  zombieCount: number;
  avgLifespan: number; // ms
  costPerPolecat: number; // USD
  spawnRate: number; // per minute
}

interface WitnessCheck {
  id: string;
  name: string;
  passed: boolean;
  details?: string;
  timestamp: string;
}

interface WitnessReport {
  id: string;
  timestamp: string;
  summary: string;
  checks: WitnessCheck[];
  anomalies: WitnessAnomaly[];
  overallHealth: number;
}

interface WitnessAnomaly {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  polecatId?: string;
  detectedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 3000;

const LIFECYCLE_ORDER: PolecatLifecycle[] = ['SPAWNED', 'WORKING', 'PR_CREATED', 'CLEANUP', 'DONE'];

const LIFECYCLE_STYLES: Record<PolecatLifecycle, { bg: string; text: string; border: string; label: string }> = {
  SPAWNED:    { bg: 'bg-blue-500/10',    text: 'text-blue-400',    border: 'border-blue-500/20',    label: 'SPAWNED' },
  WORKING:    { bg: 'bg-cyan-500/10',    text: 'text-cyan-400',    border: 'border-cyan-500/20',    label: 'WORKING' },
  PR_CREATED: { bg: 'bg-violet-500/10',  text: 'text-violet-400',  border: 'border-violet-500/20',  label: 'PR CREATED' },
  CLEANUP:    { bg: 'bg-amber-500/10',   text: 'text-amber-400',   border: 'border-amber-500/20',   label: 'CLEANUP' },
  DONE:       { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', label: 'DONE' },
  ZOMBIE:     { bg: 'bg-red-500/10',     text: 'text-red-400',     border: 'border-red-500/20',     label: 'ZOMBIE' },
};

const LIFECYCLE_BAR_COLORS: Record<PolecatLifecycle, string> = {
  SPAWNED:    'bg-blue-400',
  WORKING:    'bg-cyan-400',
  PR_CREATED: 'bg-violet-400',
  CLEANUP:    'bg-amber-400',
  DONE:       'bg-emerald-400',
  ZOMBIE:     'bg-red-400',
};

const ANOMALY_SEVERITY_STYLES: Record<string, string> = {
  low:      'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  medium:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
  high:     'bg-orange-500/10 text-orange-400 border-orange-500/20',
  critical: 'bg-red-500/10 text-red-400 border-red-500/20',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function formatDuration(ms: number | undefined | null): string {
  if (ms == null || isNaN(ms)) return '--';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatCost(usd: number | undefined | null): string {
  if (usd == null || isNaN(usd)) return '$0';
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`;
  return `$${usd.toFixed(3)}`;
}

function timeSince(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function lifecycleProgress(status: PolecatLifecycle): number {
  const idx = LIFECYCLE_ORDER.indexOf(status);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / LIFECYCLE_ORDER.length) * 100);
}

// ─── Fallback Data ──────────────────────────────────────────────────────────────

const FALLBACK_POLECATS: Polecat[] = [
  {
    id: 'pc-001', name: 'polecat-alpha', beadId: 'b-2', beadName: 'gen-types',
    worktreeBranch: 'meow/gen-types-b2', spawnTime: new Date(Date.now() - 180000).toISOString(),
    status: 'WORKING', isZombie: false, progress: 60,
    lastHeartbeat: new Date(Date.now() - 5000).toISOString(),
  },
  {
    id: 'pc-002', name: 'polecat-bravo', beadId: 'b-7', beadName: 'audit-deps',
    worktreeBranch: 'meow/audit-deps-b7', spawnTime: new Date(Date.now() - 420000).toISOString(),
    status: 'DONE', isZombie: false, progress: 100,
    lastHeartbeat: new Date(Date.now() - 60000).toISOString(),
    prUrl: 'https://github.com/org/repo/pull/42', exitCode: 0,
  },
  {
    id: 'pc-003', name: 'polecat-charlie', beadId: 'b-10', beadName: 'deploy-staging',
    worktreeBranch: 'meow/deploy-staging-b10', spawnTime: new Date(Date.now() - 30000).toISOString(),
    status: 'SPAWNED', isZombie: false, progress: 10,
    lastHeartbeat: new Date(Date.now() - 2000).toISOString(),
  },
  {
    id: 'pc-004', name: 'polecat-delta', beadId: 'b-5', beadName: 'fetch-data',
    worktreeBranch: 'meow/fetch-data-b5', spawnTime: new Date(Date.now() - 240000).toISOString(),
    status: 'PR_CREATED', isZombie: false, progress: 80,
    lastHeartbeat: new Date(Date.now() - 15000).toISOString(),
    prUrl: 'https://github.com/org/repo/pull/43',
  },
  {
    id: 'pc-005', name: 'polecat-echo', beadId: 'b-12', beadName: 'push-registry',
    worktreeBranch: 'meow/push-registry-b12', spawnTime: new Date(Date.now() - 600000).toISOString(),
    status: 'ZOMBIE', isZombie: true, progress: 35,
    lastHeartbeat: new Date(Date.now() - 360000).toISOString(),
  },
  {
    id: 'pc-006', name: 'polecat-foxtrot', beadId: 'b-8', beadName: 'patch-vulns',
    worktreeBranch: 'meow/patch-vulns-b8', spawnTime: new Date(Date.now() - 300000).toISOString(),
    status: 'CLEANUP', isZombie: false, progress: 90,
    lastHeartbeat: new Date(Date.now() - 8000).toISOString(),
  },
  {
    id: 'pc-007', name: 'polecat-golf', beadId: 'b-3', beadName: 'write-tests',
    worktreeBranch: 'meow/write-tests-b3', spawnTime: new Date(Date.now() - 90000).toISOString(),
    status: 'WORKING', isZombie: false, progress: 45,
    lastHeartbeat: new Date(Date.now() - 3000).toISOString(),
  },
];

const FALLBACK_STATS: PolecatStats = {
  totalSpawned: 23,
  active: 4,
  completed: 16,
  failed: 2,
  zombieCount: 1,
  avgLifespan: 195000,
  costPerPolecat: 0.042,
  spawnRate: 2.3,
};

const FALLBACK_WITNESS: WitnessReport = {
  id: 'wr-001',
  timestamp: new Date(Date.now() - 30000).toISOString(),
  summary: 'Swarm health nominal. 1 zombie detected (pc-005). No critical anomalies.',
  overallHealth: 85,
  checks: [
    { id: 'wc-1', name: 'Heartbeat Response', passed: true, timestamp: new Date(Date.now() - 30000).toISOString() },
    { id: 'wc-2', name: 'Worktree Integrity', passed: true, timestamp: new Date(Date.now() - 30000).toISOString() },
    { id: 'wc-3', name: 'Memory Bounds', passed: true, timestamp: new Date(Date.now() - 30000).toISOString() },
    { id: 'wc-4', name: 'Zombie Detection', passed: false, details: 'pc-005 stale > 5min', timestamp: new Date(Date.now() - 30000).toISOString() },
    { id: 'wc-5', name: 'PR Quality Gate', passed: true, timestamp: new Date(Date.now() - 30000).toISOString() },
    { id: 'wc-6', name: 'Resource Limits', passed: true, timestamp: new Date(Date.now() - 30000).toISOString() },
  ],
  anomalies: [
    { id: 'an-1', severity: 'medium', message: 'Polecat pc-005 unresponsive for 6 minutes', polecatId: 'pc-005', detectedAt: new Date(Date.now() - 30000).toISOString() },
    { id: 'an-2', severity: 'low', message: 'Spawn rate above baseline (2.3/min vs 1.5/min avg)', detectedAt: new Date(Date.now() - 120000).toISOString() },
  ],
};

// ─── Sub-components ─────────────────────────────────────────────────────────────

function LifecycleBadge({ status }: { status: PolecatLifecycle }) {
  const style = LIFECYCLE_STYLES[status] || LIFECYCLE_STYLES.SPAWNED;
  return (
    <span className={`px-2 py-0.5 font-mono text-[10px] uppercase border ${style.bg} ${style.text} ${style.border}`}>
      {style.label}
    </span>
  );
}

function LifecycleBar({ status, progress }: { status: PolecatLifecycle; progress: number }) {
  const barColor = LIFECYCLE_BAR_COLORS[status] || 'bg-zinc-500';
  const segments = LIFECYCLE_ORDER.map((phase, i) => {
    const phaseProgress = lifecycleProgress(phase);
    const prevProgress = i > 0 ? lifecycleProgress(LIFECYCLE_ORDER[i - 1]) : 0;
    const isCurrent = status === phase;
    const isPast = LIFECYCLE_ORDER.indexOf(status) > i || status === 'DONE';
    const isZombie = status === 'ZOMBIE';

    return (
      <div
        key={phase}
        className="flex-1 relative"
        title={phase}
      >
        <div className="h-1.5 bg-[#2d363f]/30">
          {(isPast || isCurrent) && (
            <motion.div
              className={`h-full ${isZombie ? 'bg-red-400/60' : isPast ? LIFECYCLE_BAR_COLORS[phase] : barColor}`}
              initial={{ width: 0 }}
              animate={{
                width: isPast ? '100%' : isCurrent ? `${Math.min(((progress - prevProgress) / (phaseProgress - prevProgress)) * 100, 100)}%` : '0%',
              }}
              transition={{ duration: 0.4 }}
            />
          )}
        </div>
        {i < LIFECYCLE_ORDER.length - 1 && (
          <div className="absolute right-0 top-0 w-px h-1.5 bg-[#2d363f]/50" />
        )}
      </div>
    );
  });

  return <div className="flex gap-0">{segments}</div>;
}

function PolecatCard({ polecat }: { polecat: Polecat }) {
  const effectiveStatus: PolecatLifecycle = polecat.isZombie ? 'ZOMBIE' : polecat.status;
  const style = LIFECYCLE_STYLES[effectiveStatus] || LIFECYCLE_STYLES.SPAWNED;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`bg-[#1a1f26] border ${polecat.isZombie ? 'border-red-500/30' : 'border-[#2d363f]'} p-3 w-[220px] shrink-0 relative`}
    >
      {/* Zombie indicator */}
      {polecat.isZombie && (
        <motion.div
          className="absolute top-2 right-2 text-red-400 text-sm"
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          title="ZOMBIE — stale > 5 min"
        >
          {'\u{1F480}'}
        </motion.div>
      )}

      {/* Name + Status */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 ${
          polecat.isZombie ? 'bg-red-400' :
          effectiveStatus === 'WORKING' ? 'bg-cyan-400 animate-pulse' :
          effectiveStatus === 'DONE' ? 'bg-emerald-400' :
          'bg-white/20'
        }`} />
        <span className="font-mono text-xs text-[#e6e1cf] truncate">{polecat.name}</span>
      </div>

      {/* Lifecycle badge */}
      <div className="mb-2">
        <LifecycleBadge status={effectiveStatus} />
      </div>

      {/* Progress bar */}
      <div className="mb-2">
        <LifecycleBar status={effectiveStatus} progress={polecat.progress} />
        <div className="flex justify-between mt-0.5">
          {LIFECYCLE_ORDER.map((phase) => (
            <span key={phase} className="font-mono text-[8px] text-[#4a5159] flex-1 text-center">
              {phase.slice(0, 3)}
            </span>
          ))}
        </div>
      </div>

      {/* Details */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-[#4a5159]">Bead</span>
          <span className="font-mono text-[10px] text-cyan-400/60 truncate max-w-[120px]">
            {polecat.beadName || polecat.beadId}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-[#4a5159]">Branch</span>
          <span className="font-mono text-[10px] text-violet-400/60 truncate max-w-[120px]">
            {polecat.worktreeBranch}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-[#4a5159]">Spawned</span>
          <span className="font-mono text-[10px] text-[#4a5159]">
            {timeSince(polecat.spawnTime)}
          </span>
        </div>
        {polecat.lastHeartbeat && (
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#4a5159]">Heartbeat</span>
            <span className={`font-mono text-[10px] ${polecat.isZombie ? 'text-red-400' : 'text-[#4a5159]'}`}>
              {timeSince(polecat.lastHeartbeat)}
            </span>
          </div>
        )}
        {polecat.prUrl && (
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#4a5159]">PR</span>
            <span className="font-mono text-[10px] text-violet-400 truncate max-w-[120px]">
              {polecat.prUrl.split('/').pop()}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function PolecatSwarmView() {
  const [polecats, setPolecats] = useState<Polecat[]>([]);
  const [stats, setStats] = useState<PolecatStats>(FALLBACK_STATS);
  const [witness, setWitness] = useState<WitnessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [forcePatrolling, setForcePatrolling] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);

  // ─── Fetch All Data ───────────────────────────────────────────────────────

  const fetchData = useCallback(async (controller: AbortController) => {
    try {
      const [polecatRes, statsRes, healthRes, witnessRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/polecats`, { signal: controller.signal }),
        fetch(`${API}/api/meow/polecats/stats`, { signal: controller.signal }),
        fetch(`${API}/api/meow/polecats/health`, { signal: controller.signal }),
        fetch(`${API}/api/meow/witness/report`, { signal: controller.signal }),
      ]);

      // Polecats
      if (polecatRes.status === 'fulfilled' && polecatRes.value.ok) {
        const data = await polecatRes.value.json();
        const rawPolecats = data.polecats || data.workers || [];
        setPolecats(rawPolecats.map((p: Polecat) => ({
          ...p,
          progress: p.progress ?? lifecycleProgress(p.status),
          isZombie: p.isZombie ?? false,
        })));
      } else {
        setPolecats((prev) => prev.length === 0 ? FALLBACK_POLECATS : prev);
      }

      // Stats
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const data = await statsRes.value.json();
        if (data.stats) setStats(data.stats);
        else setStats(data as PolecatStats);
      } else {
        setStats((prev) => prev === FALLBACK_STATS ? FALLBACK_STATS : prev);
      }

      // Health — mark zombies
      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const data = await healthRes.value.json();
        if (data.zombies && Array.isArray(data.zombies)) {
          const zombieIds = new Set(data.zombies.map((z: { id: string }) => z.id));
          setPolecats((prev) =>
            prev.map((p) => ({
              ...p,
              isZombie: zombieIds.has(p.id) || p.isZombie,
              status: zombieIds.has(p.id) ? 'ZOMBIE' as PolecatLifecycle : p.status,
            })),
          );
        }
      }

      // Witness
      if (witnessRes.status === 'fulfilled' && witnessRes.value.ok) {
        const data = await witnessRes.value.json();
        setWitness(data.report || data);
      } else {
        setWitness((prev) => prev === null ? FALLBACK_WITNESS : prev);
      }

      setLoading(false);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setPolecats((prev) => prev.length === 0 ? FALLBACK_POLECATS : prev);
        setWitness((prev) => prev === null ? FALLBACK_WITNESS : prev);
        setLoading(false);
      }
    }
  }, []);

  // ─── Polling ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    fetchData(controller);
    const iv = setInterval(() => {
      if (!controller.signal.aborted) fetchData(controller);
    }, POLL_INTERVAL);
    return () => {
      controller.abort();
      clearInterval(iv);
    };
  }, [fetchData]);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleSpawnPolecat = useCallback(async () => {
    setSpawning(true);
    try {
      await fetch(`${API}/api/meow/polecats/spawn`, { method: 'POST' });
      const c = new AbortController();
      fetchData(c);
    } catch { /* silent */ }
    setTimeout(() => setSpawning(false), 2000);
  }, [fetchData]);

  const handleCleanupStale = useCallback(async () => {
    setCleaningUp(true);
    try {
      await fetch(`${API}/api/meow/polecats/cleanup`, { method: 'POST' });
      const c = new AbortController();
      fetchData(c);
    } catch { /* silent */ }
    setTimeout(() => setCleaningUp(false), 2000);
  }, [fetchData]);

  const handleForcePatrol = useCallback(async () => {
    setForcePatrolling(true);
    try {
      await fetch(`${API}/api/meow/witness/patrol`, { method: 'POST' });
      const c = new AbortController();
      fetchData(c);
    } catch { /* silent */ }
    setTimeout(() => setForcePatrolling(false), 3000);
  }, [fetchData]);

  // ─── Derived ──────────────────────────────────────────────────────────────

  const swimLanes = useMemo(() => {
    const lanes: Record<PolecatLifecycle, Polecat[]> = {
      SPAWNED: [], WORKING: [], PR_CREATED: [], CLEANUP: [], DONE: [], ZOMBIE: [],
    };
    polecats.forEach((p) => {
      const key: PolecatLifecycle = p.isZombie ? 'ZOMBIE' : p.status;
      if (lanes[key]) lanes[key].push(p);
    });
    return lanes;
  }, [polecats]);

  const activeCount = polecats.filter((p) => !p.isZombie && p.status !== 'DONE').length;
  const witnessPassRate = witness
    ? Math.round(((witness.checks || []).filter((c) => c.passed).length / Math.max((witness.checks || []).length, 1)) * 100)
    : 0;

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0f1419]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-[#4a5159]">
            Scanning swarm...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0f1419] text-[#e6e1cf]">
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2d363f]">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm uppercase tracking-widest text-[#6c7680]">
            Polecat Swarm
          </h1>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 ${activeCount > 0 ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`} />
            <span className="font-mono text-[10px] text-cyan-400">
              {activeCount} active
            </span>
            <span className="font-mono text-[10px] text-[#4a5159]">/</span>
            <span className="font-mono text-[10px] text-[#4a5159]">
              {polecats.length} total
            </span>
          </div>
          <span className="font-mono text-[10px] text-[#4a5159]">|</span>
          <span className="font-mono text-[10px] text-[#4a5159]">
            {(stats.spawnRate ?? 0).toFixed(1)}/min spawn rate
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSpawnPolecat}
            disabled={spawning}
            className="px-3 py-1.5 font-mono text-[10px] uppercase bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors disabled:opacity-40"
          >
            {spawning ? 'Spawning...' : '+ Spawn Polecat'}
          </button>
          <button
            onClick={handleCleanupStale}
            disabled={cleaningUp}
            className="px-3 py-1.5 font-mono text-[10px] uppercase bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-40"
          >
            {cleaningUp ? 'Cleaning...' : 'Cleanup Stale'}
          </button>
        </div>
      </div>

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ─── Left: Swim Lanes (70%) ──────────────────────────────────── */}
        <div className="w-[70%] flex flex-col overflow-hidden border-r border-[#2d363f]">
          <div className="flex-1 overflow-auto p-4 space-y-4">
            {(Object.entries(swimLanes) as [PolecatLifecycle, Polecat[]][]).map(([lane, cards]) => {
              if (cards.length === 0 && lane === 'ZOMBIE') return null;
              const style = LIFECYCLE_STYLES[lane];
              return (
                <div key={lane}>
                  {/* Lane header */}
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`w-3 h-0.5 ${LIFECYCLE_BAR_COLORS[lane]}`} />
                    <span className={`font-mono text-[10px] uppercase tracking-widest ${style.text}`}>
                      {style.label}
                    </span>
                    <span className="font-mono text-[10px] text-[#4a5159]">
                      {cards.length}
                    </span>
                  </div>

                  {/* Cards flow */}
                  {cards.length === 0 ? (
                    <div className="font-mono text-[10px] text-[#4a5159] py-3 pl-6">
                      No polecats in this stage
                    </div>
                  ) : (
                    <div className="flex gap-3 overflow-x-auto pb-2 pl-6">
                      <AnimatePresence>
                        {cards.map((p) => (
                          <PolecatCard key={p.id} polecat={p} />
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── Right: Witness Panel (30%) ──────────────────────────────── */}
        <div className="w-[30%] flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2d363f]">
            <span className="font-mono text-[10px] uppercase tracking-widest text-[#4a5159]">
              Witness Oversight
            </span>
            <button
              onClick={handleForcePatrol}
              disabled={forcePatrolling}
              className="px-2 py-1 font-mono text-[10px] uppercase bg-violet-500/10 text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors disabled:opacity-40"
            >
              {forcePatrolling ? 'Patrolling...' : 'Force Patrol'}
            </button>
          </div>

          <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
            {witness ? (
              <>
                {/* Health Score */}
                <div className="bg-[#1a1f26] border border-[#2d363f] p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-[10px] uppercase text-[#4a5159]">
                      Overall Health
                    </span>
                    <span className={`font-mono text-lg font-medium ${
                      witness.overallHealth >= 80 ? 'text-emerald-400' :
                      witness.overallHealth >= 50 ? 'text-amber-400' :
                      'text-red-400'
                    }`}>
                      {witness.overallHealth}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-[#2d363f]/30">
                    <motion.div
                      className={`h-full ${
                        witness.overallHealth >= 80 ? 'bg-emerald-400' :
                        witness.overallHealth >= 50 ? 'bg-amber-400' :
                        'bg-red-400'
                      }`}
                      initial={{ width: 0 }}
                      animate={{ width: `${witness.overallHealth}%` }}
                      transition={{ duration: 0.6 }}
                    />
                  </div>
                </div>

                {/* Summary */}
                <div className="bg-[#1a1f26] border border-[#2d363f] p-3">
                  <span className="font-mono text-[10px] uppercase text-[#4a5159] block mb-1">
                    Report Summary
                  </span>
                  <p className="font-mono text-[11px] text-[#6c7680] leading-relaxed">
                    {witness.summary}
                  </p>
                  <span className="font-mono text-[10px] text-[#4a5159] mt-1 block">
                    {formatTime(witness.timestamp)}
                  </span>
                </div>

                {/* Checks */}
                <div>
                  <span className="font-mono text-[10px] uppercase text-[#4a5159] mb-2 block">
                    Checks ({witnessPassRate}% pass)
                  </span>
                  <div className="space-y-1">
                    {(witness.checks || []).map((check) => (
                      <div
                        key={check.id}
                        className={`flex items-center gap-2 px-2 py-1.5 border ${
                          check.passed
                            ? 'border-[#2d363f]/30 bg-transparent'
                            : 'border-red-500/20 bg-red-500/5'
                        }`}
                      >
                        <span className={`font-mono text-[11px] ${
                          check.passed ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {check.passed ? '\u2713' : '\u2717'}
                        </span>
                        <span className="font-mono text-[10px] text-[#6c7680] flex-1">
                          {check.name}
                        </span>
                        {check.details && (
                          <span className="font-mono text-[10px] text-red-400/60 truncate max-w-[100px]">
                            {check.details}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Anomalies */}
                {(witness.anomalies || []).length > 0 && (
                  <div>
                    <span className="font-mono text-[10px] uppercase text-[#4a5159] mb-2 block">
                      Anomalies ({(witness.anomalies || []).length})
                    </span>
                    <div className="space-y-2">
                      <AnimatePresence>
                        {(witness.anomalies || []).map((anomaly) => (
                          <motion.div
                            key={anomaly.id}
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className={`p-2 border ${ANOMALY_SEVERITY_STYLES[anomaly.severity] || ANOMALY_SEVERITY_STYLES.low}`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-mono text-[10px] uppercase">
                                {anomaly.severity}
                              </span>
                              {anomaly.polecatId && (
                                <span className="font-mono text-[10px] text-[#4a5159]">
                                  {anomaly.polecatId}
                                </span>
                              )}
                            </div>
                            <p className="font-mono text-[10px] text-[#4a5159] leading-relaxed">
                              {anomaly.message}
                            </p>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 font-mono text-xs text-[#4a5159]">
                No witness report available
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Bottom Stats Bar ────────────────────────────────────────────── */}
      <div className="border-t border-[#2d363f] px-6 py-3">
        <div className="flex items-center gap-6">
          {[
            { label: 'Spawned', value: stats.totalSpawned, cls: 'text-[#6c7680]' },
            { label: 'Active', value: stats.active, cls: 'text-cyan-400' },
            { label: 'Completed', value: stats.completed, cls: 'text-emerald-400' },
            { label: 'Failed', value: stats.failed, cls: stats.failed > 0 ? 'text-red-400' : 'text-[#4a5159]' },
            { label: 'Zombies', value: stats.zombieCount, cls: stats.zombieCount > 0 ? 'text-red-400' : 'text-[#4a5159]' },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase text-[#4a5159]">{s.label}</span>
              <span className={`font-mono text-xs font-medium ${s.cls}`}>{s.value}</span>
            </div>
          ))}

          <div className="h-4 w-px bg-[#2d363f]/30" />

          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase text-[#4a5159]">Avg Lifespan</span>
            <span className="font-mono text-xs text-[#6c7680]">{formatDuration(stats.avgLifespan)}</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase text-[#4a5159]">Cost/Polecat</span>
            <span className="font-mono text-xs text-amber-400/60">{formatCost(stats.costPerPolecat)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
