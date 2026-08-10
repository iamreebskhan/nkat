-- ============================================================================
-- 0071_rule_data_quality.sql
--
-- Retire four hand-inserted rules that answer nothing.
--
-- WHAT THEY ARE
-- Four live Anthem BCBS Ohio rows, created_by='seed', whose entire value
-- payload is {"covered": true} — no `answer` key at all. They count as
-- filled cells in every coverage report and return nothing readable to a
-- biller. Two of the four also carry no source_quote, so there is nothing
-- to take to the payer on appeal.
--
--   99348 covered            no answer, no quote
--   99349 covered            no answer
--   99350 covered            no answer
--   99350 telehealth_allowed no answer, no quote
--
-- They trace to a source_document at https://example.test/... — a
-- placeholder, not a payer publication. The library's rule is that
-- nothing lives without a verbatim quote from a real document, and a
-- citation cannot be invented, so they are expired rather than patched.
--
-- WHAT THIS COSTS, STATED PLAINLY
-- Expiring them leaves those four (payer, code, attribute) keys with no
-- live rule, so Anthem Ohio 99348/99349/99350 coverage and 99350
-- telehealth become Unknown rather than a confident answer nobody can
-- source. That is the correct trade — an unsourced "covered" on a screen
-- a practice bills from is worse than an honest Unknown — but it is a
-- reduction in apparent coverage and should not arrive as a surprise.
--
-- WHAT THIS MIGRATION NO LONGER DOES, AND WHY
-- It originally also relabelled `rateBasis` on 1,331 rows and repaired
-- conditional coverage badges on 53. Both were undone by the very next
-- seed replay, because migrations run once while seeds re-apply whenever
-- their content changes — so data a seed produces must be fixed in that
-- seed. Both are now corrected at source, in
-- payer-rules-fee-schedules-full.sql and payer-rules-denial-attributes.sql,
-- and the sections are gone from here rather than left to fight the seeds
-- on every deploy.
--
-- Reversible: pre-images journaled. Idempotent: a second run finds
-- nothing live to expire.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0071_unreadable_rules_journal (
  rule_id          UUID PRIMARY KEY,
  prior_expiration DATE,
  journaled_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No foreign key to payer_rule. A journal holds pre-images and must
-- outlive the row it describes; an FK here blocks any later seed from
-- replacing its own rules, which is exactly how migration 0070's journal
-- broke payer-rules-cy2026-full-rule.sql.
ALTER TABLE migration_0071_unreadable_rules_journal
  DROP CONSTRAINT IF EXISTS migration_0071_unreadable_rules_journal_rule_id_fkey;

COMMENT ON TABLE migration_0071_unreadable_rules_journal IS
  'Pre-images of rules expired by migration 0071 for having no readable '
  'answer. To undo: UPDATE payer_rule p SET expiration_date = '
  'j.prior_expiration FROM migration_0071_unreadable_rules_journal j '
  'WHERE p.id = j.rule_id.';

CREATE TEMP TABLE _unreadable ON COMMIT DROP AS
SELECT id, expiration_date
  FROM payer_rule
 WHERE effective_date <= CURRENT_DATE
   AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
   -- No readable answer. This is the defect; the missing quote on two of
   -- them is a consequence of the same hand insertion.
   AND coalesce(btrim(value->>'answer'), '') = ''
   -- Scoped to hand-inserted rows. An extraction with no answer would be
   -- a pipeline bug to fix at source, not a row to quietly retire.
   AND created_by = 'seed';

-- A fuse. If this ever matches far more than the four known rows, the
-- predicate has caught something it was not meant to and the migration
-- must stop rather than mass-expire the library.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM _unreadable;
  IF n > 10 THEN
    RAISE EXCEPTION 'migration 0071: % rules match the unreadable-answer predicate, expected at most 10. Refusing to expire that many.', n;
  END IF;
END $$;

INSERT INTO migration_0071_unreadable_rules_journal (rule_id, prior_expiration)
SELECT id, expiration_date FROM _unreadable
ON CONFLICT (rule_id) DO NOTHING;

UPDATE payer_rule p
   SET expiration_date = CURRENT_DATE
  FROM _unreadable u
 WHERE p.id = u.id;

-- ---------------------------------------------------------------------
-- Prove it. Only properties this migration is responsible for — nothing
-- that re-validates a journal row a later migration may legitimately
-- have touched, which is how the previous version of this file came to
-- fail on its own history.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_expired INT;
  n_left    INT;
BEGIN
  SELECT count(*) INTO n_expired FROM _unreadable;

  SELECT count(*) INTO n_left
    FROM payer_rule
   WHERE effective_date <= CURRENT_DATE
     AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     AND coalesce(btrim(value->>'answer'), '') = ''
     AND created_by = 'seed';
  IF n_left <> 0 THEN
    RAISE EXCEPTION 'migration 0071: % hand-inserted rule(s) with no readable answer are still live', n_left;
  END IF;

  -- Nothing outside the targeted set may have been expired.
  IF EXISTS (
    SELECT 1 FROM migration_0071_unreadable_rules_journal j
      JOIN payer_rule p ON p.id = j.rule_id
     WHERE coalesce(btrim(p.value->>'answer'), '') <> '') THEN
    RAISE EXCEPTION 'migration 0071: a rule WITH an answer was expired — refusing.';
  END IF;

  RAISE NOTICE 'migration 0071:';
  RAISE NOTICE '  unreadable hand-inserted rules expired : %', n_expired;
  RAISE NOTICE '  still live with no answer             : 0';
  RAISE NOTICE '  NOTE: Anthem Ohio 99348/99349/99350 coverage and 99350 telehealth';
  RAISE NOTICE '        now answer Unknown. That is intended — see the header.';
END $$;

COMMIT;
