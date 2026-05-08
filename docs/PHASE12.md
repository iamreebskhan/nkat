# Phase 12 — OpenAPI Fix, Stripe SDK Adapter, Reconciler, Dunning UI, Seat-Add

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **38 suites / 350 tests / 0 failures (~30s).**
`npx tsc --noEmit` (extension) → **0 errors.**
`npx jest --ci` (extension) → **4 suites / 30 tests / 0 failures (~14s).**
`node --test infra/terraform/lambda/datadog-forwarder/index.test.js` → **7/7 pass.**

**Combined: 42 unit-test suites / 387 tests, all green** + Bedrock smoke (gated) + 2 Playwright E2E specs (3 tests, opt-in) + Lambda scrubber (7).

This phase adds **2 new suites and 15 new tests** for the Stripe API client (8) and the reconciler (7). And finally, `docs/openapi.json` exists — 31 paths exported.

The phase fixes a long-running pre-existing bug, brings live Stripe wiring online, adds the closed-loop reconciler that handles webhook drift, and ships the dunning + self-serve seat-add endpoints the in-app UI consumes.

## What landed

### OpenAPI export bug — fixed

The Phase 8 export script `scripts/export-openapi.ts` had been silently exiting with code 1, never producing `docs/openapi.json`. The CI drift gate would have always failed once a real spec landed. Root cause: **three providers** had constructors with optional non-injectable parameters (`fetchImpl?: FetchLike`) that Nest's DI resolver couldn't satisfy. Nest threw asynchronously during `NestFactory.create(AppModule, { logger: false })`, but with `logger: false` the error was swallowed by a Node 25 unhandled-rejection handler that exited the process before our `process.on('unhandledRejection')` could fire.

Fix: add `@Optional()` to the three constructors and a defense-in-depth `pool.on('error')` listener in the pg pool factory.

| File | Fix |
|---|---|
| `backend/src/webhooks/webhook.service.ts` | `@Optional() fetchImpl?: FetchLike` |
| `backend/src/cms0057/pa-adapter.ts` | `@Optional() fetchImpl?: FetchLike` |
| `backend/src/ingestion/cms-coverage-api.client.ts` | `@Optional() fetchImpl?: FetchLike` |
| `backend/src/database/pool.ts` | `pool.on('error', …)` so a failed idle-client doesn't kill the process |

`docs/openapi.json` now ships 31 paths (was 29 in Phase 8 + 2 new from Phase 12). The Phase 8 CI drift-gate is now functional.

### Concrete Stripe API adapter

