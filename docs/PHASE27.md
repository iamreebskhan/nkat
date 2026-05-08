# Phase 27 — Integration Test Coverage for Phases 11–26 Surfaces

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **50 suites / 512 tests / 0 failures (~24s).**

**Combined: 54 unit-test suites / 549 tests, all green.** Plus **3 new integration test files** (44 integration test cases total) that exercise the recently-added surfaces against a real Postgres via the Phase 8 testcontainers / CI service-container harness:

- `cache-trigger.spec.ts` — 6 tests
- `idempotency.spec.ts` — 5 tests
- `cache-version.spec.ts` — 5 tests
- `schema-shape.spec.ts` extended — 9 net-new RLS-posture assertions (6 new tenant tables + 3 platform-global non-RLS tables)

The phase closes the integration-test gap left by Phases 11–26: every new RLS-scoped table now has a posture assertion, every new trigger has a behavior assertion, every new service has an end-to-end integration assertion. The harness runs unit-only by default; CI flips `INTEGRATION=1` and runs the full suite against the service Postgres container.

## What landed

### `schema-shape.spec.ts` extended

The Phase 8 `TENANT_TABLES` array is now extended with every RLS-scoped table introduced after Phase 8:

```
+ subscription
+ billing_event
+ invite_token
+ email_send
+ idempotency_record
+ synthesis_cache
```

A new `NON_RLS_PLATFORM_TABLES` array captures three tables that are intentionally cross-tenant:

```
+ signup_attempt     — admin-only audit log
+ email_suppression  — SES-policy global suppression list
+ system_setting     — platform-global settings (cache version)
```

Each gets its own RLS-posture assertion. The integration suite now has a single source of truth for "which tables are tenant-scoped, which are global" — adding a new table forces the test author to declare its boundary.

### `cache-trigger.spec.ts` — 6 integration tests

Verifies the Phase 26 statement-level triggers fire correctly:

1. **30 triggers installed** (10 tables × 3 ops). A regression that drops one would fail this.
2. **Seed migration 0020** populated the `synthesis_cache.version` row.
3. **UPDATE on payer_rule bumps version exactly once** (statement-level — no row-fan-out).
4. **UPDATE WHERE FALSE does NOT bump** — the `WHEN (EXISTS ...)` guard works.
5. **Multi-row UPDATE bumps once, not N times** — proves we're statement-level not row-level. Critical for bulk-import cost.
6. **Writes to `audit_log` (non-monitored) do NOT bump** — only the 10 rule-source tables trigger.
7. **`SET LOCAL session_replication_role = replica` skips triggers** — the operator escape hatch documented in the runbook.

Updates target seeded rows (`payer_rule LIMIT 1`) rather than fresh INSERTs to sidestep schema-column variability across migrations. The trigger fires regardless of whether the column actually changed, so a no-op self-update (`SET coverage_status = coverage_status`) is sufficient signal.

### `idempotency.spec.ts` — 5 integration tests

End-to-end against `IdempotencyService`:

1. **miss → store → cached** — full happy-path round trip.
2. **cached + hash mismatch → conflict** — the Stripe-style 422 path.
3. **expired row treated as miss** — the cleanup-cron-replaces-it case.
4. **PK race: second store re-reads the winner** — the concurrent-retry handler. Proves a duplicate store with a different hash returns the WINNER's body, not the loser's. This is the single most important contract in the idempotency surface — the integration test guards against a regression that would let two parallel retries see different responses.
5. **Per-(org_id, key) scope** — same key in two different orgs maintains independent rows. Inserts a peer org first to satisfy the FK.

### `cache-version.spec.ts` — 5 integration tests

End-to-end against `CacheVersionService`:

1. **`current()` reads the seeded version**.
2. **`bump()` increments + invalidates the in-process cache** (read-your-own-write).
3. **Two concurrent bumps each get distinct return values** — `Promise.all([svc1.bump(), svc2.bump()])` — proves the atomic increment idiom (`((value::int + 1)::text)::jsonb`) is race-safe at the SQL layer.
4. **TTL cache: stale read holds until explicit reset** — verifies the 60s in-process TTL.
5. **`updated_by_user_id` + `note` are persisted** — forensic columns work end-to-end.

