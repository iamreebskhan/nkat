-- ============================================================================
-- 0004_document_chunks.sql
-- Vector embeddings for citation-grounded retrieval.
-- Global table; document chunks are extracted from authoritative public sources.
-- ============================================================================

CREATE TABLE document_chunk (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_doc_id       UUID        NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  chunk_index         INT         NOT NULL,
  content             TEXT        NOT NULL,
  embedding           vector(1024),                            -- text-embedding-3-large @ 1024d Matryoshka, or Bedrock equivalent
  -- denormalized metadata for hot-path filters
  payer_id            UUID        REFERENCES payer(id),
  state               CHAR(2)     REFERENCES state(state),
  codes_mentioned     TEXT[]      NOT NULL DEFAULT '{}',       -- CPT/HCPCS
  icd10_mentioned     TEXT[]      NOT NULL DEFAULT '{}',
  modifiers_mentioned TEXT[]      NOT NULL DEFAULT '{}',
  pos_mentioned       TEXT[]      NOT NULL DEFAULT '{}',
  taxonomy_mentioned  TEXT[]      NOT NULL DEFAULT '{}',
  policy_section      TEXT,                                    -- 'Coverage Criteria','Documentation','Modifiers',...
  token_count         INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_doc_id, chunk_index)
);

-- HNSW vector index. m=16, ef_construction=64 are reasonable defaults for our scale.
-- ef_search is set per-query at runtime (typical 100-200).
CREATE INDEX document_chunk_embedding_hnsw ON document_chunk
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN indexes for array-based metadata filters.
CREATE INDEX document_chunk_codes_gin ON document_chunk USING GIN (codes_mentioned);
CREATE INDEX document_chunk_icd10_gin ON document_chunk USING GIN (icd10_mentioned);
CREATE INDEX document_chunk_modifiers_gin ON document_chunk USING GIN (modifiers_mentioned);

-- B-tree for cheap (payer_id, state) prefilter before vector scan.
CREATE INDEX document_chunk_payer_state_idx ON document_chunk (payer_id, state);

-- Full-text search column for hybrid lexical + vector retrieval.
ALTER TABLE document_chunk ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX document_chunk_tsv_idx ON document_chunk USING GIN (content_tsv);

COMMENT ON TABLE document_chunk IS
  'Embedded chunks of authoritative source documents. Filtered by metadata + HNSW vector + tsvector hybrid retrieval.';
