/**
 * MAIL WHATSAPP BRIDGE — LP-025 (Stage 04 Wave 5)
 *
 * Routes critical mail escalations to WhatsApp via Evolution API.
 * Triggers when mail.priority === 'critical' OR mail.type === 'escalation'.
 * Rate-limited to 30 messages per hour.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Mail } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeResult {
  success: boolean;
  bridgeType: string;
  mailId: string;
  detail?: string;
  error?: string;
  timestamp: Date;
}

interface RateLimitState {
  count: number;
  windowStart: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[MAIL-WA-BRIDGE]';
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Bridge
// ─────────────────────────────────────────────────────────────────────────────

export class WhatsAppBridge {
  private rateLimit: RateLimitState = { count: 0, windowStart: Date.now() };
  private deliveryLog: Array<{ mailId: string; sentAt: Date; status: string }> = [];

  /** Check if environment is properly configured for WhatsApp delivery */
  isConfigured(): boolean {
    return !!(
      process.env.EVOLUTION_API_URL &&
      process.env.EVOLUTION_INSTANCE &&
      process.env.EVOLUTION_API_KEY &&
      process.env.MAYOR_OPERATOR_PHONE
    );
  }

  /** Determine if this mail should be bridged to WhatsApp */
  shouldBridge(mail: Mail): boolean {
    if (!this.isConfigured()) return false;
    return mail.priority === 'critical' || mail.type === 'escalation';
  }

  /** Send the mail to WhatsApp */
  async bridge(mail: Mail): Promise<BridgeResult> {
    const base: Omit<BridgeResult, 'success' | 'detail' | 'error'> = {
      bridgeType: 'whatsapp',
      mailId: mail.id,
      timestamp: new Date(),
    };

    // Pre-flight: configured?
    if (!this.isConfigured()) {
      return { ...base, success: false, error: 'WhatsApp bridge not configured (missing env vars)' };
    }

    // Rate limit check
    if (!this.checkRateLimit()) {
      const result: BridgeResult = {
        ...base,
        success: false,
        error: `Rate limit exceeded (${RATE_LIMIT_MAX}/hr). Mail ${mail.id} queued but not sent.`,
      };
      console.warn(TAG, result.error);
      return result;
    }

    // Build message
    const message = this.formatMessage(mail);
    const phone = process.env.MAYOR_OPERATOR_PHONE!;

    try {
      const response = await fetch(
        `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: process.env.EVOLUTION_API_KEY!,
          },
          body: JSON.stringify({
            number: phone,
            text: message,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => 'no body');
        const errMsg = `Evolution API ${response.status}: ${body}`;
        console.error(TAG, errMsg);
        this.trackDelivery(mail.id, 'failed');
        return { ...base, success: false, error: errMsg };
      }

      // Success
      this.rateLimit.count++;
      this.trackDelivery(mail.id, 'delivered');
      this.persistBridgeEvent(mail);

      console.info(TAG, `Sent to ${phone}: [${mail.priority}] ${mail.subject}`);

      broadcast('meow:bridge', {
        bridge: 'whatsapp',
        mailId: mail.id,
        status: 'delivered',
        phone,
        timestamp: new Date().toISOString(),
      });

      return { ...base, success: true, detail: `Delivered to ${phone}` };
    } catch (err: any) {
      const errMsg = `WhatsApp send failed: ${err.message ?? err}`;
      console.error(TAG, errMsg);
      this.trackDelivery(mail.id, 'error');
      return { ...base, success: false, error: errMsg };
    }
  }

  /** Get delivery log for diagnostics */
  getDeliveryLog(limit = 50): typeof this.deliveryLog {
    return this.deliveryLog.slice(-limit);
  }

  /** Current rate limit status */
  getRateLimitStatus(): { remaining: number; resetsAt: Date } {
    this.resetWindowIfExpired();
    return {
      remaining: Math.max(0, RATE_LIMIT_MAX - this.rateLimit.count),
      resetsAt: new Date(this.rateLimit.windowStart + RATE_LIMIT_WINDOW_MS),
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private formatMessage(mail: Mail): string {
    const lines = [
      `[MEOW ALERT] ${mail.subject}`,
      mail.body,
    ];
    if (mail.moleculeId) lines.push(`Molecule: ${mail.moleculeId}`);
    if (mail.beadId) lines.push(`Bead: ${mail.beadId}`);
    lines.push(`Priority: ${mail.priority.toUpperCase()}`);
    lines.push(`Type: ${mail.type}`);
    lines.push(`From: ${mail.from}`);
    lines.push(`Time: ${new Date().toISOString()}`);
    return lines.join('\n');
  }

  private checkRateLimit(): boolean {
    this.resetWindowIfExpired();
    return this.rateLimit.count < RATE_LIMIT_MAX;
  }

  private resetWindowIfExpired(): void {
    const now = Date.now();
    if (now - this.rateLimit.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimit = { count: 0, windowStart: now };
    }
  }

  private trackDelivery(mailId: string, status: string): void {
    this.deliveryLog.push({ mailId, sentAt: new Date(), status });
    // Cap log at 200 entries
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
        [mail.id, 'whatsapp', mail.priority, mail.type, 'delivered'],
      );
    } catch (err: any) {
      // Non-critical — log and continue
      console.warn(TAG, `DB persist failed (non-critical): ${err.message}`);
    }
  }
}
