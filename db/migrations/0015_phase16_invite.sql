-- ============================================================================
-- 0015_phase16_invite.sql
-- Phase 16 — magic-link first-admin invite. Anonymous redeem path takes a
-- bare token, looks up the row by SHA-256 hash + a constant-prefix-index,
-- returns the org/user/role context the front-end needs to bootstrap a
-- session.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- invite_token — single-use magic-link issued per (org, user). Token is
-- 32 bytes of randomness rendered as base64url; we store SHA-256(token)
-- only, plus a 12-char lookup prefix on the *raw* token to make the
-- redeem query a fast index hit (instead of full-table scan to compare
-- hashes). The prefix is non-secret on its own; SHA-256 of full token
-- is the security boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE invite_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  -- 12 base64url chars from the start of the raw token. Non-secret on
  -- its own (32 bytes / 256 bits >> 12 chars / 72 bits) — used to
  -- index-narrow before the constant-time hash compare in app code.
  token_lookup_prefix CHAR(12) NOT NULL,

  -- SHA-256 of the full raw token, hex-encoded (64 chars).
  token_hash CHAR(64) NOT NULL,

  role TEXT NOT NULL CHECK (role IN ('employee','reviewer','admin','consultant')),

  -- Lifecycle. consumed_at IS NOT NULL means the token has been redeemed
  -- once and cannot be redeemed again.
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_ip INET,

  -- Forensics — who issued it.
  issued_by UUID REFERENCES app_user(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup path: index on (token_lookup_prefix) hits 1 row in the typical
-- case (12 base64url chars = ~72 bits of entropy across the prefix
-- alone). Even at 1M live invites the expected collision count is < 1.
CREATE INDEX invite_token_prefix_idx ON invite_token (token_lookup_prefix)
  WHERE consumed_at IS NULL;

-- For admin-side listing + cleanup.
CREATE INDEX invite_token_org_idx ON invite_token (org_id, created_at DESC);
CREATE INDEX invite_token_expiry_idx ON invite_token (expires_at)
  WHERE consumed_at IS NULL;

SELECT app.apply_tenant_rls('invite_token');
