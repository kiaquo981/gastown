/**
 * SKILL AUTO-SELECTION -- CG-015 (Stage 05 Wave 4)
 *
 * AI-powered skill selection for bead execution.
 * When a bead needs to be executed but has no explicit skill assigned,
 * this module analyzes the bead requirements and selects the best skill(s).
 *
 * Selection pipeline:
 *   1. Analyze bead description/requirements to determine needed capabilities
 *   2. Match against registered skill manifests (name, description, capabilities)
 *   3. Consider skill performance history (from skill-performance-ranking.ts)
 *   4. Handle multi-skill beads (ordered skill chain)
 *   5. Score each candidate with confidence level
 *   6. Learn from corrections (if selected skill fails, record and adjust)
 *
 * Fallback: keyword matching when Gemini unavailable.
 * Persists selection history to meow_skill_selections.
 *
 * Gas Town: "Pick the right wrench for the right bolt."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead, SkillManifest } from '../types';

const log = createLogger('skill-auto-selection');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCandidate {
  skillName: string;
  score: number;              // 0 - 100
  confidence: number;         // 0.0 - 1.0
  reasoning: string;
  matchType: 'ai' | 'keyword' | 'history' | 'exact';
}

export interface SkillSelectionResult {
  id: string;
  beadId: string;
  selectedSkills: string[];           // ordered chain for multi-skill beads
  candidates: SkillCandidate[];       // all evaluated candidates, ranked
  isMultiSkill: boolean;
  aiAssisted: boolean;
  selectionTimeMs: number;
  createdAt: Date;
}

export interface SkillSelectionFeedback {
  id: string;
  selectionId: string;
  beadId: string;
  selectedSkill: string;
  outcome: 'success' | 'failure' | 'partial';
  correctSkill?: string;             // if user corrected the selection
  feedbackNote?: string;
  recordedAt: Date;
}

export interface SkillProfile {
  skillName: string;
  description: string;
  keywords: string[];                 // extracted from manifest
  capabilities: string[];
  historicalSuccessRate: number;       // 0.0 - 1.0
  avgQuality: number;                 // 1-10
  selectionCount: number;
  correctionCount: number;            // times this was a wrong selection
}

export interface SelectionStats {
  totalSelections: number;
  aiAssistRate: number;               // how often AI was used
  accuracyRate: number;               // selections not corrected
  avgCandidatesPerSelection: number;
  avgSelectionTimeMs: number;
  topSkills: Array<{ name: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Common keyword → skill mappings for heuristic fallback */
const KEYWORD_SKILL_MAP: Record<string, string[]> = {
  // Code-related
  'code': ['code-gen', 'code-review', 'refactor'],
  'implement': ['code-gen', 'scaffold'],
  'refactor': ['refactor', 'code-review'],
  'test': ['test-gen', 'qa-check'],
  'debug': ['debug-analysis', 'code-review'],
  'review': ['code-review', 'qa-check'],
  'deploy': ['deploy', 'ci-cd'],
  'build': ['build', 'scaffold'],

  // Content-related
  'copy': ['copywriting', 'content-gen'],
  'write': ['content-gen', 'copywriting'],
  'translate': ['translate', 'localize'],
  'email': ['email-gen', 'copywriting'],
  'headline': ['headline-gen', 'copywriting'],

  // Data-related
  'analyze': ['data-analysis', 'report-gen'],
  'report': ['report-gen', 'data-analysis'],
  'scrape': ['web-scrape', 'data-extract'],
  'extract': ['data-extract', 'web-scrape'],
  'research': ['research', 'web-scrape'],

  // Ads-related
  'campaign': ['campaign-gen', 'meta-ads', 'google-ads'],
  'creative': ['creative-gen', 'image-gen'],
  'ad': ['ad-copy', 'campaign-gen'],
  'meta': ['meta-ads', 'campaign-gen'],
  'google': ['google-ads', 'campaign-gen'],

  // Ops-related
  'monitor': ['monitor', 'alert-check'],
  'alert': ['alert-check', 'monitor'],
  'schedule': ['scheduler', 'cron-task'],
  'notify': ['notification', 'alert-check'],
};

