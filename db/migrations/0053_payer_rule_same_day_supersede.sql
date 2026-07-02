-- ============================================================================
-- 0053 — allow same-day supersession of a payer_rule.
--
-- payer_rule versions by INSERT + expiring the prior row (set expiration_date,
-- never UPDATE the value). The original table CHECK required
--   expiration_date > effective_date   (strictly greater)
-- so expiring a rule on the SAME DAY it was created violated the constraint.
--
-- That day-zero case is rare in normal ingestion (each (payer,state,code,
-- attribute) key appears once per document) but constant during CHUNKED
-- ingestion of a large ruling: the CY2026 PFS final rule (1,216 pages) mentions
-- the same code across many chunks, so chunk N's insert tries to expire chunk
-- 1's same-day row → 23514 check_violation → the whole chunk's write aborts.
--
-- Widen to >= so a rule can be superseded the same day (the replacement carries
-- expiration_date = NULL and stays the active row; the superseded row gets a
-- non-null expiration and drops out of active lookups). Widening only — every
-- existing row already satisfies the stricter '>'.
-- ============================================================================

ALTER TABLE payer_rule DROP CONSTRAINT payer_rule_check;
ALTER TABLE payer_rule ADD CONSTRAINT payer_rule_check
  CHECK (expiration_date IS NULL OR expiration_date >= effective_date);
