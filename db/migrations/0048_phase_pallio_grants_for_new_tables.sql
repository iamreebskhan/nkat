-- ============================================================================
-- 0048 — Backfill GRANTs for the new tables created in 0041–0047.
--
-- Migrations run as `postgres` (the deploy script uses `sudo -u postgres
-- psql ...`). Tables created by postgres don't inherit the ALTER DEFAULT
-- PRIVILEGES rules set in 0001 (those apply per-creator), so the `app`
-- role gets "permission denied" 42501 on first query.
--
-- This migration grants SELECT/INSERT/UPDATE/DELETE on every table +
-- SELECT on the view that Phases B–G introduced. Idempotent.
-- ============================================================================

-- Phase 0 / A — view
GRANT SELECT ON payer_allowed_codes_v       TO app, analyst;

-- Phase B
GRANT SELECT, INSERT, UPDATE, DELETE ON denial_rule_metrics TO app;
GRANT SELECT                              ON denial_rule_metrics TO analyst;

-- Phase D — no new table, just columns on patient (already granted).

-- Phase G — cheat-sheet templates
GRANT SELECT, INSERT, UPDATE, DELETE ON cheat_sheet_template TO app;
GRANT SELECT                              ON cheat_sheet_template TO analyst;

-- Phase E — calendar link + visit_external_event
GRANT SELECT, INSERT, UPDATE, DELETE ON clinician_calendar_link TO app;
GRANT SELECT                              ON clinician_calendar_link TO analyst;
GRANT SELECT, INSERT, UPDATE, DELETE ON visit_external_event    TO app;
GRANT SELECT                              ON visit_external_event    TO analyst;

-- Phase F — messaging
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_thread          TO app;
GRANT SELECT                              ON patient_thread          TO analyst;
GRANT SELECT, INSERT, UPDATE, DELETE ON patient_message         TO app;
GRANT SELECT                              ON patient_message         TO analyst;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification            TO app;
GRANT SELECT                              ON notification            TO analyst;
