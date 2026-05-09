-- ============================================================================
-- 0034_phase_pallio_pgp_helpers.sql
--
-- Phase 8 — encrypted-at-rest helpers for sensitive columns.
--
-- Background:
--   Postgres-managed providers (Neon, RDS) encrypt the entire volume,
--   which protects against disk theft. To protect against DBA-level
--   read access (rogue staff, compromised replica) we additionally
--   wrap the *most sensitive* fields with pgcrypto's pgp_sym_*.
--
--   Source: pallio_complete_vision_v3 §15.1 ("encrypted at rest —
--   pg_crypto for sensitive cols").
--
-- Approach:
--   - Provide encrypt_phi(text) / decrypt_phi(bytea) wrapper functions
--     that read the symmetric key from the `app.phi_key` GUC.
--   - The GUC is set at connection-time from a Vault-issued secret
--     (production deploy) or from PGPCRYPTO_KEY env (dev).
--   - Tables that store the most sensitive fields (SSN-equivalent,
--     full DOB, member_id) get a `_enc bytea` companion column.
--
-- Migration adds the helpers; column additions land per-feature as
-- they're needed (intentionally small blast radius).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- encrypt_phi(plaintext) / decrypt_phi(ciphertext)
--
-- Reads the symmetric key from app.phi_key GUC. Errors loudly if unset.
-- Use ONLY for fields that genuinely warrant DBA-level confidentiality:
-- SSN, full DOB, member_id. Patient names + addresses are NOT in scope —
-- the cost (joinability, search) outweighs the benefit.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION encrypt_phi(plaintext TEXT)
  RETURNS BYTEA AS $$
DECLARE
  v_key TEXT;
BEGIN
  v_key := current_setting('app.phi_key', true);
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'encrypt_phi: app.phi_key GUC not set'
      USING ERRCODE = 'config_file_error';
  END IF;
  IF plaintext IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN pgp_sym_encrypt(plaintext, v_key, 'cipher-algo=aes256');
END;
$$ LANGUAGE plpgsql STRICT;

CREATE OR REPLACE FUNCTION decrypt_phi(ciphertext BYTEA)
  RETURNS TEXT AS $$
DECLARE
  v_key TEXT;
BEGIN
  v_key := current_setting('app.phi_key', true);
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'decrypt_phi: app.phi_key GUC not set'
      USING ERRCODE = 'config_file_error';
  END IF;
  IF ciphertext IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN pgp_sym_decrypt(ciphertext, v_key);
END;
$$ LANGUAGE plpgsql STRICT;

COMMENT ON FUNCTION encrypt_phi(TEXT) IS
  'Wrap PHI with pgp_sym_encrypt. Requires app.phi_key GUC set per session.';
COMMENT ON FUNCTION decrypt_phi(BYTEA) IS
  'Unwrap PHI with pgp_sym_decrypt. Requires app.phi_key GUC set per session.';

-- ----------------------------------------------------------------------------
-- Patient: add encrypted companion for primary_member_id.
-- Existing plaintext column stays for now (eligibility code formats
-- X12 270/271 from plaintext). Removed in a follow-up once eligibility
-- reads from the encrypted form via decrypt_phi().
-- ----------------------------------------------------------------------------
ALTER TABLE patient
  ADD COLUMN IF NOT EXISTS primary_member_id_enc BYTEA;

COMMENT ON COLUMN patient.primary_member_id_enc IS
  'Encrypted member_id (pgp_sym_encrypt with app.phi_key). Source of truth once eligibility reads from this.';

-- Superbill member_id_snapshot — frozen at superbill creation. Encrypt
-- the new column; existing rows stay plaintext until backfill.
ALTER TABLE superbill
  ADD COLUMN IF NOT EXISTS member_id_snapshot_enc BYTEA;
