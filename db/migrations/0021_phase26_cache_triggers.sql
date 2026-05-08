-- ============================================================================
-- 0021_phase26_cache_triggers.sql
-- Phase 26 — auto-invalidate the synthesis cache when rule-source tables
-- mutate. STATEMENT-level triggers (not ROW-level) so a 100k-row bulk
-- import bumps the version once, not 100k times.
--
-- Tables monitored (changes here can affect lookup findings, which
-- affect synthesis output):
--   payer_rule, ncci_ptp, ncci_mue, documentation_requirement,
--   mhpaea_parity_pair, dme_master_list, asc_payment_indicator,
--   wc_state_fee_schedule, hcc_mapping, cob_rule.
--
-- We deliberately do NOT trigger on:
--   - tenant-scoped tables (client_rulebook, client_rule, audit_log) —
--     those don't drive synthesis output
--   - reference tables that change rarely (revenue_code, ms_drg, ndc) —
--     not worth the trigger overhead
--
-- Operator escape hatch: bulk imports that want to defer the bump to
-- a single explicit cache:invalidate call at the end can run the
-- session with `SET session_replication_role = replica` (Postgres
-- standard for "skip user-defined triggers"). The rule-source tables
-- aren't replicated targets, so this disables the trigger cleanly.
-- ============================================================================

-- Statement-level trigger function. Fires once per INSERT/UPDATE/DELETE
-- statement; bumps `synthesis_cache.version` if it exists, no-ops if not
-- (so a fresh deploy without the seed doesn't error out).
CREATE OR REPLACE FUNCTION app.bump_synthesis_cache_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Atomic increment + a "trigger-driven" note. Skip silently if the
  -- key is missing (e.g., during a fresh deploy mid-migration).
  UPDATE system_setting
     SET value      = ((value::int + 1)::text)::jsonb,
         note       = 'auto: ' || TG_TABLE_NAME || ' ' || TG_OP,
         updated_at = now()
   WHERE key = 'synthesis_cache.version';
  RETURN NULL;
END;
$$;

-- Helper macro-like procedure to install the three triggers on a table.
-- We could inline these, but DRYing the table list keeps a future
-- "add a new rule-source table" change to one CREATE TRIGGER call.
DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'payer_rule',
    'ncci_ptp',
    'ncci_mue',
    'documentation_requirement',
    'mhpaea_parity_pair',
    'dme_master_list',
    'asc_payment_indicator',
    'wc_state_fee_schedule',
    'hcc_mapping',
    'cob_rule'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    -- AFTER INSERT
    EXECUTE format(
      'CREATE TRIGGER %I_bump_cache_ins
         AFTER INSERT ON %I
         REFERENCING NEW TABLE AS new_rows
         FOR EACH STATEMENT
         WHEN (EXISTS (SELECT 1 FROM new_rows))
         EXECUTE FUNCTION app.bump_synthesis_cache_version()',
      tbl || '_bump', tbl
    );
    -- AFTER UPDATE
    EXECUTE format(
      'CREATE TRIGGER %I_bump_cache_upd
         AFTER UPDATE ON %I
         REFERENCING NEW TABLE AS new_rows
         FOR EACH STATEMENT
         WHEN (EXISTS (SELECT 1 FROM new_rows))
         EXECUTE FUNCTION app.bump_synthesis_cache_version()',
      tbl || '_bump', tbl
    );
    -- AFTER DELETE
    EXECUTE format(
      'CREATE TRIGGER %I_bump_cache_del
         AFTER DELETE ON %I
         REFERENCING OLD TABLE AS old_rows
         FOR EACH STATEMENT
         WHEN (EXISTS (SELECT 1 FROM old_rows))
         EXECUTE FUNCTION app.bump_synthesis_cache_version()',
      tbl || '_bump', tbl
    );
  END LOOP;
END;
$$;
