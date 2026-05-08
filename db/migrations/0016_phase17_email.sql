-- ============================================================================
-- 0016_phase17_email.sql
-- Phase 17 — outbound email scaffolding. We track:
--   email_send       — append-only audit of every transactional message we
--                      attempted to send (success + failure). PHI-free body
--                      content; only template name + recipient + status.
--   email_suppression — bounce/complaint list. Honors AWS SES feedback
--                      reports plus manual unsubscribe + the customer's
--                      explicit "stop sending" request.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- email_send — outbound message audit. RLS-scoped to `org_id` because the
-- recipient address often belongs to a tenant's user; cross-tenant scan
-- should require admin connection.
-- ---------------------------------------------------------------------------
CREATE TABLE email_send (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES org(id) ON DELETE CASCADE,

  -- The template that produced this message. Closed enum at the app
  -- layer (see backend/src/email/email-templates.ts); we don't pin the
  -- enum in SQL to avoid ALTER TABLE on every new template.
  template TEXT NOT NULL,

  -- Recipient. Lowercased on insert. Case-insensitive email comparison
  -- elsewhere uses CITEXT; here we store as plain TEXT after explicit
  -- normalization to keep this surface free of CITEXT side effects.
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('queued','sent','suppressed','failed')),

  -- Provider-specific message id (SES MessageId). Null on suppressed/queued/failed.
  provider_message_id TEXT,

  error_class TEXT,                 -- e.g. 'AccessDenied', 'SuppressionList'
  error_detail TEXT,                 -- truncated to 1024 chars

  -- Idempotency key for the caller (e.g. invite_token id) — prevents
  -- double-send when retries collide. UNIQUE means a re-attempt with the
  -- same idempotency key is a no-op.
  idempotency_key TEXT UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX email_send_org_idx ON email_send (org_id, created_at DESC);
CREATE INDEX email_send_recipient_idx ON email_send (recipient, created_at DESC);
CREATE INDEX email_send_status_idx ON email_send (status, created_at) WHERE status IN ('queued','failed');

SELECT app.apply_tenant_rls('email_send');

-- ---------------------------------------------------------------------------
-- email_suppression — bounces, complaints, and explicit opt-outs. Global
-- (cross-tenant) on purpose: a complaint to one tenant's outbound mail
-- means we MUST stop sending to that address from any tenant. That's
-- AWS SES policy; ignoring it tanks our sender reputation across the
-- whole platform.
-- ---------------------------------------------------------------------------
CREATE TABLE email_suppression (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('bounce_permanent','bounce_transient','complaint','manual_optout','admin_block')),
  source TEXT NOT NULL CHECK (source IN ('ses_feedback','manual','admin_api')),
  detail TEXT,
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For transient bounces we may auto-clear after a window; permanent
  -- + complaints are forever (manually clearable via break-glass only).
  expires_at TIMESTAMPTZ
);

CREATE INDEX email_suppression_expires_idx ON email_suppression (expires_at) WHERE expires_at IS NOT NULL;
