'use client';

/**
 * TmuxSessionView — tmux-style Session Dashboard for Gas Town
 *
 * Web dashboard mirroring a tmux terminal session: session list, worker
 * detail, activity feed, system status — arranged in a 4-pane split layout.
 *
 * APIs:
 *   GET {API}/api/meow/crew          — crew/worker list (sessions)
 *   GET {API}/api/meow/crew/stats    — crew stats
 *   GET {API}/api/meow/workers/overview — worker overview
 *   GET {API}/api/meow/town/pulse    — system pulse
 *   GET {API}/api/meow/town/timeline — activity timeline
 *   GET {API}/api/meow/town/log      — enriched townlog
 *   GET {API}/api/meow/mail/stats    — mail stats
 *
 * TERMINAL AESTHETIC (even darker than Ayu Dark):
 *   bg: #0a0e14, panels: #121820, text: #e6e1cf, muted: #4a5159
 *   border: #1e2630, green: #c2d94c, yellow: #ffb454, red: #f07178, cyan: #95e6cb
 *   Font-mono everything, rounded-none
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Theme Constants ─────────────────────────────────────────────────────────

const T = {
  bg:      '#0a0e14',
  panel:   '#121820',
  text:    '#e6e1cf',
  muted:   '#4a5159',
  border:  '#1e2630',
  green:   '#c2d94c',
  yellow:  '#ffb454',
  red:     '#f07178',
  cyan:    '#95e6cb',
  blue:    '#59c2ff',
  magenta: '#d2a6ff',
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  name: string;
  role: string;
  rig: string;
  workerName: string;
  status: 'active' | 'idle' | 'dead';
  lastActivity: string | null;
  uptime?: string;
  currentBead?: { id: string; title: string } | null;
  cv?: { id: string; title: string; completedAt: string }[];
  tokensConsumed?: number;
  cost?: number;
  apiCalls?: number;
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

interface LogEntry {
  id: string;
  timestamp: string;
  source: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'debug';
}

interface PulseData {
  molecules?: { active?: number; completed?: number; failed?: number; total?: number };
  beads?: { ready?: number; in_progress?: number; blocked?: number; done?: number; total?: number };
  guzzoline?: { level?: number; capacity?: number; reserved?: number };
  patrols?: { healthScore?: number; passing?: number; failing?: number };
  uptime?: string;
  workerCount?: number;
}

interface MailStats {
  unread?: number;
  total?: number;
  sent?: number;
  queued?: number;
}

type TmuxTab = 'sessions' | 'workers' | 'log' | 'status';

// ─── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL = 6000;
const MAX_LOG_ENTRIES = 100;

const STATUS_COLOR: Record<string, string> = {
  active: T.green,
  alive:  T.green,
  idle:   T.yellow,
  stale:  T.yellow,
  dead:   T.red,
  paused: T.yellow,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusColor(s: string): string {
  return STATUS_COLOR[s] || T.muted;
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '--:--:--';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return '--:--:--';
  }
}

function fmtTimeFull(ts: string | null | undefined): string {
  if (!ts) return '-- --- --:--';
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return '-- --- --:--';
  }
}

function fmtNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function fmtCost(n: number | undefined): string {
  if (n === undefined || n === null) return '$0.00';
  return `$${n.toFixed(4)}`;
}

function percent(value: number | undefined, max: number | undefined): number {
  if (!value || !max || max === 0) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.data ?? data) as T;
  } catch {
    return null;
  }
}

// ─── Pane Title Bar ──────────────────────────────────────────────────────────

function PaneTitle({ title, extra }: { title: string; extra?: string }) {
  return (
    <div
      className="flex items-center justify-between px-3 py-1 font-mono text-xs select-none"
      style={{ background: T.border, color: T.muted, borderBottom: `1px solid ${T.border}` }}
    >
      <span>
        <span style={{ color: T.green }}>{'─── '}</span>
        {title}
        <span style={{ color: T.green }}>{' ───'}</span>
      </span>
      {extra && <span style={{ color: T.muted }}>{extra}</span>}
    </div>
  );
}

// ─── Fuel Bar (ASCII-style) ──────────────────────────────────────────────────

function FuelBar({ value, max, label, color }: { value: number; max: number; label: string; color: string }) {
  const pct = percent(value, max);
  const filled = Math.round(pct / 5);
  const empty = 20 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <div className="font-mono text-xs flex items-center gap-2" style={{ color: T.text }}>
      <span style={{ color: T.muted, minWidth: 100 }}>{label}</span>
      <span style={{ color }}>[{bar}]</span>
      <span style={{ color: T.muted }}>{pct}%</span>
      <span style={{ color: T.muted }}>({fmtNumber(value)}/{fmtNumber(max)})</span>
    </div>
  );
}

// ─── Status KV Row ───────────────────────────────────────────────────────────

function KVRow({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="font-mono text-xs flex gap-2 py-0.5">
      <span style={{ color: T.muted, minWidth: 130 }}>{label}:</span>
      <span style={{ color: color || T.text }}>{value}</span>
    </div>
  );
}

// ─── Session Row ─────────────────────────────────────────────────────────────

function SessionRow({
  session, index, selected, onClick,
}: {
  session: Session; index: number; selected: boolean; onClick: () => void;
}) {
  const sc = statusColor(session.status);

  return (
    <button
      onClick={onClick}
      className="w-full text-left font-mono text-xs py-1.5 px-2 border-none outline-none transition-colors"
      style={{
        background: selected ? `${T.green}12` : 'transparent',
        color: T.text,
        borderLeft: selected ? `2px solid ${T.green}` : '2px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = `${T.border}`;
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: selected ? T.green : T.muted }}>
          {selected ? '>' : ' '}
        </span>
        <span style={{ color: T.muted }}>[{index}]</span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: sc }}
        />
        <span className="truncate flex-1" style={{ color: T.text }}>
          {session.name || session.id}
        </span>
        <span style={{ color: T.muted }} className="flex-shrink-0">
          {session.role}
        </span>
      </div>
      <div className="flex items-center gap-2 ml-6 mt-0.5">
        <span style={{ color: T.muted }} className="truncate">
          rig:{session.rig || '--'}
        </span>
        <span style={{ color: T.muted }}>|</span>
        <span style={{ color: T.muted }} className="truncate">
          {session.workerName || '--'}
        </span>
        <span className="ml-auto flex-shrink-0" style={{ color: T.muted }}>
          {fmtTime(session.lastActivity)}
        </span>
      </div>
    </button>
  );
}

// ─── Worker Detail Pane ──────────────────────────────────────────────────────

function WorkerDetail({ session }: { session: Session | null }) {
  if (!session) {
    return (
      <div className="flex items-center justify-center h-full font-mono text-sm" style={{ color: T.muted }}>
        <div className="text-center">
          <div>{'─── no session selected ───'}</div>
          <div className="mt-2 text-xs">{'select a session from the left pane'}</div>
        </div>
      </div>
    );
  }

  const sc = statusColor(session.status);
  const cv = session.cv || [];
  const last10 = cv.slice(-10).reverse();

  return (
    <div className="p-3 overflow-y-auto h-full font-mono text-xs" style={{ color: T.text }}>
      {/* Status line */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 mb-3"
        style={{ background: T.border }}
      >
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: sc }}
        />
        <span style={{ color: sc, fontWeight: 600 }}>
          {session.status.toUpperCase()}
        </span>
        <span style={{ color: T.muted }}>|</span>
        <span style={{ color: T.text }}>{session.name || session.id}</span>
        <span className="ml-auto" style={{ color: T.muted }}>
          uptime: {session.uptime || '--'}
        </span>
      </div>

      {/* Core info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mb-3">
        <KVRow label="worker" value={session.workerName || '--'} />
        <KVRow label="role" value={session.role || '--'} color={T.cyan} />
        <KVRow label="rig (worktree)" value={session.rig || '--'} />
        <KVRow label="session id" value={(session.id ?? '').slice(0, 12) || '?'} color={T.muted} />
        <KVRow label="last activity" value={fmtTimeFull(session.lastActivity)} />
      </div>

      {/* Current Task */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.green }}>
          {'─── current task ───'}
        </div>
        {session.currentBead ? (
          <div className="px-2 py-1.5" style={{ background: `${T.green}08`, border: `1px solid ${T.green}20` }}>
            <div style={{ color: T.green }}>{session.currentBead.id}</div>
            <div style={{ color: T.text }}>{session.currentBead.title}</div>
          </div>
        ) : (
          <div className="px-2 py-1" style={{ color: T.muted }}>{'(none)'}</div>
        )}
      </div>

      {/* Resource usage */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.cyan }}>
          {'─── resources ───'}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>tokens</div>
            <div style={{ color: T.cyan }}>{fmtNumber(session.tokensConsumed)}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>cost</div>
            <div style={{ color: T.yellow }}>{fmtCost(session.cost)}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>api calls</div>
            <div style={{ color: T.text }}>{fmtNumber(session.apiCalls)}</div>
          </div>
        </div>
      </div>

      {/* CV Chain */}
      <div>
        <div className="mb-1" style={{ color: T.magenta }}>
          {'─── cv chain (last 10) ───'}
        </div>
        {last10.length === 0 ? (
          <div className="px-2 py-1" style={{ color: T.muted }}>{'(empty)'}</div>
        ) : (
          <div className="space-y-0.5">
            {last10.map((item, i) => (
              <div key={item.id || i} className="flex gap-2 px-2 py-0.5" style={{ background: i % 2 === 0 ? 'transparent' : `${T.border}44` }}>
                <span style={{ color: T.muted }}>{fmtTime(item.completedAt)}</span>
                <span style={{ color: T.green }}>{'✓'}</span>
                <span style={{ color: T.muted }} className="flex-shrink-0">{(item.id || '').slice(0, 8)}</span>
                <span className="truncate" style={{ color: T.text }}>{item.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Activity Log Pane ───────────────────────────────────────────────────────

function ActivityLog({ entries }: { entries: LogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll when pinned
  useEffect(() => {
    if (pinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, pinned]);

  // Detect manual scroll-up to unpin
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (atBottom !== pinned) setPinned(atBottom);
  }, [pinned]);

  const levelColor = (level: string): string => {
    switch (level) {
      case 'info': return T.cyan;
      case 'warn': return T.yellow;
      case 'error': return T.red;
      case 'debug': return T.muted;
      default: return T.text;
    }
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* Pin toggle */}
      <div className="absolute top-1 right-2 z-10">
        <button
          onClick={() => {
            setPinned(!pinned);
            if (!pinned && scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
          className="font-mono text-xs px-2 py-0.5 border-none cursor-pointer"
          style={{
            background: pinned ? `${T.green}20` : T.border,
            color: pinned ? T.green : T.muted,
          }}
          title={pinned ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
        >
          {pinned ? '⏎ pinned' : '⏎ unpinned'}
        </button>
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden p-2 font-mono text-xs"
        style={{ color: T.text }}
      >
        {entries.length === 0 ? (
          <div style={{ color: T.muted }} className="py-4 text-center">
            {'--- awaiting log output ---'}
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex gap-1 py-px leading-relaxed whitespace-nowrap">
              <span style={{ color: T.muted }}>[{fmtTime(entry.timestamp)}]</span>
              <span style={{ color: levelColor(entry.level) }} className="flex-shrink-0">
                [{entry.source || entry.level}]
              </span>
              <span className="truncate" style={{ color: levelColor(entry.level) }}>
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Entry count footer */}
      <div
        className="flex items-center justify-between px-2 py-0.5 font-mono text-xs"
        style={{ background: T.border, color: T.muted, borderTop: `1px solid ${T.border}` }}
      >
        <span>{entries.length} entries</span>
        <span>max {MAX_LOG_ENTRIES}</span>
      </div>
    </div>
  );
}

// ─── System Status Pane ──────────────────────────────────────────────────────

function SystemStatus({
  pulse, mailStats, lastUpdate,
}: {
  pulse: PulseData | null;
  mailStats: MailStats | null;
  lastUpdate: Date | null;
}) {
  const mol = pulse?.molecules || {};
  const beads = pulse?.beads || {};
  const guz = pulse?.guzzoline || {};
  const pat = pulse?.patrols || {};

  const healthColor = (score: number | undefined): string => {
    if (score === undefined) return T.muted;
    if (score >= 80) return T.green;
    if (score >= 50) return T.yellow;
    return T.red;
  };

  return (
    <div className="p-3 overflow-y-auto h-full font-mono text-xs" style={{ color: T.text }}>
      {/* Molecules */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.green }}>{'─── molecules ───'}</div>
        <div className="grid grid-cols-3 gap-2">
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>active</div>
            <div style={{ color: T.green }}>{mol.active ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>completed</div>
            <div style={{ color: T.cyan }}>{mol.completed ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>failed</div>
            <div style={{ color: T.red }}>{mol.failed ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Beads */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.cyan }}>{'─── beads ───'}</div>
        <div className="grid grid-cols-4 gap-2">
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>ready</div>
            <div style={{ color: T.green }}>{beads.ready ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>in_progress</div>
            <div style={{ color: T.yellow }}>{beads.in_progress ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>blocked</div>
            <div style={{ color: T.red }}>{beads.blocked ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>done</div>
            <div style={{ color: T.cyan }}>{beads.done ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Mail */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.yellow }}>{'─── mail ───'}</div>
        <div className="grid grid-cols-4 gap-2">
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>unread</div>
            <div style={{ color: (mailStats?.unread ?? 0) > 0 ? T.yellow : T.text }}>
              {mailStats?.unread ?? 0}
            </div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>total</div>
            <div>{mailStats?.total ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>sent</div>
            <div>{mailStats?.sent ?? 0}</div>
          </div>
          <div className="px-2 py-1" style={{ background: T.border }}>
            <div style={{ color: T.muted }}>queued</div>
            <div>{mailStats?.queued ?? 0}</div>
          </div>
        </div>
      </div>

      {/* Guzzoline */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.magenta }}>{'─── guzzoline ───'}</div>
        <FuelBar
          value={guz.level ?? 0}
          max={guz.capacity ?? 100}
          label="fuel level"
          color={
            percent(guz.level, guz.capacity) > 50
              ? T.green
              : percent(guz.level, guz.capacity) > 20
              ? T.yellow
              : T.red
          }
        />
        {guz.reserved !== undefined && (
          <div className="mt-1 px-2" style={{ color: T.muted }}>
            reserved: {fmtNumber(guz.reserved)}
          </div>
        )}
      </div>

      {/* Patrols */}
      <div className="mb-3">
        <div className="mb-1" style={{ color: T.red }}>{'─── patrols ───'}</div>
        <div className="flex items-center gap-3 px-2">
          <span style={{ color: T.muted }}>health score:</span>
          <span
            className="text-sm font-bold"
            style={{ color: healthColor(pat.healthScore) }}
          >
            {pat.healthScore !== undefined ? `${pat.healthScore}%` : '--'}
          </span>
          {pat.passing !== undefined && (
            <>
              <span style={{ color: T.muted }}>|</span>
              <span style={{ color: T.green }}>{pat.passing} passing</span>
              <span style={{ color: T.red }}>{pat.failing ?? 0} failing</span>
            </>
          )}
        </div>
      </div>

      {/* Refresh indicator */}
      <div
        className="mt-4 pt-2 flex items-center justify-between"
        style={{ borderTop: `1px solid ${T.border}` }}
      >
        <span style={{ color: T.muted }}>
          last refresh: {lastUpdate ? fmtTime(lastUpdate.toISOString()) : '--'}
        </span>
        <span style={{ color: T.muted }}>
          interval: {POLL_INTERVAL / 1000}s
        </span>
      </div>
    </div>
  );
}

// ─── Pane Border (visual separator) ──────────────────────────────────────────

function PaneBorderH() {
  return (
    <div
      className="w-full select-none"
      style={{ height: 1, background: T.border }}
    />
  );
}

function PaneBorderV() {
  return (
    <div
      className="h-full select-none"
      style={{ width: 1, background: T.border }}
    />
  );
}

// ─── Tmux Tab Bar ────────────────────────────────────────────────────────────

function TmuxTabs({ active, onSelect }: { active: TmuxTab; onSelect: (t: TmuxTab) => void }) {
  const tabs: { id: TmuxTab; idx: number; label: string }[] = [
    { id: 'sessions', idx: 0, label: 'sessions' },
    { id: 'workers',  idx: 1, label: 'workers' },
    { id: 'log',      idx: 2, label: 'log' },
    { id: 'status',   idx: 3, label: 'status' },
  ];

  return (
    <div className="flex items-center font-mono text-xs" style={{ background: T.border }}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className="px-3 py-1 border-none cursor-pointer transition-colors"
            style={{
              background: isActive ? T.panel : 'transparent',
              color: isActive ? T.green : T.muted,
              borderBottom: isActive ? `1px solid ${T.green}` : '1px solid transparent',
            }}
          >
            {tab.idx}:{tab.label}
            {isActive ? '*' : ''}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TmuxSessionView() {
  // ── State ────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [crewStats, setCrewStats] = useState<CrewStats | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [pulse, setPulse] = useState<PulseData | null>(null);
  const [mailStats, setMailStats] = useState<MailStats | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<TmuxTab>('sessions');
  const [startTime] = useState(() => new Date());

  const abortRef = useRef<AbortController | null>(null);
  const logIdCounter = useRef(0);

  // ── Normalize crew data into sessions ────────────────────────────────────
  const normalizeSessions = useCallback((raw: unknown): Session[] => {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).members
      ? (raw as { members: unknown[] }).members
      : Object.values(raw as Record<string, unknown>);

    return arr.map((item: unknown) => {
      const r = item as Record<string, unknown>;
      return {
        id: String(r.id || r.sessionId || r.name || '??'),
        name: String(r.name || r.sessionName || r.id || 'unnamed'),
        role: String(r.role || r.specialization || '--'),
        rig: String(r.rig || r.worktree || r.branch || '--'),
        workerName: String(r.workerName || r.worker || r.agentName || '--'),
        status: (['active', 'idle', 'dead'].includes(String(r.status || ''))
          ? String(r.status)
          : r.status === 'alive' ? 'active'
          : r.status === 'stale' ? 'idle'
          : r.status === 'paused' ? 'idle'
          : 'dead') as Session['status'],
        lastActivity: String(r.lastActivity || r.heartbeat || r.updatedAt || r.lastSeen || ''),
        uptime: String(r.uptime || '--'),
        currentBead: r.currentBead
          ? { id: String((r.currentBead as Record<string, unknown>).id || ''), title: String((r.currentBead as Record<string, unknown>).title || '') }
          : r.currentAssignment
          ? { id: '', title: String(r.currentAssignment) }
          : null,
        cv: Array.isArray(r.cv) ? r.cv.map((c: Record<string, unknown>) => ({
          id: String(c.id || ''), title: String(c.title || c.task || ''), completedAt: String(c.completedAt || ''),
        })) : Array.isArray(r.assignmentHistory) ? (r.assignmentHistory as Record<string, unknown>[]).filter((h) => h.status === 'completed').map((h) => ({
          id: String(h.id || ''), title: String(h.task || ''), completedAt: String(h.completedAt || ''),
        })) : [],
        tokensConsumed: Number(r.tokensConsumed || r.tokens || 0),
        cost: Number(r.cost || 0),
        apiCalls: Number(r.apiCalls || r.calls || 0),
      };
    });
  }, []);

  // ── Normalize log entries ────────────────────────────────────────────────
  const normalizeLog = useCallback((raw: unknown): LogEntry[] => {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).entries
      ? (raw as { entries: unknown[] }).entries
      : (raw as Record<string, unknown>).events
      ? (raw as { events: unknown[] }).events
      : [];

    return arr.map((item: unknown) => {
      const r = item as Record<string, unknown>;
      logIdCounter.current += 1;
      return {
        id: String(r.id || logIdCounter.current),
        timestamp: String(r.timestamp || r.ts || r.createdAt || new Date().toISOString()),
        source: String(r.source || r.actor || r.component || 'system'),
        message: String(r.message || r.msg || r.text || r.event || JSON.stringify(r)),
        level: (['info', 'warn', 'error', 'debug'].includes(String(r.level || ''))
          ? String(r.level) : 'info') as LogEntry['level'],
      };
    });
  }, []);

  // ── Data fetching ────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const s = ac.signal;

    const [crewRaw, statsRaw, pulseRaw, logRaw, mailRaw] = await Promise.all([
      fetchJSON(`${API}/api/meow/crew`, s),
      fetchJSON<CrewStats>(`${API}/api/meow/crew/stats`, s),
      fetchJSON<PulseData>(`${API}/api/meow/town/pulse`, s),
      fetchJSON(`${API}/api/meow/town/log`, s),
      fetchJSON<MailStats>(`${API}/api/meow/mail/stats`, s),
    ]);

    if (s.aborted) return;

    const normalized = normalizeSessions(crewRaw);
    if (normalized.length > 0) setSessions(normalized);
    if (statsRaw) setCrewStats(statsRaw);
    if (pulseRaw) setPulse(pulseRaw);
    if (mailRaw) setMailStats(mailRaw);

    const newLog = normalizeLog(logRaw);
    if (newLog.length > 0) {
      setLogEntries((prev) => {
        // Merge new entries, deduplicate by id, cap at MAX_LOG_ENTRIES
        const map = new Map<string, LogEntry>();
        for (const e of prev) map.set(e.id, e);
        for (const e of newLog) map.set(e.id, e);
        const merged = Array.from(map.values());
        merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        return merged.slice(-MAX_LOG_ENTRIES);
      });
    }

    setLastUpdate(new Date());
  }, [normalizeSessions, normalizeLog]);

  // ── Poll loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, POLL_INTERVAL);
    return () => {
      clearInterval(iv);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchAll]);

  // ── Derived values ───────────────────────────────────────────────────────
  const selectedSession = useMemo(() => {
    return sessions[selectedIdx] ?? null;
  }, [sessions, selectedIdx]);

  const aliveSessions = useMemo(() => sessions.filter((s) => s.status !== 'dead').length, [sessions]);
  const deadSessions = useMemo(() => sessions.filter((s) => s.status === 'dead').length, [sessions]);

  const uptimeStr = useMemo(() => {
    const diff = Date.now() - startTime.getTime();
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return `${h}h${m.toString().padStart(2, '0')}m`;
  }, [startTime, lastUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard navigation ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, sessions.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === '1') {
        setActiveTab('sessions');
      } else if (e.key === '2') {
        setActiveTab('workers');
      } else if (e.key === '3') {
        setActiveTab('log');
      } else if (e.key === '4') {
        setActiveTab('status');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sessions.length]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col w-full font-mono"
      style={{
        background: T.bg,
        color: T.text,
        height: '100vh',
        minHeight: 600,
      }}
    >
      {/* ── tmux top status bar ─────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 py-1 text-xs select-none flex-shrink-0"
        style={{ background: T.green, color: T.bg }}
      >
        <span className="font-bold">[gas-town]</span>
        <span>
          {selectedSession?.name || 'no-session'}
          {' | '}
          workers: {sessions.length}
          {' | '}
          alive: {aliveSessions}
          {' | '}
          dead: {deadSessions}
          {' | '}
          up: {uptimeStr}
        </span>
        <span>{new Date().toLocaleTimeString('en-US', { hour12: false })}</span>
      </div>

      {/* ── tmux window tabs ────────────────────────────────────────────────── */}
      <TmuxTabs active={activeTab} onSelect={setActiveTab} />

      {/* ── 4-pane grid ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden" style={{ display: 'grid', gridTemplateRows: '1fr 1px 1fr', gridTemplateColumns: '40% 1px 1fr' }}>
        {/* Top-Left: Session List */}
        <div className="overflow-hidden flex flex-col" style={{ background: T.panel }}>
          <PaneTitle
            title="sessions"
            extra={`${sessions.length} total`}
          />
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs" style={{ color: T.muted }}>
                {'--- no sessions ---'}
              </div>
            ) : (
              sessions.map((sess, i) => (
                <SessionRow
                  key={sess.id}
                  session={sess}
                  index={i}
                  selected={i === selectedIdx}
                  onClick={() => setSelectedIdx(i)}
                />
              ))
            )}
          </div>
          {/* Session footer */}
          <div
            className="flex items-center justify-between px-3 py-1 text-xs flex-shrink-0"
            style={{ background: T.border, color: T.muted, borderTop: `1px solid ${T.border}` }}
          >
            <span>total: {sessions.length}</span>
            <span>
              <span style={{ color: T.green }}>{aliveSessions} alive</span>
              {' / '}
              <span style={{ color: T.red }}>{deadSessions} dead</span>
            </span>
          </div>
        </div>

        {/* Vertical border */}
        <PaneBorderV />

        {/* Top-Right: Worker Detail */}
        <div className="overflow-hidden flex flex-col" style={{ background: T.panel }}>
          <PaneTitle
            title="worker detail"
            extra={selectedSession ? `[${selectedIdx}]` : ''}
          />
          <div className="flex-1 overflow-hidden">
            <WorkerDetail session={selectedSession} />
          </div>
        </div>

        {/* Horizontal border (spans full width) */}
        <div style={{ gridColumn: '1 / -1' }}>
          <PaneBorderH />
        </div>

        {/* Bottom-Left: Activity Log */}
        <div className="overflow-hidden flex flex-col" style={{ background: T.panel }}>
          <PaneTitle
            title="activity log"
            extra={`${logEntries.length}/${MAX_LOG_ENTRIES}`}
          />
          <div className="flex-1 overflow-hidden">
            <ActivityLog entries={logEntries} />
          </div>
        </div>

        {/* Vertical border */}
        <PaneBorderV />

        {/* Bottom-Right: System Status */}
        <div className="overflow-hidden flex flex-col" style={{ background: T.panel }}>
          <PaneTitle
            title="system status"
            extra={pulse ? 'live' : 'waiting...'}
          />
          <div className="flex-1 overflow-hidden">
            <SystemStatus pulse={pulse} mailStats={mailStats} lastUpdate={lastUpdate} />
          </div>
        </div>
      </div>

      {/* ── tmux bottom status bar ──────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 py-1 text-xs select-none flex-shrink-0"
        style={{ background: T.border, color: T.muted, borderTop: `1px solid ${T.border}` }}
      >
        <span>
          <span style={{ color: T.green }}>j/k</span> navigate
          {' | '}
          <span style={{ color: T.green }}>1-4</span> switch panes
        </span>
        <span>
          mol:{pulse?.molecules?.active ?? 0}/{pulse?.molecules?.total ?? 0}
          {' '}
          beads:{pulse?.beads?.in_progress ?? 0}/{pulse?.beads?.total ?? 0}
          {' '}
          mail:{mailStats?.unread ?? 0}
        </span>
        <span>
          {crewStats?.mostActive
            ? `top: ${crewStats.mostActive.name} (${crewStats.mostActive.tasks})`
            : ''}
        </span>
      </div>
    </div>
  );
}
