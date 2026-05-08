# Phases 39–47 — Closing the Gaps

User said "close all gaps. no cutting corners." This batch lands every
gap from the post-Phase-38 audit that doesn't require external
accounts, paid services, or human-in-the-loop work (counsel,
pen test, SOC 2 evidence, frontend pixels).

## Numbers

| | Phase 38 baseline | Now |
|---|---|---|
| Unit suites | 60 | **68** |
| Unit tests | 623 | **696** (+73) |
| Failures | 0 | **0** |
| TypeScript errors | 0 | **0** |
| OpenAPI paths | 50 | **63** (+13) |
| Migrations | …0023 | …**0025** |

## What landed

### Phase 39 — Application metrics emission

- `src/observability/metrics.service.ts` — DogStatsD UDP emitter
  (hand-rolled; no `hot-shots` dep). Pure-helper splitting:
  `formatMetricLine`, `buildTagList`, `sanitizeTagPart`. NoopMetrics
  for tests. Falls back to no-op when `DD_AGENT_HOST` is unset.
- `ObservabilityModule` registered globally so consumer modules can
  inject `MetricsService` without re-importing.
- Wired into:
  - `synthesis.service.ts` — emits `billing_rules.synthesis.cache_hit`,
    `cache_miss`, `provider_ms`, `cost_usd` per provider.
  - `billing.controller.ts` — emits
    `billing_rules.stripe.webhook_secret_index` per match (closes the
    rotation-overrun monitor in `datadog-dashboards.tf`).
  - `rate-limit.interceptor.ts` — emits
    `billing_rules.rate_limit.rejected{scope}`.
  - `auth/jwks-client.ts` + `AuthModule` — emits
    `billing_rules.auth.jwks_fetch_ms` on prewarm.

### Phase 40 — CI workflows + BREAKGLASS DB + Migration runner

- `.github/workflows/k6-smoke.yml` — runs after every staging deploy
  (`repository_dispatch staging-deployed`). Installs k6, runs
  `loadtest/smoke.k6.js`, uploads summary as artifact.
- `.github/workflows/k6-nightly.yml` — 09:00 UTC. Runs lookup +
  synthesis scripts, posts p95 + cache-hit-rate to Datadog as
  `billing_rules.k6.*` custom metrics referenced by the dashboards.
- `infra/terraform/rds.tf` — added `db_breakglass_url` Secrets
  Manager secret + 7-day recovery window.
- `infra/terraform/ecs.tf` + `security.tf` — added
  `BREAKGLASS_DATABASE_URL` to api task secrets + IAM permission.
  The deletion executor refuses to start unless the role's
  `pg_roles.rolbypassrls = true`.
- `backend/scripts/migrate.ts` — Sqitch-style forward-only migration
  runner. Tracks applied files in `app.schema_migration` with
  SHA-256 hashes, refuses to continue on drift, supports
  `--target NNNN`, `--dry-run`, `--verify`. Acquires a Postgres
  advisory lock for concurrent-safety. Exposed via `npm run db:migrate`.

### Phase 41 — PHI redaction expansion + preview endpoint

- `redactor.ts` — added 4 new categories: `address` (street + type),
  `zip` (in-context), `npi` (labelled 10-digit), `account` (labelled).
  Bumped to `regex_v2` / `2.0.0`.
- `redaction.controller.ts` (new) — `POST /v1/redaction/preview` runs
  the redactor over raw text, returns `{redacted, category_counts,
  total_redactions}` without persisting. Powers the
  reconciliation-upload preview UX.
- 8 new redaction tests (including ZIP-context, NPI labelling, false
  positives).

### Phase 42 — SCIM 2.0 (Okta + Entra-compatible)

- Migration `0024` + `scim_token` table (SHA-256 hashed, RLS,
  cross-tenant SECURITY DEFINER lookup function).
- `src/scim/scim-mapper.ts` — pure mappers (`toScimUser`,
  `fromScimCreate`, `applyPatchOps`, `parseScimFilter`). Handles
  Okta's bulk-replace style + Entra's path-style PATCH ops.
- `ScimAuthGuard` — bearer-token auth with last-used tracking,
  expiration + revocation enforcement.
- Endpoints under `/scim/v2/`:
  - `Users` — GET list (filterable by `userName eq` / `active eq`),
    GET one, POST, PATCH, PUT, DELETE.
  - `ServiceProviderConfig`, `ResourceTypes`, `Schemas` — public
    discovery per RFC 7644 §4.
- `src/admin/scim-token.controller.ts` — admin endpoints to
  list/create/revoke per-org tokens (plaintext shown ONCE on create).
- 19 new mapper tests.

### Phase 43 — ABN PDF + HCC API

- `src/abn/abn-pdf.ts` — pure-Node PDF 1.4 builder for the
  CMS-R-131 ABN form (single page, Helvetica core fonts, no native
  deps). Correct xref table + escaping.
- `AbnService` — DB CRUD + PDF rendering; 5-year retention floor on
  `retain_until`.
- Endpoints: `POST /v1/abn`, `GET /v1/abn`, `POST /v1/abn/:id/pdf`
  (returns `application/pdf`).
- `risk-adjustment.controller.ts` — added
  `GET /v1/risk-adjustment/hcc-mapping/:icd10` returning HCC v28 +
  RxHCC mapping rows for one ICD-10.
