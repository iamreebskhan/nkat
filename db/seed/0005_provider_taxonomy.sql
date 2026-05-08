-- ============================================================================
-- 0005_provider_taxonomy.sql
-- Sample of NUCC provider taxonomy codes covering Phase 1 specialties.
-- Full NUCC set (~900 codes) loaded via crawler in Phase 0 ingestion.
-- Source: https://taxonomy.nucc.org/
-- ============================================================================

INSERT INTO provider_taxonomy (taxonomy, classification, specialization, grouping, effective_date) VALUES
  -- Physicians (Allopathic & Osteopathic)
  ('208D00000X','General Practice',                  NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207Q00000X','Family Medicine',                   NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207R00000X','Internal Medicine',                 NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207RH0000X','Internal Medicine',                 'Hematology & Oncology',               'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207RG0100X','Internal Medicine',                 'Geriatric Medicine',                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207RH0003X','Internal Medicine',                 'Hospice & Palliative Medicine',       'Allopathic & Osteopathic Physicians',                          '2007-04-01'),
  ('207RX0202X','Internal Medicine',                 'Medical Oncology',                    'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207V00000X','Obstetrics & Gynecology',           NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207W00000X','Ophthalmology',                     NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207X00000X','Orthopaedic Surgery',               NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('207Y00000X','Otolaryngology',                    NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('208000000X','Pediatrics',                        NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('208600000X','Surgery',                           NULL,                                  'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('2084P0800X','Psychiatry & Neurology',            'Psychiatry',                          'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('2084N0400X','Psychiatry & Neurology',            'Neurology',                           'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('2084P0805X','Psychiatry & Neurology',            'Geriatric Psychiatry',                'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  ('2084P0802X','Psychiatry & Neurology',            'Addiction Psychiatry',                'Allopathic & Osteopathic Physicians',                          '2003-01-01'),
  -- Nurse Practitioners
  ('363L00000X','Nurse Practitioner',                NULL,                                  'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363LF0000X','Nurse Practitioner',                'Family',                              'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363LG0600X','Nurse Practitioner',                'Gerontology',                         'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363LP0808X','Nurse Practitioner',                'Psychiatric/Mental Health',           'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363LP2300X','Nurse Practitioner',                'Primary Care',                        'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  -- Physician Assistants
  ('363A00000X','Physician Assistant',               NULL,                                  'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363AM0700X','Physician Assistant',               'Medical',                             'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  ('363AS0400X','Physician Assistant',               'Surgical',                            'Physician Assistants & Advanced Practice Nursing Providers',   '2003-01-01'),
  -- Behavioral Health (non-physician)
  ('1041C0700X','Social Worker',                     'Clinical',                            'Behavioral Health & Social Service Providers',                 '2003-01-01'),
  ('103T00000X','Psychologist',                      NULL,                                  'Behavioral Health & Social Service Providers',                 '2003-01-01'),
  ('103TC0700X','Psychologist',                      'Clinical',                            'Behavioral Health & Social Service Providers',                 '2003-01-01'),
  ('101YM0800X','Counselor',                         'Mental Health',                       'Behavioral Health & Social Service Providers',                 '2003-01-01'),
  ('101YA0400X','Counselor',                         'Addiction (Substance Use Disorder)',  'Behavioral Health & Social Service Providers',                 '2003-01-01'),
  -- Hospice / Palliative agencies
  ('251G00000X','Home Health Agency',                NULL,                                  'Agencies',                                                     '2003-01-01'),
  ('251G00000X','Hospice Care, Community Based',     NULL,                                  'Agencies',                                                     '2003-01-01')
ON CONFLICT (taxonomy) DO UPDATE
  SET classification = EXCLUDED.classification,
      specialization = EXCLUDED.specialization,
      grouping = EXCLUDED.grouping;
