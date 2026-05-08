-- ============================================================================
-- 0015_phase6_asc_ub04.sql
-- ASC payment indicators + UB-04 bill types + revenue-code → product_line
-- allowlist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ASC payment indicators (CMS ASCFS Addenda; representative subset).
-- ---------------------------------------------------------------------------
INSERT INTO asc_payment_indicator (code, payment_indicator, payment_group, payment_rate, effective_year, source_url) VALUES
  -- Office-based surgical procedures (group A2)
  ('11042', 'A2', 'Office-based surgical procedure',         165.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc'),
  -- Group P1 — paid at standard ASC rate
  ('27447', 'P1', 'Total knee arthroplasty (TKA)',          12000.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc'),
  -- Group J8 — device-intensive
  ('63685', 'J8', 'Spinal neurostimulator implant',         18500.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc'),
  -- Cataract surgery (very high ASC volume)
  ('66984', 'P1', 'Cataract surgery, with IOL',              1700.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc'),
  -- Colonoscopy (high volume)
  ('45378', 'P1', 'Diagnostic colonoscopy',                   650.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc'),
  ('45380', 'P1', 'Colonoscopy w/ biopsy',                    760.00, 2026, 'https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc')
ON CONFLICT (code, payment_indicator, effective_year) DO UPDATE
  SET payment_group = EXCLUDED.payment_group,
      payment_rate = EXCLUDED.payment_rate,
      source_url = EXCLUDED.source_url;

-- ---------------------------------------------------------------------------
-- UB-04 bill types (3-digit; FL 4 of UB-04).
--   Position 1: facility type (1=hospital, 2=SNF, 3=home health, 4=religious nonmedical, 8=hospice)
--   Position 2: classification (1=inpatient, 3=outpatient, etc.)
--   Position 3: frequency (1=admit-thru-discharge, 2=interim-first, 3=interim-cont, 4=interim-last, 7=replacement, 8=void)
-- This is a representative subset; full table has ~80 rows.
-- ---------------------------------------------------------------------------
INSERT INTO ub04_bill_type (bill_type, facility_type, classification, frequency, description, valid_for_product_lines, effective_date) VALUES
  ('111', '1', '1', '1', 'Hospital inpatient — admit thru discharge',                  '{institutional_hospital}',     '1980-01-01'),
  ('112', '1', '1', '2', 'Hospital inpatient — interim first',                         '{institutional_hospital}',     '1980-01-01'),
  ('114', '1', '1', '4', 'Hospital inpatient — interim last',                          '{institutional_hospital}',     '1980-01-01'),
  ('131', '1', '3', '1', 'Hospital outpatient — admit thru discharge',                 '{institutional_hospital,institutional_asc}', '1980-01-01'),
  ('141', '1', '4', '1', 'Hospital — observation services',                            '{institutional_hospital}',     '2003-04-01'),
  ('181', '1', '8', '1', 'Hospital hospice — admit thru discharge',                    '{institutional_hospice}',      '1983-11-01'),
  ('211', '2', '1', '1', 'SNF inpatient — admit thru discharge',                       '{institutional_snf}',          '1980-01-01'),
  ('212', '2', '1', '2', 'SNF inpatient — interim first',                              '{institutional_snf}',          '1980-01-01'),
  ('213', '2', '1', '3', 'SNF inpatient — interim continuing',                         '{institutional_snf}',          '1980-01-01'),
  ('214', '2', '1', '4', 'SNF inpatient — interim last',                               '{institutional_snf}',          '1980-01-01'),
  ('322', '3', '2', '2', 'Home health — interim first',                                '{institutional_home_health}',  '1980-01-01'),
  ('323', '3', '2', '3', 'Home health — interim continuing',                           '{institutional_home_health}',  '1980-01-01'),
  ('329', '3', '2', '9', 'Home health — final',                                        '{institutional_home_health}',  '1980-01-01'),
  ('811', '8', '1', '1', 'Hospice — admit thru discharge',                             '{institutional_hospice}',      '1983-11-01'),
  ('812', '8', '1', '2', 'Hospice — interim first',                                    '{institutional_hospice}',      '1983-11-01'),
  ('813', '8', '1', '3', 'Hospice — interim continuing',                               '{institutional_hospice}',      '1983-11-01'),
  ('814', '8', '1', '4', 'Hospice — interim last',                                     '{institutional_hospice}',      '1983-11-01'),
  ('818', '8', '1', '8', 'Hospice — voided/cancelled prior claim',                     '{institutional_hospice}',      '1983-11-01')
ON CONFLICT (bill_type) DO UPDATE
  SET facility_type = EXCLUDED.facility_type,
      classification = EXCLUDED.classification,
      frequency = EXCLUDED.frequency,
      description = EXCLUDED.description,
      valid_for_product_lines = EXCLUDED.valid_for_product_lines;

-- ---------------------------------------------------------------------------
-- Revenue-code → product_line allowlist. Catches misclaimed institutional
-- combos (e.g. hospice revenue code 0651 on a hospital outpatient claim).
-- ---------------------------------------------------------------------------
INSERT INTO revenue_code_product_line (revenue_code, product_line, valid, rationale, effective_date) VALUES
  -- Hospice revenue codes only valid on hospice product line.
  ('0651', 'institutional_hospice',        TRUE,  'Hospice routine home care',                                       '1983-11-01'),
  ('0652', 'institutional_hospice',        TRUE,  'Hospice continuous home care',                                    '1983-11-01'),
  ('0655', 'institutional_hospice',        TRUE,  'Hospice inpatient respite care',                                  '1983-11-01'),
  ('0656', 'institutional_hospice',        TRUE,  'Hospice general inpatient',                                       '1983-11-01'),
  ('0657', 'institutional_hospice',        TRUE,  'Hospice physician services',                                      '1983-11-01'),
  ('0659', 'institutional_hospice',        TRUE,  'Hospice other',                                                   '1983-11-01'),
  -- Home health revenue codes only valid on home health product line.
  ('0571', 'institutional_home_health',    TRUE,  'Home health aide visit',                                          '1980-01-01'),
  ('0572', 'institutional_home_health',    TRUE,  'Home health PT visit',                                            '1980-01-01'),
  ('0573', 'institutional_home_health',    TRUE,  'Home health OT visit',                                            '1980-01-01'),
  ('0574', 'institutional_home_health',    TRUE,  'Home health speech visit',                                        '1980-01-01'),
  ('0581', 'institutional_home_health',    TRUE,  'Home health skilled nurse visit',                                 '1980-01-01'),
  -- Hospital revenue codes (general — applies to inpatient/outpatient/asc).
  ('0250', 'institutional_hospital',       TRUE,  'Pharmacy general',                                                '1980-01-01'),
  ('0258', 'institutional_hospital',       TRUE,  'Pharmacy IV solutions',                                           '1980-01-01'),
  ('0450', 'institutional_hospital',       TRUE,  'Emergency room general',                                          '1980-01-01'),
  ('0451', 'institutional_hospital',       TRUE,  'Emergency room EMTALA',                                           '2003-04-01'),
  ('0636', 'institutional_hospital',       TRUE,  'Drugs requiring detailed coding',                                 '1996-01-01'),
  ('0762', 'institutional_hospital',       TRUE,  'Treatment / observation room',                                    '2002-04-01'),
  ('0780', 'institutional_hospital',       TRUE,  'Telemedicine general',                                            '2017-01-01'),
  -- SNF accommodation codes
  ('0190', 'institutional_snf',            TRUE,  'Subacute care',                                                   '1996-01-01'),
  ('0220', 'institutional_snf',            TRUE,  'Special charges',                                                 '1980-01-01'),
  ('0100', 'institutional_snf',            TRUE,  'All-inclusive room and board (SNF)',                              '1980-01-01'),
  ('0100', 'institutional_hospital',       TRUE,  'All-inclusive room and board (hospital)',                         '1980-01-01'),
  ('0110', 'institutional_hospital',       TRUE,  'R&B private (hospital)',                                          '1980-01-01'),
  ('0110', 'institutional_snf',            TRUE,  'R&B private (SNF)',                                               '1980-01-01'),
  ('0120', 'institutional_hospital',       TRUE,  'R&B semi-private (hospital)',                                     '1980-01-01'),
  ('0120', 'institutional_snf',            TRUE,  'R&B semi-private (SNF)',                                          '1980-01-01')
ON CONFLICT (revenue_code, product_line, effective_date) DO UPDATE
  SET valid = EXCLUDED.valid,
      rationale = EXCLUDED.rationale;

-- Pre-load default feature flags.
INSERT INTO feature_flag (flag_key, org_id, enabled, config, rationale) VALUES
  ('synthesis.enabled',  NULL, FALSE, '{}'::jsonb, 'Phase 6 default off; tenant must opt-in to LLM-paraphrased findings'),
  ('synthesis.provider', NULL, TRUE,  '{"name":"deterministic"}'::jsonb, 'Default provider is deterministic; switch to "bedrock" once HIPAA BAA + AMA license live')
ON CONFLICT DO NOTHING;
