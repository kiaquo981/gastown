/**
 * MAIL EMAIL BRIDGE — LP-026 (Stage 04 Wave 5)
 *
 * Routes report-type mail and daily digests via Resend API.
 * Supports individual reports, daily digests, weekly summaries, and alert notifications.
 * Uses a void aesthetic dark-theme HTML template.
 */

import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import type { Mail } from '../types';
import type { BridgeResult } from './mail-whatsapp-bridge';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[MAIL-EMAIL-BRIDGE]';
const RESEND_API = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'noreply@hive-ecosystem.com';

// ─────────────────────────────────────────────────────────────────────────────
// Email Templates (void aesthetic dark theme)
// ─────────────────────────────────────────────────────────────────────────────

function wrapHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <div style="border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:16px;margin-bottom:24px;">
    <span style="color:#58a6ff;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:600;">MEOW MAIL SYSTEM</span>
  </div>
  <h1 style="color:#e6edf3;font-size:20px;font-weight:600;margin:0 0 24px 0;">${title}</h1>
  ${bodyContent}
  <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;margin-top:32px;">
    <span style="color:#484f58;font-size:11px;">HIVE Ecosystem &middot; Automated Mail Bridge</span>
  </div>
</div>
</body>
</html>`;
}

function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return '#f85149';
    case 'high': return '#d29922';
    case 'normal': return '#58a6ff';
    case 'low': return '#484f58';
    default: return '#58a6ff';
  }
}

function renderMailHtml(mail: Mail): string {
  const color = priorityColor(mail.priority);
  const body = `
  <div style="background:#161b22;border:1px solid rgba(255,255,255,0.06);border-left:3px solid ${color};padding:16px;margin-bottom:16px;">
    <div style="color:${color};font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">${mail.priority} &middot; ${mail.type}</div>
    <div style="color:#e6edf3;font-size:15px;font-weight:600;margin-bottom:8px;">${escapeHtml(mail.subject)}</div>
    <div style="color:#8b949e;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(mail.body)}</div>
    ${mail.moleculeId ? `<div style="color:#484f58;font-size:11px;margin-top:12px;">Molecule: ${mail.moleculeId}</div>` : ''}
    ${mail.beadId ? `<div style="color:#484f58;font-size:11px;">Bead: ${mail.beadId}</div>` : ''}
    <div style="color:#484f58;font-size:11px;margin-top:8px;">From: ${mail.from} &middot; ${new Date(mail.createdAt).toISOString()}</div>
  </div>`;
  return wrapHtml(mail.subject, body);
}

function renderDigestHtml(mails: Mail[], title: string): string {
  const items = mails.map(m => {
    const color = priorityColor(m.priority);
    return `
    <div style="background:#161b22;border:1px solid rgba(255,255,255,0.06);border-left:3px solid ${color};padding:12px 16px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#e6edf3;font-size:13px;font-weight:600;">${escapeHtml(m.subject)}</span>
        <span style="color:${color};font-size:10px;text-transform:uppercase;">${m.priority}</span>
      </div>
      <div style="color:#8b949e;font-size:12px;margin-top:4px;">${escapeHtml(m.body.slice(0, 120))}${m.body.length > 120 ? '...' : ''}</div>
      <div style="color:#484f58;font-size:10px;margin-top:4px;">${m.from} &middot; ${m.type}</div>
    </div>`;
  }).join('');

  const summary = `
  <div style="background:#161b22;border:1px solid rgba(255,255,255,0.06);padding:16px;margin-bottom:16px;">
    <div style="color:#8b949e;font-size:13px;">${mails.length} messages &middot; ${mails.filter(m => m.priority === 'critical').length} critical &middot; ${mails.filter(m => m.type === 'escalation').length} escalations</div>
  </div>
  ${items}`;

  return wrapHtml(title, summary);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Bridge
// ─────────────────────────────────────────────────────────────────────────────

export class EmailBridge {
  private sentLog: Array<{ mailId: string; to: string; sentAt: Date; status: string }> = [];

  /** Check if Resend API is configured */
  isConfigured(): boolean {
    return !!process.env.RESEND_API_KEY;
  }

  /** Determine if this mail should be bridged to email */
  shouldBridge(mail: Mail): boolean {
    if (!this.isConfigured()) return false;
    return mail.type === 'report';
  }

  /** Send a single mail as email */
  async bridge(mail: Mail): Promise<BridgeResult> {
    const base: Omit<BridgeResult, 'success' | 'detail' | 'error'> = {
      bridgeType: 'email',
      mailId: mail.id,
      timestamp: new Date(),
    };

    if (!this.isConfigured()) {
      return { ...base, success: false, error: 'Email bridge not configured (RESEND_API_KEY missing)' };
    }

    const recipientEmail = this.resolveRecipientEmail(mail);
    if (!recipientEmail) {
      return { ...base, success: false, error: `No email mapping for recipient: ${mail.to}` };
    }

    const html = renderMailHtml(mail);
    return this.sendViaResend(mail.id, recipientEmail, `[MEOW] ${mail.subject}`, html);
  }

  /** Send a digest of multiple mails to a recipient */
  async sendDigest(mails: Mail[], recipientEmail: string): Promise<BridgeResult> {
    const digestId = `digest-${Date.now().toString(36)}`;
    const base: Omit<BridgeResult, 'success' | 'detail' | 'error'> = {
      bridgeType: 'email-digest',
      mailId: digestId,
      timestamp: new Date(),
    };

    if (!this.isConfigured()) {
      return { ...base, success: false, error: 'Email bridge not configured (RESEND_API_KEY missing)' };
    }

    if (mails.length === 0) {
      return { ...base, success: true, detail: 'Empty digest, nothing to send' };
    }

    const title = `MEOW Digest: ${mails.length} messages`;
    const html = renderDigestHtml(mails, title);
    return this.sendViaResend(digestId, recipientEmail, `[MEOW] ${title}`, html);
  }

  /** Get send log */
  getSentLog(limit = 50): typeof this.sentLog {
    return this.sentLog.slice(-limit);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async sendViaResend(
    mailId: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<BridgeResult> {
    const base: Omit<BridgeResult, 'success' | 'detail' | 'error'> = {
      bridgeType: 'email',
      mailId,
      timestamp: new Date(),
    };

    const fromEmail = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;

    try {
      const response = await fetch(RESEND_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          html,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => 'no body');
        const errMsg = `Resend API ${response.status}: ${body}`;
        console.error(TAG, errMsg);
        this.trackSent(mailId, to, 'failed');
        return { ...base, success: false, error: errMsg };
      }

      const data = await response.json().catch(() => ({}));
      this.trackSent(mailId, to, 'delivered');
      this.persistBridgeEvent(mailId, to);

      console.info(TAG, `Email sent to ${to}: ${subject}`);

      broadcast('meow:bridge', {
        bridge: 'email',
        mailId,
        status: 'delivered',
        to,
        resendId: (data as any).id,
        timestamp: new Date().toISOString(),
      });

      return { ...base, success: true, detail: `Delivered to ${to}` };
    } catch (err: any) {
      const errMsg = `Email send failed: ${err.message ?? err}`;
      console.error(TAG, errMsg);
      this.trackSent(mailId, to, 'error');
      return { ...base, success: false, error: errMsg };
    }
  }

  private resolveRecipientEmail(mail: Mail): string | null {
    // Check mail metadata for explicit email
    if (mail.metadata?.email && typeof mail.metadata.email === 'string') {
      return mail.metadata.email;
    }
    // Fallback: operator email from env
    if (process.env.OPERATOR_EMAIL) {
      return process.env.OPERATOR_EMAIL;
    }
    return null;
  }

  private trackSent(mailId: string, to: string, status: string): void {
    this.sentLog.push({ mailId, to, sentAt: new Date(), status });
    if (this.sentLog.length > 200) {
      this.sentLog = this.sentLog.slice(-100);
    }
  }

  private async persistBridgeEvent(mailId: string, to: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_bridge_events (mail_id, bridge_type, priority, mail_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [mailId, 'email', 'normal', 'report', 'delivered'],
      );
    } catch (err: any) {
      console.warn(TAG, `DB persist failed (non-critical): ${err.message}`);
    }
  }
}
