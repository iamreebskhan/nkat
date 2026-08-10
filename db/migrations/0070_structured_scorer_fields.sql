-- 0070 — backfill the structured frequency-limit fields the denial scorer
--        actually reads, for the rules whose prose states an unambiguous cap.
--
-- WHY
-- ---
-- `predictSuperbill` (lib/features/billing/predict-superbill.service.ts:104-122)
-- builds `CodeRuleSet.frequencyLimit` only when JSON.parse of the
-- frequency_limit rule value yields NUMERIC `maxOccurrences` AND `windowDays`.
-- Measured before this migration:
--
--   SELECT jsonb_object_keys(value), count(*) FROM payer_rule
--    WHERE attribute='frequency_limit' AND effective_date <= CURRENT_DATE
--      AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
--      AND superseded_by IS NULL GROUP BY 1;
--   -> answer 149 | appliesToService 98 | mappedFrom 98
--      supportingQuotes 25 | sourceDocument 25
--
-- Zero of the 149 live rules carry either key, so the `frequency_exceeded`
-- reason (weight 0.75, denial-risk.service.ts:269-291) can never fire for any
-- code or payer. The prose carries the numbers; nothing structured does.
--
-- WHAT THIS DOES
-- --------------
-- ADDS `maxOccurrences` + `windowDays` alongside the existing keys on the 32
-- live rows whose prose states a cap that is unambiguous AND expressible as
-- the single (count, trailing-window) pair the scorer supports. It does not
-- touch `answer`, `supportingQuotes`, `sourceDocument`, or the `source_quote`
-- column — the citation stays exactly as extracted. 117 of 149 rows are left
-- alone; the classification of every distinct answer is recorded below.
--
-- `modifier_required` is deliberately NOT touched. See section 4.
--
-- WINDOW ARITHMETIC — READ BEFORE CHANGING A NUMBER
-- -------------------------------------------------
-- countInWindow (denial-risk.service.ts:150-163) counts history rows with
--   dos - windowDays <= h.dos <= dos
-- i.e. the window is INCLUSIVE OF BOTH ENDPOINTS, and the reason fires when
-- used + 1 > maxOccurrences. So for a rule that permits one service every N
-- days, `windowDays = N` would flag a service billed at exactly the permitted
-- N-day cadence — a false positive on perfectly compliant billing. Every
-- interval below is therefore encoded as N-1, and a same-date-of-service rule
-- is encoded as windowDays = 0 (which selects exactly the DOS itself).
--
-- Idempotent: the UPDATE is guarded on the keys being absent, so a second run
-- matches no rows and writes nothing. Journals pre-images. Ends by proving its
-- own postcondition.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Journal.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_0070_scorer_fields_journal (
  -- NO foreign key to payer_rule, deliberately. A journal holds
  -- pre-images and must outlive the row it describes. An FK here blocks
  -- any seed from deleting and re-inserting its own rules, which is
  -- exactly what happened: payer-rules-cy2026-full-rule.sql replaces its
  -- 1,689 rows on every run and died with
  --   violates foreign key constraint
  --   "migration_0070_scorer_fields_journal_rule_id_fkey"
  -- breaking seed idempotency for the whole deploy.
  rule_id      UUID        PRIMARY KEY,
  attribute    TEXT        NOT NULL,
  prior_value  JSONB       NOT NULL,
  journaled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE migration_0070_scorer_fields_journal
  DROP CONSTRAINT IF EXISTS migration_0070_scorer_fields_journal_rule_id_fkey;

COMMENT ON TABLE migration_0070_scorer_fields_journal IS
  'Pre-images of payer_rule.value for rows migration 0070 added structured '
  'scorer fields to. To undo: UPDATE payer_rule p SET value = j.prior_value '
  'FROM migration_0070_scorer_fields_journal j WHERE p.id = j.rule_id;';

-- ---------------------------------------------------------------------
-- 2. The hand-classified target set.
--
-- Rules are pinned by md5 of the exact prose answer AND by code, so a row
-- can only be touched when both the wording and the code it is attached to
-- are the ones classified here. If ingestion ever rewords an answer, the
-- hash stops matching and this migration goes inert rather than guessing —
-- the guard in section 5 turns that into a hard failure.
--
-- ENCODED (6 answers, 32 rows):
--
--  a) "Bill a NEW patient home visit (99341, 99342, 99344, 99345) only once
--     per patient per provider per three years." -> 1 / 1094 days.
--     Attached to exactly the four new-patient codes it names. NOTE: the
--     scorer's history is per patient across the practice, not per provider,
--     so this can fire when a DIFFERENT clinician in the practice bills a
--     new-patient visit. That is not a false alarm in practice — under CPT's
--     same-group/same-specialty rule that second visit is an established
--     patient visit anyway, which is precisely what this payer downcodes to.
--
--  b) "Bill home health recertification (G0179) on a 60-calendar-day cycle —
--     one recertification per 60-day certification period ... Do not bill
--     G0179 more often than the 60-day cycle." -> 1 / 59 days.
--
--  c) "HCPCS code G0136 ... may be billed not more often than every 6
--     months." -> 1 / 179 days (6 months read as 180 days, minus 1 for the
--     inclusive window; erring short means the check under-fires rather than
--     flagging a compliant 6-month interval).
--
--  d) IBT for obesity, individual (G0447): "one visit every week for the
--     first month; one visit every other week for months 2 to 6; and one
--     visit every month for months 7 to 12." -> 1 / 6 days. The schedule is
--     phased and cannot be encoded exactly with one pair, but "no more than
--     one in any 7-day span" holds in EVERY phase (weekly is the densest),
--     so this is the tightest cap that can never contradict the prose.
--
--  e) Same schedule for IBT group counseling (G0473). -> 1 / 6 days.
--
--  f) "Only one clinician may be paid for the same code, same patient, same
--     date of service - CCH's duplicate edits look across providers and
--     across the practice's history." -> 1 / 0 days (same DOS only).
--     The scorer's history is exactly "this patient, this practice", which
--     matches the stated scope.
--     EXCLUDED from this one: 99417, 99425, 99427, 99439, 99498. All five
--     are add-on codes that a SINGLE clinician may legitimately report more
--     than once for one date (each additional 15/20/30 minutes). The prose
--     forbids a second CLINICIAN, not a second unit, and the scorer counts
--     lines, so encoding them would flag compliant billing. The other 15
--     codes on this rule are once-per-day services by construction.
--
-- NOT ENCODED (17 answers, 117 rows) and why:
--
--   - UnitedHealthcare "maximum daily frequency edit per procedure ... the
--     manual does NOT publish the numeric limit" (25 rows) — no number.
--   - Second plan, same shape: "the manual does not publish the per-code
--     values" (21 rows) — no number.
--   - Absolute Total Care "check the current SC Medicaid fee schedule for a
--     per-period or lifetime count" (24 rows) — narrative, points elsewhere.
--   - NINE CY2026 PFS answers of the form "The frequency limitation of one
--     ... is permanently REMOVED for <code> beginning CY 2026" — G0508,
--     G0509, 99231, 99232, 99233, 99307, 99308, 99309, 99310 (27 rows).
--     These state the ABOLITION of a cap. The numbers in the prose are the
--     old limits. Encoding them would invert the rule and manufacture
--     denials risk on claims CMS explicitly freed. Left alone deliberately.
--   - 98975 and 99453: "2 days of monitoring in a 30-day period" (6 rows) —
--     a MINIMUM data requirement for reporting the code, not a billing cap.
--     maxOccurrences/windowDays cannot express a floor.
--   - MDPP session structure for G9886, G9887, G9871 (9 rows) — "up to 22
--     sessions over 12 months ... no more than one per week". Not encoded
--     because the same payer's modifier rules for these very codes state
--     that a make-up session MAY be held on the same day as a regularly
--     scheduled session (CPT modifier 76 exists to identify it). A 1-per-week
--     or 1-per-day cap would therefore flag billing the payer explicitly
--     contemplates. The 22-per-12-months cap is real but is out of reach of
--     the 90-day history window (see section 5), so it would be inert.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE freq_targets (
  answer_md5      TEXT   NOT NULL,
  codes           TEXT[] NOT NULL,
  max_occurrences INT    NOT NULL,
  window_days     INT    NOT NULL
) ON COMMIT DROP;

