-- ===========================================================================
-- 0082 — Withdraw rules extracted from a TEST FIXTURE, and put back the
--        real ones they displaced.
--
-- WHAT HAPPENED, PLAINLY: I did this. While verifying the ingestion fix in
-- 42265f8 I registered an ingestion source pointing at
--
--   https://app.pallio.io/test-fixtures/medicare-final-rule-2026.pdf
--
-- and gave it a REAL payer (Traditional Medicare Part B) and a real state
-- (OH), because that is what the existing TEST source was configured with.
-- Running it did exactly what ingestion is supposed to do: it expired the
-- live rule on each key and inserted its own. 19 rules written, 10 of which
-- displaced seeded rules whose citations had been verified against the actual
-- Federal Register document.
--
-- So Traditional Medicare's answer for 99497 in Ohio now cites a file on our
-- own domain with a cache-busting query string on it. The answer text is not
-- obviously wrong, which is what makes it dangerous: a biller clicking the
-- citation lands on a fixture, and the weekly drift check would happily
-- verify the rule against it forever. A rule is only as good as the document
-- it points at.
--
-- THE REPAIR, IN THE ORDER IT HAS TO HAPPEN
--   1. Find every source_document whose url contains /test-fixtures/.
--   2. Revive the rule each fixture-derived rule displaced — same key, expired
--      on the same day, authored by a seed or extraction run rather than a
--      person. This is the 0076 pattern: only ever revive pipeline-authored
--      rules, never something hand-typed.
--   3. Only then expire the fixture rules, by setting expiration_date to their
--      own effective_date so they read as never having been live.
--   4. Assert no key is left dark and no live rule cites a fixture.
--
-- The ZZTEST ingestion source is deleted too, so tonight's verification cannot
-- fire again from cron. The pre-existing "TEST — Medicare Final Rule" source
-- is left alone but DEACTIVATED: it is someone's fixture, not mine to remove,
-- and now that the write path actually works it would do this again on its
-- next scheduled run.
-- ===========================================================================

BEGIN;

-- 1. The fixture documents.
CREATE TEMP TABLE _fixture_docs ON COMMIT DROP AS
SELECT id, url FROM source_document WHERE url LIKE '%/test-fixtures/%';

-- Rules that came from them and are currently live.
CREATE TEMP TABLE _fixture_rules ON COMMIT DROP AS
SELECT pr.id, pr.payer_id, pr.state, pr.code, pr.attribute, pr.product_line,
       pr.effective_date
  FROM payer_rule pr
  JOIN _fixture_docs f ON f.id = pr.source_doc_id
 WHERE pr.expiration_date IS NULL;

-- 2. For each, the pipeline-authored rule it displaced: same key, expired on
--    or after the fixture rule's effective date, most recent first.
-- MATCHED ON (payer, state, code, attribute) AND NOTHING ELSE, because that
-- is the exact key the ingestion's own expire statement uses:
--
--   UPDATE payer_rule SET expiration_date = CURRENT_DATE
--    WHERE payer_id = .. AND state = .. AND code = .. AND attribute = ..
--
-- My first attempt also matched product_line and found zero rows, because the
-- ingestion INSERT hardcodes product_line = 'commercial' for every payer —
-- Traditional Medicare included. So it expired a medicare-line rule and
-- inserted a commercial-line one on the same key, and a product_line-aware
-- join could never pair them back up. Matching what the damage matched is the
-- only thing that undoes it.
--
-- The author guard is now "not a person" rather than a whitelist of prefixes:
-- an email in created_by means a human typed it, and those are never revived
-- automatically. That is the same test expire-ungrounded-rules.sql uses.
CREATE TEMP TABLE _revive ON COMMIT DROP AS
SELECT DISTINCT ON (fr.id) fr.id AS fixture_rule_id, prev.id AS revive_id
  FROM _fixture_rules fr
  JOIN payer_rule prev
    ON prev.payer_id = fr.payer_id
   AND prev.state = fr.state
   AND prev.code = fr.code
   AND prev.attribute = fr.attribute
   AND prev.id <> fr.id
   AND prev.expiration_date IS NOT NULL
   AND prev.expiration_date >= fr.effective_date
   AND prev.created_by NOT LIKE '%@%'
  LEFT JOIN _fixture_docs fd ON fd.id = prev.source_doc_id
 WHERE fd.id IS NULL                       -- never revive another fixture rule
 ORDER BY fr.id, prev.expiration_date DESC, prev.confidence DESC NULLS LAST;

UPDATE payer_rule SET expiration_date = NULL
 WHERE id IN (SELECT revive_id FROM _revive);

-- 3. Withdraw the fixture rules — effective_date, so they never read as live.
UPDATE payer_rule pr
   SET expiration_date = pr.effective_date
  FROM _fixture_rules fr
 WHERE pr.id = fr.id;

-- 4. Remove the source I created; deactivate the pre-existing fixture source
--    so the now-working pipeline does not repeat this on its next run.
DELETE FROM ingestion_source WHERE url LIKE '%/test-fixtures/%' AND name LIKE 'ZZTEST%';
UPDATE ingestion_source SET active = FALSE
 WHERE url LIKE '%/test-fixtures/%';

DO $$
DECLARE
  n_fixture INT;
  n_revived INT;
  still_live INT;
  dark TEXT;
BEGIN
  SELECT count(*) INTO n_fixture FROM _fixture_rules;
  SELECT count(*) INTO n_revived FROM _revive;

  SELECT count(*) INTO still_live
    FROM payer_rule pr JOIN _fixture_docs f ON f.id = pr.source_doc_id
   WHERE pr.expiration_date IS NULL;
  IF still_live > 0 THEN
    RAISE EXCEPTION 'still % live rule(s) citing a test fixture', still_live;
  END IF;

  -- A key must still answer IF IT ANSWERED BEFORE. Most of what the fixture
  -- wrote landed on keys that had no rule at all — 98016, 99453, 99454,
  -- 99457 and the rest are remote-monitoring codes this library never
  -- covered — and demanding those answer after the withdrawal was the wrong
  -- test: it asked the repair to invent rules the fixture had invented.
  -- Restoring displaced rules is the job; leaving a never-covered key
  -- uncovered is correct.
  SELECT string_agg(DISTINCT fr.code || '/' || fr.attribute, ', ') INTO dark
    FROM _fixture_rules fr
    JOIN _revive rv ON rv.fixture_rule_id = fr.id      -- only keys we displaced
   WHERE NOT EXISTS (
     SELECT 1 FROM payer_rule live
      WHERE live.payer_id = fr.payer_id AND live.state = fr.state
        AND live.code = fr.code AND live.attribute = fr.attribute
        AND live.expiration_date IS NULL
   );
  IF dark IS NOT NULL THEN
    RAISE EXCEPTION 'displaced keys left with no live rule: %', dark;
  END IF;

  RAISE NOTICE 'fixture rules withdrawn: %, displaced rules revived: %, '
               'fixture-only keys left uncovered (correct): %',
    n_fixture, n_revived, n_fixture - n_revived;
END $$;

COMMIT;
