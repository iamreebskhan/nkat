# Production Cutover Runbook

The single document that converts "stage works" into "production is live and
the first paying tenant can sign in." Every step is gated; do not skip
steps. If a gate fails, stop and resolve before proceeding.

## Pre-cutover gates (T-2 weeks)

| Gate | Owner | Evidence |
|---|---|---|
| AWS HIPAA BAA executed | Counsel | Signed BAA on file |
| Bedrock + Datadog + Stripe + Comprehend Medical sub-processor BAAs | Counsel | Each BAA on file |
| SOC 2 Type 1 report issued | Vanta auditor | PDF in `compliance/` |
| Pen test report — clean (no high/critical) | External | PDF + remediation log |
| Cyber + E&O insurance bound | Broker | Certificate of insurance |
| AMA CPT license active | Counsel | License + license token in Secrets Manager |
| CMS Coverage API token issued | Eng | Token in Secrets Manager |
| 3 design partners signed MSA + BAA | GTM | Signed agreements |

If any gate fails: cutover does not proceed. Press the date.

## Pre-cutover engineering (T-1 week)

### Infra parity check

- [ ] Production VPC in `us-east-1` with subnets in 3 AZs.
- [ ] RDS Postgres 16 Multi-AZ + read replica + 35-day automated backups.
- [ ] PgBouncer (transaction pool mode) in front of RDS.
- [ ] ECS Fargate cluster + ALB + ACM cert for `api.<domain>` and `app.<domain>`.
- [ ] CloudWatch alarms wired to PagerDuty + Slack `#oncall-active`.
- [ ] Datadog APM + log forwarding active; PHI scrubbing rules verified.
- [ ] Secrets Manager populated; ECS task IAM role grants only the secrets it needs.
- [ ] Bedrock VPC endpoint — model invocations stay on AWS backbone.

### Data parity check

- [ ] Every migration in `db/migrations/*.sql` applied to prod RDS.
- [ ] Every seed in `db/seed/*.sql` applied to prod RDS.
- [ ] `pgvector` + `citext` extensions present.
- [ ] RLS enabled on every tenant-scoped table — verify with the
  `break-glass.md` "RLS posture" query; it should return zero rows.
- [ ] `app` role created with `NOBYPASSRLS`; `breakglass` with `BYPASSRLS`.
- [ ] First tenant org seeded with admin user invite (T-1 day).

### App parity check

- [ ] Stage environment ran the full E2E + integration + k6 smoke.
- [ ] OpenAPI export checked in; `git diff --exit-code docs/openapi.json` clean.
- [ ] `npx tsc --noEmit` → 0 errors on the cutover commit.
- [ ] `npx jest --ci` → all suites green.
- [ ] `npm run test:e2e` (browser extension) → green.
- [ ] Hallucination eval set ≥ 95% pass rate against the prod model + prompts.

## Cutover day (T-0)

### Communication windows

- T-7d: design partners notified by CSM + status-page banner.
- T-1d: final reminder + freeze window starts.
- T-0 0900 ET: cutover starts. Status-page incident: "Scheduled — Maintenance Window."
- T-0 1100 ET: target completion. Status-page → Monitoring.
- T-0 1700 ET: status-page → Resolved if clean.

### Sequence

1. **Lock writes** on stage (read-only mode flag).
2. **Final stage → prod data export** for any reference seeds added since the parity check (rare).
3. **Deploy backend** via blue-green:
   - Push image to ECR.
   - Standup green target group with new image.
   - Health-check green for 5 minutes.
   - Shift 10% → 50% → 100% over 30 minutes.
4. **Run post-deploy smoke**:
   - `GET /health` → 200.
   - `POST /v1/lookup` (seeded tenant) → expected finding shape.
   - `POST /v1/synthesis` with deterministic provider → 200.
   - Webhook subscription create + test delivery → signature verified.
5. **DNS cutover**: Route 53 weighted-routing 0% → 100% to prod ALB.
   ACM cert chain verified by `openssl s_client`.
6. **First-tenant invite email** sent — admin completes SSO + MFA bootstrap.
7. **Monitoring window** — primary + secondary on-call watch dashboards
   for 2 hours. Any alarm → rollback decision tree below.
8. **Status page** → Resolved. Internal `#release-launch` retro.

## Rollback decision tree

```
P0 (data loss / cross-tenant leak / lookup down for >5 min):
  → Cut DNS back to stage (read-only).
  → File incident immediately per incident-response.md.
  → Do NOT attempt forward-fix in prod under fire.

P1 (degraded perf / single feature down):
  → Roll the green target group back to blue (previous image).
  → Hold DNS; continue monitoring.
  → Forward-fix in branch with full CI + canary.

P2 (cosmetic / non-blocking):
  → Note in retro; file ticket.
  → Continue monitoring; no rollback.
```

## Post-cutover (T+1 day to T+7 days)

| Day | Owner | Action |
|---|---|---|
| T+1 | Eng on-call | 24h dashboard review; any anomaly → ticket |
| T+1 | CSM | Tenant admin onboarding call |
| T+2 | Eng | First nightly backup verified by restore-to-staging |
| T+3 | CSM | First synthetic 835 ingested; denial dashboard reviewed with tenant |
| T+5 | Eng | First weekly digest email rendering verified |
| T+7 | All | Cutover retrospective; action items filed |

## Tenant offboarding-readiness (built before launch)

Before going live, the tenant must be able to leave without a fight:

- Self-serve data export of their `client_rulebook` history (JSON + PDF).
- Self-serve audit-log export (last N days as CSV).
- Documented deletion process with HIPAA-compatible retention overrides.
- 90-day data-deletion SLA stated in the MSA.

## Known production-only configuration

| Setting | Stage | Prod |
|---|---|---|
| Bedrock model ID | `anthropic.claude-3-5-haiku-...` (cheap) | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| RDS instance class | `db.t4g.medium` | `db.r6g.large` Multi-AZ |
| ECS task CPU/mem | 0.5 vCPU / 1 GB | 2 vCPU / 4 GB, autoscale 3–20 |
| Datadog log retention | 7d | 30d (HIPAA-eligible plan) |
| Backup retention | 7d automated | 35d automated + 1y daily `pg_dump` to S3 Object Lock |
| Synthesis feature flag default | `enabled=false` | `enabled=true` for design partners only |

Document the diff so an engineer reading either env doesn't have to guess.