/** Minimum confidence to auto-select without human review */
const AUTO_SELECT_CONFIDENCE = 0.7;

/** Weight for performance history in scoring */
const HISTORY_WEIGHT = 0.3;

/** Weight for AI/keyword match in scoring */
const MATCH_WEIGHT = 0.5;

/** Weight for skill popularity (selection count) in scoring */
const POPULARITY_WEIGHT = 0.2;

// ---------------------------------------------------------------------------
// Gemini helper (with heuristic fallback)
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
                'You are a skill matching engine. Given a task description and available skills, select the best skill(s). Respond only with valid JSON.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in skill-auto-selection');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractKeywords(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter((w, i, arr) => arr.indexOf(w) === i); // deduplicate
}

function computeKeywordOverlap(aKeywords: string[], bKeywords: string[]): number {
  if (aKeywords.length === 0 || bKeywords.length === 0) return 0;
  const setB = new Set(bKeywords);
  const matches = aKeywords.filter(k => setB.has(k)).length;
  return matches / Math.max(aKeywords.length, bKeywords.length);
}

// ---------------------------------------------------------------------------
// SkillAutoSelector
// ---------------------------------------------------------------------------

export class SkillAutoSelector {
  private skillProfiles = new Map<string, SkillProfile>();
  private selectionHistory: SkillSelectionResult[] = [];
  private feedbackLog: SkillSelectionFeedback[] = [];
  private maxHistory = 5_000;
  private maxFeedback = 2_000;

  // --- Register or update a skill profile -----------------------------------

  registerSkill(manifest: SkillManifest): void {
    const keywords = [
      ...extractKeywords(manifest.name),
      ...extractKeywords(manifest.description),
      ...(manifest.tools?.provided ?? []).flatMap(t => extractKeywords(t.description)),
    ];

    const existing = this.skillProfiles.get(manifest.name);

    this.skillProfiles.set(manifest.name, {
      skillName: manifest.name,
      description: manifest.description,
      keywords,
      capabilities: manifest.requirements?.capabilities?.map(c => String(c)) ?? [],
      historicalSuccessRate: existing?.historicalSuccessRate ?? 0.5,
      avgQuality: existing?.avgQuality ?? 5,
      selectionCount: existing?.selectionCount ?? 0,
      correctionCount: existing?.correctionCount ?? 0,
    });

    log.info({ skill: manifest.name, keywords: keywords.length }, 'Skill registered for auto-selection');
  }

  // --- Select skills for a bead ---------------------------------------------

