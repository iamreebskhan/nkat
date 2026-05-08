# Phase 2 — 835 ERA + Denial Intelligence + Analyst Review Queue

## Done — verified by passing tests this session

`npm test` → **16 test suites, 117 tests, 0 failures, ~19s wall clock.**
`npx tsc --noEmit` → **0 errors.**

This phase closes the **denial-intelligence feedback loop**: the platform now
ingests 835 ERA files, matches each line back to the `payer_rule` row that
should have prevented denial, and exposes a tenant-scoped denial dashboard
("did our pre-flight catch this denial? what did it cost us?").

It also stands up the **analyst review queue** — every machine-extracted
proposed rule waits in `extraction_candidate` until an analyst clicks accept,
reject, or edit, and the corresponding `payer_rule` is only inserted on
accept. Append-only `extraction_decision` audit trail.

## New schema (db/migrations/0008_extraction_queue.sql)

| Table | Purpose | RLS |
|---|---|---|
| `extraction_candidate` | Proposed payer_rule pending analyst review (status: queued/claimed/accepted/rejected/edited) | global |
| `extraction_decision` | Append-only audit of analyst actions on candidates | global |
| `rule_dispute` | Customer-submitted "this rule is wrong" reports; flow back into queue | tenant (RLS) |

Plus `app.touch_updated_at()` trigger and an `updated_at` trigger on
`extraction_candidate`.

## New backend modules

| Path | Purpose | Tests |
|---|---|---|
| `ingestion/era835/types.ts` | Typed `Era835File`, `Era835Claim`, `Era835ServiceLine`, `Era835Adjustment` | — |
| `ingestion/era835/parser.ts` | X12 835 parser; auto-detects delimiters from ISA; PHI-safe (drops names) | 19 |
| `ingestion/era835/ingestor.ts` | Persists parsed records to `era_835_record`; matches expected `payer_rule`; idempotent per (org, claim_id, dos, code) | 7 |
| `ingestion/era835/era835.controller.ts` | `POST /v1/era835/upload` (RLS-protected) | — |
| `ingestion/era835/era835.module.ts` | Wiring | — |
| `denial/denial.service.ts` | `topByCarc`, `catchRate`, `trendByDay` aggregations over tenant 835 data | 3 |
| `denial/denial.controller.ts` | `GET /v1/denials/{top,catch-rate,trend}?days=30` | — |
| `admin/extraction-queue.service.ts` | `enqueue`, `nextBatch`, `claim`, `accept`, `reject`, `edit` | 5 |
| `admin/extraction-queue.controller.ts` | `GET /v1/admin/extraction-queue/next`; `POST .../{claim,accept,reject,edit}` | — |
| `scripts/ingest-era835-batch.ts` | CLI for bulk loading 835 files for one tenant | — |

## What the 835 parser handles

Tested by 19 specs against a real-shaped fixture (`test/fixtures/sample-835.txt`):

- Auto-detects element/sub-element/segment delimiters from the ISA header
- Parses `BPR` (payment), `TRN` (trace), `N1` (payer/payee), `CLP` (claim), `CAS` (adjustments — multi-triplet), `NM1*QC` (patient — only stores member id, never name), `DTM*472` (service date), `SVC` (service line + modifiers + revenue code), `LQ*HE` (RARC remarks)
- Tolerates CRLF whitespace between segments
- Tolerates files that end without IEA (preserves the last claim)
- Returns 0 for non-numeric amount fields (no throws)
- Skips malformed CAS group codes silently — they end up in `unparsed_segments` for debugging
- Multiple CAS triplets per segment: 6+ codes per CAS handled
- Custom delimiters (e.g. `|` element, `#` segment) work

Two PHI guarantees enforced by tests:
1. `NM1*QC` patient name fields (last/first/middle) are never stored.
2. The patient external id (member id) is the *only* PHI-adjacent field captured, and the spec asserts no name fragments leak into the output JSON.

## What the ingestor does

`Era835Ingestor.ingest(tx, file, ctx)` — caller MUST open `runWithTenant`
first so RLS applies.

