-- ============================================================================
-- 0039 — Reachable platform_admin role.
--
-- The Session.role union has 'platform_admin' but no code path could
-- ever produce it: org_member.role CHECK only allows
-- (employee, reviewer, admin, consultant), and mapDbRoleToSession
-- mapped 'admin' → 'org_admin'. So `/api/admin/*` and `/admin/*`
-- routes that check `session.role === 'platform_admin'` were dead.
--
-- This adds a tenant-independent boolean on app_user. To elevate
-- the platform operator:
--   UPDATE app_user SET is_platform_admin = TRUE
--    WHERE email = 'hamda@theaura.agency';
-- ============================================================================

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS app_user_platform_admin_idx
  ON app_user (is_platform_admin) WHERE is_platform_admin = TRUE;

COMMENT ON COLUMN app_user.is_platform_admin IS
  'When true, the JWT session.role is overridden to platform_admin (unlocks /api/admin/*). Independent of org_member.role.';
