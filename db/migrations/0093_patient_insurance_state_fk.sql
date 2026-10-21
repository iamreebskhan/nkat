-- ============================================================================
-- 0093_patient_insurance_state_fk.sql
--
-- Audit R37. Every layer checked only that a coverage state was two letters,
-- so 'ZZ' was stored, and every rule lookup keyed on it came back empty. The
-- patient service now refuses a state that does not exist and a payer ×
-- state pair the payer does not serve. This constraint is the backstop for
-- writers that bypass the service — scripts and direct SQL.
--
-- NOT VALID: rows already stored are not re-checked at deploy; every new or
-- changed row is. Run the read-only pre-check first (expected 0) and
-- VALIDATE CONSTRAINT afterwards if it is clean:
--   SELECT count(*) FROM patient
--    WHERE insurance_state IS NOT NULL
--      AND insurance_state NOT IN (SELECT state FROM state);
--
-- `state` is filled by db/seed/0001, which runs after migrations. The
-- constraint is added to an empty-or-full table either way; seeded patients
-- are checked on insert, after the states exist.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patient_insurance_state_fkey'
  ) THEN
    ALTER TABLE patient
      ADD CONSTRAINT patient_insurance_state_fkey
      FOREIGN KEY (insurance_state) REFERENCES state(state) NOT VALID;
  END IF;
END $$;
