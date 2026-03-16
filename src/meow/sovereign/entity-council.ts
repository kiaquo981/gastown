/**
 * ENTITY COUNCIL -- SG-004 (Stage 06 Wave 1)
 *
 * MAYOR + ATLAS + NOUS deliberate as a council for high-stakes decisions.
 *
 * Trigger conditions:
 *   - Budget > $1000
 *   - New market entry
 *   - Formula creation / major modification
 *   - Crisis response
 *   - Any decision flagged as high-risk by auto-approve-engine
 *
 * Each entity provides a distinct perspective:
 *   - MAYOR (Strategic): Business impact, resource allocation, priority alignment
 *   - ATLAS (Geopolitical): Market conditions, regulatory risk, competitive landscape
 *   - NOUS (Epistemic): Historical patterns, philosophical analysis, blind spots
 *
 * Deliberation format:
 *   1. Each entity states position independently
 *   2. Cross-examination (entities challenge each other)
 *   3. Synthesis of perspectives
 *   4. Final decision
 *
 * Voting outcomes:
 *   - Unanimous:  auto-approve
 *   - Majority:   proceed with caution (conditions attached)
 *   - Split:      defer to human
 *
 * Integration: hooks into auto-approve-engine.ts (Stage 05) for high-stakes override.
 *
 * DB table: meow_council_deliberations
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('entity-council');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CouncilTrigger =
  | 'high_budget'
  | 'new_market_entry'
  | 'formula_creation'
  | 'crisis_response'
  | 'high_risk_override'
  | 'manual_request';

export type CouncilOutcome =
  | 'approved'
  | 'approved_with_conditions'
  | 'deferred_to_human'
  | 'rejected';

export type EntityVote = 'approve' | 'conditional' | 'defer' | 'reject';

export type EntityName = 'mayor' | 'atlas' | 'nous';

export interface EntityPosition {
  entity: EntityName;
  vote: EntityVote;
  position: string;                   // the entity's stated position
  reasoning: string;                  // why they hold this position
  conditions?: string[];              // if conditional, what conditions
  riskAssessment: string;
  confidenceScore: number;            // 0.0 - 1.0
}

export interface CrossExamination {
  challenger: EntityName;
  challenged: EntityName;
  challenge: string;
  response: string;
}

export interface CouncilDeliberation {
  id: string;
  trigger: CouncilTrigger;
  subject: string;                    // what is being deliberated
  context: string;                    // full context for the decision
  positions: EntityPosition[];
  crossExaminations: CrossExamination[];
  synthesis: string;
  outcome: CouncilOutcome;
  conditions: string[];               // conditions attached to approval
  votes: Record<EntityName, EntityVote>;
  overallConfidence: number;          // 0.0 - 1.0
  transcript: string;                 // full deliberation transcript
  estimatedBudgetUsd: number;
  affectedMarkets: string[];
  relatedApprovalId?: string;         // link to auto-approve-engine request
  createdAt: Date;
  completedAt: Date | null;
  metadata?: Record<string, unknown>;
}

export interface CouncilConfig {
  budgetThresholdUsd: number;         // trigger when budget > this
  enableCrossExamination: boolean;
  maxCrossExaminations: number;
  autoApproveOnUnanimous: boolean;
  requireAllEntities: boolean;        // all 3 must respond
}

export interface CouncilStats {
  totalDeliberations: number;
  byOutcome: Record<string, number>;
  byTrigger: Record<string, number>;
  unanimousRate: number;
  avgConfidence: number;
  avgDeliberationTimeMs: number;
  deferredToHumanCount: number;
  rejectedCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTITY_SYSTEM_PROMPTS: Record<EntityName, string> = {
  mayor:
    'You are MAYOR, the supreme strategic entity. You evaluate decisions through the lens of business strategy, resource allocation, and long-term vision. You prioritize sustainable growth and risk management. You think in terms of directives, priorities, and tactical execution.',
  atlas:
    'You are ATLAS, the geopolitical intelligence entity. You evaluate decisions through the lens of market conditions, regulatory compliance, competitive landscape, and cultural context across multiple markets. You think in terms of opportunities, threats, and market readiness.',
  nous:
    'You are NOUS, the epistemic oracle entity. You evaluate decisions through the lens of knowledge patterns, historical analogies, philosophical frameworks, and intellectual rigor. You challenge assumptions and seek blind spots. You think in terms of first principles, inversions, and second-order effects.',
};

const DEFAULT_CONFIG: CouncilConfig = {
  budgetThresholdUsd: 1000,
  enableCrossExamination: true,
  maxCrossExaminations: 3,
  autoApproveOnUnanimous: true,
  requireAllEntities: true,
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGeminiAsEntity(
  entity: EntityName,
  prompt: string,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            { role: 'system', content: ENTITY_SYSTEM_PROMPTS[entity] },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1536,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err, entity }, 'Gemini call failed for entity');
    return null;
  }
}

async function callGeminiSynthesis(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content:
                'You are the Entity Council moderator. Synthesize the positions of MAYOR (strategy), ATLAS (geopolitics), and NOUS (epistemics) into a final decision. Be balanced and consider all perspectives. Respond ONLY with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini synthesis call failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// EntityCouncil
// ---------------------------------------------------------------------------

export class EntityCouncil {
  private deliberations: CouncilDeliberation[] = [];
  private config: CouncilConfig;
  private maxInMemory = 2_000;

  constructor(config?: Partial<CouncilConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --- Convene the Council ---------------------------------------------------

  async convene(
    trigger: CouncilTrigger,
    subject: string,
    context: string,
    options?: {
      estimatedBudgetUsd?: number;
      affectedMarkets?: string[];
      relatedApprovalId?: string;
    },
  ): Promise<CouncilDeliberation> {
    log.info({ trigger, subject: subject.slice(0, 100) }, 'Entity Council convened');
    const startMs = Date.now();

    broadcast('meow:sovereign', {
      type: 'council_convened',
      trigger,
      subject: subject.slice(0, 100),
    });

    // Phase 1: Each entity states their position
    const positions = await this.gatherPositions(subject, context, trigger);

    // Phase 2: Cross-examination
    let crossExaminations: CrossExamination[] = [];
    if (this.config.enableCrossExamination && positions.length >= 2) {
      crossExaminations = await this.conductCrossExamination(
        subject,
        positions,
      );
    }

    // Phase 3: Determine votes
    const votes: Record<EntityName, EntityVote> = {
      mayor: 'defer',
      atlas: 'defer',
      nous: 'defer',
    };
    for (const pos of positions) {
      votes[pos.entity] = pos.vote;
    }

    // Phase 4: Determine outcome
    const { outcome, conditions, synthesis } = await this.synthesizeDecision(
      subject,
      positions,
      crossExaminations,
      votes,
    );

    // Phase 5: Calculate confidence
    const overallConfidence = positions.length > 0
      ? Math.round(
          (positions.reduce((s, p) => s + p.confidenceScore, 0) / positions.length) * 1000,
        ) / 1000
      : 0;

    // Phase 6: Build transcript
    const transcript = this.buildTranscript(
      subject,
      positions,
      crossExaminations,
      synthesis,
      outcome,
      conditions,
    );

    const deliberation: CouncilDeliberation = {
      id: uuidv4(),
      trigger,
      subject,
      context: context.slice(0, 5000),
      positions,
      crossExaminations,
      synthesis,
      outcome,
      conditions,
      votes,
      overallConfidence,
      transcript,
      estimatedBudgetUsd: options?.estimatedBudgetUsd ?? 0,
      affectedMarkets: options?.affectedMarkets ?? [],
      relatedApprovalId: options?.relatedApprovalId,
      createdAt: new Date(),
      completedAt: new Date(),
    };

    // Store
    this.deliberations.push(deliberation);
    if (this.deliberations.length > this.maxInMemory) {
      this.deliberations = this.deliberations.slice(-this.maxInMemory);
    }

    await this.persistDeliberation(deliberation);

    const elapsedMs = Date.now() - startMs;

    broadcast('meow:sovereign', {
      type: 'council_decision',
      deliberationId: deliberation.id,
      trigger,
      subject: subject.slice(0, 100),
      outcome,
      votes,
      overallConfidence,
      conditionsCount: conditions.length,
      elapsedMs,
    });

    log.info(
      {
        id: deliberation.id,
        outcome,
        votes,
        overallConfidence,
        elapsedMs,
      },
      `Entity Council decision: ${outcome}`,
    );

    return deliberation;
  }

  // --- Check if Council is needed --------------------------------------------

  shouldConveneCouncil(
    estimatedBudgetUsd: number,
    isNewMarket: boolean,
    isFormulaCreation: boolean,
    isCrisis: boolean,
    approvalRiskCategory?: string,
  ): { needed: boolean; trigger: CouncilTrigger | null; reason: string } {
    if (isCrisis) {
      return { needed: true, trigger: 'crisis_response', reason: 'Crisis condition detected' };
    }

    if (estimatedBudgetUsd > this.config.budgetThresholdUsd) {
      return {
        needed: true,
        trigger: 'high_budget',
        reason: `Budget $${estimatedBudgetUsd} exceeds threshold $${this.config.budgetThresholdUsd}`,
      };
    }

    if (isNewMarket) {
      return { needed: true, trigger: 'new_market_entry', reason: 'New market entry decision' };
    }

    if (isFormulaCreation) {
      return { needed: true, trigger: 'formula_creation', reason: 'Formula creation requires deliberation' };
    }

    if (approvalRiskCategory === 'high' || approvalRiskCategory === 'critical') {
      return {
        needed: true,
        trigger: 'high_risk_override',
        reason: `Auto-approve flagged as ${approvalRiskCategory} risk`,
      };
    }

    return { needed: false, trigger: null, reason: 'No council trigger conditions met' };
  }

  // --- Getters ---------------------------------------------------------------

  getDeliberation(id: string): CouncilDeliberation | null {
    return this.deliberations.find(d => d.id === id) ?? null;
  }

  getRecentDeliberations(limit = 20): CouncilDeliberation[] {
    return this.deliberations.slice(-limit).reverse();
  }

  getDeliberationsByOutcome(outcome: CouncilOutcome): CouncilDeliberation[] {
    return this.deliberations.filter(d => d.outcome === outcome);
  }

  getDeliberationsByTrigger(trigger: CouncilTrigger): CouncilDeliberation[] {
    return this.deliberations.filter(d => d.trigger === trigger);
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): CouncilStats {
    const total = this.deliberations.length;
    if (total === 0) {
      return {
        totalDeliberations: 0,
        byOutcome: {},
        byTrigger: {},
        unanimousRate: 0,
        avgConfidence: 0,
        avgDeliberationTimeMs: 0,
        deferredToHumanCount: 0,
        rejectedCount: 0,
      };
    }

    const byOutcome: Record<string, number> = {};
    const byTrigger: Record<string, number> = {};
    let unanimousCount = 0;
    let totalConfidence = 0;
    let totalTimeMs = 0;
    let deferredCount = 0;
    let rejectedCount = 0;

    for (const d of this.deliberations) {
      byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
      byTrigger[d.trigger] = (byTrigger[d.trigger] ?? 0) + 1;
      totalConfidence += d.overallConfidence;

      if (d.completedAt) {
        totalTimeMs += d.completedAt.getTime() - d.createdAt.getTime();
      }

      // Check unanimity
      const voteValues = Object.values(d.votes);
      const allSame = voteValues.every(v => v === voteValues[0]);
      if (allSame && voteValues[0] === 'approve') unanimousCount++;

      if (d.outcome === 'deferred_to_human') deferredCount++;
      if (d.outcome === 'rejected') rejectedCount++;
    }

    return {
      totalDeliberations: total,
      byOutcome,
      byTrigger,
      unanimousRate: Math.round((unanimousCount / total) * 1000) / 1000,
      avgConfidence: Math.round((totalConfidence / total) * 1000) / 1000,
      avgDeliberationTimeMs: Math.round(totalTimeMs / total),
      deferredToHumanCount: deferredCount,
      rejectedCount,
    };
  }

  // --- Update config ---------------------------------------------------------

  updateConfig(updates: Partial<CouncilConfig>): void {
    this.config = { ...this.config, ...updates };
    log.info({ config: this.config }, 'Entity Council config updated');
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(sinceDays = 30): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, trigger, subject, context, positions,
                cross_examinations, synthesis, outcome, conditions,
                votes, overall_confidence, transcript,
                estimated_budget_usd, affected_markets,
                related_approval_id, created_at, completed_at, metadata
         FROM meow_council_deliberations
         WHERE created_at > NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sinceDays, this.maxInMemory],
      );

      this.deliberations = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        trigger: r.trigger as CouncilTrigger,
        subject: (r.subject as string) ?? '',
        context: (r.context as string) ?? '',
        positions: this.parseJsonSafe(r.positions, []),
        crossExaminations: this.parseJsonSafe(r.cross_examinations, []),
        synthesis: (r.synthesis as string) ?? '',
        outcome: r.outcome as CouncilOutcome,
        conditions: this.parseJsonSafe(r.conditions, []),
        votes: this.parseJsonSafe(r.votes, { mayor: 'defer', atlas: 'defer', nous: 'defer' }),
        overallConfidence: parseFloat(String(r.overall_confidence ?? '0')),
        transcript: (r.transcript as string) ?? '',
        estimatedBudgetUsd: parseFloat(String(r.estimated_budget_usd ?? '0')),
        affectedMarkets: this.parseJsonSafe(r.affected_markets, []),
        relatedApprovalId: (r.related_approval_id as string) ?? undefined,
        createdAt: new Date(r.created_at as string),
        completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
        metadata: this.parseJsonSafe(r.metadata, {}),
      }));

      log.info({ count: this.deliberations.length }, 'Loaded council deliberations from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load council deliberations from DB');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Position Gathering
  // ---------------------------------------------------------------------------

  private async gatherPositions(
    subject: string,
    context: string,
    trigger: CouncilTrigger,
  ): Promise<EntityPosition[]> {
    const entities: EntityName[] = ['mayor', 'atlas', 'nous'];
    const positions: EntityPosition[] = [];

    const positionPrompt = (entity: EntityName) =>
      `The Entity Council has been convened for the following decision.

Trigger: ${trigger}
Subject: ${subject}
Context: ${context.slice(0, 2000)}

As ${entity.toUpperCase()}, state your position on this decision.

Respond with JSON:
{
  "vote": "approve|conditional|defer|reject",
  "position": "your position statement (1-2 sentences)",
  "reasoning": "why you hold this position (2-3 sentences)",
  "conditions": ["condition1", "condition2"],
  "riskAssessment": "brief risk assessment from your perspective",
  "confidenceScore": 0.0-1.0
}`;

    // Query all entities in parallel
    const results = await Promise.allSettled(
      entities.map(async (entity) => {
        const raw = await callGeminiAsEntity(entity, positionPrompt(entity));
        return { entity, raw };
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value.raw) {
        // Fallback heuristic position
        positions.push(
          this.generateHeuristicPosition(result.status === 'fulfilled' ? result.value.entity : entities[positions.length], trigger),
        );
        continue;
      }

      const { entity, raw } = result.value;
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          positions.push(this.generateHeuristicPosition(entity, trigger));
          continue;
        }

        const parsed = JSON.parse(match[0]) as {
          vote: string;
          position: string;
          reasoning: string;
          conditions: string[];
          riskAssessment: string;
          confidenceScore: number;
        };

        positions.push({
          entity,
          vote: this.validateVote(parsed.vote),
          position: (parsed.position ?? '').slice(0, 500),
          reasoning: (parsed.reasoning ?? '').slice(0, 1000),
          conditions: Array.isArray(parsed.conditions) ? parsed.conditions.slice(0, 5) : [],
          riskAssessment: (parsed.riskAssessment ?? '').slice(0, 500),
          confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore ?? 0.5)),
        });
      } catch (err) {
        log.warn({ err, entity }, 'Failed to parse entity position');
        positions.push(this.generateHeuristicPosition(entity, trigger));
      }
    }

    return positions;
  }

  private generateHeuristicPosition(
    entity: EntityName,
    trigger: CouncilTrigger,
  ): EntityPosition {
    const heuristics: Record<EntityName, Record<CouncilTrigger, EntityVote>> = {
      mayor: {
        high_budget: 'conditional',
        new_market_entry: 'conditional',
        formula_creation: 'approve',
        crisis_response: 'approve',
        high_risk_override: 'defer',
        manual_request: 'defer',
      },
      atlas: {
        high_budget: 'defer',
        new_market_entry: 'conditional',
        formula_creation: 'approve',
        crisis_response: 'conditional',
        high_risk_override: 'conditional',
        manual_request: 'defer',
      },
      nous: {
        high_budget: 'conditional',
        new_market_entry: 'defer',
        formula_creation: 'conditional',
        crisis_response: 'approve',
        high_risk_override: 'defer',
        manual_request: 'defer',
      },
    };

    const vote = heuristics[entity]?.[trigger] ?? 'defer';

    return {
      entity,
      vote,
      position: `${entity.toUpperCase()} recommends ${vote} based on ${trigger} trigger (heuristic fallback).`,
      reasoning: 'AI analysis unavailable. Using conservative heuristic based on trigger type and entity role.',
      conditions: vote === 'conditional' ? ['Review by human before proceeding'] : [],
      riskAssessment: `Heuristic risk assessment: ${trigger === 'crisis_response' ? 'high urgency' : 'standard caution'}`,
      confidenceScore: 0.3,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Cross-Examination
  // ---------------------------------------------------------------------------

  private async conductCrossExamination(
    subject: string,
    positions: EntityPosition[],
  ): Promise<CrossExamination[]> {
    const examinations: CrossExamination[] = [];

    // Each entity challenges the next in sequence
    const pairs: Array<[EntityName, EntityName]> = [];
    for (let i = 0; i < positions.length; i++) {
      const challenger = positions[i].entity;
      const challenged = positions[(i + 1) % positions.length].entity;
      if (challenger !== challenged) {
        pairs.push([challenger, challenged]);
      }
    }

    const limited = pairs.slice(0, this.config.maxCrossExaminations);

    for (const [challenger, challenged] of limited) {
      const challengedPos = positions.find(p => p.entity === challenged);
      if (!challengedPos) continue;

      const prompt = `You are ${challenger.toUpperCase()} in the Entity Council.

${challenged.toUpperCase()} stated: "${challengedPos.position}"
Their reasoning: "${challengedPos.reasoning}"

Subject: ${subject}

Challenge their position with a pointed question or counterargument.
Respond with JSON:
{
  "challenge": "your challenge to their position (1-2 sentences)",
  "expectedWeakness": "what flaw you see in their reasoning"
}`;

      const challengeRaw = await callGeminiAsEntity(challenger, prompt);

      let challenge = `${challenger.toUpperCase()} challenges: Is ${challenged.toUpperCase()}'s assessment too narrow?`;
      let response = `${challenged.toUpperCase()} maintains their position.`;

      if (challengeRaw) {
        try {
          const match = challengeRaw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]) as { challenge: string; expectedWeakness: string };
            challenge = (parsed.challenge ?? challenge).slice(0, 500);
          }
        } catch { /* use default */ }
      }

      // Get response from challenged entity
      const responsePrompt = `You are ${challenged.toUpperCase()} in the Entity Council.

Your position: "${challengedPos.position}"
${challenger.toUpperCase()} challenges: "${challenge}"

Defend or modify your position.
Respond with plain text (1-2 sentences).`;

      const responseRaw = await callGeminiAsEntity(challenged, responsePrompt);
      if (responseRaw) {
        response = responseRaw.slice(0, 500);
      }

      examinations.push({ challenger, challenged, challenge, response });
    }

    return examinations;
  }

  // ---------------------------------------------------------------------------
  // Private: Decision Synthesis
  // ---------------------------------------------------------------------------

  private async synthesizeDecision(
    subject: string,
    positions: EntityPosition[],
    crossExaminations: CrossExamination[],
    votes: Record<EntityName, EntityVote>,
  ): Promise<{ outcome: CouncilOutcome; conditions: string[]; synthesis: string }> {
    // Count votes
    const voteValues = Object.values(votes);
    const approveCount = voteValues.filter(v => v === 'approve').length;
    const rejectCount = voteValues.filter(v => v === 'reject').length;
    const deferCount = voteValues.filter(v => v === 'defer').length;
    const conditionalCount = voteValues.filter(v => v === 'conditional').length;

    // Determine outcome by voting rules
    let outcome: CouncilOutcome;
    if (approveCount === 3 && this.config.autoApproveOnUnanimous) {
      outcome = 'approved';
    } else if (rejectCount >= 2) {
      outcome = 'rejected';
    } else if (deferCount >= 2) {
      outcome = 'deferred_to_human';
    } else if (approveCount >= 2) {
      outcome = 'approved';
    } else if (conditionalCount >= 2 || (approveCount >= 1 && conditionalCount >= 1)) {
      outcome = 'approved_with_conditions';
    } else {
      outcome = 'deferred_to_human';
    }

    // Gather conditions from all conditional positions
    const allConditions: string[] = [];
    for (const pos of positions) {
      if (pos.conditions && pos.conditions.length > 0) {
        allConditions.push(...pos.conditions.map(c => `[${pos.entity.toUpperCase()}] ${c}`));
      }
    }

    // AI synthesis
    const synthesisPrompt = `Synthesize the Entity Council deliberation.

Subject: ${subject}

Positions:
${positions.map(p => `${p.entity.toUpperCase()} (${p.vote}): ${p.position}\n  Reasoning: ${p.reasoning}`).join('\n\n')}

Cross-examinations:
${crossExaminations.map(ce => `${ce.challenger.toUpperCase()} -> ${ce.challenged.toUpperCase()}: ${ce.challenge}\n  Response: ${ce.response}`).join('\n\n') || 'None conducted'}

Vote tally: Approve=${approveCount}, Conditional=${conditionalCount}, Defer=${deferCount}, Reject=${rejectCount}
Preliminary outcome: ${outcome}

Respond with JSON:
{
  "synthesis": "balanced synthesis of all perspectives (3-5 sentences)",
  "conditions": ["any additional conditions"],
  "outcomeAdjustment": null or "approved|approved_with_conditions|deferred_to_human|rejected"
}`;

    const raw = await callGeminiSynthesis(synthesisPrompt);
    let synthesis = this.buildHeuristicSynthesis(positions, outcome);

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            synthesis: string;
            conditions: string[];
            outcomeAdjustment: string | null;
          };
          synthesis = (parsed.synthesis ?? synthesis).slice(0, 2000);
          if (Array.isArray(parsed.conditions)) {
            allConditions.push(...parsed.conditions.map(c => `[SYNTHESIS] ${c}`));
          }
          // CRIT-03: Block AI from overriding democratic vote outcome
          if (parsed.outcomeAdjustment && this.isValidOutcome(parsed.outcomeAdjustment)) {
            if (parsed.outcomeAdjustment !== outcome) {
              log.warn(`[EntityCouncil] AI attempted to override voted outcome ${outcome} with ${parsed.outcomeAdjustment} — blocked`);
            }
            // Do NOT override: preserve democratic decision
          }
        }
      } catch { /* use heuristic synthesis */ }
    }

    return {
      outcome,
      conditions: [...new Set(allConditions)].slice(0, 10),
      synthesis,
    };
  }

  private buildHeuristicSynthesis(
    positions: EntityPosition[],
    outcome: CouncilOutcome,
  ): string {
    const parts: string[] = [];
    parts.push(`The Entity Council has reached a ${outcome.replace(/_/g, ' ')} decision.`);

    for (const pos of positions) {
      parts.push(`${pos.entity.toUpperCase()} voted ${pos.vote}: ${pos.position.slice(0, 100)}`);
    }

    if (outcome === 'deferred_to_human') {
      parts.push('Human review is required due to lack of consensus.');
    } else if (outcome === 'approved_with_conditions') {
      parts.push('Approval is granted with conditions that must be met before execution.');
    }

    return parts.join(' ');
  }

  // ---------------------------------------------------------------------------
  // Private: Transcript Builder
  // ---------------------------------------------------------------------------

  private buildTranscript(
    subject: string,
    positions: EntityPosition[],
    crossExaminations: CrossExamination[],
    synthesis: string,
    outcome: CouncilOutcome,
    conditions: string[],
  ): string {
    const lines: string[] = [];

    lines.push('=== ENTITY COUNCIL DELIBERATION TRANSCRIPT ===');
    lines.push(`Subject: ${subject}`);
    lines.push(`Date: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('--- PHASE 1: POSITION STATEMENTS ---');
    for (const pos of positions) {
      lines.push(`[${pos.entity.toUpperCase()}] Vote: ${pos.vote} (confidence: ${pos.confidenceScore.toFixed(2)})`);
      lines.push(`  Position: ${pos.position}`);
      lines.push(`  Reasoning: ${pos.reasoning}`);
      lines.push(`  Risk Assessment: ${pos.riskAssessment}`);
      if (pos.conditions && pos.conditions.length > 0) {
        lines.push(`  Conditions: ${pos.conditions.join('; ')}`);
      }
      lines.push('');
    }

    if (crossExaminations.length > 0) {
      lines.push('--- PHASE 2: CROSS-EXAMINATION ---');
      for (const ce of crossExaminations) {
        lines.push(`[${ce.challenger.toUpperCase()} -> ${ce.challenged.toUpperCase()}]`);
        lines.push(`  Challenge: ${ce.challenge}`);
        lines.push(`  Response: ${ce.response}`);
        lines.push('');
      }
    }

    lines.push('--- PHASE 3: SYNTHESIS ---');
    lines.push(synthesis);
    lines.push('');

    lines.push('--- DECISION ---');
    lines.push(`Outcome: ${outcome.toUpperCase().replace(/_/g, ' ')}`);
    if (conditions.length > 0) {
      lines.push('Conditions:');
      for (const c of conditions) {
        lines.push(`  - ${c}`);
      }
    }

    lines.push('');
    lines.push('=== END TRANSCRIPT ===');

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Private: Validation Helpers
  // ---------------------------------------------------------------------------

  private validateVote(raw: string): EntityVote {
    const valid: EntityVote[] = ['approve', 'conditional', 'defer', 'reject'];
    return valid.includes(raw as EntityVote) ? (raw as EntityVote) : 'defer';
  }

  private isValidOutcome(raw: string): boolean {
    const valid: CouncilOutcome[] = ['approved', 'approved_with_conditions', 'deferred_to_human', 'rejected'];
    return valid.includes(raw as CouncilOutcome);
  }

  // ---------------------------------------------------------------------------
  // Private: Persistence
  // ---------------------------------------------------------------------------

  private async persistDeliberation(d: CouncilDeliberation): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_council_deliberations
          (id, trigger, subject, context, positions,
           cross_examinations, synthesis, outcome, conditions,
           votes, overall_confidence, transcript,
           estimated_budget_usd, affected_markets,
           related_approval_id, created_at, completed_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id,
          d.trigger,
          d.subject.slice(0, 500),
          d.context.slice(0, 5000),
          JSON.stringify(d.positions),
          JSON.stringify(d.crossExaminations),
          d.synthesis.slice(0, 5000),
          d.outcome,
          JSON.stringify(d.conditions),
          JSON.stringify(d.votes),
          d.overallConfidence,
          d.transcript.slice(0, 20000),
          d.estimatedBudgetUsd,
          JSON.stringify(d.affectedMarkets),
          d.relatedApprovalId ?? null,
          d.createdAt.toISOString(),
          d.completedAt?.toISOString() ?? null,
          d.metadata ? JSON.stringify(d.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, deliberationId: d.id }, 'Failed to persist council deliberation');
    }
  }

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    if (typeof raw === 'object') return raw as T;
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: EntityCouncil | null = null;

export function getEntityCouncil(
  config?: Partial<CouncilConfig>,
): EntityCouncil {
  if (!instance) {
    instance = new EntityCouncil(config);
    log.info('EntityCouncil singleton created');
  }
  return instance;
}
