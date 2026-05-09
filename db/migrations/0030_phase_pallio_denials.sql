-- ============================================================================
-- 0030_phase_pallio_denials.sql
-- Phase 4 — per-superbill denial workflow.
--
-- The existing `denial_event` table from 0006 is a nightly *aggregate* rollup
-- (denials grouped by org+payer+code+carc+period). Pallio's clinical+billing
-- integration needs a per-superbill record so the billing agent can:
--   - Log a single denial against a specific superbill
--   - See AI analysis (likely cause + refile recommendation, citation-grounded)
--   - Decide refile / write-off / appeal
--   - Track the outcome (paid / partial / secondary denial)
--
-- AI fields are populated lazily by /api/denials/[id]/analyze. Decision +
-- outcome fields are clinician-facing workflow state.
-- ============================================================================

CREATE TABLE superbill_denial (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  superbill_id             UUID        NOT NULL REFERENCES superbill(id) ON DELETE CASCADE,

  -- Claim context — frozen at denial time so future schema changes don't drift.
  payer_id                 UUID        REFERENCES payer(id),
  cpt_code                 TEXT        NOT NULL,
  icd10_codes              TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  modifiers                TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Denial signal
  carc_code                TEXT        NOT NULL,                   -- Claim Adjustment Reason Code (e.g. CO-50)
  rarc_code                TEXT,                                   -- Remittance Advice Remark Code (optional)
  group_code               TEXT,                                   -- CO/PR/OA/PI
  denial_reason            TEXT,                                   -- free-text from EOB
  denied_amount_cents      BIGINT      NOT NULL DEFAULT 0,
  denied_at                TIMESTAMPTZ NOT NULL,

  -- AI analysis (lazy)
  ai_analysis_text         TEXT,
  ai_likely_cause          TEXT,
  ai_recommendation        TEXT        CHECK (ai_recommendation IN
                                          ('refile', 'write_off', 'appeal', 'unknown')),
  ai_citation_doc_name     TEXT,
  ai_citation_quote        TEXT,
  ai_analyzed_at           TIMESTAMPTZ,
  ai_model_version         TEXT,

  -- Resolution decision
  decision                 TEXT        NOT NULL DEFAULT 'pending'
                                       CHECK (decision IN
                                          ('pending', 'refile', 'write_off', 'appeal')),
  decision_at              TIMESTAMPTZ,
  decision_by_user_id      UUID        REFERENCES app_user(id),
  decision_notes           TEXT,

  -- Refile / outcome tracking
  refiled_at               TIMESTAMPTZ,
  outcome                  TEXT        NOT NULL DEFAULT 'pending'
                                       CHECK (outcome IN
                                          ('pending', 'paid', 'partially_paid',
                                           'secondary_denial', 'written_off')),
  outcome_at               TIMESTAMPTZ,
  outcome_amount_cents     BIGINT,
  outcome_notes            TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX superbill_denial_org_status_idx
  ON superbill_denial (org_id, decision, denied_at DESC);

CREATE INDEX superbill_denial_superbill_idx
  ON superbill_denial (superbill_id);

CREATE INDEX superbill_denial_payer_carc_idx
  ON superbill_denial (org_id, payer_id, carc_code);

-- One pending decision per (superbill, cpt_code, carc) — re-denials of the
-- same line item update the existing row rather than appending. Resolved
-- denials (decision != 'pending') don't block new rows.
CREATE UNIQUE INDEX superbill_denial_pending_unique_idx
  ON superbill_denial (superbill_id, cpt_code, carc_code)
  WHERE decision = 'pending';

COMMENT ON TABLE superbill_denial IS
  'Per-superbill denial workflow: log denial → AI analysis → decision → outcome.';

SELECT app.apply_tenant_rls('superbill_denial');
