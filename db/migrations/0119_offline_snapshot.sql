-- ============================================================================
-- 0119 — Offline copy of a clinician's caseload (Level-1 doc:33; Mark's
-- definition of offline [v1 16:05-16:53]; Mark Q8 default: read the chart and
-- draft offline, sign on reconnect).
--
-- A clinician saves their caseload and their coming visits to the device they
-- take into a home with no signal. That copy is a disclosure of PHI to the
-- device, logged as every other export is (phi_export_log, 0090): who, when,
-- which patients, how large. The logger swallows a refused insert, so the
-- CHECK has to know the kind before the route ships (as 0090, 0118).
--
-- Nothing else is stored server-side: notes written offline arrive through
-- the same note and vitals routes as notes written online, with the same
-- checks, when the device is back online.
-- ============================================================================

ALTER TABLE phi_export_log DROP CONSTRAINT IF EXISTS phi_export_log_export_type_check;
ALTER TABLE phi_export_log ADD CONSTRAINT phi_export_log_export_type_check
  CHECK (export_type IN (
    'cheat_sheet', 'superbill_pdf', 'report_csv', 'patient_record_pdf', 'rule_lookup_pdf',
    'visit_audit_packet', 'claim_csv', 'offline_snapshot'));
