-- ============================================================================
-- 0111_intake_referrals.sql
--
-- Level-1 audit (27 Oct 2026), intake and administration (doc:22-28). Every
-- intake created an active patient, so there was no referral board, no stage,
-- no pending requirements, no triage, no record of insurance verification and
-- no reason when a patient was not taken under care (NTUC). Mark, 3 Sep
-- [00:38]: intake "does all the referrals, gets all the demographics in ...
-- the insurance verification, the triage, referral tracking, scheduling".
--
--   org_reason_code         the practice's discharge and NTUC codes, its EHR's
--                           numbering (01-10 with 01b/02b; 20a-27), each with
--                           a category the reports roll up by. Mark Q11a
--                           default: preloaded and editable. The defaults are
--                           written by the app on first use
--                           (lib/features/referrals/reason-codes.ts), so a
--                           practice gets them however it was created: signup,
--                           a seed or an import.
--   referral                one per referral received, from receipt to its
--                           disposition: admitted (with the patient it became),
--                           NTUC (with its code and date), transitioned, or
--                           still pre-admission / pending long term. The
--                           person is held here until admission, so a referral
--                           that is never admitted never becomes a patient and
--                           the census stays the census.
--   referral_triage         the nurse's triage (doc:26-27): symptoms,
--                           immediate needs, preliminary acuity, possible
--                           hospice eligibility. Append-only; the latest is
--                           the current one.
--   insurance_verification  each check of a patient's or a referral's
--                           coverage (doc:23): how, what it said, by whom,
--                           when. Manual until a clearinghouse is chosen
--                           (Mark Q3).
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

-- 1. Reason codes.
CREATE TABLE org_reason_code (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('discharge', 'ntuc')),
  code        TEXT        NOT NULL CHECK (code ~ '^[0-9]{2}[a-z]?$'),
  label       TEXT        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  -- What the reports count a code as: transitions to the partner hospice and
  -- to other hospices, deaths on service, and so on (doc:93, :108-109).
  category    TEXT        NOT NULL CHECK (category IN (
                'hospice_partner', 'hospice_other', 'goals_met', 'moved', 'lost_contact',
                'declined', 'death', 'non_compliance', 'other_agency', 'not_appropriate',
                'other')),
  -- Retire rather than delete: past dispositions keep the code they were given.
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order  INT         NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT org_reason_code_org_kind_code_uniq UNIQUE (org_id, kind, code)
);

SELECT app.apply_tenant_rls('org_reason_code');

