-- ============================================================================
-- 0027_phase65_final_rule_doctype.sql
-- Phase 65 — add `cms_final_rule` to the source_document.document_type
-- CHECK constraint.
--
-- CMS Final Rules (PFS, OPPS, IPPS, Hospice Wage Index, etc.) are
-- distinct from MLN articles or LCDs — they're the legal regulatory
-- documents that drive every other CMS payment update. The analyst
-- queue treats them as their own track because the extraction
-- pipeline produces a different rule shape (whole-rule references
-- vs single-code carve-outs).
-- ============================================================================

ALTER TABLE source_document DROP CONSTRAINT IF EXISTS source_document_document_type_check;

ALTER TABLE source_document
  ADD CONSTRAINT source_document_document_type_check
  CHECK (document_type IN (
    'medical_policy', 'reimbursement_policy', 'provider_manual',
    'mln_article', 'ncd', 'lcd', 'lcd_article', 'cms_pfs',
    'cms_coverage_api', 'hcpcs_release', 'ncci_release',
    'analyst_call', 'client_upload', 'cms_0057_pa_api',
    'state_medicaid_manual', 'wc_fee_schedule', 'ihs_rate',
    'cms_final_rule'
  ));
