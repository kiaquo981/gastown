'use client';

/**
 * PatrolView — Patrol Command Center (EP-146)
 * Visualization of Deacon, Witness, and Refinery patrol loops
 * with exponential backoff, health gauges, and timeline reports.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ── Ayu Dark palette ──────────────────────────────────────────────
const C = {
  bg: '#0f1419',
  card: '#1a1f26',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

// ── Types ──────────────────────────────────────────────────────────
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
  durationMs?: number;
}

interface PatrolHealth {
  status: 'running' | 'stopped' | 'unknown';
  intervalMs?: number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  consecutiveClean?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  healthScore?: number;
}

type PatrolType = 'deacon' | 'witness' | 'refinery';

interface PatrolState {
  health: PatrolHealth;
  reports: PatrolReport[];
  loading: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────
function rateColor(rate: number): string {
  if (rate >= 90) return C.green;
  if (rate >= 70) return C.yellow;
  return C.red;
}

function rateTailwind(rate: number): string {
  if (rate >= 90) return 'text-[#c2d94c]';
  if (rate >= 70) return 'text-[#ffb454]';
  return 'text-[#f07178]';
}

function statusColor(status: string): string {
  if (status === 'running') return C.green;
  if (status === 'stopped') return C.red;
  return C.muted;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ── Circular Gauge ─────────────────────────────────────────────────
function HealthGauge({ score, size = 64 }: { score: number; size?: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = rateColor(score);

  return (
    <svg width={size} height={size} className="shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={C.border}
        strokeWidth={3}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="butt"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1, ease: 'easeOut' }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontFamily="monospace"
        fontSize={size * 0.22}
        fontWeight="bold"
      >
        {score}
      </text>
    </svg>
  );
}

// ── Sparkline ──────────────────────────────────────────────────────
function Sparkline({ values, width = 120, height = 32 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  const lastVal = values[values.length - 1];
  const prevVal = values[values.length - 2];
  const color = lastVal >= prevVal ? C.green : C.red;

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        opacity={0.8}
      />
      {/* last dot */}
      <circle
        cx={(values.length - 1) / (values.length - 1) * width}
        cy={height - ((lastVal - min) / range) * (height - 4) - 2}
        r={2.5}
        fill={color}
      />
    </svg>
  );
}

// ── Backoff Chart ──────────────────────────────────────────────────
function BackoffChart({
  baseMs,
  currentMs,
  maxMs,
  consecutiveClean,
}: {
  baseMs: number;
  currentMs: number;
  maxMs: number;
  consecutiveClean: number;
}) {
  const w = 260;
  const h = 80;
  const pad = { top: 12, bottom: 20, left: 40, right: 12 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  // Generate exponential backoff curve points (base * 2^n, capped at max)
  const steps = 10;
  const points: { x: number; y: number; ms: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const ms = Math.min(baseMs * Math.pow(2, i), maxMs);
    points.push({
      x: pad.left + (i / (steps - 1)) * innerW,
      y: pad.top + innerH - (ms / maxMs) * innerH,
      ms,
    });
  }

  // Find current position on curve
  const currentStep = currentMs <= baseMs
    ? 0
    : Math.min(Math.log2(currentMs / baseMs), steps - 1);
  const currentX = pad.left + (currentStep / (steps - 1)) * innerW;
  const currentY = pad.top + innerH - (currentMs / maxMs) * innerH;

  const polyline = points.map(p => `${p.x},${p.y}`).join(' ');

  return (
    <div className="mt-3">
      <div className="font-mono text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>
        Backoff Curve
      </div>
      <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        {/* grid lines */}
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + innerH} stroke={C.border} strokeWidth={0.5} />
        <line x1={pad.left} y1={pad.top + innerH} x2={pad.left + innerW} y2={pad.top + innerH} stroke={C.border} strokeWidth={0.5} />
        {/* base line */}
        <line
          x1={pad.left}
          y1={pad.top + innerH - (baseMs / maxMs) * innerH}
          x2={pad.left + innerW}
          y2={pad.top + innerH - (baseMs / maxMs) * innerH}
          stroke={C.cyan}
          strokeWidth={0.5}
          strokeDasharray="3,3"
          opacity={0.4}
        />
        {/* max line */}
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left + innerW}
          y2={pad.top}
          stroke={C.red}
          strokeWidth={0.5}
          strokeDasharray="3,3"
          opacity={0.3}
        />
        {/* curve */}
        <motion.polyline
          points={polyline}
          fill="none"
          stroke={C.purple}
          strokeWidth={1.5}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.2 }}
        />
        {/* current indicator */}
        <motion.circle
          cx={currentX}
          cy={currentY}
          r={4}
          fill={C.green}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.8, type: 'spring' }}
        />
        <motion.circle
          cx={currentX}
          cy={currentY}
          r={8}
          fill="none"
          stroke={C.green}
          strokeWidth={1}
          opacity={0.3}
          initial={{ scale: 0 }}
          animate={{ scale: [1, 1.5, 1] }}
          transition={{ delay: 1, duration: 2, repeat: Infinity }}
        />
        {/* labels */}
        <text x={pad.left - 4} y={pad.top + innerH - (baseMs / maxMs) * innerH + 3} textAnchor="end" fill={C.cyan} fontFamily="monospace" fontSize={7}>
          {formatMs(baseMs)}
        </text>
        <text x={pad.left - 4} y={pad.top + 3} textAnchor="end" fill={C.red} fontFamily="monospace" fontSize={7} opacity={0.6}>
          {formatMs(maxMs)}
        </text>
        <text x={currentX} y={currentY - 10} textAnchor="middle" fill={C.green} fontFamily="monospace" fontSize={8} fontWeight="bold">
          {formatMs(currentMs)}
        </text>
        {/* X-axis label */}
        <text x={pad.left + innerW / 2} y={h - 2} textAnchor="middle" fill={C.muted} fontFamily="monospace" fontSize={7}>
          {consecutiveClean} clean runs
        </text>
      </svg>
    </div>
  );
}

