-- ============================================================================
-- 0016_phase11_design_partner_subscription.sql
-- Seed a default Org-tier subscription for the synthetic design-partner
-- org used by dev / integration tests. Production tenants get rows via
-- Stripe webhook ingestion, never via this seed.
-- ============================================================================

-- The default design-partner org id used across seeds + integration tests.
INSERT INTO org (id, name, status)
VALUES ('11111111-1111-4111-8111-111111111111', 'Design Partner Co', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscription (
  org_id, tier, seats, states, specialty_packs,
  stripe_customer_id, stripe_subscription_id, status,
  current_period_start, current_period_end, trial_end, cancel_at_period_end
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'org', 25,
  ARRAY['OH','NC','SC']::text[],
  ARRAY['palliative','behavioral_health']::text[],
  'cus_DESIGN_PARTNER_DEV',
  'sub_DESIGN_PARTNER_DEV',
  'trialing',
  now(),
  now() + INTERVAL '30 days',
  now() + INTERVAL '14 days',
  false
)
ON CONFLICT (org_id) DO NOTHING;
