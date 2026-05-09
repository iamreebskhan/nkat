# Pallio production deploy runbook

Source of record for what production looks like. Update on every deploy
that changes the topology, never just in your head.

## Topology

- **App tier** — Hostinger VPS, Ubuntu 24 LTS, Node 22 LTS via PM2 cluster
  mode (1 process per vCPU). Nginx front, Let's Encrypt + auto-renew.
  Vision §12 specifies VPS path; Cloudflare Pages does not run Next.js
  SSR cleanly.
- **DB tier** — Neon Postgres 16 with pgvector. Production = 4 vCPU /
  16 GB / 200 GB storage. Branch DB per pre-prod env. Logical
  replication slot for nightly backup verifier.
- **Object storage** — Cloudflare R2 (`pallio-prod-static`,
  `pallio-prod-uploads`). Backups in AWS S3 (`pallio-prod-backups`,
  Object Lock 35d).
- **Email** — Resend transactional, SPF + DKIM on the apex.
- **Observability** — Sentry (frontend + backend), Grafana Cloud Logs
  (Nginx + PM2 stdout), Grafana SLOs panel for RLS audit + backup
  freshness.

## Deploy procedure

1. **Cut the release branch** off `main` after PR is green.
2. **Run pre-deploy checks** (block on first failure):
   - `npm run typecheck`
   - `npx vitest run`
   - `tsx scripts/rls-audit.ts` against the staging DB
   - `tsx scripts/gold-standard-eval.ts --threshold 0.95` (Phase 7 added)
3. **Apply migrations** against staging — `psql -f db/migrations/00XX_*.sql`.
   Diff `\d` of the changed tables vs. expected schema.
4. **Deploy app** to staging via Github Actions → SSH → PM2 reload.
5. **Smoke** the staging app via Playwright `npx playwright test e2e/smoke.spec.ts`.
6. **Promote** by re-running the same workflow targeting prod.
7. **Post-deploy** smoke against prod — same Playwright suite, no PHI.

## Rollback

- App tier: `pm2 reload ecosystem.config.cjs --update-env` against
  the prior commit. `<5 min` to roll back.
- DB tier: forward-only — write a fixup migration, don't roll the
  schema back. Restore from S3 snapshot only on data corruption.

## Secrets

Stored in 1Password vault `pallio-prod`. Mirrored into VPS env via
`/etc/pallio/env` (mode 0640, root:pallio). Hot reload via `pm2 reload`.

| Var | Owner | Rotated |
|---|---|---|
| `JWT_SECRET` | platform | quarterly |
| `ANTHROPIC_API_KEY` | AI | on incident |
| `OPENAI_API_KEY` | AI | on incident |
| `STRIPE_SECRET_KEY` | billing | on incident |
| `STRIPE_WEBHOOK_SECRET` | billing | on incident |
| `BACKUP_GPG_RECIPIENT` | ops | annual |
| `RESEND_API_KEY` | platform | on incident |
| `DATABASE_URL` | platform | quarterly |
| `AMA_LICENSE_TOKEN` | legal | annual |

## HIPAA gates (all must be GREEN before prod traffic)

- [ ] BAA signed with: Anthropic? **NO — PHI must never reach Claude**;
      Resend (covered); Neon (covered); R2 (covered); Sentry
      (covered, scrubber on).
- [ ] PHI guard active — `lib/ai/phi-guard.ts` asserts pre-send.
- [ ] PHI access log writes verified — query `phi_access_log` after
      smoke; expect ≥1 row per patient view.
- [ ] Audit log retention trigger active — `prevent_premature_audit_delete()`
      raises on under-6y delete. Verified by SQL test.
- [ ] RLS audit script reports 0 unprotected tables.
- [ ] AMA license in env — disables CPT descriptor redaction per-tenant.
- [ ] Encrypted at rest — Neon ENC + Object-Lock'd backups + GPG file-level
      for the dumps that leave Neon.
- [ ] Sentry scrubber on (`/regex/(\b\d{3}-\d{2}-\d{4}\b|...)/`).
- [ ] Gold-standard eval ≥ 95% — fail CI gate before flipping the
      synthesizer to sonnet-4-6 in prod.

## Backup + DR

- Nightly logical dump via `scripts/nightly-backup.sh` from a cron on
  the VPS at 04:00 UTC.
- Weekly restore-test job — pulls last Sunday's dump, restores to a
  Neon branch DB, runs `psql -c "SELECT count(*) FROM patient"` and
  diffs against prod.
- DR drill: quarterly. Document RTO + RPO per drill run in
  `docs/dr-drills.md`.

## On-call

PagerDuty rotation: weekly. First responder is the merging engineer
of the week's deploy. Escalation chain: SRE → CTO.

Critical pages:
- `/livez` returns 503 on >2 consecutive Postgres failures
- Sentry P0 issues
- `phi_access_log` insert error rate >1%
- Backup not present in S3 by 06:00 UTC
