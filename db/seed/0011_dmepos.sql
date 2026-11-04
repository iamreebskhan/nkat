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

-- DMEPOS requirements, from CMS's own lists: the Required Prior Authorization
-- List (updated 29 July 2026) and the Required Face-to-Face Encounter and
-- Written Order Prior to Delivery List (effective 28 October 2026). Each row
-- is dated from when its requirement took effect nationwide.
--
-- These rows used to claim prior authorization for every item and a
-- certificate of medical necessity for two, with dollar thresholds nobody
-- published. On the CMS lists: K0823 needs both prior authorization (from
-- 1 Sept 2018) and a face-to-face encounter; E0277 (21 Oct 2019) and L5856
-- (1 Dec 2020) need prior authorization only; E1390 needs a face-to-face
-- encounter from 13 April 2026 and no prior authorization; E0470, E0471 and
-- E0601 are on neither list, so they have no row. CMS retired certificates
-- of medical necessity for claims from 1 January 2023, and prior
-- authorization does not depend on the billed amount, so no threshold is
-- stored.
--
-- The dates are part of the unique key, so the old rows are removed and
-- written again rather than updated. Nothing references this table.
DELETE FROM dme_master_list
 WHERE code IN ('K0823', 'E0470', 'E0471', 'E0601', 'E1390', 'L5856', 'E0277');

INSERT INTO dme_master_list (code, description, requires_face_to_face, requires_prior_auth, requires_cmn, payment_threshold_dollar, effective_date, source_release, source_url) VALUES
  ('K0823', 'Power wheelchair group 2 standard, captains chair', TRUE,  TRUE,  FALSE, NULL, '2018-09-01', 'CMS Required PA List 2026-07-29; F2F/WOPD List 2026-10-28', 'https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-process-certain-durable-medical-equipment-prosthetics-orthotics-and-supplies'),
  ('E0277', 'Powered pressure-reducing air mattress',            FALSE, TRUE,  FALSE, NULL, '2019-10-21', 'CMS Required PA List 2026-07-29; F2F/WOPD List 2026-10-28', 'https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-process-certain-durable-medical-equipment-prosthetics-orthotics-and-supplies'),
  ('L5856', 'Microprocessor-controlled prosthetic knee',         FALSE, TRUE,  FALSE, NULL, '2020-12-01', 'CMS Required PA List 2026-07-29; F2F/WOPD List 2026-10-28', 'https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/prior-authorization-and-pre-claim-review-initiatives/prior-authorization-process-certain-durable-medical-equipment-prosthetics-orthotics-and-supplies'),
  ('E1390', 'Oxygen concentrator, single delivery port',         TRUE,  FALSE, FALSE, NULL, '2026-04-13', 'CMS Required PA List 2026-07-29; F2F/WOPD List 2026-10-28', 'https://www.cms.gov/data-research/monitoring-programs/medicare-fee-service-compliance-programs/medical-review-and-education/dmepos-order-requirements')
ON CONFLICT (code, effective_date) DO UPDATE
  SET description = EXCLUDED.description,
      requires_face_to_face = EXCLUDED.requires_face_to_face,
      requires_prior_auth = EXCLUDED.requires_prior_auth,
      requires_cmn = EXCLUDED.requires_cmn,
      payment_threshold_dollar = EXCLUDED.payment_threshold_dollar,
      source_release = EXCLUDED.source_release,
      source_url = EXCLUDED.source_url;
