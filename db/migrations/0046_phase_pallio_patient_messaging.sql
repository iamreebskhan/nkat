-- ============================================================================
-- 0046 — Patient-scoped messaging (Phase F, nurses-only v1).
--
-- Per Mark's 2026-05-22 answer: he wants both nurse-to-nurse AND
-- nurse-to-patient/family eventually. v1 ships nurses-only (faster to
-- get into hands; doesn't gate on patient-portal auth). Patient-side
-- (F2) is a follow-up.
--
-- One thread per patient (auto-created on first post). Messages are
-- append-only after a 5-minute edit window. PHI is the message body
-- itself — every read writes an audit_log entry.
-- ============================================================================

CREATE TABLE IF NOT EXISTS patient_thread (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  patient_id      UUID         NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  created_by      UUID         NOT NULL REFERENCES app_user(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  UNIQUE (org_id, patient_id)
);

CREATE INDEX IF NOT EXISTS patient_thread_org_recent_idx
  ON patient_thread (org_id, last_message_at DESC NULLS LAST);

SELECT app.apply_tenant_rls('patient_thread');

CREATE TABLE IF NOT EXISTS patient_message (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  thread_id       UUID         NOT NULL REFERENCES patient_thread(id) ON DELETE CASCADE,
  author_user_id  UUID         NOT NULL REFERENCES app_user(id),
  body            TEXT         NOT NULL CHECK (length(body) > 0 AND length(body) <= 5000),
  /* @mentioned user ids extracted at write-time so notifications can fan out
     without re-parsing on every read. */
  mentioned_user_ids UUID[]    NOT NULL DEFAULT '{}'::uuid[],
  /* Read receipts: set of user_ids that have viewed this message. */
  read_by         UUID[]       NOT NULL DEFAULT '{}'::uuid[],
  /* Audit: edits inside the 5-min window write the previous body. */
  edited_at       TIMESTAMPTZ,
  edit_history    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patient_message_thread_time_idx
  ON patient_message (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS patient_message_mentions_gin
  ON patient_message USING GIN (mentioned_user_ids);

SELECT app.apply_tenant_rls('patient_message');

COMMENT ON TABLE patient_thread IS 'Phase F: one thread per (org, patient). v1 nurses-only.';
COMMENT ON TABLE patient_message IS 'Phase F: append-only after 5-min edit window. PHI; every read audited.';

-- ----------------------------------------------------------------------------
-- notification: lightweight per-user inbox for @mentions and platform
-- events. The UI polls or reads this table to render the bell badge.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id         UUID         NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind            TEXT         NOT NULL,                 -- e.g. 'patient_thread_mention'
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_user_unread_idx
  ON notification (user_id, created_at DESC)
  WHERE read_at IS NULL;

SELECT app.apply_tenant_rls('notification');
