-- ============================================================================
-- 0035_phase_pallio_alert_checkpoints.sql
--
-- Phase 9 — checkpoint table for per-org payer-rule-change alerts.
--
-- The cron job advances last_checked_at after each successful dispatch
-- so we never re-alert on the same effective_date window twice.
-- ============================================================================

CREATE TABLE org_rule_alert_checkpoint (
  org_id              UUID        PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  last_checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE org_rule_alert_checkpoint ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_rule_alert_checkpoint_tenant_isolation
  ON org_rule_alert_checkpoint
  USING (org_id::text = current_setting('app.current_org_id', true));

COMMENT ON TABLE org_rule_alert_checkpoint IS
  'Per-org watermark for the nightly payer-rule-change alert dispatcher.';
