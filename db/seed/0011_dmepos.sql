-- ============================================================================
-- 0011_dmepos.sql
-- DMEPOS code pack + Master List + DMEPOS-specific modifiers.
-- Source: CMS HCPCS Level II + DMEPOS fee schedule + Master List Apr 13 2026.
-- ============================================================================

-- DMEPOS HCPCS Level II codes (representative subset).
INSERT INTO code (code, code_system, short_descriptor, category, specialty, effective_date) VALUES
  -- Mobility
  ('K0001', 'HCPCS2', 'Standard manual wheelchair',                    'DME Mobility',   'dmepos', '2003-01-01'),
  ('K0823', 'HCPCS2', 'Power wheelchair, group 2 standard',            'DME Mobility',   'dmepos', '2014-01-01'),
  ('E0143', 'HCPCS2', 'Walker, folding, wheeled, no seat',              'DME Mobility',   'dmepos', '2003-01-01'),
  ('E0260', 'HCPCS2', 'Hospital bed, semi-electric',                    'DME Bed',        'dmepos', '2003-01-01'),
  ('E0277', 'HCPCS2', 'Powered pressure-reducing mattress',             'DME Bed',        'dmepos', '2003-01-01'),
  -- Respiratory
  ('E0470', 'HCPCS2', 'Respiratory assist device, BiPAP w/o backup',    'DME Respiratory','dmepos', '2003-01-01'),
  ('E0471', 'HCPCS2', 'Respiratory assist device, BiPAP w/ backup',     'DME Respiratory','dmepos', '2003-01-01'),
  ('E0601', 'HCPCS2', 'Continuous airway pressure (CPAP) device',       'DME Respiratory','dmepos', '2003-01-01'),
  ('E1390', 'HCPCS2', 'Oxygen concentrator, single delivery port',      'DME Respiratory','dmepos', '2003-01-01'),
  -- Diabetes supplies
  ('A4253', 'HCPCS2', 'Blood glucose test strips, 50 ct',               'DME Diabetes',   'dmepos', '2003-01-01'),
  ('E0607', 'HCPCS2', 'Home blood glucose monitor',                     'DME Diabetes',   'dmepos', '2003-01-01'),
  -- Orthotics / prosthetics
  ('L0631', 'HCPCS2', 'Lumbar-sacral orthosis, sagittal control',       'Orthotic',       'dmepos', '2003-01-01'),
  ('L5856', 'HCPCS2', 'Endoskeletal lower-extremity microprocessor knee','Prosthetic',    'dmepos', '2010-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty;

-- DMEPOS-specific modifiers (extend the Phase 1 modifier set).
INSERT INTO modifier (modifier, description, modifier_type, payer_applicability, effective_date) VALUES
  ('GA', 'Waiver of liability statement on file (signed ABN)',  'abn', '{Medicare}', '2002-01-01'),
  ('GZ', 'Item or service expected to be denied; no ABN',       'abn', '{Medicare}', '2002-01-01'),
  ('GY', 'Statutorily excluded; non-Medicare benefit',          'abn', '{Medicare}', '2002-01-01'),
  ('GX', 'Notice of liability voluntarily issued',              'abn', '{Medicare}', '2010-01-01'),
  ('KX', 'Specific required documentation on file (DMEPOS)',    'dme', '{Medicare}', '2006-01-01'),
  ('RR', 'Rental DME',                                          'dme', '{Medicare}', '1992-01-01'),
  ('NU', 'New equipment',                                       'dme', '{Medicare}', '1992-01-01'),
  ('UE', 'Used equipment',                                      'dme', '{Medicare}', '1992-01-01'),
  ('LL', 'Lease/rental on a purchase agreement',                'dme', '{Medicare}', '2006-01-01')
ON CONFLICT (modifier) DO UPDATE
  SET description = EXCLUDED.description,
      modifier_type = EXCLUDED.modifier_type,
      payer_applicability = EXCLUDED.payer_applicability;

-- Modifier relationships specific to DMEPOS
INSERT INTO modifier_relationship (modifier_a, modifier_b, relationship_type, rationale, effective_date) VALUES
  ('NU', 'UE', 'mutually_exclusive', 'New and Used cannot both apply to the same DME line', '1992-01-01'),
  ('NU', 'RR', 'mutually_exclusive', 'New purchase and rental are mutually exclusive',       '1992-01-01'),
  ('UE', 'RR', 'mutually_exclusive', 'Used purchase and rental are mutually exclusive',      '1992-01-01'),
  ('GA', 'GZ', 'mutually_exclusive', 'GA = signed ABN; GZ = no ABN. Cannot both apply',      '2002-01-01'),
  ('GA', 'GY', 'mutually_exclusive', 'Signed ABN vs statutorily excluded — distinct paths',  '2002-01-01')
ON CONFLICT DO NOTHING;

-- DMEPOS Master List (representative entries; the 2026-04-13 update added
-- 18 codes per Federal Register notice).
INSERT INTO dme_master_list (code, description, requires_face_to_face, requires_prior_auth, requires_cmn, payment_threshold_dollar, effective_date, source_release, source_url) VALUES
  ('K0823', 'Power wheelchair group 2 standard',          TRUE, TRUE,  TRUE,  4000, '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('E0470', 'BiPAP without backup',                       TRUE, TRUE,  FALSE, 1500, '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('E0471', 'BiPAP with backup',                          TRUE, TRUE,  FALSE, 2500, '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('E0601', 'CPAP device',                                TRUE, TRUE,  FALSE, 800,  '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('E1390', 'Oxygen concentrator',                        TRUE, TRUE,  FALSE, 600,  '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('L5856', 'Microprocessor-controlled prosthetic knee',  TRUE, TRUE,  TRUE,  20000,'2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list'),
  ('E0277', 'Powered pressure-reducing mattress',         TRUE, TRUE,  FALSE, 1500, '2018-01-01', 'CMS DMEPOS ML', 'https://www.cms.gov/medicare/coverage/dmepos/master-list')
ON CONFLICT (code, effective_date) DO UPDATE
  SET description = EXCLUDED.description,
      requires_face_to_face = EXCLUDED.requires_face_to_face,
      requires_prior_auth = EXCLUDED.requires_prior_auth,
      requires_cmn = EXCLUDED.requires_cmn,
      payment_threshold_dollar = EXCLUDED.payment_threshold_dollar;
