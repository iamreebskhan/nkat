-- ============================================================================
-- 0088_visit_note_structure.sql
--
-- Give the visit note a structure, and give vitals somewhere to live.
--
-- WHY
--
-- On the 20 Aug 2026 walkthrough Mark Hendrix stated the same requirement six
-- different ways, and it is the one thing the product did not have:
--
--   09:50  "that visit note, which is really, really critical from an audit
--           standpoint, that it be in a kind of a structured format."
--   06:10  "each note that you have to have has an HPI — which is history of
--           present illness — social history … and then the rest is like a
--           physical exam."
--   06:29  "you're going to collect their vitals, keep track of their vitals,
--           their weight, all of those things."
--   10:12  "they're going to want to take the note and the superbill and
--           compare them and make sure that they match."
--
-- Until now `visit.document_text` was a single nullable TEXT column holding a
-- TipTap document, and nothing read its contents. The product therefore could
-- not answer "does this note contain an HPI?", which is the question an audit
-- asks and the question payer documentation rules (documentation_requirement.
-- required_chart_elements, declared in 0003 with the inline example 'vitals'
-- and never populated since) were always going to need answered.
--
-- Nothing anywhere stored a weight. A repo-wide search for a vitals table, a
-- weight column or a blood-pressure column returns nothing but that one 0003
-- comment.
--
-- SHAPE
--
-- One row per section rather than one JSON blob per note, because the whole
-- point is that individual sections are addressable: "is the HPI present", "is
-- the physical exam present" has to be a WHERE clause, not a JSON walk in
-- application code.
--
-- Templates are org-owned and versioned, following care_plan_version (0029:187)
-- and the org rulebook: an org edits its template, and notes already signed
-- keep pointing at the version they were written against. Mark's own template
-- — "the perfect note", which he wrote and then told us is "not quite current
-- to current technology and current rules" — is an INPUT to an org's first
-- version, never an authority baked into the schema.
--
-- The default section set lives in TypeScript (lib/features/visits/
-- note-template.ts), not in this migration, for the same reason
-- ROLE_DEFAULT_PERMISSIONS does: it is reviewed as code and applied per org.
-- ============================================================================

-- --------------------------------------------------------------------------
-- A versioned, org-owned note template.
-- --------------------------------------------------------------------------
CREATE TABLE note_template (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  version               INT         NOT NULL DEFAULT 1,

  -- Exactly one active template per org. Superseding one deactivates it
  -- rather than deleting it, so signed notes can still resolve their labels.
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Where this version came from, for provenance: 'default' (shipped set),
  -- 'edited' (org changed it), 'imported' (built from a supplied document).
  source                TEXT        NOT NULL DEFAULT 'default'
                                    CHECK (source IN ('default', 'edited', 'imported')),
  source_note           TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID        REFERENCES app_user(id),

  UNIQUE (org_id, version)
);

CREATE UNIQUE INDEX note_template_one_active_per_org
  ON note_template (org_id) WHERE is_active;

SELECT app.apply_tenant_rls('note_template');


-- --------------------------------------------------------------------------
-- The sections a template declares, in order.
-- --------------------------------------------------------------------------
CREATE TABLE note_template_section (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  template_id           UUID        NOT NULL REFERENCES note_template(id) ON DELETE CASCADE,

  -- Stable machine key ('hpi', 'social_history', 'physical_exam'). This is
  -- what payer documentation rules and the audit packet match on, so it must
  -- not change when an org renames the visible label.
  section_key           TEXT        NOT NULL,
  label                 TEXT        NOT NULL,
  help_text             TEXT,

  -- 'prose'  — a rich-text block (HPI, physical exam)
  -- 'vitals' — renders the vitals capture, stored in visit_vitals not here
  -- 'list'   — one item per line (medications, allergies, problem list)
  kind                  TEXT        NOT NULL DEFAULT 'prose'
                                    CHECK (kind IN ('prose', 'vitals', 'list')),

  -- A required section must be non-empty before the visit can be signed.
  is_required           BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ...except on these visit types, by slug.
  --
  -- Mark named four things a note must have (20 Aug 2026, 05:55-06:29): HPI,
  -- social history, physical exam, vitals. He was describing a home visit. A
  -- blanket rule would make the product refuse encounters that are legitimate
  -- and common in palliative care: there is no physical exam over video, no
  -- weight taken during an advance-care-planning phone call, and at a
  -- bereavement follow-up the patient has died — there is no one to examine
  -- and no history of present illness to write.
  --
  -- Empty array is the safe default: required everywhere.
  not_required_for_visit_types TEXT[] NOT NULL DEFAULT '{}',

  sort_order            INT         NOT NULL DEFAULT 0,

  UNIQUE (template_id, section_key)
);

