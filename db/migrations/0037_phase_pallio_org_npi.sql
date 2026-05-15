-- ============================================================================
-- 0037 — Persist org rendering-provider NPI captured during onboarding.
--
-- The onboarding wizard already collects an NPI in step 1 (Profile), but
-- saveProfile() was silently dropping it because no column existed to
-- store it on. Superbill generation needs it (rendering provider NPI is
-- mandatory on a CMS-1500 / 837P claim) — without it buildDraftFromVisit
-- crashed because it joined `app_user.npi` which never existed in the
-- live schema.
--
-- Adds onboarding_status.npi (nullable for back-compat with existing
-- rows). The superbill builder reads from here as the fallback when
-- the clinician's individual NPI isn't recorded.
-- ============================================================================

ALTER TABLE onboarding_status
  ADD COLUMN IF NOT EXISTS npi TEXT
  CONSTRAINT onboarding_status_npi_format
  CHECK (npi IS NULL OR npi ~ '^\d{10}$');

COMMENT ON COLUMN onboarding_status.npi IS
  'Rendering-provider NPI for solo-practice orgs. 10 digits. Set during onboarding step 1.';
