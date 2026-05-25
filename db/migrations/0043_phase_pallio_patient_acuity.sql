-- ============================================================================
-- 0043 — Patient acuity (Phase D).
--
-- Mark's answer in the 2026-05-22 question doc: simple 4-step scale —
-- low / medium / high / critical. Nurses tag each patient with their
-- current acuity; the caseload list sorts critical-first so the day's
-- highest-risk patients surface to the top.
--
-- Stored as TEXT with a CHECK so we can extend the enum later without
-- a Postgres ENUM alteration. Default NULL — existing patients are
-- "unassigned" and surface at the bottom of the sorted list.
-- ============================================================================

ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS acuity TEXT
    CHECK (acuity IN ('low', 'medium', 'high', 'critical'));

ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS acuity_updated_at TIMESTAMPTZ;

ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS acuity_updated_by_user_id UUID REFERENCES app_user(id);

CREATE INDEX IF NOT EXISTS patient_org_acuity_idx
  ON patient (org_id, acuity);

COMMENT ON COLUMN patient.acuity IS
  'Phase D — 4-step palliative-care acuity (low/medium/high/critical). NULL = unassigned. Drives caseload sort.';
