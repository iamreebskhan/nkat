-- ============================================================================
-- 0012_workers_comp.sql
-- State Workers' Comp fee-schedule conversion factors.
-- Source: state WC commission notices (SC: $52 effective 2026-04-01; CA various;
-- VA: 2026 fee schedule; NM: 2026 PFS).
-- ============================================================================

INSERT INTO wc_state_fee_schedule (state, year, conversion_factor, effective_date, adopts_cms_codes, notes, source_url) VALUES
  ('SC', 2026, 52.0000, '2026-04-01', TRUE,  'SC WCC professional services CF; adopts 2026 CMS CPT/HCPCS', 'https://www.wcc.sc.gov/medical-fee-schedules'),
  ('CA', 2026, 38.5000, '2026-03-01', TRUE,  'CA DWC OMFS (representative)',                                  'https://www.dir.ca.gov/dwc/omfs9904.htm'),
  ('NC', 2026, 41.7500, '2026-01-01', TRUE,  'NC IC fee schedule (representative)',                           'https://www.ic.nc.gov/'),
  ('OH', 2026, 40.0000, '2026-01-01', TRUE,  'BWC OH professional services',                                  'https://www.bwc.ohio.gov/provider/'),
  ('VA', 2026, 38.7500, '2026-01-01', TRUE,  'VA WCC 2026 medical fee schedule',                              'https://workcomp.virginia.gov/medical-fee-services/2026-medical-fee-schedules'),
  ('NM', 2026, 50.5000, '2026-01-01', TRUE,  'NM WCA professional services',                                  'https://www.workerscomp.nm.gov/')
ON CONFLICT (state, year, effective_date) DO UPDATE
  SET conversion_factor = EXCLUDED.conversion_factor,
      adopts_cms_codes = EXCLUDED.adopts_cms_codes,
      notes = EXCLUDED.notes,
      source_url = EXCLUDED.source_url;

-- WC-relevant HCPCS T-codes
INSERT INTO code (code, code_system, short_descriptor, category, specialty, effective_date) VALUES
  ('T2010', 'HCPCS2', 'Preadmission screening / resident review',          'WC',           'workers_comp', '2003-01-01'),
  ('T2025', 'HCPCS2', 'Waiver services, NOS',                              'WC',           'workers_comp', '2003-01-01'),
  ('T2027', 'HCPCS2', 'Specialized childcare, waiver',                     'WC',           'workers_comp', '2003-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty;
