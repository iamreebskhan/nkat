-- ============================================================================
-- 0009_rulebook_uploads_repair.sql
-- Rulebook rows written by the upload merge and the editor before the 5 Nov
-- 2026 fixes are brought to what the fixes write (migration 0131), and every
-- other row is left exactly as it was.
--
-- WHY IT EXISTS. "Use Pallio" stored Pallio's rule as the practice's own, a
-- frozen copy answering every date; a file's 'prior_auth' was stored under
-- that name and never answered a lookup; an edited payer call kept the call's
-- expiry and link. Production held 90 uploaded rows, 9 under short names.
-- This file builds one row of each kind, as the old code wrote it, and runs
-- app.repair_rulebook_uploads() on 15 Aug 2026, when the July CMS file answers.
--
-- It WRITES: a throwaway practice, its rulebook, fourteen rows, an attestation,
-- their journal entries and two library rules on codes no seed writes, all
-- removed at the end. It attests as the seeded test admin (0017_test_users.sql).
-- Run it only against a database built for the test, as CI does.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '== rulebook upload repair: setup =='

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'setup: the seeded test admin (0017_test_users.sql) is missing';
  END IF;
END $$;

INSERT INTO org (id, name, slug, plan_tier)
VALUES ('c2026131-0000-4000-8000-000000000001', 'Rulebook upload repair test', 'rulebook-upload-repair-test', 'org')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO org_rulebook (id, org_id, origin)
VALUES ('c2026131-0000-4000-8000-000000000002', 'c2026131-0000-4000-8000-000000000001', 'uploaded')
ON CONFLICT (org_id) DO NOTHING;

-- Library rules on codes no seed writes, both answer-only, as the CMS fee
-- schedule crawler writes most of its rules: X9997 covered, and an X9994
-- prior-auth rule whose text a practice's file repeats word for word.
INSERT INTO payer_rule (id, payer_id, state, product_line, code, attribute, value, coverage_status,
                        confidence, effective_date, expiration_date, source_doc_id, source_quote, created_by)
VALUES ('c2026131-0000-4000-8000-0000000000b7', 'a0000000-0000-4000-8000-000000000401', 'OH', 'medicare_ffs',
        'X9997', 'covered', '{"answer": "Covered under the test schedule."}', 'covered', 0.95,
        DATE '2026-01-01', NULL, '5c5772ec-2213-4658-b32e-b5e9332dca0e', 'The test schedule covers it.', 'db/test/0009'),
       ('c2026131-0000-4000-8000-0000000000b8', 'a0000000-0000-4000-8000-000000000401', 'OH', 'medicare_ffs',
        'X9994', 'prior_auth_required', '{"answer": "No prior authorization."}', 'not_covered', 0.80,
        DATE '2026-01-01', NULL, '5c5772ec-2213-4658-b32e-b5e9332dca0e', 'No prior authorization.', 'db/test/0009');

-- Medicare's 99350 and 99341 in Ohio, from the January and July CMS files (as 0008 finds them).
CREATE TEMP TABLE _rule AS
SELECT
  (SELECT id FROM payer_rule
    WHERE source_doc_id = '2b1d7f30-26a0-4c6e-9a1f-26a000000001'::uuid
      AND payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
      AND state = 'OH' AND code = '99350' AND attribute = 'covered'
      AND (expiration_date IS NULL OR expiration_date > effective_date)) AS jan_99350,
  (SELECT id FROM payer_rule
    WHERE source_doc_id = '5c5772ec-2213-4658-b32e-b5e9332dca0e'::uuid
      AND payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
      AND state = 'OH' AND code = '99350' AND attribute = 'covered'
      AND (expiration_date IS NULL OR expiration_date > effective_date)) AS jul_99350,
  (SELECT id FROM payer_rule
    WHERE source_doc_id = '5c5772ec-2213-4658-b32e-b5e9332dca0e'::uuid
      AND payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
      AND state = 'OH' AND code = '99341' AND attribute = 'covered'
      AND (expiration_date IS NULL OR expiration_date > effective_date)) AS jul_99341;

DO $$
DECLARE k RECORD;
BEGIN
  SELECT * INTO k FROM _rule;
  IF k.jan_99350 IS NULL OR k.jul_99350 IS NULL OR k.jul_99341 IS NULL THEN
    RAISE EXCEPTION 'setup: a rule this test copies is missing: %', row_to_json(k);
  END IF;
END $$;

