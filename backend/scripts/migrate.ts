#!/usr/bin/env ts-node
/**
 * Forward-only migration runner.
 *
 *   ts-node scripts/migrate.ts [--target NNNN] [--dry-run] [--verify]
 *
 * Each `db/migrations/*.sql` file is applied exactly once, recorded
 * in `app.schema_migration` with its SHA-256 hash. A re-run is a no-op.
 * If a previously-applied file's hash drifts from what's recorded,
 * the runner refuses to continue (someone edited a migration after
 * apply — that's never safe).
 *
 * Flags:
 *   --target NNNN   — stop after applying file `NNNN_*`. Useful in
 *                     CI to test a known good baseline before merging
 *                     a new migration.
 *   --dry-run       — print the plan; don't apply.
 *   --verify        — only verify recorded hashes match disk; don't
 *                     apply anything new.
 *
 * Idempotent + safe under concurrent invocation (acquires a Postgres
 * advisory lock for the duration of the run).
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

const ADVISORY_LOCK_KEY = 0x0042b0c1; // arbitrary 32-bit; consistent across runs.

interface Args {
  target: string | null;
  dryRun: boolean;
  verifyOnly: boolean;
  migrationsDir: string;
}

function parseArgs(): Args {
  const a: Args = {
    target: null,
    dryRun: false,
    verifyOnly: false,
    migrationsDir: resolve(__dirname, '../../db/migrations'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--target') a.target = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--verify') a.verifyOnly = true;
    else if (argv[i] === '--dir') a.migrationsDir = resolve(argv[++i]);
  }
  return a;
}

interface MigrationFile {
  filename: string;
  number: string; // e.g. "0023"
  body: string;
  hash: string;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const filename of entries) {
    const m = filename.match(/^(\d{4})_/);
    if (!m) {
      throw new Error(`migration filename ${filename} doesn't match NNNN_* convention`);
    }
    const body = await readFile(join(dir, filename), 'utf8');
    const hash = createHash('sha256').update(body).digest('hex');
    out.push({ filename, number: m[1], body, hash });
  }
  return out;
}

async function ensureMigrationTable(pool: Pool): Promise<void> {
  // Use the `app` schema for our own bookkeeping. `app` schema +
  // `current_org_id` GUC machinery already exists from migration 0001.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.schema_migration (
      filename TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      sha256 CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT current_user,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS schema_migration_number_idx
      ON app.schema_migration (number);
  `);
}

async function readApplied(pool: Pool): Promise<Map<string, { sha256: string }>> {
  const r = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM app.schema_migration',
  );
  const m = new Map<string, { sha256: string }>();
  for (const row of r.rows) m.set(row.filename, { sha256: row.sha256 });
  return m;
}

async function withAdvisoryLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      ADVISORY_LOCK_KEY,
    ]);
    if (!got.rows[0]?.ok) {
      throw new Error(
        'another migration runner appears to be holding the advisory lock; aborting.',
      );
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function applyOne(pool: Pool, mig: MigrationFile): Promise<void> {
  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN');
    // Run the file body as a single multi-statement query — Postgres
    // libpq honors statement separators.
    await client.query(mig.body);
    await client.query(
      `INSERT INTO app.schema_migration (filename, number, sha256, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [mig.filename, mig.number, mig.hash, Date.now() - t0],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    exit(2);
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));

  await ensureMigrationTable(pool);
  const onDisk = await loadMigrations(args.migrationsDir);
  console.log(`Found ${onDisk.length} migration file(s) on disk.`);

  await withAdvisoryLock(pool, async () => {
    const applied = await readApplied(pool);

    // Drift check: every previously-applied migration's recorded hash
    // must match the file on disk.
    let drift = false;
    for (const m of onDisk) {
      const a = applied.get(m.filename);
      if (a && a.sha256 !== m.hash) {
        console.error(
          `! HASH DRIFT: ${m.filename} on disk (${m.hash.slice(0, 12)}…) ` +
            `differs from recorded (${a.sha256.slice(0, 12)}…). ` +
            `Migrations are forward-only — never edit an applied file.`,
        );
        drift = true;
      }
    }
    if (drift) {
      throw new Error('migration drift detected; refusing to continue.');
    }

    if (args.verifyOnly) {
      console.log('verify-only: all recorded hashes match disk.');
      return;
    }

    // Plan
    const pending = onDisk.filter((m) => !applied.has(m.filename));
    const plan = args.target ? pending.filter((m) => m.number <= args.target!) : pending;
    if (plan.length === 0) {
      console.log('Nothing to apply.');
      return;
    }
    for (const m of plan) {
      console.log(`  → ${m.filename} (${m.hash.slice(0, 12)})`);
    }
    if (args.dryRun) {
      console.log('--dry-run: no SQL executed.');
      return;
    }
    for (const m of plan) {
      console.log(`Applying ${m.filename}...`);
      const t0 = Date.now();
      await applyOne(pool, m);
      console.log(`  ✓ ${m.filename} in ${Date.now() - t0}ms`);
    }
    console.log(`Applied ${plan.length} migration(s).`);
  });

  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error('migration failed:', e instanceof Error ? e.message : e);
  exit(1);
});
