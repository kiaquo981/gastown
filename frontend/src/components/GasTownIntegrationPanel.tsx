'use client';

/**
 * GasTownIntegrationPanel — Reusable Gas Town dashboard widget
 *
 * Embeds MEOW infrastructure data (beads, molecules, convoys, workers, health)
 * into any existing view. Pass `domain` to filter/contextualize data.
 *
 * Used in: MorosView, DropOpsView, AtlasView, EcommerceView, MarketView
 */

import { useState, useEffect, useCallback } from 'react';
import { ORCHESTRATOR_URL } from '@/lib/config';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BeadStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
}

interface MoleculeInfo {
  id: string;
  formulaId: string;
  phase: string;
  status: string;
  completedSteps: number;
  totalSteps: number;
  createdAt: string;
}

interface ConvoyInfo {
  id: string;
  name: string;
  status: string;
  beadIds: string[];
  progress: number;
  createdAt: string;
}

interface PolecatStats {
  total: number;
  running: number;
  idle: number;
  failed: number;
  completed: number;
}

interface HealthInfo {
  score: number;
  status: string;
  checks?: Record<string, unknown>;
}

interface FeedItem {
  id: string;
  type: string;
  source: string;
  message: string;
  severity: string;
  timestamp: string;
}

interface TownPulse {
  molecules: { total: number; active: number };
  beads: { total: number; inProgress: number };
  convoys: { total: number; dispatched: number };
  workers: { total: number; busy: number };
  health: number;
  uptime?: string;
}

interface GasTownData {
  pulse: TownPulse | null;
  beadStats: BeadStats | null;
  molecules: MoleculeInfo[];
  convoys: ConvoyInfo[];
  polecatStats: PolecatStats | null;
  health: HealthInfo | null;
  feed: FeedItem[];
}

interface Props {
  /** Domain context — filters data and labels */
  domain: 'moros' | 'dropops' | 'atlas' | 'ecommerce' | 'market';
  /** Optional: compact mode for sidebar embedding */
  compact?: boolean;
}

const DOMAIN_LABELS: Record<string, { title: string; color: string; desc: string }> = {
  moros:      { title: 'MOROS × Gas Town',      color: 'text-red-400',    desc: 'Mayor orchestration, convoys, system health' },
  dropops:    { title: 'DropOps × Gas Town',    color: 'text-cyan-400',   desc: 'Molecule pipeline, bead tracking per stage' },
  atlas:      { title: 'Atlas × Gas Town',      color: 'text-amber-400',  desc: 'Country beads, convoy dispatch, intelligence molecules' },
  ecommerce:  { title: 'Ecommerce × Gas Town',  color: 'text-emerald-400', desc: 'Product beads, supplier convoys, COD pipeline molecules' },
  market:     { title: 'Market × Gas Town',     color: 'text-violet-400', desc: 'Multi-country convoys, market beads, regional molecules' },
};

const API = typeof ORCHESTRATOR_URL === 'string' ? ORCHESTRATOR_URL : '';

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return fallback;
    return await r.json();
  } catch { return fallback; }
}

