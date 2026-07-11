-- 0055 — backfill the patients.careteam.edit permission.
--
-- Care-team assignment (0054) must gate on a PERMISSION, not session.role —
-- roles are display-only per lib/auth.ts and vision §18.4. The org_admin
-- template now includes patients.careteam.edit for new invites; this grants
-- it to every EXISTING holder of team.deactivate (org_admin-exclusive across
-- all role templates), covering both redeemed members and pending invites.

INSERT INTO user_permission (org_id, user_id, pending_invite_id, permission)
SELECT up.org_id, up.user_id, up.pending_invite_id, 'patients.careteam.edit'
FROM user_permission up
WHERE up.permission = 'team.deactivate'
  AND NOT EXISTS (
    SELECT 1 FROM user_permission dup
    WHERE dup.org_id = up.org_id
      AND dup.user_id IS NOT DISTINCT FROM up.user_id
      AND dup.pending_invite_id IS NOT DISTINCT FROM up.pending_invite_id
      AND dup.permission = 'patients.careteam.edit'
  );
