-- ============================================================================
-- 0002_rls_isolation.sql
-- Verifies that RLS policies block cross-tenant READS and cross-tenant WRITES.
--
-- This is the only tenant-isolation gate in CI, so every check below is an
-- assertion that RAISEs on the wrong answer. Nothing here prints a result set
-- and leaves a human to notice it is wrong.
--
-- WHY IT IS SHAPED THIS WAY, named concretely. Until 2026-09 this file set its
-- tenant context with `SET LOCAL app.current_org_id = '...'` at FILE SCOPE.
-- psql runs in autocommit, so every one of them emitted
--     WARNING:  SET LOCAL can only be used in transaction blocks
-- and set nothing. A WARNING is not an error, so ON_ERROR_STOP never fired.
-- The GUC was never set, app.current_org_id() was NULL for the whole run, the
-- four checks were bare SELECTs annotated "Expect 1 row" that returned
-- (0 rows) — and the file still printed "RLS ISOLATION OK" and exited 0.
-- Widening the policy in 0007_rls.sql to USING (true), so every tenant reads
-- every other tenant's client_company, produced byte-identical exit status and
-- banner. An auditor reading that CI log saw a green tenant-isolation gate for
-- a run in which tenant isolation was never exercised.
--
-- Two rules follow from that, and breaking either brings the hole back:
--   1. The SET LOCAL and the assertion that depends on it must be inside the
--      SAME explicit BEGIN/COMMIT. SET LOCAL does not survive COMMIT.
--   2. Every scenario needs its positive half. "Acme sees no Beta row" and
--      "the cross-tenant write was blocked" are both true of a session that
--      can see and write NOTHING — which is exactly the state this file was
--      in. So each one is paired with the read or write that must SUCCEED.
--
-- Run as breakglass / admin for setup, then as 'app' for the assertions.
-- ============================================================================

\set ON_ERROR_STOP on

-- --- Setup (as breakglass / admin, which bypasses RLS) ---
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

-- The fixture has to actually be there. Both inserts above are ON CONFLICT
-- DO NOTHING, so a pre-existing row on the `acme` slug would swallow them
-- silently and every isolation check below would then be passing against an
-- empty table — one tenant reading zero of another tenant's rows because
-- there are none, not because a policy stopped it.
DO $$
DECLARE n_orgs int; n_clients int;
BEGIN
  SELECT count(*) INTO n_orgs FROM org
   WHERE id IN ('11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222');
  SELECT count(*) INTO n_clients FROM client_company
   WHERE id IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  IF n_orgs <> 2 OR n_clients <> 2 THEN
    RAISE EXCEPTION 'RLS TEST FIXTURE MISSING: % of 2 orgs and % of 2 client_company rows present. The ON CONFLICT clauses swallowed the setup (most likely a slug collision), so the isolation checks below would run against nothing.',
      n_orgs, n_clients;
  END IF;
END $$;

\echo 'Fixture present: two orgs, one client_company each.'

-- The assertions are only worth anything if RLS is enforced for the role that
-- runs them. A superuser, or any role with BYPASSRLS, sees every tenant's rows
-- whatever the policies say.
DO $$
DECLARE is_super bool; can_bypass bool;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, can_bypass
    FROM pg_roles WHERE rolname = 'app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test harness bug: role app does not exist, so the checks below cannot run as a tenant';
  END IF;
  IF is_super OR can_bypass THEN
    RAISE EXCEPTION 'test harness bug: role app has superuser=% bypassrls=% — RLS is not enforced for it and every check below is vacuous',
      is_super, can_bypass;
  END IF;
END $$;

-- --- Switch to app role for the actual RLS test ---
SET ROLE app;

\echo ''
\echo '== Harness sentinel: the tenant GUC really is set =='
BEGIN;
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
DO $$
BEGIN
  -- The bug this whole file was rewritten for. If SET LOCAL ever drifts back
  -- outside a transaction it sets nothing, app.current_org_id() is NULL, every
  -- policy fails closed, and the "no leak" assertions below all pass for the
  -- wrong reason. Fail here instead, where the message says what happened.
  IF app.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'test harness bug: tenant GUC is NULL — SET LOCAL ran outside a transaction block, so every check below would pass on a session with no tenant context at all';
  END IF;
  IF app.current_org_id() <> '11111111-1111-1111-1111-111111111111'::uuid THEN
    RAISE EXCEPTION 'test harness bug: tenant GUC is % , not the Acme org', app.current_org_id();
  END IF;
