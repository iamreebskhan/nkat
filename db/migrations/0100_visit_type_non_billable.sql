-- ============================================================================
-- 0100_visit_type_non_billable.sql
--
-- Audit R18. The coding bands were a closed set of billable encounters, and one
-- of them could not be billed at all:
--
--   1. There was no way to say "not billed". A bereavement follow-up (a visit
--      to the family after the patient has died) or a caregiver-only visit could
--      only be entered as an alias of a billable band, so it coded an E/M at
--      sign-off. The settings screen's own placeholder suggested exactly that.
--   2. 'inpatient_consult' has no code ladder. The suggester codes nothing for
--      it, so the document screen refuses to sign it, and the code table holds
--      none of the inpatient, consult or SNF families. Every org was seeded with
--      it and could schedule it.
--
-- 'non_billable' is a band that codes nothing on purpose. The visit is
-- documented and signed and stops there: transitionVisit refuses
-- documented -> pending_billing, and buildDraftFromVisit refuses to raise a bill.
--
-- Runs after 0099, which took 'telehealth' out of this CHECK. Do not put it back.
-- ============================================================================

-- 1. 'non_billable' joins the bands. 'inpatient_consult' stays in the CHECK so
--    existing rows remain valid; the service no longer offers it for a new or
--    edited type (SELECTABLE_CODING_BASES).
ALTER TABLE org_visit_type DROP CONSTRAINT IF EXISTS org_visit_type_coding_basis_check;
ALTER TABLE org_visit_type ADD CONSTRAINT org_visit_type_coding_basis_check
  CHECK (coding_basis IN (
    'new_patient_home', 'established_patient_home',
    'advance_care_planning', 'inpatient_consult', 'non_billable'
  ));

-- 2. Stop offering inpatient consult where nothing uses it. A type a visit is
--    booked on stays as it is, and so does one in an org with no other active
--    type: updateVisitType's "keep at least one active visit type" rule. A
--    deactivated type can be switched back on from /settings/visit-types.
UPDATE org_visit_type t
   SET active = FALSE,
       updated_at = now()
 WHERE t.coding_basis = 'inpatient_consult'
   AND t.active
   AND NOT EXISTS (SELECT 1 FROM visit v
                    WHERE v.org_id = t.org_id AND v.visit_type = t.slug)
   AND EXISTS (SELECT 1 FROM org_visit_type o
                WHERE o.org_id = t.org_id
                  AND o.active
                  AND o.coding_basis <> 'inpatient_consult');

COMMENT ON COLUMN org_visit_type.coding_basis IS
  'The CPT band this type bills as. non_billable = documented and signed, never billed (audit R18). inpatient_consult has no code ladder and is not offered for new or edited types.';

-- Not done here on purpose: re-banding an org's own types. A custom type such
-- as "Bereavement follow-up" that bills like an established visit is the org's
-- setting to change on /settings/visit-types once the practice confirms it is
-- not billed. Candidates (read-only):
--   SELECT o.name, t.slug, t.label, t.coding_basis
--     FROM org_visit_type t JOIN org o ON o.id = t.org_id
--    WHERE t.label ILIKE '%bereave%' OR t.label ILIKE '%caregiver%';
--
-- Production pre-check (read-only), before applying — what step 2 will switch off:
--   SELECT o.name, t.slug, t.label,
--          (SELECT count(*) FROM visit v
--            WHERE v.org_id = t.org_id AND v.visit_type = t.slug) AS visits
--     FROM org_visit_type t JOIN org o ON o.id = t.org_id
--    WHERE t.coding_basis = 'inpatient_consult' AND t.active
--    ORDER BY 1;
