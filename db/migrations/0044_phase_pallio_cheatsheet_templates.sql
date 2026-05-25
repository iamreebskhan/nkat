-- ============================================================================
-- 0044 — Cheat-sheet operator review queue (Phase G).
--
-- Per Mark's 2026-05-22 answer: when the corpus has enough rules to
-- justify a cheat sheet for a new (payer, state) combo, the candidate
-- sits on the operator's Super Panel until Hamda reviews + publishes.
-- Org users don't see it browse-style until published.
--
-- This is independent of cheat_sheet_generation (the per-org PDF
-- render audit log). Templates are global reference, not tenant.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cheat_sheet_template (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id              UUID         NOT NULL REFERENCES payer(id),
  state                 CHAR(2)      NOT NULL REFERENCES state(state),
  /* Status:
       pending_review — corpus reached threshold; Hamda hasn't approved yet
       published      — visible org-side; renderable
       withdrawn      — published then pulled (e.g. payer policy changed) */
  status                TEXT         NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN ('pending_review','published','withdrawn')),
  /* How many covered rules we found at template creation time. */
  rule_count_at_creation INT         NOT NULL DEFAULT 0,
  /* Operator notes for the review queue. */
  notes                 TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_at          TIMESTAMPTZ,
  published_by_user_id  UUID         REFERENCES app_user(id),
  withdrawn_at          TIMESTAMPTZ,
  withdrawn_by_user_id  UUID         REFERENCES app_user(id),
  UNIQUE (payer_id, state)
);

CREATE INDEX IF NOT EXISTS cheat_sheet_template_status_idx
  ON cheat_sheet_template (status, created_at DESC);

COMMENT ON TABLE cheat_sheet_template IS
  'Phase G operator review queue. One row per (payer, state) combo the corpus has enough data to support. Hamda publishes; orgs see only published templates in their "browse" view.';
