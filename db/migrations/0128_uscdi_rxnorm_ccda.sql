-- ============================================================================
-- 0128_uscdi_rxnorm_ccda.sql
--
-- ONC groundwork: the data a certified record has to hold, in the form it has
-- to hold it. This does not make Pallio certified; it is what certification
-- would build on.
--
--   patient.race_codes          USCDI race: OMB categories by CDC code, more
--                               than one allowed, or 'declined' alone. Empty
--                               is "never asked", which is a different answer.
--   patient.ethnicity_code      USCDI ethnicity, or 'declined'.
--   patient.preferred_language  RFC 5646 tag, or 'declined'.
--   patient_allergy.rxnorm_cui  the substance in RxNorm, when a clinician chose
--                               one; patient_medication has had it since 0114.
--   phi_export_log              'patient_ccda', the C-CDA download.
--
-- A value outside the lists is refused here as well as in the API: these are
-- codes other systems read, and a wrong one travels.
-- ============================================================================

ALTER TABLE patient
  ADD COLUMN race_codes TEXT[] NOT NULL DEFAULT '{}'
    CONSTRAINT patient_race_codes_known
    CHECK (race_codes <@ ARRAY['1002-5', '2028-9', '2054-5', '2076-8', '2106-3', 'declined']::text[]),
  ADD CONSTRAINT patient_race_declined_alone
    CHECK (NOT ('declined' = ANY(race_codes)) OR cardinality(race_codes) = 1),
  ADD COLUMN ethnicity_code TEXT
    CONSTRAINT patient_ethnicity_known
    CHECK (ethnicity_code IS NULL OR ethnicity_code IN ('2135-2', '2186-5', 'declined')),
  ADD COLUMN preferred_language TEXT
    CONSTRAINT patient_preferred_language_form
    CHECK (preferred_language IS NULL OR preferred_language ~ '^[a-z]{2,8}(-[A-Za-z0-9]{1,8})*$');

ALTER TABLE patient_allergy
  ADD COLUMN rxnorm_cui TEXT CHECK (rxnorm_cui IS NULL OR rxnorm_cui ~ '^[0-9]{1,10}$');

ALTER TABLE phi_export_log DROP CONSTRAINT IF EXISTS phi_export_log_export_type_check;
ALTER TABLE phi_export_log ADD CONSTRAINT phi_export_log_export_type_check
  CHECK (export_type IN (
    'cheat_sheet', 'superbill_pdf', 'report_csv', 'patient_record_pdf', 'rule_lookup_pdf',
    'visit_audit_packet', 'claim_csv', 'offline_snapshot', 'claim_837', 'eligibility_270',
    'claim_status_276', 'patient_ccda'));

COMMENT ON COLUMN patient.race_codes IS 'USCDI race: CDC codes, or ''declined'' alone; empty is never asked (0128).';
COMMENT ON COLUMN patient.ethnicity_code IS 'USCDI ethnicity: CDC code, or ''declined''; null is never asked (0128).';
COMMENT ON COLUMN patient.preferred_language IS 'USCDI preferred language: RFC 5646 tag, or ''declined''; null is never asked (0128).';
