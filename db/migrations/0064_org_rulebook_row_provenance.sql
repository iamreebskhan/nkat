-- 0064 — org_rulebook_row provenance + expiry.
--
-- Context: the point-of-care rule lookup previously read the GLOBAL
-- `payer_rule` library only, and org-scoped actions (analyst
-- attestations, AI-synthesized answers) wrote back into that global
-- library. Two consequences, both live in prod:
--
--   1. An org's own rulebook never answered a lookup. The client saw
--      "Unknown" for payers they had already documented.
--   2. One org's analyst attestation ran
--        UPDATE payer_rule SET expiration_date = CURRENT_DATE
--      with no org filter — expiring a CMS-seeded rule for every other
--      tenant on the platform.
--
-- The lookup now reads org_rulebook_row FIRST and shows the global
-- library alongside for comparison; org-scoped writes land in
-- org_rulebook_row instead of payer_rule. That makes org_rulebook_row
-- an authoritative answer source rather than a display cache, so it
-- needs the two columns an authoritative source requires: an expiry
-- (attestations are time-boxed phone confirmations) and a link back to
-- the attestation that produced it.
--
-- Both columns are nullable and default NULL, so every existing row
-- keeps its current meaning: no expiry, no attestation backing.

BEGIN;

ALTER TABLE org_rulebook_row
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Provenance for origin='analyst' rows. ON DELETE SET NULL: deleting an
-- attestation record should not silently delete the org's rule value,
-- only its backing reference.
ALTER TABLE org_rulebook_row
  ADD COLUMN IF NOT EXISTS source_attestation_id UUID
    REFERENCES analyst_attestation(id) ON DELETE SET NULL;

COMMENT ON COLUMN org_rulebook_row.expires_at IS
  'When this row stops being authoritative for lookups. NULL = never. '
  'Set from analyst_attestation.expires_at for origin=''analyst'' rows.';
COMMENT ON COLUMN org_rulebook_row.source_attestation_id IS
  'The analyst_attestation this row was mirrored from, when origin=''analyst''.';

-- The lookup filters on expiry, so fold it into the existing hot path
-- index rather than adding a second one.
DROP INDEX IF EXISTS org_rulebook_row_lookup_idx;
CREATE INDEX org_rulebook_row_lookup_idx
  ON org_rulebook_row (org_id, payer_id, state, cpt_code, attribute)
  INCLUDE (expires_at);

COMMIT;
