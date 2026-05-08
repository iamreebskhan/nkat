-- ============================================================================
-- 0018_phase22_idempotency.sql
-- Phase 22 — Stripe-style `Idempotency-Key` support for retry-tolerant
-- write endpoints. Storage rules:
--
--   - Key uniqueness is per (org_id, key). Same key from a different
--     tenant is its own row. Required because keys are caller-chosen
--     and we cannot trust them to be globally unique.
--
--   - `request_hash` is SHA-256 of canonical (method, path, body). On
--     replay with the same key but DIFFERENT body, we return 422
--     `IDEMPOTENCY_KEY_REUSED` — that's the Stripe contract.
--
--   - Cached responses are kept for 24h. Past expiry, the row is
--     reclaimed by the cleanup cron + the same key may be re-used.
--
--   - We persist `response_body` as JSONB. Endpoints whose responses
--     contain PHI MUST NOT use idempotency caching — the
--     `@Idempotent()` decorator is opt-in per route.
-- ============================================================================

CREATE TABLE idempotency_record (
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash CHAR(64) NOT NULL,

  response_status SMALLINT NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),

  PRIMARY KEY (org_id, key)
);

CREATE INDEX idempotency_record_expires_idx ON idempotency_record (expires_at);

SELECT app.apply_tenant_rls('idempotency_record');
