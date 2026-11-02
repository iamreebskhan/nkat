-- ============================================================================
-- 0118_billing_identity_export_fees.sql
--
-- Billing, as the Level-1 document and Mark's defaults ask (doc:67, :71, :72,
-- :74; Mark Q1, Q2, Q4, Q5):
--
--   org_billing_provider        who the claims bill as: legal name, EIN,
--                               taxonomy, the billing address and, when
--                               payment goes elsewhere, the pay-to address.
--                               The org NPI stays on onboarding_status (0037).
--   clinician_profile.taxonomy  the rendering provider's taxonomy.
--   claim_export_batch / _item  claims exported as claim lines for the billing
--                               software (Q1 default: a standard CSV): which,
--                               by whom, when. A claim's last export is its
--                               "sent to billing" marker.
--   superbill_activity.kind     + 'exported'.
--   practice_fee                the practice's own fee per code (Q4 default):
--                               billed = the practice's fee, expected = the
--                               payer's rate. Empty until the practice sends
--                               its fee schedule; billing then stays at the
--                               payer's rate, as today.
--   superbill.expected_amount_cents  the payer's rates for the claim's lines.
--   era_835_record.contractual / patient_responsibility / other_adjustment
--                               the 835's adjustments by group (CO, PR,
--                               OA+PI), recorded as the payer stated them
--                               (Q2 default: the billing software owns
--                               balances; Pallio keeps the record).
--
-- Grants: default privileges (0001, 0052), so no GRANT.
-- ============================================================================

-- 1. The billing provider.
CREATE TABLE org_billing_provider (
  org_id                UUID        PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  legal_name            TEXT        NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 120),
  -- Nine digits, stored without the hyphen (CMS-1500 box 25, 837P REF*EI).
  ein                   TEXT        CHECK (ein IS NULL OR ein ~ '^[0-9]{9}$'),
  -- Health Care Provider Taxonomy: three digits, six characters, then X.
  taxonomy_code         TEXT        CHECK (taxonomy_code IS NULL OR taxonomy_code ~ '^[0-9]{3}[0-9A-Z]{6}X$'),
  -- A street address (the 837P refuses a PO box for the billing provider).
  address_line_1        TEXT        CHECK (address_line_1 IS NULL OR length(btrim(address_line_1)) BETWEEN 1 AND 120),
  address_line_2        TEXT        CHECK (address_line_2 IS NULL OR length(address_line_2) <= 120),
  city                  TEXT        CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 80),
  state                 TEXT        CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  zip                   TEXT        CHECK (zip IS NULL OR zip ~ '^[0-9]{5}([0-9]{4})?$'),
  -- Where payment goes, when it is not the billing address (837P loop 2010AB).
  pay_to_address_line_1 TEXT        CHECK (pay_to_address_line_1 IS NULL OR length(btrim(pay_to_address_line_1)) BETWEEN 1 AND 120),
  pay_to_address_line_2 TEXT        CHECK (pay_to_address_line_2 IS NULL OR length(pay_to_address_line_2) <= 120),
  pay_to_city           TEXT        CHECK (pay_to_city IS NULL OR length(btrim(pay_to_city)) BETWEEN 1 AND 80),
  pay_to_state          TEXT        CHECK (pay_to_state IS NULL OR pay_to_state ~ '^[A-Z]{2}$'),
  pay_to_zip            TEXT        CHECK (pay_to_zip IS NULL OR pay_to_zip ~ '^[0-9]{5}([0-9]{4})?$'),
  updated_by_user_id    UUID        REFERENCES app_user(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An address is whole or absent, each of the two.
  CONSTRAINT org_billing_provider_address_whole CHECK (
    (address_line_1 IS NULL) = (city IS NULL) AND (city IS NULL) = (state IS NULL) AND (state IS NULL) = (zip IS NULL)),
  CONSTRAINT org_billing_provider_pay_to_whole CHECK (
    (pay_to_address_line_1 IS NULL) = (pay_to_city IS NULL) AND (pay_to_city IS NULL) = (pay_to_state IS NULL)
    AND (pay_to_state IS NULL) = (pay_to_zip IS NULL)),
  CONSTRAINT org_billing_provider_pay_to_line_2 CHECK (pay_to_address_line_2 IS NULL OR pay_to_address_line_1 IS NOT NULL),
  CONSTRAINT org_billing_provider_line_2 CHECK (address_line_2 IS NULL OR address_line_1 IS NOT NULL)
);
SELECT app.apply_tenant_rls('org_billing_provider');

ALTER TABLE clinician_profile
  ADD COLUMN IF NOT EXISTS taxonomy_code TEXT
    CONSTRAINT clinician_profile_taxonomy_format CHECK (taxonomy_code IS NULL OR taxonomy_code ~ '^[0-9]{3}[0-9A-Z]{6}X$');
