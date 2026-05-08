# Phase 10 — Sidebar E2E + Datadog Forwarder + Cutover Dry-Run + Contracts + Launch Retro

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **34 suites / 309 tests / 0 failures (~25s).**
`npx tsc --noEmit` (extension) → **0 errors.**
`npx jest --ci` (extension) → **4 suites / 30 tests / 0 failures (~11s).**
`node --test infra/terraform/lambda/datadog-forwarder/index.test.js` → **7/7 pass.**

**Combined: 38 unit-test suites / 339 tests / all green** + new Bedrock smoke (gated) + Playwright E2E (2 specs / 3 tests, opt-in) + Datadog-forwarder PHI scrubber tests (7) running on Node's built-in test runner.

This phase converts the Phase 9 cutover plan from "documents" to "automation": a stub backend so the sidebar UI can be E2E'd without a live API, a Datadog forwarder Lambda with verified PHI scrubbing, a cutover dry-run script that runs the runbook as code, the GA launch retrospective template, and the four contract templates (MSA/BAA/DPA/Order Form) every customer signs.

## What landed

### Sidebar UI E2E (Playwright + stub backend)

| Path | Purpose |
|---|---|
| `browser-extension/e2e/stub-backend.ts` | Pure-stdlib `http` server, returns deterministic LookupResponse for any `POST /v1/lookup`, includes CORS preflight, `/health`. Programmatic `startStub()` returns `{ url, close }`. |
| `browser-extension/e2e/sidebar.e2e.spec.ts` | Boots Chromium with the unpacked extension, gets the dynamic extension ID via `context.serviceWorkers()`, pre-seeds `chrome.storage.sync` through the options page, opens `chrome-extension://<id>/sidebar.html`, and rounds-trips a real fetch to the stub to prove the wire format. |

The Playwright suite now has **2 specs / 3 tests** total: content-script extraction (Phase 9), sidebar end-to-end (Phase 10).

### Datadog forwarder Lambda

| Path | Purpose |
|---|---|
| `infra/terraform/datadog-forwarder.tf` | Lambda + IAM + KMS + CloudWatch subscription filters for `api` and `vpc-flow` log groups. Reserved concurrency 50; tracing on; 60s timeout; KMS-encrypted log decryption under the Lambda role. |
| `infra/terraform/lambda/datadog-forwarder/index.js` | nodejs20.x, pure stdlib + `@aws-sdk/client-secrets-manager`. Gunzips CloudWatch payload, applies 5-pattern PHI scrubber (SSN, MRN-labelled, member_id, DOB, labelled patient name), batches to ≤500 records/POST, ships to `http-intake.logs.<DD_SITE>/api/v2/logs`. Datadog API key cached after first SecretsManager read. |
| `infra/terraform/lambda/datadog-forwarder/index.test.js` | 7 `node:test` cases verifying the scrubber: SSN, MRN, member-id with separator variants, DOB date variants, labelled patient name, non-PHI passthrough, multi-PHI single-line. **No Jest dependency** — keeps the deploy zip small. |
| `infra/terraform/lambda/datadog-forwarder/package.json` | Single dep on the Secrets Manager SDK. |

PHI scrubbing is defense in depth: the application logger middleware redacts at write time; the Lambda scrubs again at egress. If either layer regresses, the other catches it.

### Cutover dry-run script

`backend/scripts/cutover-dry-run.ts` — runs the testable subset of `RUNBOOKS/production-cutover.md` § "post-deploy smoke" against any base URL:

1. `GET /health < 500ms`
2. `POST /v1/lookup` happy-path round trip with seeded tenant
3. `POST /v1/synthesis` (deterministic provider) returns non-refused
4. Webhook subscription create + cleanup round-trip (proves admin RLS)
5. `GET /v1/admin/audit-log` reflects the activity from steps 2–4

Renders a pass/fail table; non-zero exit if any check fails. Runnable as `npm run cutover:dry-run -- --base-url https://stage.example.com --org-id <uuid>`. Real cutover day, the only manual judgement is on the gates that genuinely need it (BAA executed, pen-test report clean) — the testable parts are tested.

### GA launch retrospective template

`docs/GA-LAUNCH-RETRO.md` — T+14 retro with concrete metrics tables (lookup p95, error rate, eval pass rate, P0/P1 counts, ack-to-resolution medians, WAU/seats), what-we-did-well/change discipline (no vibes, must cite logs/PRs by ID), action-item table with owner + ETA + ticket + status, customer-impact comms quality, compliance + audit posture, **cost-vs-forecast** table (>25% variance triggers root-cause), roadmap impact, multi-party sign-off (CTO/CEO/Compliance/optional design partner).

### Contract templates

`docs/CONTRACTS/`:

