# Phase 21 — RFC 8058 List-Unsubscribe Headers, Launch-Readiness + Post-Launch Runbooks

## Done — verified by passing tests this session

`npx tsc --noEmit` (backend) → **0 errors.**
`npx jest --ci` (backend) → **47 suites / 468 tests / 0 failures (~28s).**
`npx ts-node scripts/export-openapi.ts` → **44 paths** in `docs/openapi.json`.

**Combined: 51 unit-test suites / 505 tests, all green.** This phase adds **+1 suite / +5 tests**.

The phase ships RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers — the bits that turn the unsubscribe footer into a native "Unsubscribe" button next to the sender in Gmail, Apple Mail, and Outlook. Plus the two runbooks that gate the first prod cutover (launch-readiness checklist) and define the first 30 post-launch days (post-launch playbook).

## What landed

### `EmailMessage.headers` + SES wire-up

`backend/src/email/email-types.ts`:

```ts
export interface EmailHeader { name: string; value: string }
export interface EmailMessage {
  // ... existing fields ...
  headers?: EmailHeader[];
}
```

`backend/src/email/ses-v2-email-client.ts`:

- When `msg.headers` is present, the SES SendEmail body includes `Content.Simple.Headers: [{ Name, Value }]` with the AWS-spec capitalized property names. When absent, the Headers field is omitted entirely (cleaner than sending `[]` which AWS handles but the request payload should reflect intent).

### `buildListUnsubscribeHeaders(unsubscribeUrl)` in `EmailService`

Exported pure function. Returns the two RFC 8058 headers:

```
List-Unsubscribe: <https://app.example.com/v1/u/TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

URL is wrapped in `<angle brackets>` per RFC. We deliberately omit the `mailto:` alternative — keeping the surface to one verb (HTTPS) limits attack surface and matches our redeem endpoint. Gmail / Apple Mail / Outlook all accept the URL-only variant.

`EmailService.send` and `EmailService.retryFailedSend` both build the headers when `unsubscribeSecret` + `unsubscribeBaseUrl` are configured; both pass them to `EmailClient.send`. URL is regenerated per-recipient + per-call (matching the per-recipient signed-token design from Phase 20).

### Path correction: `/u/<TOKEN>` → `/v1/u/<TOKEN>`

Phase 20 wrote the unsubscribe URL as `<base>/u/<token>`, but the controller is registered at `@Controller('v1/u')`. So the URL was a path mismatch — links would have 404'd. Fixed both call sites (`send` + `retryFailedSend`) to write `/v1/u/<token>`. Caught while wiring the headers. (No live email had been sent yet, so no real customers were affected — but had we cut over without this fix, every footer link would have been broken.)

### Tests — 5 new

`src/email/__tests__/list-unsubscribe.spec.ts`:

1. `buildListUnsubscribeHeaders` produces both headers in the documented shape.
2. Token-with-dot-separator passes through inside angle brackets unchanged (verifies the `[A-Za-z0-9._~-]+` URL char class).
3. SES client OMITS `Headers` when none supplied (clean payload).
4. SES client INCLUDES `Headers: [{ Name, Value }]` with capitalized AWS property names when supplied (verifies SES wire-format conformance).
5. SES client preserves header order and forwards arbitrary custom headers (e.g., `X-Tenant-Cohort`).

### Launch-Readiness gates — `docs/RUNBOOKS/launch-readiness.md`

Two-stack readiness model:

**Infrastructure** (A1–A7):
- A1 Stage SES smoke green
- A2 Stage Stripe smoke green
- A3 Stage cutover dress rehearsal pass
- A4 CI / OpenAPI gates green
- A5 Production infra parity (migrations, seeds, RLS, Datadog, EventBridge schedules ENABLED)
- A6 Backups verified by restore-to-staging
- A7 Pen test report + SOC 2 Type 1 issued

**Commercial** (B1–B6):
- B1 Sub-processor BAAs
- B2 Customer agreements (MSA + BAA + DPA + Order Form)
- B3 Insurance bound (cyber, E&O, general liability)
- B4 AMA + CMS license tokens in prod Secrets Manager
- B5 State privacy notices (Privacy Center, WMHMDA, Colorado AI Act)
- B6 Counsel sign-off (FDA CDS exemption memo, AKS/Stark/FCA review)

**Authority + clock**: 2/3 approval (CTO + CEO + Compliance) required to flip any gate from red to green. If a gate flips red post-scheduling, cutover is **paused, not slipped**.

### Post-Launch Playbook — `docs/RUNBOOKS/post-launch-playbook.md`

Day-by-day cadence T+0 → T+30:

| Day | Focus |
|---|---|
| T+0 | 2-hour cutover monitoring window |
| T+1 | First-tenant onboarding call; welcome email verified end-to-end; CloudTrail/RDS audit logs flowing |
| T+2 | Backup restore-to-staging smoke |
| T+3 | First synthetic 835 ingested; `email_send` review for unknown failure classes |
| T+5 | Weekly digest email round-trip with end-to-end List-Unsubscribe verification |
| T+7 | Cutover retrospective; Stripe `billing_event` review for unhandled types |
| T+14 | GA-launch retro published; tenant T+14 NPS ≥ 50; first case study draft |
| T+30 | 90-day review prep; cost-vs-forecast review; pen-test re-engagement scheduled |

**Daily metrics snapshot** to `#release-launch` covers lookup p95, error rate, email send success, dead-letter count, hallucination eval, tenant NPS, P0/P1 count.

