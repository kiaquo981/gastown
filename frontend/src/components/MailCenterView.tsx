'use client';

/**
 * MailCenterView — GT-017: Mail Center
 * Full internal email interface for MEOW workers.
 * Gas Town Stage 03 Wave 4 — Communication Hub
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

/* -------------------- Types -------------------- */

interface MailMessage {
  id: string; from: string; to: string; subject: string; body: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  type: 'info' | 'task' | 'escalation' | 'alert';
  read: boolean; threadId?: string; createdAt: string;
}

interface Mailbox {
  workerId: string; workerName: string; unreadCount: number;
  totalMessages: number; dnd: boolean; lastActivity?: string;
}

interface MailStats {
  queued: number; delivered: number; totalMailboxes: number;
  totalMessages: number; unreadTotal: number; dndCount: number;
}

interface QueueWorker {
  id: string; status: 'idle' | 'processing' | 'paused';
  claimed: number; processed: number; lastClaim?: string;
}

type TabKey = 'inbox' | 'sent' | 'mailboxes' | 'broadcast' | 'queue';

/* -------------------- Constants -------------------- */

const TABS: { key: TabKey; label: string }[] = [
  { key: 'inbox', label: 'Inbox' }, { key: 'sent', label: 'Sent' },
  { key: 'mailboxes', label: 'All Mailboxes' }, { key: 'broadcast', label: 'Broadcast' },
  { key: 'queue', label: 'Queue Workers' },
];

