-- ============================================================================
-- 0028_phase69_final_rule_extraction.sql
-- Phase 69 — track extraction status on source_document.
--
-- The extraction worker scans `source_document` for rows whose
-- `extracted_at` is NULL and runs PDF→text → candidates against them.
-- This adds the bookkeeping columns + an index that lets the worker
-- find pending work efficiently.
-- ============================================================================

ALTER TABLE source_document
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS extraction_candidate_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extraction_error TEXT,
  ADD COLUMN IF NOT EXISTS extracted_text TEXT;

CREATE INDEX IF NOT EXISTS source_document_pending_extraction_idx
  ON source_document (retrieved_at)
  WHERE extracted_at IS NULL
    AND document_type IN ('cms_final_rule', 'mln_article', 'state_medicaid_manual');
