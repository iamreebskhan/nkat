-- ============================================================================
-- 0020_phase25_system_setting.sql
-- Phase 25 — global key/value settings table. NOT RLS-scoped: settings
-- are platform-wide and admin-only-write. Initial use: cache version
-- bump for synthesis_cache invalidation.
--
-- We could have repurposed `feature_flag`, but that table is per-tenant
-- with semantics tied to product feature gates (synthesis on/off,
-- provider selection). Mixing in platform-global rules-version values
-- would muddy that contract.
-- ============================================================================

CREATE TABLE system_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  -- Audit context for who bumped + why. Admin user id is nullable so
  -- automated bumps (CLI scripts) can record `null` user_id with a
  -- non-null `note`.
  updated_by_user_id UUID REFERENCES app_user(id),
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the cache_version key. Default to 1; admin can bump via
-- `POST /v1/admin/cache/invalidate` or the `npm run cache:invalidate` script.
INSERT INTO system_setting (key, value, note)
VALUES ('synthesis_cache.version', '1'::jsonb, 'initial seed')
ON CONFLICT (key) DO NOTHING;
