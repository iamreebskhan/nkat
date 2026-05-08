#!/usr/bin/env ts-node
/**
 * Daily cleanup of bounded-lifetime tables. Targets:
 *
 *   1. `idempotency_record`           — DELETE WHERE expires_at < now().
 *      24h-default TTL set at insert; cleanup keeps the table bounded.
 *
 *   2. `email_send` historical churn  — DELETE rows older than 90 days
 *      whose status IS NOT 'failed' (we keep `failed` rows around for
 *      forensic access + the retry surface).
 *
 *   3. `synthesis_cache`              — DELETE WHERE expires_at < now().
 *      7-day default TTL set at insert. Bounded cache, no PHI risk
 *      (per-org scoped at write time).
 *
 *   4. `signup_attempt` cleanup runs in its own script
 *      (`expire-signup-attempts.ts`) — separate cron because that one
 *      also deletes orphaned orgs.
 *
 * Bounded per-run by `--limit` (default 50_000 rows per table) so a
 * single invocation can't lock the table for hours.
 *
 * Run:
 *   ts-node scripts/cleanup-expired-records.ts [--dry-run] [--limit 50000]
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDb } from '../src/database/db';

interface Args {
  dryRun: boolean;
  limit: number;
}

function parseArgs(): Args {
  const a: Args = { dryRun: false, limit: 50_000 };
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
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  // --- 1. idempotency_record -------------------------------------------
  const expiredIdemp = await db
    .selectFrom('idempotency_record')
    .select(({ fn }) => [fn.count<number>('key').as('n')])
    .where('expires_at', '<', sql<Date>`now()`)
    .executeTakeFirst();
  const expiredCount = Number(expiredIdemp?.n ?? 0);
  console.log(`idempotency_record: ${expiredCount} expired row(s).`);

  if (!args.dryRun && expiredCount > 0) {
    // Bounded delete via subquery LIMIT — keeps lock duration sane.
    const r = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT org_id, key
        FROM idempotency_record
        WHERE expires_at < now()
        LIMIT ${args.limit}
      )
      DELETE FROM idempotency_record r
      USING victims v
      WHERE r.org_id = v.org_id AND r.key = v.key
      RETURNING 1 AS deleted
    `.execute(db);
    console.log(`  → deleted ${r.rows.length} row(s).`);
  }

  // --- 2. email_send historical churn ----------------------------------
  // We keep `failed` rows for the retry / dead-letter surface; everything
  // else past 90 days is observability noise we don't need.
  const oldEmail = await db
    .selectFrom('email_send')
    .select(({ fn }) => [fn.count<number>('id').as('n')])
    .where('status', '!=', 'failed')
    .where('created_at', '<', sql<Date>`now() - interval '90 days'`)
    .executeTakeFirst();
  const oldEmailCount = Number(oldEmail?.n ?? 0);
  console.log(`email_send (>90d, not failed): ${oldEmailCount} row(s).`);

  if (!args.dryRun && oldEmailCount > 0) {
    const r = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT id
        FROM email_send
        WHERE status != 'failed'
          AND created_at < now() - interval '90 days'
        LIMIT ${args.limit}
      )
      DELETE FROM email_send r
      USING victims v
      WHERE r.id = v.id
      RETURNING 1 AS deleted
    `.execute(db);
    console.log(`  → deleted ${r.rows.length} row(s).`);
  }

  // --- 3. synthesis_cache (7-day TTL) ---------------------------------
  const expiredCache = await db
    .selectFrom('synthesis_cache')
    .select(({ fn }) => [fn.count<number>('content_hash').as('n')])
    .where('expires_at', '<', sql<Date>`now()`)
    .executeTakeFirst();
  const expiredCacheCount = Number(expiredCache?.n ?? 0);
  console.log(`synthesis_cache: ${expiredCacheCount} expired row(s).`);

  if (!args.dryRun && expiredCacheCount > 0) {
    const r = await sql<{ deleted: number }>`
      WITH victims AS (
        SELECT org_id, content_hash
        FROM synthesis_cache
        WHERE expires_at < now()
        LIMIT ${args.limit}
      )
      DELETE FROM synthesis_cache c
      USING victims v
      WHERE c.org_id = v.org_id AND c.content_hash = v.content_hash
      RETURNING 1 AS deleted
    `.execute(db);
    console.log(`  → deleted ${r.rows.length} row(s).`);
  }

  if (args.dryRun) console.log('\n--dry-run set; no DELETEs issued.');
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
