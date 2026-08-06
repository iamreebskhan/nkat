-- 0065 — retract org-triggered writes from the global rule library.
--
-- Companion to 0064 and the org-first lookup. 0064 made
-- `org_rulebook_row` an authoritative answer source; the application
-- change stopped org actions from writing `payer_rule`. This migration
-- cleans up what the OLD code already wrote.
--
-- What the old code did, per analyst attestation:
--
--   1. UPDATE payer_rule SET expiration_date = CURRENT_DATE
--       WHERE payer_id=… AND state=… AND code=… AND attribute=…
--         AND expiration_date IS NULL          -- NO org filter
--      → expired the CMS/seed rule for EVERY tenant.
--   2. INSERT a new payer_rule at confidence 0.60 in its place
--      → published one practice's phone call to every tenant.
--   3. Cross-org UPDATE of org_rulebook_row for the same key
--      → overwrote every other tenant's rulebook cell.
--
-- This migration reverses all three, in that order backwards:
--
--   A. Delete the cross-org rulebook rows the refresh wrote
--      (origin='source' pointing at a retracted rule). Those orgs fall
--      back to the global library, which is the correct neutral state.
--   B. Re-home each attestation into the rulebook of the org that
--      actually made the call (origin='analyst').
--   C. Retract the global rule by setting expiration_date =
--      effective_date. NOT a DELETE: eight tables FK-reference
--      payer_rule with ON DELETE NO ACTION (alert, era_835_record,
--      rule_dispute, client_rule, extraction_candidate, org_rulebook_row,
--      documentation_requirement via source_doc, payer_rule.superseded_by).
--      An empty [effective, expiration) window is never returned for any
--      date of service, and the CHECK is `expiration_date >=
--      effective_date`, so equality is legal.
--   D. Un-expire the CMS/seed rules that step 1 wrongly killed.
--
-- The same treatment is applied to `created_by='ai'` rows, which the
-- lookup route wrote globally on one tenant's query at confidence 0.40.
--
-- MUST RUN AS A SUPERUSER. org_rulebook_row / org_rulebook /
-- analyst_attestation are all FORCE ROW LEVEL SECURITY, and this
-- migration deliberately spans tenants. `sudo -u postgres psql pallio`
-- satisfies this.
--
-- Idempotent: re-running is a no-op (already-retracted rules no longer
-- match `expiration_date IS NULL`).

BEGIN;

-- ---------------------------------------------------------------------
-- Guard — a non-superuser would silently retract nothing under RLS.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    RAISE EXCEPTION
      'Must run as superuser: org_rulebook_row has FORCE ROW LEVEL SECURITY and this migration spans tenants. Use: sudo -u postgres psql pallio -f %',
      'db/migrations/0065_retract_org_writes_from_global_library.sql';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 0. Snapshot the pre-existing duplicate-key count.
--
-- The library's intended invariant is one LIVE rule per
-- (payer, state, code, attribute). Production may already violate it —
-- the old mirror inserted before expiring in some paths. So the final
-- check compares against this baseline instead of demanding zero, which
-- would make the migration unrunnable on a database that is already
-- dirty. We must not make it worse; we are not obliged to fix it here.
-- ---------------------------------------------------------------------
-- NB: this is a CURRENCY test (in force today), deliberately different
-- from the collapsed-window sentinel used to pick retraction candidates
-- below. Using the sentinel here would make the check inert: reviving a
-- rule flips expiration_date from a past date to NULL, and the sentinel
-- counts both as live, so the number could never move.
CREATE TEMP TABLE dupe_baseline ON COMMIT DROP AS
SELECT count(*)::int AS n FROM (
  SELECT payer_id, state, code, attribute
    FROM payer_rule
   WHERE expiration_date IS NULL OR expiration_date > CURRENT_DATE
   GROUP BY 1,2,3,4
  HAVING count(*) > 1
) d;

-- ---------------------------------------------------------------------
-- 1. Identify every global rule that an ORG action created.
-- ---------------------------------------------------------------------

