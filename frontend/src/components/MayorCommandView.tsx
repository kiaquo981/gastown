'use client';

/**
 * MayorCommandView — GT-007 Mayor Command Center
 *
 * Central orchestrator dashboard showing convoy queue, decision log,
 * and resource allocation in real-time.
 *
 * API: GET /api/meow/mayor/status, GET /api/meow/workers/overview
 * SSE: meow:dispatch channel for live convoy dispatches
 * VOID AESTHETIC: bg-[#0a0e27], border-white/5, text-white/[0.87], font-mono, rounded-none
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type MayorState = 'active' | 'idle' | 'overloaded';
type ConvoyStatus = 'queued' | 'dispatching' | 'running' | 'done' | 'failed';

interface ConvoyBead {
  id: string;
  name: string;
  skill: string;
  status: string;
}

interface ConvoyLeg {
  index: number;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  worker?: string;
}

interface Convoy {
  id: string;
  beadsCount: number;
  beads: ConvoyBead[];
  legs: ConvoyLeg[];
  status: ConvoyStatus;
  assignedRig?: string;
  synthesis?: string;
  createdAt: string;
  updatedAt: string;
}

interface DecisionEntry {
  id: string;
  timestamp: string;
  action: 'dispatch' | 'escalate' | 'handoff' | 'allocate' | 'throttle' | 'recover';
  description: string;
  outcome: string;
  convoyId?: string;
}

interface WorkerRole {
  role: string;
  total: number;
  active: number;
  utilization: number;
}

interface MayorStatus {
  state: MayorState;
  activeConvoys: number;
  queuedConvoys: number;
  totalDispatched: number;
  avgDispatchTime: number;
  uptime: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5000;
const MAX_DECISIONS = 200;

const CONVOY_STATUS_STYLES: Record<ConvoyStatus, string> = {
  queued:       'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20',
  dispatching:  'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  running:      'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',
  done:         'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  failed:       'bg-red-500/10 text-red-400 border border-red-500/20',
};

const MAYOR_STATE_STYLES: Record<MayorState, { dot: string; label: string; cls: string }> = {
  active:     { dot: 'bg-emerald-400', label: 'ACTIVE',     cls: 'text-emerald-400' },
  idle:       { dot: 'bg-zinc-500',    label: 'IDLE',       cls: 'text-zinc-400' },
  overloaded: { dot: 'bg-red-400',     label: 'OVERLOADED', cls: 'text-red-400' },
};

const ACTION_ICONS: Record<string, string> = {
  dispatch: '\u{1F69B}',
  escalate: '\u{26A0}',
  handoff:  '\u{1F91D}',
  allocate: '\u{1F4CA}',
  throttle: '\u{23F8}',
  recover:  '\u{1F504}',
};

const LEG_STATUS_COLOR: Record<string, string> = {
  pending: 'bg-zinc-500/30',
  running: 'bg-amber-400/60 animate-pulse',
  done:    'bg-emerald-400/60',
  failed:  'bg-red-400/60',
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ─── Fallback Data ──────────────────────────────────────────────────────────────

const FALLBACK_STATUS: MayorStatus = {
  state: 'idle',
  activeConvoys: 0,
  queuedConvoys: 0,
  totalDispatched: 0,
  avgDispatchTime: 0,
  uptime: '0s',
};

const FALLBACK_CONVOYS: Convoy[] = [
  {
    id: 'cv-001', beadsCount: 4, status: 'running', assignedRig: 'rig-alpha',
    beads: [
      { id: 'b-1', name: 'parse-schema', skill: 'typescript', status: 'done' },
      { id: 'b-2', name: 'gen-types', skill: 'codegen', status: 'running' },
      { id: 'b-3', name: 'write-tests', skill: 'testing', status: 'pending' },
      { id: 'b-4', name: 'lint-check', skill: 'lint', status: 'pending' },
    ],
    legs: [
      { index: 0, label: 'Parse', status: 'done', worker: 'polecat-03' },
      { index: 1, label: 'Generate', status: 'running', worker: 'polecat-07' },
      { index: 2, label: 'Test', status: 'pending' },
      { index: 3, label: 'Lint', status: 'pending' },
    ],
    synthesis: 'Generating type definitions from schema...',
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cv-002', beadsCount: 2, status: 'queued',
    beads: [
      { id: 'b-5', name: 'fetch-data', skill: 'http', status: 'pending' },
      { id: 'b-6', name: 'transform', skill: 'etl', status: 'pending' },
    ],
    legs: [
      { index: 0, label: 'Fetch', status: 'pending' },
      { index: 1, label: 'Transform', status: 'pending' },
    ],
    createdAt: new Date(Date.now() - 30000).toISOString(),
    updatedAt: new Date(Date.now() - 30000).toISOString(),
  },
  {
    id: 'cv-003', beadsCount: 3, status: 'done', assignedRig: 'rig-beta',
    beads: [
      { id: 'b-7', name: 'audit-deps', skill: 'security', status: 'done' },
      { id: 'b-8', name: 'patch-vulns', skill: 'security', status: 'done' },
      { id: 'b-9', name: 'verify-fix', skill: 'testing', status: 'done' },
    ],
    legs: [
      { index: 0, label: 'Audit', status: 'done', worker: 'polecat-01' },
      { index: 1, label: 'Patch', status: 'done', worker: 'polecat-02' },
      { index: 2, label: 'Verify', status: 'done', worker: 'polecat-05' },
    ],
    synthesis: 'All vulnerabilities patched. 3/3 checks passed.',
    createdAt: new Date(Date.now() - 600000).toISOString(),
    updatedAt: new Date(Date.now() - 60000).toISOString(),
  },
  {
    id: 'cv-004', beadsCount: 1, status: 'dispatching',
    beads: [
      { id: 'b-10', name: 'deploy-staging', skill: 'deploy', status: 'pending' },
    ],
    legs: [
      { index: 0, label: 'Deploy', status: 'pending' },
    ],
    createdAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'cv-005', beadsCount: 2, status: 'failed', assignedRig: 'rig-gamma',
    beads: [
      { id: 'b-11', name: 'build-image', skill: 'docker', status: 'done' },
      { id: 'b-12', name: 'push-registry', skill: 'docker', status: 'failed' },
    ],
    legs: [
      { index: 0, label: 'Build', status: 'done', worker: 'polecat-09' },
      { index: 1, label: 'Push', status: 'failed', worker: 'polecat-09' },
    ],
    synthesis: 'Registry auth expired. Retry after token refresh.',
    createdAt: new Date(Date.now() - 300000).toISOString(),
    updatedAt: new Date(Date.now() - 180000).toISOString(),
  },
];

const FALLBACK_DECISIONS: DecisionEntry[] = [
  { id: 'd-1', timestamp: new Date(Date.now() - 90000).toISOString(), action: 'dispatch', description: 'Dispatched convoy cv-001 to rig-alpha', outcome: 'success', convoyId: 'cv-001' },
  { id: 'd-2', timestamp: new Date(Date.now() - 60000).toISOString(), action: 'allocate', description: 'Allocated 2 polecats to codegen pool', outcome: 'success' },
  { id: 'd-3', timestamp: new Date(Date.now() - 45000).toISOString(), action: 'escalate', description: 'Convoy cv-005 push failed — escalating to Witness', outcome: 'pending', convoyId: 'cv-005' },
  { id: 'd-4', timestamp: new Date(Date.now() - 20000).toISOString(), action: 'throttle', description: 'Queue depth > 10 — throttling new convoy intake', outcome: 'applied' },
  { id: 'd-5', timestamp: new Date(Date.now() - 5000).toISOString(), action: 'dispatch', description: 'Dispatching convoy cv-004 to available rig', outcome: 'in-progress', convoyId: 'cv-004' },
];

const FALLBACK_WORKERS: WorkerRole[] = [
  { role: 'Polecat', total: 12, active: 8, utilization: 67 },
  { role: 'Witness', total: 2, active: 1, utilization: 50 },
  { role: 'Mayor', total: 1, active: 1, utilization: 100 },
  { role: 'Refinery', total: 3, active: 2, utilization: 67 },
  { role: 'Mailman', total: 2, active: 1, utilization: 50 },
];

// ─── Sub-components ─────────────────────────────────────────────────────────────

function ConvoyStatusBadge({ status }: { status: ConvoyStatus }) {
  return (
    <span className={`px-2 py-0.5 font-mono text-[10px] uppercase ${CONVOY_STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

function LegProgress({ legs }: { legs: ConvoyLeg[] }) {
  return (
    <div className="flex gap-1 items-center">
      {legs.map((leg) => (
        <div
          key={leg.index}
          className={`h-1.5 flex-1 ${LEG_STATUS_COLOR[leg.status] || 'bg-zinc-700'}`}
          title={`${leg.label}: ${leg.status}${leg.worker ? ` (${leg.worker})` : ''}`}
        />
      ))}
    </div>
  );
}

function UtilizationBar({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-red-400' : value >= 70 ? 'bg-amber-400' : 'bg-cyan-400';
  return (
    <div className="w-full h-1.5 bg-white/5">
      <motion.div
        className={`h-full ${color}`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(value, 100)}%` }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
    </div>
  );
}

// ─── Create Convoy Modal ────────────────────────────────────────────────────────

function CreateConvoyModal({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (data: { beads: string; rig?: string }) => void;
}) {
  const [beads, setBeads] = useState('');
  const [rig, setRig] = useState('');

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="w-[480px] bg-[#0d1117] border border-white/10 p-6"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-mono text-sm uppercase tracking-widest text-white/[0.87] mb-4">
          Create Convoy
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block font-mono text-[10px] uppercase text-white/40 mb-1">
              Beads (comma-separated skill names)
            </label>
            <input
              value={beads}
              onChange={(e) => setBeads(e.target.value)}
              placeholder="parse-schema, gen-types, write-tests"
              className="w-full bg-[#0a0e27] border border-white/10 px-3 py-2 font-mono text-xs text-white/[0.87] placeholder:text-white/20 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="block font-mono text-[10px] uppercase text-white/40 mb-1">
              Assigned Rig (optional)
            </label>
            <input
              value={rig}
              onChange={(e) => setRig(e.target.value)}
              placeholder="rig-alpha"
              className="w-full bg-[#0a0e27] border border-white/10 px-3 py-2 font-mono text-xs text-white/[0.87] placeholder:text-white/20 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 font-mono text-[10px] uppercase text-white/40 border border-white/10 hover:border-white/20 hover:text-white/60 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (beads.trim()) onSubmit({ beads: beads.trim(), rig: rig.trim() || undefined });
              }}
              disabled={!beads.trim()}
              className="px-4 py-2 font-mono text-[10px] uppercase bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Create
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function MayorCommandView() {
  const [status, setStatus] = useState<MayorStatus>(FALLBACK_STATUS);
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [workers, setWorkers] = useState<WorkerRole[]>([]);
  const [expandedConvoy, setExpandedConvoy] = useState<string | null>(null);
  const [pinDecisions, setPinDecisions] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forcingDispatch, setForcingDispatch] = useState(false);

  const decisionsEndRef = useRef<HTMLDivElement>(null);
  const decisionsRef = useRef<DecisionEntry[]>([]);

  // Keep ref in sync
  useEffect(() => { decisionsRef.current = decisions; }, [decisions]);

  // Auto-scroll decisions
  useEffect(() => {
    if (pinDecisions && decisionsEndRef.current) {
      decisionsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [decisions, pinDecisions]);

  // ─── Fetch Status + Convoys ───────────────────────────────────────────────

  const fetchData = useCallback(async (controller: AbortController) => {
    try {
      const [statusRes, workersRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/mayor/status`, { signal: controller.signal }),
        fetch(`${API}/api/meow/workers/overview`, { signal: controller.signal }),
      ]);

      if (statusRes.status === 'fulfilled' && statusRes.value.ok) {
        const data = await statusRes.value.json();
        if (data.status) setStatus(data.status);
        else if (data.state) setStatus(data as MayorStatus);
        if (data.convoys) setConvoys(data.convoys);
        if (data.decisions) {
          setDecisions((prev) => {
            const ids = new Set(prev.map((d) => d.id));
            const fresh = (data.decisions as DecisionEntry[]).filter((d) => !ids.has(d.id));
            const merged = [...prev, ...fresh];
            return merged.length > MAX_DECISIONS ? merged.slice(merged.length - MAX_DECISIONS) : merged;
          });
        }
      } else {
        // Use fallback
        setConvoys(FALLBACK_CONVOYS);
        setDecisions((prev) => prev.length === 0 ? FALLBACK_DECISIONS : prev);
        setStatus((prev) => prev === FALLBACK_STATUS ? { ...FALLBACK_STATUS, state: 'active', activeConvoys: 2, queuedConvoys: 2, totalDispatched: 14, avgDispatchTime: 3200, uptime: '4h 12m' } : prev);
      }

      if (workersRes.status === 'fulfilled' && workersRes.value.ok) {
        const wData = await workersRes.value.json();
        if (wData.roles) setWorkers(wData.roles);
        else if (Array.isArray(wData.workers)) setWorkers(wData.workers);
      } else {
        setWorkers((prev) => prev.length === 0 ? FALLBACK_WORKERS : prev);
      }

      setLoading(false);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setConvoys((prev) => prev.length === 0 ? FALLBACK_CONVOYS : prev);
        setDecisions((prev) => prev.length === 0 ? FALLBACK_DECISIONS : prev);
        setWorkers((prev) => prev.length === 0 ? FALLBACK_WORKERS : prev);
        setLoading(false);
      }
    }
  }, []);

  // ─── Polling ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller);
    const iv = setInterval(() => {
      if (!controller.signal.aborted) fetchData(controller);
    }, POLL_INTERVAL);
    return () => {
      controller.abort();
      clearInterval(iv);
    };
  }, [fetchData]);

  // ─── SSE: meow:dispatch ───────────────────────────────────────────────────

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API}/api/events`);
      es.onopen = () => setSseConnected(true);
      es.onerror = () => setSseConnected(false);

      es.addEventListener('meow:dispatch', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);

          // Update convoy if present
          if (data.convoy) {
            setConvoys((prev) => {
              const idx = prev.findIndex((c) => c.id === data.convoy.id);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...data.convoy };
                return updated;
              }
              return [data.convoy, ...prev];
            });
          }

          // Append decision if present
          if (data.decision) {
            const entry: DecisionEntry = {
              id: data.decision.id || `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: data.decision.timestamp || new Date().toISOString(),
              action: data.decision.action || 'dispatch',
              description: data.decision.description || '',
              outcome: data.decision.outcome || '',
              convoyId: data.decision.convoyId,
            };
            setDecisions((prev) => {
              const merged = [...prev, entry];
              return merged.length > MAX_DECISIONS ? merged.slice(merged.length - MAX_DECISIONS) : merged;
            });
          }
        } catch { /* ignore malformed SSE */ }
      });
    } catch {
      setSseConnected(false);
    }
    return () => { es?.close(); };
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleCreateConvoy = useCallback(async (data: { beads: string; rig?: string }) => {
    try {
      await fetch(`${API}/api/meow/mayor/convoy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beads: data.beads.split(',').map((b) => b.trim()).filter(Boolean),
          rig: data.rig,
        }),
      });
      setShowCreateModal(false);
      // Refresh immediately
      const c = new AbortController();
      fetchData(c);
    } catch { /* silent */ }
  }, [fetchData]);

  const handleForceDispatch = useCallback(async () => {
    setForcingDispatch(true);
    try {
      await fetch(`${API}/api/meow/mayor/force-dispatch`, { method: 'POST' });
      const c = new AbortController();
      fetchData(c);
    } catch { /* silent */ }
    setTimeout(() => setForcingDispatch(false), 2000);
  }, [fetchData]);

  // ─── Derived ──────────────────────────────────────────────────────────────

  const totalCapacity = useMemo(() => workers.reduce((s, w) => s + w.total, 0), [workers]);
  const usedCapacity = useMemo(() => workers.reduce((s, w) => s + w.active, 0), [workers]);
  const queuedCapacity = useMemo(
    () => convoys.filter((c) => c.status === 'queued').reduce((s, c) => s + c.beadsCount, 0),
    [convoys],
  );

  const stateStyle = MAYOR_STATE_STYLES[status.state] || MAYOR_STATE_STYLES.idle;

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0a0e27]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
            Connecting to Mayor...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#0a0e27] text-white/[0.87]">
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm uppercase tracking-widest text-white/60">
            Mayor Command Center
          </h1>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 ${stateStyle.dot} ${status.state === 'active' ? 'animate-pulse' : ''}`} />
            <span className={`font-mono text-[10px] uppercase ${stateStyle.cls}`}>
              {stateStyle.label}
            </span>
          </div>
          <span className="font-mono text-[10px] text-white/20">|</span>
          <span className="font-mono text-[10px] text-white/30">
            UP {status.uptime}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {sseConnected && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-400">
              <span className="w-1.5 h-1.5 bg-emerald-400 animate-pulse" />
              SSE
            </span>
          )}
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-3 py-1.5 font-mono text-[10px] uppercase bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors"
          >
            + Create Convoy
          </button>
          <button
            onClick={handleForceDispatch}
            disabled={forcingDispatch}
            className="px-3 py-1.5 font-mono text-[10px] uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-40"
          >
            {forcingDispatch ? 'Dispatching...' : 'Force Dispatch'}
          </button>
        </div>
      </div>

      {/* ─── KPI Strip ───────────────────────────────────────────────────── */}
      <div className="flex gap-6 px-6 py-3 border-b border-white/5">
        {[
          { label: 'Active', value: status.activeConvoys, cls: 'text-cyan-400' },
          { label: 'Queued', value: status.queuedConvoys, cls: 'text-amber-400' },
          { label: 'Dispatched', value: status.totalDispatched, cls: 'text-emerald-400' },
          { label: 'Avg Dispatch', value: formatDuration(status.avgDispatchTime), cls: 'text-white/60' },
        ].map((kpi) => (
          <div key={kpi.label} className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase text-white/30">{kpi.label}</span>
            <span className={`font-mono text-xs font-medium ${kpi.cls}`}>{kpi.value}</span>
          </div>
        ))}
      </div>

      {/* ─── Main Content ────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ─── Left Column: Convoy Queue (60%) ─────────────────────────── */}
        <div className="w-[60%] flex flex-col border-r border-white/5 overflow-hidden">
          <div className="px-4 py-2 border-b border-white/5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
              Convoy Queue ({convoys.length})
            </span>
          </div>

          <div className="flex-1 overflow-auto">
            {convoys.length === 0 && (
              <div className="text-center py-12 font-mono text-xs text-white/20">
                No convoys in queue
              </div>
            )}

            <AnimatePresence initial={false}>
              {convoys.map((convoy) => {
                const isExpanded = expandedConvoy === convoy.id;
                return (
                  <motion.div
                    key={convoy.id}
                    layout
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="border-b border-white/5"
                  >
                    {/* Convoy Row */}
                    <button
                      onClick={() => setExpandedConvoy(isExpanded ? null : convoy.id)}
                      className="w-full flex items-center gap-4 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      <motion.span
                        animate={{ rotate: isExpanded ? 90 : 0 }}
                        className="text-white/20 font-mono text-xs"
                      >
                        {'\u25B6'}
                      </motion.span>

                      <span className="font-mono text-xs text-white/40 w-[72px] shrink-0">
                        {convoy.id}
                      </span>

                      <span className="font-mono text-[10px] text-white/30 w-[60px] shrink-0">
                        {convoy.beadsCount} beads
                      </span>

                      <div className="w-[100px] shrink-0">
                        <LegProgress legs={convoy.legs} />
                      </div>

                      <span className="font-mono text-[10px] text-white/30 w-[60px] shrink-0">
                        {convoy.legs.length} legs
                      </span>

                      <ConvoyStatusBadge status={convoy.status} />

                      {convoy.assignedRig && (
                        <span className="font-mono text-[10px] text-violet-400/60 ml-auto">
                          {convoy.assignedRig}
                        </span>
                      )}
                    </button>

                    {/* Expanded Detail */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 pl-10 space-y-3">
                            {/* Beads */}
                            <div>
                              <span className="font-mono text-[10px] uppercase text-white/20 block mb-1">
                                Beads
                              </span>
                              <div className="flex flex-wrap gap-2">
                                {convoy.beads.map((bead) => (
                                  <span
                                    key={bead.id}
                                    className="px-2 py-1 font-mono text-[10px] bg-[#0a0e27] border border-white/5"
                                  >
                                    <span className="text-white/40">{bead.id}</span>
                                    <span className="text-white/10 mx-1">|</span>
                                    <span className="text-white/60">{bead.name}</span>
                                    <span className="text-white/10 mx-1">|</span>
                                    <span className="text-cyan-400/60">{bead.skill}</span>
                                    <span className="text-white/10 mx-1">|</span>
                                    <span className={
                                      bead.status === 'done' ? 'text-emerald-400' :
                                      bead.status === 'running' ? 'text-amber-400' :
                                      bead.status === 'failed' ? 'text-red-400' :
                                      'text-zinc-500'
                                    }>{bead.status}</span>
                                  </span>
                                ))}
                              </div>
                            </div>

                            {/* Legs Progress */}
                            <div>
                              <span className="font-mono text-[10px] uppercase text-white/20 block mb-1">
                                Legs Progress
                              </span>
                              <div className="flex gap-2">
                                {convoy.legs.map((leg) => (
                                  <div
                                    key={leg.index}
                                    className="flex-1 bg-[#0a0e27] border border-white/5 p-2"
                                  >
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="font-mono text-[10px] text-white/60">{leg.label}</span>
                                      <span className={`w-2 h-2 ${LEG_STATUS_COLOR[leg.status]}`} />
                                    </div>
                                    <div className="font-mono text-[10px] text-white/20">
                                      {leg.worker || 'unassigned'}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Synthesis */}
                            {convoy.synthesis && (
                              <div>
                                <span className="font-mono text-[10px] uppercase text-white/20 block mb-1">
                                  Synthesis
                                </span>
                                <div className="font-mono text-[11px] text-white/40 bg-[#0a0e27] border border-white/5 p-2">
                                  {convoy.synthesis}
                                </div>
                              </div>
                            )}

                            {/* Timestamps */}
                            <div className="flex gap-4 font-mono text-[10px] text-white/20">
                              <span>Created: {formatTime(convoy.createdAt)}</span>
                              <span>Updated: {formatTime(convoy.updatedAt)}</span>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {/* ─── Right Column: Decision Log (40%) ────────────────────────── */}
        <div className="w-[40%] flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
              Decision Log ({decisions.length})
            </span>
            <button
              onClick={() => setPinDecisions(!pinDecisions)}
              className={`font-mono text-[10px] px-2 py-0.5 border ${
                pinDecisions
                  ? 'border-cyan-500/20 text-cyan-400 bg-cyan-500/5'
                  : 'border-white/10 text-white/30 hover:text-white/50'
              } transition-colors`}
            >
              {pinDecisions ? 'AUTO-SCROLL ON' : 'AUTO-SCROLL OFF'}
            </button>
          </div>

          <div className="flex-1 overflow-auto px-4 py-2" onWheel={() => { if (pinDecisions) setPinDecisions(false); }}>
            {decisions.length === 0 && (
              <div className="text-center py-12 font-mono text-xs text-white/20">
                No decisions recorded
              </div>
            )}

            <AnimatePresence initial={false}>
              {decisions.map((dec) => (
                <motion.div
                  key={dec.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex gap-3 py-2 border-b border-white/[0.03]"
                >
                  <span className="font-mono text-[10px] text-white/20 shrink-0 w-[60px] pt-0.5">
                    {formatTime(dec.timestamp)}
                  </span>

                  <span className="text-sm shrink-0 w-5 text-center" title={dec.action}>
                    {ACTION_ICONS[dec.action] || '\u{2022}'}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[11px] text-white/60 leading-relaxed">
                      {dec.description}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`font-mono text-[10px] ${
                        dec.outcome === 'success' ? 'text-emerald-400' :
                        dec.outcome === 'pending' ? 'text-amber-400' :
                        dec.outcome === 'failed' ? 'text-red-400' :
                        'text-white/30'
                      }`}>
                        {dec.outcome}
                      </span>
                      {dec.convoyId && (
                        <span className="font-mono text-[10px] text-violet-400/40">
                          {dec.convoyId}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            <div ref={decisionsEndRef} />
          </div>
        </div>
      </div>

      {/* ─── Bottom Bar: Resource Allocation ─────────────────────────────── */}
      <div className="border-t border-white/5 px-6 py-3">
        <div className="flex items-center gap-6">
          {/* Worker roles */}
          <div className="flex-1 flex gap-4">
            {workers.map((w) => (
              <div key={w.role} className="flex-1 min-w-[120px]">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-[10px] uppercase text-white/30">{w.role}</span>
                  <span className="font-mono text-[10px] text-white/50">
                    {w.active}/{w.total}
                    <span className="text-white/20 ml-1">({w.utilization}%)</span>
                  </span>
                </div>
                <UtilizationBar value={w.utilization} />
              </div>
            ))}
          </div>

          {/* Capacity gauge */}
          <div className="shrink-0 flex items-center gap-4 pl-4 border-l border-white/5">
            <div className="text-center">
              <div className="font-mono text-[10px] uppercase text-white/20 mb-0.5">Total</div>
              <div className="font-mono text-sm text-white/60">{totalCapacity}</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[10px] uppercase text-white/20 mb-0.5">Used</div>
              <div className="font-mono text-sm text-cyan-400">{usedCapacity}</div>
            </div>
            <div className="text-center">
              <div className="font-mono text-[10px] uppercase text-white/20 mb-0.5">Queued</div>
              <div className="font-mono text-sm text-amber-400">{queuedCapacity}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Create Convoy Modal ─────────────────────────────────────────── */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateConvoyModal
            onClose={() => setShowCreateModal(false)}
            onSubmit={handleCreateConvoy}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