COMMENT ON COLUMN clinician_profile.taxonomy_code IS
  'The rendering provider''s Health Care Provider Taxonomy code (837P PRV*PE, CMS-1500 box 24J shaded). 0118.';

-- 2. Claim export.
CREATE TABLE claim_export_batch (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  created_by_user_id  UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_count         INT         NOT NULL CHECK (claim_count > 0),
  line_count          INT         NOT NULL CHECK (line_count > 0),
  -- Of the file handed over, so "is this the file we sent?" has an answer.
  content_sha256      TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX claim_export_batch_org_idx ON claim_export_batch (org_id, created_at DESC);
SELECT app.apply_tenant_rls('claim_export_batch');

CREATE TABLE claim_export_item (
  batch_id      UUID NOT NULL REFERENCES claim_export_batch(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  superbill_id  UUID NOT NULL REFERENCES superbill(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, superbill_id)
);
CREATE INDEX claim_export_item_superbill_idx ON claim_export_item (superbill_id);
SELECT app.apply_tenant_rls('claim_export_item');

ALTER TABLE superbill_activity DROP CONSTRAINT IF EXISTS superbill_activity_kind_check;
ALTER TABLE superbill_activity ADD CONSTRAINT superbill_activity_kind_check
  CHECK (kind IN ('created', 'edited', 'status_change', 'denial_logged', 'denial_decision', 'resubmitted', 'exported'));

-- The export is a PHI disclosure, logged as one. The logger swallows a refused
-- insert, so the CHECK has to know the kind before the route ships (as 0090).
ALTER TABLE phi_export_log DROP CONSTRAINT IF EXISTS phi_export_log_export_type_check;
ALTER TABLE phi_export_log ADD CONSTRAINT phi_export_log_export_type_check
  CHECK (export_type IN (
    'cheat_sheet', 'superbill_pdf', 'report_csv', 'patient_record_pdf', 'rule_lookup_pdf',
    'visit_audit_packet', 'claim_csv'));

-- 3. The practice's fee schedule.
CREATE TABLE practice_fee (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  code                TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9]{5}$'),
  fee_cents           INT         NOT NULL CHECK (fee_cents > 0 AND fee_cents <= 10000000),
  effective_from      DATE        NOT NULL,
  -- The day it stops applying; NULL while it is the fee in force.
  effective_to        DATE,
  created_by_user_id  UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT practice_fee_span CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (org_id, code, effective_from)
);
-- One fee in force per code.
CREATE UNIQUE INDEX practice_fee_current_uniq ON practice_fee (org_id, code) WHERE effective_to IS NULL;
SELECT app.apply_tenant_rls('practice_fee');

ALTER TABLE superbill
  ADD COLUMN IF NOT EXISTS expected_amount_cents BIGINT
    CONSTRAINT superbill_expected_nonneg CHECK (expected_amount_cents IS NULL OR expected_amount_cents >= 0);
COMMENT ON COLUMN superbill.expected_amount_cents IS
  'What the payer''s rates on file come to for the claim''s lines (0118). Equal to billed while the practice has no fee schedule; NULL when a line has no rate, and on bills with no priced lines.';

-- Bills priced before this migration billed the payer's rates, there being no
-- fee schedule, so what the payer is expected to pay is what was billed. Only
-- where every line had a rate: a bill with an unrated ($0) line stays unknown,
-- as a new one would be.
UPDATE superbill s
   SET expected_amount_cents = s.billed_amount_cents
 WHERE s.expected_amount_cents IS NULL
   AND jsonb_typeof(s.pricing->'lines') = 'array'
   AND jsonb_array_length(s.pricing->'lines') > 0
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(s.pricing->'lines') l
      WHERE COALESCE((l->>'rateCents')::bigint, 0) <= 0
         OR l->>'feeCents' IS NOT NULL
   );

-- 4. The 835's adjustments by group, per line, as the payer stated them.
ALTER TABLE era_835_record
  ADD COLUMN IF NOT EXISTS contractual_amount            NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS patient_responsibility_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS other_adjustment_amount       NUMERIC(12,2);
COMMENT ON COLUMN era_835_record.contractual_amount IS
  'CAS group CO on this line (with the claim-level CAS on its first line): the contractual adjustment. NULL on rows posted before 0118.';
COMMENT ON COLUMN era_835_record.patient_responsibility_amount IS
  'CAS group PR: the patient''s share as the payer stated it. Pallio records it; the billing software keeps the balance (Mark Q2 default).';
COMMENT ON COLUMN era_835_record.other_adjustment_amount IS
  'CAS groups OA and PI.';
