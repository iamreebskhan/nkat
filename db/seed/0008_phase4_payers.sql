-- ============================================================================
-- 0008_phase4_payers.sql
-- Real-world payer rows for Phase 4 (NC + SC Medicaid MCOs + Ohio commercial).
-- Source: NC Medicaid Managed Care plan list (post Apr 1 2026 merger),
-- SCDHHS Healthy Connections MCO list, and the artifact's Ohio payer set.
-- IDs are deterministic so re-runs land the same rows.
-- ============================================================================

-- North Carolina Medicaid Managed Care (5 plans post Apr 1 2026 merger)
INSERT INTO payer (id, name, parent_org, payer_type, states_served, policy_index_url, notes) VALUES
  ('a0000000-0000-4000-8000-000000000101', 'Healthy Blue North Carolina',     'BCBS NC',        'medicaid_mco', '{NC}', 'https://www.healthybluenc.com/medicaid', 'BCBS NC Medicaid'),
  ('a0000000-0000-4000-8000-000000000102', 'UnitedHealthcare of North Carolina','UnitedHealth', 'medicaid_mco', '{NC}', 'https://www.uhcprovider.com/',          'UHC NC Medicaid'),
  ('a0000000-0000-4000-8000-000000000103', 'AmeriHealth Caritas North Carolina','AmeriHealth',  'medicaid_mco', '{NC}', 'https://www.amerihealthcaritasnc.com/', 'NC Medicaid'),
  ('a0000000-0000-4000-8000-000000000104', 'Carolina Complete Health',        'Centene',        'medicaid_mco', '{NC}', 'https://www.carolinacompletehealth.com/','Post Apr 1 2026 merger of WellCare + CCH'),
  ('a0000000-0000-4000-8000-000000000105', 'EBCI Tribal Option',              'EBCI',           'tribal',       '{NC}', 'https://ebci.com/tribal-option/',       'Eastern Band of Cherokee Indians')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, parent_org = EXCLUDED.parent_org,
  states_served = EXCLUDED.states_served, policy_index_url = EXCLUDED.policy_index_url,
  notes = EXCLUDED.notes;

-- South Carolina Medicaid Managed Care (5 MCOs)
INSERT INTO payer (id, name, parent_org, payer_type, states_served, policy_index_url) VALUES
  ('a0000000-0000-4000-8000-000000000201', 'Absolute Total Care',                    'Centene',     'medicaid_mco', '{SC}', 'https://www.absolutetotalcare.com/'),
  ('a0000000-0000-4000-8000-000000000202', 'First Choice by Select Health',          'Select Health','medicaid_mco', '{SC}', 'https://www.selecthealthofsc.com/'),
  ('a0000000-0000-4000-8000-000000000203', 'Healthy Blue by BlueChoice of SC',       'BCBS SC',     'medicaid_mco', '{SC}', 'https://www.healthybluesc.com/'),
  ('a0000000-0000-4000-8000-000000000204', 'Humana Healthy Horizons of South Carolina','Humana',    'medicaid_mco', '{SC}', 'https://www.humana.com/medicaid/sc/'),
  ('a0000000-0000-4000-8000-000000000205', 'Molina Healthcare of South Carolina',    'Molina',      'medicaid_mco', '{SC}', 'https://www.molinahealthcare.com/sc')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, parent_org = EXCLUDED.parent_org,
  states_served = EXCLUDED.states_served, policy_index_url = EXCLUDED.policy_index_url;

-- Ohio commercial + Medicaid payers per artifact research
INSERT INTO payer (id, name, parent_org, payer_type, states_served, policy_index_url) VALUES
  ('a0000000-0000-4000-8000-000000000301', 'Aetna',                          'CVS Health',   'commercial',   '{OH,NC,SC}', 'https://www.aetna.com/health-care-professionals/clinical-policy-bulletins'),
  ('a0000000-0000-4000-8000-000000000302', 'UnitedHealthcare Community Plan Ohio','UnitedHealth','medicaid_mco','{OH}',       'https://www.uhcprovider.com/'),
  ('a0000000-0000-4000-8000-000000000303', 'Anthem BCBS Ohio (Elevance)',    'Elevance',     'commercial',   '{OH}',       'https://providers.anthem.com/ohio-provider'),
  ('a0000000-0000-4000-8000-000000000304', 'Medical Mutual of Ohio',         'Medical Mutual','commercial',  '{OH}',       'https://www.medmutual.com/For-Providers/Policies-and-Standards'),
  ('a0000000-0000-4000-8000-000000000305', 'CareSource Ohio',                'CareSource',   'medicaid_mco', '{OH}',       'https://www.caresource.com/doc-category/oh-med-reimbursement-policy'),
  ('a0000000-0000-4000-8000-000000000306', 'Buckeye Health Plan',            'Centene',      'medicaid_mco', '{OH}',       'https://www.buckeyehealthplan.com/providers/resources/clinical-payment-policies'),
  ('a0000000-0000-4000-8000-000000000307', 'Molina Healthcare of Ohio',      'Molina',       'medicaid_mco', '{OH}',       'https://www.molinahealthcare.com/providers/oh/medicaid/policies'),
  ('a0000000-0000-4000-8000-000000000308', 'Humana Ohio',                    'Humana',       'commercial',   '{OH}',       'https://mcp.humana.com/tad/tad_new/home.aspx')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, parent_org = EXCLUDED.parent_org,
  states_served = EXCLUDED.states_served, policy_index_url = EXCLUDED.policy_index_url;
