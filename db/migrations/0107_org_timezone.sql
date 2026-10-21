-- ============================================================================
-- 0107_org_timezone.sql
--
-- The practice's time zone, so a visit's date of service is the day it
-- happened where it happened.
--
-- The date of service on a bill was the visit start's UTC calendar day
-- (toISOString().slice(0, 10)). For a US practice that is already tomorrow in
-- the evening: a visit starting at 8:30 pm Eastern on 22 Sep was billed as
-- 23 Sep. That wrong day then picked the payer's fee-schedule row, was stored
-- on the bill and sent on the claim, and made the 835 date match fail. Other
-- instants turned into days the same way, or by casting in the database
-- session's time zone, which is not the practice's either.
--
-- A calendar date on a claim (CMS-1500 24A, 837P DTP*472) has no time and no
-- zone: it is the local day of the service. So every instant that becomes a
-- day now becomes the day in this zone (lib/features/org/org-date.ts
-- orgLocalDate; in SQL, (ts AT TIME ZONE org.timezone)::date). DATE columns
-- are already days and are read as they are.
--
-- Default Eastern: the payer roster is Ohio and the Carolinas, and the demo
-- clinic is in Ohio. The default alone is closer than UTC for every US zone,
-- so no org is made worse before anyone sets it. The CHECK keeps it to the
-- US practice zones the app offers (PRACTICE_TIME_ZONES in org-date.ts; a
-- spec keeps the two lists equal).
--
-- No bill is re-dated. A submitted claim's date is what the payer holds and
-- echoes in the 835, so changing it here alone would break remittance
-- matching. To list bills whose stored date differs from the local day, run
-- the finder in lib/features/org/org-date.ts's header, read-only.
--
-- DDL only, with a constant default, so no table rewrite and no RLS guard.
-- Idempotent: every statement can be re-run.
-- ============================================================================

BEGIN;

ALTER TABLE org ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

ALTER TABLE org DROP CONSTRAINT IF EXISTS org_timezone_check;
ALTER TABLE org ADD CONSTRAINT org_timezone_check CHECK (timezone IN (
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico'
));

COMMENT ON COLUMN org.timezone IS
  'IANA zone of the practice. A visit''s date of service is the calendar day of its start in this zone (lib/features/org/org-date.ts orgLocalDate; in SQL (ts AT TIME ZONE org.timezone)::date).';

COMMIT;
