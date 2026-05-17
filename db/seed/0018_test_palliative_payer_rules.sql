-- ============================================================================
-- 0018_test_palliative_payer_rules.sql
--
-- A realistic palliative-care billing rulebook for TEST / DEMO use.
-- Structured from public payer reimbursement-policy language for the
-- three OH payers already seeded in 0008. Each payer_rule carries a
-- verbatim source_quote so the lookup engine returns a CITED answer
-- (the engine refuses to answer without a citation).
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING.
--
-- Payers (from 0008_phase4_payers.sql):
--   a0000000-0000-4000-8000-000000000301  Aetna                 (commercial)
--   a0000000-0000-4000-8000-000000000302  UHC Community Plan OH (medicaid_mco)
--   a0000000-0000-4000-8000-000000000303  Anthem BCBS Ohio      (commercial)
-- ============================================================================

-- ---- source_document (global; payer policy PDFs) --------------------------
INSERT INTO source_document
  (id, payer_id, url, document_type, title, effective_date,
   retrieved_at, content_hash, cms_license_token_used, source_metadata)
VALUES
  ('d0000000-0000-4000-8000-000000000a01',
   'a0000000-0000-4000-8000-000000000301',
   'https://www.aetna.com/cpb/medical/data/1_99/0009.html',
   'reimbursement_policy',
   'Aetna — Home Care & Palliative E/M Reimbursement Policy (2026)',
   '2026-01-01', now(), 'sha256:test-aetna-pall-2026', FALSE,
   '{"seed":"0018","note":"test rulebook"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000a02',
   'a0000000-0000-4000-8000-000000000302',
   'https://www.uhcprovider.com/oh-community-plan-palliative',
   'provider_manual',
   'UnitedHealthcare Community Plan OH — Palliative Care Provider Manual (2026)',
   '2026-01-01', now(), 'sha256:test-uhc-oh-pall-2026', FALSE,
   '{"seed":"0018","note":"test rulebook"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000a03',
   'a0000000-0000-4000-8000-000000000303',
   'https://providers.anthem.com/ohio-provider/policies/palliative',
   'reimbursement_policy',
   'Anthem BCBS Ohio — Palliative & Advance Care Planning Policy (2026)',
   '2026-01-01', now(), 'sha256:test-anthem-oh-pall-2026', FALSE,
   '{"seed":"0018","note":"test rulebook"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ---- payer_rule -----------------------------------------------------------
-- value JSONB carries an `answer` string (renderStructuredAnswer reads it).
-- attribute uses the canonical DB enum from 0003.
INSERT INTO payer_rule
  (id, payer_id, state, product_line, code, attribute, value,
   coverage_status, confidence, effective_date, expiration_date,
   source_doc_id, source_quote, source_page, created_by)
VALUES
  -- ===== Aetna (commercial) ===============================================
  ('e0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99349','covered',
   '{"answer":"Covered for established-patient home visits (moderate MDM / 40 min) when the visit is medically necessary and the home is the patient''s residence."}'::jsonb,
   'covered',0.95,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'CPT 99349 is a covered service for established patients seen in the home when medically necessary.',12,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99349','prior_auth_required',
   '{"answer":"No prior authorization is required for 99349.","required":false}'::jsonb,
   'covered',0.92,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'Prior authorization is not required for home E/M codes 99347-99350.',14,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000003',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99349','telehealth_allowed',
   '{"answer":"Telehealth is permitted for 99349 via real-time audio-video; append modifier 95 and POS 10."}'::jsonb,
   'covered',0.88,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'Home E/M services may be furnished via synchronous audio-video telehealth with modifier 95.',19,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000004',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99349','documentation_required',
   '{"answer":"Document total time or MDM, place of service (home), and medical necessity for the home setting."}'::jsonb,
   'covered',0.90,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'The medical record must support time or medical decision making and the necessity of a home visit.',15,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000005',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99497','covered',
   '{"answer":"Advance Care Planning (first 30 minutes) is covered when voluntary and documented."}'::jsonb,
   'covered',0.93,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'Advance care planning code 99497 is reimbursable when the discussion is voluntary and documented.',22,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000006',
   'a0000000-0000-4000-8000-000000000301','OH','commercial','99350','frequency_limit',
   '{"answer":"Up to 1 home E/M (99350) per patient per day; additional same-day visits require modifier 25.","maxPerDay":1}'::jsonb,
   'varies',0.85,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a01',
   'Only one home visit E/M per day is reimbursed absent a separately identifiable service.',16,'test@pallio.io'),

  -- ===== UHC Community Plan OH (medicaid_mco) =============================
  ('e0000000-0000-4000-8000-000000000011',
   'a0000000-0000-4000-8000-000000000302','OH','medicaid_mco','99349','covered',
   '{"answer":"Covered under Ohio Medicaid managed care for established home visits with documented medical necessity."}'::jsonb,
   'covered',0.94,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a02',
   'Home visit code 99349 is a covered benefit for members receiving palliative care at home.',8,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000012',
   'a0000000-0000-4000-8000-000000000302','OH','medicaid_mco','99349','prior_auth_required',
   '{"answer":"Prior authorization IS required after the 12th home visit in a rolling 12-month period.","required":true,"threshold":12}'::jsonb,
   'varies',0.89,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a02',
   'Prior authorization is required for the thirteenth and subsequent home visits within twelve months.',9,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000013',
   'a0000000-0000-4000-8000-000000000302','OH','medicaid_mco','G0318','covered',
   '{"answer":"G0318 longitudinal palliative care management is covered for members with a qualifying serious illness."}'::jsonb,
   'covered',0.87,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a02',
   'Longitudinal palliative care management (G0318) is reimbursable for eligible seriously ill members.',11,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000014',
   'a0000000-0000-4000-8000-000000000302','OH','medicaid_mco','99497','telehealth_allowed',
   '{"answer":"ACP (99497) may be delivered via telehealth, including audio-only, for Ohio Medicaid members."}'::jsonb,
   'covered',0.86,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a02',
   'Advance care planning may be furnished via telehealth, including audio-only, for managed-care members.',13,'test@pallio.io'),

  -- ===== Anthem BCBS Ohio (commercial) ===================================
  ('e0000000-0000-4000-8000-000000000021',
   'a0000000-0000-4000-8000-000000000303','OH','commercial','99348','covered',
   '{"answer":"Covered for established-patient home visits (low MDM / 30 min)."}'::jsonb,
   'covered',0.93,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a03',
   'Established patient home visit code 99348 is a covered service.',7,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000022',
   'a0000000-0000-4000-8000-000000000303','OH','commercial','99349','covered',
   '{"answer":"Covered; bill the level supported by total time or MDM."}'::jsonb,
   'covered',0.93,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a03',
   'Home visit services are covered at the level supported by documented time or medical decision making.',7,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000023',
   'a0000000-0000-4000-8000-000000000303','OH','commercial','99498','covered',
   '{"answer":"ACP add-on 99498 (each additional 30 min) is covered when billed with 99497."}'::jsonb,
   'covered',0.90,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a03',
   'Code 99498 is reimbursable as an add-on to 99497 for each additional 30 minutes.',18,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000024',
   'a0000000-0000-4000-8000-000000000303','OH','commercial','99349','modifier_required',
   '{"answer":"Append modifier 95 for synchronous telehealth; modifier 25 if a separately identifiable E/M is performed same day."}'::jsonb,
   'varies',0.84,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a03',
   'Modifier 95 is required for telehealth delivery; modifier 25 for a separate same-day E/M.',20,'test@pallio.io'),
  ('e0000000-0000-4000-8000-000000000025',
   'a0000000-0000-4000-8000-000000000303','OH','commercial','99349','telehealth_allowed',
   '{"answer":"Telehealth permitted for 99349 via audio-video only (not audio-only) for commercial members."}'::jsonb,
   'covered',0.87,'2026-01-01',NULL,'d0000000-0000-4000-8000-000000000a03',
   'Home E/M via telehealth is limited to synchronous audio-video for commercial plans.',21,'test@pallio.io')
ON CONFLICT (id) DO NOTHING;
