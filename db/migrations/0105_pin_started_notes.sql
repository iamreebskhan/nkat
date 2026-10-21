-- ============================================================================
-- 0105_pin_started_notes.sql
--
-- Pin every note that has already been started to its org's active template
-- version, so the next edit on Settings -> Note template cannot reshape it.
--
-- visit.note_template_id pins a visit to the template version its note is
-- written under. The note editor, the note preview and audit packet, the sign
-- guard, the payer documentation check and the patient export all resolve
-- COALESCE(visit.note_template_id, the org's active template). Until now only
-- saving a section set the pin, so notes started any other way were left
-- unpinned and silently followed the active template:
--
--   * notes started only by carry-forward, before carry-forward pinned;
--   * vitals-only notes (recording vitals never pinned);
--   * seeded or imported notes written straight into visit_note_section;
--   * notes held only in the legacy free-text column, visit.document_text,
--     which no screen writes any more but the API still accepts.
--
-- After a template edit, their written sections vanished from the editor AND
-- the preview while the sign guard still counted them. The settings page
-- promises the opposite ("Notes already started, signed or not, keep their
-- version"). The app now pins on every write that starts a note (section
-- save, carry-forward, vitals) and at sign-off. This backfills the notes
-- started before that.
--
-- What it pins: a visit with no pin that has a non-empty section, a
-- visit_vitals row, legacy free text a clinician actually wrote, or is already
-- signed (documented, pending_billing, billed). Signed visits are included so
-- a note attested before sign-off pinned cannot change version on a later edit
-- either, the same guarantee sign-off now gives.
--
-- "Legacy free text a clinician actually wrote" is noteIsEmpty's rule
-- (lib/features/visits/visit-pure.ts) in SQL. An untouched editor still
-- serialises to a document — an empty doc, or one empty paragraph — and
-- neither is a started note, so the test asks for a text node holding a
-- non-whitespace character, and counts a row that is not JSON at all
-- (pre-TipTap plain text) as written. Deliberately narrower than noteIsEmpty,
-- which also counts a leaf carrying no text at all, such as a pasted image:
-- under-pinning is safe, because such a note takes its pin on its next write
-- or at sign-off anyway.
--
-- Pinned to: the org's ACTIVE version, the one each of these notes resolves
-- to, and is shown under, today. So this changes nothing on screen when it
-- runs; it only stops the next edit changing it. It cannot restore a section
-- an EARLIER edit already hid (that text is still in visit_note_section); the
-- pre-check's template_versions column flags orgs where that may have
-- happened. note_template_one_active_per_org guarantees at most one active
-- version per org, so the join below picks exactly one.
--
-- Skipped: visits in an org with no active template. ensureNoteTemplate
-- creates version 1 the first time any note in an org is read or written, so
-- such an org has never had a section or vitals recorded through the app, and
-- its visits have no structured content to hide (locally: one org, 212
-- visits, legacy free text at most). They stay unpinned and take a pin when
-- they are next written or signed. The pre-check counts them.
--
-- Idempotent: only NULL pins are written, so a second run updates nothing.
-- visit.updated_at is left alone; this is bookkeeping, not an edit to the
-- visit.
--
-- Read-only pre-check, to run on production first as the migration role
-- (under RLS as app it sees one org or none). It changes nothing:
--
--   SELECT v.org_id,
--          count(*)                                         AS unpinned_started,
--          count(*) FILTER (WHERE nt.id IS NULL)            AS skipped_no_active_template,
--          count(*) FILTER (WHERE v.status IN ('documented', 'pending_billing', 'billed'))
--                                                           AS signed,
--          (SELECT count(*) FROM note_template x WHERE x.org_id = v.org_id)
--                                                           AS template_versions
--     FROM visit v
--     LEFT JOIN note_template nt ON nt.org_id = v.org_id AND nt.is_active
--    WHERE v.note_template_id IS NULL
--      AND (EXISTS (SELECT 1 FROM visit_note_section s
--                    WHERE s.visit_id = v.id AND NOT s.is_empty)
--           OR EXISTS (SELECT 1 FROM visit_vitals vv WHERE vv.visit_id = v.id)
--           OR (btrim(coalesce(v.document_text, '')) <> ''
--               AND CASE WHEN btrim(v.document_text) ~ '^[{[]'
--                        THEN jsonb_path_exists(v.document_text::jsonb,
--                               '$.**.text ? (@ like_regex "\\S")')
--                        ELSE TRUE END)
--           OR v.status IN ('documented', 'pending_billing', 'billed'))
--    GROUP BY v.org_id
--    ORDER BY v.org_id;
--
--   This migration pins unpinned_started - skipped_no_active_template visits.
--   template_versions > 1: the org has already edited its template, so some
--   of these notes may already be showing a later version than they were
--   started under. Review those before running.
-- ============================================================================

BEGIN;

-- visit, visit_note_section and visit_vitals are under row-level security.
-- Only a role that bypasses it sees every org's rows: the deploy superuser
-- does (0052: `postgres` on prod, `admin` locally and in CI). Any other role
-- would see no visits, pin nothing, and report success. So refuse instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles
                  WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '0105 needs a role that bypasses row-level security (superuser or BYPASSRLS); % does not', current_user;
  END IF;
END $$;

UPDATE visit v
   SET note_template_id = nt.id
  FROM note_template nt
 WHERE nt.org_id = v.org_id
   AND nt.is_active
   AND v.note_template_id IS NULL
   AND (EXISTS (SELECT 1 FROM visit_note_section s
                 WHERE s.visit_id = v.id AND NOT s.is_empty)
        OR EXISTS (SELECT 1 FROM visit_vitals vv WHERE vv.visit_id = v.id)
        -- noteIsEmpty's rule: see the header. An untouched editor's document
        -- is not a started note; any text node with a non-whitespace
        -- character is, and so is a row that is not JSON at all.
        OR (btrim(coalesce(v.document_text, '')) <> ''
            AND CASE WHEN btrim(v.document_text) ~ '^[{[]'
                     THEN jsonb_path_exists(v.document_text::jsonb,
                            '$.**.text ? (@ like_regex "\\S")')
                     ELSE TRUE END)
        OR v.status IN ('documented', 'pending_billing', 'billed'));

COMMIT;
