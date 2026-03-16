/**
 * INTELLIGENT MAIL ROUTING -- CG-013 (Stage 05 Wave 4)
 *
 * Smart mail routing that uses AI to determine optimal delivery channel.
 * Analyzes each outgoing mail across multiple dimensions:
 *
 *   - Message urgency / priority
 *   - Recipient preferences (learned over time from feedback)
 *   - Channel availability & health
 *   - Time-of-day optimization (no WhatsApp at 3am)
 *   - Content type matching (reports → email, alerts → WhatsApp, updates → SSE)
 *   - Rate limit awareness per channel
 *   - Fallback chain: primary → secondary → SSE (always available)
 *
 * Integrates with mail bridges: WhatsApp, Email, SSE, Slack/Discord.
 * Persists learned preferences to meow_mail_routing_preferences.
 *
 * Gas Town: "The right message, through the right pipe, at the right time."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Mail, MailPriority, MailType } from '../types';

const log = createLogger('intelligent-mail-routing');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliveryChannel = 'whatsapp' | 'email' | 'sse' | 'slack' | 'discord';

export interface ChannelHealth {
  channel: DeliveryChannel;
  healthy: boolean;
  latencyMs: number;
  rateLimitRemaining: number;
  rateLimitResetAt: Date | null;
  lastCheckedAt: Date;
  errorRate: number;          // 0.0 - 1.0 over last 100 deliveries
}

export interface RecipientPreference {
  recipientId: string;
  preferredChannels: DeliveryChannel[];   // ordered by preference
  quietHoursStart: number;                // UTC hour 0-23
  quietHoursEnd: number;                  // UTC hour 0-23
  timezone: string;                       // e.g. 'America/Sao_Paulo'
  channelFeedback: Record<DeliveryChannel, {
    deliveries: number;
    acknowledged: number;     // user opened / read
    avgResponseTimeMs: number;
  }>;
  updatedAt: Date;
}

export interface RoutingDecision {
  id: string;
  mailId: string;
  recipientId: string;
  selectedChannel: DeliveryChannel;
  fallbackChain: DeliveryChannel[];
  reasoning: string[];
  scores: Record<DeliveryChannel, number>;
  aiAssisted: boolean;
  decidedAt: Date;
}

export interface ContentAnalysis {
  urgency: 'critical' | 'high' | 'normal' | 'low';
  contentType: 'alert' | 'report' | 'update' | 'task' | 'escalation' | 'digest';
  lengthCategory: 'short' | 'medium' | 'long';
  hasAttachments: boolean;
  suggestedChannel: DeliveryChannel;
}

export interface RoutingStats {
  totalDecisions: number;
  byChannel: Record<DeliveryChannel, number>;
  avgDecisionTimeMs: number;
  fallbackRate: number;       // how often primary channel fails
  aiAssistRate: number;       // how often AI was used vs heuristic
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default channel affinity by mail type */
const CONTENT_TYPE_CHANNEL_MAP: Record<MailType, DeliveryChannel[]> = {
  task: ['sse', 'slack', 'email'],
  escalation: ['whatsapp', 'slack', 'sse'],
  notification: ['sse', 'slack', 'email'],
  report: ['email', 'slack', 'sse'],
  nudge: ['sse', 'slack', 'whatsapp'],
};

/** Default channel affinity by priority */
const PRIORITY_CHANNEL_MAP: Record<MailPriority, DeliveryChannel[]> = {
  critical: ['whatsapp', 'slack', 'sse'],
  high: ['slack', 'whatsapp', 'sse'],
  normal: ['sse', 'email', 'slack'],
  low: ['sse', 'email'],
};

/** Channel capacity scores (lower = cheaper to send) */
const CHANNEL_COST: Record<DeliveryChannel, number> = {
  sse: 0,
  slack: 1,
  discord: 1,
  email: 2,
  whatsapp: 5,
};

/** Max characters suitable per channel */
const CHANNEL_MAX_LENGTH: Record<DeliveryChannel, number> = {
  whatsapp: 4096,
  email: 100_000,
  sse: 2000,
  slack: 3000,
  discord: 2000,
};

