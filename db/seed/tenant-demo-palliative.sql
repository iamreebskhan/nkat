-- ============================================================================
-- tenant-demo-palliative.sql
--
-- Audit R20. The demo tenant: 'Pallio Demo Palliative Care', a home-based
-- palliative practice in central Ohio with eight staff, fourteen patients and
-- six weeks of documented, billed work behind it.
--
-- DELIBERATELY NOT IN db/seed/MANIFEST. It writes tenant tables (org,
-- app_user, patient, visit, superbill), which the manifest's own rule and
-- deploy.sh's tenant-writer check keep out of every deploy. CI still applies
-- it (ci.yml runs every db/seed/*.sql), so each push proves it against the
-- current schema. Run it by hand, per docs/RUNBOOKS/demo-tenant.md:
--
--   read -rs -p 'demo password: ' DEMO_PW; echo
--   sudo -u postgres psql pallio -X -v ON_ERROR_STOP=1 -v demo_password="$DEMO_PW" -f db/seed/tenant-demo-palliative.sql
--   unset DEMO_PW
--
-- WHY A NEW ORG. The account first meant for the demo, 'Pallio Live Demo',
-- held two cloned fixture patients (both born 1942-03-08, same address, same
-- member id), a hand-typed 'KatherineKatherinKatherinee', dozens of stacked
-- harness visits and one user who sat in no care-team seat. It cannot be
-- cleaned in place: audit_log_retention_guard keeps six years of that user's
-- rows on its /audit page. Migration 0101 (R36) retires it; this replaces it.
--
-- PASSWORDS. Every account is created with password_hash NULL, which login()
-- rejects. Hashes are set only by the \if block at the end, from a psql
-- variable, with pgcrypto's bcrypt (bcryptjs verifies its $2a$ hashes). No
-- credential is in this file. Without -v demo_password, existing hashes are
-- left as they are.
--
-- NPIs. The org NPI is 1234567893, the check-digit example CMS publishes.
-- Clinicians get a credential and NO individual NPI: a real-format number
-- could belong to a real provider, so those come from the practice or an
-- NPPES check (R20 decision 2). Until then every bill names the org NPI as
-- rendering provider, exactly as buildDraftFromVisit falls back, and the
-- bill page says so.
--
-- IDENTIFIERS. Phones are 614-555-01xx (reserved for fiction). Medicare ids
-- begin with 0, which no Medicare Beneficiary Identifier can.
--
-- IDEMPOTENT. Deterministic ids ('d0000000-0000-4000-8000-' + a 12-digit
-- suffix: org 1, users 1xx, patients 2xx, visits 3xx, bills 5xx, denials 6xx,
-- claim activity 1xxxxx) and ON CONFLICT DO UPDATE throughout. Dates are
-- relative to today (US Eastern business days), so re-running moves the
-- caseload to the current week and restores every seeded row; rows created
-- in the app are left alone.
--
-- REQUIRES migrations through 0103 (visit.signer_credential from 0098,
-- org_visit_type.is_telehealth from 0099, the contact and outside-provider
-- tables from 0103) and, in the same database, the
-- reference seeds this sorts after: payers (0008, payer-medicare.sql), place
-- of service (0002) and the payer rules that price the bills.
--
-- AFTERWARDS run scripts/backfill-phi-encryption.sql (CROSSCHECK-RUNBOOK
-- §5b) to encrypt the member ids written here in plaintext.
-- ============================================================================

\set ON_ERROR_STOP on

-- This file is UTF-8 (em dashes in labels, activity summaries and template
-- help text). psql otherwise sends it in the console's encoding: a run from a
-- Windows console stored every '—' as 'â€”'. Re-running repairs those rows,
-- because they are upserted.
SET client_encoding = 'UTF8';

-- One transaction: the checks at the end abort the whole seed, not the half
-- of it that came after the problem.
BEGIN;

-- ----------------------------------------------------------------------------
-- Working tables. Session-local and dropped at COMMIT; dropped first as well
-- so a second run in one session starts clean.
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS pg_temp.demo_seed_user, pg_temp.demo_seed_role_perm,
  pg_temp.demo_seed_section, pg_temp.demo_seed_template_section,
  pg_temp.demo_seed_ref_rate, pg_temp.demo_seed_day,
  pg_temp.demo_seed_patient, pg_temp.demo_seed_patient_note, pg_temp.demo_seed_visit,
  pg_temp.demo_seed_visit_row, pg_temp.demo_seed_note, pg_temp.demo_seed_line,
  pg_temp.demo_seed_bill, pg_temp.demo_seed_denial;

-- The staff. org_member.role keeps its legacy value ('admin' for an org
-- admin, 'employee' otherwise); role_template (0096) is what the sidebar and
-- the permission set follow. credential feeds clinician_profile.
CREATE TEMP TABLE demo_seed_user (
  user_key       TEXT PRIMARY KEY,
  id             UUID NOT NULL,
  email          TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  member_role    TEXT NOT NULL,
  role_template  TEXT NOT NULL,
  credential     TEXT
) ON COMMIT DROP;

INSERT INTO demo_seed_user (user_key, id, email, full_name, member_role, role_template, credential) VALUES
  -- Medical director; sees patients as well as running the practice.
  ('director',   'd0000000-0000-4000-8000-000000000101', 'helen.okafor@demo.pallio.io',     'Helen Okafor',     'admin',    'org_admin',     'MD'),
  ('np_delgado', 'd0000000-0000-4000-8000-000000000102', 'marcus.delgado@demo.pallio.io',   'Marcus Delgado',   'employee', 'clinician',     'NP'),
  ('np_raman',   'd0000000-0000-4000-8000-000000000103', 'priya.raman@demo.pallio.io',      'Priya Raman',      'employee', 'clinician',     'NP'),
  -- RN case manager and social worker: care-team seats, no billed visits.
  ('rn',         'd0000000-0000-4000-8000-000000000104', 'theresa.kowalski@demo.pallio.io', 'Theresa Kowalski', 'employee', 'clinician',     'RN'),
  ('lcsw',       'd0000000-0000-4000-8000-000000000105', 'jamal.whitfield@demo.pallio.io',  'Jamal Whitfield',  'employee', 'clinician',     'LCSW'),
  ('chaplain',   'd0000000-0000-4000-8000-000000000106', 'anne.lindqvist@demo.pallio.io',   'Anne Lindqvist',   'employee', 'read_only',     NULL),
  ('biller',     'd0000000-0000-4000-8000-000000000107', 'dana.mercer@demo.pallio.io',      'Dana Mercer',      'employee', 'billing_agent', NULL),
  ('manager',    'd0000000-0000-4000-8000-000000000108', 'colleen.brandt@demo.pallio.io',   'Colleen Brandt',   'admin',    'org_admin',     NULL);

-- Permissions come only from user_permission (login reads nothing else).
-- Each block below is ROLE_DEFAULT_PERMISSIONS[<template>] from
-- lib/features/team/team.types.ts, copied in order. The '-- role:' markers are
-- what lib/features/team/__tests__/demo-seed-drift.spec.ts compares against
-- that constant, so a permission added there fails the spec until it is
-- added here.
CREATE TEMP TABLE demo_seed_role_perm (
  role_template TEXT NOT NULL,
  permission    TEXT NOT NULL,
  PRIMARY KEY (role_template, permission)
) ON COMMIT DROP;

-- role:org_admin
INSERT INTO demo_seed_role_perm (role_template, permission)
SELECT 'org_admin', p FROM unnest(ARRAY[
  'patients.list', 'patients.view', 'patients.create', 'patients.edit', 'patients.archive',
  'visits.view.own', 'visits.view.all', 'visits.create', 'visits.edit', 'visits.submit',
  'careplans.view', 'careplans.edit',
  'schedule.view', 'schedule.create', 'schedule.edit',
  'billing.lookup.view', 'billing.lookup.export',
  'billing.superbills.view', 'billing.superbills.create', 'billing.superbills.edit', 'billing.superbills.export',
  'superbill.predict',
  'billing.denials.view', 'billing.denials.log', 'billing.denials.refile', 'billing.denials.writeoff',
  'cheatsheets.view', 'cheatsheets.generate', 'cheatsheets.download',
  'knowledge.view', 'knowledge.upload', 'knowledge.attest', 'knowledge.edit',
  'reports.view', 'reports.export',
  'team.view', 'team.invite', 'team.permissions', 'team.deactivate',
  'settings.view', 'settings.org', 'settings.payers', 'settings.integrations',
  'audit.view',
  'messaging.read', 'messaging.send',
  'patient.acuity.edit',
  'patients.careteam.edit'
]) AS p;

-- role:clinician
INSERT INTO demo_seed_role_perm (role_template, permission)
SELECT 'clinician', p FROM unnest(ARRAY[
  'patients.list', 'patients.view', 'patients.edit',
  'visits.view.own', 'visits.create', 'visits.edit', 'visits.submit',
  'careplans.view', 'careplans.edit',
  'schedule.view', 'schedule.create', 'schedule.edit',
  'messaging.read', 'messaging.send',
  'patient.acuity.edit'
]) AS p;

-- role:billing_agent
INSERT INTO demo_seed_role_perm (role_template, permission)
SELECT 'billing_agent', p FROM unnest(ARRAY[
  'patients.list', 'patients.view',
  'visits.view.all',
  'billing.lookup.view', 'billing.lookup.export',
  'billing.superbills.view', 'billing.superbills.create', 'billing.superbills.edit', 'billing.superbills.export',
  'superbill.predict',
  'billing.denials.view', 'billing.denials.log', 'billing.denials.refile', 'billing.denials.writeoff',
  'cheatsheets.view', 'cheatsheets.download',
  'knowledge.view',
  'knowledge.attest',
  'messaging.read'
]) AS p;

-- role:read_only
INSERT INTO demo_seed_role_perm (role_template, permission)
SELECT 'read_only', p FROM unnest(ARRAY[
  'patients.list', 'patients.view',
  'visits.view.all',
  'reports.view',
  'audit.view'
]) AS p;

-- The note sections written on every signed visit. Keys and kinds must match
-- DEFAULT_NOTE_SECTIONS in lib/features/visits/note-template.ts (the drift
-- spec checks, and that every required prose section is here). Vitals are not
-- a section row: they live in visit_vitals. The physical exam is written on
-- home visits only; it is waived for telehealth and advance care planning.
CREATE TEMP TABLE demo_seed_section (
  section_key     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  in_person_only  BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_seed_section (section_key, kind, in_person_only) VALUES
  ('chief_complaint',     'prose', FALSE),
  ('hpi',                 'prose', FALSE),
  ('social_history',      'prose', FALSE),
  ('code_status',         'prose', FALSE),
  ('medications',         'list',  FALSE),
  ('physical_exam',       'prose', TRUE),
  ('goals_of_care',       'prose', FALSE),
  ('assessment_and_plan', 'prose', FALSE);

-- The note template those sections are written against, as ensureNoteTemplate
-- (lib/features/visits/note.service.ts) creates it on a real org's first note
-- read: one row per DEFAULT_NOTE_SECTIONS entry in
-- lib/features/visits/note-template.ts, in its order, sort_order its index.
-- The drift spec holds each row to that constant field by field. The inserts
-- that use it come after the visits.
CREATE TEMP TABLE demo_seed_template_section (
  section_key                   TEXT PRIMARY KEY,
  label                         TEXT NOT NULL,
  kind                          TEXT NOT NULL,
  is_required                   BOOLEAN NOT NULL,
  not_required_for_visit_types  TEXT[] NOT NULL,
  sort_order                    INT NOT NULL UNIQUE,
  help_text                     TEXT
) ON COMMIT DROP;

INSERT INTO demo_seed_template_section
  (section_key, label, kind, is_required, not_required_for_visit_types, sort_order, help_text) VALUES
  ('reason_for_visit',      'Reason for visit',           'prose',  FALSE, ARRAY[]::text[],  0,
   'Why this encounter happened — referral, follow-up, crisis.'),
  ('chief_complaint',       'Chief complaint',            'prose',  FALSE, ARRAY[]::text[],  1,
   'In the patient''s own words where possible.'),
  ('hpi',                   'History of present illness', 'prose',  TRUE,  ARRAY['bereavement_follow_up'],  2,
   'The narrative of the current illness and what has changed since the last visit.'),
  ('past_medical_history',  'Past medical history',       'list',   FALSE, ARRAY[]::text[],  3, NULL),
  ('past_surgical_history', 'Past surgical history',      'list',   FALSE, ARRAY[]::text[],  4, NULL),
  ('social_history',        'Social history',             'prose',  TRUE,  ARRAY['bereavement_follow_up'],  5,
   'Living situation, caregivers, substance use, advance-directive status.'),
  ('family_history',        'Family history',             'prose',  FALSE, ARRAY[]::text[],  6, NULL),
  ('code_status',           'Code status',                'prose',  FALSE, ARRAY[]::text[],  7,
   'Full code, DNR/DNI, POLST/MOLST on file.'),
  ('vitals',                'Vitals',                     'vitals', TRUE,
   ARRAY['advance_care_planning', 'telehealth', 'bereavement_follow_up'],  8,
   'Weight is tracked across visits — the trend is what matters in palliative care.'),
  ('allergies',             'Allergies',                  'list',   FALSE, ARRAY[]::text[],  9, NULL),
  ('medications',           'Medications',                'list',   FALSE, ARRAY[]::text[], 10,
   'One per line, with dose, route, frequency and any change made today.'),
  ('review_of_systems',     'Review of systems',          'prose',  FALSE, ARRAY[]::text[], 11, NULL),
  ('physical_exam',         'Physical examination',       'prose',  TRUE,
   ARRAY['advance_care_planning', 'telehealth', 'bereavement_follow_up'], 12, NULL),
  ('goals_of_care',         'Goals of care',              'prose',  FALSE, ARRAY[]::text[], 13,
   'The palliative core of the note — what the patient wants, and what changed.'),
  ('assessment_and_plan',   'Assessment and plan',        'prose',  TRUE,  ARRAY[]::text[], 14,
   'Numbered by problem. This is what the billed codes are defended with.');

-- Pallio's 2025 Medicare reference rates, for codes a payer publishes no rate
-- for — the fallback buildSuperbill prices from. A copy of
-- MEDICARE_RATES_CENTS_2025 in lib/features/superbills/superbill-pure.ts; the
-- drift spec holds each row to estimateRateCents().
CREATE TEMP TABLE demo_seed_ref_rate (
  code         TEXT PRIMARY KEY,
  md_cents     BIGINT NOT NULL,
  np_pa_cents  BIGINT NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_seed_ref_rate (code, md_cents, np_pa_cents) VALUES
  ('99341', 4664, 3964), ('99342', 7411, 6299), ('99344', 13413, 11401), ('99345', 18994, 16145),
  ('99347', 4277, 3635), ('99348', 7218, 6135), ('99349', 11975, 10179), ('99350', 17452, 14834),
  ('G0318', 2938, 2497), ('99417', 2919, 2475), ('99497', 7660, 6381),  ('99498', 7184, 5984);

-- Business days around today in Ohio: bday -1 is the last weekday before
-- today, bday 1 the next one. Visits are placed on these, so the caseload
-- always sits on the current calendar and never on a weekend.
CREATE TEMP TABLE demo_seed_day ON COMMIT DROP AS
SELECT (-row_number() OVER (ORDER BY d DESC))::int AS bday, d::date AS day
  FROM generate_series((now() AT TIME ZONE 'America/New_York')::date - 70,
                       (now() AT TIME ZONE 'America/New_York')::date - 1,
                       interval '1 day') AS d
 WHERE extract(isodow FROM d) < 6
UNION ALL
SELECT (row_number() OVER (ORDER BY d))::int, d::date
  FROM generate_series((now() AT TIME ZONE 'America/New_York')::date + 1,
                       (now() AT TIME ZONE 'America/New_York')::date + 20,
                       interval '1 day') AS d
 WHERE extract(isodow FROM d) < 6;

-- The caseload. Fourteen people, fourteen names, fourteen birth dates,
-- nine towns around Columbus. Acuity: 3 critical, 4 high, 5 medium, 2 low.
-- One discharged (stabilized, back to his pulmonologist), one deceased.
-- dx is the visit diagnosis list, principal first. The height, weight and
-- vitals columns are each patient's baseline; weight_step is how much weight
-- they lose between home visits, which draws the downward trend.
CREATE TEMP TABLE demo_seed_patient (
  patient_no                INT PRIMARY KEY,
  id                        UUID NOT NULL,
  first_name                TEXT NOT NULL,
  last_name                 TEXT NOT NULL,
  sex                       TEXT NOT NULL,
  dob                       DATE NOT NULL,
  address_line_1            TEXT NOT NULL,
  city                      TEXT NOT NULL,
  zip                       TEXT NOT NULL,
  phone                     TEXT NOT NULL,
  emergency_contact_name    TEXT NOT NULL,
  emergency_contact_phone   TEXT NOT NULL,
  payer_name                TEXT NOT NULL,
  member_id                 TEXT NOT NULL,
  group_number              TEXT,
  dx                        TEXT[] NOT NULL,
  referring_physician_name  TEXT NOT NULL,
  referral_reason           TEXT NOT NULL,
  acuity                    TEXT NOT NULL,
  status                    TEXT NOT NULL,
  ends_bday                 INT,
  primary_np                TEXT NOT NULL,
  height_cm                 NUMERIC NOT NULL,
  weight_kg                 NUMERIC NOT NULL,
  weight_step               NUMERIC NOT NULL,
  sbp                       INT NOT NULL,
  dbp                       INT NOT NULL,
  hr                        INT NOT NULL,
  rr                        INT NOT NULL,
  spo2                      INT NOT NULL,
  caregiver                 TEXT NOT NULL,
  medications               TEXT[] NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_seed_patient (
  patient_no, id, first_name, last_name, sex, dob, address_line_1, city, zip, phone,
  emergency_contact_name, emergency_contact_phone, payer_name, member_id, group_number, dx,
  referring_physician_name, referral_reason, acuity, status, ends_bday, primary_np,
  height_cm, weight_kg, weight_step, sbp, dbp, hr, rr, spo2, caregiver, medications
) VALUES
  (1, 'd0000000-0000-4000-8000-000000000201', 'Harold', 'Jennings', 'M', DATE '1938-02-14',
   '418 Larkspur Ln', 'Columbus', '43214', '614-555-0101', 'Karen Jennings (daughter)', '614-555-0151',
   'Traditional Medicare (Part B)', '0EK4TN2WA17', NULL, ARRAY['C34.90', 'G89.3', 'Z66'],
   'Samuel Greer, MD (oncology)', 'Symptom management in stage IV lung cancer',
   'critical', 'active', NULL, 'np_delgado', 178, 64.0, 0.9, 112, 68, 96, 22, 91, 'his daughter',
   ARRAY['Morphine ER 15 mg PO every 12 hours', 'Morphine IR 5 mg PO every 4 hours as needed for pain or breathlessness',
         'Senna 8.6 mg 2 tablets PO at bedtime', 'Oxygen 2 L/min by nasal cannula']),
  (2, 'd0000000-0000-4000-8000-000000000202', 'Dolores', 'Whitaker', 'F', DATE '1941-07-03',
   '76 Hawthorne Ridge Ct', 'Westerville', '43081', '614-555-0102', 'Michael Whitaker (son)', '614-555-0152',
   'Traditional Medicare (Part B)', '0FJ7RH5KM28', NULL, ARRAY['I50.22', 'R06.02'],
   'Nadia Farouk, MD (cardiology)', 'Advanced heart failure with recurrent admissions',
   'high', 'active', NULL, 'np_raman', 160, 71.5, 0.8, 98, 60, 78, 20, 93, 'her son',
   ARRAY['Furosemide 40 mg PO twice daily', 'Carvedilol 3.125 mg PO twice daily',
         'Spironolactone 12.5 mg PO daily', 'Morphine IR 2.5 mg PO every 4 hours as needed for breathlessness']),
  (3, 'd0000000-0000-4000-8000-000000000203', 'Raymond', 'Castillo', 'M', DATE '1949-11-21',
   '3905 Briar Knoll Dr', 'Grove City', '43123', '614-555-0103', 'Rosa Castillo (wife)', '614-555-0153',
   'Humana Healthy Horizons of Ohio', 'H41021337', NULL, ARRAY['J44.1', 'R06.02'],
   'Owen Mackey, MD (pulmonology)', 'Severe COPD with frequent exacerbations',
   'medium', 'discharged', -15, 'np_delgado', 170, 68.0, 0.3, 128, 76, 88, 20, 92, 'his wife',
   ARRAY['Fluticasone/umeclidinium/vilanterol 100/62.5/25 mcg 1 inhalation daily',
         'Albuterol HFA 2 puffs every 4 hours as needed']),
  (4, 'd0000000-0000-4000-8000-000000000204', 'Evelyn', 'Hartwell', 'F', DATE '1933-05-30',
   '112 Linden Crest Rd', 'Worthington', '43085', '614-555-0104', 'Linda Hartwell-Price (daughter)', '614-555-0154',
   'Traditional Medicare (Part B)', '0CX2PD8GT35', NULL, ARRAY['G30.9', 'R63.4', 'Z66'],
   'Ruth Castellano, MD (primary care)', 'Advanced dementia with declining intake',
   'medium', 'active', NULL, 'np_raman', 155, 52.0, 0.5, 118, 64, 72, 16, 96, 'her daughter',
   ARRAY['Acetaminophen 650 mg PO every 6 hours as needed for pain', 'Mirtazapine 7.5 mg PO at bedtime']),
  (5, 'd0000000-0000-4000-8000-000000000205', 'Gerald', 'Novak', 'M', DATE '1956-09-12',
   '6620 Stoneway Ln', 'Dublin', '43017', '614-555-0105', 'Janet Novak (wife)', '614-555-0155',
   'Aetna', 'W410210556', '0184330', ARRAY['G12.21', 'R13.10'],
   'Victor Aung, MD (neurology)', 'ALS with progressing bulbar symptoms',
   'high', 'active', NULL, 'np_delgado', 183, 72.0, 1.1, 124, 78, 84, 20, 94, 'his wife',
   ARRAY['Riluzole 50 mg PO twice daily', 'Glycopyrrolate 1 mg PO three times daily', 'Baclofen 10 mg PO three times daily']),
  (6, 'd0000000-0000-4000-8000-000000000206', 'Loretta', 'Simmons', 'F', DATE '1944-01-25',
   '1488 Pheasant Run Ct', 'Reynoldsburg', '43068', '614-555-0106', 'Denise Simmons (daughter)', '614-555-0156',
   'Traditional Medicare (Part B)', '0HW9AE3RN46', NULL, ARRAY['N18.5', 'R53.83'],
   'Irene Sato, MD (nephrology)', 'Conservative management of stage 5 kidney disease',
   'high', 'active', NULL, 'np_raman', 163, 66.0, 0.7, 146, 82, 76, 18, 97, 'her daughter',
   ARRAY['Sertraline 25 mg PO daily', 'Ondansetron 4 mg PO every 8 hours as needed for nausea',
         'Sodium bicarbonate 650 mg PO twice daily']),
  (7, 'd0000000-0000-4000-8000-000000000207', 'Walter', 'Hughes', 'M', DATE '1946-06-08',
   '905 Cider Mill Rd', 'Gahanna', '43230', '614-555-0107', 'Margaret Hughes (wife)', '614-555-0157',
   'Traditional Medicare (Part B)', '0MA5KQ1VD53', NULL, ARRAY['C25.9', 'G89.3', 'R63.4'],
   'Samuel Greer, MD (oncology)', 'Uncontrolled pain in metastatic pancreatic cancer',
   'critical', 'deceased', -9, 'np_delgado', 175, 58.0, 1.6, 104, 62, 102, 20, 95, 'his wife',
   ARRAY['Oxycodone ER 20 mg PO every 12 hours', 'Oxycodone IR 5-10 mg PO every 3 hours as needed for pain',
         'Senna 8.6 mg 2 tablets PO twice daily', 'Polyethylene glycol 17 g PO daily']),
  (8, 'd0000000-0000-4000-8000-000000000208', 'Frances', 'Oduya', 'F', DATE '1952-10-17',
   '2731 Marchmont St', 'Columbus', '43207', '614-555-0108', 'Grace Oduya (sister)', '614-555-0158',
   'CareSource Ohio', 'CS410208314', NULL, ARRAY['K70.31'],
   'Daniel Mbeki, MD (hepatology)', 'Refractory ascites in decompensated cirrhosis',
   'medium', 'active', NULL, 'np_raman', 165, 69.0, 0.6, 102, 58, 88, 20, 95, 'her sister',
   ARRAY['Lactulose 20 g PO twice daily', 'Rifaximin 550 mg PO twice daily', 'Spironolactone 50 mg PO daily']),
  (9, 'd0000000-0000-4000-8000-000000000209', 'Leonard', 'Petrakis', 'M', DATE '1940-12-02',
   '2150 Tremont Park Ct', 'Upper Arlington', '43221', '614-555-0109', 'Helena Petrakis (wife)', '614-555-0159',
   'Traditional Medicare (Part B)', '0TR3GF6YP64', NULL, ARRAY['G20.A1', 'R26.89'],
   'Victor Aung, MD (neurology)', 'Advanced Parkinson disease with falls',
   'medium', 'active', NULL, 'np_delgado', 172, 63.0, 0.4, 132, 74, 70, 16, 97, 'his wife',
   ARRAY['Carbidopa/levodopa 25/100 mg 1.5 tablets PO four times daily', 'Midodrine 2.5 mg PO three times daily']),
  (10, 'd0000000-0000-4000-8000-000000000210', 'Marjorie', 'Kessler', 'F', DATE '1958-03-19',
   '5302 Wyndcliff Dr', 'Hilliard', '43026', '614-555-0110', 'Robert Kessler (husband)', '614-555-0160',
   'Aetna', 'W410210583', '0277415', ARRAY['C50.912', 'G89.3', 'Z66'],
   'Claire Donnelly, MD (oncology)', 'Bone pain in metastatic breast cancer',
   'critical', 'active', NULL, 'np_raman', 162, 55.0, 0.9, 116, 72, 94, 18, 96, 'her husband',
   ARRAY['Hydromorphone 2 mg PO every 4 hours as needed for pain', 'Dexamethasone 4 mg PO daily',
         'Senna 8.6 mg 2 tablets PO at bedtime', 'Lorazepam 0.5 mg PO at bedtime as needed for anxiety']),
  (11, 'd0000000-0000-4000-8000-000000000211', 'Clarence', 'Boyd', 'M', DATE '1936-08-27',
   '489 Otterbrook Way', 'Westerville', '43081', '614-555-0111', 'Dorothy Boyd (wife)', '614-555-0161',
   'Traditional Medicare (Part B)', '0NP8WJ2HC75', NULL, ARRAY['I69.354'],
   'Ruth Castellano, MD (primary care)', 'Caregiver support after stroke',
   'low', 'active', NULL, 'np_delgado', 176, 74.0, 0.2, 138, 80, 68, 16, 97, 'his wife',
   ARRAY['Acetaminophen 1000 mg PO three times daily', 'Baclofen 5 mg PO three times daily', 'Aspirin 81 mg PO daily']),
  (12, 'd0000000-0000-4000-8000-000000000212', 'Eugene', 'Albright', 'M', DATE '1943-04-11',
   '4411 Sycamore Bend Dr', 'Grove City', '43123', '614-555-0112', 'Thomas Reyes (partner)', '614-555-0162',
   'Traditional Medicare (Part B)', '0DU6CM4XE82', NULL, ARRAY['C61', 'G89.3'],
   'Claire Donnelly, MD (oncology)', 'Pain in metastatic prostate cancer',
   'high', 'active', NULL, 'np_raman', 180, 70.0, 0.7, 128, 76, 80, 16, 97, 'his partner',
   ARRAY['Enzalutamide 160 mg PO daily', 'Leuprolide 22.5 mg IM every 3 months',
         'Oxycodone IR 5 mg PO every 4 hours as needed for pain', 'Naproxen 250 mg PO twice daily with food']),
  (13, 'd0000000-0000-4000-8000-000000000213', 'Shirley', 'Tanaka', 'F', DATE '1950-07-29',
   '3876 Fallow Glen Ct', 'Hilliard', '43026', '614-555-0113', 'Emily Tanaka (daughter)', '614-555-0163',
   'Humana Healthy Horizons of Ohio', 'H41021395', NULL, ARRAY['J84.10', 'R06.02'],
   'Owen Mackey, MD (pulmonology)', 'Breathlessness in idiopathic pulmonary fibrosis',
   'medium', 'active', NULL, 'np_delgado', 158, 51.0, 0.5, 118, 70, 92, 24, 90, 'her neighbor',
   ARRAY['Oxygen 3 L/min by nasal cannula', 'Morphine IR 2.5 mg PO every 4 hours as needed for breathlessness',
         'Benzonatate 100 mg PO three times daily as needed for cough']),
  (14, 'd0000000-0000-4000-8000-000000000214', 'Beatrice', 'Morrow', 'F', DATE '1931-10-05',
   '167 Wren Hollow Pl', 'Gahanna', '43230', '614-555-0114', 'Alicia Morrow (granddaughter)', '614-555-0164',
   'CareSource Ohio', 'CS410208371', NULL, ARRAY['R62.7', 'R63.4'],
   'Ruth Castellano, MD (primary care)', 'Adult failure to thrive',
   'low', 'active', NULL, 'np_raman', 150, 43.5, 0.4, 108, 62, 74, 16, 96, 'her granddaughter',
   ARRAY['Mirtazapine 7.5 mg PO at bedtime', 'Oral nutrition supplement 1 bottle PO twice daily',
         'Vitamin D3 1000 IU PO daily']);

-- Payers are matched by exact name, never by id: the ids differ between
-- databases, the names are the seeds' contract. A name matching no active
-- payer, or more than one, stops the run here rather than writing a patient
-- with no payer or twice.
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT p.payer_name, ', ') INTO bad
    FROM demo_seed_patient p
   WHERE (SELECT count(*) FROM payer py WHERE py.name = p.payer_name AND py.active) <> 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'demo seed: not exactly one active payer named %', bad;
  END IF;
END $$;

-- What each patient's notes say. Per visit, the seed adds what changed
-- (weight, PPS, how the visit was held); these are the parts a clinician
-- carries from visit to visit. assessment_and_plan is numbered by problem,
-- one paragraph each, as the template's help text asks. acp_summary is the
-- advance care planning note, for the two patients who had that visit.
CREATE TEMP TABLE demo_seed_patient_note (
  patient_no           INT PRIMARY KEY,
  chief_complaint      TEXT NOT NULL,
  hpi                  TEXT NOT NULL,
  social_history       TEXT NOT NULL,
  code_status          TEXT NOT NULL,
  physical_exam        TEXT NOT NULL,
  goals_of_care        TEXT NOT NULL,
  assessment_and_plan  TEXT NOT NULL,
  acp_summary          TEXT
) ON COMMIT DROP;

INSERT INTO demo_seed_patient_note (
  patient_no, chief_complaint, hpi, social_history, code_status, physical_exam,
  goals_of_care, assessment_and_plan, acp_summary
) VALUES
  (1, 'Increasing shortness of breath and right chest wall pain.',
   '88-year-old man with stage IV non-small cell lung cancer who declined further systemic therapy in the spring. Breathless with minimal exertion; chest wall pain controlled on long-acting morphine with breakthrough doses about twice a day.',
   'Widowed; lives with his daughter, who is his main caregiver. Retired machinist. Quit smoking in 1990. No alcohol.',
   'DNR/DNI. Ohio DNR Comfort Care order signed and kept on the refrigerator.',
   'Thin, alert, speaks in short sentences. Diminished breath sounds at the right base, no accessory muscle use at rest. Mild bilateral ankle edema. Tender right lateral chest wall.',
   'Wants to stay at home and avoid another hospital stay; his daughter agrees. Would accept hospice when walking to the bathroom is no longer safe.',
   '1. Cancer-related pain: continue morphine ER 15 mg every 12 hours and morphine IR 5 mg every 4 hours as needed. 2. Breathlessness: fan, pursed-lip breathing, morphine IR as above, home oxygen 2 L. 3. Constipation prevention: senna 2 tablets at bedtime. 4. Hospice readiness reviewed at every visit.',
   NULL),
  (2, 'Fatigue and orthopnea; sleeping in a recliner.',
   '85-year-old woman with chronic systolic heart failure, ejection fraction 20%, admitted twice this year for decompensation. Not a candidate for advanced therapies. Three-pillow orthopnea; tired after dressing.',
   'Lives alone in a single-story home. Her son visits daily and fills a weekly pill organizer. Retired school librarian.',
   'DNR/DNI. Wants ICD shocks turned off; her cardiologist is aware.',
   'Sitting upright, conversant. JVP raised to the angle of the jaw. Bibasilar crackles. 2+ pitting edema to mid-shin on both sides.',
   'Wants to stay out of the hospital and be at her granddaughter''s wedding in the fall. Prefers diuretic changes at home to admission.',
   '1. Heart failure: furosemide 40 mg twice daily; call if weight rises 1 kg overnight. 2. Breathlessness at night: morphine IR 2.5 mg as needed. 3. ICD deactivation: coordinating with cardiology. 4. Caregiver support: social work reviewing home health aide hours.',
   NULL),
  (3, 'Breathlessness after a recent COPD exacerbation.',
   '76-year-old man with severe COPD, FEV1 32% predicted, referred after his third exacerbation needing steroids this year. Back to his usual activity around the house.',
   'Lives with his wife in a two-story home. Stopped smoking five years ago. Retired bus driver.',
   'Full code. Would reconsider intubation after any further ICU admission; conversation ongoing.',
   'Barrel chest, prolonged expiration, scattered expiratory wheezes, no distress at rest.',
   'Wants to keep gardening and to avoid the ICU. Agreed to return to his pulmonologist and primary care physician once stable.',
   '1. COPD: continue triple inhaler and rescue albuterol; action plan reviewed with his wife. 2. Anxiety with breathlessness: breathing techniques; he declines medication. 3. Discharge from the palliative program once stable across two visits.',
   NULL),
  (4, 'Eating less and spending more of the day in bed.',
   '93-year-old woman with advanced Alzheimer dementia, FAST stage 7a, speaking only single words. Her daughter reports she now eats about half of each meal and sleeps most of the day.',
   'Lives with her daughter and son-in-law; a private-duty aide comes four hours on weekdays. Former church organist.',
   'DNR/DNI. No feeding tube, per her advance directive.',
   'Frail, in bed, opens eyes to voice, does not follow commands. Skin intact over sacrum and heels. Contractures of both knees.',
   'Comfort-focused care at home. The family declines hospital transfer for infections and has chosen careful hand feeding.',
   '1. Advanced dementia: comfort feeding only, aspiration precautions. 2. Skin: turning every 2 hours; pressure-relief mattress in place. 3. Evening agitation: music and familiar routine before any medication. 4. Hospice eligibility reviewed with her daughter.',
   NULL),
  (5, 'Progressive weakness and trouble swallowing.',
   '70-year-old man with ALS diagnosed 18 months ago, now in a power wheelchair. Bulbar symptoms are progressing, with coughing at meals. Uses BiPAP overnight.',
   'Married; his wife is his caregiver. Retired civil engineer. Two adult children in Cincinnati. Uses an eye-gaze tablet for longer conversations.',
   'DNR/DNI. Declines tracheostomy. BiPAP continued for comfort.',
   'Alert, dysarthric. Tongue fasciculations, marked wasting of both hands. Weak cough. Lungs clear.',
   'Wants to remain at home, keep talking with his family, and avoid tracheostomy or long-term ventilation.',
   '1. Dysphagia: speech therapy re-evaluation; feeding tube discussed and declined for now. 2. Sialorrhea: glycopyrrolate. 3. Breathing: continue nightly BiPAP, review daytime use. 4. Caregiver strain: social work visit arranged.',
   'Reviewed his wishes on tracheostomy, mechanical ventilation and artificial nutrition. He does not want a tracheostomy or permanent ventilation and will use BiPAP only for comfort. Named his wife as health care power of attorney; Ohio Health Care Power of Attorney and Living Will completed and copies left in the home.'),
  (6, 'Fatigue and itching.',
   '82-year-old woman with stage 5 chronic kidney disease, eGFR 9, who chose conservative kidney management over dialysis. More tired, itching all over, eating poorly.',
   'Lives with her husband, who has early memory loss; their daughter lives nearby and coordinates care. Retired nurse.',
   'DNR/DNI. Does not want dialysis.',
   'Pale and tired. Excoriations on both forearms. No asterixis. Trace ankle edema.',
   'Wants time at home with her husband, without dialysis or hospital stays; understands time may be short.',
   '1. Conservative kidney management: low-potassium diet as tolerated; labs only when they would change care. 2. Pruritus: sertraline and emollients. 3. Nausea: ondansetron as needed. 4. Hospice conversation planned with her daughter present.',
   NULL),
  (7, 'Abdominal pain through to the back, and weight loss.',
   '80-year-old man with metastatic pancreatic adenocarcinoma with liver metastases, no longer a candidate for chemotherapy. Pain escalating over two weeks, 7 to 8 out of 10 at worst. Eating very little.',
   'Lives with his wife of 55 years; their son lives next door. Retired farmer. Methodist; his pastor visits weekly.',
   'DNR/DNI. Ohio DNR Comfort Care order in the home.',
   'Cachectic, icteric sclerae. Epigastric tenderness; liver edge 4 cm below the costal margin. No peritoneal signs.',
   'Comfort at home; his wife hopes he can die at home. The family is open to hospice.',
   '1. Cancer pain: oxycodone ER 20 mg every 12 hours, oxycodone IR 5-10 mg every 3 hours as needed; celiac plexus block declined. 2. Constipation: senna and polyethylene glycol. 3. Anorexia: small frequent meals, no appetite stimulant. 4. Hospice referral discussed with the family.',
   NULL),
  (8, 'Abdominal swelling and shortness of breath.',
   '73-year-old woman with alcohol-associated cirrhosis, MELD 24, and diuretic-refractory ascites needing paracentesis every two weeks. Abstinent for three years. Not a transplant candidate.',
   'Lives with her sister. Attends a weekly recovery group by phone. Retired home health aide.',
   'DNR. Would accept hospital admission for symptom control.',
   'Tense, distended abdomen with shifting dullness. Mild scleral icterus. Spider angiomata on the chest. No asterixis.',
   'Wants to avoid ICU care and keep going to church; open to an indwelling peritoneal catheter to cut down hospital trips.',
   '1. Refractory ascites: tunneled peritoneal catheter to be discussed with hepatology. 2. Hepatic encephalopathy prevention: lactulose to two or three soft stools a day, rifaximin. 3. Abstinence: recovery support continues. 4. Symptoms reviewed at each visit.',
   NULL),
  (9, 'Falls and freezing when walking.',
   '85-year-old man with Parkinson disease for 12 years, now freezing often, with two falls this month without injury and new daytime sleepiness.',
   'Lives with his wife in a condo with an elevator; his daughter visits at weekends. Retired restaurant owner.',
   'DNR/DNI, after discussion with his wife and daughter.',
   'Masked face, resting tremor of the right hand, rigidity in all limbs, shuffling gait with freezing at doorways. Orthostatic drop of 20 mmHg.',
   'Wants to stay in his own home and keep attending Sunday services; accepts a wheelchair for outings.',
   '1. Parkinson disease: continue carbidopa/levodopa; neurology aware of wearing-off. 2. Falls: home safety evaluation by physical therapy; walker at all times. 3. Orthostatic hypotension: compression stockings, slow position changes, midodrine. 4. Support for his wife as caregiver.',
   NULL),
  (10, 'Bone pain in the back and hips.',
   '68-year-old woman with metastatic left breast cancer to bone and liver, progressing on third-line therapy; oncology has stopped treatment. Back and hip pain limit walking.',
   'Married; lives with her husband, a retired teacher. Two sons in Columbus. Former accountant.',
   'DNR/DNI.',
   'Uncomfortable changing position. Tender over the lower thoracic spine and left hip. No focal neurological deficit. Liver palpable.',
   'Wants to be comfortable enough to attend her son''s graduation; would accept hospice after that.',
   '1. Bone pain: hydromorphone 2 mg every 4 hours as needed; radiation oncology consult for palliative radiation to the left hip. 2. Constipation: senna at bedtime. 3. Anxiety: lorazepam 0.5 mg at bedtime as needed. 4. Spinal cord compression warning signs taught.',
   'Discussed what matters most as her disease progresses. She wants comfort-focused care, no CPR or ICU admission, and to die at home if her symptoms can be managed there. Her husband was present and agrees. Ohio DNR Comfort Care order signed; timing of hospice revisited.'),
  (11, 'Routine follow-up after stroke; his wife is tired.',
   '90-year-old man with left hemiplegia after a right middle cerebral artery stroke two years ago. Stable, wheelchair-dependent, occasional left shoulder pain. His wife reports exhaustion.',
   'Lives with his wife, 86, who gives most of his care; a home health aide comes three mornings a week. Army veteran.',
   'DNR/DNI.',
   'Alert and oriented. Left arm and leg strength 2/5 with spastic tone. Left shoulder subluxation, painful on passive movement. Skin intact.',
   'Both want him at home with more help there, rather than a move to a nursing facility.',
   '1. Post-stroke shoulder pain: scheduled acetaminophen, positioning sling. 2. Spasticity: continue baclofen. 3. Caregiver support: VA aid and attendance application with social work. 4. Function unchanged; current plan continues.',
   NULL),
  (12, 'Hip and rib pain; fatigue.',
   '83-year-old man with castration-resistant prostate cancer metastatic to bone. PSA rising on enzalutamide; oncology is discussing further options. Pain in the right hip and ribs, worse at night.',
   'Lives with his partner. Retired postal carrier. Fishes with his grandson when he can.',
   'Full code for now; wants to talk it through before deciding.',
   'Walks with a cane. Tender over the right iliac crest and left lower ribs. No spinal tenderness. Neurologically intact.',
   'Wants to keep fishing and stay independent; still weighing further treatment.',
   '1. Bone pain: oxycodone IR 5 mg every 4 hours as needed, naproxen with food. 2. Fatigue: pacing activities. 3. Advance care planning visit booked to talk through code status. 4. Radium-223 being discussed with oncology.',
   NULL),
  (13, 'Breathless with very little activity; dry cough.',
   '76-year-old woman with idiopathic pulmonary fibrosis on home oxygen 3 L at rest; stopped antifibrotic therapy because of GI side effects. Breathless walking to the mailbox.',
   'Widowed; lives alone, and a neighbor checks on her daily. Retired seamstress. Her daughter in Seattle calls every evening.',
   'DNR/DNI. Does not want intubation.',
   'Full sentences at rest on 3 L. Fine bibasilar crackles. Digital clubbing. No edema.',
   'Wants to stay independent in her own home as long as she can; would consider moving in with her daughter later.',
   '1. Breathlessness: morphine IR 2.5 mg as needed, a fan, oxygen up to 4 L on exertion. 2. Cough: benzonatate. 3. Safety: medical alert pendant arranged. 4. Living arrangements revisited as her needs grow.',
   NULL),
  (14, 'Weight loss and weakness.',
   '94-year-old woman with adult failure to thrive: 8 kg lost over six months, now needing help to bathe and dress. Her primary care workup found no single dominant cause.',
   'Lives with her granddaughter; attends an adult day program twice a week. Former telephone operator.',
   'DNR/DNI.',
   'Frail, temporal wasting, oriented to person and place. Poor dentition. Lungs clear. Sacral skin intact.',
   'Wants to stay with her granddaughter and enjoy her meals; no hospital stays.',
   '1. Failure to thrive: liberalized diet, favorite foods, oral nutrition supplement twice daily. 2. Function: home health physical therapy for transfers. 3. Mood: screened positive for low mood; mirtazapine at bedtime. 4. Hospice eligibility to be reviewed at the next visit.',
   NULL);

-- Visits: forty signed over the last six weeks by the three billing
-- clinicians, and twelve still to come. bday places each on the calendar
-- above. Minutes sit inside each code's time band (code.typical_minutes,
-- 0091): 99344 60+, 99345 75+, 99348 30+, 99349 40+, 99350 60+, 99417 each
-- 15 minutes past 99350's 60 on a commercial plan, 99497 16-45 minutes of
-- advance care planning. Two are telehealth, two are advance care planning.
-- pps and pain are what the home visit recorded; PPS falls, as it does.
--
-- Every signed visit carries a bill, because signing drafts one. The bills
-- run oldest to newest: 29 paid, 1 partly paid and 2 denied, then 6 with the
-- payer, then the 2 newest still in draft.
CREATE TEMP TABLE demo_seed_visit (
  visit_no           INT PRIMARY KEY,
  patient_no         INT NOT NULL,
  clinician          TEXT NOT NULL,
  bday               INT NOT NULL,
  at_time            TIME NOT NULL,
  visit_type         TEXT NOT NULL,
  minutes            INT,
  acp_minutes        INT,
  prolonged_minutes  INT,
  cpt                TEXT[],
  bill_status        TEXT,
  pps                INT,
  pain               INT
) ON COMMIT DROP;

INSERT INTO demo_seed_visit (
  visit_no, patient_no, clinician, bday, at_time, visit_type,
  minutes, acp_minutes, prolonged_minutes, cpt, bill_status, pps, pain
) VALUES
  ( 1,  1, 'director',   -30, '09:30', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           40, 5),
  ( 2,  2, 'np_raman',   -29, '10:00', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'paid',           50, 3),
  ( 3,  5, 'director',   -28, '13:00', 'new_patient_home',         80,  0,  0, ARRAY['99345'], 'paid',           50, 2),
  ( 4,  6, 'np_raman',   -27, '09:00', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           50, 4),
  ( 5,  3, 'np_delgado', -27, '14:00', 'established_patient_home', 35,  0,  0, ARRAY['99348'], 'paid',           60, 2),
  ( 6,  9, 'np_delgado', -26, '10:30', 'established_patient_home', 42,  0,  0, ARRAY['99349'], 'paid',           50, 3),
  ( 7,  7, 'director',   -25, '09:00', 'new_patient_home',         90,  0,  0, ARRAY['99345'], 'paid',           40, 7),
  ( 8, 12, 'np_raman',   -25, '13:30', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'paid',           50, 4),
  ( 9,  4, 'np_raman',   -24, '11:00', 'established_patient_home', 30,  0,  0, ARRAY['99348'], 'paid',           40, 1),
  (10,  8, 'np_raman',   -23, '10:00', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           60, 3),
  (11, 11, 'np_delgado', -23, '14:30', 'established_patient_home', 35,  0,  0, ARRAY['99348'], 'paid',           40, 2),
  (12, 10, 'director',   -22, '10:00', 'new_patient_home',         85,  0,  0, ARRAY['99345'], 'paid',           40, 6),
  (13,  1, 'np_delgado', -21, '09:30', 'established_patient_home', 50,  0,  0, ARRAY['99349'], 'paid',           40, 6),
  (14, 13, 'np_delgado', -20, '13:00', 'new_patient_home',         65,  0,  0, ARRAY['99344'], 'paid',           50, 2),
  (15,  5, 'np_delgado', -20, '09:00', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           50, 2),
  (16,  2, 'np_raman',   -19, '15:00', 'telehealth',               35,  0,  0, ARRAY['99348'], 'paid',           NULL, NULL),
  (17,  7, 'director',   -18, '10:30', 'established_patient_home', 65,  0,  0, ARRAY['99350'], 'paid',           30, 8),
  (18, 14, 'np_raman',   -18, '13:30', 'new_patient_home',         60,  0,  0, ARRAY['99344'], 'paid',           40, 2),
  (19,  6, 'np_raman',   -17, '09:30', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'paid',           50, 4),
  (20, 12, 'director',   -16, '11:00', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           50, 5),
  (21,  3, 'np_delgado', -16, '14:00', 'established_patient_home', 30,  0,  0, ARRAY['99348'], 'paid',           60, 1),
  (22, 10, 'np_raman',   -15, '10:00', 'established_patient_home', 60,  0,  0, ARRAY['99350'], 'paid',           40, 7),
  (23,  8, 'np_raman',   -15, '13:30', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'paid',           50, 3),
  (24,  5, 'director',   -14, '10:00', 'advance_care_planning',    40, 40,  0, ARRAY['99497'], 'paid',           NULL, NULL),
  (25, 11, 'np_delgado', -14, '13:00', 'established_patient_home', 60,  0,  0, ARRAY['99350'], 'denied',         40, 2),
  (26, 13, 'np_delgado', -13, '10:00', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'partially_paid', 50, 3),
  (27,  7, 'director',   -12, '09:00', 'established_patient_home', 70,  0,  0, ARRAY['99350'], 'paid',           20, 8),
  (28, 14, 'np_raman',   -12, '14:00', 'established_patient_home', 30,  0,  0, ARRAY['99348'], 'denied',         40, 1),
  (29,  1, 'np_delgado', -11, '09:30', 'established_patient_home', 60,  0,  0, ARRAY['99350'], 'paid',           30, 7),
  (30,  9, 'np_delgado', -11, '13:30', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'paid',           50, 3),
  (31,  4, 'np_raman',   -10, '10:30', 'established_patient_home', 30,  0,  0, ARRAY['99348'], 'paid',           40, 1),
  (32,  6, 'director',   -10, '14:00', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'paid',           40, 5),
  (33, 10, 'np_raman',    -8, '11:00', 'telehealth',               40,  0,  0, ARRAY['99349'], 'submitted',      NULL, NULL),
  (34, 12, 'np_raman',    -7, '09:30', 'established_patient_home', 45,  0,  0, ARRAY['99349'], 'submitted',      40, 5),
  (35,  2, 'np_raman',    -6, '13:00', 'established_patient_home', 60,  0,  0, ARRAY['99350'], 'submitted',      40, 4),
  (36, 13, 'np_delgado',  -5, '10:00', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'submitted',      50, 3),
  (37, 10, 'director',    -4, '14:00', 'advance_care_planning',    35, 35,  0, ARRAY['99497'], 'submitted',      NULL, NULL),
  (38,  8, 'np_delgado',  -3, '11:00', 'established_patient_home', 40,  0,  0, ARRAY['99349'], 'submitted',      50, 4),
  (39,  5, 'np_delgado',  -2, '09:30', 'established_patient_home', 80,  0, 20, ARRAY['99350', '99417'], 'draft', 40, 3),
  (40, 14, 'np_raman',    -1, '13:30', 'established_patient_home', 35,  0,  0, ARRAY['99348'], 'draft',          40, 2),
  -- Still to come. Each clinician has a visit in the next four business
  -- days and in the last four, so the current week's grid shows all three
  -- whatever day the seed ran. None for the discharged or deceased patient.
  (41,  1, 'np_delgado',   1, '09:30', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (42,  6, 'np_raman',     1, '13:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (43, 11, 'director',     2, '10:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (44,  9, 'np_delgado',   2, '14:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (45,  4, 'np_raman',     3, '10:30', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (46, 12, 'director',     3, '13:30', 'advance_care_planning',    NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (47, 13, 'np_delgado',   4, '09:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (48,  2, 'np_raman',     4, '15:00', 'telehealth',               NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (49,  8, 'np_raman',     5, '10:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (50, 10, 'director',     6, '11:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (51,  5, 'np_delgado',   7, '13:00', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (52, 14, 'np_raman',     8, '09:30', 'established_patient_home', NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- Each visit resolved to real times (Eastern), ids, and the weight its home
-- visit recorded: the patient's baseline less weight_step per home visit.
CREATE TEMP TABLE demo_seed_visit_row ON COMMIT DROP AS
SELECT x.*,
       CASE WHEN x.signed THEN x.starts_at + make_interval(mins => x.minutes + 90) END AS signed_at,
       CASE WHEN NOT x.signed THEN 'scheduled'
            WHEN x.bill_status = 'draft' THEN 'pending_billing'
            ELSE 'billed' END AS status,
       CASE WHEN x.signed THEN CASE WHEN x.is_telehealth THEN '10' ELSE '12' END END AS pos_code,
       CASE WHEN x.signed AND x.in_person
            THEN round(x.base_weight - x.weight_step * (x.seq - 1), 1) END AS weight_kg
  FROM (
    SELECT v.visit_no,
           ('d0000000-0000-4000-8000-' || lpad((300 + v.visit_no)::text, 12, '0'))::uuid AS id,
           v.patient_no, p.id AS patient_id,
           u.id AS clinician_id, u.credential,
           v.visit_type, v.bday,
           v.visit_type IN ('new_patient_home', 'established_patient_home') AS in_person,
           v.visit_type = 'telehealth' AS is_telehealth,
           v.bday < 0 AS signed,
           (d.day + v.at_time) AT TIME ZONE 'America/New_York' AS starts_at,
           d.day AS dos,
           v.minutes, v.acp_minutes, v.prolonged_minutes, v.cpt, v.bill_status, v.pps, v.pain,
           p.weight_kg AS base_weight, p.weight_step,
           row_number() OVER (
             PARTITION BY v.patient_no,
                          (v.bday < 0 AND v.visit_type IN ('new_patient_home', 'established_patient_home'))
             ORDER BY v.bday) AS seq
      FROM demo_seed_visit v
      JOIN demo_seed_day d ON d.bday = v.bday
      JOIN demo_seed_patient p ON p.patient_no = v.patient_no
      JOIN demo_seed_user u ON u.user_key = v.clinician
  ) x;

-- A visit whose day is missing from the calendar would be dropped by the
-- join above without a word; a past visit with no codes, or a future one
-- with a bill, would be written inconsistent. Stop on either.
DO $$
DECLARE
  n INT;
BEGIN
  SELECT (SELECT count(*) FROM demo_seed_visit) - (SELECT count(*) FROM demo_seed_visit_row) INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'demo seed: % visit(s) fall outside the business-day calendar', n;
  END IF;

  SELECT count(*) INTO n FROM demo_seed_visit_row
   WHERE signed <> (bill_status IS NOT NULL AND cpt IS NOT NULL AND minutes IS NOT NULL);
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % visit(s) are signed without codes and a bill, or scheduled with them', n;
  END IF;

  SELECT count(*) INTO n
    FROM demo_seed_visit v JOIN demo_seed_patient p ON p.patient_no = v.patient_no
   WHERE p.ends_bday IS NOT NULL AND v.bday >= p.ends_bday;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % visit(s) fall after the patient was discharged or died', n;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- The org, and what signup and onboarding would have written for it.
-- ----------------------------------------------------------------------------

-- plan_tier 'org' (25 seats) rather than 'team': a team plan has 5 seats and
-- this roster alone is 8, so the Team page would refuse the invite that gives
-- whoever runs the demo a login in their own name (R20 decision 1). A demo
-- org that has since been retired (deleted_at) stays retired.
INSERT INTO org (id, name, slug, plan_tier, baa_signed_at, primary_contact_email, status, daily_visit_capacity)
VALUES ('d0000000-0000-4000-8000-000000000001', 'Pallio Demo Palliative Care', 'pallio-demo-palliative-care',
        'org', now(), 'colleen.brandt@demo.pallio.io', 'active', 6)
ON CONFLICT (id) DO UPDATE SET
  name                  = EXCLUDED.name,
  slug                  = EXCLUDED.slug,
  plan_tier             = EXCLUDED.plan_tier,
  primary_contact_email = EXCLUDED.primary_contact_email,
  status                = 'active',
  daily_visit_capacity  = EXCLUDED.daily_visit_capacity,
  baa_signed_at         = COALESCE(org.baa_signed_at, EXCLUDED.baa_signed_at),
  updated_at            = now();

-- The superbill reads the billing NPI from here, not from org. Every step
-- complete, as a practice that finished onboarding would be.
INSERT INTO onboarding_status (
  org_id, profile_complete, states_complete, payers_complete, cpt_codes_complete, rulebook_complete,
  active_states, active_payer_ids, org_type, npi, completed_at
)
SELECT 'd0000000-0000-4000-8000-000000000001', TRUE, TRUE, TRUE, TRUE, TRUE,
       ARRAY['OH'],
       ARRAY(SELECT py.id FROM payer py
              WHERE py.name IN (SELECT payer_name FROM demo_seed_patient)
              ORDER BY py.name),
       'palliative', '1234567893', now()
ON CONFLICT (org_id) DO UPDATE SET
  profile_complete   = TRUE,
  states_complete    = TRUE,
  payers_complete    = TRUE,
  cpt_codes_complete = TRUE,
  rulebook_complete  = TRUE,
  active_states      = EXCLUDED.active_states,
  active_payer_ids   = EXCLUDED.active_payer_ids,
  org_type           = EXCLUDED.org_type,
  npi                = EXCLUDED.npi,
  completed_at       = COALESCE(onboarding_status.completed_at, EXCLUDED.completed_at),
  updated_at         = now();

-- The home E/M family, advance care planning, prolonged service and the
-- G2211 add-on. 99343 is left out: CPT deleted it in 2023 (the Ohio Appendix
-- DD seeds record it as discontinued), and there has never been a 99346.
INSERT INTO org_cpt_code_set (org_id, cpt_code, active)
SELECT 'd0000000-0000-4000-8000-000000000001', c, TRUE
  FROM unnest(ARRAY['99341', '99342', '99344', '99345', '99347', '99348', '99349', '99350',
                    '99497', '99498', '99417', 'G2211', 'G0318']) AS c
ON CONFLICT (org_id, cpt_code) DO UPDATE SET active = TRUE;

-- DEFAULT_VISIT_TYPES (lib/features/visits/visit-types.service.ts), as
-- signup gives every new org. The drift spec checks the two agree and that
-- every visit above uses one of these.
-- 'telehealth' is an established visit with the modality forced on, not a
-- band of its own (audit R22, 0099 — whose CHECK refuses 'telehealth').
-- No 'inpatient_consult': nothing can code it, so signup stopped seeding it
-- (audit R18, 0100).
INSERT INTO org_visit_type (org_id, slug, label, coding_basis, is_telehealth, sort_order, active) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'new_patient_home',         'New patient — home',               'new_patient_home',         FALSE, 10, TRUE),
  ('d0000000-0000-4000-8000-000000000001', 'established_patient_home', 'Established patient — home',       'established_patient_home', FALSE, 20, TRUE),
  ('d0000000-0000-4000-8000-000000000001', 'advance_care_planning',    'Advance care planning',            'advance_care_planning',    FALSE, 30, TRUE),
  ('d0000000-0000-4000-8000-000000000001', 'telehealth',               'Established patient — telehealth', 'established_patient_home', TRUE,  40, TRUE)
-- The unique index is on the lowered slug: org_visit_type_org_slug_idx.
ON CONFLICT (org_id, lower(slug)) DO UPDATE SET
  label         = EXCLUDED.label,
  coding_basis  = EXCLUDED.coding_basis,
  is_telehealth = EXCLUDED.is_telehealth,
  sort_order    = EXCLUDED.sort_order,
  active        = TRUE,
  updated_at   = now();

-- DEFAULT_VISIT_SERVICES (lib/features/visits/visit-services.service.ts), the
-- starter catalog signup gives every new org, so the document screen's
-- services picker is not empty.
INSERT INTO visit_service (org_id, name, description, category, cpt_hint, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'Symptom management',        'Pain, dyspnea, nausea, or other symptom assessment and treatment', 'clinical',          NULL,    10),
  ('d0000000-0000-4000-8000-000000000001', 'Medication reconciliation', 'Full medication review, deprescribing, adherence check',           'clinical',          NULL,    20),
  ('d0000000-0000-4000-8000-000000000001', 'Wound care',                'Assessment and dressing of pressure injuries or wounds',           'clinical',          NULL,    30),
  ('d0000000-0000-4000-8000-000000000001', 'Advance care planning',     'Goals-of-care discussion, POLST/MOLST, surrogate designation',     'psychosocial',      '99497', 40),
  ('d0000000-0000-4000-8000-000000000001', 'Psychosocial support',      'Emotional support for the patient; anxiety, depression, distress', 'psychosocial',      NULL,    50),
  ('d0000000-0000-4000-8000-000000000001', 'Caregiver education',       'Teaching the family how to provide care between visits',           'education',         NULL,    60),
  ('d0000000-0000-4000-8000-000000000001', 'Equipment/DME assessment',  'Hospital bed, oxygen, mobility aids — need and ordering',          'care_coordination', NULL,    70),
  ('d0000000-0000-4000-8000-000000000001', 'Referral coordination',     'Hospice, home health, specialist, or community-service referral',  'care_coordination', NULL,    80),
  ('d0000000-0000-4000-8000-000000000001', 'Nutrition support',         'Appetite, intake, feeding decisions',                              'clinical',          NULL,    90),
  ('d0000000-0000-4000-8000-000000000001', 'Spiritual care referral',   'Chaplaincy or the patient''s own faith community',                  'psychosocial',      NULL,    100)
ON CONFLICT (org_id, lower(name)) DO UPDATE SET
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  cpt_hint    = EXCLUDED.cpt_hint,
  sort_order  = EXCLUDED.sort_order,
  active      = TRUE,
  updated_at  = now();

-- ----------------------------------------------------------------------------
-- Staff.
-- ----------------------------------------------------------------------------

-- password_hash is never written here: NULL on first insert, untouched after.
INSERT INTO app_user (id, email, full_name, status)
SELECT id, email, full_name, 'active' FROM demo_seed_user
ON CONFLICT (id) DO UPDATE SET
  email     = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  status    = 'active';

INSERT INTO org_member (org_id, user_id, role, role_template, status, joined_at)
SELECT 'd0000000-0000-4000-8000-000000000001', id, member_role, role_template, 'active', now() - interval '180 days'
  FROM demo_seed_user
ON CONFLICT (org_id, user_id) DO UPDATE SET
  role          = EXCLUDED.role,
  role_template = EXCLUDED.role_template,
  status        = 'active';

INSERT INTO user_permission (org_id, user_id, permission, granted_by_user_id)
SELECT 'd0000000-0000-4000-8000-000000000001', u.id, rp.permission,
       (SELECT id FROM demo_seed_user WHERE user_key = 'manager')
  FROM demo_seed_user u
  JOIN demo_seed_role_perm rp ON rp.role_template = u.role_template
ON CONFLICT (user_id, org_id, permission) WHERE user_id IS NOT NULL DO NOTHING;

-- Exactly the template, no more: a grant added to a seeded user by hand, or
-- one the template has since dropped, is taken away again, so showing role
-- separation shows what each role really gets.
DELETE FROM user_permission up
 USING demo_seed_user u
 WHERE up.org_id = 'd0000000-0000-4000-8000-000000000001'
   AND up.user_id = u.id
   AND NOT EXISTS (
     SELECT 1 FROM demo_seed_role_perm rp
      WHERE rp.role_template = u.role_template AND rp.permission = up.permission);

-- Credential only (R20 decision 2). npi is not in the column list, so an NPI
-- recorded later on the Team page survives a re-run.
INSERT INTO clinician_profile (org_id, user_id, credential, updated_by_user_id)
SELECT 'd0000000-0000-4000-8000-000000000001', id, credential,
       (SELECT id FROM demo_seed_user WHERE user_key = 'manager')
  FROM demo_seed_user
 WHERE credential IS NOT NULL
ON CONFLICT (org_id, user_id) DO UPDATE SET
  credential = EXCLUDED.credential,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- Patients. All four care-team seats are filled: the primary NP alternates
-- between the two NPs, and the RN case manager, the social worker and the
-- biller sit on every chart. The emergency contact and the referring
-- physician are not written here: 0103 retired those columns, and the next
-- section puts both where the app reads them.
-- ----------------------------------------------------------------------------
INSERT INTO patient (
  id, org_id, first_name, last_name, date_of_birth, sex_assigned_at_birth,
  address_line_1, city, state, zip, phone,
  primary_payer_id, primary_member_id, primary_group_number, insurance_state,
  primary_diagnosis_icd10, palliative_referral_reason,
  acuity, acuity_updated_at, acuity_updated_by_user_id,
  primary_np_user_id, rn_user_id, social_worker_user_id, billing_agent_user_id,
  status, discharged_at, created_at, updated_at, created_by_user_id
)
SELECT p.id, 'd0000000-0000-4000-8000-000000000001', p.first_name, p.last_name, p.dob, p.sex,
       p.address_line_1, p.city, 'OH', p.zip, p.phone,
       py.id, p.member_id, p.group_number, 'OH',
       p.dx[1], p.referral_reason,
       p.acuity, fv.first_at, np.id,
       np.id, rn.id, sw.id, bl.id,
       p.status,
       -- For the deceased patient this is the date of death: the chart has
       -- no separate column for it.
       CASE WHEN p.ends_bday IS NOT NULL THEN (e.day + time '16:00') AT TIME ZONE 'America/New_York' END,
       fv.first_at - interval '14 days', now(), mg.id
  FROM demo_seed_patient p
  JOIN payer py          ON py.name = p.payer_name AND py.active
  JOIN demo_seed_user np ON np.user_key = p.primary_np
  JOIN demo_seed_user rn ON rn.user_key = 'rn'
  JOIN demo_seed_user sw ON sw.user_key = 'lcsw'
  JOIN demo_seed_user bl ON bl.user_key = 'biller'
  JOIN demo_seed_user mg ON mg.user_key = 'manager'
  LEFT JOIN demo_seed_day e ON e.bday = p.ends_bday
  CROSS JOIN LATERAL (
    SELECT min(r.starts_at) AS first_at FROM demo_seed_visit_row r WHERE r.patient_no = p.patient_no
  ) fv
ON CONFLICT (id) DO UPDATE SET
  first_name                = EXCLUDED.first_name,
  last_name                 = EXCLUDED.last_name,
  date_of_birth             = EXCLUDED.date_of_birth,
  sex_assigned_at_birth     = EXCLUDED.sex_assigned_at_birth,
  address_line_1            = EXCLUDED.address_line_1,
  city                      = EXCLUDED.city,
  state                     = EXCLUDED.state,
  zip                       = EXCLUDED.zip,
  phone                     = EXCLUDED.phone,
  primary_payer_id          = EXCLUDED.primary_payer_id,
  -- The ciphertext companion (0034) is kept while the member id is the same
  -- and cleared when it changes, so the PHI backfill encrypts the new one.
  primary_member_id_enc     = CASE WHEN patient.primary_member_id IS NOT DISTINCT FROM EXCLUDED.primary_member_id
                                   THEN patient.primary_member_id_enc END,
  primary_member_id         = EXCLUDED.primary_member_id,
  primary_group_number      = EXCLUDED.primary_group_number,
  insurance_state           = EXCLUDED.insurance_state,
  primary_diagnosis_icd10   = EXCLUDED.primary_diagnosis_icd10,
  palliative_referral_reason = EXCLUDED.palliative_referral_reason,
  acuity                    = EXCLUDED.acuity,
  acuity_updated_at         = EXCLUDED.acuity_updated_at,
  acuity_updated_by_user_id = EXCLUDED.acuity_updated_by_user_id,
  primary_np_user_id        = EXCLUDED.primary_np_user_id,
  rn_user_id                = EXCLUDED.rn_user_id,
  social_worker_user_id     = EXCLUDED.social_worker_user_id,
  billing_agent_user_id     = EXCLUDED.billing_agent_user_id,
  status                    = EXCLUDED.status,
  discharged_at             = EXCLUDED.discharged_at,
  archived_at               = NULL,
  updated_at                = now();

-- ----------------------------------------------------------------------------
-- Family, caregivers and the referring physician (audit R30). 0103 moved
-- these off the patient row and copied the old values across once. A fresh
-- database applies every migration before any seed, so that copy never sees
-- these patients: the seed writes the new tables itself.
--
-- NOT EXISTS guards rather than ids: a contact or link the org has edited in
-- the app stays as it is, and a seeded one it deleted comes back. Where 0103
-- already copied the old values (a demo org seeded before 0103), its copied
-- "Karen Jennings (daughter)" contact and referrer count as already there.
-- ----------------------------------------------------------------------------

-- One contact per patient, from the emergency contact above: the name, the
-- relationship in its brackets, the phone. The primary caregiver when the
-- caregiver column names the same relative. Living with the patient per the
-- social histories, where Dolores Whitaker and Shirley Tanaka live alone and
-- Loretta Simmons lives with her husband, not the daughter who coordinates
-- her care. Health care power of attorney only where a note names one:
-- Gerald Novak's wife, at his ACP visit.
INSERT INTO patient_contact (
  org_id, patient_id, full_name, relationship, phone,
  is_primary_caregiver, is_emergency_contact, is_healthcare_poa, lives_with_patient,
  notes, created_by_user_id, updated_by_user_id
)
SELECT 'd0000000-0000-4000-8000-000000000001', c.patient_id, c.full_name, c.relationship, c.phone,
       c.is_primary_caregiver, c.is_emergency_contact,
       -- One POA per patient (0103): one the org has named since stands, and
       -- the seeded contact comes back without the role.
       c.is_healthcare_poa AND NOT EXISTS (
         SELECT 1 FROM patient_contact x WHERE x.patient_id = c.patient_id AND x.is_healthcare_poa),
       c.lives_with_patient, c.notes, mg.id, mg.id
  FROM (
    SELECT p.id AS patient_id, k.full_name,
           CASE k.said
             WHEN 'wife'          THEN 'spouse'
             WHEN 'husband'       THEN 'spouse'
             WHEN 'partner'       THEN 'partner'
             WHEN 'daughter'      THEN 'child'
             WHEN 'son'           THEN 'child'
             WHEN 'sister'        THEN 'sibling'
             WHEN 'brother'       THEN 'sibling'
             WHEN 'granddaughter' THEN 'grandchild'
             WHEN 'grandson'      THEN 'grandchild'
             ELSE 'other'
           END AS relationship,
           p.emergency_contact_phone AS phone,
           COALESCE(p.caregiver IN ('his ' || k.said, 'her ' || k.said), FALSE) AS is_primary_caregiver,
           TRUE AS is_emergency_contact,
           p.patient_no = 5 AS is_healthcare_poa,
           p.patient_no NOT IN (2, 6, 13) AS lives_with_patient,
           NULL::text AS notes,
           p.emergency_contact_name AS copied_name
      FROM demo_seed_patient p
      CROSS JOIN LATERAL (
        SELECT btrim(regexp_replace(p.emergency_contact_name, '\s*\([^)]*\)\s*$', '')) AS full_name,
               lower(substring(p.emergency_contact_name FROM '\(([^)]*)\)\s*$'))      AS said
      ) k
    UNION ALL
    -- Shirley Tanaka's daughter is in Seattle. The caregiver the seed names
    -- is the neighbor who checks on her every day.
    SELECT p.id, 'Joan Whitcomb', 'friend', '614-555-0165', TRUE, FALSE, FALSE, FALSE,
           'Next-door neighbor; checks on her every day and has a key.', NULL
      FROM demo_seed_patient p
     WHERE p.patient_no = 13
  ) c
  JOIN demo_seed_user mg ON mg.user_key = 'manager'
 WHERE NOT EXISTS (SELECT 1 FROM patient_contact x
                    WHERE x.patient_id = c.patient_id
                      AND x.full_name IN (c.full_name, c.copied_name));

-- The referring physicians, one roster row each: Ruth Castellano refers
-- three of these patients and has one phone number to correct, not three.
-- Name only: an individual NPI could belong to a real provider (see NPIs
-- above). The brackets give the specialty. Added only for a patient still
-- without a referrer, so a re-run, or a database where 0103 copied the
-- referrers, adds none.
INSERT INTO external_provider (org_id, full_name, specialty, created_by_user_id)
SELECT DISTINCT 'd0000000-0000-4000-8000-000000000001'::uuid, r.full_name, r.specialty, mg.id
  FROM demo_seed_patient p
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(p.referring_physician_name, '\s*\([^)]*\)\s*$', '')) AS full_name,
           initcap(substring(p.referring_physician_name FROM '\(([^)]*)\)\s*$'))    AS specialty
  ) r
  JOIN demo_seed_user mg ON mg.user_key = 'manager'
 WHERE NOT EXISTS (SELECT 1 FROM patient_external_provider x
                    WHERE x.patient_id = p.id AND x.role = 'referring')
   AND NOT EXISTS (SELECT 1 FROM external_provider e
                    WHERE e.org_id = 'd0000000-0000-4000-8000-000000000001'
                      AND e.full_name = r.full_name);

-- Who referred each patient, and for Ruth Castellano's three, who is their
-- primary care provider as well. One of each per patient (0103): one the org
-- has set in the app since stands.
INSERT INTO patient_external_provider (org_id, patient_id, external_provider_id, role, created_by_user_id)
SELECT 'd0000000-0000-4000-8000-000000000001', p.id, ep.id, rl.role, mg.id
  FROM demo_seed_patient p
  CROSS JOIN LATERAL (
    SELECT btrim(regexp_replace(p.referring_physician_name, '\s*\([^)]*\)\s*$', '')) AS full_name,
           lower(substring(p.referring_physician_name FROM '\(([^)]*)\)\s*$'))      AS said
  ) r
  CROSS JOIN LATERAL (
    SELECT e.id FROM external_provider e
     WHERE e.org_id = 'd0000000-0000-4000-8000-000000000001' AND e.full_name = r.full_name
     ORDER BY e.created_at, e.id
     LIMIT 1
  ) ep
  JOIN (VALUES ('referring'), ('primary_care')) AS rl(role)
    ON rl.role = 'referring' OR r.said = 'primary care'
  JOIN demo_seed_user mg ON mg.user_key = 'manager'
 WHERE NOT EXISTS (SELECT 1 FROM patient_external_provider x
                    WHERE x.patient_id = p.id AND x.role = rl.role);

-- ----------------------------------------------------------------------------
-- Visits, written unpinned (note_template_id NULL). The app pins a visit to
-- the template version its note is written under on every write that starts a
-- note — saving a section, carry-forward, recording vitals — and at sign-off;
-- the seed pins its visits once their notes and vitals are written, below.
-- ----------------------------------------------------------------------------
INSERT INTO visit (
  id, org_id, patient_id, clinician_user_id, visit_type,
  scheduled_start, scheduled_end, start_time, stop_time,
  total_minutes, acp_minutes, prolonged_minutes,
  is_telehealth, telehealth_modality, telehealth_consent_documented,
  document_text, cpt_codes_assigned, icd10_codes, modifiers,
  status, signed_at, signed_by_user_id, signer_credential, place_of_service_code,
  note_template_id, created_at, updated_at
)
SELECT r.id, 'd0000000-0000-4000-8000-000000000001', r.patient_id, r.clinician_id, r.visit_type,
       r.starts_at,
       r.starts_at + make_interval(mins => COALESCE(r.minutes,
                                    CASE r.visit_type WHEN 'advance_care_planning' THEN 45 ELSE 60 END)),
       CASE WHEN r.signed THEN r.starts_at END,
       CASE WHEN r.signed THEN r.starts_at + make_interval(mins => r.minutes) END,
       r.minutes, COALESCE(r.acp_minutes, 0), COALESCE(r.prolonged_minutes, 0),
       r.is_telehealth,
       CASE WHEN r.is_telehealth THEN 'audio_video' END,
       r.is_telehealth AND r.signed,
       NULL,
       COALESCE(r.cpt, ARRAY[]::text[]),
       CASE WHEN r.signed THEN p.dx ELSE ARRAY[]::text[] END,
       -- 95: synchronous audio-video, as the CPT suggester emits it.
       CASE WHEN r.signed AND r.is_telehealth THEN ARRAY['95'] ELSE ARRAY[]::text[] END,
       r.status, r.signed_at,
       CASE WHEN r.signed THEN r.clinician_id END,
       -- Snapshotted at sign-off from clinician_profile (0098).
       CASE WHEN r.signed THEN r.credential END,
       -- 12 home, 10 telehealth in the home (0095); recorded on signed visits.
       r.pos_code,
       NULL,
       LEAST(r.starts_at - interval '10 days', now() - interval '1 day'),
       COALESCE(r.signed_at, LEAST(r.starts_at - interval '10 days', now() - interval '1 day'))
  FROM demo_seed_visit_row r
  JOIN demo_seed_patient p ON p.patient_no = r.patient_no
ON CONFLICT (id) DO UPDATE SET
  patient_id                    = EXCLUDED.patient_id,
  clinician_user_id             = EXCLUDED.clinician_user_id,
  visit_type                    = EXCLUDED.visit_type,
  scheduled_start               = EXCLUDED.scheduled_start,
  scheduled_end                 = EXCLUDED.scheduled_end,
  start_time                    = EXCLUDED.start_time,
  stop_time                     = EXCLUDED.stop_time,
  total_minutes                 = EXCLUDED.total_minutes,
  acp_minutes                   = EXCLUDED.acp_minutes,
  prolonged_minutes             = EXCLUDED.prolonged_minutes,
  is_telehealth                 = EXCLUDED.is_telehealth,
  telehealth_modality           = EXCLUDED.telehealth_modality,
  telehealth_consent_documented = EXCLUDED.telehealth_consent_documented,
  document_text                 = NULL,
  cpt_codes_assigned            = EXCLUDED.cpt_codes_assigned,
  -- One unit per code, as the seeded codes are billed (0106): a re-run that
  -- resets the codes must not leave beside them a count saved since.
  cpt_units                     = '{}'::jsonb,
  icd10_codes                   = EXCLUDED.icd10_codes,
  modifiers                     = EXCLUDED.modifiers,
  status                        = EXCLUDED.status,
  signed_at                     = EXCLUDED.signed_at,
  signed_by_user_id             = EXCLUDED.signed_by_user_id,
  signer_credential             = EXCLUDED.signer_credential,
  place_of_service_code         = EXCLUDED.place_of_service_code,
  -- note_template_id is left as it is: see the pin below.
  updated_at                    = EXCLUDED.updated_at;

-- ----------------------------------------------------------------------------
-- The note template. The note preview, the audit packet, the sign guard and
-- the documentation check read a visit's sections through its pinned
-- template, else the org's active one; with neither, no section renders and
-- every signed note previews as "Nothing has been written yet". A real org
-- gets its template from ensureNoteTemplate on its first note read. This org
-- is built in SQL and never takes that path, so the seed makes the same
-- version 1, unless the org already has an active template (one per org,
-- note_template_one_active_per_org): the app's own version 1, or a later
-- version the org saved, is left as it is.
-- ----------------------------------------------------------------------------
INSERT INTO note_template (org_id, name, version, is_active, source, created_by_user_id)
SELECT 'd0000000-0000-4000-8000-000000000001', 'Palliative visit note', 1, TRUE, 'default', NULL
 WHERE NOT EXISTS (SELECT 1 FROM note_template t
                    WHERE t.org_id = 'd0000000-0000-4000-8000-000000000001' AND t.is_active);

-- Its sections, into version 1 only: the shipped default, whether this seed
-- or ensureNoteTemplate made it. Never into a later version, which is the
-- org's own edit and may leave a default section out on purpose.
INSERT INTO note_template_section (
  org_id, template_id, section_key, label, help_text, kind, is_required,
  not_required_for_visit_types, sort_order
)
SELECT t.org_id, t.id, d.section_key, d.label, d.help_text, d.kind, d.is_required,
       d.not_required_for_visit_types, d.sort_order
  FROM note_template t
  CROSS JOIN demo_seed_template_section d
 WHERE t.org_id = 'd0000000-0000-4000-8000-000000000001'
   AND t.version = 1 AND t.source = 'default'
   AND NOT EXISTS (SELECT 1 FROM note_template_section x
                    WHERE x.template_id = t.id AND x.section_key = d.section_key);

-- ----------------------------------------------------------------------------
-- The signed notes: every section in demo_seed_section on every signed
-- visit, the physical exam on home visits only. The patient's standing text
-- plus what this visit changed.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE demo_seed_note ON COMMIT DROP AS
SELECT r.id AS visit_id, r.clinician_id, r.signed_at, s.section_key, s.kind,
       CASE s.section_key
         WHEN 'chief_complaint' THEN
           CASE r.visit_type
             WHEN 'new_patient_home'      THEN 'Initial palliative care consultation. ' || n.chief_complaint
             WHEN 'advance_care_planning' THEN 'Advance care planning conversation.'
             ELSE n.chief_complaint
           END
         WHEN 'hpi' THEN n.hpi || ' ' ||
           CASE
             WHEN r.visit_type = 'new_patient_home'
               THEN 'Referred by ' || p.referring_physician_name || ': ' || p.referral_reason || '.'
             WHEN r.visit_type = 'telehealth'
               THEN 'Seen by audio-video telehealth with the patient at home and ' || p.caregiver
                    || ' present; consent to a telehealth visit documented.'
             WHEN r.visit_type = 'advance_care_planning'
               THEN 'Visit set aside for advance care planning, with ' || p.caregiver || ' present.'
             WHEN r.seq > 1
               THEN 'Weight today ' || r.weight_kg || ' kg, down ' || p.weight_step
                    || ' kg since the last home visit; PPS ' || r.pps || '%.'
             ELSE 'Weight today ' || r.weight_kg || ' kg; PPS ' || r.pps || '%.'
           END
         WHEN 'social_history' THEN n.social_history
         WHEN 'code_status'    THEN n.code_status
         WHEN 'physical_exam'  THEN n.physical_exam
         WHEN 'goals_of_care'  THEN n.goals_of_care
         WHEN 'assessment_and_plan' THEN
           CASE WHEN r.visit_type = 'advance_care_planning'
                THEN 'Advance care planning, ' || r.acp_minutes || ' minutes, face to face and voluntary. '
                     || n.acp_summary
                ELSE n.assessment_and_plan
           END
       END AS body,
       CASE WHEN s.kind = 'list' THEN p.medications END AS items
  FROM demo_seed_visit_row r
  JOIN demo_seed_patient p      ON p.patient_no = r.patient_no
  JOIN demo_seed_patient_note n ON n.patient_no = r.patient_no
  JOIN demo_seed_section s      ON r.in_person OR NOT s.in_person_only
 WHERE r.signed;

-- A section written empty would be marked is_empty = FALSE below and pass
-- the sign-off check with nothing in it. Concatenation, not format(), builds
-- the text above so that a missing piece shows up here as NULL.
DO $$
DECLARE
  n INT;
BEGIN
  SELECT count(*) INTO n FROM demo_seed_note
   WHERE (kind = 'prose' AND coalesce(btrim(body), '') = '')
      OR (kind = 'list'  AND coalesce(cardinality(items), 0) = 0)
      OR kind NOT IN ('prose', 'list');
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % note section(s) would be written empty', n;
  END IF;
END $$;

-- TipTap for prose (the assessment and plan split into one paragraph per
-- numbered problem), {"items": [...]} for a list section.
INSERT INTO visit_note_section (org_id, visit_id, section_key, content, is_empty, updated_at, updated_by_user_id)
SELECT 'd0000000-0000-4000-8000-000000000001', nt.visit_id, nt.section_key,
       CASE
         WHEN nt.kind = 'list' THEN jsonb_build_object('items', to_jsonb(nt.items))
         WHEN nt.section_key = 'assessment_and_plan' THEN jsonb_build_object('type', 'doc', 'content',
           (SELECT jsonb_agg(jsonb_build_object('type', 'paragraph', 'content',
                     jsonb_build_array(jsonb_build_object('type', 'text', 'text', part))) ORDER BY ord)
              FROM regexp_split_to_table(nt.body, '\s+(?=[1-9]\. )') WITH ORDINALITY AS t(part, ord)))
         ELSE jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
           jsonb_build_object('type', 'paragraph', 'content',
             jsonb_build_array(jsonb_build_object('type', 'text', 'text', nt.body)))))
       END,
       FALSE, nt.signed_at - interval '20 minutes', nt.clinician_id
  FROM demo_seed_note nt
ON CONFLICT (visit_id, section_key) DO UPDATE SET
  content               = EXCLUDED.content,
  is_empty              = FALSE,
  updated_at            = EXCLUDED.updated_at,
  updated_by_user_id    = EXCLUDED.updated_by_user_id,
  carried_from_visit_id = NULL,
  carried_unchanged     = FALSE;

-- Vitals on every signed home visit: none by video or on an advance care
-- planning call, where the template waives them. Readings vary a little
-- around each patient's baseline so no two visits are identical; weight and
-- PPS come from the visit row, and fall.
INSERT INTO visit_vitals (
  org_id, visit_id, patient_id, recorded_at, height_cm, weight_kg,
  bp_systolic, bp_diastolic, heart_rate, resp_rate, temperature_c, spo2_percent,
  pps_percent, pain_score, created_at, created_by_user_id
)
SELECT 'd0000000-0000-4000-8000-000000000001', r.id, r.patient_id,
       r.starts_at + interval '10 minutes', p.height_cm, r.weight_kg,
       p.sbp + (r.visit_no * 7) % 9 - 4,
       p.dbp + (r.visit_no * 5) % 7 - 3,
       p.hr  + (r.visit_no * 3) % 9 - 4,
       p.rr  + r.visit_no % 3 - 1,
       36.5 + ((r.visit_no * 3) % 5 - 2) / 10.0,
       LEAST(100, p.spo2 + r.visit_no % 3 - 1),
       r.pps, r.pain,
       r.starts_at + interval '10 minutes', r.clinician_id
  FROM demo_seed_visit_row r
  JOIN demo_seed_patient p ON p.patient_no = r.patient_no
 WHERE r.signed AND r.in_person
ON CONFLICT (visit_id) DO UPDATE SET
  patient_id         = EXCLUDED.patient_id,
  recorded_at        = EXCLUDED.recorded_at,
  height_cm          = EXCLUDED.height_cm,
  weight_kg          = EXCLUDED.weight_kg,
  bp_systolic        = EXCLUDED.bp_systolic,
  bp_diastolic       = EXCLUDED.bp_diastolic,
  heart_rate         = EXCLUDED.heart_rate,
  resp_rate          = EXCLUDED.resp_rate,
  temperature_c      = EXCLUDED.temperature_c,
  spo2_percent       = EXCLUDED.spo2_percent,
  pps_percent        = EXCLUDED.pps_percent,
  pain_score         = EXCLUDED.pain_score,
  notes              = NULL,
  created_by_user_id = EXCLUDED.created_by_user_id;

-- Pin each visit whose note this run wrote to version 1, as the app pins a
-- visit to the version its note is written under. "Wrote" means sections or
-- vitals: recording vitals starts a note too, so a seeded vitals-only visit
-- left unpinned would follow the org's later version and lose the sections it
-- was written under — the hole 0105 backfills. Runs after both writes, so a
-- first run sees them. These notes use DEFAULT_NOTE_SECTIONS' keys, so they
-- keep reading through the version that declares them after the org edits its
-- template. Only visits with no pin yet: the visit upsert leaves the pin
-- alone, so a seeded visit documented in the app under the org's later version
-- keeps that version on a re-run. Scheduled visits get no note and no vitals
-- here and stay unpinned, reading through the active template like any note
-- not yet opened. Visits created in the app are never touched.
UPDATE visit v
   SET note_template_id = t.id
  FROM note_template t
 WHERE t.org_id = 'd0000000-0000-4000-8000-000000000001'
   AND t.version = 1 AND t.source = 'default'
   AND v.org_id = t.org_id
   AND v.note_template_id IS NULL
   AND (v.id IN (SELECT DISTINCT nt.visit_id FROM demo_seed_note nt)
        OR v.id IN (SELECT DISTINCT vr.id FROM demo_seed_visit_row vr
                      JOIN visit_vitals vv ON vv.visit_id = vr.id));

-- ----------------------------------------------------------------------------
-- Bills, priced the way buildDraftFromVisit prices them (audit R33): the
-- payer's 'covered' rate on file for the date of service, the payer's own
-- product line first, the NP/PA figure where one is published and the
-- clinician is not a physician; failing that, the reference table. The bill
-- page's rule check and the billed amount therefore agree.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE demo_seed_line ON COMMIT DROP AS
SELECT r.visit_no, l.ord, l.code, t.tier,
       CASE
         WHEN pr.id IS NOT NULL THEN
           round(CASE
                   WHEN pos.facility_indicator = 'facility'
                        AND pr.value->>'facilityRate' ~ '^[0-9]+(\.[0-9]+)?$'
                     THEN (pr.value->>'facilityRate')::numeric
                   WHEN t.tier = 'NP_PA' AND pr.value->>'npPaRate' ~ '^[0-9]+(\.[0-9]+)?$'
                     THEN (pr.value->>'npPaRate')::numeric
                   ELSE (pr.value->>'rate')::numeric
                 END * 100)::bigint
         WHEN t.tier = 'MD' THEN rr.md_cents
         ELSE rr.np_pa_cents
       END AS rate_cents,
       CASE WHEN pr.id IS NOT NULL THEN 'payer_fee_schedule'
            WHEN rr.code IS NOT NULL THEN 'reference_table'
            ELSE 'unrated' END AS source,
       pr.id AS payer_rule_id,
       pr.value->>'rateBasis' AS rate_basis,
       to_char(pr.effective_date, 'YYYY-MM-DD') AS effective_date
  FROM demo_seed_visit_row r
  JOIN demo_seed_patient p ON p.patient_no = r.patient_no
  JOIN payer py ON py.name = p.payer_name AND py.active
  -- tierForCredential: MD and DO at the physician rate, everyone else NP/PA.
  CROSS JOIN LATERAL (SELECT CASE WHEN r.credential IN ('MD', 'DO') THEN 'MD' ELSE 'NP_PA' END AS tier) t
  CROSS JOIN LATERAL unnest(r.cpt) WITH ORDINALITY AS l(code, ord)
  LEFT JOIN pos ON pos.pos = r.pos_code
  LEFT JOIN LATERAL (
    SELECT pr.id, pr.value, pr.effective_date
      FROM payer_rule pr
     WHERE pr.payer_id = py.id
       AND pr.state = 'OH'
       AND pr.code = l.code
       AND pr.attribute = 'covered'
       AND pr.value->>'rate' ~ '^[0-9]+(\.[0-9]+)?$'
       AND pr.superseded_by IS NULL
       AND pr.effective_date <= r.dos
       AND (pr.expiration_date IS NULL OR pr.expiration_date > r.dos)
     -- The payer's own product line first: PAYER_TYPE_PRODUCT_LINE in
     -- lib/features/billing/payer-rule.repository.ts.
     ORDER BY (pr.product_line = CASE py.payer_type
                                   WHEN 'medicare_mac'           THEN 'medicare_ffs'
                                   WHEN 'medicare_advantage_org' THEN 'medicare_advantage'
                                   WHEN 'medicaid_state'         THEN 'medicaid_ffs'
                                   WHEN 'medicaid_mco'           THEN 'medicaid_mco'
                                   WHEN 'workers_comp'           THEN 'workers_comp_state'
                                   WHEN 'auto_no_fault'          THEN 'auto_no_fault'
                                   WHEN 'tribal'                 THEN 'tribal_638'
                                   ELSE 'commercial'
                                 END) DESC,
              pr.effective_date DESC
     LIMIT 1
  ) pr ON TRUE
  LEFT JOIN demo_seed_ref_rate rr ON rr.code = l.code
 WHERE r.signed;

-- One bill per signed visit, and when each step of its life happened: made
-- at sign-off, reviewed and sent the next morning, settled ten to fourteen
-- days later (never in the future).
CREATE TEMP TABLE demo_seed_bill ON COMMIT DROP AS
SELECT r.visit_no,
       ('d0000000-0000-4000-8000-' || lpad((500 + r.visit_no)::text, 12, '0'))::uuid AS id,
       r.id AS visit_id, r.patient_id, r.clinician_id, py.id AS payer_id, p.member_id, r.dos, r.cpt,
       p.dx AS icd10_codes,
       CASE WHEN r.is_telehealth THEN ARRAY['95'] ELSE ARRAY[]::text[] END AS modifiers,
       u.full_name AS provider_name, r.pos_code, r.bill_status,
       ln.billed, ln.pricing,
       r.signed_at AS created_at,
       r.signed_at + interval '18 hours' AS reviewed_at,
       r.signed_at + interval '19 hours' AS submitted_at,
       LEAST(r.signed_at + make_interval(days => 10 + r.visit_no % 5), now() - interval '2 hours') AS settled_at
  FROM demo_seed_visit_row r
  JOIN demo_seed_patient p ON p.patient_no = r.patient_no
  JOIN payer py            ON py.name = p.payer_name AND py.active
  JOIN demo_seed_user u    ON u.id = r.clinician_id
  CROSS JOIN LATERAL (
    SELECT sum(l.rate_cents)::bigint AS billed,
           -- superbill.pricing (0094): {tier, lines:[{code, rateCents, source,
           -- payerRuleId, rateBasis, effectiveDate}]}.
           jsonb_build_object('tier', min(l.tier), 'lines', jsonb_agg(jsonb_build_object(
             'code', l.code, 'rateCents', l.rate_cents, 'source', l.source,
             'payerRuleId', l.payer_rule_id, 'rateBasis', l.rate_basis,
             'effectiveDate', l.effective_date) ORDER BY l.ord)) AS pricing
      FROM demo_seed_line l
     WHERE l.visit_no = r.visit_no
  ) ln
 WHERE r.signed;

-- The org NPI is both billing provider (box 33a) and, with no clinician NPI
-- on file, rendering provider (box 24J) — buildDraftFromVisit's fallback,
-- which the bill page flags. predicted_risk stays NULL: these bills were not
-- scored when saved, and a made-up score would be worse than none.
INSERT INTO superbill (
  id, org_id, visit_id, patient_id, payer_id, member_id_snapshot, date_of_service,
  cpt_codes, icd10_codes, modifiers, provider_npi, provider_name, billing_npi, place_of_service_code,
  billed_amount_cents, status, submitted_at, paid_at, paid_amount_cents, predicted_risk, pricing,
  created_at, updated_at
)
SELECT b.id, 'd0000000-0000-4000-8000-000000000001', b.visit_id, b.patient_id, b.payer_id, b.member_id, b.dos,
       b.cpt, b.icd10_codes, b.modifiers, ob.npi, b.provider_name, ob.npi, b.pos_code,
       b.billed, b.bill_status,
       CASE WHEN b.bill_status <> 'draft' THEN b.submitted_at END,
       CASE WHEN b.bill_status IN ('paid', 'partially_paid') THEN b.settled_at END,
       CASE b.bill_status
         WHEN 'paid'           THEN b.billed
         WHEN 'partially_paid' THEN round(b.billed * 0.62)::bigint
       END,
       NULL, b.pricing,
       b.created_at,
       CASE b.bill_status
         WHEN 'draft'     THEN b.created_at
         WHEN 'submitted' THEN b.submitted_at
         ELSE b.settled_at
       END
  FROM demo_seed_bill b
  CROSS JOIN (SELECT npi FROM onboarding_status WHERE org_id = 'd0000000-0000-4000-8000-000000000001') ob
ON CONFLICT (id) DO UPDATE SET
  visit_id               = EXCLUDED.visit_id,
  patient_id             = EXCLUDED.patient_id,
  payer_id               = EXCLUDED.payer_id,
  member_id_snapshot_enc = CASE WHEN superbill.member_id_snapshot IS NOT DISTINCT FROM EXCLUDED.member_id_snapshot
                                THEN superbill.member_id_snapshot_enc END,
  member_id_snapshot     = EXCLUDED.member_id_snapshot,
  date_of_service        = EXCLUDED.date_of_service,
  cpt_codes              = EXCLUDED.cpt_codes,
  -- One unit per code, matching the billed amount reset below (0106).
  cpt_units              = '{}'::jsonb,
  icd10_codes            = EXCLUDED.icd10_codes,
  modifiers              = EXCLUDED.modifiers,
  -- A re-run keeps a clinician's NPI the Team page filled in (R40): only a
  -- bill still carrying the org NPI, or none, is written back to it.
  provider_npi           = COALESCE(NULLIF(NULLIF(superbill.provider_npi, ''), EXCLUDED.provider_npi),
                                    EXCLUDED.provider_npi),
  provider_name          = EXCLUDED.provider_name,
  billing_npi            = EXCLUDED.billing_npi,
  place_of_service_code  = EXCLUDED.place_of_service_code,
  billed_amount_cents    = EXCLUDED.billed_amount_cents,
  status                 = EXCLUDED.status,
  submitted_at           = EXCLUDED.submitted_at,
  paid_at                = EXCLUDED.paid_at,
  paid_amount_cents      = EXCLUDED.paid_amount_cents,
  predicted_risk         = NULL,
  pricing                = EXCLUDED.pricing,
  updated_at             = EXCLUDED.updated_at;

-- The two denials, each with its reason code, so the denial log and every
-- metric that reads superbill_denial count what superbill.status counts.
CREATE TEMP TABLE demo_seed_denial (
  visit_no   INT PRIMARY KEY,
  id         UUID NOT NULL,
  cpt_code   TEXT NOT NULL,
  carc_code  TEXT NOT NULL,
  rarc_code  TEXT,
  reason     TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_seed_denial (visit_no, id, cpt_code, carc_code, rarc_code, reason) VALUES
  -- A stable, low-acuity patient billed at the top home level.
  (25, 'd0000000-0000-4000-8000-000000000601', '99350', '50', NULL,
   'Level of service not supported as medically necessary for this visit.'),
  -- Two symptom codes and no underlying condition.
  (28, 'd0000000-0000-4000-8000-000000000602', '99348', '16', 'M76',
   'Claim lacks information needed for adjudication: diagnosis coding incomplete.');

-- Both await a decision, so they show in the biller's inbox and the log.
INSERT INTO superbill_denial (
  id, org_id, superbill_id, payer_id, cpt_code, icd10_codes, modifiers,
  carc_code, rarc_code, group_code, denial_reason, denied_amount_cents, denied_at,
  decision, outcome, created_at, updated_at
)
SELECT d.id, 'd0000000-0000-4000-8000-000000000001', b.id, b.payer_id, d.cpt_code, b.icd10_codes, b.modifiers,
       d.carc_code, d.rarc_code, 'CO', d.reason, l.rate_cents, b.settled_at,
       'pending', 'pending', b.settled_at, b.settled_at
  FROM demo_seed_denial d
  JOIN demo_seed_bill b ON b.visit_no = d.visit_no AND b.bill_status = 'denied'
  JOIN demo_seed_line l ON l.visit_no = d.visit_no AND l.code = d.cpt_code
ON CONFLICT (id) DO UPDATE SET
  superbill_id         = EXCLUDED.superbill_id,
  payer_id             = EXCLUDED.payer_id,
  cpt_code             = EXCLUDED.cpt_code,
  icd10_codes          = EXCLUDED.icd10_codes,
  modifiers            = EXCLUDED.modifiers,
  carc_code            = EXCLUDED.carc_code,
  rarc_code            = EXCLUDED.rarc_code,
  group_code           = EXCLUDED.group_code,
  denial_reason        = EXCLUDED.denial_reason,
  denied_amount_cents  = EXCLUDED.denied_amount_cents,
  denied_at            = EXCLUDED.denied_at,
  decision             = 'pending',
  decision_at          = NULL,
  decision_by_user_id  = NULL,
  decision_notes       = NULL,
  refiled_at           = NULL,
  outcome              = 'pending',
  outcome_at           = NULL,
  outcome_amount_cents = NULL,
  outcome_notes        = NULL,
  updated_at           = EXCLUDED.updated_at;

-- Each bill's own timeline, in the words the app writes: created at sign-off
-- by the clinician, then the biller's review, submission and the payer's
-- answer (statusSummary in superbill.service.ts, logDenial for a denial).
INSERT INTO superbill_activity (id, org_id, superbill_id, at, actor_user_id, kind, from_status, to_status, summary, detail)
SELECT ('d0000000-0000-4000-8000-' || lpad((100000 + b.visit_no * 10 + a.step)::text, 12, '0'))::uuid,
       'd0000000-0000-4000-8000-000000000001', b.id, a.at, a.actor, a.kind, a.from_status, a.to_status,
       a.summary, a.detail
  FROM demo_seed_bill b
  JOIN superbill s ON s.id = b.id
  LEFT JOIN demo_seed_denial d ON d.visit_no = b.visit_no
  CROSS JOIN (SELECT id FROM demo_seed_user WHERE user_key = 'biller') bl
  CROSS JOIN LATERAL (VALUES
    (1, b.created_at, b.clinician_id, 'created', NULL, 'draft', 'Superbill created from the visit',
     jsonb_build_object('billedAmountCents', s.billed_amount_cents, 'cptCodes', to_jsonb(s.cpt_codes))),
    (2, b.reviewed_at, bl.id, 'status_change', 'draft', 'ready_to_submit', 'Reviewed — ready to submit', '{}'::jsonb),
    (3, b.submitted_at, bl.id, 'status_change', 'ready_to_submit', 'submitted', 'Submitted to the payer', '{}'::jsonb),
    (4, b.settled_at, bl.id,
     CASE WHEN b.bill_status = 'denied' THEN 'denial_logged' ELSE 'status_change' END,
     CASE WHEN b.bill_status = 'denied' THEN NULL ELSE 'submitted' END,
     b.bill_status,
     CASE b.bill_status
       WHEN 'paid'           THEN 'Paid in full — $' || to_char(s.paid_amount_cents / 100.0, 'FM999999990.00')
       WHEN 'partially_paid' THEN 'Partially paid — $' || to_char(s.paid_amount_cents / 100.0, 'FM999999990.00')
       ELSE 'Denied by payer — CARC ' || d.carc_code || ': ' || d.reason
     END,
     CASE WHEN b.bill_status = 'denied'
          THEN jsonb_build_object('carcCode', d.carc_code, 'rarcCode', d.rarc_code,
                                  'cptCode', d.cpt_code, 'deniedAmountCents', s.billed_amount_cents)
          ELSE jsonb_build_object('paidAmountCents', s.paid_amount_cents)
     END)
  ) AS a(step, at, actor, kind, from_status, to_status, summary, detail)
 WHERE a.step = 1
    OR (a.step IN (2, 3) AND b.bill_status <> 'draft')
    OR (a.step = 4 AND b.bill_status IN ('paid', 'partially_paid', 'denied'))
ON CONFLICT (id) DO UPDATE SET
  superbill_id  = EXCLUDED.superbill_id,
  at            = EXCLUDED.at,
  actor_user_id = EXCLUDED.actor_user_id,
  kind          = EXCLUDED.kind,
  from_status   = EXCLUDED.from_status,
  to_status     = EXCLUDED.to_status,
  summary       = EXCLUDED.summary,
  detail        = EXCLUDED.detail;

-- ----------------------------------------------------------------------------
-- Care plans for five patients, last updated at their most recent visit.
-- ----------------------------------------------------------------------------
INSERT INTO care_plan (
  org_id, patient_id, document, goals_of_care_summary, primary_symptoms, active_medications,
  current_version, last_updated_visit_id, created_at, updated_at
)
SELECT 'd0000000-0000-4000-8000-000000000001', p.id,
       jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
         jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
           jsonb_build_object('type', 'text', 'text', 'Goals of care: ' || c.goals))),
         jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
           jsonb_build_object('type', 'text', 'text', 'Symptom plan: ' || c.symptom_plan))),
         jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
           jsonb_build_object('type', 'text', 'text', 'Support: ' || c.support))))),
       c.goals, c.symptoms, p.medications, 1, lv.id, lv.signed_at, lv.signed_at
  FROM (VALUES
    (1, 'Remain at home with his daughter and avoid readmission; hospice when walking is no longer safe.',
        'Morphine for pain and breathlessness, home oxygen 2 L, bowel regimen; RN case manager checks symptoms weekly by phone.',
        'Daughter is his main caregiver; social work reviewing respite options.',
        ARRAY['Breathlessness', 'Chest wall pain', 'Fatigue']),
    (2, 'Stay out of the hospital, be at her granddaughter''s wedding, and have ICD shocks turned off.',
        'Daily weights with a call at 1 kg overnight, furosemide changes at home, low-dose morphine for breathlessness at night.',
        'Son manages medications; home health aide hours under review.',
        ARRAY['Orthopnea', 'Edema', 'Fatigue']),
    (5, 'Remain at home talking with his family; no tracheostomy or long-term ventilation; BiPAP for comfort only.',
        'Glycopyrrolate for secretions, speech therapy for swallowing, nightly BiPAP.',
        'Wife is caregiver and health care power of attorney; social work following caregiver strain.',
        ARRAY['Dysphagia', 'Sialorrhea', 'Weakness']),
    (6, 'Conservative kidney management without dialysis; time at home with her husband.',
        'Treat itching and nausea; labs only when they would change care.',
        'Daughter coordinates care; husband has early memory loss.',
        ARRAY['Pruritus', 'Fatigue', 'Nausea']),
    (10, 'Comfortable enough to attend her son''s graduation, then hospice; no CPR or ICU admission.',
         'Hydromorphone for bone pain, palliative radiation to the left hip, spinal cord compression warning signs taught.',
         'Husband at home; both sons nearby.',
         ARRAY['Bone pain', 'Anxiety', 'Constipation'])
  ) AS c(patient_no, goals, symptom_plan, support, symptoms)
  JOIN demo_seed_patient p ON p.patient_no = c.patient_no
  CROSS JOIN LATERAL (
    SELECT r.id, r.signed_at FROM demo_seed_visit_row r
     WHERE r.patient_no = c.patient_no AND r.signed
     ORDER BY r.bday DESC LIMIT 1
  ) lv
ON CONFLICT (patient_id) DO UPDATE SET
  document              = EXCLUDED.document,
  goals_of_care_summary = EXCLUDED.goals_of_care_summary,
  primary_symptoms      = EXCLUDED.primary_symptoms,
  active_medications    = EXCLUDED.active_medications,
  last_updated_visit_id = EXCLUDED.last_updated_visit_id,
  updated_at            = EXCLUDED.updated_at;

-- Version 1's snapshot, tied to that visit as upsertCarePlan does. Snapshots
-- are frozen, so a re-run leaves an existing one alone.
INSERT INTO care_plan_version (org_id, care_plan_id, version, document, snapshot_visit_id, created_by_user_id, created_at)
SELECT cp.org_id, cp.id, 1, cp.document, cp.last_updated_visit_id, r.clinician_id, cp.created_at
  FROM care_plan cp
  JOIN demo_seed_visit_row r ON r.id = cp.last_updated_visit_id
 WHERE cp.org_id = 'd0000000-0000-4000-8000-000000000001'
ON CONFLICT (care_plan_id, version) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Checks. CI runs this file on every push, so these hold for the seed as
-- committed; they hold again on the VPS against whatever the org has
-- gathered since. Any failure aborts the transaction and nothing above is
-- kept.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  demo CONSTANT UUID := 'd0000000-0000-4000-8000-000000000001';
  n    INT;
  cap  INT;
BEGIN
  -- What the old demo account was: two "patients" who were one record.
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM patient WHERE org_id = demo
     GROUP BY lower(first_name), lower(last_name) HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % patient name(s) appear more than once in the demo org', n;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM patient WHERE org_id = demo
     GROUP BY date_of_birth HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % date(s) of birth are shared by patients in the demo org', n;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM org_member m JOIN app_user u ON u.id = m.user_id
     WHERE m.org_id = demo AND m.status = 'active'
     GROUP BY lower(u.full_name) HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % staff name(s) are shared by members of the demo org', n;
  END IF;

  -- The count getDailyCapacityStatus makes before it lets a visit be booked.
  SELECT daily_visit_capacity INTO cap FROM org WHERE id = demo;
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM visit
     WHERE org_id = demo AND status NOT IN ('cancelled', 'no_show')
     GROUP BY clinician_user_id, date(COALESCE(scheduled_start, start_time))
    HAVING count(*) > cap) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % clinician-day(s) exceed the daily capacity of %', n, cap;
  END IF;

  -- The two denial counts must agree: bills marked denied, and denial rows.
  SELECT count(*) INTO n FROM superbill s
   WHERE s.org_id = demo AND s.status = 'denied'
     AND NOT EXISTS (SELECT 1 FROM superbill_denial d WHERE d.superbill_id = s.id);
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % denied bill(s) have no denial row', n;
  END IF;

  -- A signed home visit needs a weight: the vitals section is required on it
  -- and the trend is drawn from it.
  SELECT count(*) INTO n FROM demo_seed_visit_row r
   WHERE r.signed AND r.in_person
     AND NOT EXISTS (SELECT 1 FROM visit_vitals vv WHERE vv.visit_id = r.id AND vv.weight_kg IS NOT NULL);
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % signed home visit(s) have no weight recorded', n;
  END IF;

  -- Every section written above must be one the template its visit reads
  -- through declares (the pin, else the org's active template). The preview,
  -- the audit packet and the sign guard join sections through that template
  -- and drop the rest, so an undeclared one leaves the note looking empty.
  SELECT count(*) INTO n
    FROM demo_seed_note nt
    JOIN visit v ON v.id = nt.visit_id
   WHERE NOT EXISTS (
     SELECT 1 FROM note_template_section t
      WHERE t.section_key = nt.section_key
        AND t.template_id = COALESCE(v.note_template_id,
              (SELECT x.id FROM note_template x WHERE x.org_id = v.org_id AND x.is_active LIMIT 1)));
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % written note section(s) are not in the template their visit reads through, so the note shows them as empty', n;
  END IF;

  -- The template the seed writes must be DEFAULT_NOTE_SECTIONS, row for row.
  -- The drift spec reads the VALUES list above; this reads what the INSERT
  -- actually wrote, so a drift in its column list or SELECT fails too.
  SELECT count(*) INTO n FROM (
    (SELECT section_key, label, help_text, kind, is_required,
            not_required_for_visit_types, sort_order
       FROM demo_seed_template_section
     EXCEPT
     SELECT s.section_key, s.label, s.help_text, s.kind, s.is_required,
            s.not_required_for_visit_types, s.sort_order
       FROM note_template_section s
       JOIN note_template t ON t.id = s.template_id
      WHERE t.org_id = 'd0000000-0000-4000-8000-000000000001'
        AND t.version = 1 AND t.source = 'default')
    UNION ALL
    (SELECT s.section_key, s.label, s.help_text, s.kind, s.is_required,
            s.not_required_for_visit_types, s.sort_order
       FROM note_template_section s
       JOIN note_template t ON t.id = s.template_id
      WHERE t.org_id = 'd0000000-0000-4000-8000-000000000001'
        AND t.version = 1 AND t.source = 'default'
     EXCEPT
     SELECT section_key, label, help_text, kind, is_required,
            not_required_for_visit_types, sort_order
       FROM demo_seed_template_section)
  ) diff;
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: the note template differs from DEFAULT_NOTE_SECTIONS in % row(s)', n;
  END IF;

  -- The chart's Family & caregivers card and the note header's referring
  -- physician read 0103's tables, not the patient row (audit R30).
  SELECT count(*) INTO n FROM demo_seed_patient p
   WHERE NOT EXISTS (SELECT 1 FROM patient_contact c WHERE c.patient_id = p.id)
      OR NOT EXISTS (SELECT 1 FROM patient_external_provider x
                      WHERE x.patient_id = p.id AND x.role = 'referring');
  IF n > 0 THEN
    RAISE EXCEPTION 'demo seed: % patient(s) have no family contact or no referring physician', n;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Passwords, only when one is passed: -v demo_password=... gives every
-- seeded account that one password, bcrypt cost 12. Without it nothing
-- changes: a first run leaves every hash NULL, and no one can log in.
-- ----------------------------------------------------------------------------
\if :{?demo_password}
-- The password is in the next statement's text, and at bcrypt cost 12 that
-- statement runs long enough to trip a slow-statement log
-- (log_min_duration_statement; the RDS config logs anything over 2 s).
-- Statement logging is switched off for this transaction first. These are
-- superuser settings: the VPS runs this file as postgres, a local run as admin.
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = 'panic';
-- One hash for every seeded account (they share the password by design):
-- eight separate cost-12 hashes took about four seconds.
UPDATE app_user
   SET password_hash = h.hash
  FROM (SELECT crypt(:'demo_password', gen_salt('bf', 12)) AS hash) h
 WHERE app_user.email LIKE '%@demo.pallio.io'
   AND app_user.id IN (SELECT id FROM demo_seed_user);
\echo 'demo seed: password set on the seeded @demo.pallio.io accounts'
\endif

COMMIT;
