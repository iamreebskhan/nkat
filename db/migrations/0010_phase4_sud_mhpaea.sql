-- ============================================================================
-- 0010_phase4_sud_mhpaea.sql
-- Phase 4 — behavioral health + 42 CFR Part 2 SUD consent + MHPAEA parity.
--
-- New columns + table:
--   * code.is_sud_part2 — flags codes that fall under 42 CFR Part 2 (SUD
--     treatment). Lookup hard-stops if these are billed without active TPO
--     consent in `consent_record`.
--   * code.specialty — light tag for filtering ('behavioral_health','oncology',
--     'palliative','telemedicine',...). Independent of category which is
--     finer-grained.
--   * mhpaea_parity_pair — explicit catalog of behavioral_health → med/surg
--     code pairs used by the parity engine. The previously denormalized
--     `payer_rule.mhpaea_paired_code` column still works for inline lookups;
--     this table is the source of truth for reporting + analytics.
-- ============================================================================

ALTER TABLE code ADD COLUMN IF NOT EXISTS is_sud_part2 BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE code ADD COLUMN IF NOT EXISTS specialty TEXT;

CREATE INDEX IF NOT EXISTS code_specialty_active_idx
  ON code (specialty)
  WHERE expiration_date IS NULL;

CREATE INDEX IF NOT EXISTS code_sud_active_idx
  ON code (is_sud_part2)
  WHERE expiration_date IS NULL AND is_sud_part2 = TRUE;

-- ---------------------------------------------------------------------------
-- mhpaea_parity_pair: catalog of (behavioral_health_code, med_surg_code)
-- pairs the parity engine compares.
-- ---------------------------------------------------------------------------
CREATE TABLE mhpaea_parity_pair (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  behavioral_health_code TEXT       NOT NULL,
  med_surg_code         TEXT        NOT NULL,
  classification        TEXT        NOT NULL CHECK (classification IN (
                          'inpatient_in_network','inpatient_out_of_network',
                          'outpatient_in_network','outpatient_out_of_network',
                          'emergency_care','prescription_drugs'
                        )),
  rationale             TEXT,
  source_url            TEXT,
  effective_date        DATE        NOT NULL,
  expiration_date       DATE,
  CHECK (expiration_date IS NULL OR expiration_date > effective_date),
  UNIQUE (behavioral_health_code, med_surg_code, classification, effective_date)
);

CREATE INDEX mhpaea_parity_pair_bh_idx ON mhpaea_parity_pair (behavioral_health_code)
  WHERE expiration_date IS NULL;

COMMENT ON TABLE mhpaea_parity_pair IS
  'Catalog of behavioral_health ↔ med/surg comparable code pairs used by the MHPAEA parity engine.';
COMMENT ON COLUMN code.is_sud_part2 IS
  'TRUE = code falls under 42 CFR Part 2 (substance use disorder treatment). Lookup blocks these without active TPO consent.';
