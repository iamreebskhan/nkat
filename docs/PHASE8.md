# Phase 8 — Integration Tests, Runbooks, OpenAPI, Load Tests, CI Expansion

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors.**
`npx jest --ci` → **34 suites, 309 tests, 0 failures, ~25s.**

Combined with the browser extension (4 / 30, unchanged), the platform stays at **38 suites / 339 tests**. Phase 8 is the productionization layer — runbooks, harnesses, CI gates, deploy/DR/incident process — without changing application surface.

## What landed

### Integration test harness (Testcontainers + pgvector:pg16)

| Path | Purpose |
|---|---|
| `backend/test/integration/harness.ts` | Boots `pgvector/pgvector:pg16`, applies every `db/migrations/*.sql` + `db/seed/*.sql` in order, returns admin pool (`BYPASSRLS`) + app-role pool (`NOBYPASSRLS`), plus Kysely instances bound to each. `integrationDescribe` skips automatically when `INTEGRATION!=1` so suites still parse without Docker. |
| `backend/test/integration/rls-isolation.spec.ts` | 5 cross-tenant tests — org-A only sees A's rows, org-B only B's, no `app.current_org_id` returns 0 rows from tenant tables, cross-tenant write blocked, reference data globally readable. |
| `backend/test/integration/schema-shape.spec.ts` | Verifies RLS enabled on all 17 tenant-scoped tables, disabled on 30 reference tables, seed counts (states, product lines, POS), NC/SC/OH payers seeded, HCC v28 entries present, `pgvector` + `citext` extensions installed. |
| `backend/test/integration/hcc-importer.spec.ts` | End-to-end: clean CSV import + idempotent re-import (PK conflict path covered). |
| `backend/test/integration/jest-integration.config.cjs` | 180s timeout, runInBand, separate from unit-test config. |

Run: `INTEGRATION=1 npm run test:integration` once Docker is healthy. CI uses a real Postgres service container for the same coverage.

### OpenAPI export

`backend/scripts/export-openapi.ts` — boots Nest in-process, captures the SwaggerModule document, writes `docs/openapi.json`. Wired to `npm run openapi:export`. CI runs it and fails the build if `git diff --exit-code docs/openapi.json` is non-clean → spec drift gate.

### k6 load tests

`loadtest/lookup.k6.js` — constant-arrival-rate scenario against `POST /v1/lookup` with palliative codes (99497/99498/99347-50/G0318). SLO thresholds:

```js
http_req_failed:  ['rate<0.001']
http_req_duration:['p(95)<2000']
```

`loadtest/README.md` covers prereqs (k6 + a running stage cluster) + invocation patterns.

### CI expansion (`.github/workflows/ci.yml`)

Existing jobs preserved (schema-apply, backend-typecheck-test). New jobs:

- **backend-integration-tests** — Postgres service container, applies migrations + seeds, runs `INTEGRATION=1 jest --config test/integration/jest-integration.config.cjs --runInBand`.
- **extension-typecheck-test** — typecheck + jest in `browser-extension/`, uploads `dist/` build artifact.
- **openapi-export-drift** — runs `npm run openapi:export`, fails if `docs/openapi.json` would change. Forces spec to be regenerated and committed alongside any controller change.

### Runbooks (`docs/RUNBOOKS/`)

| File | Covers |
|---|---|
| `deployment.md` | Blue-green ECS, env table per environment, forward-only migrations, ALTER COLUMN split pattern, pre-flight checklist, rollback flow. |
| `incident-response.md` | P0–P3 severity table; P0 PHI-breach runbook with HIPAA 60-day OCR notification; P1 wrong-results; webhook stuck-deliveries; status page component mapping. |
| `disaster-recovery.md` | RPO 1h / RTO 4h tier table, backup posture (RDS automated + 35d retention + daily encrypted `pg_dump` to Object-Lock S3 + 1y retention), monthly DR drill, region failover (us-east-1 → us-west-2), single-tenant restore. |
| `on-call.md` | 1-week rotations, PagerDuty/Slack tools, page-worthy events (CloudWatch alarms, synthetic failures, backup failures, crawler error rate, webhook DLQ), triage order, comms cadence by severity, blameless post-mortem template + 5-business-day deadline; specific playbooks (lookup p95, RDS connection saturation, webhook DLQ, hallucination-eval failure, AMA license alert). |
| `break-glass.md` | Three DB roles (`app` NOBYPASSRLS / `analyst` / `breakglass` BYPASSRLS); SSO+MFA+ticket+secondary-review gating; auto-revoking ≤4h IAM session; prepared SQL (RLS posture, list policies, kill runaway query, rotate webhook secret, rebuild HNSW concurrently); secrets rotation table; SOC 2 Type 2 audit-trail expectations. |

### Customer success playbook (`docs/CUSTOMER-SUCCESS.md`)

