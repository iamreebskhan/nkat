-- ============================================================================
-- 0001_extensions_and_roles.sql
-- Enables required extensions and creates the application + admin roles.
-- Run as the postgres superuser (admin in our docker-compose).
-- ============================================================================

-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- uuid_generate_v4
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid, crypto helpers
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive text
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- GIN over scalar types in composite indexes

-- ----------------------------------------------------------------------------
-- Roles
-- ----------------------------------------------------------------------------
-- 'app' is the everyday application role. NOBYPASSRLS means RLS policies are
-- always enforced; the app cannot accidentally see other tenants' rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app_dev_only_change_in_prod' NOBYPASSRLS;
  END IF;
END
$$;

-- 'analyst' is the offline analyst-attestation role. Read access to client data,
-- write access to payer_rule additions only via stored procedures.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyst') THEN
    CREATE ROLE analyst LOGIN PASSWORD 'analyst_dev_only_change_in_prod' NOBYPASSRLS;
  END IF;
END
$$;

-- 'breakglass' bypasses RLS for emergencies and audits. Use is logged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breakglass') THEN
    CREATE ROLE breakglass LOGIN PASSWORD 'breakglass_dev_only_change_in_prod' BYPASSRLS;
  END IF;
END
$$;

-- Helper: settable per-session tenant context. App MUST set this on every
-- transaction via `SET LOCAL app.current_org_id = '<uuid>'`. RLS policies read
-- it through the get_current_org_id() function below.
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_org_id() IS
  'Returns the org id set via SET LOCAL app.current_org_id. NULL if unset (will fail every RLS policy).';

GRANT USAGE ON SCHEMA app TO app, analyst;
GRANT EXECUTE ON FUNCTION app.current_org_id() TO app, analyst;

-- Default privileges for the public schema: app gets read+write on tables,
-- read on sequences, create on schema. Analyst gets read by default; explicit
-- grants per table for any write paths.
GRANT USAGE ON SCHEMA public TO app, analyst;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO analyst;
