# Phase 1 — Medicare core lookup: Status

## Done — verified by passing tests this session

**Backend scaffold** (`backend/`) — NestJS 11 + TypeScript strict mode + Kysely + pg + pino:
- `npm install` clean (741 packages).
- `npx tsc --noEmit` → **zero errors**.
- `npx jest --ci` → **12 suites, 84 tests, all passing** (~50s).

### Modules built

| Path | Purpose | Tests |
|---|---|---|
| `src/config/env.ts` | Zod-validated env, fail-fast at startup | 6 |
| `src/common/uuid.ts` | Strict v1–v5 UUID validator (used at every trust boundary) | 4 |
| `src/database/{pool,db,schema.types}.ts` | pg pool + Kysely + hand-written types for all 32 tables | — |
| `src/database/rls-transaction.ts` | `runWithTenant(db, orgId, work)` opens tx, validates UUID, `SET LOCAL app.current_org_id`, runs work | 3 |
| `src/observability/logger.ts` | Pino logger with PHI redaction (mrn, ssn, dob, member_id, authz, cookies, …) | 3 |
| `src/auth/auth.guard.ts` | `dev_header` mode (X-Org-Id) + jwt placeholder; refuses dev mode in production | 6 |
| `src/lookup/services/payer-rule.repository.ts` | DOS-aware `payer_rule` lookup with source-doc citation join | — |
| `src/lookup/services/modifier.service.ts` | Modifier hierarchy + payer applicability + mutual-exclusion (NCCI XE/XP/XS/XU > 59) | 11 |
| `src/lookup/services/ncci.service.ts` | PTP edits + MUE units check, modifier-indicator override aware | 7 |
| `src/lookup/services/timely-filing.service.ts` | Days-from-DOS vs payer's filing window | 4 |
| `src/lookup/services/cob.service.ts` | Coordination-of-Benefits primary determination | 11 |
| `src/lookup/services/icd10-medical-necessity.service.ts` | Diagnosis ↔ procedure link against LCD/NCD ICD-10 list | — |
| `src/lookup/services/provider-taxonomy.service.ts` | Allowed taxonomy check | — |
| `src/lookup/services/lookup.service.ts` | Orchestrator; refuses below confidence 0.5 | 10 |
| `src/lookup/lookup.controller.ts` | `POST /v1/lookup`, validated, `AuthGuard`-protected | — |
| `src/health/health.controller.ts` | `/healthz` (liveness) + `/readyz` (DB roundtrip) | — |
| `src/ingestion/cms-coverage-api.client.ts` | Typed wrapper for `api.coverage.cms.gov`; license-token handshake; injectable fetch | 6 |
| `src/ingestion/ncd-lcd.ingestor.ts` | Maps LCD details → `source_document` + `payer_rule` rows; idempotent on `content_hash` | 5 |
| `scripts/ingest-palliative.ts` | CLI: per-state palliative LCD ingestion with `--dry-run` | — |
| `src/main.ts` | Bootstrap with global validation pipe, Swagger UI, URI versioning | — |

### Lookup pipeline coverage by CARC class

| CARC | Class | Service | Verified |
|---|---|---|---|
| 11 | Medical necessity ICD-10 | `MedicalNecessityService` | unit test in orchestrator |
| 16 | Missing/invalid info | DTO `class-validator` constraints | exercised |
| 97 | Bundled (NCCI PTP/MUE) | `NcciService` | 7 tests incl. modifier-override |
| 4 | Wrong/missing modifier | `ModifierService` | 11 tests incl. hierarchy + mutual exclusion |
| 50 | Coverage criteria | `PayerRuleRepository` + orchestrator | 4 orchestrator tests |
| 29 | Past timely filing | `TimelyFilingService` | 4 tests |
| 22/24 | COB primary determination | `CobService` | 11 tests (payer_type → coverage_type map) |
| 170/185 | Provider eligibility | `ProviderTaxonomyService` | exercised in orchestrator |
| ABN | Beneficiary liability flow | `LookupService` recommends ABN on not_covered | 1 test |

### Refusal-on-low-confidence

Threshold = 0.5. Coverage rule below threshold → `severity='warning'` with `recommendation: "Flag for analyst attestation."` Verified by `lookup.service.spec.ts › refuses (warning) when coverage rule is below confidence threshold`.

### Tenant isolation guarantee

- `app` DB role is `NOBYPASSRLS`.
- Every tenant-touching code path goes through `runWithTenant(db, orgId, work)`.
- The helper validates `orgId` against the strict UUID regex *before* any SQL runs (verified by `rls-transaction.spec.ts`); SQL injection-shaped strings rejected.
- `SET LOCAL app.current_org_id = '<uuid>'` is emitted via Kysely's `sql.lit()` literal, transactionally scoped.
- DB-level test (`db/test/0002_rls_isolation.sql`) verifies cross-tenant reads return zero rows and cross-tenant writes are blocked.

### CI

`.github/workflows/ci.yml` runs three jobs on every PR:
1. **backend-typecheck-test** — install + lint + tsc + jest.
2. **schema-apply** — boots `pgvector/pgvector:pg16`, applies all migrations + seed, runs `db/test/*.sql`.

## Open items deferred to Phase 1.5

- **Bedrock + Claude 3.5 Sonnet synthesis layer.** Current orchestrator returns deterministic, structured findings; a future LLM pass will paraphrase them in plain English while preserving citations. Behind a config flag so it stays optional.
- **Integration tests with Testcontainers** running migrations + seeds and exercising the orchestrator end-to-end against real Postgres + pgvector. Blocked on local Docker Desktop being healthy.
- **AMA CPT license + CMS Coverage API token** — manual procurement (long lead time).
- **AWS HIPAA BAA + sub-processor BAAs** for Bedrock, Datadog, etc.
- **NestJS Pino HTTP logging wiring** is in `main.ts` but the Pino logger replacement at `app.useLogger(...)` happens after `listen()`, so first-request lifecycle logs still go to the default. Move it before `listen` in 1.5.

## Reproducing the run

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npm install                  # 5 minutes first time
npx tsc --noEmit             # zero errors
npx jest --ci                # 84 tests pass in ~50s
```

End-to-end including DB schema (requires Docker Desktop healthy):

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform
.\db\apply.ps1               # builds + applies db/migrations/* + db/seed/*
.\db\test.ps1                # runs db/test/*.sql incl. RLS isolation
cd backend; npm run start:dev
# In another shell:
curl -X POST http://localhost:3000/v1/lookup `
  -H "Content-Type: application/json" `
  -H "X-Org-Id: 11111111-1111-4111-8111-111111111111" `
  -d '{ "payer_id": "...", "state": "OH", "product_line": "medicare_ffs", "date_of_service": "2026-04-15", "lines": [{ "code": "99497" }] }'
```
