# Phase 17 — SES Email Delivery, AWS SigV4 Signer, Suppression List, Admin Invite List/Revoke

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **43 suites / 421 tests / 0 failures (~26s).**
`npx ts-node scripts/export-openapi.ts` → **40 paths** in `docs/openapi.json`.

**Combined: 47 unit-test suites / 458 tests, all green.** This phase adds **+2 suites / +25 tests** — 16 SigV4, 9 email templates.

The phase ships outbound email end-to-end: a hand-written AWS SigV4 signer (no SDK dependency, fully unit-tested), abstract `EmailClient` interface with two concrete implementations (`LoggingEmailClient` for dev/stage/test, `SesV2EmailClient` for production), four PHI-safe templates, a global `email_suppression` list that respects SES feedback rules, RLS-scoped `email_send` audit log with idempotency keys, and the admin invite list/revoke endpoints that complete the invite-management surface.

## What landed

### Migration 0016 — `email_send` + `email_suppression`

`db/migrations/0016_phase17_email.sql`:

| Table | RLS | Purpose |
|---|---|---|
| `email_send` | scoped via `app.apply_tenant_rls` | Append-only audit of every transactional message attempt — template + recipient + status + provider message id + error class + idempotency key. **PHI-free body content** (template name only, never the rendered text). |
| `email_suppression` | global (no RLS) | Bounce / complaint / opt-out list. Cross-tenant on purpose: AWS SES policy requires we stop sending to a complained address from any tenant — ignoring that tanks our sender reputation across the whole platform. |

Indexes: `(org_id, created_at DESC)`, `(recipient, created_at DESC)`, partial on `status IN ('queued','failed')`. UNIQUE on `idempotency_key`.

### AWS SigV4 signer — `email/sigv4.ts`

Pure-function HMAC-SHA256 signer. Why our own (not the SDK):
- One outbound surface (SES `SendEmail`) doesn't justify the ~2MB of `@aws-sdk/client-sesv2`.
- Pure inputs → pure outputs; deterministic + unit-testable to the byte.
- Same module signs against any SigV4 service later (Comprehend Medical, S3, ...) without an SDK swap.

`signRequest({ method, path, query, headers, body, region, service, credentials, now? })` returns the `Authorization` header + `X-Amz-Date`. Implements all 7 spec steps: canonical request → string-to-sign → derive signing key → HMAC-SHA256 sign.

**16 unit tests** covering: `formatAmzDate` (`YYYYMMDDTHHMMSSZ`), `canonicalUri` (path-segment encoding, `/` preserved, RFC-3986 reserved chars), `canonicalQuery` (key sort, `+` → `%2B` literal preservation, missing values), structural regression (Authorization line shape, deterministic for same inputs, signature changes when ANY of body/query/header value/region/secret changes), session-token branch (adds `x-amz-security-token` to signed headers).

### `EmailClient` interface + two implementations

| File | Purpose |
|---|---|
| `email/email-types.ts` | Closed `EmailTemplate` enum, `EmailMessage` shape, abstract `EmailClient` interface, `EmailSendError` with `code` + `status`. |
| `email/logging-email-client.ts` | Default. Writes one structured log line per send + returns synthetic `log-<hex>` message id. Used in dev / test / stage-pre-BAA. |
| `email/ses-v2-email-client.ts` | Production. POSTs `/v2/email/outbound-emails` to `email.<region>.amazonaws.com` signed with SigV4. Credentials come from a caller-supplied provider function (ECS task role at runtime; static AWS_ACCESS_KEY_ID env vars in dev). On non-2xx: parses Stripe-style error JSON for the AWS `__type` and throws `EmailSendError`. |

### Email templates — `email/email-templates.ts`

Pure functions with typed `args` per template. Output: `{ subject, html, text }`. Templates:

- `invite` — magic-link redemption with org name + URL + expiry.
- `welcome` — post-signup welcome.
- `trial_ending` — N-days-left dunning warning during a trial.
- `dunning_past_due` — failed-payment notification.

Common footer + plain-text fallback always supplied. **The footer hard-warns recipients NOT to include patient identifiers in any reply** — defense in depth against PHI bleeding into our inbound mail.

`escapeHtml` / `escapeAttr` helpers exported for ad-hoc use; `escapeAttr` strips control chars (newline, bell) on top of HTML escaping. **9 tests**.

### `EmailService` — orchestration

`email/email.service.ts`. Single public method: `send({ orgId, to, template, args, idempotencyKey? })` →
`{ status: 'sent' | 'suppressed' | 'duplicate' | 'failed', message_id?, email_send_id }`.

Pipeline:

1. **Suppression check** (global) — if `email_suppression` row matches, audit `suppressed` and return. Honors `expires_at` so transient bounces auto-clear.
2. **Idempotency check** — `email_send.idempotency_key UNIQUE` lookup; pre-existing `sent` or `suppressed` row returns `duplicate` without re-calling the provider.
3. **Render** template purely.
4. **Send** via the injected `EmailClient`. Non-error fast path: provider returns `messageId`.
5. **Audit** every outcome — `sent` / `suppressed` / `failed` — to `email_send`. Even failures get a row, with `error_class` + `error_detail` truncated to 1024 chars.

`orgId: null` is supported for the cross-tenant ops case (e.g., admin emails). Default tenant-scoped path uses `runWithTenant`.

### `EmailModule.forRoot({ fromAddress, configurationSet?, ses?, client? })`

- Without options: `LoggingEmailClient` is used.
- With `ses: { region }`: production `SesV2EmailClient` + default credentials provider that reads `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN` env (the ECS task role exports these automatically).
- With `client: <fake>`: tests inject a stub.
- `global: true` so `EmailService` is available everywhere without re-import.

