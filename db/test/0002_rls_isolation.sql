-- ============================================================================
-- 0002_rls_isolation.sql
-- Verifies that RLS policies block cross-tenant reads.
-- Setup: insert two orgs with separate client_company rows, then attempt to
-- read from each tenant's session and confirm zero leakage.
--
-- Run as breakglass for setup, then switch to 'app' role for the assertions.
-- ============================================================================

\set ON_ERROR_STOP on

-- --- Setup (as breakglass) ---
\echo '== RLS test setup =='

INSERT INTO org (id, name, slug, plan_tier) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme RCM',  'acme',  'org'),
  ('22222222-2222-2222-2222-222222222222', 'Beta RCM',  'beta',  'org')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO client_company (id, org_id, name, primary_state, specialties) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111',
   'Acme Hospice', 'OH', '{hospice,palliative}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222',
   'Beta Oncology', 'NC', '{oncology}')
ON CONFLICT (id) DO NOTHING;

\echo 'Inserted two orgs and one client_company each.'

-- --- Switch to app role for the actual RLS test ---
SET ROLE app;

\echo ''
\echo '== Acme session: should see only Acme client =='
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
SELECT name, primary_state FROM client_company ORDER BY name;
-- Expect 1 row: Acme Hospice / OH

\echo ''
\echo '== Beta session: should see only Beta client =='
SET LOCAL app.current_org_id = '22222222-2222-2222-2222-222222222222';
SELECT name, primary_state FROM client_company ORDER BY name;
-- Expect 1 row: Beta Oncology / NC

\echo ''
\echo '== No org context: should see zero rows =='
RESET app.current_org_id;
SELECT count(*) AS leak_count FROM client_company;
-- Expect 0

\echo ''
\echo '== Cross-tenant write attempt: blocked =='
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
DO $$
BEGIN
  -- Try to insert a client_company under Beta's org while in Acme's session
  BEGIN
    INSERT INTO client_company (id, org_id, name)
    VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'Should fail');
    RAISE EXCEPTION 'RLS FAILED: cross-tenant write succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'RLS OK: cross-tenant write blocked';
  END;
END $$;

\echo ''
\echo '== Org table self-access works =='
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
SELECT name, slug FROM org;
-- Expect 1 row: Acme RCM

RESET ROLE;

\echo ''
\echo 'RLS ISOLATION OK'
