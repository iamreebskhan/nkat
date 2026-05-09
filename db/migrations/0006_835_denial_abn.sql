-- ============================================================================
-- 0006_835_denial_abn.sql
-- 835 ERA ingestion (denial intelligence feedback loop) + ABN tracking.
-- Tenant-scoped; RLS enabled in 0007_rls.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- era_835_record: parsed 835 line-item.
-- Customer-uploaded or clearinghouse-fed; matched back to the payer_rule that
-- should have prevented denial.
-- ---------------------------------------------------------------------------
CREATE TABLE era_835_record (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id           UUID        NOT NULL REFERENCES client_company(id) ON DELETE CASCADE,
  payer_id            UUID        REFERENCES payer(id),
  trace_number        TEXT,                                    -- TRN02 from 835
  claim_id            TEXT,                                    -- CLP01
  patient_external_id TEXT,                                    -- de-id reference
  service_dos         DATE        NOT NULL,
  billed_amount       NUMERIC(12,2),
  paid_amount         NUMERIC(12,2),
  adjustment_amount   NUMERIC(12,2),
  carc_codes          TEXT[]      NOT NULL DEFAULT '{}',
  rarc_codes          TEXT[]      NOT NULL DEFAULT '{}',
  group_code          TEXT,                                    -- CO/PR/OA/PI
  service_codes       TEXT[]      NOT NULL DEFAULT '{}',       -- CPT/HCPCS
  modifiers           TEXT[]      NOT NULL DEFAULT '{}',
  pos                 TEXT,
  units               INT,
  expected_rule_id    UUID        REFERENCES payer_rule(id),    -- our pre-flight matched rule
  preflight_warned    BOOLEAN     NOT NULL DEFAULT FALSE,       -- did we flag this before submission?
  raw_segment         TEXT,                                     -- original 835 segment (for debugging)
  source_file_uri     TEXT,                                     -- s3:// to original 835
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX era_835_org_dos_idx ON era_835_record (org_id, service_dos DESC);
CREATE INDEX era_835_carc_idx ON era_835_record USING GIN (carc_codes);
CREATE INDEX era_835_codes_idx ON era_835_record USING GIN (service_codes);

-- ---------------------------------------------------------------------------
-- denial_event: nightly rollup of 835 denials for dashboards.
-- Drives "top 10 denial reasons by $ impact" view.
-- ---------------------------------------------------------------------------
CREATE TABLE denial_event (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id               UUID        REFERENCES client_company(id) ON DELETE CASCADE,
  payer_id                UUID        REFERENCES payer(id),
  code                    TEXT,
  carc                    TEXT        NOT NULL,
  rarc                    TEXT,
  count                   INT         NOT NULL,
  dollar_impact           NUMERIC(14,2) NOT NULL,
  preflight_caught_count  INT         NOT NULL DEFAULT 0,       -- of these, how many we warned about
  preflight_caught_dollar NUMERIC(14,2) NOT NULL DEFAULT 0,
  period                  DATERANGE   NOT NULL,
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  EXCLUDE USING gist (org_id WITH =, client_id WITH =, payer_id WITH =, code WITH =, carc WITH =, period WITH &&)
);

CREATE INDEX denial_event_org_period_idx ON denial_event USING gist (org_id, period);

-- btree_gist (enabled in 0001) provides the GiST opclass for UUID
-- columns used by the EXCLUDE constraint above.

-- ---------------------------------------------------------------------------
-- abn_record: signed Advance Beneficiary Notice tracking.
-- 5-year retention minimum (CMS requirement). Required when GA modifier asserted.
-- ABN form CMS-R-131 effective March 13, 2026 (exp Mar 31, 2029).
-- ---------------------------------------------------------------------------
CREATE TABLE abn_record (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  client_id           UUID        NOT NULL REFERENCES client_company(id) ON DELETE CASCADE,
  patient_external_id TEXT        NOT NULL,
  form_version        TEXT        NOT NULL,                    -- 'CMS-R-131-2026-03-13'
  signed_at           TIMESTAMPTZ NOT NULL,
  service_codes       TEXT[]      NOT NULL DEFAULT '{}',
  reason_code         TEXT,                                    -- e.g. 'medical_necessity','frequency_limit','statutorily_excluded'
  estimated_cost      NUMERIC(12,2),
  document_uri        TEXT,                                    -- s3:// to scanned signed form
  retain_until        DATE        NOT NULL,                    -- signed_at + 5 years (or longer per state)
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (retain_until > signed_at::date)
);

CREATE INDEX abn_record_lookup_idx ON abn_record
  (org_id, client_id, patient_external_id, signed_at DESC);
CREATE INDEX abn_record_retain_idx ON abn_record (retain_until)
  WHERE retain_until > CURRENT_DATE;
