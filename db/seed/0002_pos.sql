-- ============================================================================
-- 0002_pos.sql
-- Place of Service codes (CMS public).
-- Subset covering Phase 1 needs; full list (~70 codes) added in later phases.
-- Source: https://www.cms.gov/medicare/coding-billing/place-of-service-codes
-- ============================================================================

INSERT INTO pos (pos, description, facility_indicator, effective_date) VALUES
  ('01','Pharmacy',                              'non_facility', '2003-04-01'),
  ('02','Telehealth provided other than home',   'facility',     '2017-01-01'),
  ('03','School',                                'non_facility', '2003-04-01'),
  ('04','Homeless Shelter',                      'non_facility', '2003-04-01'),
  ('05','Indian Health Service free-standing',   'facility',     '2003-04-01'),
  ('06','Indian Health Service provider-based',  'facility',     '2003-04-01'),
  ('07','Tribal 638 free-standing',              'facility',     '2003-04-01'),
  ('08','Tribal 638 provider-based',             'facility',     '2003-04-01'),
  ('09','Prison/Correctional Facility',          'non_facility', '2003-04-01'),
  ('10','Telehealth provided in patient''s home','non_facility', '2022-01-01'),
  ('11','Office',                                'non_facility', '2003-04-01'),
  ('12','Home',                                  'non_facility', '2003-04-01'),
  ('13','Assisted Living Facility',              'non_facility', '2003-04-01'),
  ('14','Group Home',                            'non_facility', '2003-04-01'),
  ('15','Mobile Unit',                           'non_facility', '2003-04-01'),
  ('17','Walk-in Retail Health Clinic',          'non_facility', '2010-04-01'),
  ('19','Off-Campus Outpatient Hospital',        'facility',     '2016-01-01'),
  ('20','Urgent Care Facility',                  'non_facility', '2003-04-01'),
  ('21','Inpatient Hospital',                    'facility',     '2003-04-01'),
  ('22','On-Campus Outpatient Hospital',         'facility',     '2003-04-01'),
  ('23','Emergency Room - Hospital',             'facility',     '2003-04-01'),
  ('24','Ambulatory Surgical Center',            'facility',     '2003-04-01'),
  ('25','Birthing Center',                       'non_facility', '2003-04-01'),
  ('26','Military Treatment Facility',           'facility',     '2003-04-01'),
  ('31','Skilled Nursing Facility',              'facility',     '2003-04-01'),
  ('32','Nursing Facility',                      'non_facility', '2003-04-01'),
  ('33','Custodial Care Facility',               'non_facility', '2003-04-01'),
  ('34','Hospice',                               'facility',     '2003-04-01'),
  ('41','Ambulance - Land',                      'facility',     '2003-04-01'),
  ('42','Ambulance - Air or Water',              'facility',     '2003-04-01'),
  ('49','Independent Clinic',                    'non_facility', '2003-04-01'),
  ('50','Federally Qualified Health Center',     'non_facility', '2003-04-01'),
  ('51','Inpatient Psychiatric Facility',        'facility',     '2003-04-01'),
  ('52','Psychiatric Facility-Partial Hospitalization','facility','2003-04-01'),
  ('53','Community Mental Health Center',        'facility',     '2003-04-01'),
  ('54','Intermediate Care Facility / Individuals with Intellectual Disabilities','non_facility','2003-04-01'),
  ('55','Residential Substance Abuse Treatment Facility','non_facility','2003-04-01'),
  ('56','Psychiatric Residential Treatment Center','facility',   '2003-04-01'),
  ('57','Non-residential Substance Abuse Treatment Facility','non_facility','2014-10-01'),
  ('60','Mass Immunization Center',              'non_facility', '2003-04-01'),
  ('61','Comprehensive Inpatient Rehabilitation Facility','facility','2003-04-01'),
  ('62','Comprehensive Outpatient Rehabilitation Facility','non_facility','2003-04-01'),
  ('65','End-Stage Renal Disease Treatment Facility','non_facility','2003-04-01'),
  ('71','Public Health Clinic',                  'non_facility', '2003-04-01'),
  ('72','Rural Health Clinic',                   'non_facility', '2003-04-01'),
  ('81','Independent Laboratory',                'non_facility', '2003-04-01'),
  ('99','Other Place of Service',                'non_facility', '2003-04-01')
ON CONFLICT (pos) DO UPDATE
  SET description = EXCLUDED.description,
      facility_indicator = EXCLUDED.facility_indicator;
