-- ============================================================================
-- 0112_patient_documents.sql
--
-- Referral paperwork kept on the patient as attachments (Mark Q11j default;
-- Level-1 doc:22, "referral source and referral information"). The order, the
-- records and the face sheet arrive with the referral, before there is a
-- patient, so a document belongs to a referral, a patient, or both: admission
-- names the patient on the referral's documents, as it does on its coverage
-- checks (0111).
--
-- The file is held in the row, encrypted with pgp_sym_encrypt_bytea and the
-- app.phi_key GUC when the key is configured (as 0034's companions are), and
-- as it was uploaded when it is not; `encrypted` says which, so a read knows
-- whether it needs the key. Only PDF, JPEG and PNG are taken, up to 10 MB: the
-- upload route checks the file's own first bytes, not the name it came with.
--
-- A document filed on the wrong patient is a disclosure, so it can be removed:
-- removal empties the content and keeps the row (who, when, why), and the
-- audit log has the upload and the removal.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

CREATE TABLE patient_document (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  referral_id         UUID        REFERENCES referral(id) ON DELETE CASCADE,
  patient_id          UUID        REFERENCES patient(id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL CHECK (kind IN (
                        'referral_order', 'medical_records', 'face_sheet', 'insurance_card',
                        'consent', 'other')),
  file_name           TEXT        NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  content_type        TEXT        NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes          INT         NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256              TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content             BYTEA,
  encrypted           BOOLEAN     NOT NULL DEFAULT FALSE,
  uploaded_by_user_id UUID        REFERENCES app_user(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at          TIMESTAMPTZ,
  removed_by_user_id  UUID        REFERENCES app_user(id),
  removed_reason      TEXT        CHECK (removed_reason IS NULL OR length(btrim(removed_reason)) BETWEEN 1 AND 300),
  CONSTRAINT patient_document_has_subject CHECK (referral_id IS NOT NULL OR patient_id IS NOT NULL),
  -- Held until removed, and nothing held after.
  CONSTRAINT patient_document_removed_empties CHECK ((removed_at IS NULL) = (content IS NOT NULL)),
  CONSTRAINT patient_document_removed_says_why CHECK (
    removed_at IS NULL OR (removed_by_user_id IS NOT NULL AND removed_reason IS NOT NULL))
);

CREATE INDEX patient_document_patient_idx ON patient_document (patient_id, uploaded_at DESC);
CREATE INDEX patient_document_referral_idx ON patient_document (referral_id, uploaded_at DESC);

SELECT app.apply_tenant_rls('patient_document');

COMMENT ON TABLE patient_document IS
  'Referral paperwork and other documents kept on a referral or a patient (Mark Q11j). content is pgp_sym_encrypt_bytea when encrypted; emptied on removal.';
