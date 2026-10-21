-- ============================================================================
-- 0092_clinician_profile.sql
--
-- A clinician's billing identity within an org: individual NPI and licensure.
--
-- Audit R40. Every claim put the ORGANIZATION's onboarding NPI in the
-- rendering-provider slot, or '' when onboarding never captured one, because
-- nothing anywhere recorded a person-level NPI. On a CMS-1500 the rendering
-- provider (box 24J) is the individual who performed the service — a Type 1
-- NPI — and the billing provider (box 33a) is the organization. Using the org
-- number for both misidentifies who treated the patient.
--
-- Audit R25. Pricing tier (MD vs NP/PA) was a per-visit dropdown that nothing
-- read, so every claim priced at the NP/PA rate whoever saw the patient. Tier
-- follows from a clinician's licence, so it is derived from `credential` here.
--
-- Per org, keyed like org_member: the same person can hold different roles in
-- different orgs, and tenant isolation (RLS) stays the ordinary kind.
-- ============================================================================

CREATE TABLE clinician_profile (
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id             UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  -- Individual (Type 1) NPI. Format only here; the Luhn check digit is
  -- validated in the service, where a useful message can be returned.
  npi                 TEXT        CONSTRAINT clinician_profile_npi_format
                                  CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$'),

  -- Licensure. MD/DO bill at the physician rate, NP/PA/CNS at 85%. RN, LCSW
  -- and OTHER do not bill home E/M codes, which the draft bill warns about.
  credential          TEXT        CONSTRAINT clinician_profile_credential_check
                                  CHECK (credential IS NULL OR credential IN
                                    ('MD', 'DO', 'NP', 'PA', 'CNS', 'RN', 'LCSW', 'OTHER')),

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id  UUID        REFERENCES app_user(id),

  PRIMARY KEY (org_id, user_id)
);

-- Two clinicians in one org cannot share an NPI: it identifies one person.
CREATE UNIQUE INDEX clinician_profile_org_npi_uniq
  ON clinician_profile (org_id, npi) WHERE npi IS NOT NULL;

SELECT app.apply_tenant_rls('clinician_profile');

-- The organization's NPI travels separately as the billing provider, so
-- pointing provider_npi at the clinician does not drop it from the claim.
ALTER TABLE superbill ADD COLUMN IF NOT EXISTS billing_npi TEXT;

COMMENT ON COLUMN superbill.provider_npi IS
  'Rendering provider NPI (CMS-1500 box 24J): the clinician''s own Type 1 NPI from clinician_profile. Falls back to the org NPI only with a visible warning on the draft.';
COMMENT ON COLUMN superbill.billing_npi IS
  'Billing provider NPI (CMS-1500 box 33a): the organization''s NPI captured at onboarding.';
