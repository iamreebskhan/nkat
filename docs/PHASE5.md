# Phase 5 — DMEPOS + Workers' Comp + IHS + CMS-0057-F + HCC Risk Adjustment

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors.**
`npx jest --ci` → **27 test suites, 249 tests, 0 failures, ~25s wall clock.**

This phase ships the **DMEPOS Master List flagging** (KX/F2F/CMN/PA), the
**CMS-0057-F Prior Authorization API adapter** (typed FHIR client +
backfill), and the **HCC Risk Adjustment scoring engine** (V28 mapping +
hierarchy trumping + RAF computation). Plus state Workers' Comp fee
schedules and IHS T1015 encounter rates.

## New schema (db/migrations/0011_phase5_dme_wc_cms0057.sql)

| Table | Purpose | RLS |
|---|---|---|
| `dme_master_list` | CMS DMEPOS Master List entries (heightened doc/F2F/PA/CMN/$threshold) | global |
| `wc_state_fee_schedule` | State Workers' Comp conversion factors per year | global |
| `cms_0057_pa_response` | Cached FHIR PA responses for replay + analyst-queue backfill | tenant |
| `ihs_encounter_rate` | IHS All-Inclusive Rate per setting per year (Federal Register) | global |

## New seeds

- **`db/seed/0011_dmepos.sql`** — 13 DMEPOS HCPCS codes (mobility, beds, respiratory, diabetes, orthotics/prosthetics), 9 DMEPOS-specific modifiers (KX/GA/GZ/GY/GX/RR/NU/UE/LL), 5 modifier-relationship rules (NU/UE/RR mutual exclusion, GA/GZ exclusion, GA/GY distinct paths), 7 Master List entries with PA/F2F/CMN flags.
- **`db/seed/0012_workers_comp.sql`** — 6 state WC fee schedules (SC at $52 effective Apr 1 2026, plus CA/NC/OH/VA/NM), 3 WC T-codes.
- **`db/seed/0013_ihs.sql`** — T1015 encounter code, SE modifier, 4 IHS All-Inclusive Rates per Federal Register CY 2026 notice.
- **`db/seed/0014_hcc_v28.sql`** — 27 ICD-10 → HCC v28 mappings (diabetes / CHF / COPD / cancers / behavioral / SUD / dementia / renal / respiratory / cachexia) with RAF weights.

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `lookup/services/dmepos.service.ts` | Pure-fn `evaluateMasterListLine` + DB-backed `DmepostService`; flags PA/F2F/CMN/KX-missing/rental-purchase-conflict/below-threshold | 11 |
| `cms0057/pa-adapter.ts` | Typed FHIR R4 PA-API client (CoverageEligibilityResponse) + `cms_0057_pa_response` cache + pure `decodePaResponse` decoder | 11 |
| `cms0057/cms0057.module.ts` | Wiring | — |
| `risk-adjustment/hcc.service.ts` | Pure-fn `computeRaf` + DB-backed `HccRiskAdjustmentService`; V28 hierarchy trumping (HCC037 trumps HCC036+038, HCC222 trumps HCC224+226) | 11 |
| `risk-adjustment/risk-adjustment.module.ts` | Wiring | — |
| `lookup/services/lookup.service.ts` | Extended with `checkDmepos` cross-line check; `dmepos_master_list` CARC class | +2 |
| `lookup/dto/lookup-response.dto.ts` | +1 CarcClass: `dmepos_master_list` | — |

## DMEPOS pre-flight in the orchestrator

Every claim runs through `checkDmepos` after the existing per-line and
cross-line checks. For each line whose code appears on the DMEPOS Master
List:

| Issue kind | Severity | Recommendation |
|---|---|---|
| `master_list_pa_required` | warning | Confirm a PA approval is on file before submission. |
| `master_list_face_to_face_required` | warning | Verify the qualifying F2F note is in the chart and dated. |
| `master_list_cmn_required` | warning | Obtain CMS-484 / supplier-specific CMN before billing. |
| `kx_modifier_missing` | warning | Append KX after confirming the documentation is on file. |
| `master_list_below_threshold` | **info** | Below $ threshold; PA may not apply. |
| `rental_purchase_modifier_conflict` | warning | Pick a single disposition (NU=new purchase, UE=used, RR=rental). |

The `below_threshold` case is special: when the line's `billed_amount` is
*below* the Master List `payment_threshold_dollar`, PA / F2F / CMN
requirements may not apply. Rather than firing every requirement we surface
a single `info`-level hint. Verified by test.

## CMS-0057-F PA Adapter

Compliant with the Jan 1, 2027 mandate. The adapter:

1. **Issues a FHIR R4 GET** against `<payer>/CoverageEligibilityResponse` with `member`, `service-codes`, and `dos` query params.
2. **Decodes** via the pure `decodePaResponse(fhir, requested_codes)` function:
   - `pa_required` per-item, with most-restrictive-wins aggregation across matching items.
   - `decision` from the Da Vinci PAS-shaped extension (`extension-decision` URL) when present.
   - `documentation_codes` from `authorizationSupporting[].coding[].code`, deduped + alphabetically sorted for stable output.
   - Outcome handling: `queued`/`partial` → `pending`, `error` → `unknown`.
