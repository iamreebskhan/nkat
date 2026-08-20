-- Seed: 99213 / 99214 for the five South Carolina Medicaid managed care
-- plans, from the state's own schedules.
--
-- WHY THESE TWO CODES. The operator's library-health page reported core code
-- coverage at 94%, and the entire shortfall was 99213 and 99214 missing for
-- eight payers. Both are marked is_core in library_coverage_target: a
-- palliative practice that runs any clinic-based follow-up bills office E/M,
-- and 99417 (prolonged outpatient, already covered) is an add-on to exactly
-- these. Five of those eight payers are South Carolina plans, which the
-- schedules below answer directly. Ohio and Aetna need their own commercial
-- documents and are NOT invented here.
--
-- SOURCES, read cell by cell from the same two workbooks the rest of the SC
-- rules come from — no value typed from memory:
--   FEE_P1454.xlsx   BASE PHYSICIANS FEE SCHEDULE             5/15/2026
--   FEE_OMPANP.xlsx  PHYSICIAN ASSISTANT / NURSE PRACTITIONER 8/15/2025
--
--   PROC    MOD  PAYMENT   FACILITY   EFFECTIVE     schedule
--   99213   0    69.94     51         2024-07-01    physician
--   99213   0    55.95     40.80      2024-07-01    PA/NP
--   99214   0    98.84     75.23      2024-07-01    physician
--   99214   0    79.07     60.18      2024-07-01    PA/NP
--
-- The PA/NP differential holds at exactly 80% on both codes (55.95/69.94 and
-- 79.07/98.84), which is the same relationship every other SC rule in this
-- library carries. A nurse-practitioner-led practice bills the second number.
--
-- THE GT LINES. Both codes carry a GT-modifier row at parity with the
-- in-person rate, exactly as the home-visit codes do. GT identifies
-- interactive telecommunication, so the state prices these for telehealth
-- delivery with no reduction. Recorded as telehealth_allowed, quoting the row.
--
-- WHAT IS DELIBERATELY ABSENT. No prior_auth, frequency or documentation
-- rules. A fee schedule states what a code pays, not what a plan requires
-- before paying it, and asserting a negative from a pricing table is the
-- error this library exists to avoid.
--
-- 2 codes x 5 payers = 10 coverage rules, plus 2 x 5 telehealth rules.
-- Idempotent: deterministic UUIDs + ON CONFLICT (id) DO UPDATE.

BEGIN;

-- Close anything already live on these keys, at this seed's own start date,
-- so no key is ever left without a rule.
UPDATE payer_rule pr
   SET expiration_date = GREATEST(pr.effective_date, DATE '2024-07-01')
 WHERE pr.expiration_date IS NULL
   AND pr.created_by <> 'extract:sc-office-visits-2026-08'
   AND (pr.payer_id, pr.state, pr.code, pr.attribute) IN (
     ('a0000000-0000-4000-8000-000000000201'::uuid,'SC','99213','covered'),
     ('a0000000-0000-4000-8000-000000000202'::uuid,'SC','99213','covered'),
     ('a0000000-0000-4000-8000-000000000203'::uuid,'SC','99213','covered'),
     ('a0000000-0000-4000-8000-000000000204'::uuid,'SC','99213','covered'),
     ('a0000000-0000-4000-8000-000000000205'::uuid,'SC','99213','covered'),
     ('a0000000-0000-4000-8000-000000000201'::uuid,'SC','99214','covered'),
     ('a0000000-0000-4000-8000-000000000202'::uuid,'SC','99214','covered'),
     ('a0000000-0000-4000-8000-000000000203'::uuid,'SC','99214','covered'),
     ('a0000000-0000-4000-8000-000000000204'::uuid,'SC','99214','covered'),
     ('a0000000-0000-4000-8000-000000000205'::uuid,'SC','99214','covered'),
     ('a0000000-0000-4000-8000-000000000201'::uuid,'SC','99213','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000202'::uuid,'SC','99213','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000203'::uuid,'SC','99213','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000204'::uuid,'SC','99213','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000205'::uuid,'SC','99213','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000201'::uuid,'SC','99214','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000202'::uuid,'SC','99214','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000203'::uuid,'SC','99214','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000204'::uuid,'SC','99214','telehealth_allowed'),
     ('a0000000-0000-4000-8000-000000000205'::uuid,'SC','99214','telehealth_allowed')
   );

INSERT INTO payer_rule (
  id, payer_id, state, product_line, code, attribute, value, coverage_status,
  confidence, effective_date, expiration_date, source_doc_id, source_quote, created_by
)
SELECT
  v.id::uuid, v.payer_id::uuid, 'SC', 'medicaid_mco', v.code, v.attribute,
  v.value::jsonb, v.coverage_status, v.confidence, DATE '2024-07-01', NULL,
  'e5c1a7b2-0001-4d3a-9f10-2b6c8e4a1101'::uuid, v.source_quote,
  'extract:sc-office-visits-2026-08'
