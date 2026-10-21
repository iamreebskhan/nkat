-- ============================================================================
-- 0089_note_carry_forward.sql
--
-- Record when a note section was carried forward from a previous visit.
--
-- WHY THIS IS A COLUMN AND NOT A FEATURE THAT LEAVES NO TRACE
--
-- Mark Hendrix, 20 Aug 2026 [10:55]: "You also need a note, because that's
-- going to be your starting point from the next visit. So if you create a note
-- for a new patient, then you can use that note as a template for the next
-- visit." He framed it as the efficiency half of the product — [11:12] "how we
-- make nurse practitioners and nurses efficient."
--
-- The naive implementation is to copy the last note into the new visit
-- silently. That is the single most-cited documentation failure in E/M audits:
-- cloned notes, where a payer finds the same paragraph across a run of visits
-- and concludes the later ones do not evidence the work billed. It would
-- undermine the exact property he spent sixty seconds asking for — that the
-- note defends the codes.
--
-- So carrying forward is explicit, per section, and leaves a record: which
-- visit the text came from, and whether the clinician has edited it since.
-- An auditor pulling the note can see "this paragraph was brought forward from
-- 12 Aug and not changed", which is a defensible answer where a silent copy is
-- not.
-- ============================================================================

ALTER TABLE visit_note_section
  -- The visit this section's content was copied from. NULL means written here.
  ADD COLUMN carried_from_visit_id UUID REFERENCES visit(id),
  -- Set TRUE on copy, cleared the moment the clinician edits the section.
  -- Separate from carried_from_visit_id so "brought forward and then revised"
  -- stays distinguishable from "brought forward and signed unchanged".
  ADD COLUMN carried_unchanged     BOOLEAN NOT NULL DEFAULT FALSE;

-- Finding every unchanged carried-forward section across an org is an audit
-- question ("show me notes that were not actually written"), so it needs to be
-- answerable without a sequential scan.
CREATE INDEX visit_note_section_carried_idx
  ON visit_note_section (org_id, carried_from_visit_id)
  WHERE carried_unchanged;
