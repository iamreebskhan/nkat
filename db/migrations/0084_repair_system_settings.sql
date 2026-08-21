-- ============================================================================
-- 0084_repair_system_settings.sql
--
-- Undo four rows written into system_setting on 2026-08-21 at 10:13Z while
-- probing whether the platform-settings endpoint validated anything. It did
-- not — that is the defect, and every one of these saved and returned 200:
--
--   lookup.daily_quotas   = 500        a typo of lookup.daily_quota. Not in
--                                      the catalog, so the admin page cannot
--                                      render it: stored and unreachable.
--   cron.alert_hour_utc   = 99         an hour that does not exist
--   embeddings.dimension  = "banana"   a string where a number is read
--   synthesis_cache.version = 1        OVERWROTE the counter maintained by
--                                      migration 0021's trigger, which stood
--                                      at 458
--
-- All three of the first group were UNSET before this, so removing them
-- restores the previous state exactly rather than guessing a value.
--
-- The validation that stops a repeat is in the application (KNOWN_SETTINGS
-- now carries a per-key check, and the upsert refuses an unknown key or a
-- database-owned one). This migration only repairs the data.
--
-- Nothing in the application reads any of these keys today — the trigger
-- writes the counter and no TypeScript reads it — so there was no functional
-- effect. The counter is restored anyway: a monotonic value that has walked
-- backwards is a trap for whoever wires it up later, and "it happened not to
-- matter this time" is not a reason to leave it wrong.
-- ============================================================================

BEGIN;

DELETE FROM system_setting
 WHERE key IN ('lookup.daily_quotas', 'cron.alert_hour_utc', 'embeddings.dimension');

-- GREATEST, not a literal 459: the trigger increments on every payer_rule
-- statement, so the counter may have moved on from 1 between the bad write
-- and this migration. Whatever it is now, land above the pre-incident 458 so
-- every previously cached entry stays invalidated and the sequence never
-- repeats a version it has already used.
UPDATE system_setting
   SET value = to_jsonb(GREATEST(459, (value #>> '{}')::int + 1)),
       note  = 'restored by 0084 — a settings-validation probe overwrote 458 with 1',
       updated_at = now()
 WHERE key = 'synthesis_cache.version';

DO $$
DECLARE
  leftover int;
  version  int;
BEGIN
  SELECT count(*) INTO leftover
    FROM system_setting
   WHERE key IN ('lookup.daily_quotas', 'cron.alert_hour_utc', 'embeddings.dimension');
  IF leftover <> 0 THEN
    RAISE EXCEPTION '0084: % probe row(s) still present', leftover;
  END IF;

  SELECT (value #>> '{}')::int INTO version
    FROM system_setting WHERE key = 'synthesis_cache.version';
  IF version IS NULL OR version < 459 THEN
    RAISE EXCEPTION '0084: synthesis_cache.version is %, expected >= 459', version;
  END IF;
END $$;

COMMIT;
