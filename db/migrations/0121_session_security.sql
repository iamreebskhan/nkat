-- ============================================================================
-- 0121_session_security.sql
--
-- Security roadmap, Phase 0 (30 Oct 2026), the two items that live in the
-- session (HIPAA 164.312(a)(2)(iii) automatic logoff, 164.312(d); ONC
-- 170.315(d)(5) automatic access time-out, (d)(13) multi-factor):
--
--   org.idle_timeout_minutes  a session ends after this long without anything
--                             done in it, and a sign-in is needed to go on. A
--                             session lasted 7 days with no idle limit. 30
--                             minutes by default (decided 31 Oct 2026 over the
--                             roadmap's 15, which interrupted a home visit's
--                             conversation); a practice may set 5 to 120.
--   org.mfa_policy            who must use a second factor: admins and billers
--                             (anyone who can change access, the practice's
--                             settings or its claims), or everyone. MFA was
--                             optional for every user. There is no "off": the
--                             floor is the roadmap's.
--   app_user.mfa_pending_secret  a new authenticator being set up. Setting one
--                             up used to clear the enrolled one first, so an
--                             abandoned setup left the account with no second
--                             factor at all; the old one now stays in force
--                             until the new one is confirmed.
--
-- org already has RLS (its own row only); app_user is not tenant data. No
-- backfill: the defaults are the policy.
-- ============================================================================

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS idle_timeout_minutes SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS mfa_policy           TEXT     NOT NULL DEFAULT 'admins_and_billers';

ALTER TABLE org DROP CONSTRAINT IF EXISTS org_idle_timeout_minutes_check;
ALTER TABLE org ADD CONSTRAINT org_idle_timeout_minutes_check
  CHECK (idle_timeout_minutes BETWEEN 5 AND 120);

ALTER TABLE org DROP CONSTRAINT IF EXISTS org_mfa_policy_check;
ALTER TABLE org ADD CONSTRAINT org_mfa_policy_check
  CHECK (mfa_policy IN ('admins_and_billers', 'everyone'));

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;
