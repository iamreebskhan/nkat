-- ============================================================================
-- 0004_code_catalog.sql
-- The code catalog must hold one row per code in force, and G0318 must be the
-- code it is. This file reads the database CI just built and asserts what the
-- readers now get from it, through the view the super-bill picker reads.
--
-- WHY IT EXISTS, named concretely. db/seed/0007_palliative_codes.sql seeded
-- HCPCS G0318 as 'Longitudinal palliative care management visit', category
-- 'Palliative E/M', effective 2024-01-01. G0318 is none of those. It is the
-- prolonged home or residence E/M add-on CMS created in the CY2023 physician
-- fee schedule: one unit per full 15 minutes past the CMS total time of
-- 99345/99350, which is the math lib/features/visits/cpt-suggester.ts bills
-- by, and Ohio Medicaid lists it from 01/01/2023. The picker, the superbill
-- list and the rulebook all showed the wrong text, and a search for
-- 'prolonged' in the picker did not find it.
--
-- Moving the date is the dangerous half. The primary key is
-- (code, effective_date) (db/migrations/0002_reference_codes.sql), so a seed
-- that changes only the date in its VALUES inserts a SECOND G0318 row, and
-- every reader that joins code on the code alone (payer_allowed_codes_v in
-- 0069, the rulebook) then lists each G0318 rule twice. 0007 moves the row in
-- place and checks itself on the deploy, where db/test never runs; this file
-- is the same check for CI, docker-compose and db/test.ps1.
--
-- Touches no user data and creates nothing, not even a temp table: every
-- statement is a SELECT inside a DO block, so it runs under
-- default_transaction_read_only = on.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== Code catalog: the palliative ladder and G0318 are present =='

DO $$
DECLARE
  missing text;
BEGIN
  -- POSITIVE CONTROL for everything below. "No code has two rows in force"
  -- is trivially true of an empty code table, and a 0007 that never applied
  -- would pass it.
  SELECT string_agg(v.c, ', ' ORDER BY v.c) INTO missing
    FROM (VALUES ('99341'),('99342'),('99344'),('99345'),
                 ('99347'),('99348'),('99349'),('99350'),
                 ('99497'),('99498'),('G0318')) v(c)
   WHERE NOT EXISTS (SELECT 1 FROM code k WHERE k.code = v.c);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'CODE CATALOG INCOMPLETE: % absent from the code table. db/seed/0007_palliative_codes.sql did not apply, so the checks below would pass vacuously.',
      missing;
  END IF;
END $$;

\echo 'All 11 palliative ladder, ACP and G0318 codes present.'

\echo ''
\echo '== No code has two rows in force, today or one to three years back =='

DO $$
DECLARE
  dupes int;
  worst text;
BEGIN
  -- payer_allowed_codes_v and superbill.service.ts join code at CURRENT_DATE,
  -- so two rows in force on one date double every row they return for that
  -- code. Checked at today and one, two and three years back, so that a row
  -- moved to an earlier date, or an old row a successor forgot to expire, is
  -- caught on the dates a bill or an appeal can still carry.
  SELECT count(*),
         left(string_agg(format('%s on %s (%s rows)', d.code, d.at, d.n), ', ' ORDER BY d.code, d.at), 400)
    INTO dupes, worst
    FROM (
      SELECT c.code, a.at, count(*) AS n
        FROM code c
        CROSS JOIN (VALUES (CURRENT_DATE), (CURRENT_DATE - 365),
                           (CURRENT_DATE - 730), (CURRENT_DATE - 1095)) a(at)
       WHERE c.effective_date <= a.at
         AND (c.expiration_date IS NULL OR c.expiration_date > a.at)
       GROUP BY c.code, a.at
      HAVING count(*) > 1
    ) d;
  IF dupes <> 0 THEN
    RAISE EXCEPTION 'DUPLICATE CODE IN FORCE: % code/date pair(s) have more than one row in force: %. The primary key is (code, effective_date), so a seed that changes only a code''s effective_date inserts a second row instead of moving the first, and payer_allowed_codes_v then lists every rule for that code twice.',
      dupes, worst;
  END IF;