-- The payer call one edit started from.
INSERT INTO analyst_attestation (id, org_id, payer_id, state, cpt_code, attribute, rule_value, coverage_status,
                                 payer_rep_name, call_date, expires_at, attested_by_user_id)
VALUES ('c2026131-0000-4000-8000-0000000000a0', 'c2026131-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000401', 'OH', '99344', 'covered', '{"note": "Rep said covered."}', 'covered',
        'Test rep', DATE '2026-08-01', DATE '2026-10-30', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

-- Picks of Pallio's rule, as the old merge stored them: the page's values,
-- origin 'org_upload', the column's 0.5, no rule, no quote.
--   a1: January's 99350 rule, rate and figures (keys a file never has).
--   a2: the answer-only X9997 rule, word for word.
--   a3: a library value on a code the library holds no rule for.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence)
SELECT 'c2026131-0000-4000-8000-0000000000a1', 'c2026131-0000-4000-8000-000000000001',
       'c2026131-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'org_upload', 0.50
  FROM payer_rule pr WHERE pr.id = (SELECT jan_99350 FROM _rule);
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence)
SELECT 'c2026131-0000-4000-8000-0000000000a3', 'c2026131-0000-4000-8000-000000000001',
       'c2026131-0000-4000-8000-000000000002', pr.payer_id, pr.state, 'X9996', pr.attribute,
       pr.value, pr.coverage_status, 'org_upload', 0.50
  FROM payer_rule pr WHERE pr.id = (SELECT jan_99350 FROM _rule);

-- A file's own rows ("Keep mine" was the only choice they were shown):
--   c1, c2: under the library's name, at most an answer: the practice's.
--   b1: 'prior_auth', nothing else in the rulebook for that rule: renamed.
--   b2: 'telehealth' beside b3, a pick of Pallio's rule under
--       'telehealth_allowed' for the same code, both from one merge: left.
--   b4: a short name with no payer: answers nothing, left.
--   b5: 'prior_auth' on X9994, word for word the library's rule: renamed, and
--       still the practice's own on a second run.
-- e1: a payer call edited by hand, as the old editor left it: still holding
--     the call's expiry and link. e2: the payer call itself. e3: an edit with
--     neither.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_quote,
                              expires_at, source_attestation_id)
VALUES
  ('c2026131-0000-4000-8000-0000000000a2', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', 'X9997', 'covered',
   '{"answer": "Covered under the test schedule."}', 'covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000c1', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99348', 'covered',
   '{"answer": "Per our own rulebook."}', 'not_covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000c2', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99347', 'covered', '{}', 'unknown', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000b1', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99349', 'prior_auth',
   '{"answer": "PA on file."}', 'covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000b2', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', 'X9995', 'telehealth',
   '{"answer": "Video allowed."}', 'covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000b3', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', 'X9995', 'telehealth_allowed',
   '{"answer": "Pallio says varies.", "mappedFrom": "telehealth"}', 'varies', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000b4', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   NULL, 'OH', '99349', 'documentation', '{"answer": "Notes required."}', 'covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000b5', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', 'X9994', 'prior_auth',
   '{"answer": "No prior authorization."}', 'not_covered', 'org_upload', 0.50, NULL, NULL, NULL),
  ('c2026131-0000-4000-8000-0000000000e1', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99344', 'covered', '{"notes": "Confirmed again."}', 'covered',
   'org_override', 0.60, 'Rep said covered.', TIMESTAMPTZ '2026-10-30 04:00+00', 'c2026131-0000-4000-8000-0000000000a0'),
  ('c2026131-0000-4000-8000-0000000000e2', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99345', 'covered', '{"note": "Rep said covered."}', 'covered',
   'analyst', 0.60, 'Rep said covered.', TIMESTAMPTZ '2026-10-30 04:00+00', 'c2026131-0000-4000-8000-0000000000a0'),
  ('c2026131-0000-4000-8000-0000000000e3', 'c2026131-0000-4000-8000-000000000001', 'c2026131-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99342', 'covered', '{"notes": "Our contract."}', 'covered',
   'org_override', 0.95, NULL, NULL, NULL);

-- f1: a library copy, as generation writes one.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_payer_rule_id, source_quote)
SELECT 'c2026131-0000-4000-8000-0000000000f1', 'c2026131-0000-4000-8000-000000000001',
       'c2026131-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'source', pr.confidence, pr.id, pr.source_quote
  FROM payer_rule pr WHERE pr.id = (SELECT jul_99341 FROM _rule);

