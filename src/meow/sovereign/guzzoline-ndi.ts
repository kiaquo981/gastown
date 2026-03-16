/**
 * GUZZOLINE RESERVOIR + NDI (Nondeterministic Idempotence)
 * + BOND OPERATOR TABLE + COMPOUND FORMULAS
 *
 * Four foundational Gas Town concepts in one module:
 *
 * 1. GUZZOLINE — The fuel reservoir metaphor.
 *    "Generators fill the reservoir, Convoys consume it."
 *    Tracks work capacity: how much "fuel" (available work/budget/capacity) the system has.
 *
 * 2. NDI — Nondeterministic Idempotence.
 *    Three Pillars of Persistence: Agent Bead + Hook Bead + Molecule Chain.
 *    All in Git. Sessions are cattle; agents are persistent identities.
 *    Even if a session dies, the work state survives in the bead + hook + molecule triplet.
 *
 * 3. BOND OPERATOR TABLE — MEOW operation algebra.
 *    Operand A + Operand B → Result using named operators.
 *    Formula + Vars → Proto (cook), Proto + Context → Molecule (pour), etc.
 *
 * 4. COMPOUND FORMULAS — Formulas that compose other formulas.
 *    Compound Formulas bundle sub-formulas into cascading workflows.
 *    Compound Protos are pre-configured multi-formula templates.
 */

import { createLogger } from '../../lib/logger';
import { broadcast } from '../../sse';

const log = createLogger('guzzoline-ndi');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GUZZOLINE RESERVOIR
// ═══════════════════════════════════════════════════════════════════════════════

export interface GuzzolineReservoir {
  /** Current fuel level (0-100) */
  level: number;
  /** Maximum capacity */
  capacity: number;
  /** Rate of consumption per hour */
  burnRate: number;
  /** Rate of generation per hour */
  fillRate: number;
  /** Estimated hours until empty at current burn rate */
  hoursRemaining: number;
  /** Breakdown by category */
  breakdown: {
    beadsReady: number;      // Beads available to work on
    polecatSlots: number;    // Available polecat spawn slots
    budgetRemaining: number; // $ remaining in daily budget
    apiQuota: number;        // LLM API calls remaining (pct)
    mergeQueueSpace: number; // Merge queue capacity (pct)
  };
  /** Generators feeding the reservoir */
  generators: GuzzolineGenerator[];
  /** Consumers draining the reservoir */
  consumers: GuzzolineConsumer[];
  /** History of level over time */
  history: Array<{ timestamp: Date; level: number }>;
}

export interface GuzzolineGenerator {
  name: string;
  type: 'bead_creation' | 'budget_topup' | 'slot_release' | 'quota_reset';
  rate: number;          // units per hour
  lastContribution: Date;
}

export interface GuzzolineConsumer {
  name: string;
  type: 'polecat_work' | 'api_calls' | 'merge_ops' | 'patrol_runs';
  rate: number;          // units per hour
  lastConsumption: Date;
}

export class GuzzolineEngine {
  private reservoir: GuzzolineReservoir;
  private maxHistory = 100;

  constructor() {
    this.reservoir = {
      level: 72,
      capacity: 100,
      burnRate: 8.5,
      fillRate: 12.0,
      hoursRemaining: 8.5,
      breakdown: {
        beadsReady: 15,
        polecatSlots: 3,
        budgetRemaining: 35.50,
        apiQuota: 68,
        mergeQueueSpace: 85,
      },
      generators: [
        { name: 'Issue Backlog', type: 'bead_creation', rate: 5, lastContribution: new Date() },
        { name: 'Daily Budget', type: 'budget_topup', rate: 2, lastContribution: new Date() },
        { name: 'Polecat Recycling', type: 'slot_release', rate: 8, lastContribution: new Date() },
        { name: 'API Quota Reset', type: 'quota_reset', rate: 1, lastContribution: new Date() },
      ],
      consumers: [
        { name: 'Polecat Work', type: 'polecat_work', rate: 6, lastConsumption: new Date() },
        { name: 'LLM API Calls', type: 'api_calls', rate: 4, lastConsumption: new Date() },
        { name: 'Merge Operations', type: 'merge_ops', rate: 2, lastConsumption: new Date() },
        { name: 'Patrol Cycles', type: 'patrol_runs', rate: 1, lastConsumption: new Date() },
      ],
      history: [],
    };

    // Seed history with last 24 data points
    const now = Date.now();
    for (let i = 23; i >= 0; i--) {
      this.reservoir.history.push({
        timestamp: new Date(now - i * 3600000),
        level: Math.max(20, Math.min(95, 72 + Math.sin(i * 0.5) * 20 + (Math.random() - 0.5) * 10)),
      });
    }
  }

  getReservoir(): GuzzolineReservoir {
    return { ...this.reservoir };
  }

  /** Consume fuel (called when work is done) */
  consume(amount: number, consumerType: GuzzolineConsumer['type']): void {
    this.reservoir.level = Math.max(0, this.reservoir.level - amount);
    const consumer = this.reservoir.consumers.find(c => c.type === consumerType);
    if (consumer) consumer.lastConsumption = new Date();
    this.updateMetrics();
  }

