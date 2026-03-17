'use client';

/**
 * RefineryView — Merge Queue Dashboard (EP-145)
 * Visualize merge queue, conflict resolution, integration status
 */

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || 'http://localhost:3001';

interface MergeItem {
  id: string;
  branch: string;
  author: string;
  title: string;
  status: 'queued' | 'testing' | 'approved' | 'merged' | 'blocked';
  priority: number;
  checksPass: number;
  checksTotal: number;
  conflictFiles: string[];
  queuedAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  testing: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  merged: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
};

export default function RefineryView() {
  const [items, setItems] = useState<MergeItem[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/observability/stats`);
      if (res.ok) {
        const data = await res.json();
        if (data.mergeQueue) {
          setItems(data.mergeQueue);
        } else {
          // Demo merge queue from MEOW context
          setItems([
            { id: 'mr-1', branch: 'feat/wave-6-observability', author: 'ObservabilityEngine', title: 'Townlog + Health Score + Error Trending', status: 'testing', priority: 1, checksPass: 3, checksTotal: 5, conflictFiles: [], queuedAt: new Date(Date.now() - 1200000).toISOString() },
            { id: 'mr-2', branch: 'feat/hooks-frankflow', author: 'HooksEngine', title: 'FrankFlow 12 builtin hooks + pattern learner', status: 'approved', priority: 2, checksPass: 5, checksTotal: 5, conflictFiles: [], queuedAt: new Date(Date.now() - 2400000).toISOString() },
            { id: 'mr-3', branch: 'feat/workspace-gov', author: 'WorkspaceGovernor', title: '5-level CLAUDE.md hierarchy + audit', status: 'queued', priority: 3, checksPass: 2, checksTotal: 5, conflictFiles: [], queuedAt: new Date(Date.now() - 3600000).toISOString() },
            { id: 'mr-4', branch: 'fix/molecule-phase-edge', author: 'MoleculeEngine', title: 'Fix ICE9→SOLID transition edge case', status: 'blocked', priority: 4, checksPass: 1, checksTotal: 5, conflictFiles: ['src/meow/molecule.ts', 'src/meow/phase.ts'], queuedAt: new Date(Date.now() - 4800000).toISOString() },
            { id: 'mr-5', branch: 'feat/crew-hierarchy', author: 'CrewManager', title: 'Mayor→Witness→Polecat worker hierarchy', status: 'merged', priority: 5, checksPass: 5, checksTotal: 5, conflictFiles: [], queuedAt: new Date(Date.now() - 7200000).toISOString() },
          ]);
        }
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const iv = setInterval(fetchData, 8000);
    return () => clearInterval(iv);
  }, [fetchData, autoRefresh]);

  const filtered = filterStatus === 'all' ? items : items.filter(i => i.status === filterStatus);
  const queuedCount = items.filter(i => i.status === 'queued' || i.status === 'testing').length;
  const blockedCount = items.filter(i => i.status === 'blocked').length;

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm uppercase tracking-widest text-slate-300">Refinery — Merge Queue</h1>
          <span className="font-mono text-xs text-blue-400">{queuedCount} in queue</span>
          {blockedCount > 0 && (
            <span className="font-mono text-xs text-red-400">{blockedCount} blocked</span>
          )}
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`px-2 py-1 font-mono text-[10px] ${autoRefresh ? 'text-emerald-400' : 'text-slate-500'}`}
        >
          {autoRefresh ? '● LIVE' : '○ PAUSED'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-6 py-3 border-b border-white/5">
        {['all', 'queued', 'testing', 'approved', 'merged', 'blocked'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-2 py-0.5 font-mono text-[10px] uppercase border ${
              filterStatus === s ? 'border-white/20 text-white bg-white/5' : 'border-transparent text-slate-600 hover:text-slate-400'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Queue */}
      <div className="flex-1 overflow-auto p-4 space-y-2">
        {filtered.length === 0 && (
          <div className="text-center text-slate-600 font-mono text-xs py-12">Merge queue is empty</div>
        )}
        {filtered.map((item, idx) => (
          <div key={item.id} className={`border border-white/5 bg-[#0d1117] px-5 py-4 ${item.status === 'blocked' ? 'border-l-2 border-l-red-500' : ''}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-slate-600">#{idx + 1}</span>
                <span className={`px-2 py-0.5 font-mono text-[10px] uppercase border ${STATUS_STYLES[item.status]}`}>
                  {item.status}
                </span>
                <span className="font-mono text-sm text-white">{item.title}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-500">{item.checksPass}/{item.checksTotal} checks</span>
                {/* Progress dots */}
                <div className="flex gap-0.5">
                  {Array.from({ length: item.checksTotal }).map((_, i) => (
                    <div key={i} className={`w-1.5 h-1.5 ${i < item.checksPass ? 'bg-emerald-500' : 'bg-white/10'}`} />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-4 font-mono text-[10px] text-slate-600">
              <span>{item.branch}</span>
              <span>by {item.author}</span>
              <span>Queued {item.queuedAt ? new Date(item.queuedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'N/A'}</span>
            </div>
            {(item.conflictFiles ?? []).length > 0 && (
              <div className="mt-2 px-2 py-1 bg-red-500/5 border border-red-500/10">
                <span className="font-mono text-[10px] text-red-400">Conflicts: {(item.conflictFiles ?? []).join(', ')}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
