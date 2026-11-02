-- ============================================================================
-- 0116_care_coordination.sql
--
-- Care between visits (Level-1 doc:38, :40, :48, :50-56):
--
--   care_plan (+ columns)        the formal care plan's structured parts
--                                (doc:38): goals, interventions with who is
--                                responsible, what is monitored and how often,
--                                the NP's escalation parameters, the next
--                                review. Frozen with the plan at sign-off, so
--                                care_plan_version takes the same columns.
--   care_program_enrollment      PCM/CCM enrolment (doc:38, :101): the program,
--                                the day, the consent (day and how). One
--                                enrolment in force per patient and program.
--   phone_encounter              telephone encounters (doc:52): who called
--                                whom, how long, symptom scores, a summary.
--                                A call recorded in error is voided, not
--                                deleted.
--   escalation_alert             a finding that crossed the NP's parameters
--                                (doc:55-57): from a visit's vitals, a call's
--                                scores or an event. The NP is notified and
--                                acknowledges it. One per source and measure.
--   care_task                    tasks to the interdisciplinary team (doc:40,
--                                :54): a discipline, optionally a person, a
--                                due day, done or cancelled with a note. Mark
--                                Q11e default: manual tasks, plus alerts when
--                                the NP's criteria are met.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- No backfill: every new column has its default.
-- ============================================================================

-- 1. The care plan's structured parts. Items are validated where they are
--    written (lib/features/care-plans/care-plan.types.ts); here, only their
--    shape.
ALTER TABLE care_plan
  ADD COLUMN goals         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN interventions JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN monitoring    JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN escalation    JSONB  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN review_on     DATE;
ALTER TABLE care_plan ADD CONSTRAINT care_plan_structured_lists CHECK (
  jsonb_typeof(interventions) = 'array' AND jsonb_typeof(monitoring) = 'array' AND jsonb_typeof(escalation) = 'array');

-- NULL on a version frozen before these existed.
ALTER TABLE care_plan_version
  ADD COLUMN goals         TEXT[],
  ADD COLUMN interventions JSONB,
  ADD COLUMN monitoring    JSONB,
  ADD COLUMN escalation    JSONB,
  ADD COLUMN review_on     DATE;

