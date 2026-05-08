# Break-Glass Runbook

"Break-glass" = the controlled override of normal access controls during a
real incident. Every use is logged, audited, and post-mortemed. We build
explicitly for this rather than handing engineers superuser by default.

## Roles

| Role | Connect | Privileges | Use case |
|---|---|---|---|
| `app` | API service | NOBYPASSRLS | Normal operation; cannot accidentally cross tenants |
| `analyst` | Internal analyst tools | NOBYPASSRLS, restricted writes via stored procs | Attestation calls, dispute resolution |
| `breakglass` | Manual SSH session via SSO + MFA + ticket | BYPASSRLS | Incident-only investigation; never ambient |

`breakglass` access is gated by:

1. SSO + MFA.
2. An incident ticket (P0/P1 only) referenced in the session metadata.
3. Auto-revoking IAM session ≤ 4 hours.
4. CloudTrail + DB audit logging on every statement (not just connection).

## When to use break-glass

- **Cross-tenant investigation** during a confirmed P0 leak (you need to see
  the offending rows across all tenants to scope impact).
- **Failed migration** — the `app` role can't run DDL; admin/break-glass can.
- **Stuck transaction** holding a lock — `pg_terminate_backend` requires
  superuser-ish privileges.
- **Recovery from a runaway deletion** by a buggy job, where you need to
  read pre-DELETE state via PITR + cross-schema copy.

**NEVER use break-glass for:**
- Routine queries. The `app` and `analyst` roles cover the day job.
- Bypassing a stuck deploy (re-run the deploy or roll back).
- Customer-requested data access — those go through the audited admin
  endpoints (which RLS-scope to the customer's own tenant).

## Procedure

1. **Open an incident ticket** with the affected component, severity, and
   intended action. P0/P1 only.
2. **Page secondary on-call** — you do not break-glass alone. The secondary
   reviews the planned commands before connection.
3. **Connect via the bastion**: SSM session into the bastion host, then
   `psql -U breakglass -h <rds-endpoint>`. The bastion logs every keystroke.
4. **Run prepared statements** from the runbook, not ad-hoc SQL. If the
   runbook doesn't cover it, add a step: write the SQL, get secondary
   review, then run it.
5. **Capture the session transcript** — it's auto-archived to S3, but
   manually attach it to the incident ticket as well.
6. **Disconnect immediately** when done. Don't leave the session idle.
7. **Post-mortem** within 5 business days. Include every command run.

## Common break-glass operations (reviewed prepared statements)

### Confirm RLS posture across all tenant tables

```sql
-- Should return zero rows. Any row indicates a leak surface.
SELECT relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND relname IN (
    'org','org_member','client_company','client_rulebook','client_rule',
    'audit_log','consent_record','alert','era_835_record','denial_event',
    'abn_record','rule_dispute','client_doc_upload','redaction_event',
    'webhook_subscription','webhook_delivery','cms_0057_pa_response'
  )
  AND NOT relrowsecurity;
```

### List all RLS policies (sanity check after a migration)

```sql
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
ORDER BY tablename, policyname;
```

### Stop a runaway query

```sql
-- Identify
SELECT pid, now() - query_start AS age, state, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 minutes'
ORDER BY age DESC;

-- Cancel (graceful)
SELECT pg_cancel_backend(<pid>);

-- Terminate (force)
SELECT pg_terminate_backend(<pid>);
```

### Rotate a webhook signing secret without downtime

```sql
-- Generate a new secret out-of-band, then:
UPDATE webhook_subscription
   SET signing_secret = $new_secret
 WHERE id = $subscription_id;

-- Customer must redeploy their endpoint with the new secret. Until they do,
-- their delivery verifier will fail; that's the desired behavior to force
-- the rotation.
```

### Rebuild HNSW vector index without locking the lookup path

```sql
-- Build concurrently (no AccessExclusiveLock).
CREATE INDEX CONCURRENTLY document_chunk_embedding_hnsw_v2
  ON document_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m=16, ef_construction=64);
-- Atomically swap.
BEGIN;
DROP INDEX document_chunk_embedding_hnsw;
ALTER INDEX document_chunk_embedding_hnsw_v2 RENAME TO document_chunk_embedding_hnsw;
COMMIT;
```

## Secrets rotation

Routine secrets rotation is automated; emergency rotation uses break-glass.

| Secret | Routine | Emergency |
|---|---|---|
| RDS app/admin passwords | Quarterly via Secrets Manager | Immediate revoke + rotate; force ECS task replacement |
| Webhook signing_secret per tenant | Customer-initiated | Immediate UPDATE (above); customer must redeploy endpoint |
| AMA license token | Annual renewal | Immediate take-down of CPT-descriptor display; renegotiate |
| CMS Coverage API license token | Renew per CMS terms | Immediate ingestion pause |
| AWS access keys (IAM users — minimize) | Auto-rotate every 90 days | Immediate revoke via IAM; pivot to instance role if available |

## Audit trail expectations

A SOC 2 Type 2 audit will sample break-glass sessions and ask:

1. Show the incident ticket that authorized this session.
2. Show the secondary on-call's review of the planned commands.
3. Show the full session transcript.
4. Show the post-mortem.

Each must be present and time-aligned. Missing any one is a finding.
