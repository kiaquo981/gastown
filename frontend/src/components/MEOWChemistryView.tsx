'use client';

/**
 * MEOWChemistryView — MEOW Chemistry Lab
 *
 * Full molecular pipeline visualization:
 * Formulas -> cook -> Protomolecules -> pour -> Molecules -> steps -> complete
 * Plus wisps (ephemeral vapor with TTL countdown).
 *
 * AYU DARK aesthetic: bg-[#0f1419], cards-[#1a1f26], text-[#e6e1cf], muted-[#6c7680]
 * Phase colors: ICE9=#59c2ff, SOLID=#6c7680, LIQUID=#c2d94c, VAPOR=#d2a6ff
 * Font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

type MoleculePhase = 'ice9' | 'solid' | 'liquid' | 'vapor';
type MoleculeStatus = 'active' | 'completed' | 'failed' | 'paused';
type StepStatus = 'pending' | 'ready' | 'running' | 'done' | 'completed' | 'failed' | 'skipped';

interface MoleculeStep {
  id: string;
  name: string;
  status: StepStatus;
  assignee?: string;
  skill?: string;
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
  ttlMs?: number;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  convoyId?: string;
  metadata?: Record<string, unknown>;
}

interface Convoy {
  id: string;
  name: string;
  moleculeIds: string[];
  status: string;
  createdAt?: string;
}

interface CookVariable {
  key: string;
  value: string;
}

// ─── Ayu Dark Constants ─────────────────────────────────────────────────────

const AYU = {
  bg: '#0f1419',
  card: '#1a1f26',
  cardHover: '#1e2430',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: 'rgba(108,118,128,0.2)',
} as const;

const PHASE_COLORS: Record<MoleculePhase, { hex: string; label: string; icon: string }> = {
  ice9:   { hex: '#59c2ff', label: 'ICE-9',  icon: '\u2744' },
  solid:  { hex: '#6c7680', label: 'SOLID',  icon: '\u25A0' },
  liquid: { hex: '#c2d94c', label: 'LIQUID', icon: '\u223F' },
  vapor:  { hex: '#d2a6ff', label: 'VAPOR',  icon: '\u2601' },
};

const PHASE_TW: Record<MoleculePhase, { badge: string; bar: string; glow: string }> = {
  ice9:   { badge: 'bg-[#59c2ff]/15 text-[#59c2ff] border-[#59c2ff]/30', bar: 'bg-[#59c2ff]', glow: 'shadow-[0_0_12px_rgba(89,194,255,0.2)]' },
  solid:  { badge: 'bg-[#6c7680]/15 text-[#6c7680] border-[#6c7680]/30', bar: 'bg-[#6c7680]', glow: '' },
  liquid: { badge: 'bg-[#c2d94c]/15 text-[#c2d94c] border-[#c2d94c]/30', bar: 'bg-[#c2d94c]', glow: 'shadow-[0_0_12px_rgba(194,217,76,0.15)]' },
  vapor:  { badge: 'bg-[#d2a6ff]/15 text-[#d2a6ff] border-[#d2a6ff]/30', bar: 'bg-[#d2a6ff]', glow: 'shadow-[0_0_12px_rgba(210,166,255,0.2)]' },
};

const STATUS_TW: Record<MoleculeStatus, { label: string; cls: string }> = {
  active:    { label: 'Active',    cls: 'bg-[#c2d94c]/15 text-[#c2d94c] border-[#c2d94c]/30' },
  completed: { label: 'Done',      cls: 'bg-[#59c2ff]/15 text-[#59c2ff] border-[#59c2ff]/30' },
  failed:    { label: 'Failed',    cls: 'bg-[#ff3333]/15 text-[#ff3333] border-[#ff3333]/30' },
  paused:    { label: 'Paused',    cls: 'bg-[#ffb454]/15 text-[#ffb454] border-[#ffb454]/30' },
};

const STEP_DOT: Record<string, string> = {
  pending:   'bg-[#6c7680]/40',
  ready:     'bg-[#59c2ff]/60',
  running:   'bg-[#ffb454]/60',
  done:      'bg-[#c2d94c]/60',
  completed: 'bg-[#c2d94c]/60',
  failed:    'bg-[#ff3333]/60',
  skipped:   'bg-[#6c7680]/20',
};

const STEP_FILL: Record<string, string> = {
  pending:   '#1a1f26',
  ready:     '#162435',
  running:   '#2a1f0a',
  done:      '#1a2610',
  completed: '#1a2610',
  failed:    '#2a1010',
  skipped:   '#14181e',
};

const STEP_STROKE: Record<string, string> = {
  pending:   '#6c7680',
  ready:     '#59c2ff',
  running:   '#ffb454',
  done:      '#c2d94c',
  completed: '#c2d94c',
  failed:    '#ff3333',
  skipped:   '#3b4048',
};

const POLL_INTERVAL = 5000;
const DAG_NODE_W = 150;
const DAG_NODE_H = 44;
const DAG_H_GAP = 36;
const DAG_V_GAP = 60;
const DAG_PAD = 24;

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncId(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) : id;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function getWispTtlRemaining(mol: Molecule): number {
  if (mol.expiresAt) return Math.max(0, new Date(mol.expiresAt).getTime() - Date.now());
  if (mol.ttlMs && mol.createdAt) {
    return Math.max(0, new Date(mol.createdAt).getTime() + mol.ttlMs - Date.now());
  }
  return -1;
}

function getWispTtlTotal(mol: Molecule): number {
  if (mol.ttlMs) return mol.ttlMs;
  if (mol.expiresAt && mol.createdAt) {
    return new Date(mol.expiresAt).getTime() - new Date(mol.createdAt).getTime();
  }
  return -1;
}

function ttlColor(pct: number): string {
  if (pct > 50) return '#c2d94c';
  if (pct > 25) return '#ffb454';
  return '#ff3333';
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

/** Phase Pipeline — horizontal flow showing 4 MEOW phases with counts */
function PhasePipeline({
  counts,
  activePhase,
  onPhaseClick,
}: {
  counts: Record<MoleculePhase, number>;
  activePhase: MoleculePhase | 'all';
  onPhaseClick: (phase: MoleculePhase | 'all') => void;
}) {
  const phases: MoleculePhase[] = ['ice9', 'solid', 'liquid', 'vapor'];
  const transitions = ['cook', 'pour', 'burn'];

  return (
    <div className="flex items-center justify-center gap-0 py-4 px-6 overflow-x-auto">
      {phases.map((phase, idx) => {
        const cfg = PHASE_COLORS[phase];
        const tw = PHASE_TW[phase];
        const isActive = activePhase === phase;
        const count = counts[phase] || 0;

        return (
          <div key={phase} className="flex items-center">
            {/* Phase node */}
            <motion.button
              onClick={() => onPhaseClick(isActive ? 'all' : phase)}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              className={`
                relative flex flex-col items-center justify-center min-w-[100px] h-[68px]
                border font-mono transition-all duration-200
                ${isActive
                  ? `border-[${cfg.hex}]/50 bg-[${cfg.hex}]/10 ${tw.glow}`
                  : 'border-[#6c7680]/20 bg-[#1a1f26] hover:border-[#6c7680]/40'}
              `}
              style={{
                borderColor: isActive ? `${cfg.hex}80` : undefined,
                backgroundColor: isActive ? `${cfg.hex}15` : undefined,
              }}
            >
              <span className="text-lg" style={{ color: cfg.hex }}>{cfg.icon}</span>
              <span className="text-[10px] font-bold tracking-wider mt-0.5" style={{ color: cfg.hex }}>
                {cfg.label}
              </span>
              <span className="text-[10px] mt-0.5" style={{ color: `${cfg.hex}99` }}>
                {count}
              </span>
              {/* Pulsing ring for active filter */}
              {isActive && (
                <motion.div
                  className="absolute inset-0 border-2 pointer-events-none"
                  style={{ borderColor: `${cfg.hex}40` }}
                  animate={{ opacity: [0.6, 0.2, 0.6] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              )}
            </motion.button>

            {/* Transition arrow */}
            {idx < phases.length - 1 && (
              <div className="flex items-center mx-2 flex-shrink-0">
                <motion.div
                  className="flex items-center gap-1"
                  animate={{ x: [0, 4, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <div className="w-8 h-px" style={{ backgroundColor: '#6c768040' }} />
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M1 1L7 4L1 7" stroke="#6c7680" strokeWidth="1" strokeOpacity="0.4" />
                  </svg>
                </motion.div>
                <span className="text-[8px] font-mono absolute mt-6" style={{ color: '#6c768060' }}>
                  {transitions[idx]}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Molecule Card — compact card for the grid */
function MoleculeCard({
  mol,
  isSelected,
  onSelect,
  convoyName,
}: {
  mol: Molecule;
  isSelected: boolean;
  onSelect: () => void;
  convoyName?: string;
}) {
  const steps = mol.steps || [];
  const done = steps.filter(s => s.status === 'done' || s.status === 'completed').length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const readyCount = steps.filter(s => s.status === 'ready').length;
  const phaseCfg = PHASE_COLORS[mol.phase];
  const phaseTw = PHASE_TW[mol.phase];

  return (
    <motion.button
      onClick={onSelect}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      whileHover={{ y: -2 }}
      className={`
        text-left w-full p-4 font-mono transition-all duration-200
        border bg-[#1a1f26] hover:bg-[#1e2430]
        ${isSelected ? 'border-[#e6e1cf]/30 bg-[#1e2430]' : 'border-[#6c7680]/15 hover:border-[#6c7680]/30'}
      `}
    >
      {/* Header: name + phase badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-xs font-bold leading-tight" style={{ color: AYU.text }}>
          {mol.name}
        </span>
        <span className={`flex-none px-1.5 py-0.5 text-[9px] border ${phaseTw.badge}`}>
          {phaseCfg.label}
        </span>
      </div>

      {/* ID + status + formula */}
      <div className="flex items-center gap-2 mb-3 text-[10px]" style={{ color: AYU.muted }}>
        <span className="font-mono">{truncId(mol.id)}</span>
        <span className={`px-1 py-0.5 border ${STATUS_TW[mol.status]?.cls || ''}`}>
          {STATUS_TW[mol.status]?.label || mol.status}
        </span>
        {mol.formulaName && (
          <span style={{ color: '#6c768080' }}>{mol.formulaName}</span>
        )}
      </div>

      {/* Step progress bar */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: AYU.muted }}>
          <span>Steps</span>
          <span className="tabular-nums">{done}/{total} ({pct}%)</span>
        </div>
        <div className="w-full h-1.5 overflow-hidden" style={{ backgroundColor: '#6c768015' }}>
          <motion.div
            className="h-full"
            style={{ backgroundColor: phaseCfg.hex, opacity: 0.7 }}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Ready steps badge + convoy */}
      <div className="flex items-center gap-2">
        {readyCount > 0 && (
          <motion.span
            className="text-[9px] px-1.5 py-0.5 border border-[#59c2ff]/30 bg-[#59c2ff]/10 text-[#59c2ff] tabular-nums"
            animate={{ opacity: [1, 0.5, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            {readyCount} ready
          </motion.span>
        )}
        {convoyName && (
          <span className="text-[9px] px-1.5 py-0.5 border border-[#6c7680]/20 text-[#6c7680]">
            {convoyName}
          </span>
        )}
      </div>

      {/* Step mini-dots */}
      {steps.length > 0 && (
        <div className="flex gap-0.5 mt-2 flex-wrap">
          {steps.slice(0, 24).map(s => (
            <div
              key={s.id}
              title={`${s.name}: ${s.status}`}
              className={`w-2.5 h-2.5 ${STEP_DOT[s.status] || STEP_DOT.pending}`}
            />
          ))}
          {steps.length > 24 && (
            <span className="text-[8px] ml-1" style={{ color: '#6c768060' }}>
              +{steps.length - 24}
            </span>
          )}
        </div>
      )}
    </motion.button>
  );
}

/** DAG Layout computation for step visualization */
interface DAGNode {
  id: string;
  step: MoleculeStep;
  level: number;
  col: number;
  x: number;
  y: number;
}

interface DAGEdge {
  from: DAGNode;
  to: DAGNode;
}

function computeDAG(steps: MoleculeStep[]): { nodes: DAGNode[]; edges: DAGEdge[]; w: number; h: number } {
  if (!steps.length) return { nodes: [], edges: [], w: 0, h: 0 };

  const stepMap = new Map(steps.map(s => [s.id, s]));
  const levelMap = new Map<string, number>();

  function getLevel(id: string, visited: Set<string>): number {
    if (levelMap.has(id)) return levelMap.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const step = stepMap.get(id);
    const deps = step?.dependsOn || [];
    if (!deps.length) { levelMap.set(id, 0); return 0; }
    let max = 0;
    for (const d of deps) {
      if (stepMap.has(d)) max = Math.max(max, getLevel(d, visited) + 1);
    }
    levelMap.set(id, max);
    return max;
  }

  for (const s of steps) getLevel(s.id, new Set());

  const levels = new Map<number, MoleculeStep[]>();
  for (const s of steps) {
    const lv = levelMap.get(s.id) || 0;
    if (!levels.has(lv)) levels.set(lv, []);
    levels.get(lv)!.push(s);
  }

  const maxLevel = Math.max(...Array.from(levels.keys()), 0);
  const maxCols = Math.max(...Array.from(levels.values()).map(g => g.length), 1);
  const totalMaxW = maxCols * DAG_NODE_W + (maxCols - 1) * DAG_H_GAP;

  const nodes: DAGNode[] = [];
  const nodeMap = new Map<string, DAGNode>();

  for (let lv = 0; lv <= maxLevel; lv++) {
    const group = levels.get(lv) || [];
    const groupW = group.length * DAG_NODE_W + (group.length - 1) * DAG_H_GAP;
    const offset = (totalMaxW - groupW) / 2;
    for (let col = 0; col < group.length; col++) {
      const s = group[col];
      const node: DAGNode = {
        id: s.id,
        step: s,
        level: lv,
        col,
        x: DAG_PAD + offset + col * (DAG_NODE_W + DAG_H_GAP),
        y: DAG_PAD + lv * (DAG_NODE_H + DAG_V_GAP),
      };
      nodes.push(node);
      nodeMap.set(s.id, node);
    }
  }

  const edges: DAGEdge[] = [];
  for (const s of steps) {
    const to = nodeMap.get(s.id);
    if (!to) continue;
    for (const depId of (s.dependsOn || [])) {
      const from = nodeMap.get(depId);
      if (from) edges.push({ from, to });
    }
  }

  const w = totalMaxW + DAG_PAD * 2;
  const h = (maxLevel + 1) * (DAG_NODE_H + DAG_V_GAP) - DAG_V_GAP + DAG_PAD * 2;

  return { nodes, edges, w, h };
}

/** StepDAGPanel — SVG DAG for molecule detail */
function StepDAGPanel({
  steps,
  onComplete,
  onFail,
}: {
  steps: MoleculeStep[];
  onComplete: (stepId: string) => void;
  onFail: (stepId: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const dag = useMemo(() => computeDAG(steps), [steps]);

  if (!dag.nodes.length) {
    return (
      <div className="flex items-center justify-center h-32 text-[10px]" style={{ color: AYU.muted }}>
        No steps in this molecule
      </div>
    );
  }

  const svgW = Math.max(dag.w, 320);
  const svgH = Math.max(dag.h, 120);

  return (
    <div className="w-full overflow-auto" style={{ backgroundColor: '#0d1117' }}>
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="font-mono">
        <defs>
          <marker id="dag-arrow" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#6c768040" />
          </marker>
          <marker id="dag-arrow-done" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#c2d94c40" />
          </marker>
          {/* Glow filter for ready steps */}
          <filter id="ready-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges */}
        {dag.edges.map((e, i) => {
          const x1 = e.from.x + DAG_NODE_W / 2;
          const y1 = e.from.y + DAG_NODE_H;
          const x2 = e.to.x + DAG_NODE_W / 2;
          const y2 = e.to.y;
          const midY = (y1 + y2) / 2;
          const isDone = e.from.step.status === 'done' || e.from.step.status === 'completed';
          return (
            <path
              key={`e-${i}`}
              d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
              fill="none"
              stroke={isDone ? '#c2d94c40' : '#6c768025'}
              strokeWidth={isDone ? 1.5 : 1}
              markerEnd={isDone ? 'url(#dag-arrow-done)' : 'url(#dag-arrow)'}
            />
          );
        })}

        {/* Nodes */}
        {dag.nodes.map(node => {
          const s = node.step;
          const isHovered = hoveredId === s.id;
          const isReady = s.status === 'ready';
          const isActionable = s.status === 'ready' || s.status === 'running';
          const fill = STEP_FILL[s.status] || STEP_FILL.pending;
          const stroke = isHovered ? AYU.text : (STEP_STROKE[s.status] || STEP_STROKE.pending);

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{ cursor: isActionable ? 'pointer' : 'default' }}
              filter={isReady ? 'url(#ready-glow)' : undefined}
            >
              <rect
                width={DAG_NODE_W}
                height={DAG_NODE_H}
                fill={fill}
                stroke={stroke}
                strokeWidth={isHovered ? 1.5 : 1}
                strokeOpacity={isHovered ? 0.9 : 0.5}
              />
              {/* Running pulse */}
              {s.status === 'running' && (
                <rect
                  width={DAG_NODE_W} height={DAG_NODE_H}
                  fill="none" stroke="#ffb454" strokeWidth={2}
                >
                  <animate attributeName="stroke-opacity" values="0.6;0.15;0.6" dur="2s" repeatCount="indefinite" />
                </rect>
              )}
              {/* Name */}
              <text x={8} y={16} fontSize={9} fill={AYU.text} fontFamily="monospace" opacity={0.9}>
                {(s.name || '').length > 18 ? (s.name || '').slice(0, 16) + '..' : s.name || '?'}
              </text>
              {/* Status label */}
              <text x={DAG_NODE_W - 8} y={16} fontSize={7} fill={STEP_STROKE[s.status]} fontFamily="monospace" textAnchor="end" opacity={0.7}>
                {(s.status || '').toUpperCase()}
              </text>
              {/* Skill / assignee */}
              <text x={8} y={32} fontSize={7} fill="#6c7680" fontFamily="monospace" opacity={0.5}>
                {s.skill || s.assignee || (s.id ?? '').slice(0, 12) || '?'}
              </text>

              {/* Action buttons on hover */}
              {isHovered && isActionable && (
                <>
                  <g onClick={(e) => { e.stopPropagation(); onComplete(s.id); }} style={{ cursor: 'pointer' }}>
                    <rect x={DAG_NODE_W - 90} y={DAG_NODE_H - 14} width={38} height={11} fill="#c2d94c15" stroke="#c2d94c40" strokeWidth={0.5} />
                    <text x={DAG_NODE_W - 71} y={DAG_NODE_H - 5.5} fontSize={6} fill="#c2d94c" fontFamily="monospace" textAnchor="middle">DONE</text>
                  </g>
                  <g onClick={(e) => { e.stopPropagation(); onFail(s.id); }} style={{ cursor: 'pointer' }}>
                    <rect x={DAG_NODE_W - 48} y={DAG_NODE_H - 14} width={38} height={11} fill="#ff333315" stroke="#ff333340" strokeWidth={0.5} />
                    <text x={DAG_NODE_W - 29} y={DAG_NODE_H - 5.5} fontSize={6} fill="#ff3333" fontFamily="monospace" textAnchor="middle">FAIL</text>
                  </g>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Wisp Card for the Wisp Garden */
function WispGardenCard({
  wisp,
  onPromote,
  onBurn,
  actionLoading,
}: {
  wisp: Molecule;
  onPromote: () => void;
  onBurn: () => void;
  actionLoading: string | null;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = getWispTtlRemaining(wisp);
  const total = getWispTtlTotal(wisp);
  const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : -1;
  const isUrgent = remaining >= 0 && remaining < 60_000;
  const isDead = remaining === 0;
  const barColor = pct >= 0 ? ttlColor(pct) : '#6c7680';
  const fadeOpacity = pct >= 0 ? Math.max(0.3, pct / 100) : 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: fadeOpacity, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className={`
        relative p-3 border font-mono bg-[#1a1f26]
        ${isUrgent && !isDead ? 'border-[#ff3333]/40' : 'border-[#d2a6ff]/15'}
      `}
    >
      {/* Urgent pulsing border */}
      {isUrgent && !isDead && (
        <motion.div
          className="absolute inset-0 border-2 border-[#ff3333]/30 pointer-events-none"
          animate={{ opacity: [0, 0.7, 0] }}
          transition={{ duration: 1, repeat: Infinity }}
        />
      )}

      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold" style={{ color: '#d2a6ff' }}>{truncId(wisp.id, 10)}</span>
        <span className="text-[9px] px-1 py-0.5 border border-[#d2a6ff]/20 bg-[#d2a6ff]/10 text-[#d2a6ff]">
          WISP
        </span>
      </div>

      <div className="text-[9px] mb-2" style={{ color: AYU.muted }}>
        {wisp.formulaName || wisp.name}
      </div>

      {/* TTL countdown */}
      {pct >= 0 ? (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[8px] uppercase tracking-wider" style={{ color: '#6c768080' }}>TTL</span>
            <span className="text-[10px] font-bold tabular-nums" style={{ color: isDead ? '#ff3333' : barColor }}>
              {isDead ? 'EXPIRED' : formatMs(remaining)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden" style={{ backgroundColor: '#6c768015' }}>
            <motion.div
              className="h-full"
              style={{ backgroundColor: barColor }}
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.8 }}
            />
          </div>
        </div>
      ) : (
        <div className="text-[8px] italic mb-3" style={{ color: '#6c768050' }}>TTL unknown</div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onPromote(); }}
          disabled={actionLoading !== null}
          className="flex-1 text-[8px] uppercase tracking-wider px-2 py-1.5 border border-[#c2d94c]/30 bg-[#c2d94c]/10 text-[#c2d94c] hover:bg-[#c2d94c]/20 disabled:opacity-30 transition-colors"
        >
          {actionLoading === `promote-${wisp.id}` ? '...' : 'Promote'}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onBurn(); }}
          disabled={actionLoading !== null}
          className="flex-1 text-[8px] uppercase tracking-wider px-2 py-1.5 border border-[#ff3333]/30 bg-[#ff3333]/10 text-[#ff3333] hover:bg-[#ff3333]/20 disabled:opacity-30 transition-colors"
        >
          {actionLoading === `burn-${wisp.id}` ? '...' : 'Burn'}
        </button>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function MEOWChemistryView() {
  // State
  const [molecules, setMolecules] = useState<Molecule[]>([]);
  const [convoys, setConvoys] = useState<Convoy[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [filterPhase, setFilterPhase] = useState<MoleculePhase | 'all'>('all');
  const [selectedMolId, setSelectedMolId] = useState<string | null>(null);
  const [showCookPanel, setShowCookPanel] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Cook form state
  const [cookFormulaName, setCookFormulaName] = useState('');
  const [cookVars, setCookVars] = useState<CookVariable[]>([{ key: '', value: '' }]);
  const [cookResult, setCookResult] = useState<{ protoId?: string; error?: string } | null>(null);
  const [cooking, setCooking] = useState(false);
  const [wispTtlSec, setWispTtlSec] = useState(300);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────

  const fetchMolecules = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterPhase !== 'all') params.set('phase', filterPhase);
      const qs = params.toString();
      const res = await fetch(`${API}/api/meow/molecules${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items: Molecule[] = Array.isArray(data?.molecules) ? data.molecules : Array.isArray(data) ? data : [];
      setMolecules(items);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [filterPhase]);

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

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchMolecules(), fetchConvoys()]);
  }, [fetchMolecules, fetchConvoys]);

  useEffect(() => {
    setLoading(true);
    fetchAll().finally(() => setLoading(false));
    intervalRef.current = setInterval(() => fetchAll(), POLL_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchAll]);

  // ── Actions ────────────────────────────────────────────────────────

  const cookFormula = useCallback(async () => {
    if (!cookFormulaName.trim()) return;
    setCooking(true);
    setCookResult(null);
    try {
      const vars: Record<string, string> = {};
      for (const v of cookVars) {
        if (v.key.trim()) vars[v.key.trim()] = v.value;
      }
      const res = await fetch(`${API}/api/meow/cook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formulaName: cookFormulaName.trim(), variables: vars }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCookResult({ protoId: data.protoId || data.id });
      await fetchAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setCookResult({ error: msg });
    } finally {
      setCooking(false);
    }
  }, [cookFormulaName, cookVars, fetchAll]);

  const pourProto = useCallback(async (protoId: string) => {
    setActionLoading(`pour-${protoId}`);
    try {
      const res = await fetch(`${API}/api/meow/pour/${protoId}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCookResult(null);
      setCookFormulaName('');
      setCookVars([{ key: '', value: '' }]);
      await fetchAll();
    } catch (err: unknown) {
      console.error('[MEOWChemistry] pour failed:', err);
    } finally {
      setActionLoading(null);
    }
  }, [fetchAll]);

  const createWisp = useCallback(async (protoId: string) => {
    setActionLoading(`wisp-${protoId}`);
    try {
      const res = await fetch(`${API}/api/meow/wisp/${protoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlMs: wispTtlSec * 1000 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCookResult(null);
      setCookFormulaName('');
      setCookVars([{ key: '', value: '' }]);
      await fetchAll();
    } catch (err: unknown) {
      console.error('[MEOWChemistry] wisp failed:', err);
    } finally {
      setActionLoading(null);
    }
  }, [wispTtlSec, fetchAll]);

  const completeStep = useCallback(async (moleculeId: string, stepId: string) => {
    setActionLoading(`step-${stepId}`);
    try {
      const res = await fetch(`${API}/api/meow/molecules/${moleculeId}/steps/${stepId}/complete`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh detail
      const molRes = await fetch(`${API}/api/meow/molecules/${moleculeId}`);
      if (molRes.ok) {
        const data = await molRes.json();
        const updated = data.molecule || data;
        setMolecules(prev => prev.map(m => m.id === moleculeId ? updated : m));
      }
    } catch (err: unknown) {
      console.error('[MEOWChemistry] completeStep failed:', err);
    } finally {
      setActionLoading(null);
    }
  }, []);

  const failStep = useCallback(async (moleculeId: string, stepId: string) => {
    setActionLoading(`step-${stepId}`);
    try {
      await fetch(`${API}/api/meow/molecules/${moleculeId}/steps/${stepId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'failed' }),
      });
      const molRes = await fetch(`${API}/api/meow/molecules/${moleculeId}`);
      if (molRes.ok) {
        const data = await molRes.json();
        const updated = data.molecule || data;
        setMolecules(prev => prev.map(m => m.id === moleculeId ? updated : m));
      }
    } catch (err: unknown) {
      console.error('[MEOWChemistry] failStep failed:', err);
    } finally {
      setActionLoading(null);
    }
  }, []);

  const promoteWisp = useCallback(async (wispId: string) => {
    setActionLoading(`promote-${wispId}`);
    try {
      await fetch(`${API}/api/meow/pour/${wispId}`, { method: 'POST' });
      await fetchAll();
    } catch {
      // next poll will update
    } finally {
      setActionLoading(null);
    }
  }, [fetchAll]);

  const burnWisp = useCallback(async (wispId: string) => {
    setActionLoading(`burn-${wispId}`);
    try {
      await fetch(`${API}/api/meow/wisp/${wispId}`, { method: 'DELETE' });
      await fetchAll();
    } catch {
      // next poll will update
    } finally {
      setActionLoading(null);
    }
  }, [fetchAll]);

  // ── Derived ────────────────────────────────────────────────────────

  const phaseCounts = useMemo(() => {
    const c: Record<MoleculePhase, number> = { ice9: 0, solid: 0, liquid: 0, vapor: 0 };
    for (const m of molecules) { if (c[m.phase] !== undefined) c[m.phase]++; }
    return c;
  }, [molecules]);

  const nonVaporMolecules = useMemo(() => {
    return molecules.filter(m => m.phase !== 'vapor');
  }, [molecules]);

  const wisps = useMemo(() => {
    return molecules.filter(m => m.phase === 'vapor');
  }, [molecules]);

  const convoyMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of convoys) {
      for (const mid of (c.moleculeIds || [])) {
        map.set(mid, c.name);
      }
    }
    return map;
  }, [convoys]);

  const selectedMol = useMemo(() => {
    return molecules.find(m => m.id === selectedMolId) ?? null;
  }, [molecules, selectedMolId]);

  const stats = useMemo(() => {
    const total = molecules.length;
    const totalSteps = molecules.reduce((sum, m) => sum + (m.steps?.length || 0), 0);
    const doneSteps = molecules.reduce((sum, m) => sum + (m.steps?.filter(s => s.status === 'done' || s.status === 'completed').length || 0), 0);
    const completionRate = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
    const avgSteps = total > 0 ? (totalSteps / total).toFixed(1) : '0';
    return { total, totalSteps, doneSteps, completionRate, avgSteps, wisps: wisps.length };
  }, [molecules, wisps]);

  // ── Cook panel variables management ────────────────────────────────

  const addCookVar = () => setCookVars(prev => [...prev, { key: '', value: '' }]);
  const removeCookVar = (idx: number) => setCookVars(prev => prev.filter((_, i) => i !== idx));
  const updateCookVar = (idx: number, field: 'key' | 'value', val: string) => {
    setCookVars(prev => prev.map((v, i) => i === idx ? { ...v, [field]: val } : v));
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col font-mono overflow-hidden" style={{ backgroundColor: AYU.bg, color: AYU.text }}>

      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0" style={{ borderColor: AYU.border }}>
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 ${connected ? 'bg-[#c2d94c] animate-pulse' : 'bg-[#ff3333]'}`} />
          <h1 className="text-sm font-bold tracking-[0.15em] uppercase">MEOW Chemistry Lab</h1>
          <span className="text-[10px] px-2 py-0.5 border" style={{ borderColor: '#6c768030', color: AYU.muted }}>
            {stats.total} molecules
          </span>
          <span className="text-[10px] px-2 py-0.5 border border-[#d2a6ff]/20 bg-[#d2a6ff]/10 text-[#d2a6ff]">
            {stats.wisps} wisps
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCookPanel(!showCookPanel)}
            className="px-3 py-1.5 text-[10px] uppercase tracking-wider border border-[#59c2ff]/30 bg-[#59c2ff]/10 text-[#59c2ff] hover:bg-[#59c2ff]/20 transition-colors"
          >
            {showCookPanel ? 'Close Cook' : 'Cook Formula'}
          </button>
          <button
            onClick={() => { setLoading(true); fetchAll().finally(() => setLoading(false)); }}
            className="px-2 py-1.5 text-[10px] border hover:bg-[#1a1f26] transition-colors"
            style={{ borderColor: '#6c768030', color: AYU.muted }}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* ── Phase Pipeline ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b" style={{ borderColor: AYU.border }}>
        <PhasePipeline counts={phaseCounts} activePhase={filterPhase} onPhaseClick={setFilterPhase} />
      </div>

      {/* ── Cook Interface (collapsible) ────────────────────────────── */}
      <AnimatePresence>
        {showCookPanel && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="flex-shrink-0 border-b overflow-hidden"
            style={{ borderColor: AYU.border }}
          >
            <div className="p-5 bg-[#141920]">
              <div className="text-[10px] uppercase tracking-widest mb-3" style={{ color: AYU.muted }}>
                Cook New Protomolecule
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Formula name */}
                <div>
                  <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: '#6c768080' }}>Formula Name</label>
                  <input
                    value={cookFormulaName}
                    onChange={e => setCookFormulaName(e.target.value)}
                    placeholder="e.g. deploy-pipeline"
                    className="w-full px-3 py-2 text-xs border bg-[#0f1419] focus:outline-none focus:border-[#59c2ff]/40 placeholder-[#6c768040]"
                    style={{ borderColor: '#6c768030', color: AYU.text }}
                  />
                </div>

                {/* Variables editor */}
                <div>
                  <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: '#6c768080' }}>Variables</label>
                  <div className="space-y-1 max-h-[100px] overflow-y-auto">
                    {cookVars.map((v, idx) => (
                      <div key={idx} className="flex items-center gap-1">
                        <input
                          value={v.key}
                          onChange={e => updateCookVar(idx, 'key', e.target.value)}
                          placeholder="key"
                          className="flex-1 px-2 py-1 text-[10px] border bg-[#0f1419] focus:outline-none"
                          style={{ borderColor: '#6c768020', color: AYU.text }}
                        />
                        <input
                          value={v.value}
                          onChange={e => updateCookVar(idx, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-1 px-2 py-1 text-[10px] border bg-[#0f1419] focus:outline-none"
                          style={{ borderColor: '#6c768020', color: AYU.text }}
                        />
                        {cookVars.length > 1 && (
                          <button onClick={() => removeCookVar(idx)} className="text-[#ff3333]/60 hover:text-[#ff3333] text-xs px-1">x</button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button onClick={addCookVar} className="text-[9px] mt-1 text-[#59c2ff]/60 hover:text-[#59c2ff]">+ Add Variable</button>
                </div>

                {/* Actions + TTL slider */}
                <div className="flex flex-col gap-2">
                  <button
                    onClick={cookFormula}
                    disabled={!cookFormulaName.trim() || cooking}
                    className="px-4 py-2 text-[10px] uppercase tracking-wider border border-[#59c2ff]/40 bg-[#59c2ff]/15 text-[#59c2ff] hover:bg-[#59c2ff]/25 disabled:opacity-30 transition-colors"
                  >
                    {cooking ? 'Cooking...' : 'Cook'}
                  </button>

                  {cookResult?.protoId && (
                    <div className="space-y-1">
                      <div className="text-[9px] text-[#c2d94c]">Proto: {truncId(cookResult.protoId, 12)}</div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => pourProto(cookResult.protoId!)}
                          disabled={actionLoading !== null}
                          className="flex-1 px-2 py-1.5 text-[9px] uppercase border border-[#c2d94c]/30 bg-[#c2d94c]/10 text-[#c2d94c] hover:bg-[#c2d94c]/20 disabled:opacity-30 transition-colors"
                        >
                          Pour
                        </button>
                        <button
                          onClick={() => createWisp(cookResult.protoId!)}
                          disabled={actionLoading !== null}
                          className="flex-1 px-2 py-1.5 text-[9px] uppercase border border-[#d2a6ff]/30 bg-[#d2a6ff]/10 text-[#d2a6ff] hover:bg-[#d2a6ff]/20 disabled:opacity-30 transition-colors"
                        >
                          Wisp
                        </button>
                      </div>
                      {/* TTL slider for wisp */}
                      <div>
                        <label className="block text-[8px] uppercase tracking-wider mb-0.5" style={{ color: '#6c768060' }}>
                          Wisp TTL: {wispTtlSec}s ({formatMs(wispTtlSec * 1000)})
                        </label>
                        <input
                          type="range"
                          min={30}
                          max={3600}
                          step={30}
                          value={wispTtlSec}
                          onChange={e => setWispTtlSec(Number(e.target.value))}
                          className="w-full h-1 appearance-none cursor-pointer"
                          style={{ accentColor: '#d2a6ff' }}
                        />
                      </div>
                    </div>
                  )}

                  {cookResult?.error && (
                    <div className="text-[9px] text-[#ff3333]">{cookResult.error}</div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main Content ────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* ── Left: Molecule Grid + Wisp Garden ──────────────────────── */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">

          {/* Molecule Grid */}
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-[140px] bg-[#1a1f26] animate-pulse" />
                ))}
              </div>
            ) : nonVaporMolecules.length === 0 && wisps.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <div className="text-3xl opacity-15">&#x2697;</div>
                <div className="text-sm" style={{ color: '#6c768060' }}>No molecules found</div>
                <div className="text-[10px]" style={{ color: '#6c768040' }}>
                  Cook a formula to create your first protomolecule
                </div>
              </div>
            ) : (
              <>
                {/* Non-vapor molecules */}
                {nonVaporMolecules.length > 0 && (
                  <div className="mb-6">
                    <div className="text-[10px] uppercase tracking-widest mb-3" style={{ color: AYU.muted }}>
                      Molecules ({nonVaporMolecules.length})
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      <AnimatePresence mode="popLayout">
                        {nonVaporMolecules.map(mol => (
                          <MoleculeCard
                            key={mol.id}
                            mol={mol}
                            isSelected={selectedMolId === mol.id}
                            onSelect={() => setSelectedMolId(selectedMolId === mol.id ? null : mol.id)}
                            convoyName={convoyMap.get(mol.id)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                {/* Wisp Garden */}
                {wisps.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="text-[10px] uppercase tracking-widest" style={{ color: '#d2a6ff' }}>
                        Wisp Garden
                      </div>
                      <span className="text-[9px] px-1.5 py-0.5 border border-[#d2a6ff]/20 bg-[#d2a6ff]/10 text-[#d2a6ff] tabular-nums">
                        {wisps.length} active
                      </span>
                      {/* Decorative vapor particles */}
                      <div className="relative w-16 h-4 overflow-hidden">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <motion.div
                            key={i}
                            className="absolute w-1 h-1 bg-[#d2a6ff]/20"
                            style={{ left: `${10 + i * 15}%`, bottom: 0 }}
                            animate={{ opacity: [0, 0.5, 0], y: [0, -12, -20] }}
                            transition={{ duration: 2 + i * 0.4, repeat: Infinity, delay: i * 0.3 }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                      <AnimatePresence mode="popLayout">
                        {wisps.map(w => (
                          <WispGardenCard
                            key={w.id}
                            wisp={w}
                            onPromote={() => promoteWisp(w.id)}
                            onBurn={() => burnWisp(w.id)}
                            actionLoading={actionLoading}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </main>

        {/* ── Right: Molecule Detail Panel ────────────────────────────── */}
        <AnimatePresence mode="wait">
          {selectedMol && (
            <motion.div
              key={selectedMol.id}
              initial={{ x: 360, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 360, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="w-[380px] flex-shrink-0 border-l flex flex-col overflow-hidden"
              style={{ borderColor: AYU.border, backgroundColor: '#141920' }}
            >
              {/* Detail header */}
              <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ borderColor: AYU.border }}>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider" style={{ color: AYU.text }}>
                    Molecule Detail
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: AYU.muted }}>{truncId(selectedMol.id, 12)}</div>
                </div>
                <button
                  onClick={() => setSelectedMolId(null)}
                  className="text-[10px] px-2 py-1 border hover:bg-[#1a1f26] transition-colors"
                  style={{ borderColor: '#6c768030', color: AYU.muted }}
                >
                  CLOSE
                </button>
              </div>

              {/* Scrollable detail content */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {/* Name and badges */}
                <div className="px-4 py-3 border-b" style={{ borderColor: AYU.border }}>
                  <div className="text-sm font-bold mb-2" style={{ color: AYU.text }}>{selectedMol.name}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 text-[9px] border ${PHASE_TW[selectedMol.phase].badge}`}>
                      {PHASE_COLORS[selectedMol.phase].icon} {PHASE_COLORS[selectedMol.phase].label}
                    </span>
                    <span className={`px-1.5 py-0.5 text-[9px] border ${STATUS_TW[selectedMol.status]?.cls}`}>
                      {STATUS_TW[selectedMol.status]?.label || selectedMol.status}
                    </span>
                    {selectedMol.formulaName && (
                      <span className="text-[9px] px-1.5 py-0.5 border" style={{ borderColor: '#6c768020', color: AYU.muted }}>
                        {selectedMol.formulaName}
                      </span>
                    )}
                  </div>
                </div>

                {/* Metadata grid */}
                <div className="px-4 py-3 border-b" style={{ borderColor: AYU.border }}>
                  <div className="text-[9px] uppercase tracking-widest mb-2" style={{ color: '#6c768060' }}>Metadata</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {[
                      { label: 'ID', value: selectedMol.id },
                      { label: 'Formula', value: selectedMol.formulaName || '-' },
                      { label: 'Created', value: selectedMol.createdAt ? new Date(selectedMol.createdAt).toLocaleString() : '-' },
                      { label: 'Updated', value: selectedMol.updatedAt ? new Date(selectedMol.updatedAt).toLocaleString() : '-' },
                      { label: 'Convoy', value: convoyMap.get(selectedMol.id) || '-' },
                      { label: 'Steps', value: `${selectedMol.steps?.length || 0}` },
                    ].map(row => (
                      <div key={row.label}>
                        <div className="text-[8px] uppercase tracking-wider" style={{ color: '#6c768050' }}>{row.label}</div>
                        <div className="text-[10px] font-mono break-all" style={{ color: '#e6e1cf99' }}>{row.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Step progress summary */}
                <div className="px-4 py-3 border-b" style={{ borderColor: AYU.border }}>
                  <div className="text-[9px] uppercase tracking-widest mb-2" style={{ color: '#6c768060' }}>Step Progress</div>
                  {(() => {
                    const steps = selectedMol.steps || [];
                    const total = steps.length;
                    const done = steps.filter(s => s.status === 'done' || s.status === 'completed').length;
                    const running = steps.filter(s => s.status === 'running').length;
                    const ready = steps.filter(s => s.status === 'ready').length;
                    const failed = steps.filter(s => s.status === 'failed').length;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <>
                        <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: AYU.muted }}>
                          <span>{done}/{total} complete</span>
                          <span className="tabular-nums">{pct}%</span>
                        </div>
                        <div className="w-full h-2 overflow-hidden mb-2" style={{ backgroundColor: '#6c768015' }}>
                          <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: PHASE_COLORS[selectedMol.phase].hex, opacity: 0.7 }} />
                        </div>
                        <div className="flex items-center gap-3 text-[9px]">
                          {ready > 0 && <span className="text-[#59c2ff]">{ready} ready</span>}
                          {running > 0 && <span className="text-[#ffb454]">{running} running</span>}
                          {failed > 0 && <span className="text-[#ff3333]">{failed} failed</span>}
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* DAG visualization */}
                <div className="px-4 py-3 border-b" style={{ borderColor: AYU.border }}>
                  <div className="text-[9px] uppercase tracking-widest mb-2" style={{ color: '#6c768060' }}>
                    Step DAG
                  </div>
                  <div className="border" style={{ borderColor: '#6c768015' }}>
                    <StepDAGPanel
                      steps={selectedMol.steps || []}
                      onComplete={(stepId) => completeStep(selectedMol.id, stepId)}
                      onFail={(stepId) => failStep(selectedMol.id, stepId)}
                    />
                  </div>
                </div>

                {/* Step list (vertical timeline) */}
                <div className="px-4 py-3">
                  <div className="text-[9px] uppercase tracking-widest mb-2" style={{ color: '#6c768060' }}>
                    Steps ({selectedMol.steps?.length || 0})
                  </div>
                  <div className="space-y-0">
                    {(selectedMol.steps || []).map((step, idx) => {
                      const isLast = idx === (selectedMol.steps?.length || 0) - 1;
                      const isActionable = step.status === 'ready' || step.status === 'running';
                      return (
                        <div key={step.id} className="flex gap-3">
                          {/* Timeline connector */}
                          <div className="flex flex-col items-center w-4 flex-shrink-0">
                            <div
                              className={`w-2.5 h-2.5 ${STEP_DOT[step.status] || STEP_DOT.pending}`}
                              style={{ border: `1px solid ${STEP_STROKE[step.status] || STEP_STROKE.pending}40` }}
                            />
                            {!isLast && <div className="w-px flex-1 min-h-[20px]" style={{ backgroundColor: '#6c768020' }} />}
                          </div>
                          {/* Step content */}
                          <div className="flex-1 pb-3 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px]" style={{ color: STEP_STROKE[step.status] || AYU.muted }}>
                                {step.name}
                              </span>
                              <span className="text-[8px] uppercase flex-shrink-0" style={{ color: '#6c768060' }}>
                                {step.status}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[9px]" style={{ color: '#6c768050' }}>
                              {step.assignee && <span>{step.assignee}</span>}
                              {step.skill && <span>{step.skill}</span>}
                              {step.dependsOn && step.dependsOn.length > 0 && (
                                <span>{step.dependsOn.length} dep{step.dependsOn.length > 1 ? 's' : ''}</span>
                              )}
                            </div>
                            {isActionable && (
                              <div className="flex gap-1 mt-1">
                                <button
                                  onClick={() => completeStep(selectedMol.id, step.id)}
                                  disabled={actionLoading !== null}
                                  className="px-2 py-0.5 text-[8px] uppercase border border-[#c2d94c]/30 bg-[#c2d94c]/10 text-[#c2d94c] hover:bg-[#c2d94c]/20 disabled:opacity-30 transition-colors"
                                >
                                  Complete
                                </button>
                                <button
                                  onClick={() => failStep(selectedMol.id, step.id)}
                                  disabled={actionLoading !== null}
                                  className="px-2 py-0.5 text-[8px] uppercase border border-[#ff3333]/30 bg-[#ff3333]/10 text-[#ff3333] hover:bg-[#ff3333]/20 disabled:opacity-30 transition-colors"
                                >
                                  Fail
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Chemistry Stats Footer ──────────────────────────────────── */}
      <footer className="flex items-center justify-between px-5 py-2.5 border-t flex-shrink-0" style={{ borderColor: AYU.border, backgroundColor: '#0d1117' }}>
        <div className="flex items-center gap-6">
          {/* Phase breakdown */}
          <div className="flex items-center gap-3">
            {(['ice9', 'solid', 'liquid', 'vapor'] as MoleculePhase[]).map(phase => (
              <div key={phase} className="flex items-center gap-1">
                <div className="w-2 h-2" style={{ backgroundColor: PHASE_COLORS[phase].hex, opacity: 0.6 }} />
                <span className="text-[9px] tabular-nums" style={{ color: PHASE_COLORS[phase].hex }}>
                  {phaseCounts[phase]}
                </span>
                <span className="text-[8px] uppercase" style={{ color: '#6c768050' }}>{PHASE_COLORS[phase].label}</span>
              </div>
            ))}
          </div>

          <div className="w-px h-4" style={{ backgroundColor: '#6c768020' }} />

          {/* Completion rate */}
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] uppercase tracking-wider" style={{ color: '#6c768050' }}>Completion</span>
            <span className="text-[10px] font-bold tabular-nums" style={{ color: '#c2d94c' }}>{stats.completionRate}%</span>
            <span className="text-[8px]" style={{ color: '#6c768040' }}>({stats.doneSteps}/{stats.totalSteps} steps)</span>
          </div>

          <div className="w-px h-4" style={{ backgroundColor: '#6c768020' }} />

          {/* Average steps */}
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] uppercase tracking-wider" style={{ color: '#6c768050' }}>Avg Steps</span>
            <span className="text-[10px] tabular-nums" style={{ color: AYU.muted }}>{stats.avgSteps}</span>
          </div>

          <div className="w-px h-4" style={{ backgroundColor: '#6c768020' }} />

          {/* Active wisps */}
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] uppercase tracking-wider" style={{ color: '#6c768050' }}>Wisps</span>
            <span className="text-[10px] tabular-nums" style={{ color: '#d2a6ff' }}>{stats.wisps}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[9px]" style={{ color: '#6c768030' }}>
            {connected ? 'CONNECTED' : 'OFFLINE'}
          </span>
          <span className="text-[9px]" style={{ color: '#6c768020' }}>
            poll: {POLL_INTERVAL / 1000}s
          </span>
        </div>
      </footer>
    </div>
  );
}