3. **Caches** the raw response into `cms_0057_pa_response` (RLS-tenant-scoped) for replay + audit.
4. **Promotes** to authoritative via the existing `extraction_candidate` flow with `extractor_name='cms_0057_pa_api'` and confidence 1.0 (analyst still sign-offs; this is the moat).

The fetch implementation is injected so tests stub network without nock or
msw.

## HCC Risk Adjustment

`computeRaf(icd10[], mappings) → { total_raf, breakdown, unmapped_icd10s }`:

1. Maps each ICD-10 to its highest-weighted V28 HCC.
2. Groups contributing ICD-10s under the resulting HCC.
3. **Applies hierarchy trumping**: when both a more-severe and less-severe HCC from the same family appear in a patient, the less-severe is marked `trumped` and excluded from the total.
4. Sums surviving HCCs.
5. Rounds to 4 decimal places for stable output.

Hierarchy seeded for the test set:
- `HCC037` (Diabetes w/ chronic complications) trumps `HCC036` (acute) and `HCC038` (no complications)
- `HCC222` (End-Stage HF) trumps `HCC224` (general) and `HCC226` (unspecified)

Real V28 has hundreds of these chains; this hard-coded subset matches
exactly what's in `db/seed/0014_hcc_v28.sql` so the unit tests exercise
the trumping logic honestly. Phase 6 imports the full V28 chain table from CMS.

## Cumulative state at end of Phase 5

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 | **Phase 5** |
|---|---|---|---|---|---|
| SQL migrations | 7 | 8 | 9 | 10 | **11** |
| Seed files | 7 | 7 | 7 | 10 | **14** |
| Backend modules | 11 | 14 | 18 | 20 | **22** |
| Test suites | 12 | 16 | 22 | 24 | **27** |
| Passing tests | 84 | 117 | 181 | 213 | **249** |
| Test wall clock | ~50s | ~19s | ~17s | ~14s | ~25s |
| TypeScript errors | 0 | 0 | 0 | 0 | **0** |
| Real payer rows seeded | 0 | 0 | 0 | 18 | 18 |
| Specialty packs covered | 1 (palliative) | 1 | 1 | 3 (+ BH + onc) | **6 (+ DMEPOS / WC / IHS)** |

## Hard constraints honored (no corner cutting)

- **DMEPOS rules are deterministic, citation-grounded.** Every Master List entry has `source_release` + `source_url`; every issue surfaces the URL.
- **CMS-0057-F decoder is a pure function.** `decodePaResponse(fhir, requested_codes)` has zero IO and is unit-tested across 11 cases including malformed/empty/queued/error/extension-decoded paths.
- **Most-restrictive-wins aggregation** in PA adapter matches federal-program convention (any "required" item makes the whole claim PA-required).
- **`cms_0057_pa_response` is tenant-scoped** (RLS) — PA queries are member-specific and the cache must not leak across orgs.
- **HCC hierarchy is explicit, not inferred.** The trumping map is hard-coded from V28 documentation; tests verify each chain (HCC037 trumps both 036 and 038; HCC222 trumps both 224 and 226).
- **Multi-mapped ICD-10 picks the highest-weighted HCC.** Tested explicitly. Some ICDs map to multiple HCCs at different RAF weights — picking the highest is the V28 convention.
- **HCC unmapped ICDs are reported, not silently dropped.** Sorted into `unmapped_icd10s` so the dashboard can show "12 ICDs contributed; 3 didn't map."
- **Rental-purchase mutual exclusion** (NU/UE/RR/LL) flagged at both the modifier-relationship layer (Phase 1 service) and the DMEPOS-specific layer — defense in depth.

## Bug caught + fixed during this session

- **`hcc_mapping.hcc_code` is NOT NULL.** Initial Z51.5 seed row used `null` for the HCC code (palliative isn't an HCC); the migration would have rejected it. Caught during seed review, removed the row with a comment explaining why.

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit         # 0 errors
npx jest --ci            # 249 tests pass in ~25s
```

End-to-end (Docker required):

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform
.\db\apply.ps1           # applies all 11 migrations + 14 seed files
cd backend
npm run start:dev

# Pre-flight a DMEPOS line:
$ORG = '11111111-1111-4111-8111-111111111111'
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/v1/lookup `
  -Headers @{ 'X-Org-Id' = $ORG } `
  -ContentType 'application/json' `
  -Body (@{
    payer_id = '...'; state = 'OH'; product_line = 'medicare_ffs';
    date_of_service = '2026-04-15';
    lines = @(@{ code = 'E0470'; modifiers = @() })
  } | ConvertTo-Json -Depth 5)

# Score a patient's RAF:
# (HccRiskAdjustmentService is exported from RiskAdjustmentModule;
# Phase 5.5 will expose a /v1/risk/raf endpoint.)
```

Phase 6 (full V28 HCC table import + ASC fee schedule + UB-04 institutional
deeper integration + LLM synthesis layer behind Bedrock + browser extension
v1) on `continue`.
