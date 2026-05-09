-- ============================================================================
-- 0029_phase_pallio_emr.sql
--
-- Phase 1 of the Pallio pivot — adds the EMR layer (patient/visit/care_plan/
-- superbill) on top of the existing billing-intelligence schema. Plus the
-- per-permission table for the "permissions are templates not locks" model
-- from the vision (§6.9, §18.7).
--
-- All tenant tables get RLS via `app.apply_tenant_rls()` from 0007.
--
-- Notes on data-model decisions:
--   - `patient` belongs to an org (the palliative-care agency). It carries a
--     `primary_payer_id` referencing the global payer reference table, plus a
--     free-text member_id (PHI — encrypted at rest in Phase 7).
--   - `visit` references both patient and clinician (a row in app_user with
--     org_member). Times are stored as TIMESTAMPTZ — DST mistakes here cascade
--     to wrong billing.
--   - `care_plan` is one current row per patient + a snapshot table for
--     versioning (so we never lose the historical state at the moment a
--     visit was billed).
--   - `superbill` derives from a visit and is the billing artifact. Status is
--     a closed enum-style CHECK so we can reason about state transitions.
--   - `pending_invite` + `user_permission` together implement the "invite a
--     user with explicit permission set" flow from vision §18.7.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- patient: clinical record. PHI-bearing.
-- ---------------------------------------------------------------------------
CREATE TABLE patient (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,

  -- Demographics (PHI — see Phase 7 encryption pass)
  first_name            TEXT        NOT NULL,
  last_name             TEXT        NOT NULL,
  date_of_birth         DATE        NOT NULL,
  sex_assigned_at_birth TEXT        CHECK (sex_assigned_at_birth IN ('M', 'F', 'X', 'unknown')),
  address_line_1        TEXT,
  address_line_2        TEXT,
  city                  TEXT,
  state                 CHAR(2),
  zip                   TEXT,
  phone                 TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,

  -- Insurance — payer is global reference, member_id is per-patient.
  primary_payer_id      UUID        REFERENCES payer(id),
  primary_member_id     TEXT,
  primary_group_number  TEXT,
  insurance_effective_date DATE,
  insurance_termination_date DATE,

  -- Clinical context
  primary_diagnosis_icd10 TEXT,
  referring_physician_npi  TEXT,
  referring_physician_name TEXT,
  palliative_referral_reason TEXT,

  -- Lifecycle
  status                TEXT        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'discharged', 'deceased', 'archived')),
  discharged_at         TIMESTAMPTZ,
  archived_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID
);

CREATE INDEX patient_org_status_idx ON patient (org_id, status);
CREATE INDEX patient_org_payer_idx  ON patient (org_id, primary_payer_id);
CREATE INDEX patient_org_dob_idx    ON patient (org_id, date_of_birth);
-- Lower(name) for case-insensitive search; common access pattern.
CREATE INDEX patient_org_name_idx   ON patient (org_id, lower(last_name), lower(first_name));

COMMENT ON TABLE patient IS
  'Clinical patient record (PHI). One per (org, person). Insurance + demographics + clinical context.';

SELECT app.apply_tenant_rls('patient');


