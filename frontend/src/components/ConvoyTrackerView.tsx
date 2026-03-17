'use client';

/**
 * ConvoyTrackerView -- GT-015: Charmbracelet TUI-style Convoy Lifecycle Tracker
 *
 * Visual work-order bundle tracker for the Mayor's convoy system.
 * Convoys bundle beads (tasks) into dispatched work-orders.
 *
 * Features:
 *   1. Horizontal lifecycle pipeline (CREATED -> DISPATCHED -> SWARM -> LANDING -> DELIVERED / FAILED)
 *   2. Convoy cards with expandable bead trees (TUI tree indentation)
 *   3. Create Convoy form with bead selector
 *   4. Detail slide-over panel with history timeline
 *   5. Live SSE activity feed for convoy events
 *
 * Ayu Dark palette:
 *   bg: #0f1419, cards: #1a1f26, text: #e6e1cf, muted: #6c7680
 *   border: #2d363f, green: #c2d94c, yellow: #ffb454, red: #f07178
 *   cyan: #95e6cb, purple: #d2a6ff
 *
 * APIs:
 *   GET  {API}/api/meow/convoys
 *   GET  {API}/api/meow/convoys/{id}
 *   POST {API}/api/meow/mayor/convoy           { name, description, beadIds }
 *   POST {API}/api/meow/mayor/convoy/{id}/dispatch
 *   SSE  {API}/api/events  (event: meow:dispatch, meow:convoy:*)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

type ConvoyStage = 'created' | 'dispatched' | 'swarm' | 'landing' | 'delivered' | 'failed';

type MergeStrategy = 'direct' | 'mr' | 'local';

interface ConvoyBead {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  priority?: string;
  mergeStrategy?: MergeStrategy;
}

interface ConvoyEvent {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  convoyId?: string;
  convoyName?: string;
}

interface Convoy {
  id: string;
  name: string;
  description?: string;
  status: ConvoyStage;
  beadIds: string[];
  beads?: ConvoyBead[];
  mergeStrategy?: MergeStrategy;
  progress: number;
  createdBy?: string;
  createdAt: string;
  updatedAt?: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  events?: ConvoyEvent[];
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_MS = 6000;

const PIPELINE_STAGES: { key: ConvoyStage; label: string; symbol: string }[] = [
  { key: 'created',    label: 'CREATED',    symbol: '+' },
  { key: 'dispatched', label: 'DISPATCHED', symbol: '>' },
  { key: 'swarm',      label: 'SWARM',      symbol: '*' },
  { key: 'landing',    label: 'LANDING',    symbol: 'v' },
  { key: 'delivered',  label: 'DELIVERED',  symbol: '#' },
];

const STAGE_IDX: Record<string, number> = {
  created: 0, dispatched: 1, swarm: 2, landing: 3, delivered: 4, failed: -1,
};

// Ayu Dark palette tokens
const AYU = {
  bg:      '#0f1419',
  card:    '#1a1f26',
  text:    '#e6e1cf',
  muted:   '#6c7680',
  border:  '#2d363f',
  green:   '#c2d94c',
  yellow:  '#ffb454',
  red:     '#f07178',
  cyan:    '#95e6cb',
  purple:  '#d2a6ff',
} as const;

const STAGE_COLORS: Record<ConvoyStage, string> = {
  created:    AYU.muted,
  dispatched: AYU.yellow,
  swarm:      AYU.cyan,
  landing:    AYU.purple,
  delivered:  AYU.green,
  failed:     AYU.red,
};

const MERGE_LABELS: Record<MergeStrategy, { label: string; color: string }> = {
  direct: { label: 'DIRECT', color: AYU.green },
  mr:     { label: 'MR',     color: AYU.purple },
  local:  { label: 'LOCAL',  color: AYU.yellow },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5000)     return 'just now';
  if (diff < 60_000)   return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch { return iso; }
}

function stageOf(status: ConvoyStage): number {
  return STAGE_IDX[status] ?? -1;
}

function clx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

/** Pipeline stage indicator for header */
function PipelineBar({ convoys }: { convoys: Convoy[] }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    PIPELINE_STAGES.forEach(s => { c[s.key] = 0; });
    c['failed'] = 0;
    convoys.forEach(cv => { c[cv.status] = (c[cv.status] || 0) + 1; });
    return c;
  }, [convoys]);

  return (
    <div className="flex items-center gap-0 w-full">
      {PIPELINE_STAGES.map((stage, i) => {
        const color = STAGE_COLORS[stage.key];
        const count = counts[stage.key] || 0;
        const isLast = i === PIPELINE_STAGES.length - 1;

        return (
          <div key={stage.key} className="flex items-center flex-1 min-w-0">
            {/* Stage node */}
            <motion.div
              className="flex flex-col items-center gap-1 flex-shrink-0"
              whileHover={{ scale: 1.05 }}
              transition={{ duration: 0.15 }}
            >
              <div
                className="w-10 h-10 flex items-center justify-center border rounded-none font-mono text-sm font-bold"
                style={{
                  borderColor: count > 0 ? color : `${AYU.border}`,
                  backgroundColor: count > 0 ? `${color}15` : 'transparent',
                  color: count > 0 ? color : AYU.muted,
                }}
              >
                {stage.symbol}
              </div>
              <span className="text-[9px] tracking-[0.15em] uppercase" style={{ color: count > 0 ? color : AYU.muted }}>
                {stage.label}
              </span>
              <span
                className="text-xs font-bold tabular-nums font-mono"
                style={{ color: count > 0 ? color : `${AYU.muted}60` }}
              >
                {count}
              </span>
            </motion.div>

            {/* Connector arrow */}
            {!isLast && (
              <div className="flex-1 flex items-center mx-2">
                <div className="flex-1 h-px" style={{ backgroundColor: `${AYU.border}` }} />
                <span className="text-[10px] mx-1" style={{ color: AYU.muted }}>
                  {'>'}
                </span>
                <div className="flex-1 h-px" style={{ backgroundColor: `${AYU.border}` }} />
              </div>
            )}
          </div>
        );
      })}

      {/* Failed branch */}
      <div className="flex items-center ml-4 flex-shrink-0">
        <div className="w-px h-6" style={{ backgroundColor: AYU.border }} />
        <div className="flex flex-col items-center gap-1 ml-3">
          <div
            className="w-10 h-10 flex items-center justify-center border rounded-none font-mono text-sm font-bold"
            style={{
              borderColor: (counts['failed'] || 0) > 0 ? AYU.red : AYU.border,
              backgroundColor: (counts['failed'] || 0) > 0 ? `${AYU.red}15` : 'transparent',
              color: (counts['failed'] || 0) > 0 ? AYU.red : AYU.muted,
            }}
          >
            !
          </div>
          <span className="text-[9px] tracking-[0.15em] uppercase" style={{ color: (counts['failed'] || 0) > 0 ? AYU.red : AYU.muted }}>
            FAILED
          </span>
          <span className="text-xs font-bold tabular-nums font-mono" style={{ color: (counts['failed'] || 0) > 0 ? AYU.red : `${AYU.muted}60` }}>
            {counts['failed'] || 0}
          </span>
        </div>
      </div>
    </div>
  );
}

