-- ============================================================================
-- 0011_phase5_dme_wc_cms0057.sql
-- Phase 5 — DMEPOS Master List, Workers' Comp state fee schedules,
-- CMS-0057-F PA API response cache.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- dme_master_list — CMS DMEPOS Master List entries; subject to heightened
-- documentation + face-to-face + prior-auth requirements.
-- 2026 update (effective Apr 13, 2026) added 18 codes per Federal Register.
-- ---------------------------------------------------------------------------
CREATE TABLE dme_master_list (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT        NOT NULL,                  -- HCPCS Level II code
  description           TEXT,
  requires_face_to_face BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_prior_auth   BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_cmn          BOOLEAN     NOT NULL DEFAULT FALSE,    -- Certificate of Medical Necessity
  payment_threshold_dollar NUMERIC(12,2),                       -- threshold above which PA applies
  effective_date        DATE        NOT NULL,
  expiration_date       DATE,
  source_release        TEXT        NOT NULL,                  -- e.g. 'CMS DMEPOS ML 2026-04-13'
  source_url            TEXT,
  CHECK (expiration_date IS NULL OR expiration_date > effective_date),
  UNIQUE (code, effective_date)
);

CREATE INDEX dme_master_list_code_active_idx ON dme_master_list (code)
  WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- wc_state_fee_schedule — state Workers' Compensation fee-schedule conversion
-- factors per (state, year). Multiplied against RVU to compute allowable.
-- ---------------------------------------------------------------------------
CREATE TABLE wc_state_fee_schedule (
  state                 CHAR(2)     NOT NULL REFERENCES state(state),
  year                  SMALLINT    NOT NULL,
  conversion_factor     NUMERIC(8,4) NOT NULL,
  effective_date        DATE        NOT NULL,
  expiration_date       DATE,
  adopts_cms_codes      BOOLEAN     NOT NULL DEFAULT TRUE,     -- adopts annual CMS CPT/HCPCS update
  notes                 TEXT,
  source_url            TEXT,
  PRIMARY KEY (state, year, effective_date)
);

CREATE INDEX wc_state_fee_schedule_state_idx ON wc_state_fee_schedule (state, year);

-- ---------------------------------------------------------------------------
-- cms_0057_pa_response — cached prior-authorization API responses from
-- payers (FHIR R4 Patient/Provider/PA APIs). Used to backfill payer_rule
-- rows at confidence 1.0 once the Jan 1, 2027 mandate is live.
-- Tenant-scoped — per-org because PA queries are member-specific.
-- ---------------------------------------------------------------------------
CREATE TABLE cms_0057_pa_response (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  payer_id              UUID        REFERENCES payer(id),
  request_correlation_id TEXT       NOT NULL,                  -- our internal id
  fhir_request_uri      TEXT        NOT NULL,
  fhir_response_status  INT         NOT NULL,
  fhir_response_body    JSONB       NOT NULL,
  pa_required           BOOLEAN,                                -- decoded
  decision              TEXT,                                   -- 'approved' | 'denied' | 'pending' | 'unknown'
  documentation_codes   TEXT[]      NOT NULL DEFAULT '{}',     -- LOINC / required-doc codes from PA response
  patient_external_id   TEXT,                                   -- de-identified ref
  service_codes         TEXT[]      NOT NULL DEFAULT '{}',
  date_of_service       DATE,
  retrieved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* When this response was promoted into a payer_rule via the analyst flow,
     we link to the resulting candidate so we can show provenance. */
  resulting_candidate_id UUID       REFERENCES extraction_candidate(id)
);

CREATE INDEX cms_0057_pa_response_payer_dos_idx
  ON cms_0057_pa_response (payer_id, date_of_service DESC);
CREATE INDEX cms_0057_pa_response_codes_idx
  ON cms_0057_pa_response USING GIN (service_codes);

SELECT app.apply_tenant_rls('cms_0057_pa_response');

-- ---------------------------------------------------------------------------
-- ihs_encounter_rate — annual IHS All-Inclusive Rate (per CMS/IHS Federal
-- Register notices). Tribal 638 facilities and IHS-operated facilities bill
-- T1015 at the encounter rate for Medicaid.
-- ---------------------------------------------------------------------------
CREATE TABLE ihs_encounter_rate (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  setting               TEXT        NOT NULL CHECK (setting IN ('outpatient','inpatient_per_diem','dental','medicare_clinic')),
  effective_year        INT         NOT NULL,
  amount                NUMERIC(10,2) NOT NULL,
  source_federal_register TEXT,
  notes                 TEXT,
  UNIQUE (setting, effective_year)
);

COMMENT ON TABLE dme_master_list IS
  'CMS DMEPOS Master List of items subject to heightened documentation, face-to-face, and prior auth.';
COMMENT ON TABLE wc_state_fee_schedule IS
  'State Workers'' Compensation fee schedule conversion factors per year.';
COMMENT ON TABLE cms_0057_pa_response IS
  'Cached FHIR Prior Authorization API responses for CMS-0057-F backfill into payer_rule.';
COMMENT ON TABLE ihs_encounter_rate IS
  'IHS All-Inclusive Rates per Federal Register; T1015 + SE modifier billing.';
