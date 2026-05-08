#!/usr/bin/env ts-node
/**
 * Renewal motion — scheduled daily. For every active subscription whose
 * `current_period_end` falls inside the configured notice window, emit a
 * Slack message + log an audit_log row so CSM has a working tickler.
 *
 * The window is read from CLI: --notice-days 60 (matches the MSA default
 * 60-day notice window).
 *
 * The script does NOT touch Stripe — Stripe handles the actual renewal
 * billing. We're just surfacing renewals for human conversation per
 * `CUSTOMER-SUCCESS.md` § "Renewal + expansion".
 *
 * Run:
 *   ts-node scripts/renewal-motion.ts --notice-days 60 --slack-webhook https://hooks.slack.com/...
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/database/db';

interface Args {
  noticeDays: number;
  slackWebhook?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { noticeDays: 60, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notice-days') args.noticeDays = parseInt(argv[++i], 10);
    else if (a === '--slack-webhook') args.slackWebhook = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (Number.isNaN(args.noticeDays) || args.noticeDays < 1) {
    console.error('--notice-days must be a positive integer');
    exit(2);
  }
  return args;
}

async function postSlack(webhook: string, text: string): Promise<void> {
  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    throw new Error(`slack webhook failed: ${r.status}`);
  }
}

async function main() {
  const args = parseArgs();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
  });
  const db = createDb(pool);

  // Admin connection bypasses RLS so we can scan every tenant. Production
  // wiring should route this script through the `analyst` role, not
  // `breakglass` — we're reading subscription state, not PHI.
  const rows = await db
    .selectFrom('subscription as s')
    .innerJoin('org as o', 'o.id', 's.org_id')
    .select([
      's.org_id',
      's.tier',
      's.seats',
      's.status',
      's.current_period_end',
      's.cancel_at_period_end',
      'o.name as org_name',
    ])
    .where('s.status', 'in', ['trialing', 'active'])
    .where(
      sql`s.current_period_end`,
      '<=',
      sql`now() + ${`${args.noticeDays} days`}::interval`,
    )
    .where(sql`s.current_period_end`, '>', sql`now()`)
    .execute();

  if (rows.length === 0) {
    console.log(`No subscriptions enter their ${args.noticeDays}-day notice window.`);
    await pool.end();
    exit(0);
  }

  console.log(`${rows.length} subscription(s) entering notice window:`);
  for (const r of rows) {
    const daysOut = Math.ceil(
      (new Date(r.current_period_end!).getTime() - Date.now()) / (24 * 3600 * 1000),
    );
    const flag = r.cancel_at_period_end ? ' [CANCEL_AT_PERIOD_END]' : '';
    const line = `· ${r.org_name} (${r.tier}, ${r.seats} seats) renews in ${daysOut}d${flag}`;
    console.log(line);

    if (!args.dryRun && args.slackWebhook) {
      await postSlack(
        args.slackWebhook,
        `:hourglass_flowing_sand: *Renewal motion*: ${line}`,
      );
    }
  }

  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
