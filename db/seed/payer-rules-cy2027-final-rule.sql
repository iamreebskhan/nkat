-- ============================================================================
-- Seed: CY2027 Medicare PFS FINAL RULE — what changes for a home-based
-- palliative practice on 1 January 2027.
--
-- Source: CMS-1848-F, "Medicare and Medicaid Programs; CY 2027 Payment
-- Policies Under the Physician Fee Schedule…", filed for public inspection on
-- 4 November 2026 (Federal Register document 2026-22743, 2,468 pages).
-- Effective 2027-01-01. Every source_quote is a sentence of that text,
-- complete, checked verbatim against it.
--
-- WHAT IT WRITES, for Traditional Medicare (Part B) in OH, NC and SC, each
-- rule from 2027-01-01:
--   * G2211 stops: CMS replaced the visit complexity add-on code with
--     modifier B1 on the E/M visit's own claim line (B2 for a practitioner in
--     a Shared Savings Program or LEAD ACO). Its 'covered' and 'bundled_with'
--     rules say so from 1 January.
--   * The 17 office/outpatient and home or residence E/M codes CMS's "Mod B1
--     B2 Adjusted RVUs" file lists take a 'bundled_with' rule naming B1 and
--     B2 in G2211's place. Their 2027 rates, with and without the modifiers,
--     are in payer-rules-fee-schedules-full.sql.
--   * Advance care planning: G0572 and G0573 (new) report clinical staff
--     time; 99497 and 99498 the billing practitioner's, and both sets may be
--     billed together. 'documentation_required' rules on all four.
--   * Modifiers B1 and B2 (modifier) and codes G0572 and G0573 (code), from
--     2027-01-01.
--
-- THE RULE EACH REPLACES ENDS WHERE IT BEGINS (step 2): G2211's rules and
-- the home visit codes' G2211 add-on rules from the CY2026 final rule end on
-- 2027-01-01, so every date of service has one rule per key, 2026 dates the
-- 2026 rule. payer-rules-cy2026-full-rule.sql (step 5d) ends them there too
-- once these rows exist; on a database where it ran first, this does.
-- db/maintenance/close-rule-timelines.sql keeps a rule that begins after
-- today; it used to shut it.
--
-- Idempotent: deterministic ids (md5 of state, code and attribute) and
-- ON CONFLICT (id) DO UPDATE.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payer WHERE id = 'a0000000-0000-4000-8000-000000000401'::uuid) THEN
    RAISE EXCEPTION 'Traditional Medicare (Part B) payer row is missing. Apply db/seed/payer-medicare.sql first.';
  END IF;
END $$;

INSERT INTO source_document (id, payer_id, url, document_type, title, retrieved_at, content_hash, cms_license_token_used, source_metadata, extracted_at)
VALUES
  ('b0000000-0000-4000-8000-000000002027'::uuid, 'a0000000-0000-4000-8000-000000000401'::uuid,
   'https://public-inspection.federalregister.gov/2026-22743.pdf', 'cms_pfs',
   'CMS — CY2027 Physician Fee Schedule Final Rule (CMS-1848-F, public inspection copy)', now(),
   'sha256:4f292c6e2b82286bb88e4557d955a985d4653118c97167ce95e55a7e9996b395', FALSE, '{}'::jsonb, now())
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, content_hash = EXCLUDED.content_hash;

CREATE TEMP TABLE _cy2027_rules (
  code TEXT, attribute TEXT, coverage_status TEXT, value_json TEXT, source_quote TEXT
) ON COMMIT DROP;

