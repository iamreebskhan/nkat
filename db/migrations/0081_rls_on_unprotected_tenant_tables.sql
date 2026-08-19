-- ===========================================================================
-- 0081 — Row-level security on the three tenant tables that never had it.
--
-- The operator compliance page has been reporting this the whole time and
-- nobody could see it, because reading it requires platform_admin:
--
--   RLS on every tenant table ......... FAIL
--   Unprotected: signup_attempt, migration_0080_reground_journal, feature_flag
--
-- All three carry org_id, none had ENABLE ROW LEVEL SECURITY, so the tenant
-- boundary on them was whatever the querying code remembered to write.
-- Every other table with an org_id enforces it in the database.
--
-- ONE OF THESE IS MINE. migration_0080_reground_journal was created earlier
-- in this same session to record the prior contents of tenant rulebook rows
-- before they were re-derived, and its before_row column holds to_jsonb(r) —
-- the complete row, per org. I added a table full of tenant data and left the
-- boundary off. The check caught it, which is the point of the check.
--
-- WHY THIS IS SAFE TO APPLY TO A LIVE SYSTEM
-- None of the three is read or written by application code — grepped across
-- lib/ and app/ and there is not one reference. signup_attempt belongs to the
-- Stripe-era signup flow (0014); the self-serve signup in auth.service.ts
-- writes org/app_user/org_member directly and never touches it. So no request
-- path can start failing because a policy now applies. Migrations and psql run
-- as the table owner, which bypasses RLS regardless.
--
-- feature_flag is the one with a wrinkle: org_id is NULLABLE there, and NULL
-- means "global default for every org". A plain org_id = current_org policy
-- would hide exactly those global rows, which is the opposite of what they
-- are for. Its policy therefore admits NULL as well.
-- ===========================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- signup_attempt — org_id NOT NULL, carries company_name and admin_email.
-- --------------------------------------------------------------------------
ALTER TABLE signup_attempt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signup_attempt_tenant_isolation ON signup_attempt;
CREATE POLICY signup_attempt_tenant_isolation ON signup_attempt
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

-- --------------------------------------------------------------------------
-- migration_0080_reground_journal — org_id NOT NULL, before_row holds the
-- whole prior rulebook row.
-- --------------------------------------------------------------------------
ALTER TABLE migration_0080_reground_journal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS migration_0080_reground_journal_tenant_isolation
  ON migration_0080_reground_journal;
CREATE POLICY migration_0080_reground_journal_tenant_isolation
  ON migration_0080_reground_journal
  USING (org_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (org_id::text = current_setting('app.current_org_id', true));

-- --------------------------------------------------------------------------
-- feature_flag — org_id NULLABLE, NULL = global default. Both the org's own
-- rows and the global ones must stay visible.
-- --------------------------------------------------------------------------
ALTER TABLE feature_flag ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_flag_tenant_isolation ON feature_flag;
CREATE POLICY feature_flag_tenant_isolation ON feature_flag
  USING (
    org_id IS NULL
    OR org_id::text = current_setting('app.current_org_id', true)
  )
  WITH CHECK (
    org_id IS NULL
    OR org_id::text = current_setting('app.current_org_id', true)
  );

-- --------------------------------------------------------------------------
-- Assert the thing the compliance page asserts, so this migration fails here
-- rather than being reported as still-broken on the operator dashboard.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(t.table_name, ', ' ORDER BY t.table_name) INTO bad
    FROM information_schema.tables t
    JOIN pg_class c ON c.relname = t.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE t.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND EXISTS (SELECT 1 FROM information_schema.columns col
                  WHERE col.table_name = t.table_name
                    AND col.table_schema = 'public'
                    AND col.column_name = 'org_id')
     AND t.table_name NOT IN (
       'cpt_code','icd10_code','carc_code','rarc_code','place_of_service',
       'modifier','taxonomy','us_state','payer','payer_alias',
       'cms_final_rule','cms_lcd','cms_ncd','cms_pa_list','cms_pa_list_code',
       'fee_schedule_year','fee_schedule_row','schema_migration',
       'rate_limit_bucket','idempotency_key','_prisma_migrations'
     )
     AND (
       NOT c.relrowsecurity
       OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
     );

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant tables still without RLS + policy: %', bad;
  END IF;
  RAISE NOTICE 'RLS: every tenant table now enables row level security and carries a policy';
END $$;

COMMIT;
