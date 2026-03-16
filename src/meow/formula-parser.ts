/**
 * MEOW Formula Parser — Stage 02
 *
 * Parses TOML formula files into the Formula interface.
 * Handles variable substitution, dependency validation, cycle detection (Kahn's),
 * and ready-step computation.
 */

import type { Formula, FormulaStep, FormulaVar, FormulaLeg, FormulaType } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight TOML Parser (handles the subset used by formulas)
// ─────────────────────────────────────────────────────────────────────────────

interface TOMLValue {
  [key: string]: string | number | boolean | string[] | TOMLValue | TOMLValue[];
}

function parseTOMLValue(raw: string): string | number | boolean | string[] {
  const trimmed = raw.trim();

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Array of strings: ["a", "b", "c"]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => {
      const st = s.trim();
      if ((st.startsWith('"') && st.endsWith('"')) || (st.startsWith("'") && st.endsWith("'"))) {
        return st.slice(1, -1);
      }
      return st;
    });
  }

  // Integer
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  // Float
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // Unquoted string
  return trimmed;
}

function parseTOML(content: string): TOMLValue {
  const result: TOMLValue = {};
  const lines = content.split('\n');

  let currentSection: string | null = null;
  let currentArraySection: string | null = null;
  let currentArrayItem: TOMLValue | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) continue;

    // Array of tables: [[section]]
    const arrayMatch = line.match(/^\[\[(\w+(?:\.\w+)*)\]\]$/);
    if (arrayMatch) {
      // Flush previous array item
      if (currentArraySection && currentArrayItem) {
        if (!result[currentArraySection]) {
          result[currentArraySection] = [] as TOMLValue[];
        }
        (result[currentArraySection] as TOMLValue[]).push(currentArrayItem);
      }
      currentArraySection = arrayMatch[1];
      currentArrayItem = {};
      currentSection = null;
      continue;
    }

    // Table: [section] or [section.subsection]
    const sectionMatch = line.match(/^\[(\w+(?:\.\w+)*)\]$/);
    if (sectionMatch) {
      // Flush previous array item
      if (currentArraySection && currentArrayItem) {
        if (!result[currentArraySection]) {
          result[currentArraySection] = [] as TOMLValue[];
        }
        (result[currentArraySection] as TOMLValue[]).push(currentArrayItem);
        currentArraySection = null;
        currentArrayItem = null;
      }
      currentSection = sectionMatch[1];
      // Create nested objects for dotted sections
      const parts = currentSection.split('.');
      let target = result;
      for (const part of parts) {
        if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) {
          target[part] = {};
        }
        target = target[part] as TOMLValue;
      }
      continue;
    }

    // Key = value
    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = parseTOMLValue(rawValue);

      if (currentArrayItem) {
        currentArrayItem[key] = value;
      } else if (currentSection) {
        const parts = currentSection.split('.');
        let target = result;
        for (const part of parts) {
          target = target[part] as TOMLValue;
        }
        target[key] = value;
      } else {
        result[key] = value;
      }
    }
  }

  // Flush last array item
  if (currentArraySection && currentArrayItem) {
    if (!result[currentArraySection]) {
      result[currentArraySection] = [] as TOMLValue[];
    }
    (result[currentArraySection] as TOMLValue[]).push(currentArrayItem);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formula Parsing
// ─────────────────────────────────────────────────────────────────────────────

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return val ? [val] : [];
  return [];
}

function toRecord(val: unknown): Record<string, string> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = String(v);
    }
    return result;
  }
  return {};
}

function parseFormulaStep(raw: TOMLValue): FormulaStep {
  return {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    description: raw.description ? String(raw.description) : undefined,
    skill: raw.skill ? String(raw.skill) : undefined,
    needs: toStringArray(raw.needs),
    type: (raw.type as 'polecat' | 'crew') || 'polecat',
    gate: raw.gate ? String(raw.gate) as FormulaStep['gate'] : undefined,
    timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    retries: typeof raw.retries === 'number' ? raw.retries : undefined,
    vars: raw.vars ? toRecord(raw.vars) : undefined,
  };
}