Covers tier matrix (Solo/Team/Org/Enterprise), 60-min Org-tier onboarding script, week-1 cadence, weighted health-score formula, QBR agenda, L1→L4 support escalation, status-page comms, KB content list, renewal/expansion paths (target NRR 120% by Y2), churn save-call procedure + loss-report categorization, design-partner program, voice-of-customer (NPS + CAB + #feature-requests), and a CSM-facing compliance touch-points checklist (BAA, WMHMDA, Colorado AI Act, AB 3030, 42 CFR Part 2, AMA EULA).

## Hard constraints honored (no corner cutting)

- **`integrationDescribe` is `describe.skip` when `INTEGRATION!=1`** so Phase 0–7 unit suites still compile + run on a machine without Docker. CI flips the flag and provides Postgres.
- **Integration tests use TWO pools** (admin + app-role) so RLS policies are exercised against the actual NOBYPASSRLS connection that production uses. Admin pool is reserved for setup + break-glass parity.
- **OpenAPI export is a CI gate, not a manual step** — a controller change without a regenerated spec fails the build.
- **k6 SLOs match the production SLO contract** (p95 < 2s, error rate < 0.1%) so the load test is the contract, not an aspiration.
- **Runbooks are written for the on-call human at 3am**, not for an audit checkbox — every section ends in a concrete next step or a piece of SQL/CLI.
- **Break-glass runbook explicitly forbids `breakglass` for routine work** — `app` and `analyst` cover the day-job; `breakglass` requires SSO+MFA+ticket+secondary, with auto-revoke ≤4h.
- **Customer success playbook treats compliance as part of the CSM job description**, not a thing thrown over the wall to legal — BAA before PHI, WMHMDA notice for WA users, AB 3030 customer-side disclaimer guidance.

## Bug caught + fixed during this session

- **Integration spec TS errors**: schema-shape.spec was passing the raw `pg.Pool` to Kysely's `sql\`...\`.execute(...)` (which wants a `QueryExecutorProvider`). Switched to `ctx.db` (Kysely instance) so the executor satisfies the interface.
- **Missing `metadata` on client_company insert** in rls-isolation.spec — the column is NOT NULL with a default, but Kysely's strict insert types still require an explicit `{}`. Added.

## What's deliberately NOT in Phase 8

- **Live integration-test run on this machine.** Docker Desktop has been wedged the entire project (engine pipe non-responsive); CI runs against a real Postgres service container instead, which is the same code path. Local re-run will work the moment Docker recovers.
- **k6 baseline numbers.** The script + thresholds are committed; first baseline run happens against a deployed stage cluster, not the dev box.
- **Live Bedrock smoke tests.** Same as Phase 7 — gated on AWS HIPAA BAA.
- **Browser extension Playwright E2E.** Still unit-tested; full Chrome-driver E2E is a follow-on.

## Cumulative state at end of Phase 8

| Metric | P1 | P2 | P3 | P4 | P5 | P6 | P7 | **P8** |
|---|---|---|---|---|---|---|---|---|
| SQL migrations | 7 | 8 | 9 | 10 | 11 | 12 | 12 | **12** |
| Seed files | 7 | 7 | 7 | 10 | 14 | 15 | 15 | **15** |
| Backend modules | 11 | 14 | 18 | 20 | 22 | 26 | 26 | **26** |
| Backend test suites | 12 | 16 | 22 | 24 | 27 | 31 | 34 | **34** |
| Backend tests | 84 | 117 | 181 | 213 | 249 | 285 | 309 | **309** |
| Integration test suites | — | — | — | — | — | — | — | **3 (skip-by-default)** |
| Extension test suites | — | — | — | — | — | 4 | 4 | 4 |
| Extension tests | — | — | — | — | — | 30 | 30 | 30 |
| **Combined unit tests** | 84 | 117 | 181 | 213 | 249 | 315 | 339 | **339** |
| HTTP endpoints | ~5 | ~7 | ~12 | ~13 | ~13 | ~13 | ~22 | **~22** |
| Runbooks | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **5** |
| CI jobs | 2 | 2 | 2 | 2 | 2 | 2 | 2 | **5** |
| TypeScript errors | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit         # 0 errors
npx jest --ci            # 34 suites, 309 tests, ~25s

# Integration tests (requires Docker)
INTEGRATION=1 npm run test:integration

# OpenAPI export
npm run openapi:export
git diff --exit-code ../docs/openapi.json   # CI gate

# k6 load test (against a deployed stage cluster)
cd ..\loadtest
k6 run lookup.k6.js -e BASE_URL=https://stage.<domain> -e TOKEN=$STAGE_TOKEN
```

Phase 9 (live Bedrock smoke + Playwright E2E + production cutover + first design-partner onboarding) on `continue`.
