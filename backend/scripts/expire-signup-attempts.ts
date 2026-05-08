#!/usr/bin/env ts-node
/**
 * Daily cleanup of stale `signup_attempt` rows. For each pending row
 * past `expires_at`:
 *   1. Mark it `expired`.
 *   2. If the linked `org` has no `subscription` row, delete the org —
 *      it's an abandoned signup that never reached a successful Checkout.
 *      This frees the slug and keeps `org_status_idx` clean.
 *
 * Idempotent: re-running the script after a successful run is a no-op.
 *
 * Run:
 *   ts-node scripts/expire-signup-attempts.ts [--dry-run]
 *
 * Env:
 *   DATABASE_URL
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/database/db';

interface Args {
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    exit(2);
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  // 1. Stale candidates.
  const stale = await db
    .selectFrom('signup_attempt')
    .select(['id', 'org_id', 'admin_email'])
    .where('status', '=', 'pending')
    .where('expires_at', '<', sql<Date>`now()`)
    .execute();

  if (stale.length === 0) {
    console.log('No stale signup_attempt rows.');
    await pool.end();
    exit(0);
  }
  console.log(`${stale.length} stale signup_attempt row(s):`);

  let attemptsExpired = 0;
  let orgsDeleted = 0;
  for (const row of stale) {
    console.log(`  · attempt=${row.id} org=${row.org_id} email=${row.admin_email}`);
    if (args.dryRun) continue;

    await db
      .updateTable('signup_attempt')
      .set({ status: 'expired' })
      .where('id', '=', row.id)
      .execute();
    attemptsExpired++;

    const sub = await db
      .selectFrom('subscription')
      .select(['id'])
      .where('org_id', '=', row.org_id)
      .executeTakeFirst();
    if (!sub) {
      // No subscription → abandoned signup → reclaim the org row +
      // its slug. ON DELETE CASCADE on org_member / org / signup_attempt
      // does the rest.
      await db.deleteFrom('org').where('id', '=', row.org_id).execute();
      orgsDeleted++;
      console.log(`    → org ${row.org_id} deleted (no subscription)`);
    }
  }

  console.log(`\nDone: ${attemptsExpired} expired, ${orgsDeleted} orphan orgs deleted.`);
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