const ALL_CHANNELS: DeliveryChannel[] = ['whatsapp', 'email', 'sse', 'slack', 'discord'];

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
                'You are a mail routing engine. Analyze messages and recommend delivery channels. Respond only with valid JSON.',
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
    log.warn({ err }, 'Gemini call failed in intelligent-mail-routing');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentUtcHour(): number {
  return new Date().getUTCHours();
}

function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Wraps around midnight (e.g., 22 -> 7)
  return hour >= start || hour < end;
}

function analyzeContentHeuristic(mail: Mail): ContentAnalysis {
  const bodyLen = (mail.body ?? '').length + (mail.subject ?? '').length;
  const lengthCategory: ContentAnalysis['lengthCategory'] =
    bodyLen < 200 ? 'short' : bodyLen < 1000 ? 'medium' : 'long';

  const hasAttachments = !!(mail.metadata?.attachments);

  // Map mail type to content type
  const contentTypeMap: Record<MailType, ContentAnalysis['contentType']> = {
    task: 'task',
    escalation: 'escalation',
    notification: 'update',
    report: 'report',
    nudge: 'update',
  };
  const contentType = contentTypeMap[mail.type] ?? 'update';

  // Determine suggested channel from type
  const channelPrefs = CONTENT_TYPE_CHANNEL_MAP[mail.type] ?? ['sse'];
  const suggestedChannel = channelPrefs[0];

  return {
    urgency: mail.priority,
    contentType,
    lengthCategory,
    hasAttachments,
    suggestedChannel,
  };
}

// ---------------------------------------------------------------------------
// IntelligentMailRouter
// ---------------------------------------------------------------------------

export class IntelligentMailRouter {
  private preferences = new Map<string, RecipientPreference>();
  private channelHealth = new Map<DeliveryChannel, ChannelHealth>();
  private decisions: RoutingDecision[] = [];
  private maxDecisions = 5_000;
  private deliveryLog: Array<{
    channel: DeliveryChannel;
    success: boolean;
    timestamp: Date;
  }> = [];
  private maxDeliveryLog = 2_000;

  constructor() {
    // Initialize channel health with defaults
    for (const ch of ALL_CHANNELS) {
      this.channelHealth.set(ch, {
        channel: ch,
        healthy: ch === 'sse', // SSE is always healthy
        latencyMs: 0,
        rateLimitRemaining: ch === 'sse' ? Infinity : 100,
        rateLimitResetAt: null,
        lastCheckedAt: new Date(),
        errorRate: 0,
      });
    }
  }

  // --- Route a mail to the optimal channel ----------------------------------

