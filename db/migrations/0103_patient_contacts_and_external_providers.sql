-- ============================================================================
-- 0103_patient_contacts_and_external_providers.sql
--
-- Audit R30. A palliative patient's circle is bigger than the chart could hold:
--
--   * One unlabelled emergency_contact_name/_phone pair (0029), and no screen
--     ever collected the phone. Mark's patients have a daughter-in-law who is
--     the caregiver and a nephew who holds healthcare power of attorney.
--   * One referring_physician_npi/_name pair, where the header of his note
--     lists a primary care provider, a referring physician, a pulmonologist
--     and an oncologist.
--   * No API or screen read either pair back, so nothing captured could be
--     seen or corrected, and the note header could not print any of it.
--
-- Three tenant tables replace them:
--
--   patient_contact             family, friends and paid caregivers, with the
--                               roles that matter at the bedside: primary
--                               caregiver, emergency contact, and healthcare
--                               POA (at most one per patient).
--   external_provider           the org's roster of outside clinicians, one row
--                               per NPI where there is one, so a PCP who refers
--                               ten patients has one phone number to correct.
--   patient_external_provider   who that clinician is to this patient: primary
--                               care (one), referring (one), specialist
--                               (labelled, e.g. Pulmonologist), or other.
--
-- The four legacy columns are copied across below and then kept, unwritten
-- and unread, for rollback.
--
-- Grants: the default privileges from 0001, re-asserted in 0052, give app DML
-- on every table the migration role creates in public, so there is no GRANT.
-- ============================================================================

-- 1. Family and caregivers.
CREATE TABLE patient_contact (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  full_name             TEXT        NOT NULL
                                    CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  relationship          TEXT        NOT NULL CHECK (relationship IN (
                                      'spouse', 'partner', 'child', 'child_in_law', 'parent',
                                      'sibling', 'grandchild', 'niece_nephew', 'other_family',
                                      'friend', 'paid_caregiver', 'facility_staff', 'other')),
  phone                 TEXT,
  alt_phone             TEXT,
  email                 TEXT        CHECK (email IS NULL OR length(email) <= 254),
  is_primary_caregiver  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_emergency_contact  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_healthcare_poa     BOOLEAN     NOT NULL DEFAULT FALSE,
  lives_with_patient    BOOLEAN     NOT NULL DEFAULT FALSE,
  notes                 TEXT        CHECK (notes IS NULL OR length(notes) <= 500),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID        REFERENCES app_user(id),
  updated_by_user_id    UUID        REFERENCES app_user(id)
);

CREATE INDEX patient_contact_patient_idx ON patient_contact (patient_id);
-- One healthcare power of attorney per patient. The service checks first and
-- names the existing one; this is the backstop for two saves at once.
CREATE UNIQUE INDEX patient_contact_one_poa ON patient_contact (patient_id) WHERE is_healthcare_poa;

SELECT app.apply_tenant_rls('patient_contact');

-- 2. The org's roster of outside clinicians, and who each one is to a patient.
CREATE TABLE external_provider (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  full_name           TEXT        NOT NULL
                                  CHECK (length(btrim(full_name)) BETWEEN 1 AND 150),
  -- Ten digits here; the check digit is enforced by the app (isValidNpi), so
  -- a legacy value copied below is kept rather than refused.
  npi                 TEXT        CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$'),
  specialty           TEXT,
  practice_name       TEXT,
  phone               TEXT,
  fax                 TEXT,
  active              BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  UUID        REFERENCES app_user(id)
);

-- An NPI is an identity: one roster row per NPI per org. A name is not, so
-- name-only rows are never merged.
CREATE UNIQUE INDEX external_provider_org_npi_uniq ON external_provider (org_id, npi) WHERE npi IS NOT NULL;

SELECT app.apply_tenant_rls('external_provider');

CREATE TABLE patient_external_provider (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id            UUID        NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  -- No cascade: a roster row is never deleted while a patient refers to it.
  external_provider_id  UUID        NOT NULL REFERENCES external_provider(id),
  role                  TEXT        NOT NULL
                                    CHECK (role IN ('primary_care', 'referring', 'specialist', 'other')),
  -- What the note header calls a specialist or other provider: Pulmonologist,
  -- Oncologist. NULL for primary care and referring, whose label is fixed.
  role_label            TEXT        CHECK (role_label IS NULL OR length(role_label) <= 80),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id    UUID        REFERENCES app_user(id),
  CONSTRAINT pep_specialist_label
    CHECK (role <> 'specialist' OR (role_label IS NOT NULL AND length(btrim(role_label)) > 0)),
  -- Named: the generated name would be truncated past 63 characters, and the
  -- service matches on it to turn a lost race into a readable 422.
  CONSTRAINT pep_patient_provider_role_uniq UNIQUE (patient_id, external_provider_id, role)
);

CREATE UNIQUE INDEX pep_one_pcp ON patient_external_provider (patient_id) WHERE role = 'primary_care';
CREATE UNIQUE INDEX pep_one_referring ON patient_external_provider (patient_id) WHERE role = 'referring';
-- Answers "which of our patients does Dr X see".
CREATE INDEX pep_provider_idx ON patient_external_provider (external_provider_id);

SELECT app.apply_tenant_rls('patient_external_provider');

