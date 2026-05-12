# Pallio production launch checklist

Every item below must be GREEN before flipping DNS to prod.

## 1 · Vendor accounts + tokens (you own these)

| What | Where to get it | Where it lands | Required at launch? |
|---|---|---|---|
| Hosting account | Hostinger VPS *or* Vercel | n/a | ✅ |
| Production domain | Registrar of choice | DNS A/CNAME → host | ✅ |
| Postgres 16 + pgvector | Neon / Supabase / self-hosted | `DATABASE_URL` | ✅ |
| Anthropic API key | console.anthropic.com | `ANTHROPIC_API_KEY` | ✅ for AI lookup |
| OpenAI API key (embeddings only) | platform.openai.com | `OPENAI_API_KEY` | ✅ for vector search |
| Resend API key | resend.com | `RESEND_API_KEY` | ✅ for emails |
| Resend domain verified | DNS TXT records | n/a | ✅ before first invite |
| Stripe live mode account | dashboard.stripe.com | `STRIPE_SECRET_KEY` | ✅ for paid plans |
| Stripe webhook signing secret | Stripe → Webhooks → endpoint | `STRIPE_WEBHOOK_SECRET` | ✅ |
| Stripe Price IDs (solo / team / org) | Stripe → Products | `STRIPE_PRICE_SOLO/TEAM/ORG` | ✅ |
| AMA CPT license token | AMA royalties portal | `AMA_LICENSE_TOKEN` | ⚠️ until set, descriptors are redacted (vision §15.1) |
| Sentry DSN | sentry.io project settings | `SENTRY_DSN` (Phase 11) | Recommended |
| Backup S3 bucket + keys | aws.amazon.com | `BACKUP_BUCKET`, `AWS_*` | ✅ for nightly backup |
| BAA-signed transactional email vendor | Resend BAA add-on | n/a | ✅ for HIPAA scope |

## 2 · Secrets you mint yourself

```bash
# 32+ char random strings — generate once, store in 1Password/Vault.
JWT_SECRET=$(openssl rand -hex 32)
PALLIO_PHI_KEY=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 24)
BACKUP_GPG_RECIPIENT=...   # GPG keyring ID; not auto-generated
```

## 3 · App env (production .env on the VPS / Vercel project)

```env
NODE_ENV=production
APP_BASE_URL=https://app.pallio.io

# Postgres
DATABASE_URL=postgres://app:STRONGPASS@neon-host/pallio?sslmode=require

# Auth
JWT_SECRET=<from §2>
JWT_EXPIRES_IN=7d
COOKIE_NAME=pallio_session

# AI
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Email
RESEND_API_KEY=re_...
EMAIL_FROM_ADDRESS=no-reply@pallio.io

# Stripe (live mode)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_SOLO=price_...
STRIPE_PRICE_TEAM=price_...
STRIPE_PRICE_ORG=price_...
STRIPE_PRICE_ENT=price_...

# AMA license — leave UNSET until contract signed; redaction stays on.
# AMA_LICENSE_TOKEN=...

# pgcrypto + cron
PALLIO_PHI_KEY=<from §2>
CRON_SECRET=<from §2>

# Backup
BACKUP_BUCKET=pallio-prod-backups
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
BACKUP_GPG_RECIPIENT=ops@pallio.io
```

## 4 · Database bring-up

```bash
# 1. Apply every migration in order against the prod Postgres.
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done

# 2. Apply seeds.
for f in db/seed/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done

# 3. Pre-deploy gate: every tenant table has RLS.
DATABASE_URL=$DATABASE_URL npm run rls:audit

# 4. Pre-deploy gate: AI eval (skipped if no ANTHROPIC_API_KEY).
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY npm run eval:gold-standard -- --threshold 0.95
```

## 5 · App deploy

```bash
# Build artifact
npm ci
npm run build

# PM2 / systemd / Vercel — your deploy story.
pm2 start ecosystem.config.cjs --env production
```

## 6 · Stripe webhook wiring

1. In Stripe dashboard → Webhooks → add endpoint
   `https://app.pallio.io/api/webhooks/stripe`
2. Subscribe to: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

## 7 · Cron wiring (nightly)

| Job | Command | Schedule |
|---|---|---|
| Payer-rule alert digest | `curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.pallio.io/api/cron/payer-rule-alerts` | `0 13 * * *` (08:00 ET) |
| Logical backup | `bash scripts/nightly-backup.sh` (on the VPS) | `0 4 * * *` |

Vercel: declare in `vercel.json` `crons` field.
VPS: cron entries on the deploy host.

## 8 · Post-deploy verification (Playwright)

```bash
PALLIO_BASE_URL=https://app.pallio.io \
PALLIO_SMOKE_USER_EMAIL=smoke@pallio.io \
PALLIO_SMOKE_USER_PASSWORD=<smoke pw> \
npm run smoke
```

Expect: 5/5 specs green.

## 9 · HIPAA gates (final sign-off)

- [ ] BAA executed with: Resend, Neon (or your DB host), R2/S3, Sentry.
      **NOT** Anthropic — PHI never reaches Claude (PHI guard active).
- [ ] PHI guard active (verified by `lib/ai/__tests__/phi-guard.spec.ts` — 14/14 green in CI).
- [ ] PHI access log writes verified — query `phi_access_log` after smoke; expect ≥1 row per patient view.
- [ ] Audit log retention trigger active (verify by attempting to delete a row younger than 6y → must throw `check_violation`).
- [ ] RLS audit script reports 0 unprotected tables.
- [ ] AMA license token decision made (leave unset → descriptors gated; set → AMA badge flips green).
- [ ] Encrypted at rest: Neon ENC + Object-Lock S3 + GPG file-level on dumps.
- [ ] Sentry scrubber on (the `lib/observability/sentry.ts` shim is wired; replace with real SDK init when DSN is in env).

## 10 · Day-1 ops

- PagerDuty rotation set; first responder = current week's deployer.
- Status page configured (statuspage.io / Better Uptime).
- `/api/health/livez` polled every 30s by load balancer.
- Sentry P0 alerts → on-call.

---

## What's already done in the repo

✅ Every line of code, migration, test, and runbook to support all of §1–§10.
✅ 12 PRs merged with full 7-job CI green on each.
✅ Local production build verified: `npm run build` clean, `npm start` boots, `/api/health/livez` returns 503 with `db_unreachable: timeout` when no DB is reachable (= correct fail-loud behavior).

## What's still on you (the human)

The §1 vendor list. None of those values can be generated by an agent.
Once the secrets are in env on the deploy target, this checklist is mechanical.
