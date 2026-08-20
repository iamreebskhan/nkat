-- ===========================================================================
-- 0083 — Put back the rule counts that unchanged-document runs erased.
--
-- The cron overwrote ingestion_source.last_rule_count with 0 on every pass,
-- including passes where nothing was extracted because the document had not
-- changed. The health view reads that column, so 22 of 27 sources were
-- classified "no_rules" and shown to the operator as
--
--   "Last extraction produced no rules — the document may have been
--    restructured"
--
-- about documents that were never opened. The code half is fixed alongside
-- this; the column still holds the zeros that were already written, and every
-- one of them is a false accusation sitting on a dashboard.
--
-- HOW THE TRUE COUNT IS RECOVERED, rather than guessed: a source that really
-- did extract left its rules behind, and every one of them points at a
-- source_document with that source's URL. Counting them is a measurement, not
-- an estimate. A source with no such rules keeps 0, because for that one the
-- 0 is the truth.
--
-- Counts LIVE rules only. A source whose rules have all since been expired or
-- superseded is genuinely producing nothing today, and should keep saying so.
-- ===========================================================================

BEGIN;

CREATE TEMP TABLE _true_counts ON COMMIT DROP AS
SELECT s.id AS source_id,
       count(pr.id)::int AS live_rules
  FROM ingestion_source s
  JOIN source_document sd ON sd.url = s.url
  LEFT JOIN payer_rule pr
         ON pr.source_doc_id = sd.id
        AND pr.expiration_date IS NULL
 GROUP BY s.id;

UPDATE ingestion_source s
   SET last_rule_count = t.live_rules,
       updated_at = now()
  FROM _true_counts t
 WHERE t.source_id = s.id
   AND t.live_rules > 0
   AND COALESCE(s.last_rule_count, 0) = 0;   -- only correct the false zeros

DO $$
DECLARE
  repaired INT;
  still_zero INT;
BEGIN
  SELECT count(*) INTO repaired
    FROM ingestion_source s JOIN _true_counts t ON t.source_id = s.id
   WHERE t.live_rules > 0 AND s.last_rule_count = t.live_rules;

  SELECT count(*) INTO still_zero
    FROM ingestion_source WHERE COALESCE(last_rule_count, 0) = 0 AND last_check_at IS NOT NULL;

  RAISE NOTICE 'sources with a recovered rule count: %', repaired;
  RAISE NOTICE 'sources still reporting 0 (no live rules trace to them — genuinely nothing): %',
    still_zero;
END $$;

COMMIT;
