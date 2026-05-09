-- ============================================================================
-- 0023_phase35_rate_limit_overrides.sql
-- Phase 35 — per-tenant rate-limit overrides.
--
-- Defaults baked into route decorators (`@RateLimit({ limit, refillPerSec, scope })`)
-- are right for ~95% of tenants. Enterprise customers + ones temporarily
-- under DDoS pressure need higher (or sometimes lower!) ceilings on
-- specific scopes. This table holds those overrides.
--
-- Lookup: `(org_id, scope) → (limit, refill_per_sec)` with optional
-- `expires_at` for time-boxed promotional bumps. NULL expires_at means
-- the override stands until explicitly removed.
-- ============================================================================

CREATE TABLE rate_limit_override (
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,                     -- matches the @RateLimit({scope}) decorator
  "limit" INTEGER NOT NULL CHECK ("limit" > 0 AND "limit" <= 1000000),
  refill_per_sec NUMERIC(10,4) NOT NULL CHECK (refill_per_sec >= 0 AND refill_per_sec <= 100000),
  reason TEXT,                             -- audit context for why this override exists
  set_by_user_id UUID REFERENCES app_user(id),
  expires_at TIMESTAMPTZ,                  -- NULL = no expiry
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope)
);

-- Lookup index for the cache-warm path. Predicate dropped because
-- `now()` is STABLE not IMMUTABLE; Postgres rejects it in partial
-- indexes. The "active only" filter happens in the OverrideResolver
-- query: `WHERE expires_at IS NULL OR expires_at > now()`.
CREATE INDEX rate_limit_override_active_idx ON rate_limit_override (org_id, scope, expires_at);

-- Tenant-scoped: customers can read their own overrides; only admin
-- mutates (enforced at controller layer).
SELECT app.apply_tenant_rls('rate_limit_override');

-- Cross-tenant cache-warm function. The OverrideResolver in the API
-- needs every active override to populate its in-memory map; running
-- that under RLS would require a per-org loop. SECURITY DEFINER lets
-- this single call read across tenants, owned by a role with
-- SELECT permission on the table.
CREATE OR REPLACE FUNCTION app.list_active_rate_limit_overrides()
RETURNS TABLE (
  org_id UUID,
  scope TEXT,
  "limit" INTEGER,
  refill_per_sec NUMERIC,
  expires_at TIMESTAMPTZ
) LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT org_id, scope, "limit", refill_per_sec, expires_at
  FROM rate_limit_override
  WHERE expires_at IS NULL OR expires_at > now();
$$;

-- The function must be callable by the app role. SECURITY DEFINER means
-- it runs with the privileges of the function's owner — so the owner
-- needs SELECT permission on the underlying table (granted by default
-- to the migration runner).
GRANT EXECUTE ON FUNCTION app.list_active_rate_limit_overrides() TO app;
