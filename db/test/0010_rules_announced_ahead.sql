-- ============================================================================
-- 0010_rules_announced_ahead.sql
-- Rules written now for a later date of service: the CY 2027 Medicare fee
-- schedule and final rule, which answer from 1 January 2027.
--
-- On 31 December 2026 the July 2026 file answers; from 1 January the 2027
-- rows do, with B1 in G2211's place. Then db/maintenance/close-rule-timelines
-- .sql runs, as deploy.sh runs it after every seed: it kept the row in force
-- today and shut every row that began after it, so each rule announced ahead
-- was dead on the deploy that wrote it and from its first day nothing
-- answered. The 2027 rows must come out of it answering.
--
-- Writes: the maintenance step's own repairs and journal (none expected).
-- CI's database only; not for production.
-- ============================================================================

\set ON_ERROR_STOP on

\echo '== What answers on 31 December 2026 and on 15 January 2027 (Medicare, OH)'

CREATE TEMP TABLE announced_expect (code TEXT, attribute TEXT, dos DATE, coverage TEXT, rate TEXT, b1 TEXT, starts TEXT);
INSERT INTO announced_expect VALUES
  ('99350', 'covered',      '2026-12-31', 'covered',     '193.06', NULL,     NULL),
  ('99350', 'covered',      '2027-01-15', 'covered',     '185.66', '204.58', NULL),
  ('G0318', 'covered',      '2026-12-31', 'covered',     '34.07',  NULL,     NULL),
  ('G0318', 'covered',      '2027-01-15', 'covered',     '32.63',  NULL,     NULL),
  ('G2211', 'covered',      '2026-12-31', 'covered',     NULL,     NULL,     'HCPCS G2211'),
  ('G2211', 'covered',      '2027-01-15', 'not_covered', NULL,     NULL,     'Not billed for a date of service from 1 January 2027'),
  ('99350', 'bundled_with', '2026-12-31', 'covered',     NULL,     NULL,     'CPT code 99350'),
  ('99350', 'bundled_with', '2027-01-15', 'covered',     NULL,     NULL,     'From 1 January 2027 the visit complexity add-on is modifier B1'),
  ('G0572', 'covered',      '2027-01-15', 'covered',     '61.99',  NULL,     NULL),
  ('G0398', 'covered',      '2027-01-15', 'not_covered', NULL,     NULL,     NULL);

CREATE OR REPLACE FUNCTION pg_temp.check_announced(label TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
  n INT;
  r RECORD;
BEGIN
  FOR e IN SELECT * FROM announced_expect LOOP
    SELECT count(*) INTO n FROM payer_rule
     WHERE payer_id = 'a0000000-0000-4000-8000-000000000401' AND state = 'OH'
       AND code = e.code AND attribute = e.attribute
       AND effective_date <= e.dos AND (expiration_date IS NULL OR expiration_date > e.dos);
    IF n <> 1 THEN
      RAISE EXCEPTION '% — Medicare OH % / % on %: % rule(s) answer, expected exactly 1.', label, e.code, e.attribute, e.dos, n;
    END IF;
    SELECT coverage_status, value->>'rate' AS rate, value->'modifierRates'->'B1'->>'rate' AS b1, value->>'answer' AS answer
      INTO r FROM payer_rule
     WHERE payer_id = 'a0000000-0000-4000-8000-000000000401' AND state = 'OH'
       AND code = e.code AND attribute = e.attribute
       AND effective_date <= e.dos AND (expiration_date IS NULL OR expiration_date > e.dos);
    IF r.coverage_status <> e.coverage
       OR r.rate IS DISTINCT FROM e.rate
       OR r.b1 IS DISTINCT FROM e.b1
       OR (e.starts IS NOT NULL AND position(e.starts IN r.answer) <> 1) THEN
      RAISE EXCEPTION '% — Medicare OH % / % on %: answers % rate % (B1 %), "%…"; expected % rate % (B1 %), "%…".',
        label, e.code, e.attribute, e.dos, r.coverage_status, r.rate, r.b1, left(r.answer, 60),
        e.coverage, e.rate, e.b1, e.starts;
    END IF;
  END LOOP;
END $$;

SELECT pg_temp.check_announced('as the seeds leave it');

\echo '== Every Medicare fee schedule key answers once on both dates'

DO $$
DECLARE
  gaps INT;
  doubles INT;
BEGIN
  SELECT count(*) FILTER (WHERE n = 0), count(*) FILTER (WHERE n > 1) INTO gaps, doubles FROM (
    SELECT k.state, k.code, d.dos,
           (SELECT count(*) FROM payer_rule pr
             WHERE pr.payer_id = 'a0000000-0000-4000-8000-000000000401' AND pr.state = k.state
               AND pr.code = k.code AND pr.attribute = 'covered'
               AND pr.effective_date <= d.dos AND (pr.expiration_date IS NULL OR pr.expiration_date > d.dos)) AS n
      FROM (SELECT DISTINCT state, code FROM payer_rule
             WHERE created_by = 'extract:pfs-final-rule-2027-11') k
     CROSS JOIN (VALUES (DATE '2026-12-31'), (DATE '2027-01-15')) d(dos)
     -- G0572/G0573 begin in 2027.
     WHERE NOT (k.code IN ('G0572', 'G0573') AND d.dos < DATE '2027-01-01')
  ) x;
  IF gaps <> 0 OR doubles <> 0 THEN
    RAISE EXCEPTION 'Medicare fee schedule keys: % with no rule and % with more than one, on 31 Dec 2026 or 15 Jan 2027.', gaps, doubles;
  END IF;
END $$;

\echo '== The deploy step that closes rule timelines leaves the 2027 rows answering'

CREATE TEMP TABLE announced_before AS
  SELECT count(*) AS n FROM payer_rule
   WHERE effective_date = DATE '2027-01-01' AND (expiration_date IS NULL OR expiration_date > effective_date);

\ir ../maintenance/close-rule-timelines.sql

DO $$
DECLARE
  before_n BIGINT;
  after_n  BIGINT;
BEGIN
  SELECT n INTO before_n FROM announced_before;
  SELECT count(*) INTO after_n FROM payer_rule
   WHERE effective_date = DATE '2027-01-01' AND (expiration_date IS NULL OR expiration_date > effective_date);
  IF before_n < 1137 THEN
    RAISE EXCEPTION 'Only % rows begin on 2027-01-01; the CY 2027 seeds write 1,137. They did not all apply.', before_n;
  END IF;
  IF after_n <> before_n THEN
    RAISE EXCEPTION 'close-rule-timelines.sql shut % of the % rules that begin on 2027-01-01.', before_n - after_n, before_n;
  END IF;
END $$;

SELECT pg_temp.check_announced('after close-rule-timelines.sql');

\echo 'RULES ANNOUNCED AHEAD OK'