CREATE INDEX note_template_section_template_idx
  ON note_template_section (template_id, sort_order);

SELECT app.apply_tenant_rls('note_template_section');


-- --------------------------------------------------------------------------
-- What the clinician actually wrote, one row per section.
-- --------------------------------------------------------------------------
CREATE TABLE visit_note_section (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  visit_id              UUID        NOT NULL REFERENCES visit(id) ON DELETE CASCADE,

  section_key           TEXT        NOT NULL,

  -- TipTap JSON for 'prose', {"items":[...]} for 'list'. Kept as JSONB so a
  -- section's content can be inspected without parsing text in the app.
  content               JSONB       NOT NULL DEFAULT '{}'::JSONB,

  -- Denormalised so "does this note have an HPI" is an index scan and not a
  -- JSON walk. Maintained by the service on every write.
  is_empty              BOOLEAN     NOT NULL DEFAULT TRUE,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id    UUID        REFERENCES app_user(id),

  UNIQUE (visit_id, section_key)
);

CREATE INDEX visit_note_section_present_idx
  ON visit_note_section (visit_id, section_key) WHERE NOT is_empty;

SELECT app.apply_tenant_rls('visit_note_section');


-- --------------------------------------------------------------------------
-- Vitals. A separate table because Mark asked to "keep track of" them — the
-- requirement is the trend across visits, not a value inside one note.
-- --------------------------------------------------------------------------
CREATE TABLE visit_vitals (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  visit_id              UUID        NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
  -- Denormalised from the visit so the longitudinal read is a single-table
  -- index scan on the patient, which is the query that draws the weight trend.
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,

  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Stored in metric; the UI converts. Every field is nullable: a palliative
  -- home visit routinely records some vitals and not others, and forcing a
  -- clinician to invent a number is worse than an absent one.
  height_cm             NUMERIC(5,1) CHECK (height_cm IS NULL OR height_cm BETWEEN 20 AND 280),
  weight_kg             NUMERIC(5,2) CHECK (weight_kg IS NULL OR weight_kg BETWEEN 0.5 AND 500),
  bp_systolic           SMALLINT     CHECK (bp_systolic IS NULL OR bp_systolic BETWEEN 40 AND 300),
  bp_diastolic          SMALLINT     CHECK (bp_diastolic IS NULL OR bp_diastolic BETWEEN 20 AND 200),
  heart_rate            SMALLINT     CHECK (heart_rate IS NULL OR heart_rate BETWEEN 20 AND 250),
  resp_rate             SMALLINT     CHECK (resp_rate IS NULL OR resp_rate BETWEEN 4 AND 80),
  -- Two decimals, not one. Clinicians enter Fahrenheit and we store Celsius,
  -- and at one decimal that conversion does not survive the round trip:
  -- 97.8 F is 36.5556 C, which stores as 36.6 and reads back as 97.9. A
  -- temperature that changes by itself between entry and reload is a defect
  -- the clinician sees every time.
  temperature_c         NUMERIC(4,2) CHECK (temperature_c IS NULL OR temperature_c BETWEEN 25 AND 45),
  spo2_percent          SMALLINT     CHECK (spo2_percent IS NULL OR spo2_percent BETWEEN 30 AND 100),

  -- Palliative-specific and both on Mark's template: the Palliative
  -- Performance Scale runs 0-100 in steps of 10, and pain is the 0-10 scale
  -- the Perfect Note records as "pain is 7/10".
  pps_percent           SMALLINT     CHECK (pps_percent IS NULL OR (pps_percent BETWEEN 0 AND 100 AND pps_percent % 10 = 0)),
  pain_score            SMALLINT     CHECK (pain_score IS NULL OR pain_score BETWEEN 0 AND 10),

  notes                 TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID        REFERENCES app_user(id),

  -- One vitals record per visit. A correction updates it rather than stacking
  -- a second row, so the trend never double-counts a single encounter.
  UNIQUE (visit_id)
);

-- The weight-trend query: newest first, for one patient.
CREATE INDEX visit_vitals_patient_trend_idx
  ON visit_vitals (patient_id, recorded_at DESC);

SELECT app.apply_tenant_rls('visit_vitals');


-- --------------------------------------------------------------------------
-- Which template version a visit's note was written against. Nullable: notes
-- written before this migration have no template, and must keep opening.
-- --------------------------------------------------------------------------
ALTER TABLE visit
  ADD COLUMN note_template_id UUID REFERENCES note_template(id);
