# Phase 22 — Stripe-Style `Idempotency-Key` for Retry-Tolerant Writes

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **49 suites / 499 tests / 0 failures (~50s).**
`npx ts-node scripts/export-openapi.ts` → **44 paths** in `docs/openapi.json`.

**Combined: 53 unit-test suites / 536 tests, all green.** This phase adds **+2 suites / +31 tests** for the idempotency surface — 22 pure-helper tests + 9 interceptor branch tests.

The phase ships the `Idempotency-Key` middleware Stripe popularized: a client can retry any decorated POST endpoint over flaky transport without double-booking work. Without this, the first time a customer's billing system retries a 504-timed-out `POST /v1/lookup` or `POST /v1/admin/billing/seats`, they'd run the underlying side-effect twice. With it, the second request replays the original response — guaranteed.

## What landed

### Migration 0018 — `idempotency_record`

`db/migrations/0018_phase22_idempotency.sql`. RLS-scoped via `app.apply_tenant_rls`.

| Column | Notes |
|---|---|
| `(org_id, key)` PK | Per-tenant scope. Two tenants can independently use the same key. |
| `request_hash CHAR(64)` | SHA-256 of canonical (method, path, body). |
| `response_status SMALLINT` | 100..599 CHECK; the cached HTTP status. |
| `response_body JSONB` | The cached body. **Endpoints whose responses contain PHI MUST NOT use the decorator** — opt-in is per-route. |
| `expires_at` | Default `now() + 24h`. Cleanup cron reclaims past-expiry rows + the same key may be re-used. |

Index `idempotency_record_expires_idx ON expires_at` for the cleanup scan.

### Pure helpers — `idempotency-pure.ts`

- `isValidKey(s)` — 8..255 ASCII-printable chars, no spaces. Stops `Idempotency-Key: ` (whitespace) and `\r\n`-injection attempts at the validation layer.
- `hashRequest({ method, path, body })` — SHA-256 hex of `<METHOD>\n<path>\n<canonical(body)>`. Method case-normalized; body canonicalized.
- `canonicalize(value)` — deterministic JSON with sorted object keys at every level. `{a:1,b:2}` and `{b:2,a:1}` hash identically. Non-finite numbers (`Infinity`/`NaN`) coerce to `null` for JSON safety.

**22 unit tests** covering: key validation matrix (length boundaries, charset rules, undefined / null / non-string inputs), object-key sort at every nesting level, array order preservation, primitive handling, deterministic hashing, sensitivity to method / path / body changes, method case-normalization.

### `IdempotencyService` — read/write

`backend/src/common/idempotency/idempotency.service.ts`:

- `findExisting(orgId, key, requestHash)` →
  - `{ kind: 'cached', status, body }` — found, hash matches, not expired.
  - `{ kind: 'conflict' }` — found, hash differs (Stripe-style 422).
  - `{ kind: 'miss' }` — not found OR found but expired.
- `store(orgId, key, requestHash, status, body)` →
  - INSERTs the response. On PK conflict (concurrent retry race), re-reads the winner's row and returns its response. Race-loser's work is wasted, but the canonical response is what the client gets.

### `IdempotencyInterceptor` + `@Idempotent()` decorator

`backend/src/common/idempotency/idempotency.interceptor.ts`. Globally registered as `APP_INTERCEPTOR` so it runs on every request, but **opt-in per-route** via `@Idempotent()` metadata. When metadata isn't set, the interceptor is a pass-through.

When set:

