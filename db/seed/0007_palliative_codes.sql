-- ============================================================================
-- 0007_palliative_codes.sql
-- Phase 1 anchor: palliative + hospice code set (~30 codes).
-- Descriptors are OUR paraphrased short-form. Do NOT use AMA verbatim.
-- ============================================================================

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
  -- Palliative E/M longitudinal (CMS HCPCS)
  ('G0318', 'HCPCS2', 'Longitudinal palliative care management visit',          'Palliative E/M',  '2024-01-01'),
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