CREATE TEMP TABLE _before AS
SELECT id, to_jsonb(r) AS row FROM org_rulebook_row r
 WHERE org_id = 'c2026131-0000-4000-8000-000000000001';

\echo '== what each row should become =='

DO $$
DECLARE got TEXT;
BEGIN
  SELECT string_agg(right(row_id::text, 2) || '=' || action, ' ' ORDER BY row_id) INTO got
    FROM app.rulebook_upload_repairs(DATE '2026-08-15')
   WHERE org_id = 'c2026131-0000-4000-8000-000000000001';
  -- c1, c2, b4, e2, e3 and f1 are not listed: nothing to repair.
  IF got IS DISTINCT FROM 'a1=to_library a2=to_library a3=to_library b1=renamed b2=left_short b3=to_library b5=renamed e1=detached' THEN
    RAISE EXCEPTION 'repairs on 15 Aug 2026: %', got;
  END IF;
END $$;

\echo '== repair =='

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM app.repair_rulebook_uploads(DATE '2026-08-15');
  -- Counts span every practice in the database; this one contributes 2/2/2/1/1.
  IF r.to_library < 2 OR r.now_gaps < 2 OR r.renamed < 2 OR r.left_short < 1 OR r.detached < 1 THEN
    RAISE EXCEPTION 'the repair counted too little: %', row_to_json(r);
  END IF;
END $$;

DO $$
DECLARE
  k RECORD;
  x org_rulebook_row;
  pr payer_rule;
  changed TEXT;
  n INT;
BEGIN
  SELECT * INTO k FROM _rule;

  -- a1, the January pick, now holds July's rule whole, as a library copy.
  SELECT * INTO x FROM org_rulebook_row WHERE id = 'c2026131-0000-4000-8000-0000000000a1';
  SELECT * INTO pr FROM payer_rule WHERE id = k.jul_99350;
  IF x.origin <> 'source' OR x.source_payer_rule_id IS DISTINCT FROM pr.id OR x.rule_value IS DISTINCT FROM pr.value
     OR x.coverage_status IS DISTINCT FROM pr.coverage_status OR x.confidence IS DISTINCT FROM pr.confidence
     OR x.source_quote IS DISTINCT FROM pr.source_quote THEN
    RAISE EXCEPTION 'the January pick is not a copy of July''s rule: %', row_to_json(x);
  END IF;

  -- a2, the word-for-word pick, is a copy of X9997.
  SELECT * INTO x FROM org_rulebook_row WHERE id = 'c2026131-0000-4000-8000-0000000000a2';
  IF x.origin <> 'source' OR x.source_payer_rule_id IS DISTINCT FROM 'c2026131-0000-4000-8000-0000000000b7'::uuid
     OR x.confidence <> 0.95 OR x.source_quote IS DISTINCT FROM 'The test schedule covers it.' THEN
    RAISE EXCEPTION 'the word-for-word pick is not a copy of its rule: %', row_to_json(x);
  END IF;

  -- a3 and b3, picks with no rule today, are the gap generation writes.
  SELECT count(*) INTO n FROM org_rulebook_row
   WHERE id IN ('c2026131-0000-4000-8000-0000000000a3', 'c2026131-0000-4000-8000-0000000000b3')
     AND origin = 'source' AND coverage_status = 'unknown' AND rule_value = '{}'::jsonb AND confidence = 0
     AND source_quote IS NULL AND source_payer_rule_id IS NULL;
  IF n <> 2 THEN
    RAISE EXCEPTION 'the picks with no rule are not gaps (% of 2)', n;
  END IF;

  -- b1 and b5 answer under the library's name, still the practice's, as they were.
  SELECT count(*) INTO n FROM org_rulebook_row r JOIN _before b ON b.id = r.id
   WHERE r.id IN ('c2026131-0000-4000-8000-0000000000b1', 'c2026131-0000-4000-8000-0000000000b5')
     AND r.attribute = 'prior_auth_required' AND r.origin = 'org_upload'
     AND r.rule_value = (b.row->'rule_value') AND r.coverage_status = b.row->>'coverage_status';
  IF n <> 2 THEN
    RAISE EXCEPTION 'the short-named rows were not renamed as they were (% of 2)', n;
  END IF;

  -- e1, the edited payer call, keeps everything but the call's expiry and link.
  SELECT * INTO x FROM org_rulebook_row WHERE id = 'c2026131-0000-4000-8000-0000000000e1';
  IF x.expires_at IS NOT NULL OR x.source_attestation_id IS NOT NULL OR x.origin <> 'org_override'
     OR x.rule_value <> '{"notes": "Confirmed again."}'::jsonb OR x.coverage_status <> 'covered' THEN
    RAISE EXCEPTION 'the edited payer call: %', row_to_json(x);
  END IF;

  -- Every other row exactly as it was.
  SELECT string_agg(right(r.id::text, 2), ' ' ORDER BY r.id) INTO changed
    FROM org_rulebook_row r JOIN _before b ON b.id = r.id
   WHERE right(r.id::text, 2) IN ('c1', 'c2', 'b2', 'b4', 'e2', 'e3', 'f1')
     AND to_jsonb(r) IS DISTINCT FROM b.row;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'rows that must not be touched were: %', changed;
  END IF;

  -- The journal holds the seven rewritten rows whole, as they were.
  SELECT count(*) INTO n FROM rulebook_mirror_journal j
    JOIN _before b ON b.id = j.rulebook_row_id
   WHERE j.org_id = 'c2026131-0000-4000-8000-000000000001'
     AND j.before_row = b.row
     AND (   (right(j.rulebook_row_id::text, 2) = 'a1' AND j.action = 'to_library' AND j.new_rule_id = k.jul_99350)
          OR (right(j.rulebook_row_id::text, 2) = 'a2' AND j.action = 'to_library'
              AND j.new_rule_id = 'c2026131-0000-4000-8000-0000000000b7'::uuid)
          OR (right(j.rulebook_row_id::text, 2) IN ('a3', 'b3') AND j.action = 'to_library' AND j.new_rule_id IS NULL)
          OR (right(j.rulebook_row_id::text, 2) IN ('b1', 'b5') AND j.action = 'renamed')
          OR (right(j.rulebook_row_id::text, 2) = 'e1' AND j.action = 'detached'));
  IF n <> 7 OR (SELECT count(*) FROM rulebook_mirror_journal
                 WHERE org_id = 'c2026131-0000-4000-8000-000000000001') <> 7 THEN
    RAISE EXCEPTION 'the journal does not hold exactly the seven rewritten rows as they were (% of 7 match)', n;
  END IF;
