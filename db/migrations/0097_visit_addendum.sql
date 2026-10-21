-- ============================================================================
-- 0097_visit_addendum.sql
--
-- Audit R15. Signing locks the note, and four messages told the clinician to
-- "record any change as a new addendum" — but nothing could accept one, so
-- every correction to a signed note happened outside the record.
--
-- An addendum is a signed, append-only statement added to an attested note.
-- It carries its author and the credential they held when they signed it (a
-- snapshot from clinician_profile, not a live join), and it cannot be changed
-- or removed once written.
-- ============================================================================

CREATE TABLE visit_addendum (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  visit_id           UUID        NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
  body               TEXT        NOT NULL
                                 CONSTRAINT visit_addendum_body_check
                                 CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  author_user_id     UUID        NOT NULL REFERENCES app_user(id),
  -- The author's credential at the moment of signing (same list as
  -- clinician_profile.credential). NULL when none was recorded.
  author_credential  TEXT        CONSTRAINT visit_addendum_credential_check
                                 CHECK (author_credential IS NULL OR author_credential IN
                                   ('MD', 'DO', 'NP', 'PA', 'CNS', 'RN', 'LCSW', 'OTHER')),
  signed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX visit_addendum_visit_idx ON visit_addendum (visit_id, signed_at);

SELECT app.apply_tenant_rls('visit_addendum');

-- Append-only. A cascade from deleting the visit or the org (tenant deletion)
-- is let through — it arrives at trigger depth > 1, from the FK's own
-- trigger. Nothing else may change or remove a signed addendum.
CREATE OR REPLACE FUNCTION app.visit_addendum_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'visit_addendum is append-only: a signed addendum cannot be changed or removed'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER visit_addendum_append_only
  BEFORE UPDATE OR DELETE ON visit_addendum
  FOR EACH ROW EXECUTE FUNCTION app.visit_addendum_append_only();

COMMENT ON TABLE visit_addendum IS
  'Signed, append-only corrections to an attested visit note (audit R15). Printed after the note in the preview, the audit packet and the patient record export.';
