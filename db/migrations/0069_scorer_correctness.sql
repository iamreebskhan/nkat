-- ============================================================================
-- 0069 — payer_allowed_codes_v: make the prior-auth / modifier hint flags
--        reflect what the rule SAYS, not that a row exists.
--
-- THE DEFECT
-- ----------
-- 0041 (and its 0047 replacement) computed the picker/predictor hints as
--
--     BOOL_OR(pr.attribute = 'prior_auth_required') AS prior_auth_required
--     BOOL_OR(pr.attribute = 'modifier_required')   AS modifier_required
--
-- That is ROW PRESENCE. `bool_or(attribute = 'x')` inside a CTE already
-- filtered to that attribute is just "a row exists", so a correctly
-- ingested rule whose answer reads "No prior approval is required under
-- policy 1H for 99348 delivered via telehealth" set the flag TRUE.
-- predictSuperbill() feeds that flag straight into scoreLine(), which adds
-- a `prior_auth_missing` reason worth 0.70 to the denial-risk score.
-- Noisy-OR with a 0.35 `coverage_varies` reason puts the line at 0.805 —
-- the high band — for a code the payer explicitly said needs no PA.
--
-- Measured on this database before the change:
--     view rows total ........................... 268
--     prior_auth_required = TRUE ................  72
--     of those, driven ONLY by rules whose answer
--     explicitly says no PA is required .........  12
--       AmeriHealth Caritas NC  NC 99347-99350 (medicaid_mco)
--       EBCI Tribal Option      NC 99347-99350 (tribal_638)
--       Healthy Blue NC         NC 99347-99350 (medicaid_mco)
--     modifier_required = TRUE ..................  67
--     of those wrongly flagged today ............   0
--
-- The modifier corpus contains no explicit negation today, so that flag is
-- accidentally right; it is fixed here anyway because the next correctly
-- written "no modifier required" rule would break it the same way.
--
-- WHAT "CONTENT SAYS REQUIRED" MEANS HERE
-- ---------------------------------------
-- Built from the 16 distinct prior_auth_required answers and 27 distinct
-- modifier_required answers actually in the library (not an imagined
-- corpus). The classifier is deliberately asymmetric, because under-warning
-- a biller (missed PA -> hard denial) costs more than over-warning
-- (one extra verification call):
--
--   1. If the text states a requirement ANYWHERE -> flag. This is what
--      makes conditional rules safe: "OUT-OF-NETWORK: prior authorization
--      is required ... ANTHEM SECONDARY: no prior authorization is
--      required" flags, because one of the two branches is a requirement
--      the biller may be standing in. Same for "requires prior
--      authorization after five visits" and "if the rendering practice is
--      NOT contracted ... prior authorization is required".
--   2. Otherwise, if the text explicitly negates the requirement -> do not
--      flag. "No prior approval is required under policy 1H for 99348
--      delivered via telehealth ... unless prior approval is otherwise
--      required for that specific service" is a negation: the trailing
--      "unless ... otherwise required" is a disclaimer that this policy
--      does not override other policies, not an assertion that this code
--      needs PA. Treating it as a requirement would flag the exact rows
--      this migration exists to unflag.
--   3. Otherwise (a rule exists but says neither) -> flag. E.g. "Submit
--      the prior-auth request at least 10 calendar days before the
--      scheduled date of service" never uses the word "required", but a
--      payer that documents a PA lead time is a payer that wants a PA.
--
-- Mechanically: mask every negation phrase, then look for a requirement
-- phrase in what survives. Masking first is what stops
-- "No prior approval is required" from matching the requirement pattern
-- "prior approval ... is required" inside itself.
--
-- Rules that survive as NOT-required after this change, and why that is
-- the honest answer rather than a lost warning:
--   * The four "policy 1H telehealth" rules (NC CCP 1H) — explicit.
--   * Healthy Blue NC — "subsequent visits (99341, 99342, 99344, 99345,
--     99347-99350) require no PA". The negation is scoped to in-network
--     practices; no rule in the library states Healthy Blue's
--     out-of-network position, so the old TRUE was noise, not evidence.
--     If that OON policy is ever ingested as its own row, the bool_or
--     below restores the flag for the same key with no code change.
--
-- Not changed here, and why:
--   * has_frequency_limit stays row-presence. A frequency_limit rule's
--     content IS the limit; presence of one is the fact being reported.
--   * The hints CTE still groups by (payer_id, state, code) without
--     product_line, so a rule filed under one product line still hints
--     every product line for that code. That is the pre-existing (and
--     conservative) behaviour; narrowing it would REMOVE warnings, which
--     is not this migration's job.
--
-- prior_auth_value stops being MAX(value::text) — a lexicographic pick
-- among however many PA rules share the key, which could show the biller
-- the negation while the flag said TRUE. It now prefers the rule that
-- actually caused the flag, then the most recently effective one.
--
-- Structure only: no payer_rule row is read, written, or expired, so there
-- is no pre-image to journal. Idempotent — CREATE OR REPLACE of one
-- function and one view; re-running produces byte-identical objects.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Baseline snapshot, taken while the OLD view definition is still
--    installed, so the postcondition can prove the flag count moved in
--    the right direction (and never the wrong one).
-- ---------------------------------------------------------------------
CREATE TEMP TABLE hint_flag_baseline ON COMMIT DROP AS
SELECT
  count(*) FILTER (WHERE prior_auth_required)::int AS pa_true,
  count(*) FILTER (WHERE modifier_required)::int   AS mod_true,
  count(*)::int                                    AS total_rows
