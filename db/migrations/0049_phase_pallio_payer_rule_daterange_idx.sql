-- ============================================================================
-- 0049 — Date-range index on payer_rule for the allowed-codes hot path.
--
-- payer_allowed_codes_v + getAllowedCodesForPayer filter on
-- (payer_id, state) with an effective_date <= dos and
-- (expiration_date IS NULL OR expiration_date > dos) window, plus
-- superseded_by IS NULL. The existing payer_rule_lookup_idx leads with
-- product_line/code/attribute, which doesn't serve a (payer,state)+date
-- range scan as well. This index targets exactly that access pattern.
-- ============================================================================

CREATE INDEX IF NOT EXISTS payer_rule_date_range_idx
  ON payer_rule (payer_id, state, effective_date, expiration_date)
  WHERE superseded_by IS NULL;

COMMENT ON INDEX payer_rule_date_range_idx IS
  'Phase 0/A: serves payer_allowed_codes_v (payer,state)+active-date-window scans.';
