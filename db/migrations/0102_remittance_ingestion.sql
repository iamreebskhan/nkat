-- ============================================================================
-- 0102_remittance_ingestion.sql
--
-- Audit R10. Payer truth never entered Pallio. Every paid amount was typed, or
-- copied from "billed" by one click, and every denial was the org's own
-- assertion, so "Collected", "Outstanding" and every denial count on /billing
-- were the org's word on both legs of the claim. era_835_record has existed
-- since 0006, but nothing in the Next app wrote or read it: its tenancy key
-- (client_company) is a concept the app does not have, and no superbill
-- carried a reference an 835 could echo back.
--
-- This lets an org upload the 835 it downloads from its clearinghouse or the
-- payer's portal. Pallio still fetches nothing and sends nothing (R35):
--
--   remittance_file            one row per uploaded file, unique per org by
--                              content hash, so the same file posts once.
--   era_835_record             one row per service line, now keyed to that
--                              file and to the superbill it matched, with
--                              what the posting did. client_id and
--                              service_dos relax to NULL: the app has no
--                              client_company, and a claim-level row may
--                              carry no date of service.
--   superbill.paid_source      'recorded' (typed in Pallio) or 'remittance'
--                              (posted from a payer's 835).
--   superbill_denial.source    the same, for denials.
--
-- Matching needs no new superbill column. A bill's Claim ref is the first 12
-- hex characters of its id (the 837 only guarantees that 20 characters of the
-- patient control number come back in CLP01); the service turns a ref into an
-- id range, so a match is a primary-key range scan.
--
-- NO PHI FROM THE FILE. patient_external_id and raw_segment stay NULL on every
-- row the upload writes, and the patient name and member id in NM1*QC are
-- never stored (lib/features/remittances/remittance.service.ts).
--
-- Grants: the default privileges 0092 relies on (app gets DML on every table
-- admin creates in public), so there is no GRANT here. era_835_record keeps
-- the tenant_isolation policy it has had since 0007.
-- ============================================================================

CREATE TABLE remittance_file (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Of the file's text: the same 835 uploaded twice is one file.
  sha256               TEXT        NOT NULL CONSTRAINT remittance_file_sha256_format
                                   CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  filename             TEXT        NOT NULL,
  payer_name           TEXT,                   -- N1*PR
  trace_number         TEXT,                   -- TRN02: the check or EFT number
  payment_date         DATE,                   -- BPR16
  total_paid_cents     BIGINT,                 -- BPR02
  claim_count          INT         NOT NULL DEFAULT 0,
  uploaded_by_user_id  UUID        REFERENCES app_user(id),
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remittance_file_org_sha_uniq UNIQUE (org_id, sha256)
);

CREATE INDEX remittance_file_org_uploaded_idx ON remittance_file (org_id, uploaded_at DESC);

SELECT app.apply_tenant_rls('remittance_file');

ALTER TABLE era_835_record
  ALTER COLUMN client_id DROP NOT NULL,
  ALTER COLUMN service_dos DROP NOT NULL,
  ADD COLUMN remittance_file_id         UUID REFERENCES remittance_file(id) ON DELETE CASCADE,
  ADD COLUMN claim_seq                  INT,
  ADD COLUMN line_seq                   INT,     -- 0 = a claim that carried no service line
  ADD COLUMN claim_status_code          TEXT,    -- CLP02
  ADD COLUMN payer_claim_control_number TEXT,    -- CLP07
  ADD COLUMN superbill_id               UUID REFERENCES superbill(id) ON DELETE SET NULL,
  ADD COLUMN posting                    TEXT CONSTRAINT era_835_record_posting_check
                                        CHECK (posting IN ('paid', 'partially_paid', 'denied', 'unmatched', 'needs_review')),
  ADD COLUMN posting_note               TEXT,
  -- A row from an upload always says where it sits in the file and what its
  -- posting did: re-uploading the file retries exactly the claims that did
  -- not post, which is read from these three columns.
  ADD CONSTRAINT era_835_record_upload_row_check
    CHECK (remittance_file_id IS NULL
           OR (posting IS NOT NULL AND claim_seq IS NOT NULL AND line_seq IS NOT NULL));

CREATE UNIQUE INDEX era_835_file_line_uniq
  ON era_835_record (remittance_file_id, claim_seq, line_seq)
  WHERE remittance_file_id IS NOT NULL;

CREATE INDEX era_835_superbill_idx
  ON era_835_record (superbill_id)
  WHERE superbill_id IS NOT NULL;

ALTER TABLE superbill
  ADD COLUMN IF NOT EXISTS paid_source TEXT
    CONSTRAINT superbill_paid_source_check CHECK (paid_source IN ('recorded', 'remittance'));

-- Every paid amount on file today was typed in Pallio.
UPDATE superbill
   SET paid_source = 'recorded'
 WHERE paid_amount_cents IS NOT NULL
   AND paid_source IS NULL;

ALTER TABLE superbill_denial
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'recorded'
    CONSTRAINT superbill_denial_source_check CHECK (source IN ('recorded', 'remittance'));

COMMENT ON TABLE remittance_file IS
  'One uploaded ERA/835, unique per org by the sha256 of its text (audit R10). Its claims post to superbills; each service line is an era_835_record row. Nothing from NM1*QC is stored.';
COMMENT ON COLUMN era_835_record.posting IS
  'What the upload did with this line''s claim: paid / partially_paid / denied posted to superbill_id; unmatched and needs_review are retried when the same file is uploaded again.';
COMMENT ON COLUMN superbill.paid_source IS
  'Where paid_amount_cents came from: recorded (typed in Pallio) or remittance (posted from a payer 835). NULL while unpaid.';
COMMENT ON COLUMN superbill_denial.source IS
  'recorded (logged or marked in Pallio) or remittance (posted from a payer 835, carrying the payer''s own CARC).';

-- Read-only check after applying (expect patient_external_id and raw_segment
-- NULL on every upload row):
--   SELECT posting, superbill_id IS NOT NULL AS linked,
--          patient_external_id, raw_segment
--     FROM era_835_record WHERE remittance_file_id IS NOT NULL;
