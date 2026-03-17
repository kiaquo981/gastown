'use client';

/**
 * NDIStatusView -- Nondeterministic Idempotence Status
 *
 * The 3 pillars of persistence in Gas Town:
 *   Agent Bead + Hook Bead + Molecule Chain
 * All backed by Git.
 *
 * "Sessions are cattle, Agents are pets."
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

/* ──────────────────── Types ──────────────────── */

interface PulseData {
  status: string;
  uptime?: number;
  workers?: number;
  molecules?: number;
  hooks?: number;
  beads?: number;
  timestamp?: string;
  [key: string]: unknown;
}

interface BeadStatsData {
  total: number;
  by_status: Record<string, number>;
  velocity?: number | { avg_per_week?: number };
  [key: string]: unknown;
}

interface HookStatsData {
  total?: number;
  pending?: number;
  claimed?: number;
  completed?: number;
  failed?: number;
  [key: string]: unknown;
}

interface MoleculeData {
  id: string;
  name?: string;
  status?: string;
  steps?: { id: string; status: string; name?: string }[];
  convoy?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface CrewMember {
  id: string;
  name: string;
  status: string;
  specialization?: string;
  metrics?: { tasksCompleted?: number; avgDuration?: string; successRate?: number };
  currentAssignment?: string | null;
  [key: string]: unknown;
}

interface WorkerContext {
  sessionId?: string;
  lastActivity?: string;
  beadCount?: number;
  sessionCount?: number;
  deathReason?: string;
  lastWords?: string;
  recoveredAt?: string;
  recoveredBy?: string;
  [key: string]: unknown;
}

type PillarHealth = 'green' | 'yellow' | 'red';

/* ──────────────────── Ayu Dark Palette ──────────────────── */

const AYU = {
  bg: '#0f1419',
  card: '#1a1f26',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

/* ──────────────────── Constants ──────────────────── */

const POLL_INTERVAL = 10000;

/* ──────────────────── Helpers ──────────────────── */

function healthColor(h: PillarHealth): string {
  if (h === 'green') return AYU.green;
  if (h === 'yellow') return AYU.yellow;
  return AYU.red;
}

function healthLabel(h: PillarHealth): string {
  if (h === 'green') return 'HEALTHY';
  if (h === 'yellow') return 'DEGRADED';
  return 'CRITICAL';
}

function timeAgo(ts: string | undefined | null): string {
  if (!ts) return 'never';
  try {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  } catch {
    return 'unknown';
  }
}

function formatUptime(seconds: number | undefined): string {
  if (!seconds) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ──────────────────── Component ──────────────────── */

export default function NDIStatusView() {
  /* ── State ── */
  const [pulse, setPulse] = useState<PulseData | null>(null);
  const [beadStats, setBeadStats] = useState<BeadStatsData | null>(null);
  const [hookStats, setHookStats] = useState<HookStatsData | null>(null);
  const [molecules, setMolecules] = useState<MoleculeData[]>([]);
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [workerContexts, setWorkerContexts] = useState<Record<string, WorkerContext>>({});
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [expandedWorker, setExpandedWorker] = useState<string | null>(null);
  const [svgHover, setSvgHover] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  /* ── Fetch all data ── */

  const fetchAll = useCallback(async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    try {
      const [pulseRes, beadRes, hookRes, molRes, crewRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/town/pulse`, { signal }),
        fetch(`${API}/api/beads/stats`, { signal }),
        fetch(`${API}/api/meow/gupp/stats`, { signal }),
        fetch(`${API}/api/meow/molecules`, { signal }),
        fetch(`${API}/api/meow/crew`, { signal }),
      ]);

      if (pulseRes.status === 'fulfilled' && pulseRes.value.ok) {
        setPulse(await pulseRes.value.json());
      }
      if (beadRes.status === 'fulfilled' && beadRes.value.ok) {
        setBeadStats(await beadRes.value.json());
      }
      if (hookRes.status === 'fulfilled' && hookRes.value.ok) {
        setHookStats(await hookRes.value.json());
      }
      if (molRes.status === 'fulfilled' && molRes.value.ok) {
        const molData = await molRes.value.json();
        setMolecules(Array.isArray(molData) ? molData : molData.molecules || []);
      }
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const crewData = await crewRes.value.json();
        const members: CrewMember[] = Array.isArray(crewData) ? crewData : crewData.crew || crewData.members || [];
        setCrew(members);
      }

      setLastRefresh(new Date().toISOString());
    } catch {
      // network error — keep stale data
    } finally {
      setLoading(false);
    }
    return () => controller.abort();
  }, []);

  const fetchWorkerContext = useCallback(async (workerId: string) => {
    try {
      const res = await fetch(`${API}/api/meow/crew/${workerId}/context`);
      if (!res.ok) return;
      const ctx = await res.json();
      setWorkerContexts(prev => ({ ...prev, [workerId]: ctx }));
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchAll();
    pollRef.current = setInterval(fetchAll, POLL_INTERVAL);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchAll]);

  /* ── Derived health ── */

  const beadHealth: PillarHealth = (() => {
    if (!beadStats) return 'red';
    const blocked = beadStats.by_status?.blocked || 0;
    const total = beadStats.total || 1;
    if (blocked / total > 0.3) return 'red';
    if (blocked / total > 0.1) return 'yellow';
    return 'green';
  })();

  const hookHealth: PillarHealth = (() => {
    if (!hookStats) return 'red';
    const failed = hookStats.failed || 0;
    const total = (hookStats.total || hookStats.pending || 0) + (hookStats.claimed || 0) + (hookStats.completed || 0) + failed;
    if (total === 0) return 'yellow';
    if (failed / Math.max(total, 1) > 0.2) return 'red';
    if (failed > 0) return 'yellow';
    return 'green';
  })();

  const moleculeHealth: PillarHealth = (() => {
    if (molecules.length === 0) return 'yellow';
    const stalled = molecules.filter(m => m.status === 'stalled' || m.status === 'failed').length;
    if (stalled / molecules.length > 0.3) return 'red';
    if (stalled > 0) return 'yellow';
    return 'green';
  })();

  /* ── Active counts for SVG ── */
  const activeBeads = beadStats?.by_status?.in_progress || 0;
  const activeHooks = hookStats?.claimed || 0;
  const activeMolecules = molecules.filter(m => m.status === 'running' || m.status === 'active' || m.status === 'in_progress').length;

  /* ── Workers with session info ── */
  const deadSessions = crew.filter(w => {
    const ctx = workerContexts[w.id];
    return ctx?.deathReason || w.status === 'idle';
  });

  /* ── Expand worker → fetch context ── */
  const toggleWorker = (id: string) => {
    if (expandedWorker === id) {
      setExpandedWorker(null);
    } else {
      setExpandedWorker(id);
      if (!workerContexts[id]) fetchWorkerContext(id);
    }
  };

  /* ──────────────────── Render ──────────────────── */

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: AYU.bg, color: AYU.muted }}>
        <div className="text-sm animate-pulse">Loading NDI status...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto font-mono" style={{ background: AYU.bg, color: AYU.text }}>
      {/* ── Header ── */}
      <div className="px-6 py-5 border-b" style={{ borderColor: AYU.border }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-bold tracking-tight" style={{ color: AYU.text }}>
              NDI STATUS
            </h1>
            <span className="text-xs" style={{ color: AYU.muted }}>
              Nondeterministic Idempotence
            </span>
            {pulse && (
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
                style={{
                  background: pulse.status === 'ok' || pulse.status === 'alive' ? `${AYU.green}15` : `${AYU.red}15`,
                  color: pulse.status === 'ok' || pulse.status === 'alive' ? AYU.green : AYU.red,
                  border: `1px solid ${pulse.status === 'ok' || pulse.status === 'alive' ? AYU.green : AYU.red}30`,
                }}
              >
                {pulse.status}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {pulse?.uptime != null && (
              <span className="text-[10px]" style={{ color: AYU.muted }}>
                Uptime: {formatUptime(pulse.uptime as number)}
              </span>
            )}
            <span className="text-[10px]" style={{ color: AYU.muted }}>
              Last refresh: {lastRefresh ? timeAgo(lastRefresh) : '--'}
            </span>
            <button
              onClick={fetchAll}
              className="px-3 py-1 text-xs transition-colors hover:opacity-80"
              style={{ background: `${AYU.border}`, color: AYU.muted, border: `1px solid ${AYU.border}` }}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-8">

        {/* ═══════════════ Section 1: Three Pillars ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            The Three Pillars of Persistence
          </h2>
          <div className="grid grid-cols-3 gap-4">

            {/* ── Pillar 1: Agent Bead ── */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: healthColor(beadHealth) }} />
                  <span className="text-sm font-bold" style={{ color: AYU.text }}>AGENT BEAD</span>
                </div>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: healthColor(beadHealth) }}>
                  {healthLabel(beadHealth)}
                </span>
              </div>
              <p className="text-[11px] mb-4" style={{ color: AYU.muted }}>
                Worker identity, their CV chain, persistent memory. Each agent accumulates beads as proof-of-work.
              </p>

              {/* Worker list */}
              <div className="space-y-2 max-h-[320px] overflow-y-auto">
                {crew.length === 0 && (
                  <div className="text-[10px] py-4 text-center" style={{ color: AYU.muted }}>No workers registered</div>
                )}
                {crew.map(worker => (
                  <button
                    key={worker.id}
                    onClick={() => toggleWorker(worker.id)}
                    className="w-full text-left p-3 rounded-none transition-colors"
                    style={{
                      background: expandedWorker === worker.id ? `${AYU.border}40` : `${AYU.bg}`,
                      border: `1px solid ${AYU.border}`,
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: worker.status === 'active' ? AYU.green :
                              worker.status === 'paused' ? AYU.yellow : AYU.muted,
                          }}
                        />
                        <span className="text-xs" style={{ color: AYU.text }}>{worker.name}</span>
                      </div>
                      <span className="text-[10px]" style={{ color: AYU.muted }}>
                        {worker.metrics?.tasksCompleted ?? 0} beads
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px]" style={{ color: AYU.muted }}>
                      <span>{worker.specialization || 'general'}</span>
                      <span>{worker.metrics?.successRate != null ? `${Math.round(worker.metrics.successRate * 100)}% rate` : ''}</span>
                    </div>
                    {expandedWorker === worker.id && workerContexts[worker.id] && (
                      <div className="mt-3 pt-3 space-y-1" style={{ borderTop: `1px solid ${AYU.border}` }}>
                        <div className="text-[10px]" style={{ color: AYU.cyan }}>
                          Sessions: {workerContexts[worker.id].sessionCount ?? '--'}
                        </div>
                        <div className="text-[10px]" style={{ color: AYU.muted }}>
                          Last active: {timeAgo(workerContexts[worker.id].lastActivity)}
                        </div>
                        {workerContexts[worker.id].deathReason && (
                          <div className="text-[10px]" style={{ color: AYU.red }}>
                            Last death: {workerContexts[worker.id].deathReason}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>

              {/* Bead totals */}
              <div className="mt-4 pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${AYU.border}` }}>
                <span className="text-[10px] uppercase" style={{ color: AYU.muted }}>Total beads</span>
                <span className="text-sm font-bold" style={{ color: AYU.green }}>{beadStats?.total ?? 0}</span>
              </div>
            </div>

            {/* ── Pillar 2: Hook Bead ── */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: healthColor(hookHealth) }} />
                  <span className="text-sm font-bold" style={{ color: AYU.text }}>HOOK BEAD</span>
                </div>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: healthColor(hookHealth) }}>
                  {healthLabel(hookHealth)}
                </span>
              </div>
              <p className="text-[11px] mb-4" style={{ color: AYU.muted }}>
                GUPP hooks that persist work assignments. The claim-execute-complete lifecycle ensures no work is lost.
              </p>

              {/* Hook stats grid */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                {[
                  { label: 'Pending', value: hookStats?.pending ?? 0, color: AYU.yellow },
                  { label: 'Claimed', value: hookStats?.claimed ?? 0, color: AYU.cyan },
                  { label: 'Completed', value: hookStats?.completed ?? 0, color: AYU.green },
                  { label: 'Failed', value: hookStats?.failed ?? 0, color: AYU.red },
                ].map(item => (
                  <div
                    key={item.label}
                    className="p-3 rounded-none"
                    style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}
                  >
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>{item.label}</div>
                    <div className="text-lg font-bold" style={{ color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Hook-to-bead mapping info */}
              <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Hook-to-Bead Mapping</div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px]">
                    <span style={{ color: AYU.muted }}>Active hooks with beads</span>
                    <span style={{ color: AYU.cyan }}>{activeHooks}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span style={{ color: AYU.muted }}>Orphan hooks (no bead)</span>
                    <span style={{ color: hookStats?.pending ? AYU.yellow : AYU.muted }}>
                      {hookStats?.pending ?? 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span style={{ color: AYU.muted }}>Total hook throughput</span>
                    <span style={{ color: AYU.text }}>
                      {(hookStats?.completed ?? 0) + (hookStats?.claimed ?? 0) + (hookStats?.pending ?? 0)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${AYU.border}` }}>
                <span className="text-[10px] uppercase" style={{ color: AYU.muted }}>Total hooks</span>
                <span className="text-sm font-bold" style={{ color: AYU.yellow }}>
                  {hookStats?.total ?? ((hookStats?.pending ?? 0) + (hookStats?.claimed ?? 0) + (hookStats?.completed ?? 0) + (hookStats?.failed ?? 0))}
                </span>
              </div>
            </div>

            {/* ── Pillar 3: Molecule Chain ── */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: healthColor(moleculeHealth) }} />
                  <span className="text-sm font-bold" style={{ color: AYU.text }}>MOLECULE CHAIN</span>
                </div>
                <span className="text-[10px] uppercase tracking-wider" style={{ color: healthColor(moleculeHealth) }}>
                  {healthLabel(moleculeHealth)}
                </span>
              </div>
              <p className="text-[11px] mb-4" style={{ color: AYU.muted }}>
                Molecular work state. Multi-step execution chains with convoy associations. The full DAG of work.
              </p>

              {/* Molecule list */}
              <div className="space-y-2 max-h-[280px] overflow-y-auto">
                {molecules.length === 0 && (
                  <div className="text-[10px] py-4 text-center" style={{ color: AYU.muted }}>No active molecules</div>
                )}
                {molecules.slice(0, 15).map(mol => {
                  const totalSteps = mol.steps?.length ?? 0;
                  const doneSteps = mol.steps?.filter(s => s.status === 'done' || s.status === 'completed').length ?? 0;
                  const pct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
                  return (
                    <div
                      key={mol.id}
                      className="p-3 rounded-none"
                      style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs truncate max-w-[60%]" style={{ color: AYU.text }}>
                          {mol.name || mol.id.slice(0, 12)}
                        </span>
                        <span
                          className="text-[10px] uppercase"
                          style={{
                            color: mol.status === 'running' || mol.status === 'active' ? AYU.green :
                              mol.status === 'stalled' || mol.status === 'failed' ? AYU.red :
                              mol.status === 'completed' || mol.status === 'done' ? AYU.cyan : AYU.muted,
                          }}
                        >
                          {mol.status || 'unknown'}
                        </span>
                      </div>
                      {/* Step progress bar */}
                      {totalSteps > 0 && (
                        <div className="mt-2">
                          <div className="flex justify-between text-[10px] mb-1" style={{ color: AYU.muted }}>
                            <span>{doneSteps}/{totalSteps} steps</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="h-1 rounded-none" style={{ background: `${AYU.border}` }}>
                            <div
                              className="h-full rounded-none transition-all"
                              style={{ width: `${pct}%`, background: AYU.green }}
                            />
                          </div>
                        </div>
                      )}
                      {mol.convoy && (
                        <div className="mt-1 text-[10px]" style={{ color: AYU.purple }}>
                          Convoy: {mol.convoy}
                        </div>
                      )}
                    </div>
                  );
                })}
                {molecules.length > 15 && (
                  <div className="text-[10px] text-center py-2" style={{ color: AYU.muted }}>
                    +{molecules.length - 15} more molecules
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 flex items-center justify-between" style={{ borderTop: `1px solid ${AYU.border}` }}>
                <span className="text-[10px] uppercase" style={{ color: AYU.muted }}>Active molecules</span>
                <span className="text-sm font-bold" style={{ color: AYU.cyan }}>{activeMolecules}</span>
              </div>
            </div>
          </div>
        </section>

        {/* ═══════════════ Section 2: Persistence Diagram (SVG) ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Persistence Diagram
          </h2>
          <div className="rounded-none p-6" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
            <svg viewBox="0 0 900 220" className="w-full" style={{ maxHeight: 220 }}>
              {/* Background grid pattern */}
              <defs>
                <pattern id="ndi-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke={AYU.border} strokeWidth="0.3" />
                </pattern>
                {/* Animated dash for data flow */}
                <style>{`
                  @keyframes ndi-flow { to { stroke-dashoffset: -24; } }
                  .ndi-flow-line { animation: ndi-flow 1.5s linear infinite; }
                  @keyframes ndi-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
                  .ndi-pulse { animation: ndi-pulse 2s ease-in-out infinite; }
                `}</style>
              </defs>
              <rect width="900" height="220" fill={AYU.bg} />
              <rect width="900" height="220" fill="url(#ndi-grid)" />

              {/* ── Node 1: Agent Bead ── */}
              <g
                onMouseEnter={() => setSvgHover('bead')}
                onMouseLeave={() => setSvgHover(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x="40" y="60" width="200" height="100" rx="0"
                  fill={svgHover === 'bead' ? `${AYU.card}` : AYU.bg}
                  stroke={healthColor(beadHealth)}
                  strokeWidth={svgHover === 'bead' ? 2 : 1}
                />
                <text x="140" y="95" textAnchor="middle" fill={AYU.text} fontSize="13" fontFamily="monospace" fontWeight="bold">
                  AGENT BEAD
                </text>
                <text x="140" y="115" textAnchor="middle" fill={AYU.muted} fontSize="10" fontFamily="monospace">
                  Workers: {crew.length}
                </text>
                <text x="140" y="130" textAnchor="middle" fill={healthColor(beadHealth)} fontSize="10" fontFamily="monospace">
                  Beads: {beadStats?.total ?? 0}
                </text>
                <text x="140" y="145" textAnchor="middle" fill={AYU.muted} fontSize="9" fontFamily="monospace">
                  In Progress: {activeBeads}
                </text>
                {/* Health dot */}
                <circle cx="55" cy="75" r="4" fill={healthColor(beadHealth)} className="ndi-pulse" />
              </g>

              {/* ── Flow line: Bead -> Hook ── */}
              <line
                x1="240" y1="110" x2="350" y2="110"
                stroke={AYU.cyan}
                strokeWidth="1.5"
                strokeDasharray="8 4"
                className="ndi-flow-line"
                opacity="0.7"
              />
              {/* Connection count */}
              <rect x="270" y="88" width="50" height="20" rx="0" fill={AYU.bg} stroke={AYU.border} strokeWidth="1" />
              <text x="295" y="102" textAnchor="middle" fill={AYU.cyan} fontSize="10" fontFamily="monospace">
                {activeHooks}
              </text>
              {/* Arrow */}
              <polygon points="348,105 340,100 340,110" fill={AYU.cyan} opacity="0.7" />

              {/* ── Node 2: Hook Bead ── */}
              <g
                onMouseEnter={() => setSvgHover('hook')}
                onMouseLeave={() => setSvgHover(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x="350" y="60" width="200" height="100" rx="0"
                  fill={svgHover === 'hook' ? `${AYU.card}` : AYU.bg}
                  stroke={healthColor(hookHealth)}
                  strokeWidth={svgHover === 'hook' ? 2 : 1}
                />
                <text x="450" y="95" textAnchor="middle" fill={AYU.text} fontSize="13" fontFamily="monospace" fontWeight="bold">
                  HOOK BEAD
                </text>
                <text x="450" y="115" textAnchor="middle" fill={AYU.muted} fontSize="10" fontFamily="monospace">
                  Pending: {hookStats?.pending ?? 0}
                </text>
                <text x="450" y="130" textAnchor="middle" fill={healthColor(hookHealth)} fontSize="10" fontFamily="monospace">
                  Claimed: {hookStats?.claimed ?? 0}
                </text>
                <text x="450" y="145" textAnchor="middle" fill={AYU.muted} fontSize="9" fontFamily="monospace">
                  Done: {hookStats?.completed ?? 0}
                </text>
                <circle cx="365" cy="75" r="4" fill={healthColor(hookHealth)} className="ndi-pulse" />
              </g>

              {/* ── Flow line: Hook -> Molecule ── */}
              <line
                x1="550" y1="110" x2="660" y2="110"
                stroke={AYU.purple}
                strokeWidth="1.5"
                strokeDasharray="8 4"
                className="ndi-flow-line"
                opacity="0.7"
              />
              <rect x="580" y="88" width="50" height="20" rx="0" fill={AYU.bg} stroke={AYU.border} strokeWidth="1" />
              <text x="605" y="102" textAnchor="middle" fill={AYU.purple} fontSize="10" fontFamily="monospace">
                {activeMolecules}
              </text>
              <polygon points="658,105 650,100 650,110" fill={AYU.purple} opacity="0.7" />

              {/* ── Node 3: Molecule Chain ── */}
              <g
                onMouseEnter={() => setSvgHover('molecule')}
                onMouseLeave={() => setSvgHover(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x="660" y="60" width="200" height="100" rx="0"
                  fill={svgHover === 'molecule' ? `${AYU.card}` : AYU.bg}
                  stroke={healthColor(moleculeHealth)}
                  strokeWidth={svgHover === 'molecule' ? 2 : 1}
                />
                <text x="760" y="95" textAnchor="middle" fill={AYU.text} fontSize="13" fontFamily="monospace" fontWeight="bold">
                  MOLECULE CHAIN
                </text>
                <text x="760" y="115" textAnchor="middle" fill={AYU.muted} fontSize="10" fontFamily="monospace">
                  Total: {molecules.length}
                </text>
                <text x="760" y="130" textAnchor="middle" fill={healthColor(moleculeHealth)} fontSize="10" fontFamily="monospace">
                  Active: {activeMolecules}
                </text>
                <text x="760" y="145" textAnchor="middle" fill={AYU.muted} fontSize="9" fontFamily="monospace">
                  Convoys: {new Set(molecules.map(m => m.convoy).filter(Boolean)).size}
                </text>
                <circle cx="675" cy="75" r="4" fill={healthColor(moleculeHealth)} className="ndi-pulse" />
              </g>

              {/* ── Git backbone line ── */}
              <line x1="40" y1="195" x2="860" y2="195" stroke={AYU.border} strokeWidth="1" strokeDasharray="4 4" />
              <text x="450" y="212" textAnchor="middle" fill={AYU.muted} fontSize="9" fontFamily="monospace">
                GIT-BACKED PERSISTENCE LAYER
              </text>

              {/* Vertical lines from nodes to git backbone */}
              <line x1="140" y1="160" x2="140" y2="195" stroke={AYU.border} strokeWidth="1" strokeDasharray="2 2" />
              <line x1="450" y1="160" x2="450" y2="195" stroke={AYU.border} strokeWidth="1" strokeDasharray="2 2" />
              <line x1="760" y1="160" x2="760" y2="195" stroke={AYU.border} strokeWidth="1" strokeDasharray="2 2" />

              {/* Labels on git connection */}
              <text x="140" y="185" textAnchor="middle" fill={AYU.green} fontSize="8" fontFamily="monospace">DB</text>
              <text x="450" y="185" textAnchor="middle" fill={AYU.green} fontSize="8" fontFamily="monospace">DB</text>
              <text x="760" y="185" textAnchor="middle" fill={AYU.green} fontSize="8" fontFamily="monospace">DB</text>

              {/* Title */}
              <text x="450" y="35" textAnchor="middle" fill={AYU.text} fontSize="11" fontFamily="monospace" fontWeight="bold">
                Agent Bead &lt;-&gt; Hook Bead &lt;-&gt; Molecule Chain
              </text>
              <text x="450" y="50" textAnchor="middle" fill={AYU.muted} fontSize="9" fontFamily="monospace">
                Nondeterministic Idempotence Triad
              </text>
            </svg>
          </div>
        </section>

        {/* ═══════════════ Section 3: Crash Recovery Panel ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Crash Recovery Panel
          </h2>
          <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
            {/* Motto */}
            <div className="mb-5 p-4 rounded-none text-center" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
              <p className="text-sm italic" style={{ color: AYU.purple }}>
                &quot;Sessions are cattle, Agents are pets.&quot;
              </p>
              <p className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                Sessions die and are replaced. Agents persist through beads.
              </p>
            </div>

            {/* Recent session deaths */}
            <div className="mb-4">
              <h3 className="text-[11px] uppercase mb-3" style={{ color: AYU.muted }}>Recent Session Deaths</h3>
              <div className="space-y-2 max-h-[240px] overflow-y-auto">
                {deadSessions.length === 0 && crew.length === 0 && (
                  <div className="text-[10px] py-4 text-center" style={{ color: AYU.muted }}>
                    No session death records available
                  </div>
                )}
                {crew.map(worker => {
                  const ctx = workerContexts[worker.id];
                  return (
                    <div
                      key={`death-${worker.id}`}
                      className="p-3 rounded-none"
                      style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs" style={{ color: AYU.text }}>{worker.name}</span>
                          <span
                            className="text-[10px] px-1.5 py-0.5"
                            style={{
                              background: worker.status === 'active' ? `${AYU.green}15` : `${AYU.red}15`,
                              color: worker.status === 'active' ? AYU.green : AYU.red,
                              border: `1px solid ${worker.status === 'active' ? AYU.green : AYU.red}30`,
                            }}
                          >
                            {worker.status}
                          </span>
                        </div>
                        <span className="text-[10px]" style={{ color: AYU.muted }}>
                          {worker.id.slice(0, 10)}
                        </span>
                      </div>
                      {ctx?.deathReason && (
                        <div className="text-[10px] mt-1" style={{ color: AYU.red }}>
                          Death: {ctx.deathReason}
                        </div>
                      )}
                      {ctx?.lastWords && (
                        <div className="text-[10px] mt-1 truncate" style={{ color: AYU.muted }}>
                          Last words: &quot;{ctx.lastWords}&quot;
                        </div>
                      )}

                      {/* Recovery status */}
                      <div className="flex items-center gap-4 mt-2 text-[10px]">
                        <span style={{ color: AYU.green }}>
                          Beads: {worker.metrics?.tasksCompleted ?? 0} preserved
                        </span>
                        <span style={{ color: AYU.cyan }}>
                          Hooks: {worker.currentAssignment ? 'intact' : 'idle'}
                        </span>
                        {ctx?.recoveredAt && (
                          <span style={{ color: AYU.purple }}>
                            Recovered {timeAgo(ctx.recoveredAt)} by {ctx.recoveredBy || 'seance'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Seance availability */}
            <div className="p-3 rounded-none flex items-center justify-between" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full" style={{ background: AYU.purple }} />
                <span className="text-[11px]" style={{ color: AYU.text }}>Seance Protocol</span>
              </div>
              <span className="text-[10px]" style={{ color: AYU.purple }}>
                Available -- talk to your predecessors
              </span>
            </div>
          </div>
        </section>

        {/* ═══════════════ Section 4: Git-Backed State ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Git-Backed State -- What Survives a Full Restart
          </h2>
          <div className="grid grid-cols-2 gap-4">

            {/* Persistent state */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full" style={{ background: AYU.green }} />
                <span className="text-sm font-bold" style={{ color: AYU.green }}>PERSISTENT (Survives Restart)</span>
              </div>
              <div className="space-y-3">
                {/* Beads in DB */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Beads in DB</span>
                    <span className="text-xs font-bold" style={{ color: AYU.green }}>{beadStats?.total ?? 0}</span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Agent identity, CV chain, work history. Fully persistent.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.green }} />
                  </div>
                </div>

                {/* Hooks in DB */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Hooks in DB</span>
                    <span className="text-xs font-bold" style={{ color: AYU.green }}>
                      {hookStats?.total ?? ((hookStats?.pending ?? 0) + (hookStats?.claimed ?? 0) + (hookStats?.completed ?? 0))}
                    </span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    GUPP work assignments. Pending hooks resume on restart.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.green }} />
                  </div>
                </div>

                {/* Molecules in DB */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Molecules in DB</span>
                    <span className="text-xs font-bold" style={{ color: AYU.green }}>{molecules.length}</span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Multi-step execution chains. Step progress preserved, convoy intact.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.green }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Ephemeral state */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="flex items-center gap-2 mb-4">
                <div className="w-2 h-2 rounded-full" style={{ background: AYU.red }} />
                <span className="text-sm font-bold" style={{ color: AYU.red }}>EPHEMERAL (Lost on Restart)</span>
              </div>
              <div className="space-y-3">
                {/* Wisps in memory */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Wisps in Memory</span>
                    <span className="text-[10px] px-2 py-0.5" style={{ background: `${AYU.red}15`, color: AYU.red, border: `1px solid ${AYU.red}30` }}>
                      VOLATILE
                    </span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Short-lived ephemeral messages. Fire-and-forget. Lost on process death.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.red, opacity: 0.6 }} />
                  </div>
                </div>

                {/* Workers in memory */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Workers in Memory</span>
                    <span className="text-[10px] px-2 py-0.5" style={{ background: `${AYU.yellow}15`, color: AYU.yellow, border: `1px solid ${AYU.yellow}30` }}>
                      RE-REGISTER
                    </span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Runtime process handles. Workers re-register on startup. Identity survives via beads.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '60%', background: AYU.yellow, opacity: 0.6 }} />
                  </div>
                </div>

                {/* Session context */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Session Context</span>
                    <span className="text-[10px] px-2 py-0.5" style={{ background: `${AYU.red}15`, color: AYU.red, border: `1px solid ${AYU.red}30` }}>
                      VOLATILE
                    </span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Active conversation state, tool calls in flight. Recoverable only via seance.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.red, opacity: 0.6 }} />
                  </div>
                </div>

                {/* Polecat swarm */}
                <div className="p-3 rounded-none" style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: AYU.text }}>Polecat Swarm State</span>
                    <span className="text-[10px] px-2 py-0.5" style={{ background: `${AYU.red}15`, color: AYU.red, border: `1px solid ${AYU.red}30` }}>
                      VOLATILE
                    </span>
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>
                    Ephemeral worker swarm. Polecats are born, do work, and die. No persistence needed.
                  </div>
                  <div className="mt-2 h-1 rounded-none" style={{ background: AYU.border }}>
                    <div className="h-full rounded-none" style={{ width: '100%', background: AYU.red, opacity: 0.4 }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* NDI guarantee footer */}
          <div
            className="mt-4 p-4 rounded-none text-center"
            style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}
          >
            <p className="text-[11px]" style={{ color: AYU.text }}>
              NDI Guarantee: Kill the process at any point. Restart. All beads, hooks, and molecules resume.
            </p>
            <p className="text-[10px] mt-1" style={{ color: AYU.muted }}>
              Only wisps and active session context are lost. Use seance to recover conversation history.
            </p>
          </div>
        </section>

      </div>
    </div>
  );
}
