-- ============================================================================
-- 0020_local_clinical_fixture.sql
--
-- DELIBERATELY NOT IN db/seed/MANIFEST. Per the manifest's own rule, a seed
-- that is not listed is never applied to production — that is how fixtures
-- stay out. Run this by hand against a local database only:
--
--   psql "$DATABASE_URL" -f db/seed/0020_local_clinical_fixture.sql
--
-- WHY THIS EXISTS. db/seed contains reference data and payer rules and no
-- clinical rows at all: no org, no patient, no visit. A developer with a
-- freshly migrated local database therefore cannot open a visit, cannot
-- document one, cannot sign one and cannot generate a superbill — the entire
-- clinician path is unreachable locally, which is why it went untested while
-- the rulebook half was exercised repeatedly. This gives that path something
-- to stand on.
--
-- It seeds two visits on purpose:
--   * V1 has an EMPTY note. It is the reproduction fixture for the defect
--     where a visit can be signed, attested and submitted for billing with no
--     documentation at all.
--   * V2 has a real note. It is the CONTROL: any guard added to the signing
--     path must still let V2 through, or the guard is wrong.
--
-- Idempotent: deterministic ids + ON CONFLICT, so it can be re-run.
-- ============================================================================

-- Org 1111… is the design-partner org that 0017_test_users.sql already
-- attaches its four test users to, so the two seeds compose.
INSERT INTO org (id, name, slug, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Design Partner', 'design-partner', 'active')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status;

-- The clinician of record. 0017 seeds this user; repeated here so this file
-- stands alone against a database where only migrations have run.
INSERT INTO app_user (id, email, full_name, status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin@design-partner.test', 'Test Admin', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_member (org_id, user_id, role, status, joined_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin', 'active', now())
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Permissions do NOT come from org_member.role. login() reads them from
-- user_permission (auth.service.ts:116-122); signup is what populates that
-- table with ROLE_DEFAULT_PERMISSIONS.org_admin. 0017_test_users.sql creates
-- app_user + org_member and stops, so every seeded user logs in with almost no
-- permissions and the whole app renders "Permission denied" — which is exactly
-- what happens if you try to use the test users to look at anything.
--
-- This grants the org_admin set. Keep it in step with ROLE_DEFAULT_PERMISSIONS
-- in lib/features/team/team.types.ts.
INSERT INTO user_permission (org_id, user_id, permission)
SELECT '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', p
  FROM unnest(ARRAY[
    'patients.list','patients.view','patients.create','patients.edit','patients.archive',
    'patients.careteam.edit','patient.acuity.edit',
    'visits.view.own','visits.view.all','visits.create','visits.edit','visits.submit',
    'careplans.view','careplans.edit',
    'schedule.view','schedule.create','schedule.edit',
    'billing.lookup.view','billing.lookup.export',
    'billing.superbills.view','billing.superbills.create','billing.superbills.edit',
    'billing.superbills.export','superbill.predict',
    'billing.denials.view','billing.denials.log','billing.denials.refile','billing.denials.writeoff',
    'cheatsheets.view','cheatsheets.generate','cheatsheets.download',
    'knowledge.view','knowledge.upload','knowledge.attest','knowledge.edit',
    'reports.view','reports.export',
    'team.view','team.invite','team.permissions','team.deactivate',
    'settings.view','settings.org','settings.payers','settings.integrations',
    'audit.view','messaging.read','messaging.send'
  ]) AS p
ON CONFLICT DO NOTHING;

-- Visit types. visit.visit_type is an org-owned slug and the CPT suggester
-- branches on coding_basis, never on the slug, so every band needs a row or a
-- scheduled visit codes nothing. 'telehealth' is an established visit with the
-- telehealth modality forced on, not a band of its own (audit R22, 0099).
-- 'inpatient_consult' is kept but inactive, as 0100 leaves it where no visit
-- uses it: nothing can code it (audit R18). active follows each row, so a
-- re-seed does not switch it back on.
INSERT INTO org_visit_type (org_id, slug, label, coding_basis, is_telehealth, sort_order, active) VALUES
  ('11111111-1111-4111-8111-111111111111', 'new_patient_home',         'New patient — home',               'new_patient_home',         FALSE, 1, TRUE),
  ('11111111-1111-4111-8111-111111111111', 'established_patient_home', 'Established patient — home',       'established_patient_home', FALSE, 2, TRUE),
  ('11111111-1111-4111-8111-111111111111', 'advance_care_planning',    'Advance care planning',            'advance_care_planning',    FALSE, 3, TRUE),
  ('11111111-1111-4111-8111-111111111111', 'telehealth',               'Established patient — telehealth', 'established_patient_home', TRUE,  4, TRUE),
  ('11111111-1111-4111-8111-111111111111', 'inpatient_consult',        'Inpatient consult',                'inpatient_consult',        FALSE, 5, FALSE)
-- Conflict target must match the real index, which is on the LOWERED slug:
-- org_visit_type_org_slug_idx ON (org_id, lower(slug)).
ON CONFLICT (org_id, lower(slug)) DO UPDATE
  SET label = EXCLUDED.label, coding_basis = EXCLUDED.coding_basis,
      is_telehealth = EXCLUDED.is_telehealth, active = EXCLUDED.active;

-- Two patients with palliative-plausible ages and diagnoses.
INSERT INTO patient (id, org_id, first_name, last_name, date_of_birth, state, status) VALUES
  ('f0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   'Stephen', 'Singleton', DATE '1936-01-19', 'OH', 'active'),
  ('f0000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   'Grace', 'Hopper', DATE '1942-03-08', 'OH', 'active')
ON CONFLICT (id) DO UPDATE
  SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
      date_of_birth = EXCLUDED.date_of_birth, status = EXCLUDED.status;

-- V1 — THE REPRODUCTION. 60 documented minutes, no documentation.
INSERT INTO visit (
  id, org_id, patient_id, clinician_user_id, visit_type,
  scheduled_start, start_time, stop_time, total_minutes, acp_minutes,
  document_text, status
) VALUES (
  'e0000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111',
  'f0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'new_patient_home',
  now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour', 60, 0,
  NULL, 'in_progress'
)
ON CONFLICT (id) DO UPDATE
  SET document_text = NULL, status = 'in_progress', signed_at = NULL,
      signed_by_user_id = NULL, total_minutes = 60;

-- V2 — THE CONTROL. Same shape, but genuinely documented.
INSERT INTO visit (
  id, org_id, patient_id, clinician_user_id, visit_type,
  scheduled_start, start_time, stop_time, total_minutes, acp_minutes,
  document_text, status
) VALUES (
  'e0000000-0000-4000-8000-00000000000b', '11111111-1111-4111-8111-111111111111',
  'f0000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'established_patient_home',
  now() - interval '4 hours', now() - interval '4 hours', now() - interval '3 hours', 45, 0,
  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"HPI: 84-year-old with advanced COPD, seen at home for symptom management. Reports increased dyspnea on exertion over the past week."}]}]}',
  'in_progress'
)
ON CONFLICT (id) DO UPDATE
  SET status = 'in_progress', signed_at = NULL, signed_by_user_id = NULL;

