-- ============================================================================
-- 0085_retire_smoke_test_orgs.sql
--
-- Soft-delete the organisations left behind by probe and e2e scripts.
--
-- /admin/orgs lists 33 organisations. Four are real — Pallio Live Demo,
-- Ntakt, Other RCM Co, Design Partner Co. The rest were created by scripts
-- signing up against production between 2026-05-21 and 2026-08-19, and no
-- script ever removed what it made. A page that is 88% noise cannot do its
-- job, which is to let an operator find a customer.
--
-- The urgent half is not tidiness. Those scripts derived each account's
-- password from the same Date.now() stamp they put in the org NAME:
--
--     orgName:  `FB ${s}`                      <- displayed on /admin/orgs
--     email:    `fb-${s}@pallio-smoke.test`
--     password: `Fb-${s}!x`
--
-- Anyone who could read the org list could compute the login for every one
-- of them. The scripts were fixed to use random secrets, but that does
-- nothing for the accounts already created. Soft-delete does: login resolves
-- the caller's org with `o.deleted_at IS NULL`, so a retired org's members
-- cannot sign in.
--
-- WHY SOFT, NOT HARD. Migration 0040 already answered this: audit_log.org_id
-- has no ON DELETE CASCADE, and prevent_premature_audit_delete blocks removal
-- of any audit row younger than six years. That trigger is correct policy and
-- this migration does not argue with it. Soft-delete keeps the audit trail
-- and removes the org from every operator- and user-facing surface. It is
-- also reversible: set deleted_at = NULL.
--
-- SELECTED BY EMAIL DOMAIN, NOT BY NAME. Name patterns are something I would
-- be inventing; the domain is evidence. Every one of these accounts sits on
-- @pallio-smoke.test — .test is reserved by RFC 2606 and cannot be a real
-- address. An org is retired only when EVERY active member is on that
-- domain, so a real org that once had a test user invited is left alone.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _retire ON COMMIT DROP AS
SELECT o.id, o.name
  FROM org o
 WHERE o.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
      WHERE m.org_id = o.id
   )
   -- every member on the reserved test domain, none outside it
   AND NOT EXISTS (
     SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
      WHERE m.org_id = o.id
        AND lower(u.email) NOT LIKE '%@pallio-smoke.test'
   )
   -- nothing that looks like real use
   AND NOT EXISTS (SELECT 1 FROM superbill s WHERE s.org_id = o.id)
   AND NOT EXISTS (SELECT 1 FROM superbill_denial d WHERE d.org_id = o.id);

DO $$
DECLARE
  n int;
  survivor text;
BEGIN
  SELECT count(*) INTO n FROM _retire;
  RAISE NOTICE '0085: retiring % org(s)', n;

  -- Zero is a NOTICE, not an error: a fresh developer database has none of
  -- this debris, and a repair migration that aborts the whole migration run
  -- on a clean database is a worse bug than the one it repairs. Whether it
  -- did anything on production is answered by this notice and by the org
  -- count below, not by refusing to start.
  IF n = 0 THEN
    RAISE NOTICE '0085: no smoke-test orgs found — nothing to retire';
  END IF;
  -- Implausibly many IS an error. That is how a repair becomes an outage.
  IF n > 40 THEN
    RAISE EXCEPTION '0085: matched % orgs, far more than the 29 expected — refusing', n;
  END IF;

  -- The four real orgs must not be in the set, by name, independently of the
  -- domain rule above. Two unrelated checks have to agree before anything is
  -- touched.
  FOR survivor IN
    SELECT unnest(ARRAY['Pallio Live Demo', 'Ntakt', 'Other RCM Co', 'Design Partner Co'])
  LOOP
    IF EXISTS (SELECT 1 FROM _retire WHERE name = survivor) THEN
      RAISE EXCEPTION '0085: refusing — selection includes the real org %', survivor;
    END IF;
  END LOOP;
END $$;

-- Snapshot of everything that must SURVIVE, taken before the update. Naming
-- the four production orgs in the assertion was the first thing I wrote, and
-- it failed on a developer database that has none of them — an assertion that
-- only holds on one machine is not an assertion. This invariant holds
-- everywhere: an org that was live and was not selected is still live.
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
BEGIN
  SELECT count(*) INTO live FROM org WHERE deleted_at IS NULL;
  RAISE NOTICE '0085: % org(s) remain live', live;

  SELECT k.name INTO lost
    FROM _keep k JOIN org o ON o.id = k.id
   WHERE o.deleted_at IS NOT NULL
   LIMIT 1;
  IF lost IS NOT NULL THEN
    RAISE EXCEPTION '0085: retired an org that was not selected: %', lost;
  END IF;

  -- Anything still live on the test domain means the selection missed it.
  IF EXISTS (
    SELECT 1 FROM org o
      JOIN org_member m ON m.org_id = o.id
      JOIN app_user u ON u.id = m.user_id
     WHERE o.deleted_at IS NULL
       AND lower(u.email) LIKE '%@pallio-smoke.test'
  ) THEN
    RAISE NOTICE '0085: a live org still has a @pallio-smoke.test member — check it by hand';
  END IF;
END $$;

COMMIT;
