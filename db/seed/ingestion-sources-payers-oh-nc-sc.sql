-- Seed: real payer policy sources for OH / NC / SC.
--
-- WHY THIS EXISTS
-- The nightly cron (/api/cron/ingest-documents) fills the global rule
-- library by walking `ingestion_source`. That table has only ever held
-- three rows — a test-fixture Medicare PDF and two CMS URLs — so 16 of
-- 19 payers had no rule in the library and every lookup for them
-- returned "Unknown". The pipeline was never broken; it was never fed.
--
-- HOW THESE URLS WERE CHOSEN
-- Each was found by a research agent and then INDEPENDENTLY re-fetched
-- by a second agent before being accepted. 32 candidates were proposed,
-- 12 rejected: wrong scope for home-visit / ACP / prolonged-service
-- codes, a superseded policy revision, and one explicitly ARCHIVED and
-- RESCINDED document. Only the 20 that survived are here. Every URL is
-- on the payer's own domain (or the state Medicaid agency's), and every
-- one was confirmed to serve a real policy document rather than a
-- search page or login wall.
--
-- WHAT HAPPENS NEXT
-- The cron fetches each URL, hands the PDF/HTML to Claude, and extracts
-- rules that MUST carry a verbatim quote (lib/ai/document-rule-extractor
-- .ts refuses to invent). Rules land in `payer_rule` and become visible
-- to every tenant, with the org's own rulebook still taking precedence
-- (rule-lookup.service.ts §18.6 step 2).
--
-- CADENCE
-- monthly for provider manuals (they change on a published annual or
-- semi-annual cycle); weekly for payment/medical policies, which get
-- revised more often and are cheaper to re-check (content-hash dedupe
-- means an unchanged document costs one fetch and no Claude call).
--
-- KNOWN GAP — state Medicaid policies
-- A state clinical coverage policy governs EVERY Medicaid MCO in that
-- state, but `payer_rule.payer_id` is NOT NULL, so a rule cannot yet be
-- stored payer-agnostically. As an interim each distinct state-policy
-- URL is bound to one plan that had no document of its own. Once
-- payer_id is nullable these should be re-pointed at payer_id = NULL and
-- the state-Medicaid fallback in payer-rule.repository.ts will serve
-- them to every MCO in the state from a single ingestion.
--
-- Still WITHOUT any source after this seed: Molina Healthcare of Ohio,
-- Molina Healthcare of South Carolina, Medical Mutual of Ohio, First
-- Choice by Select Health. Their policy libraries sit behind a provider
-- portal login, which the crawler cannot reach. Those close via analyst
-- attestation instead, which now writes to the practice's own rulebook
-- and answers immediately.
--
-- Idempotent: re-running updates the row rather than duplicating it.

