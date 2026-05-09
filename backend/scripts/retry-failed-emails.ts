#!/usr/bin/env ts-node
/**
 * Retry cron — picks up `email_send` rows in `failed` status whose
 * `next_retry_at <= now()`, calls `EmailService.retryFailedSend(id)` for
 * each. Bounded by `MAX_RETRIES`; rows past the cap are dead-lettered
 * (status stays `failed`, `next_retry_at = null`, `error_class =
 * 'MaxRetriesExceeded'`).
 *
 * Idempotent: same row processed twice in the same run is a no-op
 * because the second pass sees `status` already updated.
 *
 * Run:
 *   ts-node scripts/retry-failed-emails.ts [--dry-run] [--limit 100]
 *
 * Env:
 *   DATABASE_URL
 *   EMAIL_FROM_ADDRESS, SES_REGION + AWS_*, EMAIL_UNSUBSCRIBE_SECRET,
 *   APP_BASE_URL, SES_CONFIGURATION_SET (optional)
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/database/db';
import { EmailService } from '../src/email/email.service';
import { LoggingEmailClient } from '../src/email/logging-email-client';
import { SesV2EmailClient } from '../src/email/ses-v2-email-client';
import type { EmailClient } from '../src/email/email-types';

interface Args {
  dryRun: boolean;
  limit: number;
}

function parseArgs(): Args {
  const a: Args = { dryRun: false, limit: 100 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    exit(2);
  }
  const fromAddress = env.EMAIL_FROM_ADDRESS ?? 'no-reply@example.com';
  const configSet = env.SES_CONFIGURATION_SET;
  const unsubSecret = env.EMAIL_UNSUBSCRIBE_SECRET;
  const unsubBaseUrl = env.APP_BASE_URL;

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  const candidates = await db
    .selectFrom('email_send')
    .select(['id', 'recipient', 'template', 'retry_count'])
    .where('status', '=', 'failed')
    .where('next_retry_at', 'is not', null)
    .where('next_retry_at', '<=', sql<Date>`now()`)
    .orderBy('next_retry_at', 'asc')
    .limit(args.limit)
    .execute();

  console.log(`${candidates.length} email_send row(s) eligible for retry.`);
  if (candidates.length === 0 || args.dryRun) {
    if (args.dryRun) console.log('--dry-run set; not retrying.');
    await pool.end();
    exit(0);
  }

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
  const email = new EmailService(client, fromAddress, configSet, db, unsubSecret, unsubBaseUrl);

  let sent = 0;
  let stillFailed = 0;
  let dead = 0;
  let noop = 0;
  for (const row of candidates) {
    try {
      const r = await email.retryFailedSend(row.id);
      switch (r.status) {
        case 'sent':
          sent++;
          console.log(`  ✓ ${row.id} (${row.template}) → sent`);
          break;
        case 'failed':
          stillFailed++;
          console.log(
            `  • ${row.id} (${row.template}) → still failed (attempt ${row.retry_count + 1})`,
          );
          break;
        case 'dead_lettered':
          dead++;
          console.log(`  ✗ ${row.id} (${row.template}) → DEAD (max retries)`);
          break;
        case 'noop':
          noop++;
          break;
      }
    } catch (e) {
      stillFailed++;
      console.error(`  ! ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\nDone: sent=${sent} still_failed=${stillFailed} dead=${dead} noop=${noop}.`);
  await pool.end();
  exit(stillFailed === 0 && dead === 0 ? 0 : 0); // never red-fail the cron — dead-letter is expected behavior
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
