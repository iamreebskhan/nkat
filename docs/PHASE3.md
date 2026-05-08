# Phase 3 — Reconciliation, Drift Alerts, Webhooks, Disputes

## Done — verified by passing tests this session

`npx tsc --noEmit` → **0 errors.**
`npx jest --ci` → **22 test suites, 181 tests, 0 failures, ~17s wall clock.**

This phase ships the **reconciliation core (Job 2 from the plan)** plus the
infrastructure that makes a multi-tenant SaaS retention curve actually work:
drift detection on finalized rulebooks, signed webhook delivery, customer
dispute workflow, and a 90-day re-verification scheduler for analyst
attestations.

## New schema (db/migrations/0009_reconciliation_alerts_webhooks.sql)

| Table | Purpose | RLS |
|---|---|---|
| `client_doc_upload` | Tenant-scoped raw upload provenance + redacted text | tenant |
| `redaction_event` | Append-only PHI redaction audit (counts only — never the redacted strings) | tenant |
| `webhook_subscription` | Per-org webhook endpoints + signing secret | tenant |
| `webhook_delivery` | Persistent retry queue for HMAC-signed deliveries | tenant |
| `attestation_reverification` | 90-day re-verify schedule for analyst-attested rules | global |

Plus a unique partial index ensuring at most one *pending* re-verification
per `payer_rule` at a time.

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `redaction/redactor.ts` | Pure-function PHI redactor v1 (regex-based; ICN/MRN/Member/DOB/Phone/Email/SSN/Name) | 18 |
| `redaction/redaction.service.ts` | Persists redacted text + appends `redaction_event` audit | — |
| `redaction/redaction.module.ts` | Wiring | — |
| `reconciliation/diff-engine.ts` | Pure function `computeDiff(authoritative, client) → DiffSet` with stable integrity_hash | 11 |
| `reconciliation/reconciliation.service.ts` | createRulebook, computeDiff, decide, finalize (RLS-scoped) | — |
| `reconciliation/reconciliation.controller.ts` | `/v1/reconciliation/{rulebooks,decisions,...}` | — |
| `reconciliation/reconciliation.module.ts` | Wiring | — |
| `alerts/drift-detector.ts` | Pure function `detectDrift(rulebook_id, baseline, current) → DriftAlert[]` | 10 |
| `webhooks/signing.ts` | HMAC-SHA256 signing + verification with timestamped replay protection | 13 |
| `webhooks/webhook.service.ts` | enqueue → backoff queue → deliver via injectable fetch | 5 |
| `webhooks/webhook.module.ts` | Wiring | — |
| `disputes/dispute.service.ts` | submit/resolveRight/resolveWrong (latter spawns extraction_candidate at priority 95) | — |
| `disputes/dispute.controller.ts` | `/v1/disputes/{,:id/resolve-right,:id/resolve-wrong}` | — |
| `disputes/dispute.module.ts` | Wiring | — |
| `reverification/reverification.service.ts` | schedule, listDue, markOverdue, markCompleted (auto-reschedules +90d) | 4 |
| `reverification/reverification.module.ts` | Wiring | — |
| `scripts/reverification-mark-overdue.ts` | Cron-friendly CLI; flips pending past-due to `overdue` | — |

`app.module.ts` wires all four new modules + the redaction module +
reconciliation alongside the Phase 1/2 set.

## Highlights

### Diff engine — deterministic + stable integrity_hash

`computeDiff(authoritative, client)` returns one of four outcomes per
`(payer, state, product_line, code, attribute)` key:
- `aligned`
- `conflicting` (with `field_diffs[]` listing which value fields disagree, plus a synthesized `coverage_status` field if the status differs)
- `missing_in_client`
- `missing_in_authoritative`

The `integrity_hash` is FNV-1a over a canonical fingerprint of every entry
(outcome | key | sorted field_diffs). Tested to be stable regardless of
input order, and tested to change when outcome distribution changes —
critical for the rulebook-finalize integrity guarantee.

### Drift detector — alerting transitions

`detectDrift(rulebook_id, baseline, current)` returns `DriftAlert[]` for
every key whose outcome (or `field_diffs`) shifted between snapshots,
EXCEPT resolutions to `aligned` (those don't alert; UI marks them as
auto-resolved).

| Transition | Severity |
|---|---|
| `aligned` → `conflicting` | **critical** |
| `aligned` → `missing_in_authoritative` (rule retired) | **critical** |
| `missing_in_client` → `conflicting` | high |
| `conflicting` → `conflicting` (new field_diffs) | high |
| `aligned` → `missing_in_client` | medium |
| `absent` → `missing_in_client` (new auth rule) | medium |
| any → `aligned` (resolution) | _no alert_ |

### Webhook signing + delivery

- Signature header: `X-Signature: sha256=<hex>` over `<timestamp>.<canonical_json_body>`.
- 5-minute replay-protection tolerance (configurable; tested).
- `canonicalJson` recursively sorts keys so `{a,b}` and `{b,a}` produce identical signatures (tested).
- `verifySignature` uses `timingSafeEqual` from `node:crypto` — no early returns on mismatch.
- Retry schedule: 0s → 1m → 5m → 15m → 1h → 6h → 24h → 24h, then `dead_letter`. Tested monotonic + clamp-at-end.
- Atomic claim using `SELECT … FOR UPDATE SKIP LOCKED` so two delivery workers can't pick the same row.

### PHI redaction v1

