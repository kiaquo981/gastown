'use client';

/**
 * MoleculeDAG — SVG-based DAG visualization for molecule steps
 *
 * Layered layout: assigns each step to a depth level based on longest path
 * from root nodes. Steps at the same level are arranged horizontally.
 * Edges drawn as cubic bezier curves between nodes.
 */

import { useMemo, useCallback, useState } from 'react';

/* ---------- Types ---------- */

type StepStatus = 'pending' | 'ready' | 'running' | 'done' | 'completed' | 'failed' | 'gated' | 'skipped';

interface DAGStep {
  id: string;
  name: string;
  status: StepStatus;
  skill?: string;
  type?: string;
  gate?: string;
  dependsOn?: string[];
  assignee?: string;
}

interface MoleculeDAGProps {
  steps: DAGStep[];
  onStepClick?: (stepId: string) => void;
  onCompleteStep?: (stepId: string) => void;
  selectedStepId?: string | null;
}

/* ---------- Layout Constants ---------- */

const NODE_W = 160;
const NODE_H = 48;
const H_GAP = 40;
const V_GAP = 70;
const PADDING = 30;

/* ---------- Status Colors ---------- */

const STATUS_FILL: Record<string, string> = {
  pending:   '#1a1a2e',
  ready:     '#0d1b2a',
  running:   '#2a1a00',
  done:      '#0a1f0a',
  completed: '#0a1f0a',
  failed:    '#2a0a0a',
  gated:     '#1a1a00',
  skipped:   '#111111',
};

const STATUS_STROKE: Record<string, string> = {
  pending:   '#333',
  ready:     '#3b82f6',
  running:   '#f59e0b',
  done:      '#22c55e',
  completed: '#22c55e',
  failed:    '#ef4444',
  gated:     '#eab308',
  skipped:   '#333',
};

const STATUS_TEXT: Record<string, string> = {
  pending:   '#666',
  ready:     '#60a5fa',
  running:   '#fbbf24',
  done:      '#4ade80',
  completed: '#4ade80',
  failed:    '#f87171',
  gated:     '#facc15',
  skipped:   '#555',
};

const STATUS_LABEL: Record<string, string> = {
  pending:   'PENDING',
  ready:     'READY',
  running:   'RUNNING',
  done:      'DONE',
  completed: 'DONE',
  failed:    'FAILED',
  gated:     'GATED',
  skipped:   'SKIP',
};

/* ---------- Layout Algorithm ---------- */

interface LayoutNode {
  id: string;
  step: DAGStep;
  level: number;
  col: number;
  x: number;
  y: number;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
}

function computeLayout(steps: DAGStep[]): { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number } {
  if (steps.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const stepMap = new Map(steps.map(s => [s.id, s]));
  const deps = new Map<string, string[]>();
  for (const s of steps) {
    deps.set(s.id, s.dependsOn || []);
  }

  // Compute levels via longest path from roots
  const levelMap = new Map<string, number>();

  function getLevel(id: string, visited: Set<string>): number {
    if (levelMap.has(id)) return levelMap.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);

    const parents = deps.get(id) || [];
    if (parents.length === 0) {
      levelMap.set(id, 0);
      return 0;
    }

    let maxParent = 0;
    for (const p of parents) {
      if (stepMap.has(p)) {
        maxParent = Math.max(maxParent, getLevel(p, visited) + 1);
      }
    }
    levelMap.set(id, maxParent);
    return maxParent;
  }

  for (const s of steps) {
    getLevel(s.id, new Set());
  }

  // Group by level
  const levels = new Map<number, DAGStep[]>();
  for (const s of steps) {
    const lv = levelMap.get(s.id) || 0;
    if (!levels.has(lv)) levels.set(lv, []);
    levels.get(lv)!.push(s);
  }

  const maxLevel = Math.max(...Array.from(levels.keys()), 0);

  // Assign positions
  const nodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();

  for (let lv = 0; lv <= maxLevel; lv++) {
    const group = levels.get(lv) || [];
    const totalWidth = group.length * NODE_W + (group.length - 1) * H_GAP;
    const startX = PADDING;

    for (let col = 0; col < group.length; col++) {
      const s = group[col];
      const node: LayoutNode = {
        id: s.id,
        step: s,
        level: lv,
        col,
        x: startX + col * (NODE_W + H_GAP),
        y: PADDING + lv * (NODE_H + V_GAP),
      };
      nodes.push(node);
      nodeMap.set(s.id, node);
    }
  }

  // Center each level horizontally relative to the widest level
  const maxCols = Math.max(...Array.from(levels.values()).map(g => g.length), 1);
  const totalMaxWidth = maxCols * NODE_W + (maxCols - 1) * H_GAP;

  for (const node of nodes) {
    const group = levels.get(node.level) || [];
    const groupWidth = group.length * NODE_W + (group.length - 1) * H_GAP;
    const offset = (totalMaxWidth - groupWidth) / 2;
    node.x += offset;
  }

  // Build edges
  const edges: LayoutEdge[] = [];
  for (const s of steps) {
    const toNode = nodeMap.get(s.id);
    if (!toNode) continue;
    for (const depId of (s.dependsOn || [])) {
      const fromNode = nodeMap.get(depId);
      if (fromNode) {
        edges.push({ from: fromNode, to: toNode });
      }
    }
  }

  const width = totalMaxWidth + PADDING * 2;
  const height = (maxLevel + 1) * (NODE_H + V_GAP) - V_GAP + PADDING * 2;

  return { nodes, edges, width, height };
}