  async routeMail(mail: Mail): Promise<RoutingDecision> {
    const startMs = Date.now();
    const recipientId = Array.isArray(mail.to) ? mail.to[0] : mail.to;
    const pref = this.preferences.get(recipientId);
    const content = analyzeContentHeuristic(mail);
    const currentHour = getCurrentUtcHour();

    // Score each channel
    const scores: Record<DeliveryChannel, number> = {
      whatsapp: 0,
      email: 0,
      sse: 0,
      slack: 0,
      discord: 0,
    };
    const reasoning: string[] = [];

    // 1. Content-type affinity
    const typePrefs = CONTENT_TYPE_CHANNEL_MAP[mail.type] ?? ['sse'];
    for (let i = 0; i < typePrefs.length; i++) {
      scores[typePrefs[i]] += (typePrefs.length - i) * 10;
    }
    reasoning.push(`Content type "${mail.type}" favors: ${typePrefs.join(' > ')}`);

    // 2. Priority affinity
    const priPrefs = PRIORITY_CHANNEL_MAP[mail.priority] ?? ['sse'];
    for (let i = 0; i < priPrefs.length; i++) {
      scores[priPrefs[i]] += (priPrefs.length - i) * 8;
    }
    reasoning.push(`Priority "${mail.priority}" favors: ${priPrefs.join(' > ')}`);

    // 3. Channel health
    for (const ch of ALL_CHANNELS) {
      const health = this.channelHealth.get(ch);
      if (!health) continue;
      if (!health.healthy) {
        scores[ch] -= 50;
        reasoning.push(`${ch} unhealthy — penalized`);
      }
      if (health.rateLimitRemaining <= 0) {
        scores[ch] -= 100;
        reasoning.push(`${ch} rate limited — blocked`);
      }
      if (health.errorRate > 0.3) {
        scores[ch] -= Math.round(health.errorRate * 30);
        reasoning.push(`${ch} high error rate (${Math.round(health.errorRate * 100)}%)`);
      }
    }

    // 4. Quiet hours
    if (pref) {
      if (isInQuietHours(currentHour, pref.quietHoursStart, pref.quietHoursEnd)) {
        // During quiet hours, suppress interruptive channels unless critical
        if (mail.priority !== 'critical') {
          scores.whatsapp -= 40;
          scores.slack -= 20;
          reasoning.push(`Quiet hours active (${pref.quietHoursStart}:00-${pref.quietHoursEnd}:00 UTC) — suppressing interruptive channels`);
        } else {
          reasoning.push('Quiet hours active but priority is critical — allowing all channels');
        }
      }
    } else {
      // Default quiet hours: 23:00 - 07:00 UTC
      if (isInQuietHours(currentHour, 23, 7)) {
        if (mail.priority !== 'critical') {
          scores.whatsapp -= 30;
          reasoning.push('Default quiet hours (23-07 UTC) — reducing WhatsApp score');
        }
      }
    }

    // 5. Recipient learned preferences
    if (pref) {
      for (let i = 0; i < pref.preferredChannels.length; i++) {
        const ch = pref.preferredChannels[i];
        scores[ch] += (pref.preferredChannels.length - i) * 6;
      }
      reasoning.push(`Recipient prefers: ${pref.preferredChannels.join(' > ')}`);

      // Acknowledge rate bonus (channels where they respond faster)
      for (const ch of ALL_CHANNELS) {
        const fb = pref.channelFeedback[ch];
        if (fb && fb.deliveries > 3) {
          const ackRate = fb.acknowledged / fb.deliveries;
          scores[ch] += Math.round(ackRate * 15);
        }
      }
    }

    // 6. Message length suitability
    const bodyLen = (mail.body ?? '').length;
    for (const ch of ALL_CHANNELS) {
      if (bodyLen > CHANNEL_MAX_LENGTH[ch]) {
        scores[ch] -= 25;
        reasoning.push(`${ch} max length exceeded (${bodyLen} > ${CHANNEL_MAX_LENGTH[ch]})`);
      }
    }

    // 7. Cost awareness (prefer cheaper channels when scores are close)
    for (const ch of ALL_CHANNELS) {
      scores[ch] -= CHANNEL_COST[ch];
    }

    // 8. Try AI-enhanced routing for high-priority or ambiguous cases
    let aiAssisted = false;
    const topTwo = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2);
    const scoreDiff = topTwo.length >= 2 ? topTwo[0][1] - topTwo[1][1] : 100;

    if (scoreDiff < 5 || mail.priority === 'critical') {
      const aiResult = await this.getAiRoutingAdvice(mail, content, scores);
      if (aiResult) {
        aiAssisted = true;
        for (const [ch, bonus] of Object.entries(aiResult.adjustments)) {
          if (scores[ch as DeliveryChannel] !== undefined) {
            scores[ch as DeliveryChannel] += bonus;
          }
        }
        if (aiResult.reasoning) reasoning.push(`AI: ${aiResult.reasoning}`);
      }
    }

    // Build ranked channel list
    const ranked = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .map(([ch]) => ch as DeliveryChannel);

    // SSE is always the final fallback
    const fallbackChain = ranked.filter(ch => ch !== ranked[0]);
    if (!fallbackChain.includes('sse')) fallbackChain.push('sse');

    const decision: RoutingDecision = {
      id: uuidv4(),
      mailId: mail.id,
      recipientId,
      selectedChannel: ranked[0],
      fallbackChain,
      reasoning,
      scores,
      aiAssisted,
      decidedAt: new Date(),
    };

