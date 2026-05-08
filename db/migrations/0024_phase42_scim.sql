-- ============================================================================
-- 0024_phase42_scim.sql
-- Phase 42 — SCIM 2.0 (RFC 7643/7644) provisioning surface.
--
-- Per-org bearer tokens that authenticate IdP SCIM clients (Okta,
-- Azure AD/Entra, Google) when they push user lifecycle events.
-- Tokens are hashed with SHA-256 at rest; the plaintext is shown
-- exactly once at create time.
--
-- We don't need a separate user/group table — SCIM Users map directly
-- to (`app_user`, `org_member`) and SCIM Groups map to the role
-- enum on `org_member.role`.
-- ============================================================================

CREATE TABLE scim_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- SHA-256 hex of the plaintext token.
  token_hash CHAR(64) NOT NULL UNIQUE,
  -- Last 8 chars of the plaintext, displayed in admin UI to identify
  -- which token is which without leaking the secret.
  display_suffix CHAR(8) NOT NULL,
  description TEXT,
  created_by_user_id UUID REFERENCES app_user(id),
  expires_at TIMESTAMPTZ,                 -- NULL = no expiry
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scim_token_org_active_idx ON scim_token (org_id)
  WHERE revoked_at IS NULL;

SELECT app.apply_tenant_rls('scim_token');

-- Cross-tenant lookup function — the SCIM auth guard hashes the
-- presented bearer + needs to find the (org_id, token_id) match
-- across tenants. RLS would block that without setting an orgId
-- first, which we don't have until after the lookup.
CREATE OR REPLACE FUNCTION app.lookup_scim_token(p_token_hash CHAR(64))
RETURNS TABLE (
  id UUID,
  org_id UUID,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT id, org_id, expires_at, revoked_at
  FROM scim_token
  WHERE token_hash = p_token_hash
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION app.lookup_scim_token(CHAR(64)) TO app;
