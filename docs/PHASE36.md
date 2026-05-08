# Phase 36 — Stripe Webhook Signing-Secret Rotation

## Why this phase

Rotating a Stripe webhook signing secret without rotation support
means: (a) a brief window where signed events are rejected as
invalid; or (b) coordinating dashboard rotation to the second with
a deploy. Both are operationally hostile.

The fix: accept multiple signing secrets simultaneously during a
rotation window. Update the deployed config first (now both the new
+ old secret are honored), rotate in the Stripe dashboard, observe
that no events are still arriving signed by the old secret, then
remove the old secret from config.

## What landed

### `backend/src/billing/stripe-hmac.ts`

- `signingSecret` now accepts `string | string[]`. Single-string
  usage is unchanged.
- Returns `{ timestamp, secretIndex }`. `secretIndex` is the 0-based
  position of the matching secret — `0` is "primary", any non-zero
  means a fallback secret matched.
- Iterates every (secret, candidate-v1) pair fully — no early-return
  on first secret-mismatch. Timing leaks the *count* of secrets
  (non-sensitive) but not which one matched.
- Empty-list and empty-string-entry cases throw with descriptive
  messages.

### `backend/src/billing/billing.controller.ts`

- Accepts `signingSecret: string | string[]` from DI.
- Builds an effective list (filters empty strings); throws
  `400 webhook signing secret not configured` when empty.
- Logs at WARN level when a non-primary secret matches, so ops can
  watch the count drop to zero before retiring the old secret.

### `backend/src/billing/billing.module.ts`

- `BillingModuleOptions.stripeSigningSecret: string | string[]`.
  Documented rotation semantics inline.

### `backend/src/app.module.ts`

- Reads both `STRIPE_WEBHOOK_SIGNING_SECRET` (new) and
  `STRIPE_WEBHOOK_SIGNING_SECRET_PREVIOUS` (old) from env, filters
  empties, passes the array. Single-secret deployments unaffected
  because the array collapses to one entry.

### Tests

- 5 new test cases in `stripe-hmac.spec.ts`:
  - primary-secret accept (returns secretIndex=0)
  - previous-secret accept (returns secretIndex=1)
  - rejected when neither secret matches
  - empty list throws
  - empty-string entry throws
- Full suite: **623 / 623 passing** (was 618; +5 new).

## Rotation runbook

1. Generate a new signing secret in Stripe dashboard but DON'T mark
   the old one inactive yet.
2. Deploy with `STRIPE_WEBHOOK_SIGNING_SECRET` = new secret,
   `STRIPE_WEBHOOK_SIGNING_SECRET_PREVIOUS` = old secret.
3. In Stripe dashboard, mark the old secret inactive.
4. Wait 24h. Watch Datadog for any
   `stripe webhook verified by rotation secret #1` warning logs. The
   count must drop to zero (Stripe never sends an event under a
   retired secret, but a buffered re-delivery in the first ~24h is
   plausible).
5. Deploy again with `STRIPE_WEBHOOK_SIGNING_SECRET_PREVIOUS`
   removed. Done.

## Notes on the sidebar UI E2E expansion

The Phase-36 plan also called for browser-extension sidebar UI E2E
test expansion. Postponed to a downstream phase: the scope of "what
to E2E" needs design-partner-team triage (which encounter flows we
care about) before adding tests. Not blocking the GA cut.
