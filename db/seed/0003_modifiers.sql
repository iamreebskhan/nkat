-- ============================================================================
-- 0003_modifiers.sql
-- Common Level I and Level II modifiers + relationship rules.
-- Phase 1 scope. Many additional specialty modifiers added in later phases.
-- ============================================================================

INSERT INTO modifier (modifier, description, modifier_type, payer_applicability, effective_date) VALUES
  -- Distinct service modifiers (NCCI hierarchy)
  ('25','Significant separately identifiable E/M service same day','distinct_service', '{}', '1992-01-01'),
  ('26','Professional component',                                 'pricing',          '{}', '1992-01-01'),
  ('TC','Technical component',                                    'pricing',          '{}', '1992-01-01'),
  ('59','Distinct procedural service (NCCI fallback)',            'distinct_service', '{}', '1996-01-01'),
  ('XE','Separate encounter',                                     'distinct_service', '{}', '2015-01-01'),
  ('XP','Separate practitioner',                                  'distinct_service', '{}', '2015-01-01'),
  ('XS','Separate structure/organ',                               'distinct_service', '{}', '2015-01-01'),
  ('XU','Unusual non-overlapping service',                        'distinct_service', '{}', '2015-01-01'),
  -- Telehealth
  ('95','Synchronous audio/video telemedicine',                   'telehealth',       '{}', '2017-01-01'),
  ('GT','Interactive A/V telecomm system (legacy)',               'telehealth',       '{Medicare}', '1999-01-01'),
  ('GQ','Asynchronous telemedicine',                              'telehealth',       '{}', '2002-01-01'),
  ('93','Audio-only telemedicine',                                'telehealth',       '{}', '2022-01-01'),
  -- ABN / beneficiary liability
  ('GA','Waiver of liability statement on file (signed ABN)',     'abn',              '{Medicare}', '2002-01-01'),
  ('GX','Notice of liability voluntarily issued',                 'abn',              '{Medicare}', '2010-01-01'),
  ('GY','Statutorily excluded item/service',                      'abn',              '{Medicare}', '2002-01-01'),
  ('GZ','Expected to be denied; no ABN obtained',                 'abn',              '{Medicare}', '2002-01-01'),
  ('KX','Specific required documentation on file',                'dme',              '{Medicare}', '2006-01-01'),
  -- DME
  ('RR','DME rental',                                             'dme',              '{Medicare}', '1992-01-01'),
  ('NU','DME new equipment purchase',                             'dme',              '{Medicare}', '1992-01-01'),
  ('UE','DME used equipment purchase',                            'dme',              '{Medicare}', '1992-01-01'),
  -- Drug wastage (oncology critical)
  ('JW','Drug amount discarded (single-dose vial waste)',         'drug',             '{}', '2017-01-01'),
  ('JZ','Zero drug amount discarded',                             'drug',             '{Medicare}', '2023-07-01'),
  -- Hospice
  ('GW','Service not related to terminal condition (hospice)',    'informational',    '{Medicare}', '2002-01-01'),
  ('GV','Attending physician not employed by hospice',            'informational',    '{Medicare}', '2002-01-01'),
  -- Other commonly needed
  ('51','Multiple procedures',                                    'pricing',          '{}', '1992-01-01'),
  ('52','Reduced services',                                       'pricing',          '{}', '1992-01-01'),
  ('53','Discontinued procedure',                                 'pricing',          '{}', '1992-01-01'),
  ('76','Repeat procedure same physician',                        'distinct_service', '{}', '1992-01-01'),
  ('77','Repeat procedure another physician',                     'distinct_service', '{}', '1992-01-01'),
  ('91','Repeat clinical diagnostic lab test',                    'distinct_service', '{}', '1996-01-01')
ON CONFLICT (modifier) DO UPDATE
  SET description = EXCLUDED.description,
      modifier_type = EXCLUDED.modifier_type,
      payer_applicability = EXCLUDED.payer_applicability;

-- Relationship rules: NCCI hierarchy (X-modifiers preferred over 59).
INSERT INTO modifier_relationship (modifier_a, modifier_b, relationship_type, rationale, source_url, effective_date) VALUES
  ('XE','59','preferred_over',     'CMS prefers specific X-modifier over 59 when applicable', 'https://www.cms.gov/files/document/mln1783722-proper-use-modifiers-59-xe-xp-xs-xu.pdf','2015-01-01'),
  ('XP','59','preferred_over',     'Same hierarchy', 'https://www.cms.gov/files/document/mln1783722-proper-use-modifiers-59-xe-xp-xs-xu.pdf','2015-01-01'),
  ('XS','59','preferred_over',     'Same hierarchy', 'https://www.cms.gov/files/document/mln1783722-proper-use-modifiers-59-xe-xp-xs-xu.pdf','2015-01-01'),
  ('XU','59','preferred_over',     'Same hierarchy', 'https://www.cms.gov/files/document/mln1783722-proper-use-modifiers-59-xe-xp-xs-xu.pdf','2015-01-01'),
  ('59','XE','mutually_exclusive', 'Never combine 59 with an X-modifier on the same line', NULL, '2015-01-01'),
  ('59','XP','mutually_exclusive', 'Never combine 59 with an X-modifier on the same line', NULL, '2015-01-01'),
  ('59','XS','mutually_exclusive', 'Never combine 59 with an X-modifier on the same line', NULL, '2015-01-01'),
  ('59','XU','mutually_exclusive', 'Never combine 59 with an X-modifier on the same line', NULL, '2015-01-01'),
  ('JW','JZ','mutually_exclusive', 'JW = wastage, JZ = no wastage; cannot both apply',      NULL, '2023-07-01'),
  ('GA','GZ','mutually_exclusive', 'GA = signed ABN; GZ = no ABN; mutually exclusive',      NULL, '2002-01-01')
ON CONFLICT DO NOTHING;
