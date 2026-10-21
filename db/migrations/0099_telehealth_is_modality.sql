-- ============================================================================
-- 0099_telehealth_is_modality.sql
--
-- Audit R22. Telehealth was modelled twice, and neither model read the other:
--
--   1. As a CODING BAND: org_visit_type.coding_basis = 'telehealth', which the
--      CPT suggester routed to the established-patient ladder. A new patient
--      seen on the "Telehealth" type at 65 minutes coded 99350 + 99417
--      instead of 99344.
--   2. As a MODALITY: visit.is_telehealth, the checkbox that drives modifier
--      95/93 and place of service 10. The "Telehealth" type with the box left
--      unticked billed an in-person established visit at POS 12, no modifier.
--
-- Telehealth is how the encounter happened, not what kind of encounter it
-- was. The band now comes only from new vs established; the modality is the
-- visit's own flag, and a visit type can only force that flag ON.
--
-- Order matters: the flag is set before the re-band erases the only record of
-- which types were telehealth, and the CHECK is rewritten last so it does not
-- refuse the re-band. 0100 (audit R18) rewrites the same CHECK after this one.
--
-- Safe to re-run, also after 0100. Step 5 rewrites the CHECK only while it
-- still lists 'telehealth': once 0100 has added 'non_billable', putting this
-- four-band CHECK back is refused by any "Not billed" type. And the file is
-- one transaction, so a failure leaves the table as it was; under psql -f the
-- DROP used to commit on its own and the refused ADD left no CHECK at all.
-- ============================================================================

BEGIN;

-- 1. A visit type can force the telehealth modality on. scheduleVisit stamps
--    it onto the visit; documentVisit refuses to clear it.
ALTER TABLE org_visit_type
  ADD COLUMN IF NOT EXISTS is_telehealth BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Re-band every telehealth type to the ladder it already coded on (the
--    suggester sent 'telehealth' to the established ladder), keeping the flag.
--    What these types bill does not change.
UPDATE org_visit_type
   SET is_telehealth = TRUE,
       coding_basis  = 'established_patient_home',
       updated_at    = now()
 WHERE coding_basis = 'telehealth';

-- 3. Put the band in the name where the org never renamed the seeded type, so
--    nobody picks it for a new patient. A type the org renamed keeps its name.
UPDATE org_visit_type
   SET label = 'Established patient — telehealth',
       updated_at = now()
 WHERE slug = 'telehealth' AND label = 'Telehealth';

-- 4. Unsigned visits on those types become telehealth visits, so they carry
--    95/93 and POS 10 when signed. Signed visits are attested and stay exactly
--    as they were billed.
UPDATE visit v
   SET is_telehealth = TRUE,
       telehealth_modality = COALESCE(v.telehealth_modality, 'audio_video'),
       updated_at = now()
  FROM org_visit_type t
 WHERE t.org_id = v.org_id
   AND t.slug = v.visit_type
   AND t.is_telehealth
   AND NOT v.is_telehealth
   AND v.status IN ('scheduled', 'in_progress');

-- 5. 'telehealth' is no longer a coding band. Only while the CHECK still lists
--    it (see above). A table the old version of this step left with no CHECK
--    gets 0100's back by re-running 0100.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'org_visit_type'::regclass
                AND conname = 'org_visit_type_coding_basis_check'
                AND pg_get_constraintdef(oid) LIKE '%''telehealth''%') THEN
    ALTER TABLE org_visit_type DROP CONSTRAINT org_visit_type_coding_basis_check;
    ALTER TABLE org_visit_type ADD CONSTRAINT org_visit_type_coding_basis_check
      CHECK (coding_basis IN (
        'new_patient_home', 'established_patient_home',
        'advance_care_planning', 'inpatient_consult'
      ));
  END IF;
END $$;

-- 6. When the patient consented to telehealth at intake. Nothing on this
--    migration writes it; the intake step does. It pre-fills the per-visit
--    acknowledgment, which is still what signing a telehealth visit requires.
ALTER TABLE patient ADD COLUMN IF NOT EXISTS telehealth_consent_at TIMESTAMPTZ;

COMMENT ON TABLE org_visit_type IS
  'Org-owned visit types. coding_basis maps each to one of the built-in CPT bands so custom types cannot change what gets billed. Telehealth is not a band: is_telehealth forces the visit''s modality flag instead (audit R22).';
COMMENT ON COLUMN org_visit_type.is_telehealth IS
  'Visits of this type are always telehealth: scheduling sets visit.is_telehealth and documenting cannot clear it. Never changes the coding band.';
COMMENT ON COLUMN patient.telehealth_consent_at IS
  'When the patient consented to telehealth at intake. NULL = not recorded. Pre-fills, but does not replace, the per-visit consent acknowledgment.';

COMMIT;

-- Production pre-check (read-only), before applying — what step 4 will touch:
--   SELECT v.status, v.is_telehealth, count(*)
--     FROM visit v
--     JOIN org_visit_type t ON t.org_id = v.org_id AND t.slug = v.visit_type
--    WHERE t.coding_basis = 'telehealth'
--    GROUP BY 1, 2;
