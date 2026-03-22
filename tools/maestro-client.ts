#!/usr/bin/env npx tsx
/**
 * Gas Town Maestro Client — Local Agent Bridge
 *
 * Standalone script that runs on your machine. It:
 * 1. Detects Claude Code CLI
 * 2. Registers with Gas Town backend as a Maestro instance
 * 3. Receives dispatched work via HTTP callback
 * 4. Spawns Claude Code to execute the work
 * 5. Reports results back to Gas Town
 *
 * Usage:
 *   npx tsx tools/maestro-client.ts
 *
 * Environment:
 *   GASTOWN_URL       — Backend URL (default: https://gastown-production.up.railway.app)
 *   GASTOWN_API_KEY   — API key for mutations
 *   MAESTRO_PORT      — Local callback port (default: 9090)
 *   MAESTRO_MAX       — Max concurrent sessions (default: 2)
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const GASTOWN_URL = process.env.GASTOWN_URL || 'https://gastown-production.up.railway.app';
const API_KEY = process.env.GASTOWN_API_KEY || 'gt_a8f3c2e1d4b6789012345678901234567890abcd1234';
const LOCAL_PORT = parseInt(process.env.MAESTRO_PORT || '9090', 10);
const MAX_SESSIONS = parseInt(process.env.MAESTRO_MAX || '2', 10);
const HEARTBEAT_MS = 30_000;

let maestroId = '';
let activeSessions = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let server: http.Server | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 19);
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [MAESTRO] ${msg}${extra}`);
}

function logError(msg: string, err?: unknown) {
  const ts = new Date().toISOString().slice(11, 19);
  const errMsg = err instanceof Error ? err.message : String(err || '');
  console.error(`[${ts}] [MAESTRO] ERROR: ${msg}${errMsg ? ' — ' + errMsg : ''}`);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${GASTOWN_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Step 1: Detect Claude ─────────────────────────────────────────────────────

function detectClaude(): { path: string; version: string } {
  try {
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    let version = 'unknown';
    try {
      version = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch { /* version detection optional */ }
    return { path: claudePath, version };
  } catch {
    logError('Claude Code CLI not found in PATH. Install it first: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
}

// ── Step 2: Register ──────────────────────────────────────────────────────────

async function register(): Promise<string> {
  const claude = detectClaude();
  log(`Claude detected: ${claude.path} (${claude.version})`);

  const result = await api('POST', '/api/meow/town/maestro/register', {
    callbackUrl: `http://localhost:${LOCAL_PORT}`,
    name: `Maestro-${os.hostname().split('.')[0]}`,
    capabilities: ['code', 'refactor', 'test', 'review', 'devops'],
    maxSessions: MAX_SESSIONS,
    hostname: os.hostname(),
    os: process.platform,
    version: claude.version,
  }) as { instance?: { id: string } };

  const id = result?.instance?.id;
  if (!id) throw new Error('Registration failed — no instance ID returned');
  return id;
}

// ── Step 3: Heartbeat ─────────────────────────────────────────────────────────

async function sendHeartbeat() {
  try {
    await api('POST', '/api/meow/town/maestro/heartbeat', {
      instanceId: maestroId,
      activeSessions,
      status: activeSessions >= MAX_SESSIONS ? 'busy' : 'online',
    });
  } catch (err) {
    logError('Heartbeat failed', err);
    // If 404, re-register
    if (String(err).includes('404')) {
      log('Instance not found — re-registering...');
      try {
        maestroId = await register();
        log(`Re-registered as ${maestroId}`);
      } catch (e) { logError('Re-registration failed', e); }
    }
  }
}

// ── Step 4: Handle Dispatch ───────────────────────────────────────────────────

interface DispatchPayload {
  dispatchId: string;
  beadId: string;
  skill: string;
  title: string;
  description?: string;
  priority?: string;
  context?: string;
  payload?: Record<string, unknown>;
}

async function handleDispatch(payload: DispatchPayload) {
  const { dispatchId, beadId, title, description, context } = payload;
  log(`Dispatch received: ${title}`, { dispatchId, beadId, skill: payload.skill });

  activeSessions++;
  const startTime = Date.now();

  // Build the prompt
  const parts = [`Task: ${title}`];
  if (description) parts.push(`\nDescription: ${description}`);
  if (context) parts.push(`\nContext: ${context}`);
  parts.push('\nComplete this task. Be thorough but concise.');

  const prompt = parts.join('');

  let output = '';
  let error = '';
  let success = false;

  try {
    const result = await spawnClaude(prompt);
    output = result.output;
    error = result.error;
    success = result.exitCode === 0;
    log(`Claude finished: ${success ? 'SUCCESS' : 'FAILED'}`, {
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
      outputLength: output.length,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logError('Claude spawn failed', err);
  }

  // Report back to Gas Town
  try {
    await api('POST', '/api/meow/town/maestro/report', {
      dispatchId,
      maestroId,
      success,
      output: output.slice(0, 50_000),
      durationMs: Date.now() - startTime,
      error: success ? undefined : error.slice(0, 5_000),
    });
    log('Report sent to Gas Town');
  } catch (err) {
    logError('Failed to report to Gas Town', err);
  }

  activeSessions--;
}

// ── Claude Spawner ────────────────────────────────────────────────────────────

function spawnClaude(prompt: string): Promise<{ output: string; error: string; exitCode: number }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    let resultText = '';

    const child = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '-p', prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000, // 10 minute timeout
    });

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);

      // Parse stream-json lines for the result
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Capture result text from assistant messages
          if (event.type === 'assistant' && event.subtype === 'text') {
            resultText += event.text || '';
          }
          // Also capture the final result
          if (event.type === 'result') {
            if (event.result) resultText = event.result;
          }
        } catch { /* not all lines are JSON */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      errChunks.push(data.toString());
    });

    child.on('close', (code) => {
      const output = resultText || chunks.join('');
      const error = errChunks.join('');
      resolve({ output, error, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      resolve({ output: '', error: err.message, exitCode: 1 });
    });
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function startServer(): http.Server {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/dispatch') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as DispatchPayload;

          if (activeSessions >= MAX_SESSIONS) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accepted: false, reason: 'at capacity' }));
            return;
          }

          // Accept immediately, process async
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));

          // Fire and forget — handleDispatch runs async
          handleDispatch(payload).catch(err => logError('Dispatch handler error', err));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        maestroId,
        activeSessions,
        maxSessions: MAX_SESSIONS,
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  srv.listen(LOCAL_PORT, () => {
    log(`Callback server listening on http://localhost:${LOCAL_PORT}`);
  });

  return srv;
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  log('Shutting down...');

  if (heartbeatTimer) clearInterval(heartbeatTimer);

  // Unregister from Gas Town
  if (maestroId) {
    try {
      await api('DELETE', `/api/meow/town/maestro/${maestroId}`);
      log('Unregistered from Gas Town');
    } catch { /* best effort */ }
  }

  if (server) server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           GAS TOWN MAESTRO CLIENT                    ║
╠══════════════════════════════════════════════════════╣
║  Backend:    ${GASTOWN_URL.padEnd(38)}║
║  Port:       ${String(LOCAL_PORT).padEnd(38)}║
║  Max:        ${String(MAX_SESSIONS).padEnd(38)}║
╚══════════════════════════════════════════════════════╝
`);

  // Detect Claude Code
  detectClaude();

  // Start callback server
  server = startServer();

  // Register with Gas Town
  try {
    maestroId = await register();
    log(`Registered with Gas Town as ${maestroId}`);
  } catch (err) {
    logError('Failed to register with Gas Town', err);
    logError(`Is the backend running at ${GASTOWN_URL}?`);
    process.exit(1);
  }

  // Start heartbeat
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  log('Heartbeat started (30s interval)');
  log('Waiting for dispatch...');
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
