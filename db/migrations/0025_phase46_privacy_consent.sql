-- ============================================================================
-- 0025_phase46_privacy_consent.sql
-- Phase 46 — consumer-privacy consent + Data Subject Access Requests (DSAR).
--
-- Distinct from the patient TPO `consent_record` table:
--   - `privacy_consent` records consumer-facing privacy notices
--     (WMHMDA, CCPA, CPA, AB 3030, Colorado SB24-205) acceptances.
--   - `dsar_request` records access/deletion requests filed under
--     each respective regime, with status tracking + 45-day clock.
--
-- Both are tenant-scoped (a tenant's billers' consents flow to their
-- own org_id; an end consumer's data subject request flows to the
-- org that holds the data).
-- ============================================================================

CREATE TABLE privacy_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id UUID REFERENCES app_user(id),
  -- Subject identity for non-app-user consents (e.g., patient).
  subject_external_id TEXT,
  -- Regime that this consent satisfies. Multiple regimes can apply
  -- to one user → one row per (regime, version).
  regime TEXT NOT NULL CHECK (regime IN (
    'wmhmda',           -- Washington My Health My Data Act
    'ccpa',             -- California CCPA/CPRA
    'cpa_co',           -- Colorado Consumer Privacy Act
    'tdpsa_tx',         -- Texas Data Privacy and Security Act
    'vcdpa_va',         -- Virginia
    'ab3030_ai',        -- California AB 3030 AI patient communication
    'sb24_205_ai_co',   -- Colorado AI Act SB24-205
    'general'
  )),
  -- Notice version this consent attaches to. Bumped when wording changes.
  notice_version TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  ip_address INET,
  user_agent TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
  -- (PK is declared inline on the `id` column above; a second PRIMARY KEY
  -- here would be rejected.)
);

CREATE INDEX privacy_consent_subject_idx
  ON privacy_consent (org_id, regime, granted_at DESC);

SELECT app.apply_tenant_rls('privacy_consent');

CREATE TABLE dsar_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Subject identity. Either app_user OR external (email + name).
  user_id UUID REFERENCES app_user(id),
  subject_email TEXT,
  subject_name TEXT,
  regime TEXT NOT NULL CHECK (regime IN (
    'wmhmda', 'ccpa', 'cpa_co', 'tdpsa_tx', 'vcdpa_va', 'ctdpa_ct', 'utah_ucpa',
    'general'
  )),
  request_type TEXT NOT NULL CHECK (request_type IN (
    'access', 'deletion', 'portability', 'correction', 'opt_out_sale',
    'opt_out_targeted_advertising', 'limit_sensitive_use'
  )),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'verified', 'fulfilled', 'rejected', 'expired')),
  -- 45-day default fulfillment clock from `received_at`.
  due_at TIMESTAMPTZ NOT NULL,
  fulfilled_at TIMESTAMPTZ,
  rejection_reason TEXT,
  notes TEXT,
  ip_address INET,
  user_agent TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX dsar_request_status_idx
  ON dsar_request (org_id, status, due_at)
  WHERE status IN ('received', 'verified');

SELECT app.apply_tenant_rls('dsar_request');
