-- 0054 — per-patient care team assignment.
--
-- CareTeamSchema (primaryNpUserId / rnUserId / socialWorkerUserId /
-- billingAgentUserId) has been part of the POST /api/patients contract since
-- the intake wizard shipped, but nothing persisted it — these columns are the
-- missing storage. All nullable: a patient may have any subset assigned.
-- Membership in the patient's org is enforced at the service layer
-- (org_member check) — app_user itself is global.

ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS primary_np_user_id     UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS rn_user_id             UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS social_worker_user_id  UUID REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS billing_agent_user_id  UUID REFERENCES app_user(id);

COMMENT ON COLUMN patient.primary_np_user_id    IS 'Assigned primary NP (app_user id, must be an org member).';
COMMENT ON COLUMN patient.rn_user_id            IS 'Assigned RN (app_user id, must be an org member).';
COMMENT ON COLUMN patient.social_worker_user_id IS 'Assigned social worker (app_user id, must be an org member).';
COMMENT ON COLUMN patient.billing_agent_user_id IS 'Assigned billing agent (app_user id, must be an org member).';

-- Caseload queries filter by assignee ("my patients").
CREATE INDEX IF NOT EXISTS idx_patient_primary_np ON patient (primary_np_user_id) WHERE primary_np_user_id IS NOT NULL;