  /** Generate fuel (called when capacity is added) */
  generate(amount: number, generatorType: GuzzolineGenerator['type']): void {
    this.reservoir.level = Math.min(this.reservoir.capacity, this.reservoir.level + amount);
    const gen = this.reservoir.generators.find(g => g.type === generatorType);
    if (gen) gen.lastContribution = new Date();
    this.updateMetrics();
  }

  private updateMetrics(): void {
    const netRate = this.reservoir.fillRate - this.reservoir.burnRate;
    this.reservoir.hoursRemaining = netRate >= 0
      ? 999
      : this.reservoir.level / Math.abs(netRate);

    this.reservoir.history.push({ timestamp: new Date(), level: this.reservoir.level });
    if (this.reservoir.history.length > this.maxHistory) {
      this.reservoir.history = this.reservoir.history.slice(-this.maxHistory);
    }

    if (this.reservoir.level < 20) {
      broadcast('meow:guzzoline', {
        type: 'low_fuel',
        level: this.reservoir.level,
        hoursRemaining: this.reservoir.hoursRemaining,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. NDI — NONDETERMINISTIC IDEMPOTENCE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The Three Pillars of Persistence:
 * 1. Agent Bead  — The agent's identity + assignment (who does what)
 * 2. Hook Bead   — The GUPP binding (work pinned to agent)
 * 3. Molecule Chain — The execution state (where in the workflow)
 *
 * If any pillar is intact, the work can be recovered.
 * Sessions are ephemeral cattle. Agents are persistent identities.
 */

export interface NDIPillar {
  name: 'agent_bead' | 'hook_bead' | 'molecule_chain';
  status: 'intact' | 'degraded' | 'lost';
  lastVerified: Date;
  location: string;  // Where this pillar is stored (git ref, db table, etc.)
  recoverable: boolean;
  recoveryMethod?: string;
}

export interface NDIState {
  agentId: string;
  beadId: string;
  moleculeId?: string;
  pillars: NDIPillar[];
  overallStatus: 'healthy' | 'degraded' | 'critical';
  idempotent: boolean;  // Can this work be safely retried?
  lastCheck: Date;
}

export function checkNDI(agentId: string, beadId: string, moleculeId?: string): NDIState {
  // In production, would check Git + DB + memory for each pillar
  const pillars: NDIPillar[] = [
    {
      name: 'agent_bead',
      status: 'intact',
      lastVerified: new Date(),
      location: `meow_workers WHERE id='${agentId}'`,
      recoverable: true,
      recoveryMethod: 'Query meow_workers table or rebuild from Git history',
    },
    {
      name: 'hook_bead',
      status: 'intact',
      lastVerified: new Date(),
      location: `meow_hooks WHERE bead_id='${beadId}'`,
      recoverable: true,
      recoveryMethod: 'Query meow_hooks table + gt seance to recover session context',
    },
    {
      name: 'molecule_chain',
      status: moleculeId ? 'intact' : 'degraded',
      lastVerified: new Date(),
      location: moleculeId ? `meow_molecules WHERE id='${moleculeId}'` : 'not started',
      recoverable: true,
      recoveryMethod: 'Re-cook formula from ICE9 source, resume from last completed step',
    },
  ];

  const degradedCount = pillars.filter(p => p.status !== 'intact').length;
  const overallStatus: NDIState['overallStatus'] =
    degradedCount === 0 ? 'healthy' :
    degradedCount <= 1 ? 'degraded' : 'critical';

  return {
    agentId,
    beadId,
    moleculeId,
    pillars,
    overallStatus,
    idempotent: pillars.some(p => p.status === 'intact'),
    lastCheck: new Date(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. BOND OPERATOR TABLE — MEOW Algebra
// ═══════════════════════════════════════════════════════════════════════════════

export interface BondOperation {
  operator: string;
  operandA: string;
  operandB: string;
  result: string;
  description: string;
  phase: string;         // Which MEOW phase this operates in
  reversible: boolean;
}

export const BOND_OPERATOR_TABLE: BondOperation[] = [
  // ICE9 → SOLID transitions
  {
    operator: 'cook',
    operandA: 'Formula (ICE9)',
    operandB: 'Variables',
    result: 'Protomolecule (SOLID)',
    description: 'Substitute variables into a frozen formula template, producing a reusable proto',
    phase: 'ice9 → solid',
    reversible: false,
  },
  // SOLID → LIQUID transitions
  {
    operator: 'pour',
    operandA: 'Protomolecule (SOLID)',
    operandB: 'Context (BU/Rig)',
    result: 'Molecule (LIQUID)',
    description: 'Activate a proto by injecting runtime context, creating a flowing workflow',
    phase: 'solid → liquid',
    reversible: false,
  },
  // SOLID → VAPOR transitions
  {
    operator: 'wisp',
    operandA: 'Protomolecule (SOLID)',
    operandB: 'TTL Config',
    result: 'Wisp (VAPOR)',
    description: 'Create an ephemeral in-memory workflow that auto-destructs after TTL',
    phase: 'solid → vapor',
    reversible: false,
  },
  // LIQUID → LIQUID transitions (self-loop)
  {
    operator: 'squash',
    operandA: 'Molecule (LIQUID)',
    operandB: 'Digest Template',
    result: 'Condensed Molecule (LIQUID)',
    description: 'Compress completed steps into a digest summary, keeping the molecule flowing',
    phase: 'liquid → liquid',
    reversible: false,
  },
  // VAPOR → nothing (destruction)
  {
    operator: 'burn',
    operandA: 'Wisp (VAPOR)',
    operandB: 'TTL Expiry',
    result: 'Artifacts Only',
    description: 'Destroy ephemeral wisp, preserving only output artifacts',
    phase: 'vapor → ∅',
    reversible: false,
  },
  // Compound operations
  {
    operator: 'compound',
    operandA: 'Formula A (ICE9)',
    operandB: 'Formula B (ICE9)',
    result: 'Compound Formula (ICE9)',
    description: 'Compose two formulas into a compound mega-formula',
    phase: 'ice9 → ice9',
    reversible: true,
  },
  {
    operator: 'synthesize',
    operandA: 'Molecule Results[]',
    operandB: 'Synthesis Template',
    result: 'Convoy Artifact',
    description: 'Merge results from parallel convoy legs into a single deliverable',
    phase: 'liquid → artifact',
    reversible: false,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 4. COMPOUND FORMULAS
// ═══════════════════════════════════════════════════════════════════════════════

export type CompoundStrategy = 'sequential' | 'parallel' | 'conditional' | 'fan-out';

export interface CompoundFormula {
  id: string;
  name: string;
  description: string;
  strategy: CompoundStrategy;
  subFormulas: Array<{
    formulaName: string;
    order: number;
    condition?: string;       // e.g. "prev.success == true"
    params?: Record<string, unknown>;
  }>;
  synthesisStep?: {
    type: 'merge-results' | 'pick-best' | 'aggregate' | 'custom';
    template?: string;
  };
}

export interface CompoundProto {
  id: string;
  compoundFormulaId: string;
  boundTemplates: string[];  // Pre-configured sub-formula names
  description: string;
  tags: string[];
}

/** Built-in compound formulas */
export const COMPOUND_FORMULAS: CompoundFormula[] = [
  {
    id: 'cf-full-release',
    name: 'Full Release Pipeline',
    description: 'Compound: Polecat Work → Witness Review → Beads Release',
    strategy: 'sequential',
    subFormulas: [
      { formulaName: 'mol-polecat-work', order: 1 },
      { formulaName: 'mol-patrol-witness', order: 2, condition: 'prev.success == true' },
      { formulaName: 'mol-beads-release', order: 3, condition: 'prev.success == true' },
    ],
    synthesisStep: { type: 'merge-results' },
  },
  {
    id: 'cf-multi-rig',
    name: 'Multi-Rig Deploy',
    description: 'Compound: Parallel work across multiple rigs with synthesis',
    strategy: 'fan-out',
    subFormulas: [
      { formulaName: 'mol-polecat-work', order: 1, params: { rig: 'gastown-app' } },
      { formulaName: 'mol-polecat-work', order: 1, params: { rig: 'gastown-backend' } },
      { formulaName: 'mol-beads-release', order: 2 },
    ],
    synthesisStep: { type: 'aggregate' },
  },
  {
    id: 'cf-patrol-suite',
    name: 'Full Patrol Suite',
    description: 'Compound: Run all 3 patrols in parallel',
    strategy: 'parallel',
    subFormulas: [
      { formulaName: 'mol-patrol-deacon', order: 1 },
      { formulaName: 'mol-patrol-witness', order: 1 },
      { formulaName: 'mol-patrol-refinery', order: 1 },
    ],
    synthesisStep: { type: 'merge-results' },
  },
];

export const COMPOUND_PROTOS: CompoundProto[] = [
  {
    id: 'cp-standard-release',
    compoundFormulaId: 'cf-full-release',
    boundTemplates: ['mol-polecat-work', 'mol-patrol-witness', 'mol-beads-release'],
    description: 'Pre-configured standard release pipeline',
    tags: ['release', 'standard'],
  },
  {
    id: 'cp-parallel-rigs',
    compoundFormulaId: 'cf-multi-rig',
    boundTemplates: ['mol-polecat-work', 'mol-beads-release'],
    description: 'Pre-configured multi-rig parallel deployment',
    tags: ['deploy', 'multi-rig'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Singletons
// ─────────────────────────────────────────────────────────────────────────────

let _guzzoline: GuzzolineEngine | null = null;

export function getGuzzolineEngine(): GuzzolineEngine {
  if (!_guzzoline) _guzzoline = new GuzzolineEngine();
  return _guzzoline;
}

log.info('Guzzoline + NDI + Bond Operators + Compound Formulas module loaded');
