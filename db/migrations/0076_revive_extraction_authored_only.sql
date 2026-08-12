-- ============================================================================
-- 0076_revive_extraction_authored_only.sql
--
-- Repairs a defect in migration 0074, in this same deploy.
--
-- WHAT 0074 GOT WRONG
-- When the reverted seed's rows were purged, 0074 restored the rule each one
-- had displaced by taking the most recent surviving rule on that key:
--
--     ORDER BY pr.effective_date DESC, pr.expiration_date DESC NULLS FIRST, pr.id
--
-- It never asked WHO wrote the rule it was reviving. On one key —
-- UnitedHealthcare Community Plan Ohio, G0318, prolonged home E/M — the most
-- recent surviving rule was authored by a PERSON rather than by an extraction
-- run. 0074 put it back into service; db/maintenance/expire-ungrounded-rules
-- .sql, which runs later in the same deploy, correctly withdrew it again; and
-- the key was left with no answer at all, while the real determination from
-- extract:fee-schedules-full-2026-08 sat expired underneath it.
--
-- A hand-typed payer rule is exactly what this library refuses to serve. The
-- revive step reintroduced one, and the only reason it did not reach a biller
-- is that a later step caught it. That is luck, not design: had that rule been
-- ordered second, it would still be expired and nobody would know.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0074
-- Migrations are tracked by filename and 0074 has already run on production,
-- so editing it would change nothing there. It is left as written, wrong
-- ordering and all, because the ledger should record what actually ran.
--
-- WHY A MIGRATION MAY TOUCH THIS SEED-OWNED ROW
-- The house rule is that a migration must not repair data a seed produces,
-- because the next seed run undoes the repair. It does not bite here: the
-- owning seed's ON CONFLICT clause sets expiration_date = NULL, which is
-- precisely what this migration does. Seed and migration agree, so a later
-- seed run re-asserts the repair rather than reversing it.
--
-- WHAT IT DOES
-- For every key migration 0074 touched that is now unanswered, restore the
-- most recent rule on that key that was written by an extraction or crawler
-- run. Keys with no such rule are left alone — those are the eight G0179/G0180
-- keys that a seed fills at step 6, and inventing an answer for them is not
-- this file's business.
--
-- Idempotent: a second run finds every key already answered and does nothing.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _touched ON COMMIT DROP AS
SELECT DISTINCT
       (rule_row->>'payer_id')::uuid     AS payer_id,
       rule_row->>'state'                AS state,
       rule_row->>'code'                 AS code,
       rule_row->>'attribute'            AS attribute,
       rule_row->>'product_line'         AS product_line
  FROM migration_0074_purge_journal;

-- Keys 0074 touched that nothing answers now.
CREATE TEMP TABLE _dark ON COMMIT DROP AS
SELECT t.* FROM _touched t
 WHERE NOT EXISTS (
   SELECT 1 FROM payer_rule live
    WHERE live.payer_id IS NOT DISTINCT FROM t.payer_id
      AND live.state    IS NOT DISTINCT FROM t.state
      AND live.code = t.code
      AND live.attribute = t.attribute
      AND live.product_line IS NOT DISTINCT FROM t.product_line
      AND live.effective_date <= CURRENT_DATE
      AND (live.expiration_date IS NULL OR live.expiration_date > CURRENT_DATE));

-- The newest rule on each dark key that a pipeline actually wrote.
CREATE TEMP TABLE _fix ON COMMIT DROP AS
SELECT DISTINCT ON (d.payer_id, d.state, d.code, d.attribute, d.product_line) pr.id
  FROM _dark d
  JOIN payer_rule pr
    ON pr.payer_id IS NOT DISTINCT FROM d.payer_id
   AND pr.state    IS NOT DISTINCT FROM d.state
   AND pr.code = d.code
   AND pr.attribute = d.attribute
   AND pr.product_line IS NOT DISTINCT FROM d.product_line
 WHERE (pr.created_by LIKE 'extract:%' OR pr.created_by LIKE 'crawler:%')
   AND pr.effective_date <= CURRENT_DATE
 ORDER BY d.payer_id, d.state, d.code, d.attribute, d.product_line,
          pr.effective_date DESC, pr.expiration_date DESC NULLS FIRST, pr.id;

UPDATE payer_rule pr SET expiration_date = NULL FROM _fix f WHERE pr.id = f.id;

DO $$
DECLARE
  n_dark INT; n_fixed INT; n_dupes INT; n_still INT := 0;
  r RECORD;
BEGIN
  SELECT count(*) INTO n_dark  FROM _dark;
  SELECT count(*) INTO n_fixed FROM _fix;

  SELECT count(*) INTO n_dupes FROM (
    SELECT payer_id, state, code, attribute, product_line
      FROM payer_rule
     WHERE effective_date <= CURRENT_DATE
       AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1) d;
  IF n_dupes <> 0 THEN
    RAISE EXCEPTION '0076: restoring left % key(s) with more than one live rule', n_dupes;
  END IF;

  -- Restoring a rule written by a person would recreate the exact defect.
  IF EXISTS (SELECT 1 FROM payer_rule pr JOIN _fix f ON f.id = pr.id
              WHERE pr.created_by NOT LIKE 'extract:%' AND pr.created_by NOT LIKE 'crawler:%') THEN
    RAISE EXCEPTION '0076: refused — a selected rule is not authored by an extraction run';
  END IF;

  FOR r IN
    SELECT p.name AS payer, d.code FROM _dark d JOIN payer p ON p.id = d.payer_id
     WHERE NOT EXISTS (SELECT 1 FROM _fix f JOIN payer_rule pr ON pr.id = f.id
                        WHERE pr.payer_id IS NOT DISTINCT FROM d.payer_id
                          AND pr.code = d.code AND pr.attribute = d.attribute)
     ORDER BY 1, 2
  LOOP
    n_still := n_still + 1;
    RAISE NOTICE '0076: % / % has no extraction-authored rule to restore — a seed must supply it', r.payer, r.code;
  END LOOP;

  RAISE NOTICE '0076: % unanswered key(s) examined, % restored from an extraction run, % left for a seed',
    n_dark, n_fixed, n_still;
END $$;

COMMIT;
