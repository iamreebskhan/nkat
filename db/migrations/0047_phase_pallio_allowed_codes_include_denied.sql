-- ============================================================================
-- 0047 — Extend payer_allowed_codes_v to include denied / unknown rows.
--
-- Phase A "Show all" affordance from the picker needs the view to also
-- surface coverage_status IN ('not_covered','unknown') so the nurse
-- can intentionally include them when they know better than the rules
-- (the override modal still records the reason in audit_log).
--
-- We REPLACE the view; downstream callers default to filtering to
-- covered/varies in the SQL service layer so existing behavior is
-- unchanged unless they opt in.
-- ============================================================================

CREATE OR REPLACE VIEW payer_allowed_codes_v AS
WITH active_status AS (
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
    AND pr.coverage_status IN ('covered', 'varies', 'not_covered', 'unknown')
    AND pr.effective_date <= CURRENT_DATE
    AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
    AND pr.superseded_by IS NULL
),
hints AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.code,
    BOOL_OR(pr.attribute = 'modifier_required')   AS modifier_required,
    BOOL_OR(pr.attribute = 'prior_auth_required') AS prior_auth_required,
    BOOL_OR(pr.attribute = 'frequency_limit')     AS has_frequency_limit,
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
FROM active_status ac
JOIN code c
  ON c.code = ac.code
 AND c.effective_date <= CURRENT_DATE
 AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
LEFT JOIN hints h
  ON h.payer_id = ac.payer_id
 AND h.state    = ac.state
 AND h.code     = ac.code;

COMMENT ON VIEW payer_allowed_codes_v IS
  'One row per (payer, state, active CPT/HCPCS) — all coverage statuses. Service layer filters by coverage_status; "show all" mode includes denied/unknown.';