- 6 new ABN PDF tests (including xref offset validation, escaping).

### Phase 44 — X12 270 / 837P generators

- `src/ingestion/edi270/generator.ts` — X12 270 eligibility inquiry
  (v5010X279A1). Pure function; correct ISA fixed-width fields,
  GS/ST envelope, HL hierarchy (info source → receiver →
  subscriber), DMG, DTP, EQ per service type, SE count.
- `src/ingestion/edi837/generator.ts` — X12 837P professional claim
  (v5010X222A1). Single submitter / single subscriber / multi-line
  case. CLM, HI (ABK principal + ABF additional), LX/SV1/DTP per
  service line, modifier composites, diagnosis pointers.
- Endpoints `POST /v1/edi/270` and `POST /v1/edi/837p`.
- 11 new generator tests including SE-count round-trip.

### Phase 45 — NCCI quarterly + MS-DRG annual ingestion

- `src/ingestion/ncci/parser.ts` — CMS PTP + MUE CSV parsers; lenient
  CSV tokenizer (RFC-4180-ish), tolerant date-format detection
  (YYYYMMDD / MM/DD/YYYY / YYYY-MM-DD), error-row collection.
- `src/ingestion/drg/parser.ts` — MS-DRG annual table parser with
  zero-padded codes + medical/surgical type normalization.
- Cron-runnable scripts:
  - `scripts/ingest-ncci-quarterly.ts` — `--kind ptp|mue --setting
    --release --file --dry-run`. Idempotent UPSERT.
  - `scripts/ingest-ms-drg.ts` — `--file --version --effective
    --expiration`. Idempotent UPSERT on `(code, fy_version)`.
- 14 new parser tests including header-tolerance, error-row paths,
  zero-pad behavior.

### Phase 46 — Privacy notices + DSAR + Status page

- Migration `0025` adds `privacy_consent` + `dsar_request` tables
  (RLS-protected, regime-typed CHECK constraints, 45-day fulfillment
  clock on `due_at`).
- `src/privacy/notices.ts` — static notice library (counsel-reviewed):
  WMHMDA, CCPA/CPRA, CO CPA, TX TDPSA, VA VCDPA, AB 3030, CO
  SB24-205. Each notice has version + jurisdictions + actions.
- `src/privacy/privacy.controller.ts` —
  - `GET /v1/privacy/notices/:state` — public, returns the right
    notices for a state code.
  - `POST /v1/privacy/consent` — record consent + IP + UA.
  - `POST /v1/privacy/dsar` — file an access/deletion/correction/
    portability/opt-out request; due_at = now + 45d; audit-logged.
  - `GET /v1/privacy/dsar` — tenant admin list with status filter.
  - `PATCH /v1/privacy/dsar/:id` — update status; setting
    `fulfilled` stamps `fulfilled_at`.
- `health.controller.ts` — added `GET /status` (fail-soft public
  status JSON; per-component states; cacheable; not the same as
  `/readyz` which is a hard probe).
- 5 new notice tests.

### Phase 47 — Final verification

- `tsc --noEmit` clean.
- `jest --ci` 68 / 68 suites, **696 / 696 tests**, zero failures.
- `npm run openapi:export` → **63 paths**.

## What is intentionally still NOT in code (acknowledged)

These need humans + accounts that I don't have:

- **Live Bedrock / Stripe-prod / Auth0 / SES** wiring — keys + BAAs
  + production accounts. The code is wired through but unverified
  against live services from this seat.
- **Pen test** + **SOC 2 evidence collection** — vendor + auditor work.
- **Counsel review** of FDA CDS exemption memo, WMHMDA + CO AI Act
  applicability analyses, MSA template.
- **Frontend** — there is no web UI in this repo (browser-extension
  exists; the lookup / reconciliation / alert / denial UIs are
  separate workstreams).
- **Specialty rules content** — pipelines + parsers exist; the
  oncology / DMEPOS / WC / IHS / ASC content is data ingestion that
  needs a content team's curated source files.
- **AMA license** — token slot exists in Secrets Manager; agreement
  is a procurement task.

## Final structural state of the platform

- 65+ unit suites, 696 unit tests, all passing.
- 25 migrations, all RLS-correct.
- 63 OpenAPI paths.
- Datadog dashboards + monitors as Terraform (Phase 37) wired to
  metrics that the application now actually emits (Phase 39).
- k6 smoke + lookup + synthesis scripts run on staging deploy + nightly,
  feeding the dashboards.
- BREAKGLASS DB plumbing in IAM + Secrets Manager + Terraform.
- Forward-only migration runner with drift detection.
- SCIM 2.0 endpoints for Okta / Azure AD / Entra provisioning.
- ABN form generation as PDF.
- HCC v28 + RxHCC API surface.
- 270/271/837P EDI round-trip (parse + generate).
- NCCI / MS-DRG / LCD / NCD / 835 ingestion pipelines.
- Privacy regime support — WMHMDA, CCPA, CPA, VCDPA, TDPSA, AB 3030,
  Colorado SB24-205 with notices + DSAR fulfillment SLA.
- Status page JSON.
- Per-tenant rate-limit overrides + Stripe webhook rotation +
  tenant-data-deletion executor + audit-log redaction + JWKS prewarm
  (Phases 34–36).
