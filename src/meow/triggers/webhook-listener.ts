/**
 * LP-021 — Webhook Listener Trigger
 *
 * Express middleware that fires molecules on incoming webhooks.
 * Registers endpoints for Shopify, Meta, and custom webhook events.
 * Each webhook: parse payload -> load formula TOML -> cook molecule -> pour (start execution).
 *
 * Rate limited: max 10 triggers per minute per webhook type.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { meowEngine } from '../engine';
import { createLogger } from '../../lib/logger';
import type { FeedEvent, FeedEventType } from '../types';

const log = createLogger('webhook-listener');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookTriggerDef {
  name: string;
  formulaName: string;
  varMapping: Record<string, string>; // payload path -> formula var name
  createdAt: Date;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const triggers = new Map<string, WebhookTriggerDef>();
const rateLimits = new Map<string, RateLimitEntry>();

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

/** Verify Shopify HMAC signature (SHA256, base64) */
function verifyShopifySignature(req: Request): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    log.warn('SHOPIFY_WEBHOOK_SECRET not set — skipping signature verification');
    return true; // Degrade gracefully if secret not configured
  }

  const hmacHeader = req.get('X-Shopify-Hmac-SHA256') || '';
  if (!hmacHeader) {
    log.warn('Missing X-Shopify-Hmac-SHA256 header');
    return false;
  }

  const rawBody = JSON.stringify(req.body || {});
  const computed = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

/** Verify Meta webhook via verify_token on GET challenge, or signature on POST */
function verifyMetaSignature(req: Request): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    log.warn('META_APP_SECRET not set — skipping signature verification');
    return true; // Degrade gracefully if secret not configured
  }

  const sigHeader = req.get('X-Hub-Signature-256') || '';
  if (!sigHeader) {
    log.warn('Missing X-Hub-Signature-256 header');
    return false;
  }

  const rawBody = JSON.stringify(req.body || {});
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkRateLimit(webhookType: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(webhookType);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(webhookType, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

function extractVar(payload: Record<string, unknown>, dotPath: string): string {
  const parts = dotPath.split('.');
  let current: unknown = payload;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return '';
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current !== null && current !== undefined ? String(current) : '';
}

function buildVars(
  payload: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [payloadPath, varName] of Object.entries(mapping)) {
    vars[varName] = extractVar(payload, payloadPath);
  }
  return vars;
}

async function loadFormulaContent(formulaName: string): Promise<string | null> {
  const formulasDir = path.resolve(__dirname, '..', 'formulas');
  const filePath = path.join(formulasDir, `${formulaName}.formula.toml`);

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    log.error({ formulaName, filePath }, 'Formula file not found');
    return null;
  }
}

async function logWebhookEvent(
  webhookType: string,
  payload: Record<string, unknown>,
  moleculeId: string | null,
  error?: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO feed_events (type, source, message, severity, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'molecule_started' as FeedEventType,
        'webhook-listener',
        error
          ? `Webhook ${webhookType} failed: ${error}`
          : `Webhook ${webhookType} fired molecule ${moleculeId}`,
        error ? 'warning' : 'info',
        JSON.stringify({ webhookType, moleculeId, payloadKeys: Object.keys(payload) }),
        new Date(),
      ],
    );
  } catch (err) {
    log.error({ err }, 'Failed to log webhook event');
  }
}

