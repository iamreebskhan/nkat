# Phase 33 — Redis TLS Support, /readyz Redis Ping, Pingable Health Controller

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **57 suites / 584 tests / 0 failures (~28s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 61 unit-test suites / 621 tests, all green.** This phase adds **+2 unit suites / +13 unit tests**:
- `redis-mini-client-dial.spec.ts`: 4 tests for the dial-injection / TLS-prep path
- `health.controller.spec.ts`: 9 tests for liveness, readiness happy paths (no store / in-memory / Redis-wired), DB+Redis failure paths, plus the exported `realRedisPing` semantics

The phase finishes Phase 32's Redis story with the bits production needs to actually deploy: TLS support (AWS ElastiCache `transit_encryption_enabled` requires it) + a `/readyz` probe that surfaces Redis health alongside DB health.

## What landed

### `RedisMiniClient` — TLS via `dial` option

`backend/src/common/redis/redis-mini-client.ts`. Three options on the constructor:

- `tls: true` — use `tls.connect` with default options (verify cert, SNI = host).
- `tls: TlsOptions` — caller-supplied (CA bundle, ALPN, `rejectUnauthorized`, etc.).
- `dial: (host, port) => Duplex` — override the underlying socket. Tests use this; production typically doesn't.

Runtime model:
- The `socket` field is now typed as `Duplex` (not `Socket`) since `tls.TLSSocket` and a unit-test PassThrough both satisfy it.
- The connect handshake waits on `'secureConnect'` instead of `'connect'` when `tls` is set (TLS handshake is what "connect" means at the protocol level).
- `setNoDelay` is best-effort guarded (Duplex doesn't always have it).
- Boot log distinguishes `redis://` vs `rediss://` so operators see the choice.

Defaults to plain TCP — no behavior change for the existing in-memory path or for the non-TLS Redis test container in CI.

### `dial` injection for unit testability

The `dial` option lets tests substitute a `Duplex` stream (no real socket needed). 4 new unit tests in `redis-mini-client-dial.spec.ts`:

1. **Uses the supplied dial function instead of `net.connect`** — verifies the host/port pair is passed + the bytes the client writes are the documented EVAL frame.
2. **AUTH runs immediately after connect** when password is supplied — bytes-on-the-wire assertion.
3. **Rejects in-flight calls when the socket closes** mid-flight — the in-flight queue is drained with a clear error.
4. **Per-command timeout fires when reply never arrives** — 50ms timeout, ensures the rejection path isn't gated on socket close.

These tests exercise the wire-protocol behavior end-to-end without requiring a Redis instance. Combined with the Phase 32 RESP encoder/parser tests + the integration test (which talks to a real Redis), the mini-client now has full coverage at three layers (wire format, dial behavior, real-server end-to-end).

### `HealthController` — extended `/readyz` with Redis ping

`backend/src/health/health.controller.ts`:

`GET /readyz` now returns:

```json
{
  "status": "ok",
  "db_latency_ms": 12,
  "redis_latency_ms": 3,         // present only when Redis is wired
  "redis": "ok"                   // or "not_configured"
}
```

Behavior:
- DB ping always runs (`SELECT 1`). On failure → 503 with `component: "database"`.
- When `RATE_LIMIT_STORE_TOKEN` resolves to a `RedisRateLimitStore` instance, also runs a Redis probe via a low-cost `consume` against an isolated `health` key (limit=1M, refillPerSec=0). On failure → 503 with `component: "redis"`.
- When the store is the `InMemoryRateLimitStore` (or unwired), the probe is skipped — `redis: "not_configured"`. There's nothing to probe and silent-success would mislead the operator.

The 503 body always carries a structured `component` field so the on-call sees which dependency tripped without grepping logs.

### `realDbPing` / `realRedisPing` exported

```ts
export const realDbPing: DbPing = async (db) => sql`SELECT 1`.execute(db);
export const realRedisPing: RedisPing = async (store) => {
  const r = await store.consume({ key: 'health', limit: 1_000_000, refillPerSec: 0 });
  if (!r.allowed) throw new Error('rate-limit health probe unexpectedly rejected');
};
```

The controller exposes `dbPing` and `redisPing` as instance fields (defaulted to the real implementations). Unit tests assign them directly:

```ts
const c = new HealthController(fakeDb, store);
c.dbPing = async () => undefined;
c.redisPing = async () => { throw new Error('redis down'); };
```

This sidesteps Kysely-internal mocking + keeps the unit tests fast (no fake DB pool wiring). Real-DB coverage stays in the integration suite.

### Why fields, not constructor params

A first attempt put `dbPing` and `redisPing` as defaulted constructor params:

```ts
constructor(@Inject(DB_TOKEN) db, ..., dbPing: DbPing = realDbPing, redisPing: RedisPing = realRedisPing) {}
```

Nest's DI tried to resolve them by reflection metadata + saw `Function`-typed parameters with no provider → silent crash on `NestFactory.create`. The same Phase 12 trap from earlier in the project. Refactored to instance fields with defaults so Nest's DI never sees them; tests assign via the property bag.

### `RateLimitModule.forRoot` accepts TLS path implicitly

The module factory takes a `redis: RedisLike` opaque object — production wiring constructs a `RedisMiniClient` with `tls: true` and passes it in. No new module surface; the TLS plumbing is contained within the client construction call site.

## Hard constraints honored (no corner cutting)

- **Default TLS verifies the cert.** `rejectUnauthorized` is on by default; caller can disable via `TlsOptions` for self-signed dev environments only.
- **SNI auto-set to `host`** — works correctly with shared-host Redis services.
- **`secureConnect` event** is what we await on TLS, not the plain `connect` event. TLS handshake completion is the actual readiness signal.
- **Graceful degradation in `/readyz`**: when Redis isn't wired, the probe is omitted, not faked. A `redis: "not_configured"` is honest; `redis: "ok"` would mislead.
- **Structured `component` field on 503** — operators see which dependency tripped at a glance, no log diving.
- **Health probe uses an isolated key** (`health`) with a 1M ceiling so it can't interfere with real tenant quotas.
- **Nest DI silent-crash trap avoided** by using instance fields for the testable ping functions instead of defaulted constructor params. Same lesson as Phase 12; we recognized + applied the pattern early this time.
- **Three-layer coverage of the Redis client**: wire format (Phase 32 unit tests), dial behavior (Phase 33 unit tests), real-server integration (Phase 32 integration test against the CI service container). Each layer catches a different class of regression.

## Bug caught + fixed during this session

1. **Nest DI silent crash** — `NestFactory.create` failed with EXIT=1 + no output (the Phase 12 pattern) because `dbPing: DbPing = realDbPing` constructor params with TypeScript-only function types confused the reflection-based DI. Refactored to instance fields with defaults; OpenAPI export back to clean.
2. **Initial Kysely-mock attempt** for the readiness DB-ping path failed because the fake `Pool` didn't satisfy enough of Kysely's internal contract. Rather than continue building a deeper mock, refactored to inject `dbPing` / `redisPing` as overridable functions — cleaner test boundary, integration suite covers the real Kysely path.

## What's deliberately NOT in Phase 33

- **AUTH against ElastiCache token-based auth.** ElastiCache's auth-token works the same as `AUTH password`; production wiring just plumbs it through `RedisMiniClientOptions.password`. No code change needed in Phase 33.
- **Cluster mode.** Single primary-with-replicas is fine at our scale; Cluster routing requires `MOVED`/`ASK` handling which we don't need yet.
- **CA bundle for AWS ElastiCache TLS.** ElastiCache uses certs signed by AWS's public CA; Node's bundled CA store accepts them by default. No CA config needed for the typical AWS deploy.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 33

| Metric | P30 | P31 | P32 | **P33** |
|---|---|---|---|---|
| SQL migrations | 21 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 53 | 54 | 55 | **57 (+2)** |
| Backend tests (unit) | 548 | 555 | 571 | **584 (+13)** |
| Integration test suites | 6 | 6 | 7 | **7** |
| Integration test cases | 44 | 44 | 51 | **51** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 585 | 592 | 608 | **621** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 7 | 7 | 7 | **7** |
| Service containers in CI | 1 | 1 | 2 | **2** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 57 / 584
npx ts-node scripts/export-openapi.ts             # 45 paths

# Production wiring with ElastiCache TLS:
# const redis = new RedisMiniClient({
#   host: 'master.br-prod.xxx.use1.cache.amazonaws.com',
#   port: 6379,
#   password: process.env.REDIS_AUTH_TOKEN,
#   tls: true,                            // verify cert against system CA
#   commandTimeoutMs: 2000,
# });
# RateLimitModule.forRoot({ redis, redisKeyPrefix: 'br-prod:rl:' })

# /readyz with Redis wired:
curl https://stage/readyz
# {"status":"ok","db_latency_ms":12,"redis_latency_ms":3,"redis":"ok"}
```

Phase 34 (first dress rehearsal pass + first prod cutover + first paying tenant) on `continue`.
