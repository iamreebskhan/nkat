-- ============================================================================
-- 0117_care_management_time.sql
--
-- PCM/CCM time and the month's charge (Level-1 doc:53, :69, :101; Mark Q10
-- default: "a PCM/CCM time log with monthly totals. Clinical staff and NPs can
-- both log time, consent is a dated record, and the month's charge is raised
-- once the time qualifies").
--
--   org_visit_type.coding_basis  + 'care_management': the band of the visit a
--                                month's charge is raised on. Its codes come
--                                from the month's time, never from a ladder.
--                                The bill pipeline (pricing, claims queue,
--                                denials, the 835) is the visits' own.
--   care_management_time         time spent on an enrolled patient's care
--                                management: who, as a practitioner (NP, MD,
--                                DO, PA, CNS: 'qhp') or clinical staff, the day,
--                                minutes, what was done; from a call or not.
--                                Recorded in error: voided, not deleted.
--   care_management_charge       the month's charge for one enrolment: the
--                                codes and minutes it was raised on, and the
--                                signed visit that carries it to the bill. One
--                                per enrolment and month; its month takes no
--                                more time.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

-- 1. The band.
ALTER TABLE org_visit_type DROP CONSTRAINT IF EXISTS org_visit_type_coding_basis_check;
ALTER TABLE org_visit_type ADD CONSTRAINT org_visit_type_coding_basis_check
  CHECK (coding_basis IN (
    'new_patient_home', 'established_patient_home',
    'advance_care_planning', 'inpatient_consult', 'non_billable', 'care_management'
  ));
COMMENT ON COLUMN org_visit_type.coding_basis IS
  'The CPT band this type bills as. non_billable = documented and signed, never billed (audit R18). care_management = the month a PCM/CCM charge is raised on, coded from its time log (0117). inpatient_consult has no code ladder and is not offered for new or edited types.';

-- 2. The time log.
CREATE TABLE care_management_time (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  enrollment_id         UUID        NOT NULL REFERENCES care_program_enrollment(id) ON DELETE CASCADE,
  performed_by_user_id  UUID        NOT NULL REFERENCES app_user(id),
  -- Read from the performer's credential when logged: a practitioner's own
  -- time, or clinical staff time under the practitioner's direction.
  performer_kind        TEXT        NOT NULL CHECK (performer_kind IN ('qhp', 'clinical_staff')),
  service_on            DATE        NOT NULL,
  minutes               SMALLINT    NOT NULL CHECK (minutes BETWEEN 1 AND 240),
  activity              TEXT        NOT NULL CHECK (activity IN (
                                      'phone', 'care_coordination', 'medication_management',
                                      'care_plan', 'caregiver_support', 'other')),
  note                  TEXT        CHECK (note IS NULL OR length(note) <= 500),
  phone_encounter_id    UUID        REFERENCES phone_encounter(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at             TIMESTAMPTZ,
  voided_by_user_id     UUID        REFERENCES app_user(id),
  void_reason           TEXT        CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CONSTRAINT care_management_time_void_why CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
-- A call's time is counted once.
CREATE UNIQUE INDEX care_management_time_call_uniq
  ON care_management_time (phone_encounter_id) WHERE phone_encounter_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX care_management_time_month_idx ON care_management_time (enrollment_id, service_on);
CREATE INDEX care_management_time_org_idx ON care_management_time (org_id, service_on);
SELECT app.apply_tenant_rls('care_management_time');

-- 3. The month's charge.
CREATE TABLE care_management_charge (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  enrollment_id       UUID        NOT NULL REFERENCES care_program_enrollment(id) ON DELETE CASCADE,
  -- The first day of the calendar month, where the practice is.
  month               DATE        NOT NULL CHECK (extract(day FROM month) = 1),
  -- The visit the charge is carried on: signed, then billed like any other.
  visit_id            UUID        NOT NULL REFERENCES visit(id),
  -- Which code set: clinical staff time (everyone's minutes count), or the
  -- billing practitioner's own.
  basis               TEXT        NOT NULL CHECK (basis IN ('staff', 'qhp')),
  -- The day the counted time reached what is billed.
  date_of_service     DATE        NOT NULL,
  codes               TEXT[]      NOT NULL CHECK (cardinality(codes) BETWEEN 1 AND 2),
  units               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  qhp_minutes         INT         NOT NULL CHECK (qhp_minutes >= 0),
  staff_minutes       INT         NOT NULL CHECK (staff_minutes >= 0),
  raised_by_user_id   UUID        NOT NULL REFERENCES app_user(id),
  raised_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, month),
  UNIQUE (visit_id),
  CONSTRAINT care_management_charge_dos_in_month
    CHECK (date_of_service >= month AND date_of_service < (month + interval '1 month')::date)
);
CREATE INDEX care_management_charge_org_month_idx ON care_management_charge (org_id, month);
SELECT app.apply_tenant_rls('care_management_charge');

COMMENT ON TABLE care_management_time IS 'PCM/CCM time, by whom (practitioner or clinical staff), per day (doc:53, Mark Q10).';
COMMENT ON TABLE care_management_charge IS 'A month''s PCM/CCM charge for one enrolment and the signed visit carrying it to the bill (doc:69).';
