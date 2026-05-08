# Phase 4 — NC + SC + Behavioral Health + 42 CFR Part 2 + MHPAEA + 271 Eligibility

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors.**
`npx jest --ci` → **24 test suites, 213 tests, 0 failures, ~14s wall clock.**

This phase replicates Ohio coverage to NC + SC, ships the behavioral-health
specialty pack, lands the **42 CFR Part 2 SUD consent hard-stop** + the
**MHPAEA parity engine** in the pre-flight orchestrator, and adds an X12
**271 eligibility-response parser** with the same PHI-safe posture as the
835 parser.

## New schema (db/migrations/0010_phase4_sud_mhpaea.sql)

| Change | Purpose |
|---|---|
| `code.is_sud_part2 BOOLEAN` (default false) | Flags SUD codes that fall under 42 CFR Part 2; lookup hard-stops without active TPO consent. |
| `code.specialty TEXT` | Light specialty tag for filtering: `behavioral_health`, `oncology`, `palliative`, `telemedicine`, `medical_surgical`, ... |
| `mhpaea_parity_pair` table | Catalog of (BH code ↔ med/surg code) pairs the parity engine compares, with classification (in/out network, inpatient/outpatient/emergency). |
| Partial indexes | `code (specialty) WHERE active`, `code (is_sud_part2=true) WHERE active`, `mhpaea_parity_pair (behavioral_health_code) WHERE active`. |

## New seed data

- **`db/seed/0008_phase4_payers.sql`** — 18 real-world payer rows: 5 NC Medicaid MCOs (post Apr 1 2026 merger), 5 SC Medicaid MCOs, 8 Ohio commercial + Medicaid plans. Deterministic UUIDs so re-runs are stable.
- **`db/seed/0009_behavioral_health_codes.sql`** — 25 BH codes (90791/2/4/7, 90832/4/7, 90838, 90846/7, 90853, 90839/40, plus E/M counterparts 99202/3/13/14 for parity), 8 H-codes for SUD, 7 mental-health ICD-10s, 6 MHPAEA parity pairs.
- **`db/seed/0010_oncology_codes.sql`** — 25 oncology codes: chemo administration (96401–96417), therapeutic infusions (96365–96368), hydration (96360/61), radiation (77386/77385/77373/77432), drug J-codes (J9035, J9170, J9355, J9264, J9303, J9217), labs, plus 7 oncology-relevant ICD-10s (C18/C50/C61/C34, Z51.0/11/12).

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `lookup/services/sud-consent.service.ts` | 42 CFR Part 2 hard-stop: returns one of `no_sud_codes` / `consent_active` / `consent_missing` / `consent_revoked` / `patient_unknown` for the codes on a claim. RLS-scoped via `runReadOnlyWithTenant`. | exercised in lookup orchestrator tests |
| `lookup/services/mhpaea-parity.engine.ts` | **Pure function** `evaluateParity(bh_code, ms_code, bh_rules, ms_rules) → ParityFlag[]`. Detects BH treated more restrictively on PA / frequency / cost-share / documentation NQTL. | 11 |
| `lookup/services/mhpaea-parity.service.ts` | DB wrapper: loads BH + paired med/surg rules per `mhpaea_parity_pair`, runs the engine. | exercised in orchestrator tests |
| `lookup/services/lookup.service.ts` | Extended with `checkSudConsent` + `checkMhpaeaParity`; orchestrator now plumbs `orgId` from controller. | 4 new |
| `lookup/dto/lookup-request.dto.ts` | Added optional `client_id` + `patient_external_id` for SUD consent path. | — |
| `lookup/lookup.controller.ts` | Now passes `orgId` to `lookup.run()` after AuthGuard. | — |
| `ingestion/edi271/types.ts` | `Edi271File`, `Edi271SubscriberCoverage`, `Edi271BenefitLine`. | — |
| `ingestion/edi271/parser.ts` | X12 271 parser; detects delimiters from ISA; handles `^` repetition + `:` sub-element separators on EB03; PHI-safe (no patient names ever stored). | 15 |
| `ingestion/edi271/edi271.controller.ts` | `POST /v1/eligibility/parse-271`, AuthGuard-protected. | — |
| `ingestion/edi271/edi271.module.ts` | Wiring. | — |

## SUD consent gating in the orchestrator

Pre-flight semantics for any claim that contains an `is_sud_part2 = TRUE` code:

| Status | Severity | Recommendation |
|---|---|---|
| `consent_active` | _no finding_ | proceed |
| `patient_unknown` | **critical** + carc_class `part2_consent` | "Add patient_external_id and confirm a signed TPO consent is on file before submission." |
| `consent_missing` | **critical** + carc_class `part2_consent` | "Obtain a signed TPO consent before submitting these claims." |
| `consent_revoked` | **critical** + carc_class `part2_consent` | "Obtain a new signed TPO consent (treatment + payment + operations) before re-submission." |

When the claim has no SUD codes the SUD service short-circuits without
querying `consent_record` at all.

