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
  -- payer_type was omitted here, which made it write-once: correcting a
  -- misclassified payer in this file did nothing on any database that
  -- already had the row. The app derives product_line from payer_type
  -- (PAYER_TYPE_PRODUCT_LINE), so a wrong type silently serves the wrong
  -- line of business rather than failing.
  payer_type = EXCLUDED.payer_type,
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
  -- payer_type was omitted here, which made it write-once: correcting a
  -- misclassified payer in this file did nothing on any database that
  -- already had the row. The app derives product_line from payer_type
  -- (PAYER_TYPE_PRODUCT_LINE), so a wrong type silently serves the wrong
  -- line of business rather than failing.
  payer_type = EXCLUDED.payer_type,
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
  -- Was filed as 'Humana Ohio' / commercial. It is neither. Every artifact
  -- attached to this payer names the Medicaid product: the document is
  -- titled "Humana Healthy Horizons Ohio - Provider Manual", its own scope
  -- line reads "Humana Healthy Horizons in Ohio is a Medicaid product of
  -- Humana Health Plan of Ohio, Inc.", and all 141 rules quote Healthy
  -- Horizons policy. Only this row said commercial.
  --
  -- That mislabel served MEDICAID rules to anyone looking up a Humana
  -- COMMERCIAL patient in Ohio, and left an actual Healthy Horizons member
  -- with nothing, because the app derives product_line from payer_type
  -- (PAYER_TYPE_PRODUCT_LINE in payer-rule.repository.ts). Humana also
  -- exited Employer Group Commercial Medical entirely -- announced Feb
  -- 2023, finalized H1 2025 per its 10-K -- so the commercial reading did
  -- not describe a product that still exists.
  --
  -- Reclassified to match its sibling, 'Humana Healthy Horizons of South
  -- Carolina' (medicaid_mco). The 141 rules move to product_line
  -- 'medicaid_mco' in payer-rules-denial-attributes.sql, in the same
  -- change -- payer_type and product_line have to move together or the
  -- rules become invisible.
  --
  -- source_url points at the manual we actually hold and can fetch. The
  -- old value, mcp.humana.com/tad, is Humana's commercial coverage portal
  -- and returns 403 to every client.
  ('a0000000-0000-4000-8000-000000000308', 'Humana Healthy Horizons of Ohio', 'Humana',      'medicaid_mco', '{OH}',       'https://assets.humana.com/is/content/humana/2025_OH_Provider_Manualpdf')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, parent_org = EXCLUDED.parent_org,
  -- payer_type was omitted here, which made it write-once: correcting a
  -- misclassified payer in this file did nothing on any database that
  -- already had the row. The app derives product_line from payer_type
  -- (PAYER_TYPE_PRODUCT_LINE), so a wrong type silently serves the wrong
  -- line of business rather than failing.
  payer_type = EXCLUDED.payer_type,
  states_served = EXCLUDED.states_served, policy_index_url = EXCLUDED.policy_index_url;
