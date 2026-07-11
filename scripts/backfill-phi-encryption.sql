-- Backfill the PHI _enc companion columns (0034) for rows created before
-- PALLIO_PHI_KEY was provisioned. Idempotent — only touches rows whose
-- ciphertext is missing while plaintext exists.
--
-- Run on the VPS (reads the key straight from .env — nothing to substitute):
--
--   cd /opt/pallio/app
--   export PALLIO_PHI_KEY=$(grep -hE '^PALLIO_PHI_KEY=' .env .env.local .env.production 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
--   sudo -u postgres psql pallio -v phi_key="$PALLIO_PHI_KEY" -f scripts/backfill-phi-encryption.sql
--
-- (If the key isn't in .env yet: openssl rand -hex 32, add it as
--  PALLIO_PHI_KEY=<the generated value> to /opt/pallio/app/.env, pm2 restart
--  pallio, then run the block above.)

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL app.phi_key = :'phi_key';

UPDATE patient
   SET primary_member_id_enc = encrypt_phi(primary_member_id)
 WHERE primary_member_id IS NOT NULL
   AND primary_member_id_enc IS NULL;

UPDATE superbill
   SET member_id_snapshot_enc = encrypt_phi(member_id_snapshot)
 WHERE member_id_snapshot IS NOT NULL
   AND member_id_snapshot_enc IS NULL;

COMMIT;

-- Verify: every plaintext member id should now have ciphertext, and a
-- round-trip decrypt should match.
SET app.phi_key = :'phi_key';
SELECT
  (SELECT count(*) FROM patient   WHERE primary_member_id IS NOT NULL AND primary_member_id_enc IS NULL)  AS patient_missing_enc,
  (SELECT count(*) FROM superbill WHERE member_id_snapshot IS NOT NULL AND member_id_snapshot_enc IS NULL) AS superbill_missing_enc,
  (SELECT count(*) FROM patient   WHERE primary_member_id_enc IS NOT NULL AND decrypt_phi(primary_member_id_enc) IS DISTINCT FROM primary_member_id) AS patient_roundtrip_mismatch;
