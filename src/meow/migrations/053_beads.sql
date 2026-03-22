-- ============================================================================
-- Migration 053: Beads — Work units for Gas Town MEOW engine
-- ============================================================================
-- Beads are the atomic units of work in Gas Town. Each bead represents a task
-- that can be assigned to a worker (polecat/agent/human), tracked through
-- status transitions, and grouped into convoys.
--
-- Date: 2026-03-22
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS beads (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'backlog'
                    CHECK (status IN ('backlog','ready','in_progress','in_review','blocked','done','cancelled')),
  priority          TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('critical','high','medium','low')),
  executor_type     TEXT NOT NULL DEFAULT 'agent'
                    CHECK (executor_type IN ('agent','worker','clone','human')),
  bu                TEXT,
  rig               TEXT,
  skill             TEXT,
  formula           TEXT,
  tier              TEXT CHECK (tier IS NULL OR tier IN ('S','A','B')),
  labels            JSONB DEFAULT '{}'::jsonb,
  assignee          TEXT,
  molecule_id       TEXT,
  convoy_id         TEXT,
  parent_id         TEXT,
  dependencies      JSONB DEFAULT '[]'::jsonb,
  artifacts         TEXT[] DEFAULT '{}',
  pr_url            TEXT,
  worktree          TEXT,
  created_by        TEXT NOT NULL DEFAULT 'system',
  completed_by      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_beads_status ON beads(status);
CREATE INDEX IF NOT EXISTS idx_beads_priority ON beads(priority);
CREATE INDEX IF NOT EXISTS idx_beads_rig ON beads(rig);
CREATE INDEX IF NOT EXISTS idx_beads_assignee ON beads(assignee);
CREATE INDEX IF NOT EXISTS idx_beads_molecule ON beads(molecule_id);
CREATE INDEX IF NOT EXISTS idx_beads_convoy ON beads(convoy_id);
CREATE INDEX IF NOT EXISTS idx_beads_parent ON beads(parent_id);
CREATE INDEX IF NOT EXISTS idx_beads_created ON beads(created_at DESC);

-- Activity log for audit trail
CREATE TABLE IF NOT EXISTS beads_activity_log (
  id          SERIAL PRIMARY KEY,
  bead_id     TEXT NOT NULL REFERENCES beads(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  old_value   TEXT,
  new_value   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_beads_activity_bead ON beads_activity_log(bead_id);
CREATE INDEX IF NOT EXISTS idx_beads_activity_created ON beads_activity_log(created_at DESC);

-- Archive for completed beads >90 days
CREATE TABLE IF NOT EXISTS beads_archive (LIKE beads INCLUDING ALL);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_beads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_beads_updated ON beads;
CREATE TRIGGER trg_beads_updated
  BEFORE UPDATE ON beads
  FOR EACH ROW EXECUTE FUNCTION update_beads_updated_at();

-- RLS
ALTER TABLE beads ENABLE ROW LEVEL SECURITY;
ALTER TABLE beads_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE beads_archive ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS beads_service_all ON beads;
CREATE POLICY beads_service_all ON beads FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS beads_activity_service_all ON beads_activity_log;
CREATE POLICY beads_activity_service_all ON beads_activity_log FOR ALL
  TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS beads_archive_service_all ON beads_archive;
CREATE POLICY beads_archive_service_all ON beads_archive FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMIT;
