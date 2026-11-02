-- ============================================================================
-- 0123_claim_referring_provider.sql
--
-- Whether the practice's claims name the patient's referring physician:
-- CMS-1500 box 17 (qualifier DN) and 17b, 837P loop 2310A.
--
--   org_billing_provider.claim_referring_provider
--       FALSE until the practice turns it on (Settings → Billing provider).
--       Whether Mark's payers need it is still his to say
--       (docs/open-questions-for-mark.md), and box 17 filled with the wrong
--       provider is worse than box 17 left empty, so no claim changes until
--       someone asks for it. On, a claim names the physician linked on the
--       chart as referring (patient_external_provider, 0103), and only with an
--       NPI that passes its check digit; claim-referring.ts has the rule.
--
-- No backfill: the default is the policy.
-- ============================================================================

ALTER TABLE org_billing_provider
  ADD COLUMN IF NOT EXISTS claim_referring_provider BOOLEAN NOT NULL DEFAULT FALSE;
