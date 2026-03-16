/**
 * MAIL BRIDGE ORCHESTRATOR — Stage 04 Wave 5
 *
 * Single entry point for all mail bridges.
 * After MailRouter.send() delivers a mail, it calls onMailSent() here
 * to route the mail to all applicable external channels.
 *
 * Bridges:
 *   LP-025  WhatsApp   — critical/escalation -> Evolution API
 *   LP-026  Email      — reports/digests -> Resend API
 *   LP-027  SSE        — all mail -> real-time UI notifications
 *   LP-028  Slack      — escalation/reports/critical -> Slack/Discord webhooks
 */

import type { Mail } from '../types';
import { WhatsAppBridge } from './mail-whatsapp-bridge';
import { EmailBridge } from './mail-email-bridge';
import { SSEMailBridge } from './mail-sse-bridge';
import { SlackDiscordBridge } from './mail-slack-bridge';
import type { BridgeResult } from './mail-whatsapp-bridge';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeStatus {
  whatsapp: { configured: boolean; rateLimitRemaining?: number };
  email: { configured: boolean };
  sse: { configured: true; workers: number; totalNotifications: number };
  slack: { configured: boolean; webhooks: string[] };
  discord: { configured: boolean };
}

export interface BridgeRouteResult {
  mailId: string;
  results: BridgeResult[];
  bridgedTo: string[];
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[BRIDGE-ORCHESTRATOR]';

export class MailBridgeOrchestrator {
  readonly whatsapp: WhatsAppBridge;
  readonly email: EmailBridge;
  readonly sse: SSEMailBridge;
  readonly slack: SlackDiscordBridge;

  constructor() {
    this.whatsapp = new WhatsAppBridge();
    this.email = new EmailBridge();
    this.sse = new SSEMailBridge();
    this.slack = new SlackDiscordBridge();

    const configured: string[] = [];
    if (this.whatsapp.isConfigured()) configured.push('whatsapp');
    if (this.email.isConfigured()) configured.push('email');
    configured.push('sse'); // SSE is always active
    if (this.slack.isConfigured()) configured.push('slack/discord');

    console.info(TAG, `Initialized with bridges: [${configured.join(', ')}]`);
  }

  /**
   * Route a mail to all applicable bridges.
   * Called by MailRouter after every send().
   * Non-blocking: fires all bridges in parallel, never throws.
   */
  async onMailSent(mail: Mail): Promise<BridgeRouteResult> {
    const results: BridgeResult[] = [];
    const bridgedTo: string[] = [];

    // SSE bridge: always fires (synchronous, never fails)
    try {
      this.sse.bridge(mail);
      bridgedTo.push('sse');
    } catch (err: any) {
      console.error(TAG, `SSE bridge error: ${err.message}`);
    }

    // Async bridges: run in parallel
    const asyncBridges: Array<Promise<void>> = [];

    // WhatsApp bridge
    if (this.whatsapp.shouldBridge(mail)) {
      asyncBridges.push(
        this.whatsapp.bridge(mail).then(result => {
          results.push(result);
          if (result.success) bridgedTo.push('whatsapp');
        }).catch(err => {
          console.error(TAG, `WhatsApp bridge error: ${err.message}`);
        }),
      );
    }

    // Email bridge
    if (this.email.shouldBridge(mail)) {
      asyncBridges.push(
        this.email.bridge(mail).then(result => {
          results.push(result);
          if (result.success) bridgedTo.push('email');
        }).catch(err => {
          console.error(TAG, `Email bridge error: ${err.message}`);
        }),
      );
    }

    // Slack/Discord bridge
    if (this.slack.shouldBridge(mail)) {
      asyncBridges.push(
        this.slack.bridge(mail).then(result => {
          results.push(result);
          if (result.success) bridgedTo.push('slack-discord');
        }).catch(err => {
          console.error(TAG, `Slack/Discord bridge error: ${err.message}`);
        }),
      );
    }

    // Wait for all async bridges (with individual error handling above)
    if (asyncBridges.length > 0) {
      await Promise.allSettled(asyncBridges);
    }

    if (bridgedTo.length > 1) {
      // More than just SSE
      console.info(TAG, `Mail ${mail.id} bridged to: [${bridgedTo.join(', ')}]`);
    }

    return {
      mailId: mail.id,
      results,
      bridgedTo,
      timestamp: new Date(),
    };
  }

  /** Get status of all bridges */
  getStatus(): BridgeStatus {
    const sseStats = this.sse.stats();
    const slackStatus = this.slack.getWebhookStatus();

    return {
      whatsapp: {
        configured: this.whatsapp.isConfigured(),
        rateLimitRemaining: this.whatsapp.isConfigured()
          ? this.whatsapp.getRateLimitStatus().remaining
          : undefined,
      },
      email: {
        configured: this.email.isConfigured(),
      },
      sse: {
        configured: true,
        workers: sseStats.workers,
        totalNotifications: sseStats.totalNotifications,
      },
      slack: {
        configured: slackStatus.slack.length > 0,
        webhooks: slackStatus.slack,
      },
      discord: {
        configured: slackStatus.discord,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: MailBridgeOrchestrator | null = null;

/** Get or create the singleton MailBridgeOrchestrator */
export function getMailBridgeOrchestrator(): MailBridgeOrchestrator {
  if (!instance) {
    instance = new MailBridgeOrchestrator();
  }
  return instance;
}

// Re-export bridge classes and types for direct access
export { WhatsAppBridge } from './mail-whatsapp-bridge';
export { EmailBridge } from './mail-email-bridge';
export { SSEMailBridge } from './mail-sse-bridge';
export { SlackDiscordBridge } from './mail-slack-bridge';
export type { BridgeResult } from './mail-whatsapp-bridge';
export type { Notification } from './mail-sse-bridge';