FROM payer_allowed_codes_v;

-- ---------------------------------------------------------------------
-- 1. The classifier.
--
-- IMMUTABLE + PARALLEL SAFE: pure text over its arguments, so the planner
-- may fold it and the view stays parallelisable.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payer_rule_content_requires(
  p_value jsonb,
  p_kind  text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $fn$
DECLARE
  -- What the rule is about: "prior authorization" and its many spellings,
  -- or "modifier".
  subject text;
  -- Phrases that deny the requirement.
  neg_re  text;
  -- Phrases that assert it.
  aff_re  text;
  answer  text;
  masked  text;
BEGIN
  answer := coalesce(p_value->>'answer', '');

  -- No readable content: a rule row exists and we cannot tell what it
  -- says. Warn. (Every rule in the library carries an `answer` today;
  -- this is the guard for the day one does not.)
  IF btrim(answer) = '' THEN
    RETURN TRUE;
  END IF;

  IF p_kind = 'prior_auth_required' THEN
    subject :=
      '(prior[[:space:]_-]*(authoriz|authoris|approv|auth)[a-z]*'
      || '|pre-?(authoriz|authoris|cert)[a-z]*'
      || '|\mPAs?\M)';

    neg_re :=
         '(\mno\M[[:space:]]+' || subject || ')'
      || '|(' || subject || '[[:space:]]+(is|are|was|were)[[:space:]]+not[[:space:]]+required)'
      || '|((do|does|did|will)[[:space:]]+not[[:space:]]+(require|need)[[:space:]]+'
         || '(a[[:space:]]+|an[[:space:]]+|any[[:space:]]+)?' || subject || ')'
      || '|(requires?d?[[:space:]]+no[[:space:]]+' || subject || ')'
      -- NOT a negation, and it was one here until it was measured.
      -- "Services rendered without prior authorization will be denied" is
      -- the single most common way a payer manual STATES the requirement.
      -- Reading it as a denial of the requirement produced silence on
      -- exactly the claims most likely to be rejected — a far worse
      -- failure than the over-warning this function was written to stop.
      -- Left out of neg_re deliberately; the affirmative side catches it.
      || '|(\mno\M[[:space:]]+need[[:space:]]+for[[:space:]]+(a[[:space:]]+|an[[:space:]]+)?' || subject || ')'
      -- "is waived" denies the requirement; "is NOT waived" asserts it.
      -- The optional (not )? made the two identical, so an explicit
      -- assertion read as a denial.
      || '|(' || subject || '[[:space:]]+(is|are)[[:space:]]+waived)';

    -- "without <subject>" states the requirement whenever a consequence
    -- follows, which is how manuals phrase it: denied, rejected, not
    -- reimbursed, not payable.
    aff_re := '(without[[:space:]]+(a[[:space:]]+|an[[:space:]]+)?' || subject
      || '[^.]*(deni|reject|not[[:space:]]+(be[[:space:]]+)?(reimburs|paid|payable|covered)|forfeit))|';

    -- `requir[a-z]*` + up to three filler words covers "requires prior
    -- authorization", "required a prior approval", "requiring prior
    -- authorisation for all ...". The filler is [a-z]+ only, so it can
    -- never span the ' <> ' mask token planted over a negation.
    aff_re := aff_re ||
         '(' || subject || '[[:space:]]+(is|are|was|were)[[:space:]]+required)'
      || '|(requir[a-z]*[[:space:]]+([a-z]+[[:space:]]+){0,3}' || subject || ')'
      || '|(must[[:space:]]+([a-z]+[[:space:]]+){0,3}' || subject || ')'
      || '|(' || subject || '[[:space:]]+(must|shall)[[:space:]]+be)'
      || '|((authoriz|authoris)[a-z]*[[:space:]]+before[[:space:]]+the[[:space:]]+service)'
      || '|(subject[[:space:]]+to[[:space:]]+' || subject || ')';

  ELSIF p_kind = 'modifier_required' THEN
    subject := '(modifier[a-z]*)';

    -- Tighter than the PA negation on purpose. "The manual names NO
    -- service-specific modifier for home-based E/M ... Do not read this
    -- manual as waiving modifiers" is NOT a negation of the requirement —
    -- it is an absence of a payer-specific one — so the negation pattern
    -- demands the word "required"/"applicable" next to the denial.
    neg_re :=
         '((\mno\M|not)[[:space:]]+(a[[:space:]]+|any[[:space:]]+)?' || subject
         || '[[:space:]]+(is[[:space:]]+|are[[:space:]]+)?required)'
      || '|(' || subject || '[[:space:]]+(is|are|was|were)[[:space:]]+not[[:space:]]+required)'
      || '|((do|does|did|will)[[:space:]]+not[[:space:]]+(require|need)[[:space:]]+'
         || '(a[[:space:]]+|an[[:space:]]+|any[[:space:]]+)?' || subject || ')'
      || '|(requires?d?[[:space:]]+no[[:space:]]+' || subject || ')'
      || '|(' || subject || '[[:space:]]+(is|are)[[:space:]]+not[[:space:]]+(applicable|needed|necessary))';

    -- "append modifier GT", "must carry one of GQ/GT/G0/95", "a telehealth
    -- modifier is mandatory: GQ, GT, ...", "requiring a POC therapy
    -- modifier", "Modifier 76 must be appended".
    aff_re :=
         '(' || subject || '[[:space:]]+([a-z0-9/]+[[:space:]]+){0,4}(is|are)[[:space:]]+(required|mandatory))'
      || '|((is|are)[[:space:]]+(required|mandatory))'
      || '|(requir[a-z]*[[:space:]]+([a-z]+[[:space:]]+){0,3}' || subject || ')'
      || '|(must[[:space:]]+([a-z]+[[:space:]]+){0,4}' || subject || ')'
      || '|(' || subject || '[[:space:]]+([a-z0-9/]+[[:space:]]+){0,4}must[[:space:]]+be)'
      || '|(\mappend\M|\mmust[[:space:]]+carry\M)';

  ELSE
    -- Unknown hint kind: flag rather than silently clear a warning.
    RETURN TRUE;
  END IF;

  masked := regexp_replace(answer, neg_re, ' <> ', 'gi');

  -- 1. A requirement survives the masking -> required.
  IF masked ~* aff_re THEN
    RETURN TRUE;
  END IF;

  -- 2. Something was masked, and nothing affirmative was left -> the rule
  --    is an explicit negation.
  IF masked <> answer THEN
    RETURN FALSE;
  END IF;

  -- 3. Neither signal. A rule exists on this attribute; warn.
  RETURN TRUE;
END;
$fn$;

COMMENT ON FUNCTION payer_rule_content_requires(jsonb, text) IS
  'Does a payer_rule.value say the thing is REQUIRED? p_kind is the '
  'payer_rule.attribute (prior_auth_required | modifier_required). '
  'Conservative: an affirmative requirement anywhere wins over a negation '
  '(conditional rules such as "required out-of-network" must still warn); '
  'an explicit negation with no surviving requirement returns false; '
  'silence returns true. See db/migrations/0069_scorer_correctness.sql.';

GRANT EXECUTE ON FUNCTION payer_rule_content_requires(jsonb, text) TO app, analyst;

-- ---------------------------------------------------------------------
-- 2. The view. Column list, order and types are byte-identical to 0047 —
--    only the two hint expressions and prior_auth_value change, so
--    CREATE OR REPLACE is legal and no dependent object is disturbed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW payer_allowed_codes_v AS
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
    AND pr.effective_date <= CURRENT_DATE
    AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
    AND pr.superseded_by IS NULL
),
hints AS (
  SELECT
    pr.payer_id,
    pr.state,
    pr.code,
    -- CONTENT, not presence: true when at least one live rule on this key
    -- says a modifier is required.
    BOOL_OR(pr.attribute = 'modifier_required'
            AND payer_rule_content_requires(pr.value, 'modifier_required'))
      AS modifier_required,
    BOOL_OR(pr.attribute = 'prior_auth_required'
            AND payer_rule_content_requires(pr.value, 'prior_auth_required'))
      AS prior_auth_required,
    -- Frequency limits stay presence-based: the rule's content is the
    -- limit itself, so "a rule exists" is the fact being reported.
    BOOL_OR(pr.attribute = 'frequency_limit')     AS has_frequency_limit,
    MAX(CASE WHEN pr.attribute = 'frequency_limit' THEN pr.value::text END)
      AS frequency_limit_value,
    -- Show the rule that CAUSED the flag, so the picker never displays a
    -- "no PA needed" answer next to a prior-auth warning. Ties break on
    -- the most recently effective rule, then id, so the value is stable.
    (array_agg(pr.value::text ORDER BY
        payer_rule_content_requires(pr.value, 'prior_auth_required') DESC,
        pr.effective_date DESC,
        pr.id)
      FILTER (WHERE pr.attribute = 'prior_auth_required'))[1]
      AS prior_auth_value
  FROM payer_rule pr
  WHERE pr.attribute IN ('modifier_required','prior_auth_required','frequency_limit')
    AND pr.effective_date <= CURRENT_DATE
    AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
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
 AND c.effective_date <= CURRENT_DATE
 AND (c.expiration_date IS NULL OR c.expiration_date > CURRENT_DATE)
LEFT JOIN hints h
  ON h.payer_id = ac.payer_id
 AND h.state    = ac.state
 AND h.code     = ac.code;

COMMENT ON VIEW payer_allowed_codes_v IS
  'One row per (payer, state, active CPT/HCPCS) — all coverage statuses. '
  'modifier_required / prior_auth_required reflect what the sibling rules '
  'SAY (payer_rule_content_requires), not that a row exists; '
  'has_frequency_limit is presence-based. Service layer filters by '
  'coverage_status; "show all" mode includes denied/unknown.';

-- ---------------------------------------------------------------------
-- 3. Postconditions. A migration that cannot prove it worked is not done.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  pa_before   INT;
  mod_before  INT;
  rows_before INT;
  pa_after    INT;
  mod_after   INT;
  rows_after  INT;
  bad         INT;
  probe       TEXT;
BEGIN
  SELECT pa_true, mod_true, total_rows
    INTO pa_before, mod_before, rows_before
    FROM hint_flag_baseline;

  SELECT count(*) FILTER (WHERE prior_auth_required),
         count(*) FILTER (WHERE modifier_required),
         count(*)
    INTO pa_after, mod_after, rows_after
    FROM payer_allowed_codes_v;

  -- (a) Classifier unit tests, on literal strings taken verbatim from the
  --     library. These stay meaningful even if the data changes, and they
  --     are the contract the view depends on.
  FOREACH probe IN ARRAY ARRAY[
    'No prior approval is required under policy 1H for 99348 delivered via telehealth, and no initial in-person examination is required, unless prior approval is otherwise required for that specific service.',
    'subsequent visits (99341, 99342, 99347-99350) require no PA as long as the clinician deems them medically necessary.',
    'Prior authorization is not required when Anthem is the secondary payer.'
  ] LOOP
    IF payer_rule_content_requires(jsonb_build_object('answer', probe), 'prior_auth_required') THEN
      RAISE EXCEPTION
        'Rolling back: classifier flagged an explicit PA negation as required — %',
        left(probe, 90);
    END IF;
  END LOOP;

  FOREACH probe IN ARRAY ARRAY[
    'Depends on network status. An OUT-OF-NETWORK physician, facility or other health care professional must obtain prior authorization for all procedures and services.',
    'OUT-OF-NETWORK: prior authorization is required for all out-of-network services except emergency services. ANTHEM SECONDARY: no prior authorization is required when Anthem is the secondary payer.',
    'Under the Home health/home infusion category of this PAL, 99344 requires prior authorization after five visits. The first five visits may be billed without prior authorization.',
    'Submit the prior-auth request at least 10 calendar days before the scheduled date of service.'
  ] LOOP
    IF NOT payer_rule_content_requires(jsonb_build_object('answer', probe), 'prior_auth_required') THEN
      RAISE EXCEPTION
        'Rolling back: classifier cleared a PA requirement (conditional rules must still warn) — %',
        left(probe, 90);
    END IF;
  END LOOP;

  FOREACH probe IN ARRAY ARRAY[
    'Whenever any of these services is delivered by telehealth, a telehealth modifier is mandatory: GQ, GT, G0 or 95. Submitting the bare code with no telehealth modifier is a denial.',
    'The manual names NO service-specific modifier for home-based E/M. Do not read this manual as waiving modifiers - apply standard CPT/HCPCS modifier rules.',
    'Append modifier GT to 99350 when the service was delivered via interactive audio-visual communication.'
  ] LOOP
    IF NOT payer_rule_content_requires(jsonb_build_object('answer', probe), 'modifier_required') THEN
      RAISE EXCEPTION
        'Rolling back: classifier cleared a modifier requirement — %', left(probe, 90);
    END IF;
  END LOOP;

  IF payer_rule_content_requires(
       jsonb_build_object('answer', 'No modifier is required for this code.'),
       'modifier_required') THEN
    RAISE EXCEPTION 'Rolling back: classifier flagged an explicit modifier negation as required.';
  END IF;

  -- Silence and unreadable content must still warn.
  IF NOT payer_rule_content_requires('{}'::jsonb, 'prior_auth_required')
     OR NOT payer_rule_content_requires(jsonb_build_object('answer', ''), 'modifier_required')
     OR NOT payer_rule_content_requires(jsonb_build_object('answer', 'See the payer portal.'), 'prior_auth_required')
  THEN
    RAISE EXCEPTION 'Rolling back: an unreadable/silent rule must still raise the flag.';
  END IF;

  -- (b) The view must agree with the classifier in both directions.
  SELECT count(*) INTO bad
  FROM payer_allowed_codes_v v
  WHERE v.prior_auth_required
    AND NOT EXISTS (
      SELECT 1 FROM payer_rule pr
       WHERE pr.payer_id = v.payer_id AND pr.state = v.state AND pr.code = v.code
         AND pr.attribute = 'prior_auth_required'
         AND pr.effective_date <= CURRENT_DATE
         AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
         AND pr.superseded_by IS NULL
         AND payer_rule_content_requires(pr.value, 'prior_auth_required')
    );
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % view row(s) still flag prior_auth_required with no rule that says so.', bad;
  END IF;

  SELECT count(*) INTO bad
  FROM payer_allowed_codes_v v
  WHERE NOT v.prior_auth_required
    AND EXISTS (
      SELECT 1 FROM payer_rule pr
       WHERE pr.payer_id = v.payer_id AND pr.state = v.state AND pr.code = v.code
         AND pr.attribute = 'prior_auth_required'
         AND pr.effective_date <= CURRENT_DATE
         AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
         AND pr.superseded_by IS NULL
         AND payer_rule_content_requires(pr.value, 'prior_auth_required')
    );
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % view row(s) DROPPED a prior-auth warning a rule still asserts.', bad;
  END IF;

  SELECT count(*) INTO bad
  FROM payer_allowed_codes_v v
  WHERE v.modifier_required
    AND NOT EXISTS (
      SELECT 1 FROM payer_rule pr
       WHERE pr.payer_id = v.payer_id AND pr.state = v.state AND pr.code = v.code
         AND pr.attribute = 'modifier_required'
         AND pr.effective_date <= CURRENT_DATE
         AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
         AND pr.superseded_by IS NULL
         AND payer_rule_content_requires(pr.value, 'modifier_required')
    );
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % view row(s) still flag modifier_required with no rule that says so.', bad;
  END IF;

  -- (c) The displayed PA text must never contradict the flag.
  SELECT count(*) INTO bad
  FROM payer_allowed_codes_v v
  WHERE v.prior_auth_required
    AND v.prior_auth_value IS NOT NULL
    AND NOT payer_rule_content_requires(v.prior_auth_value::jsonb, 'prior_auth_required');
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % view row(s) warn about prior auth while showing a "no PA needed" answer.', bad;
  END IF;

  -- (d) The row set itself must be untouched, and content-derived flags
  --     can only ever be a subset of presence-derived ones.
  IF rows_after <> rows_before THEN
    RAISE EXCEPTION
      'Rolling back: view row count changed % -> %. Only the hint columns should have moved.',
      rows_before, rows_after;
  END IF;
  IF pa_after > pa_before OR mod_after > mod_before THEN
    RAISE EXCEPTION
      'Rolling back: hint flags rose (PA % -> %, modifier % -> %). Content flags are a subset of presence flags; a rise means the classifier is matching something it should not.',
      pa_before, pa_after, mod_before, mod_after;
  END IF;

  -- (e) If the library actually contains an explicit "no PA required"
  --     rule, the flag must have come off somewhere. Data-conditional so
  --     the migration still passes on an empty/fresh database, and it
  --     re-passes unchanged on a second run (pa_after = pa_before then).
  IF EXISTS (
    SELECT 1 FROM payer_rule pr
     WHERE pr.attribute = 'prior_auth_required'
       AND pr.effective_date <= CURRENT_DATE
       AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
       AND pr.superseded_by IS NULL
       AND NOT payer_rule_content_requires(pr.value, 'prior_auth_required')
       AND EXISTS (SELECT 1 FROM payer_allowed_codes_v v
                    WHERE v.payer_id = pr.payer_id AND v.state = pr.state AND v.code = pr.code)
  ) AND pa_after = pa_before AND pa_before > 0 THEN
    RAISE WARNING
      'Live "no prior auth required" rules exist on codes in the view, but the flag count did not move (% -> %). Expected on a re-run; investigate on a first run.',
      pa_before, pa_after;
  END IF;

  RAISE NOTICE '0069 complete. view rows: % (unchanged).', rows_after;
  RAISE NOTICE '  prior_auth_required TRUE: % -> %  (% false warnings removed)',
    pa_before, pa_after, pa_before - pa_after;
  RAISE NOTICE '  modifier_required   TRUE: % -> %  (% false warnings removed)',
    mod_before, mod_after, mod_before - mod_after;
END $$;

-- ---------------------------------------------------------------------
-- The classifier's own test corpus.
--
-- The postconditions above check that the view changed the way this
-- migration intended. They cannot check that the CLASSIFIER IS RIGHT,
-- because they evaluate the same function over the same rows the flags
-- were built from — a tautology. The first version of this function
-- passed every one of them while reading "services rendered WITHOUT
-- prior authorization will be denied" as a statement that no
-- authorization is needed.
--
-- So: fixed sentences, expected answers, asserted here. If a future edit
-- to the regexes breaks one, the migration refuses to commit.
--
-- THE ASYMMETRY THAT DECIDES EVERY AMBIGUOUS CASE. Warning when no
-- authorization is needed costs a biller thirty seconds. Staying silent
-- when it IS needed costs a denied claim and a re-file inside the
-- timely-filing window. When the wording is genuinely unclear, this
-- function must warn.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t   RECORD;
  got BOOLEAN;
  bad INT := 0;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- Requirement stated as a consequence of not having it. This is the
      -- phrasing the first version got backwards, and it is the commonest
      -- one in a payer manual.
      ('Services rendered without prior authorization will be denied.',                         TRUE),
      ('Claims submitted without a prior authorization number will be rejected.',               TRUE),
      ('A claim without prior authorization is not reimbursed.',                                TRUE),
      ('Care provided without pre-certification will not be covered.',                          TRUE),
      -- Requirement stated plainly.
      ('Prior authorization is required for all out-of-network services.',                      TRUE),
      ('Providers must obtain prior authorization before the service.',                         TRUE),
      ('This service is subject to prior authorization.',                                       TRUE),
      ('Prior authorization is not waived for palliative care home visits.',                    TRUE),
      ('Home health visits require prior authorization after five visits.',                     TRUE),
      -- Genuine negations. These must NOT warn.
      ('No prior authorization is required when Anthem is the secondary payer.',                FALSE),
      ('Prior authorization is not required for this code.',                                    FALSE),
      ('This plan does not require prior authorization for home visits.',                       FALSE),
      ('Evaluation and management visits for mental health require no prior authorization.',    FALSE),
      ('Prior authorization is waived for emergency services.',                                 FALSE),
      -- Unreadable content must warn rather than stay silent.
      ('',                                                                                      TRUE)
    ) AS v(sentence, expected)
  LOOP
    got := payer_rule_content_requires(
             jsonb_build_object('answer', t.sentence), 'prior_auth_required');
    IF got IS DISTINCT FROM t.expected THEN
      bad := bad + 1;
      RAISE WARNING 'classifier: expected % got % for "%"', t.expected, got, t.sentence;
    END IF;
  END LOOP;

  IF bad > 0 THEN
    RAISE EXCEPTION 'migration 0069: the prior-auth classifier misreads % of its own test sentences — see the warnings above. Refusing to install a classifier that can silence a real authorization requirement.', bad;
  END IF;
  RAISE NOTICE 'migration 0069: prior-auth classifier passes all 15 corpus sentences';
END $$;

COMMIT;