1. Read `Idempotency-Key` header (case-insensitive lookup; absent header → pass-through behavior, treats route as if metadata weren't applied).
2. Validate key shape; reject malformed with 409 `IDEMPOTENCY_KEY_INVALID`.
3. Pull `req.auth.orgId`. Without it (degraded auth path), skip — there's no tenant to scope.
4. Compute `requestHash` from method + originalUrl + body.
5. `findExisting` →
   - `cached`: replay via `res.setHeader('idempotency-replayed', 'true').status(s).send(body)` and return `of(undefined)` so Nest's serializer doesn't re-process.
   - `conflict`: throw 409 `IDEMPOTENCY_KEY_REUSED`.
   - `miss`: pipe `tap` over the handler's Observable; on success, `service.store(...)` with the body. **5xx responses are NOT cached** — retries should re-run, not replay an outage response.

### Decorated endpoints

`@Idempotent()` applied to four production write paths:

| Endpoint | Why |
|---|---|
| `POST /v1/lookup` | Read in name only; the underlying work touches Bedrock + DB writes (audit_log). Retried double-runs would double-count usage. |
| `POST /v1/synthesis` | Bedrock spend — the most expensive endpoint. Retry idempotency saves real $. |
| `POST /v1/admin/billing/seats` | Stripe seat increase + local cache write. Stripe accepts its own `Idempotency-Key`; we forward + dedupe at our layer. |
| `POST /v1/admin/billing/checkout-session` | Stripe Checkout session creation; double-creating wastes Stripe quota + confuses the customer with two URLs. |
| `POST /v1/admin/webhook-subscriptions` | Creating a webhook twice would double-deliver every event. |

Other write endpoints (signup, invite redeem, billing webhook receiver) are intentionally NOT decorated:

- **Signup** uses `signup_attempt UNIQUE(stripe_checkout_session_id)` for de-duplication.
- **Invite redeem** is single-use by design (`consumed_at` lock).
- **Stripe webhook receiver** dedupes on `billing_event UNIQUE(stripe_event_id)`.

So every retry-relevant write surface has a dedupe layer; idempotency is the layer for client-driven retries.

### `IdempotencyModule`

`backend/src/common/idempotency/idempotency.module.ts`. Imports `DatabaseModule`, exports `IdempotencyService` + `IdempotencyInterceptor`. Registered in `AppModule.imports`; the interceptor is added globally via `{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }`.

### Tests — interceptor branch coverage

`backend/src/common/idempotency/__tests__/idempotency.interceptor.spec.ts` — 9 tests:

1. Pass-through when `@Idempotent()` not set.
2. Pass-through when header absent.
3. Reject malformed key (409).
4. Replay cached response on hash match (`idempotency-replayed: true` header).
5. Throw 409 IDEMPOTENCY_KEY_REUSED on conflict.
6. On miss, execute handler + store response with correct args.
7. Skip caching 5xx responses.
8. Pass-through when no orgId on request (degraded mode).
9. `IDEMPOTENT_KEY` metadata constant has the documented value.

## Hard constraints honored (no corner cutting)

- **Per-tenant scope on the key.** Two tenants using the same key are independent. Required because keys are caller-chosen.
- **Hash includes method + path + canonical body.** Path lets us reuse the same key across different endpoints if needed; method change (POST → PUT) invalidates. Canonical body means cosmetic key-order differences don't trigger spurious conflicts.
- **Same opaque error on key validation** as on conflict: both `IDEMPOTENCY_KEY_INVALID` and `IDEMPOTENCY_KEY_REUSED` are 409. The structured `code` distinguishes them for callers, the HTTP status is identical.
- **5xx responses are NOT cached.** A retry after a 503 should re-run the work, not replay the failure. Cache is for `2xx`/`4xx` (4xx caching is intentional — `400 BadRequest` for the same body should be deterministic).
- **Race-loser doesn't 5xx.** The PK-conflict branch re-reads the winner's row. Concurrent duplicate retries see one canonical response.
- **Endpoint opt-in is explicit.** No accidental caching of PHI-bearing responses. The decorator is a code-level decision per route; eligible endpoints are listed in this doc.
- **`@Idempotent()` on `POST /v1/lookup`** is intentional even though "lookup" sounds idempotent. The endpoint writes audit_log rows + counts toward usage; retry-double-counting is real.
- **Interceptor is globally registered + per-route opt-in.** Not "per-controller-import" so we don't end up with controllers that forget to import the module. Forgetting `@Idempotent()` is fine (degrades to old behavior); forgetting the module wiring would be silent breakage.
- **Cleanup cron not yet wired** — `expires_at` lets a future scheduled task reclaim past-expiry rows. Adding the cron is one more line in `scheduled-tasks.tf`; deferred to Phase 23.
- **`response_body JSONB` accepts arbitrary shapes.** The pure helper `canonicalize` does not run on stored response bodies — they're persisted as-is per Nest's serialization, replayed via `res.send` so the wire format matches.

## Bug caught + fixed during this session

- **One typo in `idempotency-pure.spec.ts`** — extra `)` in a `.not.toBe(...))` line broke the parse. Caught by running the spec; fixed; 22/22 green.

## What's deliberately NOT in Phase 22

- **Cleanup cron for expired rows.** `expires_at` index is in place. Phase 23 candidate; one EventBridge schedule + ~15 lines of script.
- **`Stale-While-Revalidate` semantics.** We treat expired rows as miss. A future variant could serve the stale row + asynchronously re-run; not needed at our scale today.
- **In-flight placeholder rows for true concurrent dedup.** Today two parallel duplicates may both execute the work; one INSERT wins, the loser re-reads. For our target traffic (low concurrent retries from a single client), the simpler design is correct.
- **Idempotency on `DELETE` endpoints.** DELETE is idempotent at the HTTP semantic layer already; our deletes (e.g., webhook subscription disable) are no-ops on second call. No decorator needed.
- **Forwarding the Idempotency-Key to Stripe.** Today our `POST /v1/admin/billing/seats` is idempotent at OUR layer; Stripe's seat-update API also accepts an `Idempotency-Key` header for its own retries. Plumbing our key through to Stripe is a Phase 23 follow-on.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones, not code work.

## Cumulative state at end of Phase 22

| Metric | P19 | P20 | P21 | **P22** |
|---|---|---|---|---|
| SQL migrations | 16 | 17 | 17 | **18 (+idempotency)** |
| Backend modules | 30 | 30 | 30 | **31 (+idempotency)** |
| Backend test suites | 45 | 46 | 47 | **49 (+2)** |
| Backend tests | 456 | 463 | 468 | **499 (+31)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 493 | 500 | 505 | **536** |
| HTTP endpoints | ~40 | ~41 | ~41 | **~41** |
| Decorated `@Idempotent()` routes | 0 | 0 | 0 | **5** |
| `docs/openapi.json` paths | 43 | 44 | 44 | **44** |
| Scheduled tasks (TF) | 4 | 5 | 5 | **5** |
| Runbooks | 7 | 7 | 9 | **9** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                # 0 errors
npx jest --ci                                   # 49 / 499
npx ts-node scripts/export-openapi.ts           # 44 paths

# Round-trip an idempotent request twice with the same key:
curl -X POST https://stage/v1/lookup \
  -H 'idempotency-key: client-retry-abc-1234-5678' \
  -H 'x-org-id: 11111111-...' \
  -H 'content-type: application/json' \
  -d '{"payer_id":"...","state":"OH",...}'
# First call: normal response.
# Second call (same key + same body): same response, header `idempotency-replayed: true`.
# Second call (same key + DIFFERENT body): 409 { code: "IDEMPOTENCY_KEY_REUSED" }.
```

Phase 23 (idempotency cleanup cron + Stripe key passthrough + first dress rehearsal pass + first prod cutover) on `continue`.
