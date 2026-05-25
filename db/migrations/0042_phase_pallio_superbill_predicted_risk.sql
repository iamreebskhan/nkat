-- ============================================================================
-- 0042 — Pre-submission denial predictor: predicted_risk on superbill.
--
-- Phase B of the EMR-pivot plan. Every time a superbill is persisted
-- (POST /api/visits/[id]/superbill) we run the denial-risk primitive
-- against its draft lines and store the structured result here. Later,
-- when a denial comes back (superbill_denial), the nightly feedback
-- cron joins predicted_risk vs. actual outcome and writes per-rule
-- precision into denial_rule_metrics so we can tune weights.
--
-- Shape:
--   { worstBand, blockCount, highCount, mediumCount,
--     perLine: [ { code, score, riskBand, reasons[] } ],
--     ranAt }
-- ============================================================================

ALTER TABLE superbill
  ADD COLUMN IF NOT EXISTS predicted_risk JSONB;

CREATE INDEX IF NOT EXISTS superbill_predicted_risk_band_idx
  ON superbill ((predicted_risk->>'worstBand'))
  WHERE predicted_risk IS NOT NULL;

COMMENT ON COLUMN superbill.predicted_risk IS
  'Phase B denial-predictor output captured at persist-time. NULL for rows persisted before this migration. Drives the predicted-vs-actual feedback loop.';

-- ----------------------------------------------------------------------------
-- denial_rule_metrics: nightly aggregate of per-reason precision/recall.
-- One row per (reason_code) updated each night. The Phase B UI consults
-- the latest row to surface "Our predictor is X% accurate on this rule"
-- next to the risk badge.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS denial_rule_metrics (
  reason_code         TEXT       PRIMARY KEY,
  -- True positives: predictor said high/block AND a denial came back.
  true_positives      INT        NOT NULL DEFAULT 0,
  -- False positives: predictor said high/block AND no denial.
  false_positives     INT        NOT NULL DEFAULT 0,
  -- False negatives: predictor said low/medium AND a denial came back.
  false_negatives     INT        NOT NULL DEFAULT 0,
  -- Precision = TP / (TP + FP). NULL until we have data.
  precision_pct       NUMERIC(5,2),
  -- Recall = TP / (TP + FN). NULL until we have data.
  recall_pct          NUMERIC(5,2),
  sample_size         INT        NOT NULL DEFAULT 0,
  last_computed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE denial_rule_metrics IS
  'Phase B feedback loop: predictor vs. real-world denial accuracy per reason code. Updated by scripts/nightly-denial-feedback.mjs.';
