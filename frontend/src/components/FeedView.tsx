'use client';

/**
 * FeedView -- Gas Town Main Feed (gt feed)
 *
 * Steve Yegge's primary TUI view, adapted to web. Three-panel split:
 *   Panel 1: Agent Tree (left 30%) — hierarchical worker topology
 *   Panel 2: Convoy Dashboard (middle 40%) — active convoy progress
 *   Panel 3: Event Stream (right 30%) — real-time timeline
 *
 * Toggle "Problems" mode (P key or button) replaces convoys with attention panel.
 *
 * Ayu Dark palette:
 *   bg: #0f1419, cards: #1a1f26, text: #e6e1cf, muted: #6c7680
 *   border: #2d363f, green: #c2d94c, yellow: #ffb454, red: #f07178
 *   cyan: #95e6cb, purple: #d2a6ff
 *
 * APIs:
 *   GET {API}/api/meow/workers/overview   — agent tree
 *   GET {API}/api/meow/crew               — crew members
 *   GET {API}/api/meow/convoys            — convoy list
 *   GET {API}/api/meow/town/timeline      — event stream
 *   GET {API}/api/beads?status=in_progress — active beads
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type WorkerStatus =
  | 'WORKING'
  | 'IDLE'
  | 'SLEEPING'
  | 'PATROLLING'
  | 'PR_CREATED'
  | 'STALE'
  | 'BLOCKED'
  | 'ERROR'
  | 'SPAWNING';

interface TreeWorker {
  id: string;
  name: string;
  role: 'mayor' | 'deacon' | 'witness' | 'refinery' | 'polecat' | 'crew' | 'boot' | 'dog';
  status: WorkerStatus;
  currentBead?: string;
  rig?: string;
  children?: TreeWorker[];
}

interface RigNode {
  rigName: string;
  witness?: TreeWorker;
  refinery?: TreeWorker;
  polecats: TreeWorker[];
  crew: TreeWorker[];
}

interface TownOverview {
  mayor?: TreeWorker;
  deacon?: TreeWorker;
  boots?: TreeWorker[];
  dogs?: TreeWorker[];
  rigs: RigNode[];
}

type ConvoyBeadStatus = 'DONE' | 'WORKING' | 'READY' | 'BLOCKED' | 'FAILED' | 'LANDED';

interface ConvoyBead {
  id: string;
  title: string;
  status: ConvoyBeadStatus;
  assignee?: string;
  dependsOn?: string;
}

interface Convoy {
  id: string;
  name: string;
  status: 'active' | 'landed' | 'failed';
  beads: ConvoyBead[];
  createdAt: string;
}

type EventType = 'work' | 'sling' | 'mail' | 'merge' | 'spawn' | 'convoy' | 'patrol' | 'error' | 'system';

interface TimelineEvent {
  id: string;
  timestamp: string;
  type: EventType;
  actor: string;
  message: string;
  beadId?: string;
}

interface ActiveBead {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  updatedAt?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5000;
const MAX_EVENTS = 200;

const STATUS_COLORS: Record<WorkerStatus, { dot: string; text: string }> = {
  WORKING:    { dot: '#95e6cb', text: 'text-[#95e6cb]' },
  IDLE:       { dot: '#6c7680', text: 'text-[#6c7680]' },
  SLEEPING:   { dot: '#4a5159', text: 'text-[#4a5159]' },
  PATROLLING: { dot: '#d2a6ff', text: 'text-[#d2a6ff]' },
  PR_CREATED: { dot: '#c2d94c', text: 'text-[#c2d94c]' },
  STALE:      { dot: '#ffb454', text: 'text-[#ffb454]' },
  BLOCKED:    { dot: '#f07178', text: 'text-[#f07178]' },
  ERROR:      { dot: '#f07178', text: 'text-[#f07178]' },
  SPAWNING:   { dot: '#39bae6', text: 'text-[#39bae6]' },
};

const BEAD_STATUS_ICON: Record<ConvoyBeadStatus, { icon: string; color: string }> = {
  DONE:    { icon: '\u2713', color: '#c2d94c' },
  WORKING: { icon: '\u25CF', color: '#95e6cb' },
  READY:   { icon: '\u25CB', color: '#6c7680' },
  BLOCKED: { icon: '\u2298', color: '#f07178' },
  FAILED:  { icon: '\u2717', color: '#f07178' },
  LANDED:  { icon: '\u2713', color: '#4a5159' },
};

const EVENT_STYLE: Record<EventType, { icon: string; color: string }> = {
  work:    { icon: '\uD83D\uDD28', color: '#95e6cb' },
  sling:   { icon: '\uD83D\uDCCB', color: '#ffb454' },
  mail:    { icon: '\u2709\uFE0F',  color: '#d2a6ff' },
  merge:   { icon: '\u2697\uFE0F',  color: '#c2d94c' },
  spawn:   { icon: '\uD83D\uDE3A', color: '#39bae6' },
  convoy:  { icon: '\uD83D\uDE9A', color: '#ffb454' },
  patrol:  { icon: '\uD83D\uDEE1\uFE0F', color: '#d2a6ff' },
  error:   { icon: '\u26A0\uFE0F',  color: '#f07178' },
  system:  { icon: '\u2699\uFE0F',  color: '#6c7680' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '--:--:--'; }
}

function statusIcon(s: WorkerStatus): string {
  if (s === 'WORKING' || s === 'PATROLLING') return '\u25CF';
  if (s === 'IDLE') return '\u25CB';
  if (s === 'STALE' || s === 'ERROR') return '\u26A0';
  if (s === 'PR_CREATED') return '\u25CF';
  if (s === 'BLOCKED') return '\u2298';
  return '\u25CB';
}

function convoyProgress(beads: ConvoyBead[]): { done: number; total: number; pct: number } {
  const done = beads.filter(b => b.status === 'DONE' || b.status === 'LANDED').length;
  const total = beads.length || 1;
  return { done, total, pct: Math.round((done / total) * 100) };
}

function progressBar(done: number, total: number, width: number = 5): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

// Parse overview data into a TownOverview, handling whatever shape the API returns
function parseOverview(data: Record<string, unknown>): TownOverview {
  const result: TownOverview = { rigs: [] };

  // Direct mayor/deacon fields
  if (data.mayor && typeof data.mayor === 'object') {
    result.mayor = data.mayor as TreeWorker;
  }
  if (data.deacon && typeof data.deacon === 'object') {
    result.deacon = data.deacon as TreeWorker;
  }

  // Boots
  if (Array.isArray(data.boots)) {
    result.boots = data.boots as TreeWorker[];
  }

  // Dogs
  if (Array.isArray(data.dogs)) {
    result.dogs = data.dogs as TreeWorker[];
  }

  // Rigs
  if (Array.isArray(data.rigs)) {
    result.rigs = (data.rigs as Record<string, unknown>[]).map(r => ({
      rigName: (r.rigName || r.name || 'unknown') as string,
      witness: r.witness as TreeWorker | undefined,
      refinery: r.refinery as TreeWorker | undefined,
      polecats: (Array.isArray(r.polecats) ? r.polecats : []) as TreeWorker[],
      crew: (Array.isArray(r.crew) ? r.crew : []) as TreeWorker[],
    }));
  }

  // If flat workers array, convert to synthetic rigs
  if (result.rigs.length === 0 && Array.isArray(data.workers)) {
    const byRig = new Map<string, TreeWorker[]>();
    for (const w of data.workers as TreeWorker[]) {
      const rig = w.rig || 'default';
      if (!byRig.has(rig)) byRig.set(rig, []);
      byRig.get(rig)!.push(w);
    }
    for (const [rigName, workers] of byRig) {
      result.rigs.push({
        rigName,
        witness: workers.find(w => w.role === 'witness'),
        refinery: workers.find(w => w.role === 'refinery'),
        polecats: workers.filter(w => w.role === 'polecat'),
        crew: workers.filter(w => w.role === 'crew'),
      });
    }
  }

  return result;
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

/* ── Tree Line ─────────────────────────────────────────────────── */

