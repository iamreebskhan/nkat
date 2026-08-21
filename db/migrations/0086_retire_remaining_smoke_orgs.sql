-- ============================================================================
-- 0086_retire_remaining_smoke_orgs.sql
--
-- 0085 retired 16 of the 29 smoke-test orgs and left 13 behind. The ones it
-- missed all look like this:
--
--   Full 1787158992869 | superbills=1 denials=1 visits=1 patients=1
--   Scen 1779380570551 | superbills=1 denials=1 visits=1 patients=1
--
-- 0085 excluded any org holding a superbill, as a belt-and-braces "do not
-- touch anything that looks used". The reasoning was wrong. probe-full-live
-- and probe-all-scenarios run the COMPLETE flow — patient, visit, superbill,
-- denial — so a superbill is not evidence of real use, it is the artefact the
-- test exists to produce. That clause excluded precisely the orgs it was
-- written to catch, while adding nothing the domain rule did not already do.
--
-- So the rule is now just the rule: every active member on @pallio-smoke.test.
-- .test is reserved by RFC 2606 and cannot be a real address, which makes
-- "every member is on it" the definition of a test organisation rather than a
-- heuristic about it. Layering data-shape guesses on top of a fact is what
-- produced the half-finished retirement in the first place.
--
-- Safety is unchanged and does not depend on data shape: an org with even one
-- member outside the reserved domain is never selected, the four real orgs
-- are checked by name before anything is written, and every org that was live
-- and not selected must still be live afterwards.
--
-- Pallio Live Demo holds 21 superbills and its member is livedemo@pallio.io —
-- a real domain — so it is out of the selection on the domain rule alone.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _retire ON COMMIT DROP AS
SELECT o.id, o.name
  FROM org o
 WHERE o.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM org_member m WHERE m.org_id = o.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
      WHERE m.org_id = o.id
        AND lower(u.email) NOT LIKE '%@pallio-smoke.test'
   );

DO $$
DECLARE
  n int;
  survivor text;
BEGIN
  SELECT count(*) INTO n FROM _retire;
  RAISE NOTICE '0086: retiring % org(s)', n;
  IF n = 0 THEN
    RAISE NOTICE '0086: none left to retire';
  END IF;
  IF n > 40 THEN
    RAISE EXCEPTION '0086: matched % orgs — far more than expected, refusing', n;
  END IF;

  FOR survivor IN
    SELECT unnest(ARRAY['Pallio Live Demo', 'Ntakt', 'Other RCM Co', 'Design Partner Co'])
  LOOP
    IF EXISTS (SELECT 1 FROM _retire WHERE name = survivor) THEN
      RAISE EXCEPTION '0086: refusing — selection includes the real org %', survivor;
    END IF;
  END LOOP;
END $$;

CREATE TEMP TABLE _keep ON COMMIT DROP AS
SELECT id, name FROM org
 WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM _retire);

UPDATE org
   SET deleted_at = now()
 WHERE id IN (SELECT id FROM _retire);

DO $$
DECLARE
  live int;
  lost text;
  stragglers int;
BEGIN
  SELECT count(*) INTO live FROM org WHERE deleted_at IS NULL;
  RAISE NOTICE '0086: % org(s) remain live', live;

  SELECT k.name INTO lost
    FROM _keep k JOIN org o ON o.id = k.id
   WHERE o.deleted_at IS NOT NULL
   LIMIT 1;
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION '0086: retired an org that was not selected: %', lost;
  END IF;

  -- Did this finish the job? Count live orgs that WOULD still be selected —
  -- the same predicate, not a looser one.
  --
  -- The first version asked whether any live org still had a member on the
  -- reserved domain, which is a different and wrong question: an org holding
  -- one tester alongside real people is exactly what the selection spares on
  -- purpose, so the check failed on the case it was designed to protect and
  -- rolled the whole migration back. Caught by seeding that case locally
  -- before this went anywhere near production.
  SELECT count(*) INTO stragglers
    FROM org o
   WHERE o.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM org_member m WHERE m.org_id = o.id)
     AND NOT EXISTS (
       SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
        WHERE m.org_id = o.id
          AND lower(u.email) NOT LIKE '%@pallio-smoke.test'
     );
  IF stragglers > 0 THEN
    RAISE EXCEPTION '0086: % all-test org(s) still live — the retirement is incomplete', stragglers;
  END IF;
END $$;

COMMIT;
