-- ============================================================================
-- 0041 — payer_allowed_codes_v: the "what does this payer cover" view.
--
-- Powers Phase A's payer-scoped CPT picker on the super-bill and Phase B's
-- pre-submission denial predictor.
--
-- Returns one row per (payer, state, code) where:
--   * a "covered" attribute row exists in payer_rule
--   * the rule is currently active (effective_date <= today < expiration_date)
--   * the code itself is still active in the `code` reference table
--
-- Each row carries the joined metadata the picker needs (descriptor,
-- category), the provenance (sourceKind derived from created_by), the
-- confidence, and the related-attribute hints we already store in
-- payer_rule (prior_auth_required, modifier_required, frequency_limit).
--
-- We do NOT include "denied" / "not_covered" rows here. The picker will
-- ask for those via a separate ?includeDenied=true flag when the nurse
-- explicitly wants the override-allowed view; the predictor (Phase B)
-- has its own coverage-status query.
--
-- The view is global (no RLS). It's reference data: the same answer for
-- every org.
-- ============================================================================

CREATE OR REPLACE VIEW payer_allowed_codes_v AS
WITH active_covered AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.product_line,
    pr.code,
    pr.coverage_status,
    pr.confidence,
    pr.effective_date,
    pr.expiration_date,
    pr.value           AS rule_value,
    pr.source_doc_id,
    pr.source_quote,
    pr.created_by,
    pr.created_at,
    pr.id              AS payer_rule_id
  FROM payer_rule pr
  WHERE pr.attribute = 'covered'
    AND pr.coverage_status IN ('covered', 'varies')
    AND pr.effective_date <= CURRENT_DATE
    AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
    AND pr.superseded_by IS NULL
),
-- Sibling rules in the same (payer, state, code) group that flag hints.
-- We surface modifier_required, prior_auth_required, frequency_limit as
-- booleans + values the picker can show inline. The presence of a row
-- means "yes, this hint applies."
hints AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.code,
    BOOL_OR(pr.attribute = 'modifier_required')   AS modifier_required,
    BOOL_OR(pr.attribute = 'prior_auth_required') AS prior_auth_required,
    BOOL_OR(pr.attribute = 'frequency_limit')     AS has_frequency_limit,
    -- pull the first frequency_limit value we find for display
    MAX(CASE WHEN pr.attribute = 'frequency_limit' THEN pr.value::text END)
      AS frequency_limit_value,
    MAX(CASE WHEN pr.attribute = 'prior_auth_required' THEN pr.value::text END)
      AS prior_auth_value
  FROM payer_rule pr
  WHERE pr.attribute IN ('modifier_required','prior_auth_required','frequency_limit')
    AND pr.effective_date <= CURRENT_DATE
    AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
    AND pr.superseded_by IS NULL
  GROUP BY pr.payer_id, pr.state, pr.code
)
SELECT
  ac.payer_id,
  ac.state,
  ac.product_line,
  ac.code,
  c.short_descriptor                                  AS descriptor,
  c.category                                          AS category,
  c.code_system                                       AS code_system,
  ac.coverage_status,
  ac.confidence,
  ac.rule_value,
  ac.effective_date,
  ac.expiration_date,
  ac.source_doc_id,
  ac.source_quote,
  ac.created_by,
  ac.created_at                                       AS rule_created_at,
  ac.payer_rule_id,
  -- Provenance derived from created_by (matches getRulebook's logic).
  CASE
    WHEN ac.created_by IN ('crawler','cms') THEN 'crawler'
    WHEN ac.created_by = 'ai'                THEN 'ai'
    WHEN ac.created_by = 'manual'            THEN 'manual'
    WHEN ac.created_by LIKE '%@%'            THEN 'analyst'
    ELSE 'unknown'
  END                                                 AS source_kind,
  COALESCE(h.modifier_required, FALSE)                AS modifier_required,
  COALESCE(h.prior_auth_required, FALSE)              AS prior_auth_required,
  COALESCE(h.has_frequency_limit, FALSE)              AS has_frequency_limit,
  h.frequency_limit_value                             AS frequency_limit_value,
  h.prior_auth_value                                  AS prior_auth_value
FROM active_covered ac
JOIN code c
  ON c.code = ac.code
 AND c.effective_date <= CURRENT_DATE
 AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
LEFT JOIN hints h
  ON h.payer_id = ac.payer_id
 AND h.state    = ac.state
 AND h.code     = ac.code;

COMMENT ON VIEW payer_allowed_codes_v IS
  'One row per (payer, state, active CPT/HCPCS) the payer covers, with descriptor, provenance, confidence, and modifier/PA/frequency hints. Phase A (picker) + Phase B (predictor) read from here.';