-- 1a. Attestation-derived. Joined through source_document because the
--     mirror wrote url = 'attestation://<id>'; that is a firmer link
--     than parsing created_by = 'analyst:<user_id>'.
CREATE TEMP TABLE retract_attestation ON COMMIT DROP AS
SELECT
  pr.id             AS rule_id,
  pr.attribute      AS db_attribute,   -- already the long-form name
  pr.effective_date AS rule_effective_date,
  aa.id             AS attestation_id,
  aa.org_id,
  aa.payer_id,
  aa.state,
  aa.cpt_code,
  aa.rule_value,
  aa.coverage_status,
  aa.confirmed_quote,
  aa.expires_at,
  aa.attested_by_user_id,
  aa.status         AS attestation_status,
  aa.created_at     AS attested_at
FROM payer_rule pr
JOIN source_document sd
  ON sd.id = pr.source_doc_id
 AND sd.document_type = 'analyst_call'
JOIN analyst_attestation aa
  ON sd.url = 'attestation://' || aa.id::text
WHERE pr.expiration_date IS NULL
   OR pr.expiration_date > pr.effective_date;   -- not already retracted

-- 1b. AI-synthesized. Written globally at 0.40 on one tenant's lookup.
--     Unattributable to an org (no link was ever recorded), and below
--     the 0.5 answer floor, so these are retracted without re-homing.
CREATE TEMP TABLE retract_ai ON COMMIT DROP AS
SELECT pr.id AS rule_id, pr.effective_date AS rule_effective_date
FROM payer_rule pr
WHERE pr.created_by = 'ai'
  AND (pr.expiration_date IS NULL OR pr.expiration_date > pr.effective_date);

-- ---------------------------------------------------------------------
-- 2. (A) Neutralise the cross-org rulebook cells that fed off a
--        retracted rule.
--
-- Only origin='source': a tenant's own 'org_override' / 'org_upload' /
-- 'analyst' rows are theirs and are never touched here.
--
-- BLANK, DO NOT DELETE. `generateRulebook` (rulebook.service.ts:245)
-- also writes origin='source' rows with source_payer_rule_id set, so a
-- matching row is not necessarily refresh-contamination — it may be a
-- cell the org deliberately generated that merely happened to source
-- from a bad rule. Deleting would silently remove cells from their
-- rulebook grid. Blanking keeps the grid intact, drops the borrowed
-- data, and — because confidence goes to 0, below the 0.5 floor
-- fetchOrgRule applies to machine-written rows — makes the lookup fall
-- through to the global library, which is the correct neutral state.
-- ---------------------------------------------------------------------
UPDATE org_rulebook_row r
   SET coverage_status      = 'unknown',
       rule_value           = '{}'::jsonb,
       source_payer_rule_id = NULL,
       source_quote         = NULL,
       confidence           = 0.00,
       updated_at           = now()
 WHERE r.origin = 'source'
   AND r.source_payer_rule_id IN (
     SELECT rule_id FROM retract_attestation
     UNION
     SELECT rule_id FROM retract_ai
   );

-- ---------------------------------------------------------------------
-- 3. (B) Re-home each attestation into its OWN org's rulebook.
-- ---------------------------------------------------------------------

-- Every affected org needs a rulebook container to hang the cell off.
INSERT INTO org_rulebook (org_id, origin, current_version)
SELECT DISTINCT org_id, 'generated', 1
FROM retract_attestation
ON CONFLICT (org_id) DO UPDATE SET updated_at = now();

-- Excluded statuses:
--   'voided'      — the org already retracted it.
--   're_verified' — a LATER call for the same cell superseded it
--                   (attestation.service.ts:91-112 sets this on the
--                   prior row). Its data is stale by construction.
-- 'expired' rows ARE re-homed, carrying their past expires_at, so they
-- show in the rulebook with correct provenance but never answer.
--
-- DISTINCT ON is load-bearing: an org can hold several attestations for
-- one key. Without it, ON CONFLICT DO UPDATE would try to touch the same
-- row twice in one statement, which Postgres rejects with "cannot affect
-- row a second time". Newest call wins.
INSERT INTO org_rulebook_row (
  org_id, rulebook_id, payer_id, state, cpt_code, attribute,
  rule_value, coverage_status, origin, confidence,
  source_quote, source_attestation_id, expires_at,
  last_edited_by_user_id, last_edited_at
)
SELECT DISTINCT ON (r.org_id, r.payer_id, r.state, r.cpt_code, r.db_attribute)
  r.org_id, rb.id, r.payer_id, r.state, r.cpt_code, r.db_attribute,
  r.rule_value, r.coverage_status, 'analyst', 0.60,
  r.confirmed_quote, r.attestation_id, r.expires_at::timestamptz,
  r.attested_by_user_id, now()
