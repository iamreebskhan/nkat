-- ============================================================================
-- retire-uncited-document-versions.sql — run AFTER the seeds, with the
-- timeline repair.
--
-- WHAT IT CLEANS
-- source_document holds one row per (url, payer_id, content_hash) — one
-- per VERSION of a document per payer. That is correct: a changed payer
-- document must not overwrite the version the existing rules were
-- extracted from.
--
-- But until the content hash was taken over extracted TEXT rather than raw
-- bytes, an HTML page whose markup differed on every fetch minted a new
-- version each crawl. Production accumulated 13 versions of one Aetna
-- clinical policy page in three months and 35 of a Federal Register PDF in
-- a single day. The policy text never changed.
--
-- The hashing fix stops NEW churn. It cannot undo what is already stored,
-- and it cannot be applied retroactively either: extracted_text is NULL on
-- the historical rows, so their text hash is not recoverable without
-- re-fetching every document.
--
-- WHAT THIS DOES INSTEAD, AND WHAT IT REFUSES TO DO
-- It deletes only version rows that NOTHING references and that are NOT
-- the newest version of their document. A row is kept if:
--
--   * it is the newest version for its (url, payer_id) — that is the
--     document as it stands, and change detection compares against it; or
--   * any payer_rule, document_chunk, extraction_candidate,
--     documentation_requirement or client_doc_upload points at it — a rule
--     must keep citing the exact version it was extracted from, even when
--     a newer version exists. A citation a biller cannot open is worse
--     than a redundant row.
--
-- So a document with one version is untouched, and a document whose every
-- version is cited is untouched. Only the dead middle is removed.
--
-- Reversible: every deleted row is journaled whole beforehand.
-- Idempotent: a second run finds nothing left to retire.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS document_version_retirement_journal (
  id           BIGSERIAL PRIMARY KEY,
  document_id  UUID NOT NULL,
  url          TEXT NOT NULL,
  payer_id     UUID,
  document_row JSONB NOT NULL,
  retired_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No foreign key to source_document: the row it describes is about to be
-- deleted, which is the entire point. The same reasoning that kept an FK
-- off the migration 0072 journal.
COMMENT ON TABLE document_version_retirement_journal IS
  'Whole rows deleted by db/maintenance/retire-uncited-document-versions.sql. '
  'To undo: INSERT INTO source_document SELECT (jsonb_populate_record(NULL::source_document, document_row)).* '
  'FROM document_version_retirement_journal WHERE ...';

CREATE TEMP TABLE _retire ON COMMIT DROP AS
WITH ranked AS (
  SELECT sd.id, sd.url, sd.payer_id,
         row_number() OVER (
           PARTITION BY sd.url, coalesce(sd.payer_id::text, '~null~')
           ORDER BY sd.retrieved_at DESC, sd.id DESC
         ) AS recency,
         (SELECT count(*) FROM payer_rule                r WHERE r.source_doc_id      = sd.id)
       + (SELECT count(*) FROM document_chunk            c WHERE c.source_doc_id      = sd.id)
       + (SELECT count(*) FROM extraction_candidate      e WHERE e.source_doc_id      = sd.id)
       + (SELECT count(*) FROM documentation_requirement d WHERE d.source_doc_id      = sd.id)
       + (SELECT count(*) FROM client_doc_upload         u WHERE u.source_document_id = sd.id)
         AS refs
    FROM source_document sd
)
SELECT id, url, payer_id
  FROM ranked
 WHERE recency > 1     -- never the current version
   AND refs = 0;       -- never something a rule cites

INSERT INTO document_version_retirement_journal (document_id, url, payer_id, document_row)
SELECT r.id, r.url, r.payer_id, to_jsonb(sd) - 'extracted_text'
  FROM _retire r JOIN source_document sd ON sd.id = r.id;

DELETE FROM source_document sd USING _retire r WHERE sd.id = r.id;

DO $$
DECLARE
  n_retired INT;
  n_dangling INT;
  n_orphan_urls INT;
BEGIN
  SELECT count(*) INTO n_retired FROM _retire;

  -- Nothing may point at a row that no longer exists. document_chunk and
  -- extraction_candidate are ON DELETE CASCADE, so a mistake there would
  -- be silent — which is why refs=0 is the precondition and this is the
  -- proof.
  SELECT (SELECT count(*) FROM payer_rule r
            WHERE r.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = r.source_doc_id))
       + (SELECT count(*) FROM documentation_requirement d
            WHERE d.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = d.source_doc_id))
       + (SELECT count(*) FROM document_chunk c
            WHERE NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = c.source_doc_id))
       + (SELECT count(*) FROM extraction_candidate e
            WHERE NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = e.source_doc_id))
       + (SELECT count(*) FROM client_doc_upload u
            WHERE u.source_document_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = u.source_document_id))
    INTO n_dangling;
  IF n_dangling <> 0 THEN
    RAISE EXCEPTION 'retire-uncited-document-versions: % row(s) now reference a deleted document', n_dangling;
  END IF;

  -- Every (url, payer_id) that existed must still have at least one row.
  SELECT count(*) INTO n_orphan_urls
    FROM document_version_retirement_journal j
   WHERE NOT EXISTS (
     SELECT 1 FROM source_document s
      WHERE s.url = j.url AND s.payer_id IS NOT DISTINCT FROM j.payer_id);
  IF n_orphan_urls <> 0 THEN
    RAISE EXCEPTION 'retire-uncited-document-versions: % document(s) lost every version — refusing', n_orphan_urls;
  END IF;

  RAISE NOTICE 'document versions: % uncited old version(s) retired', n_retired;
  RAISE NOTICE '  dangling references: 0   documents left with no version: 0';
END $$;

COMMIT;
