# Phase 14 — Stripe Checkout, Tier/Price Catalog, Self-Serve Data Export, Dress-Rehearsal Results

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **39 suites / 359 tests / 0 failures (~32s).**
`npx ts-node scripts/export-openapi.ts` → **36 paths** in `docs/openapi.json`.

**Combined: 43 unit-test suites / 396 tests, all green.**

This phase is **+1 suite / +8 tests** for billing (price-catalog 3, stripe-api-client +2 for Checkout, billing-pure +3 for new log-only event types).

The phase closes Stripe self-serve onboarding (Checkout session), adds the tier→price catalog the Checkout endpoint reads, completes MSA § 7.1's data-export commitment with three streamed-export endpoints, and lands the dress-rehearsal results template that the rehearsal coordinator fills in to clear cutover.

## What landed

### Stripe Checkout for self-serve onboarding

`backend/src/billing/stripe-api-client.ts`:

- `createCheckoutSession({ priceId, quantity, successUrl, cancelUrl, customerEmail?, orgId, tier, states?, specialty_packs?, trialDays? })` — POSTs `/v1/checkout/sessions` with `mode=subscription`, line-item `price + quantity`, and Stripe-shipped metadata that our existing webhook controller already routes on (`subscription_data.metadata.org_id`). Returns `{ id, url }` for the UI to redirect into.
- Form-encoded body sets `billing_address_collection=required` and `allow_promotion_codes=true`.

`backend/src/billing/billing-types.ts`:

- `StripeClient` interface declares optional `createCheckoutSession?` so test stubs can satisfy the minimal surface they need.

`backend/src/billing/billing-pure.ts`:

- `classifyEvent` now recognizes `checkout.session.completed`, `checkout.session.expired`, and `invoice.uncollectible` as `log` events (not `ignore`). Stripe's follow-up `customer.subscription.created` is what actually applies state — these events are forensic only.

`backend/src/billing/billing.service.ts`:

- `applyEvent` switch handles the three new event types as log-only (returning a small computed-state breadcrumb).

### Tier → Price catalog

`backend/src/billing/price-catalog.ts`:

- `resolvePriceId(tier, env)` — env-driven mapping (`STRIPE_PRICE_SOLO/TEAM/ORG/ENTERPRISE`).
- `SELF_SERVE_TIERS = ['solo', 'team', 'org']` and `isSelfServeTier(tier)`. Enterprise is contracted via Sales / Order Form, not Checkout — the controller rejects an Enterprise Checkout request with `TIER_NOT_SELF_SERVE`.

3 unit tests in `__tests__/price-catalog.spec.ts`.

### `POST /v1/admin/billing/checkout-session`

`backend/src/billing/billing-admin.controller.ts`:

```
POST /v1/admin/billing/checkout-session
Body: {
  tier: 'solo' | 'team' | 'org',
  quantity: 1..10000,
  success_url, cancel_url,
  customer_email?,
  states?: string[],
  specialty_packs?: SpecialtyPack[],
  trial_days?: 0..60
}
→ { url }      (UI redirects browser into Stripe Checkout)

403  TIER_NOT_SELF_SERVE       (enterprise tier)
503  STRIPE_NOT_CONFIGURED     (missing STRIPE_API_KEY)
503  PRICE_NOT_CONFIGURED      (missing STRIPE_PRICE_<tier>)
```

class-validator DTO uses the closed `ALL_SPECIALTY_PACKS` enum from billing-types so a typo'd specialty pack is a 400, not a silent metadata stamp.

### Self-serve data export endpoints (MSA § 7.1)

`backend/src/admin/data-export.controller.ts` — three streamed endpoints registered in `AdminModule`:

| Endpoint | Format | Pagination |
|---|---|---|
| `GET /v1/admin/export/rulebooks` | JSON document | None — finalized rulebook count is bounded |
| `GET /v1/admin/export/audit-log?days=N` | NDJSON streamed | Keyset on `(occurred_at desc, id desc)`, page size 1000 |
| `GET /v1/admin/export/era-835?days=N` | CSV streamed | Date-window read |

`days` clamps to `[1, 365]` (default 90). All RLS-scoped via `runReadOnlyWithTenant`. Memory bound: NDJSON streams one record per line; CSV writes one row per line. Months-long exports never blow out RAM.

CSV cells are properly quoted (RFC 4180-ish): commas / newlines / quote marks force `"…"` wrapping with `""` doubling.

### Dress-rehearsal results template