**Roll-forward criteria** for design-partner #2 are explicit: T+14 retro signed off, no P0 in 14 days, tenant NPS ≥ 50, SOC 2 evidence flowing, cost within 50% of forecast.

**What we DON'T do** in the first 30 days: refactor live paths, add specialty packs, change pricing, onboard #2.

## Hard constraints honored (no corner cutting)

- **Per-recipient unsubscribe token in headers AND footer.** Same token, same URL, same TTL — but generated fresh per `EmailService.send` call. No shared tokens across recipients.
- **List-Unsubscribe URL is HTTPS-only.** `mailto:` isn't included. We have one redeem endpoint + one threat model; no point opening a second.
- **List-Unsubscribe-Post header makes the click idempotent.** Gmail's pre-fetch protection (`google-bot` URL probing for spam classification) sees the POST header and respects it; our `POST /v1/u/:token` is idempotent at the suppression-list UPSERT layer.
- **`Content.Simple.Headers` exact AWS shape**: capitalized `Name`/`Value` properties. Tested by serializing the actual JSON body and asserting key shape.
- **Path mismatch caught + fixed before any live send.** `/u/` → `/v1/u/` on both EmailService send + retry paths.
- **Launch-readiness is two-stack** (infra + commercial), not a flat list. Engineering can't override commercial gates and vice versa; both Compliance + CTO must sign every gate.
- **Cutover is paused-not-slipped on red.** A gate that flips red after scheduling doesn't slide the date by a fixed delta — it stops the clock until the same 2/3 approval flips it green.
- **Post-launch playbook caps the first 30 days at one tenant.** No design-partner #2 onboarding compounds risk on a wobbly base. The roll-forward criteria are explicit.
- **Daily metric snapshot is one-row-per-day**, not a stream. Signal over noise; ops sees the trend, not every event.

## Bug caught + fixed during this session

- **Unsubscribe URL path mismatch from Phase 20**. Footer rendered `<base>/u/<token>` but the controller is at `/v1/u/<token>`. Fixed in both `EmailService.send` + `retryFailedSend` while wiring the new headers (since the headers carry the same URL). Would have produced 404s on every live unsubscribe click had we cut over without this fix.

## What's deliberately NOT in Phase 21

- **`mailto:` List-Unsubscribe alternative.** RFC 5322/2369 supports it; we don't implement it. Reasoning: a `mailto:` triggers a reply that arrives at our inbound MX (which we don't operate today). HTTPS-only redeem keeps the surface tight.
- **Custom List-Id / Feedback-Loop headers** for ISP-specific signal-strengthening. AWS SES handles FBL out-of-band via the configuration-set feedback topic.
- **Live first prod cutover** itself. The runbook + readiness gates are in place; cutover is the operational step.
- **First design-partner reference call.** Listed in T+14 / T+30 cadence but doesn't ship as code.

## Cumulative state at end of Phase 21

| Metric | P18 | P19 | P20 | **P21** |
|---|---|---|---|---|
| SQL migrations | 16 | 16 | 17 | **17** |
| Backend modules | 30 | 30 | 30 | **30** |
| Backend test suites | 45 | 45 | 46 | **47 (+1)** |
| Backend tests | 456 | 456 | 463 | **468 (+5)** |
| Extension tests | 30 | 30 | 30 | **30** |
| Lambda PHI scrubber tests | 7 | 7 | 7 | **7** |
| **Combined unit tests** | 493 | 493 | 500 | **505** |
| HTTP endpoints | ~37 | ~40 | ~41 | **~41** |
| `docs/openapi.json` paths | 41 | 43 | 44 | **44** |
| Scheduled tasks (TF) | 4 | 4 | 5 | **5** |
| Runbooks | 7 | 7 | 7 | **9 (+launch-readiness, +post-launch)** |
| TypeScript errors | 0 | 0 | 0 | **0** |

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit                             # 0 errors
npx jest --ci                                # 47 / 468
npx ts-node scripts/export-openapi.ts        # 44 paths

# Inspect a rendered email (LoggingEmailClient writes to logs):
npm run billing:emails -- --dry-run
# When SES_REGION is set, the wire body includes Content.Simple.Headers
# with the List-Unsubscribe + List-Unsubscribe-Post entries.
```

Phase 22 (first dress rehearsal pass + first prod cutover + first paying tenant onboarded) on `continue`.
