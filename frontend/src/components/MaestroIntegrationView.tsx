'use client';

/**
 * MaestroIntegrationView -- Maestro Integration Panel
 *
 * Shows RunMaestro CLI instances connected to Gas Town, their heartbeat
 * status, dispatch history, and controls for registration/dispatch.
 *
 * Ayu Dark palette:
 *   bg: #0f1419, cards: #1a1f26, text: #e6e1cf, muted: #6c7680
 *   border: #2d363f, green: #c2d94c, yellow: #ffb454, red: #f07178
 *   cyan: #95e6cb, purple: #d2a6ff
 *
 * APIs:
 *   GET    {API}/api/meow/town/maestro/list
 *   GET    {API}/api/meow/town/maestro/stats
 *   POST   {API}/api/meow/town/maestro/register
 *   POST   {API}/api/meow/town/maestro/heartbeat
 *   POST   {API}/api/meow/town/maestro/dispatch
 *   POST   {API}/api/meow/town/maestro/report
 *   DELETE {API}/api/meow/town/maestro/{id}
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type MaestroStatus = 'alive' | 'stale' | 'dead';
type DispatchStatus = 'dispatched' | 'running' | 'completed' | 'failed';

interface MaestroInstance {
  id: string;
  hostname: string;
  status: MaestroStatus;
  capabilities: string[];
  lastHeartbeat: string | null;
  registeredAt: string;
  dispatches?: number;
}

interface MaestroStats {
  totalRegistered: number;
  alive: number;
  stale: number;
  dead: number;
  totalDispatches: number;
  successRate: number;
  avgResponseTime: string;
}

interface DispatchRecord {
  id: string;
  maestroId: string;
  beadId: string;
  skill: string;
  status: DispatchStatus;
  dispatchedAt: string;
  completedAt: string | null;
  duration: string | null;
  output: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 6000;

const KNOWN_CAPABILITIES = [
  'code-gen', 'code-review', 'refactor', 'test-gen', 'docs-gen',
  'deploy', 'ci-cd', 'lint', 'security-scan', 'migrate',
  'shell-exec', 'git-ops', 'file-ops', 'search', 'analyze',
];

const STATUS_STYLES: Record<MaestroStatus, { dot: string; glow: string; label: string }> = {
  alive: { dot: 'bg-[#c2d94c]', glow: 'shadow-[0_0_8px_rgba(194,217,76,0.4)]', label: 'Alive' },
  stale: { dot: 'bg-[#ffb454]', glow: 'shadow-[0_0_8px_rgba(255,180,84,0.3)]', label: 'Stale' },
  dead:  { dot: 'bg-[#f07178]', glow: 'shadow-[0_0_8px_rgba(240,113,120,0.3)]', label: 'Dead' },
};

const DISPATCH_STATUS_STYLES: Record<DispatchStatus, { text: string; bg: string }> = {
  dispatched: { text: 'text-[#d2a6ff]', bg: 'bg-[#d2a6ff]/10' },
  running:    { text: 'text-[#ffb454]', bg: 'bg-[#ffb454]/10' },
  completed:  { text: 'text-[#c2d94c]', bg: 'bg-[#c2d94c]/10' },
  failed:     { text: 'text-[#f07178]', bg: 'bg-[#f07178]/10' },
};

const FALLBACK_STATS: MaestroStats = {
  totalRegistered: 0, alive: 0, stale: 0, dead: 0,
  totalDispatches: 0, successRate: 0, avgResponseTime: '--',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTs(ts: string | null): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch { return '--'; }
}

function heartbeatAge(ts: string | null): { label: string; color: string } {
  if (!ts) return { label: 'never', color: 'text-[#f07178]' };
  const ms = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 30) return { label: `${secs}s ago`, color: 'text-[#c2d94c]' };
  if (secs < 120) return { label: `${secs}s ago`, color: 'text-[#ffb454]' };
  const mins = Math.floor(secs / 60);
  return { label: `${mins}m ago`, color: 'text-[#f07178]' };
}

function truncate(s: string | null, len: number): string {
  if (!s) return '--';
  return s.length > len ? s.slice(0, len) + '...' : s;
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4 font-mono">
      <div className="text-[#6c7680] text-xs uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold ${accent || 'text-[#e6e1cf]'}`}>{value}</div>
    </div>
  );
}

function PulsingDot({ status }: { status: MaestroStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className="relative flex h-3 w-3">
      {status === 'alive' && (
        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${s.dot} opacity-50`} />
      )}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${s.dot} ${s.glow}`} />
    </span>
  );
}

function CapBadge({ cap }: { cap: string }) {
  return (
    <span className="inline-block bg-[#95e6cb]/10 text-[#95e6cb] text-[10px] font-mono px-1.5 py-0.5 rounded-none border border-[#95e6cb]/20 mr-1 mb-1">
      {cap}
    </span>
  );
}

// ─── Heartbeat Timeline ─────────────────────────────────────────────────────────

function HeartbeatTimeline({ maestros }: { maestros: MaestroInstance[] }) {
  const slots = 20;
  const slotWidth = 100 / slots;

  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4">
      <h3 className="text-[#e6e1cf] font-mono text-sm font-semibold mb-4 flex items-center gap-2">
        <span className="text-[#d2a6ff]">&#9829;</span> Heartbeat Monitor
      </h3>
      {maestros.length === 0 ? (
        <div className="text-[#6c7680] font-mono text-xs text-center py-6">No maestros registered</div>
      ) : (
        <div className="space-y-2">
          {maestros.map((m) => {
            const age = m.lastHeartbeat ? (Date.now() - new Date(m.lastHeartbeat).getTime()) / 1000 : Infinity;
            return (
              <div key={m.id} className="flex items-center gap-3">
                <div className="w-28 text-[#6c7680] font-mono text-[10px] truncate" title={m.id}>{m.id}</div>
                <div className="flex-1 flex items-center bg-[#0f1419] border border-[#2d363f] rounded-none h-5 overflow-hidden">
                  {Array.from({ length: slots }).map((_, i) => {
                    const slotAge = i * 6;
                    let dotColor = 'bg-[#2d363f]';
                    if (age < Infinity) {
                      if (slotAge <= 30 && age < 30) dotColor = 'bg-[#c2d94c]';
                      else if (slotAge <= 120 && age < 120) dotColor = 'bg-[#ffb454]';
                      else if (slotAge > 120 && age >= 120) dotColor = 'bg-[#f07178]/40';
                      else if (i === 0) {
                        dotColor = age < 30 ? 'bg-[#c2d94c]' : age < 120 ? 'bg-[#ffb454]' : 'bg-[#f07178]';
                      }
                    }
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-center"
                        style={{ width: `${slotWidth}%` }}
                      >
                        <div className={`w-2 h-2 rounded-full ${dotColor}`} />
                      </div>
                    );
                  })}
                </div>
                <PulsingDot status={m.status as MaestroStatus} />
              </div>
            );
          })}
          <div className="flex items-center gap-3 mt-1">
            <div className="w-28" />
            <div className="flex-1 flex justify-between text-[10px] text-[#6c7680] font-mono px-1">
              <span>now</span>
              <span>30s</span>
              <span>1m</span>
              <span>2m</span>
            </div>
            <div className="w-3" />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function MaestroIntegrationView() {
  // ── State ──
  const [maestros, setMaestros] = useState<MaestroInstance[]>([]);
  const [stats, setStats] = useState<MaestroStats>(FALLBACK_STATS);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Registration form
  const [regId, setRegId] = useState('');
  const [regHostname, setRegHostname] = useState('');
  const [regCaps, setRegCaps] = useState<string[]>([]);
  const [regLoading, setRegLoading] = useState(false);
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Dispatch form
  const [dispMaestro, setDispMaestro] = useState('');
  const [dispBead, setDispBead] = useState('');
  const [dispSkill, setDispSkill] = useState('');
  const [dispLoading, setDispLoading] = useState(false);
  const [dispResult, setDispResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Heartbeat pulses
  const [pulses, setPulses] = useState<Record<string, number>>({});

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ──

  const fetchAll = useCallback(async () => {
    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const [listRes, statsRes] = await Promise.all([
        fetch(`${API}/api/meow/town/maestro/list`, { signal: ctrl.signal }),
        fetch(`${API}/api/meow/town/maestro/stats`, { signal: ctrl.signal }),
      ]);

      if (listRes.ok) {
        const data = await listRes.json();
        const items: MaestroInstance[] = Array.isArray(data) ? data : (data.maestros || data.items || []);
        setMaestros(items);

        // Detect heartbeat changes for pulse animation
        setPulses((prev) => {
          const next: Record<string, number> = {};
          for (const m of items) {
            const hb = m.lastHeartbeat || '';
            const prevTs = prev[m.id];
            if (prevTs && hb && new Date(hb).getTime() !== prevTs) {
              next[m.id] = new Date(hb).getTime();
            } else {
              next[m.id] = hb ? new Date(hb).getTime() : 0;
            }
          }
          return next;
        });
      }

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats({
          totalRegistered: data.totalRegistered ?? data.total ?? 0,
          alive: data.alive ?? 0,
          stale: data.stale ?? 0,
          dead: data.dead ?? 0,
          totalDispatches: data.totalDispatches ?? data.dispatches ?? 0,
          successRate: data.successRate ?? 0,
          avgResponseTime: data.avgResponseTime ?? '--',
        });

        // Extract dispatch history if embedded
        if (Array.isArray(data.recentDispatches)) {
          setDispatches(data.recentDispatches);
        }
      }

      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to fetch maestro data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    pollRef.current = setInterval(fetchAll, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      abortRef.current?.abort();
    };
  }, [fetchAll]);

  // ── Actions ──

  const handleRegister = useCallback(async () => {
    if (!regId.trim() || !regHostname.trim()) {
      setRegMsg({ ok: false, text: 'ID and hostname are required' });
      return;
    }
    setRegLoading(true);
    setRegMsg(null);
    try {
      const res = await fetch(`${API}/api/meow/town/maestro/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: regId.trim(), hostname: regHostname.trim(), capabilities: regCaps }),
      });
      if (res.ok) {
        setRegMsg({ ok: true, text: `Registered ${regId}` });
        setRegId('');
        setRegHostname('');
        setRegCaps([]);
        fetchAll();
      } else {
        const body = await res.json().catch(() => ({}));
        setRegMsg({ ok: false, text: body.error || `HTTP ${res.status}` });
      }
    } catch (err: unknown) {
      setRegMsg({ ok: false, text: err instanceof Error ? err.message : 'Registration failed' });
    } finally {
      setRegLoading(false);
    }
  }, [regId, regHostname, regCaps, fetchAll]);

  const handleDeregister = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${API}/api/meow/town/maestro/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) fetchAll();
    } catch { /* swallow */ }
  }, [fetchAll]);

  const handleDispatch = useCallback(async () => {
    if (!dispMaestro || !dispBead.trim() || !dispSkill.trim()) {
      setDispResult({ ok: false, text: 'Maestro, Bead ID, and Skill are required' });
      return;
    }
    setDispLoading(true);
    setDispResult(null);
    try {
      const res = await fetch(`${API}/api/meow/town/maestro/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maestroId: dispMaestro, beadId: dispBead.trim(), skill: dispSkill.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setDispResult({ ok: true, text: `Dispatched ${dispSkill} to ${dispMaestro} for bead ${dispBead}` });
        setDispBead('');
        setDispSkill('');
        fetchAll();
      } else {
        setDispResult({ ok: false, text: body.error || `HTTP ${res.status}` });
      }
    } catch (err: unknown) {
      setDispResult({ ok: false, text: err instanceof Error ? err.message : 'Dispatch failed' });
    } finally {
      setDispLoading(false);
    }
  }, [dispMaestro, dispBead, dispSkill, fetchAll]);

  const handleSendHeartbeat = useCallback(async (id: string) => {
    try {
      await fetch(`${API}/api/meow/town/maestro/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      fetchAll();
    } catch { /* swallow */ }
  }, [fetchAll]);

  const toggleCap = useCallback((cap: string) => {
    setRegCaps((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  }, []);

  // ── Derived ──

  const aliveMaestros = useMemo(() => maestros.filter((m) => m.status === 'alive'), [maestros]);

  const allSkills = useMemo(() => {
    const set = new Set<string>();
    maestros.forEach((m) => m.capabilities?.forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }, [maestros]);

  // ── Render ──

  if (loading && maestros.length === 0) {
    return (
      <div className="min-h-screen bg-[#0f1419] flex items-center justify-center">
        <div className="text-[#6c7680] font-mono text-sm animate-pulse">Loading Maestro data...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-[#2d363f] pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <span className="text-[#d2a6ff]">&#9654;</span> Maestro Integration Panel
          </h1>
          <p className="text-[#6c7680] text-xs mt-1">
            RunMaestro CLI instances connected to Gas Town
          </p>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-[#f07178] text-xs bg-[#f07178]/10 px-2 py-1 border border-[#f07178]/20 rounded-none">
              {error}
            </span>
          )}
          <button
            onClick={fetchAll}
            className="text-[#95e6cb] text-xs border border-[#95e6cb]/30 px-3 py-1 rounded-none hover:bg-[#95e6cb]/10 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* ── Stats Overview ── */}
      <section>
        <h2 className="text-[#6c7680] text-xs uppercase tracking-wider mb-3">Maestro Stats</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Registered" value={stats.totalRegistered} />
          <StatCard label="Alive" value={stats.alive} accent="text-[#c2d94c]" />
          <StatCard label="Stale" value={stats.stale} accent="text-[#ffb454]" />
          <StatCard label="Dead" value={stats.dead} accent="text-[#f07178]" />
          <StatCard label="Dispatches" value={stats.totalDispatches} accent="text-[#d2a6ff]" />
          <StatCard
            label="Success Rate"
            value={stats.successRate > 0 ? `${(stats.successRate * 100).toFixed(1)}%` : '--'}
            accent="text-[#95e6cb]"
          />
          <StatCard label="Avg Response" value={stats.avgResponseTime} accent="text-[#e6e1cf]" />
        </div>
      </section>

      {/* ── Heartbeat Monitor ── */}
      <section>
        <HeartbeatTimeline maestros={maestros} />
      </section>

      {/* ── Connected Maestros Grid ── */}
      <section>
        <h2 className="text-[#6c7680] text-xs uppercase tracking-wider mb-3">
          Connected Maestros ({maestros.length})
        </h2>
        {maestros.length === 0 ? (
          <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-8 text-center">
            <div className="text-[#6c7680] text-sm">No Maestro instances registered</div>
            <div className="text-[#6c7680] text-xs mt-1">Use the form below to register one</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <AnimatePresence mode="popLayout">
              {maestros.map((m) => {
                const st = STATUS_STYLES[m.status] || STATUS_STYLES.dead;
                const hb = heartbeatAge(m.lastHeartbeat);
                const hasPulse = pulses[m.id] && pulses[m.id] > 0;
                return (
                  <motion.div
                    key={m.id}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                    className={`bg-[#1a1f26] border border-[#2d363f] rounded-none p-4 relative ${
                      hasPulse ? 'ring-1 ring-[#c2d94c]/30' : ''
                    }`}
                  >
                    {/* Status bar */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <PulsingDot status={m.status} />
                        <span className={`text-xs ${st.dot.replace('bg-', 'text-').replace(']', '/80]')}`}>
                          {st.label}
                        </span>
                      </div>
                      <span className="text-[10px] text-[#6c7680]">{formatTs(m.registeredAt)}</span>
                    </div>

                    {/* Identity */}
                    <div className="mb-3">
                      <div className="text-[#e6e1cf] text-sm font-semibold truncate" title={m.id}>{m.id}</div>
                      <div className="text-[#6c7680] text-xs truncate" title={m.hostname}>{m.hostname}</div>
                    </div>

                    {/* Heartbeat */}
                    <div className="flex items-center gap-2 mb-3 text-xs">
                      <span className="text-[#6c7680]">Last heartbeat:</span>
                      <span className={hb.color}>{hb.label}</span>
                    </div>

                    {/* Capabilities */}
                    <div className="mb-4">
                      <div className="text-[#6c7680] text-[10px] uppercase tracking-wider mb-1">Capabilities</div>
                      <div className="flex flex-wrap">
                        {(m.capabilities || []).length === 0 ? (
                          <span className="text-[#6c7680] text-[10px]">none</span>
                        ) : (
                          m.capabilities.map((c) => <CapBadge key={c} cap={c} />)
                        )}
                      </div>
                    </div>

                    {/* Dispatches counter */}
                    {m.dispatches != null && (
                      <div className="text-[10px] text-[#6c7680] mb-3">
                        Dispatches: <span className="text-[#d2a6ff]">{m.dispatches}</span>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-3 border-t border-[#2d363f]">
                      <button
                        onClick={() => handleSendHeartbeat(m.id)}
                        className="text-[10px] text-[#c2d94c] border border-[#c2d94c]/30 px-2 py-0.5 rounded-none hover:bg-[#c2d94c]/10 transition-colors"
                      >
                        Ping
                      </button>
                      <button
                        onClick={() => handleDeregister(m.id)}
                        className="text-[10px] text-[#f07178] border border-[#f07178]/30 px-2 py-0.5 rounded-none hover:bg-[#f07178]/10 transition-colors ml-auto"
                      >
                        Deregister
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </section>

      {/* ── Registration + Dispatch side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Registration Form */}
        <section className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5">
          <h3 className="text-[#e6e1cf] text-sm font-semibold mb-4 flex items-center gap-2">
            <span className="text-[#c2d94c]">+</span> Register Maestro
          </h3>

          <div className="space-y-3">
            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">Instance ID</label>
              <input
                value={regId}
                onChange={(e) => setRegId(e.target.value)}
                placeholder="maestro-alpha-01"
                className="w-full bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#c2d94c]/50 placeholder-[#6c7680]/50"
              />
            </div>
            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">Hostname</label>
              <input
                value={regHostname}
                onChange={(e) => setRegHostname(e.target.value)}
                placeholder="dev-machine.local"
                className="w-full bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#c2d94c]/50 placeholder-[#6c7680]/50"
              />
            </div>
            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">
                Capabilities ({regCaps.length} selected)
              </label>
              <div className="flex flex-wrap gap-1 bg-[#0f1419] border border-[#2d363f] p-2 max-h-28 overflow-y-auto">
                {KNOWN_CAPABILITIES.map((cap) => {
                  const active = regCaps.includes(cap);
                  return (
                    <button
                      key={cap}
                      onClick={() => toggleCap(cap)}
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded-none border transition-colors ${
                        active
                          ? 'bg-[#95e6cb]/15 text-[#95e6cb] border-[#95e6cb]/30'
                          : 'bg-transparent text-[#6c7680] border-[#2d363f] hover:text-[#e6e1cf] hover:border-[#6c7680]'
                      }`}
                    >
                      {active ? '- ' : '+ '}{cap}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              onClick={handleRegister}
              disabled={regLoading}
              className="w-full bg-[#c2d94c]/15 text-[#c2d94c] text-xs font-semibold border border-[#c2d94c]/30 py-2 rounded-none hover:bg-[#c2d94c]/25 transition-colors disabled:opacity-40"
            >
              {regLoading ? 'Registering...' : 'Register Instance'}
            </button>

            <AnimatePresence>
              {regMsg && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className={`text-xs px-3 py-2 border rounded-none ${
                    regMsg.ok
                      ? 'text-[#c2d94c] bg-[#c2d94c]/10 border-[#c2d94c]/20'
                      : 'text-[#f07178] bg-[#f07178]/10 border-[#f07178]/20'
                  }`}
                >
                  {regMsg.text}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* Dispatch Console */}
        <section className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5">
          <h3 className="text-[#e6e1cf] text-sm font-semibold mb-4 flex items-center gap-2">
            <span className="text-[#ffb454]">&#8227;</span> Dispatch Console
          </h3>

          <div className="space-y-3">
            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">Target Maestro</label>
              <select
                value={dispMaestro}
                onChange={(e) => setDispMaestro(e.target.value)}
                className="w-full bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#ffb454]/50"
              >
                <option value="">Select Maestro...</option>
                {aliveMaestros.map((m) => (
                  <option key={m.id} value={m.id}>{m.id} ({m.hostname})</option>
                ))}
                {/* Also show non-alive for manual dispatch */}
                {maestros.filter((m) => m.status !== 'alive').map((m) => (
                  <option key={m.id} value={m.id}>[{m.status}] {m.id}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">Bead ID</label>
              <input
                value={dispBead}
                onChange={(e) => setDispBead(e.target.value)}
                placeholder="bead-0xABC"
                className="w-full bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#ffb454]/50 placeholder-[#6c7680]/50"
              />
            </div>

            <div>
              <label className="text-[#6c7680] text-[10px] uppercase tracking-wider block mb-1">Skill</label>
              <select
                value={dispSkill}
                onChange={(e) => setDispSkill(e.target.value)}
                className="w-full bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#ffb454]/50"
              >
                <option value="">Select Skill...</option>
                {allSkills.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="__custom">-- custom --</option>
              </select>
              {dispSkill === '__custom' && (
                <input
                  onChange={(e) => setDispSkill(e.target.value)}
                  placeholder="custom-skill-name"
                  className="w-full mt-1 bg-[#0f1419] border border-[#2d363f] text-[#e6e1cf] text-xs font-mono px-3 py-2 rounded-none focus:outline-none focus:border-[#ffb454]/50 placeholder-[#6c7680]/50"
                />
              )}
            </div>

            <button
              onClick={handleDispatch}
              disabled={dispLoading}
              className="w-full bg-[#ffb454]/15 text-[#ffb454] text-xs font-semibold border border-[#ffb454]/30 py-2 rounded-none hover:bg-[#ffb454]/25 transition-colors disabled:opacity-40"
            >
              {dispLoading ? 'Dispatching...' : 'Dispatch Task'}
            </button>

            <AnimatePresence>
              {dispResult && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className={`text-xs px-3 py-2 border rounded-none ${
                    dispResult.ok
                      ? 'text-[#c2d94c] bg-[#c2d94c]/10 border-[#c2d94c]/20'
                      : 'text-[#f07178] bg-[#f07178]/10 border-[#f07178]/20'
                  }`}
                >
                  {dispResult.text}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>
      </div>

      {/* ── Dispatch History ── */}
      <section>
        <h2 className="text-[#6c7680] text-xs uppercase tracking-wider mb-3">
          Dispatch History ({dispatches.length})
        </h2>
        <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none overflow-hidden">
          {dispatches.length === 0 ? (
            <div className="text-[#6c7680] text-xs text-center py-8 font-mono">
              No dispatches recorded yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#2d363f] bg-[#0f1419]">
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Timestamp</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Maestro</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Bead</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Skill</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Status</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Duration</th>
                    <th className="text-left text-[#6c7680] font-normal uppercase tracking-wider px-4 py-2">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {dispatches.map((d, i) => {
                    const dss = DISPATCH_STATUS_STYLES[d.status] || DISPATCH_STATUS_STYLES.dispatched;
                    return (
                      <tr
                        key={d.id || i}
                        className="border-b border-[#2d363f]/50 hover:bg-[#0f1419]/50 transition-colors"
                      >
                        <td className="px-4 py-2 text-[#6c7680] whitespace-nowrap">{formatTs(d.dispatchedAt)}</td>
                        <td className="px-4 py-2 text-[#e6e1cf] whitespace-nowrap">{d.maestroId}</td>
                        <td className="px-4 py-2 text-[#95e6cb] whitespace-nowrap font-semibold">{d.beadId}</td>
                        <td className="px-4 py-2 text-[#d2a6ff] whitespace-nowrap">{d.skill}</td>
                        <td className="px-4 py-2 whitespace-nowrap">
                          <span className={`inline-block px-1.5 py-0.5 ${dss.bg} ${dss.text} rounded-none border border-current/20`}>
                            {d.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[#6c7680] whitespace-nowrap">{d.duration || '--'}</td>
                        <td className="px-4 py-2 text-[#6c7680] max-w-[200px] truncate" title={d.output || ''}>
                          {truncate(d.output, 60)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Footer ── */}
      <div className="border-t border-[#2d363f] pt-3 flex items-center justify-between text-[10px] text-[#6c7680]">
        <span>Polling every {POLL_INTERVAL / 1000}s</span>
        <span>{maestros.length} instance{maestros.length !== 1 ? 's' : ''} registered</span>
      </div>
    </div>
  );
}
