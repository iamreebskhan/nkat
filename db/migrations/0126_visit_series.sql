-- ============================================================================
-- 0126_visit_series.sql
--
-- Repeating visits. A series is how a run of visits was booked: every N weeks or
-- months, to a day or for a number of visits. Each occurrence is an ordinary
-- visit row, so it is moved, cancelled, documented and billed on its own, and
-- nothing that reads visits has to know a series exists.
--
--   visit_series     what was asked for
--   visit.series_id  which series a visit was booked in; nullable, and left as
--                    it is when one occurrence is moved or cancelled
--
-- Tenant data under RLS. The patient and clinician are on the visits; the
-- series names them too because that is what was booked.
-- ============================================================================

CREATE TABLE visit_series (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id          UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  clinician_user_id   UUID        NOT NULL REFERENCES app_user(id),
  visit_type          TEXT        NOT NULL,
  every_n             INT         NOT NULL CHECK (every_n BETWEEN 1 AND 12),
  unit                TEXT        NOT NULL CHECK (unit IN ('week', 'month')),
  starts_on           DATE        NOT NULL,
  until_on            DATE,
  visit_count         INT,
  created_by_user_id  UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT visit_series_ends CHECK ((until_on IS NULL) <> (visit_count IS NULL))
);
CREATE INDEX visit_series_patient_idx ON visit_series (org_id, patient_id);
SELECT app.apply_tenant_rls('visit_series');

ALTER TABLE visit ADD COLUMN series_id UUID REFERENCES visit_series(id);
CREATE INDEX visit_series_id_idx ON visit (org_id, series_id) WHERE series_id IS NOT NULL;

COMMENT ON TABLE visit_series IS
  'How a run of repeating visits was booked (0126). Each occurrence is an ordinary visit.';
COMMENT ON COLUMN visit.series_id IS
  'The repeating series this visit was booked in, if any (0126).';
