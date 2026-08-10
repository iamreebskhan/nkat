-- ============================================================================
-- close-rule-timelines.sql — run AFTER every seed application.
--
-- WHY THIS IS MAINTENANCE AND NOT A MIGRATION
-- Migration 0072 did this once and it was undone within the same deploy.
-- Migrations run at step 5, seeds at step 6, so the repair happened and
-- then the seeds wrote fresh overlaps straight over it. Production went
-- from "0 ambiguous keys at every date" in the migration's own output to
-- 28 in verify-production, minutes later.
--
-- The seeds cause it because they expire what they supersede at
-- CURRENT_DATE rather than at the date the replacement takes effect:
--
--   UPDATE payer_rule old SET expiration_date = CURRENT_DATE ...
--
-- so for every DOS between the new rule's effective date and today, both
-- the old and the new row are served. Six seeds do this, and fixing them
-- individually would not help: payer-rules-fee-schedules-full.sql alone
-- writes rows effective 2024-01-01, 2025-10-01 and 2026-07-01, so no
-- single literal date is right for it, and any future seed would have to
-- remember the rule. Repairing centrally, after the seeds, is correct
-- once and stays correct.
--
-- WHY IT MATTERS
-- fetchPayerRule serves
--   effective_date <= dos AND (expiration_date IS NULL OR expiration_date > dos)
-- and ends in LIMIT 1. Where two rows are served the ORDER BY usually
-- ties — same product line, same effective date — so the answer is
-- whichever row the planner returns first. Today is always clean, which
-- is why this hid for so long; a denial is re-worked at the DOS ON THE
-- CLAIM, inside a timely-filing window of 90 to 365 days.
--
-- HOW IT DECIDES
-- The row that answers TODAY is authoritative — exactly one per key,
-- since today is unambiguous. Every other row on that key must stop
-- before the anchor starts:
--   begins earlier   -> expire at the anchor's effective date, so real
--                       history still answers for older dates
--   begins on/after  -> collapse to zero width; the anchor was already in
--                       force, so it can never have been the answer
--
-- Only ever shortens a rule's life, so it cannot resurrect a withdrawn
-- one, and the anchor is untouched, so no key stops answering.
--
-- Idempotent. Safe to run on every deploy. Read-only when there is
-- nothing to close.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS rule_timeline_repair_journal (
  id               BIGSERIAL PRIMARY KEY,
  rule_id          UUID NOT NULL,
  prior_expiration DATE,
  new_expiration   DATE NOT NULL,
  anchor_id        UUID NOT NULL,
  repaired_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No foreign key to payer_rule: a journal must outlive the row it
-- describes, and an FK here would block seeds from replacing their own
-- rules — which is how migration 0070's journal broke
-- payer-rules-cy2026-full-rule.sql.
CREATE INDEX IF NOT EXISTS rule_timeline_repair_journal_rule_idx
  ON rule_timeline_repair_journal (rule_id);

COMMENT ON TABLE rule_timeline_repair_journal IS
  'Every expiration_date narrowed by db/maintenance/close-rule-timelines.sql, '
  'appended on each run. To undo the most recent repair of a rule: '
  'UPDATE payer_rule p SET expiration_date = j.prior_expiration FROM '
  '(SELECT DISTINCT ON (rule_id) rule_id, prior_expiration FROM '
  'rule_timeline_repair_journal ORDER BY rule_id, id DESC) j WHERE p.id = j.rule_id.';

CREATE TEMP TABLE _anchor ON COMMIT DROP AS
SELECT DISTINCT ON (payer_id, state, code, attribute)
       payer_id, state, code, attribute, id AS anchor_id, effective_date AS anchor_effective
  FROM payer_rule
 WHERE effective_date <= CURRENT_DATE
   AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
 ORDER BY payer_id, state, code, attribute, effective_date DESC, id DESC;

CREATE TEMP TABLE _close ON COMMIT DROP AS
SELECT other.id                                           AS rule_id,
       other.expiration_date                              AS prior_expiration,
       a.anchor_id,
       GREATEST(other.effective_date, a.anchor_effective) AS new_expiration
  FROM payer_rule other
  JOIN _anchor a
    ON a.payer_id  = other.payer_id AND a.state = other.state
   AND a.code      = other.code     AND a.attribute = other.attribute
 WHERE other.id <> a.anchor_id
   AND (other.expiration_date IS NULL
        OR other.expiration_date > GREATEST(other.effective_date, a.anchor_effective));

INSERT INTO rule_timeline_repair_journal (rule_id, prior_expiration, new_expiration, anchor_id)
SELECT rule_id, prior_expiration, new_expiration, anchor_id FROM _close;

UPDATE payer_rule p
   SET expiration_date = c.new_expiration
  FROM _close c
 WHERE p.id = c.rule_id;

DO $$
DECLARE
  n_closed  INT;
  d         INT;
  ambiguous INT;
  worst     INT := 0;
  detail    TEXT := '';
BEGIN
  SELECT count(*) INTO n_closed FROM _close;

  FOREACH d IN ARRAY ARRAY[0, 30, 60, 90, 180, 270, 365, 545, 730] LOOP
    SELECT count(*) INTO ambiguous FROM (
      SELECT payer_id, state, code, attribute
        FROM payer_rule
       WHERE effective_date <= CURRENT_DATE - d
         AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE - d)
       GROUP BY 1,2,3,4 HAVING count(*) > 1) x;
    IF ambiguous > worst THEN worst := ambiguous; END IF;
    detail := detail || format('    dos -%s: %s%s', d, ambiguous, chr(10));
  END LOOP;

  RAISE NOTICE 'rule timelines: % overlap(s) closed', n_closed;
  IF worst > 0 THEN
    RAISE NOTICE '%', detail;
    RAISE EXCEPTION 'rule timelines: % key(s) still serve more than one rule at some date of service', worst;
  END IF;

  IF EXISTS (SELECT 1 FROM _close WHERE prior_expiration IS NOT NULL
                                    AND new_expiration > prior_expiration) THEN
    RAISE EXCEPTION 'rule timelines: a rule would have been EXTENDED, not shortened — refusing';
  END IF;

  RAISE NOTICE 'rule timelines OK — one rule served per key at every date checked';
END $$;

COMMIT;
