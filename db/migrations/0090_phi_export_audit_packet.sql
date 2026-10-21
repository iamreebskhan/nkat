-- ============================================================================
-- 0090_phi_export_audit_packet.sql
--
-- Allow 'visit_audit_packet' as a phi_export_log export type.
--
-- WHY THIS IS NOT OPTIONAL
--
-- phi_export_log.export_type carries a CHECK constraint listing every kind of
-- PHI export the product can produce (0033:51). The visit audit packet — the
-- signed note plus the superbill in one PDF — is a new one, and it is the most
-- PHI-dense document Pallio emits: full clinical note, diagnoses, member id,
-- date of birth.
--
-- logPhiExport swallows its own failures to console.error (phi-access-log.ts:93)
-- so that a logging problem never blocks a clinician's download. That is the
-- right call for availability and the wrong one to rely on here: without this
-- migration the packet would download normally while the §164.528
-- accounting-of-disclosures row silently failed to insert. A disclosure that
-- happened and was not recorded is precisely the thing the log exists to
-- prevent, so the constraint has to learn the new value before the route ships.
-- ============================================================================

ALTER TABLE phi_export_log
  DROP CONSTRAINT IF EXISTS phi_export_log_export_type_check;

ALTER TABLE phi_export_log
  ADD CONSTRAINT phi_export_log_export_type_check
  CHECK (export_type IN (
    'cheat_sheet',
    'superbill_pdf',
    'report_csv',
    'patient_record_pdf',
    'rule_lookup_pdf',
    'visit_audit_packet'
  ));
