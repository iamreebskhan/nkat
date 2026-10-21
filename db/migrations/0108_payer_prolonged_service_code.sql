-- ============================================================================
-- 0108_payer_prolonged_service_code.sql
--
-- Which prolonged-service add-on a payer takes for home E/M time past the top
-- code: HCPCS G0318 or CPT 99417.
--
-- The code suggester chose by payer type alone: Medicare and Medicare
-- Advantage got G0318, every other payer 99417. Ohio Medicaid's own fee
-- schedule lists both, and a managed-care plan that follows CMS's home-visit
-- rules takes G0318, so its patients were only ever offered the other code.
-- Which of the two a plan wants is the plan's billing policy, so it is set
-- per payer, on the payer roster a platform admin already edits.
--
-- NULL keeps the default by payer type, so nothing changes for any payer
-- until someone sets it (lib/features/billing/prolonged-code.ts
-- prolongedServiceCodeFor). When it is set, the suggester uses that code with
-- that code's own timing: G0318 from the CMS total time for the top code,
-- 99417 from the CPT time.
--
-- DDL only, no default, so no table rewrite. payer is global reference data
-- with no RLS (0007_rls.sql). Idempotent: every statement can be re-run.
-- ============================================================================

BEGIN;

ALTER TABLE payer ADD COLUMN IF NOT EXISTS prolonged_service_code TEXT;

ALTER TABLE payer DROP CONSTRAINT IF EXISTS payer_prolonged_service_code_check;
ALTER TABLE payer ADD CONSTRAINT payer_prolonged_service_code_check
  CHECK (prolonged_service_code IN ('G0318', '99417'));

COMMENT ON COLUMN payer.prolonged_service_code IS
  'Prolonged-service add-on this payer takes for home E/M time past the top code: G0318 or 99417. NULL = by payer type (Medicare and Medicare Advantage G0318, others 99417).';

COMMIT;
