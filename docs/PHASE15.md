# Phase 15 — Self-Serve Signup, Stripe Test Clock, Public Anonymous Endpoint

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **40 suites / 380 tests / 0 failures (~31s).**
`npx ts-node scripts/export-openapi.ts` → **37 paths** in `docs/openapi.json`.

**Combined: 44 unit-test suites / 417 tests, all green.** This phase adds **+1 suite / +21 tests**.

This phase closes the self-serve loop a brand-new tenant walks through: the public, anonymous `POST /v1/signup/start` endpoint that creates an org synchronously, generates a Stripe Checkout session with the right metadata, and records a `signup_attempt` row that lets ops triage abandoned cohorts. Stripe Test Clock support lands so the dress rehearsal can time-travel a customer through trial-end / dunning / renewal in minutes instead of weeks.

## What landed

### Migration 0014 — `signup_attempt`

`db/migrations/0014_phase15_signup.sql` — append-only audit log of signup starts, **not** RLS-scoped (admin-only read; non-PHI; cross-tenant scan supports cohort analysis).

| Column | Notes |
|---|---|
| `org_id` | NOT NULL — org row created synchronously at signup start |
| `company_name`, `admin_email`, `tier`, `quantity`, `states[]`, `specialty_packs[]`, `trial_days` | Inputs preserved for forensics |
| `stripe_checkout_session_id` | UNIQUE — webhook completion looks up by this |
| `status` | `pending` → `completed` / `abandoned` / `expired` |
| `source_ip`, `source_user_agent` | Rate-limit + abuse triage |
| `expires_at` | Defaults to `now() + 24h` (Stripe's Checkout session TTL) |

Indexes: `(org_id)`, `(created_at) WHERE status='pending'` (cleanup scan), `(admin_email)` (return-customer detection).

### `signup-pure.ts` — pure helpers + 14 unit tests

- `slugFromCompanyName(name)` — strips diacritics + collapses to URL-safe slug, caps at 48 chars, never empty (falls back to `tenant`).
- `suffixedSlug(base, suffix)` — sanitizes 6-char suffix for collision retry.
- `clampTrialDays(raw)` — caps at 14 days per product policy, integer-floors fractional input, treats negatives / NaN as 0.

### `SignupService.start()`

`backend/src/signup/signup.service.ts`:

1. Validates Stripe is configured + tier is self-serve (`solo`/`team`/`org`) + `STRIPE_PRICE_<tier>` resolves.
2. Allocates a unique slug — base slug; on UNIQUE conflict, appends a 6-hex-char random suffix; bounded retry (5 attempts).
3. Inserts the new `org` row (admin connection — no RLS context, this is the bootstrap moment).
4. Creates the Stripe Checkout session with `metadata.org_id` + `subscription_data.metadata.{org_id, tier, seats, states, specialty_packs}` so the existing webhook controller routes the resulting subscription to the correct tenant.
5. Records the `signup_attempt` row with the Checkout session id + IP + user agent.
6. **Compensating delete**: if Stripe rejects the session, the just-inserted org is rolled back so we don't leak orphaned tenants into analytics + the slug namespace.

Returns `{ org_id, signup_attempt_id, checkout_url }`.

### `POST /v1/signup/start` — public, anonymous, rate-limited

`backend/src/signup/signup.controller.ts`:

- DTO validated by `class-validator` — closed-enum tier, `quantity` 1–10000, URLs require protocol + TLD-not-required, optional 2-char US state codes, optional `SpecialtyPack` enum, optional `trial_days` 0–14.
- **Per-IP token bucket**: 5 starts / 60s. In-memory `Map` with coarse eviction at 10k entries. Replace with Redis when we scale beyond one ECS task. The WAF in front of the ALB does the heavy lifting; this is application-level defense in depth.
- 403 `RATE_LIMITED` on bucket exhaustion.
- Test-only export `_resetSignupRateLimit()` for spec isolation.

### Stripe Test Clock support

`StripeApiClient` adds three methods:

- `createTestClock({ frozenTime, name? })` — POST `/v1/test_helpers/test_clocks`
- `advanceTestClock({ id, frozenTime })` — POST `/v1/test_helpers/test_clocks/:id/advance`
- `deleteTestClock(id)` — DELETE

Stage rehearsal scripts can now jump a synthetic subscription forward 14 days to verify `trial_end` → `active` transition, 30 days to verify `customer.subscription.updated` arrival cadence, and 60+ days to verify dunning/cancellation behavior — all in seconds. Production safety: ops policy never constructs a clock against a live key; the methods exist for stage scripts only.

3 new tests in `stripe-api-client.spec.ts`.

### BillingModule made global

`BillingModule.forRoot(...)` now returns `global: true` and exports `STRIPE_CLIENT_TOKEN`. SignupModule depends on the Stripe client provider without re-importing BillingModule. The ergonomic shape mirrors `DatabaseModule`'s pattern.

### AppModule wiring

`SignupModule` registered after `BillingModule.forRoot(...)` in `AppModule`'s imports list.

## Hard constraints honored (no corner cutting)

- **Compensating delete on Stripe failure.** Inserting the org first (so the slug + URL routing works) then creating the Checkout session creates a small window where Stripe could fail. The service rolls back the org so an abandoned signup leaves no fingerprint.
- **Rate limit is opt-in for tests.** `_resetSignupRateLimit()` clears state between describe blocks; production never invokes it. The bucket is bounded to 10k entries before coarse eviction so a sustained DoS doesn't OOM.
- **`metadata.org_id` is the contract.** SignupService stamps it on both the Checkout session AND the embedded subscription metadata, so the existing webhook handler (Phase 11) routes correctly without any new code path.
- **Trial days hard-capped at 14.** Even if a future feature flag lets ops grant longer trials, the controller's `class-validator` Max(14) AND the service's `clampTrialDays(14)` both enforce. Defense in depth.
- **Test Clock is decoupled from production wiring.** The methods are on the concrete adapter, NOT on the abstract `StripeClient` interface — so production code can't accidentally call them, and `instanceof StripeApiClient` is the only path.
- **Signup endpoint is unauthenticated by design.** It's the entry point for new tenants. The `class-validator` DTO + the IP rate limit + the WAF are the three layers of abuse protection.
- **Slug allocation is bounded.** 5 retries with hex suffixes covers ~16M unique slugs per company name. Beyond that, the service throws `SLUG_ALLOCATION_FAILED` rather than spinning forever.

## Bug caught + fixed during this session

- **`org` row insert was missing `status` + `metadata`** even though both have DB defaults. Strict Kysely insert types require explicit values for non-`Generated<>` fields. Added `status: 'active', metadata: {}` to the insert builder.

## What's deliberately NOT in Phase 15

- **Email verification flow.** Stripe Checkout requires `customer_email` + the admin completes payment, which is sufficient bot-resistance for now. A double-opt-in via magic-link is a Phase 16 candidate.
- **First-admin invite + login.** Self-serve signup creates the org row but doesn't yet seat the admin. CSM (or a Phase 16 magic-link) handles the first login. The `primary_contact_email` is stamped on the org so we know who to invite.
- **Pending signup cleanup job.** A scheduled task should expire `signup_attempt` rows past `expires_at` and (if no subscription exists) delete the org. Indexed `(created_at) WHERE status='pending'` is ready for this; the cron job lands in Phase 16.
- **Org self-provisioning from `checkout.session.completed`.** Today the org is created at signup-start time, not at checkout-completion. This is intentional: the success_url needs an `org_id` to deep-link the customer into their tenant immediately on return.
- **Live stage Stripe key + first dress rehearsal.** Manual ops + scheduling.
- **First design-partner contract executed.** Manual GTM.
- **First prod Stripe Customer.** Sequenced after dress rehearsal pass.

## Cumulative state at end of Phase 15

| Metric | P12 | P13 | P14 | **P15** |
|---|---|---|---|---|
| SQL migrations | 13 | 13 | 13 | **14 (+signup)** |
| Backend modules | 27 | 27 | 27 | **28 (+signup)** |
| Backend test suites | 38 | 38 | 39 | **40 (+1)** |
| Backend tests | 350 | 351 | 359 | **380 (+21)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 387 | 388 | 396 | **417** |
| HTTP endpoints | ~26 | ~27 | ~31 | **~32 (+/v1/signup/start)** |
| `docs/openapi.json` paths | 31 | 32 | 36 | **37** |
| Scheduled tasks (TF) | 0 | 2 | 2 | **2** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                # 0 errors
npx jest --ci                                   # 40 / 380
npx ts-node scripts/export-openapi.ts           # 37 paths

# Public signup smoke (against stage)
curl -X POST https://stage.example.com/v1/signup/start \
  -H "content-type: application/json" \
  -d '{
    "company_name": "Acme Hospice Billing",
    "admin_email": "admin@acme.com",
    "tier": "team",
    "quantity": 5,
    "success_url": "https://app.example.com/welcome",
    "cancel_url": "https://example.com/pricing"
  }'
# → { "checkout_url": "https://checkout.stripe.com/c/...", "org_id": "...", "signup_attempt_id": "..." }
```

Phase 16 (signup-attempt cleanup cron + magic-link first-admin invite + first dress rehearsal pass + first prod cutover) on `continue`.
