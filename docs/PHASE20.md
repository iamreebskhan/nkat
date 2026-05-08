# Phase 20 — One-Click Unsubscribe, Email Retry Cron, Args-Snapshot Migration

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **46 suites / 463 tests / 0 failures (~52s).**
`npx ts-node scripts/export-openapi.ts` → **44 paths** in `docs/openapi.json`.

**Combined: 50 unit-test suites / 500 tests, all green.** This phase adds **+1 suite / +7 tests** for the unsubscribe-token primitive — the security-critical piece — plus a real retry surface for failed sends.

The phase ships RFC 8058-style one-click unsubscribe (HMAC-signed token in the footer; GET/POST redeem flips a `manual_optout` row), per-recipient signed URLs in every email, an `args_snapshot` column so the retry cron can re-render the original message exactly, and bounded exponential-backoff retries with eventual dead-lettering.

## What landed

### Migration 0017 — `email_send` retry columns

`db/migrations/0017_phase20_email_retry.sql` adds three columns:

| Column | Default | Purpose |
|---|---|---|
| `args_snapshot JSONB` | `'{}'::jsonb` | Persisted typed args (PHI-free by template contract) so the retry cron re-renders without ambient state. |
| `retry_count INT` | `0` | Bounded by `MAX_RETRIES = 4`. |
| `next_retry_at TIMESTAMPTZ` | `NULL` | NULL means "don't retry" (success / dead-letter / non-retryable error). |

Partial index `email_send_retry_idx ON email_send (next_retry_at) WHERE status='failed' AND next_retry_at IS NOT NULL` keeps the retry-scan O(due_count) regardless of historical send volume.

### Unsubscribe-link signer — `email/unsubscribe-token.ts`

Pure HMAC-SHA256 compact token. Format: `base64url(payload).base64url(signature)`. Single-claim shape `{ email, scope, exp }` — no JWT header overhead, one algorithm, deterministic + reproducible.

- `signUnsubscribeToken({ payload, secret, ttlMs? })` — defaults to 90-day TTL.
- `verifyUnsubscribeToken({ token, secret, expectScope? })` — constant-time HMAC compare; same opaque return shape on `malformed | bad_signature | expired | wrong_scope` so probing learns nothing about which check tripped.
- `email` is lower-cased on sign (so a recipient typed with mixed case still produces a stable token).

**7 unit tests**: round trip, expired, tampered signature, wrong secret, malformed inputs (no-dot, empty, partial), default-TTL boundary (89 days OK, 91 days expired), wrong-scope rejection.

### Email-template footer rewrite

`email/email-templates.ts` — `FOOTER_HTML` / `FOOTER_TEXT` constants replaced with `footerHtml(meta)` / `footerText(meta)` that conditionally append an unsubscribe link when `meta.unsubscribe_url` is supplied. Every template renderer signature now takes a `FooterMeta` second argument; `renderTemplate` threads `meta` through.

The unsubscribe link is per-recipient (`/v1/u/<signed-token>`), so each rendered message gets a fresh URL even when content is template-identical. No pre-baked URLs, no shared tokens.

### `EmailService` — unsubscribe + args-snapshot + retry

- Constructor takes `unsubscribeSecret` + `unsubscribeBaseUrl` as `@Optional()`. When both are present, every `send()` call generates a signed token from the recipient + injects `meta.unsubscribe_url` into `renderTemplate`. When unset, the footer omits the link.
- `recordAudit` persists `args_snapshot` + sets `next_retry_at = nextRetryAt(0)` for failed sends with retryable error classes.
- `MAX_RETRIES = 4` with backoff `[10m, 1h, 6h, 24h]` — total worst-case retry window is ~31 hours, deliberately bounded so a long-running outage doesn't generate stale alerts.
- `isRetryable(errorClass)` — closed list of non-retryable classes (`MessageRejected`, `MailFromDomainNotVerifiedException`, `AccountSuspendedException`, `SuppressionList`, `NoMessageId`); everything else retries with conservative-default-on-unknown logic.

**New public method**: `EmailService.retryFailedSend(emailSendId)` returns `{ status: 'sent' | 'failed' | 'dead_lettered' | 'noop' }`. Re-renders from `args_snapshot`, sends, updates the row in place. Idempotent at the row level (already-sent or already-dead rows return `noop`).

### `UnsubscribeController` — `/v1/u/:token`

Both verbs accepted (RFC 8058 mandates POST; GET preserves human-clickable simplicity):

- `GET /v1/u/:token` → 200 + minimal HTML confirmation page (no JS, server-rendered; all dependencies inline).
- `POST /v1/u/:token` → 200 `{ ok: true, email }`.

Both call `consume()`:
1. `verifyUnsubscribeToken(token, secret, expectScope='manual_optout')`. Same opaque error on every failure.
2. UPSERT `email_suppression` with `reason='manual_optout'`, `source='manual'`. Conflict-resolution preserves `complaint` (never downgrades a complaint back to manual_optout) but otherwise upgrades + refreshes `suppressed_at`.

Anonymous + token-authed; no rate limit at the application layer (a single HMAC compare is O(1) and the WAF/ALB handles abusive volume).

### `EmailModule` wiring

- New options: `unsubscribeSecret`, `unsubscribeBaseUrl`. AppModule reads `EMAIL_UNSUBSCRIBE_SECRET` + `APP_BASE_URL` env.
- New providers: `EMAIL_UNSUBSCRIBE_SECRET_TOKEN`, `EMAIL_UNSUBSCRIBE_BASE_URL_TOKEN`.
- New controller: `UnsubscribeController` (alongside the existing `SesFeedbackController`).

