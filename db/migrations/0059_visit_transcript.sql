-- 0059 — encounter transcript on the visit.
--
-- Client walkthrough [00:09–00:30]: "is mein note nahi bante… transcript bhi
-- aati hai, par note nahi… woh record karne par karega; recording ho rahi hai,
-- is ke baad screen par aayega." The nurse records the encounter, the
-- transcript appears, and the clinical note is drafted from it.
--
-- The transcript is PHI of the most sensitive kind (a verbatim record of a
-- palliative-care conversation). It lives on the visit row inside the tenant
-- boundary, is covered by the existing patient/visit RLS, and is read through
-- the PHI access log like any other clinical content.

ALTER TABLE visit
  ADD COLUMN IF NOT EXISTS transcript TEXT,
  ADD COLUMN IF NOT EXISTS transcript_updated_at TIMESTAMPTZ,
  -- Which engine produced it — matters for provenance and for proving where
  -- PHI was (or wasn't) sent.
  ADD COLUMN IF NOT EXISTS transcript_engine TEXT;

COMMENT ON COLUMN visit.transcript IS
  'Verbatim encounter transcript (PHI). Produced by the configured transcription engine; drafts the clinical note.';
COMMENT ON COLUMN visit.transcript_engine IS
  'Engine that produced the transcript (e.g. self_hosted:whisper). Provenance for PHI-disclosure review.';
