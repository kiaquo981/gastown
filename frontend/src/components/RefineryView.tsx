'use client';

/**
 * RefineryView — Intelligent Merge Queue Dashboard (EP-145)
 *
 * Gas Town's Refinery: merge queue with CI status, rebase strategy,
 * conflict detection, and live event feed.
 *
 * Features:
 *   1. Queue Pipeline — Horizontal stage visualization (QUEUED -> GATING -> REBASING -> MERGING -> MERGED/REJECTED)
 *   2. Merge Queue Table — Full table with CI badges, priority, conflicts, actions
 *   3. Merge Stats Panel — Key metrics with sparkline SVG
 *   4. Conflict Resolver — Per-item conflict detail with rebase controls
 *   5. Enqueue Form — Add new merge items to the queue
 *   6. Live Merge Feed — Real-time event stream
 *
 * Ayu Dark palette:
 *   bg: #0f1419, cards: #1a1f26, text: #e6e1cf, muted: #6c7680
 *   border: #2d363f, green: #c2d94c, yellow: #ffb454, red: #f07178
 *   cyan: #95e6cb, purple: #d2a6ff
 *
 * APIs:
 *   GET  {API}/api/meow/refinery/queue
 *   GET  {API}/api/meow/refinery/stats
 *   GET  {API}/api/meow/refinery/config
 *   POST {API}/api/meow/refinery/enqueue       { branch, author, title, beadId, priority, rebaseStrategy }
 *   POST {API}/api/meow/refinery/process
 *   POST {API}/api/meow/refinery/{id}/approve
 *   POST {API}/api/meow/refinery/{id}/reject
 *   GET  {API}/api/meow/town/pulse              (has refinery section)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type RefineryStage = 'queued' | 'gating' | 'rebasing' | 'merging' | 'merged' | 'rejected';
type RebaseStrategy = 'auto-rebase' | 'manual' | 'fast-forward';
type CICheck = 'pass' | 'fail' | 'pending' | 'running';
type Priority = 0 | 1 | 2 | 3;

interface CIStatus {
  tsc: CICheck;
  lint: CICheck;
  test: CICheck;
  build: CICheck;
}

interface MergeItem {
  id: string;
  branch: string;
  author: string;
  title: string;
  beadId?: string;
  status: RefineryStage;
  priority: Priority;
  rebaseStrategy: RebaseStrategy;
  ci: CIStatus;
  conflictFiles: string[];
  queuedAt: string;
  position: number;
}

interface RefineryStats {
  queueDepth: number;
  mergeRate: number;
  avgWaitTime: number;
  avgGateDuration: number;
  passRate: number;
  throughputHistory: number[];
}

interface MergeFeedEvent {
  id: string;
  type: 'merged' | 'failed' | 'conflict' | 'enqueued' | 'rebased' | 'approved' | 'rejected';
  message: string;
  branch: string;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const STAGES: RefineryStage[] = ['queued', 'gating', 'rebasing', 'merging', 'merged', 'rejected'];

const STAGE_LABELS: Record<RefineryStage, string> = {
  queued: 'QUEUED',
  gating: 'GATING',
  rebasing: 'REBASING',
  merging: 'MERGING',
  merged: 'MERGED',
  rejected: 'REJECTED',
};

const STAGE_COLORS: Record<RefineryStage, string> = {
  queued: '#6c7680',
  gating: '#ffb454',
  rebasing: '#d2a6ff',
  merging: '#95e6cb',
  merged: '#c2d94c',
  rejected: '#f07178',
};

const PRIORITY_CONFIG: Record<Priority, { label: string; color: string; bg: string }> = {
  0: { label: 'CRITICAL', color: '#f07178', bg: 'rgba(240,113,120,0.1)' },
  1: { label: 'HIGH', color: '#ffb454', bg: 'rgba(255,180,84,0.1)' },
  2: { label: 'NORMAL', color: '#95e6cb', bg: 'rgba(149,230,203,0.1)' },
  3: { label: 'LOW', color: '#6c7680', bg: 'rgba(108,118,128,0.1)' },
};

const CI_ICONS: Record<CICheck, { symbol: string; color: string }> = {
  pass: { symbol: '\u2713', color: '#c2d94c' },
  fail: { symbol: '\u2717', color: '#f07178' },
  pending: { symbol: '\u25CB', color: '#6c7680' },
  running: { symbol: '\u25CF', color: '#ffb454' },
};

const FEED_COLORS: Record<MergeFeedEvent['type'], string> = {
  merged: '#c2d94c',
  failed: '#f07178',
  conflict: '#ffb454',
  enqueued: '#95e6cb',
  rebased: '#d2a6ff',
  approved: '#c2d94c',
  rejected: '#f07178',
};

const POLL_INTERVAL = 6000;

// ─── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ─── Sparkline SVG ──────────────────────────────────────────────────────────────

function Sparkline({ data, width = 120, height = 32, color = '#c2d94c' }: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const areaPoints = [...points, `${width},${height}`, `0,${height}`];

  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints.join(' ')} fill="url(#sparkGrad)" />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      {/* Latest point dot */}
      {data.length > 0 && (
        <circle
          cx={width}
          cy={height - ((data[data.length - 1] - min) / range) * (height - 4) - 2}
          r="2"
          fill={color}
        />
      )}
    </svg>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────────

