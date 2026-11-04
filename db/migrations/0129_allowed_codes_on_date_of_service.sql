-- ============================================================================
-- 0129_allowed_codes_on_date_of_service.sql
--
-- A payer's codes and rules as they stood on a date of service.
--
-- payer_allowed_codes_v answers for CURRENT_DATE only, and two things read it
-- for a claim that has a date of its own: the bill's code list and the
-- denial-risk score. A bill dated 12 March 2026 was offered codes, and
-- scored, by the rules in force on the day someone opened it: the January CMS
-- file had expired, so July's answered. The rate on the same bill came from the
-- January file (readPayerRates reads its date of service), so the bill and its
-- own checks disagreed about which rule applied. In 2026 the three CMS files
-- agree on every library code, so nothing visible changed; from January 2027 a
-- 2026 claim re-worked after a denial would have been checked against 2027's
-- rules.
--
--   payer_allowed_codes_on(p_dos)  the view's rows as they stood on p_dos
--   payer_allowed_codes_v          now the function on CURRENT_DATE: the same
--                                  columns, types and rows as before
--
-- One definition, so the two cannot drift. The function body is 0069's view
-- with CURRENT_DATE read as p_dos, nothing else changed. LANGUAGE sql, STABLE,
-- a single SELECT and no SECURITY DEFINER, so the planner inlines it and a
-- payer/state/code filter still reaches payer_rule's indexes. state and
-- confidence are cast back to character(2) and numeric(3,2) in the view: a
-- function's result columns carry no type modifier, and CREATE OR REPLACE VIEW
-- refuses to change one.
--
-- The function runs as its caller, so the caller reads payer_rule and code
-- itself; both are reference tables without RLS, which db/test/0001 asserts,
-- and app and analyst already read them directly.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE allowed_codes_before ON COMMIT DROP AS
SELECT * FROM payer_allowed_codes_v;

CREATE OR REPLACE FUNCTION payer_allowed_codes_on(p_dos DATE)
RETURNS TABLE (
  payer_id              UUID,
  state                 CHAR(2),
  product_line          TEXT,
  code                  TEXT,
  descriptor            TEXT,
  category              TEXT,
  code_system           TEXT,
  coverage_status       TEXT,
  confidence            NUMERIC(3,2),
  rule_value            JSONB,
  effective_date        DATE,
  expiration_date       DATE,
  source_doc_id         UUID,
  source_quote          TEXT,
  created_by            TEXT,
  rule_created_at       TIMESTAMPTZ,
  payer_rule_id         UUID,
  source_kind           TEXT,
  modifier_required     BOOLEAN,
  prior_auth_required   BOOLEAN,
  has_frequency_limit   BOOLEAN,
  frequency_limit_value TEXT,
  prior_auth_value      TEXT
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
WITH active_status AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.product_line,
    pr.code,
    pr.coverage_status,
    pr.confidence,
    pr.effective_date,
    pr.expiration_date,
    pr.value           AS rule_value,
    pr.source_doc_id,
    pr.source_quote,
    pr.created_by,
    pr.created_at,
    pr.id              AS payer_rule_id
  FROM payer_rule pr
  WHERE pr.attribute = 'covered'
    AND pr.coverage_status IN ('covered', 'varies', 'not_covered', 'unknown')
    AND pr.effective_date <= p_dos
    AND (pr.expiration_date IS NULL OR pr.expiration_date > p_dos)
    AND pr.superseded_by IS NULL
),
hints AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.code,
    BOOL_OR(pr.attribute = 'modifier_required'
            AND payer_rule_content_requires(pr.value, 'modifier_required'))
      AS modifier_required,
    BOOL_OR(pr.attribute = 'prior_auth_required'
            AND payer_rule_content_requires(pr.value, 'prior_auth_required'))
      AS prior_auth_required,
    BOOL_OR(pr.attribute = 'frequency_limit')     AS has_frequency_limit,
    MAX(CASE WHEN pr.attribute = 'frequency_limit' THEN pr.value::text END)
      AS frequency_limit_value,
    (array_agg(pr.value::text ORDER BY
        payer_rule_content_requires(pr.value, 'prior_auth_required') DESC,
        pr.effective_date DESC,
        pr.id)
      FILTER (WHERE pr.attribute = 'prior_auth_required'))[1]
      AS prior_auth_value
  FROM payer_rule pr
  WHERE pr.attribute IN ('modifier_required','prior_auth_required','frequency_limit')
    AND pr.effective_date <= p_dos
    AND (pr.expiration_date IS NULL OR pr.expiration_date > p_dos)
    AND pr.superseded_by IS NULL
  GROUP BY pr.payer_id, pr.state, pr.code
)
SELECT
  ac.payer_id,
  ac.state,
  ac.product_line,
  ac.code,
  c.short_descriptor                                  AS descriptor,
  c.category                                          AS category,
  c.code_system                                       AS code_system,
  ac.coverage_status,
  ac.confidence,
  ac.rule_value,
  ac.effective_date,
  ac.expiration_date,
  ac.source_doc_id,
  ac.source_quote,
  ac.created_by,
  ac.created_at                                       AS rule_created_at,
  ac.payer_rule_id,
  CASE
    WHEN ac.created_by IN ('crawler','cms') THEN 'crawler'
    WHEN ac.created_by = 'ai'                THEN 'ai'
    WHEN ac.created_by = 'manual'            THEN 'manual'
    WHEN ac.created_by LIKE '%@%'            THEN 'analyst'
    ELSE 'unknown'
  END                                                 AS source_kind,
  COALESCE(h.modifier_required, FALSE)                AS modifier_required,
  COALESCE(h.prior_auth_required, FALSE)              AS prior_auth_required,
  COALESCE(h.has_frequency_limit, FALSE)              AS has_frequency_limit,
  h.frequency_limit_value                             AS frequency_limit_value,
  h.prior_auth_value                                  AS prior_auth_value
