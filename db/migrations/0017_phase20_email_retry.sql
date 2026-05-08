-- ============================================================================
-- 0017_phase20_email_retry.sql
-- Phase 20 — `email_send` gains `args_snapshot` (so the retry cron can
-- re-render the original message) and `retry_count` (so we bound
-- exponential retries). Existing rows get safe defaults.
-- ============================================================================

ALTER TABLE email_send
  ADD COLUMN args_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN next_retry_at TIMESTAMPTZ;

-- Targeted index for the retry scan: failed rows past `next_retry_at`,
-- bounded by `retry_count < N`. Partial so it stays small.
CREATE INDEX email_send_retry_idx
  ON email_send (next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;
