-- ============================================================================
-- 0079_verify_govinfo_via_federalregister.sql
--
-- Gives the govinfo copies of the CY2026 Physician Fee Schedule final rule a
-- route the drift checker can actually read: the same rule as published by
-- federalregister.gov.
--
-- THE PROBLEM
-- govinfo.gov serves FR-2025-11-05/2025-19787 as a 211 MB PDF. It answers
-- HTTP 200 and is simply too large to fetch and text-extract on a weekly
-- schedule, so the checker declines it and reports 'oversized'. Three
-- source_document rows point at it, carrying 22 live Medicare rules that have
-- therefore never been re-verified.
--
-- WHY federalregister.gov IS THE SAME DOCUMENT, NOT A SUBSTITUTE
-- Same Federal Register document number, 2025-19787, same publication date,
-- 5 November 2025. One is the print rendering, the other the web rendering of
-- one legal text. The library already cites the HTML copy for 1,689 rules and
-- it verifies clean at 7 MB.
--
-- This is demonstrated rather than assumed. Eight quotes on the HTML document
-- were reported drifted until scripts/recheck-source-drift.mjs learned to
-- normalise between the two renderings -- [[Page 49404]] against (Printed page
-- 49404), Leukine[supreg] against the registered-trademark glyph, TeX-style
-- ``quotes'', and a section marker that survives one rendering and not the
-- other. Those quotes were transcribed from the GOVINFO text and they match
-- the federalregister.gov HTML today. The two renderings are already known to
-- be interchangeable for quote-checking, because making them so is what fixed
-- that finding.
--
-- WHY A MIGRATION
-- These rows are created by the ingestion crawler at runtime, not by a seed,
-- so there is no seed file to carry the metadata. If the crawler later
-- rewrites source_metadata this will need re-applying; it writes into the
-- existing JSON rather than replacing it, so nothing else is lost meanwhile.
--
-- Idempotent. Touches no rule and no answer -- only how a document is read.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE _govinfo ON COMMIT DROP AS
SELECT id, url FROM source_document
 WHERE url LIKE '%govinfo.gov%2025-19787%';

UPDATE source_document sd
   SET source_metadata = coalesce(sd.source_metadata, '{}'::jsonb) || jsonb_build_object(
         'verifyVia', 'https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other',
         'verifyViaNote', 'govinfo serves this rule as a 211 MB PDF, too large to verify weekly. Same Federal Register document (2025-19787, 5 Nov 2025), read through its HTML rendering, which the library already cites for 1,689 rules.')
  FROM _govinfo g
 WHERE sd.id = g.id
   AND sd.source_metadata->>'verifyVia' IS DISTINCT FROM
       'https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other';

DO $$
DECLARE
  n_docs INT; n_rules INT; n_target INT;
BEGIN
  SELECT count(*) INTO n_docs FROM _govinfo;

  SELECT count(*) INTO n_rules
    FROM payer_rule r JOIN _govinfo g ON g.id = r.source_doc_id
   WHERE r.effective_date <= CURRENT_DATE
     AND (r.expiration_date IS NULL OR r.expiration_date > CURRENT_DATE);

  -- The document being pointed AT must actually be in the library, otherwise
  -- this writes a route to something nobody has ever read.
  SELECT count(*) INTO n_target FROM source_document
   WHERE url = 'https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other';

  IF n_docs > 0 AND n_target = 0 THEN
    RAISE EXCEPTION '0079: refusing — the federalregister.gov rendering is not a document in this library, so it cannot be offered as a route to the same text';
  END IF;

  IF n_docs = 0 THEN
    RAISE NOTICE '0079: no govinfo copies of FR 2025-19787 here — nothing to do';
  ELSE
    RAISE NOTICE '0079: % govinfo document(s) given a readable route, covering % live rule(s)', n_docs, n_rules;
    RAISE NOTICE '0079: they will report as "ok (mirror)" and name the URL actually read, never as verified at the cited address';
  END IF;
END $$;

COMMIT;