function TreeLine({ depth, isLast, children }: { depth: number; isLast: boolean; children: React.ReactNode }) {
  const prefix = depth > 0
    ? '│   '.repeat(depth - 1) + (isLast ? '└── ' : '├── ')
    : '';

  return (
    <div className="flex items-center gap-0 font-mono text-[12px] leading-6 whitespace-nowrap">
      <span className="text-[#2d363f] select-none" style={{ letterSpacing: '0px' }}>
        {prefix}
      </span>
      {children}
    </div>
  );
}

/* ── Worker Node ───────────────────────────────────────────────── */

function WorkerNode({
  worker,
  depth,
  isLast,
  onSelect,
}: {
  worker: TreeWorker;
  depth: number;
  isLast: boolean;
  onSelect: (w: TreeWorker) => void;
}) {
  const sc = STATUS_COLORS[worker.status] || STATUS_COLORS.IDLE;

  return (
    <TreeLine depth={depth} isLast={isLast}>
      <button
        onClick={() => onSelect(worker)}
        className="flex items-center gap-1.5 hover:bg-[#2d363f]/20 px-1 -ml-1 transition-colors group"
      >
        <span style={{ color: sc.dot }}>{statusIcon(worker.status)}</span>
        <span className="text-[#e6e1cf] group-hover:text-white transition-colors">{worker.name}</span>
        <span className={`text-[10px] ${sc.text} opacity-70`}>[{worker.status}]</span>
        {worker.currentBead && (
          <span className="text-[10px] text-[#95e6cb]/60 ml-1">{worker.currentBead}</span>
        )}
      </button>
    </TreeLine>
  );
}

