-- ============================================================================
-- 0120 — Clearinghouse connections and the claim cycle through them
-- (Level-1 doc:23, :72-:74; Mark [v1 08:22-10:58]: the clearinghouse "sends it
-- through to the right payer", and the four he named are Availity, Waystar,
-- TriZetto and Inovalon).
--
--   clearinghouse_connection  one per clearinghouse account the practice uses:
--                             which vendor, test or production, the IDs its
--                             files carry, how files travel (SFTP, or the
--                             practice downloads and uploads them itself) and
--                             how real-time checks are asked (CAQH CORE, or
--                             Availity's API). Passwords, keys and client
--                             secrets are encrypted (pgp_sym_encrypt with
--                             PALLIO_TOKEN_KEY, as the Google tokens of 0045)
--                             and never read back to a browser.
--   clearinghouse_payer_id    the payer ID each clearinghouse knows a payer by
--                             (837P 2010BB NM109): they differ by clearinghouse.
--   claim_submission / _item  each 837P file Pallio built: sent over SFTP or
--                             downloaded, its interchange and group control
--                             numbers (what the 999 and TA1 answer by), and
--                             per claim what came back: the 999, then the
--                             payer's 277CA.
--   clearinghouse_file        every response file read (from SFTP or uploaded):
--                             999, TA1, 277CA, 277, 271, 835, the vendor's own
--                             notices. Its hash makes reading it twice a no-op.
--                             The file's text is not kept: what it said is
--                             applied to the claims and summarised in counts.
--   superbill_activity.kind   + 'clearinghouse' (the claim's own history).
--   phi_export_log            + 'claim_837', 'eligibility_270',
--                             'claim_status_276': each is a disclosure.
--   insurance_verification    + details, connection_id: what an electronic
--                             coverage check (271) said.
--
-- Control numbers come from two global sequences, so an interchange or group
-- control number is never reused by any org: the 999 names the group it
-- answers by number alone.
--
-- Grants: default privileges (0001, 0052) for the tables; the sequences are
-- granted explicitly as well, so nextval() works whoever runs this.
-- ============================================================================

-- 1. Connections.
CREATE TABLE clearinghouse_connection (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  vendor                TEXT        NOT NULL CHECK (vendor IN ('availity', 'waystar', 'trizetto', 'inovalon')),
  label                 TEXT        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- T or P in ISA15, and which of the vendor's hosts.
  environment           TEXT        NOT NULL CHECK (environment IN ('test', 'production')),
  -- How claim files travel: Pallio uploads them over SFTP and reads the
  -- responses back, or the practice downloads each file and uploads the
  -- responses itself.
  batch_channel         TEXT        NOT NULL DEFAULT 'manual' CHECK (batch_channel IN ('sftp', 'manual')),
  -- How a real-time eligibility (270) or claim status (276) question is asked.
  realtime_channel      TEXT        NOT NULL DEFAULT 'none' CHECK (realtime_channel IN ('none', 'core_soap', 'availity_api')),
  -- IDs, hosts, folders, the submitter contact: nothing secret (validated in
  -- lib/features/clearinghouse/connection-settings.ts).
  settings              JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  -- The secrets, as one encrypted JSON object. NULL when none are saved.
  secrets_enc           BYTEA,
  -- The SFTP server's host key (SHA-256, base64), pinned on the first good
  -- test; a server presenting another key afterwards is refused.
  sftp_host_key_sha256  TEXT        CHECK (sftp_host_key_sha256 IS NULL OR length(sftp_host_key_sha256) BETWEEN 40 AND 64),
  -- Where claims go when nobody picks: one active primary per org.
  is_primary            BOOLEAN     NOT NULL DEFAULT false,
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_test_at          TIMESTAMPTZ,
  last_test_ok          BOOLEAN,
  last_test_message     TEXT        CHECK (last_test_message IS NULL OR length(last_test_message) <= 500),
  last_poll_at          TIMESTAMPTZ,
  last_poll_ok          BOOLEAN,
  last_poll_message     TEXT        CHECK (last_poll_message IS NULL OR length(last_poll_message) <= 500),
  created_by_user_id    UUID        REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    UUID        REFERENCES app_user(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, label)
);
CREATE UNIQUE INDEX clearinghouse_connection_primary_uniq
  ON clearinghouse_connection (org_id) WHERE is_primary AND status = 'active';
SELECT app.apply_tenant_rls('clearinghouse_connection');

-- 2. Payer IDs, per connection.
CREATE TABLE clearinghouse_payer_id (
  connection_id           UUID        NOT NULL REFERENCES clearinghouse_connection(id) ON DELETE CASCADE,
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  payer_id                UUID        NOT NULL REFERENCES payer(id),
  -- 837P 2010BB NM109, 270/276 2100A NM109.
  external_payer_id       TEXT        NOT NULL CHECK (external_payer_id ~ '^[A-Za-z0-9]{2,80}$'),
  -- 837P SBR09, when the payer's type does not say it (MB, MC, CI, 16 …).
  claim_filing_indicator  TEXT        CHECK (claim_filing_indicator IS NULL OR claim_filing_indicator ~ '^[0-9A-Z]{2}$'),
  updated_by_user_id      UUID        REFERENCES app_user(id),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, payer_id)
);
SELECT app.apply_tenant_rls('clearinghouse_payer_id');

-- 3. Control numbers (ISA13, GS06): global, so never reused by any sender.
CREATE SEQUENCE x12_interchange_control_seq MINVALUE 1 MAXVALUE 999999999 CYCLE;
CREATE SEQUENCE x12_group_control_seq MINVALUE 1 MAXVALUE 999999999 CYCLE;
GRANT USAGE, SELECT ON SEQUENCE x12_interchange_control_seq, x12_group_control_seq TO app;

-- 4. The files Pallio built.
CREATE TABLE claim_submission (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  connection_id               UUID        REFERENCES clearinghouse_connection(id) ON DELETE SET NULL,
  -- Kept with the file, so its history reads whole if the connection goes.
  vendor                      TEXT        NOT NULL CHECK (vendor IN ('availity', 'waystar', 'trizetto', 'inovalon')),
  channel                     TEXT        NOT NULL CHECK (channel IN ('sftp', 'download')),
  usage_indicator             TEXT        NOT NULL CHECK (usage_indicator IN ('T', 'P')),
  interchange_control_number  BIGINT      NOT NULL CHECK (interchange_control_number BETWEEN 1 AND 999999999),
  group_control_number        BIGINT      NOT NULL CHECK (group_control_number BETWEEN 1 AND 999999999),
  filename                    TEXT        NOT NULL CHECK (length(filename) BETWEEN 1 AND 120),
  content_sha256              TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size                   INT         NOT NULL CHECK (byte_size > 0),
  claim_count                 INT         NOT NULL CHECK (claim_count > 0),
  -- sending: being uploaded; sent: on the clearinghouse's server;
  -- send_failed: the upload failed, nothing left Pallio; downloaded: handed
  -- to the person who downloaded it.
  state                       TEXT        NOT NULL CHECK (state IN ('sending', 'sent', 'send_failed', 'downloaded')),
  -- What came back for the file as a whole (TA1, the 999's AK9, or the
  -- vendor's own notice).
  ack_state                   TEXT        CHECK (ack_state IS NULL OR ack_state IN (
                                'accepted', 'accepted_with_errors', 'partially_accepted', 'rejected')),
  ack_at                      TIMESTAMPTZ,
  error_message               TEXT        CHECK (error_message IS NULL OR length(error_message) <= 1000),
  created_by_user_id          UUID        REFERENCES app_user(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                     TIMESTAMPTZ,
  UNIQUE (group_control_number),
  UNIQUE (interchange_control_number)
);
CREATE INDEX claim_submission_org_idx ON claim_submission (org_id, created_at DESC);
SELECT app.apply_tenant_rls('claim_submission');

CREATE TABLE claim_submission_item (
  submission_id                   UUID        NOT NULL REFERENCES claim_submission(id) ON DELETE CASCADE,
  org_id                          UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  superbill_id                    UUID        NOT NULL REFERENCES superbill(id) ON DELETE CASCADE,
  -- ST02: one transaction set per claim, so the 999 answers per claim.
  transaction_set_control_number  TEXT        NOT NULL CHECK (transaction_set_control_number ~ '^[0-9]{4,9}$'),
  -- CLM01, what the 277CA and 835 echo back.
  claim_ref                       TEXT        NOT NULL CHECK (claim_ref ~ '^[0-9A-Z]{1,38}$'),
  -- CLM05-3: 1 original, 7 replacement of a claim the payer processed.
  frequency_code                  TEXT        NOT NULL CHECK (frequency_code IN ('1', '7', '8')),
  send_state                      TEXT        NOT NULL CHECK (send_state IN ('sending', 'sent', 'send_failed', 'downloaded')),
  -- The 999 (or TA1) for this claim's transaction set.
  ack_state                       TEXT        CHECK (ack_state IS NULL OR ack_state IN ('accepted', 'accepted_with_errors', 'rejected')),
  ack_errors                      JSONB       CHECK (ack_errors IS NULL OR jsonb_typeof(ack_errors) = 'array'),
  ack_at                          TIMESTAMPTZ,
  -- The payer's acknowledgment (277CA) or a later status (277).
  payer_state                     TEXT        CHECK (payer_state IS NULL OR payer_state IN ('accepted', 'rejected', 'pending', 'finalized')),
  payer_statuses                  JSONB       CHECK (payer_statuses IS NULL OR jsonb_typeof(payer_statuses) = 'array'),
  payer_at                        TIMESTAMPTZ,
  -- REF*1K: the payer's own number for the claim (a replacement names it).
  payer_claim_number              TEXT        CHECK (payer_claim_number IS NULL OR length(payer_claim_number) <= 50),
  -- REF*D9 or the clearinghouse's trace for the claim.
  clearinghouse_trace             TEXT        CHECK (clearinghouse_trace IS NULL OR length(clearinghouse_trace) <= 50),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, superbill_id),
  UNIQUE (submission_id, transaction_set_control_number)
);
CREATE INDEX claim_submission_item_superbill_idx ON claim_submission_item (superbill_id, updated_at DESC);
-- A claim is in at most one file on its way out.
CREATE UNIQUE INDEX claim_submission_item_sending_uniq
  ON claim_submission_item (superbill_id) WHERE send_state = 'sending';
SELECT app.apply_tenant_rls('claim_submission_item');

-- 5. Every response file read.
CREATE TABLE clearinghouse_file (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  connection_id        UUID        REFERENCES clearinghouse_connection(id) ON DELETE SET NULL,
  source               TEXT        NOT NULL CHECK (source IN ('sftp', 'upload', 'realtime')),
  -- The name it had on the clearinghouse's server, or as uploaded.
  remote_name          TEXT        CHECK (remote_name IS NULL OR length(remote_name) BETWEEN 1 AND 255),
  remote_size          BIGINT      CHECK (remote_size IS NULL OR remote_size >= 0),
  kind                 TEXT        NOT NULL CHECK (kind IN (
                         '999', 'ta1', '277ca', '277', '271', '835', 'notification', 'vendor_report', 'unknown')),
  sha256               TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size            INT         NOT NULL CHECK (byte_size >= 0),
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by_user_id  UUID        REFERENCES app_user(id),
  -- applied: it changed claims; nothing_to_apply: read, and nothing in it
  -- concerned a claim (a vendor report, or every claim already answered);
  -- unmatched: it answers files or claims Pallio does not have; failed: unreadable.
  outcome              TEXT        NOT NULL CHECK (outcome IN ('applied', 'nothing_to_apply', 'unmatched', 'failed')),
  -- Counts and control numbers only: no names, member IDs or amounts.
  summary              JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error_message        TEXT        CHECK (error_message IS NULL OR length(error_message) <= 1000),
  remittance_file_id   UUID        REFERENCES remittance_file(id) ON DELETE SET NULL,
  UNIQUE (org_id, sha256)
);
CREATE INDEX clearinghouse_file_org_idx ON clearinghouse_file (org_id, received_at DESC);
CREATE INDEX clearinghouse_file_remote_idx ON clearinghouse_file (connection_id, remote_name);
SELECT app.apply_tenant_rls('clearinghouse_file');

-- 6. The claim's history says what the clearinghouse said.
ALTER TABLE superbill_activity DROP CONSTRAINT IF EXISTS superbill_activity_kind_check;
ALTER TABLE superbill_activity ADD CONSTRAINT superbill_activity_kind_check
  CHECK (kind IN ('created', 'edited', 'status_change', 'denial_logged', 'denial_decision', 'resubmitted',
                  'exported', 'clearinghouse'));

-- 7. Disclosures: an 837P file downloaded or sent, a coverage or claim status
-- question asked. The logger swallows a refused insert, so the CHECK has to
-- know the kinds before the routes ship (as 0090, 0118, 0119).
ALTER TABLE phi_export_log DROP CONSTRAINT IF EXISTS phi_export_log_export_type_check;
ALTER TABLE phi_export_log ADD CONSTRAINT phi_export_log_export_type_check
  CHECK (export_type IN (
    'cheat_sheet', 'superbill_pdf', 'report_csv', 'patient_record_pdf', 'rule_lookup_pdf',
    'visit_audit_packet', 'claim_csv', 'offline_snapshot', 'claim_837', 'eligibility_270',
    'claim_status_276'));

-- 8. What an electronic coverage check said.
ALTER TABLE insurance_verification
  ADD COLUMN IF NOT EXISTS details JSONB
    CONSTRAINT insurance_verification_details_object CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES clearinghouse_connection(id) ON DELETE SET NULL;
COMMENT ON COLUMN insurance_verification.details IS
  'The payer''s answer to an electronic eligibility check (271, or Availity''s coverage API), summarised: coverage, plan, dates, benefits, hospice. 0120.';

COMMENT ON TABLE clearinghouse_connection IS
  'A clearinghouse account the practice uses (Availity, Waystar, TriZetto, Inovalon): IDs, channels, encrypted secrets. 0120.';
COMMENT ON TABLE claim_submission IS
  'An 837P file Pallio built, sent over SFTP or downloaded, with the control numbers its acknowledgments answer by. 0120.';
COMMENT ON TABLE clearinghouse_file IS
  'A response file read from a clearinghouse or uploaded (999, TA1, 277CA, 277, 271, 835, vendor notices); the text is not kept. 0120.';
