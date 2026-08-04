-- 0058 — append-only activity history for a superbill.
--
-- Client walkthrough [06:09]: "us ki history humein likhni paregi — activity
-- history lazmi likhna: ke yeh pehle bill tha, yeh reject hua, aur ab yeh new
-- bill hai." When a payer rejects a claim (often because THEIR rules changed),
-- the nurse edits and resubmits — and the org must be able to show exactly what
-- the bill looked like before, why it was rejected, and what changed.
--
-- Append-only by design: rows are never updated or deleted, so the trail can be
-- trusted in an appeal or an audit.

CREATE TABLE IF NOT EXISTS superbill_activity (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  superbill_id   UUID        NOT NULL REFERENCES superbill(id) ON DELETE CASCADE,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Null for system/cron-driven entries (e.g. an ERA import).
  actor_user_id  UUID        REFERENCES app_user(id),
  kind           TEXT        NOT NULL CHECK (kind IN (
                   'created', 'edited', 'status_change',
                   'denial_logged', 'denial_decision', 'resubmitted'
                 )),
  from_status    TEXT,
  to_status      TEXT,
  -- One human-readable line — this is what the history renders.
  summary        TEXT        NOT NULL,
  -- Structured extras: changed fields, CARC code, amounts, etc.
  detail         JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS superbill_activity_bill_idx
  ON superbill_activity (superbill_id, at DESC);

SELECT app.apply_tenant_rls('superbill_activity');

COMMENT ON TABLE superbill_activity IS
  'Append-only history of a superbill: created → submitted → denied → edited → resubmitted. Never updated or deleted.';
