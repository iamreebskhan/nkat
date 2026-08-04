-- 0060 — services provided against a visit.
--
-- Client walkthrough [02:28–02:47]: "yahan pe visit types mein jo hai… lekin
-- koi visit types ke bhi against, agar kuch different types [ki] services
-- hongi ke is visit mein hum logon ne kya kya un ko help provide karni [hai],
-- kya cheezein deni hain — to woh dekh lena ek baar."
--
-- A visit TYPE says what kind of encounter it was (and drives the base CPT).
-- It doesn't say what was actually done in the room. Palliative care is mostly
-- the second thing: symptom management, a goals-of-care conversation, caregiver
-- teaching, medication reconciliation, a wound dressing. Two visits of the same
-- type can be completely different pieces of work.
--
-- So: an org-owned catalog of services, and a join recording which were
-- provided on a given visit. The catalog is editable by the org — that is the
-- extensibility the client asked for. The visit_type enum deliberately stays
-- closed: it selects the billing code, so an arbitrary new value would change
-- what gets billed.

CREATE TABLE IF NOT EXISTS visit_service (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  -- Grouping for the picker, so a 12-item list stays readable.
  category    TEXT        NOT NULL DEFAULT 'clinical' CHECK (category IN (
                'clinical', 'psychosocial', 'care_coordination', 'education', 'other'
              )),
  -- Optional hint shown next to the service when it commonly supports a code
  -- (e.g. ACP → 99497). Advisory only: the CPT suggester remains the authority
  -- on what is actually billed.
  cpt_hint    TEXT,
  -- Deactivate rather than delete — historical visits must keep their labels.
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order  INT         NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One name per org; case-insensitive so "Wound care" and "wound care" can't
-- both exist and split the reporting.
CREATE UNIQUE INDEX IF NOT EXISTS visit_service_org_name_idx
  ON visit_service (org_id, lower(name));

CREATE TABLE IF NOT EXISTS visit_service_provided (
  visit_id   UUID        NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
  service_id UUID        NOT NULL REFERENCES visit_service(id) ON DELETE RESTRICT,
  org_id     UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  -- Optional: minutes spent on this specific service, for time-based codes.
  minutes    INT         CHECK (minutes IS NULL OR (minutes >= 0 AND minutes <= 720)),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (visit_id, service_id)
);

CREATE INDEX IF NOT EXISTS visit_service_provided_service_idx
  ON visit_service_provided (service_id);

SELECT app.apply_tenant_rls('visit_service');
SELECT app.apply_tenant_rls('visit_service_provided');

-- Seed every existing org with a palliative-care starter set, so the picker
-- isn't empty on first use. Orgs can rename, deactivate or extend these.
INSERT INTO visit_service (org_id, name, description, category, cpt_hint, sort_order)
SELECT o.id, s.name, s.description, s.category, s.cpt_hint, s.sort_order
FROM org o
CROSS JOIN (VALUES
  ('Symptom management',        'Pain, dyspnea, nausea, or other symptom assessment and treatment', 'clinical',          NULL,    10),
  ('Medication reconciliation', 'Full medication review, deprescribing, adherence check',           'clinical',          NULL,    20),
  ('Wound care',                'Assessment and dressing of pressure injuries or wounds',           'clinical',          NULL,    30),
  ('Advance care planning',     'Goals-of-care discussion, POLST/MOLST, surrogate designation',     'psychosocial',      '99497', 40),
  ('Psychosocial support',      'Emotional support for the patient; anxiety, depression, distress', 'psychosocial',      NULL,    50),
  ('Caregiver education',       'Teaching the family how to provide care between visits',           'education',         NULL,    60),
  ('Equipment/DME assessment',  'Hospital bed, oxygen, mobility aids — need and ordering',          'care_coordination', NULL,    70),
  ('Referral coordination',     'Hospice, home health, specialist, or community-service referral',  'care_coordination', NULL,    80),
  ('Nutrition support',         'Appetite, intake, feeding decisions',                              'clinical',          NULL,    90),
  ('Spiritual care referral',   'Chaplaincy or the patient''s own faith community',                 'psychosocial',      NULL,   100)
) AS s(name, description, category, cpt_hint, sort_order)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE visit_service IS
  'Org-editable catalog of services that can be provided on a visit. Deactivate rather than delete — historical visits reference these rows.';
COMMENT ON TABLE visit_service_provided IS
  'Which catalog services were actually provided on a visit, with optional per-service minutes.';
