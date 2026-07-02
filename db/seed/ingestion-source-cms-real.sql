-- ============================================================================
-- Register the REAL, current CMS ruling PDFs as ingestion sources so the
-- platform extracts coverage/billing rules from genuine CMS documents.
--
-- Points DIRECTLY at cms.gov. The ingest engine now sends a browser User-Agent
-- (document-ingestion.service.ts fetchUrlBytes) so CMS's bot manager serves the
-- server-side fetch — no self-hosting or public/ serving needed. (Earlier a bot
-- UA got 403'd; the browser UA is verified to 200.)
--
-- Prereq: seed the Medicare payer FIRST, or these bind to NULL and extract
-- nothing (extractRulesFromDocument needs both payer_id and state):
--   sudo -u postgres psql pallio -f db/seed/payer-medicare.sql
--
-- These CMS docs are short + rule-dense, within Claude's native-PDF ceiling
-- (< 600 pages / < 32 MB on a 1M-context model). The full Federal Register
-- final rule (~1,000+ pages, > 32 MB) is deliberately NOT used — it exceeds
-- the limit and would extract zero rules.
--
-- Idempotent. Also removes the earlier SELF-HOSTED test rows (which 404'd
-- because the deploy doesn't serve public/ live).
--
-- Apply on the VPS (AFTER payer-medicare.sql):
--   sudo -u postgres psql pallio -f db/seed/ingestion-source-cms-real.sql
-- Then fire the cron once (extracts):
--   curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.pallio.io/api/cron/ingest-documents
-- Verify sources ran clean + rules landed:
--   sudo -u postgres psql pallio -c "SELECT name,last_check_at,last_ingested_at,last_error FROM ingestion_source WHERE document_type IN ('cms_pfs','mln_article') AND url LIKE '%cms.gov%';"
--   sudo -u postgres psql pallio -c "SELECT code,attribute,coverage_status,confidence FROM payer_rule WHERE created_by LIKE 'crawler:%' AND expiration_date IS NULL ORDER BY code LIMIT 50;"
-- ============================================================================

-- Drop the earlier self-hosted test rows (404'd; NULL payer). Safe: test data.
DELETE FROM ingestion_source WHERE url LIKE '%/test-fixtures/cms/%';

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
    'https://www.cms.gov/files/document/mm14315-medicare-physician-fee-schedule-final-rule-summary-cy-2026.pdf',
    (SELECT id FROM medicare), 'OH', 'cms_pfs', 'monthly',
    'REAL CMS final-rule summary (MM14315). New CY2026 codes: G0552-G0554, G2211, home visits 99347-99350.'
  ),
  (
    'CMS — Telehealth & Remote Patient Monitoring (MLN901705)',
    'https://www.cms.gov/files/document/mln901705-telehealth-remote-patient-monitoring.pdf',
    (SELECT id FROM medicare), 'OH', 'mln_article', 'monthly',
    'REAL CMS MLN901705. Telehealth (G0320-G0322), RPM/RTM (99457/99458, 98980/98981).'
  ),
  (
    'CMS — Evaluation & Management Services (MLN006764)',
    'https://www.cms.gov/files/document/mln006764-evaluation-management-services.pdf',
    (SELECT id FROM medicare), 'OH', 'mln_article', 'monthly',
    'REAL CMS MLN006764. Home-visit E/M (99341-99350), nursing-facility E/M, prolonged services.'
  ),
  (
    'CMS — Advance Care Planning (MLN909289)',
    'https://www.cms.gov/files/document/mln-advanced-care-planning.pdf',
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

-- Confirm what we registered (payer must be Medicare, NOT blank).
SELECT s.name, p.name AS payer, s.state, s.document_type, s.active
  FROM ingestion_source s
  LEFT JOIN payer p ON p.id = s.payer_id
 WHERE s.url LIKE '%cms.gov%' AND s.document_type IN ('cms_pfs', 'mln_article')
 ORDER BY s.name;
