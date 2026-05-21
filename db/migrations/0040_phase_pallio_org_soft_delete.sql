-- ============================================================================
-- 0040 — Soft-delete for orgs.
--
-- We can't hard-delete orgs that have audit_log rows: a HIPAA retention
-- trigger (`prevent_premature_audit_delete`) blocks DELETE on any
-- audit row younger than 6 years. That trigger is correct policy.
--
-- Soft-delete preserves the audit trail while removing the org from
-- every operator/user-facing surface. To "delete" an org, set
-- `deleted_at = NOW()`. Code paths that read orgs treat deleted_at
-- IS NOT NULL as effectively gone:
--   * login (`findOrgForUser` rejects deleted orgs → user can't sign in)
--   * cross-tenant operator list (`/api/admin/orgs` filters deleted)
--
-- Hard-delete still works for orgs created before any audit rows
-- existed; this just gives operators a safe knob when retention
-- prevents purge.
-- ============================================================================

ALTER TABLE org
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS org_deleted_at_idx
  ON org (deleted_at) WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN org.deleted_at IS
  'Soft-delete timestamp. When non-null, the org is hidden from all UIs and its members cannot log in. Audit rows are preserved.';
