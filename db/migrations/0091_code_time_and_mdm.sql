-- ============================================================================
-- 0091_code_time_and_mdm.sql
--
-- Give the code table the two things E/M selection actually turns on, as data
-- rather than as prose inside a label.
--
-- THE PROBLEM THIS CLOSES
--
-- The home-visit time ladder was written down in four places:
--
--   db/seed/0007_palliative_codes.sql  short_descriptor '…low MDM/15min'
--   lib/ai/anthropic.client.ts:156     parser prompt, 15/30/60/75 · 20/30/40/60
--   lib/ai/__tests__/gold-standard.fixtures.ts   the eval's asserted answers
--   lib/features/visits/cpt-suggester.ts         hardcoded threshold bands
--
-- The first three agree. The fourth — the one that actually decides which code
-- a clinician bills — did not: it fired 99345 at 60 minutes where every other
-- source says 75, and seven of its eight bands were low by 5 to 20 minutes.
-- Every deviation was in the same direction: a higher-paying code at less
-- documented time.
--
-- It could not read the right number because the number was not stored as one.
-- `code.short_descriptor` is TEXT, its own schema comment says "our wording,
-- not AMA verbatim", and the minutes were inside the string. Parsing a figure
-- out of a field the schema flags as a paraphrase would have produced something
-- that looked sourced while being just as unverified.
--
-- So: two real columns, populated from the same values the other three sources
-- already agree on, and the suggester reads them instead of holding its own copy.
--
-- mdm_level is added at the same time because it is the OTHER axis these codes
-- are selected on, and the AI prompt already records it ("low/low/mod/high")
-- while the suggester ignores it entirely. Storing it does not switch anything
-- on — it makes the second axis available for the decision the client still
-- has to make about whether Pallio should offer MDM-based selection at all.
-- ============================================================================

ALTER TABLE code
  -- CPT's stated time for this code. NULL for codes where time is not a
  -- selection criterion at all (most HCPCS supply and DME codes).
  ADD COLUMN typical_minutes INT
    CHECK (typical_minutes IS NULL OR (typical_minutes > 0 AND typical_minutes <= 600)),

  -- Medical Decision Making level, where the code descriptor states one.
  -- 'straightforward' is CPT's own term for the lowest tier; the home-visit
  -- ladder only uses low/moderate/high.
  ADD COLUMN mdm_level TEXT
    CHECK (mdm_level IS NULL OR mdm_level IN
      ('straightforward', 'low', 'moderate', 'high'));

COMMENT ON COLUMN code.typical_minutes IS
  'CPT stated time in minutes. The threshold the time-based code suggester reads — never re-derive it from short_descriptor, which is our own wording.';

COMMENT ON COLUMN code.mdm_level IS
  'Medical Decision Making level from the code descriptor. Stored for the second E/M selection axis; not yet used for suggestion.';
