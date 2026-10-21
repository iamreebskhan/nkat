-- ============================================================================
-- 0095_visit_place_of_service.sql
--
-- Audit R23. Where a visit took place was never recorded. Every claim was
-- billed as place of service 12 (home), or 10 for telehealth, by inference —
-- an assisted-living, nursing-facility or hospice visit went out as a home
-- visit, and nothing on the note could contradict the claim.
--
-- The visit now records it (prefilled 12 or 10 on the document screen), and
-- the claim, the bill page, the PDF, the note header and the reconciliation
-- all carry it. No backfill: visits documented before this stay NULL, so the
-- reconciliation says "not recorded" instead of pretending it was.
--
-- `pos` is the CMS reference table (0002), filled by db/seed/0002_pos.sql.
-- ============================================================================

ALTER TABLE visit ADD COLUMN IF NOT EXISTS place_of_service_code TEXT REFERENCES pos(pos);

COMMENT ON COLUMN visit.place_of_service_code IS
  'Where the encounter took place (CMS place of service). The source of the claim''s place_of_service_code. NULL on visits documented before 0095.';
