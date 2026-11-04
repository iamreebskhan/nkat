-- ============================================================================
-- 0007_rules_on_date_of_service.sql
-- payer_allowed_codes_on(date) answers with the rules in force on that date
-- (migration 0129), and payer_allowed_codes_v is still today's answer.
--
-- A bill's code list and its denial-risk score read the function on the
-- bill's date of service. They read the view, which answers for today, so a
-- bill dated in March was scored by July's CMS file while its rate came from
-- January's.
--
-- Read-only: every statement is a SELECT inside a DO block.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== payer_allowed_codes_v is the function on today'

DO $$
DECLARE
  differ INT;
BEGIN
  SELECT count(*) INTO differ FROM (
    (SELECT * FROM payer_allowed_codes_v
     EXCEPT ALL
     SELECT payer_id, state::CHAR(2), product_line, code, descriptor, category, code_system,
            coverage_status, confidence::NUMERIC(3,2), rule_value, effective_date, expiration_date,
            source_doc_id, source_quote, created_by, rule_created_at, payer_rule_id, source_kind,
            modifier_required, prior_auth_required, has_frequency_limit, frequency_limit_value,
            prior_auth_value
       FROM payer_allowed_codes_on(CURRENT_DATE))
    UNION ALL
    (SELECT payer_id, state::CHAR(2), product_line, code, descriptor, category, code_system,
            coverage_status, confidence::NUMERIC(3,2), rule_value, effective_date, expiration_date,
            source_doc_id, source_quote, created_by, rule_created_at, payer_rule_id, source_kind,
            modifier_required, prior_auth_required, has_frequency_limit, frequency_limit_value,
            prior_auth_value
       FROM payer_allowed_codes_on(CURRENT_DATE)
     EXCEPT ALL
     SELECT * FROM payer_allowed_codes_v)
  ) x;
  IF differ <> 0 THEN
    RAISE EXCEPTION '% row(s) differ between payer_allowed_codes_v and payer_allowed_codes_on(CURRENT_DATE).', differ;
  END IF;
END $$;

\echo '== Every row is in force on the date asked, and only then'

DO $$
DECLARE
  bad INT;
BEGIN
  SELECT count(*) INTO bad
    FROM (VALUES (DATE '2026-02-15'), (DATE '2026-05-15'), (DATE '2026-08-15'), (CURRENT_DATE)) d(dos)
   CROSS JOIN LATERAL payer_allowed_codes_on(d.dos) f
   WHERE f.effective_date > d.dos
      OR (f.expiration_date IS NOT NULL AND f.expiration_date <= d.dos);
  IF bad > 0 THEN
    RAISE EXCEPTION '% row(s) answered for a date outside their own rule''s window.', bad;
  END IF;
END $$;

\echo '== Medicare 99350 in Ohio comes from the CMS file of the quarter asked'

DO $$
DECLARE
  got TEXT;
BEGIN
  -- January's file (RVU26A) for a February visit, April's (RVU26B) for May,
  -- July's (RVU26C) for August: one row each, each from its own file. The
  -- view alone, read for today, answers July's for all three.
  SELECT string_agg(format('%s: %s', q.dos, q.files), '; ' ORDER BY q.dos) INTO got
    FROM (
      SELECT d.dos, string_agg(f.source_doc_id::text, ',') AS files
        FROM (VALUES (DATE '2026-02-15'), (DATE '2026-05-15'), (DATE '2026-08-15')) d(dos)
        LEFT JOIN LATERAL payer_allowed_codes_on(d.dos) f
               ON f.payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
              AND f.state = 'OH' AND f.code = '99350'
       GROUP BY d.dos
    ) q;
  IF got IS DISTINCT FROM
     '2026-02-15: 2b1d7f30-26a0-4c6e-9a1f-26a000000001; '
     '2026-05-15: 2b1d7f30-26b0-4c6e-9a1f-26b000000001; '
     '2026-08-15: 5c5772ec-2213-4658-b32e-b5e9332dca0e' THEN
    RAISE EXCEPTION 'Medicare OH 99350 by quarter came from the wrong file(s): %', got;
  END IF;
END $$;

\echo ''
\echo 'RULES ON DATE OF SERVICE OK'
