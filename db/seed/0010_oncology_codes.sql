-- ============================================================================
-- 0010_oncology_codes.sql
-- Oncology code pack: chemotherapy/infusion, radiation, drug J-codes,
-- supportive care, modifier-aware notes.
-- All descriptors are OUR paraphrased shorthand.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Effective dates are each code's own first year, which several rows had
-- wrong: the chemotherapy administration codes were created in CPT 2006 and
-- the hydration/infusion codes in CPT 2009 (from 90760-90768), not 1990; the
-- J-codes' dates are the HCPCS file's "added" dates.
--
-- The primary key is (code, effective_date), so changing a date in the VALUES
-- alone would make ON CONFLICT insert a SECOND row beside the old one, and
-- payer_allowed_codes_v would then list the code twice (db/test/0004 refuses
-- that). The existing row is re-keyed in place first, as 0007 does for G0318.
-- Idempotent: once the new date exists the UPDATE matches nothing.
-- ---------------------------------------------------------------------------
UPDATE code c SET effective_date = v.new_date
  FROM (VALUES
    ('96401', DATE '1990-01-01', DATE '2006-01-01'), ('96402', DATE '1990-01-01', DATE '2006-01-01'),
    ('96409', DATE '1990-01-01', DATE '2006-01-01'), ('96411', DATE '1990-01-01', DATE '2006-01-01'),
    ('96413', DATE '1990-01-01', DATE '2006-01-01'), ('96415', DATE '1990-01-01', DATE '2006-01-01'),
    ('96417', DATE '1990-01-01', DATE '2006-01-01'),
    ('96360', DATE '1990-01-01', DATE '2009-01-01'), ('96361', DATE '1990-01-01', DATE '2009-01-01'),
    ('96365', DATE '1990-01-01', DATE '2009-01-01'), ('96366', DATE '1990-01-01', DATE '2009-01-01'),
    ('96367', DATE '1990-01-01', DATE '2009-01-01'), ('96368', DATE '1990-01-01', DATE '2009-01-01'),
    ('J9355', DATE '2007-01-01', DATE '2000-01-01'), ('J9264', DATE '2009-01-01', DATE '2006-01-01'),
    ('J9303', DATE '2007-01-01', DATE '2008-01-01'), ('J9217', DATE '1992-01-01', DATE '1991-01-01')
  ) AS v(code, old_date, new_date)
 WHERE c.code = v.code AND c.effective_date = v.old_date
   AND NOT EXISTS (SELECT 1 FROM code k WHERE k.code = v.code AND k.effective_date = v.new_date);

