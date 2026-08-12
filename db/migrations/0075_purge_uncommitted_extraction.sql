-- ============================================================================
-- 0075_purge_uncommitted_extraction.sql
--
-- Deletes every payer_rule carrying created_by 'extract:state-fee-schedule-
-- 2026-08' — an extraction run that was never committed as a seed.
--
-- WHY THESE ROWS ARE A DEFECT RATHER THAN DATA
-- No file in db/seed/MANIFEST produces them. A database built by running the
-- manifest — which is how production is built, and what scripts/replay-from-
-- scratch.sh reconstructs — never contains them. They existed only in the
-- developer database where that ad-hoc extraction was run.
--
-- Twelve of them were LIVE and answering questions: 99343, G0179 and G0180 for
-- Buckeye, CareSource, Molina and UnitedHealthcare Community Plan. Locally the
-- library answered all three; production had never heard of them. Every local
-- check that read those cells passed on rows that existed nowhere else, and
-- reported coverage the product did not actually have.
--
-- It surfaced by accident: migration 0073 reported 8 rows restored locally and
-- 0 on production. That difference was the only visible symptom.
--
-- The twelve determinations were not wrong — re-reading Appendix DD confirms
-- all three codes — so they are not being discarded. They are re-issued from
-- db/seed/payer-rules-oh-appendixdd-mco4.sql, which runs at deploy step 6, one
-- step after this migration, and which every database gets.
--
-- The remaining ~101 rows are already expired and answer nothing.
--
-- ORDER. Migration 0074 runs first and may revive one of these rows onto a key
-- the reverted seed emptied. This then deletes it and the seed re-issues it.
-- The end state is the same whichever database this runs against: on production
-- there is nothing here to delete at all and this is a no-op.
--
-- Journalled whole before deletion. Idempotent: a second run finds no rows.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0075_purge_journal (
  id        BIGSERIAL PRIMARY KEY,
  rule_id   UUID NOT NULL,
  rule_row  JSONB NOT NULL,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0075_purge_journal IS
  'Whole rows deleted by migration 0075 (the uncommitted state-fee-schedule extraction). '
  'To undo: INSERT INTO payer_rule SELECT (jsonb_populate_record(NULL::payer_rule, rule_row)).* '
  'FROM migration_0075_purge_journal;';

CREATE TEMP TABLE _orphan ON COMMIT DROP AS
SELECT id, payer_id, state, code, attribute, product_line,
       (effective_date <= CURRENT_DATE
        AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)) AS was_live
  FROM payer_rule
 WHERE created_by = 'extract:state-fee-schedule-2026-08';

INSERT INTO migration_0075_purge_journal (rule_id, rule_row)
SELECT pr.id, to_jsonb(pr) FROM payer_rule pr JOIN _orphan o ON o.id = pr.id;

DELETE FROM payer_rule pr USING _orphan o WHERE pr.id = o.id;

DO $$
DECLARE
  n_total INT; n_live INT; n_left INT; n_surprise INT := 0;
  r RECORD;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE was_live) INTO n_total, n_live FROM _orphan;

  SELECT count(*) INTO n_left FROM payer_rule
   WHERE created_by = 'extract:state-fee-schedule-2026-08';
  IF n_left <> 0 THEN
    RAISE EXCEPTION '0075: % row(s) survived the purge', n_left;
  END IF;

  -- Emptying a key is only acceptable for the twelve this migration is FOR,
  -- because a committed seed re-issues exactly those at step 6. A key emptied
  -- outside that set means this extraction was answering something nothing
  -- else covers, and deleting it would silently remove a determination.
  FOR r IN
    SELECT p.name AS payer, o.code, o.product_line
      FROM (SELECT DISTINCT payer_id, state, code, attribute, product_line FROM _orphan WHERE was_live) o
      JOIN payer p ON p.id = o.payer_id
     WHERE NOT EXISTS (
       SELECT 1 FROM payer_rule live
        WHERE live.payer_id IS NOT DISTINCT FROM o.payer_id
          AND live.state    IS NOT DISTINCT FROM o.state
          AND live.code = o.code
          AND live.attribute = o.attribute
          AND live.product_line IS NOT DISTINCT FROM o.product_line
          AND live.effective_date <= CURRENT_DATE
          AND (live.expiration_date IS NULL OR live.expiration_date > CURRENT_DATE))
       AND NOT (o.code IN ('99343', 'G0179', 'G0180')
                AND p.name IN ('Buckeye Health Plan', 'CareSource Ohio',
                               'Molina Healthcare of Ohio', 'UnitedHealthcare Community Plan Ohio'))
     ORDER BY 1, 2
  LOOP
    n_surprise := n_surprise + 1;
    RAISE NOTICE '0075: UNEXPECTED — % / % / % was answered only by this extraction and no seed replaces it',
      r.payer, r.code, coalesce(r.product_line, '-');
  END LOOP;

  IF n_surprise <> 0 THEN
    RAISE EXCEPTION '0075: % key(s) outside the known twelve would be left unanswered — see the NOTICE lines above', n_surprise;
  END IF;

  RAISE NOTICE '0075: % uncommitted-extraction row(s) purged (% of them live)', n_total, n_live;
  RAISE NOTICE '0075: payer-rules-oh-appendixdd-mco4.sql re-issues the live ones at step 6';
END $$;

COMMIT;