END $$;

\echo 'One row in force per code on each date checked.'

\echo ''
\echo '== G0318 as the picker reads it (payer_allowed_codes_v) =='

DO $$
DECLARE
  n_rows int;
  n_keys int;
  n_bad  int;
  shown  text;
BEGIN
  SELECT count(*), count(DISTINCT (payer_id, state, product_line))
    INTO n_rows, n_keys
    FROM payer_allowed_codes_v
   WHERE code = 'G0318';

  -- Positive control: the checks below read rows, and an empty result says
  -- nothing about whether the descriptor is right.
  IF n_rows < 1 THEN
    RAISE EXCEPTION 'G0318 NOT REACHABLE: payer_allowed_codes_v returns no G0318 row. The view anchors on a live attribute=''covered'' rule and joins code at CURRENT_DATE, so either the rule library did not apply or no G0318 code row is in force today.';
  END IF;

  -- Scoped to G0318 on purpose. A whole-view uniqueness check can fail for
  -- payer_rule reasons 0003 does not cover (it checks live rows only), and
  -- that failure would be blamed on the code catalog. The block above covers
  -- the code-table cause for every code.
  IF n_rows <> n_keys THEN
    RAISE EXCEPTION 'G0318 DOUBLED: payer_allowed_codes_v returns % G0318 row(s) over % (payer, state, product_line) key(s). The view joins code on the code, so two G0318 rows in force list every G0318 rule twice and the picker renders duplicate entries.',
      n_rows, n_keys;
  END IF;

  SELECT count(*), min(descriptor || ' | ' || coalesce(category, '<null>'))
    INTO n_bad, shown
    FROM payer_allowed_codes_v
   WHERE code = 'G0318'
     AND NOT (    descriptor ILIKE '%prolonged%'
              AND descriptor ILIKE '%home%'
              AND descriptor LIKE '%15%'
              AND descriptor NOT ILIKE '%longitudinal%'
              AND descriptor NOT ILIKE '%care management%'
              AND category IS NOT DISTINCT FROM 'Prolonged');
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'G0318 MISDESCRIBED: % of % G0318 row(s) in payer_allowed_codes_v do not describe the prolonged home/residence E/M add-on per 15 min in category Prolonged. Descriptor | category shown: %',
      n_bad, n_rows, shown;
  END IF;
END $$;

\echo 'G0318 reads as the prolonged home add-on, once per payer key.'

\echo ''
\echo '== G0318 is one row, effective 2023-01-01 =='

DO $$
DECLARE
  n_rows int;
  dates  text;
  n_2023 int;
BEGIN
  SELECT count(*), string_agg(to_char(effective_date, 'YYYY-MM-DD'), ', ' ORDER BY effective_date)
    INTO n_rows, dates
    FROM code
   WHERE code = 'G0318';
  IF n_rows <> 1 OR dates <> '2023-01-01' THEN
    RAISE EXCEPTION 'G0318 WRONG ROW: the code table holds % G0318 row(s), effective %; expected exactly one, effective 2023-01-01 (CMS created G0318 in the CY2023 physician fee schedule; Ohio Medicaid lists it from 01/01/2023).',
      n_rows, coalesce(dates, '<none>');
  END IF;

  SELECT count(*) INTO n_2023
    FROM code
   WHERE code = 'G0318'
     AND effective_date <= DATE '2023-01-01'
     AND (expiration_date IS NULL OR expiration_date > DATE '2023-01-01');
  IF n_2023 <> 1 THEN
    RAISE EXCEPTION 'G0318 NOT IN FORCE ON 2023-01-01: % row(s) in force on that date; expected 1.',
      n_2023;
  END IF;
END $$;

\echo ''
\echo 'CODE CATALOG OK'
