-- ============================================================================
-- 0009_reconciliation_alerts_webhooks.sql
-- Phase 3 schema: client document upload + PHI redaction audit, webhook
-- subscriptions + deliveries, attestation re-verification scheduling.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- client_doc_upload: provenance of a raw client rule doc (PDF/XLSX/text).
-- The raw bytes go to S3 with Object Lock; we persist only the redacted text.
-- Tenant-scoped (RLS).
-- ---------------------------------------------------------------------------
CREATE TABLE client_doc_upload (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id             UUID        NOT NULL REFERENCES client_company(id) ON DELETE CASCADE,
  uploaded_by           UUID        REFERENCES app_user(id),
  original_filename     TEXT        NOT NULL,
  content_type          TEXT,
  byte_size             BIGINT      NOT NULL,
  raw_storage_uri       TEXT,                       -- s3:// path (Object Lock 6yr)
  redacted_text         TEXT,                       -- the parsed text, with PHI redacted
  redacted_storage_uri  TEXT,                       -- s3:// path of redacted version
  redaction_summary     JSONB       NOT NULL DEFAULT '{}'::jsonb,
                                                    -- {phi_categories: {mrn: 3, ssn: 0, ...}, redaction_count: 7}
  source_document_id    UUID        REFERENCES source_document(id),
                                                    -- once analyst extraction begins, this links the doc to a global source_document
  status                TEXT        NOT NULL DEFAULT 'redacted' CHECK (status IN (
                          'received','redacting','redacted','extracted','rejected','expired'
                        )),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX client_doc_upload_org_idx ON client_doc_upload (org_id, created_at DESC);
CREATE INDEX client_doc_upload_client_idx ON client_doc_upload (client_id, created_at DESC);

SELECT app.apply_tenant_rls('client_doc_upload');

-- ---------------------------------------------------------------------------
-- redaction_event: append-only audit of every PHI redaction action.
-- Records WHAT was redacted (category counts only, NEVER the redacted text)
-- so we can prove our redaction pipeline is doing its job during a SOC 2
-- audit without leaking PHI into the audit table itself.
-- ---------------------------------------------------------------------------
CREATE TABLE redaction_event (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  upload_id             UUID        NOT NULL REFERENCES client_doc_upload(id) ON DELETE CASCADE,
  redactor_name         TEXT        NOT NULL,        -- 'regex_v1', 'comprehend_medical_v1'
  redactor_version      TEXT        NOT NULL,
  category_counts       JSONB       NOT NULL,        -- {mrn: 3, ssn: 0, dob: 1, member_id: 0, ssn_like: 1}
  total_redactions      INT         NOT NULL,
  performed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  performed_by          TEXT        NOT NULL         -- 'system' or analyst email
);

CREATE INDEX redaction_event_upload_idx ON redaction_event (upload_id);

SELECT app.apply_tenant_rls('redaction_event');

-- ---------------------------------------------------------------------------
-- webhook_subscription: per-org webhook endpoints that fire on alerts /
-- rule changes / rulebook lifecycle events.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_subscription (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  url                   TEXT        NOT NULL,
  signing_secret        TEXT        NOT NULL,        -- HMAC-SHA256 base for X-Signature header
  event_types           TEXT[]      NOT NULL,        -- e.g. {'alert.created','rulebook.finalized','rule.changed','dispute.resolved'}
  status                TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  last_success_at       TIMESTAMPTZ,
  last_failure_at       TIMESTAMPTZ,
  consecutive_failures  INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_subscription_org_idx ON webhook_subscription (org_id, status);

SELECT app.apply_tenant_rls('webhook_subscription');

-- ---------------------------------------------------------------------------
-- webhook_delivery: per-attempt log; persistent retry queue.
-- ready_at = next attempt time (NULL on terminal success or terminal failure).
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_delivery (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  subscription_id       UUID        NOT NULL REFERENCES webhook_subscription(id) ON DELETE CASCADE,
  event_id              UUID        NOT NULL,        -- correlation; e.g. alert.id or rulebook.id
  event_type            TEXT        NOT NULL,
  payload               JSONB       NOT NULL,
  signature             TEXT        NOT NULL,        -- 'sha256=<hex>'
  attempt_count         INT         NOT NULL DEFAULT 0,
  max_attempts          INT         NOT NULL DEFAULT 8,
  ready_at              TIMESTAMPTZ,                  -- when the worker should next try; NULL = done
  last_attempt_at       TIMESTAMPTZ,
  last_status_code      INT,
  last_error            TEXT,
  status                TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN (
                          'queued','in_flight','succeeded','failed','dead_letter'
                        )),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_delivery_ready_idx ON webhook_delivery (ready_at, status)
  WHERE status IN ('queued','in_flight');
CREATE INDEX webhook_delivery_org_idx ON webhook_delivery (org_id, created_at DESC);

SELECT app.apply_tenant_rls('webhook_delivery');

-- ---------------------------------------------------------------------------
-- attestation_reverification: a payer_rule that came from an analyst call
-- needs re-verification every 90 days. We track the schedule explicitly.
-- ---------------------------------------------------------------------------
CREATE TABLE attestation_reverification (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_rule_id         UUID        NOT NULL REFERENCES payer_rule(id) ON DELETE CASCADE,
  reverify_by           DATE        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','overdue','superseded')),
  completed_at          TIMESTAMPTZ,
  completed_by          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attestation_reverification_due_idx ON attestation_reverification (reverify_by, status)
  WHERE status = 'pending';

CREATE UNIQUE INDEX attestation_reverification_one_open_per_rule
  ON attestation_reverification (payer_rule_id)
  WHERE status = 'pending';

-- updated_at trigger reuse from 0008
CREATE TRIGGER client_doc_upload_updated_at
  BEFORE UPDATE ON client_doc_upload
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE client_doc_upload IS
  'Tenant-scoped client document uploads. Raw bytes in S3 Object Lock; only redacted text persists in DB.';
COMMENT ON TABLE redaction_event IS
  'Append-only PHI redaction audit. Stores category counts, NOT the redacted text.';
COMMENT ON TABLE webhook_subscription IS
  'Tenant-scoped webhook endpoints for alert/rule/rulebook events.';
COMMENT ON TABLE webhook_delivery IS
  'Persistent retry queue for webhook deliveries with HMAC-signed payloads.';
COMMENT ON TABLE attestation_reverification IS
  'Schedule for 90-day re-verification of analyst-attested payer_rule rows.';
