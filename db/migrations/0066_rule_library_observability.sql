-- 0066 — make the rule library's health and coverage observable.
--
-- WHY
-- The library sat with 3 registered sources and rules for 3 of 19 payers
-- for months, and nothing anywhere said so. Every lookup for the other
-- 16 payers returned "Unknown", which is indistinguishable from "this
-- payer genuinely has no rule" — so the failure was invisible right up
-- until a client asked why nothing was being recommended.
--
-- The fix is not more rules. It is making the ABSENCE of rules visible,
-- and making the pipeline say when it stops working. This migration adds
-- the state needed for both.
--
-- Failure modes this closes (each was silent before):
--   1. A document changes and unreviewed rules enter the shared library
--      -> auto_extract, review_pending
--   2. A source URL rots (404, moved, TLS failure)
--      -> consecutive_failures
--   3. A URL still returns 200 but the content has been frozen for years
--      -> last_change_detected_at
--   4. Extraction silently yields zero rules (document restructured)
--      -> last_rule_count
--   5. The cron itself stops running (a GitHub Actions outage did exactly
--      this during development)
--      -> last_check_at already exists; the health view reads staleness
--         from it
--   6. A payer or a code has no rule anywhere, and nobody notices
--      -> library_coverage_target + the coverage report built on it

BEGIN;

-- ---------------------------------------------------------------------
-- Source health
-- ---------------------------------------------------------------------

ALTER TABLE ingestion_source
  -- When FALSE the cron still fetches and hashes on schedule, but a
  -- detected change only RAISES A FLAG instead of writing rules. Use it
  -- for sources whose rules must go through the offline grounded
  -- extraction (every quote verified verbatim against the source) before
  -- reaching a library that 111 practices bill against.
  ADD COLUMN IF NOT EXISTS auto_extract BOOLEAN NOT NULL DEFAULT TRUE,

  -- Set when the content hash moves. Distinguishes "we checked and it is
  -- genuinely unchanged" from "we have not looked in a year".
  ADD COLUMN IF NOT EXISTS last_change_detected_at TIMESTAMPTZ,

  -- Rules produced by the most recent extraction. A drop to 0 on a
  -- source that previously yielded rules means the document was
  -- restructured and the extractor no longer understands it — which
  -- otherwise looks identical to a healthy no-op.
  ADD COLUMN IF NOT EXISTS last_rule_count INTEGER,

  -- Reset to 0 on success. A source failing repeatedly is dead, not
  -- flaky, and should be surfaced rather than retried forever.
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- Content changed but auto_extract was FALSE: awaiting a human-run
  -- grounded extraction.
  ADD COLUMN IF NOT EXISTS review_pending BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ingestion_source.auto_extract IS
  'FALSE = detect changes but do not write rules; flag review_pending instead.';
COMMENT ON COLUMN ingestion_source.consecutive_failures IS
  'Reset to 0 on a successful fetch. >=3 means the source is dead, not flaky.';
COMMENT ON COLUMN ingestion_source.last_rule_count IS
  'Rules from the latest extraction. A fall to 0 signals a restructured document.';

CREATE INDEX IF NOT EXISTS ingestion_source_attention_idx
  ON ingestion_source (active, consecutive_failures DESC, last_check_at)
  WHERE active;

-- ---------------------------------------------------------------------
-- Coverage targets
--
-- "Is the library complete?" is unanswerable without knowing what it is
-- supposed to cover. This is the definition — business configuration,
-- deliberately data rather than a constant in the code, so the target
-- set can change without a deploy.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS library_coverage_target (
  code        TEXT        PRIMARY KEY,
  label       TEXT        NOT NULL,
  -- Codes the practice bills most; a gap here is urgent rather than
  -- merely untidy.
  is_core     BOOLEAN     NOT NULL DEFAULT FALSE,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE library_coverage_target IS
  'The code set the rule library is expected to answer for. Drives the '
  'coverage report: any (payer x active code) with no rule is a visible gap.';

INSERT INTO library_coverage_target (code, label, is_core, notes) VALUES
  ('99341', 'Home/residence visit, new patient, straightforward MDM',      TRUE,  NULL),
  ('99342', 'Home/residence visit, new patient, low MDM',                  TRUE,  NULL),
  ('99344', 'Home/residence visit, new patient, moderate MDM',             TRUE,  NULL),
  ('99345', 'Home/residence visit, new patient, high MDM',                 TRUE,  NULL),
  ('99347', 'Home/residence visit, established patient, straightforward',  TRUE,  NULL),
  ('99348', 'Home/residence visit, established patient, low MDM',          TRUE,  NULL),
  ('99349', 'Home/residence visit, established patient, moderate MDM',     TRUE,  NULL),
  ('99350', 'Home/residence visit, established patient, high MDM',         TRUE,  NULL),
  ('99497', 'Advance care planning, first 30 minutes',                     TRUE,  NULL),
  ('99498', 'Advance care planning, each additional 30 minutes',           FALSE, 'Add-on to 99497'),
  ('99417', 'Prolonged outpatient E/M, each 15 minutes',                   TRUE,  NULL),
  ('G0179', 'Home health plan of care recertification',                    FALSE, NULL),
  ('G0180', 'Home health plan of care certification',                      FALSE, NULL),
  ('G0318', 'Home/residence visit prolonged service',                      FALSE, NULL),
  ('99495', 'Transitional care management, moderate complexity',           FALSE, NULL),
  ('99496', 'Transitional care management, high complexity',               FALSE, NULL)
ON CONFLICT (code) DO UPDATE SET
  label   = EXCLUDED.label,
  is_core = EXCLUDED.is_core,
  notes   = EXCLUDED.notes;

-- Global reference data, same grant pattern as payer_rule: `app` gets
-- CRUD, `analyst` read-only. Deliberately NOT RLS-protected — every
-- tenant is measured against the same target set.
GRANT SELECT, INSERT, UPDATE, DELETE ON library_coverage_target TO app;
GRANT SELECT ON library_coverage_target TO analyst;

COMMIT;
