'use client';

/**
 * MoleculeView — DAG-based molecule dashboard for the MEOW Engine
 * Shows molecules by phase, step progress, activity feed, and cook interface.
 */

import { useState, useEffect, useCallback } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

/* ---------- Types ---------- */

type MoleculePhase = 'ice9' | 'solid' | 'liquid' | 'vapor';
type MoleculeStatus = 'active' | 'completed' | 'failed' | 'paused';
type StepStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

interface MoleculeStep {
  id: string;
  name: string;
  status: StepStatus;
  assignee?: string;
  beadId?: string;
  startedAt?: string;
  completedAt?: string;
  dependsOn?: string[];
}

interface Molecule {
  id: string;
  name: string;
  formulaName: string;
  phase: MoleculePhase;
  status: MoleculeStatus;
  steps: MoleculeStep[];
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

interface FeedEvent {
  id: string;
  type: string;
  message: string;
  moleculeId?: string;
  stepId?: string;
  timestamp: string;
  actor?: string;
}

interface Convoy {
  id: string;
  name: string;
  moleculeIds: string[];
  status: string;
  createdAt?: string;
}

/* ---------- Constants ---------- */

const PHASE_CONFIG: Record<MoleculePhase, { label: string; color: string; icon: string }> = {
  ice9:   { label: 'ICE-9',  color: 'cyan',    icon: '&#x2744;' },   // snowflake
  solid:  { label: 'SOLID',  color: 'blue',    icon: '&#x25A0;' },   // square
  liquid: { label: 'LIQUID', color: 'emerald', icon: '&#x223F;' },   // sine wave
  vapor:  { label: 'VAPOR',  color: 'violet',  icon: '&#x2601;' },   // cloud
};

const PHASE_BADGE: Record<MoleculePhase, string> = {
  ice9:   'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  solid:  'bg-blue-500/20 text-blue-400 border-blue-500/30',
  liquid: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  vapor:  'bg-violet-500/20 text-violet-400 border-violet-500/30',
};

const STATUS_CONFIG: Record<MoleculeStatus, { label: string; cls: string }> = {
  active:    { label: 'Active',    cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' },
  completed: { label: 'Completed', cls: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  failed:    { label: 'Failed',    cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
  paused:    { label: 'Paused',    cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
};

const STEP_STATUS_COLOR: Record<StepStatus, string> = {
  pending: 'bg-zinc-500/30 border-zinc-500/20',
  ready:   'bg-blue-500/30 border-blue-500/20',
  running: 'bg-amber-500/30 border-amber-500/20 animate-pulse',
  done:    'bg-emerald-500/30 border-emerald-500/20',
  failed:  'bg-red-500/30 border-red-500/20',
  skipped: 'bg-zinc-500/10 border-zinc-500/10',
};

const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'text-zinc-400',
  ready:   'text-blue-400',
  running: 'text-amber-400',
  done:    'text-emerald-400',
  failed:  'text-red-400',
  skipped: 'text-zinc-500',
};

/* ---------- Component ---------- */

export default function MoleculeView() {
  const [molecules, setMolecules] = useState<Molecule[]>([]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterPhase, setFilterPhase] = useState<MoleculePhase | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<MoleculeStatus | 'all'>('all');
  const [selectedMolecule, setSelectedMolecule] = useState<Molecule | null>(null);
  const [showCookModal, setShowCookModal] = useState(false);
  const [cookToml, setCookToml] = useState('');
  const [cooking, setCooking] = useState(false);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);
  const [tab, setTab] = useState<'molecules' | 'convoys'>('molecules');

  /* ---------- Fetch ---------- */

  const fetchMolecules = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterPhase !== 'all') params.set('phase', filterPhase);
      if (filterStatus !== 'all') params.set('status', filterStatus);
      const qs = params.toString();
      const res = await fetch(`${API}/api/meow/molecules${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMolecules(Array.isArray(data?.molecules) ? data.molecules : Array.isArray(data) ? data : []);
      if (data.source) setDataSource(data.source);
      else setDataSource('db');
    } catch {
      setMolecules([]);
      setDataSource('mock');
    }
  }, [filterPhase, filterStatus]);

  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/feed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFeed(Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : []);
    } catch {
      setFeed([]);
    }
  }, []);

  const fetchConvoys = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/convoys`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConvoys(Array.isArray(data?.convoys) ? data.convoys : Array.isArray(data) ? data : []);
    } catch {
      setConvoys([]);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchMolecules(), fetchFeed(), fetchConvoys()]).finally(() => setLoading(false));
  }, [fetchMolecules, fetchFeed, fetchConvoys]);

  /* ---------- Actions ---------- */

  const cookFormula = async () => {
    if (!cookToml.trim()) return;
    setCooking(true);
    try {
      const res = await fetch(`${API}/api/meow/cook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toml: cookToml }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCookToml('');
      setShowCookModal(false);
      // If proto returned, pour it immediately
      if (data.protoId) {
        await fetch(`${API}/api/meow/pour/${data.protoId}`, { method: 'POST' });
      }
      fetchMolecules();
      fetchFeed();
    } catch (err) {
      console.error('[MoleculeView] cook failed:', err);
    } finally {
      setCooking(false);
    }
  };

  const completeStep = async (moleculeId: string, stepId: string) => {
    try {
      const res = await fetch(`${API}/api/meow/molecules/${moleculeId}/steps/${stepId}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh molecule detail
      const molRes = await fetch(`${API}/api/meow/molecules/${moleculeId}`);
      if (molRes.ok) {
        const updated = await molRes.json();
        const mol = updated.molecule || updated;
        setSelectedMolecule(mol);
        setMolecules(prev => prev.map(m => m.id === moleculeId ? mol : m));
      }
      fetchFeed();
    } catch (err) {
      console.error('[MoleculeView] completeStep failed:', err);
    }
  };

  /* ---------- Derived ---------- */

  const activeMolecules = molecules.filter(m => m.status === 'active').length;

  const getStepProgress = (mol: Molecule): { done: number; total: number } => {
    const steps = mol.steps || [];
    return { done: steps.filter(s => s.status === 'done').length, total: steps.length };
  };

  /* ---------- Render ---------- */

  return (
    <div className="h-full flex bg-[#0a0a0a] font-mono text-[#e6e1cf]">
      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex-none px-6 py-4 border-b border-[#2d363f]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold tracking-tight">MEOW</span>
              <span className="text-xs text-[#4a5159]">Molecule Engine of Work</span>
              <span className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {activeMolecules} active
              </span>
              {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE</span>}
              {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20">OFFLINE</span>}
            </div>
            <button
              onClick={() => setShowCookModal(true)}
              className="px-3 py-1.5 text-xs bg-[#2d363f]/30 border border-[#2d363f] hover:bg-[#2d363f]/50 transition-colors"
            >
              Cook Formula
            </button>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3">
            {/* Tab switcher */}
            <div className="flex border border-[#2d363f]">
              <button
                onClick={() => setTab('molecules')}
                className={`px-3 py-1 text-xs ${tab === 'molecules' ? 'bg-[#2d363f]/50 text-[#e6e1cf]' : 'text-[#4a5159] hover:text-[#6c7680]'}`}
              >
                Molecules
              </button>
              <button
                onClick={() => setTab('convoys')}
                className={`px-3 py-1 text-xs ${tab === 'convoys' ? 'bg-[#2d363f]/50 text-[#e6e1cf]' : 'text-[#4a5159] hover:text-[#6c7680]'}`}
              >
                Convoys
              </button>
            </div>
            <div className="w-px h-5 bg-[#2d363f]/50" />
            {/* Phase filter */}
            <div className="flex gap-1">
              <button
                onClick={() => setFilterPhase('all')}
                className={`px-2 py-1 text-[10px] border ${filterPhase === 'all' ? 'bg-[#2d363f]/50 border-[#2d363f] text-[#e6e1cf]' : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'}`}
              >
                All
              </button>
              {(Object.keys(PHASE_CONFIG) as MoleculePhase[]).map(p => (
                <button
                  key={p}
                  onClick={() => setFilterPhase(p)}
                  className={`px-2 py-1 text-[10px] border ${filterPhase === p ? PHASE_BADGE[p] : 'border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'}`}
                >
                  {PHASE_CONFIG[p].label}
                </button>
              ))}
            </div>
            <div className="w-px h-5 bg-[#2d363f]/50" />
            {/* Status filter */}
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as MoleculeStatus | 'all')} className="px-2 py-1 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf]/80">
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="paused">Paused</option>
            </select>
            <button onClick={() => { fetchMolecules(); fetchFeed(); fetchConvoys(); }} className="px-2 py-1 text-xs text-[#4a5159] hover:text-[#e6e1cf]/80 border border-[#2d363f] bg-[#1a1f26]">
              Refresh
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full text-[#4a5159] text-sm">Loading molecules...</div>
          ) : tab === 'molecules' ? (
            /* Molecule cards grid */
            molecules.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#4a5159]">
                <div className="text-4xl mb-3">&#x2697;</div>
                <div className="text-sm">No molecules found</div>
                <div className="text-xs mt-1">Cook a formula to create your first molecule</div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {molecules.map(mol => {
                  const progress = getStepProgress(mol);
                  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
                  return (
                    <button
                      key={mol.id}
                      onClick={() => setSelectedMolecule(mol)}
                      className={`text-left p-4 bg-[#1a1f26] border border-[#2d363f] hover:border-[#2d363f] transition-colors ${
                        selectedMolecule?.id === mol.id ? 'border-[#2d363f] bg-[#2d363f]/20' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <span className="text-xs text-[#e6e1cf] font-bold leading-tight">{mol.name}</span>
                        <span className={`flex-none px-1.5 py-0.5 text-[10px] border ${PHASE_BADGE[mol.phase] || PHASE_BADGE.solid}`}>
                          {PHASE_CONFIG[mol.phase]?.label || mol.phase}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mb-3 text-[10px] text-[#4a5159]">
                        <span className="font-mono">{mol.id?.slice(0, 8)}</span>
                        <span className={`px-1 py-0.5 border ${STATUS_CONFIG[mol.status]?.cls || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}`}>
                          {STATUS_CONFIG[mol.status]?.label || mol.status}
                        </span>
                        {mol.formulaName && <span className="text-[#4a5159]">{mol.formulaName}</span>}
                      </div>
                      {/* Progress bar */}
                      <div className="mb-1.5">
                        <div className="flex items-center justify-between text-[10px] text-[#4a5159] mb-1">
                          <span>Steps</span>
                          <span>{progress.done}/{progress.total} ({pct}%)</span>
                        </div>
                        <div className="w-full h-1.5 bg-[#2d363f]/30 overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              mol.phase === 'ice9' ? 'bg-cyan-400/60' :
                              mol.phase === 'liquid' ? 'bg-emerald-400/60' :
                              mol.phase === 'vapor' ? 'bg-violet-400/60' :
                              'bg-blue-400/60'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      {/* Step mini-indicators */}
                      {mol.steps && mol.steps.length > 0 && (
                        <div className="flex gap-0.5 mt-2 flex-wrap">
                          {mol.steps.slice(0, 20).map(s => (
                            <div
                              key={s.id}
                              title={`${s.name}: ${s.status}`}
                              className={`w-3 h-3 border ${STEP_STATUS_COLOR[s.status] || STEP_STATUS_COLOR.pending}`}
                            />
                          ))}
                          {mol.steps.length > 20 && (
                            <span className="text-[9px] text-[#4a5159] ml-1">+{mol.steps.length - 20}</span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )
          ) : (
            /* Convoys tab */
            convoys.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#4a5159]">
                <div className="text-sm">No convoys</div>
              </div>
            ) : (
              <div className="space-y-3">
                {convoys.map(c => (
                  <div key={c.id} className="p-4 bg-[#1a1f26] border border-[#2d363f]">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-[#e6e1cf]">{c.name}</span>
                      <span className="text-[10px] text-[#4a5159]">{c.status}</span>
                    </div>
                    <div className="text-[10px] text-[#4a5159]">
                      {c.moleculeIds?.length || 0} molecules
                    </div>
                    {c.createdAt && (
                      <div className="text-[10px] text-[#4a5159] mt-1">{new Date(c.createdAt).toLocaleString()}</div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Right sidebar: detail or feed */}
      <div className="w-[360px] flex-none border-l border-[#2d363f] flex flex-col overflow-hidden bg-[#0a0a0a]">
        {selectedMolecule ? (
          /* Molecule detail */
          <>
            <div className="flex-none px-4 py-3 border-b border-[#2d363f] flex items-center justify-between">
              <span className="text-xs font-bold text-[#e6e1cf]/80 uppercase">Molecule Detail</span>
              <button onClick={() => setSelectedMolecule(null)} className="text-[#4a5159] hover:text-[#6c7680] text-sm">X</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Name + phase */}
              <div>
                <div className="text-sm text-[#e6e1cf] font-bold mb-1">{selectedMolecule.name}</div>
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 text-[10px] border ${PHASE_BADGE[selectedMolecule.phase]}`}>
                    {PHASE_CONFIG[selectedMolecule.phase]?.label}
                  </span>
                  <span className={`px-1.5 py-0.5 text-[10px] border ${STATUS_CONFIG[selectedMolecule.status]?.cls}`}>
                    {STATUS_CONFIG[selectedMolecule.status]?.label}
                  </span>
                </div>
              </div>
              {/* Metadata */}
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <div className="text-[#4a5159] uppercase mb-0.5">ID</div>
                  <div className="text-[#6c7680] font-mono">{selectedMolecule.id?.slice(0, 12)}</div>
                </div>
                <div>
                  <div className="text-[#4a5159] uppercase mb-0.5">Formula</div>
                  <div className="text-[#6c7680]">{selectedMolecule.formulaName || '-'}</div>
                </div>
                {selectedMolecule.createdAt && (
                  <div>
                    <div className="text-[#4a5159] uppercase mb-0.5">Created</div>
                    <div className="text-[#4a5159]">{new Date(selectedMolecule.createdAt).toLocaleDateString()}</div>
                  </div>
                )}
                {selectedMolecule.updatedAt && (
                  <div>
                    <div className="text-[#4a5159] uppercase mb-0.5">Updated</div>
                    <div className="text-[#4a5159]">{new Date(selectedMolecule.updatedAt).toLocaleDateString()}</div>
                  </div>
                )}
              </div>
              {/* Steps timeline (vertical DAG) */}
              <div>
                <div className="text-[10px] text-[#4a5159] uppercase mb-2">Steps ({selectedMolecule.steps?.length || 0})</div>
                <div className="space-y-0">
                  {(selectedMolecule.steps || []).map((step, idx) => {
                    const isLast = idx === (selectedMolecule.steps?.length || 0) - 1;
                    return (
                      <div key={step.id} className="flex gap-3">
                        {/* Timeline connector */}
                        <div className="flex flex-col items-center w-5 flex-none">
                          <div className={`w-3 h-3 border ${STEP_STATUS_COLOR[step.status]}`} />
                          {!isLast && <div className="w-px flex-1 bg-[#2d363f]/50 min-h-[24px]" />}
                        </div>
                        {/* Step content */}
                        <div className="flex-1 pb-3 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className={`text-xs ${STEP_STATUS_TEXT[step.status]}`}>{step.name}</span>
                            <span className="text-[9px] text-[#4a5159] uppercase flex-none">{step.status}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[#4a5159]">
                            {step.assignee && <span>{step.assignee}</span>}
                            {step.beadId && <span className="font-mono">bead:{step.beadId.slice(0, 6)}</span>}
                            {step.dependsOn && step.dependsOn.length > 0 && (
                              <span>{step.dependsOn.length} dep{step.dependsOn.length > 1 ? 's' : ''}</span>
                            )}
                          </div>
                          {/* Complete button for ready/running steps */}
                          {(step.status === 'ready' || step.status === 'running') && (
                            <button
                              onClick={() => completeStep(selectedMolecule.id, step.id)}
                              className="mt-1 px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                            >
                              Complete
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        ) : (
          /* Activity Feed */
          <>
            <div className="flex-none px-4 py-3 border-b border-[#2d363f]">
              <span className="text-xs font-bold text-[#e6e1cf]/80 uppercase">Activity Feed</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {feed.length === 0 ? (
                <div className="text-center py-8 text-[#4a5159] text-xs">No events yet</div>
              ) : (
                feed.map(ev => (
                  <div key={ev.id} className="p-2 bg-[#1a1f26] border border-[#2d363f]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-[#6c7680]">{ev.type}</span>
                      <span className="text-[9px] text-[#4a5159]">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-xs text-[#e6e1cf]/80">{ev.message}</div>
                    {ev.actor && <div className="text-[10px] text-[#4a5159] mt-0.5">{ev.actor}</div>}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Cook Modal */}
      {showCookModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[600px] bg-[#1a1f26] border border-[#2d363f] p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-bold text-[#e6e1cf]">Cook Formula</span>
              <button onClick={() => setShowCookModal(false)} className="text-[#4a5159] hover:text-[#6c7680] text-sm">X</button>
            </div>
            <div className="mb-3">
              <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Formula TOML</label>
              <textarea
                value={cookToml}
                onChange={e => setCookToml(e.target.value)}
                rows={15}
                placeholder={`[formula]\nname = "my-formula"\nversion = "1.0.0"\n\n[[steps]]\nname = "step-1"\nskill = "research"\n\n[[steps]]\nname = "step-2"\nskill = "implement"\ndepends_on = ["step-1"]`}
                className="w-full px-3 py-2 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf] placeholder-white/20 focus:outline-none focus:border-[#2d363f] resize-none font-mono"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCookModal(false)} className="px-3 py-1.5 text-xs text-[#4a5159] border border-[#2d363f] hover:bg-[#2d363f]/30">Cancel</button>
              <button
                onClick={cookFormula}
                disabled={!cookToml.trim() || cooking}
                className="px-4 py-1.5 text-xs bg-[#2d363f]/50 border border-[#2d363f] hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {cooking ? 'Cooking...' : 'Cook & Pour'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
