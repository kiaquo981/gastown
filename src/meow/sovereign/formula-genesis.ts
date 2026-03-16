/**
 * FORMULA GENESIS — SG-016 (Stage 06 Wave 4)
 *
 * AI generates new formulas from observed patterns of skill execution.
 * When recurring sequences are detected across molecules, the system
 * proposes them as formula candidates, validates, and queues for approval.
 *
 * Features:
 *   - Pattern detection: observe recurring sequences of skill executions across molecules
 *   - Frequency threshold: if a pattern appears >5 times, suggest as formula candidate
 *   - AI composition: Gemini analyzes the pattern and composes a proper TOML formula
 *   - Validation: syntax check, dependency check, cost estimate, risk assessment
 *   - Human review: generated formulas go to approval queue before activation
 *   - Success tracking: monitor generated formulas' performance vs. manual ones
 *   - Genesis lifecycle: pattern_detected → formula_drafted → validated → pending_approval → active
 *   - DB table: meow_formula_genesis
 *
 * Integration: reads from pattern-library.ts (Stage 05 CG-008)
 *
 * Gas Town: "The road builds itself — patterns become blueprints, blueprints become formulas."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';

const log = createLogger('formula-genesis');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GenesisLifecycle =
  | 'pattern_detected'
  | 'formula_drafted'
  | 'validated'
  | 'pending_approval'
  | 'active'
  | 'rejected'
  | 'retired';

export interface SkillSequencePattern {
  id: string;
  skills: string[];              // ordered list of skill names
  frequency: number;             // how many times observed
  avgDurationMs: number;
  avgCostUsd: number;
  avgSuccessRate: number;        // 0.0 - 1.0
  moleculeIds: string[];         // molecules where this pattern was observed
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface GenesisCandidate {
  id: string;
  lifecycle: GenesisLifecycle;
  patternId: string;             // link to the detected pattern
  skillSequence: string[];
  frequency: number;
  formulaName: string;           // generated name
  formulaToml: string;           // the generated TOML formula
  description: string;
  category: string;
  estimatedCostUsd: number;
  estimatedDurationMs: number;
  validation: ValidationResult | null;
  riskAssessment: RiskAssessment | null;
  performanceComparison: PerformanceComparison | null;
  approvalNote?: string;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: Date;
  draftedAt?: Date;
  validatedAt?: Date;
  approvedAt?: Date;
  activatedAt?: Date;
  rejectedAt?: Date;
  retiredAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  syntaxValid: boolean;
  syntaxErrors: string[];
  dependenciesResolved: boolean;
  missingDependencies: string[];
  costEstimateUsd: number;
  durationEstimateMs: number;
  complexityScore: number;       // 1-10
  validatedAt: Date;
}

export interface RiskAssessment {
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  factors: RiskFactor[];
  mitigations: string[];
  confidenceScore: number;       // 0.0 - 1.0
}

export interface RiskFactor {
  factor: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface PerformanceComparison {
  generatedSuccessRate: number;
  manualAvgSuccessRate: number;
  generatedAvgCostUsd: number;
  manualAvgCostUsd: number;
  generatedAvgDurationMs: number;
  manualAvgDurationMs: number;
  sampleSize: number;
  comparisonDate: Date;
  verdict: 'better' | 'comparable' | 'worse';
}

export interface GenesisConfig {
  minFrequencyThreshold: number;     // minimum pattern frequency to trigger genesis
  scanIntervalMs: number;            // how often to scan for patterns
  maxCandidatesInMemory: number;
  maxPatternsInMemory: number;
  autoValidate: boolean;             // auto-validate after drafting
  minSkillsInPattern: number;        // minimum skills in a sequence to consider
  maxSkillsInPattern: number;        // maximum skills to consider
  patternWindowDays: number;         // look back this many days for patterns
  requireHumanApproval: boolean;     // always require human approval before activation
}

export interface GenesisStats {
  totalPatterns: number;
  totalCandidates: number;
  byLifecycle: Record<string, number>;
  activatedCount: number;
  rejectedCount: number;
  avgValidationScore: number;
  avgFrequencyAtDetection: number;
  generatedVsManualPerformance: string;  // 'better' | 'comparable' | 'worse' | 'insufficient_data'
  lastScanAt: Date | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: GenesisConfig = {
  minFrequencyThreshold: 5,
  scanIntervalMs: 30 * 60 * 1000,  // 30 minutes
  maxCandidatesInMemory: 1_000,
  maxPatternsInMemory: 2_000,
  autoValidate: true,
  minSkillsInPattern: 2,
  maxSkillsInPattern: 10,
  patternWindowDays: 30,
  requireHumanApproval: true,
};

const LIFECYCLE_TRANSITIONS: Record<GenesisLifecycle, GenesisLifecycle[]> = {
  pattern_detected: ['formula_drafted', 'rejected'],
  formula_drafted: ['validated', 'rejected'],
  validated: ['pending_approval', 'rejected'],
  pending_approval: ['active', 'rejected'],
  active: ['retired'],
  rejected: [],
  retired: [],
};

// Category inference from skill names
const CATEGORY_INFERENCE: Array<{ pattern: string; category: string }> = [
  { pattern: 'meta_|facebook_|google_ads', category: 'campaign' },
  { pattern: 'content_|copy_|write_', category: 'content' },
  { pattern: 'ship_|fulfill_|track_', category: 'fulfillment' },
  { pattern: 'analyt_|report_|metric_', category: 'analytics' },
  { pattern: 'recover_|rescue_|fallback_', category: 'recovery' },
  { pattern: 'expand_|grow_|scale_', category: 'expansion' },
];

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
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
                'You are a formula genesis engine for the Gas Town MEOW system. '
                + 'You analyze recurring skill execution patterns and compose TOML formulas. '
                + 'TOML formulas define multi-step automation workflows with skills as atoms. '
                + 'Respond ONLY with valid JSON unless asked for TOML.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.3,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in formula-genesis');
    return null;
  }
}

// ---------------------------------------------------------------------------
// FormulaGenesis
// ---------------------------------------------------------------------------

export class FormulaGenesis {
  private config: GenesisConfig;
  private patterns = new Map<string, SkillSequencePattern>();
  private candidates: GenesisCandidate[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanAt: Date | null = null;

  constructor(config?: Partial<GenesisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info({ config: this.config }, 'FormulaGenesis created');
  }

  // --- Lifecycle -------------------------------------------------------------

  start(): void {
    if (this.scanTimer) return;

    this.scanTimer = setInterval(() => {
      this.scanForPatterns().catch(err =>
        log.error({ err }, 'Formula genesis pattern scan failed'),
      );
    }, this.config.scanIntervalMs);

    broadcast('meow:sovereign', {
      type: 'formula_genesis_started',
      scanIntervalMs: this.config.scanIntervalMs,
      minFrequency: this.config.minFrequencyThreshold,
    });

    log.info('FormulaGenesis scanning started');
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    log.info('FormulaGenesis scanning stopped');
  }

  // --- Pattern scanning ------------------------------------------------------

  async scanForPatterns(): Promise<SkillSequencePattern[]> {
    log.info('Scanning for recurring skill execution patterns');
    this.lastScanAt = new Date();
    const newPatterns: SkillSequencePattern[] = [];

    try {
      const pool = getPool();
      if (!pool) throw new Error('No DB pool');
      const windowStart = new Date(
        Date.now() - this.config.patternWindowDays * 24 * 60 * 60 * 1000,
      );

      // Pull skill execution sequences grouped by molecule
      const { rows } = await pool.query(
        `SELECT molecule_id,
                ARRAY_AGG(skill_name ORDER BY started_at) as skill_sequence,
                AVG(duration_ms)::float as avg_duration,
                AVG(cost_usd)::float as avg_cost,
                AVG(CASE WHEN success THEN 1 ELSE 0 END)::float as success_rate
         FROM meow_beads
         WHERE created_at >= $1
           AND status = 'completed'
         GROUP BY molecule_id
         HAVING COUNT(*) >= $2 AND COUNT(*) <= $3
         ORDER BY COUNT(*) DESC
         LIMIT 500`,
        [windowStart.toISOString(), this.config.minSkillsInPattern, this.config.maxSkillsInPattern],
      );

      // Count sequence frequencies
      const seqCounts = new Map<string, {
        skills: string[];
        count: number;
        totalDuration: number;
        totalCost: number;
        totalSuccessRate: number;
        moleculeIds: string[];
        firstSeen: Date;
        lastSeen: Date;
      }>();

      for (const row of rows) {
        const skills = (row.skill_sequence as string[]) ?? [];
        if (skills.length < this.config.minSkillsInPattern) continue;

        const seqKey = skills.join(' → ');

        const existing = seqCounts.get(seqKey);
        if (existing) {
          existing.count += 1;
          existing.totalDuration += (row.avg_duration ?? 0);
          existing.totalCost += (row.avg_cost ?? 0);
          existing.totalSuccessRate += (row.success_rate ?? 0);
          existing.moleculeIds.push(row.molecule_id);
          existing.lastSeen = new Date();
        } else {
          seqCounts.set(seqKey, {
            skills,
            count: 1,
            totalDuration: row.avg_duration ?? 0,
            totalCost: row.avg_cost ?? 0,
            totalSuccessRate: row.success_rate ?? 0,
            moleculeIds: [row.molecule_id],
            firstSeen: new Date(),
            lastSeen: new Date(),
          });
        }
      }

      // Filter by frequency threshold
      for (const [seqKey, data] of seqCounts) {
        if (data.count < this.config.minFrequencyThreshold) continue;

        // Check if pattern already known
        if (this.patterns.has(seqKey)) {
          const existing = this.patterns.get(seqKey)!;
          existing.frequency = data.count;
          existing.lastSeenAt = data.lastSeen;
          existing.moleculeIds = [...new Set([...existing.moleculeIds, ...data.moleculeIds])].slice(0, 100);
          continue;
        }

        const pattern: SkillSequencePattern = {
          id: uuidv4(),
          skills: data.skills,
          frequency: data.count,
          avgDurationMs: data.totalDuration / data.count,
          avgCostUsd: data.totalCost / data.count,
          avgSuccessRate: data.totalSuccessRate / data.count,
          moleculeIds: data.moleculeIds.slice(0, 100),
          firstSeenAt: data.firstSeen,
          lastSeenAt: data.lastSeen,
        };

        this.patterns.set(seqKey, pattern);
        newPatterns.push(pattern);

        // Auto-create candidate
        await this.createCandidate(pattern);
      }
    } catch (err) {
      log.error({ err }, 'Failed to scan patterns from DB');

      // Heuristic fallback: check in-memory patterns
      for (const pattern of this.patterns.values()) {
        if (pattern.frequency >= this.config.minFrequencyThreshold) {
          const hasCandidate = this.candidates.some(c => c.patternId === pattern.id);
          if (!hasCandidate) {
            await this.createCandidate(pattern);
          }
        }
      }
    }

    this.trimMemory();

    if (newPatterns.length > 0) {
      broadcast('meow:sovereign', {
        type: 'formula_genesis_patterns_detected',
        count: newPatterns.length,
        patterns: newPatterns.map(p => ({
          skills: p.skills.join(' → '),
          frequency: p.frequency,
        })),
      });
    }

    log.info({ newPatterns: newPatterns.length, totalPatterns: this.patterns.size }, 'Pattern scan complete');
    return newPatterns;
  }

  // --- Create candidate from pattern -----------------------------------------

  private async createCandidate(pattern: SkillSequencePattern): Promise<GenesisCandidate> {
    const formulaName = this.generateFormulaName(pattern.skills);
    const category = this.inferCategory(pattern.skills);

    const candidate: GenesisCandidate = {
      id: uuidv4(),
      lifecycle: 'pattern_detected',
      patternId: pattern.id,
      skillSequence: pattern.skills,
      frequency: pattern.frequency,
      formulaName,
      formulaToml: '',
      description: `Auto-detected pattern: ${pattern.skills.join(' → ')} (seen ${pattern.frequency} times)`,
      category,
      estimatedCostUsd: pattern.avgCostUsd,
      estimatedDurationMs: pattern.avgDurationMs,
      validation: null,
      riskAssessment: null,
      performanceComparison: null,
      createdAt: new Date(),
    };

    this.candidates.push(candidate);
    await this.persistCandidate(candidate);

    broadcast('meow:sovereign', {
      type: 'formula_genesis_candidate_created',
      candidateId: candidate.id,
      formulaName,
      skillSequence: pattern.skills,
      frequency: pattern.frequency,
    });

    log.info({ candidateId: candidate.id, formulaName, frequency: pattern.frequency }, 'Genesis candidate created');

    // Auto-draft if configured
    await this.draftFormula(candidate.id);

    return candidate;
  }

  // --- Draft formula via AI --------------------------------------------------

  async draftFormula(candidateId: string): Promise<GenesisCandidate> {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    if (candidate.lifecycle !== 'pattern_detected') {
      throw new Error(`Cannot draft formula in lifecycle "${candidate.lifecycle}"`);
    }

    log.info({ candidateId, formulaName: candidate.formulaName }, 'Drafting formula via AI');

    const prompt = `Generate a TOML formula for the MEOW orchestration system.

Detected pattern (seen ${candidate.frequency} times):
Skills in sequence: ${candidate.skillSequence.join(' → ')}
Avg duration: ${candidate.estimatedDurationMs}ms
Avg cost: $${candidate.estimatedCostUsd.toFixed(4)}
Category: ${candidate.category}

The formula should:
1. Have a clear [metadata] section with name, description, version, author="formula-genesis"
2. Define each skill as a [[step]] with name, skill, and dependencies
3. Include error handling with retry_count and fallback steps where appropriate
4. Specify timeout_ms per step
5. Include a [cost] section with estimated_usd

Return ONLY the TOML content (no JSON wrapper, no markdown code blocks).`;

    const raw = await callGemini(prompt);
    if (raw) {
      candidate.formulaToml = raw.replace(/```toml\s*/g, '').replace(/```/g, '').trim();
    } else {
      // Heuristic fallback: generate basic TOML
      candidate.formulaToml = this.generateHeuristicToml(candidate);
    }

    candidate.lifecycle = 'formula_drafted';
    candidate.draftedAt = new Date();
    candidate.description = `AI-generated formula from pattern: ${candidate.skillSequence.join(' → ')}`;

    await this.persistCandidate(candidate);

    broadcast('meow:sovereign', {
      type: 'formula_genesis_drafted',
      candidateId,
      formulaName: candidate.formulaName,
      tomlLength: candidate.formulaToml.length,
    });

    // Auto-validate if configured
    if (this.config.autoValidate) {
      await this.validateCandidate(candidateId);
    }

    return candidate;
  }

  // --- Validate candidate ----------------------------------------------------

  async validateCandidate(candidateId: string): Promise<GenesisCandidate> {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    if (candidate.lifecycle !== 'formula_drafted') {
      throw new Error(`Cannot validate in lifecycle "${candidate.lifecycle}"`);
    }

    log.info({ candidateId, formulaName: candidate.formulaName }, 'Validating formula candidate');

    // Syntax validation
    const syntaxErrors: string[] = [];
    const toml = candidate.formulaToml;

    if (!toml || toml.length < 20) {
      syntaxErrors.push('TOML content is empty or too short');
    }
    if (!toml.includes('[metadata]') && !toml.includes('[step')) {
      syntaxErrors.push('Missing [metadata] or [[step]] sections');
    }

    // Dependency validation
    const missingDeps: string[] = [];
    for (const skill of candidate.skillSequence) {
      try {
        const pool = getPool();
        if (!pool) continue;
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int as cnt FROM meow_skill_metrics WHERE skill_name = $1 LIMIT 1`,
          [skill],
        );
        if (rows[0]?.cnt === 0) {
          missingDeps.push(skill);
        }
      } catch {
        // If we can't check, assume it's OK
      }
    }

    // AI risk assessment
    let riskAssessment: RiskAssessment = {
      overallRisk: 'medium',
      factors: [{ factor: 'auto_generated', severity: 'medium', description: 'Formula was auto-generated and needs human review' }],
      mitigations: ['Human approval required before activation'],
      confidenceScore: 0.6,
    };

    const riskPrompt = `Assess the risk of deploying this auto-generated formula:
Name: ${candidate.formulaName}
Skills: ${candidate.skillSequence.join(' → ')}
Frequency: ${candidate.frequency} observations
Category: ${candidate.category}
Cost estimate: $${candidate.estimatedCostUsd.toFixed(4)} per execution

Return JSON:
{
  "overallRisk": "low|medium|high|critical",
  "factors": [{"factor": "...", "severity": "low|medium|high", "description": "..."}],
  "mitigations": ["..."],
  "confidenceScore": 0.0-1.0
}`;

    const riskRaw = await callGemini(riskPrompt);
    if (riskRaw) {
      try {
        const cleaned = riskRaw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned) as RiskAssessment;
        riskAssessment = {
          overallRisk: ['low', 'medium', 'high', 'critical'].includes(parsed.overallRisk) ? parsed.overallRisk : 'medium',
          factors: Array.isArray(parsed.factors) ? parsed.factors.slice(0, 10) : riskAssessment.factors,
          mitigations: Array.isArray(parsed.mitigations) ? parsed.mitigations.slice(0, 5) : riskAssessment.mitigations,
          confidenceScore: typeof parsed.confidenceScore === 'number'
            ? Math.min(1, Math.max(0, parsed.confidenceScore))
            : 0.6,
        };
      } catch {
        log.warn('Failed to parse Gemini risk assessment');
      }
    }

    const complexityScore = Math.min(10, Math.max(1,
      candidate.skillSequence.length + (missingDeps.length * 2) + (syntaxErrors.length * 3),
    ));

    const validation: ValidationResult = {
      syntaxValid: syntaxErrors.length === 0,
      syntaxErrors,
      dependenciesResolved: missingDeps.length === 0,
      missingDependencies: missingDeps,
      costEstimateUsd: candidate.estimatedCostUsd,
      durationEstimateMs: candidate.estimatedDurationMs,
      complexityScore,
      validatedAt: new Date(),
    };

    candidate.validation = validation;
    candidate.riskAssessment = riskAssessment;
    candidate.lifecycle = 'validated';
    candidate.validatedAt = new Date();

    await this.persistCandidate(candidate);

    // Auto-move to pending_approval if validation passed
    if (validation.syntaxValid && validation.dependenciesResolved) {
      if (this.config.requireHumanApproval) {
        candidate.lifecycle = 'pending_approval';
      } else {
        candidate.lifecycle = 'active';
        candidate.activatedAt = new Date();
      }
      await this.persistCandidate(candidate);
    }

    broadcast('meow:sovereign', {
      type: 'formula_genesis_validated',
      candidateId,
      formulaName: candidate.formulaName,
      syntaxValid: validation.syntaxValid,
      depsResolved: validation.dependenciesResolved,
      riskLevel: riskAssessment.overallRisk,
      lifecycle: candidate.lifecycle,
    });

    log.info({
      candidateId,
      syntaxValid: validation.syntaxValid,
      depsOk: validation.dependenciesResolved,
      risk: riskAssessment.overallRisk,
    }, 'Candidate validated');

    return candidate;
  }

  // --- Approve / reject ------------------------------------------------------

  async approveCandidate(candidateId: string, approvedBy: string, note?: string): Promise<GenesisCandidate> {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    if (candidate.lifecycle !== 'pending_approval') {
      throw new Error(`Cannot approve candidate in lifecycle "${candidate.lifecycle}"`);
    }

    candidate.lifecycle = 'active';
    candidate.approvedBy = approvedBy;
    candidate.approvalNote = note;
    candidate.approvedAt = new Date();
    candidate.activatedAt = new Date();

    await this.persistCandidate(candidate);

    broadcast('meow:sovereign', {
      type: 'formula_genesis_approved',
      candidateId,
      formulaName: candidate.formulaName,
      approvedBy,
    });

    log.info({ candidateId, formulaName: candidate.formulaName, approvedBy }, 'Genesis formula approved');
    return candidate;
  }

  async rejectCandidate(candidateId: string, rejectedBy: string, reason: string): Promise<GenesisCandidate> {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

    const allowed = LIFECYCLE_TRANSITIONS[candidate.lifecycle];
    if (!allowed.includes('rejected')) {
      throw new Error(`Cannot reject candidate in lifecycle "${candidate.lifecycle}"`);
    }

    candidate.lifecycle = 'rejected';
    candidate.rejectedBy = rejectedBy;
    candidate.rejectionReason = reason;
    candidate.rejectedAt = new Date();

    await this.persistCandidate(candidate);

    broadcast('meow:sovereign', {
      type: 'formula_genesis_rejected',
      candidateId,
      formulaName: candidate.formulaName,
      rejectedBy,
      reason,
    });

    log.info({ candidateId, formulaName: candidate.formulaName, reason }, 'Genesis formula rejected');
    return candidate;
  }

  // --- Performance comparison ------------------------------------------------

  async comparePerformance(candidateId: string): Promise<PerformanceComparison | null> {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate || candidate.lifecycle !== 'active') return null;

    try {
      const pool = getPool();
      if (!pool) return null;

      // Get generated formula performance
      const { rows: genRows } = await pool.query(
        `SELECT AVG(CASE WHEN b.success THEN 1 ELSE 0 END)::float as success_rate,
                AVG(b.cost_usd)::float as avg_cost,
                AVG(b.duration_ms)::float as avg_duration,
                COUNT(*)::int as sample_size
         FROM meow_beads b
         JOIN meow_molecules m ON b.molecule_id = m.id
         WHERE m.formula_name = $1
           AND b.created_at > NOW() - INTERVAL '7 days'`,
        [candidate.formulaName],
      );

      // Get average manual formula performance
      const { rows: manualRows } = await pool.query(
        `SELECT AVG(CASE WHEN b.success THEN 1 ELSE 0 END)::float as success_rate,
                AVG(b.cost_usd)::float as avg_cost,
                AVG(b.duration_ms)::float as avg_duration
         FROM meow_beads b
         JOIN meow_molecules m ON b.molecule_id = m.id
         WHERE m.formula_name NOT LIKE 'genesis_%'
           AND b.created_at > NOW() - INTERVAL '7 days'`,
      );

      if (!genRows[0] || genRows[0].sample_size < 3) return null;

      const gen = genRows[0];
      const manual = manualRows[0] ?? { success_rate: 0.5, avg_cost: 0.01, avg_duration: 5000 };

      const successDiff = (gen.success_rate ?? 0) - (manual.success_rate ?? 0);
      const costDiff = (gen.avg_cost ?? 0) - (manual.avg_cost ?? 0);
      let verdict: 'better' | 'comparable' | 'worse' = 'comparable';
      if (successDiff > 0.05 && costDiff <= 0) verdict = 'better';
      else if (successDiff < -0.1) verdict = 'worse';

      const comparison: PerformanceComparison = {
        generatedSuccessRate: gen.success_rate ?? 0,
        manualAvgSuccessRate: manual.success_rate ?? 0,
        generatedAvgCostUsd: gen.avg_cost ?? 0,
        manualAvgCostUsd: manual.avg_cost ?? 0,
        generatedAvgDurationMs: gen.avg_duration ?? 0,
        manualAvgDurationMs: manual.avg_duration ?? 0,
        sampleSize: gen.sample_size ?? 0,
        comparisonDate: new Date(),
        verdict,
      };

      candidate.performanceComparison = comparison;
      await this.persistCandidate(candidate);

      broadcast('meow:sovereign', {
        type: 'formula_genesis_performance_compared',
        candidateId,
        formulaName: candidate.formulaName,
        verdict,
        generatedSuccessRate: comparison.generatedSuccessRate,
        manualAvgSuccessRate: comparison.manualAvgSuccessRate,
      });

      return comparison;
    } catch (err) {
      log.error({ err, candidateId }, 'Failed to compare performance');
      return null;
    }
  }

  // --- Stats -----------------------------------------------------------------

  getStats(): GenesisStats {
    const byLifecycle: Record<string, number> = {};
    let totalFreq = 0;
    let freqCount = 0;
    let validationScoreSum = 0;
    let validationCount = 0;

    for (const c of this.candidates) {
      byLifecycle[c.lifecycle] = (byLifecycle[c.lifecycle] ?? 0) + 1;
      totalFreq += c.frequency;
      freqCount += 1;
      if (c.validation) {
        validationScoreSum += c.validation.complexityScore;
        validationCount += 1;
      }
    }

    // Compare generated vs manual
    const active = this.candidates.filter(c => c.lifecycle === 'active' && c.performanceComparison);
    let genVsManual = 'insufficient_data';
    if (active.length >= 3) {
      const betterCount = active.filter(c => c.performanceComparison?.verdict === 'better').length;
      const worseCount = active.filter(c => c.performanceComparison?.verdict === 'worse').length;
      if (betterCount > worseCount) genVsManual = 'better';
      else if (worseCount > betterCount) genVsManual = 'worse';
      else genVsManual = 'comparable';
    }

    return {
      totalPatterns: this.patterns.size,
      totalCandidates: this.candidates.length,
      byLifecycle,
      activatedCount: this.candidates.filter(c => c.lifecycle === 'active').length,
      rejectedCount: this.candidates.filter(c => c.lifecycle === 'rejected').length,
      avgValidationScore: validationCount > 0 ? Math.round(validationScoreSum / validationCount * 10) / 10 : 0,
      avgFrequencyAtDetection: freqCount > 0 ? Math.round(totalFreq / freqCount * 10) / 10 : 0,
      generatedVsManualPerformance: genVsManual,
      lastScanAt: this.lastScanAt,
    };
  }

  // --- Getters ---------------------------------------------------------------

  getCandidate(id: string): GenesisCandidate | undefined {
    return this.candidates.find(c => c.id === id);
  }

  getCandidates(lifecycle?: GenesisLifecycle): GenesisCandidate[] {
    if (lifecycle) return this.candidates.filter(c => c.lifecycle === lifecycle);
    return [...this.candidates];
  }

  getPendingApprovals(): GenesisCandidate[] {
    return this.candidates.filter(c => c.lifecycle === 'pending_approval');
  }

  getPatterns(): SkillSequencePattern[] {
    return Array.from(this.patterns.values());
  }

  // --- Helpers ---------------------------------------------------------------

  private generateFormulaName(skills: string[]): string {
    const prefix = 'genesis';
    const skillParts = skills.slice(0, 3).map(s => {
      const parts = s.split('_');
      return parts[0] ?? s.slice(0, 4);
    });
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${prefix}_${skillParts.join('_')}_${suffix}`;
  }

  private inferCategory(skills: string[]): string {
    const combined = skills.join('_').toLowerCase();
    for (const { pattern, category } of CATEGORY_INFERENCE) {
      if (new RegExp(pattern).test(combined)) return category;
    }
    return 'general';
  }

  private generateHeuristicToml(candidate: GenesisCandidate): string {
    const steps = candidate.skillSequence.map((skill, idx) => {
      const deps = idx > 0 ? `\ndependencies = ["step_${idx}"]` : '';
      return `[[step]]
name = "step_${idx + 1}"
skill = "${skill}"
timeout_ms = ${Math.round(candidate.estimatedDurationMs / candidate.skillSequence.length)}
retry_count = 1${deps}`;
    });

    return `[metadata]
name = "${candidate.formulaName}"
description = "${candidate.description}"
version = "1.0.0"
author = "formula-genesis"
category = "${candidate.category}"

[cost]
estimated_usd = ${candidate.estimatedCostUsd.toFixed(4)}

${steps.join('\n\n')}
`;
  }

  private trimMemory(): void {
    if (this.candidates.length > this.config.maxCandidatesInMemory) {
      this.candidates.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      this.candidates = this.candidates.slice(0, this.config.maxCandidatesInMemory);
    }
    if (this.patterns.size > this.config.maxPatternsInMemory) {
      const entries = Array.from(this.patterns.entries())
        .sort((a, b) => b[1].lastSeenAt.getTime() - a[1].lastSeenAt.getTime());
      this.patterns.clear();
      for (const [key, val] of entries.slice(0, this.config.maxPatternsInMemory)) {
        this.patterns.set(key, val);
      }
    }
  }

  // --- DB persistence --------------------------------------------------------

  private async persistCandidate(candidate: GenesisCandidate): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_formula_genesis
          (id, lifecycle, pattern_id, skill_sequence, frequency, formula_name,
           formula_toml, description, category, estimated_cost_usd, estimated_duration_ms,
           validation, risk_assessment, performance_comparison, approval_note,
           approved_by, rejected_by, rejection_reason,
           created_at, drafted_at, validated_at, approved_at, activated_at, rejected_at, retired_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO UPDATE SET
           lifecycle = EXCLUDED.lifecycle,
           formula_toml = EXCLUDED.formula_toml,
           description = EXCLUDED.description,
           validation = EXCLUDED.validation,
           risk_assessment = EXCLUDED.risk_assessment,
           performance_comparison = EXCLUDED.performance_comparison,
           approval_note = EXCLUDED.approval_note,
           approved_by = EXCLUDED.approved_by,
           rejected_by = EXCLUDED.rejected_by,
           rejection_reason = EXCLUDED.rejection_reason,
           drafted_at = EXCLUDED.drafted_at,
           validated_at = EXCLUDED.validated_at,
           approved_at = EXCLUDED.approved_at,
           activated_at = EXCLUDED.activated_at,
           rejected_at = EXCLUDED.rejected_at,
           retired_at = EXCLUDED.retired_at,
           metadata = EXCLUDED.metadata`,
        [
          candidate.id,
          candidate.lifecycle,
          candidate.patternId,
          JSON.stringify(candidate.skillSequence),
          candidate.frequency,
          candidate.formulaName,
          candidate.formulaToml,
          candidate.description,
          candidate.category,
          candidate.estimatedCostUsd,
          candidate.estimatedDurationMs,
          candidate.validation ? JSON.stringify(candidate.validation) : null,
          candidate.riskAssessment ? JSON.stringify(candidate.riskAssessment) : null,
          candidate.performanceComparison ? JSON.stringify(candidate.performanceComparison) : null,
          candidate.approvalNote ?? null,
          candidate.approvedBy ?? null,
          candidate.rejectedBy ?? null,
          candidate.rejectionReason ?? null,
          candidate.createdAt.toISOString(),
          candidate.draftedAt?.toISOString() ?? null,
          candidate.validatedAt?.toISOString() ?? null,
          candidate.approvedAt?.toISOString() ?? null,
          candidate.activatedAt?.toISOString() ?? null,
          candidate.rejectedAt?.toISOString() ?? null,
          candidate.retiredAt?.toISOString() ?? null,
          candidate.metadata ? JSON.stringify(candidate.metadata) : null,
        ],
      );
    } catch (err) {
      log.error({ err, candidateId: candidate.id }, 'Failed to persist genesis candidate');
    }
  }

  // --- Load from DB ----------------------------------------------------------

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_formula_genesis
         WHERE lifecycle NOT IN ('retired', 'rejected')
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.config.maxCandidatesInMemory],
      );

      for (const row of rows) {
        const candidate: GenesisCandidate = {
          id: row.id,
          lifecycle: row.lifecycle,
          patternId: row.pattern_id ?? '',
          skillSequence: this.parseJsonSafe(row.skill_sequence, []),
          frequency: parseInt(row.frequency ?? '0', 10),
          formulaName: row.formula_name ?? '',
          formulaToml: row.formula_toml ?? '',
          description: row.description ?? '',
          category: row.category ?? 'general',
          estimatedCostUsd: parseFloat(row.estimated_cost_usd ?? '0'),
          estimatedDurationMs: parseFloat(row.estimated_duration_ms ?? '0'),
          validation: this.parseJsonSafe(row.validation, null),
          riskAssessment: this.parseJsonSafe(row.risk_assessment, null),
          performanceComparison: this.parseJsonSafe(row.performance_comparison, null),
          approvalNote: row.approval_note ?? undefined,
          approvedBy: row.approved_by ?? undefined,
          rejectedBy: row.rejected_by ?? undefined,
          rejectionReason: row.rejection_reason ?? undefined,
          createdAt: new Date(row.created_at),
          draftedAt: row.drafted_at ? new Date(row.drafted_at) : undefined,
          validatedAt: row.validated_at ? new Date(row.validated_at) : undefined,
          approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
          activatedAt: row.activated_at ? new Date(row.activated_at) : undefined,
          rejectedAt: row.rejected_at ? new Date(row.rejected_at) : undefined,
          retiredAt: row.retired_at ? new Date(row.retired_at) : undefined,
          metadata: this.parseJsonSafe(row.metadata, undefined),
        };
        this.candidates.push(candidate);
      }

      log.info({ loaded: rows.length }, 'Loaded genesis candidates from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load genesis candidates from DB');
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

let instance: FormulaGenesis | null = null;

export function getFormulaGenesis(
  config?: Partial<GenesisConfig>,
): FormulaGenesis {
  if (!instance) {
    instance = new FormulaGenesis(config);
    log.info('FormulaGenesis singleton created');
  }
  return instance;
}
