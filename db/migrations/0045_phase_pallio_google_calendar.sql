-- ============================================================================
-- 0045 — Google Calendar two-way sync per clinician (Phase E).
--
-- Per Mark's 2026-05-22 answer: nurses live in Google Calendar AND in
-- Pallio; we sync both ways and check Google for conflicts on Pallio
-- schedule POSTs.
--
-- One row per (org, user). Stores the OAuth refresh-token + last-sync
-- watermark. Encryption-at-rest is via pgcrypto pgp_sym_encrypt (key
-- in env PALLIO_TOKEN_KEY) — service layer wraps the read/write.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clinician_calendar_link (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id                 UUID         NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider                TEXT         NOT NULL DEFAULT 'google'
                          CHECK (provider IN ('google')),
  /* OAuth refresh token, encrypted at rest via pgp_sym_encrypt. */
  refresh_token_encrypted BYTEA        NOT NULL,
  /* Granted scopes — defensive check in the service layer before any read. */
  scopes                  TEXT[]       NOT NULL DEFAULT '{}',
  /* External calendar id we're syncing to/from (usually 'primary'). */
  external_calendar_id    TEXT         NOT NULL DEFAULT 'primary',
  /* Watermark for incremental pull. Empty string on first sync. */
  sync_token              TEXT         NOT NULL DEFAULT '',
  /* When we last pulled events from Google. */
  last_pull_at            TIMESTAMPTZ,
  /* When we last pushed Pallio events out. */
  last_push_at            TIMESTAMPTZ,
  /* Connection status: 'connected' | 'expired' (refresh failed) | 'revoked'. */
  status                  TEXT         NOT NULL DEFAULT 'connected'
                          CHECK (status IN ('connected','expired','revoked')),
  last_error              TEXT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS clinician_calendar_link_status_idx
  ON clinician_calendar_link (status)
  WHERE status != 'connected';

SELECT app.apply_tenant_rls('clinician_calendar_link');

-- ----------------------------------------------------------------------------
-- visit_external_event: maps a Pallio visit ↔ Google event id so the
-- two-way sync can dedupe (avoid re-creating an event we already
-- pushed, and avoid re-creating a Pallio visit when we pull an event
-- we already mirrored).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visit_external_event (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  visit_id                UUID         REFERENCES visit(id) ON DELETE CASCADE,
  provider                TEXT         NOT NULL DEFAULT 'google',
  external_event_id       TEXT         NOT NULL,
  /* 'pallio_origin' = Pallio created the visit and pushed; 'external_origin'
     = Google had the event first and Pallio pulled it. Matters for conflict
     resolution. */
  direction               TEXT         NOT NULL CHECK (direction IN ('pallio_origin','external_origin')),
  last_seen_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS visit_external_event_visit_idx
  ON visit_external_event (visit_id);

SELECT app.apply_tenant_rls('visit_external_event');
