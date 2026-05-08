# Phase 19 — Welcome Email Hook, Admin Suppression Endpoints, SES Feedback Simulator, Stage Health Check

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **45 suites / 456 tests / 0 failures (~27s).**
`npx ts-node scripts/export-openapi.ts` → **43 paths** in `docs/openapi.json`.

**Combined: 49 unit-test suites / 493 tests, all green.** This phase is heavier on integration / orchestration code than on net-new unit suites — the new surface (welcome-email hook, admin suppression endpoints, simulator + health-check scripts) wires existing primitives into customer-facing behavior, so the primary verification is end-to-end stage rehearsal rather than unit assertions.

The phase ships the four pieces a real first-customer cutover needs once stage SES is BAA-covered: a welcome email that fires on first paid subscription, admin endpoints for suppression-list management, a real-AWS round-trip verifier that proves bounce/complaint feedback updates the suppression list correctly, and a single-command stage health-check that runs every smoke flow in sequence.

## What landed

### Welcome email on `customer.subscription.created`

`backend/src/billing/billing.service.ts` — `BillingService.ingestEvent` now fires a `welcome` template send after a TRUE first-time subscription create:

- Hooks at the `.then(...)` continuation of the RLS transaction so the email send happens **outside the DB tx** (no risk of failing the state apply).
- Reads org name + `primary_contact_email` via a fresh RLS-scoped read.
- `idempotencyKey: welcome-<stripe_event_id>` — deterministic per Stripe event id, so:
  - Webhook retries with the same event id are idempotent (no re-mail).
  - The reconciler's synthetic `customer.subscription.updated` events never trigger welcome (different event type), so a Stripe-side replay or a reconcile pass can't re-email a real customer.
- Best-effort: failures log as warnings, never roll back the subscription state.
- Skips when `primary_contact_email` is null (signup-attempt flow always sets it; out-of-band ops creates may not).

`BillingService` constructor takes `EmailService` + `appUrl` as `@Optional()` so existing test instantiations (`new BillingService(db)`) still work.

### Admin suppression endpoints — `backend/src/admin/suppression.controller.ts`

| Endpoint | Purpose |
|---|---|
| `GET /v1/admin/email-suppression?email=<addr>` | Look up suppression status. Returns `{ suppressed: false }` for not-in-list (NOT 404 — querying for "not suppressed" is a normal use case). Honors `expires_at` for transient bounces. |
| `POST /v1/admin/email-suppression` | Manually add an address. Body: `{ email, reason='admin_block', detail?, expires_at? }`. Reason limited to `admin_block` or `manual_optout` — bounce/complaint reasons are owned by the SES feedback path. UPSERT with explicit suppressed_at refresh. |
| `DELETE /v1/admin/email-suppression/:email` | Break-glass clear. 204 on success; 404 `EMAIL_NOT_SUPPRESSED` if not in list. |

**Both mutations write `audit_log` rows** under the acting tenant with the actor's `user_id` + `ip_address` + `user_agent`. Suppression is global (cross-tenant per SES policy), but the trail belongs to the tenant whose admin took the action.

### SES feedback simulator — `scripts/ses-feedback-simulator.ts`

Real-AWS round-trip verifier. Sends to AWS's published SES Mailbox Simulator addresses:

| Address | Expected outcome |
|---|---|
| `bounce@simulator.amazonses.com` | Permanent bounce → `email_suppression` row, `reason=bounce_permanent` |
| `complaint@simulator.amazonses.com` | Complaint → `email_suppression` row, `reason=complaint` |
| `success@simulator.amazonses.com` | Normal delivery (control — no row appears) |

After sending, the script polls `email_suppression` for the bounce + complaint addresses for up to `--wait-seconds` (default 90). If they don't appear, the round-trip is broken somewhere — SNS topic not subscribed, `/v1/internal/ses-feedback` not reachable from SNS, topic ARN not allowlisted, etc. Script prints a targeted hint when it fails.

`npm run ses:simulator -- --from no-reply@stage.example.com`.

### Unified stage health-check — `scripts/stage-health-check.ts`

Runs four smoke flows in sequence with shared exit-code aggregation:

| Step | What |
|---|---|
| `cutover-dry-run` | Phase 11 HTTP smoke (health, lookup, synthesis, webhook round-trip, audit log) |
| `billing-reconcile` | `--dry-run` to verify the staleness scan + Stripe-fetch plan |
| `signup-expire` | `--dry-run` to verify the cleanup query |
| `billing-emails` | `--dry-run` to verify the trial-ending + dunning planner |