-- V3 — a FOLLOW-UP for the same patient as V1, so carrying a note forward from
-- one signed visit into the next has something to act on. Empty on purpose.
INSERT INTO visit (
  id, org_id, patient_id, clinician_user_id, visit_type,
  scheduled_start, start_time, stop_time, total_minutes, acp_minutes,
  document_text, status
) VALUES (
  'e0000000-0000-4000-8000-00000000000c', '11111111-1111-4111-8111-111111111111',
  'f0000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'established_patient_home',
  now(), now() - interval '30 minutes', now(), 30, 0,
  NULL, 'in_progress'
)
ON CONFLICT (id) DO UPDATE
  SET document_text = NULL, status = 'in_progress', signed_at = NULL,
      signed_by_user_id = NULL;

-- V4 — a future, still-'scheduled' visit so the schedule board has something on
-- it. Rescheduling is only meaningful for a visit that has not happened yet, so
-- without one of these the board renders empty and the move path is untestable.
INSERT INTO visit (
  id, org_id, patient_id, clinician_user_id, visit_type,
  scheduled_start, status
) VALUES (
  'e0000000-0000-4000-8000-00000000000d', '11111111-1111-4111-8111-111111111111',
  'f0000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'established_patient_home',
  date_trunc('week', now()) + interval '1 day 10 hours', 'scheduled'
)
ON CONFLICT (id) DO UPDATE
  SET scheduled_start = date_trunc('week', now()) + interval '1 day 10 hours',
      status = 'scheduled';
