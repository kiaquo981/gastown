/**
 * CG-003 — Mayor Convoy Composition (Stage 05 Wave 1)
 *
 * AI-powered convoy composition for Gas Town.
 * The Mayor analyzes beads and groups them into convoys for maximum efficiency.
 *
 * Grouping criteria:
 *   - Shared context: same product, same country, same campaign
 *   - Parallel potential: independent steps that can run simultaneously
 *   - Resource sharing: beads that use same skills/workers
 *   - Deadline clustering: beads with similar due dates
 *
 * Uses Gemini to analyze bead descriptions and find non-obvious groupings.
 * Falls back to heuristic grouping when Gemini is unavailable.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, Convoy, FeedEvent } from '../types';

const log = createLogger('mayor-convoy-composition');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConvoyProposal {
  name: string;
  beadIds: string[];
  rationale: string;
  estimatedDuration: string;
  estimatedCost: string;
  parallelism: number;
  groupingFactors: string[];
}

export interface ConvoyEvaluation {
  convoyId: string;
  beadIds: string[];
  coherenceScore: number;
  parallelismScore: number;
  efficiencyScore: number;
  overallScore: number;
  issues: string[];
  suggestions: string[];
}

export interface MergeSuggestion {
  shouldMerge: boolean;
  rationale: string;
  mergedName?: string;
  combinedBeadIds?: string[];
  estimatedGain: string;
}

interface BeadCluster {
  key: string;
  beads: Bead[];
  factors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const MAX_CONVOY_SIZE = 5;
const MIN_CONVOY_SIZE = 1;

const COMPOSITION_SYSTEM_PROMPT = `You are MOROS, the Mayor of Gas Town. You compose convoys by grouping related beads.

A convoy is a work bundle of related beads that should be executed together for efficiency.

Grouping criteria (prioritized):
1. Shared context: Same BU (business unit), same rig, same domain, overlapping labels.
2. Dependency chain: Beads that depend on each other should be in the same convoy.
3. Parallel potential: Independent beads in the same domain can run simultaneously.
4. Resource sharing: Beads requiring the same skill or worker tier.
5. Priority alignment: Group beads of similar priority so critical work isn't delayed.

Rules:
- Each convoy should have 1-5 beads. Never exceed 5.
- Prefer focused convoys (2-4 beads) over single-bead or max-size ones.
- Critical beads can be solo convoys if they don't relate to anything else.
- Every bead must appear in exactly one convoy.
- Name convoys descriptively (e.g., "meta-ads-campaign-setup", "shopify-product-import").

Output STRICT JSON:
{
  "convoys": [
    {
      "name": "descriptive-name",
      "beadIds": ["bd-xxxx", ...],
      "rationale": "Why these beads belong together",
      "estimatedDuration": "2h",
      "estimatedCost": "$0.05",
      "parallelism": 2,
      "groupingFactors": ["same_bu", "shared_skill", ...]
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Heuristic grouping
// ---------------------------------------------------------------------------

function clusterByContext(beads: Bead[]): BeadCluster[] {
  const clusters = new Map<string, BeadCluster>();

  for (const bead of beads) {
    // Build cluster key from shared context
    const keyParts: string[] = [];
    const factors: string[] = [];

    if (bead.bu) {
      keyParts.push(`bu:${bead.bu}`);
      factors.push('same_bu');
    }
    if (bead.rig) {
      keyParts.push(`rig:${bead.rig}`);
      factors.push('same_rig');
    }
    if (bead.skill) {
      keyParts.push(`skill:${bead.skill}`);
      factors.push('shared_skill');
    }

    const key = keyParts.length > 0 ? keyParts.join('|') : `solo:${bead.id}`;

    if (!clusters.has(key)) {
      clusters.set(key, { key, beads: [], factors });
    }
    clusters.get(key)!.beads.push(bead);
  }

  return Array.from(clusters.values());
}

function splitOversizedClusters(clusters: BeadCluster[]): BeadCluster[] {
  const result: BeadCluster[] = [];

  for (const cluster of clusters) {
    if (cluster.beads.length <= MAX_CONVOY_SIZE) {
      result.push(cluster);
      continue;
    }

    // Split by priority sub-groups
    const byPriority = new Map<string, Bead[]>();
    for (const bead of cluster.beads) {
      const group = byPriority.get(bead.priority) || [];
      group.push(bead);
      byPriority.set(bead.priority, group);
    }

    let chunkIdx = 0;
    for (const [priority, beads] of byPriority) {
      // Further split if still too large
      for (let i = 0; i < beads.length; i += MAX_CONVOY_SIZE) {
        const chunk = beads.slice(i, i + MAX_CONVOY_SIZE);
        result.push({
          key: `${cluster.key}:${priority}:${chunkIdx++}`,
          beads: chunk,
          factors: [...cluster.factors, 'priority_aligned'],
        });
      }
    }
  }

  return result;
}

function mergeDependencyChains(beads: Bead[], clusters: BeadCluster[]): BeadCluster[] {
  // Build bead-to-cluster index
  const beadToCluster = new Map<string, number>();
  clusters.forEach((c, idx) => {
    for (const bead of c.beads) {
      beadToCluster.set(bead.id, idx);
    }
  });

  // Check for dependency links across clusters
  const mergeTargets = new Map<number, Set<number>>();

  for (const bead of beads) {
    const srcCluster = beadToCluster.get(bead.id);
    if (srcCluster === undefined) continue;

    for (const dep of bead.dependencies) {
      if (dep.type !== 'blocks') continue;
      const targetCluster = beadToCluster.get(dep.targetId);
      if (targetCluster !== undefined && targetCluster !== srcCluster) {
        // Check if merging wouldn't exceed max size
        const combined = clusters[srcCluster].beads.length + clusters[targetCluster].beads.length;
        if (combined <= MAX_CONVOY_SIZE) {
          if (!mergeTargets.has(srcCluster)) mergeTargets.set(srcCluster, new Set());
          mergeTargets.get(srcCluster)!.add(targetCluster);
        }
      }
    }
  }

  // Perform merges
  const mergedIndices = new Set<number>();
  const result: BeadCluster[] = [];

  for (let i = 0; i < clusters.length; i++) {
    if (mergedIndices.has(i)) continue;

    const targets = mergeTargets.get(i);
    if (targets && targets.size > 0) {
      let merged = { ...clusters[i], beads: [...clusters[i].beads] };
      for (const target of targets) {
        if (mergedIndices.has(target)) continue;
        if (merged.beads.length + clusters[target].beads.length > MAX_CONVOY_SIZE) continue;
        merged.beads.push(...clusters[target].beads);
        merged.factors = [...new Set([...merged.factors, ...clusters[target].factors, 'dependency_chain'])];
        mergedIndices.add(target);
      }
      result.push(merged);
    } else {
      result.push(clusters[i]);
    }
  }

  return result;
}

function heuristicCompose(beads: Bead[]): ConvoyProposal[] {
  if (beads.length === 0) return [];

  let clusters = clusterByContext(beads);
  clusters = splitOversizedClusters(clusters);
  clusters = mergeDependencyChains(beads, clusters);

  return clusters.map((cluster, idx) => {
    const beadIds = cluster.beads.map(b => b.id);
    const hasDeps = cluster.beads.some(b => b.dependencies.length > 0);
    const parallelism = hasDeps ? 1 : Math.min(beadIds.length, 3);

    // Generate descriptive name
    const bu = cluster.beads[0]?.bu || 'general';
    const skill = cluster.beads[0]?.skill || 'mixed';
    const name = `${bu}-${skill}-${idx + 1}`.toLowerCase().replace(/\s+/g, '-');

    return {
      name,
      beadIds,
      rationale: `Grouped by: ${cluster.factors.join(', ')}`,
      estimatedDuration: `${beadIds.length * 15}m`,
      estimatedCost: `$${(beadIds.length * 0.02).toFixed(2)}`,
      parallelism,
      groupingFactors: cluster.factors,
    };
  });
}

// ---------------------------------------------------------------------------
// AI-powered convoy composition
// ---------------------------------------------------------------------------

async function aiCompose(beads: Bead[]): Promise<ConvoyProposal[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const beadSummaries = beads.map(b => ({
    id: b.id,
    title: b.title,
    description: b.description?.slice(0, 200),
    priority: b.priority,
    tier: b.tier,
    skill: b.skill,
    bu: b.bu,
    rig: b.rig,
    labels: b.labels,
    dependencies: b.dependencies.map(d => ({ target: d.targetId, type: d.type })),
  }));

  const prompt = [
    `## Beads to Group (${beads.length})`,
    '```json',
    JSON.stringify(beadSummaries, null, 2),
    '```',
    '',
    `Group these beads into convoys (1-5 beads each). Every bead must appear in exactly one convoy. Output strict JSON.`,
  ].join('\n');

  try {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gemini-2.0-flash',
        messages: [
          { role: 'system', content: COMPOSITION_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.warn({ status: response.status, body: errText.slice(0, 200) }, 'Gemini composition API error');
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    const parsed = JSON.parse(jsonMatch[1] || raw) as { convoys: ConvoyProposal[] };

    // Validate — every bead must be assigned, no duplicates
    const validBeadIds = new Set(beads.map(b => b.id));
    const assignedIds = new Set<string>();
    const validConvoys: ConvoyProposal[] = [];

    for (const convoy of (parsed.convoys || [])) {
      const validIds = (convoy.beadIds || []).filter(
        (id: string) => validBeadIds.has(id) && !assignedIds.has(id)
      );
      if (validIds.length === 0) continue;

      validIds.forEach((id: string) => assignedIds.add(id));
      validConvoys.push({
        ...convoy,
        beadIds: validIds,
        parallelism: convoy.parallelism || 1,
        groupingFactors: convoy.groupingFactors || ['ai_grouped'],
      });
    }

    // Put unassigned beads into a fallback convoy
    const unassigned = beads.filter(b => !assignedIds.has(b.id));
    if (unassigned.length > 0) {
      for (let i = 0; i < unassigned.length; i += MAX_CONVOY_SIZE) {
        const chunk = unassigned.slice(i, i + MAX_CONVOY_SIZE);
        validConvoys.push({
          name: `overflow-${i / MAX_CONVOY_SIZE + 1}`,
          beadIds: chunk.map(b => b.id),
          rationale: 'Not grouped by AI — placed in overflow convoy',
          estimatedDuration: `${chunk.length * 15}m`,
          estimatedCost: `$${(chunk.length * 0.02).toFixed(2)}`,
          parallelism: 1,
          groupingFactors: ['overflow'],
        });
      }
    }

    log.info({ convoyCount: validConvoys.length, beadCount: beads.length }, 'AI composition completed');
    return validConvoys;
  } catch (err) {
    log.error({ err }, 'Gemini composition call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convoy evaluation
// ---------------------------------------------------------------------------

function evaluateConvoyBeads(beads: Bead[]): ConvoyEvaluation {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Coherence: do beads share context?
  const bus = new Set(beads.map(b => b.bu).filter(Boolean));
  const rigs = new Set(beads.map(b => b.rig).filter(Boolean));
  const skills = new Set(beads.map(b => b.skill).filter(Boolean));

  let coherenceScore = 50;
  if (bus.size <= 1) coherenceScore += 20;
  else issues.push(`Multiple BUs: ${Array.from(bus).join(', ')}`);
  if (rigs.size <= 1) coherenceScore += 15;
  if (skills.size <= 2) coherenceScore += 15;
  else suggestions.push('Consider splitting by skill type');

  // Parallelism: can beads run in parallel?
  const depTargets = new Set<string>();
  const beadIds = new Set(beads.map(b => b.id));
  let internalDeps = 0;
  for (const bead of beads) {
    for (const dep of bead.dependencies) {
      if (dep.type === 'blocks' && beadIds.has(dep.targetId)) {
        internalDeps++;
        depTargets.add(dep.targetId);
      }
    }
  }
  const parallelismScore = internalDeps === 0 ? 100 : Math.max(20, 100 - internalDeps * 20);
  if (internalDeps > 0) {
    suggestions.push(`${internalDeps} internal dependencies — consider sequential ordering`);
  }

  // Efficiency: size and priority spread
  let efficiencyScore = 60;
  if (beads.length >= 2 && beads.length <= 4) efficiencyScore += 20;
  if (beads.length === 1) {
    efficiencyScore -= 10;
    suggestions.push('Single-bead convoy — consider merging with related convoy');
  }
  if (beads.length > MAX_CONVOY_SIZE) {
    efficiencyScore -= 20;
    issues.push(`Convoy exceeds max size (${beads.length} > ${MAX_CONVOY_SIZE})`);
  }

  const priorities = new Set(beads.map(b => b.priority));
  if (priorities.size <= 1) efficiencyScore += 10;
  else if (priorities.has('critical') && priorities.has('low')) {
    efficiencyScore -= 15;
    issues.push('Mixed critical and low priority — critical beads may be delayed');
  }

  const overallScore = Math.round(
    (coherenceScore * 0.4 + parallelismScore * 0.3 + efficiencyScore * 0.3)
  );

  return {
    convoyId: '',
    beadIds: beads.map(b => b.id),
    coherenceScore: Math.min(coherenceScore, 100),
    parallelismScore,
    efficiencyScore: Math.min(efficiencyScore, 100),
    overallScore: Math.min(overallScore, 100),
    issues,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// MayorConvoyComposer
// ---------------------------------------------------------------------------

export class MayorConvoyComposer {
  private lastProposals: ConvoyProposal[] = [];

  constructor() {
    log.info('MayorConvoyComposer initialized');
  }

  /** Compose optimal convoys from a list of beads */
  async composeConvoys(beads: Bead[]): Promise<ConvoyProposal[]> {
    if (beads.length === 0) return [];

    const startMs = Date.now();
    log.info({ beadCount: beads.length }, 'Composing convoys');

    // Try AI composition for larger sets
    let proposals: ConvoyProposal[] | null = null;
    if (beads.length > 3) {
      proposals = await aiCompose(beads);
    }

    // Fallback to heuristic
    if (!proposals) {
      proposals = heuristicCompose(beads);
    }

    this.lastProposals = proposals;

    const durationMs = Date.now() - startMs;
    const source = proposals.some(p => p.groupingFactors.includes('ai_grouped')) ? 'ai' : 'heuristic';

    broadcast('meow:feed', {
      id: uuidv4(),
      type: 'system_health',
      source: 'mayor-convoy-composition',
      message: `Composed ${proposals.length} convoys from ${beads.length} beads (${source}, ${durationMs}ms)`,
      severity: 'info',
      metadata: {
        convoyCount: proposals.length,
        beadCount: beads.length,
        source,
        durationMs,
      },
      timestamp: new Date(),
    });

    log.info({ convoyCount: proposals.length, source, durationMs }, 'Convoy composition complete');
    return proposals;
  }

  /** Evaluate a proposed convoy (by bead IDs) for quality */
  async evaluateConvoy(beadIds: string[]): Promise<ConvoyEvaluation> {
    // Fetch beads from DB
    const pool = getPool();
    let beads: Bead[] = [];

    if (pool) {
      try {
        const placeholders = beadIds.map((_, i) => `$${i + 1}`).join(', ');
        const { rows } = await pool.query(
          `SELECT * FROM meow_beads WHERE id IN (${placeholders})`,
          beadIds,
        );
        beads = rows.map(this.rowToBead);
      } catch (err) {
        log.warn({ err }, 'Failed to fetch beads for evaluation');
      }
    }

    if (beads.length === 0) {
      // Create stub beads for evaluation
      beads = beadIds.map(id => ({
        id,
        title: `Bead ${id}`,
        status: 'ready' as const,
        priority: 'medium' as const,
        executorType: 'agent' as const,
        labels: {},
        dependencies: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'system',
      }));
    }

    return evaluateConvoyBeads(beads);
  }

  /** Suggest whether two convoys should be merged */
  async suggestMerge(convoyABeadIds: string[], convoyBBeadIds: string[]): Promise<MergeSuggestion> {
    const combinedSize = convoyABeadIds.length + convoyBBeadIds.length;

    // Hard rule: cannot merge if combined exceeds max size
    if (combinedSize > MAX_CONVOY_SIZE) {
      return {
        shouldMerge: false,
        rationale: `Combined size (${combinedSize}) exceeds maximum convoy size (${MAX_CONVOY_SIZE})`,
        estimatedGain: '0%',
      };
    }

    // Evaluate each convoy separately and combined
    const evalA = await this.evaluateConvoy(convoyABeadIds);
    const evalB = await this.evaluateConvoy(convoyBBeadIds);
    const evalCombined = await this.evaluateConvoy([...convoyABeadIds, ...convoyBBeadIds]);

    const avgSeparate = (evalA.overallScore + evalB.overallScore) / 2;
    const gainPercent = Math.round(((evalCombined.overallScore - avgSeparate) / avgSeparate) * 100);
    const shouldMerge = evalCombined.overallScore > avgSeparate && evalCombined.issues.length <= (evalA.issues.length + evalB.issues.length);

    return {
      shouldMerge,
      rationale: shouldMerge
        ? `Merging improves overall score from ${avgSeparate} to ${evalCombined.overallScore} (+${gainPercent}%)`
        : `Merging would ${gainPercent >= 0 ? 'not significantly improve' : 'degrade'} convoy quality (score: ${evalCombined.overallScore} vs avg ${avgSeparate})`,
      mergedName: shouldMerge ? `merged-${Date.now().toString(36)}` : undefined,
      combinedBeadIds: shouldMerge ? [...convoyABeadIds, ...convoyBBeadIds] : undefined,
      estimatedGain: `${gainPercent >= 0 ? '+' : ''}${gainPercent}%`,
    };
  }

  /** Get last proposals (cached) */
  getLastProposals(): ConvoyProposal[] {
    return this.lastProposals;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rowToBead(row: Record<string, unknown>): Bead {
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string | undefined,
      status: row.status as Bead['status'],
      priority: row.priority as Bead['priority'],
      executorType: (row.executor_type as Bead['executorType']) || 'agent',
      bu: row.bu as string | undefined,
      rig: row.rig as string | undefined,
      skill: row.skill as string | undefined,
      formula: row.formula as string | undefined,
      tier: row.tier as Bead['tier'],
      labels: (row.labels as Record<string, string>) || {},
      assignee: row.assignee as string | undefined,
      moleculeId: row.molecule_id as string | undefined,
      convoyId: row.convoy_id as string | undefined,
      parentId: row.parent_id as string | undefined,
      dependencies: (row.dependencies as Bead['dependencies']) || [],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
      createdBy: row.created_by as string || 'system',
      completedBy: row.completed_by as string | undefined,
      artifacts: row.artifacts as string[] | undefined,
      prUrl: row.pr_url as string | undefined,
      worktree: row.worktree as string | undefined,
    };
  }
}

/** Singleton instance */
export const mayorConvoyComposer = new MayorConvoyComposer();
