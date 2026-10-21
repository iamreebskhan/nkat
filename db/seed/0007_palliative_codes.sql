-- ============================================================================
-- 0007_palliative_codes.sql
-- Phase 1 anchor: palliative + hospice code set (~30 codes).
-- Descriptors are OUR paraphrased short-form. Do NOT use AMA verbatim.
-- ============================================================================

-- One transaction: the G0318 move, the upserts and the postcondition at the
-- end apply together or not at all, which is what deploy.sh says of a seed
-- that fails ("that file rolled back").
BEGIN;

-- ---------------------------------------------------------------------------
-- G0318 moves to its real effective date BEFORE the upsert below.
--
-- It was seeded effective 2024-01-01, but CMS created G0318 in the CY2023
-- physician fee schedule and Ohio Medicaid lists it from 01/01/2023. The
-- primary key is (code, effective_date) (0002_reference_codes.sql), so
-- changing only the date in the VALUES would make ON CONFLICT insert a SECOND
-- G0318 row, and payer_allowed_codes_v (0069) and the rulebook's join on code
-- (rulebook.service.ts) would then list every G0318 rule twice.
--
-- So the existing row is re-keyed in place, which also keeps the specialty
-- 0009 set on it and its created_at. Idempotent: once a 2023 row exists the
-- UPDATE matches nothing, and the DELETE only removes a 2024 leftover sitting
-- beside a 2023 row. On a fresh database both match nothing and the INSERT
-- creates the 2023 row. The postcondition at the end of this file fails the
-- seed if G0318 is not then exactly one row.
-- ---------------------------------------------------------------------------
UPDATE code SET effective_date = DATE '2023-01-01'
 WHERE code = 'G0318' AND effective_date = DATE '2024-01-01'
   AND NOT EXISTS (SELECT 1 FROM code k WHERE k.code = 'G0318' AND k.effective_date = DATE '2023-01-01');
DELETE FROM code WHERE code = 'G0318' AND effective_date = DATE '2024-01-01';

