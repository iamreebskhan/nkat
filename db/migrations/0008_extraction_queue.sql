-- ============================================================================
-- 0008_extraction_queue.sql
-- Analyst review pipeline + customer dispute / "this rule is wrong" workflow.
-- All tables are GLOBAL — analysts work on the central rule library.
--
-- Flow:
--   1. Crawler / parser produces an `extraction_candidate` (proposed payer_rule).
--   2. Analyst picks it from the queue, verifies (call payer, read source),
--      DECIDES: accept | reject | edit. Decision recorded in
--      `extraction_decision` (append-only audit).
--   3. On accept, system inserts the corresponding `payer_rule` row.
--   4. Customers can submit `rule_dispute` rows that flow back into the queue
--      with elevated priority.
-- ============================================================================

CREATE TABLE extraction_candidate (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_doc_id         UUID        NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  -- Proposed payer_rule shape (mirrors payer_rule columns)
  payer_id              UUID        NOT NULL REFERENCES payer(id),
  state                 CHAR(2)     NOT NULL REFERENCES state(state),
  product_line          TEXT        NOT NULL REFERENCES product_line(product_line),
  code                  TEXT        NOT NULL,
  attribute             TEXT        NOT NULL,
  proposed_value        JSONB       NOT NULL,
  proposed_coverage_status TEXT     NOT NULL CHECK (proposed_coverage_status IN ('covered','not_covered','varies','unknown')),
  proposed_confidence   NUMERIC(3,2) NOT NULL CHECK (proposed_confidence BETWEEN 0 AND 1),
  proposed_effective_date DATE       NOT NULL,
  proposed_expiration_date DATE,
  proposed_provider_taxonomy_allowed TEXT[] NOT NULL DEFAULT '{}',
  proposed_timely_filing_days INT,
  proposed_mhpaea_paired_code TEXT,
  source_quote          TEXT,
  source_page           INT,
  -- Provenance
  extractor_name        TEXT        NOT NULL,                -- e.g. 'ncd_lcd_ingestor', 'aetna_pdf_parser_v1'
  extractor_run_id      TEXT,
  -- Queue state
  status                TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN (
                          'queued','claimed','accepted','rejected','edited','superseded','withdrawn'
                        )),
  priority              SMALLINT    NOT NULL DEFAULT 50,    -- 0=lowest, 100=customer-disputed-and-money-on-the-line
  claimed_by            TEXT,                                 -- analyst email
  claimed_at            TIMESTAMPTZ,
  resulting_rule_id     UUID        REFERENCES payer_rule(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX extraction_candidate_status_priority_idx ON extraction_candidate
  (status, priority DESC, created_at)
  WHERE status IN ('queued', 'claimed');

CREATE INDEX extraction_candidate_lookup_idx ON extraction_candidate
  (payer_id, state, product_line, code, attribute);

CREATE TABLE extraction_decision (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id          UUID        NOT NULL REFERENCES extraction_candidate(id) ON DELETE CASCADE,
  decision              TEXT        NOT NULL CHECK (decision IN ('accept','reject','edit','withdraw')),
  edited_value          JSONB,                                -- when decision='edit'
  edited_coverage_status TEXT       CHECK (edited_coverage_status IN ('covered','not_covered','varies','unknown')),
  edited_confidence     NUMERIC(3,2),
  rationale             TEXT,
  attestation_call      JSONB,                                -- {payer, rep_name, rep_id, date, transcript_uri}
  decided_by            TEXT        NOT NULL,                 -- analyst email
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX extraction_decision_candidate_idx ON extraction_decision (candidate_id, decided_at DESC);

CREATE TABLE rule_dispute (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID        NOT NULL REFERENCES org(id) ON DELETE CASCADE,
  user_id               UUID        REFERENCES app_user(id),
  payer_rule_id         UUID        REFERENCES payer_rule(id),
  payer_id              UUID        NOT NULL REFERENCES payer(id),
  state                 CHAR(2)     NOT NULL REFERENCES state(state),
  product_line          TEXT        NOT NULL REFERENCES product_line(product_line),
  code                  TEXT        NOT NULL,
  attribute             TEXT        NOT NULL,
  customer_assertion    JSONB       NOT NULL,                 -- "what they say the right answer is"
  evidence_url          TEXT,
  customer_notes        TEXT,
  status                TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved_we_were_right','resolved_we_were_wrong','withdrawn')),
  resulting_candidate_id UUID       REFERENCES extraction_candidate(id),
  resolution_notes      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

CREATE INDEX rule_dispute_status_idx ON rule_dispute (status, created_at DESC);
CREATE INDEX rule_dispute_org_idx ON rule_dispute (org_id, created_at DESC);

-- rule_dispute is org-scoped → RLS-protect it like other tenant tables.
SELECT app.apply_tenant_rls('rule_dispute');

-- updated_at trigger for extraction_candidate
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TRIGGER extraction_candidate_updated_at
  BEFORE UPDATE ON extraction_candidate
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE extraction_candidate IS
  'Proposed payer_rule rows pending analyst review. Status flow: queued → claimed → (accepted | rejected | edited).';
COMMENT ON TABLE extraction_decision IS
  'Append-only audit of analyst decisions on extraction_candidate rows.';
COMMENT ON TABLE rule_dispute IS
  'Customer-submitted "this rule is wrong" reports. Tenant-scoped (RLS).';
