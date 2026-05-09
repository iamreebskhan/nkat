#!/usr/bin/env ts-node
/**
 * Bump the global synthesis-cache version. Same effect as the admin
 * endpoint, but invokable from a CI/CD step or an ops shell — useful
 * after a payer-rule deploy where there's no human admin to click.
 *
 * Run:
 *   ts-node scripts/invalidate-cache.ts --note "ncci-2026-q3-deploy"
 *
 * Env:
 *   DATABASE_URL
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { createDb } from '../src/database/db';
import { CacheVersionService } from '../src/synthesis/cache-version.service';

interface Args {
  note?: string;
}

function parseArgs(): Args {
  const a: Args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--note') a.note = argv[++i];
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
  const svc = new CacheVersionService(db);
  const v = await svc.bump({
    byUserId: null,
    note: args.note ?? `cli-${new Date().toISOString()}`,
  });
  console.log(`synthesis_cache.version → ${v} (note: ${args.note ?? '(cli)'})`);
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
