# Phase 11 — Stripe-Backed Billing, Tier Enforcement, CI Gates, Dress Rehearsal

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **36 suites / 335 tests / 0 failures (~32s).**
`npx tsc --noEmit` (extension) → **0 errors.**
`npx jest --ci` (extension) → **4 suites / 30 tests / 0 failures (~14s).**
`node --test infra/terraform/lambda/datadog-forwarder/index.test.js` → **7/7 pass.**

**Combined: 40 unit-test suites / 365 tests / all green** + Bedrock smoke (gated) + 2 Playwright E2E specs (3 tests, opt-in) + Lambda scrubber (7 on `node:test`).

This phase adds **two new test suites and 26 tests** for the new billing surface (`stripe-hmac.spec.ts` and `billing-pure.spec.ts`).

The phase converts the contract templates from Phase 10 into enforceable backend code: a real `subscription` table with RLS, a Stripe-backed BillingService with HMAC-verified webhook ingestion, a TierGuard that gates endpoints on the customer's purchased entitlement (tier / seats / states / specialty packs), a renewal-motion script that drives CSM tickler conversations, the cutover dress-rehearsal runbook, and CI jobs for the previously-uncovered E2E + scrubber surfaces.

## What landed

### Migration 0013 — `subscription` + `billing_event`

`db/migrations/0013_phase11_billing.sql` — two RLS-protected tables:

- **`subscription`** (one row per org, UNIQUE org_id): tier (closed enum), seats, states[], specialty_packs[], stripe_customer_id, stripe_subscription_id, status (Stripe subscription.status enum), current_period_start/end, trial_end, cancel_at_period_end, metadata. `app.apply_tenant_rls('subscription')` wired. `subscription_status_idx` partial index on `(status)` for `past_due/unpaid` watchers; `subscription_period_end_idx` for the renewal-motion query. `touch_updated_at` trigger.
- **`billing_event`** (append-only audit log): UNIQUE on `stripe_event_id` so webhook replays are idempotent. Stores the **full Stripe payload as JSONB** so we don't lose forensic detail to schema-fitting. Indexed on `(org_id, received_at DESC)` and `event_type`.

`db/seed/0016_phase11_design_partner_subscription.sql` — synthetic Org-tier subscription for the seeded design-partner org used by integration tests + dev work.

### `BillingService` + Stripe adapter + webhook controller

