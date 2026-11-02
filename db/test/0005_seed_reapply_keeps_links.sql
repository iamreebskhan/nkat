-- ============================================================================
-- 0005_seed_reapply_keeps_links.sql
-- A rule seed applied a second time must not delete a rule that something
-- else points at.
--
-- WHY IT EXISTS. The 2 Nov 2026 deploy re-applied
-- db/seed/payer-rules-cy2026-full-rule.sql because its content had changed,
-- and the seed began by deleting its own rows. On production a practice had
-- copied one of them into its rulebook (org_rulebook_row.source_payer_rule_id),
-- the foreign key refused, and the deploy stopped with the migrations in and
-- the seeds half applied. CI could not see it: it applies each seed once, to a
-- database where nothing points at a rule yet. This file points at one, then
-- applies the seed again, as a deploy does.
--
-- It WRITES: a throwaway practice, its rulebook and one row, removed at the
-- end, and the seed's own re-run. Run it only against a database built for
-- the test, as CI does.
-- ============================================================================

\set ON_ERROR_STOP on
\echo '== seed re-apply keeps links: setup =='

INSERT INTO org (id, name, slug, plan_tier)
VALUES ('c2026000-0000-4000-8000-000000000001', 'Seed re-apply test', 'seed-reapply-test', 'org')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO org_rulebook (id, org_id, origin)
VALUES ('c2026000-0000-4000-8000-000000000002', 'c2026000-0000-4000-8000-000000000001', 'generated')
ON CONFLICT (org_id) DO NOTHING;

-- A rulebook row copied from one of the seed's live rules, as onboarding does.
INSERT INTO org_rulebook_row (
  id, org_id, rulebook_id, payer_id, state, cpt_code, attribute,
  rule_value, coverage_status, origin, confidence, source_payer_rule_id, source_quote
)
SELECT 'c2026000-0000-4000-8000-000000000003', 'c2026000-0000-4000-8000-000000000001',
       'c2026000-0000-4000-8000-000000000002', pr.payer_id, pr.state, pr.code, pr.attribute,
       pr.value, pr.coverage_status, 'source', pr.confidence, pr.id, pr.source_quote
  FROM payer_rule pr
 WHERE pr.source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid
   AND pr.expiration_date IS NULL
 ORDER BY pr.state, pr.code, pr.attribute
 LIMIT 1;

CREATE TEMP TABLE _seed_before AS
SELECT (SELECT source_payer_rule_id FROM org_rulebook_row
         WHERE id = 'c2026000-0000-4000-8000-000000000003') AS linked_rule,
       (SELECT count(*) FROM payer_rule
         WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid
           AND expiration_date IS NULL) AS live_rows,
       (SELECT count(*) FROM payer_rule
         WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid) AS all_rows;

\echo '== applying payer-rules-cy2026-full-rule.sql again =='
\ir ../seed/payer-rules-cy2026-full-rule.sql

DO $$
DECLARE
  b          RECORD;
  linked     UUID;
  live_after INT;
  all_after  INT;
  dup_keys   INT;
BEGIN
  SELECT * INTO b FROM _seed_before;
  IF b.linked_rule IS NULL THEN
    RAISE EXCEPTION 'setup: the seed had no live rule to copy into a rulebook';
  END IF;

  SELECT source_payer_rule_id INTO linked FROM org_rulebook_row
   WHERE id = 'c2026000-0000-4000-8000-000000000003';
  IF linked IS DISTINCT FROM b.linked_rule THEN
    RAISE EXCEPTION 'the rulebook row lost its rule: % became %', b.linked_rule, linked;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM payer_rule WHERE id = b.linked_rule AND expiration_date IS NULL) THEN
    RAISE EXCEPTION 'the rule the rulebook row copied (%) no longer answers', b.linked_rule;
  END IF;

  SELECT count(*) INTO live_after FROM payer_rule
   WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid AND expiration_date IS NULL;
  IF live_after <> b.live_rows THEN
    RAISE EXCEPTION 'a re-run changed the live rules: % before, % after', b.live_rows, live_after;
  END IF;

  SELECT count(*) INTO all_after FROM payer_rule
   WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid;
  IF all_after <> b.all_rows THEN
    RAISE EXCEPTION 'a re-run added rows instead of rewriting them: % before, % after', b.all_rows, all_after;
  END IF;

  SELECT count(*) INTO dup_keys FROM (
    SELECT state, code, attribute FROM payer_rule
     WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid AND expiration_date IS NULL
     GROUP BY state, code, attribute HAVING count(*) > 1
  ) d;
  IF dup_keys > 0 THEN
    RAISE EXCEPTION '% keys hold two live rules from the seed after a re-run', dup_keys;
  END IF;

  RAISE NOTICE 'seed re-applied: the rulebook still points at %, and % rules are live as before', b.linked_rule, live_after;
END $$;

\echo '== cleanup =='
DELETE FROM org_rulebook_row WHERE id = 'c2026000-0000-4000-8000-000000000003';
DELETE FROM org_rulebook WHERE id = 'c2026000-0000-4000-8000-000000000002';
DELETE FROM org WHERE id = 'c2026000-0000-4000-8000-000000000001';
DROP TABLE _seed_before;