INSERT INTO freq_targets (answer_md5, codes, max_occurrences, window_days)
VALUES
  -- (a) new-patient home visit, once per 3 years
  ('429bc2c29b0c90bb5a3c4e8b93bddc6d',
   ARRAY['99341','99342','99344','99345'], 1, 1094),
  -- (b) G0179 home health recert, 60-day cycle
  ('db3aeea433c1049f57ffe3e28e7659ae',
   ARRAY['G0179'], 1, 59),
  -- (c) G0136 not more often than every 6 months
  ('c509086bc70958af741199884ca2e817',
   ARRAY['G0136'], 1, 179),
  -- (d) G0447 IBT obesity, at most weekly in every phase
  ('6fd6eb51e8959a13d264fdb24f6153b6',
   ARRAY['G0447'], 1, 6),
  -- (e) G0473 IBT obesity group, at most weekly in every phase
  ('d487207a59b0abe83030d672d72d1520',
   ARRAY['G0473'], 1, 6),
  -- (f) one clinician per code per date of service (add-ons excluded)
  ('eac6fe1204524bbd3308c21647c99716',
   ARRAY['99347','99348','99349','99350','99424','99426','99490','99491',
         '99495','99496','99497','G0179','G0180','G0181','G0318'], 1, 0);

-- Resolve to concrete live rows, using the definition of "live" that
-- fetchPayerRule uses (effective window contains today, not superseded) —
-- NOT `expiration_date IS NULL`.
CREATE TEMP TABLE freq_rows ON COMMIT DROP AS
SELECT pr.id                AS rule_id,
       pr.code,
       t.max_occurrences,
       t.window_days
  FROM payer_rule pr
  JOIN freq_targets t
    ON md5(pr.value->>'answer') = t.answer_md5
   AND pr.code = ANY (t.codes)
 WHERE pr.attribute      = 'frequency_limit'
   AND pr.effective_date <= CURRENT_DATE
   AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
   AND pr.superseded_by IS NULL;

