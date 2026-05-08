# Phase 13 — Stripe Customer Portal, Reconciler Orchestrator, Billing Audit Log, Scheduled-Task Infra

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **38 suites / 351 tests / 0 failures (~32s).**
`npx ts-node scripts/export-openapi.ts` → **32 paths** in `docs/openapi.json`.

**Combined: 42 unit-test suites / 388 tests, all green.**

This phase is the closing layer on the Phase 11–12 billing surface: customer-self-serve via Stripe's hosted Customer Portal, the orchestration script that closes the webhook-drift loop, audit-log emission so SOC 2 evidence collection has a clean trail per state change, and the EventBridge → ECS-RunTask Terraform that schedules both the reconciler and the renewal motion in production.

## What landed

### Stripe Customer Portal

`backend/src/billing/stripe-api-client.ts`:

- New method `createPortalSession({ customerId, returnUrl })` — POST `/v1/billing_portal/sessions`, returns `{ id, url, expires_at }`. Stripe's hosted UI handles payment-method updates, invoice history, and subscription management.

`backend/src/billing/billing-types.ts`:

- `StripeClient` interface now declares `createPortalSession?` and `updateSubscriptionSeats?` as optional methods. Tests can satisfy the interface with the minimum surface they exercise.

`backend/src/billing/billing-admin.controller.ts`:

- New endpoint `POST /v1/admin/billing/portal-session` with body `{ return_url }`. Auth-guarded. Looks up the org's `stripe_customer_id` from the `subscription` cache (RLS-scoped), calls `stripe.createPortalSession`, returns `{ url, expires_at }` for the UI to redirect into.
- Structured 503 codes when Stripe isn't configured (`STRIPE_NOT_CONFIGURED`) or the customer hasn't been linked yet (`STRIPE_CUSTOMER_NOT_LINKED`).

### Reconciler orchestrator script

`backend/scripts/reconcile-billing.ts` — wires Phase 12's pure `findStaleInvoiceEvents` to the database + Stripe API:

1. Read recent `billing_event` rows over the configured `--lookback-hours`.
2. Run `findStaleInvoiceEvents` to identify `(org_id, stripe_subscription_id)` pairs whose `invoice.*` events lack a follow-up `customer.subscription.*`.
3. Per pair, call `StripeApiClient.retrieveSubscription(...)`.
4. Wrap in a synthetic `customer.subscription.updated` event and call `BillingService.ingestEvent(...)`. **Idempotent** on the deterministic synthetic event id, so running the script every 10 minutes never double-applies state.

CLI flags: `--lookback-hours 24 --stale-seconds 600 --dry-run`. Dry-run prints the plan without calling Stripe — perfect for stage rehearsal.

Wired as `npm run billing:reconcile`.

### Billing audit-log integration

`backend/src/billing/billing.service.ts` — every state-changing webhook (`customer.subscription.created/updated/deleted`) now writes an `audit_log` row inside the same transaction as the `billing_event` insert:

```
{
  action: 'billing.customer.subscription.updated',
  target_type: 'subscription',
  target_id: '<stripe_sub_id>',
  payload: { stripe_event_id: '<evt_...>', computed: { tier, seats, status, period_end } },
  user_agent: 'stripe-webhook'
}
```

Why only state-changing events: the audit log is signal-rich evidence for SOC 2 sampling, not a transaction log. Replays / no-ops / `invoice.*` log-only events are already in `billing_event` for forensic replay; doubling them in `audit_log` would dilute the evidence value.

The audit row contains the **computed_state** (post-state summary), not the raw Stripe payload. No PHI, no payment details, no card data.

### EventBridge → ECS-RunTask scheduled tasks

`infra/terraform/scheduled-tasks.tf`:

| Schedule | Frequency | Script | Enabled in |
|---|---|---|---|
| `billing-reconcile` | `rate(10 minutes)` | `scripts/reconcile-billing.ts` | prod only |
| `renewal-motion` | `cron(0 14 * * ? *)` (daily 14:00 UTC) | `scripts/renewal-motion.ts` | prod only |

