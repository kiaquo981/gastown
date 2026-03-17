'use client';

/**
 * PatrolView — Patrol Reports Dashboard (EP-146)
 * View patrol reports from automated checks, inspections, and audits
 */

import { useState, useEffect, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || 'http://localhost:3001';

interface PatrolCheck {
  name: string;
  passed: boolean;
  details?: string;
}

interface PatrolReport {
  id: string;
  owner: string;
  timestamp: string;
  checks: PatrolCheck[];
  summary?: string;
  passRate: number;
}

export default function PatrolView() {
  const [reports, setReports] = useState<PatrolReport[]>([]);
  const [selectedOwner, setSelectedOwner] = useState<string>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const url = selectedOwner === 'all'
        ? `${API}/api/meow/patrols?limit=100`
        : `${API}/api/meow/patrols?owner=${selectedOwner}&limit=100`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const rawReports = data.reports || [];
        setReports(rawReports.map((r: any) => ({
          ...r,
          passRate: r.checks?.length
            ? Math.round((r.checks.filter((c: PatrolCheck) => c.passed).length / r.checks.length) * 100)
            : 0,
        })));
      }
    } catch { /* silent */ }
  }, [selectedOwner]);

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const iv = setInterval(fetchData, 10000);
    return () => clearInterval(iv);
  }, [fetchData, autoRefresh]);

  const owners = [...new Set(reports.map(r => r.owner))];
  const avgPassRate = reports.length > 0
    ? Math.round(reports.reduce((sum, r) => sum + r.passRate, 0) / reports.length)
    : 0;

  const rateColor = (rate: number) =>
    rate >= 90 ? 'text-emerald-400' : rate >= 60 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm uppercase tracking-widest text-slate-300">Patrol Reports</h1>
          <span className={`font-mono text-xs ${rateColor(avgPassRate)}`}>
            AVG {avgPassRate}% pass
          </span>
          <span className="font-mono text-xs text-slate-500">{reports.length} reports</span>
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`px-2 py-1 font-mono text-[10px] ${autoRefresh ? 'text-emerald-400' : 'text-slate-500'}`}
        >
          {autoRefresh ? '● LIVE' : '○ PAUSED'}
        </button>
      </div>

      {/* Owner filter */}
      <div className="flex gap-2 px-6 py-3 border-b border-white/5 overflow-x-auto">
        <button
          onClick={() => setSelectedOwner('all')}
          className={`px-2 py-0.5 font-mono text-[10px] uppercase border shrink-0 ${
            selectedOwner === 'all' ? 'border-white/20 text-white bg-white/5' : 'border-transparent text-slate-600 hover:text-slate-400'
          }`}
        >
          all
        </button>
        {owners.map(o => (
          <button
            key={o}
            onClick={() => setSelectedOwner(o)}
            className={`px-2 py-0.5 font-mono text-[10px] uppercase border shrink-0 ${
              selectedOwner === o ? 'border-white/20 text-white bg-white/5' : 'border-transparent text-slate-600 hover:text-slate-400'
            }`}
          >
            {o}
          </button>
        ))}
      </div>

      {/* Reports */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {reports.length === 0 && (
          <div className="text-center text-slate-600 font-mono text-xs py-12">No patrol reports yet</div>
        )}
        {reports.map(r => (
          <div key={r.id} className="border border-white/5 bg-[#0d1117] px-5 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-slate-300">{r.owner}</span>
                <span className={`font-mono text-sm font-bold ${rateColor(r.passRate)}`}>
                  {r.passRate}%
                </span>
              </div>
              <span className="font-mono text-[10px] text-slate-600">
                {new Date(r.timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            {r.summary && (
              <div className="mt-2 font-mono text-[10px] text-slate-500">{r.summary}</div>
            )}

            {/* Checks grid */}
            <div className="mt-3 grid grid-cols-2 gap-1">
              {(r.checks || []).map((c, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1">
                  <span className={`font-mono text-[10px] ${c.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                    {c.passed ? '✓' : '✗'}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">{c.name}</span>
                </div>
              ))}
            </div>

            {/* Pass rate bar */}
            <div className="mt-3 h-1 bg-white/5">
              <div
                className={`h-full ${r.passRate >= 90 ? 'bg-emerald-500' : r.passRate >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ width: `${r.passRate}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