-- ---------------------------------------------------------------------
-- 3. Journal, then add the two keys. Nothing else in `value` is touched.
--
-- `value->'k' IS NOT NULL` rather than the `?` containment operator: `?`
-- is a bind-parameter placeholder to several client drivers.
-- ---------------------------------------------------------------------
INSERT INTO migration_0070_scorer_fields_journal (rule_id, attribute, prior_value)
SELECT pr.id, pr.attribute, pr.value
  FROM payer_rule pr
  JOIN freq_rows f ON f.rule_id = pr.id
 WHERE pr.value->'maxOccurrences' IS NULL
    OR pr.value->'windowDays'     IS NULL
ON CONFLICT (rule_id) DO NOTHING;

UPDATE payer_rule pr
   SET value = pr.value || jsonb_build_object(
                 'maxOccurrences', f.max_occurrences,
                 'windowDays',     f.window_days)
  FROM freq_rows f
 WHERE pr.id = f.rule_id
   AND (pr.value->'maxOccurrences' IS NULL
        OR pr.value->'windowDays'  IS NULL);

-- ---------------------------------------------------------------------
-- 4. modifier_required — NOT backfilled, on purpose.
--
-- The ask was to populate `required` + `acceptable` on the 154 live
-- modifier_required rules from the modifiers the prose names. Every distinct
-- answer was read (28 of them). The named modifiers are real — GQ/GT/G0/95,
-- GT alone, 25, 76, GP/GO — but NOT ONE of the 28 states an unconditional
-- requirement. Every single one is conditioned on something the scorer
-- cannot see:
--
--   * telehealth modifiers (GQ/GT/G0/95, or GT alone): required only
--     "whenever any of these services is DELIVERED BY TELEHEALTH" (73 rows);
--   * modifier 25: required only when the home-visit E/M is "performed on
--     the same day as a minor procedure" (8 rows);
--   * modifier 76: required only to identify an MDPP "make-up session held
--     on the same day as a regularly scheduled session" (9 rows);
--   * GP/GO: required only when RTM 98979 is "furnished by a PT, OT, or
--     SLP" under a therapy plan of care (3 rows).
--
-- The consuming shape is unconditional:
--   modifierRequired?: { required: boolean; acceptable: string[] }
-- and `DraftLine` (denial-risk.service.ts:29-45) carries no place-of-service,
-- telehealth flag, or same-day-procedure signal to condition on. Writing
-- these fields makes the scorer wrong in a way it is not wrong today:
--
--   * `required: true` demands a telehealth modifier on every IN-PERSON home
--     visit — the overwhelming majority of lines in a home-based palliative
--     practice — at 0.55 weight.
--   * `acceptable: [...]` is worse, and it is a NEW defect rather than an
--     existing one. Today `acceptable` is hardcoded `[]`
--     (predict-superbill.service.ts:127), so the `wrong_modifier` branch is
--     unreachable (denial-risk.service.ts:244-256 requires
--     acceptable.length > 0). Populate it from a telehealth-conditional rule
--     and an in-person home visit correctly billed with modifier 25 starts
--     scoring `wrong_modifier` at 0.55, because 25 is not in the telehealth
--     set. The named set is the set that SATISFIES a conditional
--     requirement; it is not the set of modifiers permitted on the code, and
--     the scorer reads it as the latter.
--
-- So the data is not the whole blocker here and backfilling it alone is not
-- safe. Making these 154 rules enforceable needs, first, a product/eng
-- decision on how a conditional modifier requirement is represented (a
-- delivery-mode input on DraftLine plus a condition on the rule, or separate
-- attributes) — and the files that would carry it are not owned by this
-- change. Deliberately left undone rather than shipped plausible.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 5. Postcondition — prove it worked, or roll the whole thing back.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  n_expected INT;
  n_ok       INT;
  n_leak     INT;
  n_prose    INT;
  n_live     INT;
  n_journal  INT;
