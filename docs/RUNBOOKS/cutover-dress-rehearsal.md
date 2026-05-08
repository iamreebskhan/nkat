# Cutover Dress Rehearsal Runbook

A timed, full-team, end-to-end rehearsal of `production-cutover.md`,
performed against **stage** ≥ 7 days before the real cutover. The goal is
to surface every problem we'd rather hit in stage than find at 0900 ET
on go-live day with a paying tenant watching.

The rehearsal is mandatory before any first-tenant cutover. We record
everything, retro within 48 hours, file every blocker as a P1 ticket,
re-rehearse if any P1 doesn't close.

## Pre-rehearsal (T-2 days)

- [ ] Stage = production parity per `production-cutover.md` §
  "Pre-cutover engineering" (infra, data, app).
- [ ] Stage Datadog forwarder Lambda deployed; logs flowing.
- [ ] Stage RDS Multi-AZ (matches prod even if non-prod-class instance).
- [ ] Synthetic "first tenant" org seeded in stage:
      `11111111-1111-4111-8111-111111111111`, admin user provisioned,
      Stripe customer created with metadata.org_id, subscription set to
      tier=org / seats=10.
- [ ] PagerDuty test schedule configured: rehearsal coordinator paged on
  any auto-fired stage alarm.
- [ ] Status-page maintenance window scheduled (private rehearsal
  components only — customers don't see this).

## Sequence (T-0)

The schedule mirrors the real cutover timing, abbreviated. Owner per row.

| T (rel) | Owner | Action | Pass criteria |
|---|---|---|---|
| 0:00 | Coord | Open `#rehearsal` Slack; start recording | Channel exists, recording on |
| 0:05 | Eng-1 | Lock writes on stage (read-only flag) | App rejects POSTs with 503 |
| 0:10 | Eng-2 | Trigger blue-green deploy of latest image | Green target group healthy in 5 min |
| 0:20 | Eng-2 | Shift 10% → 50% → 100% over 30 min | No 5xx spike past baseline |
| 0:50 | Eng-1 | Run `npm run cutover:dry-run` against stage | All 5 checks pass |
| 0:55 | Eng-3 | Run k6 lookup load test, 5-min ramp | p95 < 2s, error rate < 0.1% |
| 1:05 | Eng-1 | Send synthetic webhook from Stripe CLI | `billing_event` row written, no duplicates |
| 1:10 | Eng-3 | Verify Datadog forwarder shipping logs | Recent `api` log lines visible in DD |
| 1:15 | Eng-2 | Force a P1: `aws ecs update-service --desired-count 0` for 90s | Pager fires, status page → Investigating |
| 1:18 | Coord | Restore service, post status update | Status-page → Monitoring within 60s of recovery |
| 1:25 | CSM | Send first-tenant invite email; admin completes SSO + MFA | Login successful, MFA enrolled |
| 1:35 | CSM | Walk admin through first lookup + first reconciliation | Tenant sees expected findings + diff list |
| 1:50 | Eng-3 | Trigger one of each P0 / P1 / P2 simulated incident | All three follow `incident-response.md` cadence |
| 2:30 | Coord | Status-page → Resolved; end recording | Window closed cleanly |

Run on a Saturday or after-hours weekday so a real customer-impact
mistake on stage doesn't bleed into prod's user base.

## Required tooling on coordinator's laptop

- Stripe CLI (for synthetic webhook signing).
- k6 (for load test).
- AWS CLI authed into the **stage** account (NOT prod — different SSO profile).
- `psql` against the stage RDS read endpoint.
- Datadog dashboard pinned to the rehearsal time range.
- This runbook open in one tab, `production-cutover.md` in another.

## Failure handling during rehearsal

Any check that fails:

1. Stop the timer; capture stdout + Datadog screenshots.
2. Continue the rehearsal (we want full surface coverage); failures
   accumulate.
3. After 2:30 wrap, file each failure as a P1 ticket on the cutover
   board.
4. Coordinator decides: do we re-rehearse, or are these issues
   addressable without re-rehearsal? Default: any P1 blocks.

## Post-rehearsal retro (T+1 day)

48 hours max between rehearsal end and retro. Attendees:

- Engineering on-call primary + secondary.
- CSM lead.
- CTO + CEO (sign-off).
- Compliance lead.

Retro template (1-pager):

```
## Rehearsal date / start / end
## Pass / fail per row of the sequence table
## P1 tickets opened
## Status-page updates (count + median time-to-update)
## Did the synthetic Datadog scrubber regression catch any PHI in test logs?  (must be no)
## Decision: cleared for prod cutover  /  re-rehearse
## Sign-offs: CTO ___ CEO ___ Compliance ___
```

## What rehearsal does NOT cover

- Real BAA execution (manual + counsel).
- Real DNS + ACM cert validation against the prod domain.
- Real customer signature on MSA / BAA / DPA.
- Real first 835 ERA from the design partner's clearinghouse.

Those are gated by the Phase 11 contract execution + BAA + first-tenant
integration steps and verified separately on cutover day.

## Cadence

- **Initial rehearsal**: ≥ 7 days before first prod cutover.
- **Re-rehearsal**: any time the production stack architecture changes
  materially (new region, new sub-processor, new RDS major, etc.).
- **Quarterly thereafter**: tied to the DR drill in
  `disaster-recovery.md`.
