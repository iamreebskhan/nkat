# Phase 25 — Synthesis Cache Invalidation, Admin Endpoint, CLI

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **50 suites / 512 tests / 0 failures (~36s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 54 unit-test suites / 549 tests, all green.** This phase adds **+2 tests** for the cache-version-bumps-hash invariant.

The phase closes the synthesis cache loop with a global version-bump invalidation primitive: when payer rules change (e.g., quarterly NCCI drop), an admin click — or a CI/CD step — bumps `synthesis_cache.version`, every existing cache row's hash is now stale, and new lookups re-render fresh. Old rows naturally TTL out over the next 7 days. No thundering herd, no DDL lock, no wholesale TRUNCATE.

## What landed

### Migration 0020 — `system_setting`

`db/migrations/0020_phase25_system_setting.sql` — a global key-value table for platform settings. **Not RLS-scoped** by design (settings are platform-wide; admins write, services read).

| Column | Notes |
|---|---|
| `key TEXT PK` | First key seeded: `synthesis_cache.version = 1`. |
| `value JSONB` | Arbitrary shape. For the cache-version key it's a JSON integer. |
| `updated_by_user_id` | Nullable so CLI bumps can record `null` user_id with a `note` ("ncci-2026-q3-deploy"). |
| `note TEXT` | Free-text audit context. |
| `updated_at` | `now()` on every write (set by the upsert clause). |

We deliberately don't reuse the per-tenant `feature_flag` table; mixing platform-global rules-version values with feature-gate semantics would muddy that contract.

### `CacheVersionService` — TTL-cached read + atomic bump

`backend/src/synthesis/cache-version.service.ts`:

- **`current(nowMs?)`** — reads the version with a 60s in-process TTL cache. Stale read on a missing key returns `1` (matches the migration seed) so a fresh deploy without the seed doesn't crash hash computation.
- **`bump({ byUserId, note })`** — atomic increment via raw SQL: `value = ((value::int + 1)::text)::jsonb`. Concurrent bumps each get a distinct return value (no lost updates — the arithmetic is server-side). Invalidates the in-process cache immediately so the bumping caller sees its own bump on the next call. Other API tasks pick up via the 60s TTL.

The 60s TTL is deliberate — it's not a correctness boundary, it's a cost-saver. After a bump, stale cache hits for up to ~60s while every API task ages out. Acceptable trade-off vs. querying Postgres on every synthesis call.

### `contentHashFor` extended with version arg

`backend/src/synthesis/synthesis-cache-pure.ts`:

```ts
contentHashFor(provider, request, cacheVersion = 1)
```

The version is hashed FIRST in the input string — small change, but:

- **Default = 1** — older callers (legacy tests, fresh-deploy callers) get the same hash they got before.
- **Bumping the version mechanically invalidates the entire cache for every tenant** — every existing row's hash no longer matches. New lookups produce new rows under the bumped version; old rows TTL out over the next 7 days.

**+2 tests**: `cacheVersion=1 vs 2 produces different hashes`, `default cacheVersion is 1 when omitted`.

### `SynthesisService` consumes the version

`backend/src/synthesis/synthesis.service.ts`:

- New `@Optional() @Inject(CacheVersionService)` constructor param.
- `synthesize()` now calls `cacheVersion.current()` before computing the hash. When the service is unwired (legacy test instantiations), the helper falls back to `1` and behavior is unchanged.

### Admin endpoint — `POST /v1/admin/cache/invalidate`

`backend/src/admin/cache-invalidate.controller.ts`. Auth-guarded; bumps the version + writes an `audit_log` row under the calling tenant.

```http
POST /v1/admin/cache/invalidate
{ "note": "ncci-2026-q3-deploy" }
→ { "version": 2 }
```

Why not a destructive TRUNCATE: bumping the version causes new lookups to populate the cache afresh while old rows naturally TTL out. No thundering herd on cache misses, no DDL lock, no transaction-time spike.

### CLI script — `npm run cache:invalidate`

`backend/scripts/invalidate-cache.ts` — same effect, invokable from CI/CD or an ops shell. Records `byUserId: null` and a `--note` for forensics. Useful when there's no human admin clicking (e.g., a scheduled rules-import job that wants to invalidate cache after its commit).

```
npm run cache:invalidate -- --note "ncci-2026-q3-deploy"
→ synthesis_cache.version → 2 (note: ncci-2026-q3-deploy)
```

### `SynthesisModule` updated

Now imports `DatabaseModule`, exports `CacheVersionService` so `AdminModule` can register `CacheInvalidateController` and `AdminModule` imports `SynthesisModule` for the service.

## Hard constraints honored (no corner cutting)

- **Bump uses `value = ((value::int + 1)::text)::jsonb`** in a single UPSERT — concurrent bumps each get distinct increments. No SELECT-then-UPDATE race. No advisory lock needed.
- **TTL on the in-process cache is 60s, not minutes.** Stale reads after a bump are bounded; every API task sees the new version within a minute.
- **In-process cache is invalidated immediately on bump** so the bumping caller sees its own write on the next call (fixes the read-your-own-write expectation).
- **Default `cacheVersion = 1`** in `contentHashFor` — legacy unit tests + fresh deploys without the seed produce the same hashes they always did.
- **Admin endpoint + CLI write the same target** (`bump`). No two paths drifting.
- **`audit_log` row recorded for the admin endpoint** with `actor user_id + ip_address + user_agent`. CLI bumps record `byUserId: null` with the note as the only forensic context — that's fine because CLI runs are themselves audit-logged in the CI/CD layer.
- **`system_setting` is intentionally not RLS-scoped.** Per-tenant settings would belong in `feature_flag`; this table is platform-global by contract.
- **Reusing `feature_flag` was rejected** — feature flags drive product gates (synthesis on/off, provider name); platform rules-version is a different beast and mixing them would muddy both surfaces.
- **Bumping is non-destructive.** Cache rows under the old version still exist; cleanup cron reclaims them at their natural 7-day TTL. Operators worried about the cost of stale rows can wait for cleanup or shorten the TTL — no action needed at bump time.

## Bug caught + fixed during this session

- **First draft of `CacheVersionService.bump` was a fragile chain of Kysely-builder attempts** trying to express `value::int + 1` through the typed ORM. Kysely doesn't model the cast-and-add idiom cleanly. Replaced with a direct `sql` template (still type-checked) — 70 lines of wrong code became 15 lines of right code. Caught while writing the second test.

## What's deliberately NOT in Phase 25

- **Per-tenant cache invalidation.** Today bumping is platform-global. A tenant-scoped invalidation surface would require either per-tenant version columns or finer-grained dependency tracking (which rule each cache row depended on). Out-of-scope; the use case (NCCI quarterly drops affect every tenant) is global by nature.
- **Auto-invalidation on rule write.** A trigger that bumps the version when `payer_rule` mutates is technically simple; we deferred because operators want explicit control over when synthesis re-renders globally (avoids surprise cache-misses during a no-op edit).
- **`synthesis_cache` cleanup-on-version-bump.** Bumping doesn't DELETE old rows; the cleanup cron handles that on the natural TTL. A faster reclaim option (DELETE rows hashed under any version < current) is a Phase 26 candidate if the cache table grows visibly stale.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 25

| Metric | P22 | P23 | P24 | **P25** |
|---|---|---|---|---|
| SQL migrations | 18 | 18 | 19 | **20 (+system_setting)** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 49 | 49 | 50 | **50** |
| Backend tests | 499 | 503 | 510 | **512 (+2)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 536 | 540 | 547 | **549** |
| HTTP endpoints | ~41 | ~41 | ~41 | **~42 (+invalidate)** |
| `docs/openapi.json` paths | 44 | 44 | 44 | **45** |
| Scheduled tasks (TF) | 5 | 6 | 6 | **6** |
| Runbooks | 9 | 9 | 10 | **10** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 50 / 512
npx ts-node scripts/export-openapi.ts             # 45 paths

# Bump the cache version after a rule deploy:
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run cache:invalidate -- --note "ncci-2026-q3-deploy"

# Or via the admin API:
curl -X POST https://stage.example.com/v1/admin/cache/invalidate \
  -H "x-org-id: 11111111-..." -H "content-type: application/json" \
  -d '{"note":"ncci-2026-q3-deploy"}'
```

Phase 26 (auto-invalidation hooks + first dress rehearsal pass + first prod cutover) on `continue`.