FROM (VALUES
  -- ---- 99213 covered -----------------------------------------------------
  ('c9213000-0000-4c01-8a01-000000000201','a0000000-0000-4000-8000-000000000201','99213','covered',
   '{"answer":"South Carolina Medicaid pays 99213 at $69.94 (non-facility) and $51.00 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $55.95 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":69.94,"facilityRate":51,"npPaRate":55.95,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99213 | MOD 0 | PAYMENT RATE 55.95 | FACILITY RATE 40.799999999999997 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD 0 | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213000-0000-4c01-8a01-000000000202','a0000000-0000-4000-8000-000000000202','99213','covered',
   '{"answer":"South Carolina Medicaid pays 99213 at $69.94 (non-facility) and $51.00 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $55.95 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":69.94,"facilityRate":51,"npPaRate":55.95,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99213 | MOD 0 | PAYMENT RATE 55.95 | FACILITY RATE 40.799999999999997 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD 0 | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213000-0000-4c01-8a01-000000000203','a0000000-0000-4000-8000-000000000203','99213','covered',
   '{"answer":"South Carolina Medicaid pays 99213 at $69.94 (non-facility) and $51.00 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $55.95 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":69.94,"facilityRate":51,"npPaRate":55.95,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99213 | MOD 0 | PAYMENT RATE 55.95 | FACILITY RATE 40.799999999999997 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD 0 | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213000-0000-4c01-8a01-000000000204','a0000000-0000-4000-8000-000000000204','99213','covered',
   '{"answer":"South Carolina Medicaid pays 99213 at $69.94 (non-facility) and $51.00 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $55.95 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":69.94,"facilityRate":51,"npPaRate":55.95,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99213 | MOD 0 | PAYMENT RATE 55.95 | FACILITY RATE 40.799999999999997 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD 0 | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213000-0000-4c01-8a01-000000000205','a0000000-0000-4000-8000-000000000205','99213','covered',
   '{"answer":"South Carolina Medicaid pays 99213 at $69.94 (non-facility) and $51.00 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $55.95 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":69.94,"facilityRate":51,"npPaRate":55.95,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99213 | MOD 0 | PAYMENT RATE 55.95 | FACILITY RATE 40.799999999999997 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD 0 | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),

  -- ---- 99214 covered -----------------------------------------------------
  ('c9214000-0000-4c01-8a01-000000000201','a0000000-0000-4000-8000-000000000201','99214','covered',
   '{"answer":"South Carolina Medicaid pays 99214 at $98.84 (non-facility) and $75.23 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $79.07 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":98.84,"facilityRate":75.23,"npPaRate":79.07,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99214 | MOD 0 | PAYMENT RATE 79.069999999999993 | FACILITY RATE 60.18 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD 0 | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214000-0000-4c01-8a01-000000000202','a0000000-0000-4000-8000-000000000202','99214','covered',
   '{"answer":"South Carolina Medicaid pays 99214 at $98.84 (non-facility) and $75.23 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $79.07 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":98.84,"facilityRate":75.23,"npPaRate":79.07,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99214 | MOD 0 | PAYMENT RATE 79.069999999999993 | FACILITY RATE 60.18 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD 0 | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214000-0000-4c01-8a01-000000000203','a0000000-0000-4000-8000-000000000203','99214','covered',
   '{"answer":"South Carolina Medicaid pays 99214 at $98.84 (non-facility) and $75.23 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $79.07 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":98.84,"facilityRate":75.23,"npPaRate":79.07,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99214 | MOD 0 | PAYMENT RATE 79.069999999999993 | FACILITY RATE 60.18 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD 0 | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214000-0000-4c01-8a01-000000000204','a0000000-0000-4000-8000-000000000204','99214','covered',
   '{"answer":"South Carolina Medicaid pays 99214 at $98.84 (non-facility) and $75.23 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $79.07 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":98.84,"facilityRate":75.23,"npPaRate":79.07,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99214 | MOD 0 | PAYMENT RATE 79.069999999999993 | FACILITY RATE 60.18 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD 0 | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214000-0000-4c01-8a01-000000000205','a0000000-0000-4000-8000-000000000205','99214','covered',
   '{"answer":"South Carolina Medicaid pays 99214 at $98.84 (non-facility) and $75.23 (facility) on the Base Physicians Fee Schedule, effective 2024-07-01. Billed by a nurse practitioner or physician assistant, the PA/NP schedule pays $79.07 — 80% of the physician rate — which is the rate that applies to most nurse-practitioner-led practices. This is the state fee-for-service rate. A Medicaid managed care plan is expected to pay on this basis unless its own contract states otherwise, so treat it as the floor rather than as this plan''s published rate.","rate":98.84,"facilityRate":75.23,"npPaRate":79.07,"npPaPercentOfPhysician":80,"manuallyPriced":false,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","appliesToService":"procedure code listed on the SC Medicaid Base Physicians Fee Schedule","mappedFrom":"state fee-for-service schedule applied as the managed care floor","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)","supportingQuotes":[{"label":"PA/NP differential","document":"SC DHHS — Physician Assistant / Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025)","quote":"SC DHHS Physician Assistant/Nurse Practitioner Fee Schedule (schedule creation date 8/15/2025), row: PROC 99214 | MOD 0 | PAYMENT RATE 79.069999999999993 | FACILITY RATE 60.18 | EFFECTIVE DATE 2024-07-01"}]}',
   'covered',0.85,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD 0 | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),

  -- ---- telehealth, from the GT rows --------------------------------------
  ('c9213700-0000-4c01-8a01-000000000201','a0000000-0000-4000-8000-000000000201','99213','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99213 with a GT modifier at $69.94 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":69.94,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD GT | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213700-0000-4c01-8a01-000000000202','a0000000-0000-4000-8000-000000000202','99213','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99213 with a GT modifier at $69.94 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":69.94,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD GT | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213700-0000-4c01-8a01-000000000203','a0000000-0000-4000-8000-000000000203','99213','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99213 with a GT modifier at $69.94 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":69.94,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD GT | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213700-0000-4c01-8a01-000000000204','a0000000-0000-4000-8000-000000000204','99213','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99213 with a GT modifier at $69.94 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":69.94,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD GT | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9213700-0000-4c01-8a01-000000000205','a0000000-0000-4000-8000-000000000205','99213','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99213 with a GT modifier at $69.94 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":69.94,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99213 | MOD GT | PAYMENT RATE 69.94 | FACILITY RATE 51 | EFFECTIVE DATE 2024-07-01'),
  ('c9214700-0000-4c01-8a01-000000000201','a0000000-0000-4000-8000-000000000201','99214','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99214 with a GT modifier at $98.84 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":98.84,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD GT | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214700-0000-4c01-8a01-000000000202','a0000000-0000-4000-8000-000000000202','99214','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99214 with a GT modifier at $98.84 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":98.84,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD GT | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214700-0000-4c01-8a01-000000000203','a0000000-0000-4000-8000-000000000203','99214','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99214 with a GT modifier at $98.84 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":98.84,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD GT | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214700-0000-4c01-8a01-000000000204','a0000000-0000-4000-8000-000000000204','99214','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99214 with a GT modifier at $98.84 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":98.84,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD GT | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01'),
  ('c9214700-0000-4c01-8a01-000000000205','a0000000-0000-4000-8000-000000000205','99214','telehealth_allowed',
   '{"answer":"The SC Medicaid Base Physicians Fee Schedule prices 99214 with a GT modifier at $98.84 — the same as the in-person rate. GT identifies a service delivered by interactive audio and video, so the state pays this code for telehealth delivery with no reduction. Confirm the plan''s own telehealth policy for originating-site and consent requirements, which a fee schedule does not state.","rate":98.84,"telehealthModifier":"GT","parityWithInPerson":true,"rateBasis":"sc_medicaid_ffs_base_physicians_schedule","sourceDocument":"SC DHHS — Base Physicians Fee Schedule (schedule creation date 5/15/2026)"}',
   'covered',0.80,
   'SC DHHS Base Physicians Fee Schedule (schedule creation date 5/15/2026), row: PROC 99214 | MOD GT | PAYMENT RATE 98.84 | FACILITY RATE 75.23 | EFFECTIVE DATE 2024-07-01')
) AS v(id, payer_id, code, attribute, value, coverage_status, confidence, source_quote)
ON CONFLICT (id) DO UPDATE SET
  value = EXCLUDED.value, coverage_status = EXCLUDED.coverage_status,
  confidence = EXCLUDED.confidence, source_quote = EXCLUDED.source_quote,
  effective_date = EXCLUDED.effective_date, expiration_date = NULL,
  source_doc_id = EXCLUDED.source_doc_id;

DO $$
DECLARE
  n INT;
  dupes INT;
BEGIN
  SELECT count(*) INTO n FROM payer_rule
   WHERE created_by = 'extract:sc-office-visits-2026-08' AND expiration_date IS NULL;
  IF n <> 20 THEN
    RAISE EXCEPTION 'expected 20 live rules from this seed, found %', n;
  END IF;

  -- The invariant this library turns on: one live rule per key.
  SELECT count(*) INTO dupes FROM (
    SELECT payer_id, state, code, attribute, count(*) AS c
      FROM payer_rule
     WHERE expiration_date IS NULL AND code IN ('99213','99214') AND state = 'SC'
     GROUP BY 1,2,3,4 HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION '% duplicate live key(s) on 99213/99214 in SC', dupes;
  END IF;

  RAISE NOTICE 'SC office visits: 20 live rules (5 payers x 99213/99214 x covered+telehealth), no duplicate keys';
END $$;

COMMIT;