-- ---------------------------------------------------------------------------
-- visit: one documented clinical encounter.
-- ---------------------------------------------------------------------------
CREATE TABLE visit (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  clinician_user_id     UUID        NOT NULL REFERENCES app_user(id),

  visit_type            TEXT        NOT NULL
                                    CHECK (visit_type IN (
                                      'new_patient_home', 'established_patient_home',
                                      'advance_care_planning', 'telehealth', 'inpatient_consult'
                                    )),
  scheduled_start       TIMESTAMPTZ,
  scheduled_end         TIMESTAMPTZ,
  start_time            TIMESTAMPTZ,
  stop_time             TIMESTAMPTZ,
  -- Cached computed minutes; verified at write time. Source of truth is the
  -- start/stop pair when both present.
  total_minutes         INT,
  -- ACP minutes are tracked separately so 99497/99498 can be added on top
  -- of the base visit code without double-counting.
  acp_minutes           INT         DEFAULT 0,
  -- Prolonged service (G0318 Medicare / 99417 non-Medicare) thresholds are
  -- computed from total_minutes - base-code-threshold. Cached for the table.
  prolonged_minutes     INT         DEFAULT 0,

  -- Telehealth
  is_telehealth         BOOLEAN     NOT NULL DEFAULT FALSE,
  telehealth_modality   TEXT        CHECK (telehealth_modality IN ('audio_video', 'audio_only')),
  telehealth_consent_documented BOOLEAN DEFAULT FALSE,

  -- Documentation
  document_text         TEXT,
  cpt_codes_assigned    TEXT[]      DEFAULT ARRAY[]::TEXT[],
  icd10_codes           TEXT[]      DEFAULT ARRAY[]::TEXT[],
  modifiers             TEXT[]      DEFAULT ARRAY[]::TEXT[],

  -- Lifecycle
  status                TEXT        NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN (
                                      'scheduled', 'in_progress', 'documented',
                                      'pending_billing', 'billed', 'cancelled', 'no_show'
                                    )),
  signed_at             TIMESTAMPTZ,
  signed_by_user_id     UUID,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Sanity: stop_time must be after start_time when both present.
  CONSTRAINT visit_time_range_chk CHECK (
    stop_time IS NULL OR start_time IS NULL OR stop_time >= start_time
  ),
  -- ACP + prolonged minutes are non-negative.
  CONSTRAINT visit_acp_nonneg_chk CHECK (acp_minutes IS NULL OR acp_minutes >= 0),
  CONSTRAINT visit_prolonged_nonneg_chk CHECK (prolonged_minutes IS NULL OR prolonged_minutes >= 0)
);

CREATE INDEX visit_patient_idx       ON visit (patient_id, scheduled_start DESC);
CREATE INDEX visit_clinician_day_idx ON visit (clinician_user_id, scheduled_start DESC);
CREATE INDEX visit_org_status_idx    ON visit (org_id, status);
CREATE INDEX visit_org_billable_idx  ON visit (org_id, status)
  WHERE status IN ('documented', 'pending_billing');

COMMENT ON TABLE visit IS
  'One documented clinical encounter. Drives CPT suggestion + superbill generation.';

SELECT app.apply_tenant_rls('visit');


