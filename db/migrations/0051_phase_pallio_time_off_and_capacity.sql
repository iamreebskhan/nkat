-- ============================================================================
-- 0051 — PTO / time-off + per-provider daily capacity (Phase E.1d + E.2).
--
-- PTO is first-class on the schedule (a row per clinician absence). The
-- capacity threshold (max visits/day per provider) lives on org as a
-- setting so the schedule POST can warn before over-booking.
-- ============================================================================

CREATE TABLE IF NOT EXISTS time_off (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  clinician_user_id UUID         NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  start_date        DATE         NOT NULL,
  end_date          DATE         NOT NULL,
  reason            TEXT,
  created_by        UUID         REFERENCES app_user(id),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS time_off_org_range_idx
  ON time_off (org_id, clinician_user_id, start_date, end_date);

SELECT app.apply_tenant_rls('time_off');

GRANT SELECT, INSERT, UPDATE, DELETE ON time_off TO app;
GRANT SELECT ON time_off TO analyst;

-- Per-provider daily visit cap. Stored on org settings JSON; default 8.
ALTER TABLE org
  ADD COLUMN IF NOT EXISTS daily_visit_capacity INT NOT NULL DEFAULT 8;

COMMENT ON COLUMN org.daily_visit_capacity IS
  'Phase E.2 capacity guard: schedule POST warns when a clinician already has >= this many visits on the target day.';
