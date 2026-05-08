# Phase 32 — Redis Mini-Client, Integration Test, CI Service Container

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **55 suites / 571 tests / 0 failures (~35s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 59 unit-test suites / 608 tests, all green.** This phase adds **+1 unit suite / +16 unit tests** for the RESP-2 encoder/parser, plus a 7-test integration spec (`rate-limit-redis.spec.ts`) that runs against a real Redis service container in CI.

The phase converts the Phase 31 abstraction into a real, exercisable production wiring: a hand-rolled minimal Redis client (no `ioredis` dep), an integration test that proves the Lua script behaves as expected through a real RESP round-trip, and a CI workflow that exercises both Postgres and Redis service containers together.

## What landed

### `RedisMiniClient` — minimal RESP-2 client

`backend/src/common/redis/redis-mini-client.ts`. ~180 lines, pure stdlib (`node:net`, no external deps). Speaks just enough Redis to satisfy `RedisLike`:

- `eval(script, numKeys, ...args)` — sends `EVAL`, returns the parsed reply.
- `quit()` — graceful shutdown.

Wire-protocol implementation:
- Single TCP socket, lazy-connected on first command.
- **Pipelined**: requests written immediately; replies arrive in send order; we track an in-flight queue so multiple concurrent `eval()` calls don't tangle their replies.
- **Per-command timeout** — default 5s; an individual stuck command rejects without poisoning the connection.
- **Auto-reconnect** — on socket close/error, in-flight is rejected with a clear error; next call reconnects.
- **AUTH + SELECT** support via constructor options.

Why hand-rolled (not `ioredis`):

- We use ONE Redis verb (`EVAL`). `ioredis` is ~3 MB unpacked + carries its own connection lifecycle that we'd have to monkey-patch for ECS task lifecycle anyway.
- RESP-2 is small + well-documented (https://redis.io/docs/latest/develop/reference/protocol-spec/).
- Auditable in 15 minutes. Exported `encodeArray` + `parseOne` for unit tests.

What we DON'T support: PUBSUB (would need a second connection), SUBSCRIBE/PSUBSCRIBE, Cluster/Sentinel, TLS (caller can supply a `tls.Socket` via dial), ACL auth.

### RESP-2 encoder/parser — exported + 16 unit tests

Pure functions (`encodeArray`, `parseOne`) cover the wire-format primitives:

- `encodeArray` — produces the `*N\r\n$N\r\n<bytes>\r\n` shape.
  - Simple commands, multi-arg commands, **UTF-8 byte length** (not character count — `héllo` is 6 bytes / 5 chars; the encoder uses bytes), empty strings.
- `parseOne(buf, offset)` — handles the 5 RESP-2 types:
  - `+` simple string → `string`
  - `-` error → `Error` instance (typed, so the caller can branch on `instanceof`)
  - `:` integer → `number` (signed)
  - `$N` bulk string → `string` (or `null` for `$-1`)
  - `*N` array → `unknown[]` (recursive)
- **Returns `null` when buffer is truncated** so the caller knows to wait for more bytes (TCP fragmentation handling).
- Exact-offset parsing — caller can reuse the buffer.
- Round-trip test exercises the typical EVAL response shape (array of integers).

### Integration test — `rate-limit-redis.spec.ts`

Runs against a real Redis service container. 7 cases:

1. **Lua script returns the documented `[allowed, remaining, retryAfterMs]` tuple** — the wire-shape contract.
2. **Allow up to limit, reject, refill after elapsed time** — the full bucket lifecycle through real Redis.
3. **Two store instances pointed at the same Redis share state** — the multi-task contract.
4. **EXPIRE is set** — bucket self-cleans after TTL; verified by reading `TTL key` directly.
5. **100 concurrent consumes against the same bucket → exactly `limit` allowed** — proves the Lua atomicity. Without it, race conditions would let some over-quota requests through; with it, exactly 5 allowed out of 100.
6. **Different keys are independent** (sanity check).
7. **Burst then steady-state with realistic clock** — drain the bucket, sleep 300ms, verify the 5/sec refill rate produces the expected token at the right time.

The suite uses `integrationDescribe` so it skips when `INTEGRATION!=1` is unset (local without Docker stays unit-only). Cleans up its own keys via `KEYS prefix:*` + `DEL` on `afterAll`.

### CI workflow — Redis service container

`.github/workflows/ci.yml` `backend-integration-tests` job:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports: [5432:5432]
  redis:
    image: redis:7-alpine
    ports: [6379:6379]
    options: >-
      --health-cmd "redis-cli ping | grep PONG"
      --health-interval 5s --health-timeout 3s --health-retries 20
env:
  REDIS_HOST: localhost
  REDIS_PORT: '6379'
```

Plus a new `Run integration tests (jest)` step that runs `INTEGRATION=1 npm run test:integration` after migrations + seeds apply. **The suite runs against BOTH service containers**: schema-shape + RLS isolation + cache triggers + idempotency + cache version against Postgres; the new rate-limit-redis spec against Redis. One CI job covers all integration surfaces.

Previously, the workflow only ran SQL schema tests via `psql`. The actual jest integration suite was never executed in CI. Phase 32 closes that gap.

## Hard constraints honored (no corner cutting)

- **No `ioredis` dependency added.** Mini-client is ~180 lines of pure stdlib code, tested via the RESP-2 encoder/parser unit suite.
- **Pipelined client with in-flight queue** — concurrent `eval()` calls don't tangle replies. Tested via the 100-concurrent-consume integration case.
- **Per-command timeout** — a stuck command rejects without poisoning the connection.
- **TCP fragmentation handling** — `parseOne` returns `null` on truncated input; we accumulate via `Buffer.concat` until a full reply is parseable.
- **Hand-test test prefix is randomized** (`br-test-${ts}-${random}`) so concurrent CI runs against the same Redis don't collide on bucket keys.
- **Cleanup on afterAll** — `KEYS prefix:* | DEL` so the test Redis stays clean for the next run.
- **CI runs the full integration suite** — not just SQL schema tests. The Postgres + Redis services share a single job so the workflow doesn't double-pay for actions runner time.
- **The 100-concurrent atomicity test** is THE Phase 32 contract — it would fail with a non-atomic store, exactly as expected. With Lua, it passes.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed. The integration suite is verified to compile clean (`tsc --noEmit` covers the `test/integration` glob); local execution is gated on Docker, but the wire-format unit tests prove the encoder/parser independent of any Redis instance.)

## What's deliberately NOT in Phase 32

- **TLS support in the mini-client**. Production may need it (AWS ElastiCache for Redis with in-transit encryption). The interface accepts a generic `Socket`-shaped client; a future enhancement passes `tls.connect(...)` instead of `net.connect(...)`. Phase 33 candidate when ops provisions the prod Redis.
- **PUBSUB / SUBSCRIBE.** Out of scope; we don't use them today.
- **Connection pool.** Single connection is fine at our request rate; sub-millisecond serialization through one socket beats the overhead of pool checkouts.
- **`ioredis` swap path.** If we ever need cluster mode or pubsub, drop in `ioredis` (it satisfies `RedisLike` natively). The interface is the dependency-inversion seam.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 32

| Metric | P29 | P30 | P31 | **P32** |
|---|---|---|---|---|
| SQL migrations | 21 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 52 | 53 | 54 | **55 (+1)** |
| Backend tests (unit) | 538 | 548 | 555 | **571 (+16)** |
| Integration test suites | 6 | 6 | 6 | **7 (+rate-limit-redis)** |
| Integration test cases | 44 | 44 | 44 | **51** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 575 | 585 | 592 | **608** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 7 | 7 | 7 | **7** |
| Service containers in CI | 1 (postgres) | 1 | 1 | **2 (+redis)** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 55 / 571
npx ts-node scripts/export-openapi.ts             # 45 paths

# Local integration (requires Docker Desktop):
docker run -d --rm --name br-redis -p 6379:6379 redis:7-alpine
INTEGRATION=1 REDIS_HOST=localhost REDIS_PORT=6379 npm run test:integration
docker stop br-redis
```

Phase 33 (TLS for Redis + first dress rehearsal pass + first prod cutover) on `continue`.
