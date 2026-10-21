-- ============================================================================
-- 0098_visit_signer_credential.sql
--
-- Audit R32. The attested note could not say under which credential it was
-- signed: the value was a client-side dropdown dropped at the network
-- boundary, and nothing stored it. The credential now comes from the signer's
-- clinician_profile and is snapshotted here at sign-off — so the note records
-- what the signer held THEN, not whatever their profile says later.
-- ============================================================================

ALTER TABLE visit ADD COLUMN IF NOT EXISTS signer_credential TEXT
  CONSTRAINT visit_signer_credential_check
  CHECK (signer_credential IS NULL OR signer_credential IN
    ('MD', 'DO', 'NP', 'PA', 'CNS', 'RN', 'LCSW', 'OTHER'));

COMMENT ON COLUMN visit.signer_credential IS
  'The credential the signer attested under, snapshotted from clinician_profile at sign-off. NULL when none was recorded, and for visits signed before 0098.';
