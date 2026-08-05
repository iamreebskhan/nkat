-- 0062 — org-owned visit types, and services scoped to a visit type.
--
-- Client walkthrough [02:30]–[02:36]: "agar koi visit type ho raha hai jo hum
-- ne add karna hai, woh aur against — lekin koi visit types ke bhi against,
-- agar kuch different types [ki] services hongi…"
--
-- Two asks in one breath: let the org add its own visit types, and let the
-- services differ per type.
--
-- ── Why coding_basis exists ──
-- The visit type selects the base CPT band (cpt-suggester keys on it), so a
-- free-form type would silently change what gets billed. Instead every type —
-- including custom ones — must declare which of the five known bands it bills
-- like. The org gets its own vocabulary; the coder keeps a closed set. This is
-- why the CHECK below constrains coding_basis, not slug.

CREATE TABLE IF NOT EXISTS org_visit_type (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Stored on visit.visit_type. Stable once created; the label is what moves.
  slug         TEXT        NOT NULL,
  label        TEXT        NOT NULL,
  -- Which built-in band this type bills as. Closed set on purpose.
  coding_basis TEXT        NOT NULL CHECK (coding_basis IN (
                 'new_patient_home', 'established_patient_home',
                 'advance_care_planning', 'telehealth', 'inpatient_consult'
               )),
  -- Deactivate rather than delete — past visits still carry the slug.
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order   INT         NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_visit_type_org_slug_idx
  ON org_visit_type (org_id, lower(slug));

SELECT app.apply_tenant_rls('org_visit_type');

-- Seed every existing org with the five built-ins, slug = coding_basis so
-- existing visit rows keep resolving.
INSERT INTO org_visit_type (org_id, slug, label, coding_basis, sort_order)
SELECT o.id, t.slug, t.label, t.slug, t.sort_order
FROM org o
CROSS JOIN (VALUES
  ('new_patient_home',         'New patient — home',        10),
  ('established_patient_home', 'Established patient — home', 20),
  ('advance_care_planning',    'Advance care planning',      30),
  ('telehealth',               'Telehealth',                 40),
  ('inpatient_consult',        'Inpatient consult',          50)
) AS t(slug, label, sort_order)
ON CONFLICT DO NOTHING;

-- visit.visit_type was CHECK-constrained to the five built-ins. Custom types
-- need it open; org_visit_type is now the authority, enforced in the service
-- layer against the org's own active slugs.
ALTER TABLE visit DROP CONSTRAINT IF EXISTS visit_visit_type_check;

-- Services scoped to a type. Empty array = applies to every visit type, so
-- everything seeded by 0060 keeps showing up exactly as before.
ALTER TABLE visit_service
  ADD COLUMN IF NOT EXISTS visit_types TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON TABLE org_visit_type IS
  'Org-owned visit types. coding_basis maps each to one of the five built-in CPT bands so custom types cannot change what gets billed.';
COMMENT ON COLUMN visit_service.visit_types IS
  'Visit-type slugs this service applies to. Empty = all types.';