## MHPAEA parity engine

Four classes of candidate violation flagged:

| Flag kind | Trigger | Confidence |
|---|---|---|
| `covered_only_for_med_surg` | BH `not_covered` while paired med/surg `covered` | 1.0 |
| `prior_auth_more_restrictive` | BH PA required, paired med/surg PA not required | 1.0 |
| `frequency_lower` | BH `value.per_year` < med/surg `value.per_year` | 0.9 |
| `cost_share_higher` | BH copay > med/surg copay | 0.85 |
| `documentation_heavier` | BH documentation_required has more required elements than paired med/surg | 0.7 |

Output is a candidate, not a verdict — the orchestrator surfaces the flag as
**warning** with a recommendation: "Review with parity counsel; this is a
candidate violation, not a confirmed one."

The engine handles stringified booleans/numbers (a real-world payer JSON
quirk), and aggregates multiple flags from the same pair.

## 271 EDI parser

Fixture-driven tests (15 specs) cover:

- Header (NM1 PR=payer, NM1 1P=provider) — names from `NM103` only, never `NM104` first-name fields. PHI-safe verified by string-search assertion that no name fragment leaks into output JSON.
- Subscriber id from `NM1*IL ... MI` qualifier + value pair.
- Group id from `REF*6P*<group>`.
- Coverage start (`DTP*346`) + end (`DTP*347`) dates.
- Active Coverage `EB*1` benefit lines with multi-code service types via either `^` or `:` composite separator.
- Copay `EB*B`, out-of-pocket max `EB*C`, inactive `EB*6`.
- Custom delimiters from ISA header (e.g. `|` element + `#` segment).
- Multiple subscribers in one file.
- Files without IEA still preserve the last subscriber.
- `unparsed_segments` capture for unknown tags (debug aid).

## Cumulative state at end of Phase 4

| Metric | After Phase 1 | After Phase 2 | After Phase 3 | **After Phase 4** |
|---|---|---|---|---|
| SQL migrations | 7 | 8 | 9 | **10** |
| Seed files | 7 | 7 | 7 | **10** |
| Backend modules | 11 | 14 | 18 | **20** |
| Test suites | 12 | 16 | 22 | **24** |
| Passing tests | 84 | 117 | 181 | **213** |
| Test wall clock | ~50s | ~19s | ~17s | ~14s |
| TypeScript errors | 0 | 0 | 0 | **0** |
| Real-world payer rows seeded | 0 | 0 | 0 | **18** |

## Hard constraints honored (no corner cutting)

- **42 CFR Part 2 hard-stop is unconditional.** SUD codes without active TPO consent get `severity='critical'`. There is no override flag, no soft warning, no "proceed anyway." Federal law.
- **PHI safety in 271 parser, verified by tests.** Patient name fields (`NM104` first / `NM105` middle) are never read or stored. The output JSON is asserted not to contain name fragments from the fixture.
- **MHPAEA flags are warnings, not verdicts.** Output explicitly recommends parity counsel review and labels each flag as candidate-only. Confidence is graded per flag kind so the UI can sort.
- **Extension test required for the orchestrator change.** When `run()`'s signature gained an `orgId` parameter, every existing lookup test was updated to pass it; a real bug (singleton race on a mutable field) was caught and removed before commit.
- **Real payer registry, not mocks.** NC + SC + Ohio rows have actual policy index URLs, parent_org names, payer_type discriminators — the data model is exercised end-to-end by the schema, not just the unit tests.
- **Rule-pair catalog explicit.** The MHPAEA engine reads from `mhpaea_parity_pair`, not from arbitrary inference. Each pair has a rationale + source URL + classification — auditable.

## Bugs caught + fixed during this session

1. **NM1 name field index off-by-one.** I had `name = seg.fields[1]` for payer/provider names; correct is `seg.fields[2]` (NM103 — entity field 1 is the type qualifier). Caught by fixture test.
2. **EB percent field index off-by-one.** Read `fields[8]` (EB09 — quantity qualifier); correct is `fields[7]` (EB08 — percent). Caught by test.
3. **EB03 service-type composite delimiter.** Original parser only split on the sub-element delimiter `:`. Real-world 271s use `^` (repetition separator) for compound EB03. Now accepts both. Caught by fixture.
4. **Fixture had non-standard EB segment field positions.** One too many empty separators between EB05 and EB06; fixed to standard X12 layout.
5. **Singleton-field race hazard in orchestrator.** Earlier draft stashed `orgId` on a private field — would race under concurrent requests. Reverted to explicit parameter passing through `checkSudConsent(req, dos, orgId)`. NestJS provider singletons must not hold per-request state.

All five caught by failing tests / mid-session review, fixed in the same
session, retested green.

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit         # 0 errors
npx jest --ci            # 213 tests pass in ~14s
```

Phase 5 (oncology pack expansion + DMEPOS + Workers' Comp + IHS + ASC +
HCC scoping + CMS-0057-F adapter scaffolding + SOC 2 Type 2 audit kickoff)
on `continue`.