// ── Patrol Card ────────────────────────────────────────────────────
function PatrolCard({
  type,
  state,
  onStart,
  onStop,
  onRunNow,
}: {
  type: PatrolType;
  state: PatrolState;
  onStart: () => void;
  onStop: () => void;
  onRunNow: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { health, reports, loading } = state;
  const latestReport = reports[0];
  const passRate = latestReport?.passRate ?? 0;
  const healthScore = health.healthScore ?? 0;
  const isRunning = health.status === 'running';

  const labels: Record<PatrolType, { name: string; icon: string; desc: string }> = {
    deacon: { name: 'Deacon', icon: '⛪', desc: 'Infrastructure & service health checks' },
    witness: { name: 'Witness', icon: '👁', desc: 'Data integrity & consistency verification' },
    refinery: { name: 'Refinery', icon: '⚗', desc: 'Performance optimization & cleanup sweeps' },
  };

  const info = labels[type];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="border font-mono"
      style={{ background: C.card, borderColor: C.border }}
    >
      {/* Card Header */}
      <div className="px-5 py-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">{info.icon}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold" style={{ color: C.text }}>{info.name}</span>
                <motion.span
                  className="text-[9px] uppercase tracking-wider px-1.5 py-0.5"
                  style={{
                    color: statusColor(health.status),
                    background: `${statusColor(health.status)}15`,
                    border: `1px solid ${statusColor(health.status)}30`,
                  }}
                  animate={{ opacity: isRunning ? [1, 0.6, 1] : 1 }}
                  transition={{ duration: 2, repeat: isRunning ? Infinity : 0 }}
                >
                  {health.status}
                </motion.span>
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>{info.desc}</div>
            </div>
          </div>
          <HealthGauge score={healthScore} size={56} />
        </div>

        {/* Stats Row */}
        <div className="flex items-center gap-5 mt-4">
          <div>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Pass Rate</div>
            <div className="text-lg font-bold" style={{ color: rateColor(passRate) }}>{passRate}%</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Interval</div>
            <div className="text-sm" style={{ color: C.purple }}>
              {health.intervalMs ? formatMs(health.intervalMs) : '--'}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Last Run</div>
            <div className="text-[11px]" style={{ color: C.text }}>
              {health.lastRunAt ? timeAgo(health.lastRunAt) : '--'}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Next Run</div>
            <div className="text-[11px]" style={{ color: C.cyan }}>
              {health.nextRunAt ? formatTime(health.nextRunAt) : '--'}
            </div>
          </div>
        </div>

        {/* Pass Rate Bar */}
        <div className="mt-3 h-1 rounded-none" style={{ background: `${C.border}` }}>
          <motion.div
            className="h-full"
            style={{ background: rateColor(passRate) }}
            initial={{ width: 0 }}
            animate={{ width: `${passRate}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 mt-4">
          {isRunning ? (
            <button
              onClick={onStop}
              disabled={loading}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-40"
              style={{ color: C.red, borderColor: `${C.red}40`, background: `${C.red}10` }}
            >
              Stop Loop
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={loading}
              className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-40"
              style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
            >
              Start Loop
            </button>
          )}
          <button
            onClick={onRunNow}
            disabled={loading}
            className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80 disabled:opacity-40"
            style={{ color: C.cyan, borderColor: `${C.border}`, background: 'transparent' }}
          >
            {loading ? 'Running...' : 'Run Now'}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-auto px-2 py-1.5 text-[10px] transition-colors"
            style={{ color: C.muted }}
          >
            {expanded ? '▲ Collapse' : '▼ Expand'}
          </button>
        </div>

        {/* Backoff Chart */}
        {health.baseIntervalMs && health.intervalMs && health.maxIntervalMs && (
          <BackoffChart
            baseMs={health.baseIntervalMs}
            currentMs={health.intervalMs}
            maxMs={health.maxIntervalMs}
            consecutiveClean={health.consecutiveClean ?? 0}
          />
        )}
      </div>

      {/* Expanded: Individual Checks */}
      <AnimatePresence>
        {expanded && latestReport && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-4 border-t" style={{ borderColor: C.border }}>
              <div className="text-[9px] uppercase tracking-wider mt-3 mb-2" style={{ color: C.muted }}>
                Latest Checks ({latestReport.checks?.length ?? 0})
              </div>
              <div className="space-y-1">
                {(latestReport.checks || []).map((check, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="flex items-center gap-2 py-1 px-2"
                    style={{ background: check.passed ? `${C.green}08` : `${C.red}08` }}
                  >
                    <span
                      className="text-xs font-bold w-4 text-center"
                      style={{ color: check.passed ? C.green : C.red }}
                    >
                      {check.passed ? '✓' : '✗'}
                    </span>
                    <span className="text-[11px] flex-1" style={{ color: C.text }}>{check.name}</span>
                    {check.details && (
                      <span className="text-[9px] truncate max-w-[160px]" style={{ color: C.muted }}>
                        {check.details}
                      </span>
                    )}
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Report Timeline Item ───────────────────────────────────────────
function ReportItem({ report }: { report: PatrolReport }) {
  const [open, setOpen] = useState(false);
  const color = rateColor(report.passRate);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="border font-mono cursor-pointer"
      style={{ borderColor: C.border, background: C.card }}
      onClick={() => setOpen(!open)}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Timeline dot */}
        <div className="flex flex-col items-center shrink-0 self-stretch">
          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
          <div className="flex-1 w-px mt-1" style={{ background: C.border }} />
        </div>

        {/* Report info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5"
              style={{
                color: C.bg,
                background: report.owner === 'deacon' ? C.cyan : report.owner === 'witness' ? C.purple : C.yellow,
              }}
            >
              {report.owner}
            </span>
            <span className="text-xs font-bold" style={{ color }}>{report.passRate}%</span>
            {report.durationMs !== undefined && (
              <span className="text-[10px]" style={{ color: C.muted }}>{formatMs(report.durationMs)}</span>
            )}
            <span className="text-[10px] ml-auto shrink-0" style={{ color: C.muted }}>
              {formatTime(report.timestamp)}
            </span>
          </div>
          {report.summary && (
            <div className="text-[10px] mt-1 truncate" style={{ color: C.muted }}>{report.summary}</div>
          )}
        </div>

        {/* Expand indicator */}
        <span className="text-[10px] shrink-0" style={{ color: C.muted }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Expanded checks */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t"
            style={{ borderColor: C.border }}
          >
            <div className="px-4 py-2 grid grid-cols-2 gap-1">
              {(report.checks || []).map((check, i) => (
                <div key={i} className="flex items-center gap-2 py-0.5 px-1">
                  <span className="text-[10px]" style={{ color: check.passed ? C.green : C.red }}>
                    {check.passed ? '✓' : '✗'}
                  </span>
                  <span className="text-[10px]" style={{ color: C.text }}>{check.name}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Aggregated Health Score ────────────────────────────────────────
function AggregatedHealth({
  patrols,
}: {
  patrols: Record<PatrolType, PatrolState>;
}) {
  const scores: number[] = [];
  const recentScores: number[] = [];

  for (const type of ['deacon', 'witness', 'refinery'] as PatrolType[]) {
    const s = patrols[type];
    if (s.health.healthScore !== undefined) scores.push(s.health.healthScore);
    // Collect last 10 pass rates for sparkline
    s.reports.slice(0, 10).reverse().forEach(r => recentScores.push(r.passRate));
  }

  const overall = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const last10 = recentScores.slice(-10);

  // Trend
  let trend: 'improving' | 'declining' | 'stable' = 'stable';
  if (last10.length >= 4) {
    const firstHalf = last10.slice(0, Math.floor(last10.length / 2));
    const secondHalf = last10.slice(Math.floor(last10.length / 2));
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    if (avgSecond - avgFirst > 3) trend = 'improving';
    else if (avgFirst - avgSecond > 3) trend = 'declining';
  }

  const trendIcon = trend === 'improving' ? '↑' : trend === 'declining' ? '↓' : '→';
  const trendColor = trend === 'improving' ? C.green : trend === 'declining' ? C.red : C.muted;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
      className="border font-mono px-5 py-4 flex items-center gap-6"
      style={{ background: C.card, borderColor: C.border }}
    >
      <HealthGauge score={overall} size={80} />
      <div className="flex-1">
        <div className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>
          Aggregated Health
        </div>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-2xl font-bold" style={{ color: rateColor(overall) }}>{overall}</span>
          <span className="text-sm font-bold" style={{ color: trendColor }}>
            {trendIcon} {trend}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[9px] uppercase" style={{ color: C.muted }}>Last 10</span>
          <Sparkline values={last10} width={140} height={24} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {(['deacon', 'witness', 'refinery'] as PatrolType[]).map(type => {
          const h = patrols[type].health;
          return (
            <div key={type} className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: statusColor(h.status) }} />
              <span className="text-[10px] capitalize w-14" style={{ color: C.text }}>{type}</span>
              <span className="text-[10px]" style={{ color: rateColor(h.healthScore ?? 0) }}>
                {h.healthScore ?? '--'}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

// ── Main Component ─────────────────────────────────────────────────
export default function PatrolView() {
  const [patrols, setPatrols] = useState<Record<PatrolType, PatrolState>>({
    deacon: { health: { status: 'unknown' }, reports: [], loading: false },
    witness: { health: { status: 'unknown' }, reports: [], loading: false },
    refinery: { health: { status: 'unknown' }, reports: [], loading: false },
  });
  const [allReports, setAllReports] = useState<PatrolReport[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const mountedRef = useRef(true);

  // ── Fetch patrol data ──────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!mountedRef.current) return;

    const fetchHealth = async (type: PatrolType): Promise<PatrolHealth> => {
      try {
        if (type === 'refinery') {
          // Refinery has no dedicated health endpoint; derive from pulse
          return { status: 'unknown' };
        }
        const res = await fetch(`${API}/api/meow/${type}/health`);
        if (res.ok) return await res.json();
      } catch { /* silent */ }
      return { status: 'unknown' };
    };

    const fetchReports = async (type: PatrolType): Promise<PatrolReport[]> => {
      try {
        const endpoint = type === 'refinery'
          ? `${API}/api/meow/patrols?owner=refinery&limit=20`
          : `${API}/api/meow/${type}/report`;
        const res = await fetch(endpoint);
        if (res.ok) {
          const data = await res.json();
          const raw = Array.isArray(data) ? data : (data.reports || (data.report ? [data.report] : []));
          return raw.map((r: any) => ({
            ...r,
            id: r.id || `${type}-${r.timestamp}`,
            owner: r.owner || type,
            passRate: r.passRate ?? (r.checks?.length
              ? Math.round((r.checks.filter((c: PatrolCheck) => c.passed).length / r.checks.length) * 100)
              : 0),
          }));
        }
      } catch { /* silent */ }
      return [];
    };

    // Fetch pulse for overall data
    let pulseData: any = null;
    try {
      const pulseRes = await fetch(`${API}/api/meow/town/pulse`);
      if (pulseRes.ok) pulseData = await pulseRes.json();
    } catch { /* silent */ }

    const [deaconHealth, witnessHealth, deaconReports, witnessReports, refineryReports] = await Promise.all([
      fetchHealth('deacon'),
      fetchHealth('witness'),
      fetchReports('deacon'),
      fetchReports('witness'),
      fetchReports('refinery'),
    ]);

    // Derive refinery health from pulse if available
    const refineryHealth: PatrolHealth = pulseData?.patrols?.refinery
      ? { ...pulseData.patrols.refinery }
      : { status: 'unknown' };

    // Enrich health from pulse data
    const enrichHealth = (h: PatrolHealth, type: PatrolType): PatrolHealth => {
      const pulsePatrol = pulseData?.patrols?.[type];
      if (pulsePatrol) {
        return {
          ...h,
          intervalMs: h.intervalMs ?? pulsePatrol.intervalMs,
          baseIntervalMs: h.baseIntervalMs ?? pulsePatrol.baseIntervalMs,
          maxIntervalMs: h.maxIntervalMs ?? pulsePatrol.maxIntervalMs,
          consecutiveClean: h.consecutiveClean ?? pulsePatrol.consecutiveClean,
          healthScore: h.healthScore ?? pulsePatrol.healthScore,
          lastRunAt: h.lastRunAt ?? pulsePatrol.lastRunAt,
          nextRunAt: h.nextRunAt ?? pulsePatrol.nextRunAt,
        };
      }
      return h;
    };

    if (!mountedRef.current) return;

    setPatrols({
      deacon: { health: enrichHealth(deaconHealth, 'deacon'), reports: deaconReports, loading: false },
      witness: { health: enrichHealth(witnessHealth, 'witness'), reports: witnessReports, loading: false },
      refinery: { health: enrichHealth(refineryHealth, 'refinery'), reports: refineryReports, loading: false },
    });

    // Merge all reports sorted by timestamp
    const merged = [...deaconReports, ...witnessReports, ...refineryReports]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 50);
    setAllReports(merged);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    if (!autoRefresh) return;
    const iv = setInterval(fetchAll, 8000);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
    };
  }, [fetchAll, autoRefresh]);

  // ── Actions ────────────────────────────────────────────────────
  const patrolAction = useCallback(async (type: PatrolType, action: 'start' | 'stop' | 'patrol') => {
    setPatrols(prev => ({
      ...prev,
      [type]: { ...prev[type], loading: true },
    }));
    try {
      await fetch(`${API}/api/meow/${type}/${action}`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 500));
      await fetchAll();
    } catch { /* silent */ }
    setPatrols(prev => ({
      ...prev,
      [type]: { ...prev[type], loading: false },
    }));
  }, [fetchAll]);

  const runAllAction = useCallback(async (action: 'start' | 'stop' | 'patrol') => {
    setActionLoading(true);
    const types: PatrolType[] = ['deacon', 'witness', 'refinery'];
    await Promise.allSettled(
      types.map(type => fetch(`${API}/api/meow/${type}/${action}`, { method: 'POST' }))
    );
    await new Promise(r => setTimeout(r, 800));
    await fetchAll();
    setActionLoading(false);
  }, [fetchAll]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col font-mono" style={{ background: C.bg, color: C.text }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 border-b shrink-0"
        style={{ borderColor: C.border }}
      >
        <div className="flex items-center gap-4">
          <h1 className="text-sm uppercase tracking-widest" style={{ color: C.text }}>
            Patrol Command Center
          </h1>
          <span className="text-[10px] px-2 py-0.5" style={{ color: C.muted, background: `${C.border}80` }}>
            {allReports.length} reports
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="text-[10px] px-2 py-1 transition-colors"
            style={{ color: autoRefresh ? C.green : C.muted }}
          >
            {autoRefresh ? '● LIVE' : '○ PAUSED'}
          </button>
        </div>
      </div>

      {/* Action Bar */}
      <div
        className="flex items-center gap-2 px-6 py-3 border-b shrink-0"
        style={{ borderColor: C.border }}
      >
        <span className="text-[9px] uppercase tracking-wider mr-2" style={{ color: C.muted }}>
          Batch
        </span>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => runAllAction('patrol')}
          disabled={actionLoading}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-40"
          style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
        >
          Run All Patrols
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => runAllAction('start')}
          disabled={actionLoading}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-40"
          style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
        >
          Start All
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => runAllAction('stop')}
          disabled={actionLoading}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors disabled:opacity-40"
          style={{ color: C.red, borderColor: `${C.red}40`, background: `${C.red}10` }}
        >
          Stop All
        </motion.button>
        {actionLoading && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: Infinity }}
            className="text-[10px] ml-2"
            style={{ color: C.yellow }}
          >
            Processing...
          </motion.span>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-[1400px] mx-auto space-y-4">
          {/* Aggregated Health */}
          <AggregatedHealth patrols={patrols} />

          {/* Patrol Cards Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {(['deacon', 'witness', 'refinery'] as PatrolType[]).map(type => (
              <PatrolCard
                key={type}
                type={type}
                state={patrols[type]}
                onStart={() => patrolAction(type, 'start')}
                onStop={() => patrolAction(type, 'stop')}
                onRunNow={() => patrolAction(type, 'patrol')}
              />
            ))}
          </div>

          {/* Reports Timeline */}
          <div>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-[11px] uppercase tracking-widest" style={{ color: C.muted }}>
                Patrol Reports Timeline
              </h2>
              <div className="flex-1 h-px" style={{ background: C.border }} />
            </div>
            <div className="space-y-2">
              {allReports.length === 0 && (
                <div className="text-center py-12 text-[11px]" style={{ color: C.muted }}>
                  No patrol reports yet. Run a patrol to see results.
                </div>
              )}
              <AnimatePresence>
                {allReports.map(report => (
                  <ReportItem key={report.id} report={report} />
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
