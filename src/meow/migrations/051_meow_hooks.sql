-- ============================================================================
-- Migration 051: MEOW GUPP Hook Persistence
-- ============================================================================
-- Persists GUPP (Gas Town Universal Propulsion Protocol) hooks to PostgreSQL.
-- Enables NDI (Nondeterministic Idempotence): hook state survives crashes and
-- restarts. On boot, GUPP hydrates from this table and re-queues any hooks
-- that were claimed or running when the process died.
--
-- Date: 2026-03-16
-- ============================================================================

BEGIN;

-- GUPP Hooks: one row per unit of work placed on an agent's hook.
-- Written on every state transition via write-through cache pattern.
CREATE TABLE IF NOT EXISTS meow_hooks (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  bead_id       TEXT NOT NULL,
  skill         TEXT NOT NULL,
  priority      TEXT DEFAULT 'normal',     -- critical, high, normal, low
  payload       JSONB DEFAULT '{}',
  status        TEXT DEFAULT 'pending',    -- pending, claimed, running, completed, failed, expired
  retry_count   INTEGER DEFAULT 0,
  max_retries   INTEGER DEFAULT 3,
  claimed_by    TEXT,                      -- worker_id that claimed this hook
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meow_hooks_status
  ON meow_hooks(status);

CREATE INDEX IF NOT EXISTS idx_meow_hooks_agent
  ON meow_hooks(agent_id);

CREATE INDEX IF NOT EXISTS idx_meow_hooks_bead
  ON meow_hooks(bead_id);

CREATE INDEX IF NOT EXISTS idx_meow_hooks_created
  ON meow_hooks(created_at DESC);

-- Composite index for the GUPP hydration query on startup
CREATE INDEX IF NOT EXISTS idx_meow_hooks_active
  ON meow_hooks(status, created_at DESC)
  WHERE status NOT IN ('completed', 'failed', 'expired');


-- ============================================================================
-- Row-Level Security
-- ============================================================================

ALTER TABLE meow_hooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meow_hooks_service_all ON meow_hooks;
CREATE POLICY meow_hooks_service_all ON meow_hooks FOR ALL
  TO service_role USING (true) WITH CHECK (true);


-- ============================================================================
-- Retention: prune completed/failed hooks older than 30 days
-- (Add to meow_prune_old_records if extending migration 050)
-- ============================================================================

CREATE OR REPLACE FUNCTION meow_prune_hooks(retention_days INTEGER DEFAULT 30)
RETURNS BIGINT AS $$
DECLARE
  cutoff TIMESTAMPTZ := NOW() - (retention_days || ' days')::INTERVAL;
  del_count BIGINT;
BEGIN
  DELETE FROM meow_hooks
  WHERE status IN ('completed', 'failed', 'expired')
    AND created_at < cutoff;
  GET DIAGNOSTICS del_count = ROW_COUNT;
  RETURN del_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION meow_prune_hooks IS
  'Prunes completed/failed/expired GUPP hooks. Call periodically. Default retention: 30 days.';


COMMIT;
