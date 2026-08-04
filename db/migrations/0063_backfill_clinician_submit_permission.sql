-- 0063 — backfill visits.submit / schedule.edit for existing clinicians.
--
-- ROLE_DEFAULT_PERMISSIONS is only a TEMPLATE, applied once when a user is
-- invited: lib/features/auth/auth.service.ts materialises the list into
-- user_permission rows, and login reads those rows (auth.service.ts ~L116).
--
-- So adding "visits.submit" to the clinician template fixes nothing for anyone
-- already invited. Every existing clinician keeps 403-ing on "Sign + submit for
-- billing" — the primary button on their primary screen — and on
-- drag-to-reschedule. This closes that gap for rows already in the database.
--
-- Targeting is by CAPABILITY, not by role name, deliberately:
--   * anyone who can already edit a visit's documentation should be able to
--     sign it — being able to write a note but not attest to it is not a
--     coherent permission set;
--   * anyone who can already create a scheduled visit should be able to move it.
-- Keying off the role would also re-grant to users an admin had deliberately
-- stripped back. Keying off the adjacent permission cannot.
--
-- No billing.* is granted here. Bill correction after a rejection belongs to
-- the billing agent.
--
-- NOTE on the shape of this table: user_permission rows target EITHER a user
-- (user_id set) OR an unaccepted invite (pending_invite_id set) — enforced by
-- user_permission_target_chk. Both are handled below, in separate statements,
-- because a naive "copy the row's user_id" carries NULL over from invite rows
-- and violates that CHECK.
--
-- Idempotent: the NOT EXISTS guards make re-running a no-op.

-- ── Existing users ─────────────────────────────────────────────────────────
INSERT INTO user_permission (org_id, user_id, permission, granted_by_user_id)
SELECT DISTINCT up.org_id, up.user_id, 'visits.submit', up.user_id
FROM user_permission up
WHERE up.permission = 'visits.edit'
  AND up.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_permission x
     WHERE x.user_id = up.user_id
       AND x.org_id = up.org_id
       AND x.permission = 'visits.submit'
  );

INSERT INTO user_permission (org_id, user_id, permission, granted_by_user_id)
SELECT DISTINCT up.org_id, up.user_id, 'schedule.edit', up.user_id
FROM user_permission up
WHERE up.permission = 'schedule.create'
  AND up.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_permission x
     WHERE x.user_id = up.user_id
       AND x.org_id = up.org_id
       AND x.permission = 'schedule.edit'
  );

-- ── Invites sent but not yet accepted ──────────────────────────────────────
-- Otherwise a clinician invited before this migration lands still arrives
-- without the permission the moment they accept.
INSERT INTO user_permission (org_id, pending_invite_id, permission)
SELECT DISTINCT up.org_id, up.pending_invite_id, 'visits.submit'
FROM user_permission up
WHERE up.permission = 'visits.edit'
  AND up.pending_invite_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_permission x
     WHERE x.pending_invite_id = up.pending_invite_id
       AND x.permission = 'visits.submit'
  );

INSERT INTO user_permission (org_id, pending_invite_id, permission)
SELECT DISTINCT up.org_id, up.pending_invite_id, 'schedule.edit'
FROM user_permission up
WHERE up.permission = 'schedule.create'
  AND up.pending_invite_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_permission x
     WHERE x.pending_invite_id = up.pending_invite_id
       AND x.permission = 'schedule.edit'
  );