| Path | Purpose |
|---|---|
| `backend/src/billing/billing-types.ts` | Closed enums (`SubscriptionTier`, `SubscriptionStatus`, `SpecialtyPack`), `TIER_DEFAULTS` price table, abstract `StripeClient` interface. **Stripe SDK is never imported anywhere outside `stripe-hmac.ts`** — keeps the production import graph clean. |
| `backend/src/billing/billing-pure.ts` | `parseTier`, `parseList`, `computeSubscriptionState`, `classifyEvent` — pure functions exercised by `billing-pure.spec.ts` without DB or Stripe. |
| `backend/src/billing/billing.service.ts` | Reads cached entitlements via RLS-tenant tx; ingests verified Stripe events with idempotency on `stripe_event_id`; writes the full payload to `billing_event` for forensics. **Derives `org_id` from the embedded subscription's `metadata.org_id`, NOT from any request header** — webhook bodies are untrusted data. |
| `backend/src/billing/stripe-hmac.ts` | HMAC-SHA256 webhook signature verifier with replay protection (300s tolerance default), constant-time compare via `timingSafeEqual`, supports multiple `v1=` candidates per header. |
| `backend/src/billing/billing.controller.ts` | `POST /v1/billing/stripe-webhook` (HMAC-verified locally, raw body required), `GET /v1/billing/entitlement` (auth-guarded, returns the caller's entitlement). |
| `backend/src/billing/tier.guard.ts` | `@RequiresEntitlement({ specialty_pack, write })` decorator + Nest `CanActivate` guard. Reject reasons (403): `NO_SUBSCRIPTION`, `PAYMENT_REQUIRED`, `CANCELED`, `INACTIVE_SUBSCRIPTION`, `PACK_NOT_LICENSED`, `STATE_NOT_LICENSED`. **Read endpoints during grace period are allowed; writes are blocked.** |
| `backend/src/billing/billing.module.ts` | `BillingModule.forRoot({ stripeSigningSecret })` so prod / stage / test inject different secrets without an env-leak in code. |

Webhook event shapes handled today: `customer.subscription.created/updated/deleted` (apply state), `invoice.paid`, `invoice.payment_failed` (log only — Stripe emits a follow-up `subscription.updated` for status changes). All other event types are forensically logged but no-op.

### Tests

| Suite | Tests | Covers |
|---|---|---|
| `billing/__tests__/stripe-hmac.spec.ts` | 7 | Fresh signature, missing header, malformed header, expired timestamp, tampered body, wrong secret, multi-candidate header. |
| `billing/__tests__/billing-pure.spec.ts` | 19 | `parseTier` canonicalization + fallback, `parseList` whitespace/empty handling, `computeSubscriptionState` happy path + defensive seats coercion + non-numeric seats + trial_end preservation, `classifyEvent` apply/log/ignore paths, all three subscription event types, ignored unknown types. |

Both are pure-function suites — no DB mocks, no Stripe SDK. The DB orchestration is exercised separately by integration tests (Phase 8 harness).

### Renewal-motion script

`backend/scripts/renewal-motion.ts` — scheduled-task CLI: scans for `status IN ('trialing','active') AND current_period_end <= now() + N days` and posts to a Slack webhook. CLI flags: `--notice-days 60` (matches MSA default), `--slack-webhook URL`, `--dry-run`. Wired as `npm run renewal:motion`. Designed to be run from EventBridge → Lambda or a daily cron job; reads `DATABASE_URL` directly (admin role; not break-glass — no PHI).

### CI gates added

`.github/workflows/ci.yml`:

| New job | Triggered on every PR | Runs |
|---|---|---|
| `lambda-scrubber-tests` | yes | `node --test index.test.js` (7 PHI scrubber assertions) |
| `extension-e2e` | yes (after `extension-typecheck-test` passes) | `npm run build` → `npx playwright install --with-deps chromium` → `xvfb-run npm run test:e2e`; uploads Playwright traces on failure |

The Phase 9 + 10 Playwright surface is now a real CI gate, not aspirational.

### Cutover dress-rehearsal runbook

`docs/RUNBOOKS/cutover-dress-rehearsal.md` — full sequenced playbook for a timed end-to-end stage rehearsal ≥ 7 days before real cutover. Owner per row, pass criteria per row, includes synthetic P1 fire drill (`aws ecs update-service --desired-count 0` for 90s) to verify pager + status-page comms. Failure-handling protocol (don't stop on first red — accumulate, then file P1 tickets and re-rehearse if any blocker remains). Retro template + sign-offs (CTO/CEO/Compliance) at T+1 day. Cadence: initial pre-cutover + on material architecture changes + quarterly with the DR drill.

## Hard constraints honored (no corner cutting)

- **Stripe SDK is gated to a single adapter file** (`StripeClient` interface in `billing-types.ts`); the rest of the billing module uses the abstract interface. Keeps the unit-test surface SDK-free and the prod import graph minimal.
- **Webhook signature verification is our own code, not Stripe's**, so the verifier is unit-testable end-to-end with a known body + secret + computed signature. Constant-time compare via `timingSafeEqual`. Replay protection at 300s default tolerance.
- **`org_id` is derived from `subscription.metadata.org_id`, never from a request header.** Webhook bodies are untrusted; we treat metadata supplied by Stripe as the only orgId source on this path.
- **Idempotent on `stripe_event_id` UNIQUE constraint** — webhook replays are no-ops.
- **`billing_event.raw_payload` is the full Stripe payload as JSONB**, not a flattened/typed schema. Stripe's payloads evolve; we don't lose forensic detail to schema-fitting.
- **TierGuard allows read access during a billing grace period** (past_due / unpaid) so a customer can still see their data while resolving billing. Writes are blocked. This matches the MSA term that customers retain access to their data through reasonable disputes.
- **Pure logic extracted into `billing-pure.ts`** so 19 of the 26 new tests run without any DB or Stripe stubs at all — pure inputs → pure outputs.
- **Renewal-motion uses the `subscription_period_end_idx`** for index-only access on the daily scan; doesn't sequential-scan the table.
- **CI E2E job uploads Playwright traces on failure** — the next time it breaks, the engineer has the artifact in their browser, not a re-run loop.
- **Dress-rehearsal runbook fires synthetic incidents** including a P1 — the rehearsal itself proves the on-call cadence works, not just the green path.

## Bug caught + fixed during this session

- **Migration drift caught at write-time**: first draft used `app.set_updated_at()` but the existing helper is `app.touch_updated_at()` (defined in 0008). Pattern-matched against `0009`'s usage and corrected before committing.

## Pre-existing issue surfaced (NOT a Phase 11 regression)

- **`docs/openapi.json` was never produced.** The Phase 8 export script (`scripts/export-openapi.ts`) exits 1 with empty output when run, and the file has never been committed. This pre-existed Phase 11; the CI drift-check job will fail until the underlying ts-node / Nest factory issue is debugged. Filed for Phase 12.

## What's deliberately NOT in Phase 11

- **Live Stripe wiring + first real customer charge.** All scaffolding is in; first charge happens once the first design-partner contract is signed.
- **Dunning UI / past-due banners.** The TierGuard returns `PAYMENT_REQUIRED` to writes; UI surfacing waits for the first customer feedback in stage.
- **Self-serve seat-add flow.** Seats are settled at signature today; self-serve seat-add is a Phase 12 surface.
- **Background reconciler that re-fetches subscriptions on `invoice.*` events.** The webhook still records the event; Stripe emits a follow-up `subscription.updated` that does the state apply. Background reconciler is belt-and-suspenders for Phase 12.
- **OpenAPI export bug fix.** Pre-existing; Phase 12.

## Cumulative state at end of Phase 11

| Metric | P7 | P8 | P9 | P10 | **P11** |
|---|---|---|---|---|---|
| SQL migrations | 12 | 12 | 12 | 12 | **13** |
| Seed files | 15 | 15 | 15 | 15 | **16** |
| Backend modules | 26 | 26 | 26 | 26 | **27 (+billing)** |
| Backend test suites | 34 | 34 | 34 | 34 | **36 (+2)** |
| Backend tests | 309 | 309 | 309 | 309 | **335 (+26)** |
| Extension test suites | 4 | 4 | 4 | 4 | **4** |
| Extension tests | 30 | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | — | — | — | 7 | **7** |
| **Combined unit tests** | 339 | 339 | 339 | 346 | **372** |
| Smoke specs (gated) | — | — | 1 | 1 | **1** |
| Playwright E2E specs / tests | — | — | 1 / 2 | 2 / 3 | **2 / 3** |
| HTTP endpoints | ~22 | ~22 | ~22 | ~22 | **~24 (+2 billing)** |
| Runbooks | 0 | 5 | 6 | 6 | **7 (+dress-rehearsal)** |
| CI jobs | 2 | 5 | 5 | 5 | **7 (+E2E +scrubber)** |
| Terraform .tf files | 0 | 0 | 8 | 9 | **9** |
| TypeScript errors | 0 | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
# Backend
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                        # 0 errors
npx jest --ci                           # 36 suites, 335 tests

# Extension
cd ..\browser-extension
npx tsc --noEmit
npx jest --ci                           # 4 suites, 30 tests

# Lambda PHI scrubber
cd ..\infra\terraform\lambda\datadog-forwarder
node --test index.test.js               # 7/7 pass

# Renewal motion (dry-run, against a stage DATABASE_URL)
cd ..\..\..\..\backend
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run renewal:motion -- --notice-days 60 --dry-run
```

Phase 12 (live stage Stripe wiring + first design-partner Stripe customer + OpenAPI export bug fix + dunning UI surface + background reconciler + self-serve seat-add) on `continue`.
