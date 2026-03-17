'use client';

/**
 * BeadsView — Kanban-style board for Beads (atomic work units)
 * Shows beads across status columns with filters, search, create modal, and detail panel.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

/* ---------- Types ---------- */

type BeadStatus = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type BeadPriority = 'p0' | 'p1' | 'p2' | 'p3';

interface Bead {
  id: string;
  title: string;
  description?: string;
  status: BeadStatus;
  priority: BeadPriority;
  executorType?: string;
  bu?: string;
  rig?: string;
  skill?: string;
  tier?: string;
  labels?: string[];
  assignee?: string;
  createdBy?: string;
  dependencyCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

interface BeadStats {
  total: number;
  by_status: Record<BeadStatus, number>;
  by_bu: Record<string, number>;
  by_rig: Record<string, number>;
  velocity: number;
}

/* ---------- Constants ---------- */

const STATUS_COLUMNS: { key: BeadStatus; label: string; color: string }[] = [
  { key: 'backlog',     label: 'Backlog',     color: 'zinc' },
  { key: 'ready',       label: 'Ready',       color: 'blue' },
  { key: 'in_progress', label: 'In Progress', color: 'amber' },
  { key: 'in_review',   label: 'In Review',   color: 'violet' },
  { key: 'blocked',     label: 'Blocked',     color: 'red' },
  { key: 'done',        label: 'Done',        color: 'emerald' },
];

const PRIORITY_CONFIG: Record<BeadPriority, { label: string; color: string }> = {
  p0: { label: 'P0', color: 'red' },
  p1: { label: 'P1', color: 'amber' },
  p2: { label: 'P2', color: 'blue' },
  p3: { label: 'P3', color: 'zinc' },
};

const STATUS_COLOR_MAP: Record<string, string> = {
  zinc: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  amber: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  violet: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  red: 'bg-red-500/20 text-red-400 border-red-500/30',
  emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
};

/* ---------- Component ---------- */

export default function BeadsView() {
  const [beads, setBeads] = useState<Bead[]>([]);
  const [stats, setStats] = useState<BeadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterBu, setFilterBu] = useState<string>('all');
  const [filterRig, setFilterRig] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [filterTier, setFilterTier] = useState<string>('all');
  const [selectedBead, setSelectedBead] = useState<Bead | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<BeadPriority>('p2');
  const [newBu, setNewBu] = useState('');
  const [newRig, setNewRig] = useState('');
  const [newSkill, setNewSkill] = useState('');
  const [newTier, setNewTier] = useState('');
  const [newExecutorType, setNewExecutorType] = useState('');
  const [creating, setCreating] = useState(false);

  // Detail panel edit state
  const [editingStatus, setEditingStatus] = useState<BeadStatus | null>(null);

  const searchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  /* ---------- Fetch ---------- */

