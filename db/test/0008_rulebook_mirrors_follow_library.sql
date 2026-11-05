-- ============================================================================
-- 0008_rulebook_mirrors_follow_library.sql
-- A practice's rulebook rows that nobody edited follow the rule library
-- (migration 0130), and a person's rows are never touched.
--
-- WHY IT EXISTS. On 4 Nov 2026 production's smoke-test practice read G0318 as
-- a "prolonged office" code and CMS quotes cut off mid-sentence, a day after
-- the library had been corrected: its rulebook held copies made before the
-- audit, and nothing brought them up to date. app.refresh_rulebook_mirrors()
-- does, after every deploy's seeds. This file builds one row of each kind and
-- runs it, on 15 Aug 2026 so that the July CMS file answers.
--
-- It WRITES: a throwaway practice, its rulebook, eight rows, their journal
-- entries and one withdrawn library rule, all removed at the end. Run it only
-- against a database built for the test, as CI does.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '== rulebook mirrors follow the library: setup =='

INSERT INTO org (id, name, slug, plan_tier)
VALUES ('c2026130-0000-4000-8000-000000000001', 'Rulebook mirror test', 'rulebook-mirror-test', 'org')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO org_rulebook (id, org_id, origin)
VALUES ('c2026130-0000-4000-8000-000000000002', 'c2026130-0000-4000-8000-000000000001', 'generated')
ON CONFLICT (org_id) DO NOTHING;

-- A rule withdrawn the way the audit withdrew 99319: it ends the day it
-- starts, so it answers on no date. Made here, on a code no seed writes,
-- because a database built from scratch never holds the withdrawn rows an
-- upgraded one keeps.
INSERT INTO payer_rule (id, payer_id, state, product_line, code, attribute, value, coverage_status,
                        confidence, effective_date, expiration_date, source_doc_id, source_quote, created_by)
VALUES ('c2026130-0000-4000-8000-0000000000b0', 'a0000000-0000-4000-8000-000000000401', 'OH', 'medicare_ffs',
        'X9998', 'covered', '{"answer": "Covered."}', 'covered', 0.90, DATE '2026-01-01', DATE '2026-01-01',
        '5c5772ec-2213-4658-b32e-b5e9332dca0e', 'A rule since withdrawn.', 'db/test/0008');

-- Medicare's rules in Ohio the rows are built from: 99350 from the January
-- and July CMS files, 99342 and 99341 from July, and the withdrawn rule above.
-- The July file also left a withdrawn duplicate of each code (effective and
-- expiring the same day) in an upgraded database; the live rule is the one
-- with a window.
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
      AND state = 'OH' AND code = '99342' AND attribute = 'covered'
      AND (expiration_date IS NULL OR expiration_date > effective_date)) AS jul_99342,
  (SELECT id FROM payer_rule
    WHERE source_doc_id = '5c5772ec-2213-4658-b32e-b5e9332dca0e'::uuid
      AND payer_id = 'a0000000-0000-4000-8000-000000000401'::uuid
      AND state = 'OH' AND code = '99341' AND attribute = 'covered'
      AND (expiration_date IS NULL OR expiration_date > effective_date)) AS jul_99341,
  'c2026130-0000-4000-8000-0000000000b0'::uuid AS withdrawn;

DO $$
DECLARE k RECORD;
BEGIN
  SELECT * INTO k FROM _rule;
  IF k.jan_99350 IS NULL OR k.jul_99350 IS NULL OR k.jul_99342 IS NULL OR k.jul_99341 IS NULL THEN
    RAISE EXCEPTION 'setup: a rule this test copies is missing: %', row_to_json(k);
  END IF;
END $$;

-- A: a copy made from January's rule, holding a quote cut off mid-sentence.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_payer_rule_id, source_quote)
SELECT 'c2026130-0000-4000-8000-00000000000a', 'c2026130-0000-4000-8000-000000000001',
       'c2026130-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'source', pr.confidence, pr.id,
       '99341 through 99350 (codes for evaluation and management'
  FROM payer_rule pr WHERE pr.id = (SELECT jan_99350 FROM _rule);

-- B: a copy of a rule since withdrawn.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_payer_rule_id, source_quote)
SELECT 'c2026130-0000-4000-8000-00000000000b', 'c2026130-0000-4000-8000-000000000001',
       'c2026130-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'source', pr.confidence, pr.id, pr.source_quote
  FROM payer_rule pr WHERE pr.id = (SELECT withdrawn FROM _rule);

