-- ============================================================================
-- 0006_code_facts.sql
-- The code facts the 3 Nov 2026 code audit corrected stay corrected. Each block
-- names the wrong value it guards against, because each one was shipped once:
--
--   * the catalog called 99341, 99347 and 99202 "low" MDM (they are
--     straightforward), left the 980xx telemedicine codes as placeholders that
--     swapped new/established and video/audio-only, and gave G0569/G0570
--     another code's meaning;
--   * the CY2026 rule library described G0317/G0318 as prolonged OFFICE codes
--     and marked deleted codes (99201, 99318, 99340, 99354, 99355, G2058,
--     G2064, G2065) and a non-code (99319) "covered";
--   * Medicare CMS status X/E codes — 36415 venipuncture, screening labs, FQHC
--     visits — read "not covered", and January to June 2026 had no Medicare
--     rate at all;
--   * NC Medicaid listed CPT codes deleted in 2023 as covered;
--   * reference tables named the wrong taxonomy, revenue, place-of-service,
--     bill type, ASC and HCC facts.
--
-- Read-only: every statement is a SELECT inside a DO block.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== Code catalog: MDM levels, telemedicine codes, APCM add-ons, J9170 =='

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(code || ' "' || short_descriptor || '" mdm=' || coalesce(mdm_level, '-'), '; ' ORDER BY code) INTO bad
    FROM code
   WHERE expiration_date IS NULL
     AND (   (code IN ('99341', '99347', '99202') AND short_descriptor NOT ILIKE '%straightforward%')
          OR (code IN ('99341', '99347') AND mdm_level IS DISTINCT FROM 'straightforward')
          OR (code BETWEEN '98000' AND '98015' AND short_descriptor ILIKE '%placeholder%')
          OR (code BETWEEN '98004' AND '98007' AND short_descriptor NOT ILIKE '%est pt%')
          OR (code BETWEEN '98008' AND '98015' AND short_descriptor NOT ILIKE 'Audio-only%')
          OR (code = 'G0569' AND (short_descriptor ILIKE '%initial%' OR short_descriptor NOT ILIKE '%later month%'))
          OR (code = 'G0570' AND (short_descriptor ILIKE '%collab%' OR short_descriptor NOT ILIKE '%behavioral health%'))
          OR (code = 'H0004' AND (short_descriptor ILIKE 'SUD%' OR is_sud_part2)));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CODE CATALOG WRONG AGAIN: %', bad;
  END IF;

  IF EXISTS (SELECT 1 FROM code WHERE code = 'J9170' AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE))
     OR NOT EXISTS (SELECT 1 FROM code WHERE code = 'J9171' AND expiration_date IS NULL) THEN
    RAISE EXCEPTION 'J9170 (deleted 2010) is in force, or J9171 is missing.';
  END IF;
END $$;

\echo 'Catalog OK.'

\echo ''
\echo '== No rule calls a deleted code, or a non-code, covered =='

DO $$
DECLARE
  bad text;
BEGIN
  -- CPT deleted these on 1 Jan 2021 (99201) or 1 Jan 2023; HCPCS retired
  -- G2058 at the end of 2020 and G2064/G2065 at the end of 2021. 99319 never
  -- existed: it is where CMS's MSSP range "99319 through 99340" starts.
  -- Checked on several 2026 dates of service, since rules carry dates.
  SELECT string_agg(DISTINCT pr.code || ' (' || p.name || ' ' || pr.state || ')', ', ') INTO bad
    FROM payer_rule pr
    JOIN payer p ON p.id = pr.payer_id
   CROSS JOIN (VALUES (DATE '2026-02-15'), (DATE '2026-05-15'), (DATE '2026-08-15'), (CURRENT_DATE)) d(dos)
   WHERE pr.attribute = 'covered'
     AND pr.coverage_status = 'covered'
     AND pr.effective_date <= d.dos
     AND (pr.expiration_date IS NULL OR pr.expiration_date > d.dos)
     AND pr.code IN ('99201', '99217', '99218', '99219', '99220', '99224', '99225', '99226',
                     '99241', '99251', '99318', '99319', '99324', '99325', '99326', '99327',
                     '99328', '99334', '99335', '99336', '99337', '99339', '99340', '99343',
                     '99354', '99355', '99356', '99357', 'G2058', 'G2064', 'G2065');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'DELETED CODE MARKED COVERED: %', bad;
  END IF;

  IF EXISTS (SELECT 1 FROM payer_rule WHERE code = '99319'
               AND (expiration_date IS NULL OR expiration_date > effective_date)) THEN
    RAISE EXCEPTION '99319 is not a CPT code, yet a rule for it is served on some date.';
  END IF;
END $$;

\echo 'No deleted code is covered.'

\echo ''
\echo '== G0317 and G0318 are not described as office codes =='

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM payer_rule
   WHERE (expiration_date IS NULL OR expiration_date > effective_date)
     AND value->>'answer' ~* 'G031[78] \(prolonged office';
  IF n > 0 THEN
    RAISE EXCEPTION '% rule(s) describe G0317/G0318 as a prolonged office visit (G0318 is home or residence, G0317 nursing facility).', n;
  END IF;
END $$;

\echo 'G0317/G0318 described as themselves.'

\echo ''
\echo '== Medicare: status X/E is not "not covered"; every 2026 quarter has a rate =='

DO $$
DECLARE
  bad    text;
  rates  text;
  dupes  int;
