-- ============================================================================
-- 0110_care_plan_visit_snapshots.sql
--
-- Level-1 audit (27 Oct 2026), doc:50 and doc:59: the follow-up visit updates
-- "assessment, plan and care plan", and the symptoms and issues being
-- monitored are part of the plan.
--
-- care_plan_version (0029) was meant to be "frozen at the moment a visit was
-- signed", and nothing ever wrote it: the only writer took an id no screen
-- sent, so every Version history was empty. Signing a visit now freezes the
-- plan as it stood, and the frozen copy needs the rest of the plan with the
-- document: the goals-of-care summary, the symptoms to monitor and the
-- medications, which until now only the live row held.
-- ============================================================================

ALTER TABLE care_plan_version
  ADD COLUMN IF NOT EXISTS goals_of_care_summary TEXT,
  ADD COLUMN IF NOT EXISTS primary_symptoms      TEXT[],
  ADD COLUMN IF NOT EXISTS active_medications    TEXT[];

COMMENT ON COLUMN care_plan_version.primary_symptoms IS
  'The symptoms and issues being monitored when this version was frozen (doc:50). NULL on versions frozen before 0110.';
