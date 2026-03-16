/**
 * Database connection pool singleton — US-024
 * Connection retry with exponential backoff on startup.
 */

import dns from 'dns';
import { Pool, PoolConfig } from 'pg';
import { createLogger } from '../lib/logger';

const log = createLogger('db');

// Force IPv4 first (Railway doesn't support IPv6 to Supabase)
dns.setDefaultResultOrder('ipv4first');

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.warn('DATABASE_URL not set — persistence disabled');
    return null;
  }

  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: parseInt(process.env.DB_POOL_MAX ?? '2', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT ?? '15000', 10),
    connectionTimeoutMillis: parseInt(process.env.DB_CONN_TIMEOUT ?? '8000', 10),
    ssl: { rejectUnauthorized: false },
  };

  pool = new Pool(config);

  pool.on('error', (err) => {
    log.error({ err }, 'Pool error');
  });

  log.info({ max: config.max }, 'Connection pool created');
  return pool;
}

export async function testConnection(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;

  try {
    await p.query('SELECT 1');
    return true;
  } catch (err) {
    log.error({ err }, 'Connection test failed');
    return false;
  }
}

/**
 * Retry connection with exponential backoff.
 * Used at startup to handle transient DB unavailability.
 */
export async function connectWithRetry(maxRetries = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ok = await testConnection();
    if (ok) {
      log.info({ attempt }, 'Database connection established');
      return true;
    }
    if (attempt < maxRetries) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      log.warn({ attempt, maxRetries, delayMs }, 'DB connection failed, retrying...');
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  log.error({ maxRetries }, 'All DB connection attempts failed');
  return false;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    log.info('Connection pool closed');
  }
}
