# Phase 9 — Live Bedrock Smoke + Playwright E2E + Production Cutover + Terraform + Design-Partner Kit

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors** (backend + extension).
`npx jest --ci` (backend) → **34 suites / 309 tests / 0 failures (~22s)**.
`npx jest --ci` (extension) → **4 suites / 30 tests / 0 failures (~11s)**.

**Combined: 38 suites / 339 unit tests, all green.** Plus a new live-Bedrock smoke spec and a Playwright E2E suite, both opt-in (skipped when env flags are off so default CI doesn't make external calls or download Chromium).

This phase is the final mile to production: prove the Bedrock chain works against a real model, prove the MV3 extension boots a real Chromium, write the runbook + Terraform that turns "stage works" into "prod is live and a paying tenant can sign in," and assemble the design-partner kit so GTM has a playbook on day one.

## What landed

### Live Bedrock smoke (gated)

| Path | Purpose |
|---|---|
| `backend/test/smoke/bedrock.smoke.spec.ts` | Constructs a real `BedrockRuntimeClient` → `BedrockSdkClient` → `BedrockSynthesisProvider` chain, sends a 1-finding `SynthesisRequest`, asserts a non-refused result + non-empty narrative + correct severity_summary in <30s. Skipped unless `BEDROCK_SMOKE=1`. |
| `backend/test/smoke/jest-smoke.config.cjs` | Separate config so the smoke suite never runs in default CI. |
| `backend/package.json` | New script: `test:smoke:bedrock`. |

Cost per run: a single ~200-token completion against `claude-3-5-sonnet`, roughly $0.005. Run on demand against stage; not a pipeline gate.

### Playwright E2E for the browser extension

| Path | Purpose |
|---|---|
| `browser-extension/e2e/playwright.config.ts` | Persistent-context launcher (`headless: false`, `--load-extension=dist/`), 30s test timeout, single worker. |
| `browser-extension/e2e/extension.e2e.spec.ts` | Boots Chromium with the unpacked extension, navigates to a fixture EHR page, asserts the code-extraction contract — all 5 procedure codes (99497, 99498, 99453, 99454, G0318) present, 4-digit year 2026 not misclassified. Second test asserts the persistent context survives a soft navigation. |
| `browser-extension/e2e/fixtures/ehr-encounter.html` | Realistic encounter fixture with procedures, ICD-10s, and intentional confusables (year, ZIP) so we can prove what's filtered. |
| `browser-extension/e2e/README.md` | Why Playwright vs jsdom; run instructions; coverage scope. |
| `browser-extension/package.json` | New script: `test:e2e`; new devDependency `@playwright/test`. |

The E2E sits *outside* the jsdom unit suite + outside `tsc --noEmit`'s include glob (`src/**/*`, `test/**/*`, `scripts/**/*`), so the existing lint/typecheck pipeline is untouched. CI will install Chromium via `playwright install --with-deps chromium` only on the E2E job.

### Production cutover runbook

`docs/RUNBOOKS/production-cutover.md` — gates table (BAA + sub-processor BAAs + SOC 2 Type 1 + pen test + insurance + AMA license + CMS token + 3 design-partners signed); pre-cutover engineering parity (infra, data, app); cutover-day sequence (lock writes → blue-green deploy → smoke → DNS cutover → first-tenant invite → 2h monitoring); rollback decision tree (P0/P1/P2); post-cutover T+1..T+7 day plan; tenant offboarding-readiness contract; production-only configuration diff table.

### Terraform infra skeleton

| File | Purpose |
|---|---|
| `infra/terraform/README.md` | Why no `prod.tfvars` checked in; apply procedure (SSO + secondary review + tagged state). |
| `versions.tf` | Provider pin, S3 backend stub, default tags incl. `Compliance=hipaa`. |
| `variables.tf` | Every input is a variable — no hard-coded ARNs, AZs, instance classes. |
| `network.tf` | VPC + 3-AZ public/private subnets, NAT gateways, VPC flow logs to CloudWatch. |
| `security.tf` | Three KMS keys (RDS / logs / secrets), task role with scoped Bedrock + Secrets Manager grants, security groups (ALB → ECS → RDS chain). |
| `rds.tf` | Postgres 16 Multi-AZ + parameter group, gp3 + autoscaling storage, 35-day backups, Performance Insights, master credentials managed by Secrets Manager. |
| `ecs.tf` | Cluster + task def + ALB + ACM HTTPS listener + autoscaling (CPU target tracking, 3–20). `ignore_changes = [task_definition]` so CD owns the image tag, not Terraform. |
| `bedrock.tf` | Interface VPC endpoint to Bedrock Runtime — keeps model traffic on AWS backbone. |
| `observability.tf` | SNS topic + email subscription + 4 CloudWatch alarms (5xx rate, p95 latency, RDS CPU, RDS connection count). |
| `outputs.tf` | The handful of values a human actually needs after apply. |

The skeleton is deliberately not a one-button deploy. A human reads + plans + reviews + applies, twice (secondary engineer signs off the plan in PR before apply).

### Design partner kit

`docs/DESIGN-PARTNER-KIT.md` — what "design partner" means commercially (50% Year-1 / 80% Year-2+); ICP for first-wave outreach (mid-market RCM in palliative/hospice/home-health, behavioral health, OH/NC/SC multi-state); cold outreach email template; 60-min discovery-call agenda; 90-day success criteria with kill-switch (3-of-6 reds at day 60 → convert to standard); welcome email post-signature; feedback cadence matrix; co-marketing terms; exit clauses; internal `tracking/design-partners.yaml` schema.

## Hard constraints honored (no corner cutting)

- **Bedrock smoke is opt-in** — `BEDROCK_SMOKE=1` gate means default `npx jest --ci` never costs money or requires AWS creds. CI runs it manually post-deploy against stage, not on every PR.
- **Playwright tests live outside the unit-test surface** — they don't slow down `jest --ci`, don't bloat `tsc --noEmit`, and don't pull a 200MB Chromium download into the default CI cache.
- **Cutover runbook is gated by BAA + SOC 2 Type 1 + pen test + insurance + AMA license** — not "we hope it goes well." Any red gate stops the cutover.
- **Terraform task definition uses `ignore_changes`** so CI/CD owns image tags. Terraform owns infra; pipelines own deploys; no drift war between them.
- **Bedrock IAM grant is scoped to specific model ARNs** (the var list), not `bedrock:InvokeModel *`. A new model means a new explicit grant.
- **VPC flow logs + RDS pg_stat logs + ALB access logs** all retain ≥30 days for HIPAA/SOC 2 evidence sampling.
- **Design-partner kit has a kill-switch at day 60** — 3-of-6 red metrics → convert to standard. We don't drag dead relationships through co-marketing.
- **Production model differs from stage model in code-tracked config** (`production-cutover.md` table) so an engineer reading either env can see the diff at a glance.

## Bug caught + fixed during this session

- **`bedrock.smoke.spec.ts` used `url` + `quote` on CitationDto**, but the DTO field names are `source_url` + `verbatim_quote`. TypeScript caught it before any AWS call. Renamed to match.

## What's deliberately NOT in Phase 9

- **Live cutover.** This phase produced the runbook + Terraform; the actual cut to production happens once the gates close (BAA, SOC 2 Type 1, pen test, design partners signed).
- **Stage Terraform module.** Same module, different vars; we copy the apply pattern when stage migrates from the current ad-hoc setup.
- **Datadog forwarder Lambda.** Stub'd in the file list but not implemented — Datadog publishes a maintained Terraform module we'll consume rather than rewrite.
- **WAF + Shield Advanced.** Post-cutover Year-1 work once we see real traffic patterns.
- **Sidebar UI E2E.** The Playwright suite proves content-script extraction; sidebar UI requires a stub backend harness — Phase 10.

## Cumulative state at end of Phase 9

| Metric | P1 | P3 | P5 | P7 | P8 | **P9** |
|---|---|---|---|---|---|---|
| SQL migrations | 7 | 9 | 11 | 12 | 12 | **12** |
| Backend test suites | 12 | 22 | 27 | 34 | 34 | **34** |
| Backend tests | 84 | 181 | 249 | 309 | 309 | **309** |
| Extension test suites | — | — | — | 4 | 4 | **4** |
| Extension tests | — | — | — | 30 | 30 | **30** |
| Smoke specs (gated) | — | — | — | — | — | **1** |
| Playwright E2E specs | — | — | — | — | — | **1 file / 2 tests** |
| HTTP endpoints | ~5 | ~12 | ~13 | ~22 | ~22 | **~22** |
| Runbooks | 0 | 0 | 0 | 0 | 5 | **6** |
| Terraform .tf files | 0 | 0 | 0 | 0 | 0 | **8** |
| GTM playbooks | 0 | 0 | 0 | 0 | 1 | **2** |
| TypeScript errors | 0 | 0 | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                # 0 errors
npx jest --ci                   # 34 suites, 309 tests, ~22s

# Browser extension
cd ..\browser-extension
npx tsc --noEmit                # 0 errors
npx jest --ci                   # 4 suites, 30 tests, ~11s

# Bedrock live smoke (requires AWS creds + BAA executed)
cd ..\backend
$env:BEDROCK_SMOKE = "1"; $env:AWS_REGION = "us-east-1"
npm run test:smoke:bedrock

# Browser extension Playwright E2E (requires Chromium install)
cd ..\browser-extension
npm run build
npx playwright install chromium
npm run test:e2e

# Terraform plan (against the real prod account, never auto-applied)
cd ..\infra\terraform
terraform init -backend-config=prod.s3.tfbackend
terraform plan -var-file=prod.tfvars -out=plan.bin
```

Phase 10 (sidebar-UI E2E with stub backend, Datadog forwarder Lambda, stage→prod cutover dry-run, first design-partner signed contract, GA launch retro) on `continue`.