-- C, D, E: a person's edit, an uploaded rulebook, an analyst's payer call.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_quote)
VALUES
  ('c2026130-0000-4000-8000-00000000000c', 'c2026130-0000-4000-8000-000000000001', 'c2026130-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99349', 'covered',
   '{"answer": "Our contract: call the plan first."}', 'varies', 'org_override', 0.60, 'Edited by the practice.'),
  ('c2026130-0000-4000-8000-00000000000d', 'c2026130-0000-4000-8000-000000000001', 'c2026130-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99348', 'covered',
   '{"answer": "Per our own rulebook."}', 'not_covered', 'org_upload', 0.50, NULL),
  ('c2026130-0000-4000-8000-00000000000e', 'c2026130-0000-4000-8000-000000000001', 'c2026130-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99347', 'covered',
   '{"answer": "Rep confirmed by phone."}', 'covered', 'analyst', 0.90, 'Rep confirmed on 01/02/2026.');

-- F: an unreviewed AI answer on a key the library answers.
-- G: an unreviewed AI answer on a key it does not (a gap is left alone the same way).
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_quote)
VALUES
  ('c2026130-0000-4000-8000-00000000000f', 'c2026130-0000-4000-8000-000000000001', 'c2026130-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', '99342', 'covered',
   '{"answer": "Probably covered."}', 'varies', 'source', 0.40, 'An AI reading of a payer page.'),
  ('c2026130-0000-4000-8000-000000000010', 'c2026130-0000-4000-8000-000000000001', 'c2026130-0000-4000-8000-000000000002',
   'a0000000-0000-4000-8000-000000000401', 'OH', 'X9999', 'covered',
   '{"answer": "Probably covered."}', 'varies', 'source', 0.40, 'An AI reading of a payer page.');

-- H: a copy that already holds the rule that answers.
INSERT INTO org_rulebook_row (id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
                              rule_value, coverage_status, origin, confidence, source_payer_rule_id, source_quote)
SELECT 'c2026130-0000-4000-8000-000000000011', 'c2026130-0000-4000-8000-000000000001',
       'c2026130-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'source', pr.confidence, pr.id, pr.source_quote
  FROM payer_rule pr WHERE pr.id = (SELECT jul_99341 FROM _rule);

CREATE TEMP TABLE _before AS
SELECT id, to_jsonb(r) AS row FROM org_rulebook_row r
 WHERE org_id = 'c2026130-0000-4000-8000-000000000001';

\echo '== what each row should do =='

DO $$
DECLARE got TEXT;
BEGIN
  SELECT string_agg(right(row_id::text, 2) || '=' || action, ' ' ORDER BY row_id) INTO got
    FROM app.rulebook_mirror_targets(DATE '2026-08-15')
   WHERE org_id = 'c2026130-0000-4000-8000-000000000001';
  -- A follow, B empty, F follow, G none, H current; C, D, E are a person's and not listed.
  IF got IS DISTINCT FROM '0a=follow 0b=empty 0f=follow 10=none 11=current' THEN
    RAISE EXCEPTION 'targets on 15 Aug 2026: %', got;
  END IF;
END $$;

\echo '== refresh =='

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM app.refresh_rulebook_mirrors(DATE '2026-08-15');
  -- Counts span every practice in the database; this one contributes 2/1/1/1.
  IF r.followed < 2 OR r.emptied < 1 OR r.already_current < 1 OR r.unanswered < 1 THEN
    RAISE EXCEPTION 'refresh counted too little: %', row_to_json(r);
  END IF;
END $$;

DO $$
DECLARE
  k RECORD;
  a org_rulebook_row; b org_rulebook_row; f org_rulebook_row;
  pr payer_rule;
  changed TEXT;
  n INT;
