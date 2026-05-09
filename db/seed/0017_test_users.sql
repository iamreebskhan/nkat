-- ============================================================================
-- 0017_test_users.sql
-- Seed deterministic test users for local dev + integration tests.
-- Production tenants are provisioned via signup → Stripe webhook → invite,
-- never via this seed.
--
-- All four roles for the design-partner org (00...01) so the LoginPage's
-- "Quick test login" buttons resolve to real app_user rows. Audit-log
-- writes need the user_id to FK-resolve, so these need to exist.
-- ============================================================================

INSERT INTO app_user (id, email, full_name, status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin@design-partner.test',     'Test Admin',      'active'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reviewer@design-partner.test',  'Test Reviewer',   'active'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'employee@design-partner.test',  'Test Employee',   'active'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'consultant@design-partner.test','Test Consultant', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_member (org_id, user_id, role, status, joined_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin',      'active', now()),
  ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reviewer',   'active', now()),
  ('11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'employee',   'active', now()),
  ('11111111-1111-4111-8111-111111111111', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'consultant', 'active', now())
ON CONFLICT (org_id, user_id) DO NOTHING;

-- A second org so the SCIM cross-tenant + RLS tests have something to
-- contrast against in dev. Not subscribed (no `subscription` row).
-- Slug is NOT NULL UNIQUE; supply one for every org insert.
INSERT INTO org (id, name, slug, status) VALUES
  ('22222222-2222-4222-8222-222222222222', 'Other RCM Co', 'other-rcm-co', 'active')
ON CONFLICT (id) DO NOTHING;

-- An admin who's a member of BOTH orgs — useful for the "switch org"
-- demo flow in a future phase.
INSERT INTO app_user (id, email, full_name, status) VALUES
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'multi@example.test', 'Multi-Org Admin', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_member (org_id, user_id, role, status, joined_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin', 'active', now()),
  ('22222222-2222-4222-8222-222222222222', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin', 'active', now())
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Default client_company rows for the design-partner org so the
-- Reconciliation page (which needs a client_id) has something to point at
-- out-of-the-box.
-- ----------------------------------------------------------------------------
INSERT INTO client_company (id, org_id, name, npi, primary_state, specialties) VALUES
  ('cccc1111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111',
   'Maple Hospice (test)',
   '1234567893',
   'OH',
   ARRAY['palliative','hospice']::text[]),
  ('cccc2222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111',
   'Cardinal Behavioral Health (test)',
   '1987654321',
   'NC',
   ARRAY['behavioral_health']::text[])
ON CONFLICT (id) DO NOTHING;
