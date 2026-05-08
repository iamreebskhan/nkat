# Phase 7 — Bedrock SDK + ASC Orchestrator Integration + HTTP Endpoints + HCC CSV Importer

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors.**
`npx jest --ci` → **34 test suites, 309 tests, 0 failures, ~28s wall clock.**

Combined with the browser extension (4 suites / 30 tests from Phase 6, unchanged), the platform is now **38 suites / 339 tests** across two codebases.

This phase closes the production loops left open at the end of Phase 6:

- **Live Bedrock wiring.** `BedrockSdkClient` adapter wraps `@aws-sdk/client-bedrock-runtime` to satisfy the abstract `BedrockClient` interface declared in Phase 6. Production AppModule provider can now inject either the deterministic provider or a Bedrock-backed one. Unit tests stub the SDK; no AWS credentials needed for CI.
- **Synthesis HTTP surface.** `POST /v1/synthesis` runs the configured provider per-tenant via the feature-flag dispatcher. Refusal responses get a 422 with a structured `reason`.
- **Risk-Adjustment HTTP surface.** `POST /v1/risk-adjustment/raf` accepts an array of ICD-10s and returns the V28 RAF score + breakdown + unmapped codes.
- **Webhook subscription CRUD** + **audit-log search**. Tenants can manage their own webhooks and run audit-trail queries for SOC 2 evidence — both RLS-scoped via `runWithTenant`/`runReadOnlyWithTenant`.
- **ASC integration in lookup orchestrator.** When `product_line === 'institutional_asc'`, the orchestrator now runs `AscService.evaluate(...)` and surfaces `asc_payment` cross-line findings. Tested for both `asc_not_payable` (critical) and `asc_office_based` (warning) paths.
- **HCC v28 CSV ingestion.** Full `parseHccCsv` + `HccCsvImporter` + CLI (`npm run ingest:hcc -- --file=hcc_v28.csv`). Importer is idempotent on the `hcc_mapping` PK, chunks 1000 rows at a time, and falls back to per-row inserts on chunk failure to isolate bad rows.

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `synthesis/bedrock-sdk-client.ts` | Concrete adapter wrapping `@aws-sdk/client-bedrock-runtime`; conforms to `BedrockClient` interface | 3 |
| `synthesis/synthesis.service.ts` | Feature-flag-driven provider dispatcher; falls back to deterministic when bedrock provider isn't registered | 6 |
| `synthesis/synthesis.controller.ts` | `POST /v1/synthesis`; refusals → 422 with structured reason | — |
| `risk-adjustment/risk-adjustment.controller.ts` | `POST /v1/risk-adjustment/raf` | — |
| `risk-adjustment/hcc-csv.ts` | Pure CSV parser (RFC 4180-ish): quoted-field handling, CRLF tolerance, header validation | 11 |
| `risk-adjustment/hcc-importer.ts` | Idempotent bulk loader with chunk + per-row fallback | — |
| `webhooks/webhook.controller.ts` | CRUD endpoints for `webhook_subscription` (create/list/pause/resume/disable); per-tenant signing-secret auto-generation if not provided | — |
| `admin/audit-log.controller.ts` | `GET /v1/admin/audit-log` keyset-paginated search | — |
| `lookup/services/lookup.service.ts` | Wired `checkAsc` cross-line check (only when product_line is `institutional_asc`) | +3 |
| `scripts/ingest-hcc-v28.ts` | CLI loader; idempotent re-runs | — |

## ASC integration

```typescript
// lookup orchestrator (cross-line phase)
if (req.product_line === 'institutional_asc') {
  cross.push(...(await this.checkAsc(req, dos)));
}
```

Severity mapping:
- `asc_not_payable` → **critical** + recommendation
- `asc_office_based` (A2 indicator) → **warning** + payment-rate caveat

Tested for: skip-when-not-ASC, fire-when-ASC, severity demotion for office-based. The full lookup test suite went from 19 to 22 specs without losing any prior behavior.

## Synthesis dispatcher

```
synthesis.enabled (tenant override → global default → false)
              │
              ▼
  ┌──────────────────────────┐
  │  refused 422              │ if !enabled
  │  reason='flag_disabled'   │
  └────────────┬─────────────┘
               │ enabled
               ▼
   synthesis.provider.name = 'bedrock' ?
              │  yes  → BedrockSynthesisProvider (if registered) → fallback to deterministic
              │  no   → DeterministicSynthesisProvider
              ▼
        SynthesisResult (or 422 SynthesisRefusedError)
```

Tested across all four paths (refused / deterministic-default / bedrock-when-registered / fallback-when-bedrock-missing) plus case-insensitive provider name lookup.

## HCC CSV format

| Column | Required | Notes |
|---|---|---|
| `icd10` | yes | First column convention; case-insensitive header |
| `hcc_code` | yes |  |
| `category` | no | Free-text human label |
| `rxhcc_code` | no |  |
| `raf_weight` | yes | Numeric; rejects non-finite |
| `effective_year` | yes | Integer 2020–2099 |

Tolerated: any column order, extra unknown columns (silently ignored), CRLF + LF, leading/trailing whitespace per field, RFC 4180 quoted strings with embedded commas + escaped quotes.

Rejected: missing required columns (throws once at header), per-row errors recorded but don't abort.

