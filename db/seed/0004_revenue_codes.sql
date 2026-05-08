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
  -- Home Health
  ('0571','Home Health - aide visit',             'home_health',   '{home_health}',   '1980-01-01'),
  ('0572','Home Health - PT visit',               'home_health',   '{home_health}',   '1980-01-01'),
  ('0573','Home Health - OT visit',               'home_health',   '{home_health}',   '1980-01-01'),
  ('0574','Home Health - speech visit',           'home_health',   '{home_health}',   '1980-01-01'),
  ('0581','Home Health - skilled nurse visit',    'home_health',   '{home_health}',   '1980-01-01'),
  -- Hospice
  ('0651','Hospice - routine home care',          'hospice',       '{hospice}',       '1983-11-01'),
  ('0652','Hospice - continuous home care',       'hospice',       '{hospice}',       '1983-11-01'),
  ('0655','Hospice - inpatient respite care',     'hospice',       '{hospice}',       '1983-11-01'),
  ('0656','Hospice - general inpatient',          'hospice',       '{hospice}',       '1983-11-01'),
  ('0657','Hospice - physician services',         'hospice',       '{hospice}',       '1983-11-01'),
  ('0659','Hospice - other',                      'hospice',       '{hospice}',       '1983-11-01'),
  -- Outpatient observation
  ('0762','Treatment / observation room',         'ancillary',     '{hospital}',      '2002-04-01'),
  -- Telemedicine (institutional)
  ('0780','Telemedicine general',                 'ancillary',     '{hospital}',      '2017-01-01')
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description,
      category = EXCLUDED.category,
      setting = EXCLUDED.setting;
