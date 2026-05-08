# Go-Live Record (Template)

The single artifact filled in at the moment we cut over the first paying
tenant in production. Coordinator commits this file to
`docs/POST-MORTEMS/go-live-YYYY-MM-DD.md` within 48 hours of T+0.

The template captures: gate states at the moment of the decision, the
actual sequence executed, what was different from the dress rehearsal,
and the decisions made on the fly. **Future audits + post-mortems will
read this** — write it like the auditor is in the room.

---

## Header

| Field | Value |
|---|---|
| Cutover date / time (UTC) | `[YYYY-MM-DD HH:MM]` |
| First paying tenant org_id | `[uuid]` |
| First paying tenant legal name | `[Customer]` |
| Build SHA (image tag) | `[sha]` |
| OpenAPI paths exported | `[N]` |
| Test count at cutover commit | `[backend / extension / lambda]` |
| Coordinator | `[name]` |
| On-call primary | `[name]` |
| On-call secondary | `[name]` |
| CSM | `[name]` |
| Status-page incident URL | `[link]` |

## Pre-cutover gate state — `launch-readiness.md`

For each gate, mark GREEN at the cutover decision moment.
Re-state any gate that flipped color in the prior 7 days.

### Infrastructure stack

- [ ] A1. Stage SES smoke green (most recent run + result)
- [ ] A2. Stage Stripe smoke green
- [ ] A3. Stage cutover dress rehearsal pass (latest results doc link)
- [ ] A4. CI / OpenAPI gates green
- [ ] A5. Production infra parity (migrations, RLS, Datadog, schedules)
- [ ] A6. Backups verified by restore (date)
- [ ] A7. Pen test + SOC 2 Type 1

### Commercial stack

- [ ] B1. Sub-processor BAAs (one row per sub-processor; date executed)
- [ ] B2. Customer agreements: MSA, BAA, DPA, Order Form (date / signer)
- [ ] B3. Insurance bound (cyber, E&O, general liability — policy numbers)
- [ ] B4. AMA + CMS license tokens in prod Secrets Manager
- [ ] B5. State privacy notices (Privacy Center, WMHMDA, CO AI Act)
- [ ] B6. Counsel sign-off (CDS exemption memo, AKS/Stark/FCA review)

### Authority sign-offs at cutover decision

| Role | Name | Signed |
|---|---|---|
| CTO | | YYYY-MM-DD HH:MM |
| CEO | | YYYY-MM-DD HH:MM |
| Compliance Lead | | YYYY-MM-DD HH:MM |

---

## Sequence executed

Copy from `production-cutover.md`'s "Cutover day → Sequence" table; for
each row, mark PASS or NOTE with the actual time.

| T (rel) | Owner | Action | Pass | Actual time | Note |
|---|---|---|---|---|---|
| 0:00 | Coord | Open `#release-launch`, recording on |  |  |  |
| 0:05 | Eng-1 | Lock writes on stage | n/a | n/a | not applicable for first prod cutover |
| 0:10 | Eng-2 | Push image to ECR + green target group |  |  |  |
| 0:20 | Eng-2 | Shift 10 → 50 → 100% over 30 min |  |  |  |
| 0:50 | Eng-1 | Run `npm run cutover:dry-run` against prod |  |  |  |
| 0:55 | Eng-3 | Synthetic Stripe webhook delivery |  |  |  |
| 1:05 | Eng-1 | DNS cutover Route 53 weighted 0 → 100 |  |  |  |
| 1:10 | CSM | First-tenant invite email sent |  |  |  |
| 1:15 | Tenant | Tenant admin completes SSO + MFA |  |  |  |
| 1:25 | Tenant | First lookup against real payer × state |  |  |  |
| 1:30 | Tenant | Welcome email received; List-Unsubscribe button visible |  |  |  |
| 1:35 → 3:35 | On-call | 2-hour monitoring window |  |  |  |
| 3:35 | Coord | Status page → Resolved |  |  |  |

## Synthesis cache hit-rate (informational)

After 1 hour of the tenant's lookups + synthesis, run:

```sql
SELECT
  COUNT(*) FILTER (WHERE hit_count > 0) AS hot_rows,
  COUNT(*) AS total_rows,
  SUM(hit_count) AS total_hits
FROM synthesis_cache
WHERE org_id = '<tenant uuid>';
```

Capture the result. We expect a non-trivial hit-rate even in the first hour
if the tenant runs the same lookups against multiple patients.

---

## What was different from the dress rehearsal

Concrete observations only. No vibes. Each item:

- What we expected (per dress rehearsal results doc).
- What we observed (logs, screenshots, metric snapshots).
- Decision made + by whom.

---

## P0/P1 incidents during the window

If any: link to the incident-response.md ticket per incident. If none: "None — clean window."

---

## Rollback decisions considered + NOT taken

For each near-miss where the rollback decision tree was discussed but
rollback was NOT triggered: capture the signals + the reasoning. (If we
didn't fire on signal X, future readers should know why.)

---

## Daily metric snapshot — T+0 close-out

| Metric | Target | Actual at T+2 hr |
|---|---|---|
| Lookup p95 | < 2s |  |
| Lookup error rate | < 0.1% |  |
| `email_send` success rate | > 95% |  |
| Welcome email delivered | yes/no |  |
| Webhook delivery dead-letter count | 0 |  |
| Datadog log lag | < 60s |  |
| Idempotency cache hit count (1 hr) | informational |  |
| Synthesis cache hit count (1 hr) | informational |  |

---

## What we'd do differently

Three to seven concrete bullets. Feed into the GA-launch retro at T+14.

---

## Sign-offs

- Coordinator: `[name]` — `[YYYY-MM-DD HH:MM]`
- CTO: `[name]` — `[YYYY-MM-DD HH:MM]`
- CEO: `[name]` — `[YYYY-MM-DD HH:MM]`
- Compliance Lead: `[name]` — `[YYYY-MM-DD HH:MM]`
- First-tenant primary contact: `[name]` (optional, after sanitization)

---

## Artifacts

- `#release-launch` Slack export: `[s3 path]`
- Recording: `[link]`
- Datadog dashboard for the 2-hour window: `[link]`
- Status-page incident: `[link]`
- Stripe events list: `[link]`
- AWS CloudTrail for the cutover account, ±2h window: `[s3 path]`