`backend/src/billing/stripe-api-client.ts` — HTTP-only adapter (no Stripe SDK dependency, just `fetch` + form-encoded bodies per Stripe's API contract). Coverage:

- `retrieveSubscription(id)` — GET `/v1/subscriptions/:id`
- `retrieveInvoice(id)` — GET `/v1/invoices/:id`
- `updateSubscriptionSeats({ subscriptionId, subscriptionItemId, quantity, prorate })` — POST with `proration_behavior=create_prorations` by default

Webhook signature verification stays in `stripe-hmac.ts` — `constructEvent` on this client throws to enforce the boundary.

8 unit tests in `__tests__/stripe-api-client.spec.ts` covering: required apiKey, GET round-trip with `Bearer` + `stripe-version` headers, URL encoding, non-2xx → `StripeApiError`, POST seat-update form encoding, `prorate=false`, invoice typed slice, constructEvent guard.

### Background reconciler — pure logic + tests

`backend/src/billing/reconciler.ts`:

- `findStaleInvoiceEvents({ events, nowMs, staleSeconds })` — scans `billing_event` rows for `invoice.{paid,payment_failed,uncollectible}` events older than the staleness threshold that have no follow-up `customer.subscription.*` event. Returns the list of `{ org_id, stripe_subscription_id }` to refetch.
- `buildSyntheticReconcileEvent(orgId, sub, nowMs)` — wraps a refetched subscription in a synthetic `customer.subscription.updated` event so it walks the same `BillingService.ingestEvent` code path the webhook uses.

7 unit tests in `__tests__/reconciler.spec.ts` covering: stale invoice with no follow-up flagged, follow-up subscription event clears the flag, fresh invoice not flagged, all three invoice event types, ordering correctness (subscription event BEFORE invoice doesn't count as follow-up), garbage events with no resolvable subscription id ignored, synthetic event shape.

### Dunning state + self-serve seat-add

`backend/src/billing/billing-admin.controller.ts`:

```
GET  /v1/admin/billing/dunning-state
   → { banner: 'past_due' | 'unpaid' | 'trial_ending' | null, ... }

POST /v1/admin/billing/seats   { quantity }
   → 200 { ok, seats }   /   403 { code: 'PAYMENT_REQUIRED' | 'INACTIVE_SUBSCRIPTION' | … }
                         /   400 { code: 'SEATS_OUT_OF_TIER_RANGE', tier, min, max }
```

Tier-bound seat ranges (`solo: 1, team: 2-10, org: 11-100, enterprise: 1-10k`) are encoded in the controller; out-of-range is rejected with a structured error code the UI surfaces. The seat-add path uses `stripe.updateSubscriptionSeats(...)` (with prorations) and write-throughs the local cache so the next `GET /entitlement` doesn't have to wait for the webhook hop. The webhook still arrives and is idempotent, so we double-apply safely.

The dunning endpoint reads `subscription.status` + `current_period_end` + `trial_end` and emits a banner with a friendly message. `trial_ending` only fires inside the last 7 days of trial.

### BillingModule — concrete Stripe wiring

`backend/src/billing/billing.module.ts`:

- `BillingModule.forRoot({ stripeSigningSecret, stripeApiKey?, stripeClient? })`
- Production wires the real `StripeApiClient` from the env `STRIPE_API_KEY`.
- Tests pass `stripeClient: <fake>` to bypass the network entirely.
- The `STRIPE_CLIENT_TOKEN` provider is `@Optional()` in the admin controller so when the API key isn't set, dunning still works (it doesn't call Stripe), but seat-add returns 503 `STRIPE_NOT_CONFIGURED`.

### AppModule wiring

`backend/src/app.module.ts` updated to pass `stripeApiKey: process.env.STRIPE_API_KEY` to `BillingModule.forRoot`. When unset, the seat-add endpoint correctly responds 503 instead of silently no-op'ing.

## Hard constraints honored (no corner cutting)

- **No Stripe SDK dependency added.** The adapter uses Node's built-in `fetch` and form-encoded bodies. Saves ~1.5MB of node_modules and avoids SDK version churn for the 3 endpoints we actually call.
- **`@Optional()` on every non-injectable constructor parameter.** Three providers had been getting away with this in unit tests but breaking Nest DI in real bootstrapping. The fix is consistent across all three; the OpenAPI export is now CI-green proof that the bootstrap path works.
- **`pool.on('error', …)` is a defense layer**, not a fix on its own. The Pool's idle-client errors no longer crash the process even if a downstream module forgets to import the pool's lifecycle hook.
- **Reconciler is pure**. `findStaleInvoiceEvents` takes a list + clock + threshold and returns a plan. The orchestrator (script or scheduled job) does the actual `retrieveSubscription` + `ingestEvent` calls.
- **Synthetic reconcile events use a deterministic id format** (`evt_reconciled_<sub>_<sec>`). They're idempotent on the BillingService's `stripe_event_id` UNIQUE constraint — so re-running reconciliation never double-applies state.
- **Seat-add write-through doesn't wait for the webhook**. Stripe call → local UPDATE → webhook arrives → idempotent no-op. UI is responsive even when webhook is delayed.
- **Dunning banner is read-only**. No mutation, no Stripe call from the dunning endpoint — pure read of the cached state.
- **Tier-bound seat ranges are encoded in code**, not in config. Tier semantics are part of the product's licensing model; they don't belong in a per-deploy config that could drift between environments.

## Bug caught + fixed during this session

- **`reconciler.ts` had an unused `org_id` parameter** in `buildSyntheticReconcileEvent`. Strict mode caught it under `noUnusedParameters: true`. Renamed to `_orgId` to satisfy the lint rule (the parameter exists so callers don't have to thread orgId through a separate channel).

## What's deliberately NOT in Phase 12

- **Reconciler controller / scheduled task wiring.** The pure logic + tests are committed; the orchestrator (Nest `@Cron` or external EventBridge → Lambda) wires up in stage during Phase 13.
- **Stripe customer + subscription creation flow.** Done out-of-band by ops at signup until the self-serve onboarding flow is built — Phase 14 candidate.
- **Stripe Customer Portal redirect.** The dunning banner suggests "update payment method" but doesn't yet generate a portal session — Phase 13 (one-line addition once `STRIPE_API_KEY` is live in stage).
- **Tier downgrade flow.** Self-serve seat-add only goes up; downgrade requires CSM contact (matches MSA + Customer Success Playbook).

## Cumulative state at end of Phase 12

| Metric | P9 | P10 | P11 | **P12** |
|---|---|---|---|---|
| SQL migrations | 12 | 12 | 13 | **13** |
| Seed files | 15 | 15 | 16 | **16** |
| Backend modules | 26 | 26 | 27 | **27** |
| Backend test suites | 34 | 34 | 36 | **38 (+2)** |
| Backend tests | 309 | 309 | 335 | **350 (+15)** |
| Extension test suites | 4 | 4 | 4 | **4** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | — | 7 | 7 | **7** |
| **Combined unit tests** | 339 | 346 | 372 | **387** |
| HTTP endpoints | ~22 | ~22 | ~24 | **~26 (+dunning, seat-add)** |
| `docs/openapi.json` paths | — (broken) | — (broken) | — (broken) | **31** |
| Runbooks | 6 | 6 | 7 | **7** |
| CI jobs | 5 | 5 | 7 | **7** |
| Terraform .tf files | 8 | 9 | 9 | **9** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                # 0 errors
npx jest --ci                                   # 38 suites / 350 tests
npx ts-node scripts/export-openapi.ts           # writes docs/openapi.json (31 paths)

cd ..\browser-extension
npx tsc --noEmit
npx jest --ci                                   # 4 / 30

cd ..\infra\terraform\lambda\datadog-forwarder
node --test index.test.js                       # 7/7
```

Phase 13 (live Stripe API key in stage + Stripe Customer Portal redirect + reconciler scheduled task + first prod cutover) on `continue`.