-- 2. PCM/CCM enrolment.
CREATE TABLE care_program_enrollment (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  program             TEXT        NOT NULL CHECK (program IN ('pcm', 'ccm')),
  enrolled_on         DATE        NOT NULL,
  -- Consent comes first (CMS: before the service is furnished).
  consent_on          DATE        NOT NULL,
  consent_method      TEXT        NOT NULL CHECK (consent_method IN ('verbal', 'written')),
  consent_note        TEXT        CHECK (consent_note IS NULL OR length(consent_note) <= 500),
  enrolled_by_user_id UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_on            DATE,
  end_reason          TEXT        CHECK (end_reason IS NULL OR length(end_reason) <= 300),
  ended_by_user_id    UUID        REFERENCES app_user(id),
  CONSTRAINT care_program_enrollment_consent_first CHECK (consent_on <= enrolled_on),
  CONSTRAINT care_program_enrollment_end CHECK (
    ended_on IS NULL OR (ended_on >= enrolled_on AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX care_program_enrollment_current_uniq
  ON care_program_enrollment (patient_id, program) WHERE ended_on IS NULL;
CREATE INDEX care_program_enrollment_org_idx ON care_program_enrollment (org_id, program, enrolled_on);
SELECT app.apply_tenant_rls('care_program_enrollment');

-- 3. Telephone encounters.
CREATE TABLE phone_encounter (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  clinician_user_id   UUID        NOT NULL REFERENCES app_user(id),
  occurred_at         TIMESTAMPTZ NOT NULL,
  direction           TEXT        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  spoke_with          TEXT        NOT NULL CHECK (spoke_with IN ('patient', 'caregiver', 'family', 'facility', 'provider', 'other')),
  minutes             SMALLINT    CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 240),
  pain_score          SMALLINT    CHECK (pain_score IS NULL OR pain_score BETWEEN 0 AND 10),
  dyspnea_score       SMALLINT    CHECK (dyspnea_score IS NULL OR dyspnea_score BETWEEN 0 AND 10),
  nausea_score        SMALLINT    CHECK (nausea_score IS NULL OR nausea_score BETWEEN 0 AND 10),
  summary             TEXT        NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at           TIMESTAMPTZ,
  voided_by_user_id   UUID        REFERENCES app_user(id),
  void_reason         TEXT        CHECK (void_reason IS NULL OR length(void_reason) <= 300),
  CONSTRAINT phone_encounter_void_why CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);
CREATE INDEX phone_encounter_patient_idx ON phone_encounter (patient_id, occurred_at DESC);
CREATE INDEX phone_encounter_org_idx ON phone_encounter (org_id, occurred_at);
SELECT app.apply_tenant_rls('phone_encounter');

-- 4. Escalation alerts.
CREATE TABLE escalation_alert (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID          NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id              UUID          NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  measure                 TEXT          NOT NULL CHECK (measure IN (
                                          'pain', 'dyspnea', 'nausea', 'pps', 'spo2',
                                          'fall', 'ed_visit', 'hospital_admission')),
  -- The reading and the NP's limit it crossed; none for an event.
  value                   NUMERIC(5, 1),
  threshold               NUMERIC(5, 1),
  source                  TEXT          NOT NULL CHECK (source IN ('vitals', 'phone', 'event')),
  visit_id                UUID          REFERENCES visit(id) ON DELETE CASCADE,
  phone_encounter_id      UUID          REFERENCES phone_encounter(id) ON DELETE CASCADE,
  event_id                UUID          REFERENCES patient_event(id) ON DELETE CASCADE,
  -- Who was told: the patient's primary NP when there is one.
  notified_user_id        UUID          REFERENCES app_user(id),
  -- withdrawn: the reading was corrected below the limit, or its source voided.
  status                  TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'withdrawn')),
  raised_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
  acknowledged_by_user_id UUID          REFERENCES app_user(id),
  acknowledged_at         TIMESTAMPTZ,
  acknowledge_note        TEXT          CHECK (acknowledge_note IS NULL OR length(acknowledge_note) <= 1000),
  CONSTRAINT escalation_alert_one_source CHECK (num_nonnulls(visit_id, phone_encounter_id, event_id) = 1),
  CONSTRAINT escalation_alert_source CHECK (
    (source = 'vitals') = (visit_id IS NOT NULL)
    AND (source = 'phone') = (phone_encounter_id IS NOT NULL)
    AND (source = 'event') = (event_id IS NOT NULL)),
  CONSTRAINT escalation_alert_acknowledged CHECK ((status = 'acknowledged') = (acknowledged_at IS NOT NULL))
);
CREATE UNIQUE INDEX escalation_alert_visit_uniq ON escalation_alert (visit_id, measure) WHERE visit_id IS NOT NULL;
CREATE UNIQUE INDEX escalation_alert_phone_uniq ON escalation_alert (phone_encounter_id, measure) WHERE phone_encounter_id IS NOT NULL;
CREATE UNIQUE INDEX escalation_alert_event_uniq ON escalation_alert (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX escalation_alert_patient_idx ON escalation_alert (patient_id, raised_at DESC);
CREATE INDEX escalation_alert_notified_idx ON escalation_alert (org_id, notified_user_id, status);
SELECT app.apply_tenant_rls('escalation_alert');

-- 5. Tasks to the interdisciplinary team.
CREATE TABLE care_task (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Most tasks are about a patient; an administrative one need not be.
  patient_id          UUID        REFERENCES patient(id) ON DELETE CASCADE,
  title               TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  details             TEXT        CHECK (details IS NULL OR length(details) <= 2000),
  discipline          TEXT        NOT NULL CHECK (discipline IN ('np', 'nursing', 'social_work', 'chaplaincy', 'admin', 'other')),
  -- Nobody yet: the discipline's to pick up.
  assignee_user_id    UUID        REFERENCES app_user(id),
  due_on              DATE,
  status              TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  -- Where it came from, when it came from somewhere.
  visit_id            UUID        REFERENCES visit(id) ON DELETE SET NULL,
  phone_encounter_id  UUID        REFERENCES phone_encounter(id) ON DELETE SET NULL,
  alert_id            UUID        REFERENCES escalation_alert(id) ON DELETE SET NULL,
  created_by_user_id  UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by_user_id   UUID        REFERENCES app_user(id),
  closed_at           TIMESTAMPTZ,
  close_note          TEXT        CHECK (close_note IS NULL OR length(close_note) <= 1000),
  CONSTRAINT care_task_closed CHECK ((status = 'open') = (closed_at IS NULL)),
  CONSTRAINT care_task_cancel_why CHECK (status <> 'cancelled' OR close_note IS NOT NULL)
);
CREATE INDEX care_task_assignee_idx ON care_task (org_id, assignee_user_id, status, due_on);
CREATE INDEX care_task_patient_idx ON care_task (patient_id, status, created_at DESC);
SELECT app.apply_tenant_rls('care_task');

COMMENT ON COLUMN care_plan.interventions IS 'Planned interventions, each {item, by}: by = the discipline responsible (doc:38).';
COMMENT ON COLUMN care_plan.monitoring IS 'What is monitored between visits, each {item, everyDays, how}: how = phone | visit | any (doc:38, :50-51).';
COMMENT ON COLUMN care_plan.escalation IS 'The NP''s escalation parameters, each {measure, threshold} (doc:38, :55).';
COMMENT ON TABLE care_program_enrollment IS 'PCM/CCM enrolment with its consent (doc:38, :101).';
COMMENT ON TABLE phone_encounter IS 'Telephone encounters between visits (doc:52).';
COMMENT ON TABLE escalation_alert IS 'A finding that crossed the NP''s escalation parameters (doc:55-57).';
COMMENT ON TABLE care_task IS 'Tasks to the interdisciplinary team (doc:40, :54).';
