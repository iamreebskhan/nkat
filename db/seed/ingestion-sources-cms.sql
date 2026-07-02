-- ============================================================================
-- Seed: real, public CMS ingestion sources (closes Phase-feeder task #19).
--
-- These are genuine, stable, public-domain U.S. Government works (CMS).
-- The document-ingestion engine (POST /api/cron/ingest-documents, or the
-- "Run now" button on /admin/ingestion-sources) fetches each URL, hashes
-- it, extracts coverage rules via Claude, and writes payer_rule rows —
-- proving Source 1 (CMS) end-to-end with no AMA-licensed content (CMS
-- coverage text is a government work; only verbatim CPT descriptors are
-- AMA-gated, and those are never stored from these pages).
--
-- Idempotent: ON CONFLICT (url) DO NOTHING. Safe to re-run / ship on every
-- deploy. New rows have last_check_at NULL so the cron treats them as due
-- on its next tick (or use the admin "Run now" button immediately).
--
-- Apply:
--   sudo -u postgres psql pallio -f db/seed/ingestion-sources-cms.sql
-- Then fire once and verify:
--   curl -X POST -H "x-cron-secret: $CRON_SECRET" \
--        https://app.pallio.io/api/cron/ingest-documents
--   sudo -u postgres psql pallio -c \
--     "SELECT name,last_check_at,last_ingested_at,last_error FROM ingestion_source;"
--   sudo -u postgres psql pallio -c \
--     "SELECT COUNT(*) FROM payer_rule WHERE created_by IN ('cms','crawler');"
-- ============================================================================

-- Resolve the Medicare payer once (NULL is legal — these lists are
-- national / all-payer reference, so a missing Medicare row won't block).
WITH medicare AS (
  SELECT id FROM payer
   WHERE name ILIKE '%medicare%'
   ORDER BY (payer_type = 'medicare_mac') DESC, created_at ASC
   LIMIT 1
)
INSERT INTO ingestion_source (name, url, payer_id, state, document_type, schedule_cadence, notes)
VALUES
  -- Medicare Telehealth Services list — directly addresses Mark's
  -- "telehealth codes vary by payer" pain point. CMS updates ~annually.
  (
    'CMS — Medicare Telehealth Services list',
    'https://www.cms.gov/medicare/coverage/telehealth/list-services',
    (SELECT id FROM medicare),
    NULL,
    'cms_coverage_api',
    'monthly',
    'Seed #19: national telehealth-eligible code list. Public-domain CMS government work.'
  )
ON CONFLICT (url) DO NOTHING;

-- The old "Medicare Coverage Database (LCD/NCD index)" URL now 404s (CMS moved
-- the page), so it errored every cron run. Retire it — deactivate any existing
-- row (idempotent; the INSERT above no longer seeds it).
UPDATE ingestion_source
   SET active = FALSE, last_error = 'retired: URL 404s (CMS moved the page)', updated_at = now()
 WHERE url = 'https://www.cms.gov/medicare/coverage/medicare-coverage-database';
