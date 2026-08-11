-- ============================================================================
-- expire-ungrounded-rules.sql — run AFTER the seeds, with the other
-- post-seed repairs.
--
-- WHAT IT REMOVES FROM SERVICE
-- Rules whose author is a PERSON rather than an extraction run. Every
-- legitimate rule in this library is created by a pipeline and names it:
--
--     extract:fee-schedules-full-2026-08    2745
--     crawler:cms_pfs                       1711
--     extract:denial-rules-2026-08           916
--     ... eight such authors, 6364 rules
--     test@pallio.io                           7   <-- these
--
-- Those seven came from db/seed/0018_test_palliative_payer_rules.sql, a
-- seed deliberately left OUT of db/seed/MANIFEST as test data. It was
-- applied to production before the manifest existed, and its rows stayed.
--
-- WHY THIS MATTERS MORE THAN THE COUNT SUGGESTS
-- They are not on test payers. They are on Aetna and Anthem BCBS Ohio, on
-- real palliative codes, and five of the seven hold `covered` -- the
-- attribute the superbill picker and the denial scorer lean on hardest.
-- They carry confidence 0.93-0.95, ABOVE every real extraction (0.75-0.85).
-- And fetchPayerRule ends in LIMIT 1, so where one of these is live it IS
-- the answer: a nurse practitioner asking whether Aetna covers 99349 in
-- Ohio was reading prose a developer typed.
--
-- Not one existing check could see them. They are well-formed rows: they
-- carry a source_quote (A1 passes), they are unique per key (B1/B6 pass),
-- they contradict nothing. They are sourced, internally consistent, and
-- untrue. Only asking "could the repo produce this row?" finds them, which
-- is what scripts/replay-from-scratch.sh does, and how they surfaced.
--
-- EXPIRED AT effective_date, NOT AT CURRENT_DATE
-- A denial is re-worked at the date of service on the CLAIM, inside a
-- 90-365 day filing window, so expiring at today would leave these serving
-- every past date. Setting expiration_date = effective_date makes the
-- window empty at EVERY date of service -- the rule was never true, so it
-- is never served -- while keeping the row, its quote and its author for
-- the audit trail.
--
-- DENYLIST, NOT A PATTERN
-- Only the authors named below are expired. An unrecognised author is NOT
-- guessed at here: verify-production.sh fails on any live rule whose
-- created_by is not an extract:/crawler: run, so the next one surfaces for
-- a human decision instead of being silently deleted by this script.
--
-- Idempotent: a second run finds nothing left to expire.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _ungrounded_authors (created_by TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _ungrounded_authors (created_by) VALUES ('test@pallio.io');

CREATE TABLE IF NOT EXISTS ungrounded_rule_expiry_journal (
  id              BIGSERIAL PRIMARY KEY,
  rule_id         UUID        NOT NULL,
  payer_id        UUID,
  state           TEXT,
  code            TEXT        NOT NULL,
  attribute       TEXT        NOT NULL,
  product_line    TEXT,
  created_by      TEXT        NOT NULL,
  confidence      NUMERIC,
  prior_expiration DATE,
  rule_value      JSONB       NOT NULL,
  expired_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No FK to payer_rule: seeds delete and re-insert their own rows, and an FK
-- here would break seed idempotency for the whole deploy. That is not
-- hypothetical -- migration 0070's journal had one and killed a deploy.
COMMENT ON TABLE ungrounded_rule_expiry_journal IS
  'Rules withdrawn from service by db/maintenance/expire-ungrounded-rules.sql '
  'because their author is a person, not an extraction run. To undo one: '
  'UPDATE payer_rule SET expiration_date = j.prior_expiration FROM '
  'ungrounded_rule_expiry_journal j WHERE payer_rule.id = j.rule_id;';

CREATE TEMP TABLE _expiring ON COMMIT DROP AS
SELECT pr.id
  FROM payer_rule pr
  JOIN _ungrounded_authors a ON a.created_by = pr.created_by
 WHERE pr.expiration_date IS DISTINCT FROM pr.effective_date;

INSERT INTO ungrounded_rule_expiry_journal
  (rule_id, payer_id, state, code, attribute, product_line, created_by,
   confidence, prior_expiration, rule_value)
SELECT pr.id, pr.payer_id, pr.state, pr.code, pr.attribute, pr.product_line,
       pr.created_by, pr.confidence, pr.expiration_date, pr.value
  FROM payer_rule pr JOIN _expiring e ON e.id = pr.id;

UPDATE payer_rule pr
   SET expiration_date = pr.effective_date
  FROM _expiring e
 WHERE pr.id = e.id;

DO $$
DECLARE
  n_expired INT;
  n_still   INT;
  r         RECORD;
BEGIN
  SELECT count(*) INTO n_expired FROM _expiring;

  -- Nothing from a denylisted author may be served at ANY date of service,
  -- not merely today.
  SELECT count(*) INTO n_still
    FROM payer_rule pr
    JOIN _ungrounded_authors a ON a.created_by = pr.created_by
   CROSS JOIN (VALUES (0),(30),(90),(180),(365),(730)) d(back)
   WHERE pr.effective_date <= CURRENT_DATE - d.back
     AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE - d.back);
  IF n_still <> 0 THEN
    RAISE EXCEPTION 'expire-ungrounded-rules: % ungrounded rule(s) still served at some date of service', n_still;
  END IF;

  RAISE NOTICE 'ungrounded rules: % withdrawn from service (author is a person, not an extraction run)', n_expired;

  -- The honest consequence, printed rather than buried: these keys now have
  -- NO answer. That is the correct state -- "we have no rule for this yet"
  -- is a thing a biller can act on, a fabricated coverage answer is not --
  -- but it IS a coverage gap, and it is the queue for real extraction.
  FOR r IN
    SELECT j.code, j.attribute, coalesce(p.name, j.payer_id::text) AS payer
      FROM ungrounded_rule_expiry_journal j
      LEFT JOIN payer p ON p.id = j.payer_id
     WHERE NOT EXISTS (
       SELECT 1 FROM payer_rule o
        WHERE o.payer_id IS NOT DISTINCT FROM j.payer_id
          AND o.state    IS NOT DISTINCT FROM j.state
          AND o.code = j.code AND o.attribute = j.attribute
          AND o.product_line IS NOT DISTINCT FROM j.product_line
          AND o.effective_date <= CURRENT_DATE
          AND (o.expiration_date IS NULL OR o.expiration_date > CURRENT_DATE))
     ORDER BY payer, j.code, j.attribute
  LOOP
    RAISE NOTICE '  now unanswered: % % %', r.payer, r.code, r.attribute;
  END LOOP;
END $$;

COMMIT;
