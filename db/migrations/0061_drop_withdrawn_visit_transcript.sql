-- 0061 — drop the withdrawn encounter-transcript columns.
--
-- A short-lived 0059 added visit.transcript / transcript_updated_at /
-- transcript_engine for a record-the-visit feature that turned out not to be
-- part of Pallio. The feature was withdrawn and 0059 deleted, but deleting a
-- migration file doesn't un-apply it: any database that ran 0059 still carries
-- the columns.
--
-- The runbook's rule is "roll forward, never DROP to undo" — that rule exists to
-- protect data the application produced. It doesn't apply here: the columns were
-- only ever writable through a transcription engine that no deployment ever
-- configured, so they are NULL everywhere. Leaving them would mean carrying
-- PHI-shaped columns that nothing reads, writes, or audits.
--
-- IF EXISTS throughout: on any database that never saw 0059 this is a no-op.

ALTER TABLE visit
  DROP COLUMN IF EXISTS transcript,
  DROP COLUMN IF EXISTS transcript_updated_at,
  DROP COLUMN IF EXISTS transcript_engine;
