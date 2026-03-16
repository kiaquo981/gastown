/**
 * MAIL SYSTEM — Inter-Agent Messaging (EP-074/075/076)
 *
 * Gas Town: "If you have something to say, put it in the Mail."
 *
 * Priority queue with 4 levels, 5 message types, 2 delivery modes.
 * Supports direct (single recipient), broadcast (role-wide), fan-out.
 * Critical mail triggers SSE + WhatsApp escalation.
 */

import { v4 as uuidv4 } from 'uuid';
import { broadcast, addActivity } from '../sse';
import type { Mail, MailPriority, MailType, MailDelivery, FeedEvent, FeedEventType } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MailRouterConfig {
  maxMailboxSize: number;       // Max messages per worker mailbox (default 500)
  retentionMs: number;          // Auto-cleanup read messages older than (default 24h)
  cleanupIntervalMs: number;    // Cleanup loop interval (default 30min)
}

export interface Mailbox {
  workerId: string;
  messages: Mail[];
  unreadCount: number;
  dnd: boolean;                 // Do Not Disturb — suppress non-critical
}

export interface MailStats {
  totalSent: number;
  totalDelivered: number;
  totalFanOut: number;
  mailboxCount: number;
  oldestUnread?: Date;
  byPriority: Record<MailPriority, number>;
  byType: Record<MailType, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MailRouterConfig = {
  maxMailboxSize: 500,
  retentionMs: 24 * 60 * 60 * 1000,     // 24 hours
  cleanupIntervalMs: 30 * 60 * 1000,    // 30 minutes
};

// Priority ordering for queue sorting
const PRIORITY_ORDER: Record<MailPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// MailRouter
// ─────────────────────────────────────────────────────────────────────────────

export class MailRouter {
  private config: MailRouterConfig;
  private mailboxes: Map<string, Mailbox> = new Map();
  private cleanupTimer?: NodeJS.Timeout;
  private totalSent: number = 0;
  private totalDelivered: number = 0;
  private totalFanOut: number = 0;
  private byPriority: Record<MailPriority, number> = { critical: 0, high: 0, normal: 0, low: 0 };
  private byType: Record<MailType, number> = { task: 0, escalation: 0, notification: 0, report: 0, nudge: 0 };

  // Role → worker IDs mapping for broadcast delivery
  private roleRegistry: Map<string, string[]> = new Map();