INSERT INTO code (code, code_system, short_descriptor, category, effective_date) VALUES
  -- Home visit E/M (new patient)
  ('99341', 'CPT',    'Home visit, new pt, low MDM/15min',                      'E/M Home Visit',  '2023-01-01'),
  ('99342', 'CPT',    'Home visit, new pt, low MDM/30min',                      'E/M Home Visit',  '2023-01-01'),
  ('99344', 'CPT',    'Home visit, new pt, mod MDM/60min',                      'E/M Home Visit',  '2023-01-01'),
  ('99345', 'CPT',    'Home visit, new pt, high MDM/75min',                     'E/M Home Visit',  '2023-01-01'),
  -- Home visit E/M (established)
  ('99347', 'CPT',    'Home visit, est pt, low MDM/20min',                      'E/M Home Visit',  '2023-01-01'),
  ('99348', 'CPT',    'Home visit, est pt, low MDM/30min',                      'E/M Home Visit',  '2023-01-01'),
  ('99349', 'CPT',    'Home visit, est pt, mod MDM/40min',                      'E/M Home Visit',  '2023-01-01'),
  ('99350', 'CPT',    'Home visit, est pt, high MDM/60min',                     'E/M Home Visit',  '2023-01-01'),
  -- Advance Care Planning
  ('99497', 'CPT',    'Advance care planning, first 30 min',                    'ACP',             '2016-01-01'),
  ('99498', 'CPT',    'Advance care planning, each addl 30 min',                'ACP',             '2016-01-01'),
  -- Prolonged home/residence E/M add-on (CMS HCPCS, CY2023 PFS): each full
  -- 15 min past the CMS total time of 99345/99350. Ohio Medicaid lists it too
  -- (Appendix DD, 01/01/2023), so the wording names no payer.
  ('G0318', 'HCPCS2', 'Prolonged home/residence E/M, each addl 15 min',         'Prolonged',       '2023-01-01'),
  -- 2026 audio-visual telemedicine series (HCPCS-style 98xxx — confirm with AMA before paid pilot)
  ('98000', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98001', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98002', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98003', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98004', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98005', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98006', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98007', 'CPT',    'A/V telemed E/M new pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98008', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98009', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98010', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98011', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98012', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98013', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98014', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  ('98015', 'CPT',    'A/V telemed E/M est pt (level placeholder)',             'Telemedicine',    '2025-01-01'),
  -- 2026 NEW G-codes for psychiatric collaborative care
  ('G0568', 'HCPCS2', 'Psych collab care, initial 70 min',                      'Psych Collab Care','2026-01-01'),
  ('G0569', 'HCPCS2', 'Psych collab care, initial 60 min',                      'Psych Collab Care','2026-01-01'),
  ('G0570', 'HCPCS2', 'Psych collab care, subseq month',                        'Psych Collab Care','2026-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category;

-- Diagnosis codes commonly relevant for hospice/palliative medical-necessity LCDs.
-- This is a tiny seed — full ICD-10 set ingested via CDC tabular file in Phase 2.
INSERT INTO icd10 (code, description, billable, chapter, effective_date) VALUES
  ('Z51.5',   'Encounter for palliative care',          true,  'Z00-Z99', '2015-10-01'),
  ('Z66',     'Do not resuscitate (DNR) status',        true,  'Z00-Z99', '2015-10-01'),
  ('C78.7',   'Secondary malignant neoplasm of liver',  true,  'C00-D49', '2015-10-01'),
  ('C79.51',  'Secondary malignant neoplasm of bone',   true,  'C00-D49', '2015-10-01'),
  ('I50.84',  'End-stage heart failure',                true,  'I00-I99', '2017-10-01'),
  ('J96.20',  'Acute and chronic respiratory failure',  true,  'J00-J99', '2015-10-01'),
  ('R64',     'Cachexia',                               true,  'R00-R99', '2017-10-01'),
  ('G30.9',   'Alzheimer''s disease, unspecified',      true,  'G00-G99', '2015-10-01')
ON CONFLICT (code, effective_date) DO NOTHING;

-- Insert a sample timely_filing payer_rule once a payer + state row exists.
-- Skipped here because payer rows are created at provisioning time per state.

-- ---------------------------------------------------------------------------
-- Time and MDM as data (0091).
--
-- These are the SAME figures the descriptors above already carry inside their
-- text, that lib/ai/anthropic.client.ts:156 gives the parser, and that the
-- gold-standard eval asserts. Putting them in columns is what lets the CPT
-- suggester read them instead of holding a fourth, divergent copy — its bands
-- fired seven of eight codes early, always toward the higher-paying code.
--
-- Idempotent: a plain UPDATE keyed on the code, safe to re-apply.
-- ---------------------------------------------------------------------------
UPDATE code SET typical_minutes = v.minutes, mdm_level = v.mdm
  FROM (VALUES
    -- Home visit E/M, new patient. 99343 is absent on purpose: CPT deleted it
    -- effective 2023, and the ladder steps 99342 → 99344.
    ('99341', 15, 'low'),
    ('99342', 30, 'low'),
    ('99344', 60, 'moderate'),
    ('99345', 75, 'high'),
    -- Home visit E/M, established patient.
    ('99347', 20, 'low'),
    ('99348', 30, 'low'),
    ('99349', 40, 'moderate'),
    ('99350', 60, 'high'),
    -- Advance care planning is time-based only — no MDM level in the
    -- descriptor, so mdm_level stays NULL rather than being invented.
    ('99497', 30, NULL),
    ('99498', 30, NULL)
  ) AS v(code, minutes, mdm)
 WHERE code.code = v.code;

-- ---------------------------------------------------------------------------
-- Postcondition: G0318 is exactly one row, effective 2023-01-01, or the seed
-- fails and the whole file rolls back.
--
-- This is the only guard that runs on the production deploy; db/test never
-- does. If a database's G0318 row was not exactly (G0318, 2024-01-01), the
-- move above matched nothing and the INSERT added a second row beside it.
-- Stopping here keeps every G0318 rule from being listed twice in the picker.
-- db/test/0004_code_catalog.sql checks the same, and more, in CI.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_rows int;
  dates  text;
BEGIN
  SELECT count(*), string_agg(to_char(effective_date, 'YYYY-MM-DD'), ', ' ORDER BY effective_date)
    INTO n_rows, dates
    FROM code
   WHERE code = 'G0318';
  IF n_rows <> 1 OR dates <> '2023-01-01' THEN
    RAISE EXCEPTION 'seed 0007: G0318 has % row(s) in code, effective %; expected exactly one, effective 2023-01-01. Remove the stray row(s) by hand, then re-apply this seed.',
      n_rows, coalesce(dates, '<none>');
  END IF;
END $$;

COMMIT;