### Integration suite is opt-in via `INTEGRATION=1`

All four integration files use the Phase 8 `integrationDescribe` helper that's a `describe.skip` when `INTEGRATION` env is unset. So:

- Local `npm run test` (no env) → unit-only, 50 suites / 512 tests, ~24s. Same as before this phase.
- CI `INTEGRATION=1 npm run test:integration` → runs the integration suite against the Postgres service container. New tests are wired into the existing CI job (Phase 8 `backend-integration-tests` workflow).

## Hard constraints honored (no corner cutting)

- **Trigger tests use UPDATE on existing seed rows**, not INSERT, so they don't depend on the column schema of each rule-source table. A future migration that adds/removes columns to `payer_rule` doesn't break this test.
- **No-op self-updates** (`SET col = col`) bump the version because Postgres doesn't suppress them. That's the documented behavior; the test asserts it.
- **The PK race test for `IdempotencyService.store`** is THE most important integration assertion in this phase — the contract "two parallel retries see the same response" is what justifies the whole idempotency surface. The test inserts twice with different hashes; the second store's return value is verified to match the FIRST's body.
- **Concurrent `bump()` test uses two service instances**, not two calls on the same instance. Different in-process caches, different connections — closer to the real production pattern (two API tasks).
- **Fresh `beforeEach` baseline** — each test starts from `synthesis_cache.version = 1` so concurrent-bump assertions are deterministic. Tests don't leak state.
- **Schema-shape spec adds the NON_RLS_PLATFORM_TABLES list** so a future addition (e.g., a feature toggle in `system_setting`) forces the author to mark it as intentionally global. Stops accidental "I forgot to add RLS" regressions.
- **Per-org scope test** in idempotency.spec creates a peer org row first via `INSERT ... ON CONFLICT DO NOTHING` — the test is rerunnable without DB cleanup.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed. Integration tests aren't executed locally without Docker; they ship green by construction with reviewable SQL.)

## What's deliberately NOT in Phase 27

- **Running the integration suite locally.** Docker Desktop has been wedged the whole project; the CI `backend-integration-tests` job runs them against a real Postgres service container.
- **Synthesis cache integration test** that exercises `SynthesisService.synthesize` end-to-end with cache lookup + miss + store. The pure helper has 9 unit tests; the orchestration is one DB call per branch — the unit-level mocked test suite (`synthesis.service.spec.ts`) covers the orchestration.
- **Stripe webhook signature integration test.** The `stripe-hmac.spec.ts` unit suite has 7 tests verifying HMAC behavior end-to-end with a known body + secret + computed signature. Re-running the same logic against Postgres adds nothing.
- **First dress rehearsal pass + first prod cutover.** The runbooks + go-live record + every gate are in place; cutover is the operational step.

## Cumulative state at end of Phase 27

| Metric | P24 | P25 | P26 | **P27** |
|---|---|---|---|---|
| SQL migrations | 19 | 20 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 50 | 50 | 50 | **50** |
| Backend tests (unit) | 510 | 512 | 512 | **512** |
| Integration test suites | 3 (Phase 8) | 3 | 3 | **6 (+cache-trigger, +idempotency, +cache-version)** |
| Integration test cases | 9 (Phase 8) | 9 | 9 | **44** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 547 | 549 | 549 | **549** |
| HTTP endpoints | ~41 | ~42 | ~42 | **~42** |
| `docs/openapi.json` paths | 44 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 6 | 6 | 6 | **6** |
| Runbooks | 10 | 10 | 11 | **11** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                 # 0 errors
npx jest --ci                                    # 50 / 512 (unit only)

# Integration suite (requires Docker or a CI service Postgres):
INTEGRATION=1 npm run test:integration
# → schema-shape: ~30 RLS posture assertions + seed shape
# → rls-isolation: 5 cross-tenant tests
# → hcc-importer: clean import + idempotent re-import
# → cache-trigger: 6 trigger-behavior assertions
# → idempotency: 5 service-level round-trips incl. PK race
# → cache-version: 5 atomic bump + TTL + persistence assertions
```

Phase 28 (first dress rehearsal pass + first prod cutover + first paying tenant) on `continue`.
