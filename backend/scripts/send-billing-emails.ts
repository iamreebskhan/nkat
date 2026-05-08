#!/usr/bin/env ts-node
/**
 * Daily orchestrator that sends trial-ending + dunning emails.
 *
 * 1. Pulls every subscription whose trial_end is within 7 days OR whose
 *    status is 'past_due', joined to org for org_name + contact email.
 * 2. Calls the pure planners (`planTrialEndingEmails`, `planDunningEmails`).
 * 3. Sends each plan via the abstract `EmailClient` chain — the real
 *    SesV2EmailClient when env is wired, LoggingEmailClient otherwise.
 * 4. Idempotency keys are derived in the planner so daily re-runs
 *    + intra-day cron retries are safe no-ops.
 *
 * Run:
 *   ts-node scripts/send-billing-emails.ts [--dry-run]
 *
 * Env (any subset; defaults give a no-send dry run):
 *   DATABASE_URL
 *   APP_BASE_URL                  (default https://app.example.com)
 *   EMAIL_FROM_ADDRESS            (default no-reply@example.com)
 *   SES_REGION + AWS_*            (production only)
 *   SES_CONFIGURATION_SET
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/database/db';
import {
  planDunningEmails,
  planTrialEndingEmails,
  type SubscriptionSnapshot,
} from '../src/billing/scheduled-emails-pure';
import { EmailService } from '../src/email/email.service';
import { LoggingEmailClient } from '../src/email/logging-email-client';
import { SesV2EmailClient } from '../src/email/ses-v2-email-client';
import type { EmailClient } from '../src/email/email-types';

interface Args {
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) if (argv[i] === '--dry-run') a.dryRun = true;
  return a;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    exit(2);
  }
  const appUrl = env.APP_BASE_URL ?? 'https://app.example.com';
  const fromAddress = env.EMAIL_FROM_ADDRESS ?? 'no-reply@example.com';
  const configSet = env.SES_CONFIGURATION_SET;

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  // 1. Snapshot. Cross-tenant scan via admin connection.
  const rows = await db
    .selectFrom('subscription as s')
    .innerJoin('org as o', 'o.id', 's.org_id')
    .select([
      's.org_id',
      'o.name as org_name',
      's.status',
      's.tier',
      's.trial_end',
      's.current_period_end',
      'o.primary_contact_email',
    ])
    .where((eb) =>
      eb.or([
        eb('s.status', '=', 'past_due'),
        eb.and([
          eb('s.status', '=', 'trialing'),
          eb('s.trial_end', '<=', sql<Date>`now() + interval '7 days'`),
          eb('s.trial_end', '>', sql<Date>`now()`),
        ]),
      ]),
    )
    .execute();

  const snap: SubscriptionSnapshot[] = rows.map((r) => ({
    org_id: r.org_id,
    org_name: r.org_name,
    status: r.status,
    tier: r.tier,
    trial_end: r.trial_end,
    current_period_end: r.current_period_end,
    primary_contact_email: r.primary_contact_email,
  }));

  // 2. Plan.
  const now = Date.now();
  const trial = planTrialEndingEmails(snap, appUrl, now);
  const dunning = planDunningEmails(snap, appUrl, now);
  const plans = [...trial, ...dunning];

  console.log(
    `${rows.length} candidate sub(s); planned ${trial.length} trial-ending + ${dunning.length} dunning email(s).`,
  );

  if (plans.length === 0 || args.dryRun) {
    if (args.dryRun) console.log('--dry-run set; not sending.');
    await pool.end();
    exit(0);
  }

  // 3. Set up the EmailService directly (no Nest factory) so the script
  //    is independent of AppModule init cost.
  const client: EmailClient = env.SES_REGION
    ? new SesV2EmailClient({
        region: env.SES_REGION,
        credentialsProvider: () => {
          const accessKeyId = env.AWS_ACCESS_KEY_ID;
          const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
          const sessionToken = env.AWS_SESSION_TOKEN;
          if (!accessKeyId || !secretAccessKey) {
            throw new Error('AWS credentials missing for SesV2EmailClient');
          }
          return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
        },
      })
    : new LoggingEmailClient();
  const email = new EmailService(client, fromAddress, configSet, db);

  let sent = 0;
  let suppressed = 0;
  let dup = 0;
  let failed = 0;
  for (const p of plans) {
    const r = await email.send({
      orgId: p.org_id,
      to: p.to,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      template: p.template as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: p.args as any,
      idempotencyKey: p.idempotencyKey,
    });
    switch (r.status) {
      case 'sent': sent++; break;
      case 'suppressed': suppressed++; break;
      case 'duplicate': dup++; break;
      case 'failed': failed++; break;
    }
  }

  console.log(
    `Done: sent=${sent} suppressed=${suppressed} duplicate=${dup} failed=${failed}.`,
  );
  await pool.end();
  exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
