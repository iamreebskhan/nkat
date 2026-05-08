# Disaster Recovery Runbook

## Targets

| Tier | RPO (data loss tolerated) | RTO (time to restore service) |
|---|---|---|
| 1 — lookup, 835 ingestion, webhooks | **1 hour** | **4 hours** |
| 2 — reconciliation, synthesis, dashboards | 24 hours | 24 hours |
| 3 — analytics warehouse, archived audit logs | 7 days | 7 days |

These targets are also written into the SOC 2 contingency-plan policy and
must be exercised at least annually.

## Backup posture

| Layer | Mechanism | Retention | Encryption |
|---|---|---|---|
| RDS Postgres | Automated daily snapshots + 5-min point-in-time recovery (PITR) | 35 days | KMS CMK (per-account) |
| RDS logical backup | `pg_dump --format=custom --jobs=4` nightly to S3 | 1 year | KMS CMK + S3 SSE-KMS |
| Audit log cold storage | S3 Object Lock (Compliance mode) | **6 years** (HIPAA) | KMS CMK |
| Object storage (uploaded ERA, redacted client docs) | S3 versioning + Object Lock | 6 years | KMS CMK |
| Cross-region replica | RDS read replica in us-west-2 | continuous | KMS CMK (us-west-2) |

Backups are tested at least monthly via the DR drill below.

## DR drill (monthly)

1. **Snapshot to staging.** Restore the latest production RDS snapshot into a
   staging RDS instance. Time-box: 60 min target.
2. **Verify migrations.** Apply the current `db/migrations/` against the
   restored DB to confirm no schema drift.
3. **Spot-check seeded reference data.** Run the smoke tests in
   `db/test/0001_smoke.sql`.
4. **Run integration tests.** `INTEGRATION=1 npm run test:integration` against
   the restored DB.
5. **Measure end-to-end RTO**: time from "snapshot identified" to
   "smoke + integration tests green." Log to `docs/RUNBOOKS/dr-drill-log.md`.

If the drill fails on any step, file a P1 and don't promote to production
until it's resolved.

## Region failover (us-east-1 → us-west-2)

Trigger: us-east-1 unavailable for > 1 hour (declared by AWS or by sustained
ALB health-check failures).

1. **Promote the read replica** (`aws rds promote-read-replica`). Takes ~10 min; PITR is no longer available on the new primary until snapshots resume.
2. **Repoint Route 53.** Failover record set already configured; manual flip is the safe move (don't trust automatic until we've drilled it).
3. **ECS service in us-west-2** spins up from the same task definition / image. Container has `AWS_REGION=us-west-2`.
4. **Bedrock**: re-validate the Bedrock client points at us-west-2 (different model availability — verify Sonnet is reachable; fall back to deterministic if not).
5. **Webhooks**: existing in-flight deliveries on the dead region's queue may dead-letter. Once us-west-2 is healthy, re-queue the dead-lettered batch with `status='queued'`.

## Restoring a single tenant

Sometimes a customer's analyst makes a mistake (e.g. accepts the wrong diff
into a finalized rulebook). We don't restore by destroying tenant data;
instead:

1. **Forward-fix the rulebook.** Open a new `client_rulebook` version that
   supersedes the broken one. The audit trail in `extraction_decision` and
   `audit_log` shows what changed and when.
2. **Refer to a snapshot if needed.** PITR can recover the DB at any
   point in the last 5 minutes; we re-create the tenant's rulebook into a
   side schema and copy individual rows back via `INSERT ... SELECT`.
3. **Don't truncate the audit log.** Audit retention is 6 years; data
   removal happens via tagging (`deleted_at`) not deletion.

## Operational guarantees

- **No single point of failure** in production: ECS Fargate × ≥2 tasks;
  RDS Multi-AZ; Redis cluster mode (us-east-1) with cross-region replica.
- **No raw PHI in observability sinks.** Pino redaction patterns + Datadog
  scrubbing rules; quarterly audit of last 30 days of logs verifies.
- **No DELETEs on tenant data tables.** Soft-delete via `status` columns
  everywhere. Hard-delete only on a customer's signed off-boarding ticket
  with legal sign-off.

## What "cannot recover" looks like

Some failure modes don't have a clean DR story; document them so we don't
pretend otherwise:

- **AMA CPT license revoked.** Code descriptors fall back to numeric-only
  display; new ingestion stops until renegotiated. This is a contractual
  failure, not a DR event.
- **Mass payer C&D** on scraping. Affected payer ingestion stops; analyst
  attestation backfills. Customer impact is "we lost coverage for payer X."
- **Bedrock provider deprecates the model**. Synthesis falls back to
  deterministic via the feature flag. Customers still get the structured
  pre-flight; synthesis paraphrasing pauses while we swap models.
