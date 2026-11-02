-- ============================================================================
-- 0115_clinical_course.sql
--
-- The course of care on the chart (Level-1 doc:37, :58, :84-95, :108):
--
--   patient.admitted_on          the day palliative care began (Mark Q11l
--                                default: the day of the admit action). The
--                                length of stay is measured from it.
--   patient_acuity_event         every acuity given, with where it came from:
--                                intake, the triage, an NP visit, a review on
--                                the chart, or already on file when the history
--                                began. Mark Q9 default: the triage and the NP
--                                values kept apart, with their history.
--                                patient.acuity stays the current value.
--   hospice_eligibility_assessment  "potential hospice appropriateness"
--                                (doc:37, :91): yes or no, the day, the basis
--                                (Mark Q11c default).
--   patient_event                falls, ED visits, hospital admissions and
--                                other significant events (doc:58, :86-89), and
--                                hospice discussions and referrals (doc:92). A
--                                readmission is an admission within 30 days of
--                                the last discharge, worked out when read.
--   patient_discharge            the discharge workflow (doc:93-95, :108): the
--                                day, the practice's discharge code (0111), and
--                                for a move to hospice its admission day, kept
--                                by hand (Mark Q11j default), and later how the
--                                hospice stay ended. A discharge can be undone
--                                by readmitting; the row stays, marked.
--
-- A death is a discharge with a death code: the patient's status becomes
-- 'deceased' rather than 'discharged'. patient.discharged_at, which nothing
-- wrote (23 Sep brief, defect 4), is written by a discharge and cleared by a
-- readmission.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

-- The backfills below read and write tables under FORCE ROW LEVEL SECURITY:
-- only a role that bypasses RLS sees every org's rows (0052: `postgres` on
-- prod, `admin` locally and in CI). Any other role would backfill nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0115 backfill needs a role that bypasses row-level security (superuser or BYPASSRLS); % does not', current_user;
  END IF;
END $$;

-- 1. When palliative care began.
ALTER TABLE patient ADD COLUMN admitted_on DATE;

-- The admitting referral's day where there is one, else the day the chart was
-- created, in the practice's zone.
UPDATE patient p
   SET admitted_on = COALESCE(
         (SELECT r.admitted_on FROM referral r WHERE r.patient_id = p.id AND r.org_id = p.org_id),
         (p.created_at AT TIME ZONE o.timezone)::date)
  FROM org o
 WHERE o.id = p.org_id AND p.admitted_on IS NULL;

-- 2. Acuity, with its history.
CREATE TABLE patient_acuity_event (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  acuity              TEXT        NOT NULL CHECK (acuity IN ('low', 'medium', 'high', 'critical')),
  source              TEXT        NOT NULL CHECK (source IN ('intake', 'triage', 'visit', 'review', 'on_file')),
  visit_id            UUID        REFERENCES visit(id) ON DELETE SET NULL,
  referral_triage_id  UUID        REFERENCES referral_triage(id) ON DELETE SET NULL,
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_acuity_event_visit_source CHECK ((source = 'visit') = (visit_id IS NOT NULL))
);
CREATE INDEX patient_acuity_event_patient_idx ON patient_acuity_event (patient_id, recorded_at DESC);
-- One acuity per visit: a change during the visit corrects it.
CREATE UNIQUE INDEX patient_acuity_event_visit_uniq ON patient_acuity_event (visit_id) WHERE visit_id IS NOT NULL;
SELECT app.apply_tenant_rls('patient_acuity_event');

-- The acuity already on file, as the first entry. Given at intake or on a
-- review since, which the chart cannot tell apart, so it says neither.
INSERT INTO patient_acuity_event (org_id, patient_id, acuity, source, recorded_by_user_id, recorded_at)
SELECT p.org_id, p.id, p.acuity, 'on_file', p.acuity_updated_by_user_id, COALESCE(p.acuity_updated_at, p.created_at)
  FROM patient p
 WHERE p.acuity IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM patient_acuity_event e WHERE e.patient_id = p.id);