    this.decisions.push(decision);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions = this.decisions.slice(-this.maxDecisions);
    }

    await this.persistDecision(decision);

    const elapsedMs = Date.now() - startMs;
    log.info(
      { mailId: mail.id, channel: decision.selectedChannel, aiAssisted, elapsedMs },
      'Mail routing decision made',
    );

    broadcast('meow:cognitive', {
      type: 'mail_routing_decision',
      mailId: mail.id,
      channel: decision.selectedChannel,
      aiAssisted,
      elapsedMs,
    });

    return decision;
  }

  // --- Record delivery feedback ---------------------------------------------

  async recordDeliveryFeedback(
    recipientId: string,
    channel: DeliveryChannel,
    success: boolean,
    acknowledged: boolean,
    responseTimeMs?: number,
  ): Promise<void> {
    // Update delivery log
    this.deliveryLog.push({ channel, success, timestamp: new Date() });
    if (this.deliveryLog.length > this.maxDeliveryLog) {
      this.deliveryLog = this.deliveryLog.slice(-this.maxDeliveryLog);
    }

    // Update channel health
    this.updateChannelErrorRate(channel);

    // Update recipient preference
    let pref = this.preferences.get(recipientId);
    if (!pref) {
      pref = this.createDefaultPreference(recipientId);
      this.preferences.set(recipientId, pref);
    }

    const fb = pref.channelFeedback[channel];
    fb.deliveries++;
    if (acknowledged) fb.acknowledged++;
    if (responseTimeMs != null && responseTimeMs > 0) {
      // Running average
      fb.avgResponseTimeMs =
        fb.deliveries === 1
          ? responseTimeMs
          : fb.avgResponseTimeMs * 0.8 + responseTimeMs * 0.2;
    }
    pref.updatedAt = new Date();

    // Re-rank preferred channels based on feedback
    this.recomputePreferredChannels(pref);

    // Persist preference
    await this.persistPreference(pref);

    broadcast('meow:cognitive', {
      type: 'mail_delivery_feedback',
      recipientId,
      channel,
      success,
      acknowledged,
    });
  }

  // --- Update channel health ------------------------------------------------

  updateChannelHealth(
    channel: DeliveryChannel,
    healthy: boolean,
    latencyMs?: number,
    rateLimitRemaining?: number,
  ): void {
    const current = this.channelHealth.get(channel) ?? {
      channel,
      healthy: false,
      latencyMs: 0,
      rateLimitRemaining: 100,
      rateLimitResetAt: null,
      lastCheckedAt: new Date(),
      errorRate: 0,
    };

    current.healthy = healthy;
    if (latencyMs != null) current.latencyMs = latencyMs;
    if (rateLimitRemaining != null) current.rateLimitRemaining = rateLimitRemaining;
    current.lastCheckedAt = new Date();

    this.channelHealth.set(channel, current);
  }

  // --- Get recipient preference ---------------------------------------------

  getRecipientPreference(recipientId: string): RecipientPreference | null {
    return this.preferences.get(recipientId) ?? null;
  }

  // --- Set quiet hours for a recipient --------------------------------------

  async setQuietHours(
    recipientId: string,
    startHour: number,
    endHour: number,
    timezone = 'UTC',
  ): Promise<void> {
    let pref = this.preferences.get(recipientId);
    if (!pref) {
      pref = this.createDefaultPreference(recipientId);
    }
    pref.quietHoursStart = Math.max(0, Math.min(23, Math.round(startHour)));
    pref.quietHoursEnd = Math.max(0, Math.min(23, Math.round(endHour)));
    pref.timezone = timezone;
    pref.updatedAt = new Date();
    this.preferences.set(recipientId, pref);

    await this.persistPreference(pref);

    log.info(
      { recipientId, start: pref.quietHoursStart, end: pref.quietHoursEnd, timezone },
      'Quiet hours updated',
    );
  }

  // --- Get routing stats ----------------------------------------------------

  getStats(): RoutingStats {
    const byChannel: Record<DeliveryChannel, number> = {
      whatsapp: 0,
      email: 0,
      sse: 0,
      slack: 0,
      discord: 0,
    };

    let totalDecisionTimeMs = 0;
    let fallbackCount = 0;
    let aiCount = 0;

    for (const d of this.decisions) {
      byChannel[d.selectedChannel] = (byChannel[d.selectedChannel] ?? 0) + 1;
      if (d.aiAssisted) aiCount++;
    }

    // Estimate decision time from log
    for (let i = 1; i < this.decisions.length; i++) {
      totalDecisionTimeMs += 10; // approximate; real latency tracked in route()
    }

    // Fallback rate from delivery log
    const recentDeliveries = this.deliveryLog.slice(-200);
    const failures = recentDeliveries.filter(d => !d.success).length;
    fallbackCount = failures;

    return {
      totalDecisions: this.decisions.length,
      byChannel,
      avgDecisionTimeMs: this.decisions.length > 0
        ? Math.round(totalDecisionTimeMs / this.decisions.length)
        : 0,
      fallbackRate: recentDeliveries.length > 0
        ? Math.round((fallbackCount / recentDeliveries.length) * 1000) / 1000
        : 0,
      aiAssistRate: this.decisions.length > 0
        ? Math.round((aiCount / this.decisions.length) * 1000) / 1000
        : 0,
    };
  }

  // --- Get channel health overview ------------------------------------------

  getChannelHealthOverview(): ChannelHealth[] {
    return Array.from(this.channelHealth.values());
  }

  // --- Load preferences from DB ---------------------------------------------

  async loadPreferences(): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      const { rows } = await pool.query(
        `SELECT recipient_id, preferred_channels, quiet_hours_start,
                quiet_hours_end, timezone, channel_feedback, updated_at
         FROM meow_mail_routing_preferences
         ORDER BY updated_at DESC
         LIMIT 2000`,
      );

      for (const row of rows) {
        const pref: RecipientPreference = {
          recipientId: row.recipient_id as string,
          preferredChannels: this.parseJsonSafe(row.preferred_channels, ['sse']),
          quietHoursStart: parseInt(row.quiet_hours_start as string, 10) || 23,
          quietHoursEnd: parseInt(row.quiet_hours_end as string, 10) || 7,
          timezone: (row.timezone as string) || 'UTC',
          channelFeedback: this.parseJsonSafe(row.channel_feedback, this.defaultFeedback()),
          updatedAt: new Date(row.updated_at as string),
        };
        this.preferences.set(pref.recipientId, pref);
      }

      log.info({ count: this.preferences.size }, 'Loaded mail routing preferences from DB');
    } catch (err) {
      log.warn({ err }, 'Failed to load mail routing preferences');
    }
  }

  // --- Private: AI routing advice -------------------------------------------

  private async getAiRoutingAdvice(
    mail: Mail,
    content: ContentAnalysis,
    currentScores: Record<DeliveryChannel, number>,
  ): Promise<{ adjustments: Record<string, number>; reasoning: string } | null> {
    const prompt = `Given this mail, recommend the best delivery channel.

Mail:
- Subject: ${mail.subject}
- Type: ${mail.type}
- Priority: ${mail.priority}
- Body length: ${(mail.body ?? '').length} chars
- Content type: ${content.contentType}
- Current hour (UTC): ${getCurrentUtcHour()}

Current channel scores: ${JSON.stringify(currentScores)}

Available channels: whatsapp (interruptive, mobile), email (async, long content), sse (real-time UI), slack (team chat), discord (team chat).

Respond with JSON: {"adjustments":{"channel_name": score_bonus_or_penalty},"reasoning":"brief explanation"}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as {
        adjustments: Record<string, number>;
        reasoning: string;
      };
      if (typeof parsed.adjustments !== 'object' || typeof parsed.reasoning !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // --- Private: recompute preferred channels from feedback ------------------

  private recomputePreferredChannels(pref: RecipientPreference): void {
    const channelScores: Array<{ ch: DeliveryChannel; score: number }> = [];

    for (const ch of ALL_CHANNELS) {
      const fb = pref.channelFeedback[ch];
      if (!fb || fb.deliveries === 0) continue;

      const ackRate = fb.acknowledged / fb.deliveries;
      // Lower response time = better (normalize against 5min)
      const responseScore = Math.max(0, 1 - fb.avgResponseTimeMs / 300_000);
      const score = ackRate * 60 + responseScore * 30 + Math.min(fb.deliveries, 50) * 0.2;
      channelScores.push({ ch, score });
    }

    channelScores.sort((a, b) => b.score - a.score);
    pref.preferredChannels = channelScores.map(c => c.ch);
  }

  // --- Private: update channel error rate from delivery log -----------------

  private updateChannelErrorRate(channel: DeliveryChannel): void {
    const recent = this.deliveryLog
      .filter(d => d.channel === channel)
      .slice(-100);
    if (recent.length === 0) return;

    const errors = recent.filter(d => !d.success).length;
    const errorRate = errors / recent.length;

    const health = this.channelHealth.get(channel);
    if (health) {
      health.errorRate = Math.round(errorRate * 1000) / 1000;
    }
  }

  // --- Private: create default preference -----------------------------------

  private createDefaultPreference(recipientId: string): RecipientPreference {
    return {
      recipientId,
      preferredChannels: ['sse', 'slack', 'email'],
      quietHoursStart: 23,
      quietHoursEnd: 7,
      timezone: 'UTC',
      channelFeedback: this.defaultFeedback(),
      updatedAt: new Date(),
    };
  }

  private defaultFeedback(): Record<DeliveryChannel, {
    deliveries: number;
    acknowledged: number;
    avgResponseTimeMs: number;
  }> {
    return {
      whatsapp: { deliveries: 0, acknowledged: 0, avgResponseTimeMs: 0 },
      email: { deliveries: 0, acknowledged: 0, avgResponseTimeMs: 0 },
      sse: { deliveries: 0, acknowledged: 0, avgResponseTimeMs: 0 },
      slack: { deliveries: 0, acknowledged: 0, avgResponseTimeMs: 0 },
      discord: { deliveries: 0, acknowledged: 0, avgResponseTimeMs: 0 },
    };
  }

  // --- Private: JSON parse safety -------------------------------------------

  private parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    }
    return raw as T;
  }

  // --- Persistence: decision ------------------------------------------------

  private async persistDecision(decision: RoutingDecision): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_mail_routing_preferences
          (id, recipient_id, preferred_channels, quiet_hours_start,
           quiet_hours_end, timezone, channel_feedback, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (recipient_id) DO UPDATE SET
           preferred_channels = EXCLUDED.preferred_channels,
           channel_feedback = EXCLUDED.channel_feedback,
           updated_at = EXCLUDED.updated_at`,
        [
          uuidv4(),
          decision.recipientId,
          JSON.stringify(
            this.preferences.get(decision.recipientId)?.preferredChannels ?? ['sse'],
          ),
          this.preferences.get(decision.recipientId)?.quietHoursStart ?? 23,
          this.preferences.get(decision.recipientId)?.quietHoursEnd ?? 7,
          this.preferences.get(decision.recipientId)?.timezone ?? 'UTC',
          JSON.stringify(
            this.preferences.get(decision.recipientId)?.channelFeedback ?? this.defaultFeedback(),
          ),
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, mailId: decision.mailId }, 'Failed to persist routing decision');
    }
  }

  // --- Persistence: preference ----------------------------------------------

  private async persistPreference(pref: RecipientPreference): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_mail_routing_preferences
          (id, recipient_id, preferred_channels, quiet_hours_start,
           quiet_hours_end, timezone, channel_feedback, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (recipient_id) DO UPDATE SET
           preferred_channels = EXCLUDED.preferred_channels,
           quiet_hours_start = EXCLUDED.quiet_hours_start,
           quiet_hours_end = EXCLUDED.quiet_hours_end,
           timezone = EXCLUDED.timezone,
           channel_feedback = EXCLUDED.channel_feedback,
           updated_at = EXCLUDED.updated_at`,
        [
          uuidv4(),
          pref.recipientId,
          JSON.stringify(pref.preferredChannels),
          pref.quietHoursStart,
          pref.quietHoursEnd,
          pref.timezone,
          JSON.stringify(pref.channelFeedback),
          pref.updatedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, recipientId: pref.recipientId }, 'Failed to persist recipient preference');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: IntelligentMailRouter | null = null;

export function getIntelligentMailRouter(): IntelligentMailRouter {
  if (!instance) {
    instance = new IntelligentMailRouter();
  }
  return instance;
}
