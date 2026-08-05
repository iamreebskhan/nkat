-- 0057 — coverage state on the patient's insurance.
--
-- Rule lookups key on (payer × state). Until now the state came from the
-- patient's ADDRESS (patient.state), which is usually right but not always:
-- a policy can be issued in a different state than the patient lives in
-- (snowbirds, plans bought across a state line, employer plans). Billing
-- correctness depends on the POLICY's state, so capture it explicitly.
--
-- Nullable on purpose: existing rows keep working because every read falls
-- back to patient.state when insurance_state is NULL.

ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS insurance_state CHAR(2);

COMMENT ON COLUMN patient.insurance_state IS
  'USPS state the primary policy is issued in. Drives payer-rule lookups; falls back to patient.state when NULL.';

-- Lookups filter by (payer, state) together.
CREATE INDEX IF NOT EXISTS patient_payer_state_idx
  ON patient (primary_payer_id, insurance_state)
  WHERE primary_payer_id IS NOT NULL;