-- 2. Referrals.
CREATE TABLE referral (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- The practice day it came in (Mark Q11l default). Time to first visit and
  -- the month a referral counts in are measured from it.
  received_on             DATE        NOT NULL,
  first_name              TEXT        NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name               TEXT        NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  date_of_birth           DATE,
  phone                   TEXT        CHECK (phone IS NULL OR length(phone) <= 40),
  -- Who sent it: a practice, clinic or hospital (the EHR's "Source volume").
  source_name             TEXT        CHECK (source_name IS NULL OR length(btrim(source_name)) BETWEEN 1 AND 150),
  referring_provider_name TEXT        CHECK (referring_provider_name IS NULL OR length(referring_provider_name) <= 150),
  referring_provider_npi  TEXT        CHECK (referring_provider_npi IS NULL OR referring_provider_npi ~ '^[0-9]{10}$'),
  reason                  TEXT        CHECK (reason IS NULL OR length(reason) <= 2000),
  primary_diagnosis_icd10 TEXT        CHECK (primary_diagnosis_icd10 IS NULL OR length(primary_diagnosis_icd10) <= 10),
  payer_id                UUID        REFERENCES payer(id),
  member_id               TEXT        CHECK (member_id IS NULL OR length(member_id) <= 120),
  -- pgp_sym_encrypt companion, as patient.primary_member_id_enc (0034).
  member_id_enc           BYTEA,
  -- The pipeline stages of the practice's current EHR.
  stage                   TEXT        NOT NULL DEFAULT 'pre_admission' CHECK (stage IN (
                            'pre_admission', 'pending_long_term', 'admitted', 'ntuc', 'transitioned')),
  stage_changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What is still needed before admission (Mark Q11d default: an editable
  -- list, starting empty): [{ "id", "label", "doneAt", "doneBy" }].
  requirements            JSONB       NOT NULL DEFAULT '[]'::jsonb
                                      CHECK (jsonb_typeof(requirements) = 'array'),
  ntuc_reason_code_id     UUID        REFERENCES org_reason_code(id),
  ntuc_on                 DATE,
  -- Why it was set aside or transitioned, or anything about the NTUC.
  closed_note             TEXT        CHECK (closed_note IS NULL OR length(closed_note) <= 1000),
  admitted_on             DATE,
  patient_id              UUID        REFERENCES patient(id),
  assigned_to_user_id     UUID        REFERENCES app_user(id),
  notes                   TEXT        CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by_user_id      UUID        REFERENCES app_user(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A disposition carries what it means: NTUC its code and day, an admission
  -- its patient and day.
  CONSTRAINT referral_ntuc_has_reason
    CHECK (stage <> 'ntuc' OR (ntuc_reason_code_id IS NOT NULL AND ntuc_on IS NOT NULL)),
  CONSTRAINT referral_admitted_has_patient
    CHECK (stage <> 'admitted' OR (patient_id IS NOT NULL AND admitted_on IS NOT NULL))
);

CREATE INDEX referral_org_stage_idx ON referral (org_id, stage, received_on DESC);
-- One referral became this patient; a second admit of the same referral is refused.
CREATE UNIQUE INDEX referral_patient_uniq ON referral (patient_id) WHERE patient_id IS NOT NULL;

SELECT app.apply_tenant_rls('referral');

-- 3. Triage.
CREATE TABLE referral_triage (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  referral_id         UUID        NOT NULL REFERENCES referral(id) ON DELETE CASCADE,
  symptoms            TEXT        CHECK (symptoms IS NULL OR length(symptoms) <= 2000),
  immediate_needs     TEXT        CHECK (immediate_needs IS NULL OR length(immediate_needs) <= 2000),
  preliminary_acuity  TEXT        CHECK (preliminary_acuity IS NULL OR preliminary_acuity IN (
                                    'low', 'medium', 'high', 'critical')),
  hospice_eligible    TEXT        CHECK (hospice_eligible IS NULL OR hospice_eligible IN ('yes', 'no', 'unsure')),
  hospice_basis       TEXT        CHECK (hospice_basis IS NULL OR length(hospice_basis) <= 1000),
  triaged_by_user_id  UUID        REFERENCES app_user(id),
  triaged_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX referral_triage_referral_idx ON referral_triage (referral_id, triaged_at DESC);

SELECT app.apply_tenant_rls('referral_triage');

-- 4. Insurance verification.
CREATE TABLE insurance_verification (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  referral_id           UUID        REFERENCES referral(id) ON DELETE CASCADE,
  patient_id            UUID        REFERENCES patient(id) ON DELETE CASCADE,
  payer_id              UUID        REFERENCES payer(id),
  member_id             TEXT        CHECK (member_id IS NULL OR length(member_id) <= 120),
  member_id_enc         BYTEA,
  method                TEXT        NOT NULL CHECK (method IN ('portal', 'phone', 'clearinghouse', 'other')),
  result                TEXT        NOT NULL CHECK (result IN ('active', 'inactive', 'not_found', 'pending')),
  coverage_effective_on DATE,
  coverage_ends_on      DATE,
  -- The call or portal reference the payer gave.
  reference             TEXT        CHECK (reference IS NULL OR length(reference) <= 100),
  notes                 TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  verified_by_user_id   UUID        REFERENCES app_user(id),
  verified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT insurance_verification_has_subject CHECK (referral_id IS NOT NULL OR patient_id IS NOT NULL),
  CONSTRAINT insurance_verification_dates CHECK (
    coverage_effective_on IS NULL OR coverage_ends_on IS NULL OR coverage_ends_on >= coverage_effective_on)
);

CREATE INDEX insurance_verification_referral_idx ON insurance_verification (referral_id, verified_at DESC);
CREATE INDEX insurance_verification_patient_idx ON insurance_verification (patient_id, verified_at DESC);

SELECT app.apply_tenant_rls('insurance_verification');

COMMENT ON TABLE referral IS
  'One per referral received, from receipt to disposition (Level-1 doc:24-25). The person is held here until admitted; patient_id is the patient they became.';
COMMENT ON TABLE org_reason_code IS
  'The practice''s discharge (01-10) and NTUC (20a-27) codes, its EHR''s numbering, with the category reports count each as.';