For each parsed claim line:
1. Resolve `payer_id` by matching the 835's payer name to a known `payer.name`. (NULL on no match — record still persists.)
2. Idempotency check: skip if `(org_id, claim_id, service_dos, service_code)` already present.
3. Match to `payer_rule` for `(payer_id, code, attribute='covered', dos)` — establishes "we had a rule on file."
4. INSERT `era_835_record` with parsed CARC/RARC, `expected_rule_id`, `preflight_warned = (had_rule && carcs.length > 0)`.

Errors are recorded per-claim and don't abort the batch (verified by the
"db boom on second claim" test).

## Denial dashboard

`runReadOnlyWithTenant`-scoped queries; RLS enforces tenant isolation.

- `GET /v1/denials/top?days=30&limit=10` — top CARC reasons by dollar impact, with per-CARC pre-flight catch rate.
- `GET /v1/denials/catch-rate?days=30` — overall catch rate + total $ impact + caught $.
- `GET /v1/denials/trend?days=30` — daily count + denied + warned for sparkline.

All three use `unnest(carc_codes)` so the same record contributing to multiple
CARCs is counted in each of them.

## Analyst review queue

Workflow: extractor → enqueue → analyst → claim → (accept|reject|edit).

State machine + audit:
```
queued ──claim──▶ claimed ─┬─accept─▶ accepted ─▶ INSERT payer_rule
                           ├─reject─▶ rejected
                           └─edit──▶ edited   ─▶ INSERT (edited) payer_rule
```

Atomicity: `claim()` uses `UPDATE … WHERE status='queued'` returning row count.
Two analysts can't both win the same row.

`extraction_decision` is **append-only** — every accept/reject/edit/withdraw
writes a new row with `decided_by` + timestamp, never UPDATEs.

Endpoints (admin scope, behind AuthGuard):
- `GET /v1/admin/extraction-queue/next?limit=10` — pull batch of unclaimed candidates by priority.
- `POST /v1/admin/extraction-queue/:id/claim` — atomic claim.
- `POST /v1/admin/extraction-queue/:id/accept` — accept; inserts `payer_rule` and links via `resulting_rule_id`.
- `POST /v1/admin/extraction-queue/:id/reject` — reject with required `rationale`.
- `POST /v1/admin/extraction-queue/:id/edit` — analyst edits proposed value/coverage/confidence; inserts edited `payer_rule`.

## CLI: bulk 835 ingestion

```powershell
npm run ingest:era835 -- `
  --org=11111111-1111-4111-8111-111111111111 `
  --client=22222222-2222-4222-8222-222222222222 `
  --dir=.\incoming-835 `
  [--source-prefix=s3://billing-rules-prod-era/]
```

Reads every `*.835`/`*.edi`/`*.txt` in `--dir`, parses, and ingests under the
specified tenant. Per-record dedup means re-running with overlapping data is
safe — the report shows `skipped_duplicate` counts.

## What's deliberately NOT in Phase 2

- **Aetna / UHC / CareSource PDF crawler.** PDF parsing pipeline + payer-specific extractors land in Phase 2.5 once we have one real PDF in hand to calibrate. The schema (`extraction_candidate`) is ready to receive their output.
- **Real-time clearinghouse webhook integration** (Availity / Change Healthcare / Waystar 835 push). Phase 2 only ingests on-demand uploads / batch CLI.
- **LLM-paraphrased denial explanations.** Phase 2 returns structured `denial_event` rows; rendering "in plain English" lands with the Bedrock layer in Phase 1.5+.
- **Analyst UI.** Endpoints are RESTful; the Phase 3 frontend will provide the queue review screens.

## Reproducing

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform\backend
npx tsc --noEmit            # 0 errors
npx jest --ci               # 117 tests, all green, ~19s
```

End-to-end (Docker required):

```powershell
cd C:\Users\S\Desktop\Nkat\billing-rules-platform
.\db\apply.ps1              # applies all 8 migrations + 7 seed files
.\db\test.ps1               # smoke + RLS isolation tests

cd backend
npm run start:dev
# In another shell — upload an 835:
$body = Get-Content backend\test\fixtures\sample-835.txt -Raw
$payload = @{
  body = $body
  client_id = '22222222-2222-4222-8222-222222222222'
} | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/v1/era835/upload `
  -ContentType 'application/json' `
  -Headers @{ 'X-Org-Id' = '11111111-1111-4111-8111-111111111111' } `
  -Body $payload
```

Then `GET /v1/denials/top?days=365` shows the rolled-up CARC analytics.