INSERT INTO _cy2027_rules (code, attribute, coverage_status, value_json, source_quote) VALUES
  ('G2211', 'covered', 'not_covered',
   '{"answer":"Not billed for a date of service from 1 January 2027. The CY 2027 final rule replaced HCPCS G2211 with modifier B1 on the claim line of the office/outpatient or home or residence E/M visit (B2 for a practitioner in a Shared Savings Program or LEAD ACO): the visit''s complexity is paid as part of the visit, not on a separate line. Bill G2211 only for a visit before 1 January 2027."}',
   'We therefore proposed to replace HCPCS code G2211 with a modifier, which we referred to in the proposed rule as MOD1, which was a placeholder to be replaced with a two-digit HCPCS modifier. We are finalizing modifier B1 as the modifier to replace placeholder MOD1.'),
  ('G2211', 'bundled_with', 'not_covered',
   '{"answer":"From 1 January 2027 G2211 is not added to an E/M visit: modifier B1 goes on the visit''s own claim line instead (B2 for a practitioner in a Shared Savings Program or LEAD ACO)."}',
   'This should also reduce operational burden, as it will not require the submission of a separate claim line, because the modifier will be placed on the claim line for the associated E/M code.'),
  ('99497', 'documentation_required', 'covered',
   '{"answer":"From 1 January 2027 CPT 99497 reports the billing practitioner''s own advance care planning time. Time clinical staff spend under the practitioner''s direct supervision is reported with HCPCS G0572 (first 20 minutes) and G0573 (each additional 20). Both may be billed for the same patient when each code''s time is met, and time counted for one code is not counted for another."}',
   'We are finalizing the proposal that HCPCS codes G0572 and G0573 and CPT codes 99497 and 99498 could be reported together, if time thresholds by the billing practitioner and clinical staff are each met with these respective code sets.'),
  ('99498', 'documentation_required', 'covered',
   '{"answer":"From 1 January 2027 CPT 99498 reports each additional 30 minutes of the billing practitioner''s own advance care planning time. Clinical staff time goes on HCPCS G0572 and G0573. Both may be billed for the same patient when each code''s time is met, and time counted for one code is not counted for another."}',
   'We are finalizing the proposal that HCPCS codes G0572 and G0573 and CPT codes 99497 and 99498 could be reported together, if time thresholds by the billing practitioner and clinical staff are each met with these respective code sets.'),
  ('G0572', 'documentation_required', 'covered',
   '{"answer":"New from 1 January 2027: advance care planning by clinical staff, first 20 minutes, directed by a treating physician or other qualified health care professional under direct supervision (audio-video technology can satisfy it). When staff time alone does not reach 20 minutes, the practitioner''s time may be added to it; time counted here is not also counted for 99497. On the Medicare telehealth list from 2027. The record must show the time spent."}',
   'Additionally, when counting time for HCPCS codes G0572 and G0573, we are also permitting the counting of practitioner time in combination with clinical staff time to meet the time threshold if clinical staff time otherwise would not meet the time threshold to report the code.'),
  ('G0573', 'documentation_required', 'covered',
   '{"answer":"New from 1 January 2027: each additional 20 minutes of advance care planning by clinical staff, billed with G0572 once G0572''s full 20 minutes have been spent (clinical staff time, or staff and practitioner time together). On the Medicare telehealth list from 2027. The record must show the time spent."}',
   'We also note that HCPCS code G0573 can be reported once the full 20 minutes of clinical staff time or clinical staff time plus practitioner time has been spent under G0572.');

-- The 17 visit codes B1 and B2 go on: CMS's "Mod B1 B2 Adjusted RVUs" file.
INSERT INTO _cy2027_rules (code, attribute, coverage_status, value_json, source_quote)
SELECT c.code, 'bundled_with', 'covered',
       json_build_object('answer',
         'From 1 January 2027 the visit complexity add-on is modifier B1 on this code''s own claim line, not HCPCS G2211. '
         || 'B1 raises the visit''s work RVU by 16% (CMS''s Mod B1 B2 Adjusted RVUs file); B2, 32%, is for a practitioner in a Shared Savings Program or LEAD ACO only. '
         || 'Either may be used when the visit is furnished by telehealth. They go on office/outpatient and home or residence E/M visits only, not on add-on lines such as G0318 or 99497.')::text,
       'We are clarifying that modifiers B1 and B2 may only be used in conjunction with E/M visits performed in the O/O or home or residence setting and may not be performed in conjunction with E/M visits in other settings, such as SNF, RHC, FQHC, CAH, or other places of service.'
  FROM (VALUES ('99202'), ('99203'), ('99204'), ('99205'), ('99211'), ('99212'), ('99213'), ('99214'), ('99215'),
               ('99341'), ('99342'), ('99344'), ('99345'), ('99347'), ('99348'), ('99349'), ('99350')) AS c(code);

