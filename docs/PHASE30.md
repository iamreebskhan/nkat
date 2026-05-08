# Phase 30 — JWT Alg Cross-Check, Per-Tenant Rate Limiting

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **53 suites / 548 tests / 0 failures (~35s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 57 unit-test suites / 585 tests, all green.** This phase adds **+1 suite / +10 tests**:
- `rate-limit-pure.spec.ts`: 8 tests (token bucket math + per-key isolation + idle eviction)
- `jwks-client.spec.ts`: +2 tests (alg cross-check happy path + rejection)

The phase closes a security gap (algorithm-confusion attack surface against the JWKS path) and lands the per-tenant rate limiter the lookup + synthesis endpoints need before they take real customer traffic.

## What landed

### `JwksClient.resolveKey` returns `{ key, alg }` instead of bare `KeyObject`

`backend/src/auth/jwks-client.ts`:

- `ResolvedKey` interface exported: `{ key: KeyObject; alg: string | undefined }`.
- The internal `byKid` map now holds `Map<string, ResolvedKey>` so each entry carries the JWK's declared `alg` (`RS256`, `ES256`, etc.) alongside the key.
- Production IdPs (Auth0, Cognito, Okta) always declare `alg` per JWK; the field is `undefined` only when the IdP omits it (rare; we still allow these via the algorithm allow-list above).

### `verifyJwt` cross-checks JWT header alg vs JWK declared alg

`backend/src/auth/jwt-verifier.ts`:

```ts
keyResolver?: (kid: string) => Promise<{ key: KeyObject; alg: string | undefined }>
```

When the resolver returns a non-undefined `alg`, the verifier compares it to the JWT header's `alg` claim. Mismatch → throw `ALG_KEY_MISMATCH`.

**Why this matters**: classic algorithm-confusion attack — an attacker who steals an RSA public key (which IS public!) could craft an HS256 token using that PEM as the shared HMAC secret. Without alg cross-check, the verifier accepts the forged token. Even though our top-of-function `ALG_NOT_ALLOWED` gate blocks `HS256` outright, the cross-check catches the more subtle case of two RS-family algs (`RS256` vs `PS256`) or two EC-family algs.

When the JWK doesn't declare `alg` (best-effort path), the verifier still accepts — the algorithm allow-list at the top of the function (`RS256`, `ES256`) is the floor. The cross-check is an additional layer when the IdP supplies the data.

**+2 new tests** in `jwks-client.spec.ts`:
- `verifyJwt rejects ALG_KEY_MISMATCH when JWK declares different alg than header` — JWK declares `ES256`, JWT header says `RS256`, signature actually verifies (synthetic but realistic) → 401 `ALG_KEY_MISMATCH`.
- `verifyJwt accepts when JWK omits alg (best-effort)` — JWK has no alg field, RS256 token verifies normally.

### Per-tenant rate limiting

#### `rate-limit-pure.ts` — pure token bucket

`backend/src/common/rate-limit/rate-limit-pure.ts`:

```ts
tryConsume(state, nowMs, key, { limit, refillPerSec }) →
  { allowed: true, remaining } | { allowed: false, retryAfterMs, remaining: 0 }
```

Token-bucket semantics:
- Bucket starts full (`limit` tokens).
- On every check, refill linearly: `tokens = min(limit, tokens + elapsedSec * refillPerSec)`.
- If `tokens ≥ 1`, consume + allow.
- Else: reject with `retryAfterMs = ceil((1 - tokens) / refillPerSec * 1000)`.

Plus `evictIdle(state, nowMs, maxIdleMs)` to drop stale buckets — bounded memory growth in long-running processes.

**8 unit tests**: limit-exhaustion + reject, linear refill, cap at limit (no token-hoarding past idle), per-key independence, retry-after correctness, `refillPerSec=0` strict-window mode, eviction happy path + no-op.

#### `RateLimitInterceptor` + `@RateLimit({ scope, limit, refillPerSec })`

`backend/src/common/rate-limit/rate-limit.interceptor.ts`:

- Reads `req.auth.orgId`. Without it (anonymous endpoint) → pass-through.
- Bucket key: `${scope}:${orgId}`. Different routes don't share quota.
- On reject: 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` headers (Stripe-style).
- Coarse eviction every 30s — keeps memory bounded without scanning per request.

Globally registered as `APP_INTERCEPTOR` in `AppModule`, opt-in per route via `@RateLimit({...})` decorator. Same pattern as the Phase 22 `@Idempotent()` decorator.

#### Decorated endpoints

| Endpoint | Limit | Refill |
|---|---|---|
| `POST /v1/lookup` | 60 burst | 1/sec (60/min sustained) |
| `POST /v1/synthesis` | 30 burst | 0.5/sec (30/min sustained) |

Synthesis is half the lookup rate — Bedrock cost dominates and the typical workflow runs many lookups per synthesis call. These are starting values; real numbers will tune from prod telemetry.

### `RateLimitModule` + `AppModule` wiring

```ts
{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }
{ provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor }
```

Both global; both opt-in per route via metadata. Order is irrelevant for correctness (interceptors compose), but rate-limit fires before idempotency for slight efficiency — an over-quota request doesn't bother computing the request hash.

## Hard constraints honored (no corner cutting)

- **Algorithm-confusion attack defense**: cross-check is on by default whenever the IdP declares `alg` on the JWK. Production IdPs always declare it; the `undefined`-fallback is for niche/self-hosted setups.
- **`ALG_KEY_MISMATCH` is a distinct error code**: structurally separate from `ALG_NOT_ALLOWED` so an auditor reading the logs can tell whether the verifier rejected because the alg wasn't on our allow-list vs because the alg disagreed with the JWK.
- **Rate-limit interceptor is global + opt-in**. No accidental rate limiting of admin or read endpoints; explicit `@RateLimit({...})` on each surface.
- **Bucket scope keyed by `(scope, orgId)`**. A single tenant's lookup quota doesn't share with their synthesis quota.
- **Anonymous endpoints (no auth.orgId) pass through**. Rate limiting anonymous traffic is a WAF concern, not an app-layer concern.
- **`Retry-After` header in seconds (ceiling)** — what RFC 6585 + Stripe's API send. Customers' SDKs already know how to back off on this.
- **Coarse eviction every 30s** — no per-request scan, keeps memory bounded without making the hot path slower.
- **`refillPerSec = 0` is supported** for strict-window mode (e.g., signup endpoint at 1 burst per 24h with no recovery). Tested explicitly.
- **Token-bucket math is unit-tested with deterministic clocks** — no `Date.now()` calls in the pure helper.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed. Existing 11 JwksClient tests survived the `Map<kid, KeyObject>` → `Map<kid, ResolvedKey>` refactor because the test helpers (`fakeFetch`, `jwkOf`) ship the `alg` field; the public `resolveKey` return shape change required no test edits.)

## What's deliberately NOT in Phase 30

- **Redis-backed rate limiter.** Today's in-process Map is per-task. With `desired_count > 1` ECS tasks, a tenant's effective quota is `tasks × limit`. That's intentional headroom for now (~3× at our typical config); migrating to Redis is a Phase 31 candidate when tenant volume justifies it.
- **Per-route configurable limits via env**. Today the limits are decorator-baked; changing them requires a deploy. Tunable-via-env is a Phase 31 surface.
- **JWKS pre-warm at AppModule boot.** Phase 29 deferred this; same reasoning here.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 30

| Metric | P27 | P28 | P29 | **P30** |
|---|---|---|---|---|
| SQL migrations | 21 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 50 | 51 | 52 | **53 (+1)** |
| Backend tests (unit) | 512 | 526 | 538 | **548 (+10)** |
| Integration test suites | 6 | 6 | 6 | **6** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 549 | 563 | 575 | **585** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `@Idempotent()` routes | 5 | 5 | 5 | **5** |
| `@RateLimit()` routes | 0 | 0 | 0 | **2 (lookup + synthesis)** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 6 | 7 | 7 | **7** |
| Runbooks | 11 | 11 | 11 | **11** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 53 / 548
npx ts-node scripts/export-openapi.ts             # 45 paths

# Trigger rate limit against stage:
for ($i = 0; $i -lt 70; $i++) {
  curl -X POST https://stage/v1/lookup -H "x-org-id: ..." -d '{...}'
}
# Last few calls return 429 with Retry-After header.
```

Phase 31 (Redis rate limiter + first dress rehearsal pass + first prod cutover) on `continue`.
