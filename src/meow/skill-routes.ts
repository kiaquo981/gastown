/**
 * Skill Routes — EP-106
 *
 * API endpoints for skill management and execution.
 * Prefixed with /api/meow/skills/
 */

import { Router, Request, Response } from 'express';
import { createLogger } from '../lib/logger';
import {
  listSkills,
  getSkill,
  registerSkill,
  registerSkillFromTOML,
  unregisterSkill,
  canExecute,
  findSkillsByRuntime,
  skillCount,
} from './skill-registry';
import { executeSkill } from './skill-runtime';
import type { SkillRuntime } from './types';

const log = createLogger('skill-routes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/skills — list all registered skills
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/skills', (_req: Request, res: Response) => {
  const runtime = _req.query.runtime as string | undefined;
  const skills = runtime
    ? findSkillsByRuntime(runtime as SkillRuntime)
    : listSkills();

  res.json({
    count: skills.length,
    skills: skills.map(s => ({
      name: s.name,
      version: s.version,
      description: s.description,
      author: s.author,
      runtime: s.runtime,
      entry: s.entry,
      inputCount: Object.keys(s.inputs).length,
      outputCount: Object.keys(s.outputs).length,
      toolsProvided: s.tools.provided.length,
      toolsRequired: s.tools.required.length,
      minTier: s.requirements.minTier || null,
      capabilities: s.requirements.capabilities,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/skills/:name — get skill details
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/skills/:name', (req: Request, res: Response) => {
  const skill = getSkill(req.params.name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${req.params.name}" not found` });
  }
  res.json(skill);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/skills — register a skill (JSON manifest)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/skills', (req: Request, res: Response) => {
  try {
    const manifest = req.body;
    if (!manifest.name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!manifest.runtime) {
      return res.status(400).json({ error: 'runtime is required' });
    }
    registerSkill(manifest);
    res.status(201).json({ ok: true, name: manifest.name });
  } catch (err) {
    log.error({ err }, 'Register skill failed');
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/skills/toml — register a skill from TOML
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/skills/toml', (req: Request, res: Response) => {
  try {
    const { toml } = req.body as { toml?: string };
    if (!toml) {
      return res.status(400).json({ error: 'toml field is required' });
    }
    const manifest = registerSkillFromTOML(toml);
    res.status(201).json({ ok: true, name: manifest.name, manifest });
  } catch (err) {
    log.error({ err }, 'Register TOML skill failed');
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/meow/skills/:name — unregister a skill
// ─────────────────────────────────────────────────────────────────────────────

router.delete('/api/meow/skills/:name', (req: Request, res: Response) => {
  const removed = unregisterSkill(req.params.name);
  if (!removed) {
    return res.status(404).json({ error: `Skill "${req.params.name}" not found` });
  }
  res.json({ ok: true, name: req.params.name });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/meow/skills/:name/execute — execute a skill
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/meow/skills/:name/execute', async (req: Request, res: Response) => {
  try {
    const skill = getSkill(req.params.name);
    if (!skill) {
      return res.status(404).json({ error: `Skill "${req.params.name}" not found` });
    }

    const { inputs, moleculeId, stepId, stepName, vars, tier } = req.body as {
      inputs?: Record<string, unknown>;
      moleculeId?: string;
      stepId?: string;
      stepName?: string;
      vars?: Record<string, unknown>;
      tier?: 'S' | 'A' | 'B';
    };

    // Tier check
    if (tier && !canExecute(req.params.name, tier)) {
      return res.status(403).json({
        error: `Skill "${req.params.name}" requires tier ${skill.requirements.minTier}, got ${tier}`,
      });
    }

    const result = await executeSkill(req.params.name, {
      moleculeId: moleculeId || 'manual',
      stepId: stepId || 'manual',
      stepName: stepName || req.params.name,
      inputs: inputs || {},
      vars,
      tier,
    });

    res.json(result);
  } catch (err) {
    log.error({ err, skill: req.params.name }, 'Skill execution failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/skills/:name/check — check if tier can execute
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/skills/:name/check', (req: Request, res: Response) => {
  const tier = (req.query.tier || 'B') as 'S' | 'A' | 'B';
  const allowed = canExecute(req.params.name, tier);
  const skill = getSkill(req.params.name);

  res.json({
    name: req.params.name,
    tier,
    allowed,
    minTier: skill?.requirements.minTier || null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/meow/skills/stats — registry stats
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/meow/skills-stats', (_req: Request, res: Response) => {
  const all = listSkills();
  const byRuntime: Record<string, number> = {};
  const byTier: Record<string, number> = { none: 0, S: 0, A: 0, B: 0 };

  for (const s of all) {
    byRuntime[s.runtime] = (byRuntime[s.runtime] || 0) + 1;
    byTier[s.requirements.minTier || 'none']++;
  }

  res.json({
    total: all.length,
    byRuntime,
    byTier,
  });
});

export default router;
