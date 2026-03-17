'use client';

/**
 * GuzzolineGaugeView — The Guzzoline Gauge: Gas Town's Fuel System
 *
 * Real-time fuel gauge showing system work capacity derived from the town pulse.
 * Five sections: central gauge, breakdown bars, generators/consumers, sparkline history, burn rate.
 * AYU DARK AESTHETIC: bg-[#0f1419], cards [#1a1f26], text [#e6e1cf], font-mono, rounded-none.
 * Polls /api/meow/town/pulse every 5s.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PulseHealth {
  score: number;
  status: string;
}

interface PulseMolecules {
  active: number;
  completed: number;
  failed: number;
  total: number;
}

interface PulseWisps {
  active: number;
  expired: number;
  promoted: number;
}

interface PulseWorkers {
  alive: number;
  stale: number;
  dead: number;
  total: number;
}

interface PulseBeads {
  total: number;
  ready: number;
  inProgress: number;
  blocked: number;
}

interface PulseMail {
  pending: number;
  delivered: number;
  failed: number;
}

interface PulseRefinery {
  queued: number;
  merged: number;
  conflicted: number;
}

interface PulseBudget {
  totalCostUsd: number;
  warnings: number;
  paused: number;
}

interface PulseObservability {
  townlogEntries: number;
  errorTrends: number;
  activeAlerts: number;
}

interface TownPulse {
  timestamp: string;
  health: PulseHealth;
  molecules: PulseMolecules;
  wisps: PulseWisps;
  workers: PulseWorkers;
  beads: PulseBeads;
  mail: PulseMail;
  refinery: PulseRefinery;
  skills: { registered: number };
  patrols: { lastScore: number; failedChecks: number };
  budget: PulseBudget;
  observability: PulseObservability;
}

interface BreakdownItem {
  label: string;
  value: number;
  max: number;
  unit: string;
  color: string;
}

interface FlowEntity {
  name: string;
  type: string;
  ratePerHr: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5000;
const HISTORY_MAX = 50;
const BUDGET_CAP = 50; // assumed $50 budget ceiling for gauge
const MERGE_QUEUE_CAP = 10;
const API_QUOTA_CAP = 1000; // assumed max API calls/hr
const POLECAT_CAP = 8; // max concurrent polecat slots

// Ayu Dark palette
const AYU = {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function gaugeColor(level: number): string {
  if (level > 60) return AYU.green;
  if (level > 30) return AYU.yellow;
  return AYU.red;
}

function computeFuelLevel(pulse: TownPulse): number {
  // Weighted composite of subsystem health signals
  const healthScore = clamp(pulse.health.score >= 0 ? pulse.health.score : 50, 0, 100);
  const beadReadiness = pulse.beads.total > 0
    ? (pulse.beads.ready / pulse.beads.total) * 100
    : 50;
  const workerHealth = pulse.workers.total > 0
    ? (pulse.workers.alive / pulse.workers.total) * 100
    : 0;
  const budgetRemaining = BUDGET_CAP > 0
    ? clamp(((BUDGET_CAP - pulse.budget.totalCostUsd) / BUDGET_CAP) * 100, 0, 100)
    : 50;
  const patrolScore = pulse.patrols.lastScore;
  const moleculeCapacity = pulse.molecules.total > 0
    ? clamp(100 - (pulse.molecules.active / Math.max(pulse.molecules.total, 1)) * 100, 0, 100)
    : 80;

  // Weights
  const level =
    healthScore * 0.25 +
    beadReadiness * 0.2 +
    workerHealth * 0.2 +
    budgetRemaining * 0.15 +
    patrolScore * 0.1 +
    moleculeCapacity * 0.1;

  return Math.round(clamp(level, 0, 100));
}

function deriveBreakdown(pulse: TownPulse): BreakdownItem[] {
  const budgetRemain = Math.max(0, BUDGET_CAP - pulse.budget.totalCostUsd);
  const apiQuotaRemain = clamp(
    API_QUOTA_CAP - (pulse.observability.townlogEntries % API_QUOTA_CAP),
    0,
    API_QUOTA_CAP,
  );
  const mergeSpace = Math.max(0, MERGE_QUEUE_CAP - pulse.refinery.queued);
  const polecatSlots = Math.max(0, POLECAT_CAP - pulse.molecules.active);

  return [
    { label: 'Beads Ready', value: pulse.beads.ready, max: Math.max(pulse.beads.total, 1), unit: '', color: AYU.cyan },
    { label: 'Polecat Slots', value: polecatSlots, max: POLECAT_CAP, unit: '', color: AYU.purple },
    { label: 'Budget Remaining', value: budgetRemain, max: BUDGET_CAP, unit: '$', color: AYU.green },
    { label: 'API Quota', value: Math.round((apiQuotaRemain / API_QUOTA_CAP) * 100), max: 100, unit: '%', color: AYU.yellow },
    { label: 'Merge Queue Space', value: Math.round((mergeSpace / MERGE_QUEUE_CAP) * 100), max: 100, unit: '%', color: AYU.cyan },
  ];
}

function deriveGenerators(pulse: TownPulse): FlowEntity[] {
  return [
    { name: 'Completed Molecules', type: 'throughput', ratePerHr: pulse.molecules.completed * 6 },
    { name: 'Promoted Wisps', type: 'intake', ratePerHr: pulse.wisps.promoted * 4 },
    { name: 'Beads Done', type: 'capacity', ratePerHr: Math.max(0, pulse.beads.total - pulse.beads.ready - pulse.beads.inProgress - pulse.beads.blocked) * 3 },
    { name: 'Mail Delivered', type: 'comms', ratePerHr: pulse.mail.delivered * 2 },
    { name: 'Refinery Merged', type: 'output', ratePerHr: pulse.refinery.merged * 5 },
  ];
}

function deriveConsumers(pulse: TownPulse): FlowEntity[] {
  return [
    { name: 'Active Molecules', type: 'processing', ratePerHr: pulse.molecules.active * 8 },
    { name: 'Active Wisps', type: 'exploration', ratePerHr: pulse.wisps.active * 3 },
    { name: 'Blocked Beads', type: 'blockage', ratePerHr: pulse.beads.blocked * 6 },
    { name: 'Cost Burn', type: 'budget', ratePerHr: pulse.budget.totalCostUsd * 2 },
    { name: 'Error Trends', type: 'failures', ratePerHr: pulse.observability.errorTrends * 4 },
  ];
}

// ─── SVG Sub-Components ─────────────────────────────────────────────────────

function GaugeSVG({ level, prevLevel }: { level: number; prevLevel: number }) {
  const color = gaugeColor(level);
  const glowColor = gaugeColor(level);

  // Arc from -135deg to +135deg = 270deg sweep
  const startAngle = -225; // degrees (SVG coordinate system, 0=right, CW)
  const sweepDeg = 270;
  const radius = 90;
  const cx = 120;
  const cy = 120;

  // Tick marks
  const ticks = useMemo(() => {
    const result: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let i = 0; i <= 10; i++) {
      const frac = i / 10;
      const angleDeg = startAngle + frac * sweepDeg;
      const angleRad = (angleDeg * Math.PI) / 180;
      const innerR = i % 2 === 0 ? 75 : 80;
      result.push({
        x1: cx + Math.cos(angleRad) * innerR,
        y1: cy + Math.sin(angleRad) * innerR,
        x2: cx + Math.cos(angleRad) * radius,
        y2: cy + Math.sin(angleRad) * radius,
        major: i % 2 === 0,
      });
    }
    return result;
  }, []);

  // Arc path for the filled portion
  const arcPath = useMemo(() => {
    const frac = clamp(level / 100, 0, 1);
    const endAngleDeg = startAngle + frac * sweepDeg;
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngleDeg * Math.PI) / 180;
    const largeArc = frac * sweepDeg > 180 ? 1 : 0;
    const sx = cx + Math.cos(startRad) * radius;
    const sy = cy + Math.sin(startRad) * radius;
    const ex = cx + Math.cos(endRad) * radius;
    const ey = cy + Math.sin(endRad) * radius;
    return `M ${sx} ${sy} A ${radius} ${radius} 0 ${largeArc} 1 ${ex} ${ey}`;
  }, [level]);

  // Background arc (full sweep)
  const bgArcPath = useMemo(() => {
    const startRad = (startAngle * Math.PI) / 180;
    const endAngleDeg = startAngle + sweepDeg;
    const endRad = (endAngleDeg * Math.PI) / 180;
    const sx = cx + Math.cos(startRad) * radius;
    const sy = cy + Math.sin(startRad) * radius;
    const ex = cx + Math.cos(endRad) * radius;
    const ey = cy + Math.sin(endRad) * radius;
    return `M ${sx} ${sy} A ${radius} ${radius} 0 1 1 ${ex} ${ey}`;
  }, []);

  // Needle angle
  const needleFrac = clamp(level / 100, 0, 1);
  const needleAngleDeg = startAngle + needleFrac * sweepDeg;

  return (
    <svg viewBox="0 0 240 180" className="w-full max-w-[320px]">
      <defs>
        <filter id="gauge-glow">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="needle-shadow">
          <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor={glowColor} floodOpacity="0.6" />
        </filter>
      </defs>

      {/* Background arc */}
      <path
        d={bgArcPath}
        fill="none"
        stroke={AYU.border}
        strokeWidth="8"
        strokeLinecap="butt"
      />

      {/* Filled arc */}
      <motion.path
        d={arcPath}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeLinecap="butt"
        filter="url(#gauge-glow)"
        initial={{ opacity: 0.6 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
      />

      {/* Tick marks */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          stroke={t.major ? AYU.muted : AYU.border}
          strokeWidth={t.major ? 2 : 1}
        />
      ))}

      {/* Tick labels */}
      {[0, 25, 50, 75, 100].map((val, i) => {
        const frac = val / 100;
        const angleDeg = startAngle + frac * sweepDeg;
        const angleRad = (angleDeg * Math.PI) / 180;
        const labelR = 64;
        return (
          <text
            key={i}
            x={cx + Math.cos(angleRad) * labelR}
            y={cy + Math.sin(angleRad) * labelR + 3}
            fill={AYU.muted}
            fontSize="8"
            fontFamily="monospace"
            textAnchor="middle"
          >
            {val}
          </text>
        );
      })}

      {/* Needle */}
      <motion.g
        animate={{ rotate: needleAngleDeg }}
        initial={{ rotate: startAngle + (clamp(prevLevel, 0, 100) / 100) * sweepDeg }}
        transition={{ type: 'spring', stiffness: 60, damping: 15 }}
        style={{ transformOrigin: `${cx}px ${cy}px` }}
        filter="url(#needle-shadow)"
      >
        <line
          x1={cx}
          y1={cy}
          x2={cx + 78}
          y2={cy}
          stroke={AYU.text}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx={cx + 78} cy={cy} r="3" fill={color} />
      </motion.g>

      {/* Center hub */}
      <circle cx={cx} cy={cy} r="6" fill={AYU.card} stroke={AYU.border} strokeWidth="2" />
      <circle cx={cx} cy={cy} r="3" fill={color} />

      {/* Label */}
      <text
        x={cx}
        y={cy + 30}
        fill={AYU.muted}
        fontSize="9"
        fontFamily="monospace"
        textAnchor="middle"
        letterSpacing="3"
      >
        GUZZOLINE
      </text>

      {/* Numeric value */}
      <motion.text
        x={cx}
        y={cy + 48}
        fill={color}
        fontSize="22"
        fontWeight="bold"
        fontFamily="monospace"
        textAnchor="middle"
        key={level}
        initial={{ opacity: 0.5, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
      >
        {level}
      </motion.text>
    </svg>
  );
}

