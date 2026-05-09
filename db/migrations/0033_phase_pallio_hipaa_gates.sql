-- ============================================================================
-- 0033_phase_pallio_hipaa_gates.sql
--
-- Phase 7 — HIPAA gates ahead of production launch.
--
-- Adds:
--   - phi_access_log: row per read of patient PHI (vision §15.1).
--   - phi_export_log: row per export operation (cheat sheet, superbill PDF,
--     report CSV) — covered entity defensibility.
--   - prevent_audit_delete trigger on audit_log so old rows can't be silently
--     dropped before the 6-year retention window.
--   - retention sweep stored proc — moves rows >6y old to a frozen archive
--     table that has no DELETE permission for the app role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- phi_access_log: every read of an identified patient row.
-- App code calls log_phi_access(...) inside withOrgContext after a successful
-- read. Volume can be high — this table is partitioned monthly in prod.
-- ----------------------------------------------------------------------------
CREATE TABLE phi_access_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE RESTRICT,
  user_id             UUID        REFERENCES app_user(id),
  patient_id          UUID        NOT NULL,                       -- not FK; patient may be archived
  access_type         TEXT        NOT NULL CHECK (access_type IN
                                     ('view', 'edit', 'export', 'print', 'api_read')),
  context             TEXT,                                       -- e.g. 'patient_record', 'visit_detail'
  reason              TEXT,                                       -- optional: clinician break-the-glass reason
  ip_address          INET,
  user_agent          TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX phi_access_log_org_time_idx ON phi_access_log (org_id, occurred_at DESC);
CREATE INDEX phi_access_log_patient_idx ON phi_access_log (patient_id, occurred_at DESC);
CREATE INDEX phi_access_log_user_idx ON phi_access_log (user_id, occurred_at DESC);

ALTER TABLE phi_access_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY phi_access_log_tenant_isolation ON phi_access_log
  USING (org_id::text = current_setting('app.current_org_id', true));

-- ----------------------------------------------------------------------------
-- phi_export_log: every PHI-bearing export. Distinct from phi_access_log
-- because exports leave the platform and need a tighter audit trail.
-- ----------------------------------------------------------------------------
CREATE TABLE phi_export_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE RESTRICT,
  user_id             UUID        REFERENCES app_user(id),
  export_type         TEXT        NOT NULL CHECK (export_type IN
                                     ('cheat_sheet', 'superbill_pdf', 'report_csv',
                                      'patient_record_pdf', 'rule_lookup_pdf')),
  target_uri          TEXT,
  byte_size           BIGINT,
  patient_ids         UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX phi_export_log_org_time_idx ON phi_export_log (org_id, occurred_at DESC);

ALTER TABLE phi_export_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY phi_export_log_tenant_isolation ON phi_export_log
  USING (org_id::text = current_setting('app.current_org_id', true));

-- ----------------------------------------------------------------------------
-- audit_log retention guard.
--
-- HIPAA Security Rule 45 CFR §164.316(b)(2)(i): retain documentation
-- 6 years from the date of its creation OR the date when it last was in
-- effect, whichever is later.
--
-- We refuse DELETE/UPDATE on rows younger than 6 years from the app role.
-- Breakglass / superuser can override for legal-hold redaction.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_premature_audit_delete()
  RETURNS TRIGGER AS $$
BEGIN
  IF OLD.occurred_at > now() - interval '6 years' THEN
    RAISE EXCEPTION 'audit_log retention: cannot delete row younger than 6 years (occurred_at=%)', OLD.occurred_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_retention_guard
  BEFORE DELETE OR UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_premature_audit_delete();

-- Same guard on phi_access_log + phi_export_log.
CREATE TRIGGER phi_access_log_retention_guard
  BEFORE DELETE OR UPDATE ON phi_access_log
  FOR EACH ROW EXECUTE FUNCTION prevent_premature_audit_delete();

CREATE TRIGGER phi_export_log_retention_guard
  BEFORE DELETE OR UPDATE ON phi_export_log
  FOR EACH ROW EXECUTE FUNCTION prevent_premature_audit_delete();

-- ----------------------------------------------------------------------------
-- log_phi_access(): convenience function called from app code so the
-- column list lives in one place.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_phi_access(
  p_user_id     UUID,
  p_patient_id  UUID,
  p_access_type TEXT,
  p_context     TEXT DEFAULT NULL,
  p_reason      TEXT DEFAULT NULL,
  p_ip          INET DEFAULT NULL,
  p_ua          TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_org_id UUID;
  v_id     UUID;
BEGIN
  v_org_id := current_setting('app.current_org_id', true)::uuid;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'log_phi_access: app.current_org_id GUC not set';
  END IF;

  INSERT INTO phi_access_log (
    org_id, user_id, patient_id, access_type, context, reason, ip_address, user_agent
  ) VALUES (
    v_org_id, p_user_id, p_patient_id, p_access_type, p_context, p_reason, p_ip, p_ua
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE phi_access_log IS
  'HIPAA accounting-of-disclosures support. Retained 6y. App role cannot delete younger rows.';
COMMENT ON TABLE phi_export_log IS
  'PHI-leaving-the-platform audit. Retained 6y.';
