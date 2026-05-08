-- ============================================================================
-- 0003_payers_and_rules.sql
-- Payer registry, the answer table (payer_rule), NCCI bundling, documentation
-- requirements, and Coordination of Benefits rules.
--
-- All GLOBAL (no RLS). Reference data shared across tenants.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- state: 2-letter state codes (and DC, territories).
-- ---------------------------------------------------------------------------
CREATE TABLE state (
  state               CHAR(2)     PRIMARY KEY,
  name                TEXT        NOT NULL,
  region              TEXT,                                   -- e.g. 'Southeast'
  mac_jurisdiction    TEXT                                    -- e.g. 'JM' for NC/SC/VA/WV
);

-- ---------------------------------------------------------------------------
-- product_line: enum-as-table (more flexible than a Postgres enum for additions).
-- ---------------------------------------------------------------------------
CREATE TABLE product_line (
  product_line        TEXT        PRIMARY KEY,
  description         TEXT        NOT NULL,
  claim_form_type     TEXT        NOT NULL CHECK (claim_form_type IN ('professional', 'institutional', 'either'))
);

-- ---------------------------------------------------------------------------
-- payer: insurance carriers, MACs, Medicaid programs.
-- ---------------------------------------------------------------------------
CREATE TABLE payer (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                CITEXT      NOT NULL,
  parent_org          TEXT,                                   -- e.g. 'Centene' for Buckeye, ATC, etc.
  payer_type          TEXT        NOT NULL CHECK (payer_type IN (
                        'medicare_mac', 'medicare_advantage_org', 'medicaid_state',
                        'medicaid_mco', 'commercial', 'tpa', 'workers_comp',
                        'auto_no_fault', 'tribal', 'self_insured', 'other'
                      )),
  states_served       CHAR(2)[]   NOT NULL DEFAULT '{}',
  npi                 TEXT,                                   -- payer NPI when applicable
  external_payer_id   TEXT,                                   -- e.g. CAQH ID, Trizetto ID
  policy_index_url    TEXT,                                   -- public policy library URL
  notes               TEXT,
  active              BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payer_name_idx ON payer (name);
CREATE INDEX payer_states_gin ON payer USING GIN (states_served);

-- ---------------------------------------------------------------------------
-- source_document: every cited PDF/HTML/API response.
-- Hashed for change detection; S3-archived for legal/audit.
-- ---------------------------------------------------------------------------
CREATE TABLE source_document (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id            UUID        REFERENCES payer(id),
  url                 TEXT        NOT NULL,
  document_type       TEXT        NOT NULL CHECK (document_type IN (
                        'medical_policy', 'reimbursement_policy', 'provider_manual',
                        'mln_article', 'ncd', 'lcd', 'lcd_article', 'cms_pfs',
                        'cms_coverage_api', 'hcpcs_release', 'ncci_release',
                        'analyst_call', 'client_upload', 'cms_0057_pa_api',
                        'state_medicaid_manual', 'wc_fee_schedule', 'ihs_rate'
                      )),
  title               TEXT,
  effective_date      DATE,
  retrieved_at        TIMESTAMPTZ NOT NULL,
  content_hash        TEXT        NOT NULL,                    -- sha256 of raw document
  storage_uri         TEXT,                                    -- s3://bucket/path
  cms_license_token_used BOOLEAN  NOT NULL DEFAULT FALSE,
  source_metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX source_document_payer_idx ON source_document (payer_id);
CREATE INDEX source_document_hash_idx ON source_document (content_hash);

-- ---------------------------------------------------------------------------
-- documentation_requirement: structured documentation rules per (code, payer, state).
-- Supports E/M MDM-or-time, ACP voluntary-discussion phrases, RPM 16-day, etc.
-- ---------------------------------------------------------------------------
CREATE TABLE documentation_requirement (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        TEXT        NOT NULL,
  payer_id                    UUID        REFERENCES payer(id),    -- NULL = applies to all payers
  state                       CHAR(2)     REFERENCES state(state), -- NULL = applies to all states
  product_line                TEXT        REFERENCES product_line(product_line),
  time_total_minutes_min      INT,                                 -- E/M time threshold
  time_components             TEXT[]      NOT NULL DEFAULT '{}',   -- 'face_to_face','prep','followup_same_day'
  mdm_elements                TEXT[]      NOT NULL DEFAULT '{}',   -- 'problems_addressed','data_reviewed','risk_assessment'
  required_phrases            TEXT[]      NOT NULL DEFAULT '{}',   -- e.g. 'voluntary discussion','advance directives'
  required_chart_elements     TEXT[]      NOT NULL DEFAULT '{}',   -- 'caregiver_present','vitals'
  rpm_days_data_required_min  INT,                                 -- e.g. 16 for 99454; 2 for 99445
  source_doc_id               UUID        REFERENCES source_document(id),
  effective_date              DATE        NOT NULL,
  expiration_date             DATE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX doc_req_lookup_idx ON documentation_requirement
  (code, payer_id, state, product_line, effective_date DESC)
  WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- payer_rule: THE ANSWER TABLE.
-- One row per (payer, state, product_line, code, attribute, effective_date).
-- Versioned via effective_date / expiration_date / superseded_by — never UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE payer_rule (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id                    UUID        NOT NULL REFERENCES payer(id),
  state                       CHAR(2)     NOT NULL REFERENCES state(state),
  product_line                TEXT        NOT NULL REFERENCES product_line(product_line),
  code                        TEXT        NOT NULL,                -- CPT or HCPCS
  attribute                   TEXT        NOT NULL CHECK (attribute IN (
                                'covered','telehealth_allowed','pos_allowed',
                                'modifier_required','modifier_optional','modifier_combinations',
                                'frequency_limit','prior_auth_required',
                                'medical_necessity_icd10','bundled_with',
                                'documentation_required','provider_taxonomy_allowed',
                                'timely_filing_days','mhpaea_paired_code',
                                'place_of_service_payment','revenue_code_allowed',
                                'surprise_billing_protected','abn_recommended',
                                'units_per_period_max','copay_or_costshare'
                              )),
  value                       JSONB       NOT NULL,
  coverage_status             TEXT        NOT NULL CHECK (coverage_status IN (
                                'covered','not_covered','varies','unknown'
                              )),
  confidence                  NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  effective_date              DATE        NOT NULL,
  expiration_date             DATE,
  superseded_by               UUID        REFERENCES payer_rule(id),
  source_doc_id               UUID        NOT NULL REFERENCES source_document(id),
  source_quote                TEXT,
  source_page                 INT,
  documentation_requirement_id UUID       REFERENCES documentation_requirement(id),
  -- denormalized convenience columns for hot-path filters
  provider_taxonomy_allowed   TEXT[]      NOT NULL DEFAULT '{}',
  timely_filing_days          INT,
  mhpaea_paired_code          TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  TEXT        NOT NULL,                -- 'crawler' | analyst email
  CHECK (expiration_date IS NULL OR expiration_date > effective_date)
);

-- Hot-path index: looking up an active rule by full key at a DOS.
CREATE INDEX payer_rule_lookup_idx ON payer_rule
  (payer_id, state, product_line, code, attribute, effective_date DESC)
  WHERE expiration_date IS NULL;

-- For finding all rules touching a code (cross-payer comparison).
CREATE INDEX payer_rule_code_idx ON payer_rule (code) WHERE expiration_date IS NULL;

-- For superseded chain traversal.
CREATE INDEX payer_rule_superseded_idx ON payer_rule (superseded_by);

COMMENT ON TABLE payer_rule IS
  'Authoritative per-attribute payer rules. Never UPDATE; supersede via new INSERT + setting prior expiration_date and superseded_by.';

-- ---------------------------------------------------------------------------
-- ncci_ptp: NCCI Procedure-to-Procedure edits (CMS quarterly).
-- Column 1 / Column 2 pairs with modifier indicator 0/1/9.
-- ---------------------------------------------------------------------------
CREATE TABLE ncci_ptp (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  column1_code        TEXT        NOT NULL,
  column2_code        TEXT        NOT NULL,
  modifier_indicator  SMALLINT    NOT NULL CHECK (modifier_indicator IN (0, 1, 9)),
  -- 0 = no modifier override; 1 = modifier override allowed; 9 = not applicable
  edit_type           TEXT        NOT NULL CHECK (edit_type IN ('practitioner','hospital_outpatient')),
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  rationale           TEXT,
  source_release      TEXT        NOT NULL,                    -- e.g. 'NCCI v32.0'
  CHECK (expiration_date IS NULL OR expiration_date > effective_date),
  UNIQUE (column1_code, column2_code, edit_type, effective_date)
);

CREATE INDEX ncci_ptp_active_idx ON ncci_ptp (column1_code, column2_code, edit_type)
  WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- ncci_mue: NCCI Medically Unlikely Edits (units-of-service maximums).
-- ---------------------------------------------------------------------------
CREATE TABLE ncci_mue (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT        NOT NULL,
  setting             TEXT        NOT NULL CHECK (setting IN ('practitioner','outpatient_hospital','dme')),
  units_max           INT         NOT NULL CHECK (units_max > 0),
  rationale           TEXT,
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  source_release      TEXT        NOT NULL,
  CHECK (expiration_date IS NULL OR expiration_date > effective_date),
  UNIQUE (code, setting, effective_date)
);

CREATE INDEX ncci_mue_active_idx ON ncci_mue (code, setting) WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- cob_rule: Coordination of Benefits priority rules.
-- e.g. (medicare, employer_group_lt_20) → medicare primary.
-- (medicaid, *) → medicaid always last.
-- ---------------------------------------------------------------------------
CREATE TABLE cob_rule (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_type_a     TEXT        NOT NULL,
  coverage_type_b     TEXT        NOT NULL,
  primary_position    TEXT        NOT NULL CHECK (primary_position IN ('A','B','depends','tie_other_rules')),
  conditions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  rationale           TEXT,
  source_url          TEXT,
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

CREATE INDEX cob_rule_lookup_idx ON cob_rule (coverage_type_a, coverage_type_b)
  WHERE expiration_date IS NULL;