  constructor(config?: Partial<MailRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Ensure a mailbox exists for a worker */
  ensureMailbox(workerId: string): Mailbox {
    let mb = this.mailboxes.get(workerId);
    if (!mb) {
      mb = { workerId, messages: [], unreadCount: 0, dnd: false };
      this.mailboxes.set(workerId, mb);
    }
    return mb;
  }

  /** Register a worker under a role for broadcast delivery */
  registerRole(role: string, workerId: string): void {
    const workers = this.roleRegistry.get(role) || [];
    if (!workers.includes(workerId)) {
      workers.push(workerId);
      this.roleRegistry.set(role, workers);
    }
    this.ensureMailbox(workerId);
  }

  /** Send a mail message — routes to recipient(s) */
  send(mail: Omit<Mail, 'id' | 'read' | 'createdAt' | 'readAt'>): Mail {
    const fullMail: Mail = {
      ...mail,
      id: `mail-${uuidv4().slice(0, 8)}`,
      read: false,
      createdAt: new Date(),
    };

    this.totalSent++;
    this.byPriority[fullMail.priority]++;
    this.byType[fullMail.type]++;

    if (fullMail.delivery === 'broadcast') {
      this.fanOut(fullMail);
    } else {
      this.deliver(fullMail);
    }

    // SSE for critical/escalation
    if (fullMail.priority === 'critical' || fullMail.type === 'escalation') {
      this.emitFeed('mail_sent', `[${fullMail.priority.toUpperCase()}] ${fullMail.from} → ${fullMail.to}: ${fullMail.subject}`, {
        metadata: { mailId: fullMail.id, priority: fullMail.priority, type: fullMail.type },
      });
    }

    return fullMail;
  }

  /** Deliver to direct recipient(s) */
  private deliver(mail: Mail): void {
    const recipients = Array.isArray(mail.to) ? mail.to : [mail.to];

    for (const recipientId of recipients) {
      const mb = this.ensureMailbox(recipientId);

      // DND: skip non-critical if muted
      if (mb.dnd && mail.priority !== 'critical') continue;

      // Eviction: if mailbox full, drop oldest read messages
      if (mb.messages.length >= this.config.maxMailboxSize) {
        const readIdx = mb.messages.findIndex(m => m.read);
        if (readIdx >= 0) mb.messages.splice(readIdx, 1);
      }

      // Insert sorted by priority
      const insertIdx = mb.messages.findIndex(m => PRIORITY_ORDER[m.priority] > PRIORITY_ORDER[mail.priority]);
      if (insertIdx === -1) {
        mb.messages.push(mail);
      } else {
        mb.messages.splice(insertIdx, 0, mail);
      }

      mb.unreadCount++;
      this.totalDelivered++;
    }
  }

  /** Fan-out broadcast: resolve role → worker IDs, create individual copies */
  private fanOut(mail: Mail): void {
    const targets = Array.isArray(mail.to) ? mail.to : [mail.to];

    for (const target of targets) {
      // Check if target is a role name
      const workers = this.roleRegistry.get(target);
      if (workers && workers.length > 0) {
        for (const wid of workers) {
          if (wid === mail.from) continue; // Don't send to self
          const copy: Mail = { ...mail, id: `mail-${uuidv4().slice(0, 8)}`, to: wid, delivery: 'direct' };
          this.deliver(copy);
          this.totalFanOut++;
        }
      } else {
        // Treat as direct if no role match
        const copy: Mail = { ...mail, to: target, delivery: 'direct' };
        this.deliver(copy);
      }
    }
  }

  /** Get inbox for a worker — sorted by priority */
  getInbox(workerId: string, unreadOnly: boolean = false): Mail[] {
    const mb = this.mailboxes.get(workerId);
    if (!mb) return [];
    return unreadOnly ? mb.messages.filter(m => !m.read) : mb.messages;
  }

  /** Mark a message as read */
  markRead(workerId: string, mailId: string): boolean {
    const mb = this.mailboxes.get(workerId);
    if (!mb) return false;

    const msg = mb.messages.find(m => m.id === mailId);
    if (!msg || msg.read) return false;

    msg.read = true;
    msg.readAt = new Date();
    mb.unreadCount = Math.max(0, mb.unreadCount - 1);
    return true;
  }

  /** Mark all messages as read */
  markAllRead(workerId: string): number {
    const mb = this.mailboxes.get(workerId);
    if (!mb) return 0;

    let count = 0;
    const now = new Date();
    for (const msg of mb.messages) {
      if (!msg.read) {
        msg.read = true;
        msg.readAt = now;
        count++;
      }
    }
    mb.unreadCount = 0;
    return count;
  }

  /** Toggle DND for a worker */
  setDND(workerId: string, enabled: boolean): void {
    const mb = this.ensureMailbox(workerId);
    mb.dnd = enabled;
  }

  /** Get unread count for a worker */
  getUnreadCount(workerId: string): number {
    return this.mailboxes.get(workerId)?.unreadCount ?? 0;
  }

  /** Start cleanup loop — remove old read messages */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupIntervalMs);

    addActivity({
      type: 'info',
      action: 'mail_cleanup_started',
      details: `Mail cleanup loop started (every ${this.config.cleanupIntervalMs / 1000}s)`,
    });
  }

  /** Stop cleanup loop */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Run one cleanup cycle */
  cleanup(): { removed: number; mailboxes: number } {
    let removed = 0;
    const cutoff = Date.now() - this.config.retentionMs;

    for (const [, mb] of this.mailboxes) {
      const before = mb.messages.length;
      mb.messages = mb.messages.filter(m => {
        if (m.read && m.readAt && m.readAt.getTime() < cutoff) return false;
        return true;
      });
      removed += before - mb.messages.length;
      mb.unreadCount = mb.messages.filter(m => !m.read).length;
    }

    return { removed, mailboxes: this.mailboxes.size };
  }

  /** Get overall stats */
  stats(): MailStats {
    let oldestUnread: Date | undefined;
    for (const [, mb] of this.mailboxes) {
      for (const m of mb.messages) {
        if (!m.read && (!oldestUnread || m.createdAt < oldestUnread)) {
          oldestUnread = m.createdAt;
        }
      }
    }

    return {
      totalSent: this.totalSent,
      totalDelivered: this.totalDelivered,
      totalFanOut: this.totalFanOut,
      mailboxCount: this.mailboxes.size,
      oldestUnread,
      byPriority: { ...this.byPriority },
      byType: { ...this.byType },
    };
  }

  /** List all mailbox summaries */
  listMailboxes(): Array<{ workerId: string; total: number; unread: number; dnd: boolean }> {
    return Array.from(this.mailboxes.values()).map(mb => ({
      workerId: mb.workerId,
      total: mb.messages.length,
      unread: mb.unreadCount,
      dnd: mb.dnd,
    }));
  }

  private emitFeed(
    type: FeedEventType,
    message: string,
    extra?: { metadata?: Record<string, unknown> },
  ): void {
    const event: FeedEvent = {
      id: uuidv4(),
      type,
      source: 'mail-router',
      message,
      severity: type === 'escalation' ? 'error' : 'info',
      timestamp: new Date(),
      ...extra,
    };
    broadcast('meow:feed', event);
  }
}

/** Singleton MailRouter instance */
export const mailRouter = new MailRouter();
