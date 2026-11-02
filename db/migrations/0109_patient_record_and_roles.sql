-- ============================================================================
-- 0109_patient_record_and_roles.sql
--
-- Level-1 audit (27 Oct 2026), intake and access items that need columns:
--
--   * Consents. The intake wizard requires HIPAA acknowledgment and the
--     goals-of-care consent and then threw both away; only telehealth was kept
--     (0029 has no column for the others). There was no record that either was
--     obtained. Stamped like telehealth_consent_at: when, and by whose signature.
--   * Secondary insurance (Mark Q11g default: capture it, payer and member ID,
--     even if Pallio never bills it). The member ID is PHI and gets the same
--     encrypted companion as the primary one (0034).
--   * LPN on the credential list. The practice's between-visit clinician is an LPN
--     (the June and July status decks: "LPN was trained in her new role"),
--     and 0092 had no such credential.
--   * An intake role template. Mark: "the person in intake ... does all the
--     referrals, gets all the demographics in ... insurance verification, the
--     triage, referral tracking, scheduling" [3 Sep 00:38]. Only org_admin
--     could create a patient by default.
-- ============================================================================

-- 1. Consents and secondary insurance on the patient.
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS hipaa_acknowledged_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS goals_of_care_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_signed_by        TEXT
    CONSTRAINT patient_consent_signed_by_len CHECK (consent_signed_by IS NULL OR length(consent_signed_by) <= 150),
  ADD COLUMN IF NOT EXISTS secondary_payer_id       UUID REFERENCES payer(id),
  ADD COLUMN IF NOT EXISTS secondary_member_id      TEXT
    CONSTRAINT patient_secondary_member_id_len CHECK (secondary_member_id IS NULL OR length(secondary_member_id) <= 120),
  ADD COLUMN IF NOT EXISTS secondary_member_id_enc  BYTEA,
  ADD COLUMN IF NOT EXISTS secondary_group_number   TEXT
    CONSTRAINT patient_secondary_group_len CHECK (secondary_group_number IS NULL OR length(secondary_group_number) <= 100);

COMMENT ON COLUMN patient.hipaa_acknowledged_at IS
  'When the patient acknowledged the HIPAA notice (intake consent step, or recorded later on the chart). NULL = not recorded.';
COMMENT ON COLUMN patient.goals_of_care_consent_at IS
  'When the patient consented to goals-of-care discussion (intake consent step, or recorded later). NULL = not recorded.';
COMMENT ON COLUMN patient.secondary_member_id_enc IS
  'pgp_sym_encrypt companion of secondary_member_id, as primary_member_id_enc (0034). NULL when no PHI key is configured.';

-- 2. LPN as a credential. It does not bill home E/M codes, like RN. A signed
--    visit keeps its signer's credential (0098), so the visit takes it too:
--    without it an LPN's signature would break that CHECK.
ALTER TABLE clinician_profile DROP CONSTRAINT IF EXISTS clinician_profile_credential_check;
ALTER TABLE clinician_profile ADD CONSTRAINT clinician_profile_credential_check
  CHECK (credential IS NULL OR credential IN
    ('MD', 'DO', 'NP', 'PA', 'CNS', 'RN', 'LPN', 'LCSW', 'OTHER'));
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_signer_credential_check;
ALTER TABLE visit ADD CONSTRAINT visit_signer_credential_check
  CHECK (signer_credential IS NULL OR signer_credential IN
    ('MD', 'DO', 'NP', 'PA', 'CNS', 'RN', 'LPN', 'LCSW', 'OTHER'));

-- 3. The intake coordinator template, on members and on invites.
ALTER TABLE org_member DROP CONSTRAINT IF EXISTS org_member_role_template_check;
ALTER TABLE org_member ADD CONSTRAINT org_member_role_template_check
  CHECK (role_template IS NULL OR role_template IN
    ('org_admin', 'clinician', 'intake_coordinator', 'billing_agent', 'consultant', 'analyst', 'read_only'));

ALTER TABLE pending_invite DROP CONSTRAINT IF EXISTS pending_invite_role_template_check;
ALTER TABLE pending_invite ADD CONSTRAINT pending_invite_role_template_check
  CHECK (role_template IN
    ('org_admin', 'clinician', 'intake_coordinator', 'billing_agent', 'consultant', 'analyst', 'read_only'));