END $$;
COMMIT;

\echo ''
\echo '== Acme session: sees its own client, and no Beta row =='
BEGIN;
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE n int; nm text; st text;
BEGIN
  SELECT count(*), min(name::text), min(primary_state::text)
    INTO n, nm, st FROM client_company;
  -- Both directions in one assertion: more than one row means the USING clause
  -- stopped restricting to org_id = app.current_org_id() (USING (true) gives 2
  -- here); zero means it never matches, which is how this file used to run.
  IF n <> 1 OR nm <> 'Acme Hospice' OR st <> 'OH' THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session saw % client_company row(s) (first: % / %); expected exactly 1 (Acme Hospice / OH)',
      n, coalesce(nm, '<none>'), coalesce(st, '<none>');
  END IF;
  IF EXISTS (SELECT 1 FROM client_company
              WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session can read Beta Oncology — another tenant''s client_company row';
  END IF;
END $$;
COMMIT;

\echo ''
\echo '== Beta session: sees its own client, and no Acme row =='
BEGIN;
SET LOCAL app.current_org_id = '22222222-2222-2222-2222-222222222222';
DO $$
DECLARE n int; nm text; st text;
BEGIN
  SELECT count(*), min(name::text), min(primary_state::text)
    INTO n, nm, st FROM client_company;
  IF n <> 1 OR nm <> 'Beta Oncology' OR st <> 'NC' THEN
    RAISE EXCEPTION 'RLS FAILED: the Beta session saw % client_company row(s) (first: % / %); expected exactly 1 (Beta Oncology / NC)',
      n, coalesce(nm, '<none>'), coalesce(st, '<none>');
  END IF;
  IF EXISTS (SELECT 1 FROM client_company
              WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') THEN
    RAISE EXCEPTION 'RLS FAILED: the Beta session can read Acme Hospice — another tenant''s client_company row';
  END IF;
END $$;
COMMIT;

\echo ''
\echo '== No org context: the table is empty to this session =='
RESET app.current_org_id;
BEGIN;
DO $$
DECLARE n int;
BEGIN
  IF app.current_org_id() IS NOT NULL THEN
    RAISE EXCEPTION 'test harness bug: an org context (%) survived into the no-context check', app.current_org_id();
  END IF;
  SELECT count(*) INTO n FROM client_company;
  IF n <> 0 THEN
    RAISE EXCEPTION 'RLS FAILED: a session with no tenant context read % client_company row(s); expected 0', n;
  END IF;
END $$;
COMMIT;

\echo ''
\echo '== Writes: same-tenant insert allowed, cross-tenant insert blocked =='
BEGIN;
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE probe uuid := gen_random_uuid(); n int;
BEGIN
  -- POSITIVE CONTROL, and it has to come first. "Cross-tenant write blocked"
  -- is also true of a session that cannot write ANYWHERE: with no org context
  -- app.current_org_id() is NULL, every WITH CHECK fails, and the old file
  -- printed "RLS OK: cross-tenant write blocked" from exactly that state. Only
  -- a session that has just proved it can write to its OWN org makes the next
  -- block mean anything.
  BEGIN
    INSERT INTO client_company (id, org_id, name)
    VALUES (probe, '11111111-1111-1111-1111-111111111111', 'RLS same-tenant probe');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session could not insert a client_company under its OWN org. Either WITH CHECK no longer matches org_id = app.current_org_id(), or this session has no tenant context — in which case the cross-tenant check below would pass vacuously.';
  END;
  SELECT count(*) INTO n FROM client_company WHERE id = probe;
  IF n <> 1 THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session inserted a client_company under its own org but reads back % row(s) for it', n;
  END IF;

  -- The check itself.
  BEGIN
    INSERT INTO client_company (id, org_id, name)
    VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'RLS cross-tenant probe');
    RAISE EXCEPTION 'RLS FAILED: the Acme session wrote a client_company row under Beta''s org';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    -- Required outcome. Not re-raised, and deliberately not printed either:
    -- a NOTICE here is what the old file offered as its evidence.
    NULL;
  END;
END $$;
-- The probe row was only ever a control; nothing from this block persists, so
-- the file stays re-runnable against a database that already has the fixture.
ROLLBACK;

\echo ''
\echo '== org table: a session sees its own org row and no other =='
BEGIN;
SET LOCAL app.current_org_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE n int; nm text;
BEGIN
  SELECT count(*), min(name::text) INTO n, nm FROM org;
  -- org is keyed on id, not org_id, so 0007_rls.sql writes its policy out by
  -- hand instead of calling app.apply_tenant_rls — it can drift on its own.
  IF n <> 1 OR nm <> 'Acme RCM' THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session saw % org row(s) (first: %); expected exactly 1 (Acme RCM)',
      n, coalesce(nm, '<none>');
  END IF;
  IF EXISTS (SELECT 1 FROM org WHERE id = '22222222-2222-2222-2222-222222222222') THEN
    RAISE EXCEPTION 'RLS FAILED: the Acme session can read the Beta RCM org row';
  END IF;
END $$;
COMMIT;

RESET ROLE;

\echo ''
\echo '== Catalogue: every tenant table still carries an unweakened policy =='

-- Everything above proves the policy WORKS — on client_company and on org.
-- That is two tables out of the seventy-three this schema gives an org_id.
-- DROP POLICY tenant_isolation ON audit_log — the table that records who read
-- which patient's chart — left every assertion above passing and this file
-- still printing RLS ISOLATION OK, because nothing above ever looks at
-- audit_log. db/migrations/0007_rls.sql hands nine tables beyond
-- client_company to app.apply_tenant_rls and later migrations hand it another
-- fifty-seven, so a per-table drop was invisible in the only tenant-isolation
-- gate CI has.
--
-- This block asks the CATALOGUE rather than restating the rule: it reads what
-- Postgres actually installed (pg_class.relrowsecurity, relforcerowsecurity,
-- pg_policy.polqual/polwithcheck). That is deliberately the weaker kind of
-- evidence — a catalogue row says a policy exists and what it says, not that
-- the planner enforces it — so it is an addition to the behavioural checks
-- above, never a replacement for them.
--
-- Each sweep is preceded by a count. "No table is missing its policy" is also
-- true of a query that matched no tables at all, which is the same shape of
-- hole as the SET LOCAL bug this file was rewritten for; the counts fail
-- loudly instead. They are floors, not exact totals, so adding a tenant table
-- does not fail CI.
DO $$
DECLARE
  -- Spelled out, in the order db/migrations/0007_rls.sql applies them, so a
  -- dropped policy is named in the failure instead of inferred from a count.
  rls_0007 CONSTANT text[] := ARRAY[
    'org', 'org_member', 'client_company', 'client_rulebook', 'client_rule',
    'audit_log', 'consent_record', 'alert', 'era_835_record', 'denial_event',
    'abn_record'];
  t          text;
  n_tables   int;
  n_policies int;
  bad        text;
BEGIN
  FOREACH t IN ARRAY rls_0007 LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = t
         AND c.relrowsecurity AND c.relforcerowsecurity
         AND EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
    ) THEN
      RAISE EXCEPTION 'RLS MISSING: public.% is put under row-level security by db/migrations/0007_rls.sql (through app.apply_tenant_rls, or by hand for org), but it does not exist, or ROW LEVEL SECURITY is not both ENABLEd and FORCEd on it, or it has no policy named tenant_isolation. Every tenant reads every other tenant''s rows in that table.',
        t;
    END IF;
  END LOOP;

  -- The other ~60 tenant tables, without naming each one: anything carrying an
  -- org_id is tenant data, so it must have RLS on and EXACTLY ONE permissive
  -- policy, and that policy must mention org_id and the tenant GUC. Permissive
  -- policies are ORed together, so a second one saying USING (true) hands every
  -- tenant every row while the first policy still reads correctly — counting
  -- them is the only way to see that. Restrictive policies are not counted:
  -- they can only narrow access. Six tables (phi_access_log, phi_export_log,
  -- org_rule_alert_checkpoint, signup_attempt, feature_flag,
  -- migration_0080_reground_journal) were written by hand with their own policy
  -- name and are not FORCEd, so this sweep asserts only what they all share;
  -- the exact-shape sweep below covers the tenant_isolation ones.
  SELECT count(*) INTO n_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                    AND a.attnum > 0 AND NOT a.attisdropped);
  IF n_tables < 60 THEN
    RAISE EXCEPTION 'test harness bug: only % public table(s) have an org_id column (the schema had 73 when this was written), so the tenant-table sweep below would pass on nearly nothing',
      n_tables;
  END IF;

  SELECT string_agg(x.relname || ' (' || x.why || ')', ', ' ORDER BY x.relname)
    INTO bad
    FROM (
      SELECT c.relname,
             CASE
               WHEN NOT c.relrowsecurity THEN 'ROW LEVEL SECURITY not enabled'
               WHEN (SELECT count(*) FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polpermissive) <> 1
                 THEN (SELECT count(*) FROM pg_policy p
                        WHERE p.polrelid = c.oid AND p.polpermissive)::text
                      || ' permissive policies; expected exactly 1'
               ELSE 'its policy does not mention both org_id and the tenant GUC'
             END AS why
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                        AND a.attnum > 0 AND NOT a.attisdropped)
         AND NOT (
               c.relrowsecurity
           AND (SELECT count(*) FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polpermissive) = 1
           AND EXISTS (
                 SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = c.oid AND p.polpermissive
                    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%org_id%'
                    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_org_id%'))
    ) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS MISSING OR WIDENED: public table(s) with an org_id column that are not restricted to one tenant: %. RLS off, the policy dropped, a second permissive policy ORed alongside it, or USING (true) all make that table readable by every other tenant.',
      bad;
  END IF;

  -- The standard shape, exactly as app.apply_tenant_rls writes it. Parens and
  -- whitespace are stripped before comparing because that is deparser
  -- formatting, not policy; everything else must match character for character,
  -- so USING (true) or an added OR branch fails here.
  SELECT count(*) INTO n_policies
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation';
  IF n_policies < 60 THEN
    RAISE EXCEPTION 'test harness bug: only % policy/policies named tenant_isolation exist (the schema had 68 when this was written), so the shape sweep below would check almost nothing',
      n_policies;
  END IF;

  SELECT string_agg(
           c.relname || ' USING ' ||
           coalesce(pg_get_expr(p.polqual, p.polrelid), '<none>') ||
           ' WITH CHECK ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '<none>') ||
           CASE WHEN c.relforcerowsecurity THEN '' ELSE ' [NOT FORCED]' END ||
           CASE WHEN p.polcmd::text = '*' THEN '' ELSE ' [not FOR ALL]' END,
           '; ' ORDER BY c.relname)
    INTO bad
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation'
     AND ( NOT c.relrowsecurity
        OR NOT c.relforcerowsecurity
        OR p.polcmd::text <> '*'
        OR regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                          '[[:space:]()]', '', 'g')
             IS DISTINCT FROM
           (CASE WHEN c.relname = 'org' THEN 'id=app.current_org_id'
                 ELSE 'org_id=app.current_org_id' END)
        OR regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                          '[[:space:]()]', '', 'g')
             IS DISTINCT FROM
           (CASE WHEN c.relname = 'org' THEN 'id=app.current_org_id'
                 ELSE 'org_id=app.current_org_id' END) );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS WEAKENED: policy tenant_isolation no longer reads org_id = app.current_org_id() FOR ALL on a FORCEd table: %. app.apply_tenant_rls writes exactly that; anything else is a tenant boundary that moved.',
      bad;
  END IF;
END $$;

\echo 'Every tenant table has RLS forced and its policy unchanged.'

\echo ''
\echo 'RLS ISOLATION OK'
