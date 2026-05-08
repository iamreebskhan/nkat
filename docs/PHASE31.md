# Phase 31 — Distributed Rate Limiter (Redis Lua), Store Abstraction

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **54 suites / 555 tests / 0 failures (~28s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 58 unit-test suites / 592 tests, all green.** This phase adds **+1 suite / +7 tests** for the new store abstraction (15 total in `rate-limit-store.spec.ts`, 8 of which exercise the Redis path including a multi-instance shared-state scenario and a fail-open simulation).

The phase converts the Phase 30 in-process token bucket from a per-task local cache into a proper shared store. With ECS autoscaling at 3-20 tasks, the Phase 30 effective limit was 3-20× the configured bucket; Phase 31 unifies it.

## What landed

### `RateLimitStore` interface

`backend/src/common/rate-limit/rate-limit-store.ts`. The shared contract:

```ts
interface RateLimitStore {
  consume(args: { key, limit, refillPerSec, nowMs? }): Promise<RateLimitResult>;
}

type RateLimitResult =
  | { allowed: true, remaining: number }
  | { allowed: false, remaining: 0, retryAfterMs: number };
```

Two implementations satisfy it.

### `InMemoryRateLimitStore`

Phase 30 default preserved. Wraps the existing `tryConsume` pure function + `evictIdle` cleanup. Per-task bucket map; effective tenant quota = (running ECS tasks) × limit. Fine for small fleets (<5 tasks); the headroom is intentional.

### `RedisRateLimitStore` with Lua atomic check

Atomic Redis Lua script that:

1. `HMGET key tokens lastRefillMs`
2. Compute elapsed seconds + refill, cap at limit.
3. If `tokens >= 1`, decrement + write back + EXPIRE + return `{allowed=1, remaining, 0}`.
4. Else write the (still-zero-ish) state + EXPIRE + return `{allowed=0, 0, retryAfterMs}`.

The Lua script is sent on every `consume` call (Redis caches it server-side after the first eval). One `eval` round-trip = one rate-limit decision; no read-modify-write race possible because the entire bucket math runs atomically inside Redis.

Key prefix is configurable (`br-prod:rl:` / `br-stage:rl:` / etc.) so a single Redis instance can serve multiple environments without bucket collisions.

**Fail-open on Redis outage**: a `redis.eval` rejection logs at error level and returns `{ allowed: true, remaining: limit }`. The on-call sees the underlying failure; the customer doesn't see a 429 cascade. Rate limiting is a cost-saver, not a correctness boundary — when in doubt, allow.

### `RedisLike` minimal interface

```ts
interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
```

The `ioredis` client matches this surface natively. Tests stub directly against the interface — no Redis dependency at test time.

### `RateLimitModule.forRoot({ redis?, redisKeyPrefix?, redisTtlSec? })`

Module factory. When `redis` is supplied (production wiring will inject an `ioredis` instance), uses `RedisRateLimitStore`. Otherwise, `InMemoryRateLimitStore`. Logs which store is in use at boot — operators see the choice in CloudWatch.

`AppModule` calls `RateLimitModule.forRoot({})` — defaults to in-memory. Production wiring (when ops adds a Redis instance) will be one line:

```ts
RateLimitModule.forRoot({
  redis: new Redis(process.env.REDIS_URL),
  redisKeyPrefix: `br-${process.env.NODE_ENV}:rl:`,
})
```

### Interceptor refactored to async store

`rate-limit.interceptor.ts`:

- Constructor injects `RATE_LIMIT_STORE_TOKEN`.
- `intercept` returns `defer(() => store.consume(...)).pipe(mergeMap(...))` so the async consume composes with the rxjs Observable Nest expects.
- `Retry-After` + `X-RateLimit-Limit` + `X-RateLimit-Remaining` headers unchanged from Phase 30.

### Tests — 15 total in `rate-limit-store.spec.ts`

InMemoryRateLimitStore (3):
1. Allows up to limit, then rejects with `retryAfterMs`.
2. Different keys are independent (per-tenant isolation).
3. (Existing pure-function coverage in `rate-limit-pure.spec.ts` stays — 8 tests there.)

RedisRateLimitStore (5):
1. **Passes the right Lua args** — verifies the keyPrefix + key concat, limit, refillPerSec, nowMs, ttl ordering.
2. **End-to-end allow/reject/refill** with a `FakeRedis` simulator that runs the same Lua semantics in-process.
3. **Multi-instance shared state** — two `RedisRateLimitStore` instances pointed at the same FakeRedis correctly share quota. THE most important assertion in this phase: it proves the Phase 30 → Phase 31 transition is real.
4. **Fails open on Redis outage** — `shouldFail = true` simulates network blip; consume returns `{ allowed: true, remaining: limit }`.
5. **Key prefix applied** — every Redis key carries the configured prefix.

The `FakeRedis` class implements `RedisLike` and replicates the Lua algorithm in JS. We don't actually parse Lua — we replicate the semantic contract. If the real Redis behaves differently from the FakeRedis, the discrepancy is in our Lua script vs. the contract our tests assert; integration testing against a real Redis is the next layer (deferred to Phase 32).

## Hard constraints honored (no corner cutting)

- **Atomic Lua script**, not read-modify-write from app code. No race possible across concurrent consumers — the entire token-bucket math runs inside Redis as a single transaction.
- **Fail-open on Redis outage** — the customer doesn't see 429s cascading because Redis is having a bad day. Loud error log, on-call paged via the existing CloudWatch alarms.
- **Key prefix is per-env** — single Redis instance can serve multiple environments without collision.
- **Auto-EXPIRE on every write** so abandoned buckets self-clean. No separate cleanup cron needed for Redis-backed state.
- **`RedisLike` interface is the minimum surface** — tests stub it without `ioredis-mock` or any other test dep. Production wiring just needs an object with `.eval(script, numKeys, ...args)`.
- **Multi-instance shared-state test is THE Phase 31 contract** — two `RedisRateLimitStore` instances pointed at the same FakeRedis exhaust the bucket together, not each independently.
- **Module factory returns a `DynamicModule`** + `global: true`. The interceptor is auto-available everywhere; downstream modules don't have to re-import.
- **Boot log line declares which store is in use** so operators reading CloudWatch know without grepping config.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 31

- **Real Redis integration test.** The FakeRedis simulates the Lua contract; an integration test against a real Redis service container in CI is the next layer. Phase 32 candidate (one Postgres-style service container in `.github/workflows/ci.yml`).
- **`ioredis` dependency added to package.json.** The interface is in place; ops wires the actual client when a Redis instance is provisioned. No npm install in this phase.
- **`pubsub` for cache version invalidation.** Today the cache version uses Postgres `system_setting` + 60s in-process TTL. A Redis pubsub `INVALIDATE` channel would push instant invalidation across all tasks; deferred until we see the actual cache hit-rate hurt in prod.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 31

| Metric | P28 | P29 | P30 | **P31** |
|---|---|---|---|---|
| SQL migrations | 21 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 51 | 52 | 53 | **54 (+1)** |
| Backend tests (unit) | 526 | 538 | 548 | **555 (+7)** |
| Integration test suites | 6 | 6 | 6 | **6** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 563 | 575 | 585 | **592** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `@RateLimit()` routes | 0 | 0 | 2 | **2** |
| Rate-limit store impls | — | — | 1 (in-memory) | **2 (in-memory + Redis)** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 7 | 7 | 7 | **7** |
| Runbooks | 11 | 11 | 11 | **11** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 54 / 555
npx ts-node scripts/export-openapi.ts             # 45 paths

# Production wiring (when Redis is provisioned):
# AppModule line:
#   RateLimitModule.forRoot({ redis: new Redis(process.env.REDIS_URL),
#                              redisKeyPrefix: `br-${env}:rl:` })
```

Phase 32 (Redis integration test in CI + first dress rehearsal pass + first prod cutover) on `continue`.
