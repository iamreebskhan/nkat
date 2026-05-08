# Incident Response Runbook

## Severity definitions

| Severity | Trigger | Customer impact | Initial response |
|---|---|---|---|
| **P0** | Confirmed PHI exposure, cross-tenant data leak, or full platform outage | All tenants affected; HIPAA breach-notification clock starts | Page on-call immediately; engage founders within 15 min |
| **P1** | Pre-flight engine returning wrong results; webhook deliveries dead-lettering >50%; auth broken; data integrity check failed | Single tenant or feature broken; revenue / compliance risk | Page on-call within 15 min; status page incident opened |
| **P2** | Synthesis hallucinations spiking on eval set; ingestion drift on a payer source; one feature flag misbehaving | Degraded but not broken | Slack-ack within 1 business hour; standard fix flow |
| **P3** | Customer-reported visual bug, doc typo, isolated dispute | None to minimal | Triaged in next standup |

## P0 — PHI exposure / cross-tenant leak

### Detect

- RLS audit query (run hourly via CloudWatch synthetics):
  ```sql
  -- Should ALWAYS return zero rows for any tenant-scoped table.
  SELECT 'leak' WHERE EXISTS (
    SELECT 1 FROM client_company c WHERE c.org_id NOT IN (SELECT id FROM org)
  );
  ```
- Customer report of seeing another tenant's data.
- Audit log search showing `lookup` or `era_835_record` reads with mismatched org context.

### Contain (within 15 min)

1. Page on-call + founders. Open `#incident-active` Slack channel.
2. **Disable the affected endpoint at the ALB** if leak is reproducible — return 503 with `Retry-After: 600`.
3. **Revoke break-glass keys** if any were issued in the last 24h (`UPDATE app_user SET status='suspended' WHERE …`).
4. Snapshot the affected DB (RDS automated snapshot on demand) — do NOT delete logs.

### Investigate (within 1 hour)

- Identify scope: which tenants' data was visible to which other tenants? Use the audit log.
- Identify root cause: was `runWithTenant` bypassed? Did a migration disable RLS on a tenant table? Was the app role granted BYPASSRLS?
- Count records touched. Categorize: identifiers vs. metadata vs. clinical.

### Notify (HIPAA breach-notification clock)

- HIPAA: a breach of unsecured PHI requires:
  - Affected individuals: notice within **60 calendar days**.
  - HHS OCR: same 60 days for breaches affecting ≥500 individuals; annual roll-up otherwise.
  - Media: within 60 days for ≥500 in a single state/jurisdiction.
- 42 CFR Part 2: SUD records have the same 60-day notification timeline as HIPAA (post Feb 16, 2026 final rule).
- WMHMDA (Washington consumers): private right of action; documentation must demonstrate timely notification.
- State breach-notification laws vary — counsel reviews the full state-by-state matrix.
- All notifications go through legal counsel before send.

### Remediate

- Forward-fix migration if RLS was the root cause.
- Code fix (with test in `test/integration/rls-isolation.spec.ts`) if `runWithTenant` was bypassed.
- Compliance memo on file: what failed, what changed, how detection improved.
- Customer-impacting changes published in `docs/CHANGELOG.md` + email digest.

## P1 — Pre-flight engine wrong results

Most common cause: stale or wrong `payer_rule` row. Distinct from a P0
because correctness, not exposure, is the harm.

### Detect

- 835 ingestion: `denial_event` shows a CARC class spike that we previously caught (`preflight_caught_count` drops).
- Customer dispute filed: `rule_dispute.status='open'` with `priority>80`.
- Hallucination eval set fails on a gold case after deploy.

### Contain

- Open the affected dispute. Mark `status='investigating'`.
- If the dispute is for a federal payer (Medicare / Medicaid), set the feature flag `synthesis.enabled = false` for the affected tenant(s) immediately to prevent LLM-paraphrased wrong answers.

### Investigate

- Pull the `payer_rule` row + `extraction_decision` chain. When was it added? Who attested it? Source URL still accessible?
- Run `attestation_reverification` on it; if overdue, queue an analyst call.

### Remediate

- Analyst calls payer (if needed), updates rule via the queue.
- Old rule row gets `expiration_date = today`; new rule row inserted with corrected value.
- Drift alert fires for every tenant rulebook that depended on the old row.
- Customer dispute resolved with `resolved_we_were_wrong` → links to `extraction_candidate` → links to new `payer_rule`.

## Runbook for cancelled or stuck webhook deliveries

### Detect

- `webhook_delivery` rows with `status='in_flight'` and `last_attempt_at < now() - 1h` (worker died mid-flight).
- `consecutive_failures > 5` on a `webhook_subscription`.

### Triage

```sql
-- stuck in-flight
UPDATE webhook_delivery SET status='queued', ready_at=now()
WHERE status='in_flight' AND last_attempt_at < now() - interval '1 hour';

-- dead-letter rate per subscription
SELECT subscription_id, count(*)
FROM webhook_delivery
WHERE status='dead_letter' AND created_at > now() - interval '24 hours'
GROUP BY subscription_id ORDER BY count(*) DESC;
```

### Communicate

- For sustained delivery failure (consecutive_failures > 10), email the
  subscription's contact and pause the subscription via the admin endpoint:
  `POST /v1/admin/webhook-subscriptions/:id/pause`.

## Status page

`status.platform-name.com` (StatusPage.io). Components mapped to internal
SLOs:

| Component | SLO target | Customer-facing |
|---|---|---|
| Lookup API | 99.9% / month | yes |
| 835 ingestion | 99.5% / month | yes |
| Webhook delivery | 99.5% / month | yes |
| Synthesis (Bedrock) | 99% / month | yes (Org+ only) |
| Reconciliation UI | 99% / month | yes |
| Admin endpoints | 99% / month | no (internal) |

Incident postings are required for P0 + P1; P2 is at on-call discretion.
