-- ============================================================================
-- 0004_revenue_codes.sql
-- Common UB-04 / 837I revenue codes (4-digit; mandatory in FL 42).
-- Phase 1 scope: hospice, home health, hospital outpatient, SNF basics.
-- Source: CMS National Uniform Billing Committee (NUBC) public manual.
-- ============================================================================

INSERT INTO revenue_code (code, description, category, setting, effective_date) VALUES
  -- Accommodations
  ('0100','All-inclusive room and board',         'accommodation', '{hospital,snf}',  '1980-01-01'),
  ('0110','R&B private (one bed)',                'accommodation', '{hospital,snf}',  '1980-01-01'),
  ('0120','R&B semi-private (2 bed)',             'accommodation', '{hospital,snf}',  '1980-01-01'),
  ('0190','Subacute care',                        'accommodation', '{snf,hospital}',  '1996-01-01'),
  ('0220','Special charges',                      'ancillary',     '{hospital,snf}',  '1980-01-01'),
  -- Pharmacy
  ('0250','Pharmacy general',                     'pharmacy',      '{hospital,snf}',  '1980-01-01'),
  ('0258','Pharmacy IV solutions',                'pharmacy',      '{hospital,snf}',  '1980-01-01'),
  -- Emergency
  ('0450','Emergency room general',               'ancillary',     '{hospital}',      '1980-01-01'),
  ('0451','Emergency room EMTALA',                'ancillary',     '{hospital}',      '2003-04-01'),
  -- Drugs requiring detailed coding
  ('0636','Drugs requiring detailed coding',      'pharmacy',      '{hospital}',      '1996-01-01'),
  -- Home Health. Each discipline has its own revenue code family: physical
  -- therapy 042X, occupational therapy 043X, speech-language pathology 044X,
  -- skilled nursing 055X, home health aide 057X, other visits 058X; a final
  -- digit of 1 is the visit charge, 2 the hourly charge. This list had put
  -- PT, OT and speech on 0572-0574 (0572 is the aide's hourly charge; 0573
  -- and 0574 are not assigned) and skilled nursing on 0581 (other visits).
  ('0421','Physical therapy - visit charge',      'home_health',   '{home_health}',   '1980-01-01'),
  ('0431','Occupational therapy - visit charge',  'home_health',   '{home_health}',   '1980-01-01'),
  ('0441','Speech-language pathology - visit charge', 'home_health', '{home_health}', '1980-01-01'),
  ('0551','Skilled nursing - visit charge',       'home_health',   '{home_health}',   '1980-01-01'),
  ('0571','Home health aide - visit charge',      'home_health',   '{home_health}',   '1980-01-01'),
  ('0572','Home health aide - hourly charge',     'home_health',   '{home_health}',   '1980-01-01'),
  ('0581','Home health other visits - visit charge', 'home_health', '{home_health}', '1980-01-01'),
  -- Hospice
  ('0651','Hospice - routine home care',          'hospice',       '{hospice}',       '1983-11-01'),
  ('0652','Hospice - continuous home care',       'hospice',       '{hospice}',       '1983-11-01'),
  ('0655','Hospice - inpatient respite care',     'hospice',       '{hospice}',       '1983-11-01'),
  ('0656','Hospice - general inpatient',          'hospice',       '{hospice}',       '1983-11-01'),
  ('0657','Hospice - physician services',         'hospice',       '{hospice}',       '1983-11-01'),
  ('0659','Hospice - other',                      'hospice',       '{hospice}',       '1983-11-01'),
  -- Outpatient observation (076X is treatment or observation room; 0762 is
  -- the observation room itself, 0761 the treatment room)
  ('0762','Observation room',                     'ancillary',     '{hospital}',      '2002-04-01'),
  -- Telemedicine (institutional)
  ('0780','Telemedicine general',                 'ancillary',     '{hospital}',      '2017-01-01')
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description,
      category = EXCLUDED.category,
      setting = EXCLUDED.setting;

-- 0573 and 0574 are not revenue codes (057X has only 0570, 0571, 0572 and
-- 0579), so they come out, with the allowlist rows that point at them
-- (revenue_code_product_line references revenue_code). Idempotent.
DELETE FROM revenue_code_product_line WHERE revenue_code IN ('0573', '0574');
DELETE FROM revenue_code WHERE code IN ('0573', '0574');
