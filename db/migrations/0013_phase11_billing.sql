-- ============================================================================
-- 0013_phase11_billing.sql
-- Phase 11 — Stripe-backed billing: per-tenant subscription, plus an
-- append-only billing_event log of webhook-derived state changes for
-- audit + reconciliation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- subscription — one row per org. Mirrors the customer's current Stripe
-- subscription; tier + seats + states + specialty_packs determine
-- product-side enforcement (the Tier guard reads this). Stripe is the
-- source of truth for billing state; we cache here for low-latency reads
-- and audit history.
-- ---------------------------------------------------------------------------
CREATE TABLE subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL UNIQUE REFERENCES org(id) ON DELETE CASCADE,

  -- Tier the customer is paying for. Must match the closed enum the
  -- billing service emits in TS (solo|team|org|enterprise).
  tier TEXT NOT NULL CHECK (tier IN ('solo','team','org','enterprise')),

  -- Seats included in the current tier price. Tier-guard rejects
  -- attempts to provision more.
  seats INT NOT NULL CHECK (seats > 0),

  -- Postal-state codes the subscription includes (e.g. {OH,NC,SC}).
  -- Lookup endpoints reject queries against states outside this set.
  states TEXT[] NOT NULL DEFAULT '{}'::text[],

  -- Specialty packs purchased (palliative, behavioral_health, oncology,
  -- dme, wc, ihs, asc, hcc). Endpoints behind a specialty pack reject
  -- requests when the pack isn't in the array.
  specialty_packs TEXT[] NOT NULL DEFAULT '{}'::text[],

  -- Stripe identifiers for the customer + active subscription. Both
  -- nullable to support the design-partner trial period before Stripe
  -- onboarding is finalized.
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,

  -- Status mirrors Stripe's subscription.status enum.
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused')),

  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscription_status_idx ON subscription(status) WHERE status IN ('past_due','unpaid');
CREATE INDEX subscription_period_end_idx ON subscription(current_period_end);

SELECT app.apply_tenant_rls('subscription');

-- ---------------------------------------------------------------------------
-- billing_event — append-only log of webhook-derived state changes. Used
-- for: (a) auditing Stripe → product state diffs; (b) recovering from a
-- webhook outage by replaying Stripe's events API; (c) the renewal-motion
-- script's signal source.
--
-- We deliberately store the *full* Stripe event payload as JSONB rather
-- than a flattened schema — Stripe's payload shape evolves; we don't want
-- to lose forensic detail to schema-fitting.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE,

  -- Stripe event id (evt_...). UNIQUE so webhook replays are idempotent.
  stripe_event_id TEXT NOT NULL UNIQUE,

  -- Type at time of write (e.g. customer.subscription.updated).
  event_type TEXT NOT NULL,

  -- Materialized "what state did this push us to" — the post-state
  -- summary that BillingService computed when it processed the event.
  -- {tier, seats, status, period_end} typically.
  computed_state JSONB NOT NULL,

  -- The full Stripe event payload, capped at 64KB by app validation.
  raw_payload JSONB NOT NULL,

  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX billing_event_org_idx ON billing_event(org_id, received_at DESC);
CREATE INDEX billing_event_type_idx ON billing_event(event_type);

SELECT app.apply_tenant_rls('billing_event');

-- ---------------------------------------------------------------------------
-- updated_at trigger for subscription. (billing_event is append-only, no
-- updated_at.)
-- ---------------------------------------------------------------------------
CREATE TRIGGER subscription_updated_at
  BEFORE UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