8 categories: SSN, MRN, Member ID, DOB, Phone, Email, ICN/Claim Control Number, Patient Name.

**Critical ordering**: labelled patterns (ICN/MRN/Member/DOB/Name) run BEFORE
unanchored ones (phone/SSN). Without that, the unanchored phone regex would
eat 10-digit runs out of labelled claim numbers — a real bug we caught
during the test run and fixed before this phase shipped.

The `MEMBER_LABELED` pattern explicitly does NOT accept bare `patient` as a
label (only `patient id`) so `Patient: John Smith` parses as a name, not a
member id.

Audit guarantee: `redaction_event` records only category counts and totals.
The redacted strings themselves are never written to the audit row — verified
by schema review (no `value` column) and by leaving an explicit comment in
the migration.

### Dispute workflow

Customer submits → `rule_dispute` row (RLS-scoped to their org). Analyst:
- `resolveRight` → marks dispute resolved, our rule stands.
- `resolveWrong` → creates an `extraction_candidate` at **priority 95** so it floats to the top of the analyst queue, links the dispute via `resulting_candidate_id`. Then the standard accept/reject/edit flow takes over and supersedes the wrong rule.

### 90-day re-verification

Every analyst-attested `payer_rule` should be re-verified every 90 days
(matches the moat-building "we get sharper over time" plan). Service
exposes:
- `schedule(payer_rule_id)` — opens a row 90 days out.
- `listDue()` — pending rows whose `reverify_by <= today`.
- `markOverdue()` — flips past-due pending → overdue.
- `markCompleted(reverification_id, by)` — closes current + auto-schedules the next 90-day cycle.

CLI for daily cron:
```powershell
npm run reverification:mark-overdue
```

A unique partial index `attestation_reverification_one_open_per_rule` keeps
the queue from getting polluted with duplicates.

## Cumulative state at end of Phase 3

| Metric | After Phase 1 | After Phase 2 | After Phase 3 |
|---|---|---|---|
| SQL migrations | 7 | 8 | **9** |
| Backend modules | 11 | 14 | **18** |
| Test suites | 12 | 16 | **22** |
| Passing tests | 84 | 117 | **181** |
| Test wall clock | ~50s | ~19s | ~17s |
| TypeScript errors | 0 | 0 | **0** |

## Hard constraints honored (no corner cutting)

- **PHI redaction is auditable but never re-leaks PHI.** The `redaction_event` audit captures category counts only; the redacted text is stored only in `client_doc_upload.redacted_text`, never the original.
- **Append-only audit everywhere.** Every dispute resolution adds a new row (no UPDATE on the customer's submitted assertion). Every diff finalization writes a new `client_rulebook` row. Every analyst decision in Phase 2 still appends a new `extraction_decision`.
- **Webhook signature uses constant-time comparison.** `crypto.timingSafeEqual` on equal-length buffers; mismatched-length signatures fail without leaking timing.
- **Webhook replay protection.** Timestamp drift > 5 minutes (configurable) fails verification regardless of correct signature.
- **Webhook claim is atomic.** `SELECT FOR UPDATE SKIP LOCKED` inside the dispatch transaction; two workers can never deliver the same row twice.
- **Diff integrity_hash is stable.** Sorted entry list + FNV-1a fingerprint; verified by ordering-independence test.
- **Drift detector ignores resolutions.** Alerts only fire on genuine divergence; resolution is a UI status update, not a notification storm.
- **One pending re-verification per rule.** `UNIQUE … WHERE status='pending'` partial index enforces at the DB level; an analyst can't accidentally schedule a duplicate.
- **All Phase 3 endpoints behind `AuthGuard`.** UUID validation at every trust boundary. `runWithTenant` for every tenant-touching DB path.

## What's deliberately NOT in Phase 3

- **PDF parser for client doc uploads.** The schema accepts pre-extracted text via `client_doc_upload.redacted_text`. A real PDF/DOCX parser (PyMuPDF + Tabula via a sidecar) lands in Phase 3.5.
- **Comprehend Medical / Presidio integration.** Phase 3 ships regex-only redaction (v1.0.0). The contract — input text → redacted text + category counts — stays the same when we swap.
- **Email delivery (alerts → SES).** Webhooks land first because they're a clean contract. Email needs the AWS BAA work.
- **Browser extension.** Separate codebase; manifest v3 + React. Plan-3 line item.

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit            # 0 errors
npx jest --ci               # 181 tests pass in ~17s
```

End-to-end (Docker required):

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform
.\db\apply.ps1              # applies all 9 migrations + 7 seed files
cd backend
npm run start:dev

# Open a draft rulebook (auth header for dev mode):
$ORG = '11111111-1111-4111-8111-111111111111'
$CLIENT = '22222222-2222-4222-8222-222222222222'
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/v1/reconciliation/rulebooks `
  -Headers @{ 'X-Org-Id' = $ORG } `
  -ContentType 'application/json' `
  -Body (@{ client_id = $CLIENT; notes = 'Q2 review' } | ConvertTo-Json)

# Get the diff:
Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/reconciliation/rulebooks/$RULEBOOK_ID/diff" `
  -Headers @{ 'X-Org-Id' = $ORG }

# Daily cron — flag overdue re-verifications:
npm run reverification:mark-overdue
```

Phase 4 (NC + SC payers + behavioral health + 42 CFR Part 2 SUD consent +
SNPs + CCM/RPM/RTM specialty pack + Athena Marketplace partner application)
on `continue`.
