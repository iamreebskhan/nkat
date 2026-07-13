-- 0056 — mark rule-producing source_documents as extracted.
--
-- The /documents page counts "Awaiting extraction" as source_document rows
-- with extracted_at IS NULL. Documents whose rules were loaded by SQL seed
-- (e.g. the CY2026 full-rule seed, b0000000-…-2026) or otherwise never went
-- through the live extraction pipeline kept extracted_at NULL — so a document
-- with hundreds of extracted rules still displayed as "awaiting extraction".
--
-- Truth source: a source_document IS extracted iff it produced payer_rule
-- rows. Backfill extracted_at + candidate count from that. Documents that
-- produced no rules stay pending (correct — nothing was extracted from them).

UPDATE source_document sd
   SET extracted_at = COALESCE(sd.extracted_at, sd.retrieved_at),
       extraction_candidate_count = sub.n
  FROM (
    SELECT source_doc_id, COUNT(*)::int AS n
    FROM payer_rule
    WHERE source_doc_id IS NOT NULL
    GROUP BY source_doc_id
  ) sub
 WHERE sd.id = sub.source_doc_id
   AND sd.extracted_at IS NULL;
