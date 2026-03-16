/**
 * WEBHOOKS OUTBOUND — SG-023 (Stage 06 Wave 6)
 *
 * Gas Town emits webhooks on key operational events to external consumers.
 * Supports registration, HMAC signature verification, retry logic with
 * exponential backoff, delivery tracking, dead letter queue, and batch delivery.
 *
 * Event types:
 *   - molecule_completed: A molecule finished execution
 *   - gate_failed: A quality gate check failed
 *   - budget_exceeded: Daily budget threshold breached
 *   - crisis_started: Crisis mode activated
 *   - formula_completed: A full formula run finished
 *   - bead_status_changed: A bead transitioned status
 *
 * Features:
 *   - Webhook registration: URL + events + optional secret for HMAC
 *   - HMAC signature: SHA-256 in X-GasTown-Signature header
 *   - Delivery: HTTP POST with retry (3 attempts, exponential backoff)
 *   - Delivery tracking: success/failure/retry count per webhook per event
 *   - Management: register, update, delete, list, test (send test payload)
 *   - Dead letter queue: after 3 failures, disable webhook and notify
 *   - Batch delivery: coalesce rapid events into single payload
 *   - DB tables: meow_outbound_webhooks, meow_webhook_deliveries
 *
 * Gas Town: "When the refinery speaks, the world listens — or stops listening."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import * as crypto from 'crypto';

const log = createLogger('webhooks-outbound');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | 'molecule_completed'
  | 'gate_failed'
  | 'budget_exceeded'
  | 'crisis_started'
  | 'formula_completed'
  | 'bead_status_changed';

export type WebhookStatus = 'active' | 'paused' | 'disabled' | 'deleted';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_letter';

export interface WebhookRegistration {
  id: string;
  url: string;
  label: string;
  events: WebhookEventType[];
  secret?: string;                // for HMAC signing
  status: WebhookStatus;
  headers?: Record<string, string>; // custom headers to include
  maxRetries: number;
  consecutiveFailures: number;
  totalDeliveries: number;
  totalFailures: number;
  lastDeliveryAt?: Date;
  lastFailureAt?: Date;
  lastFailureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
  signature?: string;
  deliveryId: string;
  webhookId: string;
}

export interface WebhookBatchPayload {
  events: Array<{
    event: WebhookEventType;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
  batchId: string;
  batchSize: number;
  signature?: string;
  webhookId: string;
}

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  payload: unknown;
  status: DeliveryStatus;
  httpStatus?: number;
  responseBody?: string;
  attempts: number;
  maxRetries: number;
  nextRetryAt?: Date;
  error?: string;
  deliveredAt?: Date;
  createdAt: Date;
}

export interface DeadLetterEntry {
  id: string;
  webhookId: string;
  webhookUrl: string;
  deliveryId: string;
  event: WebhookEventType;
  payload: unknown;
  lastError: string;
  attempts: number;
  disabledWebhook: boolean;
  createdAt: Date;
}

export interface WebhookStats {
  totalRegistrations: number;
  activeWebhooks: number;
  disabledWebhooks: number;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  deadLetterCount: number;
  avgDeliveryTimeMs: number;
  deliveriesByEvent: Record<WebhookEventType, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;                // 2s, 4s, 8s exponential
const MAX_WEBHOOKS = 200;
const MAX_DELIVERIES_MEMORY = 5000;
const MAX_DEAD_LETTERS = 500;
const BATCH_WINDOW_MS = 3000;              // coalesce events within 3s window
const DELIVERY_TIMEOUT_MS = 10_000;        // 10s timeout per HTTP call
const CONSECUTIVE_FAILURE_THRESHOLD = 3;   // disable after N consecutive failures

const ALL_EVENT_TYPES: WebhookEventType[] = [
  'molecule_completed', 'gate_failed', 'budget_exceeded',
  'crisis_started', 'formula_completed', 'bead_status_changed',
];

// ---------------------------------------------------------------------------
// HMAC helper
// ---------------------------------------------------------------------------

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// WebhooksOutbound
// ---------------------------------------------------------------------------

export class WebhooksOutbound {
  private webhooks: Map<string, WebhookRegistration> = new Map();
  private deliveries: DeliveryRecord[] = [];
  private deadLetters: DeadLetterEntry[] = [];
  private batchBuffers: Map<string, Array<{ event: WebhookEventType; timestamp: string; data: Record<string, unknown> }>> = new Map();
  private batchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private totalDeliveries = 0;
  private successfulDeliveries = 0;
  private failedDeliveries = 0;
  private totalDeliveryTimeMs = 0;

  // -------------------------------------------------------------------------
  // Registration management
  // -------------------------------------------------------------------------

  async register(
    url: string,
    label: string,
    events: WebhookEventType[],
    secret?: string,
    headers?: Record<string, string>,
    maxRetries?: number,
  ): Promise<WebhookRegistration> {
    // Validate URL
    try { new URL(url); } catch {
      throw new Error(`Invalid webhook URL: ${url}`);
    }

    // Validate events
    for (const evt of events) {
      if (!ALL_EVENT_TYPES.includes(evt)) {
        throw new Error(`Invalid event type: ${evt}. Valid: ${ALL_EVENT_TYPES.join(', ')}`);
      }
    }

    // HIGH-05: Warn about plaintext secret storage
    if (secret) {
      log.warn(
        { url, label },
        'Webhook secret stored in plaintext memory. In production, use encrypted storage (e.g., vault, KMS) for HMAC secrets.',
      );
    }

    const registration: WebhookRegistration = {
      id: uuidv4(),
      url,
      label,
      events,
      secret,
      status: 'active',
      headers,
      maxRetries: maxRetries ?? MAX_RETRIES,
      consecutiveFailures: 0,
      totalDeliveries: 0,
      totalFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.webhooks.set(registration.id, registration);

    if (this.webhooks.size > MAX_WEBHOOKS) {
      this.evictDeletedWebhooks();
    }

    await this.persistWebhook(registration);

    log.info({ webhookId: registration.id, url, events, label }, 'Webhook registered');

    broadcast('meow:sovereign', {
      type: 'webhooks:registered',
      webhookId: registration.id,
      url,
      events,
    });

    return registration;
  }

  async update(
    webhookId: string,
    updates: Partial<Pick<WebhookRegistration, 'url' | 'label' | 'events' | 'secret' | 'headers' | 'status' | 'maxRetries'>>,
  ): Promise<WebhookRegistration | null> {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) return null;

    if (updates.url) {
      try { new URL(updates.url); } catch {
        throw new Error(`Invalid webhook URL: ${updates.url}`);
      }
      webhook.url = updates.url;
    }
    if (updates.label) webhook.label = updates.label;
    if (updates.events) webhook.events = updates.events;
    if (updates.secret !== undefined) webhook.secret = updates.secret;
    if (updates.headers) webhook.headers = updates.headers;
    if (updates.status) webhook.status = updates.status;
    if (updates.maxRetries !== undefined) webhook.maxRetries = updates.maxRetries;
    webhook.updatedAt = new Date();

    // Re-enable if manually set to active
    if (updates.status === 'active') {
      webhook.consecutiveFailures = 0;
    }

    await this.persistWebhook(webhook);

    log.info({ webhookId, updates: Object.keys(updates) }, 'Webhook updated');

    return webhook;
  }

  async remove(webhookId: string): Promise<boolean> {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) return false;

    webhook.status = 'deleted';
    webhook.updatedAt = new Date();
    await this.persistWebhook(webhook);

    // Clear batch buffer and timers
    this.clearBatchTimer(webhookId);
    this.batchBuffers.delete(webhookId);

    log.info({ webhookId, url: webhook.url }, 'Webhook deleted');

    broadcast('meow:sovereign', {
      type: 'webhooks:deleted',
      webhookId,
    });

    return true;
  }

  list(includeDeleted = false): WebhookRegistration[] {
    const result: WebhookRegistration[] = [];
    for (const wh of this.webhooks.values()) {
      if (!includeDeleted && wh.status === 'deleted') continue;
      result.push({ ...wh });
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  get(webhookId: string): WebhookRegistration | undefined {
    return this.webhooks.get(webhookId);
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  async emit(event: WebhookEventType, data: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();

    for (const webhook of this.webhooks.values()) {
      if (webhook.status !== 'active') continue;
      if (!webhook.events.includes(event)) continue;

      // Buffer for batch delivery
      const buffer = this.batchBuffers.get(webhook.id) ?? [];
      buffer.push({ event, timestamp, data });
      this.batchBuffers.set(webhook.id, buffer);

      // Start or reset batch timer
      if (!this.batchTimers.has(webhook.id)) {
        const timer = setTimeout(() => this.flushBatch(webhook.id), BATCH_WINDOW_MS);
        this.batchTimers.set(webhook.id, timer);
      }
    }
  }

  private async flushBatch(webhookId: string): Promise<void> {
    this.clearBatchTimer(webhookId);

    const buffer = this.batchBuffers.get(webhookId);
    if (!buffer || buffer.length === 0) return;

    this.batchBuffers.set(webhookId, []);
    const webhook = this.webhooks.get(webhookId);
    if (!webhook || webhook.status !== 'active') return;

    if (buffer.length === 1) {
      // Single event — deliver directly
      const item = buffer[0];
      await this.deliverSingle(webhook, item.event, item.timestamp, item.data);
    } else {
      // Batch delivery
      await this.deliverBatch(webhook, buffer);
    }
  }

  // -------------------------------------------------------------------------
  // Delivery — single
  // -------------------------------------------------------------------------

  private async deliverSingle(
    webhook: WebhookRegistration,
    event: WebhookEventType,
    timestamp: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const deliveryId = uuidv4();

    const payload: WebhookPayload = {
      event,
      timestamp,
      data,
      deliveryId,
      webhookId: webhook.id,
    };

    const bodyStr = JSON.stringify(payload);

    if (webhook.secret) {
      payload.signature = signPayload(bodyStr, webhook.secret);
    }

    const delivery: DeliveryRecord = {
      id: deliveryId,
      webhookId: webhook.id,
      event,
      payload,
      status: 'pending',
      attempts: 0,
      maxRetries: webhook.maxRetries,
      createdAt: new Date(),
    };

    this.deliveries.push(delivery);
    this.trimDeliveries();

    await this.attemptDelivery(webhook, delivery, bodyStr);
  }

  // -------------------------------------------------------------------------
  // Delivery — batch
  // -------------------------------------------------------------------------

  private async deliverBatch(
    webhook: WebhookRegistration,
    items: Array<{ event: WebhookEventType; timestamp: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    const batchId = uuidv4();
    const deliveryId = uuidv4();

    const batchPayload: WebhookBatchPayload = {
      events: items,
      batchId,
      batchSize: items.length,
      webhookId: webhook.id,
    };

    const bodyStr = JSON.stringify(batchPayload);

    if (webhook.secret) {
      batchPayload.signature = signPayload(bodyStr, webhook.secret);
    }

    const delivery: DeliveryRecord = {
      id: deliveryId,
      webhookId: webhook.id,
      event: items[0].event,       // primary event
      payload: batchPayload,
      status: 'pending',
      attempts: 0,
      maxRetries: webhook.maxRetries,
      createdAt: new Date(),
    };

    this.deliveries.push(delivery);
    this.trimDeliveries();

    log.info({ webhookId: webhook.id, batchSize: items.length, batchId }, 'Delivering batch webhook');

    await this.attemptDelivery(webhook, delivery, bodyStr);
  }

  // -------------------------------------------------------------------------
  // Delivery attempt with retry
  // -------------------------------------------------------------------------

  private async attemptDelivery(
    webhook: WebhookRegistration,
    delivery: DeliveryRecord,
    bodyStr: string,
  ): Promise<void> {
    delivery.attempts += 1;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'GasTown-Webhooks/1.0',
      'X-GasTown-Delivery-Id': delivery.id,
      'X-GasTown-Event': delivery.event,
      ...(webhook.headers ?? {}),
    };

    if (webhook.secret) {
      headers['X-GasTown-Signature'] = signPayload(bodyStr, webhook.secret);
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      const resp = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const elapsed = Date.now() - startTime;
      this.totalDeliveryTimeMs += elapsed;

      delivery.httpStatus = resp.status;

      if (resp.ok) {
        delivery.status = 'delivered';
        delivery.deliveredAt = new Date();
        this.totalDeliveries += 1;
        this.successfulDeliveries += 1;

        webhook.consecutiveFailures = 0;
        webhook.totalDeliveries += 1;
        webhook.lastDeliveryAt = new Date();

        await this.persistDelivery(delivery);

        log.info({
          webhookId: webhook.id,
          deliveryId: delivery.id,
          event: delivery.event,
          httpStatus: resp.status,
          elapsed,
        }, 'Webhook delivered successfully');
      } else {
        const respBody = await resp.text().catch(() => '');
        delivery.responseBody = respBody.slice(0, 500);
        throw new Error(`HTTP ${resp.status}: ${respBody.slice(0, 200)}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      delivery.error = errMsg;
      this.totalDeliveries += 1;
      this.failedDeliveries += 1;

      webhook.totalFailures += 1;
      webhook.consecutiveFailures += 1;
      webhook.lastFailureAt = new Date();
      webhook.lastFailureReason = errMsg;

      log.warn({
        webhookId: webhook.id,
        deliveryId: delivery.id,
        attempt: delivery.attempts,
        maxRetries: delivery.maxRetries,
        error: errMsg,
      }, 'Webhook delivery failed');

      // Retry or dead letter
      if (delivery.attempts < delivery.maxRetries) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, delivery.attempts - 1);
        delivery.nextRetryAt = new Date(Date.now() + delayMs);
        delivery.status = 'pending';

        const timer = setTimeout(
          () => this.attemptDelivery(webhook, delivery, bodyStr),
          delayMs,
        );
        this.retryTimers.set(delivery.id, timer);

        await this.persistDelivery(delivery);
      } else {
        // Dead letter
        delivery.status = 'dead_letter';
        await this.persistDelivery(delivery);
        await this.addToDeadLetter(webhook, delivery, errMsg);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dead letter queue
  // -------------------------------------------------------------------------

  private async addToDeadLetter(
    webhook: WebhookRegistration,
    delivery: DeliveryRecord,
    lastError: string,
  ): Promise<void> {
    const shouldDisable = webhook.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD;

    const entry: DeadLetterEntry = {
      id: uuidv4(),
      webhookId: webhook.id,
      webhookUrl: webhook.url,
      deliveryId: delivery.id,
      event: delivery.event,
      payload: delivery.payload,
      lastError,
      attempts: delivery.attempts,
      disabledWebhook: shouldDisable,
      createdAt: new Date(),
    };

    this.deadLetters.push(entry);
    if (this.deadLetters.length > MAX_DEAD_LETTERS) {
      this.deadLetters = this.deadLetters.slice(-Math.floor(MAX_DEAD_LETTERS * 0.8));
    }

    if (shouldDisable) {
      webhook.status = 'disabled';
      webhook.updatedAt = new Date();
      await this.persistWebhook(webhook);

      log.warn({
        webhookId: webhook.id,
        url: webhook.url,
        consecutiveFailures: webhook.consecutiveFailures,
      }, 'Webhook disabled after consecutive failures');

      broadcast('meow:sovereign', {
        type: 'webhooks:disabled',
        webhookId: webhook.id,
        url: webhook.url,
        reason: 'consecutive_failures',
        failures: webhook.consecutiveFailures,
      });
    }

    await this.persistDeadLetter(entry);

    broadcast('meow:sovereign', {
      type: 'webhooks:dead_letter',
      webhookId: webhook.id,
      deliveryId: delivery.id,
      event: delivery.event,
      disabled: shouldDisable,
    });
  }

  getDeadLetters(limit = 50): DeadLetterEntry[] {
    return this.deadLetters.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Test delivery
  // -------------------------------------------------------------------------

  async test(webhookId: string): Promise<{ success: boolean; httpStatus?: number; error?: string; durationMs: number }> {
    const webhook = this.webhooks.get(webhookId);
    if (!webhook) return { success: false, error: 'Webhook not found', durationMs: 0 };

    const testPayload: WebhookPayload = {
      event: 'molecule_completed',
      timestamp: new Date().toISOString(),
      data: { test: true, message: 'Gas Town webhook test delivery' },
      deliveryId: uuidv4(),
      webhookId,
    };

    const bodyStr = JSON.stringify(testPayload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'GasTown-Webhooks/1.0',
      'X-GasTown-Delivery-Id': testPayload.deliveryId,
      'X-GasTown-Event': 'test',
      ...(webhook.headers ?? {}),
    };

    if (webhook.secret) {
      headers['X-GasTown-Signature'] = signPayload(bodyStr, webhook.secret);
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      const resp = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;

      log.info({ webhookId, httpStatus: resp.status, durationMs }, 'Webhook test completed');

      return {
        success: resp.ok,
        httpStatus: resp.status,
        durationMs,
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): WebhookStats {
    const active = [...this.webhooks.values()].filter(w => w.status === 'active').length;
    const disabled = [...this.webhooks.values()].filter(w => w.status === 'disabled').length;

    const byEvent: Record<WebhookEventType, number> = {} as Record<WebhookEventType, number>;
    for (const evt of ALL_EVENT_TYPES) byEvent[evt] = 0;

    for (const d of this.deliveries) {
      if (d.status === 'delivered' && byEvent[d.event] !== undefined) {
        byEvent[d.event] += 1;
      }
    }

    return {
      totalRegistrations: this.webhooks.size,
      activeWebhooks: active,
      disabledWebhooks: disabled,
      totalDeliveries: this.totalDeliveries,
      successfulDeliveries: this.successfulDeliveries,
      failedDeliveries: this.failedDeliveries,
      deadLetterCount: this.deadLetters.length,
      avgDeliveryTimeMs: this.totalDeliveries > 0
        ? Math.round(this.totalDeliveryTimeMs / this.totalDeliveries)
        : 0,
      deliveriesByEvent: byEvent,
    };
  }

  getDeliveries(webhookId?: string, limit = 50): DeliveryRecord[] {
    let filtered = this.deliveries;
    if (webhookId) filtered = filtered.filter(d => d.webhookId === webhookId);
    return filtered.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistWebhook(wh: WebhookRegistration): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_outbound_webhooks (id, url, label, events, secret, status, headers, max_retries, consecutive_failures, total_deliveries, total_failures, last_delivery_at, last_failure_at, last_failure_reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url,
           label = EXCLUDED.label,
           events = EXCLUDED.events,
           secret = EXCLUDED.secret,
           status = EXCLUDED.status,
           headers = EXCLUDED.headers,
           max_retries = EXCLUDED.max_retries,
           consecutive_failures = EXCLUDED.consecutive_failures,
           total_deliveries = EXCLUDED.total_deliveries,
           total_failures = EXCLUDED.total_failures,
           last_delivery_at = EXCLUDED.last_delivery_at,
           last_failure_at = EXCLUDED.last_failure_at,
           last_failure_reason = EXCLUDED.last_failure_reason,
           updated_at = EXCLUDED.updated_at`,
        [
          wh.id, wh.url, wh.label, JSON.stringify(wh.events),
          wh.secret ?? null, wh.status, wh.headers ? JSON.stringify(wh.headers) : null,
          wh.maxRetries, wh.consecutiveFailures, wh.totalDeliveries, wh.totalFailures,
          wh.lastDeliveryAt ?? null, wh.lastFailureAt ?? null,
          wh.lastFailureReason ?? null, wh.createdAt, wh.updatedAt,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist webhook registration');
    }
  }

  private async persistDelivery(d: DeliveryRecord): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_webhook_deliveries (id, webhook_id, event, payload, status, http_status, response_body, attempts, max_retries, next_retry_at, error, delivered_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           http_status = EXCLUDED.http_status,
           response_body = EXCLUDED.response_body,
           attempts = EXCLUDED.attempts,
           next_retry_at = EXCLUDED.next_retry_at,
           error = EXCLUDED.error,
           delivered_at = EXCLUDED.delivered_at`,
        [
          d.id, d.webhookId, d.event, JSON.stringify(d.payload),
          d.status, d.httpStatus ?? null, d.responseBody ?? null,
          d.attempts, d.maxRetries, d.nextRetryAt ?? null,
          d.error ?? null, d.deliveredAt ?? null, d.createdAt,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist webhook delivery');
    }
  }

  private async persistDeadLetter(entry: DeadLetterEntry): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_webhook_dead_letters (id, webhook_id, webhook_url, delivery_id, event, payload, last_error, attempts, disabled_webhook, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT DO NOTHING`,
        [
          entry.id, entry.webhookId, entry.webhookUrl, entry.deliveryId,
          entry.event, JSON.stringify(entry.payload), entry.lastError,
          entry.attempts, entry.disabledWebhook,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist dead letter entry');
    }
  }

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;

      // Load webhooks
      const { rows: whRows } = await pool.query(
        `SELECT * FROM meow_outbound_webhooks WHERE status != 'deleted' ORDER BY created_at DESC LIMIT $1`,
        [MAX_WEBHOOKS],
      );

      for (const row of whRows) {
        const wh: WebhookRegistration = {
          id: row.id,
          url: row.url,
          label: row.label,
          events: typeof row.events === 'string' ? JSON.parse(row.events) : row.events,
          secret: row.secret,
          status: row.status,
          headers: row.headers ? (typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers) : undefined,
          maxRetries: row.max_retries ?? MAX_RETRIES,
          consecutiveFailures: row.consecutive_failures ?? 0,
          totalDeliveries: row.total_deliveries ?? 0,
          totalFailures: row.total_failures ?? 0,
          lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at) : undefined,
          lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at) : undefined,
          lastFailureReason: row.last_failure_reason,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
        this.webhooks.set(wh.id, wh);
      }

      // Load recent deliveries
      const { rows: delRows } = await pool.query(
        `SELECT * FROM meow_webhook_deliveries ORDER BY created_at DESC LIMIT $1`,
        [MAX_DELIVERIES_MEMORY],
      );

      for (const row of delRows.reverse()) {
        this.deliveries.push({
          id: row.id,
          webhookId: row.webhook_id,
          event: row.event,
          payload: row.payload,
          status: row.status,
          httpStatus: row.http_status,
          responseBody: row.response_body,
          attempts: row.attempts,
          maxRetries: row.max_retries ?? MAX_RETRIES,
          nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : undefined,
          error: row.error,
          deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
          createdAt: new Date(row.created_at),
        });
      }

      this.totalDeliveries = this.deliveries.length;
      this.successfulDeliveries = this.deliveries.filter(d => d.status === 'delivered').length;
      this.failedDeliveries = this.deliveries.filter(d => d.status === 'failed' || d.status === 'dead_letter').length;

      log.info({ webhooks: whRows.length, deliveries: delRows.length }, 'Loaded webhooks from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load webhooks from DB');
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private clearBatchTimer(webhookId: string): void {
    const timer = this.batchTimers.get(webhookId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(webhookId);
    }
  }

  private trimDeliveries(): void {
    if (this.deliveries.length > MAX_DELIVERIES_MEMORY) {
      this.deliveries = this.deliveries.slice(-Math.floor(MAX_DELIVERIES_MEMORY * 0.8));
    }
  }

  private evictDeletedWebhooks(): void {
    const deleted: string[] = [];
    for (const [id, wh] of this.webhooks) {
      if (wh.status === 'deleted') deleted.push(id);
    }
    for (const id of deleted) {
      this.webhooks.delete(id);
    }
  }

  /** Cleanup: clear all timers on shutdown */
  shutdown(): void {
    this.batchTimers.forEach((timer) => clearTimeout(timer));
    this.batchTimers.clear();
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    log.info('Webhooks outbound shut down');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: WebhooksOutbound | null = null;

export function getWebhooksOutbound(): WebhooksOutbound {
  if (!instance) {
    instance = new WebhooksOutbound();
  }
  return instance;
}