/* ---------- Component ---------- */

export default function MoleculeDAG({ steps, onStepClick, onCompleteStep, selectedStepId }: MoleculeDAGProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const layout = useMemo(() => computeLayout(steps), [steps]);

  const handleClick = useCallback((id: string) => {
    onStepClick?.(id);
  }, [onStepClick]);

  if (layout.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#4a5159] text-sm">
        No steps to visualize
      </div>
    );
  }

  const svgW = Math.max(layout.width, 400);
  const svgH = Math.max(layout.height, 200);

  return (
    <div className="w-full h-full overflow-auto bg-[#0a0a0a]">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="font-mono"
      >
        {/* Edges */}
        {layout.edges.map((e, i) => {
          const x1 = e.from.x + NODE_W / 2;
          const y1 = e.from.y + NODE_H;
          const x2 = e.to.x + NODE_W / 2;
          const y2 = e.to.y;
          const midY = (y1 + y2) / 2;

          const isActive = e.from.step.status === 'completed' || e.from.step.status === 'done';
          const stroke = isActive ? '#22c55e40' : '#ffffff10';

          return (
            <path
              key={`edge-${i}`}
              d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
              fill="none"
              stroke={stroke}
              strokeWidth={isActive ? 2 : 1}
            />
          );
        })}

        {/* Arrow markers on edges */}
        <defs>
          <marker id="arrow-dim" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#ffffff15" />
          </marker>
          <marker id="arrow-active" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
            <polygon points="0 0, 6 2, 0 4" fill="#22c55e40" />
          </marker>
        </defs>

        {/* Nodes */}
        {layout.nodes.map(node => {
          const s = node.step;
          const status = s.status as StepStatus;
          const isHovered = hoveredId === s.id;
          const isSelected = selectedStepId === s.id;
          const fill = STATUS_FILL[status] || STATUS_FILL.pending;
          const stroke = isSelected ? '#fff' : isHovered ? '#888' : (STATUS_STROKE[status] || STATUS_STROKE.pending);
          const textColor = STATUS_TEXT[status] || STATUS_TEXT.pending;
          const label = STATUS_LABEL[status] || status.toUpperCase();
          const isActionable = status === 'ready' || status === 'running' || status === 'gated';

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => handleClick(s.id)}
              style={{ cursor: 'pointer' }}
            >
              {/* Node background */}
              <rect
                x={0}
                y={0}
                width={NODE_W}
                height={NODE_H}
                fill={fill}
                stroke={stroke}
                strokeWidth={isSelected ? 2 : 1}
                rx={0}
              />

              {/* Running pulse */}
              {status === 'running' && (
                <rect
                  x={0}
                  y={0}
                  width={NODE_W}
                  height={NODE_H}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  rx={0}
                  opacity={0.5}
                >
                  <animate attributeName="opacity" values="0.5;0.1;0.5" dur="2s" repeatCount="indefinite" />
                </rect>
              )}

              {/* Step title */}
              <text
                x={8}
                y={18}
                fontSize={10}
                fill={textColor}
                fontFamily="monospace"
              >
                {(s.name || '').length > 20 ? (s.name || '').slice(0, 18) + '..' : s.name || '?'}
              </text>

              {/* Status label */}
              <text
                x={NODE_W - 8}
                y={18}
                fontSize={8}
                fill={textColor}
                fontFamily="monospace"
                textAnchor="end"
                opacity={0.6}
              >
                {label}
              </text>

              {/* Skill / type info */}
              <text
                x={8}
                y={36}
                fontSize={8}
                fill="#ffffff30"
                fontFamily="monospace"
              >
                {s.skill || s.type || s.id}
              </text>

              {/* Gate indicator */}
              {s.gate && (
                <rect
                  x={NODE_W - 6}
                  y={2}
                  width={4}
                  height={4}
                  fill="#eab308"
                  opacity={status === 'gated' ? 1 : 0.3}
                />
              )}

              {/* Complete button overlay on hover for actionable steps */}
              {isHovered && isActionable && onCompleteStep && (
                <g
                  onClick={(e) => { e.stopPropagation(); onCompleteStep(s.id); }}
                >
                  <rect
                    x={NODE_W - 50}
                    y={NODE_H - 16}
                    width={42}
                    height={12}
                    fill="#22c55e20"
                    stroke="#22c55e40"
                    strokeWidth={1}
                    rx={0}
                  />
                  <text
                    x={NODE_W - 29}
                    y={NODE_H - 7}
                    fontSize={7}
                    fill="#4ade80"
                    fontFamily="monospace"
                    textAnchor="middle"
                  >
                    COMPLETE
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
