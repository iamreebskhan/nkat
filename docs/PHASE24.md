# Phase 24 — Synthesis Content Cache, Cleanup Extension, Go-Live Record Template

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **50 suites / 510 tests / 0 failures (~47s).**
`npx ts-node scripts/export-openapi.ts` → **44 paths**.

**Combined: 54 unit-test suites / 547 tests, all green.** This phase adds **+1 suite / +7 tests**.

The phase ships a per-tenant content-addressed cache for synthesis — a real cost lever since Bedrock invocations are ~$0.005–0.05 per call and identical re-renders (same findings, same audience) are common. Plus the go-live record template, the artifact the operator commits at T+0 of the first prod cutover.

## What landed

### Migration 0019 — `synthesis_cache`

`db/migrations/0019_phase24_synthesis_cache.sql`. RLS-scoped per `app.apply_tenant_rls`.

| Column | Notes |
|---|---|
| `(org_id, content_hash)` PK | **Per-tenant scope.** Findings can carry tenant-sensitive citation strings; sharing across orgs is unsafe. |
| `result JSONB` | Full `SynthesisResult` payload — narrative + citations + severity_summary + min_confidence + hallucination_risk. |
| `provider TEXT` | Flat column for provider-specific admin metrics. Also embedded in `result.provider`. |
| `hit_count INT` + `last_hit_at TIMESTAMPTZ` | Telemetry — how many lookups did this cached row save. |
| `expires_at` | Default `now() + 7 days`. Source data (rules, payer policies) is reasonably stable over a week. |

Indexes: `synthesis_cache_expires_idx ON expires_at` for the cleanup scan; `synthesis_cache_provider_idx ON provider` for admin metrics.

### Pure helper — `synthesis-cache-pure.ts`

```ts
contentHashFor(provider: string, req: SynthesisRequest): string
```

SHA-256 of `<provider>\n<audience>\n<canonical(findings)>`. Reuses Phase 22's `canonicalize` (sorted-keys JSON) so cosmetic key reorderings inside a finding don't bust the cache.

What's IN the hash: `provider`, `audience`, `findings`.
What's OUT (deliberately): `request_id` (would defeat caching), `payer_id`/`state`/`product_line`/`date_of_service` (those drove the lookup but aren't the synthesis input — the findings themselves carry whatever payer/state-specific phrasing matters).

**7 unit tests** covering: 64-char hex output, deterministic on identical inputs, sensitive to provider / audience / findings differences, **explicit IGNORE** of request_id + payer_id + state + product_line + date_of_service (the non-input metadata), order-stable on findings via canonical sort.

### `SynthesisService` cache integration

`backend/src/synthesis/synthesis.service.ts`:

- New `@Optional() @Inject(DB_TOKEN)` constructor param. When unset (e.g., legacy unit-test instantiations), cache is skipped — service behaves as before.
- `synthesize(orgId, req)` now:
  1. Validates `synthesis.enabled` flag (unchanged).
  2. Picks provider (unchanged).
  3. Computes `contentHashFor(provider.name, req)`.
  4. **Cache lookup** — `lookupCache(orgId, hash)` reads the per-tenant row, validates `expires_at`, bumps `hit_count` + `last_hit_at` on hit. Returns the cached `SynthesisResult` if fresh; null otherwise.
  5. On miss, calls `provider.synthesize(req)` (Bedrock or deterministic).
  6. **Cache store** — `storeCache(orgId, hash, provider.name, result)` — except when `result.hallucination_risk` is true (those are advisory; we want the next render to attempt fresh).

Cache lookup + store are both **best-effort** with try/catch + warning log. A DB blip never blocks synthesis; the system falls through to a fresh provider call.

`onConflict (org_id, content_hash) DO UPDATE SET result, provider, expires_at = now() + 7 days` — replaying the same input refreshes the TTL window without resetting `hit_count`.

### Cleanup script extension

`backend/scripts/cleanup-expired-records.ts` now handles three tables:

| Table | Cleanup rule |
|---|---|
| `idempotency_record` | DELETE WHERE `expires_at < now()` (24h TTL) |
| `email_send` | DELETE rows older than 90 days, `status != 'failed'` |
| **`synthesis_cache`** | DELETE WHERE `expires_at < now()` (7-day TTL) |

Same bounded-per-run pattern (`WITH victims AS (... LIMIT N) DELETE USING victims`). The single daily cron picks up all three.

### Go-Live Record template — `docs/RUNBOOKS/go-live-record.md`

The artifact the operator commits at T+0 of the first prod cutover. Captures:

- Header: cutover time, tenant org_id + legal name, build SHA, OpenAPI paths, test count, on-call roster.
- **Pre-cutover gate state** — every gate from `launch-readiness.md` (A1–A7 + B1–B6) marked GREEN at decision moment, with sign-off rows for CTO + CEO + Compliance.
- **Sequence executed** — one row per step in `production-cutover.md`, with PASS / NOTE + actual time + diff-from-expected.
- **Synthesis cache hit-rate** SQL snippet to capture the first hour's cache effectiveness (informational).
- **What was different from the dress rehearsal** — concrete observations, not vibes.
- **P0/P1 incidents** during the window.
- **Rollback decisions considered + NOT taken** — captures near-misses + the reasoning.
- Daily metric snapshot at T+2 hr (lookup p95, error rate, email success, webhook DLQ count, idempotency + synthesis cache hit counts).
- Sign-offs from coordinator, CTO, CEO, Compliance, optional first-tenant contact.
- Artifacts: Slack export, recording, Datadog window, Stripe events, CloudTrail.

Future audits + post-mortems will read this. The template enforces the discipline of writing it as if the auditor is in the room.

## Hard constraints honored (no corner cutting)

- **Cache is per-org.** PK on `(org_id, content_hash)`. Two tenants with identical findings DO NOT share. Findings can carry citation strings or carc_class data that's tenant-sensitive — sharing would be a data-leak path even when "the content is the same."
- **Cache scope intentionally excludes lookup metadata** (`request_id`, `payer_id`, `state`, `product_line`, `date_of_service`). The findings array carries everything that affects synthesis output. Including the metadata would essentially defeat the cache (different DOS → different hash, even though synthesis would produce the same narrative).
- **Hallucination-risk results are NOT cached.** A flag-true finding is an advisory output; we want the next render to try again, not replay an advisory result.
- **Cache lookup + store are best-effort.** A failed DB query logs a warning and falls through to a fresh provider call. The customer's response stays correct; we just paid for the Bedrock spend.
- **`@Optional()` DB injection** preserves all existing unit-test instantiations of `SynthesisService` (which pass `flags, det, bedrock` only). New code-path is enabled only when DB is wired.
- **Cleanup is bounded per run** + uses the `WITH victims AS LIMIT N DELETE USING` Postgres pattern that locks per-row, not table.
- **`hit_count` + `last_hit_at` survive cache refresh on conflict.** The `DO UPDATE SET ... expires_at = ...` clause does NOT reset the telemetry — we want the cumulative count over the row's life, not since-last-refresh.
- **7-day TTL is deliberate.** Source data (rules, payer policies) drift week-to-week, not minute-to-minute. A week of caching saves real $ and gives the team a known re-render window for any rule change.
- **Go-live record template is a 2/3 sign-off** (CTO/CEO/Compliance) at the cutover decision moment — same authority pattern as the launch-readiness gate flips. Keeps the chain consistent.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 24

- **Negative caching** (cache the absence of a result, e.g., when `flag_disabled` refuses). Today the refusal path skips the cache entirely. Adding negative caching would require a separate row class or schema column; the current refusal cost is one DB query, which is fine.
- **Cross-tenant content cache** for our own admin / synthetic-test runs. Single-tenant scope is the floor; lifting it later requires a privacy review.
- **Cache invalidation on rule change.** Today caching is TTL-only. When a payer rule changes, downstream synthesis re-renders only after the 7-day TTL elapses. A push-invalidation surface is a Phase 25 candidate (rule-update → invalidate-cache-for-affected-orgs).
- **Per-tenant cache size cap.** No row-count cap today. The cleanup cron's 7-day TTL is the only governor. If a single tenant runs millions of unique syntheses, their cache grows to whatever fits in 7 days. Phase 25 candidate.
- **First dress rehearsal pass + first prod cutover.** The runbooks + the go-live template are in place; cutover is the operational step.

## Cumulative state at end of Phase 24

| Metric | P21 | P22 | P23 | **P24** |
|---|---|---|---|---|
| SQL migrations | 17 | 18 | 18 | **19 (+synthesis cache)** |
| Backend modules | 30 | 31 | 31 | **31** |
| Backend test suites | 47 | 49 | 49 | **50 (+1)** |
| Backend tests | 468 | 499 | 503 | **510 (+7)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 505 | 536 | 540 | **547** |
| HTTP endpoints | ~41 | ~41 | ~41 | **~41** |
| `docs/openapi.json` paths | 44 | 44 | 44 | **44** |
| Scheduled tasks (TF) | 5 | 5 | 6 | **6** |
| Runbooks | 9 | 9 | 9 | **10 (+go-live record)** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                 # 0 errors
npx jest --ci                                    # 50 / 510

# Synthesis cache effectiveness (after a few minutes of traffic):
psql -c "SELECT provider, COUNT(*) AS rows, SUM(hit_count) AS hits, AVG(hit_count) AS avg_hits FROM synthesis_cache GROUP BY provider"

# Cleanup dry-run (now covers synthesis_cache too):
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run cleanup:expired -- --dry-run
```

Phase 25 (cache invalidation on rule change + first dress rehearsal pass + first prod cutover) on `continue`.
