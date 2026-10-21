-- ============================================================================
-- 0094_superbill_pricing.sql
--
-- Audit R33. Every claim was priced from a hardcoded 2025 Medicare table,
-- whatever the payer — the superbill page showed the payer's rate in its rule
-- check and billed the claim at a different figure on the same screen — and a
-- saved bill could not say where its amount came from.
--
-- The billed amount now comes from the payer's rate on file for the date of
-- service where one exists (payer_rule 'covered' value.rate), falling back to
-- the reference table with a verify warning. This records, per line, which
-- source priced it, so the bill page, a biller and an auditor can see why the
-- claim says what it says, and so an edit can reprice at the same tier.
-- ============================================================================

ALTER TABLE superbill ADD COLUMN IF NOT EXISTS pricing JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN superbill.pricing IS
  'How billed_amount_cents was priced: {tier, lines:[{code, rateCents, source (payer_fee_schedule | reference_table | unrated), payerRuleId, rateBasis, effectiveDate}]}. {} on bills priced before 0094.';