BEGIN
  -- CMS status X/E means "not paid under the physician fee schedule", not
  -- "not covered": 36415 is paid on the lab fee schedule. Only 99360
  -- (standby) is not paid anywhere.
  SELECT string_agg(DISTINCT pr.code, ', ') INTO bad
    FROM payer_rule pr
   WHERE pr.attribute = 'covered'
     AND pr.coverage_status = 'not_covered'
     AND pr.source_quote ~ 'Relative Value File RVU26[ABC] .* \| status code [XE] \|'
     AND pr.code <> '99360'
     AND (pr.expiration_date IS NULL OR pr.expiration_date > pr.effective_date);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'CMS STATUS X/E READ AS NOT COVERED: %', bad;
  END IF;

  -- No rule may price a service at $0 (99455/99456 are contractor-priced).
  IF EXISTS (SELECT 1 FROM payer_rule WHERE value->>'rate' IN ('0', '0.0', '0.00')
               AND (expiration_date IS NULL OR expiration_date > effective_date)) THEN
    RAISE EXCEPTION 'A rule prices a service at $0.';
  END IF;

  -- POSITIVE CONTROL: 99350 for Traditional Medicare in Ohio has its CMS rate
  -- and the NP/PA 85% on a date in each quarter of 2026, from one rule each.
  SELECT string_agg(format('%s: %s rule(s), rate %s, NP/PA %s', q.dos, q.n, q.rate, q.np), '; ' ORDER BY q.dos)
    INTO rates
    FROM (
      SELECT d.dos, count(pr.id) AS n, min(pr.value->>'rate') AS rate, min(pr.value->>'npPaRate') AS np
        FROM (VALUES (DATE '2026-02-15'), (DATE '2026-05-15'), (DATE '2026-08-15')) d(dos)
        LEFT JOIN payer_rule pr
          ON pr.payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
         AND pr.state = 'OH' AND pr.code = '99350' AND pr.attribute = 'covered'
         AND pr.effective_date <= d.dos
         AND (pr.expiration_date IS NULL OR pr.expiration_date > d.dos)
       GROUP BY d.dos
    ) q
   WHERE q.n <> 1 OR q.rate IS DISTINCT FROM '193.06' OR q.np IS DISTINCT FROM '164.1';
  IF rates IS NOT NULL THEN
    RAISE EXCEPTION 'MEDICARE 99350 OH IS NOT ONE RULE AT $193.06 (NP/PA $164.10) IN EVERY 2026 QUARTER: %', rates;
  END IF;

  -- One Medicare 'covered' rule per key on a date in each half of the year.
  SELECT count(*) INTO dupes FROM (
    SELECT pr.state, pr.code, d.dos
      FROM payer_rule pr
     CROSS JOIN (VALUES (DATE '2026-02-15'), (DATE '2026-05-15'), (DATE '2026-08-15')) d(dos)
     WHERE pr.payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
       AND pr.attribute = 'covered'
       AND pr.effective_date <= d.dos
       AND (pr.expiration_date IS NULL OR pr.expiration_date > d.dos)
     GROUP BY pr.state, pr.code, d.dos HAVING count(*) > 1) x;
  IF dupes > 0 THEN
    RAISE EXCEPTION '% Medicare covered key/date(s) serve more than one rule in 2026.', dupes;
  END IF;
END $$;

\echo 'Medicare statuses and 2026 rates OK.'

\echo ''
\echo '== Reference tables =='

DO $$
DECLARE
  bad text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider_taxonomy WHERE taxonomy = '207RH0002X' AND specialization = 'Hospice and Palliative Medicine')
     OR NOT EXISTS (SELECT 1 FROM provider_taxonomy WHERE taxonomy = '207RH0003X' AND specialization = 'Hematology & Oncology')
     OR NOT EXISTS (SELECT 1 FROM provider_taxonomy WHERE taxonomy = '251G00000X' AND classification = 'Hospice Care, Community Based')
     OR NOT EXISTS (SELECT 1 FROM provider_taxonomy WHERE taxonomy = '251E00000X' AND classification = 'Home Health') THEN
    bad := bad || 'taxonomy; ';
  END IF;
  IF EXISTS (SELECT 1 FROM pos WHERE pos IN ('05', '07') AND facility_indicator <> 'non_facility') THEN
    bad := bad || 'POS 05/07 marked facility; ';
  END IF;
  IF EXISTS (SELECT 1 FROM revenue_code WHERE code IN ('0573', '0574'))
     OR NOT EXISTS (SELECT 1 FROM revenue_code WHERE code = '0551')
     OR EXISTS (SELECT 1 FROM revenue_code WHERE code = '0572' AND description ILIKE '%PT%') THEN
    bad := bad || 'home health revenue codes; ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ub04_bill_type WHERE bill_type = '181' AND description ILIKE '%swing bed%')
     OR EXISTS (SELECT 1 FROM ub04_bill_type WHERE bill_type = '141' AND description ILIKE '%observation%') THEN
    bad := bad || 'bill types 141/181; ';
  END IF;
  IF EXISTS (SELECT 1 FROM asc_payment_indicator WHERE payment_indicator = 'P1') THEN
    bad := bad || 'ASC indicator P1 (not an indicator); ';
  END IF;
  IF EXISTS (SELECT 1 FROM hcc_mapping WHERE hcc_version = 'V28' AND effective_year = 2026
               AND (   (icd10 = 'I50.22' AND hcc_code <> 'HCC226')
                    OR (icd10 = 'C34.10' AND hcc_code <> 'HCC020')
                    OR (icd10 = 'N18.6'  AND hcc_code <> 'HCC326')
                    OR icd10 IN ('F32.A', 'F33.0', 'R64'))) THEN
    bad := bad || 'HCC V28 mappings; ';
  END IF;
  IF EXISTS (SELECT 1 FROM modifier WHERE modifier = 'GT' AND payer_applicability = '{Medicare}') THEN
    bad := bad || 'GT marked Medicare-only; ';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'REFERENCE TABLES WRONG AGAIN: %', bad;
  END IF;
END $$;

\echo ''
\echo 'CODE FACTS OK'
