-- ============================================================================
-- 0073_restore_oh_g0179_g0180.sql
--
-- Repairs damage I did in db/seed/payer-rules-oh-appendixdd-delisted.sql,
-- which has been deleted.
--
-- WHAT WENT WRONG
-- That seed claimed Ohio had removed 30 codes from Appendix DD and re-grounded
-- 150 rules as 'unknown' on the strength of it. Ohio had removed nothing. The
-- claim came from a parser that could not see SELF-CLOSING spreadsheet cells
-- (<c r="B10022" s="76"/>), so an empty cell swallowed the following cell's
-- value and 68 G-codes were invisible. Every one of the 30 is in the workbook.
--
-- The seed is gone and its 150 rows are deleted, so the correct determinations
-- are served again — G0318 reads 'covered' for all five Ohio plans, from the
-- fee-schedule extraction that always had it right.
--
-- WHY A MIGRATION AND NOT A SEED FIX
-- The seed also EXPIRED the rows it displaced, setting expiration_date to
-- effective_date, which empties the window at every date of service. Deleting
-- the seed's own rows does not undo that. For most codes the owning seed
-- re-asserts on replay — its ON CONFLICT sets expiration_date = NULL — but
-- these eight are ORPHANS: they exist in the database and no seed in
-- db/seed/MANIFEST produces them, so nothing re-asserts them.
--
-- This project's rule is that a migration must not repair data a seed
-- produces, because the next seed run undoes it. That rule does not bite
-- here, precisely because no seed produces these rows. A migration is the
-- right instrument for exactly this case and only this case.
--
-- SCOPE. Eight rows: G0179 and G0180 (home health plan-of-care certification
-- and re-certification), 'not_covered', across the four Ohio Medicaid plans
-- whose rules carry created_by 'extract:state-fee-schedule-2026-08'. Humana
-- Healthy Horizons of Ohio is not among them; its copies come from
-- payer-rules-oh-appendixdd-humana.sql, which re-asserts them on every replay.
--
-- Idempotent: the WHERE clause matches only rows still in the damaged state.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _restore ON COMMIT DROP AS
SELECT r.id
  FROM payer_rule r
 WHERE r.created_by = 'extract:state-fee-schedule-2026-08'
   AND r.state = 'OH'
   AND r.code IN ('G0179', 'G0180')
   AND r.attribute = 'covered'
   -- The damage signature: a window that opens and closes on the same day.
   AND r.expiration_date = r.effective_date;

UPDATE payer_rule pr
   SET expiration_date = NULL
  FROM _restore x
 WHERE pr.id = x.id;

DO $$
DECLARE
  n_restored INT;
  n_dupes    INT;
BEGIN
  SELECT count(*) INTO n_restored FROM _restore;

  -- Restoring a row must not put two live rules on one key. fetchPayerRule
  -- ends in LIMIT 1 with no tiebreak, so a second live row makes the answer
  -- depend on row order.
  SELECT count(*) INTO n_dupes FROM (
    SELECT payer_id, state, code, attribute, product_line
      FROM payer_rule
     WHERE effective_date <= CURRENT_DATE
       AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     GROUP BY 1, 2, 3, 4, 5
    HAVING count(*) > 1) d;
  IF n_dupes <> 0 THEN
    RAISE EXCEPTION '0073: restoring left % key(s) with more than one live rule', n_dupes;
  END IF;

  RAISE NOTICE '0073: % row(s) restored to service (G0179/G0180, Ohio)', n_restored;
  RAISE NOTICE '0073: keys with more than one live rule: 0';
END $$;

COMMIT;
