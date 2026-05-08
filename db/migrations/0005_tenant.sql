-- ============================================================================
-- 0005_tenant.sql
-- Multi-tenant tables. ALL get RLS enabled in 0007_rls.sql.
-- Includes: org, org_member, client_company, client_rulebook, client_rule,
-- audit_log, consent_record (42 CFR Part 2), alert.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- org: a billing company / RCM firm / BPO. The tenant boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE org (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                CITEXT      NOT NULL,
  slug                CITEXT      NOT NULL UNIQUE,             -- URL-safe identifier
  plan_tier           TEXT        NOT NULL DEFAULT 'solo' CHECK (plan_tier IN ('solo','team','org','enterprise')),
  baa_signed_at       TIMESTAMPTZ,
  baa_document_uri    TEXT,
  primary_contact_email CITEXT,
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX org_status_idx ON org (status);

-- ---------------------------------------------------------------------------
-- app_user: registered users. May belong to multiple orgs via org_member.
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               CITEXT      NOT NULL UNIQUE,
  full_name           TEXT,
  password_hash       TEXT,                                    -- argon2 / bcrypt; NULL when SSO-only
  mfa_secret          TEXT,                                    -- TOTP secret (encrypted)
  mfa_enrolled_at     TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  last_login_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- org_member: user ↔ org with role.
-- ---------------------------------------------------------------------------
CREATE TABLE org_member (
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id             UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role                TEXT        NOT NULL CHECK (role IN ('employee','reviewer','admin','consultant')),
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_by          UUID        REFERENCES app_user(id),
  joined_at           TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','removed')),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_member_user_idx ON org_member (user_id);

-- ---------------------------------------------------------------------------
-- client_company: a customer practice that an org bills for.
-- One org → many client_company. Each client_company has its own rulebook history.
-- ---------------------------------------------------------------------------
CREATE TABLE client_company (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name                CITEXT      NOT NULL,
  npi                 TEXT,                                    -- 10-digit; NULL if group only
  primary_state       CHAR(2)     REFERENCES state(state),
  specialties         TEXT[]      NOT NULL DEFAULT '{}',       -- e.g. {'palliative','hospice'}
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX client_company_org_idx ON client_company (org_id);

-- ---------------------------------------------------------------------------
-- client_rulebook: versioned snapshot of a client's finalized rules.
-- ---------------------------------------------------------------------------
CREATE TABLE client_rulebook (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id           UUID        NOT NULL REFERENCES client_company(id) ON DELETE CASCADE,
  version             INT         NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','finalized','archived')),
  finalized_at        TIMESTAMPTZ,
  finalized_by        UUID        REFERENCES app_user(id),
  parent_version_id   UUID        REFERENCES client_rulebook(id),
  source_doc_ids      UUID[]      NOT NULL DEFAULT '{}',       -- which uploads fed this rulebook
  notes               TEXT,
  integrity_hash      TEXT,                                    -- sha256 over finalized rule set
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);

CREATE INDEX client_rulebook_org_idx ON client_rulebook (org_id, client_id, version DESC);

-- ---------------------------------------------------------------------------
-- client_rule: per-rule decision in a rulebook. Mirrors payer_rule shape.
-- ---------------------------------------------------------------------------
CREATE TABLE client_rule (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  rulebook_id         UUID        NOT NULL REFERENCES client_rulebook(id) ON DELETE CASCADE,
  payer_id            UUID        NOT NULL REFERENCES payer(id),
  state               CHAR(2)     NOT NULL REFERENCES state(state),
  product_line        TEXT        NOT NULL REFERENCES product_line(product_line),
  code                TEXT        NOT NULL,
  attribute           TEXT        NOT NULL,
  value               JSONB       NOT NULL,
  decision            TEXT        NOT NULL CHECK (decision IN (
                        'accept_authoritative','keep_client','edit_custom','intentional_deviation'
                      )),
  decision_note       TEXT,
  authoritative_rule_id UUID      REFERENCES payer_rule(id),    -- the row diffed against
  decided_by          UUID        REFERENCES app_user(id),
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX client_rule_rulebook_idx ON client_rule (rulebook_id);
CREATE INDEX client_rule_org_idx ON client_rule (org_id);

-- ---------------------------------------------------------------------------
-- audit_log: append-only audit of every privileged action.
-- HIPAA requires 6-year retention. Use S3 Object Lock for cold storage beyond DB.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id),
  user_id             UUID        REFERENCES app_user(id),
  action              TEXT        NOT NULL,                    -- 'lookup','accept_diff','finalize_rulebook','consent_grant','login',...
  target_type         TEXT,                                    -- 'client_rulebook','client_rule','consent_record',...
  target_id           UUID,
  payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address          INET,
  user_agent          TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_time_idx ON audit_log (org_id, occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- consent_record: 42 CFR Part 2 TPO consent for SUD claim submission.
-- Effective Feb 16, 2026: SUD claims require active TPO consent.
-- Single consent covers Treatment + Payment + Operations across providers in
-- the patient's care network.
-- ---------------------------------------------------------------------------
CREATE TABLE consent_record (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id           UUID        NOT NULL REFERENCES client_company(id) ON DELETE CASCADE,
  patient_external_id TEXT        NOT NULL,                    -- hashed/de-id reference to client's record
  scope               TEXT[]      NOT NULL DEFAULT '{}',       -- {'TPO_treatment','TPO_payment','TPO_operations'}
  granted_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  document_uri        TEXT,                                    -- s3:// path to signed consent doc
  source              TEXT        NOT NULL DEFAULT 'client_upload',
  notes               TEXT,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE INDEX consent_record_lookup_idx ON consent_record
  (org_id, client_id, patient_external_id);

-- ---------------------------------------------------------------------------
-- alert: proactive notifications when authoritative changes affect a finalized rulebook.
-- ---------------------------------------------------------------------------
CREATE TABLE alert (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id           UUID        REFERENCES client_company(id) ON DELETE CASCADE,
  rulebook_id         UUID        REFERENCES client_rulebook(id) ON DELETE CASCADE,
  alert_type          TEXT        NOT NULL CHECK (alert_type IN (
                        'rule_change','new_diff','source_expired',
                        'consent_required','attestation_expiring',
                        'extraction_drift','source_unavailable'
                      )),
  severity            TEXT        NOT NULL CHECK (severity IN ('critical','high','medium','info')),
  payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  related_rule_id     UUID        REFERENCES payer_rule(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at     TIMESTAMPTZ,
  acknowledged_by     UUID        REFERENCES app_user(id),
  auto_resolved_at    TIMESTAMPTZ
);

CREATE INDEX alert_org_unread_idx ON alert (org_id, created_at DESC)
  WHERE acknowledged_at IS NULL AND auto_resolved_at IS NULL;
CREATE INDEX alert_severity_idx ON alert (severity, created_at DESC)
  WHERE acknowledged_at IS NULL;
