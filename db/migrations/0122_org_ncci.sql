-- ============================================================================
-- 0122_org_ncci.sql
--
-- NCCI edits the practice loads itself (31 Oct 2026). The review checks (0118)
-- warn on an NCCI procedure-to-procedure pair and on units above an MUE, read
-- from ncci_ptp / ncci_mue (0003) — which nothing ever filled. CMS publishes
-- the files quarterly, but they carry CPT, and the AMA licence a download is
-- accepted under allows use "internally within your organization", for
-- Medicare and Medicaid, with no copies passed on: not a file Pallio can load
-- once for every practice. So the practice downloads them under its own
-- acceptance and loads them into its own account (Settings → NCCI edits):
--
--   org_ncci_load   one load of CMS files: PTP pairs or MUE values, the file
--                   names, rows read and kept, who and when. 'staging' while
--                   the browser sends its rows, 'current' once it is used,
--                   'replaced' by a newer one of the same kind (for MUEs, of
--                   the same in-force date). A replaced load's rows are deleted;
--                   the load row stays as the record of what was used when.
--   org_ncci_ptp    a column-1 / column-2 pair with its modifier indicator and
--                   its own effective and deletion dates, as CMS's file has
--                   them. Only pairs of codes Pallio knows are kept (the code
--                   catalog, the payer rules, the practice's fees and every code
--                   on its visits and bills): the full table runs to millions of
--                   rows. codes_covered on the load says which.
--   org_ncci_mue    a code's MUE value and adjudication indicator, in force for
--                   dates of service from the load's in_force_from: CMS's MUE
--                   file has no dates of its own, one file per quarter.
--
-- Tenant data under RLS like any other, never shared between practices.
-- ncci_ptp / ncci_mue stay as they are, empty.
-- ============================================================================

CREATE TABLE org_ncci_load (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL CHECK (kind IN ('ptp', 'mue')),
  status              TEXT        NOT NULL DEFAULT 'staging'
                                  CHECK (status IN ('staging', 'current', 'replaced')),
  -- MUE only: the first date of service its values apply to.
  in_force_from       DATE,
  files               TEXT[]      NOT NULL DEFAULT '{}',
  rows_read           INT         NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  rows_kept           INT         NOT NULL DEFAULT 0 CHECK (rows_kept >= 0),
  -- PTP only: both codes of every kept pair are in this list.
  codes_covered       TEXT[],
  loaded_by_user_id   UUID        REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at        TIMESTAMPTZ,
  CONSTRAINT org_ncci_load_mue_date CHECK ((kind = 'mue') = (in_force_from IS NOT NULL))
);
CREATE INDEX org_ncci_load_org_kind_idx ON org_ncci_load (org_id, kind, status);
SELECT app.apply_tenant_rls('org_ncci_load');

CREATE TABLE org_ncci_ptp (
  load_id             UUID        NOT NULL REFERENCES org_ncci_load(id) ON DELETE CASCADE,
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  column1_code        TEXT        NOT NULL CHECK (column1_code ~ '^[A-Z0-9]{5}$'),
  column2_code        TEXT        NOT NULL CHECK (column2_code ~ '^[A-Z0-9]{5}$'),
  -- 0: never billed together; 1: with an NCCI-associated modifier; 9: not an edit.
  modifier_indicator  SMALLINT    NOT NULL CHECK (modifier_indicator IN (0, 1, 9)),
  effective_date      DATE        NOT NULL,
  -- The first date of service the pair no longer applies to; NULL while it does.
  deletion_date       DATE,
  rationale           TEXT,
  PRIMARY KEY (load_id, column1_code, column2_code, effective_date),
  CONSTRAINT org_ncci_ptp_span CHECK (deletion_date IS NULL OR deletion_date > effective_date)
);
SELECT app.apply_tenant_rls('org_ncci_ptp');

CREATE TABLE org_ncci_mue (
  load_id                 UUID      NOT NULL REFERENCES org_ncci_load(id) ON DELETE CASCADE,
  org_id                  UUID      NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  code                    TEXT      NOT NULL CHECK (code ~ '^[A-Z0-9]{5}$'),
  -- 0 is CMS's: the code is not reported by a practitioner at all.
  units_max               INT       NOT NULL CHECK (units_max >= 0),
  -- 1 per line; 2 per day, policy; 3 per day, clinical.
  adjudication_indicator  SMALLINT  CHECK (adjudication_indicator IN (1, 2, 3)),
  rationale               TEXT,
  PRIMARY KEY (load_id, code)
);
SELECT app.apply_tenant_rls('org_ncci_mue');
