-- ============================================================================
-- 0096_org_member_role_template.sql
--
-- Audit R38. The role a member's sidebar renders from was never the template
-- they were invited with. Redeeming an invite wrote org_member.role =
-- 'employee' whatever pending_invite.role_template said, and login mapped
-- 'employee' to clinician — so an invited billing agent saw only My inbox and
-- Patients, and an invited analyst never saw Attestations.
--
-- org_member.role keeps its legacy four-value CHECK (other code reads it);
-- the template lives beside it. Nullable on purpose: db/seed/0017 and 0020
-- insert members without it, and the session falls back to the same legacy
-- mapping login used before this migration.
-- ============================================================================

ALTER TABLE org_member ADD COLUMN IF NOT EXISTS role_template TEXT
  CONSTRAINT org_member_role_template_check
  CHECK (role_template IS NULL OR role_template IN
    ('org_admin', 'clinician', 'billing_agent', 'consultant', 'analyst', 'read_only'));

-- Invitees: the template the admin chose (their latest redeemed invite).
UPDATE org_member m
   SET role_template = i.role_template
  FROM (
    SELECT DISTINCT ON (org_id, redeemed_by_user_id)
           org_id, redeemed_by_user_id, role_template
      FROM pending_invite
     WHERE redeemed_by_user_id IS NOT NULL
     ORDER BY org_id, redeemed_by_user_id, redeemed_at DESC
  ) i
 WHERE i.org_id = m.org_id
   AND i.redeemed_by_user_id = m.user_id
   AND m.role_template IS NULL
   AND i.role_template IN ('org_admin', 'clinician', 'billing_agent', 'consultant', 'analyst', 'read_only');

-- Everyone else: exactly the mapping login applied before this migration.
UPDATE org_member
   SET role_template = CASE role
                         WHEN 'admin'      THEN 'org_admin'
                         WHEN 'consultant' THEN 'consultant'
                         WHEN 'reviewer'   THEN 'analyst'
                         ELSE 'clinician'
                       END
 WHERE role_template IS NULL;

COMMENT ON COLUMN org_member.role_template IS
  'The role template the member was invited with (team.types ROLE_TEMPLATES) — what their sidebar renders from. NULL falls back to the legacy role mapping.';