INSERT INTO ingestion_source (name, url, payer_id, state, document_type, schedule_cadence, active, notes)
VALUES
  -- ---------------------------------------------------------------- OH
  ('Humana Healthy Horizons Ohio — Provider Manual',
   'https://assets.humana.com/is/content/humana/2025_OH_Provider_Manualpdf',
   'a0000000-0000-4000-8000-000000000308', 'OH', 'provider_manual', 'monthly', TRUE,
   'Verified: "Humana Healthy Horizons does not require authorizations for home health assessments."'),

  ('Buckeye Health Plan — Payment Policy CC.PP.051 (High Complexity MDM E/M)',
   'https://www.buckeyehealthplan.com/content/dam/centene/policies/payment-policies/CC.PP.051.pdf',
   'a0000000-0000-4000-8000-000000000306', 'OH', 'reimbursement_policy', 'weekly', TRUE,
   'Covers the 99202-99499 E/M range incl. home visits and place of service.'),

  ('Buckeye Health Plan — 2026 Ohio Medicaid Provider Manual',
   'https://www.buckeyehealthplan.com/content/dam/centene/Buckeye/WebsitePDFs/Manuals/Buckeye_Provider%20Manual_BHP%20MEDICAID%20Provider%20Manual%202026_FINAL_amd%201.6.26-2-6kr.pdf',
   'a0000000-0000-4000-8000-000000000306', 'OH', 'provider_manual', 'monthly', TRUE,
   'Home health initial-evaluation CPT codes and retro-authorization rules.'),

  ('Anthem BCBS Ohio — ODM Telehealth Guidelines for Managed Care v6.0 (DOS 2026+)',
   'https://files.providernews.anthem.com/8041/OH-BCBS-CDFDE-010400-26-S2957-STATE-Updtd-ODM-Telehlth-Guidlns_FINAL.pdf',
   'a0000000-0000-4000-8000-000000000303', 'OH', 'state_medicaid_manual', 'weekly', TRUE,
   'Names home/residence E/M explicitly for new and established patients.'),

  ('Anthem Commercial — Reimbursement Policy C-08002 Virtual Visits',
   'https://files.providernews.anthem.com/4489/Virtual-Visits-BCBS-CM-02142024.pdf',
   'a0000000-0000-4000-8000-000000000303', 'OH', 'reimbursement_policy', 'weekly', TRUE,
   'Non-office place-of-service reimbursement criteria for virtual visits.'),

  ('Ohio Department of Medicaid — Telehealth Billing Guidelines 2026',
   'https://dam.assets.ohio.gov/image/upload/medicaid.ohio.gov/Providers/Billing/BillingInstructions/Telehealth_Billing_Guidelines_updates_for_2026_final.pdf',
   'a0000000-0000-4000-8000-000000000305', 'OH', 'state_medicaid_manual', 'monthly', TRUE,
   'ODM guidance; governs all Ohio Medicaid MCOs. Bound to CareSource on an interim basis — see the payer_id NOT NULL note in this file header.'),

  -- ---------------------------------------------------------------- SC
  ('Humana Healthy Horizons South Carolina — Prior Authorization List (services)',
   'https://assets.humana.com/is/content/humana/SC%20MDC%20PAL%20Cpdf',
   'a0000000-0000-4000-8000-000000000204', 'SC', 'medical_policy', 'weekly', TRUE,
   'Verified: prior auth required after five visits for 99344, 99501, 99502, T1021, T1030 and others.'),

  ('Absolute Total Care — SC Medicaid Provider Manual (Jan 2026)',
   'https://www.absolutetotalcare.com/content/dam/centene/absolute-total-care/2026-assets/2026-provider-docs/ATC%20SC%20Medicaid%20Provider%20Manual%20JAN%202026_FINAL.pdf',
   'a0000000-0000-4000-8000-000000000201', 'SC', 'provider_manual', 'monthly', TRUE,
   'Home health care prior-authorization rules, services in the place of residence.'),

  ('Absolute Total Care — Clinical Policy CP.MP.54 Hospice Services',
   'https://www.absolutetotalcare.com/content/dam/centene/absolute-total-care/policies/clinical-policies/CP.MP.54.pdf',
   'a0000000-0000-4000-8000-000000000201', 'SC', 'medical_policy', 'weekly', TRUE,
   'Continuous hospice home care medical-necessity criteria.'),

  ('Healthy Blue SC — Provider Administrative Office Manual (eff. 2026-07-01)',
   'https://www.healthybluesc.com/sites/default/files/BCMC_222622_26_Healthy%20Blue%20Provider%20Administrative%20Office%20Manual.pdf',
   'a0000000-0000-4000-8000-000000000203', 'SC', 'provider_manual', 'monthly', TRUE,
   'Verified: 50-visit per benefit year home health limit with named codes and PA requirements.'),

  -- ---------------------------------------------------------------- NC
  ('Carolina Complete Health — Provider Billing Manual',
   'https://network.carolinacompletehealth.com/content/dam/centene/carolinacompletehealth/pdfs/CCH-Current-Provider-Billing-Manual.pdf',
   'a0000000-0000-4000-8000-000000000104', 'NC', 'provider_manual', 'monthly', TRUE,
   'New-patient E/M frequency editing rules.'),

  ('Carolina Complete Health — 2026 Provider Manual',
   'https://network.carolinacompletehealth.com/content/dam/centene/carolinacompletehealth/pdfs/CCHE_PRV15_Provider_Manual_2026.pdf',
   'a0000000-0000-4000-8000-000000000104', 'NC', 'provider_manual', 'monthly', TRUE,
   'Telemedicine medical-necessity coverage criteria.'),

  ('NC Medicaid — CCP 1H Telehealth, Virtual Communications and RPM',
   'https://medicaid.ncdhhs.gov/media/12537/download?attachment',
   'a0000000-0000-4000-8000-000000000103', 'NC', 'state_medicaid_manual', 'monthly', TRUE,
   'Verified: hybrid telehealth with supporting home visits files with POS 12 (home). Bound to AmeriHealth Caritas on an interim basis.'),

  ('NC Medicaid — CCP 1H Telehealth (canonical policy page)',
   'https://medicaid.ncdhhs.gov/1h-telehealth-virtual-communications-and-remote-patient-monitoring/download?attachment=',
   'a0000000-0000-4000-8000-000000000101', 'NC', 'medical_policy', 'monthly', TRUE,
   'Canonical URL for CCP 1H. Bound to Healthy Blue NC on an interim basis.'),

  ('NC Medicaid — CCP 3D Hospice Services',
   'https://medicaid.ncdhhs.gov/3d-hospice-services/download?attachment=',
   'a0000000-0000-4000-8000-000000000104', 'NC', 'medical_policy', 'monthly', TRUE,
   'Hospice coverage policy — adjacent to palliative billing.'),

  ('NC Medicaid — CCP 3A Home Health Services',
   'https://medicaid.ncdhhs.gov/3a-home-health-services/download?attachment=',
   'a0000000-0000-4000-8000-000000000105', 'NC', 'state_medicaid_manual', 'monthly', TRUE,
   'Home health coverage policy. Bound to EBCI Tribal Option on an interim basis.'),

  ('UnitedHealthcare Community Plan NC — 2026 Care Provider Manual',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/admin-guides/comm-plan/NC-UHCCP-Care-Provider-Manual.pdf',
   'a0000000-0000-4000-8000-000000000102', 'NC', 'provider_manual', 'monthly', TRUE,
   'In-home hospice and routine home care benefit rules.'),

  ('UnitedHealthcare Community Plan — Prolonged Services Policy (Professional)',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/policies/medicaid-comm-plan-reimbursement/UHCCP-Prolonged-Services-Policy-Professional.pdf',
   'a0000000-0000-4000-8000-000000000102', 'NC', 'reimbursement_policy', 'weekly', TRUE,
   'Directly addresses 99417 and the 99358-99359 prolonged-service codes.'),

  ('UnitedHealthcare Community Plan — Telehealth/Virtual Health Policy (NC exception)',
   'https://www.uhcprovider.com/content/dam/provider/docs/public/policies/medicaid-comm-plan-reimbursement/UHCCP-Telehealth-Virtual-Health-Policy-Professional-and-Facility-R7133.pdf',
   'a0000000-0000-4000-8000-000000000102', 'NC', 'reimbursement_policy', 'weekly', TRUE,
   'POS 10 vs POS 12 home reimbursement, with a North Carolina state exception.')

ON CONFLICT (url) DO UPDATE SET
  name             = EXCLUDED.name,
  payer_id         = EXCLUDED.payer_id,
  state            = EXCLUDED.state,
  document_type    = EXCLUDED.document_type,
  schedule_cadence = EXCLUDED.schedule_cadence,
  active           = TRUE,
  notes            = EXCLUDED.notes,
  -- Clear the bookkeeping so the next cron tick re-fetches rather than
  -- assuming the previously-seen content hash still holds.
  last_check_at    = NULL,
  last_error       = NULL,
  updated_at       = now();

SELECT p.name AS payer, count(*) AS sources
  FROM ingestion_source s
  LEFT JOIN payer p ON p.id = s.payer_id
 WHERE s.active
 GROUP BY p.name
 ORDER BY 2 DESC, 1;
