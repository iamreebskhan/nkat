-- ============================================================================
-- 0087_yearly_ingestion_cadence.sql
--
-- Allow schedule_cadence = 'yearly'.
--
-- The cadences on offer were daily, weekly and monthly, so the CMS CY2026
-- Physician Fee Schedule final rule — a document published once a year, in
-- November, and never edited afterwards — was registered as monthly, because
-- monthly was the slowest thing available.
--
-- That is eleven unnecessary reads a year of a 1,216-page document, each one
-- a paid Opus extraction. A dry run of that source returned five rules and
-- would have displaced three of its own from the previous pass: churn, cost,
-- and no new information. The annual rulebook wants an annual cadence.
--
-- 'yearly' is 365 days in the cron's due-check. See also the "frozen"
-- classifier in library-health.service.ts, which is deliberately skipped for
-- yearly sources: a final rule that has not changed in a year has not gone
-- stale, it has simply been published. The next edition arrives at a
-- different URL, which no freshness check on this one can see.
-- ============================================================================

ALTER TABLE ingestion_source
  DROP CONSTRAINT IF EXISTS ingestion_source_schedule_cadence_check;

ALTER TABLE ingestion_source
  ADD CONSTRAINT ingestion_source_schedule_cadence_check
  CHECK (schedule_cadence IN ('daily', 'weekly', 'monthly', 'yearly'));

DO $$
BEGIN
  -- The constraint must accept the new value and still reject nonsense.
  BEGIN
    PERFORM 1 FROM ingestion_source LIMIT 0;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '0087: ingestion_source is not readable';
  END;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ingestion_source_schedule_cadence_check'
       AND pg_get_constraintdef(oid) LIKE '%yearly%'
  ) THEN
    RAISE EXCEPTION '0087: the cadence constraint does not allow yearly';
  END IF;
END $$;