END $$;

\echo '== a second run changes nothing =='

DO $$
DECLARE
  r RECORD;
  got TEXT;
BEGIN
  SELECT * INTO r FROM app.repair_rulebook_uploads(DATE '2026-08-15');
  IF r.to_library <> 0 OR r.now_gaps <> 0 OR r.renamed <> 0 OR r.detached <> 0 THEN
    RAISE EXCEPTION 'a second run repaired more: %', row_to_json(r);
  END IF;
  IF (SELECT count(*) FROM rulebook_mirror_journal WHERE org_id = 'c2026131-0000-4000-8000-000000000001') <> 7 THEN
    RAISE EXCEPTION 'a second run journalled more rows';
  END IF;
  -- b5, now under the library's name and word for word its rule, is still a file's row.
  SELECT string_agg(right(row_id::text, 2) || '=' || action, ' ' ORDER BY row_id) INTO got
    FROM app.rulebook_upload_repairs(DATE '2026-08-15')
   WHERE org_id = 'c2026131-0000-4000-8000-000000000001';
  IF got IS DISTINCT FROM 'b2=left_short' THEN
    RAISE EXCEPTION 'after the repair: %', got;
  END IF;
END $$;

\echo '== only the deploy may run it =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
     AND (   has_function_privilege('app', 'app.repair_rulebook_uploads(date)', 'EXECUTE')
          OR has_function_privilege('app', 'app.rulebook_upload_repairs(date)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'the app role can run the rulebook upload repair';
  END IF;
END $$;

\echo '== cleanup =='
DELETE FROM rulebook_mirror_journal WHERE org_id = 'c2026131-0000-4000-8000-000000000001';
DELETE FROM org_rulebook_row WHERE org_id = 'c2026131-0000-4000-8000-000000000001';
DELETE FROM org_rulebook WHERE id = 'c2026131-0000-4000-8000-000000000002';
DELETE FROM analyst_attestation WHERE id = 'c2026131-0000-4000-8000-0000000000a0';
DELETE FROM org WHERE id = 'c2026131-0000-4000-8000-000000000001';
DELETE FROM payer_rule WHERE id IN ('c2026131-0000-4000-8000-0000000000b7', 'c2026131-0000-4000-8000-0000000000b8');
DROP TABLE _before;
DROP TABLE _rule;

\echo ''
\echo 'RULEBOOK UPLOAD REPAIR OK'
