-- UnitedHealthcare Community Plan Ohio: the per-visit charting standard as a
-- checkable element list (audit R19).
--
-- The plan's 2026 Care Provider Manual (source_document c1a1d3f2…, seeded by
-- payer-rules-denial-attributes-2.sql) itemises what every visit note must
-- carry: appropriate vital signs, chief complaint, physical assessment,
-- diagnosis and treatment plan, the last four marked as critical elements.
-- Its Telehealth/Virtual Health Policy adds that a telehealth note must state
-- the visit was done through audio-video. The library already held this as
-- prose on 14 documentation_required rules, which nothing compared with the
-- note. Stored here as elements, it is checked against the note on the visit
-- screen (Note against bill), in the claim's risk score, and at submit.
--
-- One row per code those prose rules are mapped to. Element keys are the ones
-- lib/features/visits/documentation-check.ts knows: vitals, chief_complaint,
-- physical_exam, diagnosis, plan, and telehealth_modality (checked only on a
-- telehealth visit).
--
-- NOT checked, deliberately:
--   * height, weight and BMI "annually": longitudinal, not a per-visit fact;
--   * "signed and dated": the visit lifecycle enforces signing itself;
--   * member name or id on every page: the note and packet footers carry it
--     (audit R32).
--
-- payer_rule is untouched: it is versioned and never updated in place. Only
-- this plan gets an element list; the other payers' prose documentation rules
-- stay advisory until an analyst structures and attests them.
--
-- Idempotent: deterministic ids, ON CONFLICT (id) DO UPDATE.

INSERT INTO documentation_requirement (
  id, code, payer_id, state, product_line,
  time_components, mdm_elements, required_phrases, required_chart_elements,
  source_doc_id, effective_date, expiration_date
) VALUES
  ('d0c0e1e0-0302-4000-8000-000000000001'::uuid, '99341', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000002'::uuid, '99342', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000003'::uuid, '99344', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000004'::uuid, '99345', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000005'::uuid, '99347', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000006'::uuid, '99348', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000007'::uuid, '99349', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000008'::uuid, '99350', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000009'::uuid, '99417', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000010'::uuid, '99495', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000011'::uuid, '99496', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000012'::uuid, '99497', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000013'::uuid, '99498', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL),
  ('d0c0e1e0-0302-4000-8000-000000000014'::uuid, 'G0318', 'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medicaid_mco', '{}', '{}', '{}', '{vitals,chief_complaint,physical_exam,diagnosis,plan,telehealth_modality}', 'c1a1d3f2-6b74-4b8e-9a21-7c5e2f4d8a01'::uuid, DATE '2026-01-01', NULL)
ON CONFLICT (id) DO UPDATE SET
  code                    = EXCLUDED.code,
  payer_id                = EXCLUDED.payer_id,
  state                   = EXCLUDED.state,
  product_line            = EXCLUDED.product_line,
  time_components         = EXCLUDED.time_components,
  mdm_elements            = EXCLUDED.mdm_elements,
  required_phrases        = EXCLUDED.required_phrases,
  required_chart_elements = EXCLUDED.required_chart_elements,
  source_doc_id           = EXCLUDED.source_doc_id,
  effective_date          = EXCLUDED.effective_date,
  expiration_date         = EXCLUDED.expiration_date;
