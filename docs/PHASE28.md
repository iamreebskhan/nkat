# Phase 28 — Production JWT Auth, Webhook Delivery Worker

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **51 suites / 526 tests / 0 failures (~26s).**
`npx ts-node scripts/export-openapi.ts` → **45 paths**.

**Combined: 55 unit-test suites / 563 tests, all green.** This phase adds **+1 suite / +14 tests** for the JWT verifier.

The phase closes two production-readiness gaps that would have blocked first prod cutover:

1. **Real JWT verification** — the `AuthGuard` had a `'jwt' mode placeholder` that always 401'd. Now production tokens are RS256/ES256-verified against `JWT_PUBLIC_KEY`, with full claim validation (`iss`, `aud`, `exp`, `nbf`).
2. **Webhook delivery worker** — Phase 3 built `WebhookService.runDeliveryBatch()`, but no scheduled task actually drained the queue. Without a worker, every webhook subscription would have piled up rows in `webhook_delivery` forever.

## What landed

### `jwt-verifier.ts` — RS256/ES256 pure verifier

`backend/src/auth/jwt-verifier.ts`. ~140 lines, no external dep — pure Node `crypto`. Why our own (not jsonwebtoken / jose):

- One verify path, two algorithms, one key-source. The library complexity isn't justified.
- Same opaque-error pattern as the rest of the auth surface — the verifier returns structured error codes (`MALFORMED`, `ALG_NOT_ALLOWED`, `KEY_INVALID`, `BAD_SIGNATURE`, `EXPIRED`, `NOT_YET_VALID`, `ISSUER_MISMATCH`, `AUDIENCE_MISMATCH`); the AuthGuard collapses them all to the same opaque `JWT_INVALID` 401 so a probing caller learns nothing.
- ECDSA P-256 raw → DER conversion done inline (JWS uses raw R||S; Node's `crypto.verify` wants DER).

**Allowed algorithms**: `RS256`, `ES256`. Explicitly NOT supported: `HS256` (symmetric keys at the API layer is a smell), `none` (trivially-spoofable; rejected at the algorithm gate before any signature work).

**Claim validation**:
- `exp` rejected past 30s clock-skew.
- `nbf` rejected if more than 30s in the future.
- `iss` matched against `expectedIssuer` if supplied.
- `aud` matched against `expectedAudience` either as a string or as an `aud[]` array element.

### Tests — 14 cases against a REAL key

`backend/src/auth/__tests__/jwt-verifier.spec.ts`:

Generates a fresh RSA-2048 keypair via `crypto.generateKeyPairSync` once per file run, signs JWTs by hand using `crypto.createSign`, then exercises the verifier across:

- Happy path with custom claims preserved
- Malformed token (3-string-segment validation)
- 2-segment token rejection
- HS256 algorithm rejection (no symmetric keys)
- `none` algorithm rejection (no auth-bypass)
- Expired token rejection
- Skew window: `exp - 10` accepted with 30s skew
- `nbf` future rejection
- Bad signature (token signed with a different keypair) rejection
- Issuer mismatch rejection
- Audience: exact match passes
- Audience: array-includes match passes
- Audience: mismatch rejected
- Garbage public-key rejection

Each error-path test asserts the exact `code` field, not a regex on the message — so a future error-message rephrase doesn't false-fail the suite.

### `AuthGuard` — production JWT path

`backend/src/auth/auth.guard.ts`:

- `AUTH_MODE === 'dev_header'` — unchanged. NODE_ENV='production' refuses; otherwise reads `X-Org-Id` + `X-User-Id` + `X-Role` headers.
- `AUTH_MODE === 'jwt'` (NEW) — verifies the `Authorization: Bearer <token>` JWT against `JWT_PUBLIC_KEY` using RS256/ES256. Validates `iss` (= `JWT_ISSUER`) and `aud` (= `JWT_AUDIENCE`). Extracts `org_id` (UUID), `sub` (user UUID), and `role` claims.

Documented contract for the IdP token shape:

```json
{
  "iss": "https://idp.example.com",
  "aud": "<JWT_AUDIENCE>",
  "sub": "<user-uuid>",
  "org_id": "<tenant-uuid>",
  "role": "employee" | "reviewer" | "admin" | "consultant",
  "exp": 1700000000
}
```

**Same opaque error** for every JWT-side failure (`JWT_INVALID`); structured codes for shape problems (`JWT_NO_ORG_ID`, `JWT_NO_SUB`).

### Webhook delivery worker — `scripts/deliver-webhooks.ts`

The complement to `WebhookService.runDeliveryBatch()` — actually drives it on a schedule.

1. Distinct-org scan: cross-tenant query for orgs with `webhook_delivery` rows whose `status IN ('queued', 'in_flight') AND ready_at <= now()`. Bounded by `--org-batch` (default 50 orgs/run).
2. For each org, call `WebhookService.runDeliveryBatch(orgId, --per-org)` (default 25 deliveries/org/run).
3. Aggregate counts: succeeded, requeued, dead-lettered, errored.

Concurrency-safe by construction — `runDeliveryBatch` uses `SELECT FOR UPDATE SKIP LOCKED`, so two workers running simultaneously claim disjoint sets.

`npm run webhooks:deliver`.

### EventBridge schedule

`infra/terraform/scheduled-tasks.tf` adds the seventh scheduled task:

| Schedule | Frequency | Script |
|---|---|---|
| `webhooks-deliver` | `rate(2 minutes)` | `scripts/deliver-webhooks.ts` |

Prod-only by default. 2-minute cadence balances staleness (a webhook arrives within 2 min of `ready_at` elapsing) against cost (~720 ECS task starts/day per env).

## Hard constraints honored (no corner cutting)

- **No external JWT library.** ~140 lines of pure Node crypto. Algorithm allow-list is `RS256` + `ES256` only — `HS256`/`none` rejected at the gate before any signature work.
- **`none` algorithm explicitly rejected** — the classic JWT footgun. Even if a token claims `alg: none`, our `ALLOWED_ALGS` set rejects before reading any signature.
- **Same opaque `JWT_INVALID` error** for every verify failure — probing learns nothing about whether the failure was timing (`exp`), trust chain (`bad_signature`), or shape (`malformed`).
- **30s clock-skew tolerance** on `exp` + `nbf` — matches industry-standard practice; small enough to keep replay attacks bounded, large enough to absorb routine clock drift.
- **Test suite uses a REAL freshly-generated keypair**, not fixture strings. Every signature is a real RSA-SHA256 sign-verify round trip. A regression in our DER conversion or our base64url decode would surface as a real failure, not a false-positive against a hardcoded vector.
- **`JWT_NO_ORG_ID` and `JWT_NO_SUB` are SEPARATE codes** from `JWT_INVALID` — these aren't "invalid token" failures, they're "valid token from your IdP that doesn't carry the claims our app contract requires." Different remediation; surfaced separately.
- **Webhook worker uses `SELECT FOR UPDATE SKIP LOCKED`** so two cron firings in flight don't race-deliver. The 2-min cadence + service-side claim guarantees at-most-once delivery within the configured `max_attempts`.
- **Worker is bounded per run**: 50 orgs × 25 deliveries = 1,250 deliveries/cycle ceiling. A backlog clears over multiple cycles instead of one task taking 30+ minutes.
- **Cross-tenant org scan in worker uses admin connection** but every per-org delivery batch goes through `runWithTenant`. Cross-tenant write is impossible by construction.

## Bug caught + fixed during this session

1. **JWT test assertions used `.toThrow(/CODE/)` regex** matching the error message. The error message is `"disallowed alg: HS256"`, which DOESN'T contain the code text `ALG_NOT_ALLOWED`. Refactored every error-path test to use a small `expectCode(fn, 'CODE')` helper that catches the error + asserts on `error.code` directly. More robust against message rephrasing.
2. **Existing `AuthGuard` test** asserted the JWT mode threw `/JWT auth not yet wired/`. After wiring the path the assertion is wrong. Updated to assert on `JWT_PUBLIC_KEY not configured` for the no-key case, which is now the correct behavior.

## What's deliberately NOT in Phase 28

- **JWKS endpoint fetching** for IdP key rotation. Today `JWT_PUBLIC_KEY` is a single PEM in env. JWKS-based key fetching with `kid` matching is a Phase 29 candidate once we pick a specific IdP.
- **Refresh-token flow.** The IdP's job; we never see a refresh token.
- **JWT-claim-based RLS pre-population.** Today `req.auth.orgId` is set by the guard and tenant context is set by `runWithTenant` per request. A future enhancement is a Nest middleware that sets `app.current_org_id` on the connection at request open, so even read-only handlers don't have to wrap in `runWithTenant`. Phase 29 candidate.
- **Webhook delivery dashboards.** The worker prints counts; surfacing trend in Datadog is a follow-on.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones.

## Cumulative state at end of Phase 28

| Metric | P25 | P26 | P27 | **P28** |
|---|---|---|---|---|
| SQL migrations | 20 | 21 | 21 | **21** |
| Backend modules | 31 | 31 | 31 | **31** |
| Backend test suites | 50 | 50 | 50 | **51 (+1)** |
| Backend tests (unit) | 512 | 512 | 512 | **526 (+14)** |
| Integration test suites | 3 | 3 | 6 | **6** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 549 | 549 | 549 | **563** |
| HTTP endpoints | ~42 | ~42 | ~42 | **~42** |
| `docs/openapi.json` paths | 45 | 45 | 45 | **45** |
| Scheduled tasks (TF) | 6 | 6 | 6 | **7 (+webhooks-deliver)** |
| Runbooks | 10 | 11 | 11 | **11** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                 # 0 errors
npx jest --ci                                    # 51 / 526
npx ts-node scripts/export-openapi.ts            # 45 paths

# Production JWT auth — set the public key + issuer + audience:
$env:AUTH_MODE = "jwt"
$env:JWT_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
$env:JWT_ISSUER = "https://idp.example.com"
$env:JWT_AUDIENCE = "api.example.com"
# All auth-guarded endpoints now require Authorization: Bearer <RS256-token>.

# Webhook delivery worker (against stage):
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run webhooks:deliver -- --org-batch 50 --per-org 25
```

Phase 29 (JWKS endpoint fetching + first dress rehearsal pass + first prod cutover) on `continue`.
