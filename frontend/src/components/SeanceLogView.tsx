'use client';

/**
 * SeanceLogView -- Dead Session Recovery History
 *
 * "Talk to your predecessors."
 *
 * The Seance protocol allows living sessions to recover context, last words,
 * and bead state from dead sessions. This view shows the full necromantic log.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

/* ──────────────────── Types ──────────────────── */

interface SeanceRecord {
  id?: string;
  sessionId: string;
  agentName?: string;
  deathReason: string;
  lastWords?: string;
  beadsInProgress?: string[];
  resurrectedBy?: string;
  resurrectedAt?: string;
  recoveredContext?: Record<string, unknown>;
  conversationSummary?: string;
  success?: boolean;
  [key: string]: unknown;
}

interface CrewMember {
  id: string;
  name: string;
  status: string;
  specialization?: string;
  metrics?: { tasksCompleted?: number; successRate?: number };
  [key: string]: unknown;
}

interface TimelineEvent {
  id?: string;
  type: string;
  timestamp: string;
  agent?: string;
  sessionId?: string;
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

type DeathReason = 'timeout' | 'crash' | 'oom' | 'manual' | 'unknown';

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

const DEATH_COLORS: Record<string, string> = {
  timeout: AYU.yellow,
  crash: AYU.red,
  oom: '#ff6b6b',
  manual: AYU.cyan,
  unknown: AYU.muted,
};

/* ──────────────────── Helpers ──────────────────── */

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

function formatTimestamp(ts: string | undefined | null): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch {
    return '--';
  }
}

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/* ──────────────────── Component ──────────────────── */