BEGIN
  SELECT * INTO k FROM _rule;

  -- A now holds July's rule, quote and all.
  SELECT * INTO a FROM org_rulebook_row WHERE id = 'c2026130-0000-4000-8000-00000000000a';
  SELECT * INTO pr FROM payer_rule WHERE id = k.jul_99350;
  IF a.source_payer_rule_id IS DISTINCT FROM pr.id OR a.rule_value IS DISTINCT FROM pr.value
     OR a.coverage_status IS DISTINCT FROM pr.coverage_status OR a.confidence IS DISTINCT FROM pr.confidence
     OR a.source_quote IS DISTINCT FROM pr.source_quote OR a.origin <> 'source' THEN
    RAISE EXCEPTION 'the stale copy did not follow July''s rule: %', row_to_json(a);
  END IF;

  -- B is a gap, as generateRulebook writes one.
  SELECT * INTO b FROM org_rulebook_row WHERE id = 'c2026130-0000-4000-8000-00000000000b';
  IF b.coverage_status <> 'unknown' OR b.rule_value <> '{}'::jsonb OR b.confidence <> 0
     OR b.source_quote IS NOT NULL OR b.source_payer_rule_id IS NOT NULL THEN
    RAISE EXCEPTION 'the copy of a withdrawn rule still answers something: %', row_to_json(b);
  END IF;

  -- F gave way to the library's rule.
  SELECT * INTO f FROM org_rulebook_row WHERE id = 'c2026130-0000-4000-8000-00000000000f';
  SELECT * INTO pr FROM payer_rule WHERE id = k.jul_99342;
  IF f.source_payer_rule_id IS DISTINCT FROM pr.id OR f.coverage_status IS DISTINCT FROM pr.coverage_status
     OR f.confidence IS DISTINCT FROM pr.confidence THEN
    RAISE EXCEPTION 'the AI answer did not give way to the library''s rule: %', row_to_json(f);
  END IF;

  -- C, D, E (a person's), G (no rule) and H (current) are exactly as they were.
  SELECT string_agg(right(r.id::text, 2), ' ' ORDER BY r.id) INTO changed
    FROM org_rulebook_row r JOIN _before x ON x.id = r.id
   WHERE right(r.id::text, 2) IN ('0c', '0d', '0e', '10', '11')
     AND to_jsonb(r) IS DISTINCT FROM x.row;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'rows that must not be touched were: %', changed;
  END IF;

  -- The journal holds A, B and F whole, as they were.
  SELECT count(*) INTO n FROM rulebook_mirror_journal j
    JOIN _before x ON x.id = j.rulebook_row_id
   WHERE j.org_id = 'c2026130-0000-4000-8000-000000000001'
     AND j.before_row = x.row
     AND (   (right(j.rulebook_row_id::text, 2) = '0a' AND j.action = 'follow' AND j.new_rule_id = k.jul_99350)
          OR (right(j.rulebook_row_id::text, 2) = '0b' AND j.action = 'empty'  AND j.new_rule_id IS NULL)
          OR (right(j.rulebook_row_id::text, 2) = '0f' AND j.action = 'follow' AND j.new_rule_id = k.jul_99342));
  IF n <> 3 OR (SELECT count(*) FROM rulebook_mirror_journal
                 WHERE org_id = 'c2026130-0000-4000-8000-000000000001') <> 3 THEN
    RAISE EXCEPTION 'the journal does not hold exactly A, B and F as they were (% of 3 match)', n;
  END IF;
END $$;

\echo '== a second run changes nothing =='

DO $$
DECLARE n INT;
BEGIN
  PERFORM app.refresh_rulebook_mirrors(DATE '2026-08-15');
  SELECT count(*) INTO n FROM rulebook_mirror_journal
   WHERE org_id = 'c2026130-0000-4000-8000-000000000001';
  IF n <> 3 THEN
    RAISE EXCEPTION 'a second run journalled % more row(s)', n - 3;
  END IF;
  IF EXISTS (SELECT 1 FROM app.rulebook_mirror_targets(DATE '2026-08-15')
              WHERE org_id = 'c2026130-0000-4000-8000-000000000001' AND action IN ('follow', 'empty')) THEN
    RAISE EXCEPTION 'rows still differ from the library after a refresh';
  END IF;
  -- The day decides the rule: on 15 Feb 2026 January's file answers A's key.
  IF NOT EXISTS (SELECT 1 FROM app.rulebook_mirror_targets(DATE '2026-02-15') t, _rule k
                  WHERE t.row_id = 'c2026130-0000-4000-8000-00000000000a'
                    AND t.action = 'follow' AND t.rule_id = k.jan_99350) THEN
    RAISE EXCEPTION 'targets ignore the day they are asked for';
  END IF;
END $$;

\echo '== only the deploy may run it =='

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
     AND (   has_function_privilege('app', 'app.refresh_rulebook_mirrors(date)', 'EXECUTE')
          OR has_function_privilege('app', 'app.rulebook_mirror_targets(date)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'the app role can run the rulebook refresh';
  END IF;
END $$;

\echo '== cleanup =='
DELETE FROM rulebook_mirror_journal WHERE org_id = 'c2026130-0000-4000-8000-000000000001';
DELETE FROM org_rulebook_row WHERE org_id = 'c2026130-0000-4000-8000-000000000001';
DELETE FROM org_rulebook WHERE id = 'c2026130-0000-4000-8000-000000000002';
DELETE FROM org WHERE id = 'c2026130-0000-4000-8000-000000000001';
DELETE FROM payer_rule WHERE id = 'c2026130-0000-4000-8000-0000000000b0';
DROP TABLE _before;
DROP TABLE _rule;

\echo ''
\echo 'RULEBOOK MIRRORS FOLLOW THE LIBRARY OK'