async function fireMolecule(
  formulaName: string,
  vars: Record<string, string>,
  source: string,
): Promise<string | null> {
  const content = await loadFormulaContent(formulaName);
  if (!content) return null;

  try {
    const proto = await meowEngine.cook(content, vars);
    const molecule = await meowEngine.pour(proto.id);

    const event: FeedEvent = {
      id: uuidv4(),
      type: 'molecule_started',
      source: 'webhook-listener',
      moleculeId: molecule.id,
      message: `Webhook trigger "${source}" fired formula "${formulaName}" -> molecule ${molecule.id}`,
      severity: 'info',
      metadata: { formulaName, vars, source },
      timestamp: new Date(),
    };
    broadcast('meow:feed', event);

    log.info({ moleculeId: molecule.id, formulaName, source }, 'Webhook fired molecule');
    return molecule.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, formulaName, source }, 'Failed to fire molecule from webhook');
    throw new Error(`Failed to fire molecule: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Built-in webhook triggers
// ---------------------------------------------------------------------------

// Shopify: fires fulfillment formula on new order
triggers.set('shopify', {
  name: 'shopify',
  formulaName: 'campaign-launch',
  varMapping: {
    'order_number': 'order_id',
    'customer.email': 'customer_email',
    'line_items.0.title': 'product_name',
    'total_price': 'order_value',
    'shipping_address.country_code': 'country',
  },
  createdAt: new Date(),
});

// Meta: fires WA funnel formula on new lead
triggers.set('meta', {
  name: 'meta',
  formulaName: 'customer-recovery',
  varMapping: {
    'entry.0.changes.0.value.leadgen_id': 'lead_id',
    'entry.0.changes.0.value.page_id': 'page_id',
    'entry.0.id': 'ad_account_id',
  },
  createdAt: new Date(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const webhookRouter = Router();

/** POST /api/meow/webhooks/shopify */
webhookRouter.post('/shopify', async (req: Request, res: Response) => {
  const webhookType = 'shopify';

  // Verify Shopify HMAC signature
  if (!verifyShopifySignature(req)) {
    log.warn({ webhookType }, 'Invalid Shopify webhook signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  if (!checkRateLimit(webhookType)) {
    log.warn({ webhookType }, 'Rate limit exceeded');
    await logWebhookEvent(webhookType, req.body || {}, null, 'Rate limit exceeded');
    return res.status(429).json({ error: 'Rate limit exceeded — max 10 triggers per minute' });
  }

  const trigger = triggers.get(webhookType);
  if (!trigger) {
    return res.status(404).json({ error: `No trigger registered for ${webhookType}` });
  }

  const payload = (req.body || {}) as Record<string, unknown>;
  const vars = buildVars(payload, trigger.varMapping);

  try {
    const moleculeId = await fireMolecule(trigger.formulaName, vars, webhookType);
    await logWebhookEvent(webhookType, payload, moleculeId);
    return res.json({ ok: true, moleculeId, formulaName: trigger.formulaName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logWebhookEvent(webhookType, payload, null, msg);
    return res.status(500).json({ error: msg });
  }
});

/** GET /api/meow/webhooks/meta — Meta webhook verification challenge */
webhookRouter.get('/meta', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.META_VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    log.info('Meta webhook verification challenge accepted');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Verification failed' });
});

/** POST /api/meow/webhooks/meta */
webhookRouter.post('/meta', async (req: Request, res: Response) => {
  const webhookType = 'meta';

  // Verify Meta signature
  if (!verifyMetaSignature(req)) {
    log.warn({ webhookType }, 'Invalid Meta webhook signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  if (!checkRateLimit(webhookType)) {
    log.warn({ webhookType }, 'Rate limit exceeded');
    await logWebhookEvent(webhookType, req.body || {}, null, 'Rate limit exceeded');
    return res.status(429).json({ error: 'Rate limit exceeded — max 10 triggers per minute' });
  }

  const trigger = triggers.get(webhookType);
  if (!trigger) {
    return res.status(404).json({ error: `No trigger registered for ${webhookType}` });
  }

  const payload = (req.body || {}) as Record<string, unknown>;
  const vars = buildVars(payload, trigger.varMapping);

  try {
    const moleculeId = await fireMolecule(trigger.formulaName, vars, webhookType);
    await logWebhookEvent(webhookType, payload, moleculeId);
    return res.json({ ok: true, moleculeId, formulaName: trigger.formulaName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logWebhookEvent(webhookType, payload, null, msg);
    return res.status(500).json({ error: msg });
  }
});

/** POST /api/meow/webhooks/custom/:name — fires named formula with payload as vars */
webhookRouter.post('/custom/:name', async (req: Request, res: Response) => {
  const { name } = req.params;
  const webhookType = `custom:${name}`;

  if (!checkRateLimit(webhookType)) {
    log.warn({ webhookType }, 'Rate limit exceeded');
    await logWebhookEvent(webhookType, req.body || {}, null, 'Rate limit exceeded');
    return res.status(429).json({ error: 'Rate limit exceeded — max 10 triggers per minute' });
  }

  const trigger = triggers.get(name);
  if (!trigger) {
    return res.status(404).json({ error: `No custom trigger "${name}" registered` });
  }

  const payload = (req.body || {}) as Record<string, unknown>;
  const vars = buildVars(payload, trigger.varMapping);

  try {
    const moleculeId = await fireMolecule(trigger.formulaName, vars, webhookType);
    await logWebhookEvent(webhookType, payload, moleculeId);
    return res.json({ ok: true, moleculeId, formulaName: trigger.formulaName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logWebhookEvent(webhookType, payload, null, msg);
    return res.status(500).json({ error: msg });
  }
});

/** GET /api/meow/webhooks — list all registered webhook triggers */
webhookRouter.get('/', (_req: Request, res: Response) => {
  const list = Array.from(triggers.values()).map(t => ({
    name: t.name,
    formulaName: t.formulaName,
    varMapping: t.varMapping,
    createdAt: t.createdAt,
  }));
  res.json({ triggers: list, rateLimitMax: RATE_LIMIT_MAX, rateLimitWindowMs: RATE_LIMIT_WINDOW_MS });
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a custom webhook trigger.
 * After registration, POST to /api/meow/webhooks/custom/:name will fire the formula.
 */
export function registerWebhookTrigger(
  name: string,
  formulaName: string,
  varMapping: Record<string, string>,
): WebhookTriggerDef {
  const def: WebhookTriggerDef = {
    name,
    formulaName,
    varMapping,
    createdAt: new Date(),
  };
  triggers.set(name, def);

  log.info({ name, formulaName }, 'Webhook trigger registered');

  const event: FeedEvent = {
    id: uuidv4(),
    type: 'system_health',
    source: 'webhook-listener',
    message: `Webhook trigger "${name}" registered for formula "${formulaName}"`,
    severity: 'info',
    metadata: { name, formulaName, varMapping },
    timestamp: new Date(),
  };
  broadcast('meow:feed', event);

  return def;
}

/**
 * Remove a webhook trigger by name.
 */
export function removeWebhookTrigger(name: string): boolean {
  const existed = triggers.delete(name);
  if (existed) {
    log.info({ name }, 'Webhook trigger removed');
  }
  return existed;
}

/**
 * List all registered webhook triggers.
 */
export function listWebhookTriggers(): WebhookTriggerDef[] {
  return Array.from(triggers.values());
}