export default function SeanceLogView() {
  /* ── State ── */
  const [seanceRecords, setSeanceRecords] = useState<SeanceRecord[]>([]);
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRecord, setExpandedRecord] = useState<string | null>(null);

  // Seance attempt state
  const [seanceInput, setSeanceInput] = useState('');
  const [seanceInProgress, setSeanceInProgress] = useState(false);
  const [seanceResult, setSeanceResult] = useState<SeanceRecord | null>(null);
  const [seanceError, setSeanceError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  /* ── Fetch data ── */

  const fetchSeanceList = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/stage06/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'seance list' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Response could be { records: [...] } or { output: "..." } or direct array
      if (Array.isArray(data)) {
        setSeanceRecords(data);
      } else if (data.records) {
        setSeanceRecords(data.records);
      } else if (data.seances) {
        setSeanceRecords(data.seances);
      } else if (data.output && typeof data.output === 'string') {
        // CLI text output — try to parse
        try {
          const parsed = JSON.parse(data.output);
          setSeanceRecords(Array.isArray(parsed) ? parsed : []);
        } catch {
          setSeanceRecords([]);
        }
      }
    } catch {
      setSeanceRecords([]);
    }
  }, []);

  const fetchCrew = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/crew`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCrew(Array.isArray(data) ? data : data.crew || data.members || []);
    } catch {
      setCrew([]);
    }
  }, []);

  const fetchTimeline = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/town/timeline`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTimeline(Array.isArray(data) ? data : data.events || data.timeline || []);
    } catch {
      setTimeline([]);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchSeanceList(), fetchCrew(), fetchTimeline()]).finally(() => setLoading(false));
    pollRef.current = setInterval(() => {
      fetchSeanceList();
      fetchTimeline();
    }, 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchSeanceList, fetchCrew, fetchTimeline]);

  /* ── Attempt seance ── */

  const attemptSeance = async () => {
    if (!seanceInput.trim()) return;
    setSeanceInProgress(true);
    setSeanceResult(null);
    setSeanceError(null);
    try {
      const res = await fetch(`${API}/api/meow/stage06/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `seance ${seanceInput.trim()}` }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) {
        setSeanceError(data.error);
      } else {
        setSeanceResult(data as SeanceRecord);
      }
    } catch (err) {
      setSeanceError(err instanceof Error ? err.message : 'Seance failed');
    } finally {
      setSeanceInProgress(false);
    }
  };

  /* ── Derived stats ── */

  const totalDeaths = seanceRecords.length;
  const successfulRecoveries = seanceRecords.filter(r => r.success !== false && r.resurrectedAt).length;
  const recoveryRate = totalDeaths > 0 ? Math.round((successfulRecoveries / totalDeaths) * 100) : 0;

  // Death reasons breakdown
  const deathReasonCounts: Record<string, number> = {};
  seanceRecords.forEach(r => {
    const reason = r.deathReason || 'unknown';
    deathReasonCounts[reason] = (deathReasonCounts[reason] || 0) + 1;
  });
  const deathReasonEntries = Object.entries(deathReasonCounts).sort((a, b) => b[1] - a[1]);
  const totalReasonCount = deathReasonEntries.reduce((s, [, c]) => s + c, 0) || 1;

  // Beads that survived across sessions
  const totalBeadsMentioned = seanceRecords.reduce((s, r) => s + (r.beadsInProgress?.length ?? 0), 0);

  // Ghost timeline: filter events related to sessions
  const sessionEvents = timeline.filter(e =>
    e.type === 'session_start' || e.type === 'session_end' || e.type === 'session_death' ||
    e.type === 'seance' || e.type === 'worker_register' || e.type === 'worker_deregister' ||
    e.type?.includes('session') || e.type?.includes('seance') || e.type?.includes('death')
  );
  // If timeline doesn't have session events, show all events
  const displayTimeline = sessionEvents.length > 0 ? sessionEvents : timeline.slice(0, 30);

  /* ──────────────────── Render ──────────────────── */

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: AYU.bg, color: AYU.muted }}>
        <div className="text-sm animate-pulse">Summoning the dead...</div>
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
              SEANCE LOG
            </h1>
            <span className="text-xs" style={{ color: AYU.muted }}>
              Dead Session Recovery History
            </span>
            <span
              className="px-2 py-0.5 text-[10px] uppercase tracking-wider"
              style={{ background: `${AYU.purple}15`, color: AYU.purple, border: `1px solid ${AYU.purple}30` }}
            >
              Talk to your predecessors
            </span>
          </div>
          <button
            onClick={() => { fetchSeanceList(); fetchTimeline(); }}
            className="px-3 py-1 text-xs transition-colors hover:opacity-80"
            style={{ background: AYU.border, color: AYU.muted, border: `1px solid ${AYU.border}` }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="p-6 space-y-8">

        {/* ═══════════════ Section 1: Seance Table ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Seance Records
          </h2>
          <div className="rounded-none overflow-hidden" style={{ border: `1px solid ${AYU.border}` }}>
            {/* Table header */}
            <div
              className="grid grid-cols-[140px_120px_100px_1fr_120px_100px] gap-2 px-4 py-2 text-[10px] uppercase"
              style={{ background: AYU.card, color: AYU.muted, borderBottom: `1px solid ${AYU.border}` }}
            >
              <span>Session ID</span>
              <span>Agent</span>
              <span>Death Reason</span>
              <span>Last Words</span>
              <span>Resurrected By</span>
              <span>Timestamp</span>
            </div>

            {/* Table rows */}
            <div className="max-h-[400px] overflow-y-auto">
              {seanceRecords.length === 0 && (
                <div className="py-12 text-center text-[11px]" style={{ color: AYU.muted }}>
                  No seance records found. The dead are silent... for now.
                </div>
              )}
              {seanceRecords.map((record, idx) => {
                const key = record.id || `${record.sessionId}-${idx}`;
                const isExpanded = expandedRecord === key;
                const deathColor = DEATH_COLORS[record.deathReason] || AYU.muted;

                return (
                  <div key={key}>
                    <button
                      className="w-full text-left grid grid-cols-[140px_120px_100px_1fr_120px_100px] gap-2 px-4 py-3 transition-colors"
                      style={{
                        background: isExpanded ? `${AYU.border}40` : AYU.bg,
                        borderBottom: `1px solid ${AYU.border}`,
                      }}
                      onClick={() => setExpandedRecord(isExpanded ? null : key)}
                    >
                      <span className="text-[11px] truncate" style={{ color: AYU.cyan }}>
                        {record.sessionId?.slice(0, 16) || '--'}
                      </span>
                      <span className="text-[11px] truncate" style={{ color: AYU.text }}>
                        {record.agentName || '--'}
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 self-center w-fit"
                        style={{ background: `${deathColor}15`, color: deathColor, border: `1px solid ${deathColor}30` }}
                      >
                        {record.deathReason || 'unknown'}
                      </span>
                      <span className="text-[11px] truncate" style={{ color: AYU.muted }}>
                        {truncate(record.lastWords, 60) || '--'}
                      </span>
                      <span className="text-[11px] truncate" style={{ color: AYU.purple }}>
                        {record.resurrectedBy || '--'}
                      </span>
                      <span className="text-[10px]" style={{ color: AYU.muted }}>
                        {timeAgo(record.resurrectedAt)}
                      </span>
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-6 py-4 space-y-3" style={{ background: `${AYU.card}80`, borderBottom: `1px solid ${AYU.border}` }}>
                        {record.lastWords && (
                          <div>
                            <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Last Words (Full)</div>
                            <div className="text-[11px] p-3 rounded-none whitespace-pre-wrap" style={{ background: AYU.bg, border: `1px solid ${AYU.border}`, color: AYU.text }}>
                              &quot;{record.lastWords}&quot;
                            </div>
                          </div>
                        )}
                        {record.beadsInProgress && record.beadsInProgress.length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Beads in Progress at Death</div>
                            <div className="flex flex-wrap gap-1">
                              {record.beadsInProgress.map((b, i) => (
                                <span
                                  key={i}
                                  className="px-2 py-0.5 text-[10px]"
                                  style={{ background: `${AYU.yellow}15`, color: AYU.yellow, border: `1px solid ${AYU.yellow}30` }}
                                >
                                  {b}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {record.conversationSummary && (
                          <div>
                            <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Conversation Summary</div>
                            <div className="text-[11px]" style={{ color: AYU.text }}>
                              {record.conversationSummary}
                            </div>
                          </div>
                        )}
                        {record.recoveredContext && Object.keys(record.recoveredContext).length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Recovered Context Snapshot</div>
                            <pre
                              className="text-[10px] p-3 rounded-none overflow-x-auto max-h-[200px] overflow-y-auto"
                              style={{ background: AYU.bg, border: `1px solid ${AYU.border}`, color: AYU.cyan }}
                            >
                              {JSON.stringify(record.recoveredContext, null, 2)}
                            </pre>
                          </div>
                        )}
                        <div className="text-[10px]" style={{ color: AYU.muted }}>
                          Resurrected: {formatTimestamp(record.resurrectedAt)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ═══════════════ Section 2: Death Reasons Stats (SVG Donut) ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Death Reasons Breakdown
          </h2>
          <div className="rounded-none p-6" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
            <div className="flex items-center gap-8">
              {/* SVG Donut Chart */}
              <div className="flex-shrink-0">
                <svg viewBox="0 0 200 200" width="180" height="180">
                  <defs>
                    <style>{`
                      @keyframes seance-spin { to { transform: rotate(360deg); } }
                    `}</style>
                  </defs>
                  {/* Background ring */}
                  <circle cx="100" cy="100" r="70" fill="none" stroke={AYU.border} strokeWidth="24" />

                  {/* Data arcs */}
                  {(() => {
                    let offset = 0;
                    const circumference = 2 * Math.PI * 70;
                    return deathReasonEntries.map(([reason, count]) => {
                      const pct = count / totalReasonCount;
                      const dashLength = pct * circumference;
                      const dashOffset = -offset * circumference;
                      offset += pct;
                      const color = DEATH_COLORS[reason] || AYU.muted;
                      return (
                        <circle
                          key={reason}
                          cx="100" cy="100" r="70"
                          fill="none"
                          stroke={color}
                          strokeWidth="24"
                          strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                          strokeDashoffset={dashOffset}
                          transform="rotate(-90 100 100)"
                          style={{ transition: 'stroke-dasharray 0.5s, stroke-dashoffset 0.5s' }}
                        />
                      );
                    });
                  })()}

                  {/* Center text */}
                  <text x="100" y="92" textAnchor="middle" fill={AYU.text} fontSize="24" fontFamily="monospace" fontWeight="bold">
                    {totalDeaths}
                  </text>
                  <text x="100" y="112" textAnchor="middle" fill={AYU.muted} fontSize="10" fontFamily="monospace">
                    total deaths
                  </text>
                </svg>
              </div>

              {/* Legend */}
              <div className="flex-1 space-y-3">
                {deathReasonEntries.length === 0 && (
                  <div className="text-[11px]" style={{ color: AYU.muted }}>
                    No death records to display.
                  </div>
                )}
                {deathReasonEntries.map(([reason, count]) => {
                  const pct = Math.round((count / totalReasonCount) * 100);
                  const color = DEATH_COLORS[reason] || AYU.muted;
                  return (
                    <div key={reason}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-none" style={{ background: color }} />
                          <span className="text-xs uppercase" style={{ color: AYU.text }}>{reason}</span>
                        </div>
                        <span className="text-xs" style={{ color }}>
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 rounded-none" style={{ background: AYU.border }}>
                        <div
                          className="h-full rounded-none transition-all"
                          style={{ width: `${pct}%`, background: color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* ═══════════════ Section 3: Recovery Rate ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Recovery Rate
          </h2>
          <div className="grid grid-cols-4 gap-4">
            {/* Total deaths */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Sessions Died</div>
              <div className="text-2xl font-bold" style={{ color: AYU.red }}>{totalDeaths}</div>
              <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>total deaths recorded</div>
            </div>

            {/* Successful recoveries */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Recovered</div>
              <div className="text-2xl font-bold" style={{ color: AYU.green }}>{successfulRecoveries}</div>
              <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>successful seances</div>
            </div>

            {/* Recovery rate */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Recovery Rate</div>
              <div
                className="text-2xl font-bold"
                style={{ color: recoveryRate >= 80 ? AYU.green : recoveryRate >= 50 ? AYU.yellow : AYU.red }}
              >
                {recoveryRate}%
              </div>
              <div className="mt-2 h-1.5 rounded-none" style={{ background: AYU.border }}>
                <div
                  className="h-full rounded-none transition-all"
                  style={{
                    width: `${recoveryRate}%`,
                    background: recoveryRate >= 80 ? AYU.green : recoveryRate >= 50 ? AYU.yellow : AYU.red,
                  }}
                />
              </div>
            </div>

            {/* Bead continuity */}
            <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
              <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Bead Continuity</div>
              <div className="text-2xl font-bold" style={{ color: AYU.cyan }}>{totalBeadsMentioned}</div>
              <div className="text-[10px] mt-1" style={{ color: AYU.muted }}>beads survived across sessions</div>
            </div>
          </div>
        </section>

        {/* ═══════════════ Section 4: Predecessor Communication ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Predecessor Communication
          </h2>
          <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
            <p className="text-[11px] mb-4" style={{ color: AYU.muted }}>
              Attempt a seance to recover context from a dead session. Enter the session ID to commune with the departed.
            </p>

            {/* Input + button */}
            <div className="flex items-center gap-3 mb-4">
              <input
                type="text"
                value={seanceInput}
                onChange={e => setSeanceInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && attemptSeance()}
                placeholder="Enter session ID..."
                className="flex-1 px-4 py-2.5 text-xs rounded-none focus:outline-none"
                style={{
                  background: AYU.bg,
                  border: `1px solid ${AYU.border}`,
                  color: AYU.text,
                }}
              />
              <button
                onClick={attemptSeance}
                disabled={seanceInProgress || !seanceInput.trim()}
                className="px-5 py-2.5 text-xs rounded-none transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: `${AYU.purple}20`,
                  color: AYU.purple,
                  border: `1px solid ${AYU.purple}40`,
                }}
              >
                {seanceInProgress ? 'Channeling...' : 'Begin Seance'}
              </button>
            </div>

            {/* Quick pick from crew */}
            {crew.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] uppercase mb-2" style={{ color: AYU.muted }}>Known agents (click to select)</div>
                <div className="flex flex-wrap gap-2">
                  {crew.map(member => (
                    <button
                      key={member.id}
                      onClick={() => setSeanceInput(member.id)}
                      className="px-2 py-1 text-[10px] rounded-none transition-colors"
                      style={{
                        background: seanceInput === member.id ? `${AYU.purple}20` : AYU.bg,
                        color: seanceInput === member.id ? AYU.purple : AYU.muted,
                        border: `1px solid ${seanceInput === member.id ? AYU.purple : AYU.border}`,
                      }}
                    >
                      {member.name || 'unknown'} ({(member.id ?? '').slice(0, 8) || '?'})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Seance results */}
            {seanceError && (
              <div
                className="p-4 rounded-none mb-4"
                style={{ background: `${AYU.red}10`, border: `1px solid ${AYU.red}30` }}
              >
                <div className="text-[10px] uppercase mb-1" style={{ color: AYU.red }}>Seance Failed</div>
                <div className="text-[11px]" style={{ color: AYU.red }}>{seanceError}</div>
              </div>
            )}

            {seanceResult && (
              <div
                className="p-4 rounded-none space-y-3"
                style={{ background: `${AYU.purple}08`, border: `1px solid ${AYU.purple}30` }}
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: AYU.purple }} />
                  <span className="text-xs font-bold" style={{ color: AYU.purple }}>SEANCE SUCCESSFUL</span>
                </div>

                {seanceResult.agentName && (
                  <div>
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Agent</div>
                    <div className="text-[11px]" style={{ color: AYU.text }}>{seanceResult.agentName}</div>
                  </div>
                )}

                {seanceResult.lastWords && (
                  <div>
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Last Words</div>
                    <div
                      className="text-[11px] p-3 rounded-none italic"
                      style={{ background: AYU.bg, border: `1px solid ${AYU.border}`, color: AYU.text }}
                    >
                      &quot;{seanceResult.lastWords}&quot;
                    </div>
                  </div>
                )}

                {seanceResult.conversationSummary && (
                  <div>
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Conversation Summary</div>
                    <div className="text-[11px]" style={{ color: AYU.text }}>
                      {seanceResult.conversationSummary}
                    </div>
                  </div>
                )}

                {seanceResult.recoveredContext && Object.keys(seanceResult.recoveredContext).length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Recovered Context</div>
                    <pre
                      className="text-[10px] p-3 rounded-none overflow-x-auto max-h-[200px] overflow-y-auto"
                      style={{ background: AYU.bg, border: `1px solid ${AYU.border}`, color: AYU.cyan }}
                    >
                      {JSON.stringify(seanceResult.recoveredContext, null, 2)}
                    </pre>
                  </div>
                )}

                {seanceResult.beadsInProgress && seanceResult.beadsInProgress.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase mb-1" style={{ color: AYU.muted }}>Beads That Were In Progress</div>
                    <div className="flex flex-wrap gap-1">
                      {seanceResult.beadsInProgress.map((b, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 text-[10px]"
                          style={{ background: `${AYU.yellow}15`, color: AYU.yellow, border: `1px solid ${AYU.yellow}30` }}
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ═══════════════ Section 5: Ghost Timeline ═══════════════ */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: AYU.muted }}>
            Ghost Timeline
          </h2>
          <div className="rounded-none p-5" style={{ background: AYU.card, border: `1px solid ${AYU.border}` }}>
            <p className="text-[11px] mb-5" style={{ color: AYU.muted }}>
              Session lifecycles: birth, activity, death, and resurrection.
            </p>

            {/* Vertical timeline */}
            <div className="relative ml-4">
              {/* Vertical line */}
              <div
                className="absolute left-3 top-0 bottom-0 w-px"
                style={{ background: AYU.border }}
              />

              {displayTimeline.length === 0 && (
                <div className="py-8 text-center text-[11px]" style={{ color: AYU.muted }}>
                  No timeline events recorded yet.
                </div>
              )}

              <div className="space-y-1">
                {displayTimeline.slice(0, 40).map((event, idx) => {
                  // Determine event color based on type
                  let dotColor: string = AYU.muted;
                  let label = event.type;
                  if (event.type?.includes('start') || event.type?.includes('birth') || event.type?.includes('register')) {
                    dotColor = AYU.green;
                    label = 'BIRTH';
                  } else if (event.type?.includes('death') || event.type?.includes('end') || event.type?.includes('deregister')) {
                    dotColor = AYU.red;
                    label = 'DEATH';
                  } else if (event.type?.includes('seance') || event.type?.includes('resurrect')) {
                    dotColor = AYU.purple;
                    label = 'SEANCE';
                  } else if (event.type?.includes('activity') || event.type?.includes('task') || event.type?.includes('bead')) {
                    dotColor = AYU.cyan;
                    label = 'ACTIVITY';
                  }

                  return (
                    <div key={event.id || idx} className="relative pl-10 py-3">
                      {/* Dot on the line */}
                      <div
                        className="absolute left-1.5 top-4 w-3 h-3 rounded-full"
                        style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}40` }}
                      />

                      {/* Event card */}
                      <div
                        className="p-3 rounded-none"
                        style={{ background: AYU.bg, border: `1px solid ${AYU.border}` }}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="text-[10px] px-1.5 py-0.5 uppercase"
                              style={{ background: `${dotColor}15`, color: dotColor, border: `1px solid ${dotColor}30` }}
                            >
                              {label}
                            </span>
                            {event.agent && (
                              <span className="text-[11px]" style={{ color: AYU.text }}>
                                {event.agent}
                              </span>
                            )}
                            {event.sessionId && (
                              <span className="text-[10px]" style={{ color: AYU.muted }}>
                                [{event.sessionId?.slice(0, 10) ?? '--'}]
                              </span>
                            )}
                          </div>
                          <span className="text-[10px]" style={{ color: AYU.muted }}>
                            {formatTimestamp(event.timestamp)}
                          </span>
                        </div>
                        {event.message && (
                          <div className="text-[11px] mt-1" style={{ color: AYU.muted }}>
                            {truncate(event.message, 120)}
                          </div>
                        )}
                        {/* Show death-specific data */}
                        {event.data && (event.type?.includes('death') || event.type?.includes('seance')) && (
                          <div className="mt-2 flex items-center gap-3 text-[10px]">
                            {(() => { const d = event.data as Record<string, unknown>; return d.deathReason ? (
                              <span style={{ color: DEATH_COLORS[d.deathReason as string] || AYU.muted }}>
                                Reason: {String(d.deathReason)}
                              </span>
                            ) : null; })()}
                            {(() => { const d = event.data as Record<string, unknown>; return d.beadsRecovered != null ? (
                              <span style={{ color: AYU.green }}>
                                Beads recovered: {String(d.beadsRecovered)}
                              </span>
                            ) : null; })()}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {displayTimeline.length > 40 && (
                  <div className="pl-10 py-3 text-[10px]" style={{ color: AYU.muted }}>
                    +{displayTimeline.length - 40} more events
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
