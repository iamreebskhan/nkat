-- ============================================================================
-- 0031_phase_pallio_onboarding_rulebook.sql
-- Phase 5 — onboarding wizard state + per-org rulebook (the org's official
-- billing reference, derived from the source rule library or uploaded).
--
-- Source: pallio_complete_vision_v3 §9.2 (wizard) + §9.3 (Path A) + §9.4
-- (Path B) + §9.5 (rulebook lifecycle).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- onboarding_status: per-org wizard progress + completion fingerprint.
-- One row per org. The 5-step wizard upserts as the user advances.
-- ----------------------------------------------------------------------------
CREATE TABLE onboarding_status (
  org_id                  UUID        PRIMARY KEY REFERENCES org(id) ON DELETE CASCADE,
  -- Step completion booleans — true once the user has saved that step.
  profile_complete        BOOLEAN     NOT NULL DEFAULT FALSE,
  states_complete         BOOLEAN     NOT NULL DEFAULT FALSE,
  payers_complete         BOOLEAN     NOT NULL DEFAULT FALSE,
  cpt_codes_complete      BOOLEAN     NOT NULL DEFAULT FALSE,
  rulebook_complete       BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Inputs snapshot — drives Path A generation. Editable up until rulebook
  -- is finalized.
  active_states           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  active_payer_ids        UUID[]      NOT NULL DEFAULT ARRAY[]::UUID[],
  org_type                TEXT        CHECK (org_type IN ('palliative', 'hospice', 'home_health')),
  custom_domain           TEXT,
  -- Free-form notes the org admin wrote at signup.
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ
);

CREATE INDEX onboarding_status_complete_idx ON onboarding_status (completed_at)
  WHERE completed_at IS NULL;

SELECT app.apply_tenant_rls('onboarding_status');

-- ----------------------------------------------------------------------------
-- org_rulebook: the org's saved billing rulebook.
-- One active row per org; previous versions stay in `org_rulebook_version`.
-- ----------------------------------------------------------------------------
CREATE TABLE org_rulebook (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  current_version         INTEGER     NOT NULL DEFAULT 1,
  -- 'generated' = Path A (built from sources)
  -- 'uploaded'  = Path B (org's existing doc, parsed)
  -- 'merged'    = Path B post-comparison resolution
  origin                  TEXT        NOT NULL CHECK (origin IN ('generated', 'uploaded', 'merged')),
  -- Snapshot of the inputs that produced the rulebook (states + payer_ids +
  -- CPT codes). Used to detect drift when source rules update later (§9.5
  -- "Rules have been updated for [Payer]…").
  source_state_codes      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_payer_ids        UUID[]      NOT NULL DEFAULT ARRAY[]::UUID[],
  source_cpt_codes        TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  finalized_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_by_user_id    UUID        REFERENCES app_user(id),
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

CREATE INDEX org_rulebook_finalized_idx ON org_rulebook (org_id, finalized_at DESC);

SELECT app.apply_tenant_rls('org_rulebook');

-- ----------------------------------------------------------------------------
-- org_rulebook_row: one row per (rulebook, payer, state, cpt_code, attribute).
-- This is the actual lookup target — billing agents see THIS, not the global
-- payer_rule, when the org has finalized a rulebook.
-- ----------------------------------------------------------------------------
CREATE TABLE org_rulebook_row (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  rulebook_id             UUID        NOT NULL REFERENCES org_rulebook(id) ON DELETE CASCADE,
  payer_id                UUID        REFERENCES payer(id),
  state                   CHAR(2)     NOT NULL,
  cpt_code                TEXT        NOT NULL,
  attribute               TEXT        NOT NULL,
  -- The official org value. Plain text; the FE renders as a chip.
  rule_value              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  coverage_status         TEXT        NOT NULL CHECK (coverage_status IN
                                          ('covered', 'not_covered', 'varies', 'unknown')),
  -- Provenance: did this come from the source library, the org's upload, or
  -- a manual edit?
  origin                  TEXT        NOT NULL CHECK (origin IN
                                          ('source', 'org_upload', 'org_override', 'analyst')),
  -- Confidence inherited at generation time. Edits keep the original value
  -- but flip origin → org_override.
  confidence              NUMERIC(3,2) NOT NULL DEFAULT 0.5,
  -- The source row this was derived from. NULL when the org typed a value
  -- that isn't backed by any global rule.
  source_payer_rule_id    UUID        REFERENCES payer_rule(id),
  source_quote            TEXT,
  -- Audit: who last edited this cell + when?
  last_edited_by_user_id  UUID        REFERENCES app_user(id),
  last_edited_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (rulebook, payer, state, cpt, attribute). The whole rulebook
-- is replaced on regeneration (drop + re-insert), so the unique constraint
-- is per-rulebook.
CREATE UNIQUE INDEX org_rulebook_row_unique_idx
  ON org_rulebook_row (rulebook_id, payer_id, state, cpt_code, attribute);

CREATE INDEX org_rulebook_row_lookup_idx
  ON org_rulebook_row (org_id, payer_id, state, cpt_code, attribute);

SELECT app.apply_tenant_rls('org_rulebook_row');

-- ----------------------------------------------------------------------------
-- org_rulebook_version: append-only snapshots taken when a rulebook is
-- finalized or re-synced. Lets us show the full edit history per §9.5.
-- ----------------------------------------------------------------------------
CREATE TABLE org_rulebook_version (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  rulebook_id             UUID        NOT NULL REFERENCES org_rulebook(id) ON DELETE CASCADE,
  version                 INTEGER     NOT NULL,
  origin                  TEXT        NOT NULL,
  row_count               INTEGER     NOT NULL,
  -- Frozen rows as JSONB array — for compact storage + easy diff.
  rows_snapshot           JSONB       NOT NULL,
  saved_by_user_id        UUID        REFERENCES app_user(id),
  saved_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rulebook_id, version)
);

CREATE INDEX org_rulebook_version_org_idx ON org_rulebook_version (org_id, saved_at DESC);

SELECT app.apply_tenant_rls('org_rulebook_version');

-- ----------------------------------------------------------------------------
-- rulebook_upload: tracks Path B uploads (PDF / DOCX / XLSX) before they're
-- parsed and merged. The actual file lives in the storage layer; this is
-- just the metadata + extraction status.
-- ----------------------------------------------------------------------------
CREATE TABLE rulebook_upload (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  filename                TEXT        NOT NULL,
  mime_type               TEXT        NOT NULL,
  size_bytes              BIGINT      NOT NULL,
  storage_path            TEXT        NOT NULL,                    -- file:// or s3://
  status                  TEXT        NOT NULL DEFAULT 'received'
                                       CHECK (status IN
                                          ('received', 'extracting', 'extracted', 'merged', 'discarded', 'failed')),
  extraction_started_at   TIMESTAMPTZ,
  extraction_completed_at TIMESTAMPTZ,
  extraction_error        TEXT,
  -- Parsed rows ready for the side-by-side comparison view (§9.4.2).
  -- Schema: [{ payer_id, state, cpt_code, attribute, value, confidence }, ...]
  parsed_rows             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  parsed_row_count        INTEGER     NOT NULL DEFAULT 0,
  uploaded_by_user_id     UUID        REFERENCES app_user(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rulebook_upload_org_status_idx ON rulebook_upload (org_id, status, created_at DESC);

SELECT app.apply_tenant_rls('rulebook_upload');
