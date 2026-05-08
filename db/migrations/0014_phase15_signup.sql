-- ============================================================================
-- 0014_phase15_signup.sql
-- Phase 15 — self-serve onboarding via Stripe Checkout. Captures the
-- signup attempt so we can: (a) audit cohort drop-off, (b) re-link a
-- delayed Checkout completion to the right org, (c) clean up orphaned
-- orgs whose Checkout was abandoned.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- signup_attempt — append-only audit log of signup starts. The actual
-- `org` row is created at the same moment the Checkout session is
-- generated; this row links them for forensics.
--
-- NOT RLS-scoped — admin-only read path. The data is non-PHI (company
-- name, contact email, tier choice). Cross-tenant scan is intentional
-- for cohort analysis.
-- ---------------------------------------------------------------------------
CREATE TABLE signup_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linked org. NOT NULL — we always create the org synchronously at
  -- start time so the Checkout success_url can deep-link the customer
  -- into their tenant.
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,

  -- Inputs the prospective customer supplied.
  company_name TEXT NOT NULL,
  admin_email CITEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('solo','team','org')),
  quantity INT NOT NULL CHECK (quantity > 0),
  states TEXT[] NOT NULL DEFAULT '{}'::text[],
  specialty_packs TEXT[] NOT NULL DEFAULT '{}'::text[],
  trial_days INT NOT NULL DEFAULT 0,

  -- Stripe Checkout linkage.
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,

  -- Lifecycle.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','abandoned','expired')),

  -- IP + user-agent of the request — supports rate-limit + abuse
  -- triage. Truncated to 64 chars to bound storage.
  source_ip INET,
  source_user_agent TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- Stripe Checkout sessions expire 24h after creation per Stripe defaults.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX signup_attempt_org_idx ON signup_attempt (org_id);
CREATE INDEX signup_attempt_pending_idx ON signup_attempt (created_at) WHERE status = 'pending';
CREATE INDEX signup_attempt_email_idx ON signup_attempt (admin_email);
