-- ============================================================================
-- 0124_patient_prior_auth.sql
--
-- Prior authorizations on the chart. Payer rules say when one is needed
-- (attribute prior_auth_required) and the denial predictor read them, but with
-- nowhere to record that a patient HAS one it could only ever say none is on
-- file. Nothing asked for the number a claim must carry either.
--
--   patient_prior_auth   one authorization: the payer, its number, the codes it
--                        covers (empty: every service under the plan), the
--                        dates it runs, and the visits allowed when the payer
--                        caps them. 'withdrawn' is recorded in error; the row
--                        stays, as clinical and billing history does.
--
-- It goes on the claim as CMS-1500 box 23 and 837P REF*G1 (loop 2300) when one
-- covers the claim's payer, date of service and a code on it.
--
-- Tenant data under RLS; PHI, read with the chart.
-- ============================================================================

CREATE TABLE patient_prior_auth (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  payer_id            UUID        NOT NULL REFERENCES payer(id),
  -- As the payer issued it; goes on the claim. REF02 takes 50.
  auth_number         TEXT        NOT NULL CHECK (auth_number ~ '^[A-Za-z0-9-]{1,50}$'),
  codes               TEXT[]      NOT NULL DEFAULT '{}',
  valid_from          DATE        NOT NULL,
  valid_to            DATE        NOT NULL,
  visits_authorized   INT         CHECK (visits_authorized IS NULL OR visits_authorized > 0),
  status              TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  created_by_user_id  UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_prior_auth_span CHECK (valid_to >= valid_from)
);
CREATE INDEX patient_prior_auth_patient_idx ON patient_prior_auth (org_id, patient_id, payer_id) WHERE status = 'active';
SELECT app.apply_tenant_rls('patient_prior_auth');
