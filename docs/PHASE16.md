# Phase 16 — Magic-Link Invites, Signup-Attempt Cleanup, First-Admin Bootstrapping

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **41 suites / 396 tests / 0 failures (~32s).**
`npx ts-node scripts/export-openapi.ts` → **39 paths** in `docs/openapi.json`.

**Combined: 45 unit-test suites / 433 tests, all green.**

This phase adds **+1 suite / +16 tests** for invite primitives. The phase closes the self-serve onboarding loop with an opaque, constant-time, single-use magic-link redemption flow, ties first-admin bootstrap into the signup pipeline so an unredeemed signup leaves no privileged user able to log in, and lands the daily cleanup cron that reclaims abandoned-signup orgs + their slugs.

## What landed

### Migration 0015 — `invite_token`

`db/migrations/0015_phase16_invite.sql`. RLS-scoped per `app.apply_tenant_rls('invite_token')`.

Token shape:
- 32 bytes of randomness, rendered base64url (~43 chars), **never persisted server-side**.
- `token_lookup_prefix CHAR(12)` — first 12 chars of the raw token. Non-secret on its own (the SHA-256 hash is the security boundary), but a fast partial-index target.
- `token_hash CHAR(64)` — SHA-256(raw) hex.
- `consumed_at TIMESTAMPTZ` + `consumed_ip INET` — single-use enforcement + forensics.
- `expires_at TIMESTAMPTZ` — 7-day default per `invite-pure.DEFAULT_TTL_MS`.

Indexes:
- `(token_lookup_prefix) WHERE consumed_at IS NULL` — partial index hits 1 row in the typical case.
- `(org_id, created_at DESC)` — admin-side listing.
- `(expires_at) WHERE consumed_at IS NULL` — cleanup scan.

### `invite-pure.ts` — token primitives + 16 unit tests

- `generateToken()` → `{ raw, prefix, hash }`. `randomBytes(32)` + base64url + SHA-256.
- `parseToken(raw)` → `{ prefix, hash }` or `null`. Strict charset gate (only base64url chars), length floor at 12 — caller treats `null` indistinguishably from "no row found" so a probing attacker learns nothing.
- `constantTimeEqual(a, b)` — `timingSafeEqual` wrapper that returns `false` on length mismatch (instead of throwing, which `timingSafeEqual` does natively and would itself be a side-channel).
- `expiryFromNow(now, ttl)` — testable clock-injectable expiry builder; defaults to 7 days.

Tests cover: raw length / charset, prefix-is-first-12, hash matches `sha256(raw)`, 1000-call uniqueness, parse rejects too-short / wrong-charset / non-string, constant-time compare on identical / different / mismatched-length inputs, expiry clock injection.

### `InviteService` — issue + redeem

- `issue({ orgId, userId, role, ttlMs?, issuedByUserId? })` — generates the token, stores hash + prefix only, RLS-scoped via `runWithTenant`. Returns the raw token + expiry **once** to the caller (signup or admin).
- `redeem(rawToken, sourceIp)` — anonymous path:
  1. Parse → `null` returns the same opaque `INVITE_INVALID` as every other failure mode.
  2. Index-narrow on `token_lookup_prefix` (admin connection — the prefix is non-secret but RLS would block this read).
  3. Constant-time compare every candidate's hash + verify expiry.
  4. Atomically mark consumed (`consumed_at IS NULL` guard wins races with concurrent redeemers).
  5. Activate the org_member if currently `invited`.
  6. Return `{ org_id, user_id, email, role }`.

**The same opaque error covers every failure** — unknown / expired / already-consumed / hash-mismatch — so a probing caller cannot distinguish them.

