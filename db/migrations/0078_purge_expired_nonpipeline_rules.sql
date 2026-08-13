-- ============================================================================
-- 0078_purge_expired_nonpipeline_rules.sql
--
-- Removes payer_rule rows written by a PERSON or an assistant rather than by
-- an extraction or crawler run, and already withdrawn from service.
--
-- WHAT IS BEING REMOVED
-- On production these are roughly forty rows under authors like
-- 'test@pallio.io', 'analyst:<uuid>' and 'ai'. Every one is expired, so the
-- library does not serve any of them and no answer changes here. They are the
-- residue of the seven hand-typed rules withdrawn earlier in this project --
-- rules that were well formed, unique, internally consistent and untrue, and
-- that passed every audit for months because nothing asked WHO wrote them.
--
-- WHY REMOVE THEM AT ALL, IF NOTHING SERVES THEM
-- Because "expired" is one UPDATE away from "live", and this table is the
-- library's evidence base. verify-production guards LIVE rules with a
-- non-pipeline author and reports zero -- correctly, and it has reported zero
-- the whole time these rows sat there. A guard that only looks at what is
-- currently served cannot see a hand-typed rule waiting to be revived by the
-- next repair that resurrects "the most recent rule on this key". That is not
-- hypothetical: migration 0074 did exactly that, revived a person-authored
-- rule onto UnitedHealthcare's G0318, and only expire-ungrounded-rules.sql
-- catching it later kept it away from a biller.
--
-- ROWS THAT SOMETHING ELSE POINTS AT ARE KEPT
-- "Nothing serves them" was not the same as "nothing references them", and I
-- had them confused. The first attempt at this migration failed on
-- production against org_rulebook_row: a TENANT's rulebook row carries a
-- source_payer_rule_id pointing at one of these typed rules. Eight tables
-- reference payer_rule -- org_rulebook_row, client_rule, alert, rule_dispute,
-- era_835_record, extraction_candidate, attestation_reverification, and
-- payer_rule itself through superseded_by -- and one of them cascades on
-- delete, so a careless purge would have taken tenant records with it.
--
-- So any candidate that anything still points at is LEFT ALONE and named in
-- the output. The referencing tables are read from the catalog rather than
-- listed here, so a foreign key added later is covered without editing this.
--
-- A rulebook row whose source is a withdrawn typed rule is a real finding and
-- deliberately NOT resolved here: the tenant's own copy of the value is in
-- that row, and deciding what to tell them is a product decision, not a
-- migration's.
--
-- SAFETY
-- Refuses to run if any matching row is LIVE -- withdrawing a served rule is
-- a different decision and belongs to expire-ungrounded-rules.sql, which
-- journals its own reasons. Whole rows are journalled before deletion, so the
-- audit trail of what was once claimed survives the rows themselves.
-- Idempotent: a second run finds nothing left that is safe to remove.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0078_purge_journal (
  id        BIGSERIAL PRIMARY KEY,
  rule_id   UUID NOT NULL,
  author    TEXT NOT NULL,
  rule_row  JSONB NOT NULL,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0078_purge_journal IS
  'Expired non-pipeline payer_rule rows deleted by migration 0078 (hand-typed and '
  'assistant-authored residue). To undo: INSERT INTO payer_rule SELECT '
  '(jsonb_populate_record(NULL::payer_rule, rule_row)).* FROM migration_0078_purge_journal;';

CREATE TEMP TABLE _residue ON COMMIT DROP AS
SELECT id, created_by,
       (effective_date <= CURRENT_DATE
        AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)) AS is_live
  FROM payer_rule
 WHERE created_by NOT LIKE 'extract:%'
   AND created_by NOT LIKE 'crawler:%';

DO $$
DECLARE
  n_live INT;
  r RECORD;
BEGIN
  SELECT count(*) INTO n_live FROM _residue WHERE is_live;
  IF n_live <> 0 THEN
    FOR r IN SELECT DISTINCT created_by FROM _residue WHERE is_live LOOP
      RAISE NOTICE '0078: LIVE non-pipeline rule(s) authored by %', r.created_by;
    END LOOP;
    RAISE EXCEPTION '0078: refusing — % non-pipeline rule(s) are still SERVED. Withdraw them through db/maintenance/expire-ungrounded-rules.sql first, so the withdrawal is journalled with its reason.', n_live;
  END IF;
END $$;

-- Anything still pointed at by any table, found from the catalog rather than
-- from a list somebody has to remember to update.
CREATE TEMP TABLE _referenced (rule_id UUID, by_table TEXT, by_column TEXT) ON COMMIT DROP;

DO $$
DECLARE fk RECORD;
BEGIN
  FOR fk IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f' AND c.confrelid = 'payer_rule'::regclass
  LOOP
    EXECUTE format(
      'INSERT INTO _referenced (rule_id, by_table, by_column)
         SELECT DISTINCT t.%I, %L, %L FROM %s t JOIN _residue x ON x.id = t.%I',
      fk.col, fk.tbl, fk.col, fk.tbl, fk.col);
  END LOOP;
END $$;

INSERT INTO migration_0078_purge_journal (rule_id, author, rule_row)
SELECT pr.id, pr.created_by, to_jsonb(pr)
  FROM payer_rule pr JOIN _residue x ON x.id = pr.id
 WHERE NOT EXISTS (SELECT 1 FROM _referenced f WHERE f.rule_id = pr.id);

DELETE FROM payer_rule pr USING _residue x
 WHERE pr.id = x.id
   AND NOT EXISTS (SELECT 1 FROM _referenced f WHERE f.rule_id = pr.id);

DO $$
DECLARE
  n_total INT; n_kept INT; n_purged INT; n_left INT; r RECORD;
BEGIN
  SELECT count(*) INTO n_total FROM _residue;
  SELECT count(DISTINCT rule_id) INTO n_kept FROM _referenced;
  n_purged := n_total - n_kept;

  SELECT count(*) INTO n_left FROM payer_rule pr
   WHERE pr.created_by NOT LIKE 'extract:%' AND pr.created_by NOT LIKE 'crawler:%'
     AND NOT EXISTS (SELECT 1 FROM _referenced f WHERE f.rule_id = pr.id);
  IF n_left <> 0 THEN
    RAISE EXCEPTION '0078: % unreferenced non-pipeline row(s) survived the purge', n_left;
  END IF;

  IF n_total = 0 THEN
    RAISE NOTICE '0078: no non-pipeline rules present — nothing to purge';
  ELSE
    FOR r IN
      SELECT x.created_by, count(*) AS c,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM _referenced f WHERE f.rule_id = x.id)) AS kept
        FROM _residue x GROUP BY x.created_by ORDER BY 2 DESC
    LOOP
      RAISE NOTICE '0078:   author %  —  % removed, % kept (still referenced)',
        r.created_by, r.c - r.kept, r.kept;
    END LOOP;
    RAISE NOTICE '0078: % expired non-pipeline rule(s) purged and journalled, % kept because something points at them',
      n_purged, n_kept;
  END IF;

  -- Named individually, because a tenant rulebook sourced from a hand-typed
  -- rule is worth someone's attention rather than a line in a total.
  FOR r IN
    SELECT f.by_table, f.by_column, count(DISTINCT f.rule_id) AS c
      FROM _referenced f GROUP BY f.by_table, f.by_column ORDER BY 3 DESC
  LOOP
    RAISE NOTICE '0078:   still referenced from %.% — % rule(s)', r.by_table, r.by_column, r.c;
  END LOOP;
END $$;

COMMIT;
