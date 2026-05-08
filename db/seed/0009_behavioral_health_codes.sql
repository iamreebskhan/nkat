-- ============================================================================
-- 0009_behavioral_health_codes.sql
-- Behavioral health CPT + HCPCS code pack + MHPAEA parity pairs.
-- Includes 42 CFR Part 2 SUD flagging where applicable.
-- All descriptors are OUR paraphrased shorthand; never AMA verbatim.
-- ============================================================================

INSERT INTO code (code, code_system, short_descriptor, category, specialty, is_sud_part2, effective_date) VALUES
  -- Diagnostic / evaluation
  ('90791', 'CPT',    'Psych diagnostic eval, no medical',                    'BH Eval',       'behavioral_health', FALSE, '2013-01-01'),
  ('90792', 'CPT',    'Psych diagnostic eval, with medical',                  'BH Eval',       'behavioral_health', FALSE, '2013-01-01'),
  -- Psychotherapy time-based codes
  ('90832', 'CPT',    'Psychotherapy 16-37 min',                              'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90834', 'CPT',    'Psychotherapy 38-52 min',                              'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90837', 'CPT',    'Psychotherapy 53+ min',                                'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  -- Family + group
  ('90846', 'CPT',    'Family psychotherapy, w/o patient',                    'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90847', 'CPT',    'Family psychotherapy, with patient',                   'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90853', 'CPT',    'Group psychotherapy',                                  'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  -- Crisis
  ('90839', 'CPT',    'Psychotherapy for crisis, first 60 min',               'Crisis',        'behavioral_health', FALSE, '2013-01-01'),
  ('90840', 'CPT',    'Psychotherapy for crisis, addl 30 min',                'Crisis',        'behavioral_health', FALSE, '2013-01-01'),
  -- Med management
  ('99202', 'CPT',    'New pt office E/M, low MDM/15min',                     'E/M Office',    'medical_surgical',  FALSE, '2021-01-01'),
  ('99203', 'CPT',    'New pt office E/M, low MDM/30min',                     'E/M Office',    'medical_surgical',  FALSE, '2021-01-01'),
  ('99213', 'CPT',    'Est pt office E/M, low MDM/20min',                     'E/M Office',    'medical_surgical',  FALSE, '2021-01-01'),
  ('99214', 'CPT',    'Est pt office E/M, mod MDM/30min',                     'E/M Office',    'medical_surgical',  FALSE, '2021-01-01'),
  -- E&M add-on for psychotherapy (when paired with E/M same encounter)
  ('90833', 'CPT',    'Psychotherapy add-on, 16-37 min, w/E&M',               'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90836', 'CPT',    'Psychotherapy add-on, 38-52 min, w/E&M',               'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  ('90838', 'CPT',    'Psychotherapy add-on, 53+ min, w/E&M',                 'Psychotherapy', 'behavioral_health', FALSE, '2013-01-01'),
  -- SUD-specific (42 CFR Part 2 applies)
  ('H0001', 'HCPCS2', 'Alcohol/SUD assessment',                               'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0004', 'HCPCS2', 'SUD individual counseling, per 15 min',                'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0005', 'HCPCS2', 'SUD group counseling',                                 'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0006', 'HCPCS2', 'SUD case management',                                  'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0010', 'HCPCS2', 'SUD residential, per diem',                            'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0015', 'HCPCS2', 'SUD intensive outpatient program (IOP)',               'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0020', 'HCPCS2', 'SUD methadone admin',                                  'SUD',           'behavioral_health', TRUE,  '2003-01-01'),
  ('H0050', 'HCPCS2', 'SUD brief intervention, per 15 min',                   'SUD',           'behavioral_health', TRUE,  '2003-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty,
      is_sud_part2 = EXCLUDED.is_sud_part2;

-- Mark Phase 1 telemedicine codes as having a behavioral_health overlap
-- (telebehavioral health is a major use case).
UPDATE code SET specialty = COALESCE(specialty, 'telemedicine')
WHERE code IN ('98000','98001','98002','98003','98004','98005','98006','98007',
               '98008','98009','98010','98011','98012','98013','98014','98015')
  AND specialty IS NULL;

-- Update palliative codes to have specialty.
UPDATE code SET specialty = 'palliative'
WHERE code IN ('99341','99342','99344','99345','99347','99348','99349','99350',
               '99497','99498','G0318')
  AND specialty IS NULL;

-- Mental-health-related ICD-10s relevant for hospice/palliative + BH parity.
INSERT INTO icd10 (code, description, billable, chapter, effective_date) VALUES
  ('F32.A', 'Depression, unspecified',                          true, 'F00-F99', '2024-10-01'),
  ('F33.0', 'Major depressive disorder, recurrent, mild',       true, 'F00-F99', '2015-10-01'),
  ('F41.1', 'Generalized anxiety disorder',                     true, 'F00-F99', '2015-10-01'),
  ('F10.20', 'Alcohol dependence, uncomplicated',               true, 'F00-F99', '2015-10-01'),
  ('F11.20', 'Opioid dependence, uncomplicated',                true, 'F00-F99', '2015-10-01'),
  ('F14.20', 'Cocaine dependence, uncomplicated',               true, 'F00-F99', '2015-10-01'),
  ('F19.20', 'Other psychoactive substance dependence',         true, 'F00-F99', '2015-10-01')
ON CONFLICT (code, effective_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- MHPAEA parity pairs: behavioral_health code → comparable med/surg code
-- The parity engine compares (frequency_limit, prior_auth_required,
-- copay_or_costshare, modifier_required) between these pairs.
-- ---------------------------------------------------------------------------
INSERT INTO mhpaea_parity_pair (behavioral_health_code, med_surg_code, classification, rationale, source_url, effective_date) VALUES
  -- Outpatient in-network: 90834 (BH outpatient psychotherapy) ↔ 99213 (med E/M)
  ('90834', '99213', 'outpatient_in_network',
   'Both are 30-minute outpatient visits; PA / frequency / cost share parity comparison',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01'),
  ('90837', '99214', 'outpatient_in_network',
   'Both are extended outpatient visits; PA / frequency / cost share parity comparison',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01'),
  ('90832', '99202', 'outpatient_in_network',
   'Both are short outpatient visits',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01'),
  ('90791', '99203', 'outpatient_in_network',
   'Initial diagnostic evaluation parity',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01'),
  -- Crisis ↔ ED
  ('90839', '99281', 'emergency_care',
   'Crisis psychotherapy ↔ low-acuity ED visit; access standards parity',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01'),
  -- SUD intensive outpatient ↔ surgical IOP
  ('H0015', '99213', 'outpatient_in_network',
   'IOP for SUD ↔ outpatient med visit; non-quantitative treatment limit parity',
   'https://www.dol.gov/agencies/ebsa/laws-and-regulations/laws/mental-health-parity', '2013-01-01')
ON CONFLICT (behavioral_health_code, med_surg_code, classification, effective_date) DO NOTHING;