COMMENT ON TABLE patient_contact IS
  'Family, friends and paid caregivers of a patient, with primary-caregiver, emergency-contact and healthcare-POA roles (audit R30). At most one POA per patient.';
COMMENT ON TABLE external_provider IS
  'The org''s roster of outside clinicians (PCPs, referrers, specialists), one row per NPI where known (audit R30).';
COMMENT ON TABLE patient_external_provider IS
  'Who an outside clinician is to a patient: primary care (one), referring (one), specialist (labelled) or other (audit R30). Rendered into the note header and the audit packet.';

-- 3. Backfill from the legacy columns. Idempotent: every step skips a patient
--    it has already copied.
--
-- It reads patient and writes the new tables, all under FORCE ROW LEVEL
-- SECURITY. Only a role that bypasses RLS sees every org's rows: the deploy
-- superuser does (0052: `postgres` on prod, `admin` locally and in CI). Any
-- other role would see no patients and silently copy nothing, which would
-- look like data loss once the app reads the new tables. So refuse instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0103 backfill needs a role that bypasses row-level security (superuser or BYPASSRLS); % does not', current_user;
  END IF;
END $$;

-- 3a. The emergency contact. The relationship was never recorded.
INSERT INTO patient_contact (org_id, patient_id, full_name, relationship, phone, is_emergency_contact)
SELECT p.org_id, p.id,
       btrim(left(btrim(p.emergency_contact_name), 120)),
       'other',
       NULLIF(btrim(p.emergency_contact_phone), ''),
       TRUE
  FROM patient p
 WHERE NULLIF(btrim(p.emergency_contact_name), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM patient_contact c WHERE c.patient_id = p.id);

-- 3b. Referring physicians with an NPI: one roster row per org and NPI, named
--     from the most recently updated patient that gave a name.
INSERT INTO external_provider (org_id, full_name, npi)
SELECT DISTINCT ON (org_id, btrim(referring_physician_npi))
       org_id,
       left(COALESCE(NULLIF(btrim(referring_physician_name), ''),
                     'NPI ' || btrim(referring_physician_npi)), 150),
       btrim(referring_physician_npi)
  FROM patient
 WHERE btrim(referring_physician_npi) ~ '^[0-9]{10}$'
 ORDER BY org_id, btrim(referring_physician_npi),
          (NULLIF(btrim(referring_physician_name), '') IS NULL), updated_at DESC
ON CONFLICT (org_id, npi) WHERE npi IS NOT NULL DO NOTHING;

INSERT INTO patient_external_provider (org_id, patient_id, external_provider_id, role)
SELECT p.org_id, p.id, ep.id, 'referring'
  FROM patient p
  JOIN external_provider ep
    ON ep.org_id = p.org_id AND ep.npi = btrim(p.referring_physician_npi)
 WHERE btrim(p.referring_physician_npi) ~ '^[0-9]{10}$'
ON CONFLICT DO NOTHING;

-- 3c. Name-only referrals: one roster row per patient, because a name is not
--     an identity and two "Dr Smith"s must not be merged.
DO $$
DECLARE
  r   RECORD;
  pid UUID;
BEGIN
  FOR r IN
    SELECT p.id, p.org_id, btrim(left(btrim(p.referring_physician_name), 150)) AS name
      FROM patient p
     WHERE (p.referring_physician_npi IS NULL
            OR btrim(p.referring_physician_npi) !~ '^[0-9]{10}$')
       AND NULLIF(btrim(p.referring_physician_name), '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM patient_external_provider x
                        WHERE x.patient_id = p.id AND x.role = 'referring')
  LOOP
    INSERT INTO external_provider (org_id, full_name) VALUES (r.org_id, r.name)
      RETURNING id INTO pid;
    INSERT INTO patient_external_provider (org_id, patient_id, external_provider_id, role)
      VALUES (r.org_id, r.id, pid, 'referring');
  END LOOP;
END $$;

-- 4. The legacy columns stay for rollback only.
COMMENT ON COLUMN patient.emergency_contact_name IS
  'Superseded by patient_contact (0103, audit R30). Not written or read; kept for rollback.';
COMMENT ON COLUMN patient.emergency_contact_phone IS
  'Superseded by patient_contact (0103, audit R30). Not written or read; kept for rollback.';
COMMENT ON COLUMN patient.referring_physician_npi IS
  'Superseded by patient_external_provider (0103, audit R30). Not written or read; kept for rollback.';
COMMENT ON COLUMN patient.referring_physician_name IS
  'Superseded by patient_external_provider (0103, audit R30). Not written or read; kept for rollback.';

-- Production pre-check (read-only), before applying — what step 3 will copy:
--   SELECT count(*) FILTER (WHERE NULLIF(btrim(emergency_contact_name), '') IS NOT NULL) AS contacts,
--          count(*) FILTER (WHERE btrim(referring_physician_npi) ~ '^[0-9]{10}$')     AS npi_referrals,
--          count(*) FILTER (WHERE NULLIF(btrim(referring_physician_name), '') IS NOT NULL
--                             AND (referring_physician_npi IS NULL
--                                  OR btrim(referring_physician_npi) !~ '^[0-9]{10}$')) AS name_only
--     FROM patient;