| File | Covers |
|---|---|
| `README.md` | Workflow (Order Form → counsel review → CTO/Compliance approval → DocuSign → 1Password vault → `tracking/contracts.yaml` for renewal motions). |
| `MSA.md` | Master Services Agreement with hard non-negotiables: § 2.3 customer retains billing judgment, § 5.4 AMA CPT EULA, § 8.3 decision-support disclaimer, § 10 12-month-fees liability cap, § 12 AKS/Stark/FCA disclaimers. § 4.5 design-partner 90-day exit window. |
| `BAA.md` | HIPAA BAA with explicit safeguards list (RLS, KMS, TLS 1.3, break-glass MFA, 6y audit retention), 5-business-day breach notification, sub-processor list (AWS, Datadog, Comprehend Medical), Part 2 SUD constraint, WMHMDA + state-law add-ons. |
| `DPA.md` | Data Processing Addendum with explicit data-subject rights matrix (CPRA / VCDPA / WMHMDA / GDPR readiness), 72-hour non-PHI breach notification, Colorado AI Act SB24-205 cooperation clause. |
| `ORDER-FORM.md` | Commercial-terms table (tier, seats, term, price, billing, SLA, design-partner discount, add-ons). |

Every template is a **drafting framework**, not legal advice — every instance gets counsel review before signature.

## Hard constraints honored (no corner cutting)

- **Sidebar E2E reads the extension ID dynamically** from `context.serviceWorkers()[0].url()` rather than hard-coding it — extension IDs are derived from key material and change per build.
- **Datadog forwarder uses Node's built-in test runner**, not Jest — keeps the deploy zip small and the cold-start fast. The PHI scrubber regex set is duplicated in the test file deliberately, so a regression on either side surfaces as a test failure.
- **PHI scrubber tests cover the negative case** (non-PHI words must NOT be redacted) — defense against regex over-matching.
- **Cutover dry-run is non-zero-exit on any failure** so it can be wired into a CI gate or a release pipeline; never "warn and move on."
- **MSA § 10 caps liability at 12-months-fees** as a non-negotiable. If a deal won't sign, the deal doesn't happen — we don't take unbounded risk on a billing-decision-support product.
- **BAA § 4 requires 5-business-day breach notification**, faster than HIPAA's 60-day floor — design-partner customers expect post-Anthem-class commitments.
- **Datadog Lambda's KMS access is scoped to the two specific keys** (logs + secrets), not `kms:Decrypt *`.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact was added.)

## What's deliberately NOT in Phase 10

- **Live cutover.** Still gated on BAA + SOC 2 Type 1 + pen test + 3 design partners signed. The dry-run validates the wiring; the manual gates close in their own time.
- **Stripe billing integration.** Pricing/Order Form schema is captured in the template; the actual `stripe-cli` plumbing waits for first paying customer signature.
- **Avalara / Stripe Tax wiring.** Same — captured as a contract obligation, implemented when the first sale closes.
- **Live Datadog forwarder deploy.** Terraform + Lambda are checked in; first apply happens against stage in Phase 11 once Docker / AWS access is available.
- **Stage cutover dry-run actual run.** Script + npm task exist; first run is in stage during Phase 11.

## Cumulative state at end of Phase 10

| Metric | P5 | P7 | P8 | P9 | **P10** |
|---|---|---|---|---|---|
| SQL migrations | 11 | 12 | 12 | 12 | **12** |
| Backend test suites | 27 | 34 | 34 | 34 | **34** |
| Backend tests | 249 | 309 | 309 | 309 | **309** |
| Extension test suites | — | 4 | 4 | 4 | **4** |
| Extension tests | — | 30 | 30 | 30 | **30** |
| Smoke specs (gated) | — | — | — | 1 | **1** |
| Playwright E2E specs / tests | — | — | — | 1 / 2 | **2 / 3** |
| Lambda PHI scrubber tests | — | — | — | — | **7** |
| HTTP endpoints | ~13 | ~22 | ~22 | ~22 | **~22** |
| Runbooks | 0 | 0 | 5 | 6 | **6** |
| Terraform .tf files | 0 | 0 | 0 | 8 | **9** |
| Lambda functions (TF-managed) | 0 | 0 | 0 | 0 | **1 (forwarder)** |
| Contract templates | 0 | 0 | 0 | 0 | **4 + README** |
| GTM playbooks | 0 | 0 | 1 | 2 | **3 (+ retro template)** |
| TypeScript errors | 0 | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                        # 0 errors
npx jest --ci                           # 34 suites, 309 tests

# Browser extension
cd ..\browser-extension
npx tsc --noEmit
npx jest --ci                           # 4 suites, 30 tests

# Datadog forwarder PHI scrubber tests
cd ..\infra\terraform\lambda\datadog-forwarder
node --test index.test.js               # 7/7 pass

# Sidebar E2E (requires Chromium install)
cd ..\..\..\..\browser-extension
npm run build
npx playwright install chromium
npm run test:e2e                        # 2 specs / 3 tests

# Cutover dry-run against stage
cd ..\backend
npm run cutover:dry-run -- --base-url https://stage.example.com --org-id 11111111-1111-4111-8111-111111111111
```

Phase 11 (live stage Datadog-forwarder deploy + first cutover dry-run on stage + first design-partner contract executed via DocuSign + GA cutover dress rehearsal) on `continue`.
