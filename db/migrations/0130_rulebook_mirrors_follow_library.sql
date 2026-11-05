-- ============================================================================
-- 0130_rulebook_mirrors_follow_library.sql
--
-- A practice's rulebook rows that nobody edited follow the rule library.
--
-- WHAT WENT WRONG
-- Generating a rulebook copies each library rule into org_rulebook_row
-- (origin 'source'): its value, coverage, confidence and quote, with a pointer
-- back to the rule. The lookup answered from that copy first. When the 3 Nov
-- 2026 audit corrected the library, in place, the copies kept the old text:
-- on production the smoke-test practice read G0318 as a "prolonged office"
-- code, quotes that stopped mid-sentence ("…(codes for evaluation and
-- management") and no NP/PA rate, on 19 of its 20 Medicare rows, for every
-- date of service. Migration 0080 repaired the same shape of fault once, for
-- fabricated rules; nothing kept the copies in step after that. Ingestion
-- refreshes them (propagateGlobalRuleToAllOrgRulebooks), but the seeds a
-- deploy re-applies never did.
--
-- WHAT CHANGES
--   * The lookup no longer answers from origin 'source' rows at all
--     (org-rule.repository.ts): the library answers those cells, for the date
--     of service. That needs no data change and is what billers see.
--   * The stored copies still feed the rulebook page and the cheat sheets, so
--     they are brought up to the library here, and again after every deploy's
--     seeds (db/maintenance/refresh-rulebook-mirrors.sql), by
--     app.refresh_rulebook_mirrors().
--
-- WHICH ROWS
-- Only origin 'source': copies of the library, and unreviewed AI answers
-- cached at confidence 0.4. A person's edit ('org_override'), an uploaded
-- rulebook ('org_upload') and an analyst's payer call ('analyst') are left
-- exactly as they are.
--
-- WHAT A ROW BECOMES
-- The rule that answers its key today where the practice is, picked as
-- close-rule-timelines.sql picks its anchor (latest effective date, then id).
-- A copy whose rule no longer answers on any key becomes the gap
-- generateRulebook writes for a cell with no rule: 'unknown', confidence 0, no
-- quote, no rule. A row that holds no rule and has none to take (a gap, or an
-- unreviewed AI answer) is left alone; once the library has a rule for its
-- key, it takes that rule.
--
-- Every row rewritten is journalled whole first (rulebook_mirror_journal), so
-- any of it can be put back.
-- ============================================================================

BEGIN;

CREATE TABLE rulebook_mirror_journal (
  id              BIGSERIAL   PRIMARY KEY,
  org_id          UUID        NOT NULL,
  rulebook_row_id UUID        NOT NULL,
  action          TEXT        NOT NULL CHECK (action IN ('follow', 'empty')),
  before_row      JSONB       NOT NULL,
  new_rule_id     UUID,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No foreign keys: a journal must outlive the rows it describes, and one on
-- payer_rule would block a seed from rewriting its own rules (0070's journal
-- broke payer-rules-cy2026-full-rule.sql that way).
CREATE INDEX rulebook_mirror_journal_row_idx ON rulebook_mirror_journal (rulebook_row_id);

-- It holds tenant rows, so it is a tenant table (db/test/0002 sweeps them all).
SELECT app.apply_tenant_rls('rulebook_mirror_journal');

COMMENT ON TABLE rulebook_mirror_journal IS
  'Each org_rulebook_row that app.refresh_rulebook_mirrors() rewrote, whole, as it was before. '
  'To undo the latest rewrite of a row: UPDATE org_rulebook_row r SET rule_value = (j.before_row->''rule_value''), '
  'coverage_status = j.before_row->>''coverage_status'', confidence = (j.before_row->>''confidence'')::numeric, '
  'source_quote = j.before_row->>''source_quote'', source_payer_rule_id = (j.before_row->>''source_payer_rule_id'')::uuid '
  'FROM (SELECT DISTINCT ON (rulebook_row_id) * FROM rulebook_mirror_journal ORDER BY rulebook_row_id, id DESC) j '
  'WHERE r.id = j.rulebook_row_id.';

-- What every machine-written rulebook row should hold, and what to do about it.
--   follow   the library answers its key and the row holds something else
--   current  the row already holds the rule that answers
--   empty    a copy whose rule no longer answers: becomes a gap
--   none     no rule answers it and it holds none (a gap, or an unreviewed
--            AI answer): left alone
CREATE FUNCTION app.rulebook_mirror_targets(p_today DATE DEFAULT NULL)
RETURNS TABLE (
  row_id          UUID,
  org_id          UUID,
  rule_id         UUID,
  rule_value      JSONB,
  coverage_status TEXT,
  confidence      NUMERIC,
  source_quote    TEXT,
  action          TEXT
)
LANGUAGE sql STABLE
SET search_path = public, app
AS $$
  SELECT r.id, r.org_id, t.id, t.value, t.coverage_status, t.confidence, t.source_quote,
         CASE
           WHEN t.id IS NOT NULL
            AND (   r.source_payer_rule_id IS DISTINCT FROM t.id
                 OR r.rule_value         IS DISTINCT FROM t.value
                 OR r.coverage_status    IS DISTINCT FROM t.coverage_status
                 OR r.confidence         IS DISTINCT FROM t.confidence
                 OR r.source_quote       IS DISTINCT FROM t.source_quote) THEN 'follow'
           WHEN t.id IS NOT NULL                      THEN 'current'
           WHEN r.source_payer_rule_id IS NOT NULL    THEN 'empty'
           ELSE 'none'
         END
    FROM org_rulebook_row r
    JOIN org o ON o.id = r.org_id
    LEFT JOIN LATERAL (
      -- Today where the practice is, as the lookup reads "today" (0107).
      SELECT pr.id, pr.value, pr.coverage_status, pr.confidence, pr.source_quote
        FROM payer_rule pr
       WHERE pr.payer_id  = r.payer_id
         AND pr.state     = r.state
         AND pr.code      = r.cpt_code
         AND pr.attribute = r.attribute
         AND pr.effective_date <= COALESCE(p_today, (now() AT TIME ZONE o.timezone)::date)
         AND (pr.expiration_date IS NULL
              OR pr.expiration_date > COALESCE(p_today, (now() AT TIME ZONE o.timezone)::date))
       ORDER BY pr.effective_date DESC, pr.id DESC
       LIMIT 1
    ) t ON TRUE
   WHERE r.origin = 'source'
$$;

COMMENT ON FUNCTION app.rulebook_mirror_targets(DATE) IS
  'For each org_rulebook_row with origin ''source'': the library rule that answers its key on p_today '
  '(default: today where its practice is), and whether the row must follow it, is current, '
  'must become a gap, or has no rule to take (a gap, or an unreviewed AI answer). Read-only.';

CREATE FUNCTION app.refresh_rulebook_mirrors(p_today DATE DEFAULT NULL)
RETURNS TABLE (followed INT, emptied INT, already_current INT, unanswered INT)
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  n_follow  INT;
  n_empty   INT;
  n_current INT;
  n_none    INT;
BEGIN
  SELECT count(*) FILTER (WHERE t.action = 'follow'),
         count(*) FILTER (WHERE t.action = 'empty'),
         count(*) FILTER (WHERE t.action = 'current'),
         count(*) FILTER (WHERE t.action = 'none')
    INTO n_follow, n_empty, n_current, n_none
    FROM app.rulebook_mirror_targets(p_today) t;

  -- Whole rows, before anything changes.
  INSERT INTO rulebook_mirror_journal (org_id, rulebook_row_id, action, before_row, new_rule_id)
  SELECT r.org_id, r.id, t.action, to_jsonb(r), t.rule_id
    FROM app.rulebook_mirror_targets(p_today) t
    JOIN org_rulebook_row r ON r.id = t.row_id
   WHERE t.action IN ('follow', 'empty');

  -- A gap is what generateRulebook writes for a cell with no rule.
  UPDATE org_rulebook_row r
     SET rule_value           = COALESCE(t.rule_value, '{}'::jsonb),
         coverage_status      = COALESCE(t.coverage_status, 'unknown'),
         confidence           = COALESCE(t.confidence, 0),
         source_quote         = t.source_quote,
         source_payer_rule_id = t.rule_id,
         updated_at           = now()
    FROM app.rulebook_mirror_targets(p_today) t
   WHERE r.id = t.row_id
     AND t.action IN ('follow', 'empty');

  RETURN QUERY SELECT n_follow, n_empty, n_current, n_none;
END
$$;

COMMENT ON FUNCTION app.refresh_rulebook_mirrors(DATE) IS
  'Brings every org_rulebook_row with origin ''source'' up to the library rule that answers its key today '
  '(journalled in rulebook_mirror_journal). A person''s edit, upload or payer call is never touched. '
  'Run by migration 0130 and by db/maintenance/refresh-rulebook-mirrors.sql after every deploy''s seeds.';

-- Reads and rewrites every practice's rulebook: for the deploy, not the app.
REVOKE ALL ON FUNCTION app.rulebook_mirror_targets(DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.refresh_rulebook_mirrors(DATE) FROM PUBLIC;

DO $$
DECLARE
  r     RECORD;
  left_ INT;
BEGIN
  SELECT * INTO r FROM app.refresh_rulebook_mirrors();
  RAISE NOTICE '0130: rulebook rows brought up to the library: % now hold the rule in force today, % lost their rule (now unknown), % were already current, % have no rule in the library (gaps, unreviewed AI answers) and were left alone',
    r.followed, r.emptied, r.already_current, r.unanswered;

  SELECT count(*) INTO left_ FROM app.rulebook_mirror_targets() WHERE action IN ('follow', 'empty');
  IF left_ <> 0 THEN
    RAISE EXCEPTION '0130: % rulebook row(s) still differ from the library after the refresh', left_;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
     AND has_function_privilege('app', 'app.refresh_rulebook_mirrors(date)', 'EXECUTE') THEN
    RAISE EXCEPTION '0130: the app role can run app.refresh_rulebook_mirrors(), which rewrites every practice''s rulebook';
  END IF;
END $$;

COMMIT;
