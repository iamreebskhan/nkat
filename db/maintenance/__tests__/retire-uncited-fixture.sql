-- Fixture for retire-uncited-document-versions.sql.
--
-- Cases A and B replicate production EXACTLY as measured 2026-08-11.
-- Cases C-G are shapes production does not have today, but the script runs
-- every deploy forever, so it has to survive them too.
--
-- Every id starts dd000000 so teardown is one DELETE.

BEGIN;

DELETE FROM payer_rule      WHERE created_by = 'fixture:retire';
DELETE FROM document_chunk  WHERE source_doc_id::text LIKE 'dd000000%';
DELETE FROM source_document WHERE id::text LIKE 'dd000000%';

-- A version. p_seq drives both the id and the age, so version 1 is newest.
CREATE OR REPLACE FUNCTION _fx_ver(p_case int, p_seq int, p_url text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  -- last UUID group is 12 hex digits: 2 for the case, 10 for the sequence.
  v_id := ('dd000000-0000-4000-8000-' || lpad(to_hex(p_case), 2, '0')
           || lpad(p_seq::text, 10, '0'))::uuid;
  INSERT INTO source_document (id, url, document_type, title, retrieved_at, content_hash)
  VALUES (v_id, p_url, 'medical_policy', 'fixture ' || chr(64 + p_case) || ' v' || p_seq,
          now() - (p_seq || ' days')::interval,
          'sha256:' || md5(v_id::text) || md5(v_id::text || 'x'));
  RETURN v_id;
END $$;

-- Chunks. p_embedded decides only whether `embedding` is NULL -- that is
-- the whole distinction the retirement rule cares about.
--
-- The literal has to be built dynamically because the column's type is not
-- the same everywhere: production runs pgvector and the column is
-- vector(1024), while a dev box without the extension has it as bytea.
-- Hardcoding either one makes this fixture fail on the other, which would
-- mean the test cannot run where the real data lives.
CREATE OR REPLACE FUNCTION _fx_chunks(p_id uuid, p_n int, p_embedded boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
  v_dims int;
  v_lit  text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod), t.typname
    INTO v_lit, v_type
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = 'document_chunk'::regclass AND a.attname = 'embedding';

  IF NOT p_embedded THEN
    v_lit := 'NULL';
  ELSIF v_type = 'vector' THEN
    -- format_type gives 'vector(1024)'. Build [1,0,0,...] of that width --
    -- NOT an all-zero vector: cosine distance is undefined for one, and
    -- document_chunk carries an HNSW vector_cosine_ops index. The
    -- retirement only ever tests IS NOT NULL, so the direction is
    -- arbitrary; it just has to be a legal one.
    v_dims := coalesce(nullif(regexp_replace(v_lit, '\D', '', 'g'), '')::int, 3);
    v_lit  := quote_literal('[1' || repeat(',0', v_dims - 1) || ']') || '::vector';
  ELSE
    v_lit := quote_literal('\x0102') || '::' || v_type;
  END IF;

  EXECUTE format(
    'INSERT INTO document_chunk (source_doc_id, chunk_index, content, embedding)
     SELECT %L, g, ''identical chunk text '' || g, %s FROM generate_series(1, %s) g',
    p_id, v_lit, p_n);
END $$;

-- Rules citing a version. Cloned from a real row through jsonb so every
-- NOT NULL and check constraint is satisfied without listing 30 columns.
CREATE OR REPLACE FUNCTION _fx_rules(p_id uuid, p_n int, p_tag text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i INT;
BEGIN
  FOR i IN 1..p_n LOOP
    INSERT INTO payer_rule
    SELECT (jsonb_populate_record(NULL::payer_rule,
              to_jsonb(pr) || jsonb_build_object(
                'id',            gen_random_uuid(),
                'source_doc_id', p_id,
                'created_by',    'fixture:retire',
                'code',          'FX' || p_tag || i))).*
      FROM payer_rule pr
     WHERE pr.source_doc_id IS NOT NULL
     LIMIT 1;
  END LOOP;
END $$;

DO $$
DECLARE v uuid; i INT;
BEGIN
  -- === A. THE AETNA SHAPE (production, exact) ==============================
  -- 13 versions. Newest has chunks. Versions 2-12 are identical duplicates
  -- with chunks and nothing else. The OLDEST has NO chunks and carries all
  -- 6 rule citations.
  -- EXPECT: retire 11 (v2..v12). Keep v1 (newest, has the text) and v13
  -- (cited). Chunks removed = 11 * 5.
  FOR i IN 1..13 LOOP
    v := _fx_ver(1, i, 'https://fixture.test/aetna/0009.html');
    IF i <= 12 THEN PERFORM _fx_chunks(v, 5, true); END IF;
    IF i  = 13 THEN PERFORM _fx_rules(v, 6, 'A'); END IF;
  END LOOP;

  -- === B. THE FEDERAL REGISTER SHAPE (production, scaled 35 -> 8) =========
  -- No chunks anywhere. The three oldest carry the rules.
  -- EXPECT: retire 4 (v2..v5). Keep v1 (newest) and v6,v7,v8 (cited).
  FOR i IN 1..8 LOOP
    v := _fx_ver(2, i, 'https://fixture.test/fr/2025-19787.pdf');
    IF i >= 6 THEN PERFORM _fx_rules(v, 2, 'B' || i); END IF;
  END LOOP;

  -- === C. RESCUE: only an uncited middle version holds the text ===========
  -- Newest has no chunks; the cited oldest has no chunks; the ONLY chunks
  -- live on an uncited middle version. Deleting it would drop the document
  -- out of retrieval entirely.
  -- EXPECT: retire 0 — v2 is rescued.
  v := _fx_ver(3, 1, 'https://fixture.test/rescue-chunks');
  v := _fx_ver(3, 2, 'https://fixture.test/rescue-chunks'); PERFORM _fx_chunks(v, 4, true);
  v := _fx_ver(3, 3, 'https://fixture.test/rescue-chunks'); PERFORM _fx_rules(v, 1, 'C');

  -- === D. RESCUE: kept set has chunks, but none EMBEDDED ==================
  -- Newest has chunks with NULL embeddings — present but not retrievable by
  -- vector search. An uncited middle version has the embedded copies.
  -- EXPECT: retire 0 — v2 is rescued on the embedding branch.
  v := _fx_ver(4, 1, 'https://fixture.test/rescue-embedded'); PERFORM _fx_chunks(v, 3, false);
  v := _fx_ver(4, 2, 'https://fixture.test/rescue-embedded'); PERFORM _fx_chunks(v, 3, true);
  v := _fx_ver(4, 3, 'https://fixture.test/rescue-embedded'); PERFORM _fx_rules(v, 1, 'D');

  -- === E. a single version, cited by nothing ==============================
  -- EXPECT: retire 0 — it is the newest, and there is nothing else.
  v := _fx_ver(5, 1, 'https://fixture.test/single');

  -- === F. every version cited =============================================
  -- EXPECT: retire 0.
  FOR i IN 1..3 LOOP
    v := _fx_ver(6, i, 'https://fixture.test/all-cited');
    PERFORM _fx_rules(v, 1, 'F' || i);
  END LOOP;

  -- === G. dead middle, no chunks anywhere =================================
  -- Nothing to rescue, so the rescue must NOT fire and block the delete.
  -- EXPECT: retire 3 (v2,v3,v4).
  FOR i IN 1..4 LOOP
    v := _fx_ver(7, i, 'https://fixture.test/dead-middle');
  END LOOP;
END $$;

DROP FUNCTION _fx_ver(int, int, text);
DROP FUNCTION _fx_chunks(uuid, int, boolean);
-- (signature unchanged; only the body became type-aware)
DROP FUNCTION _fx_rules(uuid, int, text);

COMMIT;