export default function RefineryView() {
  // ── State ───────────────────────────────────────────────────────────────────
  const [queue, setQueue] = useState<MergeItem[]>([]);
  const [stats, setStats] = useState<RefineryStats | null>(null);
  const [feed, setFeed] = useState<MergeFeedEvent[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [showEnqueueForm, setShowEnqueueForm] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Enqueue form state
  const [formBranch, setFormBranch] = useState('');
  const [formAuthor, setFormAuthor] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formBeadId, setFormBeadId] = useState('');
  const [formPriority, setFormPriority] = useState<Priority>(2);
  const [formStrategy, setFormStrategy] = useState<RebaseStrategy>('auto-rebase');

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/refinery/queue`);
      if (res.ok) {
        const data = await res.json();
        const items: MergeItem[] = Array.isArray(data) ? data : (data.queue || data.items || []);
        setQueue(items.map((item: MergeItem, idx: number) => ({
          ...item,
          position: item.position ?? idx + 1,
          ci: item.ci ?? { tsc: 'pending', lint: 'pending', test: 'pending', build: 'pending' },
          conflictFiles: item.conflictFiles ?? [],
          rebaseStrategy: item.rebaseStrategy ?? 'auto-rebase',
          priority: item.priority ?? 2,
        })));
      }
    } catch {
      // Network error — keep existing state
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/refinery/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats({
          queueDepth: data.queueDepth ?? queue.length,
          mergeRate: data.mergeRate ?? 0,
          avgWaitTime: data.avgWaitTime ?? 0,
          avgGateDuration: data.avgGateDuration ?? 0,
          passRate: data.passRate ?? 0,
          throughputHistory: data.throughputHistory ?? [],
        });
      }
    } catch {
      // silent
    }
  }, [queue.length]);

  const fetchPulse = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/town/pulse`);
      if (res.ok) {
        const data = await res.json();
        if (data.refinery?.events) {
          setFeed(prev => {
            const existingIds = new Set(prev.map(e => e.id));
            const newEvents = (data.refinery.events as MergeFeedEvent[]).filter(e => !existingIds.has(e.id));
            return [...newEvents, ...prev].slice(0, 50);
          });
        }
      }
    } catch {
      // silent
    }
  }, []);

  const fetchAll = useCallback(async () => {
    await Promise.allSettled([fetchQueue(), fetchStats(), fetchPulse()]);
  }, [fetchQueue, fetchStats, fetchPulse]);

  useEffect(() => {
    fetchAll();
    if (!autoRefresh) return;
    const iv = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(iv);
  }, [fetchAll, autoRefresh]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch(`${API}/api/meow/refinery/${id}/approve`, { method: 'POST' });
      await fetchQueue();
      addLocalFeedEvent('approved', `Merge gate approved`, queue.find(q => q.id === id)?.branch || id);
    } catch { /* silent */ }
    setActionLoading(null);
  };

  const handleReject = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch(`${API}/api/meow/refinery/${id}/reject`, { method: 'POST' });
      await fetchQueue();
      addLocalFeedEvent('rejected', `Merge rejected`, queue.find(q => q.id === id)?.branch || id);
    } catch { /* silent */ }
    setActionLoading(null);
  };

  const handleProcess = async () => {
    setActionLoading('process');
    try {
      await fetch(`${API}/api/meow/refinery/process`, { method: 'POST' });
      await fetchQueue();
      addLocalFeedEvent('merged', `Queue processed — next item advanced`, 'refinery');
    } catch { /* silent */ }
    setActionLoading(null);
  };

  const handleEnqueue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formBranch.trim() || !formTitle.trim()) return;
    setActionLoading('enqueue');
    try {
      await fetch(`${API}/api/meow/refinery/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: formBranch.trim(),
          author: formAuthor.trim() || 'anonymous',
          title: formTitle.trim(),
          beadId: formBeadId.trim() || undefined,
          priority: formPriority,
          rebaseStrategy: formStrategy,
        }),
      });
      addLocalFeedEvent('enqueued', `Branch enqueued: ${formBranch.trim()}`, formBranch.trim());
      setFormBranch('');
      setFormAuthor('');
      setFormTitle('');
      setFormBeadId('');
      setFormPriority(2);
      setFormStrategy('auto-rebase');
      setShowEnqueueForm(false);
      await fetchQueue();
    } catch { /* silent */ }
    setActionLoading(null);
  };

  const addLocalFeedEvent = (type: MergeFeedEvent['type'], message: string, branch: string) => {
    const event: MergeFeedEvent = {
      id: `local-${Date.now()}`,
      type,
      message,
      branch,
      timestamp: new Date().toISOString(),
    };
    setFeed(prev => [event, ...prev].slice(0, 50));
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const stageCounts = useMemo(() => {
    const counts: Record<RefineryStage, number> = {
      queued: 0, gating: 0, rebasing: 0, merging: 0, merged: 0, rejected: 0,
    };
    queue.forEach(item => { counts[item.status] = (counts[item.status] || 0) + 1; });
    return counts;
  }, [queue]);

  const conflictItems = useMemo(
    () => queue.filter(item => item.conflictFiles.length > 0),
    [queue],
  );

  const activeQueue = useMemo(
    () => queue.filter(item => item.status !== 'merged' && item.status !== 'rejected'),
    [queue],
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-[#0f1419] text-[#e6e1cf] font-mono overflow-hidden">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#2d363f]">
        <div className="flex items-center gap-4">
          <h1 className="text-sm uppercase tracking-[0.2em] text-[#e6e1cf]">
            Refinery
          </h1>
          <span className="text-[10px] text-[#6c7680]">MERGE QUEUE</span>
          <span className="text-[10px] text-[#95e6cb]">{activeQueue.length} active</span>
          {conflictItems.length > 0 && (
            <span className="text-[10px] text-[#f07178]">{conflictItems.length} conflicts</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEnqueueForm(!showEnqueueForm)}
            className="px-3 py-1 text-[10px] uppercase tracking-wider border border-[#2d363f] text-[#95e6cb] hover:bg-[#95e6cb]/10 transition-colors"
          >
            + Enqueue
          </button>
          <button
            onClick={handleProcess}
            disabled={actionLoading === 'process'}
            className="px-3 py-1 text-[10px] uppercase tracking-wider border border-[#2d363f] text-[#d2a6ff] hover:bg-[#d2a6ff]/10 transition-colors disabled:opacity-40"
          >
            {actionLoading === 'process' ? 'Processing...' : 'Process Next'}
          </button>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1 text-[10px] ${autoRefresh ? 'text-[#c2d94c]' : 'text-[#6c7680]'}`}
          >
            {autoRefresh ? '\u25CF LIVE' : '\u25CB PAUSED'}
          </button>
        </div>
      </div>

      {/* ── Main content scroll area ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">

        {/* ── Queue Pipeline ────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-b border-[#2d363f]">
          <div className="text-[10px] uppercase tracking-wider text-[#6c7680] mb-3">Pipeline Stages</div>
          <div className="flex items-center gap-1">
            {STAGES.map((stage, i) => {
              const count = stageCounts[stage];
              const color = STAGE_COLORS[stage];
              const isTerminal = stage === 'merged' || stage === 'rejected';
              return (
                <div key={stage} className="flex items-center">
                  <motion.div
                    className="relative flex flex-col items-center justify-center px-5 py-3 border border-[#2d363f]"
                    style={{
                      backgroundColor: count > 0 ? `${color}08` : '#1a1f26',
                      borderColor: count > 0 ? `${color}30` : '#2d363f',
                      minWidth: 100,
                    }}
                    whileHover={{ scale: 1.02 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                  >
                    <span className="text-[10px] uppercase tracking-wider" style={{ color: count > 0 ? color : '#6c7680' }}>
                      {STAGE_LABELS[stage]}
                    </span>
                    <motion.span
                      className="text-lg font-bold mt-0.5"
                      style={{ color }}
                      key={count}
                      initial={{ scale: 1.3, opacity: 0.5 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      {count}
                    </motion.span>
                    {/* Pulse indicator for active stages */}
                    {count > 0 && !isTerminal && (
                      <motion.div
                        className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      />
                    )}
                  </motion.div>
                  {/* Arrow connector */}
                  {i < STAGES.length - 1 && (
                    <div className="flex items-center px-1">
                      <svg width="16" height="12" viewBox="0 0 16 12" className="block">
                        <path d="M0 6 L12 6 M8 2 L12 6 L8 10" stroke="#2d363f" strokeWidth="1.5" fill="none" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Stats Panel ───────────────────────────────────────────────────── */}
        {stats && (
          <div className="px-6 py-4 border-b border-[#2d363f]">
            <div className="text-[10px] uppercase tracking-wider text-[#6c7680] mb-3">Merge Statistics</div>
            <div className="grid grid-cols-6 gap-3">
              <StatCard label="Queue Depth" value={String(stats.queueDepth)} color="#95e6cb" />
              <StatCard label="Merge Rate" value={`${stats.mergeRate.toFixed(1)}/hr`} color="#c2d94c" />
              <StatCard label="Avg Wait" value={formatDuration(stats.avgWaitTime)} color="#ffb454" />
              <StatCard label="Avg Gate" value={formatDuration(stats.avgGateDuration)} color="#d2a6ff" />
              <StatCard label="Pass Rate" value={`${Math.round(stats.passRate)}%`} color={stats.passRate >= 80 ? '#c2d94c' : stats.passRate >= 50 ? '#ffb454' : '#f07178'} />
              <div className="bg-[#1a1f26] border border-[#2d363f] px-3 py-2">
                <div className="text-[10px] text-[#6c7680] mb-1">Throughput</div>
                {stats.throughputHistory.length >= 2 ? (
                  <Sparkline data={stats.throughputHistory} color="#c2d94c" width={100} height={28} />
                ) : (
                  <div className="text-[10px] text-[#6c7680]">--</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Enqueue Form ──────────────────────────────────────────────────── */}
        <AnimatePresence>
          {showEnqueueForm && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden border-b border-[#2d363f]"
            >
              <form onSubmit={handleEnqueue} className="px-6 py-4">
                <div className="text-[10px] uppercase tracking-wider text-[#6c7680] mb-3">Enqueue Merge Item</div>
                <div className="grid grid-cols-6 gap-3">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-[#6c7680] mb-1">Branch *</label>
                    <input
                      value={formBranch}
                      onChange={e => setFormBranch(e.target.value)}
                      placeholder="feat/my-feature"
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] placeholder-[#6c7680]/50 focus:border-[#95e6cb]/50 focus:outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#6c7680] mb-1">Author</label>
                    <input
                      value={formAuthor}
                      onChange={e => setFormAuthor(e.target.value)}
                      placeholder="worker-name"
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] placeholder-[#6c7680]/50 focus:border-[#95e6cb]/50 focus:outline-none"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-[10px] text-[#6c7680] mb-1">Title *</label>
                    <input
                      value={formTitle}
                      onChange={e => setFormTitle(e.target.value)}
                      placeholder="Implement feature X"
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] placeholder-[#6c7680]/50 focus:border-[#95e6cb]/50 focus:outline-none"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#6c7680] mb-1">Bead ID</label>
                    <input
                      value={formBeadId}
                      onChange={e => setFormBeadId(e.target.value)}
                      placeholder="bead-xxx"
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] placeholder-[#6c7680]/50 focus:border-[#95e6cb]/50 focus:outline-none"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-6 gap-3 mt-3">
                  <div>
                    <label className="block text-[10px] text-[#6c7680] mb-1">Priority</label>
                    <select
                      value={formPriority}
                      onChange={e => setFormPriority(Number(e.target.value) as Priority)}
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] focus:border-[#95e6cb]/50 focus:outline-none"
                    >
                      <option value={0}>Critical</option>
                      <option value={1}>High</option>
                      <option value={2}>Normal</option>
                      <option value={3}>Low</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#6c7680] mb-1">Rebase Strategy</label>
                    <select
                      value={formStrategy}
                      onChange={e => setFormStrategy(e.target.value as RebaseStrategy)}
                      className="w-full bg-[#1a1f26] border border-[#2d363f] px-3 py-1.5 text-xs text-[#e6e1cf] focus:border-[#95e6cb]/50 focus:outline-none"
                    >
                      <option value="auto-rebase">Auto-rebase</option>
                      <option value="manual">Manual</option>
                      <option value="fast-forward">Fast-forward</option>
                    </select>
                  </div>
                  <div className="col-span-4 flex items-end justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowEnqueueForm(false)}
                      className="px-4 py-1.5 text-[10px] uppercase tracking-wider border border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={actionLoading === 'enqueue'}
                      className="px-4 py-1.5 text-[10px] uppercase tracking-wider border border-[#c2d94c]/30 text-[#c2d94c] hover:bg-[#c2d94c]/10 transition-colors disabled:opacity-40"
                    >
                      {actionLoading === 'enqueue' ? 'Enqueuing...' : 'Enqueue'}
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Main grid: Queue Table + Sidebar ─────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Queue Table ──────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto border-r border-[#2d363f]">
            <div className="px-6 py-3 border-b border-[#2d363f]">
              <div className="text-[10px] uppercase tracking-wider text-[#6c7680]">
                Merge Queue ({queue.length} items)
              </div>
            </div>

            {/* Table header */}
            <div className="grid grid-cols-[40px_1fr_100px_80px_160px_90px_80px_60px_120px] gap-px px-4 py-2 border-b border-[#2d363f] text-[9px] uppercase tracking-wider text-[#6c7680]">
              <div>#</div>
              <div>Branch / Title</div>
              <div>Author</div>
              <div>Priority</div>
              <div className="text-center">CI Status</div>
              <div>Strategy</div>
              <div>Conflicts</div>
              <div>Time</div>
              <div className="text-right">Actions</div>
            </div>

            {/* Table rows */}
            {queue.length === 0 && (
              <div className="px-6 py-12 text-center text-[#6c7680] text-xs">
                Merge queue is empty. Use the Enqueue button to add items.
              </div>
            )}

            <AnimatePresence>
              {queue.map((item) => {
                const isSelected = selectedItem === item.id;
                const prio = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG[2];
                const stageColor = STAGE_COLORS[item.status];
                const hasConflicts = item.conflictFiles.length > 0;

                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 10 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Main row */}
                    <div
                      className={`grid grid-cols-[40px_1fr_100px_80px_160px_90px_80px_60px_120px] gap-px px-4 py-2.5 border-b border-[#2d363f]/50 cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#1a1f26]' : 'hover:bg-[#1a1f26]/50'
                      } ${hasConflicts ? 'border-l-2' : ''}`}
                      style={hasConflicts ? { borderLeftColor: '#f07178' } : undefined}
                      onClick={() => setSelectedItem(isSelected ? null : item.id)}
                    >
                      {/* Position */}
                      <div className="text-xs text-[#6c7680]">
                        {item.position}
                      </div>

                      {/* Branch + Title */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block px-1.5 py-0.5 text-[9px] uppercase tracking-wider border"
                            style={{ color: stageColor, borderColor: `${stageColor}30`, backgroundColor: `${stageColor}08` }}
                          >
                            {STAGE_LABELS[item.status]}
                          </span>
                          <span className="text-xs text-[#e6e1cf] truncate">{item.title}</span>
                        </div>
                        <div className="text-[10px] text-[#6c7680] mt-0.5 truncate">
                          {item.branch}
                          {item.beadId && (
                            <span className="ml-2 text-[#d2a6ff]">[{item.beadId}]</span>
                          )}
                        </div>
                      </div>

                      {/* Author */}
                      <div className="text-[10px] text-[#6c7680] flex items-center">{item.author}</div>

                      {/* Priority */}
                      <div className="flex items-center">
                        <span
                          className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider border"
                          style={{ color: prio.color, borderColor: `${prio.color}30`, backgroundColor: prio.bg }}
                        >
                          {prio.label}
                        </span>
                      </div>

                      {/* CI Status badges */}
                      <div className="flex items-center justify-center gap-2">
                        {(['tsc', 'lint', 'test', 'build'] as const).map(check => {
                          const status = item.ci?.[check] || 'pending';
                          const cfg = CI_ICONS[status];
                          return (
                            <div
                              key={check}
                              className="flex items-center gap-0.5"
                              title={`${check}: ${status}`}
                            >
                              <span className="text-[10px]" style={{ color: cfg.color }}>{cfg.symbol}</span>
                              <span className="text-[8px] uppercase text-[#6c7680]">{check}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Rebase Strategy */}
                      <div className="flex items-center">
                        <span className="text-[10px] text-[#d2a6ff]">{item.rebaseStrategy}</span>
                      </div>

                      {/* Conflicts */}
                      <div className="flex items-center">
                        {hasConflicts ? (
                          <span className="text-[10px] text-[#f07178]">{item.conflictFiles.length} files</span>
                        ) : (
                          <span className="text-[10px] text-[#6c7680]">none</span>
                        )}
                      </div>

                      {/* Time in queue */}
                      <div className="flex items-center text-[10px] text-[#6c7680]">
                        {timeAgo(item.queuedAt)}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                        {(item.status === 'gating' || item.status === 'queued') && (
                          <>
                            <button
                              onClick={() => handleApprove(item.id)}
                              disabled={actionLoading === item.id}
                              className="px-2 py-0.5 text-[9px] uppercase border border-[#c2d94c]/20 text-[#c2d94c] hover:bg-[#c2d94c]/10 transition-colors disabled:opacity-40"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleReject(item.id)}
                              disabled={actionLoading === item.id}
                              className="px-2 py-0.5 text-[9px] uppercase border border-[#f07178]/20 text-[#f07178] hover:bg-[#f07178]/10 transition-colors disabled:opacity-40"
                            >
                              Reject
                            </button>
                          </>
                        )}
                        {item.status === 'merged' && (
                          <span className="text-[9px] text-[#c2d94c]">\u2713 Done</span>
                        )}
                        {item.status === 'rejected' && (
                          <span className="text-[9px] text-[#f07178]">\u2717 Rejected</span>
                        )}
                      </div>
                    </div>

                    {/* Expanded conflict resolver */}
                    <AnimatePresence>
                      {isSelected && hasConflicts && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden bg-[#1a1f26] border-b border-[#2d363f]"
                        >
                          <ConflictResolver
                            item={item}
                            onRebase={async (id, strategy) => {
                              setActionLoading(id);
                              try {
                                await fetch(`${API}/api/meow/refinery/enqueue`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    branch: item.branch,
                                    author: item.author,
                                    title: item.title,
                                    beadId: item.beadId,
                                    priority: item.priority,
                                    rebaseStrategy: strategy,
                                  }),
                                });
                                addLocalFeedEvent('rebased', `Rebase triggered (${strategy}): ${item.branch}`, item.branch);
                                await fetchQueue();
                              } catch { /* silent */ }
                              setActionLoading(null);
                            }}
                            loading={actionLoading === item.id}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Expanded detail for selected items without conflicts */}
                    <AnimatePresence>
                      {isSelected && !hasConflicts && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden bg-[#1a1f26] border-b border-[#2d363f] px-6 py-3"
                        >
                          <div className="grid grid-cols-4 gap-4 text-[10px]">
                            <div>
                              <span className="text-[#6c7680]">Branch:</span>{' '}
                              <span className="text-[#e6e1cf]">{item.branch}</span>
                            </div>
                            <div>
                              <span className="text-[#6c7680]">Bead:</span>{' '}
                              <span className="text-[#d2a6ff]">{item.beadId || 'none'}</span>
                            </div>
                            <div>
                              <span className="text-[#6c7680]">Strategy:</span>{' '}
                              <span className="text-[#95e6cb]">{item.rebaseStrategy}</span>
                            </div>
                            <div>
                              <span className="text-[#6c7680]">Queued:</span>{' '}
                              <span className="text-[#e6e1cf]">{new Date(item.queuedAt).toLocaleString()}</span>
                            </div>
                          </div>
                          <div className="mt-2 flex gap-3">
                            {(['tsc', 'lint', 'test', 'build'] as const).map(check => {
                              const status = item.ci?.[check] || 'pending';
                              const cfg = CI_ICONS[status];
                              return (
                                <div key={check} className="flex items-center gap-1 px-2 py-1 border border-[#2d363f]">
                                  <span style={{ color: cfg.color }}>{cfg.symbol}</span>
                                  <span className="text-[10px] uppercase text-[#6c7680]">{check}</span>
                                  <span className="text-[10px]" style={{ color: cfg.color }}>{status}</span>
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>

          {/* ── Sidebar: Live Merge Feed ──────────────────────────────────────── */}
          <div className="w-[300px] flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-[#2d363f] flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-[#6c7680]">Live Feed</span>
              <span className="text-[10px] text-[#6c7680]">{feed.length} events</span>
            </div>
            <div ref={feedRef} className="flex-1 overflow-auto">
              {feed.length === 0 && (
                <div className="px-4 py-8 text-center text-[#6c7680] text-[10px]">
                  No events yet. Merge activity will appear here.
                </div>
              )}
              <AnimatePresence initial={false}>
                {feed.map((event) => (
                  <motion.div
                    key={event.id}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.15 }}
                    className="px-4 py-2.5 border-b border-[#2d363f]/50 hover:bg-[#1a1f26]/50 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <div
                        className="w-1.5 h-1.5 mt-1 flex-shrink-0"
                        style={{ backgroundColor: FEED_COLORS[event.type] || '#6c7680' }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-[#e6e1cf] leading-tight">{event.message}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[9px] truncate" style={{ color: FEED_COLORS[event.type] }}>
                            {event.branch}
                          </span>
                          <span className="text-[9px] text-[#6c7680] flex-shrink-0">
                            {timeAgo(event.timestamp)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] px-3 py-2">
      <div className="text-[10px] text-[#6c7680]">{label}</div>
      <div className="text-sm font-bold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function ConflictResolver({ item, onRebase, loading }: {
  item: MergeItem;
  onRebase: (id: string, strategy: RebaseStrategy) => Promise<void>;
  loading: boolean;
}) {
  const [selectedStrategy, setSelectedStrategy] = useState<RebaseStrategy>(item.rebaseStrategy);

  return (
    <div className="px-6 py-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 bg-[#f07178]" />
        <span className="text-[10px] uppercase tracking-wider text-[#f07178]">
          Conflict Resolution — {item.conflictFiles.length} conflicting files
        </span>
      </div>

      {/* Conflicting files list */}
      <div className="mb-3 space-y-1">
        {item.conflictFiles.map((file, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-[#0f1419] border border-[#f07178]/10">
            <span className="text-[10px] text-[#f07178]">\u2717</span>
            <span className="text-[10px] text-[#e6e1cf] font-mono">{file}</span>
          </div>
        ))}
      </div>

      {/* Strategy selector + actions */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#6c7680]">Strategy:</span>
          <select
            value={selectedStrategy}
            onChange={e => setSelectedStrategy(e.target.value as RebaseStrategy)}
            className="bg-[#0f1419] border border-[#2d363f] px-2 py-1 text-[10px] text-[#e6e1cf] focus:border-[#d2a6ff]/50 focus:outline-none"
          >
            <option value="auto-rebase">Auto-rebase</option>
            <option value="manual">Manual</option>
            <option value="fast-forward">Fast-forward</option>
          </select>
        </div>
        <button
          onClick={() => onRebase(item.id, selectedStrategy)}
          disabled={loading}
          className="px-3 py-1 text-[9px] uppercase tracking-wider border border-[#d2a6ff]/20 text-[#d2a6ff] hover:bg-[#d2a6ff]/10 transition-colors disabled:opacity-40"
        >
          {loading ? 'Rebasing...' : 'Force Rebase'}
        </button>
        <button
          onClick={() => onRebase(item.id, 'manual')}
          disabled={loading}
          className="px-3 py-1 text-[9px] uppercase tracking-wider border border-[#ffb454]/20 text-[#ffb454] hover:bg-[#ffb454]/10 transition-colors disabled:opacity-40"
        >
          Manual
        </button>
        <button
          disabled={loading}
          className="px-3 py-1 text-[9px] uppercase tracking-wider border border-[#6c7680]/20 text-[#6c7680] hover:bg-[#6c7680]/10 transition-colors disabled:opacity-40"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