function SparklineSVG({ data, width = 320, height = 60 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <text x={width / 2} y={height / 2 + 4} fill={AYU.muted} fontSize="10" fontFamily="monospace" textAnchor="middle">
          Collecting data...
        </text>
      </svg>
    );
  }

  const padding = 4;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const range = maxVal - minVal || 1;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * innerW;
    const y = padding + innerH - ((v - minVal) / range) * innerH;
    return `${x},${y}`;
  });

  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `${linePath} L ${padding + innerW},${padding + innerH} L ${padding},${padding + innerH} Z`;

  const lastVal = data[data.length - 1];
  const lastColor = gaugeColor(lastVal);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
      <defs>
        <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lastColor} stopOpacity="0.2" />
          <stop offset="100%" stopColor={lastColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Area fill */}
      <path d={areaPath} fill="url(#sparkline-fill)" />
      {/* Line */}
      <path d={linePath} fill="none" stroke={lastColor} strokeWidth="1.5" />
      {/* Current point */}
      {data.length > 0 && (
        <circle
          cx={padding + ((data.length - 1) / (data.length - 1)) * innerW}
          cy={padding + innerH - ((lastVal - minVal) / range) * innerH}
          r="3"
          fill={lastColor}
        />
      )}
      {/* Min / Max labels */}
      <text x={width - padding} y={padding + 8} fill={AYU.muted} fontSize="7" fontFamily="monospace" textAnchor="end">
        {maxVal}
      </text>
      <text x={width - padding} y={padding + innerH} fill={AYU.muted} fontSize="7" fontFamily="monospace" textAnchor="end">
        {minVal}
      </text>
    </svg>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function GuzzolineGaugeView() {
  const [pulse, setPulse] = useState<TownPulse | null>(null);
  const [fuelLevel, setFuelLevel] = useState(0);
  const [prevFuelLevel, setPrevFuelLevel] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [offline, setOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('--');
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Data fetching ───────────────────────────────────────────────────────

  const fetchPulse = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/town/pulse`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TownPulse = await res.json();
      setPulse(data);

      const newLevel = computeFuelLevel(data);
      setPrevFuelLevel(prev => prev);
      setFuelLevel(prev => {
        setPrevFuelLevel(prev);
        return newLevel;
      });
      setHistory(prev => {
        const next = [...prev, newLevel];
        return next.length > HISTORY_MAX ? next.slice(-HISTORY_MAX) : next;
      });
      setLastUpdated(new Date().toLocaleTimeString());
      setOffline(false);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setOffline(true);
      }
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    fetchPulse(ac.signal);
    pollRef.current = setInterval(() => fetchPulse(ac.signal), POLL_INTERVAL);
    return () => {
      ac.abort();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchPulse]);

  // ── Derived data ────────────────────────────────────────────────────────

  const breakdown = useMemo(() => (pulse ? deriveBreakdown(pulse) : []), [pulse]);
  const generators = useMemo(() => (pulse ? deriveGenerators(pulse) : []), [pulse]);
  const consumers = useMemo(() => (pulse ? deriveConsumers(pulse) : []), [pulse]);
  const netFlow = useMemo(() => {
    const genTotal = generators.reduce((s, g) => s + g.ratePerHr, 0);
    const conTotal = consumers.reduce((s, c) => s + c.ratePerHr, 0);
    return genTotal - conTotal;
  }, [generators, consumers]);

  const burnRate = useMemo(() => {
    if (!pulse) return { hoursRemaining: 0, emptyAt: '--', low: false };
    const conTotal = consumers.reduce((s, c) => s + c.ratePerHr, 0);
    const genTotal = generators.reduce((s, g) => s + g.ratePerHr, 0);
    const netDrain = conTotal - genTotal;
    if (netDrain <= 0) return { hoursRemaining: Infinity, emptyAt: 'NEVER (net positive)', low: fuelLevel < 30 };
    const hoursRemaining = fuelLevel / (netDrain / 10);
    const emptyDate = new Date(Date.now() + hoursRemaining * 3600000);
    const emptyAt = emptyDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { hoursRemaining: Math.round(hoursRemaining * 10) / 10, emptyAt, low: fuelLevel < 30 };
  }, [pulse, fuelLevel, consumers, generators]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen font-mono text-[#e6e1cf] p-4 md:p-6"
      style={{ backgroundColor: AYU.bg }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-wider" style={{ color: AYU.text }}>
            GUZZOLINE GAUGE
          </h1>
          <p className="text-xs mt-1" style={{ color: AYU.muted }}>
            Gas Town Fuel System -- Real-Time Work Capacity
          </p>
        </div>
        <div className="flex items-center gap-3">
          {offline ? (
            <span
              className="px-3 py-1 text-xs font-bold rounded-none border"
              style={{ borderColor: AYU.red, color: AYU.red, backgroundColor: `${AYU.red}15` }}
            >
              OFFLINE
            </span>
          ) : (
            <span
              className="px-3 py-1 text-xs rounded-none border"
              style={{ borderColor: AYU.green, color: AYU.green, backgroundColor: `${AYU.green}15` }}
            >
              LIVE
            </span>
          )}
          <span className="text-xs" style={{ color: AYU.muted }}>
            {lastUpdated}
          </span>
        </div>
      </div>

      {/* Offline overlay */}
      <AnimatePresence>
        {offline && !pulse && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-center py-20"
          >
            <div
              className="border rounded-none px-8 py-6 text-center"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <p className="text-lg font-bold mb-2" style={{ color: AYU.red }}>
                SIGNAL LOST
              </p>
              <p className="text-xs" style={{ color: AYU.muted }}>
                Cannot reach Gas Town pulse. Retrying every 5s...
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main grid */}
      {(pulse || history.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* ═══ LEFT: Central Gauge + Breakdown ═══ */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            {/* Central Fuel Gauge */}
            <div
              className="border rounded-none p-6 flex flex-col items-center"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <motion.div
                key={fuelLevel}
                animate={{
                  boxShadow: `0 0 ${fuelLevel < 30 ? 20 : 8}px ${gaugeColor(fuelLevel)}30`,
                }}
                transition={{ duration: 0.6 }}
                className="rounded-none"
              >
                <GaugeSVG level={fuelLevel} prevLevel={prevFuelLevel} />
              </motion.div>

              {/* Status text */}
              <div className="mt-2 text-center">
                <span
                  className="text-xs px-2 py-0.5 border rounded-none"
                  style={{
                    color: gaugeColor(fuelLevel),
                    borderColor: gaugeColor(fuelLevel),
                    backgroundColor: `${gaugeColor(fuelLevel)}10`,
                  }}
                >
                  {fuelLevel > 60 ? 'CAPACITY NOMINAL' : fuelLevel > 30 ? 'CAPACITY MODERATE' : 'LOW FUEL WARNING'}
                </span>
              </div>

              {/* Health / Workers / Patrol mini stats */}
              {pulse && (
                <div className="grid grid-cols-3 gap-3 mt-4 w-full">
                  {[
                    { label: 'Health', value: pulse.health.score >= 0 ? `${pulse.health.score}` : '--', color: AYU.green },
                    { label: 'Workers', value: `${pulse.workers.alive}/${pulse.workers.total}`, color: AYU.cyan },
                    { label: 'Patrol', value: `${pulse.patrols.lastScore}%`, color: AYU.purple },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="border rounded-none p-2 text-center"
                      style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                    >
                      <p className="text-[10px] uppercase tracking-wide" style={{ color: AYU.muted }}>{s.label}</p>
                      <p className="text-sm font-bold" style={{ color: s.color }}>{s.value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Breakdown Panel */}
            <div
              className="border rounded-none p-4"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <h2 className="text-xs font-bold tracking-wider mb-3" style={{ color: AYU.muted }}>
                FUEL BREAKDOWN
              </h2>
              <div className="flex flex-col gap-3">
                {breakdown.map((item) => {
                  const pct = item.max > 0 ? clamp((item.value / item.max) * 100, 0, 100) : 0;
                  return (
                    <div key={item.label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs" style={{ color: AYU.text }}>{item.label}</span>
                        <span className="text-xs font-bold" style={{ color: item.color }}>
                          {item.unit === '$' ? `$${item.value.toFixed(2)}` : `${item.value}${item.unit}`}
                        </span>
                      </div>
                      <div
                        className="h-2 rounded-none overflow-hidden"
                        style={{ backgroundColor: AYU.border }}
                      >
                        <motion.div
                          className="h-full rounded-none"
                          style={{ backgroundColor: item.color }}
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ type: 'spring', stiffness: 80, damping: 20 }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ═══ RIGHT: Generators/Consumers + History + Burn Rate ═══ */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            {/* Generators vs Consumers */}
            <div
              className="border rounded-none p-4"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <h2 className="text-xs font-bold tracking-wider mb-3" style={{ color: AYU.muted }}>
                GENERATORS vs CONSUMERS
              </h2>
              <div className="grid grid-cols-2 gap-4">
                {/* Generators (left) */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-none" style={{ backgroundColor: AYU.green }} />
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: AYU.green }}>
                      Generators
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {generators.map((g) => (
                      <div
                        key={g.name}
                        className="border rounded-none p-2"
                        style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs truncate" style={{ color: AYU.text }}>
                            {g.name}
                          </span>
                          <span className="text-xs font-bold ml-2 whitespace-nowrap" style={{ color: AYU.green }}>
                            +{g.ratePerHr}/hr
                          </span>
                        </div>
                        <span className="text-[10px]" style={{ color: AYU.muted }}>{g.type}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Consumers (right) */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-none" style={{ backgroundColor: AYU.red }} />
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: AYU.red }}>
                      Consumers
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {consumers.map((c) => (
                      <div
                        key={c.name}
                        className="border rounded-none p-2"
                        style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs truncate" style={{ color: AYU.text }}>
                            {c.name}
                          </span>
                          <span className="text-xs font-bold ml-2 whitespace-nowrap" style={{ color: AYU.red }}>
                            -{c.ratePerHr}/hr
                          </span>
                        </div>
                        <span className="text-[10px]" style={{ color: AYU.muted }}>{c.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Net flow indicator */}
              <div
                className="mt-3 border-t pt-3 flex items-center justify-between"
                style={{ borderColor: AYU.border }}
              >
                <span className="text-xs" style={{ color: AYU.muted }}>NET FLOW</span>
                <motion.span
                  className="text-sm font-bold"
                  style={{ color: netFlow >= 0 ? AYU.green : AYU.red }}
                  key={netFlow}
                  initial={{ scale: 1.2, opacity: 0.7 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  {netFlow >= 0 ? '+' : ''}{netFlow.toFixed(1)}/hr
                  {netFlow >= 0 ? ' [FILLING]' : ' [DRAINING]'}
                </motion.span>
              </div>
            </div>

            {/* Fuel History Sparkline */}
            <div
              className="border rounded-none p-4"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-bold tracking-wider" style={{ color: AYU.muted }}>
                  FUEL HISTORY
                </h2>
                <span className="text-[10px]" style={{ color: AYU.muted }}>
                  Last {history.length} readings
                </span>
              </div>
              <SparklineSVG data={history} />
              {/* Threshold lines legend */}
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-[2px]" style={{ backgroundColor: AYU.green }} />
                  <span className="text-[10px]" style={{ color: AYU.muted }}>{'>'}60 Nominal</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-[2px]" style={{ backgroundColor: AYU.yellow }} />
                  <span className="text-[10px]" style={{ color: AYU.muted }}>30-60 Moderate</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-[2px]" style={{ backgroundColor: AYU.red }} />
                  <span className="text-[10px]" style={{ color: AYU.muted }}>{'<'}30 Critical</span>
                </div>
              </div>
            </div>

            {/* Burn Rate Projector */}
            <div
              className="border rounded-none p-4"
              style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
            >
              <h2 className="text-xs font-bold tracking-wider mb-3" style={{ color: AYU.muted }}>
                BURN RATE PROJECTOR
              </h2>
              <div className="grid grid-cols-3 gap-3">
                <div
                  className="border rounded-none p-3 text-center"
                  style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                >
                  <p className="text-[10px] uppercase tracking-wide" style={{ color: AYU.muted }}>
                    Hours Remaining
                  </p>
                  <p
                    className="text-lg font-bold mt-1"
                    style={{
                      color: burnRate.hoursRemaining === Infinity
                        ? AYU.green
                        : burnRate.hoursRemaining < 2
                          ? AYU.red
                          : AYU.yellow,
                    }}
                  >
                    {burnRate.hoursRemaining === Infinity ? 'INF' : burnRate.hoursRemaining}
                  </p>
                </div>
                <div
                  className="border rounded-none p-3 text-center"
                  style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                >
                  <p className="text-[10px] uppercase tracking-wide" style={{ color: AYU.muted }}>
                    Projected Empty
                  </p>
                  <p className="text-sm font-bold mt-1" style={{ color: AYU.text }}>
                    {burnRate.emptyAt}
                  </p>
                </div>
                <div
                  className="border rounded-none p-3 text-center"
                  style={{ borderColor: AYU.border, backgroundColor: AYU.bg }}
                >
                  <p className="text-[10px] uppercase tracking-wide" style={{ color: AYU.muted }}>
                    Current Level
                  </p>
                  <p className="text-lg font-bold mt-1" style={{ color: gaugeColor(fuelLevel) }}>
                    {fuelLevel}%
                  </p>
                </div>
              </div>

              {/* Low fuel warning */}
              <AnimatePresence>
                {burnRate.low && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-3 border rounded-none p-3 flex items-center gap-3"
                    style={{
                      borderColor: AYU.red,
                      backgroundColor: `${AYU.red}10`,
                    }}
                  >
                    <motion.div
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="w-3 h-3 rounded-none flex-shrink-0"
                      style={{ backgroundColor: AYU.red }}
                    />
                    <div>
                      <p className="text-xs font-bold" style={{ color: AYU.red }}>
                        LOW FUEL WARNING
                      </p>
                      <p className="text-[10px] mt-0.5" style={{ color: AYU.muted }}>
                        Guzzoline reserves below 30%. Reduce active molecules or await bead completions.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Pipeline Summary Row */}
            {pulse && (
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: 'Molecules', value: `${pulse.molecules.active} active`, sub: `${pulse.molecules.total} total`, color: AYU.cyan },
                  { label: 'Beads', value: `${pulse.beads.ready} ready`, sub: `${pulse.beads.blocked} blocked`, color: AYU.purple },
                  { label: 'Refinery', value: `${pulse.refinery.queued} queued`, sub: `${pulse.refinery.merged} merged`, color: AYU.yellow },
                  { label: 'Budget', value: `$${pulse.budget.totalCostUsd.toFixed(2)}`, sub: `${pulse.budget.warnings} warnings`, color: AYU.green },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="border rounded-none p-3"
                    style={{ borderColor: AYU.border, backgroundColor: AYU.card }}
                  >
                    <p className="text-[10px] uppercase tracking-wide" style={{ color: AYU.muted }}>
                      {stat.label}
                    </p>
                    <p className="text-sm font-bold mt-1" style={{ color: stat.color }}>
                      {stat.value}
                    </p>
                    <p className="text-[10px] mt-0.5" style={{ color: AYU.muted }}>
                      {stat.sub}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
