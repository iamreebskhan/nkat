-- ============================================================================
-- 0074_purge_delisted_seed_rows.sql
--
-- Removes the rows left behind by db/seed/payer-rules-oh-appendixdd-delisted
-- .sql, a seed of mine that was wrong and has been deleted from the repo.
--
-- WHY DELETING THE SEED WAS NOT ENOUGH
-- Deleting a seed file stops it RE-RUNNING. It does not remove rows it has
-- already inserted. That seed ran on production in an earlier deploy and put
-- 150 rows in payer_rule; two deploys later, 145 of them were still being
-- served and G0318 read 'unknown' for all five Ohio plans — from a claim that
-- Ohio had deleted the code, which it had not.
--
-- I had removed the same rows from my own database by hand. A hand-delete is
-- not a committed artifact, so it fixed nothing anywhere else. This migration
-- is that delete, written down.
--
-- WHY THE VERIFY SUITE DID NOT CATCH IT
-- It cannot. verify-production asserts exactly one live rule per key, and
-- there was exactly one — the wrong one. Every guard passed 25/25 while the
-- library served 'unknown' for a code with a valid 'covered' determination.
-- That is the same shape as the seven hand-typed rules: well-formed, unique,
-- internally consistent, untrue.
--
-- WHAT IT DOES
--   1. Records every (payer, state, code, attribute, product_line) key the bad
--      rows occupy, so the repair can be checked against it afterwards.
--   2. Deletes the bad rows.
--   3. Restores the rule the seed displaced. close-rule-timelines.sql resolved
--      the resulting duplicates by expiring the ORIGINAL — correctly, given
--      what it was told — so on most keys the real determination is sitting
--      expired. For each key left with nothing live, the most recent
--      non-delisted rule is returned to service: latest effective_date first,
--      then the one expired most recently.
--
-- Journalled whole before deletion. Idempotent: a second run finds no rows.
-- Asserts afterwards that no key gained a second live rule and that no
-- affected key was left unanswered.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0074_purge_journal (
  id           BIGSERIAL PRIMARY KEY,
  rule_id      UUID NOT NULL,
  rule_row     JSONB NOT NULL,
  purged_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0074_purge_journal IS
  'Whole rows deleted by migration 0074 (the reverted oh-appendixdd-delisted seed). '
  'To undo: INSERT INTO payer_rule SELECT (jsonb_populate_record(NULL::payer_rule, rule_row)).* '
  'FROM migration_0074_purge_journal;';

CREATE TEMP TABLE _bad ON COMMIT DROP AS
SELECT id, payer_id, state, code, attribute, product_line
  FROM payer_rule
 WHERE created_by = 'extract:oh-appendixdd-delisted-2026-08';

INSERT INTO migration_0074_purge_journal (rule_id, rule_row)
SELECT pr.id, to_jsonb(pr)
  FROM payer_rule pr JOIN _bad b ON b.id = pr.id;

CREATE TEMP TABLE _keys ON COMMIT DROP AS
SELECT DISTINCT payer_id, state, code, attribute, product_line FROM _bad;

DELETE FROM payer_rule pr USING _bad b WHERE pr.id = b.id;

-- Bring back the rule the seed displaced, on any key now left with nothing.
CREATE TEMP TABLE _revive ON COMMIT DROP AS
SELECT DISTINCT ON (k.payer_id, k.state, k.code, k.attribute, k.product_line) pr.id
  FROM _keys k
  JOIN payer_rule pr
    ON pr.payer_id IS NOT DISTINCT FROM k.payer_id
   AND pr.state    IS NOT DISTINCT FROM k.state
   AND pr.code = k.code
   AND pr.attribute = k.attribute
   AND pr.product_line IS NOT DISTINCT FROM k.product_line
 WHERE NOT EXISTS (
   SELECT 1 FROM payer_rule live
    WHERE live.payer_id IS NOT DISTINCT FROM k.payer_id
      AND live.state    IS NOT DISTINCT FROM k.state
      AND live.code = k.code
      AND live.attribute = k.attribute
      AND live.product_line IS NOT DISTINCT FROM k.product_line
      AND live.effective_date <= CURRENT_DATE
      AND (live.expiration_date IS NULL OR live.expiration_date > CURRENT_DATE))
 ORDER BY k.payer_id, k.state, k.code, k.attribute, k.product_line,
          pr.effective_date DESC, pr.expiration_date DESC NULLS FIRST, pr.id;

UPDATE payer_rule pr
   SET expiration_date = NULL
  FROM _revive v
 WHERE pr.id = v.id;

DO $$
DECLARE
  n_purged INT; n_revived INT; n_dupes INT; n_left INT;
  n_unanswered INT := 0;
  n_empty INT := 0;
  r RECORD;
BEGIN
  SELECT count(*) INTO n_purged  FROM _bad;
  SELECT count(*) INTO n_revived FROM _revive;

  SELECT count(*) INTO n_left FROM payer_rule
   WHERE created_by = 'extract:oh-appendixdd-delisted-2026-08';
  IF n_left <> 0 THEN
    RAISE EXCEPTION '0074: % row(s) from the reverted seed survived the purge', n_left;
  END IF;

  -- The invariant fetchPayerRule depends on.
  SELECT count(*) INTO n_dupes FROM (
    SELECT payer_id, state, code, attribute, product_line
      FROM payer_rule
     WHERE effective_date <= CURRENT_DATE
       AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1) d;
  IF n_dupes <> 0 THEN
    RAISE EXCEPTION '0074: % key(s) now have more than one live rule', n_dupes;
  END IF;

  -- A key that still HAS a rule sitting under it must end up answering one.
  -- If a candidate exists and nothing is live, the revive step above failed
  -- and the purge has traded a wrong answer for no answer. That is a bug and
  -- the deploy must stop.
  --
  -- A key with NO candidate at all is a different thing and is not an error.
  -- On production there are eight: G0179 and G0180 across Buckeye, CareSource,
  -- Molina and UnitedHealthcare Community Plan. The rules that used to answer
  -- them were never produced by any seed — they came from an uncommitted
  -- extraction run and existed only in a developer database, which is why
  -- migration 0073 restored 8 rows locally and 0 here. Nothing survives to
  -- revive, and db/seed/payer-rules-oh-appendixdd-mco4.sql supplies them
  -- properly at deploy step 6, one step after this migration.
  --
  -- The distinction is the whole assertion, so it names every key it finds.
  -- The first version of this file counted them and named none: it reported
  -- "8 key(s) left with no live rule" on production, passed locally, and gave
  -- no way to tell a broken revive from a legitimately empty key. Diagnosing
  -- that cost a deploy and a round trip.
  FOR r IN
    SELECT p.name AS payer, k.code, k.attribute, k.product_line,
           (SELECT count(*) FROM payer_rule o
             WHERE o.payer_id IS NOT DISTINCT FROM k.payer_id
               AND o.state    IS NOT DISTINCT FROM k.state
               AND o.code = k.code AND o.attribute = k.attribute
               AND o.product_line IS NOT DISTINCT FROM k.product_line) AS candidates
      FROM _keys k JOIN payer p ON p.id = k.payer_id
     WHERE NOT EXISTS (
       SELECT 1 FROM payer_rule live
        WHERE live.payer_id IS NOT DISTINCT FROM k.payer_id
          AND live.state    IS NOT DISTINCT FROM k.state
          AND live.code = k.code
          AND live.attribute = k.attribute
          AND live.product_line IS NOT DISTINCT FROM k.product_line
          AND live.effective_date <= CURRENT_DATE
          AND (live.expiration_date IS NULL OR live.expiration_date > CURRENT_DATE))
     ORDER BY 1, 2
  LOOP
    IF r.candidates > 0 THEN
      n_unanswered := n_unanswered + 1;
      RAISE NOTICE '0074: REVIVE FAILED  % / % / %  — % rule(s) exist on this key and none is live',
        r.payer, r.code, coalesce(r.product_line, '-'), r.candidates;
    ELSE
      n_empty := n_empty + 1;
      RAISE NOTICE '0074: no rule ever existed for % / % — a seed must supply it at step 6',
        r.payer, r.code;
    END IF;
  END LOOP;

  IF n_unanswered <> 0 THEN
    RAISE EXCEPTION '0074: % key(s) lost a determination the purge should have restored — see the NOTICE lines above', n_unanswered;
  END IF;

  RAISE NOTICE '0074: % reverted-seed row(s) purged, % displaced rule(s) returned to service', n_purged, n_revived;
  RAISE NOTICE '0074: keys with more than one live rule: 0   revives that failed: 0   keys awaiting a seed: %', n_empty;
END $$;

COMMIT;
