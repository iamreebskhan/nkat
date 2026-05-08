# Dress Rehearsal Results Template

Filled in by the rehearsal coordinator within 48 hours of `cutover-dress-rehearsal.md` execution. The completed file is committed to `docs/POST-MORTEMS/dress-rehearsal-YYYY-MM-DD.md` and linked from `#release-launch` Slack.

---

## Header

| Field | Value |
|---|---|
| Date / start / end | `[YYYY-MM-DD HH:MM ET]` → `[HH:MM ET]` |
| Coordinator | `[name]` |
| On-call primary | `[name]` |
| On-call secondary | `[name]` |
| CSM | `[name]` |
| Build SHA exercised | `[git sha]` |
| Image tag | `[ecr-tag]` |
| Stripe key in stage | `sk_test_...` (last 4 only) |
| Re-rehearsal? (yes/no) | `[no]` |

## Sequence pass/fail

Copy the row table from `cutover-dress-rehearsal.md`. Mark each row PASS / FAIL with the actual time, and a one-line note. Failures get a separate entry in the P1 list below.

| T (rel) | Owner | Action | Pass criteria | Result | Actual time | Note |
|---|---|---|---|---|---|---|
| 0:00 | Coord | Open `#rehearsal` | Channel + recording | PASS | 09:00 |  |
| 0:05 | Eng-1 | Lock writes | App rejects POSTs with 503 |  |  |  |
| 0:10 | Eng-2 | Trigger blue-green deploy | Green target healthy in 5m |  |  |  |
| 0:20 | Eng-2 | Shift 10→50→100% | No 5xx spike |  |  |  |
| 0:50 | Eng-1 | `npm run cutover:dry-run` | All 5 checks pass |  |  |  |
| 0:55 | Eng-3 | k6 load 5-min ramp | p95<2s, err<0.1% |  |  |  |
| 1:05 | Eng-1 | Synthetic Stripe webhook | `billing_event` written, no dups |  |  |  |
| 1:10 | Eng-3 | Datadog forwarder | Recent `api` lines visible |  |  |  |
| 1:15 | Eng-2 | Force P1 (count=0 90s) | Pager fires + status page |  |  |  |
| 1:18 | Coord | Restore + status update | Status page → Monitoring within 60s |  |  |  |
| 1:25 | CSM | First-tenant invite + SSO+MFA | Login + MFA enrolled |  |  |  |
| 1:35 | CSM | First lookup + reconciliation | Findings + diff visible |  |  |  |
| 1:50 | Eng-3 | P0/P1/P2 sim incidents | All three follow incident-response cadence |  |  |  |
| 2:30 | Coord | Status → Resolved | Window closed cleanly |  |  |  |

## Numbers captured during the window

| Metric | Target | Actual |
|---|---|---|
| Lookup p95 | < 2s | _____ |
| Lookup error rate | < 0.1% | _____ |
| Synthesis refusal rate | < 5% | _____ |
| Hallucination eval pass | ≥ 95% | _____ |
| Webhook delivery latency p95 | < 5s | _____ |
| Datadog log lag | < 60s | _____ |
| Pager ack-to-resolution (synth P1) | < 30 min | _____ |
| Status-page first-update | < 60s | _____ |

## P1 ticket list (failures + must-fix-before-cutover)

| # | Title | Owner | ETA | Tracker |
|---|---|---|---|---|
| 1 |  |  |  |  |
| 2 |  |  |  |  |

## P2 ticket list (not blocking but worth fixing)

| # | Title | Owner | ETA | Tracker |
|---|---|---|---|---|
| 1 |  |  |  |  |

## Findings

### What we proved works
- (1-line bullets — what surprised us in a good way)

### What needs work before prod
- (1-line bullets — concrete observations, not vibe)

### Process feedback
- (rehearsal logistics — what to change for next time)

## Synthetic Datadog scrubber regression

**Did any test PHI bleed through to Datadog logs?** _yes/no_

(Must be **no** to clear cutover. If yes: scrubber regression is a P0 blocker; fix and re-rehearse.)

| Test pattern | Logged in stage | Visible in Datadog | Verdict |
|---|---|---|---|
| SSN `123-45-6789` |  |  |  |
| MRN `MRN: ABC1234` |  |  |  |
| Member ID `member_id: XYZ-9999` |  |  |  |
| DOB `1980-04-12` |  |  |  |
| Patient name `John Doe` |  |  |  |

## Decision

- [ ] Cleared for prod cutover
- [ ] Re-rehearse on `[YYYY-MM-DD]`
- [ ] Cutover deferred — root cause: `[…]`

## Sign-offs

- CTO: `[name]` — `[YYYY-MM-DD]`
- CEO: `[name]` — `[YYYY-MM-DD]`
- Compliance Lead: `[name]` — `[YYYY-MM-DD]`

## Recording / artifacts

- Slack channel: `#rehearsal-YYYY-MM-DD`
- Datadog dashboard time range: `[link]`
- Status-page incident: `[link]`
- Playwright traces (if any): `[s3 path]`
- k6 output: `[s3 path]`
- Stripe events list: `[link to dashboard]`