-- 3. Hospice eligibility.
CREATE TABLE hospice_eligibility_assessment (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  eligible            BOOLEAN     NOT NULL,
  assessed_on         DATE        NOT NULL,
  basis               TEXT        CHECK (basis IS NULL OR length(basis) <= 1000),
  visit_id            UUID        REFERENCES visit(id) ON DELETE SET NULL,
  assessed_by_user_id UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hospice_eligibility_patient_idx ON hospice_eligibility_assessment (patient_id, assessed_on DESC, created_at DESC);
SELECT app.apply_tenant_rls('hospice_eligibility_assessment');

-- 4. Significant events.
CREATE TABLE patient_event (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL CHECK (kind IN ('fall', 'ed_visit', 'hospital_admission', 'other',
                                                           'hospice_discussion', 'hospice_referral')),
  occurred_on         DATE        NOT NULL,
  -- The day an admission ended (the hospital discharge); a readmission is
  -- counted from it.
  ended_on            DATE,
  -- The hospital; for a hospice referral, the hospice.
  facility            TEXT        CHECK (facility IS NULL OR length(facility) <= 150),
  -- A fall with an injury is a different event from one without.
  injury              BOOLEAN,
  description         TEXT        CHECK (description IS NULL OR length(description) <= 1000),
  visit_id            UUID        REFERENCES visit(id) ON DELETE SET NULL,
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Recorded in error: kept, struck through, not counted.
  voided_at           TIMESTAMPTZ,
  voided_by_user_id   UUID        REFERENCES app_user(id),
  void_reason         TEXT        CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CONSTRAINT patient_event_ended_after CHECK (ended_on IS NULL OR ended_on >= occurred_on),
  CONSTRAINT patient_event_ended_admission CHECK (ended_on IS NULL OR kind = 'hospital_admission'),
  CONSTRAINT patient_event_injury_fall CHECK (injury IS NULL OR kind = 'fall'),
  CONSTRAINT patient_event_void_why CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
CREATE INDEX patient_event_patient_idx ON patient_event (patient_id, occurred_on DESC);
CREATE INDEX patient_event_org_kind_idx ON patient_event (org_id, kind, occurred_on);
SELECT app.apply_tenant_rls('patient_event');

-- 5. Discharge, and the move to hospice.
CREATE TABLE patient_discharge (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  -- The episode this discharge ends: from admitted_on to discharged_on.
  admitted_on         DATE,
  discharged_on       DATE        NOT NULL,
  reason_code_id      UUID        NOT NULL REFERENCES org_reason_code(id),
  note                TEXT        CHECK (note IS NULL OR length(note) <= 1000),
  -- A move to hospice (a code that counts as hospice_partner or hospice_other):
  -- which hospice, and the day it admitted the patient, entered by hand.
  hospice_name        TEXT        CHECK (hospice_name IS NULL OR length(btrim(hospice_name)) BETWEEN 1 AND 150),
  hospice_admitted_on DATE,
  -- How the hospice stay ended, recorded later: the hospice length of stay.
  hospice_ended_on    DATE,
  hospice_end_reason  TEXT        CHECK (hospice_end_reason IS NULL OR hospice_end_reason IN (
                                    'death', 'live_discharge', 'revocation', 'transfer')),
  died_on             DATE,
  recorded_by_user_id UUID        REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Undone by a readmission (or recorded in error): kept, marked.
  reversed_at         TIMESTAMPTZ,
  reversed_by_user_id UUID        REFERENCES app_user(id),
  reversed_reason     TEXT        CHECK (reversed_reason IS NULL OR length(reversed_reason) <= 300),
  CONSTRAINT patient_discharge_dates CHECK (admitted_on IS NULL OR discharged_on >= admitted_on),
  CONSTRAINT patient_discharge_hospice_dates CHECK (
    hospice_ended_on IS NULL OR (hospice_admitted_on IS NOT NULL AND hospice_ended_on >= hospice_admitted_on)),
  CONSTRAINT patient_discharge_hospice_end_reason CHECK ((hospice_ended_on IS NULL) = (hospice_end_reason IS NULL))
);
-- At most one discharge in force per patient.
CREATE UNIQUE INDEX patient_discharge_current_uniq ON patient_discharge (patient_id) WHERE reversed_at IS NULL;
CREATE INDEX patient_discharge_org_day_idx ON patient_discharge (org_id, discharged_on);
SELECT app.apply_tenant_rls('patient_discharge');

COMMENT ON COLUMN patient.admitted_on IS 'The day palliative care began (Mark Q11l): the admit action''s day; a readmission moves it.';
COMMENT ON TABLE patient_acuity_event IS 'Every acuity given and its source: intake, triage, an NP visit, a chart review, or on file when the history began (Mark Q9).';
COMMENT ON TABLE hospice_eligibility_assessment IS 'Potential hospice appropriateness: yes/no, day, basis (doc:37, Mark Q11c).';
COMMENT ON TABLE patient_event IS 'Falls, ED visits, hospital admissions and other significant events (doc:58, :86-89); hospice discussions and referrals (doc:92).';
COMMENT ON TABLE patient_discharge IS 'Discharges with the practice''s code, and the move to hospice with its dates (doc:93-95, :108).';
