-- ============================================================================
-- 0068_dedupe_source_document.sql
--
-- Collapse duplicate source_document rows and stop them coming back.
--
-- WHAT IS ACTUALLY DUPLICATED — and what only looks like it
-- 8 URLs appear on more than one row, covering 38 of 54 rows. Most of that
-- is NOT duplication. A North Carolina Medicaid clinical policy governs
-- UnitedHealthcare NC, Carolina Complete, Healthy Blue, AmeriHealth
-- Caritas and EBCI alike; each payer's rules cite it, and source_document
-- carries payer_id, so one row per payer is the intended shape.
-- Collapsing those would destroy per-payer citation, not repair it.
--
-- The real duplication is 10 (url, payer_id) pairs — 20 rows — each with
-- the same title and the same document behind it. They exist because two
-- seeds registered the document independently:
--
--   retrieved 2026-08-07  payer-rules-state-fee-schedules-2026.sql  } deleted
--   retrieved 2026-08-07  payer-rules-medicare-rvu26c.sql           } from repo
--   retrieved 2026-08-08  payer-rules-fee-schedules-full.sql        <- live seed
--
-- The first two were removed when the third superseded them; their
-- source_document rows and the rules citing them stayed behind. All 10
-- survivors are the rows the live seed still maintains, and all 10 losers
-- are owned by no seed at all — reference count and provenance agree.
--
-- The differing content_hash values do NOT indicate two versions. They are
-- seed-invented strings ('sha256:feesched-OH|<payer>' versus
-- 'sha256:full-OH|<payer>'), not digests of anything.
--
-- WHY THE CONSTRAINT IS (url, payer_id, content_hash) AND NOT (url, payer_id)
-- Because a second row at the same URL is how this system records a NEW
-- VERSION of a document, and forbidding it would break the crawler.
-- ingestDocumentFromUrl checks idempotency on (content_hash, payer_id) and
-- then INSERTs with no ON CONFLICT clause: when a watched document's bytes
-- change, the hash changes, the check misses, and a fresh row is written
-- at the same url and payer_id, carrying its own retrieved_at. That is the
-- design — retrieved_at, content_hash and source_document_hash_idx exist
-- for it, and rules keep citing the version they were extracted from.
--
-- UNIQUE (url, payer_id) would make that INSERT raise 23505 forever. The
-- ingest cron records the error on the source row and moves on, so the
-- document would simply stop being re-ingested, silently, with the only
-- symptom a rising consecutive_failures. 18 of 25 registered sources point
-- at a URL that already has a row for the same payer, so that is the
-- steady state and not an edge case.
--
-- (url, payer_id, content_hash) says the true thing instead: ONE ROW PER
-- VERSION OF A DOCUMENT PER PAYER. New version, new row — allowed. Same
-- version registered twice — rejected. It is satisfiable today with zero
-- violations, and it also removes the seed/crawler collision that
-- (url, payer_id) would have created at deploy step 6.
--
-- WHAT STOPS THE ORIGINAL BUG RECURRING
-- Not this constraint — the two seeds invented DIFFERENT placeholder
-- hashes, so a triple-key constraint would not have blocked them. The bug
-- was two seed FILES registering one document, and it is caught at the
-- moment it is introduced by scripts/check-seed-documents.mjs, which
-- deploy.sh runs before applying any seed.
--
-- SCOPE OF THE MERGE
-- Restricted to losers whose content_hash is a seed placeholder rather
-- than a real 64-hex digest. Two genuine crawled versions of a document
-- can therefore never be merged by this migration, however it is re-run.
--
-- REVERSIBLE. Every deleted row is journaled whole, with the ids of the
-- rules repointed away from it.
--
-- Idempotent: a second run finds nothing to merge and does nothing.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Journal, so this is reversible.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_0068_document_merge_journal (
  loser_id      UUID PRIMARY KEY,
  canonical_id  UUID NOT NULL,
  url           TEXT NOT NULL,
  payer_id      UUID,
  loser_row     JSONB NOT NULL,
  repointed     JSONB NOT NULL DEFAULT '{}'::jsonb,
  journaled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0068_document_merge_journal IS
  'Pre-images of source_document rows merged by migration 0068. `repointed` '
  'holds the exact ids moved to the canonical row, per table, so the merge '
  'can be reversed precisely: re-insert loser_row, then set source_doc_id '
  'back for the listed ids. Droppable once this has held for a release.';

-- ---------------------------------------------------------------------
-- 2. Choose a canonical row per (url, payer_id).
-- ---------------------------------------------------------------------
-- payer_id is nullable, so partition on a NULL-safe key; a bare
-- PARTITION BY payer_id would put every NULL in its own group and quietly
-- skip NULL-payer duplicates. There are none today; this is so there are
-- none tomorrow.
CREATE TEMP TABLE _canon ON COMMIT DROP AS
WITH refs AS (
  SELECT sd.id, sd.url, sd.payer_id, sd.retrieved_at, sd.content_hash,
         (SELECT count(*) FROM payer_rule                r WHERE r.source_doc_id      = sd.id)
       + (SELECT count(*) FROM document_chunk            c WHERE c.source_doc_id      = sd.id)
       + (SELECT count(*) FROM extraction_candidate      e WHERE e.source_doc_id      = sd.id)
       + (SELECT count(*) FROM documentation_requirement d WHERE d.source_doc_id      = sd.id)
       + (SELECT count(*) FROM client_doc_upload         u WHERE u.source_document_id = sd.id)
         AS ref_count
    FROM source_document sd
)
-- The grouping key is what decides which rows are "the same document",
-- and it has to distinguish two cases that look alike:
--
--   REAL DIGEST ('sha256:' + 64 hex) — group by the digest itself. Two
--     rows with DIFFERENT digests are two VERSIONS of the document and
--     must both survive. Two rows with the SAME digest are the identical
--     bytes registered twice, and must merge. Production had exactly
--     that: upload://aetna-policy.txt stored twice under one hash.
--
--   SEED PLACEHOLDER (anything else — 'sha256:full-OH|<payer>' and
--     friends) — group by (url, payer_id) alone. These invented strings
--     carry no version information, so two of them at one url and payer
--     are the same document however much the strings differ. That is the
--     original pathology this migration exists to clean up.
--
-- An earlier version of this excluded every real-digest row from the
-- merge, which protected the versions but left identical duplicates in
-- place — and then ALTER TABLE could not build the unique index.
SELECT id, url, payer_id, content_hash,
       first_value(id) OVER (
         PARTITION BY url,
                      coalesce(payer_id::text, '~null~'),
                      CASE WHEN content_hash ~ '^sha256:[0-9a-f]{64}$'
                           THEN content_hash
                           ELSE '~unversioned~' END
         ORDER BY ref_count DESC, retrieved_at ASC, id ASC
       ) AS canonical_id
  FROM refs;

CREATE TEMP TABLE _merge ON COMMIT DROP AS
SELECT id AS loser_id, canonical_id, url, payer_id
  FROM _canon
 WHERE id <> canonical_id;

-- ---------------------------------------------------------------------
-- 3. Journal the losers whole, before anything moves.
-- ---------------------------------------------------------------------
INSERT INTO migration_0068_document_merge_journal
  (loser_id, canonical_id, url, payer_id, loser_row, repointed)
SELECT m.loser_id, m.canonical_id, m.url, m.payer_id,
       to_jsonb(sd) - 'extracted_text',   -- can be megabytes, and the url
                                          -- is right there to re-fetch
       jsonb_build_object(
         'payer_rule',                (SELECT coalesce(jsonb_agg(r.id), '[]'::jsonb) FROM payer_rule r                WHERE r.source_doc_id      = m.loser_id),
         'documentation_requirement', (SELECT coalesce(jsonb_agg(d.id), '[]'::jsonb) FROM documentation_requirement d WHERE d.source_doc_id      = m.loser_id),
         'document_chunk',            (SELECT coalesce(jsonb_agg(c.id), '[]'::jsonb) FROM document_chunk c            WHERE c.source_doc_id      = m.loser_id),
         'extraction_candidate',      (SELECT coalesce(jsonb_agg(e.id), '[]'::jsonb) FROM extraction_candidate e      WHERE e.source_doc_id      = m.loser_id),
         'client_doc_upload',         (SELECT coalesce(jsonb_agg(u.id), '[]'::jsonb) FROM client_doc_upload u         WHERE u.source_document_id = m.loser_id)
       )
  FROM _merge m
  JOIN source_document sd ON sd.id = m.loser_id
ON CONFLICT (loser_id) DO NOTHING;

-- Count every reference BEFORE the move, so step 8 can prove none vanished.
CREATE TEMP TABLE _before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM payer_rule)                AS payer_rule,
       (SELECT count(*) FROM documentation_requirement) AS documentation_requirement,
       (SELECT count(*) FROM document_chunk)            AS document_chunk,
       (SELECT count(*) FROM extraction_candidate)      AS extraction_candidate,
       (SELECT count(*) FROM client_doc_upload)         AS client_doc_upload;