  async selectSkillsForBead(bead: Bead): Promise<SkillSelectionResult> {
    const startMs = Date.now();

    // If bead already has an explicit skill, validate it exists
    if (bead.skill && this.skillProfiles.has(bead.skill)) {
      const result: SkillSelectionResult = {
        id: uuidv4(),
        beadId: bead.id,
        selectedSkills: [bead.skill],
        candidates: [{
          skillName: bead.skill,
          score: 100,
          confidence: 1.0,
          reasoning: 'Explicitly assigned on bead',
          matchType: 'exact',
        }],
        isMultiSkill: false,
        aiAssisted: false,
        selectionTimeMs: Date.now() - startMs,
        createdAt: new Date(),
      };
      this.recordSelection(result);
      return result;
    }

    // Build description for matching
    const beadText = [
      bead.title,
      bead.description ?? '',
      bead.labels ? Object.values(bead.labels).join(' ') : '',
    ].join(' ');

    const beadKeywords = extractKeywords(beadText);

    // Collect candidates
    const candidates: SkillCandidate[] = [];

    // 1. Try AI-powered selection first
    let aiAssisted = false;
    const aiCandidates = await this.getAiCandidates(bead, beadText);
    if (aiCandidates && aiCandidates.length > 0) {
      aiAssisted = true;
      candidates.push(...aiCandidates);
    }

    // 2. Keyword-based matching (always run as supplement/fallback)
    const keywordCandidates = this.getKeywordCandidates(beadKeywords);
    for (const kc of keywordCandidates) {
      // Only add if not already present from AI
      if (!candidates.find(c => c.skillName === kc.skillName)) {
        candidates.push(kc);
      }
    }

    // 3. Direct keyword → skill map lookup
    const directCandidates = this.getDirectMapCandidates(beadKeywords);
    for (const dc of directCandidates) {
      if (!candidates.find(c => c.skillName === dc.skillName)) {
        candidates.push(dc);
      }
    }

    // 4. Boost scores with performance history
    for (const candidate of candidates) {
      const profile = this.skillProfiles.get(candidate.skillName);
      if (profile && profile.selectionCount > 5) {
        const historyBoost = profile.historicalSuccessRate * HISTORY_WEIGHT * 100;
        const popularityBoost =
          Math.min(profile.selectionCount, 100) / 100 * POPULARITY_WEIGHT * 100;
        // Penalize skills that have been corrected often
        const correctionPenalty =
          profile.correctionCount > 0
            ? (profile.correctionCount / profile.selectionCount) * 20
            : 0;

        candidate.score =
          candidate.score * MATCH_WEIGHT +
          historyBoost +
          popularityBoost -
          correctionPenalty;
        candidate.score = Math.max(0, Math.min(100, Math.round(candidate.score * 10) / 10));
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Determine if multi-skill is needed
    const isMultiSkill = this.detectMultiSkillNeed(bead, beadText);
    const selectedSkills: string[] = [];

    if (isMultiSkill && candidates.length >= 2) {
      // Select top 2-3 complementary skills
      selectedSkills.push(candidates[0].skillName);
      for (let i = 1; i < candidates.length && selectedSkills.length < 3; i++) {
        // Only add if it provides different capabilities
        const existing = this.skillProfiles.get(candidates[0].skillName);
        const next = this.skillProfiles.get(candidates[i].skillName);
        if (existing && next) {
          const overlap = computeKeywordOverlap(existing.keywords, next.keywords);
          if (overlap < 0.5) {
            selectedSkills.push(candidates[i].skillName);
          }
        } else {
          selectedSkills.push(candidates[i].skillName);
        }
      }
    } else if (candidates.length > 0) {
      selectedSkills.push(candidates[0].skillName);
    }

    const result: SkillSelectionResult = {
      id: uuidv4(),
      beadId: bead.id,
      selectedSkills,
      candidates: candidates.slice(0, 10), // top 10
      isMultiSkill,
      aiAssisted,
      selectionTimeMs: Date.now() - startMs,
      createdAt: new Date(),
    };

    await this.recordSelection(result);

    // Update selection counts
    for (const skill of selectedSkills) {
      const profile = this.skillProfiles.get(skill);
      if (profile) profile.selectionCount++;
    }

    broadcast('meow:cognitive', {
      type: 'skill_auto_selected',
      beadId: bead.id,
      selectedSkills,
      candidateCount: candidates.length,
      isMultiSkill,
      aiAssisted,
      topScore: candidates[0]?.score ?? 0,
      selectionTimeMs: result.selectionTimeMs,
    });

    log.info(
      {
        beadId: bead.id,
        selected: selectedSkills,
        candidateCount: candidates.length,
        aiAssisted,
        timeMs: result.selectionTimeMs,
      },
      'Skills auto-selected for bead',
    );

    return result;
  }

  // --- Record feedback on a selection ---------------------------------------

  async recordFeedback(
    selectionId: string,
    beadId: string,
    selectedSkill: string,
    outcome: 'success' | 'failure' | 'partial',
    correctSkill?: string,
    feedbackNote?: string,
  ): Promise<void> {
    const feedback: SkillSelectionFeedback = {
      id: uuidv4(),
      selectionId,
      beadId,
      selectedSkill,
      outcome,
      correctSkill,
      feedbackNote,
      recordedAt: new Date(),
    };

    this.feedbackLog.push(feedback);
    if (this.feedbackLog.length > this.maxFeedback) {
      this.feedbackLog = this.feedbackLog.slice(-this.maxFeedback);
    }

    // Update skill profiles with feedback
    const profile = this.skillProfiles.get(selectedSkill);
    if (profile) {
      // Recalculate success rate from recent feedback
      const recentFeedback = this.feedbackLog
        .filter(f => f.selectedSkill === selectedSkill)
        .slice(-50);
      const successes = recentFeedback.filter(f => f.outcome === 'success').length;
      profile.historicalSuccessRate =
        recentFeedback.length > 0
          ? Math.round((successes / recentFeedback.length) * 1000) / 1000
          : 0.5;

      if (outcome === 'failure' && correctSkill) {
        profile.correctionCount++;
      }
    }

    // If there was a correction, boost the correct skill's profile
    if (correctSkill && correctSkill !== selectedSkill) {
      const correctProfile = this.skillProfiles.get(correctSkill);
      if (correctProfile) {
        // Slight boost to success rate as a "vote of confidence"
        correctProfile.historicalSuccessRate = Math.min(
          1,
          correctProfile.historicalSuccessRate + 0.02,
        );
      }
    }

    await this.persistFeedback(feedback);

    broadcast('meow:cognitive', {
      type: 'skill_selection_feedback',
      selectionId,
      beadId,
      outcome,
      corrected: !!correctSkill,
    });
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): SelectionStats {
    const total = this.selectionHistory.length;
    if (total === 0) {
      return {
        totalSelections: 0,
        aiAssistRate: 0,
        accuracyRate: 0,
        avgCandidatesPerSelection: 0,
        avgSelectionTimeMs: 0,
        topSkills: [],
      };
    }

    const aiCount = this.selectionHistory.filter(s => s.aiAssisted).length;
    const totalCandidates = this.selectionHistory.reduce(
      (s, h) => s + h.candidates.length, 0,
    );
    const totalTimeMs = this.selectionHistory.reduce(
      (s, h) => s + h.selectionTimeMs, 0,
    );

    // Accuracy: selections where feedback was success / total feedback
    const withFeedback = this.feedbackLog.length;
    const successFeedback = this.feedbackLog.filter(f => f.outcome === 'success').length;
    const accuracyRate = withFeedback > 0 ? successFeedback / withFeedback : 1;

    // Top skills
    const skillCounts = new Map<string, number>();
    for (const sel of this.selectionHistory) {
      for (const skill of sel.selectedSkills) {
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
      }
    }
    const topSkills = Array.from(skillCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      totalSelections: total,
      aiAssistRate: Math.round((aiCount / total) * 1000) / 1000,
      accuracyRate: Math.round(accuracyRate * 1000) / 1000,
      avgCandidatesPerSelection: Math.round((totalCandidates / total) * 10) / 10,
      avgSelectionTimeMs: Math.round(totalTimeMs / total),
      topSkills,
    };
  }

  // --- Get selection history for a bead -------------------------------------

  getSelectionForBead(beadId: string): SkillSelectionResult | null {
    return this.selectionHistory.find(s => s.beadId === beadId) ?? null;
  }

  // --- Get all registered skill profiles ------------------------------------

  getSkillProfiles(): SkillProfile[] {
    return Array.from(this.skillProfiles.values());
  }

  // --- Load selection history from DB ---------------------------------------

  async loadHistory(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT id, bead_id, selected_skills, candidates, is_multi_skill,
                ai_assisted, selection_time_ms, created_at
         FROM meow_skill_selections
         WHERE created_at > NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT $1`,
        [this.maxHistory],
      );

      this.selectionHistory = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        beadId: r.bead_id as string,
        selectedSkills: this.parseJsonSafe(r.selected_skills, []),
        candidates: this.parseJsonSafe(r.candidates, []),
        isMultiSkill: r.is_multi_skill as boolean,
        aiAssisted: r.ai_assisted as boolean,
        selectionTimeMs: parseInt(r.selection_time_ms as string, 10) || 0,
        createdAt: new Date(r.created_at as string),
      }));

      log.info({ count: this.selectionHistory.length }, 'Loaded skill selections from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load skill selections from DB');
    }

    // Load feedback
    try {
      const pool2 = getPool();
      if (!pool2) return;

      const { rows } = await pool2.query(
        `SELECT id, selection_id, bead_id, selected_skill, outcome,
                correct_skill, feedback_note, recorded_at
         FROM meow_skill_selections
         WHERE outcome IS NOT NULL
           AND recorded_at > NOW() - INTERVAL '30 days'
         ORDER BY recorded_at DESC
         LIMIT $1`,
        [this.maxFeedback],
      );

      this.feedbackLog = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        selectionId: r.selection_id as string,
        beadId: r.bead_id as string,
        selectedSkill: r.selected_skill as string,
        outcome: r.outcome as 'success' | 'failure' | 'partial',
        correctSkill: r.correct_skill as string | undefined,
        feedbackNote: r.feedback_note as string | undefined,
        recordedAt: new Date(r.recorded_at as string),
      }));

      log.info({ count: this.feedbackLog.length }, 'Loaded skill selection feedback from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load skill selection feedback from DB');
    }
  }

  // --- Private: AI-powered candidate selection ------------------------------

  private async getAiCandidates(
    bead: Bead,
    beadText: string,
  ): Promise<SkillCandidate[] | null> {
    const availableSkills = Array.from(this.skillProfiles.entries())
      .map(([name, prof]) => `- ${name}: ${prof.description} [keywords: ${prof.keywords.slice(0, 8).join(', ')}]`)
      .join('\n');

    if (!availableSkills) return null;

    const prompt = `Select the best skill(s) for this task.

Task:
  Title: ${bead.title}
  Description: ${bead.description ?? 'N/A'}
  Priority: ${bead.priority}
  Labels: ${JSON.stringify(bead.labels ?? {})}

Available skills:
${availableSkills}

Rules:
- Select 1 skill for simple tasks, up to 3 for complex multi-step tasks
- Score each candidate 0-100 (confidence in match)
- Explain briefly why each is a good fit

Respond with JSON: {"candidates":[{"skillName":"...","score":0-100,"confidence":0.0-1.0,"reasoning":"..."}]}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        candidates: Array<{
          skillName: string;
          score: number;
          confidence: number;
          reasoning: string;
        }>;
      };

      if (!Array.isArray(parsed.candidates)) return null;

      return parsed.candidates
        .filter(c => this.skillProfiles.has(c.skillName))
        .map(c => ({
          skillName: c.skillName,
          score: Math.max(0, Math.min(100, c.score)),
          confidence: Math.max(0, Math.min(1, c.confidence)),
          reasoning: c.reasoning ?? 'AI selected',
          matchType: 'ai' as const,
        }));
    } catch {
      return null;
    }
  }

