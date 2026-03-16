-- Migration 051 — MEOW Engine (Stage 02)
-- Molecular Expression of Work: molecules, wisps, convoys, feed_events
-- Apply in Supabase SQL editor for project uhkditjakjsuekynruzd

-- ─── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE meow_phase AS ENUM ('ice9', 'solid', 'liquid', 'vapor');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE molecule_status AS ENUM ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE convoy_status AS ENUM ('assembling', 'dispatched', 'in_progress', 'delivered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Table: molecules ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS molecules (
  id                TEXT PRIMARY KEY,
  formula_name      TEXT NOT NULL,
  formula_version   INTEGER NOT NULL DEFAULT 1,
  phase             meow_phase NOT NULL DEFAULT 'solid',
  status            molecule_status NOT NULL DEFAULT 'pending',
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  vars              JSONB NOT NULL DEFAULT '{}'::jsonb,
  convoy_id         TEXT,
  completed_steps   TEXT[] NOT NULL DEFAULT '{}',
  current_steps     TEXT[] NOT NULL DEFAULT '{}',
  error             TEXT,
  digest            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_molecules_phase ON molecules(phase);
CREATE INDEX IF NOT EXISTS idx_molecules_status ON molecules(status);
CREATE INDEX IF NOT EXISTS idx_molecules_convoy ON molecules(convoy_id);
CREATE INDEX IF NOT EXISTS idx_molecules_formula ON molecules(formula_name);
CREATE INDEX IF NOT EXISTS idx_molecules_created ON molecules(created_at DESC);

-- ─── Table: wisps ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wisps (
  id                TEXT PRIMARY KEY,
  formula_name      TEXT NOT NULL,
  formula_version   INTEGER NOT NULL DEFAULT 1,
  phase             meow_phase NOT NULL DEFAULT 'vapor',
  status            molecule_status NOT NULL DEFAULT 'pending',
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  vars              JSONB NOT NULL DEFAULT '{}'::jsonb,
  convoy_id         TEXT,
  completed_steps   TEXT[] NOT NULL DEFAULT '{}',
  current_steps     TEXT[] NOT NULL DEFAULT '{}',
  error             TEXT,
  digest            TEXT,
  ttl_ms            INTEGER NOT NULL DEFAULT 3600000,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wisps_expires ON wisps(expires_at);
CREATE INDEX IF NOT EXISTS idx_wisps_status ON wisps(status);

-- ─── Table: convoys ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS convoys (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  status            convoy_status NOT NULL DEFAULT 'assembling',
  bead_ids          TEXT[] NOT NULL DEFAULT '{}',
  molecule_ids      TEXT[] NOT NULL DEFAULT '{}',
  created_by        TEXT NOT NULL,
  assigned_rig      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  progress          INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100)
);

CREATE INDEX IF NOT EXISTS idx_convoys_status ON convoys(status);
CREATE INDEX IF NOT EXISTS idx_convoys_created_by ON convoys(created_by);

-- ─── Table: feed_events ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feed_events (
  id                SERIAL PRIMARY KEY,
  type              TEXT NOT NULL,
  source            TEXT NOT NULL,
  rig               TEXT,
  bead_id           TEXT,
  molecule_id       TEXT,
  convoy_id         TEXT,
  message           TEXT NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  metadata          JSONB,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_events_type ON feed_events(type);
CREATE INDEX IF NOT EXISTS idx_feed_events_molecule ON feed_events(molecule_id);
CREATE INDEX IF NOT EXISTS idx_feed_events_convoy ON feed_events(convoy_id);
CREATE INDEX IF NOT EXISTS idx_feed_events_rig ON feed_events(rig);
CREATE INDEX IF NOT EXISTS idx_feed_events_timestamp ON feed_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_severity ON feed_events(severity);

-- ─── Auto-update updated_at ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_meow_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_molecules_updated ON molecules;
CREATE TRIGGER trg_molecules_updated
  BEFORE UPDATE ON molecules
  FOR EACH ROW EXECUTE FUNCTION update_meow_updated_at();

DROP TRIGGER IF EXISTS trg_wisps_updated ON wisps;
CREATE TRIGGER trg_wisps_updated
  BEFORE UPDATE ON wisps
  FOR EACH ROW EXECUTE FUNCTION update_meow_updated_at();

-- ─── Wisp auto-cleanup (expired wisps) ─────────────────────────────────────────

-- Optional: call this periodically from wisp_reaper dog
-- SELECT delete_expired_wisps();
CREATE OR REPLACE FUNCTION delete_expired_wisps()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM wisps WHERE expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
