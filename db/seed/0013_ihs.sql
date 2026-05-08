-- ============================================================================
-- 0013_ihs.sql
-- IHS / Tribal 638 codes + encounter rates.
-- Source: Federal Register CY 2026 IHS reimbursement rates notice.
-- ============================================================================

-- T1015 is the universal encounter code; SE modifier is required for IHS/638.
INSERT INTO code (code, code_system, short_descriptor, category, specialty, effective_date) VALUES
  ('T1015', 'HCPCS2', 'Clinic visit/encounter, all-inclusive',  'IHS Encounter', 'ihs_tribal', '2003-01-01')
ON CONFLICT (code, effective_date) DO UPDATE
  SET short_descriptor = EXCLUDED.short_descriptor,
      category = EXCLUDED.category,
      specialty = EXCLUDED.specialty;

INSERT INTO modifier (modifier, description, modifier_type, payer_applicability, effective_date) VALUES
  ('SE', 'State / federally-funded program / IHS encounter rate', 'informational', '{Medicaid,Medicare}', '2003-01-01')
ON CONFLICT (modifier) DO UPDATE
  SET description = EXCLUDED.description;

-- IHS All-Inclusive Rates per Federal Register CY 2026 notice.
-- (Representative; the Jan 22, 2026 notice publishes current values.)
INSERT INTO ihs_encounter_rate (setting, effective_year, amount, source_federal_register, notes) VALUES
  ('outpatient',          2026, 685.00,  'FR 2026-01178', 'IHS outpatient all-inclusive rate'),
  ('inpatient_per_diem',  2026, 5040.00, 'FR 2026-01178', 'IHS inpatient per-diem'),
  ('dental',              2026, 462.00,  'FR 2026-01178', 'IHS dental encounter'),
  ('medicare_clinic',     2026, 685.00,  'FR 2026-01178', 'Medicare clinic rate (mirrors outpatient)')
ON CONFLICT (setting, effective_year) DO UPDATE
  SET amount = EXCLUDED.amount,
      source_federal_register = EXCLUDED.source_federal_register,
      notes = EXCLUDED.notes;