INSERT INTO code (code, code_system, short_descriptor, category, specialty, effective_date) VALUES
  -- Chemotherapy administration
  ('96401', 'CPT',    'Chemo SQ/IM admin, non-hormonal',                  'Chemo Admin',     'oncology', '2006-01-01'),
  ('96402', 'CPT',    'Chemo SQ/IM admin, hormonal',                      'Chemo Admin',     'oncology', '2006-01-01'),
  ('96409', 'CPT',    'Chemo IV push, single drug',                       'Chemo Admin',     'oncology', '2006-01-01'),
  ('96411', 'CPT',    'Chemo IV push, addl drug',                         'Chemo Admin',     'oncology', '2006-01-01'),
  ('96413', 'CPT',    'Chemo IV infusion, first hour',                    'Chemo Admin',     'oncology', '2006-01-01'),
  ('96415', 'CPT',    'Chemo IV infusion, addl hour',                     'Chemo Admin',     'oncology', '2006-01-01'),
  ('96417', 'CPT',    'Chemo IV infusion, addl sequential drug',          'Chemo Admin',     'oncology', '2006-01-01'),
  -- Hydration / therapeutic infusions
  ('96365', 'CPT',    'Therapeutic IV infusion, first hour',              'Infusion',        'oncology', '2009-01-01'),
  ('96366', 'CPT',    'Therapeutic IV infusion, addl hour',               'Infusion',        'oncology', '2009-01-01'),
  ('96367', 'CPT',    'Therapeutic IV infusion, addl sequential',         'Infusion',        'oncology', '2009-01-01'),
  ('96368', 'CPT',    'Therapeutic IV infusion, concurrent',              'Infusion',        'oncology', '2009-01-01'),
  ('96360', 'CPT',    'Hydration IV, first hour',                         'Hydration',       'oncology', '2009-01-01'),
  ('96361', 'CPT',    'Hydration IV, addl hour',                          'Hydration',       'oncology', '2009-01-01'),
  -- Radiation oncology (post-2026 overhaul)
  ('77386', 'CPT',    'IMRT delivery, complex',                           'Radiation',       'oncology', '2015-01-01'),
  ('77385', 'CPT',    'IMRT delivery, simple',                            'Radiation',       'oncology', '2015-01-01'),
  ('77373', 'CPT',    'Stereotactic body radiation therapy (SBRT)',       'Radiation',       'oncology', '2009-01-01'),
  -- 77432 is the treatment MANAGEMENT of a cranial lesion course given in one
  -- session, not the delivery ("Stereotactic radiation trmt" in CMS's file).
  ('77432', 'CPT',    'Stereotactic radiation tx mgmt, cranial, 1 session', 'Radiation',     'oncology', '2014-01-01'),
  -- Drug J-codes (representative; pair with -JW/-JZ)
  ('J9035', 'HCPCS2', 'Bevacizumab injection',                            'Drug J-code',     'oncology', '2005-01-01'),
  ('J9170', 'HCPCS2', 'Docetaxel injection, 20 mg (now J9171)',           'Drug J-code',     'oncology', '2005-01-01'),
  ('J9171', 'HCPCS2', 'Docetaxel injection, 1 mg',                        'Drug J-code',     'oncology', '2010-01-01'),
  ('J9355', 'HCPCS2', 'Trastuzumab injection',                            'Drug J-code',     'oncology', '2000-01-01'),
  ('J9264', 'HCPCS2', 'Paclitaxel protein-bound',                         'Drug J-code',     'oncology', '2006-01-01'),
  ('J9303', 'HCPCS2', 'Panitumumab injection',                            'Drug J-code',     'oncology', '2008-01-01'),
  ('J9217', 'HCPCS2', 'Leuprolide acetate, depot',                        'Drug J-code',     'oncology', '1991-01-01'),
  -- Supportive / lab
  ('85025', 'CPT',    'Complete CBC w/ auto diff',                        'Lab',             'oncology', '2003-01-01'),
  ('80053', 'CPT',    'Comprehensive metabolic panel',                    'Lab',             'oncology', '2003-01-01'),
  ('36415', 'CPT',    'Routine venipuncture',                             'Lab',             'oncology', '2003-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty;

-- J9170 (docetaxel, 20 mg) is not a current HCPCS code: J9171 (docetaxel,
-- 1 mg) replaced it on 1 January 2010, and the 2026 HCPCS file has no J9170.
-- Its row stays for old claims but ends where J9171 starts. After the insert,
-- so a fresh database's new J9170 row is closed too.
UPDATE code SET expiration_date = DATE '2010-01-01'
 WHERE code = 'J9170' AND expiration_date IS NULL;

-- Oncology-relevant ICD-10s (subset for medical-necessity demos).
INSERT INTO icd10 (code, description, billable, chapter, effective_date) VALUES
  ('C18.0',  'Malignant neoplasm of cecum',                  true, 'C00-D49', '2015-10-01'),
  ('C50.911','Malignant neoplasm of breast, unspecified, R', true, 'C00-D49', '2015-10-01'),
  ('C61',    'Malignant neoplasm of prostate',               true, 'C00-D49', '2015-10-01'),
  ('C34.10', 'Malignant neoplasm of upper lobe, lung',       true, 'C00-D49', '2015-10-01'),
  ('Z51.11', 'Encounter for antineoplastic chemotherapy',    true, 'Z00-Z99', '2015-10-01'),
  ('Z51.12', 'Encounter for antineoplastic immunotherapy',   true, 'Z00-Z99', '2015-10-01'),
  ('Z51.0',  'Encounter for antineoplastic radiation therapy',true,'Z00-Z99', '2015-10-01')
ON CONFLICT (code, effective_date) DO NOTHING;

COMMIT;
