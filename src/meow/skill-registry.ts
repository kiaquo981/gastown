/**
 * SkillRegistry — EP-101
 *
 * In-memory registry for skill manifests.
 * Skills define HOW a step executes: runtime, tools, inputs/outputs.
 * Loaded from TOML manifests or registered programmatically.
 */

import { createLogger } from '../lib/logger';
import { broadcast } from '../sse';
import type { SkillManifest, SkillRuntime, Capability } from './types';

const log = createLogger('skill-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Registry Storage
// ─────────────────────────────────────────────────────────────────────────────

const skills = new Map<string, SkillManifest>();

// ─────────────────────────────────────────────────────────────────────────────
// TOML Parser (lightweight — no external dep)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal TOML parser for skill manifests.
 * Supports: strings, numbers, booleans, arrays, tables, inline tables.
 */
export function parseSkillTOML(toml: string): SkillManifest {
  const lines = toml.split('\n');
  const root: Record<string, unknown> = {};
  let currentTable: Record<string, unknown> = root;
  let currentPath: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Table header [section] or [section.sub]
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const path = tableMatch[1].split('.');
      currentTable = root;
      currentPath = path;
      for (const key of path) {
        if (!currentTable[key]) currentTable[key] = {};
        currentTable = currentTable[key] as Record<string, unknown>;
      }
      continue;
    }

    // Array of tables [[section]]
    const arrayTableMatch = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayTableMatch) {
      const path = arrayTableMatch[1].split('.');
      currentPath = path;
      let target = root;
      for (let j = 0; j < path.length - 1; j++) {
        if (!target[path[j]]) target[path[j]] = {};
        target = target[path[j]] as Record<string, unknown>;
      }
      const lastKey = path[path.length - 1];
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      const newEntry: Record<string, unknown> = {};
      (target[lastKey] as unknown[]).push(newEntry);
      currentTable = newEntry;
      continue;
    }

    // Key = Value
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      currentTable[key] = parseTOMLValue(rawValue.trim());
    }
  }

  return tomlToManifest(root);
}

function parseTOMLValue(raw: string): unknown {
  // String (double quotes)
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  // String (single quotes)
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);
  // Array
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => parseTOMLValue(s.trim()));
  }
  // Inline table
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    // Simple key = value pairs
    const pairs = inner.split(',');
    for (const pair of pairs) {
      const m = pair.trim().match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
      if (m) obj[m[1]] = parseTOMLValue(m[2].trim());
    }
    return obj;
  }
  return raw;
}

function tomlToManifest(root: Record<string, unknown>): SkillManifest {
  const skill = (root.skill || root) as Record<string, unknown>;
  const tools = (skill.tools || root.tools || {}) as Record<string, unknown>;
  const requirements = (skill.requirements || root.requirements || {}) as Record<string, unknown>;
  const inputs = (skill.inputs || root.inputs || {}) as Record<string, unknown>;
  const outputs = (skill.outputs || root.outputs || {}) as Record<string, unknown>;

  const providedRaw = (tools.provided || []) as Array<Record<string, unknown>>;
  const provided = Array.isArray(providedRaw)
    ? providedRaw.map(t => ({
        name: String(t.name || ''),
        description: String(t.description || ''),
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }))
    : [];

  const requiredTools = (tools.required || []) as string[];

  const parsedInputs: SkillManifest['inputs'] = {};
  for (const [k, v] of Object.entries(inputs)) {
    const def = v as Record<string, unknown>;
    parsedInputs[k] = {
      type: String(def.type || 'string'),
      required: Boolean(def.required ?? true),
      description: String(def.description || ''),
    };
  }

  const parsedOutputs: SkillManifest['outputs'] = {};
  for (const [k, v] of Object.entries(outputs)) {
    const def = v as Record<string, unknown>;
    parsedOutputs[k] = {
      type: String(def.type || 'string'),
      description: String(def.description || ''),
    };
  }

  return {
    name: String(skill.name || ''),
    version: String(skill.version || '0.1.0'),
    description: String(skill.description || ''),
    author: String(skill.author || 'system'),
    runtime: (String(skill.runtime || 'prompt_only')) as SkillRuntime,
    entry: skill.entry ? String(skill.entry) : undefined,
    tools: { provided, required: requiredTools },
    requirements: {
      capabilities: (requirements.capabilities || []) as Capability[],
      minTier: requirements.minTier as 'S' | 'A' | 'B' | undefined,
    },
    inputs: parsedInputs,
    outputs: parsedOutputs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry API
// ─────────────────────────────────────────────────────────────────────────────

export function registerSkill(manifest: SkillManifest): void {
  if (!manifest.name) throw new Error('Skill name is required');
  if (!manifest.runtime) throw new Error('Skill runtime is required');

  skills.set(manifest.name, manifest);

  log.info({ name: manifest.name, runtime: manifest.runtime, version: manifest.version }, 'Skill registered');
  broadcast('meow:skills', { type: 'skill_registered', name: manifest.name });
}

export function registerSkillFromTOML(toml: string): SkillManifest {
  const manifest = parseSkillTOML(toml);
  registerSkill(manifest);
  return manifest;
}

export function unregisterSkill(name: string): boolean {
  const had = skills.delete(name);
  if (had) {
    log.info({ name }, 'Skill unregistered');
    broadcast('meow:skills', { type: 'skill_unregistered', name });
  }
  return had;
}

export function getSkill(name: string): SkillManifest | undefined {
  return skills.get(name);
}

export function listSkills(): SkillManifest[] {
  return Array.from(skills.values());
}

export function hasSkill(name: string): boolean {
  return skills.has(name);
}

export function skillCount(): number {
  return skills.size;
}

/** Find skills that match given capabilities */
export function findSkillsByCapability(cap: Capability): SkillManifest[] {
  return listSkills().filter(s =>
    s.requirements.capabilities.includes(cap)
  );
}

/** Find skills by runtime */
export function findSkillsByRuntime(runtime: SkillRuntime): SkillManifest[] {
  return listSkills().filter(s => s.runtime === runtime);
}

/** Validate that a skill can be executed by a given tier */
export function canExecute(skillName: string, tier: 'S' | 'A' | 'B'): boolean {
  const skill = skills.get(skillName);
  if (!skill) return false;
  if (!skill.requirements.minTier) return true;

  const tierOrder = { S: 3, A: 2, B: 1 };
  return tierOrder[tier] >= tierOrder[skill.requirements.minTier];
}