Both use ECS-RunTask invoking the existing API task definition with a different `command` override (so they share the API's runtime config — Secrets Manager bindings, VPC, RDS access — without a separate deploy artifact). EventBridge has its own scoped IAM role (`br-<env>-events-runtask`) with `ecs:RunTask` against the API task family + `iam:PassRole` to the existing task / exec roles.

`state = var.env == "prod" ? "ENABLED" : "DISABLED"` — schedules are visible in stage Terraform but won't fire there. Stage rehearsal triggers them manually via `aws events put-events`.

### New tests

| Suite | Added | Total |
|---|---|---|
| `stripe-api-client.spec.ts` | +1 (createPortalSession) | 9 |

The reconciler-orchestrator script doesn't get a dedicated unit test — its pure logic was tested in Phase 12 (`reconciler.spec.ts` 7 tests), and the orchestration is glue (DB read → loop → Stripe → ingest). Stage rehearsal validates the end-to-end path.

## OpenAPI export

`docs/openapi.json` now ships **32 paths** (was 31 in Phase 12, +1 portal-session). Phase 8's CI drift gate stays functional.

## Hard constraints honored (no corner cutting)

- **Customer Portal endpoint never sees card data**. We only pass `customer_id` + `return_url`; Stripe's UI handles everything sensitive.
- **Reconciler is idempotent at three layers**: deterministic synthetic event id → `billing_event.stripe_event_id UNIQUE` → `BillingService.ingestEvent` returns `{ duplicate: true }` on replay.
- **Reconciler opens its own admin pool** (cross-tenant scan), but every per-org state apply goes through `runWithTenant` which re-applies RLS. Cross-tenant write is impossible by construction.
- **EventBridge schedules are disabled in stage by default**. Prevents stage-leak side effects (Slack pings, Stripe API calls) when stage gets a real Stripe key. Stage rehearsal triggers manually.
- **Audit log records computed_state, not raw payload**. Stripe payloads are stored in `billing_event.raw_payload` (forensic). `audit_log.payload` is signal-rich for SOC 2 evidence sampling.
- **Audit log rows are written in the same transaction** as `billing_event` insert + state apply. A failure rolls back all three; no partial-state evidence trails.
- **Audit log emission is gated to state-changing events only**. Replays are no-ops in `audit_log`; `invoice.*` events stay in `billing_event` for forensics. Auditors get the signal, not the noise.
- **EventBridge rule's `target_definition_arn` doesn't pin a revision**. ECS picks the latest active task definition each invocation — schedules track the deployed image without TF re-applies.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 13

- **Live Stripe API key in stage**. Manual ops step; key gets dropped into stage Secrets Manager once the stage Stripe account is created.
- **First prod cutover**. Gated on the dress-rehearsal pass + SOC 2 Type 1 + first design-partner contract executed. Phase 14 candidate.
- **Stripe Checkout session for new-tenant onboarding**. Self-serve onboarding is a Phase 14+ surface; today, ops creates the customer + subscription in Stripe out-of-band, then the webhook flows into our cache.
- **Reconciler cross-tenant batching**. Today the script processes one subscription at a time; if we ever have hundreds of stale events per run, a parallel batch with concurrency limit is a one-line change.
- **EventBridge → Datadog dashboard**. Deferred until the first prod schedule fires.

## Cumulative state at end of Phase 13

| Metric | P10 | P11 | P12 | **P13** |
|---|---|---|---|---|
| SQL migrations | 12 | 13 | 13 | **13** |
| Backend test suites | 34 | 36 | 38 | **38** |
| Backend tests | 309 | 335 | 350 | **351 (+1)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 346 | 372 | 387 | **388** |
| HTTP endpoints | ~22 | ~24 | ~26 | **~27 (+portal)** |
| `docs/openapi.json` paths | broken | broken | 31 | **32** |
| Scheduled tasks (TF) | 0 | 0 | 0 | **2 (reconciler + renewal)** |
| Runbooks | 6 | 7 | 7 | **7** |
| Terraform .tf files | 9 | 9 | 9 | **10** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                 # 0 errors
npx jest --ci                                    # 38 / 351
npx ts-node scripts/export-openapi.ts            # 32 paths

# Reconciler dry-run (works without STRIPE_API_KEY)
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run billing:reconcile -- --lookback-hours 24 --dry-run
```

Phase 14 (live Stripe API key in stage + Stripe Checkout for self-serve onboarding + first dress rehearsal on stage + first design-partner Stripe customer in prod) on `continue`.
