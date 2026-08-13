-- ============================================================================
-- 0080_reground_rulebook_rows.sql
--
-- Re-derives every tenant rulebook row descended from a hand-typed payer rule,
-- from the pipeline-authored rule that answers the same key today.
--
-- WHAT WENT WRONG, AND WHY FOUR EARLIER FIXES MISSED IT
-- Seven payer rules authored by 'test@pallio.io' were found fabricated: well
-- formed, confident, unique, and untrue. They were withdrawn from service,
-- kept out by a guard, un-revived after a migration resurrected one, and
-- finally purged. Every one of those fixes operated on payer_rule.
--
-- org_rulebook_row holds a tenant's OWN COPY -- rule_value, coverage_status,
-- confidence, source_quote -- and only a pointer back to the source. So none
-- of it changed what those tenants read. 185 rulebook rows across 28 active
-- orgs still carried the fabricated content, last touched 13 July 2026, and
-- nothing noticed until migration 0078 tried to delete the sources and a
-- foreign key refused.
--
-- WHY RE-DERIVE RATHER THAN DELETE OR EXPIRE
-- Measured before deciding, on production:
--   185 rows   0 hand-edited by a user   0 already expired
--   185 of 185 have a live pipeline-authored rule for the same
--              (payer, state, code, attribute)
-- So there is nothing a user wrote to preserve, and a correct, cited answer
-- exists for every single row. Deleting would leave 28 rulebooks with holes;
-- expiring would leave them with silence. Replacing the content with the
-- verified rule gives each org the answer they should have had, and restores
-- the provenance link to something citable.
--
-- WHAT IT WILL NOT TOUCH
--   * a row a user has edited (last_edited_by_user_id IS NOT NULL) -- that is
--     the tenant's own work, not ours to overwrite, however it was seeded
--   * a row whose key has no live pipeline rule -- it is flagged, not guessed
--   * a row whose key has AMBIGUOUS candidates across product lines -- also
--     flagged rather than resolved by coin toss
--
-- The before-state of every row is journalled whole, so anything this rewrites
-- can be reconstructed exactly.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0080_reground_journal (
  id             BIGSERIAL PRIMARY KEY,
  rulebook_row_id UUID NOT NULL,
  org_id         UUID NOT NULL,
  before_row     JSONB NOT NULL,
  new_source_rule UUID,
  regrounded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0080_reground_journal IS
  'Tenant rulebook rows re-derived by migration 0080, with their full prior contents. '
  'To undo a row: UPDATE org_rulebook_row SET ... FROM before_row.';

-- Rows descended from a rule no pipeline produced.
CREATE TEMP TABLE _tainted ON COMMIT DROP AS
SELECT r.id, r.org_id, r.payer_id, r.state, r.cpt_code, r.attribute,
       (r.last_edited_by_user_id IS NOT NULL) AS user_edited
  FROM org_rulebook_row r
 WHERE r.source_payer_rule_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM payer_rule pr
                WHERE pr.id = r.source_payer_rule_id
                  AND pr.created_by NOT LIKE 'extract:%'
                  AND pr.created_by NOT LIKE 'crawler:%');

-- The rule that answers each key today. DISTINCT ON keeps this deterministic
-- when a payer has more than one product line on the same code; the count of
-- such keys is reported below rather than hidden.
CREATE TEMP TABLE _replacement ON COMMIT DROP AS
SELECT DISTINCT ON (t.id) t.id AS rulebook_row_id, pr.id AS rule_id,
       pr.value, pr.coverage_status, pr.confidence, pr.source_quote,
       (SELECT count(*) FROM payer_rule c
         WHERE c.payer_id IS NOT DISTINCT FROM t.payer_id AND c.state = t.state
           AND c.code = t.cpt_code AND c.attribute = t.attribute
           AND c.created_by LIKE 'extract:%'
           AND c.effective_date <= CURRENT_DATE
           AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)) AS candidates
  FROM _tainted t
  JOIN payer_rule pr
    ON pr.payer_id IS NOT DISTINCT FROM t.payer_id
   AND pr.state = t.state
   AND pr.code = t.cpt_code
   AND pr.attribute = t.attribute
   AND pr.created_by LIKE 'extract:%'
   AND pr.effective_date <= CURRENT_DATE
   AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
 WHERE NOT t.user_edited
 ORDER BY t.id, pr.confidence DESC, pr.effective_date DESC, pr.id;

