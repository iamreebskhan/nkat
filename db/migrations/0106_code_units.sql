-- ============================================================================
-- 0106_code_units.sql
--
-- Units per code on the visit and on the bill.
--
-- The code suggester counts units for the time-based add-on codes (G0318 and
-- 99417 per 15 minutes, 99498 per 30 minutes), but nothing downstream could
-- carry a count: visit.cpt_codes_assigned and superbill.cpt_codes are sets of
-- codes, so every add-on was saved, priced and printed as one unit whatever
-- the documented time supported.
--
-- The codes stay a deduplicated set, so every reader that treats them as one
-- (the rule sidebar, the predictor, the 835 matcher, the documentation check)
-- keeps working unchanged. The count lives beside them as a map keyed by code:
--
--   {"G0318": 3}      three units of G0318; every other code is one unit
--   {}                every code is one unit (all rows before this migration)
--
-- A claim line carries one code and its units (CMS-1500 24G, 837P SV104), so a
-- count per code, not a repeated code, is the shape the bill needs.
--
-- The CHECK keeps the value an object of whole numbers from 1 to 99. The path
-- is strict on purpose: lax mode unwraps arrays, so {"G0318": [3]} would pass.
-- That the keys are among the codes, and that only per-increment codes carry
-- more than one unit, is enforced by the app (lib/features/billing/code-units.ts).
--
-- Existing rows need no backfill: {} means one unit per code, which is what
-- was billed. No submitted or paid claim is repriced.
--
-- DDL only, with a constant default, so no table rewrite and no RLS guard.
-- Idempotent: every statement can be re-run.
-- ============================================================================

BEGIN;

ALTER TABLE visit     ADD COLUMN IF NOT EXISTS cpt_units JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE superbill ADD COLUMN IF NOT EXISTS cpt_units JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visit_cpt_units_chk') THEN
    ALTER TABLE visit ADD CONSTRAINT visit_cpt_units_chk CHECK (
      jsonb_typeof(cpt_units) = 'object'
      AND NOT jsonb_path_exists(cpt_units, 'strict $.* ? (@.type() != "number" || @ < 1 || @ > 99 || @ != @.floor())')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'superbill_cpt_units_chk') THEN
    ALTER TABLE superbill ADD CONSTRAINT superbill_cpt_units_chk CHECK (
      jsonb_typeof(cpt_units) = 'object'
      AND NOT jsonb_path_exists(cpt_units, 'strict $.* ? (@.type() != "number" || @ < 1 || @ > 99 || @ != @.floor())')
    );
  END IF;
END $$;

COMMENT ON COLUMN visit.cpt_units IS
  'Units per code in cpt_codes_assigned when more than one, e.g. {"G0318": 3}. A code with no key is one unit. {} on visits before 0106.';
COMMENT ON COLUMN superbill.cpt_units IS
  'Units per code in cpt_codes when more than one, e.g. {"G0318": 3}; billed as units x rate. A code with no key is one unit. {} on bills before 0106.';

COMMIT;
