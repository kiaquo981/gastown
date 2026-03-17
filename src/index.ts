import 'dotenv/config';

/**
 * Gas Town — Server Entry Point
 *
 * Standalone Express server that mounts all MEOW route modules,
 * initializes the engine, connects to PostgreSQL, and serves
 * the SSE event stream.
 *
 * Usage:
 *   npm run dev    — development with hot reload
 *   npm start      — production
 */

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { correlationIdMiddleware } from './middleware/correlationId';
import { logger } from './lib/logger';
import { connectWithRetry, closePool } from './db/client';
import { sseClients } from './stores';
import type { SSEClient } from './types';

// ── MEOW Route Modules ─────────────────────────────────────────────────────
import meowRoutes from './meow/meow-routes';
import beadsRoutes from './meow/beads-routes';
import workerRoutes from './meow/worker-routes';
import skillRoutes from './meow/skill-routes';
import observabilityRoutes from './meow/observability-routes';
import runnerRoutes from './meow/runner-routes';
import townRoutes from './meow/town-routes';
import foundationRoutes from './meow/foundation-routes';
import guardRoutes from './meow/guard-routes';
import wave7Routes from './meow/wave7-routes';
import finalRoutes from './meow/final-routes';

// Stage routes (may be large — import only if needed)
import stage04Routes from './meow/stage04-routes';
import stage05Routes from './meow/stage05-routes';
import stage06Routes from './meow/stage06-routes';

// ── Maestro + FrankFlow + Hetzner Integration ───────────────────────────────
import { maestroRouter } from './meow/maestro';
import { frankflowRouter } from './meow/frankflow';
import { hetznerRouter } from './meow/hetzner';

// ── App Setup ───────────────────────────────────────────────────────────────

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const log = logger.child({ module: 'server' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(correlationIdMiddleware);

// Request logging (compact)
app.use((req, _res, next) => {
  if (req.method !== 'GET' || !req.path.includes('/health')) {
    log.debug({ method: req.method, path: req.path }, 'request');
  }
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/readiness', async (_req, res) => {
  const { testConnection } = await import('./db/client');
  const dbOk = await testConnection();
  res.status(dbOk ? 200 : 503).json({ ready: dbOk, db: dbOk ? 'connected' : 'disconnected' });
});

// ── SSE Endpoint ─────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');

  const client: SSEClient = { id: uuidv4(), response: res, connectedAt: new Date() };
  sseClients.push(client);
  log.info({ clientId: client.id, total: sseClients.length }, 'SSE client connected');

  req.on('close', () => {
    const idx = sseClients.findIndex(c => c.id === client.id);
    if (idx !== -1) sseClients.splice(idx, 1);
    log.info({ clientId: client.id, total: sseClients.length }, 'SSE client disconnected');
  });
});

// ── Mount MEOW Routes ────────────────────────────────────────────────────────

app.use(meowRoutes);           // /api/meow/*
app.use(beadsRoutes);          // /api/meow/beads/*
app.use(workerRoutes);         // /api/meow/mayor/*, /api/meow/gupp/*, etc.
app.use(skillRoutes);          // /api/meow/skills/*
app.use(observabilityRoutes);  // /api/meow/observability/*
app.use(runnerRoutes);         // /api/meow/runner/*
app.use(townRoutes);           // /api/meow/town/*
app.use(foundationRoutes);     // /api/meow/foundation/*
app.use(guardRoutes);          // /api/meow/guard/*
app.use(wave7Routes);          // /api/meow/wave7/*
app.use(stage04Routes);        // /api/meow/stage04/*
app.use(stage05Routes);        // /api/meow/stage05/*
app.use(stage06Routes);        // /api/meow/stage06/*
app.use(finalRoutes);          // /api/meow/final/*

// ── Maestro + FrankFlow + Hetzner ───────────────────────────────────────────
app.use(maestroRouter);                      // /api/maestro/* (prefix built-in)
app.use('/api/frankflow', frankflowRouter);  // /api/frankflow/*
app.use('/api/hetzner', hetznerRouter);      // /api/hetzner/*

// ── 404 ──────────────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  // Connect to database
  const dbOk = await connectWithRetry(3);

  // Run migrations
  if (dbOk) {
    try {
      const { getPool } = await import('./db/client');
      const pool = getPool();
      if (pool) {
        const fs = await import('fs');
        const path = await import('path');

        const migrationFiles = [
          path.join(__dirname, '../migrations/051_meow_engine.sql'),
          path.join(__dirname, 'meow/migrations/051_meow_hooks.sql'),
          path.join(__dirname, 'meow/migrations/052_meow_maestros.sql'),
        ];

        for (const file of migrationFiles) {
          if (fs.existsSync(file)) {
            try {
              const sql = fs.readFileSync(file, 'utf8');
              await pool.query(sql);
              log.info({ file: path.basename(file) }, 'Migration applied');
            } catch (err) {
              // Most errors are "already exists" — safe to ignore
              log.debug({ file: path.basename(file), err }, 'Migration skipped (likely already applied)');
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Migration runner error (non-fatal)');
    }
  }

  // Start autonomous loop if enabled
  const { startAutonomousLoop } = await import('./meow/autonomous-loop');
  startAutonomousLoop();

  log.info(`
╔══════════════════════════════════════════════════════════════╗
║                    GAS TOWN CONTROL CENTER                   ║
║══════════════════════════════════════════════════════════════║
║  Port:        ${String(PORT).padEnd(45)}║
║  Database:    ${(dbOk ? 'CONNECTED' : 'OFFLINE').padEnd(45)}║
║  Auto-Loop:   ${(process.env.MEOW_AUTONOMOUS === 'true' ? 'ENABLED' : 'DISABLED').padEnd(45)}║
║  SSE:         /api/events${' '.repeat(38)}║
║  Health:      /health${' '.repeat(38)}║
╚══════════════════════════════════════════════════════════════╝
  `);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down...');
  server.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
