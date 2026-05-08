-- ============================================================================
-- 0010_oncology_codes.sql
-- Oncology code pack: chemotherapy/infusion, radiation, drug J-codes,
-- supportive care, modifier-aware notes.
-- All descriptors are OUR paraphrased shorthand.
-- ============================================================================

INSERT INTO code (code, code_system, short_descriptor, category, specialty, effective_date) VALUES
  -- Chemotherapy administration
  ('96401', 'CPT',    'Chemo SQ/IM admin, non-hormonal',                  'Chemo Admin',     'oncology', '1990-01-01'),
  ('96402', 'CPT',    'Chemo SQ/IM admin, hormonal',                      'Chemo Admin',     'oncology', '1990-01-01'),
  ('96409', 'CPT',    'Chemo IV push, single drug',                       'Chemo Admin',     'oncology', '1990-01-01'),
  ('96411', 'CPT',    'Chemo IV push, addl drug',                         'Chemo Admin',     'oncology', '1990-01-01'),
  ('96413', 'CPT',    'Chemo IV infusion, first hour',                    'Chemo Admin',     'oncology', '1990-01-01'),
  ('96415', 'CPT',    'Chemo IV infusion, addl hour',                     'Chemo Admin',     'oncology', '1990-01-01'),
  ('96417', 'CPT',    'Chemo IV infusion, addl sequential drug',          'Chemo Admin',     'oncology', '1990-01-01'),
  -- Hydration / therapeutic infusions
  ('96365', 'CPT',    'Therapeutic IV infusion, first hour',              'Infusion',        'oncology', '1990-01-01'),
  ('96366', 'CPT',    'Therapeutic IV infusion, addl hour',               'Infusion',        'oncology', '1990-01-01'),
  ('96367', 'CPT',    'Therapeutic IV infusion, addl sequential',         'Infusion',        'oncology', '1990-01-01'),
  ('96368', 'CPT',    'Therapeutic IV infusion, concurrent',              'Infusion',        'oncology', '1990-01-01'),
  ('96360', 'CPT',    'Hydration IV, first hour',                         'Hydration',       'oncology', '1990-01-01'),
  ('96361', 'CPT',    'Hydration IV, addl hour',                          'Hydration',       'oncology', '1990-01-01'),
  -- Radiation oncology (post-2026 overhaul)
  ('77386', 'CPT',    'IMRT delivery, complex',                           'Radiation',       'oncology', '2015-01-01'),
  ('77385', 'CPT',    'IMRT delivery, simple',                            'Radiation',       'oncology', '2015-01-01'),
  ('77373', 'CPT',    'Stereotactic body radiation therapy (SBRT)',       'Radiation',       'oncology', '2009-01-01'),
  ('77432', 'CPT',    'Stereotactic radiation, single session',           'Radiation',       'oncology', '2014-01-01'),
  -- Drug J-codes (representative; pair with -JW/-JZ)
  ('J9035', 'HCPCS2', 'Bevacizumab injection',                            'Drug J-code',     'oncology', '2005-01-01'),
  ('J9170', 'HCPCS2', 'Docetaxel injection',                              'Drug J-code',     'oncology', '2005-01-01'),
  ('J9355', 'HCPCS2', 'Trastuzumab injection',                            'Drug J-code',     'oncology', '2007-01-01'),
  ('J9264', 'HCPCS2', 'Paclitaxel protein-bound',                         'Drug J-code',     'oncology', '2009-01-01'),
  ('J9303', 'HCPCS2', 'Panitumumab injection',                            'Drug J-code',     'oncology', '2007-01-01'),
  ('J9217', 'HCPCS2', 'Leuprolide acetate, depot',                        'Drug J-code',     'oncology', '1992-01-01'),
  -- Supportive / lab
  ('85025', 'CPT',    'Complete CBC w/ auto diff',                        'Lab',             'oncology', '2003-01-01'),
  ('80053', 'CPT',    'Comprehensive metabolic panel',                    'Lab',             'oncology', '2003-01-01'),
  ('36415', 'CPT',    'Routine venipuncture',                             'Lab',             'oncology', '2003-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty;

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