### Controllers

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /v1/admin/invites` | Authenticated admin | Body `{ user_id, role, ttl_days? }`. Returns `{ redeem_url, expires_at }`. |
| `POST /v1/invite/redeem` | Anonymous, rate-limited | Body `{ token }`. 10 attempts/60s per IP; 403 `RATE_LIMITED` on overflow. |

`INVITE_REDEEM_BASE_URL_TOKEN` provider lets each environment configure its own deep-link base (`stage.example.com/invite/...` vs `app.example.com/invite/...`).

### SignupService — first-admin bootstrap

The signup pipeline now ends with:

4. Find or create `app_user` for the admin email (return-customer-friendly).
5. Insert `org_member { role: 'admin', status: 'invited' }` — `ON CONFLICT DO NOTHING` so a returning signup against an existing org+user pair is idempotent.
6. Issue a magic-link invite.

Returns `{ org_id, signup_attempt_id, checkout_url, admin_invite_token, admin_invite_expires_at }`. **`status='invited'` means the new admin can NOT log in until the invite is redeemed** — an unredeemed signup leaves no privileged user.

### Signup-attempt cleanup

`backend/scripts/expire-signup-attempts.ts` — daily script:

1. Find `signup_attempt.status='pending' AND expires_at < now()`.
2. Mark them `expired`.
3. If the linked org has no `subscription` row, delete the org. ON DELETE CASCADE on `org_member`, `signup_attempt`, `invite_token` reclaims the slug + the seeded user/member rows automatically.

CLI: `--dry-run` prints the plan without mutating. Wired as `npm run signup:expire`.

### EventBridge schedule

`infra/terraform/scheduled-tasks.tf` adds a third cron:

| Schedule | Frequency | Script | Enabled in |
|---|---|---|---|
| `signup-expire` | `cron(0 13 * * ? *)` (daily 13:00 UTC) | `scripts/expire-signup-attempts.ts` | prod only |

Existing reconciler (10-min) + renewal-motion (daily 14:00 UTC) untouched.

## Hard constraints honored (no corner cutting)

- **Same opaque error on every redeem failure**. `INVITE_INVALID` covers parse failure, no-prefix-hit, expired token, already-consumed token, hash-mismatch. A probing attacker can't probe the system to learn whether a specific token ever existed.
- **Hash compare is constant-time + length-equal-checked**. `timingSafeEqual` would throw on mismatched lengths (a side-channel itself); our wrapper returns `false`.
- **Token prefix is treated as non-secret, hash is the boundary**. Even if the DB is dumped, the attacker has only hashes — they need the raw token to authenticate.
- **Concurrent redeem races resolve atomically**. The UPDATE clause includes `WHERE consumed_at IS NULL`; whichever transaction wins flips the flag, the other gets 0 rows updated and falls through to the same opaque error.
- **org_member starts `invited`, not `active`**. Until the magic-link is redeemed, no one can log into the new tenant — so an abandoned signup never produces a privileged session.
- **Cleanup script is idempotent**. Re-running after a successful run is a no-op — it only touches rows where `status='pending' AND expires_at < now()`.
- **Cleanup is gated on no-subscription**. We do NOT delete orgs whose Checkout completed late (e.g., webhook delayed past the 24h Checkout TTL). If the subscription exists, the org survives even past the signup_attempt expiry.
- **Rate-limit on the public redeem endpoint** (10 attempts/60s/IP) is application-layer defense in depth on top of the WAF. Stops credential-stuffing against the prefix index.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 16

- **Email delivery via SES**. The `admin_invite_token` is returned in the signup response so ops can manually send the magic-link until the AWS SES BAA + sub-processor BAA chain is fully executed. Phase 17 adds `EmailService` once SES is BAA-covered.
- **JWT issuance on redeem**. Today the redeem endpoint returns `{ org_id, user_id, email, role }` and the front-end constructs a session via the existing dev-header auth path. Real JWT signing lands when AUTH_MODE flips to `jwt` in stage.
- **Admin-side invite list/revoke endpoints**. `GET /v1/admin/invites` and `DELETE /v1/admin/invites/:id` are obvious next surfaces; the current scope gets to the first redeem.
- **Trial-end notification email**. Stripe Test Clock can simulate it; SES sends it. Both deferred.
- **First dress rehearsal pass + first prod cutover**. Manual ops + GTM milestones, not code work.

## Cumulative state at end of Phase 16

| Metric | P13 | P14 | P15 | **P16** |
|---|---|---|---|---|
| SQL migrations | 13 | 13 | 14 | **15 (+invite)** |
| Backend modules | 27 | 27 | 28 | **29 (+invites)** |
| Backend test suites | 38 | 39 | 40 | **41 (+1)** |
| Backend tests | 351 | 359 | 380 | **396 (+16)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 388 | 396 | 417 | **433** |
| HTTP endpoints | ~27 | ~31 | ~32 | **~34 (+invite issue/redeem)** |
| `docs/openapi.json` paths | 32 | 36 | 37 | **39** |
| Scheduled tasks (TF) | 2 | 2 | 2 | **3 (+signup-expire)** |
| Scripts | renewal, reconcile, dry-run | + | + signup:start | **+ signup:expire** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                     # 0 errors
npx jest --ci                                        # 41 / 396
npx ts-node scripts/export-openapi.ts                # 39 paths

# Cleanup dry-run (against stage)
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run signup:expire -- --dry-run

# Issue an invite + redeem (against stage)
curl -X POST https://stage.example.com/v1/admin/invites \
  -H "x-org-id: 11111111-..." -H "content-type: application/json" \
  -d '{"user_id":"22222222-...","role":"admin"}'
# → { "redeem_url": "https://app.example.com/invite/<TOKEN>", "expires_at": "..." }

curl -X POST https://stage.example.com/v1/invite/redeem \
  -H "content-type: application/json" -d '{"token":"<TOKEN>"}'
# → { "org_id": "...", "user_id": "...", "email": "...", "role": "admin" }
```

Phase 17 (SES email delivery + admin invite list/revoke + first dress rehearsal pass + first prod cutover) on `continue`.
