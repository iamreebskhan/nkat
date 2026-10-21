-- The audit trail and the PHI access/export logs are append-only: a row-level
-- trigger (0033) refuses DELETE and UPDATE on rows younger than six years.
-- TRUNCATE fires no row trigger and ignores RLS, so a role that holds it can
-- empty every organization's log in one statement.
--
-- Migrations only ever grant app SELECT, INSERT, UPDATE and DELETE (0001,
-- 0052). But a database provisioned by hand can hand app every privilege
-- through its default ACLs; the local development database does exactly
-- that (app=arwdDxtm). The org admin's Safeguards card (audit R24) tells a
-- customer these entries "cannot be deleted before they are six years old",
-- so the revoke is made explicit here: true on every database, not only on
-- one built from migrations. The card also checks the privilege at runtime.
--
-- A no-op where app never held TRUNCATE. Idempotent.

DO $$
DECLARE
  t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    RAISE NOTICE 'role app does not exist; nothing to revoke';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['audit_log', 'phi_access_log', 'phi_export_log'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE TRUNCATE ON %I FROM app', t);
    END IF;
  END LOOP;
END $$;
