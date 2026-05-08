# billing-rules-backend (Phase 1)

NestJS 11 + TypeScript + Kysely backend for the medical billing rule lookup
+ reconciliation platform. Phase 1 ships the **structured pre-flight engine**
end-to-end: a single `/v1/lookup` endpoint that runs deterministic checks
(coverage, modifiers, NCCI bundling, medical necessity, timely filing, COB,
provider taxonomy) against `payer_rule` reference data and returns
citation-grounded findings per CARC class.

LLM synthesis layer (Bedrock + Claude) lands in Phase 1.5 once the AMA CPT
license + AWS HIPAA BAA are signed. The endpoint already refuses with
confidence < 0.5 — same UX, just deterministic for now.

## Layout

```
backend/
├── src/
│   ├── config/             # Zod-validated env, ConfigModule
│   ├── database/           # pg pool, Kysely Db, RLS-enforcing transaction helper
│   ├── observability/      # pino logger w/ PHI redaction
│   ├── auth/               # AuthGuard (dev_header in dev; jwt placeholder)
│   ├── common/             # uuid validation, shared utilities
│   ├── health/             # /healthz + /readyz
│   ├── lookup/             # the structured pre-flight engine
│   │   ├── dto/                # request + response shapes
│   │   ├── services/           # one per CARC class
│   │   ├── lookup.controller.ts
│   │   └── lookup.module.ts
│   ├── ingestion/          # CMS Coverage API client + NCD/LCD ingestor
│   ├── app.module.ts
│   └── main.ts
├── scripts/
│   └── ingest-palliative.ts    # CLI to ingest palliative LCDs for OH/NC/SC
├── test/
│   └── setup-env.ts            # default env for unit tests
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── nest-cli.json
└── README.md (this file)
```

## Local development

Prereqs:
- Node 20+ (tested with v22 / v25)
- Docker Desktop running, with `db` service from the repo-level
  `docker-compose.yml` running.
- `db/apply.ps1` has been run so the schema + reference seed are present.

```powershell
cd backend
npm install
cp ../.env.example .env

# typecheck + lint + unit tests
npm run typecheck
npm run lint
npm test

# start the dev server (auto-reload)
npm run start:dev
```

API docs (dev only): `http://localhost:3000/docs`.

## How the lookup works

```
POST /v1/lookup
  X-Org-Id: <uuid>           # dev_header auth
  X-User-Id: <uuid>          # optional
  X-Role: employee|reviewer|admin|consultant

{
  "payer_id":      "...",
  "state":         "OH",
  "product_line":  "medicare_ffs",
  "date_of_service":"2026-04-15",
  "lines": [
    { "code": "99497", "modifiers": ["95"], "pos": "10", "units": 1 }
  ],
  "diagnoses":           ["Z51.5"],          // optional
  "provider_taxonomy":   "207RH0003X",       // optional
  "cob_other_coverage":  "employer_group_lt_20", // optional
  "filing_date":         "2026-05-01"        // optional; defaults to today
}
```

The orchestrator runs the following checks in parallel and returns a
`LookupResponse` containing line-level findings + cross-line findings + an
overall severity. Every finding carries citations.

| Check | Service | CARC class | Deterministic? |
|---|---|---|---|
| Coverage rule on file | `PayerRuleRepository.fetchOne` | 50 | yes |
| Modifier hierarchy + payer applicability + mutual exclusion | `ModifierService` | 4 | yes |
| NCCI PTP + MUE | `NcciService` | 97 | yes |
| Medical necessity ICD-10 ↔ CPT linkage | `MedicalNecessityService` | 11 | yes |
| Timely filing window | `TimelyFilingService` | 29 | yes |
| Coordination of Benefits primary determination | `CobService` | 22/24 | yes |
| Provider taxonomy allowed | `ProviderTaxonomyService` | 170/185 | yes |

Refusal threshold: confidence < 0.5 → `severity='warning'`, with a
`recommendation` to "flag for analyst attestation."

## Ingestion CLI

```powershell
# preview
npm run ingest:palliative -- --states=OH,NC,SC --dry-run

# real run (requires CMS_COVERAGE_API_TOKEN)
npm run ingest:palliative -- --states=OH
```

Targets the palliative + hospice + ACP code set (~30 codes seeded by
`db/seed/0007_palliative_codes.sql`). For each `(state, code)` pair it pulls
LCDs via the CMS Coverage API and persists `source_document` + `payer_rule`
rows. Idempotent on `content_hash`.

## Tenant isolation (RLS) at the request layer

Every code path that touches tenant-scoped data MUST go through
`runWithTenant(db, orgId, async (tx) => { ... })` from
`src/database/rls-transaction.ts`. That helper:

1. Validates `orgId` is a real UUID (rejects SQL injection attempts).
2. Opens a transaction.
3. `SET LOCAL app.current_org_id = '<uuid>'` so every Postgres RLS policy
   defined in `db/migrations/0007_rls.sql` filters on that org.
4. Runs your work with the typed Kysely tx.
5. Commits on success, rolls back on throw.

Reference data (`code`, `modifier`, `payer_rule`, NCCI, ICD-10, etc.) is
GLOBAL — no RLS — and is read directly via `db.selectFrom(...)`.

The DB user `app` is `NOBYPASSRLS` so a missing `SET LOCAL` is a hard
failure (zero rows returned), not a silent leak.

## Test posture

- **Unit tests** for every service, with deterministic fixtures and no DB
  required. They run in CI on every PR.
- **Integration tests** (Phase 1.5) will spin up the `pgvector/pgvector:pg16`
  image via Testcontainers and run `db/migrations/*.sql` + `db/seed/*.sql`
  before each suite, so the full schema + RLS path is exercised.
- **Production hallucination + drift monitoring** (Phase 3) samples 5% of
  prod queries weekly against the gold eval set.

## What's deliberately NOT in Phase 1

- Bedrock LLM calls (parser + synthesizer). The structured pre-flight is the
  source of truth; LLM only paraphrases findings + handles "explain in plain
  English."
- 835 ERA ingestion (Phase 2).
- Reconciliation diff engine + alerting (Phase 3).
- Browser extension (Phase 3).
- EHR integrations (Phase 4+).
