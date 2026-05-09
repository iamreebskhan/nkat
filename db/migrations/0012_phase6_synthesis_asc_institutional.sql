-- ============================================================================
-- 0012_phase6_synthesis_asc_institutional.sql
-- Phase 6 — LLM synthesis feature flag + ASC payment indicators + UB-04 bill
-- types + revenue-code allowlist per claim_form_type.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- feature_flag — global + per-tenant feature toggles. Drives whether the
-- synthesis layer paraphrases structured findings, what model to use, and
-- experiment cohorts. Tenant-scoped row overrides global default.
-- ---------------------------------------------------------------------------
CREATE TABLE feature_flag (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key              TEXT        NOT NULL,
  org_id                UUID        REFERENCES org(id) ON DELETE CASCADE,
  -- NULL org_id = global default
  enabled               BOOLEAN     NOT NULL,
  config                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  rationale             TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postgres rejects expressions in PRIMARY KEY (only column names allowed).
-- Use a UNIQUE INDEX with the COALESCE so NULL org_id (the global default
-- row) collides with itself for any given flag_key.
CREATE UNIQUE INDEX feature_flag_key_org_idx
  ON feature_flag (flag_key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX feature_flag_lookup_idx ON feature_flag (flag_key, org_id);

-- ---------------------------------------------------------------------------
-- asc_payment_indicator — CMS ASC fee schedule payment groups.
-- Payment groups (e.g. 'A2', 'P1', 'J8') drive the payment formula for
-- ambulatory surgical center claims. Source: CMS ASCFS Addenda.
-- ---------------------------------------------------------------------------
CREATE TABLE asc_payment_indicator (
  code                  TEXT        NOT NULL,                  -- HCPCS / CPT
  payment_indicator     TEXT        NOT NULL,                  -- 'A2','J8','P1', etc.
  payment_group         TEXT,                                   -- e.g. 'Office-based surgical procedure'
  payment_rate          NUMERIC(10,2),                          -- the ASC base rate (informational)
  effective_year        INT         NOT NULL,
  source_url            TEXT,
  PRIMARY KEY (code, payment_indicator, effective_year)
);

CREATE INDEX asc_payment_indicator_year_idx ON asc_payment_indicator (effective_year);

-- ---------------------------------------------------------------------------
-- ub04_bill_type — 3-digit UB-04 bill types (FL 4) + which product_lines
-- they're valid for. Validates institutional claims before submission.
-- ---------------------------------------------------------------------------
CREATE TABLE ub04_bill_type (
  bill_type             CHAR(3)     PRIMARY KEY,
  facility_type         TEXT        NOT NULL,                  -- '0' inpatient, '1' inpatient, '2' SNF, ...
  classification        TEXT,                                  -- '1' inpatient, '3' outpatient, '5' intermediate care, ...
  frequency             TEXT,                                  -- '1' admit, '2' interim-first, '4' final, ...
  description           TEXT        NOT NULL,
  valid_for_product_lines TEXT[]    NOT NULL DEFAULT '{}',     -- e.g. {'institutional_hospice','institutional_home_health'}
  effective_date        DATE        NOT NULL,
  expiration_date       DATE
);

CREATE INDEX ub04_bill_type_active_idx ON ub04_bill_type (bill_type)
  WHERE expiration_date IS NULL;

-- ---------------------------------------------------------------------------
-- revenue_code_product_line — which revenue codes are valid for which
-- institutional product_line. Catches things like a hospice revenue code
-- (0651) on a hospital outpatient claim.
-- ---------------------------------------------------------------------------
CREATE TABLE revenue_code_product_line (
  revenue_code          CHAR(4)     NOT NULL REFERENCES revenue_code(code),
  product_line          TEXT        NOT NULL REFERENCES product_line(product_line),
  valid                 BOOLEAN     NOT NULL DEFAULT TRUE,
  rationale             TEXT,
  effective_date        DATE        NOT NULL,
  expiration_date       DATE,
  PRIMARY KEY (revenue_code, product_line, effective_date)
);

CREATE INDEX revenue_code_product_line_active_idx
  ON revenue_code_product_line (revenue_code, product_line)
  WHERE expiration_date IS NULL;

COMMENT ON TABLE feature_flag IS
  'Global + per-tenant feature flags. Tenant rows override global; lookup uses (flag_key, COALESCE(org_id, NIL)) primary key.';
COMMENT ON TABLE asc_payment_indicator IS
  'CMS ASC fee schedule payment indicators per (code, year). Source: ASCFS Addenda.';
COMMENT ON TABLE ub04_bill_type IS
  '3-digit UB-04 bill types (FL 4); valid_for_product_lines gates which institutional product_lines accept each bill type.';
COMMENT ON TABLE revenue_code_product_line IS
  'Per-product_line allowlist for revenue codes; catches mismatched institutional claim/revenue-code combos.';