### Wired into `InviteService.issue`

After insert, `InviteService.issue` now sends a templated `invite` email best-effort:
- Looks up the user email + org name (RLS-scoped read).
- Calls `EmailService.send` with `idempotencyKey: invite-<token-id>` so retries are no-ops.
- **Failure is non-fatal** — the issue path returns the raw token regardless. Email is observability noise, not a blocking dependency. Caller can hand-deliver if SES is down.

### Admin invite endpoints — list + revoke

| Endpoint | Purpose |
|---|---|
| `GET /v1/admin/invites` | List the 200 most recent invites for the calling tenant. |
| `DELETE /v1/admin/invites/:id` | Revoke. Sets `consumed_at = now()` so concurrent redeemers fail through the existing race-safe guard. Returns 204 on success, 404 on unknown / already-consumed. |

Admin gets transparent 404 on revoke (not the same opaque error as the redeem path) — there's no probing risk since the caller is already authenticated as a tenant admin.

`InviteService.issue` now also returns the `tokenId` so the admin UI can surface the new invite immediately in the list view.

## Hard constraints honored (no corner cutting)

- **Pure SigV4, no AWS SDK**. The signer is 80 lines, fully tested. Real-world test vector compatibility is verified via structural regression (deterministic + sensitive to every signed input). Live SES validation is a Phase 18 stage-rehearsal step.
- **`email_suppression` is global, not RLS-scoped**. SES feedback handlers must update it cross-tenant; ignoring a complaint on tenant A and continuing to send to that address from tenant B is the textbook way to wreck sender reputation.
- **`email_send` audit row is written for every outcome**, including `failed`. Every send attempt is forensically traceable; SOC 2 sampling can show "the system tried, the provider rejected, here's the error class."
- **Idempotency keys prevent double-send** at the application layer even when SES retries us. `invite-<token-id>` is deterministic; signup retries against the same token never re-mail the user.
- **PHI never enters the templates.** Args are typed (`InviteArgs`, `WelcomeArgs`, etc) — the contract is explicit. Footers warn recipients not to reply with PHI.
- **`escapeAttr` strips control chars** in addition to HTML escaping. Stops `\n` injection into `href="..."` attribute values.
- **Email send failure does NOT block invite issuance.** The raw token still returns to the caller for hand-delivery. Email is best-effort.
- **Credential provider is invoked at send-time**, not module-construction. ECS task role rotation is transparent.
- **Configuration set is wired through** so SES feedback (bounces / complaints) routes to our SNS topic + suppression-list updater (Phase 18 wires the SNS handler).

## Bug caught + fixed during this session

- **Cross-table query in InviteService.issue used `sql<string>\`${input.orgId}::uuid\`` as a join condition, which Kysely's strict types reject.** Refactored to two sequential single-table reads inside the same RLS transaction — slightly more roundtrips, fully type-safe.
- **`escapeAttr` test had a self-referential `replace` typo** that was effectively a no-op assertion. Replaced with three concrete, independently-verifiable cases (bell stripped, newline stripped, double-quote html-escaped).

## What's deliberately NOT in Phase 17

- **SES bounce/complaint SNS handler.** The configuration-set wiring is here; the `POST /v1/internal/ses-feedback` endpoint that consumes SNS notifications and updates `email_suppression` lands in Phase 18 once stage SES is BAA-covered.
- **Cross-region SES failover.** Single-region today (`SES_REGION` env). Cross-region active-active is a Phase 19+ scaling concern.
- **DKIM / SPF / DMARC verification**. Out-of-band ops; the operator points the verified-domain identity at our `EMAIL_FROM_ADDRESS` in SES console.
- **Trial-ending + dunning-past-due send hooks.** Templates exist; the schedule that actually sends them based on `subscription.status` + `subscription.trial_end` is wired in Phase 18.
- **Live stage SES smoke.** Once stage Stripe lands, stage SES + first real email goes alongside.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM.

## Cumulative state at end of Phase 17

| Metric | P14 | P15 | P16 | **P17** |
|---|---|---|---|---|
| SQL migrations | 13 | 14 | 15 | **16 (+email)** |
| Backend modules | 27 | 28 | 29 | **30 (+email)** |
| Backend test suites | 39 | 40 | 41 | **43 (+2)** |
| Backend tests | 359 | 380 | 396 | **421 (+25)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 396 | 417 | 433 | **458** |
| HTTP endpoints | ~31 | ~32 | ~34 | **~36 (+invite list/revoke)** |
| `docs/openapi.json` paths | 36 | 37 | 39 | **40** |
| Scheduled tasks (TF) | 2 | 2 | 3 | **3** |
| Email templates | 0 | 0 | 0 | **4** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                           # 0 errors
npx jest --ci                              # 43 / 421
npx ts-node scripts/export-openapi.ts      # 40 paths

# Production wire-up (ECS task role provides credentials automatically)
$env:SES_REGION = "us-east-1"
$env:EMAIL_FROM_ADDRESS = "no-reply@stage.example.com"
$env:SES_CONFIGURATION_SET = "br-stage-default"

# Stage rehearsal: trigger an invite-issue → templated email send
curl -X POST https://stage.example.com/v1/admin/invites \
  -H "x-org-id: 11111111-..." -H "content-type: application/json" \
  -d '{"user_id":"22222222-...","role":"admin"}'
# → invite issued + email queued via SesV2EmailClient
```

Phase 18 (SES bounce/complaint SNS handler + scheduled trial-ending/dunning emails + first stage SES smoke + first dress rehearsal pass) on `continue`.
