-- ============================================================================
-- 0032_phase_pallio_attestations_branding.sql
--
-- Phase 6 — analyst attestation workflow + org branding.
--
-- Sources:
--   §6.6 (Payer Knowledge Base) — analyst attestation, 90-day expiry
--   §6.1 (Organization Settings) — branding (logo, color, custom domain)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- analyst_attestation: payer-rule confirmations sourced from a phone call
-- with the payer's provider line. Drives the §5.4 "low-confidence" tier
-- in rule lookup when no document supports a rule.
-- ----------------------------------------------------------------------------
CREATE TABLE analyst_attestation (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  payer_id            UUID        NOT NULL REFERENCES payer(id),
  state               CHAR(2)     NOT NULL,
  cpt_code            TEXT        NOT NULL,
  attribute           TEXT        NOT NULL,                       -- e.g. 'covered','prior_auth'
  -- The confirmed rule value — JSONB matching the same shape as
  -- payer_rule.value so the lookup engine can ingest it transparently.
  rule_value          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  coverage_status     TEXT        NOT NULL CHECK (coverage_status IN
                                     ('covered', 'not_covered', 'varies', 'unknown')),

  -- Call details — required for audit defensibility (§6.6).
  payer_rep_name      TEXT        NOT NULL,
  payer_rep_id        TEXT,                                       -- ref/badge number, optional
  call_date           DATE        NOT NULL,
  call_time           TEXT,                                       -- e.g. '09:32 ET' free-text
  call_phone_number   TEXT,
  call_notes          TEXT,
  /* Verbatim quote / paraphrase from the call. Mark's
     analysts paste rep wording for audit defense. */
  confirmed_quote     TEXT,

  /* 90-day expiration per §15.3. Defaults to call_date + 90 days but
     analysts can override (some payers issue longer-term commitments). */
  expires_at          DATE        NOT NULL,
  /* Lifecycle. 'active'  → in lookup pool.
                'expired' → past expires_at, not used.
                'voided'  → analyst marked stale before expiry.
                're_verified' → re-confirmed via a follow-up call;
                                 superseded by a newer row that points
                                 here via supersedes_id. */
  status              TEXT        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','expired','voided','re_verified')),
  supersedes_id       UUID        REFERENCES analyst_attestation(id),

  attested_by_user_id UUID        NOT NULL REFERENCES app_user(id),
  voided_by_user_id   UUID        REFERENCES app_user(id),
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  /* The active attestation set must be unique per (org, payer, state, code,
     attribute) — only ONE current truth per cell. */
  CONSTRAINT analyst_attestation_call_chk
    CHECK (length(payer_rep_name) > 0 AND expires_at > call_date)
);

CREATE UNIQUE INDEX analyst_attestation_active_unique_idx
  ON analyst_attestation (org_id, payer_id, state, cpt_code, attribute)
  WHERE status = 'active';

CREATE INDEX analyst_attestation_expiring_idx
  ON analyst_attestation (org_id, expires_at)
  WHERE status = 'active';

CREATE INDEX analyst_attestation_payer_idx
  ON analyst_attestation (org_id, payer_id);

COMMENT ON TABLE analyst_attestation IS
  'Phone-confirmed payer rules. Expires after 90 days by default; the lookup engine prefers source-document rules + falls through to active attestations for low-confidence answers.';

SELECT app.apply_tenant_rls('analyst_attestation');

-- ----------------------------------------------------------------------------
-- analyst_attestation_request: rules the lookup engine pushed to the
-- analyst queue when no source matched. The analyst picks one, makes
-- the call, then creates an `analyst_attestation` row that resolves
-- the request.
-- ----------------------------------------------------------------------------
CREATE TABLE analyst_attestation_request (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  payer_id            UUID        REFERENCES payer(id),
  state               CHAR(2),
  cpt_code            TEXT        NOT NULL,
  attribute           TEXT        NOT NULL,
  -- The original query that surfaced this gap — for reproducibility.
  source_query        TEXT,
  /* 'open'        → in queue, no analyst picked it up
     'in_progress' → analyst started but hasn't filed an attestation
     'resolved'    → an analyst_attestation row exists
     'duplicate'   → closed because another request covered it
     'irrelevant'  → analyst dismissed (with reason) */
  status              TEXT        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','in_progress','resolved','duplicate','irrelevant')),
  resolved_attestation_id UUID    REFERENCES analyst_attestation(id),
  claimed_by_user_id  UUID        REFERENCES app_user(id),
  claimed_at          TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX analyst_attestation_request_org_status_idx
  ON analyst_attestation_request (org_id, status, created_at DESC);

SELECT app.apply_tenant_rls('analyst_attestation_request');

-- ----------------------------------------------------------------------------
-- org_branding: per-org white-label. Logo / primary color / custom
-- domain. Cookies + middleware (Phase 7) flip the surface based on
-- the request's hostname when custom_domain is set.
-- ----------------------------------------------------------------------------
CREATE TABLE org_branding (
  org_id              UUID        PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  display_name        TEXT,                                     -- override of org.name on the FE
  logo_url            TEXT,                                     -- public URL or s3:// path
  -- Hex color (e.g. '#0d9488'). Defaults to Pallio teal.
  primary_color       TEXT        CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Custom domain like 'billing.acmehospice.com'. CNAME points to Pallio.
  custom_domain       CITEXT      UNIQUE,
  -- DNS verification status. Phase 7 wires the actual probe.
  domain_status       TEXT        NOT NULL DEFAULT 'unconfigured'
                                  CHECK (domain_status IN ('unconfigured','pending','verified','failed')),
  domain_last_checked TIMESTAMPTZ,

  email_from_name     TEXT,                                     -- override sender name on outbound mail
  email_from_address  TEXT,                                     -- e.g. 'billing@acmehospice.com'

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT app.apply_tenant_rls('org_branding');

-- ----------------------------------------------------------------------------
-- cheat_sheet_generation: log of every cheat-sheet PDF rendered for
-- the org. Lets us re-download without regenerating + audits which
-- consultant pulled which client sheet.
-- ----------------------------------------------------------------------------
CREATE TABLE cheat_sheet_generation (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  /* What was rendered. NULL state/payer/code means "all" — Mark
     occasionally pulls a master cheat sheet covering every active
     combo. */
  state               CHAR(2),
  payer_id            UUID        REFERENCES payer(id),
  cpt_codes           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  /* Storage. file:// in dev; s3:// in prod. */
  pdf_path            TEXT        NOT NULL,
  pdf_byte_size       BIGINT      NOT NULL DEFAULT 0,
  /* Title / branding snapshot used when rendered (so re-downloading
     reflects what the client saw, even if the org rebranded later). */
  rendered_title      TEXT        NOT NULL,
  rendered_logo_url   TEXT,

  generated_by_user_id UUID       REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* Soft-delete: keep history but hide from default list. */
  archived_at         TIMESTAMPTZ
);

CREATE INDEX cheat_sheet_generation_org_idx
  ON cheat_sheet_generation (org_id, created_at DESC)
  WHERE archived_at IS NULL;

SELECT app.apply_tenant_rls('cheat_sheet_generation');