  const fetchBeads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterBu !== 'all') params.set('bu', filterBu);
      if (filterRig !== 'all') params.set('rig', filterRig);
      if (filterPriority !== 'all') params.set('priority', filterPriority);
      params.set('limit', '500');
      const qs = params.toString();
      const res = await fetch(`${API}/api/beads${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBeads(data.beads || []);
      if (data.source) setDataSource(data.source);
      else setDataSource('db');
    } catch {
      setBeads([]);
      setDataSource('mock');
    }
  }, [filterBu, filterRig, filterPriority]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/beads/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);
    } catch {
      setStats(null);
    }
  }, []);

  const searchBeads = useCallback(async (q: string) => {
    if (!q.trim()) { fetchBeads(); return; }
    try {
      const res = await fetch(`${API}/api/beads/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBeads(data.beads || []);
    } catch {
      // fallback to client-side filter
    }
  }, [fetchBeads]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchBeads(), fetchStats()]).finally(() => setLoading(false));
  }, [fetchBeads, fetchStats]);

  // Debounced search
  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => searchBeads(q), 300);
  };

  /* ---------- Actions ---------- */

  const createBead = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/beads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          description: newDescription.trim() || undefined,
          priority: newPriority,
          executorType: newExecutorType || undefined,
          bu: newBu || undefined,
          rig: newRig || undefined,
          skill: newSkill || undefined,
          tier: newTier || undefined,
          createdBy: 'gastown',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Reset form
      setNewTitle('');
      setNewDescription('');
      setNewPriority('p2');
      setNewBu('');
      setNewRig('');
      setNewSkill('');
      setNewTier('');
      setNewExecutorType('');
      setShowCreateModal(false);
      // Refresh
      fetchBeads();
      fetchStats();
    } catch (err) {
      console.error('[BeadsView] create failed:', err);
    } finally {
      setCreating(false);
    }
  };

  const updateBeadStatus = async (beadId: string, newStatus: BeadStatus) => {
    try {
      const res = await fetch(`${API}/api/beads/${beadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Update locally
      setBeads(prev => prev.map(b => b.id === beadId ? { ...b, status: newStatus } : b));
      if (selectedBead?.id === beadId) setSelectedBead(prev => prev ? { ...prev, status: newStatus } : null);
      setEditingStatus(null);
      fetchStats();
    } catch (err) {
      console.error('[BeadsView] update failed:', err);
    }
  };

  const closeBead = async (beadId: string) => {
    try {
      const res = await fetch(`${API}/api/beads/${beadId}/close`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBeads(prev => prev.map(b => b.id === beadId ? { ...b, status: 'done' as BeadStatus } : b));
      if (selectedBead?.id === beadId) setSelectedBead(prev => prev ? { ...prev, status: 'done' } : null);
      fetchStats();
    } catch (err) {
      console.error('[BeadsView] close failed:', err);
    }
  };

  /* ---------- Derived ---------- */

  const filteredBeads = beads.filter(b => {
    if (filterTier !== 'all' && b.tier !== filterTier) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return b.title.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q) || (b.id || '').toLowerCase().includes(q);
    }
    return true;
  });

  const beadsByStatus: Record<BeadStatus, Bead[]> = {
    backlog: [], ready: [], in_progress: [], in_review: [], blocked: [], done: [],
  };
  filteredBeads.forEach(b => {
    if (beadsByStatus[b.status]) beadsByStatus[b.status].push(b);
    else beadsByStatus.backlog.push(b);
  });

  // Extract unique values for filters
  const allBus = [...new Set(beads.map(b => b.bu).filter(Boolean))] as string[];
  const allRigs = [...new Set(beads.map(b => b.rig).filter(Boolean))] as string[];
  const allTiers = [...new Set(beads.map(b => b.tier).filter(Boolean))] as string[];

  /* ---------- Render ---------- */

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] font-mono text-[#e6e1cf]">
      {/* Header */}
      <div className="flex-none px-6 py-4 border-b border-[#2d363f]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold tracking-tight">BEADS</span>
            <span className="text-xs text-[#4a5159]">Atomic Work Units</span>
            {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">LIVE</span>}
            {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20">OFFLINE</span>}
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-3 py-1.5 text-xs bg-[#2d363f]/30 border border-[#2d363f] hover:bg-[#2d363f]/50 transition-colors"
          >
            + New Bead
          </button>
        </div>

        {/* Stats row */}
        {stats && (
          <div className="flex gap-3 mb-4 overflow-x-auto">
            <div className="px-3 py-2 bg-[#1a1f26] border border-[#2d363f] min-w-[100px]">
              <div className="text-[10px] text-[#4a5159] uppercase">Total</div>
              <div className="text-lg font-bold">{stats.total}</div>
            </div>
            {STATUS_COLUMNS.map(col => (
              <div key={col.key} className="px-3 py-2 bg-[#1a1f26] border border-[#2d363f] min-w-[90px]">
                <div className="text-[10px] text-[#4a5159] uppercase">{col.label}</div>
                <div className={`text-lg font-bold text-${col.color}-400`}>
                  {stats.by_status?.[col.key] || 0}
                </div>
              </div>
            ))}
            <div className="px-3 py-2 bg-[#1a1f26] border border-[#2d363f] min-w-[100px]">
              <div className="text-[10px] text-[#4a5159] uppercase">Velocity</div>
              <div className="text-lg font-bold text-emerald-400">{typeof stats.velocity === 'object' ? (stats.velocity as any)?.avg_per_week ?? 0 : stats.velocity ?? 0}<span className="text-xs text-[#4a5159]">/wk</span></div>
            </div>
          </div>
        )}

        {/* Filters row */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Search beads..."
            value={searchQuery}
            onChange={e => handleSearch(e.target.value)}
            className="px-3 py-1.5 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf] placeholder-[#4a5159] w-64 focus:outline-none focus:border-[#2d363f]"
          />
          <select value={filterBu} onChange={e => setFilterBu(e.target.value)} className="px-2 py-1.5 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf]/80">
            <option value="all">All BUs</option>
            {allBus.map(bu => <option key={bu} value={bu}>{bu}</option>)}
          </select>
          <select value={filterRig} onChange={e => setFilterRig(e.target.value)} className="px-2 py-1.5 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf]/80">
            <option value="all">All Rigs</option>
            {allRigs.map(rig => <option key={rig} value={rig}>{rig}</option>)}
          </select>
          <select value={filterPriority} onChange={e => setFilterPriority(e.target.value)} className="px-2 py-1.5 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf]/80">
            <option value="all">All Priorities</option>
            <option value="p0">P0</option>
            <option value="p1">P1</option>
            <option value="p2">P2</option>
            <option value="p3">P3</option>
          </select>
          <select value={filterTier} onChange={e => setFilterTier(e.target.value)} className="px-2 py-1.5 text-xs bg-[#1a1f26] border border-[#2d363f] text-[#e6e1cf]/80">
            <option value="all">All Tiers</option>
            {allTiers.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={() => { fetchBeads(); fetchStats(); }} className="px-2 py-1.5 text-xs text-[#4a5159] hover:text-[#e6e1cf]/80 border border-[#2d363f] bg-[#1a1f26]">
            Refresh
          </button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#4a5159] text-sm">Loading beads...</div>
        ) : (
          <div className="flex h-full p-4 gap-3 min-w-max">
            {STATUS_COLUMNS.map(col => (
              <div key={col.key} className="flex flex-col w-[280px] min-w-[280px]">
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2 mb-2 border-b border-[#2d363f]">
                  <div className={`w-2 h-2 rounded-full bg-${col.color}-400`} />
                  <span className="text-xs font-bold text-[#e6e1cf]/80 uppercase">{col.label}</span>
                  <span className="text-[10px] text-[#4a5159] ml-auto">{beadsByStatus[col.key].length}</span>
                </div>
                {/* Cards */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 pb-4">
                  {beadsByStatus[col.key].map(bead => (
                    <button
                      key={bead.id}
                      onClick={() => setSelectedBead(bead)}
                      className={`w-full text-left p-3 bg-[#1a1f26] border border-[#2d363f] hover:border-[#2d363f] transition-colors ${
                        selectedBead?.id === bead.id ? 'border-[#2d363f] bg-[#2d363f]/20' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="text-xs text-[#e6e1cf] leading-tight line-clamp-2">{bead.title}</span>
                        {bead.priority && (
                          <span className={`flex-none px-1.5 py-0.5 text-[10px] border ${
                            PRIORITY_CONFIG[bead.priority]?.color === 'red' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                            PRIORITY_CONFIG[bead.priority]?.color === 'amber' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                            PRIORITY_CONFIG[bead.priority]?.color === 'blue' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
                            'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
                          }`}>
                            {PRIORITY_CONFIG[bead.priority]?.label || bead.priority}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-[#4a5159]">
                        <span className="font-mono">{bead.id?.slice(0, 8)}</span>
                        {bead.bu && <span className="px-1 py-0.5 bg-[#2d363f]/30 border border-[#2d363f]">{bead.bu}</span>}
                        {bead.tier && <span className="px-1 py-0.5 bg-[#2d363f]/30 border border-[#2d363f]">{bead.tier}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[#4a5159]">
                        {bead.assignee && <span>{bead.assignee}</span>}
                        {bead.dependencyCount != null && bead.dependencyCount > 0 && (
                          <span className="ml-auto">{bead.dependencyCount} deps</span>
                        )}
                      </div>
                    </button>
                  ))}
                  {beadsByStatus[col.key].length === 0 && (
                    <div className="text-center py-8 text-[#4a5159] text-[10px] uppercase">Empty</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Detail Panel (slide-in from right) */}
      {selectedBead && (
        <div className="fixed inset-y-0 right-0 w-[420px] bg-[#0a0a0a] border-l border-[#2d363f] z-50 flex flex-col overflow-hidden shadow-2xl">
          {/* Detail header */}
          <div className="flex-none px-5 py-4 border-b border-[#2d363f] flex items-center justify-between">
            <span className="text-xs font-bold text-[#e6e1cf]/80 uppercase">Bead Detail</span>
            <button onClick={() => { setSelectedBead(null); setEditingStatus(null); }} className="text-[#4a5159] hover:text-[#6c7680] text-sm">X</button>
          </div>
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* ID */}
            <div>
              <div className="text-[10px] text-[#4a5159] uppercase mb-1">ID</div>
              <div className="text-xs font-mono text-[#6c7680]">{selectedBead.id}</div>
            </div>
            {/* Title */}
            <div>
              <div className="text-[10px] text-[#4a5159] uppercase mb-1">Title</div>
              <div className="text-sm text-[#e6e1cf]">{selectedBead.title}</div>
            </div>
            {/* Description */}
            {selectedBead.description && (
              <div>
                <div className="text-[10px] text-[#4a5159] uppercase mb-1">Description</div>
                <div className="text-xs text-[#6c7680] whitespace-pre-wrap">{selectedBead.description}</div>
              </div>
            )}
            {/* Status */}
            <div>
              <div className="text-[10px] text-[#4a5159] uppercase mb-1">Status</div>
              {editingStatus !== null ? (
                <div className="flex flex-wrap gap-1">
                  {STATUS_COLUMNS.map(col => (
                    <button
                      key={col.key}
                      onClick={() => updateBeadStatus(selectedBead.id, col.key)}
                      className={`px-2 py-1 text-[10px] border ${STATUS_COLOR_MAP[col.color]} ${
                        selectedBead.status === col.key ? 'ring-1 ring-white/20' : ''
                      }`}
                    >
                      {col.label}
                    </button>
                  ))}
                  <button onClick={() => setEditingStatus(null)} className="px-2 py-1 text-[10px] text-[#4a5159] border border-[#2d363f]">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setEditingStatus(selectedBead.status)}
                  className={`px-2 py-1 text-[10px] border ${STATUS_COLOR_MAP[STATUS_COLUMNS.find(c => c.key === selectedBead.status)?.color || 'zinc']}`}
                >
                  {STATUS_COLUMNS.find(c => c.key === selectedBead.status)?.label || selectedBead.status}
                </button>
              )}
            </div>
            {/* Priority */}
            <div>
              <div className="text-[10px] text-[#4a5159] uppercase mb-1">Priority</div>
              <span className={`px-2 py-0.5 text-[10px] border ${
                PRIORITY_CONFIG[selectedBead.priority]?.color === 'red' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                PRIORITY_CONFIG[selectedBead.priority]?.color === 'amber' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                PRIORITY_CONFIG[selectedBead.priority]?.color === 'blue' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
                'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'
              }`}>
                {PRIORITY_CONFIG[selectedBead.priority]?.label || selectedBead.priority}
              </span>
            </div>
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-3">
              {selectedBead.bu && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">BU</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.bu}</div>
                </div>
              )}
              {selectedBead.rig && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Rig</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.rig}</div>
                </div>
              )}
              {selectedBead.tier && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Tier</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.tier}</div>
                </div>
              )}
              {selectedBead.skill && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Skill</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.skill}</div>
                </div>
              )}
              {selectedBead.executorType && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Executor</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.executorType}</div>
                </div>
              )}
              {selectedBead.assignee && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Assignee</div>
                  <div className="text-xs text-[#6c7680]">{selectedBead.assignee}</div>
                </div>
              )}
            </div>
            {/* Labels */}
            {selectedBead.labels && selectedBead.labels.length > 0 && (
              <div>
                <div className="text-[10px] text-[#4a5159] uppercase mb-1">Labels</div>
                <div className="flex flex-wrap gap-1">
                  {selectedBead.labels.map(l => (
                    <span key={l} className="px-1.5 py-0.5 text-[10px] bg-[#2d363f]/30 border border-[#2d363f] text-[#6c7680]">{l}</span>
                  ))}
                </div>
              </div>
            )}
            {/* Timestamps */}
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#2d363f]">
              {selectedBead.createdAt && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Created</div>
                  <div className="text-[10px] text-[#4a5159]">{new Date(selectedBead.createdAt).toLocaleString()}</div>
                </div>
              )}
              {selectedBead.updatedAt && (
                <div>
                  <div className="text-[10px] text-[#4a5159] uppercase mb-1">Updated</div>
                  <div className="text-[10px] text-[#4a5159]">{new Date(selectedBead.updatedAt).toLocaleString()}</div>
                </div>
              )}
            </div>
          </div>
          {/* Detail actions */}
          <div className="flex-none px-5 py-3 border-t border-[#2d363f] flex gap-2">
            {selectedBead.status !== 'done' && (
              <button
                onClick={() => closeBead(selectedBead.id)}
                className="px-3 py-1.5 text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
              >
                Close Bead
              </button>
            )}
            <button
              onClick={() => setEditingStatus(selectedBead.status)}
              className="px-3 py-1.5 text-xs bg-[#2d363f]/30 border border-[#2d363f] hover:bg-[#2d363f]/50 transition-colors"
            >
              Change Status
            </button>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[520px] bg-[#1a1f26] border border-[#2d363f] p-6">
            <div className="flex items-center justify-between mb-5">
              <span className="text-sm font-bold text-[#e6e1cf]">New Bead</span>
              <button onClick={() => setShowCreateModal(false)} className="text-[#4a5159] hover:text-[#6c7680] text-sm">X</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Title *</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="What needs to be done?"
                  className="w-full px-3 py-2 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf] placeholder-white/20 focus:outline-none focus:border-[#2d363f]"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Description</label>
                <textarea
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  rows={3}
                  placeholder="Details, context, acceptance criteria..."
                  className="w-full px-3 py-2 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf] placeholder-white/20 focus:outline-none focus:border-[#2d363f] resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Priority</label>
                  <select value={newPriority} onChange={e => setNewPriority(e.target.value as BeadPriority)} className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80">
                    <option value="p0">P0 — Critical</option>
                    <option value="p1">P1 — High</option>
                    <option value="p2">P2 — Medium</option>
                    <option value="p3">P3 — Low</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Executor Type</label>
                  <input
                    type="text"
                    value={newExecutorType}
                    onChange={e => setNewExecutorType(e.target.value)}
                    placeholder="agent, human, hybrid"
                    className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80 placeholder-white/20 focus:outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">BU</label>
                  <input type="text" value={newBu} onChange={e => setNewBu(e.target.value)} placeholder="Business Unit" className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80 placeholder-white/20 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Rig</label>
                  <input type="text" value={newRig} onChange={e => setNewRig(e.target.value)} placeholder="Rig name" className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80 placeholder-white/20 focus:outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Skill</label>
                  <input type="text" value={newSkill} onChange={e => setNewSkill(e.target.value)} placeholder="Required skill" className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80 placeholder-white/20 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#4a5159] uppercase mb-1">Tier</label>
                  <input type="text" value={newTier} onChange={e => setNewTier(e.target.value)} placeholder="S, A, B, C" className="w-full px-2 py-1.5 text-xs bg-[#0a0a0a] border border-[#2d363f] text-[#e6e1cf]/80 placeholder-white/20 focus:outline-none" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreateModal(false)} className="px-3 py-1.5 text-xs text-[#4a5159] border border-[#2d363f] hover:bg-[#2d363f]/30">Cancel</button>
              <button
                onClick={createBead}
                disabled={!newTitle.trim() || creating}
                className="px-4 py-1.5 text-xs bg-[#2d363f]/50 border border-[#2d363f] hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? 'Creating...' : 'Create Bead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
