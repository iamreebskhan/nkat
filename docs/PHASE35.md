# Phase 35 — Per-Tenant Rate-Limit Overrides + JWKS Pre-Warm

## Why this phase

Two production hardening items:

1. **Per-tenant rate-limit overrides.** Decorator defaults
   (`@RateLimit({ limit, refillPerSec, scope })`) are right for ~95%
   of tenants. The other 5% need custom ceilings — enterprise
   contracts with explicitly negotiated higher limits, tenants under
   DDoS pressure where we want to *lower* their ceiling temporarily,
   and design-partner tenants we want to give breathing room without
   patching code.

2. **JWKS pre-warm.** First inbound JWT after a cold start pays
   ~50–200ms IdP fetch latency to populate the JWKS cache. Pre-warming
   on app bootstrap eliminates that cliff and ensures the readiness
   probe passes against a configured (and reachable) IdP.

## What landed

### Schema (`db/migrations/0023_phase35_rate_limit_overrides.sql`)

- `rate_limit_override` table — primary key `(org_id, scope)`. Stores
  `limit`, `refill_per_sec` (NUMERIC), optional `expires_at` for
  time-boxed promotional bumps, plus `reason`, `set_by_user_id`,
  `created_at`, `updated_at`. RLS-protected.

- `app.list_active_rate_limit_overrides()` SECURITY DEFINER function.
  The OverrideResolver in the API needs to read every active override
  to populate its in-memory cache; running that under per-tenant RLS
  would force a per-org loop. SECURITY DEFINER lets one call return
  all active overrides.

### Backend

- `common/rate-limit/override-resolver.ts` — `OverrideResolver`
  class. Pure helpers (`buildOverrideMap`, `resolveOverride`)
  separated for unit testing. The resolver:
  - Holds an in-memory `Map<"orgId:scope", {limit, refillPerSec}>`.
  - Refreshes from the SECURITY DEFINER function every 30 seconds on
    a `setInterval(...).unref()` timer.
  - Tolerates DB errors during refresh — logs + keeps stale cache
    rather than crashing the hot path.
  - O(1) sync `resolve(orgId, scope)` lookup used by the interceptor.

- `common/rate-limit/tokens.ts` — DI tokens broken out into their
  own file to avoid a cycle between `rate-limit.module.ts` and
  `rate-limit.interceptor.ts`. Both files re-export for back-compat.

- `common/rate-limit/rate-limit.interceptor.ts` — accepts an optional
  `OverrideResolver` (Optional() decorator for back-compat with
  modules that don't include it). On request: resolve override →
  effectiveLimit/effectiveRefill → `consume(...)` with effective
  values → return `X-RateLimit-Limit` reflecting the effective limit.

- `common/rate-limit/rate-limit.module.ts` — `OverrideResolverLifecycle`
  wraps the resolver with Nest's `OnApplicationBootstrap` /
  `OnApplicationShutdown` so it starts after DB is ready and stops
  cleanly on shutdown. Bootstrap failure is non-fatal (overrides are
  enhancements, not the security boundary).

- `admin/rate-limit-override.controller.ts` —
  - `GET /v1/admin/rate-limit/overrides` — list calling tenant's
    overrides.
  - `PUT /v1/admin/rate-limit/overrides/:scope` — upsert (UPSERT on
    `(org_id, scope)`); validates `limit ∈ [1, 1_000_000]`,
    `refillPerSec ∈ [0, 100_000]`, scope name matches
    `/^[a-z0-9][a-z0-9_-]{0,63}$/`. Force-refreshes the resolver
    after write so the new override is live on the very next request
    (no 30-second wait).
  - `DELETE /v1/admin/rate-limit/overrides/:scope` — remove.
  - All three audit-log under
    `rate_limit_override.{upsert|delete}` actions.

- `auth/jwks-client.ts` — added `prewarm()` method. Wraps
  `getCacheEntry()` with structured ok/err return so the bootstrap
  hook can decide whether to log a warning.

- `auth/auth.module.ts` — `JwksPrewarmer` lifecycle class implements
  `OnApplicationBootstrap`. Runs `client.prewarm()` if a JWKS client
  is configured, logs ok/fail count. dev_header mode (no IdP) skips
  cleanly.

### Tests

- `common/rate-limit/__tests__/override-resolver.spec.ts` — pure
  helpers: `buildOverrideMap` (keying, expiration filtering, boundary
  at exactly NOW), `resolveOverride` (hit / miss on org / miss on
  scope).
- Full unit suite: **618 / 618 passing** (was 611; +7 new tests).
- OpenAPI: **50 paths** (was 48; +3 new admin override endpoints; the
  audit-log redaction endpoint is `POST :id/redact` and was already
  counted as part of `audit-log` path family in Phase 34).

## Operational notes

- Override changes audit-log immediately and apply within one request
  (force-refresh on write). Background refresh covers replicas that
  didn't service the write.
- Time-boxed overrides automatically expire — the SECURITY DEFINER
  function filters `expires_at IS NULL OR expires_at > now()`.
- The OverrideResolver bootstrap failure is non-fatal: a tenant with
  a custom ceiling continues to receive the *decorator default* until
  the resolver successfully refreshes. This is the safer fail-mode.
- JWKS prewarm latency (~50–200ms) is now paid once at startup
  rather than on the first user-facing request after a cold deploy.
