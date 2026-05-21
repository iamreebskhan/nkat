-- ============================================================================
-- 0038 — Operator-managed ingestion source registry.
--
-- The document-ingestion engine (lib/features/ingestion/document-
-- ingestion.service.ts) absorbs the same input shape regardless of
-- where it originated — CMS Final Rule, NCD/LCD, commercial payer
-- policy, state Medicaid manual. The DIFFERENCE between Source 1 and
-- Source 2 of the vision is purely *which URL* the operator points
-- at and *how often* it's re-checked. That config lives here.
--
-- The cron job (POST /api/cron/ingest-documents) walks active rows
-- and re-ingests any whose content_hash has changed since last_hash.
-- ============================================================================

CREATE TABLE ingestion_source (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable label for ops dashboards.
  name                  TEXT        NOT NULL,
  -- The URL to fetch (HTML or PDF). May be a CMS page or a payer's
  -- public policy library URL.
  url                   TEXT        NOT NULL UNIQUE,
  -- Optional binding to a payer; CMS-wide sources leave this NULL.
  payer_id              UUID        REFERENCES payer(id),
  -- Optional state restriction (LCDs are state-scoped, NCDs aren't).
  state                 CHAR(2)     REFERENCES state(state),
  -- Mirrors source_document.document_type so the ingestion engine
  -- picks the right confidence band.
  document_type         TEXT        NOT NULL CHECK (document_type IN (
                          'medical_policy', 'reimbursement_policy', 'provider_manual',
                          'mln_article', 'ncd', 'lcd', 'lcd_article', 'cms_pfs',
                          'cms_coverage_api', 'hcpcs_release', 'ncci_release',
                          'state_medicaid_manual', 'wc_fee_schedule', 'ihs_rate'
                        )),
  -- 'daily' | 'weekly' | 'monthly' — the cron checks all sources
  -- whose `last_check_at` is older than this cadence.
  schedule_cadence      TEXT        NOT NULL DEFAULT 'weekly'
                                    CHECK (schedule_cadence IN ('daily', 'weekly', 'monthly')),
  -- Hash of the most recently observed content; cron compares the
  -- fresh fetch and only re-ingests on change.
  last_content_hash     TEXT,
  last_check_at         TIMESTAMPTZ,
  last_ingested_at      TIMESTAMPTZ,
  last_error            TEXT,
  active                BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_source_due_idx
  ON ingestion_source (last_check_at NULLS FIRST)
  WHERE active = TRUE;

COMMENT ON TABLE ingestion_source IS
  'Operator-curated registry of URLs the corpus ingester re-checks on a cadence. Sources 1 (CMS) and 2 (commercial payer policies) of pallio_complete_vision_v3 §10.';
