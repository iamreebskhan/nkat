-- ============================================================================
-- Retire the 4 short CMS documents (final-rule summary + 3 MLN articles).
--
-- The complete CY2026 final rule is now seeded from the Federal Register
-- (db/seed/payer-rules-cy2026-full-rule.sql — 563 rules incl. everything the
-- short docs covered: ACP 99497/99498, home visits, telehealth, RPM, G2211,
-- G0552-G0554, ...). The short docs are redundant, so:
--
--   1. DELETE their ingestion_source rows (the cron never re-ingests them).
--   2. EXPIRE any of their payer_rule rows still active (expire rather than
--      delete: org_rulebook_row.source_payer_rule_id holds FKs to them;
--      expired rows drop out of every lookup/comparison but keep provenance).
--      GREATEST() keeps expiration >= effective (migration 0053).
--
-- Idempotent; safe to re-run.
-- Apply:
--   sudo -u postgres psql pallio -f db/seed/retire-cms-short-docs.sql
-- ============================================================================

BEGIN;

-- The 4 short docs (plus the temporary self-hosted copies from testing).
-- (ON COMMIT DROP requires the surrounding transaction — without BEGIN the
-- temp table would drop at the implicit commit of the CREATE itself.)
CREATE TEMP TABLE _retired_urls (url TEXT) ON COMMIT DROP;
INSERT INTO _retired_urls (url) VALUES
  ('https://www.cms.gov/files/document/mm14315-medicare-physician-fee-schedule-final-rule-summary-cy-2026.pdf'),
  ('https://www.cms.gov/files/document/mln901705-telehealth-remote-patient-monitoring.pdf'),
  ('https://www.cms.gov/files/document/mln006764-evaluation-management-services.pdf'),
  ('https://www.cms.gov/files/document/mln-advanced-care-planning.pdf');

-- 1. Remove the ingestion sources (exact URLs + the old self-hosted test rows).
DELETE FROM ingestion_source
 WHERE url IN (SELECT url FROM _retired_urls)
    OR url LIKE '%/test-fixtures/cms/%';

-- 2. Expire every still-active rule extracted from those documents.
UPDATE payer_rule pr
   SET expiration_date = GREATEST(CURRENT_DATE, pr.effective_date)
 WHERE pr.expiration_date IS NULL
   AND pr.source_doc_id IN (
     SELECT id FROM source_document
      WHERE url IN (SELECT url FROM _retired_urls)
         OR url LIKE '%/test-fixtures/cms/%'
   );

COMMIT;

-- Verify: no active rules remain from the short docs; the full rule stands.
SELECT 'short-doc active rules remaining' AS check, count(*) AS n
  FROM payer_rule pr
  JOIN source_document sd ON sd.id = pr.source_doc_id
 WHERE pr.expiration_date IS NULL
   AND (sd.url LIKE 'https://www.cms.gov/files/document/%' OR sd.url LIKE '%/test-fixtures/cms/%')
UNION ALL
SELECT 'full-rule active rules', count(*)
  FROM payer_rule
 WHERE source_doc_id = 'b0000000-0000-4000-8000-000000002026'::uuid
   AND expiration_date IS NULL;