-- ---------------------------------------------------------------------------
-- care_plan: living document, one current per patient + version snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE care_plan (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,

  -- TipTap JSON document — schemaless. Keeps clinician-facing structure
  -- flexible while we iterate on the palliative template (vision §18.9
  -- flagged this as needing Mark's input).
  document              JSONB       NOT NULL DEFAULT '{}'::JSONB,
  goals_of_care_summary TEXT,
  primary_symptoms      TEXT[]      DEFAULT ARRAY[]::TEXT[],
  active_medications    TEXT[]      DEFAULT ARRAY[]::TEXT[],

  current_version       INT         NOT NULL DEFAULT 1,
  last_updated_visit_id UUID        REFERENCES visit(id),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (patient_id)  -- one current care plan per patient
);

CREATE INDEX care_plan_org_idx ON care_plan (org_id, updated_at DESC);

SELECT app.apply_tenant_rls('care_plan');


-- Care plan version snapshots — frozen at the moment a visit was signed.
CREATE TABLE care_plan_version (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  care_plan_id          UUID        NOT NULL REFERENCES care_plan(id) ON DELETE CASCADE,
  version               INT         NOT NULL,
  document              JSONB       NOT NULL,
  snapshot_visit_id     UUID        REFERENCES visit(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID,

  UNIQUE (care_plan_id, version)
);

CREATE INDEX care_plan_version_org_idx ON care_plan_version (org_id, created_at DESC);

SELECT app.apply_tenant_rls('care_plan_version');


-- ---------------------------------------------------------------------------
-- superbill: billing artifact derived from a visit.
-- ---------------------------------------------------------------------------
CREATE TABLE superbill (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  visit_id              UUID        NOT NULL REFERENCES visit(id) ON DELETE RESTRICT,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  payer_id              UUID        REFERENCES payer(id),

  -- Frozen copy of the patient/visit details at the moment the superbill
  -- was generated (so future changes to the patient record don't mutate
  -- past claims).
  member_id_snapshot    TEXT        NOT NULL,
  date_of_service       DATE        NOT NULL,
  cpt_codes             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  icd10_codes           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  modifiers             TEXT[]      DEFAULT ARRAY[]::TEXT[],
  provider_npi          TEXT        NOT NULL,
  provider_name         TEXT        NOT NULL,
  -- 11 = Office, 12 = Home, 02 = Telehealth (provider's home), etc.
  place_of_service_code TEXT        NOT NULL,
  -- Total billed amount in cents to avoid float math.
  billed_amount_cents   BIGINT      NOT NULL DEFAULT 0,

  status                TEXT        NOT NULL DEFAULT 'draft'
                                    CHECK (status IN (
                                      'draft', 'ready_to_submit', 'submitted',
                                      'paid', 'partially_paid', 'denied', 'voided'
                                    )),
  submitted_at          TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  paid_amount_cents     BIGINT,
  generated_pdf_path    TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One superbill per visit (refile uses claim_resubmission instead — TBD
  -- if we need that table).
  UNIQUE (visit_id)
);

CREATE INDEX superbill_org_status_idx ON superbill (org_id, status);
CREATE INDEX superbill_org_dos_idx    ON superbill (org_id, date_of_service DESC);
CREATE INDEX superbill_payer_idx      ON superbill (org_id, payer_id);

SELECT app.apply_tenant_rls('superbill');


-- ---------------------------------------------------------------------------
-- pending_invite: invitation flow for new team members.
-- See vision §18.7 for the transactional invite-and-permission flow.
-- ---------------------------------------------------------------------------
CREATE TABLE pending_invite (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  email                 CITEXT      NOT NULL,
  role_template         TEXT        NOT NULL
                                    CHECK (role_template IN (
                                      'org_admin', 'clinician', 'billing_agent',
                                      'consultant', 'analyst', 'read_only'
                                    )),
  invited_by_user_id    UUID        NOT NULL REFERENCES app_user(id),

  -- One-time token. Stored as the token itself; in prod we'd hash and
  -- compare so a DB leak doesn't grant invite access.
  token                 TEXT        NOT NULL UNIQUE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  redeemed_at           TIMESTAMPTZ,
  redeemed_by_user_id   UUID REFERENCES app_user(id),

  -- One pending invite per (org, email).
  UNIQUE (org_id, email)
);

CREATE INDEX pending_invite_org_idx ON pending_invite (org_id, expires_at);

SELECT app.apply_tenant_rls('pending_invite');


-- ---------------------------------------------------------------------------
-- user_permission: per-user, per-org permission grants.
-- Permission strings are exact per vision §18.4. NEVER add a free-text
-- column — the set is closed.
-- ---------------------------------------------------------------------------
CREATE TABLE user_permission (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Nullable until the invite is redeemed (vision §18.7 step 2).
  user_id               UUID        REFERENCES app_user(id) ON DELETE CASCADE,
  -- When user_id is null, this row belongs to a pending invite.
  pending_invite_id     UUID        REFERENCES pending_invite(id) ON DELETE CASCADE,

  permission            TEXT        NOT NULL,
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_user_id    UUID        REFERENCES app_user(id),

  -- Either the row is attached to a real user OR a pending invite, never both
  -- and never neither.
  CONSTRAINT user_permission_target_chk CHECK (
    (user_id IS NOT NULL AND pending_invite_id IS NULL) OR
    (user_id IS NULL     AND pending_invite_id IS NOT NULL)
  )
);

-- Uniqueness: one row per (user, org, permission). The partial-unique
-- index avoids collisions during the pending-invite phase where user_id
-- is null.
CREATE UNIQUE INDEX user_permission_unique_idx
  ON user_permission (user_id, org_id, permission)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX pending_invite_permission_unique_idx
  ON user_permission (pending_invite_id, permission)
  WHERE pending_invite_id IS NOT NULL;

CREATE INDEX user_permission_user_idx ON user_permission (user_id, org_id);

SELECT app.apply_tenant_rls('user_permission');


-- ---------------------------------------------------------------------------
-- cpt_code_set: per-org subset of palliative CPT codes the org uses.
-- Lets the wizard pre-select Mark's full palliative set; org admin
-- deselects codes they don't bill.
-- ---------------------------------------------------------------------------
CREATE TABLE org_cpt_code_set (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  cpt_code              TEXT        NOT NULL,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, cpt_code)
);

CREATE INDEX org_cpt_code_set_active_idx ON org_cpt_code_set (org_id, active);

SELECT app.apply_tenant_rls('org_cpt_code_set');