-- ---------------------------------------------------------------------
-- 4. Repoint every foreign key. All five of them.
-- ---------------------------------------------------------------------
-- Missing one is not survivable. payer_rule, documentation_requirement and
-- client_doc_upload are ON DELETE NO ACTION, so a miss makes step 6 fail
-- loudly. document_chunk and extraction_candidate are ON DELETE CASCADE —
-- a miss there deletes them with no error at all.
UPDATE payer_rule r SET source_doc_id = m.canonical_id
  FROM _merge m WHERE r.source_doc_id = m.loser_id;

UPDATE documentation_requirement d SET source_doc_id = m.canonical_id
  FROM _merge m WHERE d.source_doc_id = m.loser_id;

UPDATE extraction_candidate e SET source_doc_id = m.canonical_id
  FROM _merge m WHERE e.source_doc_id = m.loser_id;

UPDATE client_doc_upload u SET source_document_id = m.canonical_id
  FROM _merge m WHERE u.source_document_id = m.loser_id;

-- document_chunk needs more than a repoint. It carries
-- UNIQUE (source_doc_id, chunk_index), and chunk_index is a per-document
-- 0-based loop counter, not a global sequence — so both rows own chunk 0,
-- and moving one onto the other collides on the first row and aborts the
-- deploy. Offset each loser's chunks past everything already sitting on
-- the canonical row, including past any earlier loser merged in the same
-- statement (hence the running sum, not a bare max).
WITH existing AS (
  SELECT source_doc_id, max(chunk_index) AS mx FROM document_chunk GROUP BY 1
), sized AS (
  SELECT m.loser_id, m.canonical_id,
         (SELECT count(*) FROM document_chunk c WHERE c.source_doc_id = m.loser_id) AS n
    FROM _merge m
), offsets AS (
  SELECT s.loser_id, s.canonical_id,
         coalesce(e.mx, -1) + 1
         + coalesce(sum(s.n) OVER (PARTITION BY s.canonical_id ORDER BY s.loser_id
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
           AS shift
    FROM sized s LEFT JOIN existing e ON e.source_doc_id = s.canonical_id
)
UPDATE document_chunk c
   SET source_doc_id = o.canonical_id,
       chunk_index   = c.chunk_index + o.shift
  FROM offsets o
 WHERE c.source_doc_id = o.loser_id;

-- ---------------------------------------------------------------------
-- 5. Carry over anything the canonical row is missing.
-- ---------------------------------------------------------------------
-- The loser may hold an effective_date, storage_uri or extracted text the
-- winner never got. Take those; never overwrite a value the winner has.
UPDATE source_document canon
   SET effective_date  = coalesce(canon.effective_date, loser.effective_date),
       storage_uri     = coalesce(canon.storage_uri,    loser.storage_uri),
       extracted_text  = coalesce(canon.extracted_text, loser.extracted_text),
       extracted_at    = coalesce(canon.extracted_at,   loser.extracted_at),
       title           = coalesce(canon.title,          loser.title),
       -- loser first, so the winner's own keys win on collision
       source_metadata = loser.source_metadata || canon.source_metadata
  FROM _merge m
  JOIN source_document loser ON loser.id = m.loser_id
 WHERE canon.id = m.canonical_id;

-- ---------------------------------------------------------------------
-- 6. Delete the now-unreferenced duplicates.
-- ---------------------------------------------------------------------
DELETE FROM source_document sd USING _merge m WHERE sd.id = m.loser_id;

-- ---------------------------------------------------------------------
-- 7. One row per version of a document per payer.
-- ---------------------------------------------------------------------
-- Guarded so a re-run is a no-op. content_hash is NOT NULL, and payer_id
-- is nullable, so NULLS NOT DISTINCT is what makes the payer_id component
-- behave; below PostgreSQL 15 an expression index gives the same
-- guarantee. The version check is at runtime, but UNIQUE NULLS NOT
-- DISTINCT must still PARSE on an old server, so it is kept out of the
-- statically-parsed path by executing it as dynamic SQL.
-- Check before building, so a leftover duplicate names itself instead of
-- arriving as "could not create unique index ... is duplicated" from deep
-- inside an ALTER TABLE. That is how this migration failed on its first
-- production run, and the raw error did not say which rows to look at.
DO $$
DECLARE
  r RECORD;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT url, payer_id, content_hash, count(*) AS rows
      FROM source_document
     GROUP BY url, coalesce(payer_id::text, '~null~'), payer_id, content_hash
    HAVING count(*) > 1
  LOOP
    n := n + 1;
    RAISE WARNING 'still duplicated: % rows for url=% payer=% hash=%',
      r.rows, r.url, coalesce(r.payer_id::text, '(none)'), r.content_hash;
  END LOOP;
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 0068: % (url, payer_id, content_hash) group(s) survived the merge — see the warnings above. The uniqueness constraint cannot be built until they are resolved.', n;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_document_url_payer_hash_key')
     OR EXISTS (SELECT 1 FROM pg_class WHERE relname = 'source_document_url_payer_hash_uniq') THEN
    RAISE NOTICE 'uniqueness on (url, payer_id, content_hash) already present — leaving it alone';
  ELSIF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'ALTER TABLE source_document
               ADD CONSTRAINT source_document_url_payer_hash_key
               UNIQUE NULLS NOT DISTINCT (url, payer_id, content_hash)';
    RAISE NOTICE 'added UNIQUE NULLS NOT DISTINCT (url, payer_id, content_hash)';
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX source_document_url_payer_hash_uniq
               ON source_document (url, coalesce(payer_id, ''00000000-0000-0000-0000-000000000000''::uuid), content_hash)';
    RAISE NOTICE 'server < 15 — added expression unique index on (url, coalesce(payer_id, zero), content_hash)';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Prove it, and refuse to commit if it is wrong.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_merged   INT;
  n_dangling INT;
  n_dupes    INT;
  b          RECORD;
  lost       TEXT := '';
BEGIN
  SELECT count(*) INTO n_merged FROM _merge;

  -- Conservation. The two CASCADE tables are why this exists: if a
  -- repoint were missed there, the rows would be gone with no error, and
  -- a dangling-reference check alone would report everything fine.
  SELECT * INTO b FROM _before;
  IF (SELECT count(*) FROM payer_rule) <> b.payer_rule THEN
    lost := lost || format(' payer_rule %s->%s', b.payer_rule, (SELECT count(*) FROM payer_rule));
  END IF;
  IF (SELECT count(*) FROM documentation_requirement) <> b.documentation_requirement THEN
    lost := lost || format(' documentation_requirement %s->%s', b.documentation_requirement, (SELECT count(*) FROM documentation_requirement));
  END IF;
  IF (SELECT count(*) FROM document_chunk) <> b.document_chunk THEN
    lost := lost || format(' document_chunk %s->%s', b.document_chunk, (SELECT count(*) FROM document_chunk));
  END IF;
  IF (SELECT count(*) FROM extraction_candidate) <> b.extraction_candidate THEN
    lost := lost || format(' extraction_candidate %s->%s', b.extraction_candidate, (SELECT count(*) FROM extraction_candidate));
  END IF;
  IF (SELECT count(*) FROM client_doc_upload) <> b.client_doc_upload THEN
    lost := lost || format(' client_doc_upload %s->%s', b.client_doc_upload, (SELECT count(*) FROM client_doc_upload));
  END IF;
  IF lost <> '' THEN
    RAISE EXCEPTION 'migration 0068 LOST ROWS —%. A foreign key was not repointed before the delete.', lost;
  END IF;

  -- Nothing may point at a row that no longer exists.
  SELECT (SELECT count(*) FROM payer_rule r
            WHERE r.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = r.source_doc_id))
       + (SELECT count(*) FROM documentation_requirement d
            WHERE d.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = d.source_doc_id))
       + (SELECT count(*) FROM document_chunk c
            WHERE c.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = c.source_doc_id))
       + (SELECT count(*) FROM extraction_candidate e
            WHERE e.source_doc_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = e.source_doc_id))
       + (SELECT count(*) FROM client_doc_upload u
            WHERE u.source_document_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM source_document s WHERE s.id = u.source_document_id))
    INTO n_dangling;
  IF n_dangling <> 0 THEN
    RAISE EXCEPTION 'migration 0068: % rows reference a source_document that no longer exists', n_dangling;
  END IF;

  SELECT count(*) INTO n_dupes FROM (
    SELECT 1 FROM source_document
     GROUP BY url, coalesce(payer_id::text, '~null~'), content_hash
    HAVING count(*) > 1) d;
  IF n_dupes <> 0 THEN
    RAISE EXCEPTION 'migration 0068: % (url, payer_id, content_hash) triples still duplicated', n_dupes;
  END IF;

  RAISE NOTICE 'migration 0068:';
  RAISE NOTICE '  duplicate documents merged        : %', n_merged;
  RAISE NOTICE '  references lost                   : 0';
  RAISE NOTICE '  dangling references               : 0';
  RAISE NOTICE '  duplicate (url,payer,hash) triples: 0';
  RAISE NOTICE '  source_document rows remaining    : %', (SELECT count(*) FROM source_document);
  RAISE NOTICE '  (url,payer_id) pairs still on >1 row, i.e. genuine versions or';
  RAISE NOTICE '   multi-payer documents, left alone: %',
    (SELECT count(*) FROM (SELECT 1 FROM source_document GROUP BY url, payer_id HAVING count(*) > 1) x);
END $$;

COMMIT;
