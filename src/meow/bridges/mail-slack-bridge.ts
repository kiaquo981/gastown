/**
 * MAIL SLACK/DISCORD BRIDGE — LP-028 (Stage 04 Wave 5)
 *
 * Routes mail to Slack channels or Discord webhooks based on type/priority.
 * Channel routing:
 *   - escalation -> #alerts
 *   - report     -> #reports
 *   - notification/task/nudge -> #general
 * Supports both Slack (Block Kit) and Discord (embed) formats.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Mail } from '../types';
import type { BridgeResult } from './mail-whatsapp-bridge';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SlackWebhookConfig {
  url: string;
  channel?: string;
}

interface DiscordWebhookConfig {
  url: string;
}

type MailTypeChannel = 'alerts' | 'reports' | 'general';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[MAIL-SLACK-BRIDGE]';

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#f85149',
  high: '#d29922',
  normal: '#58a6ff',
  low: '#484f58',
};

const TYPE_CHANNEL_MAP: Record<string, MailTypeChannel> = {
  escalation: 'alerts',
  report: 'reports',
  notification: 'general',
  task: 'general',
  nudge: 'general',
};

// ─────────────────────────────────────────────────────────────────────────────
// Slack/Discord Bridge
// ─────────────────────────────────────────────────────────────────────────────

export class SlackDiscordBridge {
  private slackWebhooks: Map<MailTypeChannel, SlackWebhookConfig> = new Map();
  private discordWebhook: DiscordWebhookConfig | null = null;
  private deliveryLog: Array<{ mailId: string; platform: string; sentAt: Date; status: string }> = [];

  constructor() {
    // Auto-configure from env vars
    if (process.env.SLACK_WEBHOOK_URL) {
      this.slackWebhooks.set('general', { url: process.env.SLACK_WEBHOOK_URL });
    }
    if (process.env.SLACK_ALERTS_WEBHOOK_URL) {
      this.slackWebhooks.set('alerts', { url: process.env.SLACK_ALERTS_WEBHOOK_URL });
    }
    if (process.env.SLACK_REPORTS_WEBHOOK_URL) {
      this.slackWebhooks.set('reports', { url: process.env.SLACK_REPORTS_WEBHOOK_URL });
    }
    if (process.env.DISCORD_WEBHOOK_URL) {
      this.discordWebhook = { url: process.env.DISCORD_WEBHOOK_URL };
    }
  }

  /** Check if at least one webhook is configured */
  isConfigured(): boolean {
    return this.slackWebhooks.size > 0 || this.discordWebhook !== null;
  }

  /** Determine if this mail should be bridged */
  shouldBridge(mail: Mail): boolean {
    if (!this.isConfigured()) return false;
    // Bridge escalations, reports, and critical-priority mail
    return (
      mail.type === 'escalation' ||
      mail.type === 'report' ||
      mail.type === 'notification' ||
      mail.priority === 'critical' ||
      mail.priority === 'high'
    );
  }

  /** Bridge mail to Slack and/or Discord */
  async bridge(mail: Mail): Promise<BridgeResult> {
    const base: Omit<BridgeResult, 'success' | 'detail' | 'error'> = {
      bridgeType: 'slack-discord',
      mailId: mail.id,
      timestamp: new Date(),
    };

    if (!this.isConfigured()) {
      return { ...base, success: false, error: 'No Slack/Discord webhooks configured' };
    }

    const results: Array<{ platform: string; success: boolean; error?: string }> = [];

    // Send to Slack if configured
    if (this.slackWebhooks.size > 0) {
      const slackResult = await this.sendToSlack(mail);
      results.push(slackResult);
    }

    // Send to Discord if configured
    if (this.discordWebhook) {
      const discordResult = await this.sendToDiscord(mail);
      results.push(discordResult);
    }

    const allSuccess = results.every(r => r.success);
    const anySuccess = results.some(r => r.success);
    const errors = results.filter(r => !r.success).map(r => r.error).join('; ');

    if (anySuccess) {
      this.persistBridgeEvent(mail);
      broadcast('meow:bridge', {
        bridge: 'slack-discord',
        mailId: mail.id,
        status: allSuccess ? 'delivered' : 'partial',
        platforms: results.map(r => r.platform),
        timestamp: new Date().toISOString(),
      });
    }

    return {
      ...base,
      success: anySuccess,
      detail: results.map(r => `${r.platform}: ${r.success ? 'ok' : 'fail'}`).join(', '),
      error: errors || undefined,
    };
  }

  /** Manually set a Slack webhook */
  setSlackWebhook(url: string, channel?: MailTypeChannel): void {
    const target = channel || 'general';
    this.slackWebhooks.set(target, { url, channel: target });
    console.info(TAG, `Slack webhook set for channel: ${target}`);
  }

  /** Manually set Discord webhook */
  setDiscordWebhook(url: string): void {
    this.discordWebhook = { url };
    console.info(TAG, 'Discord webhook set');
  }

  /** Get delivery log */
  getDeliveryLog(limit = 50): typeof this.deliveryLog {
    return this.deliveryLog.slice(-limit);
  }

  /** Get current webhook status */
  getWebhookStatus(): { slack: string[]; discord: boolean } {
    return {
      slack: Array.from(this.slackWebhooks.keys()),
      discord: this.discordWebhook !== null,
    };
  }

  // ─── Slack ───────────────────────────────────────────────────────────────

  private async sendToSlack(mail: Mail): Promise<{ platform: string; success: boolean; error?: string }> {
    const targetChannel = TYPE_CHANNEL_MAP[mail.type] || 'general';
    const webhook = this.slackWebhooks.get(targetChannel) || this.slackWebhooks.get('general');

    if (!webhook) {
      return { platform: 'slack', success: false, error: `No webhook for channel: ${targetChannel}` };
    }

    const color = PRIORITY_COLORS[mail.priority] || PRIORITY_COLORS.normal;
    const payload = {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `MEOW: ${mail.subject}`, emoji: true },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: mail.body.slice(0, 2000) },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `*Priority:* ${mail.priority.toUpperCase()}` },
            { type: 'mrkdwn', text: `*Type:* ${mail.type}` },
            { type: 'mrkdwn', text: `*From:* ${mail.from}` },
            ...(mail.moleculeId ? [{ type: 'mrkdwn' as const, text: `*Molecule:* ${mail.moleculeId}` }] : []),
            ...(mail.beadId ? [{ type: 'mrkdwn' as const, text: `*Bead:* ${mail.beadId}` }] : []),
          ],
        },
        { type: 'divider' },
      ],
      attachments: [
        {
          color,
          fallback: `[${mail.priority.toUpperCase()}] ${mail.subject}`,
        },
      ],
    };

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => 'no body');
        const errMsg = `Slack ${response.status}: ${body}`;
        console.error(TAG, errMsg);
        this.trackDelivery(mail.id, 'slack', 'failed');
        return { platform: 'slack', success: false, error: errMsg };
      }

      this.trackDelivery(mail.id, 'slack', 'delivered');
      console.info(TAG, `Slack delivered (${targetChannel}): ${mail.subject}`);
      return { platform: 'slack', success: true };
    } catch (err: any) {
      const errMsg = `Slack send failed: ${err.message ?? err}`;
      console.error(TAG, errMsg);
      this.trackDelivery(mail.id, 'slack', 'error');
      return { platform: 'slack', success: false, error: errMsg };
    }
  }

  // ─── Discord ─────────────────────────────────────────────────────────────

  private async sendToDiscord(mail: Mail): Promise<{ platform: string; success: boolean; error?: string }> {
    if (!this.discordWebhook) {
      return { platform: 'discord', success: false, error: 'No Discord webhook configured' };
    }

    const color = parseInt((PRIORITY_COLORS[mail.priority] || PRIORITY_COLORS.normal).replace('#', ''), 16);
    const payload = {
      embeds: [
        {
          title: `MEOW: ${mail.subject}`,
          description: mail.body.slice(0, 2000),
          color,
          fields: [
            { name: 'Priority', value: mail.priority.toUpperCase(), inline: true },
            { name: 'Type', value: mail.type, inline: true },
            { name: 'From', value: mail.from, inline: true },
            ...(mail.moleculeId ? [{ name: 'Molecule', value: mail.moleculeId, inline: true }] : []),
            ...(mail.beadId ? [{ name: 'Bead', value: mail.beadId, inline: true }] : []),
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Gas Town - MEOW Mail Bridge' },
        },
      ],
    };

    try {
      const response = await fetch(this.discordWebhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => 'no body');
        const errMsg = `Discord ${response.status}: ${body}`;
        console.error(TAG, errMsg);
        this.trackDelivery(mail.id, 'discord', 'failed');
        return { platform: 'discord', success: false, error: errMsg };
      }

      this.trackDelivery(mail.id, 'discord', 'delivered');
      console.info(TAG, `Discord delivered: ${mail.subject}`);
      return { platform: 'discord', success: true };
    } catch (err: any) {
      const errMsg = `Discord send failed: ${err.message ?? err}`;
      console.error(TAG, errMsg);
      this.trackDelivery(mail.id, 'discord', 'error');
      return { platform: 'discord', success: false, error: errMsg };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private trackDelivery(mailId: string, platform: string, status: string): void {
    this.deliveryLog.push({ mailId, platform, sentAt: new Date(), status });
    if (this.deliveryLog.length > 200) {
      this.deliveryLog = this.deliveryLog.slice(-100);
    }
  }

  private async persistBridgeEvent(mail: Mail): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_bridge_events (mail_id, bridge_type, priority, mail_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [mail.id, 'slack-discord', mail.priority, mail.type, 'delivered'],
      );
    } catch (err: any) {
      console.warn(TAG, `DB persist failed (non-critical): ${err.message}`);
    }
  }
}
