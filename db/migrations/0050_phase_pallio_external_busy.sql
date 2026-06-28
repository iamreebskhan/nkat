-- ============================================================================
-- 0050 — External calendar busy blocks (Phase E inbound pull-sync).
--
-- The push direction (Pallio visit -> Google event) + the live conflict
-- check (freeBusy at schedule time) already exist. This adds the inbound
-- direction WITHOUT inventing phantom Pallio visits from arbitrary Google
-- events: instead we cache each external event as a read-only busy block
-- the schedule grid can render so the clinician sees their non-Pallio
-- commitments inline.
--
-- visit_external_event already maps Pallio visits <-> Google events with
-- direction='external_origin'. We extend it with the event's time window
-- + summary so external_origin rows (visit_id NULL) are self-describing.
-- ============================================================================

ALTER TABLE visit_external_event
  ADD COLUMN IF NOT EXISTS external_summary TEXT,
  ADD COLUMN IF NOT EXISTS external_start   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_end     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_id          UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS cancelled        BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS visit_external_event_busy_idx
  ON visit_external_event (org_id, user_id, external_start)
  WHERE visit_id IS NULL AND cancelled = FALSE;

COMMENT ON COLUMN visit_external_event.external_summary IS
  'Phase E pull-sync: title of an external (Google) event cached as a busy block (visit_id NULL).';
