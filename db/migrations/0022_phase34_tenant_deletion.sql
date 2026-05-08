-- ============================================================================
-- 0022_phase34_tenant_deletion.sql
-- Phase 34 — tenant data deletion (MSA § 7).
--
-- Two new tables:
--
--   tenant_deletion_request — admin-initiated deletion. State machine:
--     requested → scheduled (after 30-day notice) → executed | canceled.
--     The executor runs once per day; the 30-day floor is enforced
--     server-side so a buggy admin click can't trigger immediate
--     deletion of customer data.
--
--   audit_log_redaction — HIPAA right-to-amend break-glass surface.
--     Records every operator-initiated PII redaction against an
--     audit_log row's payload (we keep the row id + occurred_at but
--     scrub the payload). Append-only audit-of-audit-redactions.
-- ============================================================================

CREATE TABLE tenant_deletion_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL UNIQUE REFERENCES org(id) ON DELETE CASCADE,

  -- Lifecycle.
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','scheduled','executed','canceled','failed')),
  -- 30-day grace window per MSA § 7.2 — the executor refuses to run
  -- before this timestamp.
  earliest_execute_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  failure_reason TEXT,

  -- Audit context — who requested, who confirmed, why.
  requested_by_user_id UUID REFERENCES app_user(id),
  confirmation_phrase TEXT NOT NULL,         -- typed back by admin to confirm intent
  reason TEXT,                               -- free-text optional
  retain_audit_log BOOLEAN NOT NULL DEFAULT true, -- HIPAA 6-year audit-log retention

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tenant_deletion_request_status_idx
  ON tenant_deletion_request (status, earliest_execute_at)
  WHERE status IN ('requested', 'scheduled');

-- audit_log_redaction — every operator redaction recorded forever.
-- org_id duplicated from the target audit_log row so RLS works without
-- a join on every read.
CREATE TABLE audit_log_redaction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  audit_log_id UUID NOT NULL REFERENCES audit_log(id),
  redacted_by_user_id UUID NOT NULL REFERENCES app_user(id),
  reason TEXT NOT NULL,
  redaction_type TEXT NOT NULL CHECK (redaction_type IN ('payload_scrub','payload_remove')),
  -- Hash of the original payload (sha256) so a future audit can prove
  -- a redaction happened without leaking the redacted content.
  original_payload_hash CHAR(64) NOT NULL,
  redacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_redaction_target_idx ON audit_log_redaction (audit_log_id);
CREATE INDEX audit_log_redaction_org_idx ON audit_log_redaction (org_id, redacted_at DESC);

-- Tenant isolation for both new tables.
SELECT app.apply_tenant_rls('tenant_deletion_request');
SELECT app.apply_tenant_rls('audit_log_redaction');