## Webhook subscription CRUD

```http
POST   /v1/admin/webhook-subscriptions      { url, event_types[], signing_secret? }
GET    /v1/admin/webhook-subscriptions
POST   /v1/admin/webhook-subscriptions/:id/pause
POST   /v1/admin/webhook-subscriptions/:id/resume
DELETE /v1/admin/webhook-subscriptions/:id   → status='disabled'
```

Hard rules:
- `event_types` validated against the closed enum from `database/schema.types.ts` (7 values).
- If caller doesn't supply `signing_secret`, server generates a fresh `randomBytes(32).toString('hex')`.
- All routes go through `runWithTenant` / `runReadOnlyWithTenant`; RLS at the DB layer enforces zero cross-tenant leakage.
- Disable is soft (`status='disabled'`); deliveries already in flight finish or dead-letter via the existing Phase 3 retry queue.

## Audit-log search

```http
GET /v1/admin/audit-log?action=accept_diff&since=2026-04-01&until=2026-05-01&limit=200
```

Keyset pagination on `occurred_at DESC` with a `next_cursor` token. Filters: `action`, `target_type`, `user_id`, `since` (≥), `until` (<), and `cursor` (<). Limit 1–500, default 100.

Designed for SOC 2 evidence collection — auditors run filtered queries and export the JSON for evidence packages.

## Cumulative state at end of Phase 7

| Metric | P1 | P2 | P3 | P4 | P5 | P6 | **P7** |
|---|---|---|---|---|---|---|---|
| SQL migrations | 7 | 8 | 9 | 10 | 11 | 12 | **12** |
| Seed files | 7 | 7 | 7 | 10 | 14 | 15 | **15** |
| Backend modules | 11 | 14 | 18 | 20 | 22 | 26 | **26** |
| Backend test suites | 12 | 16 | 22 | 24 | 27 | 31 | **34** |
| Backend tests | 84 | 117 | 181 | 213 | 249 | 285 | **309** |
| Extension test suites | — | — | — | — | — | 4 | 4 |
| Extension tests | — | — | — | — | — | 30 | 30 |
| **Combined tests** | 84 | 117 | 181 | 213 | 249 | 315 | **339** |
| HTTP endpoints | ~5 | ~7 | ~12 | ~13 | ~13 | ~13 | **~22** |
| TypeScript errors | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| External SDKs wired | 0 | 0 | 0 | 0 | 0 | 0 | **1 (Bedrock)** |

## Hard constraints honored (no corner cutting)

- **BedrockSdkClient is a thin adapter, no business logic.** Input/output translation only — no retries, no region defaults, no credential plumbing. Those are configuration concerns of the `BedrockRuntimeClient` instance the caller injects.
- **Synthesis controller maps `SynthesisRefusedError` to 422**, not 500. Refusal is a documented application state, not a server fault.
- **Synthesis service falls back to deterministic** when Bedrock provider config says `bedrock` but the SDK adapter isn't registered. Tested.
- **Webhook signing secret is auto-generated** with `randomBytes(32)` when caller doesn't supply one — strong default rather than a known-weak one.
- **Webhook DELETE is a soft-delete** (`status='disabled'`), preserving the Phase 3 dead-letter audit trail.
- **Audit-log search uses keyset pagination**, not OFFSET — handles months-old large logs without DB pain.
- **HCC importer is chunk-then-per-row resilient** — one bad row in a 1000-row chunk doesn't cost the rest. The first chunk-level failure is also recorded so telemetry doesn't lose the original error.
- **CSV parser tolerates real-world artifacts** — quoted commas, escaped quotes, CRLF, header order variation, unknown extra columns, whitespace — all tested.
- **ASC orchestrator integration is product-line-gated** (`institutional_asc` only) so it doesn't fire spurious findings on professional or hospital claims.

## Bug caught + fixed during this session

- **synthesis.service spec type-incompatibility**: `findings[].carc_class: string` literal-typed object wasn't assignable to `FindingDto[]` because `CarcClass` is a closed string-union. Fixed by typing `baseReq` as `SynthesisRequest` so TypeScript narrows the literals correctly. No runtime impact, but the strict-mode compiler caught it before the test ever ran.

## What's deliberately NOT in Phase 7

- **Live Bedrock integration tests against AWS.** Unit tests stub `BedrockRuntimeClient.send`. End-to-end against a real Bedrock endpoint is a Phase 7.5 task once the AWS HIPAA BAA is signed.
- **Browser extension Playwright E2E.** Unit-tested at the function level today; full Chrome-driver E2E is a follow-on.
- **Webhook subscription unit tests.** The controller is a thin pass-through to `runWithTenant` + Kysely; integration tests against a real Postgres (next phase) are more valuable than mock-heavy unit tests.

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit         # 0 errors
npx jest --ci            # 34 suites, 309 tests, ~28s

# Browser extension (unchanged from Phase 6)
cd ..\browser-extension
npx jest --ci            # 4 suites, 30 tests, ~13s

# Bulk-load V28 HCC CSV
cd ..\backend
npm run ingest:hcc -- --file=./data/hcc_v28.csv
```

Phase 8 (live Bedrock smoke against an AWS account + integration tests against
a real Postgres + browser extension Playwright E2E + customer success
playbook + production deployment runbook) on `continue`.
