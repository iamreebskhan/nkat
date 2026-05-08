# Phase 18 — SES Bounce/Complaint SNS Handler, Scheduled Trial + Dunning Emails

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **45 suites / 456 tests / 0 failures (~25s).**
`npx ts-node scripts/export-openapi.ts` → **41 paths** in `docs/openapi.json`.

**Combined: 49 unit-test suites / 493 tests, all green.** This phase adds **+2 suites / +35 tests** — 20 SNS, 15 scheduled-email planner.

The phase closes the email feedback loop: SES bounces and complaints flowing back through SNS update the global suppression list automatically, with full RSA signature verification, topic-ARN allowlist, and cert-URL host pinning. Plus the daily scheduled task that sends trial-ending and dunning emails at the right moment, with deterministic idempotency keys so cron re-runs are no-ops.

## What landed

### SNS notification primitives — `email/sns-pure.ts`

Pure functions, fully unit-testable:

- `buildCanonicalString(envelope)` — AWS SNS canonical format. Field order matters; `Notification` and `SubscriptionConfirmation` use different field sets per spec.
- `isAllowedCertUrl(rawUrl)` — host allowlist `sns.<region>.amazonaws.com` (or `.com.cn` for China). Rejects subdomain tricks (`evil.sns…`), suffix tricks (`sns…amazonaws.com.attacker.com`), wrong protocol, wrong file extension. **The cert-URL allowlist is the bedrock**: signature verification fetches whatever cert URL the message claims, so an attacker who can serve a self-signed cert at `evil.com/x.pem` would otherwise pass verification with their own private key.
- `parseSesFeedbackPayload(rawMessage, nowMs)` — classifies SES payloads:
  - `Bounce` + `bounceType=Permanent` → `bounce_permanent`, no expiry.
  - `Bounce` + `bounceType=Transient` → `bounce_transient`, expires in 24h.
  - `Complaint` → `complaint`, never expires.
  - Everything else (Delivery, DeliveryDelay, etc.) → `null` (no-op upstream).
- `isAllowedTopicArn(received, allowed)` — explicit allowlist gate. Even valid signatures from valid AWS SNS certs are rejected if the topic ARN isn't configured. Stops cross-account spoofs.

**20 unit tests** covering all of the above plus negative cases (malformed JSON, empty recipients, unknown notification types).

### `SnsVerifier` — RSA-SHA1 / RSA-SHA256 verify with cert cache

`email/sns-verifier.ts` — Nest service, in-memory PEM cache (32 entries, 24h TTL, FIFO eviction). On `verify(envelope)`:

1. `isAllowedCertUrl` gate (BEFORE we fetch).
2. Algorithm selection: SignatureVersion=1 → RSA-SHA1 (legacy AWS default), 2 → RSA-SHA256.
3. Fetch + cache the PEM cert. Reject if the response body doesn't start with `-----BEGIN CERTIFICATE-----`.
4. `createVerify(algo).update(canonical, 'utf8').verify(pubKey, sig, 'base64')`.
5. Throw `SnsVerifyError` with a structured `code` on any failure — never return false (no retries).

`fetchImpl` and `nowFn` are `@Optional()` constructor params (clock + network injection for tests, defaults to `globalThis.fetch` + `Date.now` in production).

### `SesFeedbackController` — `POST /v1/internal/ses-feedback`

Anonymous (SNS posts unauthenticated; we authenticate via the RSA signature + topic-ARN allowlist). Pipeline:

1. Body sanity check (object, required fields).
2. `isAllowedTopicArn` gate. Unauthorized → 401 `TOPIC_NOT_ALLOWED`.
3. `x-amz-sns-message-type` header / body Type cross-check (Stripe's pattern).
4. `SnsVerifier.verify(envelope)` — RSA verify before ANY further processing.
5. `SubscriptionConfirmation`: GET the `SubscribeURL` only when its host matches the SigningCertURL host AND that cert URL is itself allowlisted. Pins subscription confirmation to the AWS SNS endpoint — an attacker who steals the topic ARN can't redirect us to their own confirmation endpoint.
6. `Notification`: `parseSesFeedbackPayload` → upsert into `email_suppression`. The conflict-resolution `CASE` upgrades severity (complaint > bounce_permanent > bounce_transient) and clears `expires_at` for permanent reasons; never downgrades a complaint back to a transient bounce.

### Scheduled trial-ending + dunning planner — `billing/scheduled-emails-pure.ts`

Pure functions that take a snapshot of subscriptions + an `appUrl` + a clock, return the list of `EmailPlan` rows to send.

- `planTrialEndingEmails` — selects subs in `trialing` whose `trial_end` is within 7 days. Picks the SMALLEST window from `[1, 3, 7]` so urgency increases as trial approaches end. Idempotency key: `trial-<orgId>-w<window>-d<dayBucket>`.
- `planDunningEmails` — selects subs in `past_due`. Idempotency key: `dunning-<orgId>-d<today>` so daily re-runs are no-ops.

**15 unit tests**: `it.each` matrix of `daysLeft → window` mapping, status filtering, contact-email null-skip, idempotency-key bucketing.

### Orchestrator script — `scripts/send-billing-emails.ts`

Reads the candidate set from DB (cross-tenant admin scan), passes through the pure planners, sends each plan via the `EmailService` with the deterministic idempotency keys. `--dry-run` prints the plan without sending. Uses `LoggingEmailClient` when `SES_REGION` is unset; the production `SesV2EmailClient` when SES env is wired.

`npm run billing:emails`.

### EventBridge schedule

`infra/terraform/scheduled-tasks.tf` adds the third email-related cron:

| Schedule | Frequency | Script |
|---|---|---|
| `billing-emails` | `cron(30 12 * * ? *)` (daily 12:30 UTC = 08:30 ET) | `scripts/send-billing-emails.ts` |

Prod-only by default. Runs ~30 min before the renewal-motion cron so trial-ending notifications precede the CSM tickler.

### Module wiring

`EmailModule.forRoot({ ..., feedbackAllowedTopicArns })` registers `SnsVerifier` + `SesFeedbackController`. `AppModule` reads `SES_FEEDBACK_TOPIC_ARNS` (comma-separated) from env.

## Hard constraints honored (no corner cutting)

- **Cert URL allowlist runs BEFORE the fetch.** Even with valid SNS-shaped JSON, a malicious envelope pointing at `attacker.com/cert.pem` is rejected without ever issuing the request.
- **Subdomain + suffix attack patterns are explicitly tested**: `evil.sns.us-east-1.amazonaws.com` and `sns.us-east-1.amazonaws.com.attacker.com` both fail the regex.
- **Topic ARN allowlist is mandatory.** Empty allowlist (default) → no notifications accepted. Production must set `SES_FEEDBACK_TOPIC_ARNS`.
- **SubscribeURL pinning** to the SigningCertURL host stops an attacker who somehow gets a valid AWS cert but tries to redirect us to a different host's confirmation endpoint.
- **Suppression upgrades, never downgrades.** Once an address is `complaint`, no follow-up `bounce_transient` can clear it. SQL `CASE` enforces the ordering.
- **Permanent bounces + complaints have NULL `expires_at`** — never auto-clear.
- **Idempotency keys are deterministic functions of (orgId, day-bucket, window).** Cron retries within a day are byte-identical → `EmailService` returns `duplicate`. Different days → different key → fresh send.
- **Trial windows are sorted ascending** so `find` picks the smallest, not the largest. This was a real bug caught by the test matrix (originally `[7,3,1]` would pick window=7 for daysLeft=1 because `1<=7` matches first).
- **`SubscriptionConfirmation` only auto-confirms** when the topic ARN is in the allowlist AND the cert URL is allowlisted AND the SubscribeURL host matches. Three layers must all pass.
- **`SnsVerifier` constructor params are `@Optional()`** — Nest DI happily resolves the service without consumer-side providers (the OpenAPI export script previously hit this trap; the SES wiring would have repeated it).

## Bug caught + fixed during this session

1. **`TRIAL_WINDOWS = [7, 3, 1]` was wrong order.** `find(daysLeft <= w)` against `[7,3,1]` always picked `7` because `1 <= 7` matches first. Fixed to `[1, 3, 7]` so the smallest matching window wins. The test matrix caught it on first run.
2. **`SnsVerifier` constructor had non-injectable defaults** (functional types `fetchImpl?: ...` and `nowFn?: () => number`). Same Nest DI silent-crash pattern as Phase 12 — broke `npx ts-node scripts/export-openapi.ts` with EXIT=1. Made both `@Optional()` with explicit field assignment in the constructor body.

## What's deliberately NOT in Phase 18

- **Live stage SES smoke send + bounce simulation.** Manual ops + the AWS SES Mailbox Simulator. Scripted in Phase 19.
- **`email_suppression` admin endpoints** (list/clear). Break-glass via SQL today; admin UI surface deferred.
- **Welcome email send hook on `customer.subscription.created`.** Templates exist (Phase 17); the BillingService event-apply path is the natural injection point. Phase 19 candidate.
- **First dress rehearsal pass + first prod cutover.** Manual ops + GTM milestones, not code work.
- **SNS region-specific cert pinning.** Today the host allowlist allows any AWS-region cert URL. Pin per region in Phase 19 once we know which regions we operate in.

## Cumulative state at end of Phase 18

| Metric | P15 | P16 | P17 | **P18** |
|---|---|---|---|---|
| SQL migrations | 14 | 15 | 16 | **16** |
| Backend modules | 28 | 29 | 30 | **30** |
| Backend test suites | 40 | 41 | 43 | **45 (+2)** |
| Backend tests | 380 | 396 | 421 | **456 (+35)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 417 | 433 | 458 | **493** |
| HTTP endpoints | ~32 | ~34 | ~36 | **~37 (+/v1/internal/ses-feedback)** |
| `docs/openapi.json` paths | 37 | 39 | 40 | **41** |
| Scheduled tasks (TF) | 2 | 3 | 3 | **4 (+billing-emails)** |
| Email templates | 0 | 0 | 4 | **4** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 45 / 456
npx ts-node scripts/export-openapi.ts             # 41 paths

# Stage rehearsal: dry-run the daily email plan
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run billing:emails -- --dry-run

# Configure SNS feedback (production)
$env:SES_FEEDBACK_TOPIC_ARNS = "arn:aws:sns:us-east-1:123:br-prod-ses-feedback"
# AWS SNS is configured to POST to https://api.example.com/v1/internal/ses-feedback
```

Phase 19 (live stage SES smoke + bounce simulator + welcome email send hook + admin suppression-list endpoints + first dress rehearsal + first prod cutover) on `continue`.