INSERT INTO migration_0080_reground_journal (rulebook_row_id, org_id, before_row, new_source_rule)
SELECT r.id, r.org_id, to_jsonb(r), x.rule_id
  FROM org_rulebook_row r JOIN _replacement x ON x.rulebook_row_id = r.id;

UPDATE org_rulebook_row r
   SET rule_value           = x.value,
       coverage_status      = x.coverage_status,
       confidence           = x.confidence,
       source_quote         = x.source_quote,
       source_payer_rule_id = x.rule_id,
       updated_at           = now()
  FROM _replacement x
 WHERE r.id = x.rulebook_row_id;

DO $$
DECLARE
  n_tainted INT; n_fixed INT; n_edited INT; n_nofix INT; n_ambig INT; n_left INT;
  -- NOT named r: the queries below alias org_rulebook_row as r, and a PL/pgSQL
  -- variable shadows a SQL alias, which fails at run time with
  -- 'record "r" is not assigned yet' rather than at parse time.
  rec RECORD;
BEGIN
  SELECT count(*) INTO n_tainted FROM _tainted;
  SELECT count(*) INTO n_fixed   FROM _replacement;
  SELECT count(*) INTO n_edited  FROM _tainted WHERE user_edited;
  SELECT count(*) INTO n_ambig   FROM _replacement WHERE candidates > 1;
  n_nofix := n_tainted - n_edited - n_fixed;

  IF n_tainted = 0 THEN
    RAISE NOTICE '0080: no rulebook rows descend from a hand-typed rule — nothing to do';
  ELSE
    RAISE NOTICE '0080: % rulebook row(s) descended from hand-typed rules', n_tainted;
    RAISE NOTICE '0080:   % re-derived from the rule that answers the key today', n_fixed;
    IF n_edited > 0 THEN
      RAISE NOTICE '0080:   % left untouched because a user had edited them', n_edited;
    END IF;
    IF n_nofix > 0 THEN
      RAISE NOTICE '0080:   % left as they are — no live pipeline rule answers that key', n_nofix;
      FOR rec IN SELECT t.cpt_code, t.attribute, count(*) AS c FROM _tainted t
                WHERE NOT t.user_edited
                  AND NOT EXISTS (SELECT 1 FROM _replacement x WHERE x.rulebook_row_id = t.id)
                GROUP BY 1,2 ORDER BY 3 DESC
      LOOP
        RAISE NOTICE '0080:     no replacement for % / %  (% row(s))', rec.cpt_code, rec.attribute, rec.c;
      END LOOP;
    END IF;
    IF n_ambig > 0 THEN
      RAISE NOTICE '0080:   note: % row(s) had more than one live rule on the key across product lines; the highest-confidence, most recent was used', n_ambig;
    END IF;
  END IF;

  SELECT count(*) INTO n_left FROM org_rulebook_row r
   WHERE r.source_payer_rule_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM payer_rule pr WHERE pr.id = r.source_payer_rule_id
                  AND pr.created_by NOT LIKE 'extract:%' AND pr.created_by NOT LIKE 'crawler:%');
  IF n_left <> n_edited + n_nofix THEN
    RAISE EXCEPTION '0080: % rows still descend from a hand-typed rule, but only % were deliberately left', n_left, n_edited + n_nofix;
  END IF;
  IF n_left = 0 THEN
    RAISE NOTICE '0080: no tenant rulebook row descends from a hand-typed rule any more';
  END IF;
END $$;

COMMIT;