function detectFormulaType(toml: TOMLValue): FormulaType {
  if (toml.legs && Array.isArray(toml.legs) && (toml.legs as TOMLValue[]).length > 0) return 'convoy';
  if (toml.expansion_var || (toml.formula && typeof toml.formula === 'object' && (toml.formula as TOMLValue).expansion_var)) return 'expansion';
  if (toml.aspect || (toml.formula && typeof toml.formula === 'object' && (toml.formula as TOMLValue).aspect)) return 'aspect';
  return 'workflow';
}

function parseVarsSection(raw: unknown): Record<string, FormulaVar> {
  const result: Record<string, FormulaVar> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const v = val as Record<string, unknown>;
        result[key] = {
          description: String(v.description || ''),
          required: v.required === true,
          default: v.default !== undefined ? String(v.default) : undefined,
        };
      } else {
        // Simple key = "description" shorthand
        result[key] = {
          description: String(val || ''),
          required: false,
        };
      }
    }
  }
  return result;
}

/**
 * Parse a TOML formula string into a Formula object.
 */
export function parseFormula(tomlContent: string): Formula {
  const toml = parseTOML(tomlContent);

  // Top-level or nested under [formula]
  const meta = (toml.formula && typeof toml.formula === 'object' && !Array.isArray(toml.formula))
    ? toml.formula as TOMLValue
    : toml;

  const name = String(meta.name || 'unnamed');
  const description = String(meta.description || '');
  const version = typeof meta.version === 'number' ? meta.version : 1;

  // Parse vars
  const vars = parseVarsSection(toml.vars || meta.vars);

  // Parse steps
  const rawSteps = (toml.steps || meta.steps) as TOMLValue[] | undefined;
  const steps: FormulaStep[] = Array.isArray(rawSteps) ? rawSteps.map(parseFormulaStep) : [];

  // Parse legs (for convoy type)
  const rawLegs = (toml.legs || meta.legs) as TOMLValue[] | undefined;
  let legs: FormulaLeg[] | undefined;
  if (Array.isArray(rawLegs) && rawLegs.length > 0) {
    legs = rawLegs.map(rawLeg => ({
      id: String(rawLeg.id || ''),
      title: String(rawLeg.title || ''),
      steps: Array.isArray(rawLeg.steps) ? (rawLeg.steps as TOMLValue[]).map(parseFormulaStep) : [],
    }));
  }

  // Parse synthesis step
  let synthesis: FormulaStep | undefined;
  if (toml.synthesis && typeof toml.synthesis === 'object' && !Array.isArray(toml.synthesis)) {
    synthesis = parseFormulaStep(toml.synthesis as TOMLValue);
  }

  const type = (meta.type as FormulaType) || detectFormulaType(toml);

  return {
    name,
    description,
    version,
    type,
    vars,
    steps,
    legs,
    synthesis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a formula: check references, required fields, etc.
 */
export function validateFormula(formula: Formula): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!formula.name || formula.name === 'unnamed') {
    errors.push('Formula must have a name');
  }

  if (!formula.description) {
    errors.push('Formula must have a description');
  }

  const allSteps = getAllSteps(formula);

  if (allSteps.length === 0) {
    errors.push('Formula must have at least one step');
  }

  // Check for duplicate step IDs
  const stepIds = new Set<string>();
  for (const step of allSteps) {
    if (!step.id) {
      errors.push('Every step must have an id');
      continue;
    }
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step id: "${step.id}"`);
    }
    stepIds.add(step.id);
  }

  // Check that all 'needs' references point to existing steps
  for (const step of allSteps) {
    for (const needed of step.needs) {
      if (!stepIds.has(needed)) {
        errors.push(`Step "${step.id}" needs "${needed}" which does not exist`);
      }
    }
  }

  // Check for cycles
  const cyclePath = detectCycles(allSteps);
  if (cyclePath) {
    errors.push(`Dependency cycle detected: ${cyclePath.join(' → ')}`);
  }

  // Convoy-specific checks
  if (formula.type === 'convoy') {
    if (!formula.legs || formula.legs.length === 0) {
      errors.push('Convoy formula must have at least one leg');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle Detection (Kahn's Algorithm)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect dependency cycles using Kahn's algorithm (topological sort).
 * Returns null if no cycles, or the cycle path as string[] if a cycle exists.
 */
export function detectCycles(steps: FormulaStep[]): string[] | null {
  const stepMap = new Map<string, FormulaStep>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // step -> steps that depend on it

  for (const step of steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  // Build graph
  for (const step of steps) {
    for (const needed of step.needs) {
      if (stepMap.has(needed)) {
        adjacency.get(needed)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }
  }

  // Kahn's: start with zero in-degree nodes
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adjacency.get(current) || []) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // If we couldn't sort all nodes, there's a cycle
  if (sorted.length !== steps.length) {
    // Find nodes still with in-degree > 0 (they form the cycle)
    const cycleNodes = steps
      .filter(s => !sorted.includes(s.id))
      .map(s => s.id);

    // Trace one cycle path for the error message
    const cyclePath = traceCyclePath(cycleNodes, steps);
    return cyclePath;
  }

  return null;
}

/** Trace one cycle path through the remaining nodes for error reporting */
function traceCyclePath(cycleNodeIds: string[], steps: FormulaStep[]): string[] {
  if (cycleNodeIds.length === 0) return [];

  const stepMap = new Map(steps.map(s => [s.id, s]));
  const cycleSet = new Set(cycleNodeIds);
  const path: string[] = [];
  const visited = new Set<string>();

  let current = cycleNodeIds[0];
  while (!visited.has(current)) {
    visited.add(current);
    path.push(current);

    const step = stepMap.get(current);
    if (!step) break;

    const nextInCycle = step.needs.find(n => cycleSet.has(n) && !visited.has(n));
    if (nextInCycle) {
      current = nextInCycle;
    } else {
      // Close the cycle — find a need that's already in our path
      const closer = step.needs.find(n => path.includes(n));
      if (closer) {
        path.push(closer);
      }
      break;
    }
  }

  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ready Steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a formula and the set of completed step IDs, return which steps are now executable.
 * A step is ready when all its `needs` are in the completed set and it is not already completed.
 */
export function readySteps(formula: Formula, completedStepIds: string[]): FormulaStep[] {
  const completed = new Set(completedStepIds);
  const allSteps = getAllSteps(formula);

  return allSteps.filter(step => {
    if (completed.has(step.id)) return false;
    return step.needs.every(needed => completed.has(needed));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable Substitution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace all {{var_name}} placeholders in a formula with the provided values.
 * Returns a new Formula with substituted values (does not mutate the original).
 */
export function substituteVars(formula: Formula, vars: Record<string, string>): Formula {
  // Merge defaults from formula.vars into the provided vars
  const merged: Record<string, string> = {};
  for (const [key, def] of Object.entries(formula.vars)) {
    if (def.default !== undefined) {
      merged[key] = def.default;
    }
  }
  Object.assign(merged, vars);

  const replacer = (text: string): string => {
    return text.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
      return merged[varName] ?? `{{${varName}}}`;
    });
  };

  const substituteStep = (step: FormulaStep): FormulaStep => ({
    ...step,
    title: replacer(step.title),
    description: step.description ? replacer(step.description) : undefined,
    skill: step.skill ? replacer(step.skill) : undefined,
    vars: step.vars
      ? Object.fromEntries(Object.entries(step.vars).map(([k, v]) => [k, replacer(v)]))
      : undefined,
  });

  return {
    ...formula,
    name: replacer(formula.name),
    description: replacer(formula.description),
    vars: formula.vars, // Keep original var definitions
    steps: formula.steps.map(substituteStep),
    legs: formula.legs?.map(leg => ({
      ...leg,
      title: replacer(leg.title),
      steps: leg.steps.map(substituteStep),
    })),
    synthesis: formula.synthesis ? substituteStep(formula.synthesis) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Collect all steps from a formula (including legs and synthesis) */
function getAllSteps(formula: Formula): FormulaStep[] {
  const all: FormulaStep[] = [...formula.steps];

  if (formula.legs) {
    for (const leg of formula.legs) {
      all.push(...leg.steps);
    }
  }

  if (formula.synthesis) {
    all.push(formula.synthesis);
  }

  return all;
}
