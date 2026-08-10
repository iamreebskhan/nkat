-- ============================================================================
-- 0072_close_rule_timelines.sql
--
-- Repair superseded rules that were expired on the day the seed RAN
-- instead of the day their replacement took EFFECT, which leaves both
-- versions serving for every date of service in between.
--
-- THE DEFECT, MEASURED
--   ambiguous (payer, state, code, attribute) keys, by date of service:
--     today          0
--     90 days back   182
--     365 days back   56
--
-- A worked example — both rows served at a DOS of today-90:
--     effective 2025-10-01  expiration NULL        extract:fee-schedules-full
--     effective 2025-10-01  expiration 2026-08-08  extract:state-fee-schedule
--
-- fetchPayerRule serves a rule when
--     effective_date <= dos AND (expiration_date IS NULL OR expiration_date > dos)
-- and ends in LIMIT 1 with ORDER BY (own policy) DESC, (product_line) DESC,
-- effective_date DESC. Both rows here share a product line and an
-- effective date, so every ORDER BY term ties and the answer is decided
-- by whichever row the planner happens to return. That is not an answer.
--
-- WHY IT MATTERS AT PRECISELY THE WRONG MOMENT
-- Today is clean, so every check run at CURRENT_DATE — including every
-- one this project has run so far — reports zero. But a denial is
-- re-worked at the DOS ON THE CLAIM, inside a timely-filing window that
-- routinely runs 90 to 365 days. The ambiguity is invisible in normal
-- use and present exactly when a biller is appealing a rejection.
--
-- THE RULE THIS RESTORES
-- A key's rules should partition the timeline, not overlap it: each
-- version serves until its successor takes effect, and not one day
-- longer. So a superseded row's expiration_date is its SUCCESSOR'S
-- effective_date — clamped up to its own effective_date, since
-- payer_rule_check enforces expiration_date >= effective_date. Where the
-- two share an effective date the window collapses to zero, which is
-- correct: the replacement supersedes it from the same day, so the old
-- row never serves.
--
-- WHAT IS DELIBERATELY LEFT ALONE
-- A row expired with NO successor on its key is a retirement, not a
-- supersession — retire-cms-short-docs.sql does this to withdraw a
-- document. Those keep their expiration date. Only rows that actually
-- have a successor are moved, and only ever EARLIER, so this can never
-- extend a rule's life.
--
-- Reversible: every prior expiration_date is journaled.
-- Idempotent: a second run finds nothing left to close.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_0072_timeline_journal (
  rule_id          UUID PRIMARY KEY,
  prior_expiration DATE,
  new_expiration   DATE NOT NULL,
  successor_id     UUID NOT NULL,
  journaled_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No foreign key to payer_rule, deliberately. A journal holds pre-images
-- and must outlive the row it describes; an FK here would block any later
-- seed from deleting and re-inserting its own rules, which is exactly how
-- migration 0070's journal broke payer-rules-cy2026-full-rule.sql.
COMMENT ON TABLE migration_0072_timeline_journal IS
  'Pre-images of expiration_date values narrowed by migration 0072. To undo: '
  'UPDATE payer_rule p SET expiration_date = j.prior_expiration FROM '
  'migration_0072_timeline_journal j WHERE p.id = j.rule_id.';

-- ANCHOR ON THE ROW THAT ANSWERS TODAY.
--
-- The obvious repair — "expire each rule when its successor takes
-- effect" — is not enough, because the history is not always ordered.
-- A real key, 99496 covered, held three overlapping rows:
--
--   crawler:cms_pfs             eff 2026-01-01  exp NULL      <- answers today
--   extract:cms-rvu26c-2026-08  eff 2026-07-01  exp 2026-08-08
--   extract:fee-schedules-full  eff 2026-07-01  exp 2026-08-10
--
-- The open-ended row is the OLDEST, and both of its "successors" are
-- themselves expired, so there is no successor to close against. Any rule
-- phrased in terms of successors leaves this overlapping.
--
-- What IS unambiguous is which row the platform answers with today —
-- exactly one per key, since the ambiguity count at CURRENT_DATE is zero.
-- Treat that row as authoritative and make every other row on the key
-- stop before it starts:
--
--   other starts BEFORE it  -> expire at the authoritative row's start,
--                              preserving genuine history for older dates
--   other starts ON/AFTER it -> collapse to zero width; it can never have
--                              been the answer, since the authoritative
--                              row was already in force
--
-- Only ever shortens, so it cannot resurrect a withdrawn rule, and the
-- key keeps answering today because the anchor itself is never touched.
CREATE TEMP TABLE _anchor ON COMMIT DROP AS
SELECT DISTINCT ON (payer_id, state, code, attribute)
       payer_id, state, code, attribute, id AS anchor_id, effective_date AS anchor_effective
  FROM payer_rule
 WHERE effective_date <= CURRENT_DATE
   AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
 ORDER BY payer_id, state, code, attribute, effective_date DESC, id DESC;

CREATE TEMP TABLE _close ON COMMIT DROP AS
SELECT other.id                                              AS rule_id,
       other.expiration_date                                 AS prior_expiration,
       a.anchor_id                                           AS successor_id,
       GREATEST(other.effective_date, a.anchor_effective)    AS new_expiration
  FROM payer_rule other
  JOIN _anchor a
    ON a.payer_id  = other.payer_id AND a.state = other.state
   AND a.code      = other.code     AND a.attribute = other.attribute
 WHERE other.id <> a.anchor_id
   -- Only rows that actually overlap the anchor's reign.
   AND (other.expiration_date IS NULL
        OR other.expiration_date > GREATEST(other.effective_date, a.anchor_effective));

INSERT INTO migration_0072_timeline_journal (rule_id, prior_expiration, new_expiration, successor_id)
SELECT rule_id, prior_expiration, new_expiration, successor_id FROM _close
ON CONFLICT (rule_id) DO NOTHING;

UPDATE payer_rule p
   SET expiration_date = c.new_expiration
  FROM _close c
 WHERE p.id = c.rule_id;

-- ---------------------------------------------------------------------
-- Prove it, at the dates that actually matter.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_closed  INT;
  d         INT;
  offsets   INT[] := ARRAY[0, 30, 90, 180, 365, 730];
  ambiguous INT;
  worst     INT := 0;
  detail    TEXT := '';
BEGIN
  SELECT count(*) INTO n_closed FROM _close;

  FOREACH d IN ARRAY offsets LOOP
    SELECT count(*) INTO ambiguous FROM (
      SELECT payer_id, state, code, attribute
        FROM payer_rule
       WHERE effective_date <= CURRENT_DATE - d
         AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE - d)
       GROUP BY 1,2,3,4
      HAVING count(*) > 1) x;
    detail := detail || format('  dos -%s days: %s ambiguous key(s)%s', d, ambiguous, chr(10));
    IF ambiguous > worst THEN worst := ambiguous; END IF;
  END LOOP;

  RAISE NOTICE 'migration 0072:';
  RAISE NOTICE '  rules re-closed at their successor''s start date: %', n_closed;
  RAISE NOTICE '%', detail;

  IF worst > 0 THEN
    RAISE EXCEPTION 'migration 0072: % (payer, state, code, attribute) key(s) still serve more than one rule at some date of service — fetchPayerRule would pick between them arbitrarily. See the per-date counts above.', worst;
  END IF;

  -- The repair may only ever shorten a rule's life. If any journaled row
  -- was extended, the successor selection is wrong and the whole thing
  -- must roll back rather than quietly resurrect an outdated rule.
  IF EXISTS (SELECT 1 FROM migration_0072_timeline_journal j
              WHERE j.prior_expiration IS NOT NULL
                AND j.new_expiration > j.prior_expiration) THEN
    RAISE EXCEPTION 'migration 0072: a rule would have been EXTENDED, not shortened — refusing.';
  END IF;

  -- And nothing may be left with no rule at all where one was serving.
  IF EXISTS (
    SELECT 1 FROM migration_0072_timeline_journal j
      JOIN payer_rule v ON v.id = j.rule_id
     WHERE NOT EXISTS (
       SELECT 1 FROM payer_rule s
        WHERE s.payer_id = v.payer_id AND s.state = v.state
          AND s.code = v.code AND s.attribute = v.attribute
          AND s.effective_date <= CURRENT_DATE
          AND (s.expiration_date IS NULL OR s.expiration_date > CURRENT_DATE))) THEN
    RAISE EXCEPTION 'migration 0072: closing a rule left its key with nothing serving today — refusing.';
  END IF;
END $$;

COMMIT;
