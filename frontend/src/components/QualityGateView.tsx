'use client';

/**
 * QualityGateView — GT-032: Quality Gate Inspector
 *
 * Per-item gate detail: typecheck, lint, test, build, coderabbit.
 * Each gate shows status, log output, time taken; re-run / skip actions.
 * Ayu Dark aesthetic: bg-[#0f1419], borders [#2d363f], text [#e6e1cf], font-mono.
 * Polls /api/meow/refinery/queue every 8s for item details.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type GateStatus = 'pass' | 'fail' | 'running' | 'pending';

interface GateRun {
  runId: string;
  status: GateStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  logs: string[];
}

interface GateDetail {
  name: string;
  status: GateStatus;
  durationMs?: number;
  logs: string[];
  history: GateRun[];
}

interface QueueItem {
  id: string;
  branch: string;
  author: string;
  status: string;
  gates: GateDetail[];
  overallVerdict: 'PASS' | 'FAIL' | 'PENDING' | 'RUNNING';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 8000;

const STATUS_CONFIG: Record<GateStatus, { icon: string; color: string; bg: string; label: string }> = {
  pass:    { icon: '\u2713', color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'PASS' },
  fail:    { icon: '\u2717', color: 'text-red-400',     bg: 'bg-red-500/10',     label: 'FAIL' },
  running: { icon: '\u25CB', color: 'text-amber-400',   bg: 'bg-amber-500/10',   label: 'RUNNING' },
  pending: { icon: '\u2500', color: 'text-zinc-500',    bg: 'bg-zinc-500/10',    label: 'PENDING' },
};

const VERDICT_STYLES: Record<string, { color: string; bg: string }> = {
  PASS:    { color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  FAIL:    { color: 'text-red-400',     bg: 'bg-red-500/10' },
  PENDING: { color: 'text-zinc-400',    bg: 'bg-zinc-500/10' },
  RUNNING: { color: 'text-amber-400',   bg: 'bg-amber-500/10' },
};

// ─── Fallback ───────────────────────────────────────────────────────────────

const FALLBACK_ITEMS: QueueItem[] = [
  {
    id: 'q-001', branch: 'feat/payment-gateway', author: 'agent-12', status: 'gating',
    overallVerdict: 'RUNNING',
    gates: [
      {
        name: 'typecheck', status: 'pass', durationMs: 4200,
        logs: ['tsc --noEmit', 'Found 0 errors in 142 files', 'Typecheck completed successfully'],
        history: [
          { runId: 'r-01', status: 'fail', startedAt: new Date(Date.now() - 900000).toISOString(), finishedAt: new Date(Date.now() - 895000).toISOString(), durationMs: 5000, logs: ['error TS2322: Type mismatch'] },
          { runId: 'r-02', status: 'pass', startedAt: new Date(Date.now() - 600000).toISOString(), finishedAt: new Date(Date.now() - 595800).toISOString(), durationMs: 4200, logs: ['Found 0 errors'] },
        ],
      },
      {
        name: 'lint', status: 'pass', durationMs: 1800,
        logs: ['eslint . --ext .ts,.tsx', '0 problems found'],
        history: [{ runId: 'r-03', status: 'pass', startedAt: new Date(Date.now() - 594000).toISOString(), durationMs: 1800, logs: ['0 problems'] }],
      },
      {
        name: 'test', status: 'running',
        logs: ['vitest run --reporter=verbose', 'Running 47 test suites...', 'Suite 31/47 running...'],
        history: [],
      },
      {
        name: 'build', status: 'pending', logs: [], history: [],
      },
      {
        name: 'coderabbit', status: 'pending', logs: [], history: [],
      },
    ],
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '??:??:??'; }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function QualityGateView() {
  const [items, setItems] = useState<QueueItem[]>(FALLBACK_ITEMS);
  const [selectedItemId, setSelectedItemId] = useState<string>(FALLBACK_ITEMS[0]?.id ?? '');
  const [expandedGate, setExpandedGate] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [skipConfirm, setSkipConfirm] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/refinery/queue`, { signal });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.items ?? data.queue ?? [];
        if (list.length > 0) setItems(list);
      }
      setConnected(true);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    fetchData(ac.signal);
    const iv = setInterval(() => fetchData(ac.signal), POLL_INTERVAL);
    return () => { ac.abort(); clearInterval(iv); };
  }, [fetchData]);

  // ─── Actions ────────────────────────────────────────────────────────────

  const handleRerun = useCallback(async (itemId: string, gateName: string) => {
    setActionLoading(`${itemId}-${gateName}-rerun`);
    try {
      await fetch(`${API}/api/meow/refinery/gate/${itemId}?gate=${gateName}`, { method: 'POST' });
      if (abortRef.current) fetchData(abortRef.current.signal);
    } catch { /* noop */ }
    setActionLoading(null);
  }, [fetchData]);

  const handleSkip = useCallback(async (itemId: string, gateName: string) => {
    setActionLoading(`${itemId}-${gateName}-skip`);
    try {
      await fetch(`${API}/api/meow/refinery/gate/${itemId}/skip?gate=${gateName}`, { method: 'POST' });
      if (abortRef.current) fetchData(abortRef.current.signal);
    } catch { /* noop */ }
    setActionLoading(null);
    setSkipConfirm(null);
  }, [fetchData]);

  // ─── Selected ───────────────────────────────────────────────────────────

  const selectedItem = useMemo(
    () => items.find(i => i.id === selectedItemId) ?? items[0],
    [items, selectedItemId]
  );

  const passedCount = useMemo(
    () => selectedItem?.gates.filter(g => g.status === 'pass').length ?? 0,
    [selectedItem]
  );

  const totalGates = selectedItem?.gates.length ?? 0;

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{'\u{1F6E1}'}</span>
          <div>
            <h1 className="text-lg font-bold tracking-wide">QUALITY GATE INSPECTOR</h1>
            <p className="text-xs text-[#4a5159]">GT-032 // Per-item gate detail and control</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-xs text-[#4a5159]">{connected ? 'LIVE' : 'OFFLINE'}</span>
        </div>
      </div>

      {/* Item Selector */}
      <div className="flex gap-2 flex-wrap">
        {items.map(item => (
          <button
            key={item.id}
            onClick={() => setSelectedItemId(item.id)}
            className={`px-3 py-1.5 text-xs border rounded-none transition-colors ${
              selectedItemId === item.id
                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400'
                : 'border-[#2d363f] bg-[#1a1f26] text-[#4a5159] hover:text-[#6c7680]'
            }`}
          >
            {item.branch}
          </button>
        ))}
      </div>

      {selectedItem && (
        <>
          {/* Overall Verdict */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`border border-[#2d363f] rounded-none p-4 ${VERDICT_STYLES[selectedItem.overallVerdict]?.bg ?? 'bg-zinc-500/10'}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-[#4a5159] uppercase tracking-wider">Overall Verdict</div>
                <div className={`text-2xl font-bold mt-1 ${VERDICT_STYLES[selectedItem.overallVerdict]?.color ?? 'text-[#6c7680]'}`}>
                  {selectedItem.overallVerdict}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-[#4a5159]">{passedCount} / {totalGates} gates passed</div>
                <div className="text-xs text-white/20 mt-1">{selectedItem.branch}</div>
              </div>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-1 bg-white/5 rounded-none overflow-hidden">
              <div
                className="h-full bg-emerald-400/50 transition-all duration-500"
                style={{ width: `${totalGates > 0 ? (passedCount / totalGates) * 100 : 0}%` }}
              />
            </div>
          </motion.div>

          {/* Gate List */}
          <div className="space-y-2">
            {selectedItem.gates.map((gate, idx) => {
              const cfg = STATUS_CONFIG[gate.status];
              const isExpanded = expandedGate === gate.name;
              const isHistoryOpen = showHistory === gate.name;
              return (
                <motion.div
                  key={gate.name}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-[#1a1f26] border border-[#2d363f] rounded-none"
                >
                  {/* Gate Header */}
                  <div
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
                    onClick={() => setExpandedGate(isExpanded ? null : gate.name)}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`text-lg font-bold ${cfg.color}`}>{cfg.icon}</span>
                      <div>
                        <span className="text-sm">{gate.name}</span>
                        <span className={`ml-2 text-[10px] px-2 py-0.5 ${cfg.bg} ${cfg.color} border border-current/20 rounded-none`}>
                          {cfg.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {gate.durationMs && (
                        <span className="text-xs text-white/25">{formatDuration(gate.durationMs)}</span>
                      )}
                      <span className="text-white/20 text-xs">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                    </div>
                  </div>

                  {/* Expanded Content */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 space-y-3">
                          {/* Log Output */}
                          {gate.logs.length > 0 && (
                            <div className="bg-[#0f1419] border border-[#2d363f] rounded-none p-3 max-h-48 overflow-y-auto">
                              {gate.logs.map((line, i) => (
                                <div key={i} className="text-[11px] text-[#4a5159] leading-5">
                                  <span className="text-white/15 mr-2">{String(i + 1).padStart(3, ' ')}</span>
                                  {line}
                                </div>
                              ))}
                            </div>
                          )}
                          {gate.logs.length === 0 && (
                            <div className="text-xs text-white/20 py-2">No log output available</div>
                          )}

                          {/* Actions */}
                          <div className="flex items-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRerun(selectedItem.id, gate.name); }}
                              disabled={actionLoading === `${selectedItem.id}-${gate.name}-rerun`}
                              className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded-none hover:bg-cyan-500/20 transition-colors disabled:opacity-40"
                            >
                              {actionLoading === `${selectedItem.id}-${gate.name}-rerun` ? 'Running...' : 'Re-run Gate'}
                            </button>

                            {skipConfirm === gate.name ? (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-amber-400">Confirm skip?</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleSkip(selectedItem.id, gate.name); }}
                                  disabled={actionLoading === `${selectedItem.id}-${gate.name}-skip`}
                                  className="px-2 py-1 text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 rounded-none hover:bg-red-500/20 transition-colors"
                                >
                                  Yes
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setSkipConfirm(null); }}
                                  className="px-2 py-1 text-[10px] bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 rounded-none"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setSkipConfirm(gate.name); }}
                                className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-none hover:bg-amber-500/20 transition-colors"
                              >
                                Skip Gate
                              </button>
                            )}

                            <button
                              onClick={(e) => { e.stopPropagation(); setShowHistory(isHistoryOpen ? null : gate.name); }}
                              className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 rounded-none hover:bg-zinc-500/20 transition-colors"
                            >
                              {isHistoryOpen ? 'Hide History' : 'History'}
                            </button>
                          </div>

                          {/* Run History */}
                          <AnimatePresence>
                            {isHistoryOpen && gate.history.length > 0 && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="overflow-hidden"
                              >
                                <div className="border-t border-[#2d363f] pt-3 mt-2 space-y-2">
                                  <div className="text-[10px] text-white/25 uppercase tracking-wider">Run History</div>
                                  {gate.history.map(run => {
                                    const runCfg = STATUS_CONFIG[run.status];
                                    return (
                                      <div key={run.runId} className="flex items-center gap-3 text-xs py-1">
                                        <span className={`font-bold ${runCfg.color}`}>{runCfg.icon}</span>
                                        <span className="text-[#4a5159]">{formatTime(run.startedAt)}</span>
                                        {run.durationMs && <span className="text-white/20">{formatDuration(run.durationMs)}</span>}
                                        <span className="text-white/15 truncate flex-1">{run.logs[0] ?? ''}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          {isHistoryOpen && gate.history.length === 0 && (
                            <div className="text-xs text-white/20 py-1">No previous runs</div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
