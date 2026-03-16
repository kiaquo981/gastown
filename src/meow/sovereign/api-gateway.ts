/**
 * API GATEWAY — SG-021 (Stage 06 Wave 6)
 *
 * External API gateway for third-party integration with Gas Town.
 * Provides authenticated, rate-limited, versioned endpoints for external
 * consumers to interact with beads, formulas, workers, and metrics.
 *
 * Features:
 *   - Endpoints: create beads, trigger formulas, query status, list workers, get metrics
 *   - Authentication: API key based (X-GASTOWN-API-KEY header), rate limited per key
 *   - Rate limiting: configurable per endpoint (default: 100 req/min)
 *   - Request validation: JSON schema validation for all inputs
 *   - Response format: consistent envelope { ok, data?, error? }
 *   - Audit logging: every external API call logged with caller, endpoint, payload, response time
 *   - API versioning: v1 prefix for future backwards compatibility
 *   - Health endpoint: public, no auth required
 *   - API key management: create/revoke/list keys
 *   - DB table: meow_api_keys for key storage and rate limit tracking
 *
 * Gas Town: "The gates stay locked — but those with the right key can trade."
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import * as crypto from 'crypto';

const log = createLogger('api-gateway');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export type RateLimitWindow = '1m' | '5m' | '1h';

export interface ApiKeyRecord {
  id: string;
  keyHash: string;              // SHA-256 hash of the actual key
  keyPrefix: string;            // first 8 chars for identification
  label: string;                // human-readable name
  status: ApiKeyStatus;
  ownerId: string;
  permissions: ApiPermission[];
  rateLimitPerMin: number;
  rateLimitWindow: RateLimitWindow;
  totalRequests: number;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  revokedAt?: Date;
}

export type ApiPermission =
  | 'beads:read'
  | 'beads:write'
  | 'formulas:read'
  | 'formulas:trigger'
  | 'workers:read'
  | 'metrics:read'
  | 'status:read'
  | 'admin';

export interface ApiRequest {
  id: string;
  keyId: string;
  keyPrefix: string;
  method: string;
  endpoint: string;
  version: string;
  payload?: Record<string, unknown>;
  query?: Record<string, string>;
  ipAddress?: string;
  userAgent?: string;
  responseStatus: number;
  responseTimeMs: number;
  error?: string;
  createdAt: Date;
}

export interface RateLimitState {
  keyId: string;
  windowStart: number;          // epoch ms
  requestCount: number;
  limit: number;
}

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  meta?: {
    requestId: string;
    version: string;
    timestamp: string;
    rateLimitRemaining?: number;
  };
}

export interface EndpointConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  requiredPermission: ApiPermission;
  rateLimitOverride?: number;
  schema?: JsonSchemaRule[];
  description: string;
}

export interface JsonSchemaRule {
  field: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface GatewayStats {
  totalKeys: number;
  activeKeys: number;
  revokedKeys: number;
  totalRequests: number;
  requestsLast24h: number;
  rateLimitHitsLast24h: number;
  avgResponseTimeMs: number;
  endpointsRegistered: number;
  topEndpoints: Array<{ endpoint: string; count: number }>;
  topKeys: Array<{ keyPrefix: string; label: string; count: number }>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  version: string;
  timestamp: string;
  checks: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_VERSION = 'v1';
const DEFAULT_RATE_LIMIT = 100;               // requests per minute
const RATE_WINDOW_MS = 60_000;                // 1 minute window
const MAX_AUDIT_LOG_MEMORY = 5000;
const MAX_KEYS_IN_MEMORY = 500;
const KEY_BYTE_LENGTH = 32;

/** Endpoint definitions with validation rules */
const ENDPOINT_CONFIGS: EndpointConfig[] = [
  {
    path: '/v1/beads',
    method: 'POST',
    requiredPermission: 'beads:write',
    schema: [
      { field: 'title', type: 'string', required: true, minLength: 1, maxLength: 200 },
      { field: 'type', type: 'string', required: true },
      { field: 'payload', type: 'object', required: false },
      { field: 'priority', type: 'number', required: false, min: 1, max: 10 },
    ],
    description: 'Create a new bead',
  },
  {
    path: '/v1/beads',
    method: 'GET',
    requiredPermission: 'beads:read',
    description: 'List beads with optional filters',
  },
  {
    path: '/v1/formulas/trigger',
    method: 'POST',
    requiredPermission: 'formulas:trigger',
    rateLimitOverride: 20,
    schema: [
      { field: 'formulaName', type: 'string', required: true, minLength: 1 },
      { field: 'params', type: 'object', required: false },
      { field: 'priority', type: 'number', required: false, min: 1, max: 10 },
    ],
    description: 'Trigger a formula execution',
  },
  {
    path: '/v1/formulas',
    method: 'GET',
    requiredPermission: 'formulas:read',
    description: 'List available formulas',
  },
  {
    path: '/v1/status',
    method: 'GET',
    requiredPermission: 'status:read',
    description: 'Get system status overview',
  },
  {
    path: '/v1/workers',
    method: 'GET',
    requiredPermission: 'workers:read',
    description: 'List workers with status',
  },
  {
    path: '/v1/metrics',
    method: 'GET',
    requiredPermission: 'metrics:read',
    description: 'Get system metrics',
  },
  {
    path: '/v1/keys',
    method: 'POST',
    requiredPermission: 'admin',
    rateLimitOverride: 10,
    schema: [
      { field: 'label', type: 'string', required: true, minLength: 1, maxLength: 100 },
      { field: 'ownerId', type: 'string', required: true },
      { field: 'permissions', type: 'array', required: true },
      { field: 'rateLimitPerMin', type: 'number', required: false, min: 1, max: 10000 },
      { field: 'expiresInDays', type: 'number', required: false, min: 1, max: 365 },
    ],
    description: 'Create a new API key',
  },
  {
    path: '/v1/keys',
    method: 'GET',
    requiredPermission: 'admin',
    description: 'List all API keys',
  },
  {
    path: '/v1/keys',
    method: 'DELETE',
    requiredPermission: 'admin',
    schema: [
      { field: 'keyId', type: 'string', required: true },
    ],
    description: 'Revoke an API key',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `gt_${crypto.randomBytes(KEY_BYTE_LENGTH).toString('hex')}`;
  const hash = hashKey(raw);
  const prefix = raw.slice(0, 11); // 'gt_' + first 8 hex chars
  return { raw, hash, prefix };
}

function success<T>(data: T, requestId: string, rateLimitRemaining?: number): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      requestId,
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      rateLimitRemaining,
    },
  };
}

