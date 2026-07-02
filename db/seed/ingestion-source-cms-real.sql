-- ============================================================================
-- Register the REAL, current CMS ruling PDFs as ingestion sources so the
-- platform extracts coverage/billing rules from genuine CMS documents.
--
-- IMPORTANT — these point at SELF-HOSTED copies, not cms.gov:
--   CMS's bot manager 403s the ingest cron's server-side fetch (UA
--   "Pallio-ingest/1.0"). So we fetch the PDFs with a browser UA and serve
--   them from the app itself. Prereq (run FIRST, on the VPS):
--     node scripts/fetch-cms-real-pdfs.mjs
--   → writes public/test-fixtures/cms/*.pdf, served at
--     https://app.pallio.io/test-fixtures/cms/<file>.pdf
--   (rebuild/restart if your Next build doesn't serve public/ live).
--
-- Bound to Medicare + OH so extractRulesFromDocument persists payer_rule rows
-- (it only writes rules when BOTH payer_id and state are set).
--
-- These are genuine U.S. Government works (CMS MLN / final-rule summary),
-- small enough to extract natively (< 600 pages / < 32 MB — Claude's native
-- PDF ceiling on a 1M-context model). The full Federal Register final rule
-- (~1,000+ pages, > 32 MB) is deliberately NOT used: it exceeds the native
-- PDF limits and would extract zero rules.
--
-- Idempotent: ON CONFLICT (url) DO UPDATE re-points metadata AND resets fetch
-- bookkeeping so the next cron tick re-fetches + re-extracts.
--
-- Apply on the VPS (after the downloader):
--   sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql
-- Then fire the cron once (extracts):
--   curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.pallio.io/api/cron/ingest-documents
-- Verify the sources ran clean + rules landed:
--   sudo -u postgres psql pallio -c "SELECT name,last_check_at,last_ingested_at,last_error FROM ingestion_source WHERE url LIKE '%/test-fixtures/cms/%';"
--   sudo -u postgres psql pallio -c "SELECT code,attribute,coverage_status,confidence FROM payer_rule WHERE created_by LIKE 'crawler:%' AND expiration_date IS NULL ORDER BY code LIMIT 50;"
-- ============================================================================

WITH medicare AS (
  SELECT id FROM payer
   WHERE name ILIKE '%medicare%'
   ORDER BY (payer_type = 'medicare_mac') DESC, created_at ASC
   LIMIT 1
)
INSERT INTO ingestion_source (name, url, payer_id, state, document_type, schedule_cadence, notes)
VALUES
  (
    'CMS — CY2026 Physician Fee Schedule Final Rule Summary (CMS-1832-F)',
    'https://app.pallio.io/test-fixtures/cms/mm14315-pfs-final-rule-summary-cy2026.pdf',
    (SELECT id FROM medicare), 'OH', 'cms_pfs', 'monthly',
    'REAL CMS final-rule summary (MM14315). Self-hosted copy — CMS bot-blocks server fetches. New CY2026 codes: G0552-G0554, G2211, home visits 99347-99350.'
  ),
  (
    'CMS — Telehealth & Remote Patient Monitoring (MLN901705)',
    'https://app.pallio.io/test-fixtures/cms/mln901705-telehealth-rpm.pdf',
    (SELECT id FROM medicare), 'OH', 'mln_article', 'monthly',
    'REAL CMS MLN901705. Telehealth (G0320-G0322), RPM/RTM (99457/99458, 98980/98981), audio-video parity.'
  ),
  (
    'CMS — Evaluation & Management Services (MLN006764)',
    'https://app.pallio.io/test-fixtures/cms/mln006764-evaluation-management.pdf',
    (SELECT id FROM medicare), 'OH', 'mln_article', 'monthly',
    'REAL CMS MLN006764. Home-visit E/M (99341-99350), nursing-facility E/M (99304-99318), prolonged services.'
  ),
  (
    'CMS — Advance Care Planning (MLN909289)',
    'https://app.pallio.io/test-fixtures/cms/mln909289-advance-care-planning.pdf',
    (SELECT id FROM medicare), 'OH', 'mln_article', 'monthly',
    'REAL CMS MLN909289. Advance care planning (99497/99498), documentation requirements.'
  )
ON CONFLICT (url) DO UPDATE SET
  name              = EXCLUDED.name,
  payer_id          = EXCLUDED.payer_id,
  state             = EXCLUDED.state,
  document_type     = EXCLUDED.document_type,
  schedule_cadence  = EXCLUDED.schedule_cadence,
  notes             = EXCLUDED.notes,
  last_content_hash = NULL,
  last_check_at     = NULL,
  last_error        = NULL,
  active            = TRUE,
  updated_at        = now();

-- Confirm what we registered (and that Medicare resolved).
SELECT s.name, p.name AS payer, s.state, s.document_type, s.active
  FROM ingestion_source s
  LEFT JOIN payer p ON p.id = s.payer_id
 WHERE s.url LIKE '%/test-fixtures/cms/%'
 ORDER BY s.name;
