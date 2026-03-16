-- ============================================================================
-- Migration 052: Maestro Bridge Persistence
-- ============================================================================
-- Tracks registered RunMaestro (Electron) instances that connect to Gas Town.
-- Each Maestro runs locally on a developer machine and orchestrates Claude Code
-- sessions. Gas Town dispatches beads/hooks to Maestros via their callback URL.
--
-- Date: 2026-03-16
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS meow_maestros (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  callback_url      TEXT NOT NULL UNIQUE,
  capabilities      TEXT[] DEFAULT '{}',
  max_sessions      INTEGER DEFAULT 3,
  active_sessions   INTEGER DEFAULT 0,
  hostname          TEXT DEFAULT 'unknown',
  os                TEXT DEFAULT 'unknown',
  version           TEXT DEFAULT '0.0.0',
  status            TEXT DEFAULT 'online',       -- online, busy, stale, dead
  registered_at     TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat    TIMESTAMPTZ DEFAULT NOW(),
  total_dispatched  INTEGER DEFAULT 0,
  total_completed   INTEGER DEFAULT 0,
  total_failed      INTEGER DEFAULT 0,
  metadata          JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_meow_maestros_status
  ON meow_maestros(status);

CREATE INDEX IF NOT EXISTS idx_meow_maestros_heartbeat
  ON meow_maestros(last_heartbeat DESC);

CREATE INDEX IF NOT EXISTS idx_meow_maestros_callback
  ON meow_maestros(callback_url);

-- Polecat results table (referenced by polecat-spawner.ts but never created)
CREATE TABLE IF NOT EXISTS meow_polecat_results (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  polecat_id      TEXT NOT NULL,
  bead_id         TEXT NOT NULL,
  skill           TEXT NOT NULL,
  tier            TEXT DEFAULT 'B',
  molecule_id     TEXT,
  step_id         TEXT,
  output          TEXT DEFAULT '',
  pr_url          TEXT,
  duration_ms     INTEGER DEFAULT 0,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cost_usd        NUMERIC(10,6) DEFAULT 0,
  model           TEXT DEFAULT 'unknown',
  completed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meow_polecat_results_bead
  ON meow_polecat_results(bead_id);

CREATE INDEX IF NOT EXISTS idx_meow_polecat_results_polecat
  ON meow_polecat_results(polecat_id);

CREATE INDEX IF NOT EXISTS idx_meow_polecat_results_completed
  ON meow_polecat_results(completed_at DESC);

-- RLS
ALTER TABLE meow_maestros ENABLE ROW LEVEL SECURITY;
ALTER TABLE meow_polecat_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meow_maestros_service_all ON meow_maestros;
CREATE POLICY meow_maestros_service_all ON meow_maestros FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS meow_polecat_results_service_all ON meow_polecat_results;
CREATE POLICY meow_polecat_results_service_all ON meow_polecat_results FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMIT;
