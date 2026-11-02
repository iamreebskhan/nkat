-- ============================================================================
-- 0127_patient_chaplain.sql
--
-- A chaplain seat on the care team, beside the NP, RN, social worker and billing
-- agent of 0054. Level-1 lists chaplaincy among the interdisciplinary team and
-- tasks already go to it; nothing said which chaplain a patient has. Nullable: a
-- patient may have any subset assigned. Membership of the patient's org is
-- enforced at the service layer, as for the other seats.
--
-- A chaplain seat is on the clinical care team, like the social worker's: they
-- read the patient's visits, see them on their caseload and in the offline copy,
-- are named in the note header, and take the patient's chaplaincy tasks.
-- ============================================================================

ALTER TABLE patient ADD COLUMN IF NOT EXISTS chaplain_user_id UUID REFERENCES app_user(id);

COMMENT ON COLUMN patient.chaplain_user_id IS 'Assigned chaplain (app_user id, must be an org member).';