-- 1. One row per rule per state, each from 2027-01-01.
INSERT INTO payer_rule (id, payer_id, state, product_line, code, attribute, value, coverage_status, confidence, effective_date, expiration_date, source_doc_id, source_quote, created_by)
SELECT md5('cy2027|' || s.state || '|' || r.code || '|' || r.attribute)::uuid,
       'a0000000-0000-4000-8000-000000000401'::uuid, s.state, 'medicare_ffs', r.code, r.attribute,
       r.value_json::jsonb, r.coverage_status, 0.95, DATE '2027-01-01', NULL,
       'b0000000-0000-4000-8000-000000002027'::uuid, r.source_quote, 'extract:cy2027-final-rule-2026-11'
  FROM _cy2027_rules r
 CROSS JOIN (VALUES ('OH'), ('NC'), ('SC')) AS s(state)
ON CONFLICT (id) DO UPDATE SET
  value           = EXCLUDED.value,
  coverage_status = EXCLUDED.coverage_status,
  source_quote    = EXCLUDED.source_quote,
  effective_date  = EXCLUDED.effective_date,
  confidence      = EXCLUDED.confidence,
  expiration_date = EXCLUDED.expiration_date;

-- 2. The rule each replaces ends where it begins: never before, so 2026
--    dates of service keep the 2026 rule, and never deleted.
UPDATE payer_rule pr
   SET expiration_date = DATE '2027-01-01'
  FROM _cy2027_rules r
 CROSS JOIN (VALUES ('OH'), ('NC'), ('SC')) AS s(state)
 WHERE pr.payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
   AND pr.state = s.state
   AND pr.code = r.code
   AND pr.attribute = r.attribute
   AND pr.source_doc_id <> 'b0000000-0000-4000-8000-000000002027'::uuid
   AND pr.effective_date < DATE '2027-01-01'
   AND (pr.expiration_date IS NULL OR pr.expiration_date > DATE '2027-01-01');

-- 3. The two modifiers, from the day they exist.
INSERT INTO modifier (modifier, description, modifier_type, payer_applicability, effective_date) VALUES
  ('B1', 'Visit complexity inherent to an office/outpatient or home or residence E/M visit (replaces HCPCS G2211; work RVU +16%)', 'pricing', '{Medicare}', '2027-01-01'),
  ('B2', 'Visit complexity, practitioner in a Shared Savings Program or LEAD ACO (work RVU +32%)', 'pricing', '{Medicare}', '2027-01-01')
ON CONFLICT (modifier) DO UPDATE SET
  description = EXCLUDED.description, modifier_type = EXCLUDED.modifier_type,
  payer_applicability = EXCLUDED.payer_applicability, effective_date = EXCLUDED.effective_date;

-- 4. The two new codes, for the code list from 2027-01-01.
INSERT INTO code (code, code_system, short_descriptor, category, effective_date, specialty, typical_minutes) VALUES
  ('G0572', 'HCPCS2', 'Advance care planning by clinical staff, first 20 min', 'ACP', '2027-01-01', 'palliative', 20),
  ('G0573', 'HCPCS2', 'Advance care planning by clinical staff, each addl 20 min', 'ACP', '2027-01-01', 'palliative', 20)
ON CONFLICT (code, effective_date) DO UPDATE SET
  short_descriptor = EXCLUDED.short_descriptor, category = EXCLUDED.category,
  specialty = EXCLUDED.specialty, typical_minutes = EXCLUDED.typical_minutes;

COMMIT;
