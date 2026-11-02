-- ============================================================================
-- 0125_org_kpi_month.sql
--
-- A practice's monthly figures from before Pallio, and its plan.
--
-- The KPI report counts Pallio's own rows, so the months before a practice came
-- to Pallio read as zero, and a year-over-year table has nothing to compare
-- with. These are those months' figures as the practice reported them, typed or
-- pasted in by hand, one measure a month:
--
--   measure   a Trend Report row (referrals, admitted, census, billed, ...),
--             'discharge:<code>' / 'ntuc:<code>' for a month's count by reason,
--             or 'plan:<name>' for the goal a month is measured against (the
--             latest plan at or before a month carries forward).
--   value     as typed: a count, or dollars for money.
--
-- An entered figure stands for its month in every report, marked as entered,
-- because it is what the practice reported: Pallio may hold only some of a
-- month it was brought in during. Where Pallio's own count differs, the board
-- report's exceptions say so.
--
-- Tenant data under RLS. Counts and money only; no patient is named here.
-- ============================================================================

CREATE TABLE org_kpi_month (
  org_id              UUID          NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  month               DATE          NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  measure             TEXT          NOT NULL CHECK (length(measure) BETWEEN 1 AND 40),
  value               NUMERIC(14,2) NOT NULL CHECK (value >= 0),
  updated_by_user_id  UUID          REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month, measure)
);
SELECT app.apply_tenant_rls('org_kpi_month');

COMMENT ON TABLE org_kpi_month IS
  'Monthly figures a practice reported before Pallio, and its plan (0125). Entered by hand; each stands for its month in every report.';