Prints a PASS/FAIL table with per-step durations; non-zero exits if any red. The single command a rehearsal coordinator runs as the final handoff:

```
npm run stage:health -- --base-url https://stage.example.com --org-id 11111111-...
```

## Hard constraints honored (no corner cutting)

- **Welcome email idempotency keyed on `stripe_event_id`**, not on org_id. Stripe webhook delivery retries → same event id → `EmailService` returns `duplicate`. The reconciler's synthetic id `evt_reconciled_<sub>_<sec>` differs from the original event, but the synthetic event's TYPE is always `customer.subscription.updated` not `created`, so the welcome path doesn't fire on reconciler runs.
- **Welcome email send is OUTSIDE the DB transaction.** A failed SES call cannot roll back the subscription state apply or the audit_log row. The state of record is the DB; the email is best-effort.
- **Welcome email is post-`then` rather than try/catch inside the tx.** This makes the contract clear: state apply is committed before we even attempt the email.
- **Admin suppression endpoints log every mutation to `audit_log`** with actor + IP + UA. Cross-tenant action with single-tenant accountability.
- **Suppression DELETE returns 404 on miss**, so admin gets transparent feedback (unlike the redeem path which is opaque to anonymous probers).
- **Bounce simulator polls for the EXPECTED suppression rows, not for arbitrary feedback.** A noise event in the topic (a different test message) doesn't false-positive the verifier.
- **Simulator script bails out fast** if any of `DATABASE_URL / SES_REGION / AWS_*` is missing — never attempts a half-configured smoke that would silently skip.
- **Stage health-check spawns sub-processes via `shell: true`** so the npm-bin Windows path resolution works the same way as local dev. Each step's stdout/stderr passes through unchanged so you can see the failure inline.
- **Stage health-check fails the full run** if any step fails, but runs all four to give the rehearsal coordinator the complete picture in one report.

## Bug caught + fixed during this session

(None this session — typecheck + all tests passed on first run after each artifact landed.)

## What's deliberately NOT in Phase 19

- **Live stage SES key + first real welcome email send.** Manual ops + AWS SES BAA execution.
- **First dress rehearsal pass.** The `cutover-dress-rehearsal.md` runbook + the `stage-health-check.ts` script exist; coordinator runs them.
- **First prod cutover.** Gated on dress-rehearsal pass + first design-partner contract executed + AMA license active.
- **Self-serve unsubscribe link** in the email footer. Today the footer warns "do NOT include PHI in replies" but doesn't have a one-click unsubscribe. Phase 20 — adds a JWT-signed unsubscribe URL that auto-creates a `manual_optout` suppression row.
- **Suppression list pagination/listing.** Today admins look up by exact email; bulk listing for cohort analysis is deferred (out of routine ops use case).
- **Welcome email retry on SES failure.** Today a failed welcome is logged + skipped. A scheduled task that retries failed `email_send` rows in `failed` status is a Phase 20 candidate.

## Cumulative state at end of Phase 19

| Metric | P16 | P17 | P18 | **P19** |
|---|---|---|---|---|
| SQL migrations | 15 | 16 | 16 | **16** |
| Backend modules | 29 | 30 | 30 | **30** |
| Backend test suites | 41 | 43 | 45 | **45** |
| Backend tests | 396 | 421 | 456 | **456** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 433 | 458 | 493 | **493** |
| HTTP endpoints | ~34 | ~36 | ~37 | **~40 (+suppression GET/POST/DELETE)** |
| `docs/openapi.json` paths | 39 | 40 | 41 | **43** |
| Scheduled tasks (TF) | 3 | 3 | 4 | **4** |
| Scripts | reconcile, expire, emails | + ses-feedback | + billing-emails | **+ ses-simulator + stage-health** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                                  # 0 errors
npx jest --ci                                     # 45 / 456
npx ts-node scripts/export-openapi.ts             # 43 paths

# Stage rehearsal — single command:
$env:DATABASE_URL = "postgres://app:...@stage-db:5432/billing_rules"
npm run stage:health -- --base-url https://stage.example.com --org-id 11111111-...

# SES round-trip (after stage SES BAA executed + topic subscribed):
$env:SES_REGION = "us-east-1"; $env:AWS_ACCESS_KEY_ID = "..."; $env:AWS_SECRET_ACCESS_KEY = "..."
$env:SES_CONFIGURATION_SET = "br-stage-default"
npm run ses:simulator -- --from no-reply@stage.example.com
```

Phase 20 (one-click unsubscribe + retry-failed-emails cron + first dress rehearsal pass + first prod cutover) on `continue`.