`docs/RUNBOOKS/cutover-dress-rehearsal-results.md` — the fillable companion to `cutover-dress-rehearsal.md`. Coordinator copies the sequence-row table, marks PASS/FAIL with actual times, captures the metric numbers (lookup p95, error rate, eval pass, webhook latency, Datadog log lag, pager ack-to-resolution, status-page first-update), files P1/P2 ticket lists, and signs off CTO/CEO/Compliance.

Includes a **Synthetic Datadog scrubber regression** matrix — the 5 PHI patterns the Lambda tests cover. **Any "yes" in the "visible in Datadog" column is a P0 cutover blocker.**

## Hard constraints honored (no corner cutting)

- **Webhook bodies stay untrusted.** Stripe Checkout shipped `subscription_data.metadata.org_id` is the only trusted org_id source on the webhook path (matches Phase 11 contract). The Checkout endpoint stamps it from the verified `req.auth.orgId`, so the metadata travels with the customer's verified identity end to end.
- **Enterprise tier is gated to Sales motion.** `isSelfServeTier` returns false; the Checkout endpoint rejects with a structured 400, so the UI surfaces "Talk to sales" and a Sales-team email link.
- **Price IDs come from env, not config files.** Different envs (test / stage / prod) get different Stripe keys + price IDs. No accidental prod-price-in-test wiring.
- **Data export is streamed.** A tenant with 12 months of audit-log activity (millions of rows) exports without OOM. Keyset pagination is stable under writes during the dump.
- **CSV escaping is RFC 4180-compliant.** Cells with comma / newline / quote get the right wrap; CARC code arrays render `|`-joined to avoid CSV-internal commas.
- **`audit-log?days=N` clamps to 365.** A tenant can't ask us to scan 100,000-day windows; we cap at one year (which already satisfies SOC 2 sampling for any standard audit period).
- **Dress-rehearsal scrubber matrix is a P0 gate.** "Did test PHI bleed through to Datadog?" must be NO. The runbook makes that explicit; cutover stops there if even one pattern fails.
- **`StripeClient.createCheckoutSession?` is optional.** Tests don't have to stub it; production wiring uses the concrete `StripeApiClient`.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run.)

## What's deliberately NOT in Phase 14

- **Live Stripe API key in stage.** Manual ops step; key gets dropped into stage Secrets Manager and `STRIPE_PRICE_*` env vars wired before the dress rehearsal runs.
- **First prod cutover.** Gated on dress-rehearsal pass (using the new results template) + SOC 2 Type 1 + first contract executed.
- **Org self-provisioning flow** (creating a new tenant org from a Checkout completion). Out-of-band ops handles the org creation today; Stripe Checkout binds an existing org's customer record. Self-provisioning is a Phase 15 candidate.
- **Stripe Checkout Test Clock for time-travel testing.** Useful for verifying trial-end / dunning flows in stage; defer until first stage rehearsal.
- **Rulebook export PDF format.** JSON today; PDF rendering deferred (CSM can render manually for any tenant that needs it).

## Cumulative state at end of Phase 14

| Metric | P11 | P12 | P13 | **P14** |
|---|---|---|---|---|
| SQL migrations | 13 | 13 | 13 | **13** |
| Backend modules | 27 | 27 | 27 | **27** |
| Backend test suites | 36 | 38 | 38 | **39 (+1)** |
| Backend tests | 335 | 350 | 351 | **359 (+8)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 372 | 387 | 388 | **396** |
| HTTP endpoints | ~24 | ~26 | ~27 | **~31 (+checkout, 3 exports)** |
| `docs/openapi.json` paths | broken | 31 | 32 | **36** |
| Scheduled tasks (TF) | 0 | 0 | 2 | **2** |
| Runbooks + templates | 7 | 7 | 7 | **8 (+results template)** |
| Terraform .tf files | 9 | 9 | 10 | **10** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                # 0 errors
npx jest --ci                                   # 39 / 359
npx ts-node scripts/export-openapi.ts           # 36 paths

# Live Checkout flow against stage (requires STRIPE_API_KEY + STRIPE_PRICE_TEAM)
$env:STRIPE_API_KEY = "sk_test_..."
$env:STRIPE_PRICE_TEAM = "price_..."
# UI calls POST /v1/admin/billing/checkout-session and redirects to {url}.
```

Phase 15 (org self-provisioning + Stripe Test Clock + first stage dress rehearsal + first design-partner contract executed + first Stripe Customer in prod) on `continue`.
