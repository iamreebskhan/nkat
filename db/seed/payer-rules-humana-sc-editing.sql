-- Seed: Humana Healthy Horizons South Carolina — code editing rule SC157.
--
-- Source: Humana Healthy Horizons in South Carolina — Medicaid code editing rules (LC10134SC0221)
-- https://assets.humana.com/is/content/humana/LC10134SC0221_South_Carolina_initial_code_editing_rulespdf
--
-- The rule limits reimbursement of home-visit E/M codes to place of
-- service 02 or 12. A home visit billed with POS 11 is denied — a
-- concrete, preventable denial that no narrative document states.
--
-- The source_quote below was pulled PROGRAMMATICALLY out of the PDF, not
-- transcribed, so it cannot have drifted from the source. The generator
-- aborts if the extracted text does not contain the code range and the
-- place-of-service values.
--
-- 99343 is deliberately excluded although the document states a range:
-- the code is retired (absent from the CMS RVU file; Ohio Medicaid lists
-- it discontinued from 01/01/2023). We do not emit rules for codes that
-- no longer exist.
--
-- Caveat recorded honestly: this edition is dated 2021 and Humana has
-- published no newer South Carolina code-editing document. It is the
-- current published version, not a stale one we chose over a newer one.
--
-- 8 rules. Idempotent: deterministic UUIDs + ON CONFLICT (id) DO UPDATE.

BEGIN;

INSERT INTO source_document (id, payer_id, url, document_type, title, retrieved_at, content_hash, cms_license_token_used, source_metadata, extracted_at)
VALUES ('22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'https://assets.humana.com/is/content/humana/LC10134SC0221_South_Carolina_initial_code_editing_rulespdf', 'medical_policy', 'Humana Healthy Horizons in South Carolina — Medicaid code editing rules (LC10134SC0221)', now(), 'sha256:humana-sc-editing', FALSE, '{}'::jsonb, now())
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, extracted_at = now();

UPDATE payer_rule old
   SET expiration_date = CURRENT_DATE
  FROM (VALUES
    ('99341'),
    ('99342'),
    ('99344'),
    ('99345'),
    ('99347'),
    ('99348'),
    ('99349'),
    ('99350')
  ) AS k(code)
 WHERE old.payer_id  = 'a0000000-0000-4000-8000-000000000204'::uuid
   AND old.state     = 'SC'
   AND old.code      = k.code
   AND old.attribute = 'pos_allowed'
   AND old.created_by <> 'extract:humana-sc-editing-2026-08'
   AND old.expiration_date IS NULL;

INSERT INTO payer_rule (id, payer_id, state, product_line, code, attribute, value, coverage_status, confidence, effective_date, expiration_date, source_doc_id, source_quote, created_by)
VALUES
  ('965798da-276f-4f2d-a681-eeba30394f71'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99341', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('4156cdf1-d381-469f-89ef-c975b37ad659'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99342', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('b29cdd46-edc8-4fb5-965a-113a4b4d674b'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99344', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('51473172-2060-4fe8-b5cd-2d16b78ef0e0'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99345', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('0263e73a-6d73-44ec-a792-1fe4b0891e20'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99347', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('ea643255-0180-4d85-a45f-d51d15eed2aa'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99348', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('a6a2015c-08ff-48ac-b020-7f0cc31f21b6'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99349', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08'),
  ('029c63b8-7c9d-4ded-90c4-a40c00a795ca'::uuid, 'a0000000-0000-4000-8000-000000000204'::uuid, 'SC', 'medicaid_mco', '99350', 'pos_allowed', '{"answer":"Humana Healthy Horizons in South Carolina reimburses home visit E/M codes 99341-99350 only when the claim carries place of service 02 (telehealth) or 12 (patient’s home). A home visit billed with any other place of service — office (11), for example — will be denied. Code editing rule SC157.","allowedPlaceOfService":["02","12"],"ruleNumber":"SC157"}'::jsonb, 'varies', 0.90, DATE '2021-07-01', NULL, '22957942-ef2f-4e5c-a89b-13513fc00940'::uuid, 'Rule SC157 — We limit reimbursement of charges for home visit E/M CPT codes 99341 – 99350 to claims submitted with one of the following place-of-service codes: • 02 – Telehealth • 12 – Patient’s home', 'extract:humana-sc-editing-2026-08')
ON CONFLICT (id) DO UPDATE SET
  value        = EXCLUDED.value,
  source_quote = EXCLUDED.source_quote,
  expiration_date = NULL;

COMMIT;

SELECT p.name AS payer, count(*) AS rules
  FROM payer_rule pr JOIN payer p ON p.id = pr.payer_id
 WHERE pr.created_by = 'extract:humana-sc-editing-2026-08' GROUP BY 1;
