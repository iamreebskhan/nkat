-- ============================================================================
-- 0077_purge_fixture_document.sql
--
-- Removes the fixture document 'https://example.test/anthem-oh-palliative-
-- care-policy.pdf' — a made-up URL registered in source_document as a real
-- Anthem BCBS Ohio medical policy — together with any rule that cites it.
--
-- WHY IT IS STILL HERE
-- It is created by db/seed/0017_test_users.sql, which is COMMENTED OUT of
-- db/seed/MANIFEST on purpose. The manifest's own note reads "Test accounts —
-- never in production", and the sibling entry for the fixture rule seed reads
-- "Fixture rules that would pollute the real library". deploy.sh strips
-- comments before reading the manifest, so neither has ever been applied by a
-- deploy. The row exists because it was applied by hand before that discipline
-- existed, and nothing has removed it since.
--
-- WHY IT MATTERS
-- source_document is the evidence table. Every rule's citation resolves to a
-- row in it, and the promise the product makes to a biller is that the quote
-- can be opened and checked. A row here that names a real payer and a
-- plausible policy title, pointing at a hostname that cannot resolve, is the
-- one thing that table must never contain. verify-production already guards
-- LIVE rules citing an unopenable URL — that guard passes, and has passed the
-- whole time, because the rules citing this document are expired rather than
-- absent. The document itself was never in scope of any check.
--
-- SAFETY
-- Refuses to run if any LIVE rule cites the document. Expired rules are
-- journalled whole and deleted, then the document. Idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0077_fixture_purge_journal (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  row_id      UUID NOT NULL,
  row_data    JSONB NOT NULL,
  purged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0077_fixture_purge_journal IS
  'Fixture source_document and payer_rule rows deleted by migration 0077.';

CREATE TEMP TABLE _fixture_doc ON COMMIT DROP AS
SELECT id FROM source_document WHERE url LIKE '%example.test%';

DO $$
DECLARE
  n_live INT;
BEGIN
  SELECT count(*) INTO n_live
    FROM payer_rule r JOIN _fixture_doc d ON d.id = r.source_doc_id
   WHERE r.effective_date <= CURRENT_DATE
     AND (r.expiration_date IS NULL OR r.expiration_date > CURRENT_DATE);
  IF n_live <> 0 THEN
    RAISE EXCEPTION '0077: refusing — % LIVE rule(s) still cite the fixture document. Withdraw them first; deleting a served rule is not this migration''s job.', n_live;
  END IF;
END $$;

-- Captured BEFORE the delete so the report counts what THIS run did. The
-- first version counted rows in the journal instead, so a second run — which
-- deletes nothing, the document already being gone — still announced
-- "removed: 1, rules: 5". A migration that reports work it did not do is
-- worse than one that reports nothing.
CREATE TEMP TABLE _fixture_rules ON COMMIT DROP AS
SELECT r.id FROM payer_rule r JOIN _fixture_doc d ON d.id = r.source_doc_id;

INSERT INTO migration_0077_fixture_purge_journal (kind, row_id, row_data)
SELECT 'payer_rule', r.id, to_jsonb(r)
  FROM payer_rule r JOIN _fixture_rules f ON f.id = r.id;

INSERT INTO migration_0077_fixture_purge_journal (kind, row_id, row_data)
SELECT 'source_document', sd.id, to_jsonb(sd)
  FROM source_document sd JOIN _fixture_doc d ON d.id = sd.id;

DELETE FROM document_chunk c USING _fixture_doc d WHERE c.source_doc_id = d.id;
DELETE FROM payer_rule    r USING _fixture_doc d WHERE r.source_doc_id = d.id;
DELETE FROM source_document sd USING _fixture_doc d WHERE sd.id = d.id;

DO $$
DECLARE
  n_docs INT; n_rules INT; n_left INT;
BEGIN
  SELECT count(*) FILTER (WHERE kind = 'source_document'),
         count(*) FILTER (WHERE kind = 'payer_rule')
    INTO n_docs, n_rules
    FROM migration_0077_fixture_purge_journal;

  SELECT count(*) INTO n_left FROM source_document WHERE url LIKE '%example.test%';
  IF n_left <> 0 THEN
    RAISE EXCEPTION '0077: % fixture document(s) survived the purge', n_left;
  END IF;

  RAISE NOTICE '0077: fixture document(s) removed: %, rule(s) that cited them: % (all expired)', n_docs, n_rules;
END $$;

COMMIT;