### Retry-failed-emails script + EventBridge schedule

`backend/scripts/retry-failed-emails.ts`:

1. Pulls up to `--limit` (default 100) failed rows whose `next_retry_at <= now()`, ordered ascending so the oldest debt clears first.
2. Calls `EmailService.retryFailedSend(id)` per row.
3. Reports counts: `sent` / `still_failed` / `dead` / `noop`.

Wired as `npm run email:retry`. Never red-fails the cron — dead-lettering is an expected-outcome state, not a script error.

EventBridge: `rate(15 minutes)`, prod-only by default. Combined with the four-step backoff (`10m / 1h / 6h / 24h`), this gives ~5 retry windows per attempt slot.

### `EmailModule.forRoot` AppModule wiring

`AppModule` now passes `unsubscribeSecret: process.env.EMAIL_UNSUBSCRIBE_SECRET` + `unsubscribeBaseUrl: process.env.APP_BASE_URL`. When the secret is unset (e.g., dev without that env var), the footer is silently omitted and the redeem endpoint returns `503 UNSUBSCRIBE_NOT_CONFIGURED` — both behaviors are preferable to broken footers in production.

## Hard constraints honored (no corner cutting)

- **Unsubscribe URLs are per-recipient + per-message-render.** No shared tokens, no token re-use across recipients. Each `EmailService.send` call regenerates the token from `recipient + scope + 90d-from-now`.
- **`args_snapshot` is persisted, rendered HTML/text is not.** Retry re-renders so footer (with a fresh unsubscribe URL) is always current. Storing rendered HTML would freeze the URL into a row that may be retried days later.
- **Retry never fires on non-retryable error classes.** `MessageRejected`, `MailFromDomainNotVerifiedException`, etc., set `next_retry_at = NULL` immediately. The retry scan never sees them.
- **Same opaque error** on every unsubscribe-token verification failure — `UNSUBSCRIBE_INVALID` regardless of which check tripped. Stops timing/oracle leakage.
- **Conflict resolution NEVER downgrades a `complaint` to `manual_optout`.** SQL CASE in the unsubscribe upsert preserves the more-severe reason; only refreshes `suppressed_at`.
- **GET + POST both honored.** Outlook ATP pre-fetching email URLs is a real-world thing; we let it succeed (idempotently) rather than fail open.
- **Dead-letter is a TERMINAL state**, not "fail open." Once `MaxRetriesExceeded`, `next_retry_at = NULL` permanently — only break-glass admin can re-queue.
- **Retry script doesn't red-fail on dead-letter.** EventBridge would alarm on a non-zero exit; dead-lettering is expected. The cron exits 0 with the count printed; humans look at the printed count, not exit codes.
- **Retry cron's exponential backoff is bounded** by 31 hours total. A persistent outage doesn't generate noise indefinitely; rows roll into dead-letter and the operator has a single forensic surface.
- **`isRetryable` is exported + unit-testable** so the contract is auditable in code, not buried in a switch statement.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed. The Phase 12 SilentNestCrash pattern was already mitigated for `Optional()` constructor params; new optional params (`unsubscribeSecret`, `unsubscribeBaseUrl`) were declared with `@Optional()` from the start.)

## What's deliberately NOT in Phase 20

- **List-Unsubscribe RFC 8058 headers** in the SES SendEmail payload. Today the unsubscribe URL is footer-only; adding `List-Unsubscribe` + `List-Unsubscribe-Post` headers gives Gmail/Apple Mail's native "Unsubscribe" UI button. Phase 21 candidate (one-line addition).
- **Re-subscribe flow.** Today break-glass via the admin DELETE endpoint or SQL. Self-serve re-subscribe is a UX surface, not a security one — deferred.
- **Per-tenant unsubscribe scope.** Today an unsubscribe is global (one `email_suppression` row regardless of tenant). Per-tenant unsubscribe (e.g., "stop trial-ending emails from Acme but keep getting them from Globex") is a Phase 22+ surface tied to multi-tenancy nuance.
- **First dress rehearsal pass** + **first prod cutover.** Manual ops + GTM milestones, not code work.
- **Retry-cron Datadog dashboard.** Counts are printed; surfacing as a dashboard panel is a follow-on once stage cron starts firing.

## Cumulative state at end of Phase 20

| Metric | P17 | P18 | P19 | **P20** |
|---|---|---|---|---|
| SQL migrations | 16 | 16 | 16 | **17 (+email retry)** |
| Backend modules | 30 | 30 | 30 | **30** |
| Backend test suites | 43 | 45 | 45 | **46 (+1)** |
| Backend tests | 421 | 456 | 456 | **463 (+7)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 458 | 493 | 493 | **500** |
| HTTP endpoints | ~36 | ~37 | ~40 | **~41 (+/v1/u/:token)** |
| `docs/openapi.json` paths | 40 | 41 | 43 | **44** |
| Scheduled tasks (TF) | 3 | 4 | 4 | **5 (+email-retry)** |
| Email templates | 4 | 4 | 4 | **4** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                     # 0 errors
npx jest --ci                                        # 46 / 463
npx ts-node scripts/export-openapi.ts                # 44 paths

# Production env adds:
$env:EMAIL_UNSUBSCRIBE_SECRET = "<32+ random chars; rotate annually>"
$env:APP_BASE_URL = "https://app.example.com"

# Stage rehearsal — dry-run the retry cron
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run email:retry -- --dry-run
```

Phase 21 (List-Unsubscribe RFC 8058 headers + first dress rehearsal pass + first prod cutover) on `continue`.
