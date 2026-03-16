/**
 * MAIL SSE BRIDGE — LP-027 (Stage 04 Wave 5)
 *
 * Broadcasts every mail via SSE for real-time UI notifications.
 * Maintains notification bell state: unread counts, latest notifications, mark-as-read/dismiss.
 * Channels: 'meow:mail' (individual mail), 'meow:notifications' (bell updates).
 */

import { broadcast } from '../../sse';
import type { Mail } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  mailId: string;
  workerId: string;
  subject: string;
  body: string;
  priority: string;
  type: string;
  from: string;
  read: boolean;
  dismissedAt?: Date;
  createdAt: Date;
}

interface NotificationBellState {
  unreadCount: number;
  latestSubject?: string;
  latestPriority?: string;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TAG = '[MAIL-SSE-BRIDGE]';
const MAX_NOTIFICATIONS = 50;
const SSE_MAIL_CHANNEL = 'meow:mail';
const SSE_NOTIFICATIONS_CHANNEL = 'meow:notifications';

// ─────────────────────────────────────────────────────────────────────────────
// SSE Mail Bridge
// ─────────────────────────────────────────────────────────────────────────────

export class SSEMailBridge {
  /** Per-worker notification stores (workerId -> notifications) */
  private notifications: Map<string, Notification[]> = new Map();

  /** Global notifications (for mails with no specific worker target) */
  private globalNotifications: Notification[] = [];

  private notificationCounter = 0;

  /**
   * Bridge a mail to SSE. Always fires -- no condition check needed.
   * Broadcasts the raw mail on 'meow:mail' and updates bell state.
   */
  bridge(mail: Mail): void {
    try {
      // 1. Broadcast raw mail event
      broadcast(SSE_MAIL_CHANNEL, {
        id: mail.id,
        from: mail.from,
        to: mail.to,
        priority: mail.priority,
        type: mail.type,
        subject: mail.subject,
        body: mail.body.slice(0, 500), // Truncate body for SSE payload
        moleculeId: mail.moleculeId,
        beadId: mail.beadId,
        timestamp: new Date().toISOString(),
      });

      // 2. Create notification(s)
      const recipients = this.resolveRecipients(mail);

      for (const workerId of recipients) {
        const notification = this.createNotification(mail, workerId);
        this.addNotification(workerId, notification);
      }

      // 3. Broadcast bell state updates for all affected workers
      for (const workerId of recipients) {
        this.broadcastBellState(workerId);
      }

      // Also broadcast to global for dashboard consumption
      this.broadcastGlobalBellState();
    } catch (err: any) {
      console.error(TAG, `Bridge failed for mail ${mail.id}: ${err.message}`);
    }
  }

  /** Get notifications for a specific worker (or global if no workerId) */
  getNotifications(workerId?: string, limit = 50): Notification[] {
    const store = workerId
      ? this.notifications.get(workerId) || []
      : this.globalNotifications;

    return store
      .filter(n => !n.dismissedAt)
      .slice(-limit)
      .reverse(); // newest first
  }

  /** Get unread count for a specific worker (or global) */
  getUnreadCount(workerId?: string): number {
    const store = workerId
      ? this.notifications.get(workerId) || []
      : this.globalNotifications;

    return store.filter(n => !n.read && !n.dismissedAt).length;
  }

  /** Mark a specific notification as read */
  markNotificationRead(notificationId: string): void {
    let found = false;

    // Search all worker stores
    for (const [workerId, store] of this.notifications) {
      const notif = store.find(n => n.id === notificationId);
      if (notif && !notif.read) {
        notif.read = true;
        found = true;
        this.broadcastBellState(workerId);
        break;
      }
    }

    // Search global store
    if (!found) {
      const notif = this.globalNotifications.find(n => n.id === notificationId);
      if (notif && !notif.read) {
        notif.read = true;
        this.broadcastGlobalBellState();
      }
    }
  }

  /** Dismiss all notifications for a worker (or global) */
  dismissAll(workerId?: string): void {
    const now = new Date();

    if (workerId) {
      const store = this.notifications.get(workerId);
      if (store) {
        for (const n of store) {
          if (!n.dismissedAt) n.dismissedAt = now;
        }
        this.broadcastBellState(workerId);
      }
    } else {
      for (const n of this.globalNotifications) {
        if (!n.dismissedAt) n.dismissedAt = now;
      }
      this.broadcastGlobalBellState();
    }
  }

  /** Get bell state summary for a worker */
  getBellState(workerId?: string): NotificationBellState {
    const store = workerId
      ? this.notifications.get(workerId) || []
      : this.globalNotifications;

    const active = store.filter(n => !n.dismissedAt);
    const unread = active.filter(n => !n.read);
    const latest = active[active.length - 1];

    return {
      unreadCount: unread.length,
      latestSubject: latest?.subject,
      latestPriority: latest?.priority,
      updatedAt: new Date(),
    };
  }

  /** Get stats for diagnostics */
  stats(): { workers: number; totalNotifications: number; globalNotifications: number } {
    let totalNotifications = 0;
    for (const store of this.notifications.values()) {
      totalNotifications += store.length;
    }

    return {
      workers: this.notifications.size,
      totalNotifications,
      globalNotifications: this.globalNotifications.length,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private resolveRecipients(mail: Mail): string[] {
    const recipients: string[] = [];

    if (Array.isArray(mail.to)) {
      recipients.push(...mail.to);
    } else if (mail.to) {
      recipients.push(mail.to);
    }

    // If no specific recipients, add to global
    if (recipients.length === 0) {
      recipients.push('__global__');
    }

    return recipients;
  }

  private createNotification(mail: Mail, workerId: string): Notification {
    this.notificationCounter++;
    return {
      id: `notif-${this.notificationCounter}-${Date.now().toString(36)}`,
      mailId: mail.id,
      workerId,
      subject: mail.subject,
      body: mail.body.slice(0, 200),
      priority: mail.priority,
      type: mail.type,
      from: mail.from,
      read: false,
      createdAt: new Date(),
    };
  }

  private addNotification(workerId: string, notification: Notification): void {
    if (workerId === '__global__') {
      this.globalNotifications.push(notification);
      if (this.globalNotifications.length > MAX_NOTIFICATIONS) {
        this.globalNotifications = this.globalNotifications.slice(-MAX_NOTIFICATIONS);
      }
      return;
    }

    if (!this.notifications.has(workerId)) {
      this.notifications.set(workerId, []);
    }
    const store = this.notifications.get(workerId)!;
    store.push(notification);

    // Cap at MAX_NOTIFICATIONS per worker
    if (store.length > MAX_NOTIFICATIONS) {
      this.notifications.set(workerId, store.slice(-MAX_NOTIFICATIONS));
    }
  }

  private broadcastBellState(workerId: string): void {
    const state = this.getBellState(workerId);
    broadcast(SSE_NOTIFICATIONS_CHANNEL, {
      workerId,
      ...state,
      updatedAt: state.updatedAt.toISOString(),
    });
  }

  private broadcastGlobalBellState(): void {
    const state = this.getBellState();
    broadcast(SSE_NOTIFICATIONS_CHANNEL, {
      workerId: '__global__',
      ...state,
      updatedAt: state.updatedAt.toISOString(),
    });
  }
}
