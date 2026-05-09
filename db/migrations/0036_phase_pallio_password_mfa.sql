-- ============================================================================
-- 0036_phase_pallio_password_mfa.sql
--
-- Phase 10 — password reset tokens + MFA recovery codes.
--
-- Adds:
--   password_reset_token: short-lived single-use tokens for forgot-password.
--   mfa_recovery_code:   10 single-use codes per user-enrollment.
--
-- The app_user already has mfa_secret + mfa_enrolled_at columns, so the
-- TOTP secret itself lands there. This migration covers everything else.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- password_reset_token: 30-minute one-time tokens.
-- Only the latest UNREDEEMED row per user is honored — earlier ones are
-- expired by an INSERT-time trigger.
-- ----------------------------------------------------------------------------
CREATE TABLE password_reset_token (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash    BYTEA       NOT NULL UNIQUE,                  -- sha256 of the URL token
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  redeemed_at   TIMESTAMPTZ,
  ip_requested  INET,
  ip_redeemed   INET
);

CREATE INDEX password_reset_token_user_idx ON password_reset_token (user_id, created_at DESC);
CREATE INDEX password_reset_token_active_idx
  ON password_reset_token (user_id)
  WHERE redeemed_at IS NULL;

-- Invalidate older outstanding tokens whenever a new one is requested.
CREATE OR REPLACE FUNCTION expire_prior_reset_tokens()
  RETURNS TRIGGER AS $$
BEGIN
  UPDATE password_reset_token
     SET redeemed_at = now()
   WHERE user_id = NEW.user_id
     AND id <> NEW.id
     AND redeemed_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER password_reset_token_invalidate_priors
  AFTER INSERT ON password_reset_token
  FOR EACH ROW EXECUTE FUNCTION expire_prior_reset_tokens();

-- ----------------------------------------------------------------------------
-- mfa_recovery_code: ten single-use codes per enrollment. We store the
-- bcrypt hash (not the code) so a DB leak doesn't grant MFA bypass.
-- ----------------------------------------------------------------------------
CREATE TABLE mfa_recovery_code (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash     TEXT        NOT NULL,            -- bcrypt
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_code_user_idx ON mfa_recovery_code (user_id);
CREATE INDEX mfa_recovery_code_unused_idx ON mfa_recovery_code (user_id) WHERE used_at IS NULL;

COMMENT ON TABLE password_reset_token IS
  'Phase 10 — short-lived single-use forgot-password tokens. token_hash is sha256.';
COMMENT ON TABLE mfa_recovery_code IS
  'Phase 10 — bcrypt-hashed MFA recovery codes (10 per enrollment).';