BEGIN
  SELECT count(*) INTO n_expected FROM freq_rows;

  -- 5a. The target set must be non-empty. If the extractor ever rewords an
  --     answer, the md5 pins stop matching and this migration would silently
  --     do nothing while reporting success.
  IF n_expected = 0 THEN
    RAISE EXCEPTION
      '0070 matched no rules. The classified answer texts no longer exist verbatim (md5 pins in freq_targets). Re-read the distinct frequency_limit answers and re-classify by hand before re-running.';
  END IF;

  -- 5b. Every targeted row carries BOTH keys, as JSON numbers, with exactly
  --     the classified values.
  SELECT count(*) INTO n_ok
    FROM payer_rule pr
    JOIN freq_rows f ON f.rule_id = pr.id
   WHERE jsonb_typeof(pr.value->'maxOccurrences') = 'number'
     AND jsonb_typeof(pr.value->'windowDays')     = 'number'
     AND (pr.value->>'maxOccurrences')::int = f.max_occurrences
     AND (pr.value->>'windowDays')::int     = f.window_days;

  IF n_ok <> n_expected THEN
    RAISE EXCEPTION
      'Rolling back: % of % targeted frequency_limit rules carry the expected numeric maxOccurrences/windowDays. A targeted row may already hold a conflicting value.',
      n_ok, n_expected;
  END IF;

  -- 5c. Nothing OUTSIDE the target set gained either key. This is what keeps
  --     the nine "frequency limitation permanently removed" answers, the
  --     unpublished-limit answers, and the excluded add-on codes clean.
  SELECT count(*) INTO n_leak
    FROM payer_rule pr
   WHERE pr.attribute      = 'frequency_limit'
     AND pr.effective_date <= CURRENT_DATE
     AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
     AND pr.superseded_by IS NULL
     AND (pr.value->'maxOccurrences' IS NOT NULL
          OR pr.value->'windowDays'  IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM freq_rows f WHERE f.rule_id = pr.id);

  IF n_leak > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % live frequency_limit rule(s) outside the classified set carry maxOccurrences/windowDays.',
      n_leak;
  END IF;

  -- 5d. The citation is untouched: stripping the two added keys must give
  --     back the journaled pre-image byte for byte.
  SELECT count(*) INTO n_prose
    FROM migration_0070_scorer_fields_journal j
    JOIN payer_rule pr ON pr.id = j.rule_id
   WHERE (pr.value - 'maxOccurrences' - 'windowDays') <> j.prior_value;

  IF n_prose > 0 THEN
    RAISE EXCEPTION
      'Rolling back: % rule(s) had content other than the two new keys changed.',
      n_prose;
  END IF;

  SELECT count(*) INTO n_live
    FROM payer_rule
   WHERE attribute      = 'frequency_limit'
     AND effective_date <= CURRENT_DATE
     AND (expiration_date IS NULL OR expiration_date > CURRENT_DATE)
     AND superseded_by IS NULL;
  SELECT count(*) INTO n_journal FROM migration_0070_scorer_fields_journal;

  RAISE NOTICE '0070 structured scorer fields:';
  RAISE NOTICE '  live frequency_limit rules:        %', n_live;
  RAISE NOTICE '  encoded with a cap:                %', n_expected;
  RAISE NOTICE '  left alone (prose states no usable cap, or states a removal): %',
    n_live - n_expected;
  RAISE NOTICE '  pre-images journaled:              %', n_journal;
  RAISE NOTICE '  modifier_required rules encoded:   0 (see section 4)';
  RAISE NOTICE '  NOTE: predict-superbill.service.ts:139 pulls only 90 days of';
  RAISE NOTICE '        patient history, so windows longer than 90 days (the';
  RAISE NOTICE '        3-year new-patient and 6-month G0136 caps) can only fire';
  RAISE NOTICE '        on repeats inside 90 days. Under-fires; never over-fires.';
END $$;

COMMIT;
