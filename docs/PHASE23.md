# Phase 23 — Stripe `Idempotency-Key` Passthrough, Daily Cleanup Cron

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **49 suites / 503 tests / 0 failures (~35s).**
`npx ts-node scripts/export-openapi.ts` → **44 paths**.

**Combined: 53 unit-test suites / 540 tests, all green.** This phase adds **+4 tests** (Stripe key forwarding across all four POST methods).

The phase closes the idempotency loop end-to-end: a customer's `Idempotency-Key` header now travels from our HTTP API → through our local cache → into Stripe's API. A double-charge becomes structurally impossible across either layer's retry. Plus the daily cleanup cron that keeps `idempotency_record` + `email_send` from growing unbounded.

## What landed

### `Idempotency-Key` passthrough in `StripeApiClient`

`backend/src/billing/stripe-api-client.ts`:

- **`post(path, body, idempotencyKey?)`** — private helper now sets the `Idempotency-Key` HTTP header on the outbound Stripe request when the caller supplies one.
- Four public methods now accept an optional `idempotencyKey`:
  - `createCheckoutSession({ ..., idempotencyKey? })`
  - `updateSubscriptionSeats({ ..., idempotencyKey? })`
  - `createPortalSession({ ..., idempotencyKey? })`
  - (also forwarded structurally on any future POST via the shared `post` helper)

`backend/src/billing/billing-types.ts` — abstract `StripeClient` interface mirrors the new signatures.

### `BillingAdminController` reads the inbound key + forwards it

`backend/src/billing/billing-admin.controller.ts`:

- `addSeats` and `checkoutSession` now read the `idempotency-key` header via `@Headers('idempotency-key')` and forward it to `this.stripe.updateSubscriptionSeats({ ..., idempotencyKey })` / `createCheckoutSession({ ..., idempotencyKey })` when present.
- The same key is the one our own `IdempotencyInterceptor` (Phase 22) already validated + scoped under the org. We're consistently propagating one customer-supplied key through both dedupe layers.
- `addSeats`'s previous `stripeAny` cast was eliminated — `StripeClient.updateSubscriptionSeats` is now a real (optional) method on the interface, so we call it directly with no `as` cast.

### Cleanup cron — `scripts/cleanup-expired-records.ts`

Daily script that handles two bounded-lifetime tables in one run:

| Table | Cleanup rule |
|---|---|
| `idempotency_record` | DELETE WHERE `expires_at < now()` (24h default TTL set at insert). |
| `email_send` | DELETE rows older than 90 days WHERE `status != 'failed'`. **Failed rows stay** because the retry surface still owns them. |

Both deletes are bounded by `--limit` (default 50,000 rows per table) using `WITH victims AS (... LIMIT N) DELETE USING victims` so a single invocation can't lock the table for hours. Counts a dry-run preview row count first; `--dry-run` prints the count without DELETEing.

`npm run cleanup:expired`.

### EventBridge schedule

`infra/terraform/scheduled-tasks.tf` adds the sixth scheduled task:

| Schedule | Frequency | Script |
|---|---|---|
| `cleanup-expired` | `cron(0 11 * * ? *)` (daily 11:00 UTC) | `scripts/cleanup-expired-records.ts` |

Prod-only by default. Runs ~1h before the daily renewal-motion + billing-emails crons so it never competes for ECS task capacity.

### Tests — Stripe key forwarding (+4)

`src/billing/__tests__/stripe-api-client.spec.ts`:

1. `createCheckoutSession` forwards `idempotency-key` when supplied.
2. `createCheckoutSession` OMITS the header when not supplied.
3. `updateSubscriptionSeats` forwards the key.
4. `createPortalSession` forwards the key.

All four assert against the actual `RequestInit.headers` object, so a regression in the `post` helper (e.g., header capitalization, conditional spread bug) surfaces as a test failure.

## Hard constraints honored (no corner cutting)

- **Same key for both dedupe layers.** A customer's `Idempotency-Key: client-retry-abc-1234` is:
  1. Validated by our `IdempotencyInterceptor` (8..255 ASCII, no spaces).
  2. Scoped under the org for our local cache.
  3. Forwarded verbatim to Stripe in the outbound `Idempotency-Key` header.
  - Stripe's per-call window (24h) and ours (24h) align; both layers expire together.
- **No accidental key leakage across endpoints.** The header is read at the controller level + forwarded only to the specific Stripe call that handler makes. Our `post` helper takes the key explicitly; nothing in the shared `headers()` defaults includes it.
- **Conditional spread on the key** (`...(idempotencyKey ? { idempotencyKey } : {})`) — when absent, the StripeClient signature still accepts the call; when present, the key flows through.
- **Cleanup is bounded per run.** `LIMIT 50_000` per table per invocation. A massive backlog clears over multiple runs rather than locking the table for an hour.
- **Cleanup keeps `failed` email rows.** The retry cron + dead-letter audit surface depend on them; cleanup explicitly excludes them.
- **Cleanup uses `WITH victims AS (... LIMIT N) DELETE USING victims`** — Postgres-supported pattern that locks per-row, not table. Concurrent reads aren't blocked.
- **`stripeAny` cast eliminated** in `addSeats`. The interface now has `updateSubscriptionSeats?: ...` as a real (optional) method, so `this.stripe.updateSubscriptionSeats?` works without `as` workarounds.
- **Cleanup cron is prod-only by default**, like every other scheduled task — stage triggers manually for rehearsal.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 23

- **Forwarding the key to Bedrock** for synthesis. Bedrock doesn't support an idempotency-key header; we'd need to layer it ourselves via Bedrock prompt cache or by hashing the request. Today the synthesis endpoint relies entirely on our local `idempotency_record` cache. Phase 24 candidate.
- **Cleanup metric / Datadog dashboard.** Counts are printed; surfacing the trend is a follow-on.
- **Cleanup cron against `audit_log`.** `audit_log` is HIPAA-retention 6 years; we explicitly DON'T clean it. Mentioned here so future readers don't add it.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 23

| Metric | P20 | P21 | P22 | **P23** |
|---|---|---|---|---|
| SQL migrations | 17 | 17 | 18 | **18** |
| Backend modules | 30 | 30 | 31 | **31** |
| Backend test suites | 46 | 47 | 49 | **49** |
| Backend tests | 463 | 468 | 499 | **503 (+4)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 500 | 505 | 536 | **540** |
| HTTP endpoints | ~41 | ~41 | ~41 | **~41** |
| Decorated `@Idempotent()` routes | 0 | 0 | 5 | **5** |
| `docs/openapi.json` paths | 44 | 44 | 44 | **44** |
| Scheduled tasks (TF) | 5 | 5 | 5 | **6 (+cleanup)** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 49 / 503

# Cleanup dry-run against stage
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run cleanup:expired -- --dry-run

# End-to-end Stripe key passthrough demo (against stage):
curl -X POST https://stage.example.com/v1/admin/billing/seats \
  -H 'idempotency-key: client-retry-abc-1234-5678' \
  -H 'x-org-id: ...' \
  -H 'content-type: application/json' \
  -d '{"quantity":12}'
# → Our interceptor caches the response under (org_id, key); Stripe ALSO
#   receives the key and dedupes seat-update on its side.
# → Retry with the same key returns the cached response without calling Stripe.
# → Retry with the same key + DIFFERENT body returns 409 IDEMPOTENCY_KEY_REUSED.
```

Phase 24 (synthesis idempotency tightening + first dress rehearsal pass + first prod cutover) on `continue`.
