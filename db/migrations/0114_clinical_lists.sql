-- ============================================================================
-- 0114_clinical_lists.sql
--
-- The patient's problem list, medication list and allergies (Level-1 doc:36,
-- "medication and problem information"). Medications and allergies were free
-- text in each visit note, there was no patient-level problem list, and the
-- care plan's medication list was a second, unstructured copy. These are the
-- lists the chart keeps, and the groundwork ONC certification needs (Mark Q7):
-- problems coded in ICD-10-CM, a place for the RxNorm code of a medication.
--
--   patient_problem     one per problem, ICD-10-CM coded, active or resolved
--   patient_medication  one per medication, active or stopped (with why)
--   patient_allergy     one per allergy or intolerance, active or inactive
--   patient.no_known_allergies_*  "no known allergies" as a recorded fact,
--                       not the absence of rows; recording an allergy clears it
--
-- Nothing is deleted: a problem is resolved, a medication stopped, an allergy
-- made inactive (entered in error, or disproved), each with who and when.
--
-- The care plan's medication list (care_plan.active_medications) becomes the
-- chart's list: its entries are copied in once here, as active medications
-- recorded when the plan was last saved, and the care plan reads the chart's
-- list from now on. Its versions froze what they froze and keep it.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

CREATE TABLE patient_problem (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  -- Dotted ICD-10-CM, as normalizeIcd10 writes it (C34.90, S72.001A).
  icd10               TEXT        NOT NULL CHECK (icd10 ~ '^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$'),
  description         TEXT        NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  onset_on            DATE,
  resolved_on         DATE,
  notes               TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  UUID        REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_problem_resolved_has_day CHECK ((status = 'resolved') = (resolved_on IS NOT NULL)),
  CONSTRAINT patient_problem_dates CHECK (onset_on IS NULL OR resolved_on IS NULL OR resolved_on >= onset_on)
);
-- One active entry per code: a second "I50.9" while the first is active is
-- the same problem twice.
CREATE UNIQUE INDEX patient_problem_active_code_uniq
  ON patient_problem (patient_id, icd10) WHERE status = 'active';
CREATE INDEX patient_problem_patient_idx ON patient_problem (patient_id, status, recorded_at DESC);
SELECT app.apply_tenant_rls('patient_problem');

CREATE TABLE patient_medication (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  dose                TEXT        CHECK (dose IS NULL OR length(dose) <= 100),
  route               TEXT        CHECK (route IS NULL OR length(route) <= 50),
  frequency           TEXT        CHECK (frequency IS NULL OR length(frequency) <= 100),
  prn                 BOOLEAN     NOT NULL DEFAULT FALSE,
  indication          TEXT        CHECK (indication IS NULL OR length(indication) <= 200),
  -- RxNorm concept id, for ONC (Mark Q7). Not set from the chart yet: Pallio
  -- holds no RxNorm table. The column is here so coding does not need a
  -- migration of every medication later.
  rxnorm_cui          TEXT        CHECK (rxnorm_cui IS NULL OR rxnorm_cui ~ '^[0-9]{1,10}$'),
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  started_on          DATE,
  stopped_on          DATE,
  stop_reason         TEXT        CHECK (stop_reason IS NULL OR length(stop_reason) <= 300),
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  UUID        REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_medication_stopped_has_day CHECK ((status = 'stopped') = (stopped_on IS NOT NULL)),
  CONSTRAINT patient_medication_dates CHECK (started_on IS NULL OR stopped_on IS NULL OR stopped_on >= started_on)
);
CREATE INDEX patient_medication_patient_idx ON patient_medication (patient_id, status, recorded_at DESC);
SELECT app.apply_tenant_rls('patient_medication');

CREATE TABLE patient_allergy (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  substance           TEXT        NOT NULL CHECK (length(btrim(substance)) BETWEEN 1 AND 200),
  kind                TEXT        NOT NULL CHECK (kind IN ('drug', 'food', 'environmental', 'other')),
  reaction            TEXT        CHECK (reaction IS NULL OR length(reaction) <= 300),
  severity            TEXT        CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe', 'unknown')),
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  inactive_reason     TEXT        CHECK (inactive_reason IS NULL OR length(inactive_reason) <= 300),
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  UUID        REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX patient_allergy_patient_idx ON patient_allergy (patient_id, status, recorded_at DESC);
SELECT app.apply_tenant_rls('patient_allergy');

ALTER TABLE patient
  ADD COLUMN no_known_allergies_at         TIMESTAMPTZ,
  ADD COLUMN no_known_allergies_by_user_id UUID REFERENCES app_user(id);

-- The care plan's medication list becomes the chart's (see the header).
--
-- It reads care_plan and writes patient_medication, both under FORCE ROW LEVEL
-- SECURITY, so only a role that bypasses RLS sees every org's plans: the
-- deploy superuser does (0052: `postgres` on prod, `admin` locally and in CI).
-- Any other role would copy nothing and the medications would look lost, as
-- 0103 says of its own backfill. Idempotent: a patient whose chart already
-- has medications is skipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0114 backfill needs a role that bypasses row-level security (superuser or BYPASSRLS); % does not', current_user;
  END IF;
END $$;

INSERT INTO patient_medication (org_id, patient_id, name, status, recorded_at, updated_at)
SELECT cp.org_id, cp.patient_id, left(btrim(m.name), 200), 'active', cp.updated_at, cp.updated_at
  FROM care_plan cp
  CROSS JOIN LATERAL unnest(COALESCE(cp.active_medications, ARRAY[]::text[])) AS m(name)
 WHERE btrim(m.name) <> ''
   AND NOT EXISTS (SELECT 1 FROM patient_medication pm WHERE pm.patient_id = cp.patient_id);

COMMENT ON TABLE patient_problem IS 'The patient''s problem list, ICD-10-CM coded (Level-1 doc:36).';
COMMENT ON TABLE patient_medication IS 'The patient''s medication list (doc:36); the care plan reads it (0114).';
COMMENT ON TABLE patient_allergy IS 'The patient''s allergies and intolerances (doc:36).';
COMMENT ON COLUMN care_plan.active_medications IS 'Superseded by patient_medication (0114); copied there and no longer written.';
