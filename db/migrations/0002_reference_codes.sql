-- ============================================================================
-- 0002_reference_codes.sql
-- Reference taxonomies: medical codes, modifiers, place-of-service, ICD-10,
-- NUCC provider taxonomy, revenue codes, MS-DRG, NDC, HCC mapping.
--
-- These tables are GLOBAL (no RLS). They contain public information or
-- AMA-licensed CPT *numbers* (we never store AMA's verbatim long descriptors).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- code: CPT (AMA) + HCPCS Level II (CMS public domain).
-- We store the code number and our OWN paraphrased short descriptor.
-- AMA's verbatim long descriptors are NEVER stored or displayed.
-- ---------------------------------------------------------------------------
CREATE TABLE code (
  code                TEXT        NOT NULL,
  code_system         TEXT        NOT NULL CHECK (code_system IN ('CPT', 'HCPCS2')),
  short_descriptor    TEXT        NOT NULL,                  -- our wording, not AMA verbatim
  category            TEXT,                                  -- e.g. 'E/M Home Visit', 'ACP', 'DMEPOS'
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  superseded_by       TEXT,                                  -- code that replaces this one
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (code, effective_date),
  CHECK (expiration_date IS NULL OR expiration_date > effective_date)
);

CREATE INDEX code_active_idx ON code (code) WHERE expiration_date IS NULL;
CREATE INDEX code_category_idx ON code (category) WHERE expiration_date IS NULL;

COMMENT ON TABLE code IS 'CPT and HCPCS Level II codes. NEVER store AMA verbatim long descriptors here.';
COMMENT ON COLUMN code.short_descriptor IS 'Our paraphrased short description; AMA copyright notice required wherever displayed.';

-- ---------------------------------------------------------------------------
-- modifier: 2-character modifiers + relationship rules.
-- Examples: 25, 59, XE/XP/XS/XU, 95/GT/GQ, JW/JZ, GA/GX/GY/GZ, KX, RR.
-- ---------------------------------------------------------------------------
CREATE TABLE modifier (
  modifier            TEXT        PRIMARY KEY,               -- e.g. '25', '95', 'XE'
  description         TEXT        NOT NULL,
  modifier_type       TEXT        NOT NULL,                  -- 'pricing'|'informational'|'distinct_service'|'telehealth'|'abn'|'dme'|'drug'
  payer_applicability TEXT[]      NOT NULL DEFAULT '{}',     -- e.g. {'Medicare','Commercial'}; empty = all
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

-- Modifier relationships: hierarchy + mutual exclusion + required-combo.
CREATE TABLE modifier_relationship (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_a          TEXT        NOT NULL REFERENCES modifier(modifier),
  modifier_b          TEXT        NOT NULL REFERENCES modifier(modifier),
  relationship_type   TEXT        NOT NULL CHECK (relationship_type IN (
                        'preferred_over',     -- a preferred over b (e.g. XE > 59)
                        'mutually_exclusive', -- never combined on same line
                        'required_with',      -- if a, then b also required
                        'incompatible_with'   -- a and b on same line is a denial
                      )),
  rationale           TEXT,
  source_url          TEXT,
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  UNIQUE (modifier_a, modifier_b, relationship_type, effective_date)
);

-- ---------------------------------------------------------------------------
-- pos: Place of Service codes (CMS).
-- Examples: 02 telehealth-not-home (facility rate), 10 telehealth-home (non-facility),
-- 11 office, 12 home, 21 inpatient hospital, 22 on-campus outpatient, etc.
-- ---------------------------------------------------------------------------
CREATE TABLE pos (
  pos                 TEXT        PRIMARY KEY,               -- 2-digit code
  description         TEXT        NOT NULL,
  facility_indicator  TEXT        NOT NULL CHECK (facility_indicator IN ('facility','non_facility')),
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

-- ---------------------------------------------------------------------------
-- icd10: ICD-10-CM diagnosis codes.
-- Loaded from CDC tabular file annually (Oct 1 effective).
-- ---------------------------------------------------------------------------
CREATE TABLE icd10 (
  code                TEXT        NOT NULL,
  description         TEXT        NOT NULL,                  -- short description (CMS public)
  billable            BOOLEAN     NOT NULL,                  -- billable to highest specificity
  chapter             TEXT,                                  -- e.g. 'C00-D49' Neoplasms
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  PRIMARY KEY (code, effective_date)
);

CREATE INDEX icd10_active_idx ON icd10 (code) WHERE expiration_date IS NULL;
CREATE INDEX icd10_chapter_idx ON icd10 (chapter) WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- provider_taxonomy: NUCC 10-character codes.
-- e.g. 363LF0000X = Family NP, 363AM0700X = PA Medical, 1041C0700X = LCSW.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_taxonomy (
  taxonomy            TEXT        PRIMARY KEY,
  classification      TEXT        NOT NULL,                  -- e.g. 'Nurse Practitioner'
  specialization      TEXT,                                  -- e.g. 'Family'
  grouping            TEXT        NOT NULL,                  -- e.g. 'Physician Assistants & Advanced Practice Nursing Providers'
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

-- ---------------------------------------------------------------------------
-- revenue_code: 4-digit institutional revenue codes (UB-04 FL 42 / 837I).
-- ---------------------------------------------------------------------------
CREATE TABLE revenue_code (
  code                CHAR(4)     PRIMARY KEY,
  description         TEXT        NOT NULL,
  category            TEXT        NOT NULL,                  -- 'accommodation'|'ancillary'|'hospice'|'home_health'|'pharmacy'|...
  setting             TEXT[]      NOT NULL DEFAULT '{}',     -- {'hospital','snf','home_health','hospice'}
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

-- ---------------------------------------------------------------------------
-- ms_drg: Medicare Severity Diagnosis Related Groups (CMS public).
-- FY2026 = v43 effective Oct 1, 2025.
-- ---------------------------------------------------------------------------
CREATE TABLE ms_drg (
  code                CHAR(3)     NOT NULL,
  description         TEXT        NOT NULL,
  mdc                 TEXT        NOT NULL,                  -- Major Diagnostic Category, e.g. '05' Circulatory
  drg_type            TEXT        NOT NULL CHECK (drg_type IN ('medical','surgical')),
  relative_weight     NUMERIC(7,4) NOT NULL,
  geometric_mean_los  NUMERIC(5,2),
  arithmetic_mean_los NUMERIC(5,2),
  fy_version          TEXT        NOT NULL,                  -- 'v43'
  effective_date      DATE        NOT NULL,
  expiration_date     DATE,
  PRIMARY KEY (code, fy_version)
);

-- ---------------------------------------------------------------------------
-- ndc: National Drug Code (FDA, normalized to 11 digits).
-- Paired with -JW/-JZ wastage modifiers and J-code drugs.
-- ---------------------------------------------------------------------------
CREATE TABLE ndc (
  ndc11               CHAR(11)    PRIMARY KEY,               -- e.g. '00069102001'
  proprietary_name    TEXT,
  nonproprietary_name TEXT,
  hcpcs_jcode         TEXT,                                  -- linked HCPCS J-code (e.g. 'J9035')
  unit_size_ml        NUMERIC(10,4),
  units_per_package   INT,
  effective_date      DATE        NOT NULL,
  expiration_date     DATE
);

CREATE INDEX ndc_jcode_idx ON ndc (hcpcs_jcode) WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- hcc_mapping: ICD-10 → CMS-HCC (Hierarchical Condition Categories) + RxHCC.
-- Foundation for Phase 6 risk-adjustment product.
-- ---------------------------------------------------------------------------
CREATE TABLE hcc_mapping (
  icd10               TEXT        NOT NULL,
  hcc_version         TEXT        NOT NULL,                  -- 'V28'
  hcc_code            TEXT        NOT NULL,
  category            TEXT,                                  -- e.g. 'Diabetes_with_chronic_complications'
  rxhcc_code          TEXT,
  raf_weight          NUMERIC(7,4),
  effective_year      INT         NOT NULL,
  PRIMARY KEY (icd10, hcc_version, hcc_code, effective_year)
);