/* ── Agent Tree Panel ──────────────────────────────────────────── */

function AgentTreePanel({
  overview,
  onSelectWorker,
}: {
  overview: TownOverview;
  onSelectWorker: (w: TreeWorker) => void;
}) {
  const [collapsedRigs, setCollapsedRigs] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleRig = useCallback((rig: string) => {
    setCollapsedRigs(prev => {
      const next = new Set(prev);
      if (next.has(rig)) next.delete(rig); else next.add(rig);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const totalRigs = overview.rigs.length;
  const topItems: { item: TreeWorker | null; label?: string }[] = [];

  // Mayor
  if (overview.mayor) topItems.push({ item: overview.mayor });
  // Deacon
  if (overview.deacon) topItems.push({ item: overview.deacon });

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2d363f] flex items-center justify-between shrink-0">
        <span className="text-[11px] font-mono uppercase tracking-wider text-[#6c7680]">Agent Tree</span>
        <span className="text-[10px] font-mono text-[#4a5159]">{totalRigs} rig{totalRigs !== 1 ? 's' : ''}</span>
      </div>

      {/* Tree body */}
      <div className="flex-1 overflow-y-auto overflow-x-auto p-3 space-y-0">
        {/* TOWN root */}
        <div className="font-mono text-[12px] text-[#ffb454] font-semibold leading-6">TOWN</div>

        {/* Mayor */}
        {overview.mayor && (
          <WorkerNode worker={overview.mayor} depth={1} isLast={!overview.deacon && overview.rigs.length === 0} onSelect={onSelectWorker} />
        )}

        {/* Deacon + sub-agents */}
        {overview.deacon && (
          <>
            <WorkerNode worker={overview.deacon} depth={1} isLast={overview.rigs.length === 0} onSelect={onSelectWorker} />
            {/* Boots */}
            {overview.boots && overview.boots.length > 0 && overview.boots.map((b, i) => (
              <WorkerNode key={b.id} worker={b} depth={2} isLast={i === overview.boots!.length - 1 && (!overview.dogs || overview.dogs.length === 0)} onSelect={onSelectWorker} />
            ))}
            {/* Dogs */}
            {overview.dogs && overview.dogs.length > 0 && overview.dogs.map((d, i) => (
              <WorkerNode key={d.id} worker={d} depth={2} isLast={i === overview.dogs!.length - 1} onSelect={onSelectWorker} />
            ))}
          </>
        )}

        {/* Rigs */}
        {overview.rigs.map((rig, ri) => {
          const rigIsLast = ri === overview.rigs.length - 1;
          const rigCollapsed = collapsedRigs.has(rig.rigName);
          const rigWorkerCount = [rig.witness, rig.refinery].filter(Boolean).length + rig.polecats.length + rig.crew.length;

          return (
            <div key={rig.rigName}>
              {/* Rig name node */}
              <TreeLine depth={1} isLast={rigIsLast}>
                <button
                  onClick={() => toggleRig(rig.rigName)}
                  className="flex items-center gap-1.5 hover:bg-[#2d363f]/20 px-1 -ml-1 transition-colors"
                >
                  <span className="text-[#ffb454]">{rigCollapsed ? '\u25B6' : '\u25BC'}</span>
                  <span className="text-[#ffb454]">rig: {rig.rigName}</span>
                  <span className="text-[10px] text-[#4a5159]">({rigWorkerCount})</span>
                </button>
              </TreeLine>

              {!rigCollapsed && (
                <>
                  {/* Witness */}
                  {rig.witness && (
                    <WorkerNode
                      worker={rig.witness}
                      depth={2}
                      isLast={!rig.refinery && rig.polecats.length === 0 && rig.crew.length === 0}
                      onSelect={onSelectWorker}
                    />
                  )}

                  {/* Refinery */}
                  {rig.refinery && (
                    <WorkerNode
                      worker={rig.refinery}
                      depth={2}
                      isLast={rig.polecats.length === 0 && rig.crew.length === 0}
                      onSelect={onSelectWorker}
                    />
                  )}

                  {/* Polecats group */}
                  {rig.polecats.length > 0 && (
                    <>
                      <TreeLine depth={2} isLast={rig.crew.length === 0}>
                        <button
                          onClick={() => toggleGroup(`${rig.rigName}-polecats`)}
                          className="flex items-center gap-1.5 hover:bg-[#2d363f]/20 px-1 -ml-1 transition-colors"
                        >
                          <span className="text-[#95e6cb]">
                            {collapsedGroups.has(`${rig.rigName}-polecats`) ? '\u25B6' : '\u25BC'}
                          </span>
                          <span className="text-[#95e6cb]">Polecats</span>
                          <span className="text-[10px] text-[#4a5159]">({rig.polecats.length})</span>
                        </button>
                      </TreeLine>
                      {!collapsedGroups.has(`${rig.rigName}-polecats`) &&
                        rig.polecats.map((p, pi) => (
                          <WorkerNode
                            key={p.id}
                            worker={p}
                            depth={3}
                            isLast={pi === rig.polecats.length - 1}
                            onSelect={onSelectWorker}
                          />
                        ))}
                    </>
                  )}

                  {/* Crew group */}
                  {rig.crew.length > 0 && (
                    <>
                      <TreeLine depth={2} isLast>
                        <button
                          onClick={() => toggleGroup(`${rig.rigName}-crew`)}
                          className="flex items-center gap-1.5 hover:bg-[#2d363f]/20 px-1 -ml-1 transition-colors"
                        >
                          <span className="text-[#d2a6ff]">
                            {collapsedGroups.has(`${rig.rigName}-crew`) ? '\u25B6' : '\u25BC'}
                          </span>
                          <span className="text-[#d2a6ff]">Crew</span>
                          <span className="text-[10px] text-[#4a5159]">({rig.crew.length})</span>
                        </button>
                      </TreeLine>
                      {!collapsedGroups.has(`${rig.rigName}-crew`) &&
                        rig.crew.map((c, ci) => (
                          <WorkerNode
                            key={c.id}
                            worker={c}
                            depth={3}
                            isLast={ci === rig.crew.length - 1}
                            onSelect={onSelectWorker}
                          />
                        ))}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* Empty state */}
        {!overview.mayor && !overview.deacon && overview.rigs.length === 0 && (
          <div className="py-8 text-center text-[#4a5159] text-xs">
            No workers online
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Convoy Dashboard Panel ────────────────────────────────────── */

function ConvoyDashboardPanel({ convoys }: { convoys: Convoy[] }) {
  const [expandedConvoy, setExpandedConvoy] = useState<string | null>(null);

  const activeConvoys = useMemo(() => convoys.filter(c => c.status === 'active'), [convoys]);
  const landedConvoys = useMemo(() => convoys.filter(c => c.status === 'landed' || c.status === 'failed'), [convoys]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2d363f] flex items-center justify-between shrink-0">
        <span className="text-[11px] font-mono uppercase tracking-wider text-[#6c7680]">Convoy Dashboard</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#95e6cb]">{activeConvoys.length} active</span>
          <span className="text-[10px] font-mono text-[#4a5159]">{landedConvoys.length} landed</span>
        </div>
      </div>

      {/* Convoy list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Active convoys */}
        {activeConvoys.map(convoy => {
          const { done, total, pct } = convoyProgress(convoy.beads);
          const isExpanded = expandedConvoy === convoy.id;

          return (
            <motion.div
              key={convoy.id}
              layout
              className="bg-[#1a1f26] border border-[#2d363f] rounded-none"
            >
              <button
                onClick={() => setExpandedConvoy(isExpanded ? null : convoy.id)}
                className="w-full text-left px-3 py-2.5 focus:outline-none"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px]">{'\uD83D\uDE9A'}</span>
                    <span className="text-[11px] font-mono font-semibold text-[#ffb454] uppercase tracking-wide truncate">
                      CONVOY: {convoy.name}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-[#6c7680] shrink-0">
                    {isExpanded ? '\u25BC' : '\u25B6'}
                  </span>
                </div>

                {/* Progress bar */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-[#6c7680]">[{done}/{total}</span>
                  <span className="text-[11px] font-mono text-[#95e6cb]">{progressBar(done, total)}</span>
                  <span className="text-[11px] font-mono text-[#6c7680]">]</span>
                  <span className="text-[11px] font-mono text-[#e6e1cf]">{pct}%</span>
                </div>
              </button>

              {/* Expanded bead tree */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-[#2d363f] px-3 py-2 space-y-0.5">
                      {convoy.beads.map((bead, bi) => {
                        const bs = BEAD_STATUS_ICON[bead.status] || BEAD_STATUS_ICON.READY;
                        const isLastBead = bi === convoy.beads.length - 1;
                        return (
                          <div key={bead.id} className="flex items-center gap-1.5 font-mono text-[11px] leading-5">
                            <span className="text-[#2d363f] select-none">{isLastBead ? '\u2514\u2500\u2500' : '\u251C\u2500\u2500'}</span>
                            <span className="shrink-0" style={{ color: bs.color }}>{bs.icon}</span>
                            <span className="text-[#95e6cb]/70 shrink-0">{bead.id}</span>
                            <span className={`text-[10px] px-1 py-0 ${
                              bead.status === 'DONE' ? 'text-[#c2d94c]' :
                              bead.status === 'WORKING' ? 'text-[#95e6cb]' :
                              bead.status === 'BLOCKED' || bead.status === 'FAILED' ? 'text-[#f07178]' :
                              'text-[#6c7680]'
                            }`}>
                              [{bead.status}]
                            </span>
                            <span className="text-[#e6e1cf]/80 truncate">{bead.title}</span>
                            {bead.assignee && (
                              <span className="text-[#d2a6ff]/50 text-[10px] ml-auto shrink-0">{bead.assignee}</span>
                            )}
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

        {/* Landed convoys */}
        {landedConvoys.length > 0 && (
          <div className="pt-2 border-t border-[#2d363f]/50">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#4a5159] block mb-2">
              LANDED ({landedConvoys.length})
            </span>
            {landedConvoys.slice(0, 10).map(convoy => {
              const { done, total } = convoyProgress(convoy.beads);
              return (
                <div
                  key={convoy.id}
                  className="flex items-center gap-2 px-2 py-1.5 font-mono text-[11px] text-[#4a5159] hover:bg-[#2d363f]/10 transition-colors"
                >
                  <span>{convoy.status === 'failed' ? '\u2717' : '\u2713'}</span>
                  <span className="truncate">{convoy.name}</span>
                  <span className="ml-auto shrink-0">{done}/{total}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {convoys.length === 0 && (
          <div className="py-8 text-center text-[#4a5159] text-xs">
            No active convoys
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Problems Panel (toggle replaces convoy) ───────────────────── */

function ProblemsPanel({
  overview,
  beads,
}: {
  overview: TownOverview;
  beads: ActiveBead[];
}) {
  // Collect all workers from overview
  const allWorkers = useMemo(() => {
    const ws: TreeWorker[] = [];
    if (overview.mayor) ws.push(overview.mayor);
    if (overview.deacon) ws.push(overview.deacon);
    if (overview.boots) ws.push(...overview.boots);
    if (overview.dogs) ws.push(...overview.dogs);
    for (const rig of overview.rigs) {
      if (rig.witness) ws.push(rig.witness);
      if (rig.refinery) ws.push(rig.refinery);
      ws.push(...rig.polecats);
      ws.push(...rig.crew);
    }
    return ws;
  }, [overview]);

  const needsAttention = useMemo(() => {
    const problems: { worker: TreeWorker; reason: string }[] = [];
    for (const w of allWorkers) {
      if (w.status === 'STALE') problems.push({ worker: w, reason: 'GUPP violation: stale >30min' });
      if (w.status === 'ERROR') problems.push({ worker: w, reason: 'Worker error' });
      if (w.status === 'BLOCKED') problems.push({ worker: w, reason: 'Blocked on dependency' });
    }
    // Stale beads (if updatedAt older than 30min)
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    for (const b of beads) {
      if (b.updatedAt && new Date(b.updatedAt).getTime() < thirtyMinAgo) {
        problems.push({
          worker: { id: b.id, name: b.assignee || b.id, role: 'polecat', status: 'STALE', currentBead: b.id },
          reason: `Bead ${b.id} stale >30min`,
        });
      }
    }
    return problems;
  }, [allWorkers, beads]);

  const working = useMemo(() => allWorkers.filter(w => w.status === 'WORKING' || w.status === 'PATROLLING'), [allWorkers]);
  const idle = useMemo(() => allWorkers.filter(w => w.status === 'IDLE' || w.status === 'SLEEPING'), [allWorkers]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2d363f] flex items-center justify-between shrink-0">
        <span className="text-[11px] font-mono uppercase tracking-wider text-[#f07178]">Problems</span>
        <span className="text-[10px] font-mono text-[#4a5159]">{needsAttention.length} issues</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* NEEDS ATTENTION */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 bg-[#f07178] rounded-none" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#f07178]">
              NEEDS ATTENTION ({needsAttention.length})
            </span>
          </div>
          {needsAttention.length === 0 ? (
            <div className="text-[11px] font-mono text-[#4a5159] pl-3">All clear</div>
          ) : (
            <div className="space-y-1">
              {needsAttention.map((p, i) => (
                <div key={`${p.worker.id}-${i}`} className="flex items-start gap-2 pl-3 font-mono text-[11px]">
                  <span className="text-[#f07178] shrink-0">{'\u26A0'}</span>
                  <div className="min-w-0">
                    <span className="text-[#e6e1cf]">{p.worker.name}</span>
                    <span className="text-[#6c7680] ml-2">{p.reason}</span>
                    {p.worker.currentBead && (
                      <span className="text-[#95e6cb]/50 ml-2">{p.worker.currentBead}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* WORKING */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 bg-[#95e6cb] rounded-none" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#95e6cb]">
              WORKING ({working.length})
            </span>
          </div>
          {working.length === 0 ? (
            <div className="text-[11px] font-mono text-[#4a5159] pl-3">No workers active</div>
          ) : (
            <div className="space-y-1">
              {working.map(w => (
                <div key={w.id} className="flex items-center gap-2 pl-3 font-mono text-[11px]">
                  <span style={{ color: STATUS_COLORS[w.status].dot }}>{'\u25CF'}</span>
                  <span className="text-[#e6e1cf]">{w.name}</span>
                  <span className="text-[10px] text-[#6c7680]">[{w.role}]</span>
                  {w.rig && <span className="text-[10px] text-[#ffb454]/50">{w.rig}</span>}
                  {w.currentBead && <span className="text-[10px] text-[#95e6cb]/50 ml-auto">{w.currentBead}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* IDLE */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 bg-[#6c7680] rounded-none" />
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#6c7680]">
              IDLE ({idle.length})
            </span>
          </div>
          {idle.length === 0 ? (
            <div className="text-[11px] font-mono text-[#4a5159] pl-3">None idle</div>
          ) : (
            <div className="space-y-0.5">
              {idle.map(w => (
                <div key={w.id} className="flex items-center gap-2 pl-3 font-mono text-[11px] text-[#4a5159]">
                  <span>{'\u25CB'}</span>
                  <span>{w.name}</span>
                  <span className="text-[10px]">[{w.role}]</span>
                  {w.rig && <span className="text-[10px] text-[#ffb454]/30">{w.rig}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Event Stream Panel ────────────────────────────────────────── */

function EventStreamPanel({
  events,
  paused,
  onTogglePause,
}: {
  events: TimelineEvent[];
  paused: boolean;
  onTogglePause: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Auto-scroll when not paused
  useEffect(() => {
    if (!paused && stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, paused]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    stickToBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2d363f] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-[#6c7680]">Event Stream</span>
          {!paused && (
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="w-1.5 h-1.5 bg-[#c2d94c] rounded-none"
            />
          )}
        </div>
        <button
          onClick={onTogglePause}
          className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border rounded-none transition-colors ${
            paused
              ? 'border-[#ffb454]/30 text-[#ffb454] bg-[#ffb454]/10'
              : 'border-[#2d363f] text-[#6c7680] hover:bg-[#2d363f]/30'
          }`}
        >
          {paused ? 'PAUSED' : 'PAUSE'}
        </button>
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 space-y-0"
      >
        {events.length === 0 && (
          <div className="py-8 text-center text-[#4a5159] text-xs font-mono">
            Waiting for events...
          </div>
        )}
        {events.map(evt => {
          const style = EVENT_STYLE[evt.type] || EVENT_STYLE.system;
          return (
            <div key={evt.id} className="flex items-start gap-1.5 font-mono text-[11px] leading-5 hover:bg-[#2d363f]/10 px-1 transition-colors">
              <span className="text-[#4a5159] shrink-0 select-none">[{formatTs(evt.timestamp)}]</span>
              <span className="shrink-0">{style.icon}</span>
              <span style={{ color: style.color }} className="shrink-0">{evt.actor}</span>
              <span className="text-[#e6e1cf]/70 break-words">{evt.message}</span>
              {evt.beadId && (
                <span className="text-[#95e6cb]/40 shrink-0 ml-auto">({evt.beadId})</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Worker Detail Flyout ──────────────────────────────────────── */

function WorkerDetailFlyout({
  worker,
  onClose,
}: {
  worker: TreeWorker | null;
  onClose: () => void;
}) {
  if (!worker) return null;
  const sc = STATUS_COLORS[worker.status] || STATUS_COLORS.IDLE;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
      className="absolute top-0 left-0 bottom-0 w-72 z-30 bg-[#1a1f26] border-r border-[#2d363f] shadow-xl overflow-y-auto"
    >
      <div className="p-4 space-y-4">
        {/* Close */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase tracking-wider text-[#6c7680]">Worker Detail</span>
          <button onClick={onClose} className="text-[#6c7680] hover:text-[#e6e1cf] text-xs font-mono transition-colors">
            [X]
          </button>
        </div>

        {/* Name + status */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: sc.dot }} className="text-base">{statusIcon(worker.status)}</span>
            <span className="text-lg font-mono text-[#e6e1cf]">{worker.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 text-[10px] font-mono uppercase border rounded-none ${sc.text}`}
              style={{ borderColor: sc.dot + '40', backgroundColor: sc.dot + '15' }}>
              {worker.status}
            </span>
            <span className="text-[10px] font-mono text-[#4a5159] uppercase">{worker.role}</span>
          </div>
        </div>

        {/* Current bead */}
        {worker.currentBead && (
          <div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#4a5159] block mb-1">Current Bead</span>
            <span className="text-xs font-mono text-[#95e6cb]">{worker.currentBead}</span>
          </div>
        )}

        {/* Rig */}
        {worker.rig && (
          <div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#4a5159] block mb-1">Rig</span>
            <span className="text-xs font-mono text-[#ffb454]">{worker.rig}</span>
          </div>
        )}

        {/* Children */}
        {worker.children && worker.children.length > 0 && (
          <div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#4a5159] block mb-1">Sub-agents ({worker.children.length})</span>
            <div className="space-y-1">
              {worker.children.map(c => {
                const csc = STATUS_COLORS[c.status] || STATUS_COLORS.IDLE;
                return (
                  <div key={c.id} className="flex items-center gap-2 font-mono text-[11px]">
                    <span style={{ color: csc.dot }}>{statusIcon(c.status)}</span>
                    <span className="text-[#e6e1cf]">{c.name}</span>
                    <span className="text-[10px] text-[#4a5159]">[{c.status}]</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function FeedView() {
  // ── State ──────────────────────────────────────────────────────
  const [overview, setOverview] = useState<TownOverview>({ rigs: [] });
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [beads, setBeads] = useState<ActiveBead[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [streamPaused, setStreamPaused] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState<TreeWorker | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const lastEventIdRef = useRef<string | null>(null);

  // ── Keyboard shortcut ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'p' || e.key === 'P') {
        // Don't toggle if user is typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        setShowProblems(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Fetch functions ────────────────────────────────────────────
  const fetchOverview = useCallback(async (signal: AbortSignal) => {
    try {
      const [overviewRes, crewRes] = await Promise.allSettled([
        fetch(`${API}/api/meow/workers/overview`, { signal }),
        fetch(`${API}/api/meow/crew`, { signal }),
      ]);

      if (!mountedRef.current) return;

      let parsed: TownOverview = { rigs: [] };

      if (overviewRes.status === 'fulfilled' && overviewRes.value.ok) {
        const data = await overviewRes.value.json();
        parsed = parseOverview(data);
      }

      // Merge crew into rigs if available
      if (crewRes.status === 'fulfilled' && crewRes.value.ok) {
        const crewData = await crewRes.value.json();
        const crewArray = Array.isArray(crewData) ? crewData : crewData.crew || [];
        if (crewArray.length > 0 && parsed.rigs.length > 0) {
          // Add crew to the first rig if not already there
          const firstRig = parsed.rigs[0];
          const existingIds = new Set(firstRig.crew.map((c: TreeWorker) => c.id));
          for (const member of crewArray) {
            if (!existingIds.has(member.id)) {
              firstRig.crew.push({
                id: member.id,
                name: member.name,
                role: 'crew',
                status: member.status === 'active' ? 'WORKING' : member.status === 'paused' ? 'SLEEPING' : 'IDLE',
                currentBead: member.currentAssignment || undefined,
              });
            }
          }
        }
      }

      setOverview(parsed);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // silent — overview is best-effort
    }
  }, []);

  const fetchConvoys = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/convoys`, { signal });
      if (!res.ok || !mountedRef.current) return;
      const data = await res.json();
      setConvoys(Array.isArray(data) ? data : data.convoys || []);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }, []);

  const fetchTimeline = useCallback(async (signal: AbortSignal) => {
    if (streamPaused) return;
    try {
      const res = await fetch(`${API}/api/meow/town/timeline`, { signal });
      if (!res.ok || !mountedRef.current) return;
      const data = await res.json();
      const newEvents: TimelineEvent[] = Array.isArray(data) ? data : data.events || [];

      setEvents(prev => {
        // Merge new events, dedup by id
        const seen = new Set(prev.map(e => e.id));
        const merged = [...prev];
        for (const evt of newEvents) {
          if (!seen.has(evt.id)) {
            merged.push(evt);
            seen.add(evt.id);
          }
        }
        // Sort by timestamp and trim
        merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (merged.length > MAX_EVENTS) {
          return merged.slice(merged.length - MAX_EVENTS);
        }
        return merged;
      });

      if (newEvents.length > 0) {
        lastEventIdRef.current = newEvents[newEvents.length - 1].id;
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }, [streamPaused]);

  const fetchBeads = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/beads?status=in_progress`, { signal });
      if (!res.ok || !mountedRef.current) return;
      const data = await res.json();
      setBeads(Array.isArray(data) ? data : data.beads || []);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }, []);

  // ── Combined fetch ─────────────────────────────────────────────
  const fetchAll = useCallback(async (signal: AbortSignal) => {
    await Promise.allSettled([
      fetchOverview(signal),
      fetchConvoys(signal),
      fetchTimeline(signal),
      fetchBeads(signal),
    ]);
    if (mountedRef.current) {
      setLoading(false);
      setError(null);
    }
  }, [fetchOverview, fetchConvoys, fetchTimeline, fetchBeads]);

  // ── Lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    fetchAll(ctrl.signal);

    const interval = setInterval(() => {
      const c = new AbortController();
      fetchAll(c.signal);
    }, POLL_INTERVAL);

    return () => {
      mountedRef.current = false;
      ctrl.abort();
      clearInterval(interval);
    };
  }, [fetchAll]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono flex flex-col">
      {/* ── Header bar ──────────────────────────────────────────── */}
      <div className="px-4 py-2 border-b border-[#2d363f] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-mono uppercase tracking-wider text-[#e6e1cf]">gt feed</h1>
          {loading && (
            <motion.span
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="text-[10px] font-mono text-[#ffb454]"
            >
              LOADING...
            </motion.span>
          )}
          {error && (
            <span className="text-[10px] font-mono text-[#f07178]">{error}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Problems toggle */}
          <button
            onClick={() => setShowProblems(!showProblems)}
            className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border rounded-none transition-colors ${
              showProblems
                ? 'border-[#f07178]/30 text-[#f07178] bg-[#f07178]/10'
                : 'border-[#2d363f] text-[#6c7680] hover:bg-[#2d363f]/30'
            }`}
          >
            P PROBLEMS
          </button>

          {/* Auto-refresh indicator */}
          <div className="flex items-center gap-1.5">
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="w-1.5 h-1.5 bg-[#c2d94c]/60 rounded-none"
            />
            <span className="text-[10px] font-mono text-[#4a5159]">{POLL_INTERVAL / 1000}s</span>
          </div>
        </div>
      </div>

      {/* ── Three-panel layout ──────────────────────────────────── */}
      <div className="flex-1 flex min-h-0" style={{ height: 'calc(100vh - 80px)' }}>
        {/* Panel 1: Agent Tree (30%) */}
        <div className="w-[30%] border-r border-[#2d363f] relative overflow-hidden">
          <AgentTreePanel overview={overview} onSelectWorker={setSelectedWorker} />

          {/* Worker detail flyout */}
          <AnimatePresence>
            {selectedWorker && (
              <WorkerDetailFlyout worker={selectedWorker} onClose={() => setSelectedWorker(null)} />
            )}
          </AnimatePresence>
        </div>

        {/* Panel 2: Convoy Dashboard or Problems (40%) */}
        <div className="w-[40%] border-r border-[#2d363f]">
          {showProblems ? (
            <ProblemsPanel overview={overview} beads={beads} />
          ) : (
            <ConvoyDashboardPanel convoys={convoys} />
          )}
        </div>

        {/* Panel 3: Event Stream (30%) */}
        <div className="w-[30%]">
          <EventStreamPanel
            events={events}
            paused={streamPaused}
            onTogglePause={() => setStreamPaused(p => !p)}
          />
        </div>
      </div>
    </div>
  );
}
