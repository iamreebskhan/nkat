-- ============================================================================
-- 0019_phase24_synthesis_cache.sql
-- Phase 24 — content-addressed cache for `POST /v1/synthesis`. Distinct
-- from `idempotency_record` (which is per-(org_id, client-supplied key));
-- this cache is per-(org_id, input-hash) and saves Bedrock spend on
-- re-runs of the SAME findings + audience that don't carry an
-- Idempotency-Key.
--
--   - Per-org scope. Findings carry citation strings + carc_class;
--     sharing across orgs is unsafe because findings can leak tenant
--     context. Per-org keeps the boundary tight.
--
--   - 7-day TTL. The provider's source data (rules, payer policies)
--     doesn't change minute-to-minute; a week of caching is fine, and
--     anything older than that should re-render to pick up rule churn.
--
--   - `result` JSONB stores the FULL `SynthesisResult` so a hit replays
--     identically — same narrative, citations, severity_summary,
--     min_confidence, hallucination_risk flag.
-- ============================================================================

CREATE TABLE synthesis_cache (
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,

  -- SHA-256 of canonical (provider + model_id + findings + audience).
  content_hash CHAR(64) NOT NULL,

  -- The cached SynthesisResult.
  result JSONB NOT NULL,

  -- Tracking only — provider name is also embedded in `result.provider`
  -- but we keep a flat column for `WHERE provider = 'bedrock'` admin
  -- metrics queries.
  provider TEXT NOT NULL,

  hit_count INT NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),

  PRIMARY KEY (org_id, content_hash)
);

CREATE INDEX synthesis_cache_expires_idx ON synthesis_cache (expires_at);
CREATE INDEX synthesis_cache_provider_idx ON synthesis_cache (provider);

SELECT app.apply_tenant_rls('synthesis_cache');