export default function GasTownIntegrationPanel({ domain, compact }: Props) {
  const [data, setData] = useState<GasTownData>({
    pulse: null, beadStats: null, molecules: [], convoys: [], polecatStats: null, health: null, feed: [],
  });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const info = DOMAIN_LABELS[domain] || DOMAIN_LABELS.moros;

  const fetchAll = useCallback(async () => {
    const [pulse, beadStats, molecules, convoys, polecatStats, health, feed] = await Promise.all([
      fetchJson<TownPulse | null>('/api/meow/town/pulse', null),
      fetchJson<BeadStats | null>('/api/beads/stats', null),
      fetchJson<MoleculeInfo[]>('/api/meow/molecules', []),
      fetchJson<ConvoyInfo[]>('/api/meow/convoys', []),
      fetchJson<PolecatStats | null>('/api/meow/polecats/stats', null),
      fetchJson<HealthInfo | null>('/api/meow/health', null),
      fetchJson<FeedItem[]>('/api/meow/feed', []),
    ]);
    setData({ pulse, beadStats, molecules, convoys, polecatStats, health, feed: Array.isArray(feed) ? feed.slice(0, 20) : [] });
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 8000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const healthScore = data.pulse?.health ?? data.health?.score ?? 0;
  const healthColor = healthScore >= 80 ? 'text-emerald-400' : healthScore >= 50 ? 'text-amber-400' : 'text-red-400';
  const healthBg = healthScore >= 80 ? 'bg-emerald-500/10' : healthScore >= 50 ? 'bg-amber-500/10' : 'bg-red-500/10';

  const moleculesArr = Array.isArray(data.molecules) ? data.molecules : [];
  const convoysArr = Array.isArray(data.convoys) ? data.convoys : [];
  const feedArr = Array.isArray(data.feed) ? data.feed : [];

  if (compact) {
    return (
      <div className="space-y-2 p-3">
        <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{info.title}</div>
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="Health" value={`${healthScore}%`} color={healthColor} />
          <MiniStat label="Beads" value={String(data.beadStats?.total ?? 0)} color="text-cyan-400" />
          <MiniStat label="Convoys" value={String(convoysArr.length)} color="text-violet-400" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0a0e17] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className={`text-sm font-mono font-bold ${info.color}`}>{info.title}</h2>
          <p className="text-[10px] font-mono text-white/30 mt-0.5">{info.desc}</p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchAll(); }}
          className="p-1.5 border border-white/10 hover:bg-white/5 transition-colors"
          title="Refresh"
        >
          <svg className={`w-3.5 h-3.5 text-white/40 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Health + Pulse KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <KpiCard label="System Health" value={`${healthScore}%`} color={healthColor} bg={healthBg} />
        <KpiCard label="Beads Total" value={String(data.beadStats?.total ?? 0)} color="text-cyan-400" bg="bg-cyan-500/10" />
        <KpiCard label="In Progress" value={String(data.beadStats?.byStatus?.in_progress ?? data.pulse?.beads?.inProgress ?? 0)} color="text-blue-400" bg="bg-blue-500/10" />
        <KpiCard label="Molecules" value={String(data.pulse?.molecules?.total ?? moleculesArr.length)} color="text-purple-400" bg="bg-purple-500/10" />
        <KpiCard label="Convoys" value={String(data.pulse?.convoys?.total ?? convoysArr.length)} color="text-violet-400" bg="bg-violet-500/10" />
        <KpiCard label="Workers" value={String(data.pulse?.workers?.total ?? data.polecatStats?.total ?? 0)} color="text-orange-400" bg="bg-orange-500/10" />
      </div>

      {/* Bead Status Breakdown */}
      {data.beadStats?.byStatus && Object.keys(data.beadStats.byStatus).length > 0 && (
        <Section title="Bead Status" expanded={expanded === 'beads'} toggle={() => setExpanded(expanded === 'beads' ? null : 'beads')}>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {Object.entries(data.beadStats.byStatus).map(([status, count]) => (
              <div key={status} className="border border-white/5 bg-white/[0.02] p-2">
                <div className="text-[9px] font-mono text-white/30 uppercase">{status.replace(/_/g, ' ')}</div>
                <div className="text-sm font-mono font-bold text-white/80">{count}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Active Molecules */}
      <Section title={`Molecules (${moleculesArr.length})`} expanded={expanded === 'mol'} toggle={() => setExpanded(expanded === 'mol' ? null : 'mol')}>
        {moleculesArr.length === 0 ? (
          <div className="text-[10px] font-mono text-white/20 py-4 text-center">No active molecules</div>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {moleculesArr.slice(0, 15).map(m => (
              <div key={m.id} className="flex items-center justify-between border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-mono text-white/60 truncate">{m.formulaId || m.id}</div>
                  <div className="text-[9px] font-mono text-white/30">{m.phase} · {m.status}</div>
                </div>
                <div className="flex items-center gap-2">
                  <ProgressBar completed={m.completedSteps ?? 0} total={m.totalSteps ?? 1} />
                  <span className="text-[9px] font-mono text-white/40 w-10 text-right">{m.completedSteps ?? 0}/{m.totalSteps ?? 0}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Convoys */}
      <Section title={`Convoys (${convoysArr.length})`} expanded={expanded === 'conv'} toggle={() => setExpanded(expanded === 'conv' ? null : 'conv')}>
        {convoysArr.length === 0 ? (
          <div className="text-[10px] font-mono text-white/20 py-4 text-center">No active convoys</div>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {convoysArr.slice(0, 15).map(c => (
              <div key={c.id} className="flex items-center justify-between border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-mono text-white/60 truncate">{c.name || c.id}</div>
                  <div className="text-[9px] font-mono text-white/30">{c.status} · {c.beadIds?.length ?? 0} beads</div>
                </div>
                <div className="flex items-center gap-2">
                  <ProgressBar completed={c.progress ?? 0} total={100} />
                  <span className="text-[9px] font-mono text-white/40 w-8 text-right">{c.progress ?? 0}%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Worker Pool */}
      {data.polecatStats && (
        <Section title="Worker Pool (Polecats)" expanded={expanded === 'workers'} toggle={() => setExpanded(expanded === 'workers' ? null : 'workers')}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <WorkerStat label="Total" value={data.polecatStats.total} color="text-white/60" />
            <WorkerStat label="Running" value={data.polecatStats.running} color="text-emerald-400" />
            <WorkerStat label="Idle" value={data.polecatStats.idle} color="text-white/30" />
            <WorkerStat label="Completed" value={data.polecatStats.completed} color="text-cyan-400" />
            <WorkerStat label="Failed" value={data.polecatStats.failed} color="text-red-400" />
          </div>
        </Section>
      )}

      {/* Live Feed */}
      <Section title="Activity Feed" expanded={expanded === 'feed'} toggle={() => setExpanded(expanded === 'feed' ? null : 'feed')}>
        {feedArr.length === 0 ? (
          <div className="text-[10px] font-mono text-white/20 py-4 text-center">No recent activity</div>
        ) : (
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {feedArr.map(f => (
              <div key={f.id} className="flex items-start gap-2 border-b border-white/[0.03] py-1.5">
                <span className={`text-[8px] mt-0.5 ${f.severity === 'warning' ? 'text-amber-400' : f.severity === 'error' ? 'text-red-400' : 'text-white/20'}`}>
                  {f.severity === 'warning' ? '⚠' : f.severity === 'error' ? '✕' : '●'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-mono text-white/50 truncate">{f.message}</div>
                  <div className="text-[8px] font-mono text-white/20">{f.source} · {formatTime(f.timestamp)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Quick Actions */}
      <div className="border border-white/5 bg-white/[0.02] p-3">
        <div className="text-[9px] font-mono text-white/30 uppercase tracking-widest mb-2">Quick Actions</div>
        <div className="flex flex-wrap gap-2">
          <ActionBtn label="Create Bead" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'beads' } }))} />
          <ActionBtn label="View Molecules" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'molecules' } }))} />
          <ActionBtn label="Convoy Tracker" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'convoy-tracker' } }))} />
          <ActionBtn label="Gas Town HQ" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'gastown-hq' } }))} />
          <ActionBtn label="Worker Pool" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'worker-pool' } }))} />
          <ActionBtn label="Observability" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { view: 'observability-tower' } }))} />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({ label, value, color, bg }: { label: string; value: string; color: string; bg: string }) {
  return (
    <div className={`border border-white/5 ${bg} p-2.5`}>
      <div className="text-[8px] font-mono text-white/30 uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="border border-white/5 bg-white/[0.02] p-1.5 text-center">
      <div className="text-[7px] font-mono text-white/25 uppercase">{label}</div>
      <div className={`text-xs font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}

function WorkerStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="border border-white/5 bg-white/[0.02] p-2 text-center">
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
      <div className="text-[8px] font-mono text-white/30 uppercase">{label}</div>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  return (
    <div className="w-16 h-1.5 bg-white/5 overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-cyan-500/60 to-violet-500/60 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Section({ title, expanded, toggle, children }: { title: string; expanded: boolean; toggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border border-white/5 bg-white/[0.01]">
      <button onClick={toggle} className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors">
        <span className="text-[10px] font-mono text-white/50 uppercase tracking-widest">{title}</span>
        <span className="text-[10px] font-mono text-white/20">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 border border-white/10 hover:bg-white/5 text-[10px] font-mono text-white/50 hover:text-white/80 transition-all"
    >
      {label}
    </button>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  } catch { return ts; }
}
