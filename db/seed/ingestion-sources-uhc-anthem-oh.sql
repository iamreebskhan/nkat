-- Ingestion sources for the round-2 documents.
--
-- UnitedHealthcare Community Plan Ohio had NO monitored source at all —
-- three documents' worth of prior-auth, provider-eligibility and
-- documentation rules with nothing watching them for change. Anthem Ohio
-- had two, both telehealth, neither carrying a prior-auth rule.
--
-- last_content_hash is seeded with the real SHA-256 of the copy the rules
-- were extracted from, so the first crawl compares against the truth
-- rather than starting blind and reporting a spurious change.
--
-- Cadence reflects how the document actually moves: the care provider
-- manual is republished annually but errata land mid-year, the E/M policy
-- carries a version history with three revisions in the last year, and
-- the prior-authorization lists are reissued on their own effective
-- dates. Monthly for the lists, weekly for the rest — the check is a HEAD
-- request and a hash compare, so it is cheap to be early.

BEGIN;

INSERT INTO ingestion_source (
  id, name, url, payer_id, state, document_type, schedule_cadence,
  last_content_hash, last_check_at, last_ingested_at, active, auto_extract,
  last_change_detected_at, last_rule_count, notes
) VALUES
  ('d2b4e6a1-0001-4c3f-8a11-9e5b7c2d4f01'::uuid,
   'UnitedHealthcare Community Plan Ohio — 2026 Care Provider Manual',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/admin-guides/comm-plan/OH-Care-Provider-Manual.pdf',
   'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'provider_manual', 'weekly',
   'sha256:3591a7e0f0400c51b9215cd5a0f8a02e128a11e8076e5714db6293f6296695ab',
   now(), now(), TRUE, TRUE, now(), 39,
   'Medical record documentation standards, provider enrolment and credentialing prerequisites, maximum daily frequency edit. 104 pages; prior-auth requirements live in a separate published list, not here.'),

  ('d2b4e6a1-0002-4c3f-8a11-9e5b7c2d4f02'::uuid,
   'UnitedHealthcare Community Plan — Nonphysician Health Care Professionals Billing E/M Codes Policy (2026R0112D)',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/policies/medicaid-comm-plan-reimbursement/UHCCP-Nonphysician-Health-Care-Professional-Billing-Evaluation-Mgmt-Codes-Policy.pdf',
   'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'reimbursement_policy', 'weekly',
   'sha256:edffe604be9d3c07ffa79ce17b43b464eb951718cb5d6afd36f4b70b0f33d6e9',
   now(), now(), TRUE, TRUE, now(), 25,
   'The single highest-value document for this payer: defines E/M as 98000-98016, 99091, 99202-99499 and names who may report it. Watch the State Exceptions table — its last three revisions were all to the Ohio row.'),

  ('d2b4e6a1-0003-4c3f-8a11-9e5b7c2d4f03'::uuid,
   'UnitedHealthcare Community Plan of Ohio — Prior Authorization Requirements',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/commplan/oh/prior-auth/OH-UHCCP-PA-Effective-11-1-2025.pdf',
   'a0000000-0000-4000-8000-000000000302'::uuid, 'OH', 'medical_policy', 'monthly',
   'sha256:55c13d6c9e95cd78ff4e9648691c5bafb6aa154513a30f70e843bf28b076f9c6',
   now(), now(), TRUE, TRUE, now(), 25,
   'Effective 11/1/2025. The URL carries its own effective date, so a new edition appears at a NEW url rather than changing this one — a hash check on this url will not see it. Re-check the Ohio prior-authorization index page when this stops resolving.'),

  ('d2b4e6a1-0004-4c3f-8a11-9e5b7c2d4f04'::uuid,
   'Anthem BCBS Ohio — Quick guide to services requiring prior authorization',
   'https://providernews.anthem.com/ohio/articles/quick-guide-to-services-requiring-prior-authorization-28751',
   'a0000000-0000-4000-8000-000000000303'::uuid, 'OH', 'medical_policy', 'monthly',
   'sha256:ca50e8421e4945ce05c65e0d52a72d770bac21773e70287f43507d3b8fff91ba',
   now(), now(), TRUE, FALSE, now(), 25,
   'auto_extract is FALSE deliberately: this page renders its content with JavaScript, so a plain fetch returns 13 characters of shell HTML. It was captured with a browser. An automated crawl would read the empty shell as "the rules disappeared" and retract 25 live rules. Needs a headless-browser fetch before auto_extract can be turned on.')
ON CONFLICT (id) DO UPDATE SET
  url = EXCLUDED.url, name = EXCLUDED.name,
  schedule_cadence = EXCLUDED.schedule_cadence,
  last_content_hash = EXCLUDED.last_content_hash,
  auto_extract = EXCLUDED.auto_extract, notes = EXCLUDED.notes,
  active = TRUE, updated_at = now();

COMMIT;