FROM retract_attestation r
JOIN org_rulebook rb ON rb.org_id = r.org_id
WHERE r.attestation_status NOT IN ('voided', 're_verified')
ORDER BY r.org_id, r.payer_id, r.state, r.cpt_code, r.db_attribute,
         r.attested_at DESC
ON CONFLICT (rulebook_id, payer_id, state, cpt_code, attribute)
DO UPDATE SET
  rule_value            = EXCLUDED.rule_value,
  coverage_status       = EXCLUDED.coverage_status,
  origin                = EXCLUDED.origin,
  confidence            = EXCLUDED.confidence,
  source_quote          = EXCLUDED.source_quote,
  source_attestation_id = EXCLUDED.source_attestation_id,
  expires_at            = EXCLUDED.expires_at,
  last_edited_by_user_id = EXCLUDED.last_edited_by_user_id,
  last_edited_at        = now(),
  updated_at            = now()
-- Never clobber a cell the tenant deliberately customised, and never
-- overwrite a cell that ALREADY carries an analyst answer. The latter
-- matters because the fixed application writes attestations straight to
-- org_rulebook_row and no longer to payer_rule — such an attestation is
-- invisible to retract_attestation, so without this guard a stale
-- pre-fix call could overwrite the org's current phone confirmation.
-- It also makes this migration safe to run before OR after the deploy.
WHERE org_rulebook_row.origin NOT IN ('org_override', 'analyst');

-- ---------------------------------------------------------------------
-- 4. (C) Retract the global rules.
--
-- expiration_date = effective_date leaves an empty validity window, so
-- `effective_date <= dos AND expiration_date > dos` can never hold.
-- ---------------------------------------------------------------------
UPDATE payer_rule pr
   SET expiration_date = pr.effective_date
 WHERE pr.id IN (SELECT rule_id FROM retract_attestation
                 UNION ALL
                 SELECT rule_id FROM retract_ai);

-- ---------------------------------------------------------------------
-- 5. (D) Un-expire the platform rules the old mirror wrongly killed.
--
-- The mirror ran `SET expiration_date = CURRENT_DATE` on the attestation
-- date, so a victim is: same key, NOT org-written, and expiring exactly
-- on the day an attestation for that key was recorded.
--
-- Distinguishing a MIRROR kill from a LEGITIMATE supersession is the
-- whole difficulty, because both stamp CURRENT_DATE:
--   document-ingestion.service.ts:222  UPDATE ... = CURRENT_DATE
--   db/seed/retire-cms-short-docs.sql:39, and
--   db/seed/payer-rules-cy2026-full-rule.sql:624
--                                      UPDATE ... = GREATEST(CURRENT_DATE, effective_date)
--
-- The discriminator is the SUCCESSOR, not the neighbours. A legitimate
-- supersession always inserts a platform-written replacement that takes
-- effect on or after the day it retired the old row
-- (document-ingestion.service.ts:241 inserts effective_date =
-- CURRENT_DATE, created_by = 'crawler:…'). The mirror inserted no such
-- thing — only an 'analyst:<uid>' row. So: revive when no platform
-- successor exists.
--
-- An earlier version of this guard asked "is any OTHER rule for this key
-- live?", defining live as (expiration_date IS NULL OR expiration_date >
-- effective_date). That is the collapsed-window sentinel this migration
-- uses elsewhere — since 0053 widened the CHECK to `>=`, the only rows
-- failing it are ones step 4 just collapsed. Every long-dead historical
-- version therefore counted as "live" and blocked revival, which on a
-- key that had ever been re-ingested left NO answerable rule at all for
-- any tenant — strictly worse than the contamination being cleaned up.
-- ---------------------------------------------------------------------

