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

-- Every version, with the two things that decide its fate kept apart:
-- references that PROTECT it, and chunks, which do not.
--
-- WHY document_chunk IS NOT A PROTECTING REFERENCE
-- Chunking runs on whatever the crawler just fetched, so a churned version
-- always has its own chunks. Counting them as protection is circular --
-- the chunks exist only because the churn created the version -- and it
-- made this script a no-op on the very document it was written for: all
-- 13 versions of the Aetna policy page protected themselves, 0 retired.
--
-- Chunks are also derived, regenerable, and already ON DELETE CASCADE.
-- And keeping them is not free: 12 of those Aetna versions hold 87 chunks
-- each of IDENTICAL text, so 1,044 near-duplicate rows sit in the vector
-- index and a retrieval that should surface twelve different documents
-- surfaces the same page twelve times.
--
-- A payer_rule citation is the opposite and still protects absolutely: a
-- biller clicking through to their evidence has to land on the version
-- the rule was actually read from. In production those citations sit on
-- the OLDEST Aetna version, which carries no chunks at all -- so
-- "protected" and "has the text" are genuinely different versions, and
-- the rescue below is what keeps both.
CREATE TEMP TABLE _versions ON COMMIT DROP AS
SELECT sd.id, sd.url, sd.payer_id,
       coalesce(sd.payer_id::text, '~null~') AS grp,
       row_number() OVER (
         PARTITION BY sd.url, coalesce(sd.payer_id::text, '~null~')
         ORDER BY sd.retrieved_at DESC, sd.id DESC
       ) AS recency,
       (SELECT count(*) FROM payer_rule                r WHERE r.source_doc_id      = sd.id)
     + (SELECT count(*) FROM extraction_candidate      e WHERE e.source_doc_id      = sd.id)
     + (SELECT count(*) FROM documentation_requirement d WHERE d.source_doc_id      = sd.id)
     + (SELECT count(*) FROM client_doc_upload         u WHERE u.source_document_id = sd.id)
       AS refs,
       (SELECT count(*) FROM document_chunk c WHERE c.source_doc_id = sd.id) AS chunks,
       (SELECT count(*) FROM document_chunk c
         WHERE c.source_doc_id = sd.id AND c.embedding IS NOT NULL)          AS embedded
  FROM source_document sd;

-- THE RESCUE
-- A document must not lose its retrieval text just because the versions
-- carrying it happen to be uncited. If the kept set -- the newest version
-- plus everything a rule cites -- would hold no chunks while the document
-- HAS chunks, the newest chunk-bearing version is kept as well. Embeddings
-- are considered first: chunks without an embedding are not retrievable by
-- vector search, so a version whose chunks are embedded outranks one whose
-- chunks are merely present.
CREATE TEMP TABLE _rescue ON COMMIT DROP AS
WITH per_group AS (
  SELECT url, grp, max(chunks) AS any_chunks, max(embedded) AS any_embedded
    FROM _versions GROUP BY url, grp
),
kept_group AS (
  SELECT url, grp, max(chunks) AS kept_chunks, max(embedded) AS kept_embedded
    FROM _versions WHERE recency = 1 OR refs > 0
   GROUP BY url, grp
)
SELECT DISTINCT ON (v.url, v.grp) v.id
  FROM _versions v
  JOIN per_group  g ON g.url  = v.url AND g.grp  = v.grp
  JOIN kept_group k ON k.url  = v.url AND k.grp  = v.grp
 WHERE v.recency > 1 AND v.refs = 0
   AND (
        -- the document has embedded chunks, but nothing kept does
        (g.any_embedded > 0 AND k.kept_embedded = 0 AND v.embedded > 0)
        -- or it has chunks at all, none embedded, and nothing kept has any
     OR (g.any_embedded = 0 AND g.any_chunks > 0 AND k.kept_chunks = 0 AND v.chunks > 0)
   )
 ORDER BY v.url, v.grp, v.recency;   -- newest qualifying version

-- What the document holds BEFORE the delete, so the postconditions can
-- prove nothing was lost rather than assume it.
CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT url, grp, max(chunks) AS had_chunks, max(embedded) AS had_embedded
  FROM _versions GROUP BY url, grp;

CREATE TEMP TABLE _retire ON COMMIT DROP AS
SELECT v.id, v.url, v.payer_id,
       v.chunks   AS chunks_removed,
       v.embedded AS embedded_removed
  FROM _versions v
 WHERE v.recency > 1                                    -- never the current version
   AND v.refs = 0                                       -- never something a rule cites
   AND NOT EXISTS (SELECT 1 FROM _rescue r WHERE r.id = v.id);  -- never the last copy of the text

INSERT INTO document_version_retirement_journal (document_id, url, payer_id, document_row)
SELECT r.id, r.url, r.payer_id, to_jsonb(sd) - 'extracted_text'
  FROM _retire r JOIN source_document sd ON sd.id = r.id;

DELETE FROM source_document sd USING _retire r WHERE sd.id = r.id;

DO $$
DECLARE
  n_retired INT;
  n_dangling INT;
  n_orphan_urls INT;
  n_lost_text INT;
  n_chunks INT;
  n_embedded INT;
BEGIN
  SELECT count(*), coalesce(sum(chunks_removed),0), coalesce(sum(embedded_removed),0)
    INTO n_retired, n_chunks, n_embedded
    FROM _retire;

  -- A document that HAD chunks must still have chunks, and one that had
  -- embedded chunks must still have embedded ones. This is the check the
  -- rescue exists to satisfy; without it, dropping every uncited version
  -- of the Aetna page would have taken all 1,044 of its chunks with it and
  -- silently removed the document from vector retrieval, while every
  -- rule citation still resolved and every count above still read zero.
  SELECT count(*) INTO n_lost_text
    FROM _before b
   WHERE (b.had_chunks > 0 OR b.had_embedded > 0)
     AND NOT EXISTS (
       SELECT 1
         FROM source_document sd
         JOIN document_chunk c ON c.source_doc_id = sd.id
        WHERE sd.url = b.url
          AND coalesce(sd.payer_id::text, '~null~') = b.grp
          AND (b.had_embedded = 0 OR c.embedding IS NOT NULL));
  IF n_lost_text <> 0 THEN
    RAISE EXCEPTION 'retire-uncited-document-versions: % document(s) would lose all retrievable text — refusing', n_lost_text;
  END IF;

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
  RAISE NOTICE '  duplicate chunks removed: % (% embedded)', n_chunks, n_embedded;
  RAISE NOTICE '  dangling references: 0   documents left with no version: 0';
  RAISE NOTICE '  documents that lost their retrievable text: 0';
END $$;

COMMIT;