/** TUI-style bead tree inside convoy card */
function BeadTree({ beads, expanded }: { beads: ConvoyBead[]; expanded: boolean }) {
  if (!expanded || beads.length === 0) return null;

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="overflow-hidden mt-3 ml-1"
    >
      <div className="font-mono text-[11px] leading-relaxed">
        {beads.map((bead, i) => {
          const isLast = i === beads.length - 1;
          const prefix = isLast ? '\u2514\u2500\u2500' : '\u251C\u2500\u2500';
          const statusColor =
            bead.status === 'done' || bead.status === 'completed' ? AYU.green :
            bead.status === 'in_progress' || bead.status === 'active' ? AYU.cyan :
            bead.status === 'failed' ? AYU.red :
            AYU.muted;
          const mergeInfo = bead.mergeStrategy ? MERGE_LABELS[bead.mergeStrategy] : null;

          return (
            <div key={bead.id} className="flex items-center gap-0 py-0.5">
              <span style={{ color: AYU.muted }}>{prefix} </span>
              <span className="w-1.5 h-1.5 rounded-none inline-block mx-1 flex-shrink-0" style={{ backgroundColor: statusColor }} />
              <span style={{ color: AYU.text }} className="truncate max-w-[200px]">{bead.title || (bead.id ?? '').slice(0, 12) || '?'}</span>
              <span style={{ color: AYU.muted }} className="mx-1.5">{'\u2502'}</span>
              <span style={{ color: statusColor }} className="text-[10px] uppercase">{bead.status}</span>
              {bead.assignee && (
                <>
                  <span style={{ color: AYU.muted }} className="mx-1.5">{'\u2502'}</span>
                  <span style={{ color: AYU.purple }} className="text-[10px]">@{bead.assignee}</span>
                </>
              )}
              {mergeInfo && (
                <>
                  <span style={{ color: AYU.muted }} className="mx-1.5">{'\u2502'}</span>
                  <span style={{ color: mergeInfo.color }} className="text-[10px]">[{mergeInfo.label}]</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

/** Single convoy card */
function ConvoyCard({
  convoy,
  isSelected,
  onSelect,
  onDispatch,
  dispatching,
}: {
  convoy: Convoy;
  isSelected: boolean;
  onSelect: () => void;
  onDispatch: (id: string) => void;
  dispatching: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const stage = stageOf(convoy.status);
  const isFailed = convoy.status === 'failed';
  const color = STAGE_COLORS[convoy.status];
  const beads: ConvoyBead[] = convoy.beads || [];
  const completedBeads = beads.filter(b => b.status === 'done' || b.status === 'completed').length;
  const totalBeads = convoy.beadIds?.length || beads.length || 0;
  const mergeInfo = convoy.mergeStrategy ? MERGE_LABELS[convoy.mergeStrategy] : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className={clx(
        'rounded-none border p-4 transition-all duration-150 cursor-pointer font-mono',
        isSelected ? 'ring-1' : 'hover:border-opacity-60',
      )}
      style={{
        backgroundColor: AYU.card,
        borderColor: isSelected ? color : AYU.border,
        boxShadow: isSelected ? `0 0 20px ${color}15` : 'none',
        ...(isSelected ? { ringColor: color } : {}),
      }}
      onClick={onSelect}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-sm font-bold truncate" style={{ color: AYU.text }}>{convoy.name}</h3>
            {/* Status badge */}
            <span
              className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider border rounded-none font-bold flex-shrink-0"
              style={{
                color,
                borderColor: `${color}40`,
                backgroundColor: `${color}12`,
              }}
            >
              {convoy.status.replace('_', ' ')}
            </span>
            {/* Merge strategy badge */}
            {mergeInfo && (
              <span
                className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider border rounded-none flex-shrink-0"
                style={{
                  color: mergeInfo.color,
                  borderColor: `${mergeInfo.color}40`,
                  backgroundColor: `${mergeInfo.color}10`,
                }}
              >
                {mergeInfo.label}
              </span>
            )}
          </div>

          {convoy.description && (
            <p className="text-[11px] mb-2 line-clamp-2" style={{ color: AYU.muted }}>{convoy.description}</p>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-3 text-[10px]" style={{ color: AYU.muted }}>
            <span>{totalBeads} bead{totalBeads !== 1 ? 's' : ''}</span>
            <span style={{ color: AYU.border }}>{'\u2502'}</span>
            <span style={{ color: AYU.text }}>{(convoy.id ?? '').slice(0, 10)}</span>
            <span style={{ color: AYU.border }}>{'\u2502'}</span>
            <span>{relativeTime(convoy.updatedAt || convoy.createdAt)}</span>
          </div>
        </div>

        {/* Right: progress block */}
        <div className="flex-shrink-0 w-28 text-right">
          <div className="text-xs tabular-nums font-bold mb-1" style={{ color }}>
            {convoy.progress}%
          </div>
          <div className="w-full h-1.5 rounded-none overflow-hidden" style={{ backgroundColor: `${AYU.border}` }}>
            <motion.div
              className="h-full rounded-none"
              style={{
                backgroundColor: isFailed ? AYU.red :
                  convoy.status === 'delivered' ? AYU.green : color,
              }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(convoy.progress, 100)}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <div className="text-[10px] mt-1 tabular-nums" style={{ color: AYU.muted }}>
            {completedBeads}/{totalBeads} beads
          </div>
        </div>
      </div>

      {/* Pipeline mini-bar */}
      <div className="flex items-center gap-1 mt-3">
        {PIPELINE_STAGES.map((s, i) => {
          const sIdx = STAGE_IDX[s.key];
          const completed = !isFailed && stage > sIdx;
          const current = !isFailed && stage === sIdx;
          const stageColor = STAGE_COLORS[s.key];
          const isLast = i === PIPELINE_STAGES.length - 1;

          return (
            <div key={s.key} className="flex items-center flex-1">
              <div
                className="w-5 h-5 flex items-center justify-center rounded-none text-[9px] font-bold border flex-shrink-0"
                style={{
                  backgroundColor: completed ? `${AYU.green}20` : current ? `${stageColor}20` : 'transparent',
                  borderColor: completed ? `${AYU.green}40` : current ? `${stageColor}50` : `${AYU.border}80`,
                  color: completed ? AYU.green : current ? stageColor : `${AYU.muted}60`,
                }}
              >
                {completed ? '\u2713' : isFailed && current ? '!' : s.symbol}
              </div>
              {!isLast && (
                <div
                  className="flex-1 h-px mx-0.5"
                  style={{ backgroundColor: completed ? `${AYU.green}30` : AYU.border }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Expand toggle for bead tree */}
      {totalBeads > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-3 text-[10px] uppercase tracking-[0.1em] hover:underline transition-colors"
          style={{ color: AYU.cyan }}
        >
          {expanded ? '\u25BC hide beads' : `\u25B6 show ${totalBeads} bead${totalBeads !== 1 ? 's' : ''}`}
        </button>
      )}

      <AnimatePresence>
        {expanded && <BeadTree beads={beads} expanded={expanded} />}
      </AnimatePresence>

      {/* Action buttons row */}
      {(convoy.status === 'created') && (
        <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: `1px solid ${AYU.border}` }}>
          <button
            onClick={(e) => { e.stopPropagation(); onDispatch(convoy.id); }}
            disabled={dispatching}
            className="px-3 py-1 text-[10px] uppercase tracking-wider border rounded-none font-bold transition-all hover:brightness-110 disabled:opacity-40"
            style={{
              color: AYU.yellow,
              borderColor: `${AYU.yellow}40`,
              backgroundColor: `${AYU.yellow}10`,
            }}
          >
            {dispatching ? 'dispatching...' : '> dispatch'}
          </button>
        </div>
      )}
    </motion.div>
  );
}

/** SSE-connected live activity feed */
function LiveFeed({ events }: { events: ConvoyEvent[] }) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[11px] font-mono" style={{ color: `${AYU.muted}80` }}>
        waiting for events...
      </div>
    );
  }

  return (
    <div ref={feedRef} className="overflow-y-auto h-full font-mono text-[11px] space-y-0">
      {events.map((evt, i) => {
        const typeColor =
          evt.type.includes('fail') || evt.type.includes('error') ? AYU.red :
          evt.type.includes('deliver') || evt.type.includes('complete') ? AYU.green :
          evt.type.includes('dispatch') ? AYU.yellow :
          evt.type.includes('swarm') ? AYU.cyan :
          AYU.muted;

        return (
          <motion.div
            key={evt.id || `evt-${i}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-start gap-2 py-1.5 px-2 border-b"
            style={{ borderColor: `${AYU.border}50` }}
          >
            <span className="text-[9px] tabular-nums flex-shrink-0 mt-0.5" style={{ color: `${AYU.muted}80` }}>
              {fmtTimestamp(evt.timestamp)}
            </span>
            <span className="text-[9px] uppercase tracking-wider flex-shrink-0 w-20 truncate" style={{ color: typeColor }}>
              {evt.type.replace('meow:', '').replace('convoy:', '')}
            </span>
            <span className="truncate flex-1" style={{ color: AYU.text }}>
              {evt.message}
            </span>
            {evt.convoyName && (
              <span className="text-[9px] flex-shrink-0" style={{ color: AYU.purple }}>
                [{evt.convoyName}]
              </span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function ConvoyTrackerView() {
  // ── State ────────────────────────────────────────────────────────────────────
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);

  // Filters
  const [filterStage, setFilterStage] = useState<ConvoyStage | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Convoy | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formBeadIds, setFormBeadIds] = useState<string[]>([]);
  const [availableBeads, setAvailableBeads] = useState<ConvoyBead[]>([]);
  const [beadSearch, setBeadSearch] = useState('');
  const [creating, setCreating] = useState(false);

  // Actions
  const [dispatching, setDispatching] = useState<string | null>(null);

  // Live feed
  const [sseConnected, setSseConnected] = useState(false);
  const [feedEvents, setFeedEvents] = useState<ConvoyEvent[]>([]);
  const [showFeed, setShowFeed] = useState(true);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  // ── Fetch: Convoy List ───────────────────────────────────────────────────────

  const fetchConvoys = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/convoys?limit=100`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: Convoy[] = Array.isArray(data?.convoys) ? data.convoys : Array.isArray(data) ? data : [];
      setConvoys(list);
      setDataSource(data.source || 'db');
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Failed to load convoys');
      setDataSource('mock');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch: Convoy Detail ─────────────────────────────────────────────────────

  const fetchDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`${API}/api/meow/convoys/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const convoy: Convoy = data.convoy || data;
      setDetail(convoy);
    } catch {
      // Fallback: use the convoy from list
      const fromList = convoys.find(c => c.id === id);
      setDetail(fromList || null);
    } finally {
      setLoadingDetail(false);
    }
  }, [convoys]);

  // ── Fetch: Available Beads ───────────────────────────────────────────────────

  const fetchAvailableBeads = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/beads?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data?.beads) ? data.beads : Array.isArray(data) ? data : [];
      setAvailableBeads(list);
    } catch {
      setAvailableBeads([]);
    }
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const dispatchConvoy = useCallback(async (id: string) => {
    setDispatching(id);
    try {
      const res = await fetch(`${API}/api/meow/mayor/convoy/${id}/dispatch`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Optimistic update
      setConvoys(prev => prev.map(c =>
        c.id === id ? { ...c, status: 'dispatched' as ConvoyStage, dispatchedAt: new Date().toISOString() } : c
      ));
      if (detail?.id === id) {
        setDetail(prev => prev ? { ...prev, status: 'dispatched', dispatchedAt: new Date().toISOString() } : null);
      }
      // Add feed event
      setFeedEvents(prev => [{
        id: `local-${Date.now()}`,
        type: 'dispatch',
        message: `Convoy dispatched`,
        timestamp: new Date().toISOString(),
        convoyId: id,
        convoyName: convoys.find(c => c.id === id)?.name,
      }, ...prev].slice(0, 100));
    } catch (err) {
      console.error('[ConvoyTracker] dispatch failed:', err);
    } finally {
      setDispatching(null);
    }
  }, [detail, convoys]);

  const createConvoy = useCallback(async () => {
    if (!formName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`${API}/api/meow/mayor/convoy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDesc.trim() || undefined,
          beadIds: formBeadIds,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Reset form
      setFormName('');
      setFormDesc('');
      setFormBeadIds([]);
      setBeadSearch('');
      setShowCreate(false);
      // Refresh list
      fetchConvoys();
      // Feed event
      setFeedEvents(prev => [{
        id: `local-${Date.now()}`,
        type: 'create',
        message: `Convoy "${formName.trim()}" created with ${formBeadIds.length} beads`,
        timestamp: new Date().toISOString(),
      }, ...prev].slice(0, 100));
    } catch (err) {
      console.error('[ConvoyTracker] create failed:', err);
    } finally {
      setCreating(false);
    }
  }, [formName, formDesc, formBeadIds, fetchConvoys]);

  // ── Effects ──────────────────────────────────────────────────────────────────

  // Initial fetch + polling
  useEffect(() => {
    const ac = new AbortController();
    fetchConvoys(ac.signal);
    pollRef.current = setInterval(() => {
      const inner = new AbortController();
      fetchConvoys(inner.signal);
    }, POLL_MS);
    return () => {
      ac.abort();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchConvoys]);

  // Fetch detail when selectedId changes
  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
    else setDetail(null);
  }, [selectedId, fetchDetail]);

  // Fetch available beads when create form opens
  useEffect(() => {
    if (showCreate) fetchAvailableBeads();
  }, [showCreate, fetchAvailableBeads]);

  // SSE connection for live events
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(`${API}/api/events`);
      sseRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onerror = () => setSseConnected(false);

      const handleConvoyEvent = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const newEvt: ConvoyEvent = {
            id: data.id || `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: event.type || data.type || 'convoy',
            message: data.message || data.summary || JSON.stringify(data).slice(0, 120),
            timestamp: data.timestamp || new Date().toISOString(),
            convoyId: data.convoyId || data.convoy_id,
            convoyName: data.convoyName || data.convoy_name,
          };
          setFeedEvents(prev => [newEvt, ...prev].slice(0, 100));

          // Also refresh convoy list on meaningful events
          if (data.convoyId || data.convoy_id) {
            fetchConvoys();
          }
        } catch { /* ignore malformed SSE */ }
      };

      // Listen to convoy-related SSE events
      es.addEventListener('meow:dispatch', handleConvoyEvent);
      es.addEventListener('meow:convoy:update', handleConvoyEvent);
      es.addEventListener('meow:convoy:delivered', handleConvoyEvent);
      es.addEventListener('meow:convoy:failed', handleConvoyEvent);
      es.addEventListener('meow:convoy:progress', handleConvoyEvent);
      es.addEventListener('convoy', handleConvoyEvent);

      // Generic message fallback
      es.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type?.includes('convoy') || data.convoyId) {
            handleConvoyEvent(event);
          }
        } catch { /* ignore */ }
      };
    } catch {
      setSseConnected(false);
    }

    return () => {
      if (es) { es.close(); }
      sseRef.current = null;
    };
  }, [fetchConvoys]);

  // ESC to close panels
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCreate) setShowCreate(false);
        else if (selectedId) setSelectedId(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showCreate, selectedId]);

  // ── Derived Data ─────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return convoys.filter(c => {
      if (filterStage !== 'all' && c.status !== filterStage) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [convoys, filterStage, searchQuery]);

  const totalStats = useMemo(() => ({
    total: convoys.length,
    active: convoys.filter(c => c.status !== 'delivered' && c.status !== 'failed').length,
    delivered: convoys.filter(c => c.status === 'delivered').length,
    failed: convoys.filter(c => c.status === 'failed').length,
    avgProgress: convoys.length > 0
      ? Math.round(convoys.reduce((sum, c) => sum + (c.progress || 0), 0) / convoys.length)
      : 0,
  }), [convoys]);

  const filteredAvailableBeads = useMemo(() => {
    if (!beadSearch.trim()) return availableBeads;
    const q = beadSearch.toLowerCase();
    return availableBeads.filter(b =>
      (b.title || '').toLowerCase().includes(q) || b.id.toLowerCase().includes(q)
    );
  }, [availableBeads, beadSearch]);

  // ── Detail panel data ────────────────────────────────────────────────────────

  const detailConvoy = detail || convoys.find(c => c.id === selectedId) || null;
  const detailBeads: ConvoyBead[] = detailConvoy?.beads || [];
  const detailEvents: ConvoyEvent[] = detailConvoy?.events || [];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col font-mono overflow-hidden" style={{ backgroundColor: AYU.bg, color: AYU.text }}>

      {/* ================================================================== */}
      {/*  HEADER                                                            */}
      {/* ================================================================== */}
      <header className="flex-none px-6 py-4 border-b" style={{ borderColor: AYU.border }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-bold tracking-[0.2em] uppercase" style={{ color: AYU.text }}>
              Convoy Tracker
            </h1>
            <span className="text-[9px] tracking-[0.15em] uppercase" style={{ color: AYU.muted }}>
              work-order lifecycle
            </span>
            {/* Data source badge */}
            {dataSource === 'db' && (
              <span className="px-2 py-0.5 text-[9px] tracking-wider uppercase border rounded-none"
                style={{ color: AYU.green, borderColor: `${AYU.green}30`, backgroundColor: `${AYU.green}10` }}>
                LIVE
              </span>
            )}
            {dataSource === 'mock' && (
              <span className="px-2 py-0.5 text-[9px] tracking-wider uppercase border rounded-none"
                style={{ color: AYU.yellow, borderColor: `${AYU.yellow}30`, backgroundColor: `${AYU.yellow}10` }}>
                OFFLINE
              </span>
            )}
            {/* SSE indicator */}
            <span className="flex items-center gap-1 text-[9px]" style={{ color: sseConnected ? AYU.green : AYU.red }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: sseConnected ? AYU.green : AYU.red }} />
              SSE
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFeed(!showFeed)}
              className="px-2.5 py-1 text-[10px] uppercase tracking-wider border rounded-none transition-all"
              style={{
                color: showFeed ? AYU.cyan : AYU.muted,
                borderColor: showFeed ? `${AYU.cyan}40` : AYU.border,
                backgroundColor: showFeed ? `${AYU.cyan}10` : 'transparent',
              }}
            >
              feed {showFeed ? 'on' : 'off'}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="px-3 py-1 text-[10px] uppercase tracking-wider border rounded-none transition-all hover:brightness-110"
              style={{ color: AYU.green, borderColor: `${AYU.green}40`, backgroundColor: `${AYU.green}10` }}
            >
              + new convoy
            </button>
          </div>
        </div>

        {/* Pipeline bar */}
        <div className="mb-4">
          <PipelineBar convoys={convoys} />
        </div>

        {/* Stats + Filters row */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {[
              { label: 'total', value: totalStats.total, color: AYU.text },
              { label: 'active', value: totalStats.active, color: AYU.cyan },
              { label: 'delivered', value: totalStats.delivered, color: AYU.green },
              { label: 'failed', value: totalStats.failed, color: AYU.red },
              { label: 'avg %', value: `${totalStats.avgProgress}%`, color: AYU.yellow },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-1.5 text-[10px]">
                <span style={{ color: AYU.muted }}>{s.label}:</span>
                <span className="font-bold tabular-nums" style={{ color: s.color }}>{s.value}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="search..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="px-2.5 py-1 text-[11px] border rounded-none w-44 focus:outline-none placeholder-opacity-40"
              style={{
                backgroundColor: AYU.card,
                borderColor: AYU.border,
                color: AYU.text,
              }}
            />
            <select
              value={filterStage}
              onChange={e => setFilterStage(e.target.value as ConvoyStage | 'all')}
              className="px-2 py-1 text-[11px] border rounded-none focus:outline-none appearance-none cursor-pointer"
              style={{ backgroundColor: AYU.card, borderColor: AYU.border, color: AYU.muted }}
            >
              <option value="all">all stages</option>
              <option value="created">created</option>
              <option value="dispatched">dispatched</option>
              <option value="swarm">swarm</option>
              <option value="landing">landing</option>
              <option value="delivered">delivered</option>
              <option value="failed">failed</option>
            </select>
            <button
              onClick={() => fetchConvoys()}
              className="px-2 py-1 text-[10px] uppercase border rounded-none transition-colors"
              style={{ color: AYU.muted, borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              refresh
            </button>
          </div>
        </div>
      </header>

      {/* ================================================================== */}
      {/*  MAIN CONTENT AREA                                                 */}
      {/* ================================================================== */}
      <div className="flex-1 flex overflow-hidden">

        {/* Left: Convoy cards */}
        <div className={clx('flex-1 overflow-y-auto p-4 space-y-3', showFeed && 'pr-0')}>
          {error && !loading && convoys.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-full gap-4"
            >
              <pre className="text-sm" style={{ color: AYU.red }}>
{`  ___ ___ ___
 | -_|  _|  _|
 |___|_| |_|`}
              </pre>
              <div className="text-[11px]" style={{ color: AYU.muted }}>{error}</div>
              <p className="text-[10px] max-w-xs text-center" style={{ color: `${AYU.muted}80` }}>
                Unable to reach convoy endpoint. Check the orchestrator connection.
              </p>
              <button
                onClick={() => { setLoading(true); fetchConvoys(); }}
                className="text-[10px] uppercase tracking-widest px-4 py-1.5 border rounded-none transition-colors"
                style={{ color: AYU.yellow, borderColor: `${AYU.yellow}40` }}
              >
                retry
              </button>
            </motion.div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-28 border rounded-none animate-pulse"
                  style={{ backgroundColor: AYU.card, borderColor: AYU.border }}
                />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <pre className="text-[10px]" style={{ color: `${AYU.muted}60` }}>
{`    ___
   /   \\
  | () () |
   \\  ^  /
    |||||
    |||||`}
              </pre>
              <div className="text-[11px]" style={{ color: AYU.muted }}>no convoys found</div>
              <p className="text-[10px]" style={{ color: `${AYU.muted}60` }}>
                {searchQuery || filterStage !== 'all'
                  ? 'try adjusting your filters'
                  : 'create a convoy to bundle beads into work-orders'}
              </p>
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              {filtered.map(convoy => (
                <ConvoyCard
                  key={convoy.id}
                  convoy={convoy}
                  isSelected={selectedId === convoy.id}
                  onSelect={() => setSelectedId(selectedId === convoy.id ? null : convoy.id)}
                  onDispatch={dispatchConvoy}
                  dispatching={dispatching === convoy.id}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Right: Live Activity Feed */}
        {showFeed && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="flex-shrink-0 border-l flex flex-col overflow-hidden"
            style={{ borderColor: AYU.border, backgroundColor: `${AYU.card}` }}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: AYU.border }}>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.15em] font-bold" style={{ color: AYU.text }}>
                  live feed
                </span>
                <span className="text-[9px] tabular-nums" style={{ color: AYU.muted }}>
                  ({feedEvents.length})
                </span>
              </div>
              {feedEvents.length > 0 && (
                <button
                  onClick={() => setFeedEvents([])}
                  className="text-[9px] uppercase tracking-wider"
                  style={{ color: AYU.muted }}
                >
                  clear
                </button>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              <LiveFeed events={feedEvents} />
            </div>
          </motion.div>
        )}
      </div>

      {/* ================================================================== */}
      {/*  DETAIL SLIDE-OVER PANEL                                           */}
      {/* ================================================================== */}
      <AnimatePresence>
        {selectedId && detailConvoy && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40"
              style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
              onClick={() => setSelectedId(null)}
            />

            {/* Panel */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="fixed inset-y-0 right-0 w-[480px] z-50 flex flex-col border-l shadow-2xl overflow-hidden"
              style={{ backgroundColor: AYU.bg, borderColor: AYU.border }}
            >
              {/* Panel header */}
              <div className="flex-none px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: AYU.border }}>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.15em] font-bold" style={{ color: AYU.muted }}>
                    convoy detail
                  </div>
                  <div className="text-[10px] font-mono mt-0.5" style={{ color: `${AYU.muted}80` }}>
                    {detailConvoy.id}
                  </div>
                </div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="w-7 h-7 flex items-center justify-center border rounded-none text-xs transition-colors"
                  style={{ color: AYU.muted, borderColor: AYU.border }}
                >
                  x
                </button>
              </div>

              {/* Panel body */}
              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
                {loadingDetail && (
                  <div className="flex items-center gap-2 text-[11px]" style={{ color: AYU.muted }}>
                    <span className="animate-spin">-</span> loading detail...
                  </div>
                )}

                {/* Name + status */}
                <div>
                  <h2 className="text-base font-bold mb-2" style={{ color: AYU.text }}>{detailConvoy.name}</h2>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded-none font-bold"
                      style={{
                        color: STAGE_COLORS[detailConvoy.status],
                        borderColor: `${STAGE_COLORS[detailConvoy.status]}40`,
                        backgroundColor: `${STAGE_COLORS[detailConvoy.status]}12`,
                      }}
                    >
                      {detailConvoy.status}
                    </span>
                    <span className="text-[10px] tabular-nums" style={{ color: AYU.muted }}>
                      {detailConvoy.progress}% complete
                    </span>
                    {detailConvoy.mergeStrategy && (
                      <span
                        className="px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded-none"
                        style={{
                          color: MERGE_LABELS[detailConvoy.mergeStrategy].color,
                          borderColor: `${MERGE_LABELS[detailConvoy.mergeStrategy].color}40`,
                          backgroundColor: `${MERGE_LABELS[detailConvoy.mergeStrategy].color}10`,
                        }}
                      >
                        {MERGE_LABELS[detailConvoy.mergeStrategy].label}
                      </span>
                    )}
                  </div>
                  {detailConvoy.description && (
                    <p className="text-[11px] mt-2 leading-relaxed" style={{ color: AYU.muted }}>
                      {detailConvoy.description}
                    </p>
                  )}
                </div>

                {/* Progress bar */}
                <div>
                  <div className="w-full h-2 rounded-none overflow-hidden" style={{ backgroundColor: AYU.border }}>
                    <motion.div
                      className="h-full rounded-none"
                      style={{ backgroundColor: STAGE_COLORS[detailConvoy.status] }}
                      initial={{ width: 0 }}
                      animate={{ width: `${detailConvoy.progress}%` }}
                      transition={{ duration: 0.6 }}
                    />
                  </div>
                </div>

                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {[
                    { label: 'created by', value: detailConvoy.createdBy || 'system' },
                    { label: 'beads', value: `${detailConvoy.beadIds?.length || 0}` },
                    { label: 'created', value: fmtTimestamp(detailConvoy.createdAt) },
                    { label: 'last activity', value: relativeTime(detailConvoy.updatedAt || detailConvoy.createdAt) },
                    ...(detailConvoy.dispatchedAt ? [{ label: 'dispatched', value: fmtTimestamp(detailConvoy.dispatchedAt) }] : []),
                    ...(detailConvoy.deliveredAt ? [{ label: 'delivered', value: fmtTimestamp(detailConvoy.deliveredAt) }] : []),
                  ].map(item => (
                    <div key={item.label}>
                      <div className="text-[9px] uppercase tracking-wider mb-0.5" style={{ color: AYU.muted }}>{item.label}</div>
                      <div className="text-[11px] tabular-nums" style={{ color: AYU.text }}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {/* Pipeline visualization */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider mb-3" style={{ color: AYU.muted }}>pipeline stage</div>
                  <div className="flex items-center gap-1">
                    {PIPELINE_STAGES.map((s, i) => {
                      const sIdx = STAGE_IDX[s.key];
                      const curIdx = stageOf(detailConvoy.status);
                      const isFailed = detailConvoy.status === 'failed';
                      const completed = !isFailed && curIdx > sIdx;
                      const current = !isFailed && curIdx === sIdx;
                      const stageColor = STAGE_COLORS[s.key];
                      const isLast = i === PIPELINE_STAGES.length - 1;

                      return (
                        <div key={s.key} className="flex items-center flex-1">
                          <div
                            className="w-full py-1 text-center text-[9px] uppercase tracking-wider border rounded-none font-bold"
                            style={{
                              backgroundColor: completed ? `${AYU.green}15` : current ? `${stageColor}15` : 'transparent',
                              borderColor: completed ? `${AYU.green}40` : current ? `${stageColor}50` : AYU.border,
                              color: completed ? AYU.green : current ? stageColor : `${AYU.muted}60`,
                            }}
                          >
                            {completed ? `\u2713 ${s.label}` : s.label}
                          </div>
                          {!isLast && (
                            <span className="mx-0.5 text-[10px] flex-shrink-0" style={{ color: completed ? AYU.green : AYU.border }}>
                              {'>'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* History Timeline */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider mb-3" style={{ color: AYU.muted }}>history timeline</div>
                  <div className="relative pl-5 space-y-3">
                    <div className="absolute left-[7px] top-1 bottom-1 w-px" style={{ backgroundColor: AYU.border }} />

                    {/* Built-in timeline events from convoy state */}
                    {[
                      { label: 'Created', ts: detailConvoy.createdAt, active: true, color: AYU.muted },
                      ...(detailConvoy.dispatchedAt
                        ? [{ label: 'Dispatched', ts: detailConvoy.dispatchedAt, active: true, color: AYU.yellow }]
                        : [{ label: 'Dispatched', ts: undefined as string | undefined, active: false, color: AYU.muted }]),
                      ...(stageOf(detailConvoy.status) >= 2 && detailConvoy.status !== 'failed'
                        ? [{ label: 'Swarm started', ts: detailConvoy.dispatchedAt, active: true, color: AYU.cyan }]
                        : [{ label: 'Swarm', ts: undefined as string | undefined, active: false, color: AYU.muted }]),
                      ...(stageOf(detailConvoy.status) >= 3 && detailConvoy.status !== 'failed'
                        ? [{ label: 'Landing', ts: detailConvoy.updatedAt, active: true, color: AYU.purple }]
                        : []),
                      ...(detailConvoy.deliveredAt
                        ? [{ label: 'Delivered', ts: detailConvoy.deliveredAt, active: true, color: AYU.green }]
                        : []),
                      ...(detailConvoy.status === 'failed'
                        ? [{ label: 'Failed', ts: detailConvoy.updatedAt || detailConvoy.createdAt, active: true, color: AYU.red }]
                        : []),
                      // Append any server-provided events
                      ...detailEvents.map(evt => ({
                        label: evt.type, ts: evt.timestamp, active: true, color: AYU.text,
                        message: evt.message,
                      })),
                    ].map((evt, i) => (
                      <div key={`tl-${i}`} className="relative flex items-start gap-3">
                        <div
                          className="absolute left-[-14px] top-[5px] w-[9px] h-[9px] rounded-none border"
                          style={{
                            backgroundColor: evt.active ? `${evt.color}30` : 'transparent',
                            borderColor: evt.active ? `${evt.color}60` : AYU.border,
                          }}
                        />
                        <div>
                          <div className="text-[11px]" style={{ color: evt.active ? evt.color : `${AYU.muted}50` }}>
                            {evt.label}
                          </div>
                          {evt.ts && (
                            <div className="text-[9px] tabular-nums" style={{ color: `${AYU.muted}80` }}>
                              {fmtTimestamp(evt.ts)}
                            </div>
                          )}
                          {'message' in evt && evt.message && (
                            <div className="text-[10px] mt-0.5" style={{ color: AYU.muted }}>
                              {evt.message as string}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bead Tree */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: AYU.muted }}>
                    beads ({detailConvoy.beadIds?.length || 0})
                  </div>
                  {detailBeads.length > 0 ? (
                    <div
                      className="border rounded-none p-3 max-h-[280px] overflow-y-auto"
                      style={{ borderColor: AYU.border, backgroundColor: `${AYU.card}` }}
                    >
                      <BeadTree beads={detailBeads} expanded={true} />
                    </div>
                  ) : detailConvoy.beadIds?.length > 0 ? (
                    <div className="space-y-1">
                      {detailConvoy.beadIds.map((bid, i) => {
                        const isLast = i === detailConvoy.beadIds.length - 1;
                        const prefix = isLast ? '\u2514\u2500\u2500' : '\u251C\u2500\u2500';
                        return (
                          <div key={bid} className="text-[11px] font-mono" style={{ color: AYU.muted }}>
                            {prefix} {bid}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-[11px] italic" style={{ color: `${AYU.muted}60` }}>no beads attached</div>
                  )}
                </div>

                {/* Merge Strategy Config */}
                <div>
                  <div className="text-[9px] uppercase tracking-wider mb-2" style={{ color: AYU.muted }}>
                    merge strategy
                  </div>
                  <div className="flex items-center gap-2">
                    {(Object.keys(MERGE_LABELS) as MergeStrategy[]).map(strat => {
                      const info = MERGE_LABELS[strat];
                      const isActive = detailConvoy.mergeStrategy === strat;
                      return (
                        <div
                          key={strat}
                          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border rounded-none"
                          style={{
                            color: isActive ? info.color : `${AYU.muted}60`,
                            borderColor: isActive ? `${info.color}50` : AYU.border,
                            backgroundColor: isActive ? `${info.color}12` : 'transparent',
                          }}
                        >
                          {info.label}
                        </div>
                      );
                    })}
                    {!detailConvoy.mergeStrategy && (
                      <span className="text-[10px] italic" style={{ color: `${AYU.muted}60` }}>not configured</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Panel actions footer */}
              <div className="flex-none px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: AYU.border }}>
                {(detailConvoy.status === 'created' || detailConvoy.status === ('assembling' as ConvoyStage)) && (
                  <button
                    onClick={() => dispatchConvoy(detailConvoy.id)}
                    disabled={dispatching === detailConvoy.id}
                    className="px-4 py-1.5 text-[10px] uppercase tracking-wider border rounded-none font-bold transition-all disabled:opacity-40"
                    style={{ color: AYU.yellow, borderColor: `${AYU.yellow}40`, backgroundColor: `${AYU.yellow}10` }}
                  >
                    {dispatching === detailConvoy.id ? 'dispatching...' : '> dispatch'}
                  </button>
                )}
                <button
                  onClick={() => setSelectedId(null)}
                  className="px-3 py-1.5 text-[10px] uppercase tracking-wider border rounded-none transition-colors"
                  style={{ color: AYU.muted, borderColor: AYU.border }}
                >
                  close
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ================================================================== */}
      {/*  CREATE CONVOY MODAL                                               */}
      {/* ================================================================== */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
            onClick={() => setShowCreate(false)}
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="w-[540px] max-h-[80vh] border flex flex-col rounded-none shadow-2xl"
              style={{ backgroundColor: AYU.bg, borderColor: AYU.border }}
              onClick={e => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: AYU.border }}>
                <span className="text-xs font-bold uppercase tracking-[0.15em]" style={{ color: AYU.text }}>
                  new convoy
                </span>
                <button
                  onClick={() => setShowCreate(false)}
                  className="w-6 h-6 flex items-center justify-center border rounded-none text-[10px] transition-colors"
                  style={{ color: AYU.muted, borderColor: AYU.border }}
                >
                  x
                </button>
              </div>

              {/* Modal body */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-[9px] uppercase tracking-wider mb-1.5" style={{ color: AYU.muted }}>
                    convoy name *
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    placeholder="e.g., sprint-42-delivery"
                    autoFocus
                    className="w-full px-3 py-2 text-[11px] border rounded-none focus:outline-none"
                    style={{
                      backgroundColor: AYU.card,
                      borderColor: AYU.border,
                      color: AYU.text,
                    }}
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="block text-[9px] uppercase tracking-wider mb-1.5" style={{ color: AYU.muted }}>
                    description
                  </label>
                  <textarea
                    value={formDesc}
                    onChange={e => setFormDesc(e.target.value)}
                    placeholder="what this convoy delivers..."
                    rows={3}
                    className="w-full px-3 py-2 text-[11px] border rounded-none focus:outline-none resize-none"
                    style={{
                      backgroundColor: AYU.card,
                      borderColor: AYU.border,
                      color: AYU.text,
                    }}
                  />
                </div>

                {/* Bead selector */}
                <div>
                  <label className="block text-[9px] uppercase tracking-wider mb-1.5" style={{ color: AYU.muted }}>
                    select beads ({formBeadIds.length} selected)
                  </label>
                  <input
                    type="text"
                    value={beadSearch}
                    onChange={e => setBeadSearch(e.target.value)}
                    placeholder="filter beads..."
                    className="w-full px-3 py-1.5 text-[11px] border rounded-none focus:outline-none mb-2"
                    style={{
                      backgroundColor: AYU.card,
                      borderColor: AYU.border,
                      color: AYU.text,
                    }}
                  />
                  <div
                    className="max-h-[220px] overflow-y-auto border rounded-none"
                    style={{ borderColor: AYU.border }}
                  >
                    {filteredAvailableBeads.length === 0 ? (
                      <div className="px-3 py-6 text-[11px] text-center" style={{ color: `${AYU.muted}60` }}>
                        {availableBeads.length === 0 ? 'loading beads...' : 'no beads match filter'}
                      </div>
                    ) : (
                      filteredAvailableBeads.map(bead => {
                        const isSelected = formBeadIds.includes(bead.id);
                        return (
                          <button
                            key={bead.id}
                            onClick={() => {
                              setFormBeadIds(prev =>
                                isSelected ? prev.filter(id => id !== bead.id) : [...prev, bead.id]
                              );
                            }}
                            className="w-full text-left flex items-center gap-2 px-3 py-2 text-[11px] border-b transition-colors"
                            style={{
                              borderColor: `${AYU.border}50`,
                              backgroundColor: isSelected ? `${AYU.cyan}08` : 'transparent',
                              color: isSelected ? AYU.cyan : AYU.text,
                            }}
                          >
                            <span
                              className="w-3 h-3 flex items-center justify-center border rounded-none flex-shrink-0 text-[8px]"
                              style={{
                                backgroundColor: isSelected ? `${AYU.cyan}30` : 'transparent',
                                borderColor: isSelected ? `${AYU.cyan}60` : AYU.border,
                                color: isSelected ? AYU.cyan : 'transparent',
                              }}
                            >
                              {isSelected ? '\u2713' : ''}
                            </span>
                            <span className="truncate flex-1">{bead.title || bead.id}</span>
                            {bead.status && (
                              <span className="text-[9px] flex-shrink-0" style={{ color: AYU.muted }}>
                                {bead.status}
                              </span>
                            )}
                            <span className="text-[9px] font-mono flex-shrink-0" style={{ color: `${AYU.muted}60` }}>
                              {(bead.id ?? '').slice(0, 8)}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Modal footer */}
              <div className="flex justify-between items-center px-5 py-3 border-t" style={{ borderColor: AYU.border }}>
                <span className="text-[9px]" style={{ color: `${AYU.muted}60` }}>
                  {formBeadIds.length > 0 ? `${formBeadIds.length} bead${formBeadIds.length !== 1 ? 's' : ''} will be bundled` : 'no beads selected'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowCreate(false)}
                    className="px-3 py-1.5 text-[10px] uppercase tracking-wider border rounded-none transition-colors"
                    style={{ color: AYU.muted, borderColor: AYU.border }}
                  >
                    cancel
                  </button>
                  <button
                    onClick={createConvoy}
                    disabled={!formName.trim() || creating}
                    className="px-4 py-1.5 text-[10px] uppercase tracking-wider border rounded-none font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      color: AYU.green,
                      borderColor: `${AYU.green}40`,
                      backgroundColor: `${AYU.green}10`,
                    }}
                  >
                    {creating ? 'creating...' : '+ create convoy'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
