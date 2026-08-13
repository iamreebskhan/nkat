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
-- SAFETY
-- Refuses to run if any matching row is LIVE -- withdrawing a served rule is
-- a different decision and belongs to expire-ungrounded-rules.sql, which
-- journals its own reasons. Whole rows are journalled before deletion, so the
-- audit trail of what was once claimed survives the rows themselves.
-- Idempotent: a second run finds nothing.
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

INSERT INTO migration_0078_purge_journal (rule_id, author, rule_row)
SELECT pr.id, pr.created_by, to_jsonb(pr)
  FROM payer_rule pr JOIN _residue x ON x.id = pr.id;

DELETE FROM payer_rule pr USING _residue x WHERE pr.id = x.id;

DO $$
DECLARE
  n INT; n_left INT; r RECORD;
BEGIN
  SELECT count(*) INTO n FROM _residue;

  SELECT count(*) INTO n_left FROM payer_rule
   WHERE created_by NOT LIKE 'extract:%' AND created_by NOT LIKE 'crawler:%';
  IF n_left <> 0 THEN
    RAISE EXCEPTION '0078: % non-pipeline row(s) survived the purge', n_left;
  END IF;

  IF n = 0 THEN
    RAISE NOTICE '0078: no non-pipeline rules present — nothing to purge';
  ELSE
    FOR r IN SELECT created_by, count(*) AS c FROM _residue GROUP BY created_by ORDER BY 2 DESC LOOP
      RAISE NOTICE '0078:   % rows removed from author %', r.c, r.created_by;
    END LOOP;
    RAISE NOTICE '0078: % expired non-pipeline rule(s) purged, all journalled', n;
  END IF;
END $$;

COMMIT;
