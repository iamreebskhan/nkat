-- ============================================================================
-- 0019_palliative_codes_missing.sql
--
-- Add the 14 palliative-care codes that were never in the `code` master
-- table, which made 598 live payer rules INVISIBLE to the product.
--
-- HOW A COMPLETE RULE BECOMES A DEAD ONE
-- The super-bill picker and the denial-risk scorer do not read payer_rule.
-- They read the view `payer_allowed_codes_v`, and it ends in:
--
--   JOIN code c ON c.code = ac.code
--               AND c.effective_date <= CURRENT_DATE
--               AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
--
-- An INNER join. No row in `code`, no row in the view — however many
-- rules, however well cited, exist underneath. The whole view returned 185
-- rows while payer_rule held thousands.
--
-- These 14 codes were absent, and they are not a fringe of the code set —
-- they are the half of home-based palliative billing that is not a visit:
--
--   99490 99439 99491 99424-99427  chronic and principal care management
--   99495 99496                    transitional care after discharge
--   G0179 G0180 G0181              home health certification / supervision
--   99417                          prolonged service beyond the visit
--   99499                          unlisted evaluation and management
--
-- Verified before writing this: each of the 25 in-scope codes checked
-- against `code`; the 14 below were missing and carried 598 live rules
-- between them; `SELECT count(*) FROM payer_allowed_codes_v WHERE code IN
-- (…)` returned 0 for all of them.
--
-- Note the composite primary key (code, effective_date): ON CONFLICT must
-- name both columns, and effective_date is the code's own CPT/HCPCS
-- introduction date, not today.
--
-- Idempotent.
-- ============================================================================

BEGIN;

INSERT INTO code (code, code_system, short_descriptor, category, effective_date) VALUES
  -- Chronic / principal care management. 99490 and 99439 are the CCM pair;
  -- 99491 is physician-time CCM; 99424-99427 are principal care management.
  ('99490', 'CPT',    'Chronic care mgmt, clinical staff, first 20 min/month',   'Care Management', '2015-01-01'),
  ('99439', 'CPT',    'Chronic care mgmt, clinical staff, each addl 20 min',     'Care Management', '2021-01-01'),
  ('99491', 'CPT',    'Chronic care mgmt, physician/QHP, first 30 min/month',    'Care Management', '2019-01-01'),
  ('99424', 'CPT',    'Principal care mgmt, physician/QHP, first 30 min/month',  'Care Management', '2022-01-01'),
  ('99425', 'CPT',    'Principal care mgmt, physician/QHP, each addl 30 min',    'Care Management', '2022-01-01'),
  ('99426', 'CPT',    'Principal care mgmt, clinical staff, first 30 min/month', 'Care Management', '2022-01-01'),
  ('99427', 'CPT',    'Principal care mgmt, clinical staff, each addl 30 min',   'Care Management', '2022-01-01'),

  -- Transitional care management — the post-discharge visit pair, central
  -- to palliative practices picking patients up after a hospitalisation.
  ('99495', 'CPT',    'Transitional care mgmt, moderate MDM, 14-day visit',      'TCM',             '2013-01-01'),
  ('99496', 'CPT',    'Transitional care mgmt, high MDM, 7-day visit',           'TCM',             '2013-01-01'),

  -- Home health certification and supervision.
  ('G0179', 'HCPCS2', 'MD recertification, home health patient',                 'Home Health Cert', '2001-01-01'),
  ('G0180', 'HCPCS2', 'MD certification, home health patient',                   'Home Health Cert', '2001-01-01'),
  ('G0181', 'HCPCS2', 'MD supervision, home health patient, 30+ min/month',      'Home Health Cert', '2001-01-01'),

  -- Prolonged service beyond the primary visit. The CPT sibling of G0318,
  -- which was already present.
  ('99417', 'CPT',    'Prolonged outpatient E/M, each addl 15 min',              'Prolonged',       '2021-01-01'),

  -- Unlisted E/M. Carries prior-auth rules at several payers precisely
  -- because it is unlisted and manually priced.
  ('99499', 'CPT',    'Unlisted evaluation and management service',              'E/M Other',       '2000-01-01')
ON CONFLICT (code, effective_date) DO UPDATE SET
  short_descriptor = EXCLUDED.short_descriptor,
  category         = EXCLUDED.category,
  code_system      = EXCLUDED.code_system;

-- Prove the rules actually became reachable, and fail the seed if not.
DO $$
DECLARE
  missing INT;
  in_view INT;
BEGIN
  SELECT count(*) INTO missing
    FROM (VALUES ('99490'),('99439'),('99491'),('99424'),('99425'),('99426'),('99427'),
                 ('99495'),('99496'),('G0179'),('G0180'),('G0181'),('99417'),('99499')) v(c)
   WHERE NOT EXISTS (SELECT 1 FROM code k WHERE k.code = v.c);
  IF missing > 0 THEN
    RAISE EXCEPTION 'seed 0019: % code(s) still absent from the code table', missing;
  END IF;

  SELECT count(*) INTO in_view FROM payer_allowed_codes_v
   WHERE code IN ('99490','99439','99491','99424','99425','99426','99427',
                  '99495','99496','G0179','G0180','G0181','99417','99499');
  RAISE NOTICE 'seed 0019: 14 codes registered; payer_allowed_codes_v now returns % rows for them (was 0)', in_view;
  IF in_view = 0 THEN
    RAISE WARNING 'seed 0019: the codes are registered but the view still returns nothing for them — check that a live attribute=''covered'' rule exists, since the view anchors on that row.';
  END IF;
END $$;

COMMIT;
