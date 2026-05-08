-- ============================================================================
-- 0026_phase64_clearinghouse_credentials.sql
-- Phase 64 — per-tenant clearinghouse credentials.
--
-- Each tenant brings their own clearinghouse account (Availity is the
-- primary target; Change Healthcare + Waystar share the schema). The
-- credentials are encrypted at rest with AES-256-GCM keyed by the
-- platform's `CREDENTIAL_ENCRYPTION_KEY` env (Secrets Manager in prod).
-- We store the ciphertext + IV + auth tag; the plaintext never lives
-- on disk and is only briefly in memory during outbound API calls.
--
-- Usage: outbound 270 eligibility, 837 claim submission, 835 ERA pull.
-- The per-tenant `last_verified_at` is updated by a "test connection"
-- admin action so customers can prove their credentials work.
-- ============================================================================

CREATE TABLE tenant_clearinghouse_credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  clearinghouse TEXT NOT NULL CHECK (clearinghouse IN ('availity', 'change_healthcare', 'waystar')),

  -- AES-256-GCM ciphertext of the credentials payload (JSON-encoded
  -- before encryption — different clearinghouses have different shapes:
  -- Availity uses {clientId, clientSecret}; Change uses
  -- {username, password, traderId}). Stored as base64.
  ciphertext TEXT NOT NULL,
  -- 12-byte IV (base64). Unique per encrypt; never reused.
  iv TEXT NOT NULL,
  -- 16-byte GCM auth tag (base64).
  auth_tag TEXT NOT NULL,
  -- Which version of the encryption key was used. Lets us rotate the
  -- master key + re-encrypt rows lazily.
  key_version INTEGER NOT NULL DEFAULT 1,

  -- Display-only — the LAST 4 chars of the credential (e.g. last 4 of
  -- the client_id) so admins can identify which credential is which
  -- without revealing the secret.
  display_suffix TEXT NOT NULL,
  -- Optional human label. "Availity Production", "Sandbox", etc.
  label TEXT,

  created_by_user_id UUID REFERENCES app_user(id),
  -- Updated by /v1/admin/clearinghouse/credentials/:id/test
  last_verified_at TIMESTAMPTZ,
  last_verification_status TEXT CHECK (last_verification_status IN ('ok', 'failed', NULL)),
  last_verification_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One credential per (org, clearinghouse) — replace not append.
  -- Keeps the lookup O(1) and avoids ambiguity ("which Availity creds?").
  UNIQUE (org_id, clearinghouse)
);

CREATE INDEX tenant_clearinghouse_credential_org_idx
  ON tenant_clearinghouse_credential (org_id, clearinghouse);

SELECT app.apply_tenant_rls('tenant_clearinghouse_credential');