-- Journal first: this is the one irreversible step, and re-running
-- cannot retry it (step 4 already emptied retract_attestation for the
-- next run). Keep the pre-image so a mistake is correctable.
CREATE TABLE IF NOT EXISTS migration_0065_expiry_journal (
  rule_id          UUID        PRIMARY KEY REFERENCES payer_rule(id),
  prior_expiration DATE        NOT NULL,
  journaled_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_0065_expiry_journal IS
  'Pre-images for rules migration 0065 revived. To undo a specific '
  'revival: UPDATE payer_rule p SET expiration_date = j.prior_expiration '
  'FROM migration_0065_expiry_journal j WHERE p.id = j.rule_id;';

INSERT INTO migration_0065_expiry_journal (rule_id, prior_expiration)
SELECT victim.id, victim.expiration_date
FROM payer_rule victim
WHERE victim.expiration_date IS NOT NULL
  AND victim.created_by NOT LIKE 'analyst:%'
  AND victim.created_by <> 'ai'
  AND EXISTS (
    SELECT 1 FROM retract_attestation r
     WHERE r.payer_id     = victim.payer_id
       AND r.state        = victim.state
       AND r.cpt_code     = victim.code
       AND r.db_attribute = victim.attribute
       AND r.attested_at::date = victim.expiration_date
  )
  AND NOT EXISTS (
    SELECT 1 FROM payer_rule succ
     WHERE succ.payer_id  = victim.payer_id
       AND succ.state     = victim.state
       AND succ.code      = victim.code
       AND succ.attribute = victim.attribute
       AND succ.id       <> victim.id
       AND succ.created_by NOT LIKE 'analyst:%'
       AND succ.created_by <> 'ai'
       AND succ.effective_date >= victim.expiration_date
  )
ON CONFLICT (rule_id) DO NOTHING;

UPDATE payer_rule victim
   SET expiration_date = NULL
 WHERE victim.id IN (SELECT rule_id FROM migration_0065_expiry_journal)
   AND victim.expiration_date IS NOT NULL;

-- ---------------------------------------------------------------------
-- 6. Report + invariant check.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_att    INT;
  n_ai     INT;
  n_orgs   INT;
  n_dupes   INT;
  n_before  INT;
  n_revived INT;
BEGIN
  SELECT count(*) INTO n_att  FROM retract_attestation;
  SELECT count(*) INTO n_ai   FROM retract_ai;
  SELECT count(DISTINCT org_id) INTO n_orgs FROM retract_attestation;

  RAISE NOTICE '0065 retraction complete:';
  RAISE NOTICE '  attestation-derived global rules retracted: %', n_att;
  RAISE NOTICE '  AI-synthesized global rules retracted:      %', n_ai;
  RAISE NOTICE '  orgs whose attestations were re-homed:      %', n_orgs;

  SELECT count(*) INTO n_revived FROM migration_0065_expiry_journal;
  RAISE NOTICE '  platform rules revived (pre-images journaled): %', n_revived;
  IF n_att > 0 AND n_revived = 0 THEN
    RAISE WARNING 'Retracted % rule(s) but revived none. If those keys now read Unknown, check migration_0065_expiry_journal and the successor guard in step 5.', n_att;
  END IF;

  -- One live rule per (payer,state,code,attribute) is the library's
  -- intended invariant. Step 5 revives rows, so it could make things
  -- worse — prove it did not, against the pre-migration baseline.
  SELECT n INTO n_before FROM dupe_baseline;
  SELECT count(*) INTO n_dupes FROM (
    SELECT payer_id, state, code, attribute
      FROM payer_rule
     WHERE expiration_date IS NULL OR expiration_date > CURRENT_DATE
     GROUP BY 1,2,3,4
    HAVING count(*) > 1
  ) d;

  IF n_dupes > n_before THEN
    RAISE EXCEPTION
      'Rolling back: duplicate-live-rule keys rose from % to %. Step 5 (un-expire) over-matched.',
      n_before, n_dupes;
  END IF;

  RAISE NOTICE '  duplicate-live-rule keys: % before, % after (must not rise).',
    n_before, n_dupes;
END $$;

COMMIT;
