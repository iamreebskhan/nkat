# Phase 29 — JWKS Endpoint Fetching, IdP Key Rotation Support

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **52 suites / 538 tests / 0 failures (~46s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 56 unit-test suites / 575 tests, all green.** This phase adds **+1 suite / +12 tests**:
- `jwks-client.spec.ts`: 11 tests (full caching, force-refresh, error matrix, end-to-end with `verifyJwt`)
- `auth.guard.spec.ts`: +1 test (JWT-mode rejects when no key source configured); existing tests refactored to async patterns since `canActivate` is now async

The phase finishes the production JWT story: instead of pinning a single static `JWT_PUBLIC_KEY` PEM, the guard now resolves keys via the IdP's JWKS endpoint with TTL caching + force-refresh on `kid` miss. Auth0 / Cognito / Okta / Clerk all rotate signing keys; without JWKS, every rotation breaks our auth and requires a redeploy. With JWKS, rotation is transparent.

## What landed

### `JwksClient` — `backend/src/auth/jwks-client.ts`

A focused JWKS fetcher (~100 lines). Surface:

```ts
new JwksClient(url, fetchImpl?, nowFn?)
client.resolveKey(kid: string): Promise<KeyObject>
```

Behavior:

- **24h TTL** after a successful fetch.
- **Force-refresh on `kid` miss** — the IdP just rotated, our cache is stale; one extra fetch resolves the new key. If still missing, throws `KID_NOT_FOUND`.
- **In-flight coalescing** — concurrent `resolveKey` calls during a fetch share the same Promise. Three API tasks all calling `verifyJwt` simultaneously after a key miss → ONE HTTP fetch, not three.
- **Filters non-signing keys** — Auth0/Cognito sometimes ship `use=enc` keys in the same doc. We skip them at parse time; resolveKey treats them as not-found.
- **MAX_KEYS = 32** — bound on JWKS doc size. Real IdPs ship 1–5 keys; 32 is paranoid headroom.
- **JWK → KeyObject** via Node's built-in `createPublicKey({ format: 'jwk' })` — handles RSA + EC natively.

Structured error codes: `NO_KID`, `KID_NOT_FOUND`, `FETCH_FAILED`, `NOT_JSON`, `SHAPE`, `TOO_MANY_KEYS`, `NO_USABLE_KEYS`.

### `verifyJwt` extended with `keyResolver`

`backend/src/auth/jwt-verifier.ts`. New optional arg `keyResolver?: (kid) => Promise<KeyObject>` — typical JWKS path is `keyResolver: (kid) => jwksClient.resolveKey(kid)`. The function is now `async` (was sync in Phase 28); all 14 existing verifier tests refactored to `async`/`await` patterns, plus `expectCode` helper now awaits.

The verifier:
1. Reads `header.kid`. If `keyResolver` is configured but kid is missing → `NO_KID` error.
2. Calls `keyResolver(kid)` to get the `KeyObject`.
3. Falls back to `publicKeyPem` if no resolver supplied. Either path produces a `KeyObject`; the verify step is unchanged.

### `AuthGuard` — JWKS-preferred, PEM-fallback

`backend/src/auth/auth.guard.ts`. `canActivate` is now `async`:

- **`AUTH_MODE === 'dev_header'`** unchanged.
- **`AUTH_MODE === 'jwt'`**:
  - If `JwksClient` is wired (constructor `@Optional() @Inject(JWKS_CLIENT_TOKEN)`), use the keyResolver path.
  - Else if `JWT_PUBLIC_KEY` env is set, use the static PEM path.
  - Else: 401 with "Neither JWT_JWKS_URL nor JWT_PUBLIC_KEY configured."

Same opaque `JWT_INVALID` 401 on every verify failure — JWKS or PEM, the caller sees identical behavior.

### `AuthModule` factory wires the JwksClient

`backend/src/auth/auth.module.ts`:

```ts
{
  provide: JWKS_CLIENT_TOKEN,
  inject: [ENV_TOKEN],
  useFactory: (env) => env.JWT_JWKS_URL ? new JwksClient(env.JWT_JWKS_URL) : undefined,
}
```

When `JWT_JWKS_URL` is unset, the provider supplies `undefined`; `@Optional()` injection in `AuthGuard` accepts that and falls back to the PEM path.

### `env.ts` extended

```ts
JWT_JWKS_URL: z.string().url().optional()
```

Production `JWT_JWKS_URL` typically: `https://<your-idp-tenant>.auth0.com/.well-known/jwks.json` or equivalent.

### Tests — JWKS round-trip + cache + concurrency

**11 new tests** in `jwks-client.spec.ts`:

1. Throws on construction without url.
2. `resolveKey` returns a key that round-trips a real RSA-SHA256 signature.
3. Cached: second `resolveKey` for the same kid does NOT re-fetch.
4. On kid miss, force-refreshes once + finds the new kid.
5. `KID_NOT_FOUND` when neither cache nor refresh has the kid (proves the force-refresh fires exactly once, not infinitely).
6. `NO_KID` on empty kid input.
7. `FETCH_FAILED` on non-2xx HTTP response.
8. Skips encryption keys (`use=enc`) — the enc kid is filtered out, but a sig kid in the same doc is usable.
9. Rejects JWKS docs with > 32 keys.
10. `NO_USABLE_KEYS` when all keys are encryption-only.
11. Coalesces concurrent in-flight fetches: `Promise.all([rk('k1'), rk('k1'), rk('k1')])` → ONE fetch.

Plus an end-to-end test (`verifyJwt with keyResolver`) that exercises the full chain: real RSA signature → JWKS lookup → keyResolver → verify.

### `jwt-verifier.spec.ts` refactored to async

All 14 existing tests updated to `async`/`await` patterns. The `expectCode` helper is now `async (fn, code) => { try { await fn(); ... } catch (e) { ... } }`. `.toThrow()` patterns replaced with `await expect(...).rejects.toBeInstanceOf(...)` or the async expectCode helper.

### `auth.guard.spec.ts` refactored to async

`canActivate` is now `Promise<boolean>`, so:
- `expect(await guard.canActivate(ctx)).toBe(true)` for success cases.
- `await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException)` for rejection cases.

Plus a new test asserting "JWT mode rejects when neither JWT_JWKS_URL nor JWT_PUBLIC_KEY is configured."

## Hard constraints honored (no corner cutting)

- **Force-refresh on kid miss is bounded to ONE retry.** A second miss (key really doesn't exist) throws `KID_NOT_FOUND` immediately. No infinite loops on a stuck IdP.
- **In-flight coalescing** — three concurrent calls during a fetch share one Promise. The 11th test asserts this with `Promise.all` + `callCount === 1`.
- **Encryption-only keys are filtered at parse time.** A bad-actor IdP that ships every JWT with `use=enc` would result in `NO_USABLE_KEYS` rather than a verified-with-the-wrong-key situation.
- **MAX_KEYS = 32** — paranoid bound. A malicious or compromised IdP can't blow up our memory by shipping a 100k-key doc.
- **JWK → KeyObject via Node native** `createPublicKey({ format: 'jwk' })`. No third-party JWK parser; one less attack surface.
- **JWKS URL is constructor input**, not user input. The `JwksClient` is constructed once at AuthModule init from `JWT_JWKS_URL` env. Never built from a request-derived value.
- **`@Optional()` JWKS injection** — when env doesn't supply `JWT_JWKS_URL`, the factory returns `undefined` and `AuthGuard` falls back to the static PEM. Either path is valid; the dev/test/prod transition doesn't require code changes.
- **Verifier is now async**. Sync return paths were the wrong contract once JWKS was in scope; the async refactor catches every call site (only `AuthGuard` consumes `verifyJwt` in our codebase).
- **`expectCode` test helper is async-aware** — catches rejected promises + asserts on `code` rather than message text. Robust against future error-message rephrasing.

## Bug caught + fixed during this session

1. **First draft of `verifyJwt` async refactor** broke 14 existing tests because they called `verifyJwt(...)` synchronously. Refactored every call site to `await` + every error-path test to `await expectCode(...)`. Caught on first `tsc --noEmit` run (TypeScript flagged `claims.sub` as not-existing-on-Promise).
2. **`auth.guard.spec.ts` was crashing the Jest worker** because the existing tests did `expect(() => guard.canActivate(ctx)).toThrow(...)`. After the async refactor, `canActivate` returns a Promise that rejects — the synchronous `.toThrow` matcher doesn't see it. Refactored to `await expect(...).rejects.toBe...`.
3. **`expectCode` helper** in `jwt-verifier.spec.ts` was synchronous; promoted to async to handle the async verifier path.
4. **JwksClient test had a roundabout `jwkToPublicKey` round-trip** that was overcomplicated. Simplified to direct `KeyObject.export({format:'jwk'})` — Node's built-in JWK exporter is the right primitive.

## What's deliberately NOT in Phase 29

- **JWKS pre-warm at AppModule boot.** Today the first request after a deploy triggers the initial fetch. A 50ms first-request hit is acceptable; pre-warming would couple boot time to the IdP's availability.
- **Per-`kid` cache** (vs. per-doc). Current cache is a single Map<kid,KeyObject> with one shared expiry. Per-kid TTL would let a single key expire without invalidating the whole doc; not justified at our key counts (1-5).
- **`alg` matching against the JWK's declared `alg`.** Today we trust the JWT header's alg; a future enhancement would cross-check against the JWK's declared `alg` (Auth0 always declares it). Phase 30 candidate.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 29

| Metric | P26 | P27 | P28 | **P29** |
|---|---|---|---|---|
| SQL migrations | 21 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 50 | 50 | 51 | **52 (+1)** |
| Backend tests (unit) | 512 | 512 | 526 | **538 (+12)** |
| Integration test suites | 3 | 6 | 6 | **6** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 549 | 549 | 563 | **575** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 6 | 6 | 7 | **7** |
| Runbooks | 11 | 11 | 11 | **11** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 52 / 538

# Production wiring with JWKS:
$env:AUTH_MODE = "jwt"
$env:JWT_JWKS_URL = "https://your-tenant.auth0.com/.well-known/jwks.json"
$env:JWT_ISSUER = "https://your-tenant.auth0.com/"
$env:JWT_AUDIENCE = "api.example.com"

# OR static PEM (back-compat with Phase 28):
$env:JWT_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

Phase 30 (alg cross-check + first dress rehearsal pass + first prod cutover) on `continue`.
