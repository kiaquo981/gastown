#!/usr/bin/env npx tsx
/**
 * Gas Town Maestro Client — Pull-Based Local Agent
 *
 * Runs on your machine. Polls Gas Town for pending GUPP hooks,
 * claims them, spawns Claude Code to execute, reports results.
 *
 * Pull model (not push) — works behind NAT/firewalls, no tunnel needed.
 *
 * Usage:
 *   npx tsx tools/maestro-client.ts
 *
 * Environment:
 *   GASTOWN_URL       — Backend URL (default: https://gastown-production.up.railway.app)
 *   GASTOWN_API_KEY   — API key for mutations
 *   MAESTRO_MAX       — Max concurrent sessions (default: 2)
 *   POLL_INTERVAL     — Poll interval in ms (default: 10000)
 */

import { execSync, spawn } from 'child_process';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const GASTOWN_URL = process.env.GASTOWN_URL || 'https://gastown-production.up.railway.app';
const API_KEY = process.env.GASTOWN_API_KEY || 'gt_a8f3c2e1d4b6789012345678901234567890abcd1234';
const MAX_SESSIONS = parseInt(process.env.MAESTRO_MAX || '2', 10);
const POLL_MS = parseInt(process.env.POLL_INTERVAL || '10000', 10);

let activeSessions = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let claimedHookIds = new Set<string>();

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
    logError('Claude Code CLI not found in PATH.');
    process.exit(1);
  }
}

// ── Step 2: Poll for pending hooks ────────────────────────────────────────────

interface HookEntry {
  id: string;
  agentId: string;
  beadId: string;
  skill: string;
  priority: string;
  status: string;
  payload?: Record<string, unknown>;
}

async function pollForWork() {
  if (activeSessions >= MAX_SESSIONS) return;

  try {
    const data = await api('GET', '/api/meow/gupp/hooks/pending') as { hooks?: HookEntry[] };
    const hooks = data?.hooks || [];
    const pending = hooks.filter(h => h.status === 'pending' && !claimedHookIds.has(h.id));

    if (pending.length === 0) return;

    // Sort by priority: critical > high > normal > low
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    pending.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

    // Claim the highest priority hook
    const hook = pending[0];
    log(`Found pending hook: ${hook.id}`, { beadId: hook.beadId, skill: hook.skill, priority: hook.priority });

    // Claim it
    try {
      await api('POST', `/api/meow/gupp/hooks/${hook.id}/claim`, { workerId: `maestro-${os.hostname().split('.')[0]}` });
      claimedHookIds.add(hook.id);
      log(`Claimed hook ${hook.id}`);
    } catch (err) {
      logError(`Failed to claim hook ${hook.id}`, err);
      return;
    }

    // Get bead details for the prompt
    let beadTitle = hook.beadId;
    let beadDescription = '';
    try {
      const bead = await api('GET', `/api/beads/${hook.beadId}`) as { title?: string; description?: string };
      beadTitle = bead?.title || hook.beadId;
      beadDescription = bead?.description || '';
    } catch { /* use hook info as fallback */ }

    // Execute
    executeHook(hook, beadTitle, beadDescription);
  } catch (err) {
    // Silent on connection errors — just retry next cycle
    if (!String(err).includes('ECONNREFUSED')) {
      logError('Poll error', err);
    }
  }
}

// ── Step 3: Execute hook via Claude Code ───────────────────────────────────────

async function executeHook(hook: HookEntry, title: string, description: string) {
  activeSessions++;
  const startTime = Date.now();
  log(`Executing: ${title}`, { hookId: hook.id, beadId: hook.beadId });

  // Build prompt
  const parts = [`Task: ${title}`];
  if (description) parts.push(`\nDescription: ${description}`);
  parts.push(`\nSkill: ${hook.skill}`);
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
      outputLen: output.length,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logError('Claude spawn failed', err);
  }

  // Report result — complete or fail the hook
  try {
    if (success) {
      await api('POST', `/api/meow/gupp/hooks/${hook.id}/complete`, {
        output: output.slice(0, 50_000),
        durationMs: Date.now() - startTime,
      });
      log(`Hook ${hook.id} completed`);
    } else {
      await api('POST', `/api/meow/gupp/hooks/${hook.id}/fail`, {
        error: (error || 'Unknown error').slice(0, 5_000),
        durationMs: Date.now() - startTime,
      });
      log(`Hook ${hook.id} failed`);
    }
  } catch (err) {
    logError('Failed to report hook result', err);
  }

  // Also report via Maestro bridge if dispatchId exists
  const dispatchId = hook.payload?.dispatchId as string | undefined;
  if (dispatchId) {
    try {
      await api('POST', '/api/meow/town/maestro/report', {
        dispatchId,
        maestroId: `maestro-${os.hostname().split('.')[0]}`,
        success,
        output: output.slice(0, 50_000),
        durationMs: Date.now() - startTime,
        error: success ? undefined : error.slice(0, 5_000),
      });
    } catch { /* best effort */ }
  }

  claimedHookIds.delete(hook.id);
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
      '--dangerously-skip-permissions',
      '-p', prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    });

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant' && event.subtype === 'text') {
            resultText += event.text || '';
          }
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
      resolve({
        output: resultText || chunks.join(''),
        error: errChunks.join(''),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      resolve({ output: '', error: err.message, exitCode: 1 });
    });
  });
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  log('Shutting down...');
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           GAS TOWN MAESTRO CLIENT                    ║
║           (Pull Mode — no tunnel needed)             ║
╠══════════════════════════════════════════════════════╣
║  Backend:    ${GASTOWN_URL.padEnd(38)}║
║  Max:        ${String(MAX_SESSIONS).padEnd(38)}║
║  Poll:       ${(POLL_MS / 1000 + 's').padEnd(38)}║
╚══════════════════════════════════════════════════════╝
`);

  detectClaude();

  // Test connection
  try {
    const health = await api('GET', '/health') as { status: string };
    log(`Gas Town connected: ${health.status}`);
  } catch (err) {
    logError('Cannot reach Gas Town backend', err);
    process.exit(1);
  }

  // Start polling
  log('Polling for pending hooks...');
  pollTimer = setInterval(pollForWork, POLL_MS);
  pollForWork(); // immediate first poll
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
