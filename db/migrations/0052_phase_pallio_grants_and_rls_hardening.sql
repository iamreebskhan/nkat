-- ============================================================================
-- 0052 — Permanent grant backfill + RLS WITH CHECK hardening.
--
-- Two integrity fixes surfaced by the full-platform wiring scan:
--
-- 1. GRANTS: migration 0048 fixed grants for tables 0041–0046, but every
--    table is at the mercy of "who created it" for default privileges
--    (postgres-superuser-created tables don't inherit the 0001 ALTER
--    DEFAULT PRIVILEGES). Rather than chase individual tables, grant the
--    app + analyst roles on EVERY existing table/sequence in public, and
--    re-assert default privileges for both the postgres and app roles so
--    ANY future table is covered regardless of creator. Idempotent.
--
-- 2. RLS WITH CHECK: phi_access_log, phi_export_log (0033) and
--    org_rule_alert_checkpoint (0035) had a USING clause but no WITH CHECK,
--    so a crafted INSERT/UPDATE could set a foreign org_id. All writes go
--    through server functions today (low practical risk), but add WITH
--    CHECK for defense-in-depth. ALTER POLICY sets it without disturbing
--    the existing USING clause.
-- ============================================================================

-- 1. Blanket grants — covers every existing object permanently.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyst;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;

-- Re-assert default privileges for BOTH roles that create tables in
-- deploys (postgres for `psql -f`, app for app-owned migrations), so
-- future tables never hit the 42501 "permission denied" class again.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO analyst;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;

-- 2. WITH CHECK on the three policies that only had USING.
ALTER POLICY phi_access_log_tenant_isolation ON phi_access_log
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

ALTER POLICY phi_export_log_tenant_isolation ON phi_export_log
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

ALTER POLICY org_rule_alert_checkpoint_tenant_isolation ON org_rule_alert_checkpoint
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

-- 3. Breakglass audit trail — every cross-tenant RLS-bypass (withBreakglass)
--    other than the routine pre-tenant login/signup lookups records a row
--    here with its reason, so operator/platform-admin cross-tenant access
--    is auditable (closes the lib/db.ts hardening TODO). No org_id (these
--    are inherently cross-tenant / pre-tenant). Global admin log.
CREATE TABLE IF NOT EXISTS breakglass_log (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reason    TEXT        NOT NULL,
  node_env  TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS breakglass_log_at_idx ON breakglass_log (at DESC);
GRANT INSERT, SELECT ON breakglass_log TO app;
