-- ============================================================================
-- 0131_rulebook_uploads_repair.sql
--
-- Rulebook rows written by the upload merge and the rulebook editor before the
-- 5 Nov 2026 fixes, brought to what those fixes write.
--
-- WHAT WENT WRONG
--   * "Use Pallio" on an uploaded rulebook stored Pallio's rule as the
--     practice's own (origin 'org_upload'): the library as it read that day,
--     answering every date of service and never updated.
--   * An uploaded file names attributes the lookup's way ('prior_auth'); the
--     library and the lookup say 'prior_auth_required'. A row stored under the
--     short name never answered a lookup.
--   * Editing a payer call kept the attestation's expiry and its link to the
--     attestation: the lookup stopped using the edit on the day the call
--     expired, and voiding the attestation deleted the edit.
-- On 5 Nov 2026 production held 90 uploaded rows, 9 of them under short names.
--
-- WHAT A ROW BECOMES
--   to_library  An uploaded row copied from the library becomes a library copy
--               of the rule in force today where the practice is, or the gap
--               generation writes where there is none: what "Use Pallio"
--               stores now (rulebook.service.ts mergeUploadedRulebook). A row
--               is a copy when it holds keys only the library writes (a file's
--               row holds at most an "answer"), or when its value and coverage
--               equal a library rule's for its key.
--   renamed     An uploaded row under a short name takes the library's name,
--               where its rulebook holds no row under that name. It then
--               answers lookups, as the practice chose when it kept its own
--               value ("Keep mine" was the only choice those rows were shown).
--   detached    An edit drops the expiry and attestation link it kept from a
--               payer call (both mean something only on origin 'analyst', 0064).
-- Left as they are, and counted: an uploaded row under a short name whose
-- rulebook already holds that rule under the library's name. The old merge
-- showed the practice's row and Pallio's as two rows and stored both; nothing
-- says which the practice meant. A row with no payer answers no lookup under
-- any name and is not renamed.
--
-- Each row is journalled whole first (rulebook_mirror_journal, 0130). Read
-- 0130's table comment for how to put a row back.
-- ============================================================================

BEGIN;

ALTER TABLE rulebook_mirror_journal DROP CONSTRAINT rulebook_mirror_journal_action_check;
ALTER TABLE rulebook_mirror_journal ADD CONSTRAINT rulebook_mirror_journal_action_check
  CHECK (action IN ('follow', 'empty', 'to_library', 'renamed', 'detached'));

COMMENT ON TABLE rulebook_mirror_journal IS
  'Each org_rulebook_row rewritten by app.refresh_rulebook_mirrors() (follow, empty) or by migration 0131''s '
  'app.repair_rulebook_uploads() (to_library, renamed, detached), whole, as it was before. '
  'To undo the latest rewrite of a row: UPDATE org_rulebook_row r SET origin = j.before_row->>''origin'', '
  'attribute = j.before_row->>''attribute'', rule_value = (j.before_row->''rule_value''), '
  'coverage_status = j.before_row->>''coverage_status'', confidence = (j.before_row->>''confidence'')::numeric, '
  'source_quote = j.before_row->>''source_quote'', source_payer_rule_id = (j.before_row->>''source_payer_rule_id'')::uuid, '
  'expires_at = (j.before_row->>''expires_at'')::timestamptz, '
  'source_attestation_id = (j.before_row->>''source_attestation_id'')::uuid '
  'FROM (SELECT DISTINCT ON (rulebook_row_id) * FROM rulebook_mirror_journal ORDER BY rulebook_row_id, id DESC) j '
  'WHERE r.id = j.rulebook_row_id.';

