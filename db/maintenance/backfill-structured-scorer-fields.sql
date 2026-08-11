-- ============================================================================
-- backfill-structured-scorer-fields.sql — run AFTER the seeds, with the
-- other post-seed repairs.
--
-- WHY THIS IS NOT (ONLY) A MIGRATION
-- Migration 0070 wrote maxOccurrences/windowDays into payer_rule.value on
-- rows the SEEDS produce. That is the same shape as the bug this codebase
-- has now hit twice:
--
--   migrations run ONCE, tracked by filename in schema_migration;
--   seeds RE-APPLY whenever their content hash changes, and their
--   ON CONFLICT ... DO UPDATE SET value = EXCLUDED.value replaces the
--   whole `value` object.
--
-- So every key a migration added to `value` is dropped the next time that
-- rule's seed runs, and the migration never runs again to restore it. The
-- rules all still exist and still answer, so no row count notices; only
-- the denial scorer notices, by silently losing the structured cap it was
-- meant to score against. 0071 was moved to source for this reason; this
-- is 0070's turn.
--
-- Being here instead means it re-asserts on every deploy, immediately
-- after whatever the seeds just did, and it also makes the library
-- rebuildable: at migration time on a fresh database no rule exists yet,
-- so 0070 matched nothing and aborted the build.
--
-- WHAT IT WRITES
-- Two keys, on frequency_limit rules whose answer text is one of six
-- classifications read by hand. Nothing else in `value` is touched. The
-- classification is pinned by md5 of the answer prose: if a payer rewords
-- its policy, the pin stops matching and this script says so rather than
-- quietly applying a cap to text that no longer says it.
--
-- Idempotent: the UPDATE is guarded on the keys being absent.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE freq_targets (
  answer_md5      TEXT   NOT NULL,
  codes           TEXT[] NOT NULL,
  max_occurrences INT    NOT NULL,
  window_days     INT    NOT NULL
) ON COMMIT DROP;

-- The six classifications, unchanged from migration 0070. See that file for
-- the full reasoning, including what was deliberately NOT encoded (minimum
-- data requirements for 98975/99453, and the MDPP session structure for
-- G9886/G9887/G9871, where the same payer's own modifier rules contemplate
-- a make-up session on the same day).
INSERT INTO freq_targets (answer_md5, codes, max_occurrences, window_days)
VALUES
  -- (a) new-patient home visit, once per 3 years
  ('429bc2c29b0c90bb5a3c4e8b93bddc6d',
   ARRAY['99341','99342','99344','99345'], 1, 1094),
  -- (b) G0179 home health recert, 60-day cycle
  ('db3aeea433c1049f57ffe3e28e7659ae',
   ARRAY['G0179'], 1, 59),
  -- (c) G0136 not more often than every 6 months
  ('c509086bc70958af741199884ca2e817',
   ARRAY['G0136'], 1, 179),
  -- (d) G0447 IBT obesity, at most weekly in every phase
  ('6fd6eb51e8959a13d264fdb24f6153b6',
   ARRAY['G0447'], 1, 6),
  -- (e) G0473 IBT obesity group, at most weekly in every phase
  ('d487207a59b0abe83030d672d72d1520',
   ARRAY['G0473'], 1, 6),
  -- (f) one clinician per code per date of service (add-ons excluded)
  ('eac6fe1204524bbd3308c21647c99716',
   ARRAY['99347','99348','99349','99350','99424','99426','99490','99491',
         '99495','99496','99497','G0179','G0180','G0181','G0318'], 1, 0);

-- "Live" as fetchPayerRule defines it -- the effective window contains
-- today -- NOT `expiration_date IS NULL`.
CREATE TEMP TABLE freq_rows ON COMMIT DROP AS
SELECT pr.id AS rule_id, pr.code, t.max_occurrences, t.window_days
  FROM payer_rule pr
  JOIN freq_targets t
    ON md5(pr.value->>'answer') = t.answer_md5
   AND pr.code = ANY (t.codes)
 WHERE pr.attribute      = 'frequency_limit'
   AND pr.effective_date <= CURRENT_DATE
   AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
   AND pr.superseded_by IS NULL;

-- Journal, if migration 0070's table is present. On a database built from
-- scratch it is, because 0070 still creates it.
INSERT INTO migration_0070_scorer_fields_journal (rule_id, attribute, prior_value)
SELECT pr.id, pr.attribute, pr.value
  FROM payer_rule pr
  JOIN freq_rows f ON f.rule_id = pr.id
 WHERE pr.value->'maxOccurrences' IS NULL
    OR pr.value->'windowDays'     IS NULL
ON CONFLICT (rule_id) DO NOTHING;

-- `value->'k' IS NOT NULL` rather than the `?` containment operator: `?`
-- is a bind-parameter placeholder to several client drivers.
UPDATE payer_rule pr
   SET value = pr.value || jsonb_build_object(
                 'maxOccurrences', f.max_occurrences,
                 'windowDays',     f.window_days)
  FROM freq_rows f
 WHERE pr.id = f.rule_id
   AND (pr.value->'maxOccurrences' IS NULL
        OR pr.value->'windowDays'  IS NULL);

DO $$
DECLARE
  n_live    INT;
  n_matched INT;
  n_carry   INT;
BEGIN
  SELECT count(*) INTO n_live FROM payer_rule
   WHERE attribute = 'frequency_limit'
     AND effective_date <= CURRENT_DATE
     AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE);
  SELECT count(*) INTO n_matched FROM freq_rows;
  SELECT count(*) INTO n_carry FROM payer_rule
   WHERE attribute = 'frequency_limit'
     AND effective_date <= CURRENT_DATE
     AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     AND value->'maxOccurrences' IS NOT NULL;

  IF n_live = 0 THEN
    -- Nothing seeded yet. Not a failure: this script also runs on a
    -- database being built from nothing.
    RAISE NOTICE 'scorer fields: no live frequency_limit rules yet — nothing to backfill';
  ELSIF n_matched = 0 THEN
    -- Every pin missed. Either the seeds reworded every classified answer,
    -- or the classification was pinned to text that no longer exists. Both
    -- mean the caps below are no longer derived from what the payer says.
    RAISE EXCEPTION
      'scorer fields: % live frequency_limit rules, but NONE matched the md5-pinned classifications. Re-read the distinct frequency_limit answers and re-classify by hand.', n_live;
  ELSE
    RAISE NOTICE 'scorer fields: % of % live frequency_limit rules carry maxOccurrences/windowDays (% matched this run)',
      n_carry, n_live, n_matched;
  END IF;
END $$;

COMMIT;
