# On-Call Runbook

## Rotation

- Primary on-call: 1 engineer at a time, 1-week rotations, follow-the-sun
  once we have engineers in two timezones.
- Secondary: 1 engineer + 1 founder for P0 escalations.
- Hand-off: every Monday 09:00 local. Outgoing engineer briefs incoming on
  any in-flight tickets, recent deploys, and known issues.

## Tools

- Pager: PagerDuty integration with the status page + Datadog monitors.
- Slack: `#oncall-active` (auto-paged on P0/P1) and `#oncall-archive` (post-mortems).
- Runbooks: this directory.
- Read-only DB access: every engineer has it via SSO/IAM-DB-auth. Write
  access is per-incident, scoped, audited (see `break-glass.md`).
- Customer comms: status page CLI for incident updates;
  email digest for customer-impacting changes.

## Page-worthy events (ranked)

1. P0/P1 from `incident-response.md`.
2. Sustained CloudWatch alarm (5+ min): API error rate > 1%, p95 > 3s, RDS CPU > 90%, RDS connection saturation > 90%.
3. Synthetic-monitor failure: lookup against staging+prod hits a non-200 for 3 consecutive minutes.
4. Backup failure: nightly `pg_dump` job exit code != 0 for 2 consecutive nights.
5. Payer source crawler: > 30% extraction-error rate in a single nightly run.
6. Webhook delivery: > 100 dead-lettered in 1 hour for a single subscription.

## Triage order on a fresh page

1. **Acknowledge** in PagerDuty + post in `#oncall-active` ("on it").
2. **Read the alert payload** — don't go straight to dashboards.
3. **Check the status page**: is something already known + posted?
4. **Confirm reproduction** before declaring an incident — pages can be
   transient (e.g. CloudWatch sample-rate noise).
5. **Open the incident** if real: assign severity, post the first status
   page update within 15 minutes of confirmation.
6. **Page secondary** if P0 or if you don't see resolution in 30 minutes.

## Communications cadence

| Severity | Internal cadence | Customer cadence |
|---|---|---|
| P0 | every 15 min | initial within 15 min, updates every 30 min |
| P1 | every 30 min | initial within 30 min, updates every 60 min |
| P2 | end of day | post-resolution summary within 24h |

Status page updates use the **Investigating → Identified → Monitoring →
Resolved** lifecycle. Don't mark Resolved until the alarm has been quiet for
60 minutes.

## Post-mortem

Required for every P0 + P1 within **5 business days**. Posted to
`docs/POST-MORTEMS/` (private). Each post-mortem must answer:

1. **What happened?** (timeline; PHI redacted)
2. **Customer impact** — how many tenants, what was visible, dollar impact
   if quantifiable.
3. **What we did well + what we'd change.**
4. **Action items** (with owner + ETA). Each action item becomes a tracked
   ticket; no AI items closed without verification.

Post-mortems are blameless; we critique systems, not people. If a person
made a mistake, the question is "why did the system permit this mistake?"
not "why did they do this."

## Specific page playbooks

### "Lookup p95 > 3s"

1. Check Datadog APM: which service in the trace is slow?
2. If DB is slow: check `pg_stat_activity` for locks, slow queries; look at
   recent `payer_rule` writes (a giant batch can lock the lookup hot path).
3. If Bedrock is slow: feature-flag synthesis off for affected tenants.
4. If lookup orchestrator is slow but DB+Bedrock are fine: check PgBouncer
   connection pool saturation.

### "RDS connection saturation > 90%"

1. Check `pg_stat_activity` count by client application.
2. Run-away connections from a single ECS task: stop the task; ECS will
   replace it.
3. PgBouncer not deployed? Stand it up (transaction pool mode).

### "Webhook delivery dead-lettering"

1. Identify the affected subscription.
2. Curl the URL from a dev shell — is the customer's endpoint up?
3. If customer endpoint is down for > 1 hour, pause the subscription via
   admin endpoint and email the contact.

### "Hallucination eval failure rate > 5%"

Phase 6's synthesis layer + the gold eval set in `test/integration/`.

1. Run the eval against the new image locally.
2. Bisect: was the failure introduced in the latest deploy?
3. Roll back synthesis feature flag globally (`UPDATE feature_flag SET enabled=false WHERE flag_key='synthesis.enabled' AND org_id IS NULL`) until fixed.

### "AMA license alert" (not paged; scheduled review)

The CPT license has annual renewal terms with the AMA. The compliance
calendar surfaces this 90 days before expiry — not an incident, but it gets
the same playbook treatment to make sure it doesn't slip.