const PRIO: Record<string, string> = {
  low: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  normal: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  high: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  critical: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const TYPE_CLR: Record<string, string> = {
  info: 'text-blue-400', task: 'text-amber-400',
  escalation: 'text-red-400', alert: 'text-rose-400',
};

function timeAgo(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/* -------------------- Component -------------------- */

export default function MailCenterView() {
  const [tab, setTab] = useState<TabKey>('inbox');
  const [stats, setStats] = useState<MailStats | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [queueWorkers, setQueueWorkers] = useState<QueueWorker[]>([]);
  const [selBox, setSelBox] = useState<string | null>(null);
  const [selMsg, setSelMsg] = useState<MailMessage | null>(null);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);

  // Compose form state
  const [cTo, setCTo] = useState('');
  const [cSubj, setCSubj] = useState('');
  const [cBody, setCBody] = useState('');
  const [cPri, setCPri] = useState<'low' | 'normal' | 'high' | 'critical'>('normal');
  const [cType, setCType] = useState<'info' | 'task' | 'escalation' | 'alert'>('info');
  const [sending, setSending] = useState(false);

  // Broadcast state
  const [bSubj, setBSubj] = useState('');
  const [bBody, setBBody] = useState('');
  const [bPri, setBPri] = useState<'low' | 'normal' | 'high' | 'critical'>('normal');
  const [bSending, setBSending] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  /* ---- Fetchers ---- */

  const fetchStats = useCallback(async (sig?: AbortSignal) => {
    try {
      const r = await fetch(`${API}/api/meow/mail/stats`, { signal: sig });
      if (!r.ok) throw new Error('');
      setStats(await r.json());
      setDataSource('db');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setStats({ queued: 0, delivered: 0, totalMailboxes: 0, totalMessages: 0, unreadTotal: 0, dndCount: 0 });
      setDataSource('mock');
    }
  }, []);

  const fetchMailboxes = useCallback(async (sig?: AbortSignal) => {
    try {
      const r = await fetch(`${API}/api/meow/mail/mailboxes`, { signal: sig });
      if (!r.ok) throw new Error('');
      setMailboxes((await r.json()).mailboxes || []);
    } catch (e) { if ((e as Error).name !== 'AbortError') setMailboxes([]); }
  }, []);

  const fetchMessages = useCallback(async (wid: string, sig?: AbortSignal) => {
    try {
      const r = await fetch(`${API}/api/meow/mail/${wid}`, { signal: sig });
      if (!r.ok) throw new Error('');
      setMessages((await r.json()).messages || []);
    } catch (e) { if ((e as Error).name !== 'AbortError') setMessages([]); }
  }, []);

  const fetchQueue = useCallback(async (sig?: AbortSignal) => {
    try {
      const r = await fetch(`${API}/api/meow/mail/dashboard`, { signal: sig });
      if (!r.ok) throw new Error('');
      setQueueWorkers((await r.json()).queueWorkers || []);
    } catch (e) { if ((e as Error).name !== 'AbortError') setQueueWorkers([]); }
  }, []);

  /* ---- Polling ---- */

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const load = async () => {
      setLoading(true);
      await Promise.all([fetchStats(ac.signal), fetchMailboxes(ac.signal)]);
      if (selBox) await fetchMessages(selBox, ac.signal);
      if (tab === 'queue') await fetchQueue(ac.signal);
      setLoading(false);
    };
    load();
    const iv = setInterval(() => {
      fetchStats(ac.signal);
      fetchMailboxes(ac.signal);
      if (selBox) fetchMessages(selBox, ac.signal);
      if (tab === 'queue') fetchQueue(ac.signal);
    }, 8000);
    return () => { ac.abort(); clearInterval(iv); };
  }, [tab, selBox, fetchStats, fetchMailboxes, fetchMessages, fetchQueue]);

  /* ---- Actions ---- */

  const sendMail = async () => {
    if (!cTo || !cSubj || !cBody) return;
    setSending(true);
    try {
      const r = await fetch(`${API}/api/meow/mail/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: selBox || 'system', to: cTo, subject: cSubj, body: cBody, priority: cPri, type: cType }),
      });
      if (!r.ok) throw new Error('');
      setShowCompose(false); setCTo(''); setCSubj(''); setCBody(''); setCPri('normal'); setCType('info');
      if (selBox) fetchMessages(selBox);
    } catch { /* swallow */ }
    setSending(false);
  };

  const sendBroadcast = async () => {
    if (!bSubj || !bBody) return;
    setBSending(true);
    try {
      await fetch(`${API}/api/meow/mail/bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'broadcast', subject: bSubj, body: bBody, priority: bPri }),
      });
      setBSubj(''); setBBody('');
    } catch { /* swallow */ }
    setBSending(false);
  };

  const markRead = async (wid: string, mid: string) => {
    try {
      await fetch(`${API}/api/meow/mail/${wid}/read/${mid}`, { method: 'POST' });
      setMessages(p => p.map(m => m.id === mid ? { ...m, read: true } : m));
    } catch { /* swallow */ }
  };

  const markAllRead = async (wid: string) => {
    try {
      await fetch(`${API}/api/meow/mail/${wid}/read-all`, { method: 'POST' });
      setMessages(p => p.map(m => ({ ...m, read: true })));
    } catch { /* swallow */ }
  };

  const toggleDnd = async (wid: string, on: boolean) => {
    try {
      await fetch(`${API}/api/meow/mail/${wid}/dnd`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      });
      fetchMailboxes();
    } catch { /* swallow */ }
  };

  const bulkMarkRead = async () => {
    if (!selIds.size || !selBox) return;
    try {
      await fetch(`${API}/api/meow/mail/bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_read', ids: Array.from(selIds), workerId: selBox }),
      });
      setMessages(p => p.map(m => selIds.has(m.id) ? { ...m, read: true } : m));
      setSelIds(new Set());
    } catch { /* swallow */ }
  };

  const runCleanup = async () => {
    try { await fetch(`${API}/api/meow/mail/cleanup`, { method: 'POST' }); fetchStats(); } catch { /* swallow */ }
  };

  const toggleSel = (id: string) => {
    setSelIds(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  /* ---- Derived ---- */

  const filtered = useMemo(() => tab === 'sent' ? messages.filter(m => m.from === selBox) : messages, [messages, tab, selBox]);
  const sorted = useMemo(() => [...mailboxes].sort((a, b) => b.unreadCount - a.unreadCount), [mailboxes]);
  const curMb = mailboxes.find(m => m.workerId === selBox);

  /* -------------------- Render -------------------- */

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono">
      {/* Stats Bar */}
      <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} className="border-b border-[#2d363f] bg-[#1a1f26] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold tracking-tight">Mail Center</h1>
            {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] rounded-none bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE</span>}
            {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] rounded-none bg-amber-500/10 text-amber-400 border border-amber-500/20">DEMO</span>}
          </div>
          <div className="flex items-center gap-6 text-xs text-white/50">
            <div>Mailboxes: <span className="text-white/80">{stats?.totalMailboxes ?? '-'}</span></div>
            <div>Unread: <span className="text-amber-400">{stats?.unreadTotal ?? '-'}</span></div>
            <div>Queued: <span className="text-blue-400">{stats?.queued ?? '-'}</span></div>
            <div>DND: <span className="text-red-400">{stats?.dndCount ?? '-'}</span></div>
            <button onClick={() => setShowCompose(true)} className="px-3 py-1.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-none hover:bg-blue-500/30 transition-colors">
              + Compose
            </button>
          </div>
        </div>
      </motion.div>

      {/* Tab Bar */}
      <div className="border-b border-[#2d363f] bg-[#1a1f26] px-6 flex">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs border-b-2 transition-colors ${tab === t.key ? 'border-blue-400 text-blue-400 bg-blue-500/5' : 'border-transparent text-[#4a5159] hover:text-[#6c7680]'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Main Layout */}
      <div className="flex" style={{ height: 'calc(100vh - 120px)' }}>
        {/* Left Sidebar — Mailbox List */}
        {(tab === 'inbox' || tab === 'sent') && (
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="w-64 border-r border-[#2d363f] bg-[#1a1f26] overflow-y-auto flex-shrink-0">
            <div className="p-3 border-b border-[#2d363f] text-[10px] text-[#4a5159] uppercase tracking-widest">Mailboxes</div>
            {sorted.map(mb => (
              <button key={mb.workerId} onClick={() => { setSelBox(mb.workerId); setSelMsg(null); setSelIds(new Set()); }}
                className={`w-full text-left px-3 py-2.5 border-b border-white/[0.03] flex items-center justify-between transition-colors ${selBox === mb.workerId ? 'bg-white/5' : 'hover:bg-white/[0.02]'}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-white/70 truncate">{mb.workerName || mb.workerId}</div>
                  <div className="text-[10px] text-[#4a5159] mt-0.5">
                    {mb.totalMessages} msgs{mb.lastActivity && <span className="ml-1">| {timeAgo(mb.lastActivity)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 ml-2 flex-shrink-0">
                  {mb.dnd && <span className="text-[9px] text-red-400">DND</span>}
                  {mb.unreadCount > 0 && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] bg-blue-500/30 text-blue-300 rounded-none">{mb.unreadCount}</span>
                  )}
                </div>
              </button>
            ))}
            {sorted.length === 0 && <div className="p-4 text-xs text-white/20 text-center">No mailboxes found</div>}
          </motion.div>
        )}

        {/* Main Content Area */}
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {/* Inbox / Sent Tab */}
            {(tab === 'inbox' || tab === 'sent') && (
              <motion.div key="inbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full flex flex-col">
                {selBox ? (
                  <>
                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-4 py-2 border-b border-[#2d363f] bg-[#1a1f26]">
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-white/50">{selBox}</span>
                        <span className="text-[10px] text-[#4a5159]">{filtered.length} msgs</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {selIds.size > 0 && (
                          <button onClick={bulkMarkRead} className="px-2 py-1 text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-none hover:bg-emerald-500/30 transition-colors">
                            Mark {selIds.size} Read
                          </button>
                        )}
                        <button onClick={() => markAllRead(selBox)} className="px-2 py-1 text-[10px] bg-white/5 text-[#4a5159] border border-[#2d363f] rounded-none hover:bg-white/10 transition-colors">
                          Mark All Read
                        </button>
                        {curMb && (
                          <button onClick={() => toggleDnd(selBox, !curMb.dnd)}
                            className={`px-2 py-1 text-[10px] border rounded-none transition-colors ${curMb.dnd ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-white/5 text-[#4a5159] border-[#2d363f] hover:bg-white/10'}`}>
                            {curMb.dnd ? 'DND ON' : 'DND OFF'}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Message List */}
                    <div className="flex-1 overflow-y-auto">
                      {filtered.map(msg => (
                        <motion.div key={msg.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                          className={`flex items-center gap-3 px-4 py-3 border-b border-white/[0.03] cursor-pointer transition-colors ${selMsg?.id === msg.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.02]'} ${!msg.read ? 'border-l-2 border-l-blue-400' : ''}`}
                          onClick={() => { setSelMsg(msg); if (!msg.read && selBox) markRead(selBox, msg.id); }}>
                          <input type="checkbox" checked={selIds.has(msg.id)}
                            onChange={e => { e.stopPropagation(); toggleSel(msg.id); }} className="accent-blue-400 flex-shrink-0" />
                          <div className={`w-1.5 h-1.5 rounded-none flex-shrink-0 ${msg.read ? 'bg-transparent' : 'bg-blue-400'}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[#6c7680] truncate" style={{ maxWidth: 120 }}>{tab === 'sent' ? msg.to : msg.from}</span>
                              <span className={`text-xs truncate flex-1 ${msg.read ? 'text-[#4a5159]' : 'text-white/80 font-semibold'}`}>{msg.subject}</span>
                            </div>
                            <div className="text-[10px] text-white/25 mt-0.5 truncate">{trunc(msg.body, 80)}</div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <span className={`text-[9px] uppercase ${TYPE_CLR[msg.type] || 'text-[#4a5159]'}`}>{msg.type}</span>
                            <span className={`px-1.5 py-0.5 text-[9px] border rounded-none ${PRIO[msg.priority]}`}>{msg.priority}</span>
                            <span className="text-[10px] text-white/25 w-10 text-right">{timeAgo(msg.createdAt)}</span>
                          </div>
                        </motion.div>
                      ))}
                      {filtered.length === 0 && !loading && (
                        <div className="flex items-center justify-center h-40 text-xs text-white/20">No messages</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-white/20">Select a mailbox</div>
                )}
              </motion.div>
            )}

            {/* All Mailboxes Tab */}
            {tab === 'mailboxes' && (
              <motion.div key="mb" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs text-white/50">{mailboxes.length} mailboxes</span>
                  <button onClick={runCleanup} className="px-2 py-1 text-[10px] bg-white/5 text-[#4a5159] border border-[#2d363f] rounded-none hover:bg-white/10 transition-colors">Cleanup</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {sorted.map(mb => (
                    <motion.div key={mb.workerId} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                      className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4 hover:border-[#2d363f] transition-colors cursor-pointer"
                      onClick={() => { setSelBox(mb.workerId); setTab('inbox'); }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-white/70 font-semibold truncate">{mb.workerName || mb.workerId}</span>
                        {mb.dnd && <span className="text-[9px] text-red-400 bg-red-500/10 px-1.5 py-0.5 border border-red-500/20 rounded-none">DND</span>}
                      </div>
                      <div className="flex items-center gap-4 text-[10px] text-[#4a5159]">
                        <span>Total: {mb.totalMessages}</span>
                        <span className={mb.unreadCount > 0 ? 'text-blue-400' : ''}>Unread: {mb.unreadCount}</span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Broadcast Tab */}
            {tab === 'broadcast' && (
              <motion.div key="bc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-6 max-w-xl">
                <h2 className="text-sm font-bold text-white/70 mb-4">Broadcast to All Mailboxes</h2>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Subject</label>
                    <input value={bSubj} onChange={e => setBSubj(e.target.value)} className="w-full bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-white/80 focus:border-blue-500/40 focus:outline-none" placeholder="Subject..." />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Body</label>
                    <textarea value={bBody} onChange={e => setBBody(e.target.value)} rows={6} className="w-full bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-white/80 focus:border-blue-500/40 focus:outline-none resize-none" placeholder="Message..." />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Priority</label>
                    <div className="flex gap-2">
                      {(['low', 'normal', 'high', 'critical'] as const).map(p => (
                        <button key={p} onClick={() => setBPri(p)}
                          className={`px-3 py-1.5 text-[10px] border rounded-none transition-colors ${bPri === p ? PRIO[p] : 'bg-white/[0.02] text-[#4a5159] border-[#2d363f]'}`}>{p}</button>
                      ))}
                    </div>
                  </div>
                  <button onClick={sendBroadcast} disabled={bSending || !bSubj || !bBody}
                    className="px-4 py-2 text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-none hover:bg-blue-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    {bSending ? 'Sending...' : 'Send Broadcast'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Queue Workers Tab */}
            {tab === 'queue' && (
              <motion.div key="q" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-4">
                <h2 className="text-sm font-bold text-white/70 mb-4">Mail Queue Workers</h2>
                <div className="space-y-2">
                  {queueWorkers.map(qw => (
                    <div key={qw.id} className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-4 flex items-center justify-between">
                      <div>
                        <div className="text-xs text-white/70 font-semibold">{qw.id}</div>
                        <div className="flex items-center gap-4 text-[10px] text-[#4a5159] mt-1">
                          <span>Claimed: {qw.claimed}</span>
                          <span>Processed: {qw.processed}</span>
                          {qw.lastClaim && <span>Last: {timeAgo(qw.lastClaim)}</span>}
                        </div>
                      </div>
                      <span className={`px-2 py-1 text-[10px] border rounded-none ${qw.status === 'processing' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : qw.status === 'paused' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}`}>
                        {qw.status}
                      </span>
                    </div>
                  ))}
                  {queueWorkers.length === 0 && <div className="text-xs text-white/20 text-center py-8">No queue workers</div>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right Panel — Message Detail */}
        <AnimatePresence>
          {selMsg && (tab === 'inbox' || tab === 'sent') && (
            <motion.div key="det" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              className="w-96 border-l border-[#2d363f] bg-[#1a1f26] overflow-y-auto flex-shrink-0">
              <div className="p-4 border-b border-[#2d363f] flex items-center justify-between">
                <span className="text-xs text-white/50">Detail</span>
                <button onClick={() => setSelMsg(null)} className="text-[#4a5159] hover:text-[#6c7680] text-sm">x</button>
              </div>
              <div className="p-4 space-y-4">
                <div>
                  <div className="text-[10px] text-white/25 uppercase tracking-widest mb-1">Subject</div>
                  <div className="text-sm text-white/80">{selMsg.subject}</div>
                </div>
                <div className="flex gap-4">
                  <div><div className="text-[10px] text-white/25 uppercase tracking-widest mb-1">From</div><div className="text-xs text-[#6c7680]">{selMsg.from}</div></div>
                  <div><div className="text-[10px] text-white/25 uppercase tracking-widest mb-1">To</div><div className="text-xs text-[#6c7680]">{selMsg.to}</div></div>
                </div>
                <div className="flex gap-3">
                  <span className={`px-2 py-0.5 text-[9px] border rounded-none ${PRIO[selMsg.priority]}`}>{selMsg.priority}</span>
                  <span className={`text-[9px] uppercase ${TYPE_CLR[selMsg.type]}`}>{selMsg.type}</span>
                  <span className="text-[10px] text-white/25">{timeAgo(selMsg.createdAt)}</span>
                </div>
                <div>
                  <div className="text-[10px] text-white/25 uppercase tracking-widest mb-1">Body</div>
                  <div className="text-xs text-[#6c7680] whitespace-pre-wrap leading-relaxed bg-white/[0.02] border border-[#2d363f] rounded-none p-3">{selMsg.body}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setCTo(selMsg.from); setCSubj(`Re: ${selMsg.subject}`); setShowCompose(true); }}
                    className="px-3 py-1.5 text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-none hover:bg-blue-500/30 transition-colors">Reply</button>
                  <button onClick={() => { setCSubj(`Fwd: ${selMsg.subject}`); setCBody(`\n\n--- Forwarded ---\nFrom: ${selMsg.from}\n\n${selMsg.body}`); setShowCompose(true); }}
                    className="px-3 py-1.5 text-[10px] bg-white/5 text-[#4a5159] border border-[#2d363f] rounded-none hover:bg-white/10 transition-colors">Forward</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Compose Modal */}
      <AnimatePresence>
        {showCompose && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCompose(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-[#0f1419] border border-[#2d363f] rounded-none w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white/70">Compose Message</h3>
                <button onClick={() => setShowCompose(false)} className="text-[#4a5159] hover:text-[#6c7680] text-sm">x</button>
              </div>
              <div>
                <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">To</label>
                <select value={cTo} onChange={e => setCTo(e.target.value)} className="w-full bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-white/80 focus:border-blue-500/40 focus:outline-none">
                  <option value="">Select worker...</option>
                  {mailboxes.map(m => <option key={m.workerId} value={m.workerId}>{m.workerName || m.workerId}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Subject</label>
                <input value={cSubj} onChange={e => setCSubj(e.target.value)} className="w-full bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-white/80 focus:border-blue-500/40 focus:outline-none" placeholder="Subject..." />
              </div>
              <div>
                <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Body</label>
                <textarea value={cBody} onChange={e => setCBody(e.target.value)} rows={5} className="w-full bg-[#1a1f26] border border-[#2d363f] rounded-none px-3 py-2 text-xs text-white/80 focus:border-blue-500/40 focus:outline-none resize-none" placeholder="Message body..." />
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Priority</label>
                  <div className="flex gap-1">
                    {(['low', 'normal', 'high', 'critical'] as const).map(p => (
                      <button key={p} onClick={() => setCPri(p)}
                        className={`flex-1 px-2 py-1.5 text-[10px] border rounded-none transition-colors ${cPri === p ? PRIO[p] : 'bg-white/[0.02] text-[#4a5159] border-[#2d363f]'}`}>{p}</button>
                    ))}
                  </div>
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] text-[#4a5159] uppercase tracking-widest mb-1">Type</label>
                  <div className="flex gap-1">
                    {(['info', 'task', 'escalation', 'alert'] as const).map(t => (
                      <button key={t} onClick={() => setCType(t)}
                        className={`flex-1 px-2 py-1.5 text-[10px] border rounded-none transition-colors ${cType === t ? 'bg-white/10 text-white/70 border-white/20' : 'bg-white/[0.02] text-[#4a5159] border-[#2d363f]'}`}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowCompose(false)} className="px-4 py-2 text-xs text-[#4a5159] border border-[#2d363f] rounded-none hover:bg-white/5 transition-colors">Cancel</button>
                <button onClick={sendMail} disabled={sending || !cTo || !cSubj || !cBody}
                  className="px-4 py-2 text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-none hover:bg-blue-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#0f1419]/80 pointer-events-none">
          <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.5, repeat: Infinity }} className="text-xs text-[#4a5159] font-mono">
            Loading mail center...
          </motion.div>
        </div>
      )}
    </div>
  );
}