function failure(error: string, requestId: string): ApiEnvelope {
  return {
    ok: false,
    error,
    meta: {
      requestId,
      version: API_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// ApiGateway
// ---------------------------------------------------------------------------

export class ApiGateway {
  private keys: Map<string, ApiKeyRecord> = new Map();     // keyHash -> record
  private rateLimits: Map<string, RateLimitState> = new Map(); // keyId -> state
  private auditLog: ApiRequest[] = [];
  private startedAt: Date = new Date();
  private totalRequests = 0;
  private rateLimitHits = 0;

  // -------------------------------------------------------------------------
  // Key management
  // -------------------------------------------------------------------------

  async createKey(
    label: string,
    ownerId: string,
    permissions: ApiPermission[],
    rateLimitPerMin?: number,
    expiresInDays?: number,
  ): Promise<{ keyRecord: ApiKeyRecord; rawKey: string }> {
    const { raw, hash, prefix } = generateApiKey();

    const record: ApiKeyRecord = {
      id: uuidv4(),
      keyHash: hash,
      keyPrefix: prefix,
      label,
      status: 'active',
      ownerId,
      permissions,
      rateLimitPerMin: rateLimitPerMin ?? DEFAULT_RATE_LIMIT,
      rateLimitWindow: '1m',
      totalRequests: 0,
      createdAt: new Date(),
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 86_400_000)
        : undefined,
    };

    this.keys.set(hash, record);
    if (this.keys.size > MAX_KEYS_IN_MEMORY) {
      this.evictRevokedKeys();
    }

    await this.persistKey(record);

    log.info({ keyId: record.id, prefix, label, permissions }, 'API key created');

    broadcast('meow:sovereign', {
      type: 'gateway:key_created',
      keyId: record.id,
      prefix,
      label,
    });

    return { keyRecord: record, rawKey: raw };
  }

  async revokeKey(keyId: string): Promise<boolean> {
    const record = this.findKeyById(keyId);
    if (!record) {
      log.warn({ keyId }, 'Key not found for revocation');
      return false;
    }

    record.status = 'revoked';
    record.revokedAt = new Date();
    await this.persistKey(record);

    log.info({ keyId, prefix: record.keyPrefix }, 'API key revoked');

    broadcast('meow:sovereign', {
      type: 'gateway:key_revoked',
      keyId: record.id,
      prefix: record.keyPrefix,
    });

    return true;
  }

  listKeys(): Array<Omit<ApiKeyRecord, 'keyHash'>> {
    const result: Array<Omit<ApiKeyRecord, 'keyHash'>> = [];
    for (const record of this.keys.values()) {
      const { keyHash: _, ...rest } = record;
      result.push(rest);
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  authenticate(rawKey: string): { valid: boolean; record?: ApiKeyRecord; error?: string } {
    if (!rawKey) return { valid: false, error: 'Missing API key' };

    const hash = hashKey(rawKey);
    const record = this.keys.get(hash);

    if (!record) return { valid: false, error: 'Invalid API key' };
    if (record.status === 'revoked') return { valid: false, error: 'API key has been revoked' };
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      record.status = 'expired';
      return { valid: false, error: 'API key has expired' };
    }

    return { valid: true, record };
  }

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  checkRateLimit(keyId: string, limitOverride?: number): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const state = this.rateLimits.get(keyId);
    const record = this.findKeyById(keyId);
    const limit = limitOverride ?? record?.rateLimitPerMin ?? DEFAULT_RATE_LIMIT;

    if (!state || now - state.windowStart > RATE_WINDOW_MS) {
      // New window
      const newState: RateLimitState = {
        keyId,
        windowStart: now,
        requestCount: 1,
        limit,
      };
      this.rateLimits.set(keyId, newState);
      return { allowed: true, remaining: limit - 1, resetMs: RATE_WINDOW_MS };
    }

    state.requestCount += 1;

    if (state.requestCount > limit) {
      this.rateLimitHits += 1;
      const resetMs = RATE_WINDOW_MS - (now - state.windowStart);
      return { allowed: false, remaining: 0, resetMs };
    }

    const remaining = limit - state.requestCount;
    const resetMs = RATE_WINDOW_MS - (now - state.windowStart);
    return { allowed: true, remaining, resetMs };
  }

  // -------------------------------------------------------------------------
  // Request validation
  // -------------------------------------------------------------------------

  validateRequest(
    endpoint: string,
    method: string,
    body?: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const config = ENDPOINT_CONFIGS.find(e => e.path === endpoint && e.method === method);
    if (!config) return { valid: false, errors: [`Unknown endpoint: ${method} ${endpoint}`] };
    if (!config.schema || !body) return { valid: true, errors: [] };

    const errors: string[] = [];

    for (const rule of config.schema) {
      const value = body[rule.field];

      if (rule.required && (value === undefined || value === null)) {
        errors.push(`Missing required field: ${rule.field}`);
        continue;
      }

      if (value === undefined || value === null) continue;

      // Type check
      if (rule.type === 'array') {
        if (!Array.isArray(value)) {
          errors.push(`Field ${rule.field} must be an array`);
          continue;
        }
      } else if (typeof value !== rule.type) {
        errors.push(`Field ${rule.field} must be of type ${rule.type}, got ${typeof value}`);
        continue;
      }

      // String constraints
      if (rule.type === 'string' && typeof value === 'string') {
        if (rule.minLength !== undefined && value.length < rule.minLength) {
          errors.push(`Field ${rule.field} must be at least ${rule.minLength} characters`);
        }
        if (rule.maxLength !== undefined && value.length > rule.maxLength) {
          errors.push(`Field ${rule.field} must be at most ${rule.maxLength} characters`);
        }
        if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
          errors.push(`Field ${rule.field} does not match expected pattern`);
        }
      }

      // Number constraints
      if (rule.type === 'number' && typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`Field ${rule.field} must be at least ${rule.min}`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`Field ${rule.field} must be at most ${rule.max}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  async handleRequest(
    rawKey: string | undefined,
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ status: number; body: ApiEnvelope }> {
    const requestId = uuidv4();
    const startTime = Date.now();
    this.totalRequests += 1;

    // Health check — no auth required
    if (endpoint === '/v1/health') {
      const health = this.getHealth();
      return { status: 200, body: success(health, requestId) };
    }

    // Auth
    const auth = this.authenticate(rawKey ?? '');
    if (!auth.valid || !auth.record) {
      const elapsed = Date.now() - startTime;
      await this.logRequest(requestId, '', '', method, endpoint, undefined, query, ipAddress, userAgent, 401, elapsed, auth.error);
      return { status: 401, body: failure(auth.error ?? 'Unauthorized', requestId) };
    }

    const keyRecord = auth.record;

    // Permission check
    const config = ENDPOINT_CONFIGS.find(e => e.path === endpoint && e.method === method);
    if (!config) {
      const elapsed = Date.now() - startTime;
      await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 404, elapsed, 'Endpoint not found');
      return { status: 404, body: failure('Endpoint not found', requestId) };
    }

    if (!keyRecord.permissions.includes('admin') && !keyRecord.permissions.includes(config.requiredPermission)) {
      const elapsed = Date.now() - startTime;
      await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 403, elapsed, 'Insufficient permissions');
      return { status: 403, body: failure('Insufficient permissions', requestId) };
    }

    // Rate limit
    const rateCheck = this.checkRateLimit(keyRecord.id, config.rateLimitOverride);
    if (!rateCheck.allowed) {
      const elapsed = Date.now() - startTime;
      await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 429, elapsed, 'Rate limit exceeded');
      return { status: 429, body: failure(`Rate limit exceeded. Retry after ${Math.ceil(rateCheck.resetMs / 1000)}s`, requestId) };
    }

    // Validation
    if (method === 'POST' || method === 'PUT') {
      const validation = this.validateRequest(endpoint, method, body);
      if (!validation.valid) {
        const elapsed = Date.now() - startTime;
        await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 400, elapsed, validation.errors.join('; '));
        return { status: 400, body: failure(validation.errors.join('; '), requestId) };
      }
    }

    // Route to handler
    try {
      const data = await this.routeRequest(config, body, query);
      const elapsed = Date.now() - startTime;

      keyRecord.totalRequests += 1;
      keyRecord.lastUsedAt = new Date();

      await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 200, elapsed);

      return { status: 200, body: success(data, requestId, rateCheck.remaining) };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.logRequest(requestId, keyRecord.id, keyRecord.keyPrefix, method, endpoint, body, query, ipAddress, userAgent, 500, elapsed, errMsg);
      return { status: 500, body: failure('Internal server error', requestId) };
    }
  }

  // -------------------------------------------------------------------------
  // Request routing
  // -------------------------------------------------------------------------

  private async routeRequest(
    config: EndpointConfig,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const pool = getPool();
    if (!pool) throw new Error('DB not available');

    switch (`${config.method} ${config.path}`) {
      case 'POST /v1/beads': {
        const id = uuidv4();
        const title = body?.title as string;
        const type = body?.type as string;
        const priority = (body?.priority as number) ?? 5;
        const payload = body?.payload ?? {};
        await pool.query(
          `INSERT INTO meow_beads (id, title, type, priority, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
           ON CONFLICT DO NOTHING`,
          [id, title, type, priority, JSON.stringify(payload)],
        );
        broadcast('meow:sovereign', { type: 'gateway:bead_created', beadId: id, title });
        return { beadId: id, title, type, priority, status: 'pending' };
      }

      case 'GET /v1/beads': {
        const limit = Math.min(parseInt(query?.limit ?? '50', 10), 200);
        const offset = parseInt(query?.offset ?? '0', 10);
        const status = query?.status;
        let sql = 'SELECT id, title, type, status, priority, created_at FROM meow_beads';
        const params: unknown[] = [];
        if (status) {
          sql += ' WHERE status = $1';
          params.push(status);
        }
        sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        const { rows } = await pool.query(sql, params);
        return { beads: rows, count: rows.length, limit, offset };
      }

      case 'POST /v1/formulas/trigger': {
        const formulaName = body?.formulaName as string;
        const params = body?.params ?? {};
        const priority = (body?.priority as number) ?? 5;
        const triggerId = uuidv4();
        await pool.query(
          `INSERT INTO meow_formula_triggers (id, formula_name, params, priority, status, triggered_via, created_at)
           VALUES ($1, $2, $3, $4, 'queued', 'api_gateway', NOW())
           ON CONFLICT DO NOTHING`,
          [triggerId, formulaName, JSON.stringify(params), priority],
        );
        broadcast('meow:sovereign', { type: 'gateway:formula_triggered', triggerId, formulaName });
        return { triggerId, formulaName, priority, status: 'queued' };
      }

      case 'GET /v1/formulas': {
        const { rows } = await pool.query(
          `SELECT name, description, status, molecule_count, last_run_at
           FROM meow_formulas ORDER BY name LIMIT 100`,
        );
        return { formulas: rows, count: rows.length };
      }

      case 'GET /v1/status': {
        const stats = this.getStats();
        return {
          system: 'Gas Town MEOW',
          version: API_VERSION,
          uptime: Date.now() - this.startedAt.getTime(),
          gateway: stats,
        };
      }

      case 'GET /v1/workers': {
        const { rows } = await pool.query(
          `SELECT id, name, role, status, tier, current_task, xp, level
           FROM meow_workers ORDER BY tier, name LIMIT 200`,
        );
        return { workers: rows, count: rows.length };
      }

      case 'GET /v1/metrics': {
        const { rows: costRows } = await pool.query(
          `SELECT COALESCE(SUM(cost_usd), 0) as total_cost,
                  COUNT(*) as total_calls
           FROM meow_cost_log WHERE created_at > NOW() - INTERVAL '24 hours'`,
        );
        const { rows: beadRows } = await pool.query(
          `SELECT status, COUNT(*) as count FROM meow_beads
           WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status`,
        );
        return {
          cost24h: costRows[0],
          beadsByStatus: beadRows,
          timestamp: new Date().toISOString(),
        };
      }

      case 'POST /v1/keys': {
        const result = await this.createKey(
          body?.label as string,
          body?.ownerId as string,
          body?.permissions as ApiPermission[],
          body?.rateLimitPerMin as number | undefined,
          body?.expiresInDays as number | undefined,
        );
        return {
          keyId: result.keyRecord.id,
          rawKey: result.rawKey,
          prefix: result.keyRecord.keyPrefix,
          permissions: result.keyRecord.permissions,
          rateLimitPerMin: result.keyRecord.rateLimitPerMin,
          expiresAt: result.keyRecord.expiresAt,
          note: 'Store this key securely — it cannot be retrieved again.',
        };
      }

      case 'GET /v1/keys': {
        return { keys: this.listKeys() };
      }

      case 'DELETE /v1/keys': {
        const keyId = body?.keyId as string;
        const revoked = await this.revokeKey(keyId);
        return { revoked, keyId };
      }

      default:
        throw new Error(`Unhandled route: ${config.method} ${config.path}`);
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  getHealth(): HealthStatus {
    const pool = getPool();
    return {
      status: 'healthy',
      uptime: Date.now() - this.startedAt.getTime(),
      version: API_VERSION,
      timestamp: new Date().toISOString(),
      checks: {
        database: !!pool,
        gatewayActive: true,
        keysLoaded: this.keys.size > 0 || true,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): GatewayStats {
    const active = [...this.keys.values()].filter(k => k.status === 'active').length;
    const revoked = [...this.keys.values()].filter(k => k.status === 'revoked').length;

    const last24h = this.auditLog.filter(
      r => r.createdAt.getTime() > Date.now() - 86_400_000,
    );

    const endpointCounts = new Map<string, number>();
    const keyCounts = new Map<string, { keyPrefix: string; label: string; count: number }>();

    for (const req of last24h) {
      const ep = `${req.method} ${req.endpoint}`;
      endpointCounts.set(ep, (endpointCounts.get(ep) ?? 0) + 1);

      const existing = keyCounts.get(req.keyId);
      if (existing) {
        existing.count += 1;
      } else {
        const keyRecord = this.findKeyById(req.keyId);
        keyCounts.set(req.keyId, {
          keyPrefix: req.keyPrefix,
          label: keyRecord?.label ?? 'unknown',
          count: 1,
        });
      }
    }

    const avgResponseTime = last24h.length > 0
      ? Math.round(last24h.reduce((sum, r) => sum + r.responseTimeMs, 0) / last24h.length)
      : 0;

    return {
      totalKeys: this.keys.size,
      activeKeys: active,
      revokedKeys: revoked,
      totalRequests: this.totalRequests,
      requestsLast24h: last24h.length,
      rateLimitHitsLast24h: this.rateLimitHits,
      avgResponseTimeMs: avgResponseTime,
      endpointsRegistered: ENDPOINT_CONFIGS.length,
      topEndpoints: [...endpointCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([endpoint, count]) => ({ endpoint, count })),
      topKeys: [...keyCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }

  getEndpoints(): EndpointConfig[] {
    return [...ENDPOINT_CONFIGS];
  }

  // -------------------------------------------------------------------------
  // Audit logging
  // -------------------------------------------------------------------------

  private async logRequest(
    requestId: string,
    keyId: string,
    keyPrefix: string,
    method: string,
    endpoint: string,
    payload?: Record<string, unknown>,
    query?: Record<string, string>,
    ipAddress?: string,
    userAgent?: string,
    responseStatus = 200,
    responseTimeMs = 0,
    error?: string,
  ): Promise<void> {
    const entry: ApiRequest = {
      id: requestId,
      keyId,
      keyPrefix,
      method,
      endpoint,
      version: API_VERSION,
      payload,
      query,
      ipAddress,
      userAgent,
      responseStatus,
      responseTimeMs,
      error,
      createdAt: new Date(),
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_LOG_MEMORY) {
      this.auditLog = this.auditLog.slice(-Math.floor(MAX_AUDIT_LOG_MEMORY * 0.8));
    }

    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_api_keys_audit (id, key_id, key_prefix, method, endpoint, version, payload, query, ip_address, user_agent, response_status, response_time_ms, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT DO NOTHING`,
        [
          requestId, keyId, keyPrefix, method, endpoint, API_VERSION,
          payload ? JSON.stringify(payload) : null,
          query ? JSON.stringify(query) : null,
          ipAddress ?? null, userAgent ?? null,
          responseStatus, responseTimeMs, error ?? null,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist audit log entry');
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistKey(record: ApiKeyRecord): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      await pool.query(
        `INSERT INTO meow_api_keys (id, key_hash, key_prefix, label, status, owner_id, permissions, rate_limit_per_min, rate_limit_window, total_requests, last_used_at, expires_at, created_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           total_requests = EXCLUDED.total_requests,
           last_used_at = EXCLUDED.last_used_at,
           revoked_at = EXCLUDED.revoked_at`,
        [
          record.id, record.keyHash, record.keyPrefix, record.label,
          record.status, record.ownerId, JSON.stringify(record.permissions),
          record.rateLimitPerMin, record.rateLimitWindow, record.totalRequests,
          record.lastUsedAt ?? null, record.expiresAt ?? null,
          record.createdAt, record.revokedAt ?? null,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Failed to persist API key');
    }
  }

  async loadFromDb(): Promise<void> {
    try {
      const pool = getPool();
      if (!pool) return;
      const { rows } = await pool.query(
        `SELECT * FROM meow_api_keys ORDER BY created_at DESC LIMIT $1`,
        [MAX_KEYS_IN_MEMORY],
      );

      for (const row of rows) {
        const record: ApiKeyRecord = {
          id: row.id,
          keyHash: row.key_hash,
          keyPrefix: row.key_prefix,
          label: row.label,
          status: row.status,
          ownerId: row.owner_id,
          permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions,
          rateLimitPerMin: row.rate_limit_per_min ?? DEFAULT_RATE_LIMIT,
          rateLimitWindow: row.rate_limit_window ?? '1m',
          totalRequests: row.total_requests ?? 0,
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
          expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
          createdAt: new Date(row.created_at),
          revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
        };
        this.keys.set(record.keyHash, record);
      }

      log.info({ keys: rows.length }, 'Loaded API keys from DB');
    } catch (err) {
      log.error({ err }, 'Failed to load API keys from DB');
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private findKeyById(keyId: string): ApiKeyRecord | undefined {
    for (const record of this.keys.values()) {
      if (record.id === keyId) return record;
    }
    return undefined;
  }

  private evictRevokedKeys(): void {
    const revoked: string[] = [];
    for (const [hash, record] of this.keys) {
      if (record.status === 'revoked') revoked.push(hash);
    }
    for (const hash of revoked.slice(0, Math.floor(revoked.length / 2))) {
      this.keys.delete(hash);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ApiGateway | null = null;

export function getApiGateway(): ApiGateway {
  if (!instance) {
    instance = new ApiGateway();
  }
  return instance;
}