FROM active_status ac
JOIN code c
  ON c.code = ac.code
 AND c.effective_date <= p_dos
 AND (c.expiration_date IS NULL OR c.expiration_date > p_dos)
LEFT JOIN hints h
  ON h.payer_id = ac.payer_id
 AND h.state    = ac.state
 AND h.code     = ac.code
$fn$;

COMMENT ON FUNCTION payer_allowed_codes_on(DATE) IS
  'payer_allowed_codes_v as it stood on p_dos: one row per (payer, state, '
  'code) rule in force that day, with the hint columns from the rules in force '
  'that day. The view is this function on CURRENT_DATE. A claim''s code list '
  'and denial-risk score read it on the claim''s date of service (0129).';

GRANT EXECUTE ON FUNCTION payer_allowed_codes_on(DATE) TO app, analyst;

CREATE OR REPLACE VIEW payer_allowed_codes_v AS
SELECT
  f.payer_id,
  f.state::CHAR(2)              AS state,
  f.product_line,
  f.code,
  f.descriptor,
  f.category,
  f.code_system,
  f.coverage_status,
  f.confidence::NUMERIC(3,2)    AS confidence,
  f.rule_value,
  f.effective_date,
  f.expiration_date,
  f.source_doc_id,
  f.source_quote,
  f.created_by,
  f.rule_created_at,
  f.payer_rule_id,
  f.source_kind,
  f.modifier_required,
  f.prior_auth_required,
  f.has_frequency_limit,
  f.frequency_limit_value,
  f.prior_auth_value
FROM payer_allowed_codes_on(CURRENT_DATE) f;

COMMENT ON VIEW payer_allowed_codes_v IS
  'One row per (payer, state, active CPT/HCPCS) — all coverage statuses — as '
  'of today: payer_allowed_codes_on(CURRENT_DATE) (0129). Anything reading for '
  'a claim reads the function on the claim''s date of service instead. '
  'modifier_required / prior_auth_required reflect what the sibling rules '
  'SAY (payer_rule_content_requires), not that a row exists; '
  'has_frequency_limit is presence-based. Service layer filters by '
  'coverage_status; "show all" mode includes denied/unknown.';

-- ---------------------------------------------------------------------
-- Postconditions.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  before_n INT;
  after_n  INT;
  differ   INT;
  r        RECORD;
BEGIN
  -- (a) Today's answer is unchanged, row for row. Any slip in copying 0069's
  --     view into the function shows up here on a database with rules in it.
  SELECT count(*) INTO before_n FROM allowed_codes_before;
  SELECT count(*) INTO after_n FROM payer_allowed_codes_v;
  SELECT count(*) INTO differ FROM (
    (SELECT * FROM allowed_codes_before EXCEPT ALL SELECT * FROM payer_allowed_codes_v)
    UNION ALL
    (SELECT * FROM payer_allowed_codes_v EXCEPT ALL SELECT * FROM allowed_codes_before)
  ) x;
  IF differ <> 0 THEN
    RAISE EXCEPTION
      'Rolling back: payer_allowed_codes_v changed (% rows before, % after, % differ). The function must reproduce 0069''s view on today''s date.',
      before_n, after_n, differ;
  END IF;

  -- (b) A past date answers from the rules in force then: a 'covered' rule
  --     that has since expired is still the answer inside its own window.
  --     Data-conditional, so an empty database passes too.
  FOR r IN
    SELECT pr.id, pr.effective_date
      FROM payer_rule pr
      JOIN code c ON c.code = pr.code
                 AND c.effective_date <= pr.effective_date
                 AND (c.expiration_date IS NULL OR c.expiration_date > pr.effective_date)
     WHERE pr.attribute = 'covered'
       AND pr.coverage_status IN ('covered', 'varies', 'not_covered', 'unknown')
       AND pr.superseded_by IS NULL
       AND pr.expiration_date IS NOT NULL
       AND pr.expiration_date > pr.effective_date
       AND pr.expiration_date <= CURRENT_DATE
     ORDER BY pr.expiration_date DESC, pr.id
     LIMIT 5
  LOOP
    IF NOT EXISTS (SELECT 1 FROM payer_allowed_codes_on(r.effective_date) f
                    WHERE f.payer_rule_id = r.id) THEN
      RAISE EXCEPTION
        'Rolling back: rule % was in force on % but payer_allowed_codes_on does not return it for that date.',
        r.id, r.effective_date;
    END IF;
    IF EXISTS (SELECT 1 FROM payer_allowed_codes_v v WHERE v.payer_rule_id = r.id) THEN
      RAISE EXCEPTION 'Rolling back: expired rule % is still in today''s view.', r.id;
    END IF;
  END LOOP;

  RAISE NOTICE '0129 complete. view rows today: % (unchanged).', after_n;
END $$;

COMMIT;
