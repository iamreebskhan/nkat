-- ============================================================================
-- 0101_retire_live_demo_org.sql
--
-- R36. Retire 'Pallio Live Demo', the tenant the verification harness has
-- been writing into, before anyone is handed a demo login.
--
-- Eight scripts in scripts/ defaulted to livedemo@pallio.io and signed up or
-- logged in as it on every runbook pass (docs/CROSSCHECK-RUNBOOK.md §2-§6).
-- Each pass added another Ada Lovelace, a visit booked with confirmDoubleBook
-- (which skips the daily capacity guard), a superbill and a denial. That org
-- is the harness's scratch space, not a demo; R20 builds a real one.
--
-- The scripts now sign in as 'Pallio Harness' on @pallio-smoke.test and
-- refuse the demo tenant by pattern (scripts/lib/test-credentials.mjs). This
-- closes the other door: an old checkout, or a copy of an old script, is now
-- refused by the server instead of writing.
--
--   login   checks the user's status, then resolves the org with
--           deleted_at IS NULL; both now answer user_inactive.
--   signup  checks the email first (email_taken), and the slug check ignores
--           deleted_at, so the name cannot be re-registered under a new
--           address either (org_name_taken).
--
-- A session issued before this runs is not ended: sessions are stateless JWTs
-- (lib/auth.ts), valid until JWT_EXPIRES_IN (7d by default). The harness signs
-- in afresh on every run, so it is stopped regardless.
--
-- WHY SOFT, NOT HARD. As in 0040 and 0085: audit_log.org_id has no ON DELETE
-- CASCADE, and audit_log_retention_guard blocks deleting any audit row younger
-- than six years. The harness's trail stays on this org. That is the correct
-- policy, and it is also why R20 seeds a new tenant rather than cleaning this
-- one.
--
-- SELECTION. The org is found by name, or by the slug signup derived from it
-- (a rename keeps the slug). It is retired only if nobody but
-- livedemo@pallio.io is an active or invited member. Otherwise:
--   0 matches  NOTICE, no change. No developer or CI database has this org,
--              and a repair that aborts a clean migration run is a worse bug
--              than the one it repairs (0085).
--   2 or more  EXCEPTION. One org was expected; which of two to retire is not
--              a guess to make.
--   a person   EXCEPTION if anyone else is an active or invited member. A
--              pending invitation would otherwise be accepted into a deleted
--              org and end in user_inactive, with nobody told. Locking a real
--              user out is a decision for a human, not for a migration.
-- An EXCEPTION stops deploy.sh at this file (ON_ERROR_STOP) with nothing
-- written. livedemo@pallio.io is suspended as well, unless it still holds an
-- active seat in some other live org.
--
-- REVERSAL, by hand, if the old demo must come back before R20 ships:
--   UPDATE org SET deleted_at = NULL WHERE slug = 'pallio-live-demo';
--   UPDATE app_user SET status = 'active' WHERE email = 'livedemo@pallio.io';
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _candidate ON COMMIT DROP AS
SELECT o.id, o.name
  FROM org o
 WHERE o.deleted_at IS NULL
   AND (o.name = 'Pallio Live Demo' OR o.slug = 'pallio-live-demo');

CREATE TEMP TABLE _retire ON COMMIT DROP AS
SELECT c.id, c.name
  FROM _candidate c
 WHERE NOT EXISTS (
   SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
    WHERE m.org_id = c.id
      AND m.status IN ('active', 'invited')
      AND lower(u.email) <> 'livedemo@pallio.io'
 );

DO $$
DECLARE
  n int;
  held int;
BEGIN
  SELECT count(*) INTO n FROM _retire;
  RAISE NOTICE '0101: retiring % org(s)', n;

  -- Counted, never named: the other member is a real person, and a migration
  -- log is not where their address belongs.
  SELECT count(*) INTO held FROM _candidate WHERE id NOT IN (SELECT id FROM _retire);
  IF held > 0 THEN
    RAISE EXCEPTION '0101: refusing — % Pallio Live Demo org(s) have an active or invited member other than livedemo@pallio.io; decide by hand', held;
  END IF;

  IF n = 0 THEN
    RAISE NOTICE '0101: no Pallio Live Demo org found — nothing to retire';
  END IF;
  IF n > 1 THEN
    RAISE EXCEPTION '0101: matched % orgs as Pallio Live Demo — expected one, refusing', n;
  END IF;
END $$;

-- Everything that must SURVIVE, snapshotted before the update (0085).
CREATE TEMP TABLE _keep ON COMMIT DROP AS
SELECT id, name FROM org
 WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM _retire);

UPDATE org
   SET deleted_at = now()
 WHERE id IN (SELECT id FROM _retire);

-- The login as well as the org. Login checks the user's status before it
-- looks for an org, so this refuses at the first gate, and keeps refusing if
-- the org is ever restored by mistake. Only when no active seat is left in a
-- live org: if the account has been added somewhere real, it is not ours to
-- end.
UPDATE app_user u
   SET status = 'suspended'
 WHERE lower(u.email) = 'livedemo@pallio.io'
   AND u.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM org_member m JOIN org o ON o.id = m.org_id
      WHERE m.user_id = u.id
        AND m.status = 'active'
        AND o.deleted_at IS NULL
   );

DO $$
DECLARE
  live int;
  lost text;
  still_live int;
BEGIN
  SELECT count(*) INTO live FROM org WHERE deleted_at IS NULL;
  RAISE NOTICE '0101: % org(s) remain live', live;

  SELECT k.name INTO lost
    FROM _keep k JOIN org o ON o.id = k.id
   WHERE o.deleted_at IS NOT NULL
   LIMIT 1;
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION '0101: retired an org that was not selected: %', lost;
  END IF;

  -- The selection's own name-or-slug predicate. Any org it spared has already
  -- stopped the run above, so a survivor here means the update missed.
  SELECT count(*) INTO still_live
    FROM org o
   WHERE o.deleted_at IS NULL
     AND (o.name = 'Pallio Live Demo' OR o.slug = 'pallio-live-demo');
  IF still_live > 0 THEN
    RAISE EXCEPTION '0101: % Pallio Live Demo org(s) still live — the retirement is incomplete', still_live;
  END IF;

  IF EXISTS (
    SELECT 1 FROM app_user WHERE lower(email) = 'livedemo@pallio.io' AND status = 'active'
  ) THEN
    RAISE NOTICE '0101: livedemo@pallio.io left active — it holds a seat in another live org; check it by hand';
  END IF;
END $$;

COMMIT;