-- Every row the repair would change, and what to.
CREATE FUNCTION app.rulebook_upload_repairs(p_today DATE DEFAULT NULL)
RETURNS TABLE (
  row_id          UUID,
  org_id          UUID,
  action          TEXT,
  new_attribute   TEXT,
  rule_id         UUID,
  rule_value      JSONB,
  coverage_status TEXT,
  confidence      NUMERIC,
  source_quote    TEXT
)
LANGUAGE sql STABLE
SET search_path = public, app
AS $$
  -- ATTRIBUTE_DB_MAP's six names that differ (payer-rule.repository.ts).
  WITH short_names (short_name, library_name) AS (
    VALUES ('prior_auth',       'prior_auth_required'),
           ('telehealth',       'telehealth_allowed'),
           ('provider_type',    'provider_taxonomy_allowed'),
           ('billing_limit',    'units_per_period_max'),
           ('addon_compatible', 'bundled_with'),
           ('documentation',    'documentation_required')
  )
  SELECT r.id, r.org_id, 'to_library', NULL::text,
         t.id, t.value, t.coverage_status, t.confidence, t.source_quote
    FROM org_rulebook_row r
    JOIN org o ON o.id = r.org_id
    LEFT JOIN LATERAL (
      -- Today where the practice is, as 0130 and the lookup read it.
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
   WHERE r.origin = 'org_upload'
     AND r.payer_id IS NOT NULL
     AND r.attribute NOT IN (SELECT short_name FROM short_names)
     -- A row renamed here was a file's row: never a pick, whatever it says.
     AND NOT EXISTS (SELECT 1 FROM rulebook_mirror_journal j
                      WHERE j.rulebook_row_id = r.id AND j.action = 'renamed')
     AND (   (r.rule_value - 'answer') <> '{}'::jsonb
          OR EXISTS (SELECT 1 FROM payer_rule pr
                      WHERE pr.payer_id = r.payer_id AND pr.state = r.state
                        AND pr.code = r.cpt_code AND pr.attribute = r.attribute
                        AND pr.value = r.rule_value AND pr.coverage_status = r.coverage_status))
  UNION ALL
  SELECT r.id, r.org_id,
         CASE WHEN EXISTS (SELECT 1 FROM org_rulebook_row x
                            WHERE x.rulebook_id = r.rulebook_id
                              AND x.payer_id    = r.payer_id
                              AND x.state       = r.state
                              AND x.cpt_code    = r.cpt_code
                              AND x.attribute   = s.library_name)
              THEN 'left_short' ELSE 'renamed' END,
         s.library_name, NULL, NULL, NULL, NULL, NULL
    FROM org_rulebook_row r
    JOIN short_names s ON s.short_name = r.attribute
   WHERE r.origin = 'org_upload'
     AND r.payer_id IS NOT NULL
  UNION ALL
  SELECT r.id, r.org_id, 'detached', NULL, NULL, NULL, NULL, NULL, NULL
    FROM org_rulebook_row r
   WHERE r.origin = 'org_override'
     AND (r.expires_at IS NOT NULL OR r.source_attestation_id IS NOT NULL)
$$;

COMMENT ON FUNCTION app.rulebook_upload_repairs(DATE) IS
  'Uploaded rulebook rows and edits written before the 5 Nov 2026 fixes, and what migration 0131 makes of each: '
  'to_library (a pick of Pallio''s rule becomes a copy of the rule in force on p_today, default today where the practice is), '
  'renamed (a short attribute name takes the library''s), left_short (the library''s name is taken in that rulebook), '
  'detached (an edit drops a payer call''s expiry and link). Read-only.';

CREATE FUNCTION app.repair_rulebook_uploads(p_today DATE DEFAULT NULL)
RETURNS TABLE (to_library INT, now_gaps INT, renamed INT, left_short INT, detached INT)
LANGUAGE plpgsql
SET search_path = public, app
AS $$
DECLARE
  n_lib  INT;
  n_gap  INT;
  n_ren  INT;
  n_left INT;
  n_det  INT;
BEGIN
  SELECT count(*) FILTER (WHERE t.action = 'to_library' AND t.rule_id IS NOT NULL),
         count(*) FILTER (WHERE t.action = 'to_library' AND t.rule_id IS NULL),
         count(*) FILTER (WHERE t.action = 'renamed'),
         count(*) FILTER (WHERE t.action = 'left_short'),
         count(*) FILTER (WHERE t.action = 'detached')
    INTO n_lib, n_gap, n_ren, n_left, n_det
    FROM app.rulebook_upload_repairs(p_today) t;

  -- Whole rows, before anything changes.
  INSERT INTO rulebook_mirror_journal (org_id, rulebook_row_id, action, before_row, new_rule_id)
  SELECT r.org_id, r.id, t.action, to_jsonb(r), t.rule_id
    FROM app.rulebook_upload_repairs(p_today) t
    JOIN org_rulebook_row r ON r.id = t.row_id
   WHERE t.action IN ('to_library', 'renamed', 'detached');

  -- What "Use Pallio" stores now: the rule in force today, or the gap.
  UPDATE org_rulebook_row r
     SET origin               = 'source',
         rule_value           = COALESCE(t.rule_value, '{}'::jsonb),
         coverage_status      = COALESCE(t.coverage_status, 'unknown'),
         confidence           = COALESCE(t.confidence, 0),
         source_quote         = t.source_quote,
         source_payer_rule_id = t.rule_id,
         updated_at           = now()
    FROM app.rulebook_upload_repairs(p_today) t
   WHERE r.id = t.row_id
     AND t.action = 'to_library';

  UPDATE org_rulebook_row r
     SET attribute  = t.new_attribute,
         updated_at = now()
    FROM app.rulebook_upload_repairs(p_today) t
   WHERE r.id = t.row_id
     AND t.action = 'renamed';

  UPDATE org_rulebook_row r
     SET expires_at            = NULL,
         source_attestation_id = NULL,
         updated_at            = now()
    FROM app.rulebook_upload_repairs(p_today) t
   WHERE r.id = t.row_id
     AND t.action = 'detached';

  RETURN QUERY SELECT n_lib, n_gap, n_ren, n_left, n_det;
END
$$;

COMMENT ON FUNCTION app.repair_rulebook_uploads(DATE) IS
  'Applies app.rulebook_upload_repairs(p_today), journalling each row whole in rulebook_mirror_journal first. '
  'Run once by migration 0131; a second run changes nothing.';

-- Reads and rewrites every practice's rulebook: for the deploy, not the app.
REVOKE ALL ON FUNCTION app.rulebook_upload_repairs(DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.repair_rulebook_uploads(DATE) FROM PUBLIC;

DO $$
DECLARE
  r     RECORD;
  left_ INT;
BEGIN
  SELECT * INTO r FROM app.repair_rulebook_uploads();
  RAISE NOTICE '0131: % uploaded rows were picks of Pallio''s rule and are now library copies (% hold the rule in force today, % have none and are gaps), % renamed to the library''s attribute names, % left under the old name beside a row for the same rule, % edits no longer expire with the payer call they started from',
    r.to_library + r.now_gaps, r.to_library, r.now_gaps, r.renamed, r.left_short, r.detached;

  SELECT count(*) INTO left_ FROM app.rulebook_upload_repairs() WHERE action <> 'left_short';
  IF left_ <> 0 THEN
    RAISE EXCEPTION '0131: % row(s) still need repair after the repair', left_;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
     AND (   has_function_privilege('app', 'app.repair_rulebook_uploads(date)', 'EXECUTE')
          OR has_function_privilege('app', 'app.rulebook_upload_repairs(date)', 'EXECUTE')) THEN
    RAISE EXCEPTION '0131: the app role can run the rulebook upload repair';
  END IF;
END $$;

COMMIT;
