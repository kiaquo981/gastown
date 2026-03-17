'use client';

/**
 * NudgeView -- GT: Nudge Console
 *
 * "gt nudge" -- Gas Town's core real-time messaging.
 * "Sends a tmux notification to a worker."
 *
 * Sections: Nudge Console, Active Nudge Queue, Nudge History,
 * Channel Management, GUPP Nudge Status.
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

interface Worker {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface NudgeMessage {
  id: string;
  target: string;
  targetName: string;
  message: string;
  priority: 'normal' | 'urgent';
  status: 'pending' | 'delivered' | 'failed';
  timestamp: string;
  sender?: string;
}

interface NudgeChannel {
  id: string;
  name: string;
  members: string[];
  memberCount: number;
  description?: string;
}

interface GUPPStaleHook {
  hookId: string;
  workerId: string;
  workerName: string;
  beadId: string;
  beadTitle: string;
  hookedAt: string;
  age: string;
  nudged: boolean;
}

interface MailStats {
  queued: number;
  delivered: number;
  totalMailboxes: number;
  totalMessages: number;
}

type TabKey = 'console' | 'queue' | 'history' | 'channels' | 'gupp';

// ── Constants ───────────────────────────────────────────────────────────────

const POLL = 6000;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'console', label: 'Send Nudge' },
  { key: 'queue', label: 'Queue' },
  { key: 'history', label: 'History' },
  { key: 'channels', label: 'Channels' },
  { key: 'gupp', label: 'GUPP Nudge' },
];

const BUILTIN_CHANNELS = [
  { id: 'all-polecats', name: 'all-polecats', description: 'All ephemeral polecats' },
  { id: 'all-crew', name: 'all-crew', description: 'All crew members' },
  { id: 'all-dogs', name: 'all-dogs', description: 'All maintenance dogs' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-3">
      <span className="text-[10px] uppercase tracking-wider text-[#4a5159] block mb-1">{label}</span>
      <span className="text-lg font-mono" style={{ color: color || C.text }}>{value}</span>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function NudgeView() {
  const [tab, setTab] = useState<TabKey>('console');
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [queue, setQueue] = useState<NudgeMessage[]>([]);
  const [history, setHistory] = useState<NudgeMessage[]>([]);
  const [channels, setChannels] = useState<NudgeChannel[]>(BUILTIN_CHANNELS.map(c => ({ ...c, members: [], memberCount: 0 })));
  const [staleHooks, setStaleHooks] = useState<GUPPStaleHook[]>([]);
  const [mailStats, setMailStats] = useState<MailStats>({ queued: 0, delivered: 0, totalMailboxes: 0, totalMessages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Send form
  const [nudgeTarget, setNudgeTarget] = useState('');
  const [nudgeMessage, setNudgeMessage] = useState('');
  const [nudgePriority, setNudgePriority] = useState<'normal' | 'urgent'>('normal');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  // Channel form
  const [showChannelForm, setShowChannelForm] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [channelDesc, setChannelDesc] = useState('');

  // History filter
  const [historyFilter, setHistoryFilter] = useState('');

  const mountedRef = useRef(true);

  // ── Fetch data ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [crewRes, hooksRes, statsRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/crew`, { signal }),
        fetch(`${API}/api/meow/gupp/hooks/pending`, { signal }),
        fetch(`${API}/api/meow/mail/stats`, { signal }),
      ]);
      if (!mountedRef.current) return;

      // Workers
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const d = await crewRes.value.json();
        const crew = Array.isArray(d) ? d : d.crew || [];
        setWorkers(crew.map((c: Record<string, unknown>) => ({
          id: String(c.id || c.name),
          name: String(c.name || c.id),
          role: String(c.specialization || c.role || 'crew'),
          status: String(c.status || 'idle'),
        })));
      }

      // Pending hooks -> stale detection
      if (hooksRes.status === 'fulfilled' && hooksRes.value.ok) {
        const d = await hooksRes.value.json();
        const raw = Array.isArray(d) ? d : d.hooks || d.pending || [];
        const stale: GUPPStaleHook[] = raw
          .filter((h: Record<string, unknown>) => {
            const hookedAt = new Date(String(h.slungAt || h.createdAt || h.claimedAt || 0));
            const ageMs = Date.now() - hookedAt.getTime();
            return ageMs > 5 * 60 * 1000 || String(h.status) === 'stale';
          })
          .map((h: Record<string, unknown>) => ({
            hookId: String(h.id || ''),
            workerId: String(h.workerId || h.agentAddress || ''),
            workerName: String(h.workerName || h.agentAddress || 'unknown'),
            beadId: String(h.beadId || ''),
            beadTitle: String(h.beadTitle || h.title || h.beadId || ''),
            hookedAt: String(h.slungAt || h.createdAt || h.claimedAt || new Date().toISOString()),
            age: timeAgo(String(h.slungAt || h.createdAt || h.claimedAt || '')),
            nudged: Boolean(h.nudged),
          }));
        setStaleHooks(stale);
      }

      // Mail stats
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const d = await statsRes.value.json();
        setMailStats({
          queued: Number(d.queued || 0),
          delivered: Number(d.delivered || 0),
          totalMailboxes: Number(d.totalMailboxes || 0),
          totalMessages: Number(d.totalMessages || 0),
        });
      }

      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (mountedRef.current) setError('Failed to reach Gas Town endpoints');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

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

  // ── Actions ───────────────────────────────────────────────────────────

  const sendNudge = useCallback(async () => {
    if (!nudgeTarget || !nudgeMessage.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`${API}/api/meow/mail/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: nudgeTarget,
          subject: 'nudge',
          body: nudgeMessage.trim(),
          priority: nudgePriority,
          type: 'task',
        }),
      });
      if (res.ok) {
        const targetName = workers.find(w => w.id === nudgeTarget)?.name || nudgeTarget;
        setSendResult(`Nudge delivered to ${targetName}`);
        // Add to history
        const msg: NudgeMessage = {
          id: `ndg-${Date.now()}`,
          target: nudgeTarget,
          targetName,
          message: nudgeMessage.trim(),
          priority: nudgePriority,
          status: 'delivered',
          timestamp: new Date().toISOString(),
          sender: 'operator',
        };
        setHistory(prev => [msg, ...prev].slice(0, 200));
        setNudgeMessage('');
      } else {
        const d = await res.json().catch(() => ({}));
        setSendResult(`ERROR: ${d.error || res.statusText}`);
      }
    } catch {
      setSendResult('ERROR: Network failure');
    } finally {
      setSending(false);
    }
  }, [nudgeTarget, nudgeMessage, nudgePriority, workers]);

  const drainQueue = useCallback(async () => {
    try {
      await fetch(`${API}/api/meow/mail/drain`, { method: 'POST' });
      setQueue([]);
      fetchData();
    } catch { /* silent */ }
  }, [fetchData]);

  const nudgeStaleHook = useCallback(async (hookId: string) => {
    try {
      await fetch(`${API}/api/meow/gupp/hooks/${hookId}/claim`, { method: 'POST' });
      setStaleHooks(prev => prev.map(h =>
        h.hookId === hookId ? { ...h, nudged: true } : h
      ));
    } catch { /* silent */ }
  }, []);

  const nudgeAllStale = useCallback(async () => {
    for (const hook of staleHooks.filter(h => !h.nudged)) {
      await nudgeStaleHook(hook.hookId);
    }
  }, [staleHooks, nudgeStaleHook]);

  const createChannel = useCallback(async () => {
    if (!channelName.trim()) return;
    const ch: NudgeChannel = {
      id: channelName.trim().toLowerCase().replace(/\s+/g, '-'),
      name: channelName.trim(),
      members: [],
      memberCount: 0,
      description: channelDesc.trim() || undefined,
    };
    setChannels(prev => [...prev, ch]);
    setChannelName('');
    setChannelDesc('');
    setShowChannelForm(false);
  }, [channelName, channelDesc]);

  const broadcastToChannel = useCallback(async (channelId: string) => {
    if (!nudgeMessage.trim()) return;
    setSending(true);
    try {
      await fetch(`${API}/api/meow/mail/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: channelId,
          body: nudgeMessage.trim(),
          priority: nudgePriority,
        }),
      });
      setSendResult(`Broadcast sent to ${channelId}`);
    } catch {
      setSendResult('ERROR: Broadcast failed');
    } finally {
      setSending(false);
    }
  }, [nudgeMessage, nudgePriority]);

  // ── Derived state ─────────────────────────────────────────────────────

  const targetOptions = useMemo(() => {
    const opts: { id: string; label: string; group: string }[] = [];
    // Channels first
    channels.forEach(ch => opts.push({ id: `channel:${ch.id}`, label: ch.name, group: 'Channels' }));
    // Then workers
    workers.forEach(w => opts.push({ id: w.id, label: `${w.name} (${w.role})`, group: 'Workers' }));
    return opts;
  }, [channels, workers]);

  const filteredHistory = useMemo(() => {
    if (!historyFilter) return history;
    const q = historyFilter.toLowerCase();
    return history.filter(h =>
      h.targetName.toLowerCase().includes(q) ||
      h.message.toLowerCase().includes(q) ||
      (h.sender || '').toLowerCase().includes(q)
    );
  }, [history, historyFilter]);

  const unNudgedStale = useMemo(() => staleHooks.filter(h => !h.nudged).length, [staleHooks]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-4 space-y-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl tracking-wider uppercase text-[#e6e1cf]">NUDGE</h1>
            <p className="text-xs text-[#4a5159] mt-0.5">
              Real-time messaging &mdash; tmux notifications to workers
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[#4a5159]">
            <span>{mailStats.queued} queued</span>
            <span className="w-px h-4" style={{ background: C.border }} />
            <span>{mailStats.delivered} delivered</span>
            <span className="w-px h-4" style={{ background: C.border }} />
            <span>{staleHooks.length} stale</span>
          </div>
        </div>
      </motion.div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Mail Queued" value={mailStats.queued} color={C.yellow} />
        <StatCard label="Delivered" value={mailStats.delivered} color={C.green} />
        <StatCard label="Mailboxes" value={mailStats.totalMailboxes} />
        <StatCard label="Stale Hooks" value={staleHooks.length} color={staleHooks.length > 0 ? C.red : C.muted} />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#2d363f]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
              tab === t.key
                ? 'text-[#e6e1cf] border-b-2 border-[#95e6cb]/60'
                : 'text-[#4a5159] hover:text-[#6c7680]'
            }`}
          >
            {t.label}
            {t.key === 'gupp' && staleHooks.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[9px] bg-[#f07178]/10 text-[#f07178] border border-[#f07178]/20 rounded-none">
                {staleHooks.length}
              </span>
            )}
            {t.key === 'queue' && queue.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[9px] bg-[#ffb454]/10 text-[#ffb454] border border-[#ffb454]/20 rounded-none">
                {queue.length}
              </span>
            )}
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
      {loading && workers.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.1 }}
              className="h-28 bg-[#2d363f]/15 border border-[#2d363f] rounded-none"
            />
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* ── Console Tab ──────────────────────────────────────────────── */}
        {tab === 'console' && (
          <motion.div key="console" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-5 space-y-4">
              <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold">Nudge Console</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Target */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Target</label>
                  <select
                    value={nudgeTarget}
                    onChange={e => setNudgeTarget(e.target.value)}
                    className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 focus:outline-none appearance-none cursor-pointer"
                  >
                    <option value="" className="bg-[#1a1f26]">-- select target --</option>
                    <optgroup label="Channels" className="bg-[#1a1f26]">
                      {channels.map(ch => (
                        <option key={ch.id} value={`channel:${ch.id}`} className="bg-[#1a1f26]">
                          {ch.name} {ch.description ? `-- ${ch.description}` : ''}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Workers" className="bg-[#1a1f26]">
                      {workers.map(w => (
                        <option key={w.id} value={w.id} className="bg-[#1a1f26]">
                          {w.name} ({w.role} - {w.status})
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Priority</label>
                  <div className="flex gap-2">
                    {(['normal', 'urgent'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => setNudgePriority(p)}
                        className={`px-4 py-2 text-[10px] font-mono uppercase border rounded-none transition-colors flex-1 ${
                          nudgePriority === p
                            ? p === 'urgent'
                              ? 'border-[#f07178]/40 bg-[#f07178]/10 text-[#f07178]'
                              : 'border-[#95e6cb]/40 bg-[#95e6cb]/10 text-[#95e6cb]'
                            : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Message */}
              <div>
                <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Message</label>
                <textarea
                  value={nudgeMessage}
                  onChange={e => setNudgeMessage(e.target.value)}
                  placeholder="Type your nudge message..."
                  rows={3}
                  className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none focus:border-[#2d363f] resize-y"
                />
              </div>

              {/* Send button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (nudgeTarget.startsWith('channel:')) {
                      broadcastToChannel(nudgeTarget.replace('channel:', ''));
                    } else {
                      sendNudge();
                    }
                  }}
                  disabled={sending || !nudgeTarget || !nudgeMessage.trim()}
                  className="px-6 py-2.5 text-sm font-mono font-bold uppercase tracking-widest bg-[#95e6cb]/15 border-2 border-[#95e6cb]/40 text-[#95e6cb] rounded-none hover:bg-[#95e6cb]/25 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {sending ? 'SENDING...' : nudgeTarget.startsWith('channel:') ? 'BROADCAST' : 'SEND NUDGE'}
                </button>
                <AnimatePresence>
                  {sendResult && (
                    <motion.span
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className={`text-xs font-mono ${
                        sendResult.startsWith('ERROR') ? 'text-[#f07178]' : 'text-[#c2d94c]'
                      }`}
                    >
                      {sendResult}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Queue Tab ────────────────────────────────────────────────── */}
        {tab === 'queue' && (
          <motion.div key="queue" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#4a5159]">{queue.length} pending nudges</span>
              <button
                onClick={drainQueue}
                disabled={queue.length === 0}
                className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border border-[#f07178]/30 text-[#f07178] rounded-none hover:bg-[#f07178]/10 transition-colors disabled:opacity-30"
              >
                Drain Queue
              </button>
            </div>

            {queue.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">Queue is empty</p>
                <p className="text-[10px] text-[#4a5159] mt-1">All nudges have been delivered</p>
              </div>
            ) : (
              <div className="space-y-0">
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-28">Target</span>
                  <span className="flex-1">Message</span>
                  <span className="w-16">Priority</span>
                  <span className="w-16">Status</span>
                  <span className="w-24 text-right">Time</span>
                </div>
                {queue.map((msg, i) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.02 }}
                    className="flex items-center gap-3 px-3 py-2 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-none flex-shrink-0 ${
                      msg.status === 'delivered' ? 'bg-[#c2d94c]' : msg.status === 'failed' ? 'bg-[#f07178]' : 'bg-[#ffb454]'
                    }`} />
                    <span className="w-28 text-xs text-[#e6e1cf]/60 truncate">{msg.targetName}</span>
                    <span className="flex-1 text-[10px] text-[#4a5159] truncate">{msg.message}</span>
                    <span className={`w-16 text-[10px] font-mono uppercase ${
                      msg.priority === 'urgent' ? 'text-[#f07178]' : 'text-[#6c7680]'
                    }`}>
                      {msg.priority}
                    </span>
                    <span className="w-16 text-[10px] text-[#4a5159] font-mono">{msg.status}</span>
                    <span className="w-24 text-[9px] text-[#4a5159] text-right">{timeAgo(msg.timestamp)}</span>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* ── History Tab ──────────────────────────────────────────────── */}
        {tab === 'history' && (
          <motion.div key="history" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
            {/* Filter */}
            <input
              type="text"
              value={historyFilter}
              onChange={e => setHistoryFilter(e.target.value)}
              placeholder="Filter by target, sender, or message..."
              className="w-full bg-[#2d363f]/20 border border-[#2d363f] rounded-none px-3 py-2 text-xs font-mono text-[#e6e1cf] placeholder:text-[#4a5159] focus:outline-none focus:border-white/15 transition-colors"
            />

            {filteredHistory.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">No nudge history</p>
              </div>
            ) : (
              <div className="space-y-0">
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-28">Timestamp</span>
                  <span className="w-20">Sender</span>
                  <span className="w-24">Target</span>
                  <span className="flex-1">Message</span>
                  <span className="w-16">Priority</span>
                  <span className="w-16 text-right">Outcome</span>
                </div>
                {filteredHistory.map((msg, i) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.015 }}
                    className="flex items-center gap-3 px-3 py-2 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-none flex-shrink-0 ${
                      msg.status === 'delivered' ? 'bg-[#c2d94c]' : msg.status === 'failed' ? 'bg-[#f07178]' : 'bg-[#ffb454]'
                    }`} />
                    <span className="w-28 text-[10px] text-[#4a5159]">{fmtDate(msg.timestamp)}</span>
                    <span className="w-20 text-xs text-[#6c7680] truncate">{msg.sender || '--'}</span>
                    <span className="w-24 text-xs text-[#e6e1cf]/60 truncate">{msg.targetName}</span>
                    <span className="flex-1 text-[10px] text-[#4a5159] truncate">{msg.message}</span>
                    <span className={`w-16 text-[10px] font-mono uppercase ${
                      msg.priority === 'urgent' ? 'text-[#f07178]' : 'text-[#6c7680]'
                    }`}>
                      {msg.priority}
                    </span>
                    <span className={`w-16 text-[10px] text-right font-mono uppercase ${
                      msg.status === 'delivered' ? 'text-[#c2d94c]' : msg.status === 'failed' ? 'text-[#f07178]' : 'text-[#ffb454]'
                    }`}>
                      {msg.status}
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* ── Channels Tab ─────────────────────────────────────────────── */}
        {tab === 'channels' && (
          <motion.div key="channels" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#4a5159]">{channels.length} channels</span>
              <button
                onClick={() => setShowChannelForm(!showChannelForm)}
                className={`px-3 py-1.5 text-xs border rounded-none transition-colors ${
                  showChannelForm
                    ? 'bg-[#f07178]/10 border-[#f07178]/20 text-[#f07178]'
                    : 'bg-[#95e6cb]/15 border-[#95e6cb]/30 text-[#95e6cb] hover:bg-[#95e6cb]/25'
                }`}
              >
                {showChannelForm ? 'CANCEL' : '+ CREATE CHANNEL'}
              </button>
            </div>

            {/* Create channel form */}
            <AnimatePresence>
              {showChannelForm && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-[#1a1f26] border border-[#95e6cb]/20 rounded-none overflow-hidden"
                >
                  <div className="p-4 space-y-3">
                    <p className="text-[10px] text-[#4a5159] uppercase tracking-wider font-semibold">New Channel</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Channel Name</label>
                        <input
                          value={channelName}
                          onChange={e => setChannelName(e.target.value)}
                          placeholder="my-channel"
                          className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#4a5159] uppercase mb-1 block">Description</label>
                        <input
                          value={channelDesc}
                          onChange={e => setChannelDesc(e.target.value)}
                          placeholder="Optional description"
                          className="w-full bg-[#0f1419] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-[#e6e1cf]/80 placeholder-[#4a5159] focus:outline-none"
                        />
                      </div>
                    </div>
                    <button
                      onClick={createChannel}
                      disabled={!channelName.trim()}
                      className="px-4 py-2 text-xs font-semibold bg-[#95e6cb]/20 border border-[#95e6cb]/30 text-[#95e6cb] rounded-none hover:bg-[#95e6cb]/30 transition-colors disabled:opacity-30"
                    >
                      CREATE
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Channel list */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {channels.map((ch, i) => (
                <motion.div
                  key={ch.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-mono text-[#e6e1cf]">{ch.name}</h3>
                    <span className="text-[9px] text-[#4a5159]">{ch.memberCount} members</span>
                  </div>
                  {ch.description && (
                    <p className="text-[10px] text-[#4a5159] mb-3">{ch.description}</p>
                  )}
                  <button
                    onClick={() => {
                      setNudgeTarget(`channel:${ch.id}`);
                      setTab('console');
                    }}
                    className="px-2.5 py-1 text-[10px] font-mono uppercase border border-[#95e6cb]/20 text-[#95e6cb] rounded-none hover:bg-[#95e6cb]/10 transition-colors"
                  >
                    Broadcast
                  </button>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── GUPP Nudge Tab ───────────────────────────────────────────── */}
        {tab === 'gupp' && (
          <motion.div key="gupp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-[#4a5159]">{staleHooks.length} workers need nudging</span>
                {unNudgedStale > 0 && (
                  <span className="ml-2 text-[10px] text-[#f07178]">({unNudgedStale} un-nudged)</span>
                )}
              </div>
              <button
                onClick={nudgeAllStale}
                disabled={unNudgedStale === 0}
                className="px-4 py-1.5 text-xs font-mono uppercase tracking-wider border-2 border-[#f07178]/40 text-[#f07178] rounded-none hover:bg-[#f07178]/10 transition-colors disabled:opacity-30"
              >
                Nudge All Stale
              </button>
            </div>

            {staleHooks.length === 0 ? (
              <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-12 text-center">
                <p className="text-sm text-[#4a5159]">No stale hooks detected</p>
                <p className="text-[10px] text-[#4a5159] mt-1">All workers are responding normally</p>
              </div>
            ) : (
              <div className="space-y-0">
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-[#4a5159] uppercase tracking-wider border-b border-[#2d363f]">
                  <span className="w-4" />
                  <span className="w-28">Worker</span>
                  <span className="w-24">Bead ID</span>
                  <span className="flex-1">Bead Title</span>
                  <span className="w-24">Hooked At</span>
                  <span className="w-16">Age</span>
                  <span className="w-16">Nudged</span>
                  <span className="w-20 text-right">Action</span>
                </div>
                {staleHooks.map((hook, i) => (
                  <motion.div
                    key={hook.hookId}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.02 }}
                    className="flex items-center gap-3 px-3 py-2.5 border-b border-[#2d363f]/30 hover:bg-[#2d363f]/15 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-none flex-shrink-0 ${hook.nudged ? 'bg-[#ffb454]' : 'bg-[#f07178]'}`} />
                    <span className="w-28 text-xs text-[#e6e1cf]/60 truncate">{hook.workerName}</span>
                    <span className="w-24 text-[10px] text-[#6c7680] font-mono">{hook.beadId.slice(0, 10)}</span>
                    <span className="flex-1 text-xs text-[#4a5159] truncate">{hook.beadTitle}</span>
                    <span className="w-24 text-[10px] text-[#4a5159]">{fmtDate(hook.hookedAt)}</span>
                    <span className="w-16 text-[10px] text-[#f07178]">{hook.age}</span>
                    <span className={`w-16 text-[10px] font-mono ${hook.nudged ? 'text-[#c2d94c]' : 'text-[#4a5159]'}`}>
                      {hook.nudged ? 'YES' : 'NO'}
                    </span>
                    <div className="w-20 flex justify-end">
                      <button
                        onClick={() => nudgeStaleHook(hook.hookId)}
                        disabled={hook.nudged}
                        className="px-2 py-1 text-[9px] font-mono uppercase border border-[#ffb454]/20 text-[#ffb454] rounded-none hover:bg-[#ffb454]/10 transition-colors disabled:opacity-30"
                      >
                        Nudge
                      </button>
                    </div>
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
          className="w-1.5 h-1.5 bg-[#95e6cb]/60 rounded-none"
        />
        <span className="text-[10px] font-mono text-[#4a5159]">Auto-refresh {POLL / 1000}s</span>
      </div>
    </div>
  );
}
