'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface TimelineEvent {
  id: string;
  ts: string;
  type: string;
  message: string;
  source: string;
  moleculeId?: string;
  level?: string;
  meta?: Record<string, unknown>;
}

interface TimeBucket {
  key: string;
  start: Date;
  end: Date;
  events: TimelineEvent[];
  label: string;
}

type ZoomLevel = '1h' | '6h' | '24h' | '7d';

// ─── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 10000;

const ZOOM_CONFIG: Record<ZoomLevel, { ms: number; bucketMs: number; label: string }> = {
  '1h':  { ms: 60 * 60 * 1000,          bucketMs: 5 * 60 * 1000,       label: '1 Hour'  },
  '6h':  { ms: 6 * 60 * 60 * 1000,      bucketMs: 30 * 60 * 1000,      label: '6 Hours' },
  '24h': { ms: 24 * 60 * 60 * 1000,     bucketMs: 2 * 60 * 60 * 1000,  label: '24 Hours'},
  '7d':  { ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 12 * 60 * 60 * 1000, label: '7 Days'  },
};

const TYPE_COLORS: Record<string, { dot: string; border: string; bg: string; text: string }> = {
  molecule: { dot: 'bg-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  worker:   { dot: 'bg-blue-400',    border: 'border-blue-500/30',    bg: 'bg-blue-500/10',    text: 'text-blue-400'    },
  mail:     { dot: 'bg-amber-400',   border: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-400'   },
  patrol:   { dot: 'bg-violet-400',  border: 'border-violet-500/30',  bg: 'bg-violet-500/10',  text: 'text-violet-400'  },
  error:    { dot: 'bg-red-400',     border: 'border-red-500/30',     bg: 'bg-red-500/10',     text: 'text-red-400'     },
  hook:     { dot: 'bg-cyan-400',    border: 'border-cyan-500/30',    bg: 'bg-cyan-500/10',    text: 'text-cyan-400'    },
  convoy:   { dot: 'bg-orange-400',  border: 'border-orange-500/30',  bg: 'bg-orange-500/10',  text: 'text-orange-400'  },
};

const DEFAULT_COLOR = { dot: 'bg-white/40', border: 'border-white/10', bg: 'bg-white/5', text: 'text-white/60' };

function getTypeColor(type: string) {
  const normalized = type.toLowerCase();
  // Check for error-level events
  if (normalized === 'error' || normalized === 'critical') return TYPE_COLORS.error;
  return TYPE_COLORS[normalized] || DEFAULT_COLOR;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatTimeLabel(date: Date, zoom: ZoomLevel): string {
  if (zoom === '7d') {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (zoom === '24h') {
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function formatFullTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function buildBuckets(events: TimelineEvent[], zoom: ZoomLevel): TimeBucket[] {
  const config = ZOOM_CONFIG[zoom];
  const now = Date.now();
  const start = now - config.ms;
  const buckets: TimeBucket[] = [];

  let cursor = start;
  while (cursor < now) {
    const bucketStart = new Date(cursor);
    const bucketEnd = new Date(cursor + config.bucketMs);
    buckets.push({
      key: `${cursor}`,
      start: bucketStart,
      end: bucketEnd,
      events: [],
      label: formatTimeLabel(bucketStart, zoom),
    });
    cursor += config.bucketMs;
  }

  // Distribute events into buckets
  for (const event of events) {
    const eventTime = new Date(event.ts).getTime();
    for (const bucket of buckets) {
      if (eventTime >= bucket.start.getTime() && eventTime < bucket.end.getTime()) {
        bucket.events.push(event);
        break;
      }
    }
  }

  return buckets;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export default function GasTownTimelineView() {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [zoom, setZoom] = useState<ZoomLevel>('1h');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Fetch events ───────────────────────────────────────────────────────────
  const doFetch = useCallback((controller: AbortController) => {
    const config = ZOOM_CONFIG[zoom];
    const since = new Date(Date.now() - config.ms).toISOString();
    fetch(`${ORCHESTRATOR_URL}/api/meow/town/timeline?since=${since}&limit=100`, {
      signal: controller.signal,
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { events?: TimelineEvent[]; entries?: TimelineEvent[] }) => {
        const items = data.events ?? data.entries ?? [];
        const withIds = items.map((e, i) => ({
          ...e,
          id: e.id || `${e.ts}-${e.type}-${i}`,
        }));
        setEvents(withIds);
        setConnected(true);
        setLoading(false);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          setConnected(false);
          setLoading(false);
        }
      });
  }, [zoom]);

  useEffect(() => {
    const controller = new AbortController();
    doFetch(controller);
    const interval = setInterval(() => {
      if (!controller.signal.aborted) doFetch(controller);
    }, POLL_INTERVAL);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [doFetch]);

  // ─── Buckets ────────────────────────────────────────────────────────────────
  const buckets = useMemo(() => buildBuckets(events, zoom), [events, zoom]);
  const totalEvents = useMemo(() => buckets.reduce((s, b) => s + b.events.length, 0), [buckets]);
  const maxBucketSize = useMemo(() => Math.max(1, ...buckets.map(b => b.events.length)), [buckets]);

  // ─── Bucket width ───────────────────────────────────────────────────────────
  const bucketWidth = useMemo(() => {
    if (buckets.length <= 12) return 120;
    if (buckets.length <= 24) return 90;
    return 70;
  }, [buckets]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0e27] text-white font-mono flex flex-col">
      {/* ── Header ── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="border-b border-white/5 bg-[#0d1117]/80 backdrop-blur-sm px-4 py-3"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <h1 className="text-sm font-bold tracking-[0.2em] uppercase text-white/90">
              GAS TOWN TIMELINE
            </h1>
            <span className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-white/40">
              {totalEvents} events
            </span>
            {/* Connection indicator */}
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              <span className="text-[10px] text-white/20">{connected ? 'LIVE' : 'OFFLINE'}</span>
            </div>
          </div>

          {/* Zoom buttons */}
          <div className="flex items-center gap-1">
            {(['1h', '6h', '24h', '7d'] as ZoomLevel[]).map(z => (
              <button
                key={z}
                onClick={() => { setZoom(z); setExpandedBucket(null); setSelectedEvent(null); }}
                className={`text-[10px] px-3 py-1 rounded border transition-all ${
                  zoom === z
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60 hover:border-white/20'
                }`}
              >
                {z}
              </button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 mt-2">
          {Object.entries(TYPE_COLORS).map(([type, colors]) => (
            <div key={type} className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
              <span className="text-[9px] text-white/30 uppercase">{type}</span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* ── Timeline area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loading && events.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center h-40 text-white/20 text-xs"
          >
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Loading timeline...
            </div>
          </motion.div>
        )}

        {!loading && events.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center h-40 text-white/20 text-xs"
          >
            No events in the last {ZOOM_CONFIG[zoom].label.toLowerCase()}. Waiting for Gas Town activity...
          </motion.div>
        )}

        {/* Horizontal scrollable timeline */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto overflow-y-hidden"
        >
          <div
            className="relative min-h-[400px] pt-6 pb-4 px-4"
            style={{ width: Math.max(buckets.length * bucketWidth + 40, 800) }}
          >
            {/* ── Time axis line ── */}
            <div className="absolute left-4 right-4 top-[100px] h-px bg-white/10" />

            {/* ── Buckets ── */}
            <div className="flex items-start" style={{ gap: 0 }}>
              {buckets.map((bucket, idx) => {
                const hasEvents = bucket.events.length > 0;
                const isExpanded = expandedBucket === bucket.key;
                const barHeight = hasEvents ? Math.max(8, (bucket.events.length / maxBucketSize) * 60) : 0;

                // Get dominant type for color
                const typeCounts: Record<string, number> = {};
                bucket.events.forEach(e => {
                  const t = e.type?.toLowerCase() || 'molecule';
                  typeCounts[t] = (typeCounts[t] || 0) + 1;
                });
                const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'molecule';
                const colors = getTypeColor(dominantType);

                return (
                  <div
                    key={bucket.key}
                    className="flex flex-col items-center relative"
                    style={{ width: bucketWidth }}
                  >
                    {/* Time label */}
                    <span className="text-[9px] text-white/20 mb-1 select-none">
                      {bucket.label}
                    </span>

                    {/* Bar (above axis) */}
                    <div className="relative flex flex-col items-center" style={{ height: 70 }}>
                      <div className="flex-1" />
                      {hasEvents && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: barHeight, opacity: 1 }}
                          transition={{ duration: 0.4, delay: idx * 0.02 }}
                          className={`w-4 rounded-t ${colors.bg} border ${colors.border} border-b-0 cursor-pointer hover:opacity-80 transition-opacity`}
                          onClick={() => {
                            setExpandedBucket(isExpanded ? null : bucket.key);
                            setSelectedEvent(null);
                          }}
                        />
                      )}
                    </div>

                    {/* Dot on axis */}
                    <div className="relative z-10 my-1">
                      {hasEvents ? (
                        <motion.div
                          whileHover={{ scale: 1.4 }}
                          className={`w-3 h-3 rounded-full ${colors.dot} cursor-pointer shadow-lg`}
                          style={{ boxShadow: `0 0 8px ${colors.dot.replace('bg-', '').replace('-400', '')}` }}
                          onClick={() => {
                            setExpandedBucket(isExpanded ? null : bucket.key);
                            setSelectedEvent(null);
                          }}
                        />
                      ) : (
                        <div className="w-1.5 h-1.5 rounded-full bg-white/10" />
                      )}
                    </div>

                    {/* Count badge */}
                    {bucket.events.length > 1 && (
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: idx * 0.02 + 0.2 }}
                        className={`text-[9px] px-1.5 py-0 rounded ${colors.bg} ${colors.text} border ${colors.border} mt-1 cursor-pointer`}
                        onClick={() => {
                          setExpandedBucket(isExpanded ? null : bucket.key);
                          setSelectedEvent(null);
                        }}
                      >
                        {bucket.events.length}
                      </motion.span>
                    )}
                    {bucket.events.length === 1 && (
                      <span className="mt-1 h-[16px]" />
                    )}

                    {/* Vertical connector line */}
                    {hasEvents && (
                      <div className={`w-px h-4 ${isExpanded ? colors.dot.replace('bg-', 'bg-') : 'bg-white/5'}`} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Expanded bucket events ── */}
            <AnimatePresence>
              {expandedBucket && (() => {
                const bucket = buckets.find(b => b.key === expandedBucket);
                if (!bucket || bucket.events.length === 0) return null;
                const bucketIdx = buckets.indexOf(bucket);
                const leftOffset = bucketIdx * bucketWidth + 4;

                return (
                  <motion.div
                    key={expandedBucket}
                    initial={{ opacity: 0, y: -10, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -10, height: 0 }}
                    transition={{ duration: 0.3 }}
                    className="absolute z-20"
                    style={{ left: Math.max(4, Math.min(leftOffset - 100, (buckets.length * bucketWidth) - 380)), top: 220 }}
                  >
                    <div className="bg-[#0d1117] border border-white/10 rounded p-3 w-[360px] max-h-[240px] overflow-y-auto shadow-2xl">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] text-white/40 uppercase tracking-wider">
                          {bucket.label} — {bucket.events.length} event{bucket.events.length > 1 ? 's' : ''}
                        </span>
                        <button
                          onClick={() => setExpandedBucket(null)}
                          className="text-[10px] text-white/20 hover:text-white/60"
                        >
                          CLOSE
                        </button>
                      </div>
                      <div className="space-y-1">
                        {bucket.events.map(event => {
                          const colors = getTypeColor(event.type);
                          const isSelected = selectedEvent?.id === event.id;
                          return (
                            <motion.div
                              key={event.id}
                              initial={{ opacity: 0, x: -4 }}
                              animate={{ opacity: 1, x: 0 }}
                              className={`text-[11px] p-1.5 rounded cursor-pointer transition-all border ${
                                isSelected
                                  ? `${colors.bg} ${colors.border}`
                                  : 'border-transparent hover:bg-white/[0.03]'
                              }`}
                              onClick={() => setSelectedEvent(isSelected ? null : event)}
                            >
                              <div className="flex items-center gap-2">
                                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />
                                <span className="text-white/20 shrink-0">
                                  {formatFullTime(event.ts)}
                                </span>
                                <span className={`${colors.text} uppercase text-[9px] shrink-0`}>
                                  {event.type}
                                </span>
                              </div>
                              <p className="text-white/60 mt-0.5 pl-3.5 truncate">
                                {event.message}
                              </p>
                              {/* Expanded detail */}
                              <AnimatePresence>
                                {isSelected && (
                                  <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="mt-1.5 pl-3.5 space-y-0.5 overflow-hidden"
                                  >
                                    <div className="text-[10px] text-white/30">
                                      <span className="text-white/20">source:</span> {event.source}
                                    </div>
                                    {event.moleculeId && (
                                      <div className="text-[10px] text-white/30">
                                        <span className="text-white/20">molecule:</span>{' '}
                                        <span className="text-violet-400/60">{event.moleculeId}</span>
                                      </div>
                                    )}
                                    {event.level && (
                                      <div className="text-[10px] text-white/30">
                                        <span className="text-white/20">level:</span> {event.level}
                                      </div>
                                    )}
                                    {event.meta && Object.keys(event.meta).length > 0 && (
                                      <div className="text-[10px] text-white/20 mt-1 bg-black/30 p-1 rounded">
                                        {JSON.stringify(event.meta, null, 2).slice(0, 200)}
                                      </div>
                                    )}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                );
              })()}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Type distribution bar ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="px-4 py-2 border-t border-white/5 bg-[#0d1117]/60"
        >
          <div className="flex items-center gap-2 h-4">
            {(() => {
              const typeCounts: Record<string, number> = {};
              events.forEach(e => {
                const t = e.type?.toLowerCase() || 'molecule';
                typeCounts[t] = (typeCounts[t] || 0) + 1;
              });
              const total = events.length || 1;
              return Object.entries(typeCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => {
                  const colors = getTypeColor(type);
                  const pct = (count / total) * 100;
                  return (
                    <motion.div
                      key={type}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(pct, 2)}%` }}
                      transition={{ duration: 0.6 }}
                      className={`h-2 rounded ${colors.dot} relative group cursor-default`}
                      title={`${type}: ${count} (${pct.toFixed(1)}%)`}
                    >
                      <span className="absolute -top-5 left-0 text-[8px] text-white/30 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                        {type}: {count}
                      </span>
                    </motion.div>
                  );
                });
            })()}
          </div>
        </motion.div>
      </div>

      {/* ── Footer ── */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className="border-t border-white/5 bg-[#0d1117]/80 backdrop-blur-sm px-4 py-2 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-white/20">
            WINDOW: {ZOOM_CONFIG[zoom].label}
          </span>
          <span className="text-[10px] text-white/20">
            BUCKETS: {buckets.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/10">
            poll: {POLL_INTERVAL / 1000}s
          </span>
        </div>
      </motion.div>
    </div>
  );
}
