-- ============================================================================
-- Seed Traditional Medicare (Part B) as a payer.
--
-- The Phase-4 payer seed (0008) only has NC/SC Medicaid MCOs + Ohio commercial
-- payers — there is NO Medicare row. Without one, `name ILIKE '%medicare%'`
-- resolves to NULL, so CMS ingestion sources get payer_id = NULL and
-- extractRulesFromDocument writes ZERO payer_rule rows (it requires both
-- payer_id and state). This adds the missing Medicare payer so CMS documents
-- extract into a real, comparable payer.
--
-- Deterministic id (continues the 0008 numbering: 3xx = Ohio, 4xx = federal).
-- Idempotent: ON CONFLICT (id) DO UPDATE.
--
-- Apply on the VPS:
--   sudo -u postgres psql pallio -f db/seed/payer-medicare.sql
-- ============================================================================

INSERT INTO payer (id, name, parent_org, payer_type, states_served, policy_index_url, notes)
VALUES (
  'a0000000-0000-4000-8000-000000000401',
  'Traditional Medicare (Part B)',
  'CMS',
  'medicare_mac',
  '{OH,NC,SC}',
  'https://www.cms.gov/medicare/coverage/medicare-coverage-database',
  'Federal fee-for-service Medicare. Coverage from CMS final rules, NCD/LCD, MLN articles.'
)
ON CONFLICT (id) DO UPDATE SET
  name             = EXCLUDED.name,
  parent_org       = EXCLUDED.parent_org,
  payer_type       = EXCLUDED.payer_type,
  states_served    = EXCLUDED.states_served,
  policy_index_url = EXCLUDED.policy_index_url,
  notes            = EXCLUDED.notes;

SELECT id, name, payer_type, states_served FROM payer WHERE name ILIKE '%medicare%';
