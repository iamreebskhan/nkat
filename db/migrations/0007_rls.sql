-- ============================================================================
-- 0007_rls.sql
-- Row-Level Security policies for tenant isolation.
--
-- Pattern: every tenant-scoped table has an `org_id` column. Policies require
-- org_id = app.current_org_id(), which reads the per-session GUC
-- `app.current_org_id`. The application MUST set this on every transaction:
--
--   SET LOCAL app.current_org_id = '<uuid>';
--
-- The 'app' role is NOBYPASSRLS — it cannot accidentally see other tenants.
-- The 'breakglass' role bypasses RLS for emergencies; its use is logged.
-- ============================================================================

-- Helper: enable RLS + add the standard tenant policy + force RLS even for
-- table owners (defense in depth).
CREATE OR REPLACE FUNCTION app.apply_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s '
    'USING (org_id = app.current_org_id()) '
    'WITH CHECK (org_id = app.current_org_id())',
    tbl
  );
END
$$;

-- Apply to every tenant-scoped table.
-- Special case: `org` has no `org_id` column — its `id` IS the org —
-- so the standard apply_tenant_rls helper (which references `org_id`)
-- fails policy creation. Enable RLS and create the id-keyed policy
-- directly here.
ALTER TABLE org ENABLE ROW LEVEL SECURITY;
ALTER TABLE org FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());

SELECT app.apply_tenant_rls('org_member');
SELECT app.apply_tenant_rls('client_company');
SELECT app.apply_tenant_rls('client_rulebook');
SELECT app.apply_tenant_rls('client_rule');
SELECT app.apply_tenant_rls('audit_log');
SELECT app.apply_tenant_rls('consent_record');
SELECT app.apply_tenant_rls('alert');
SELECT app.apply_tenant_rls('era_835_record');
SELECT app.apply_tenant_rls('denial_event');
SELECT app.apply_tenant_rls('abn_record');

-- app_user is global by design (a user may belong to multiple orgs). No RLS.
-- Membership lookup goes through org_member which IS tenant-scoped.

-- ----------------------------------------------------------------------------
-- Reference tables MUST NOT have RLS — they're shared across tenants.
-- (code, modifier, modifier_relationship, pos, icd10, provider_taxonomy,
--  revenue_code, ms_drg, ndc, hcc_mapping, payer, state, product_line,
--  source_document, document_chunk, payer_rule, ncci_ptp, ncci_mue,
--  cob_rule, documentation_requirement)
--
-- We assert this loudly so a future migration doesn't accidentally enable RLS
-- on a reference table.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN VALUES
    ('code'),('modifier'),('modifier_relationship'),('pos'),('icd10'),
    ('provider_taxonomy'),('revenue_code'),('ms_drg'),('ndc'),('hcc_mapping'),
    ('payer'),('state'),('product_line'),('source_document'),('document_chunk'),
    ('payer_rule'),('ncci_ptp'),('ncci_mue'),('cob_rule'),('documentation_requirement')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Reference table % must not have RLS enabled', t;
    END IF;
  END LOOP;
END
$$;
