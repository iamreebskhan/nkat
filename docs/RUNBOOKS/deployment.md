# Deployment Runbook

The platform deploys to AWS in two environments: **staging** (auto-deploy on
merge to `develop`) and **production** (manual approval gate on merge to
`main`). Both run the same artifact set; only configuration differs.

## Artifacts produced by CI

1. `backend` Docker image — tagged `ghcr.io/<org>/billing-rules-backend:<commit>`.
2. `browser-extension/dist/` — manifest-v3 bundle uploaded as a CI artifact + (in production) submitted to Chrome Web Store via the manual gate.
3. `docs/openapi.json` — committed alongside code; CI fails the build on drift.

## Environments

| | staging | production |
|---|---|---|
| Region | us-east-1 | us-east-1 (primary) + us-west-2 (read replica) |
| DB | RDS Postgres 16 + pgvector ext + Multi-AZ | same + cross-region read replica |
| Compute | ECS Fargate × 2 tasks | ECS Fargate × ≥4 tasks behind ALB |
| Cache | ElastiCache Redis (single node) | Redis cluster mode |
| LLM | Bedrock disabled (deterministic synthesis only) | Bedrock enabled per tenant via feature flag |
| Domain | api.staging.platform | api.platform |
| BAA on file | dev BAA | production BAA + sub-processor BAAs verified |

## Promotion flow (blue-green)

1. CI builds + tests merge to `main`. Image tag `vN.N.N+commit`.
2. CD pipeline awaits manual approval (release manager).
3. Approved → `terraform apply` (or `cdk deploy`) flips ECS service `desired` traffic to **0% → green**:
   - Spin up green task set with the new image.
   - Health check: `/readyz` 200 with DB roundtrip < 500ms for 3 consecutive minutes.
   - Migrations run as a one-shot ECS task **before** flipping traffic. Migrations are forward-only; rollbacks are forward-fix migrations.
4. Shift ALB traffic 0% → 25% → 100% over 30 minutes. Synthetic monitor (k6 light load) at each step.
5. Auto-rollback triggers (ALB target group rollback to blue):
   - error rate > 0.5% for 5 minutes.
   - p95 latency > 3s for 5 minutes.
   - PostgreSQL CPU > 90% for 5 minutes.
   - Hallucination eval failure rate > 5% on the gold eval set (sampled async).

## Migration strategy

- All migrations are in `db/migrations/`, numbered, applied in order.
- Migrations run as a separate ECS task before the API task set flips. The task uses the `admin` (BYPASSRLS) role.
- Rollbacks are **always forward** — never `DROP TABLE x` to undo `CREATE TABLE x`. If a migration is broken, ship a follow-up migration that supersedes it.
- DDL that takes locks > 1s (e.g. `ALTER TABLE ... ADD COLUMN NOT NULL`) is split: ship the column nullable, backfill, then add the constraint in a follow-up.
- pgvector `HNSW` index builds are heavy: do them in a maintenance window or build them concurrently (`CREATE INDEX CONCURRENTLY`).

## Configuration

- Env vars are validated by `src/config/env.ts` (Zod). Bootstrap fails fast on missing/malformed.
- Secrets in **AWS Secrets Manager** with KMS, mounted via ECS task definition.
- Feature flags read from `feature_flag` table — no app restart required to change tenant behavior.

## Customer-visible release notes

Maintained in `docs/CHANGELOG.md`. Each customer-impacting change cross-links
to the PR + the controlling feature flag (if applicable). Release notes are
sent to:

- in-app banner (top of every authenticated page) for 14 days
- `release-notes` email digest (Org+ tier customers)
- the public webhook event `platform.release.published` (subscribers only)

## Pre-flight checklist (before manual approval)

- [ ] All CI jobs green on `main`: backend unit + integration, schema-apply, extension typecheck/test, openapi-export drift check.
- [ ] Migrations dry-run applied on a freshly restored prod snapshot in staging.
- [ ] Synthesis + hallucination eval set passes on the new image (locally or in a staging job).
- [ ] No open P0/P1 incidents.
- [ ] On-call engineer acknowledged the deploy in `#release-channel`.
- [ ] Customer-visible release notes drafted + reviewed.

## Rollback

- ALB-level: shift traffic back to blue. Takes ~60 seconds. Blue task set stays alive for 24 hours after promotion.
- Database: forward-fix migration. **Never** `DROP TABLE` or `DROP COLUMN` from a failed deploy — preserve any data the app produced before the rollback.
- Communication: status page incident opened immediately, customer email digest within 60 minutes if customer-impacting.