  // --- Private: Keyword-based candidate matching ----------------------------

  private getKeywordCandidates(beadKeywords: string[]): SkillCandidate[] {
    const candidates: SkillCandidate[] = [];

    for (const [skillName, profile] of this.skillProfiles) {
      const overlap = computeKeywordOverlap(beadKeywords, profile.keywords);
      if (overlap > 0.1) {
        const score = Math.round(overlap * 80);
        candidates.push({
          skillName,
          score,
          confidence: Math.min(0.8, overlap + 0.2),
          reasoning: `Keyword overlap: ${Math.round(overlap * 100)}%`,
          matchType: 'keyword',
        });
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  // --- Private: Direct map-based candidates ---------------------------------

  private getDirectMapCandidates(beadKeywords: string[]): SkillCandidate[] {
    const candidates: SkillCandidate[] = [];
    const seen = new Set<string>();

    for (const keyword of beadKeywords) {
      const mappedSkills = KEYWORD_SKILL_MAP[keyword];
      if (!mappedSkills) continue;

      for (let i = 0; i < mappedSkills.length; i++) {
        const skillName = mappedSkills[i];
        if (seen.has(skillName)) continue;
        seen.add(skillName);

        // Only include if registered
        if (!this.skillProfiles.has(skillName)) continue;

        candidates.push({
          skillName,
          score: 60 - i * 10, // first in list scores higher
          confidence: 0.5 - i * 0.1,
          reasoning: `Direct keyword mapping: "${keyword}" → ${skillName}`,
          matchType: 'keyword',
        });
      }
    }

    return candidates;
  }

  // --- Private: Detect if a bead needs multiple skills ----------------------

  private detectMultiSkillNeed(bead: Bead, beadText: string): boolean {
    const multiSignals = [
      /\band\b.*\bthen\b/i,
      /multi.?step/i,
      /pipeline/i,
      /chain/i,
      /first.*then/i,
      /workflow/i,
      /sequence/i,
    ];

    const signalCount = multiSignals.filter(rx => rx.test(beadText)).length;
    if (signalCount >= 1) return true;

    // Long descriptions with multiple capability domains
    const domains = new Set<string>();
    for (const keyword of extractKeywords(beadText)) {
      if (KEYWORD_SKILL_MAP[keyword]) {
        const skills = KEYWORD_SKILL_MAP[keyword];
        domains.add(skills[0]);
      }
    }
    if (domains.size >= 3) return true;

    return false;
  }

  // --- Private: record selection in memory + DB -----------------------------

  private async recordSelection(result: SkillSelectionResult): Promise<void> {
    this.selectionHistory.push(result);
    if (this.selectionHistory.length > this.maxHistory) {
      this.selectionHistory = this.selectionHistory.slice(-this.maxHistory);
    }

    await this.persistSelection(result);
  }

  // --- Private: JSON parse safety -------------------------------------------

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    return raw as T;
  }

  // --- Persistence: selection -----------------------------------------------

  private async persistSelection(result: SkillSelectionResult): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_skill_selections
          (id, bead_id, selected_skills, candidates, is_multi_skill,
           ai_assisted, selection_time_ms, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          result.id,
          result.beadId,
          JSON.stringify(result.selectedSkills),
          JSON.stringify(result.candidates),
          result.isMultiSkill,
          result.aiAssisted,
          result.selectionTimeMs,
          result.createdAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, beadId: result.beadId }, 'Failed to persist skill selection');
    }
  }

  // --- Persistence: feedback ------------------------------------------------

  private async persistFeedback(feedback: SkillSelectionFeedback): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_skill_selections
          (id, bead_id, selected_skills, candidates, is_multi_skill,
           ai_assisted, selection_time_ms, created_at,
           outcome, correct_skill, feedback_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING`,
        [
          feedback.id,
          feedback.beadId,
          JSON.stringify([feedback.selectedSkill]),
          JSON.stringify([]),
          false,
          false,
          0,
          feedback.recordedAt.toISOString(),
          feedback.outcome,
          feedback.correctSkill ?? null,
          feedback.feedbackNote ?? null,
        ],
      );
    } catch (err) {
      log.warn({ err, beadId: feedback.beadId }, 'Failed to persist skill selection feedback');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SkillAutoSelector | null = null;

export function getSkillAutoSelector(): SkillAutoSelector {
  if (!instance) {
    instance = new SkillAutoSelector();
  }
  return instance;
}
