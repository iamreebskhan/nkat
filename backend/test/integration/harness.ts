/**
 * Integration test harness — boots a real `pgvector/pgvector:pg16` container
 * via Testcontainers, applies every migration in db/migrations/* and the seeds
 * in db/seed/MANIFEST order (see seedFiles), and exposes a typed Kysely Db
 * plus an admin `pg.Pool` for direct SQL.
 *
 * The harness is opt-in: integration tests are skipped automatically when
 * Docker isn't reachable (via the `INTEGRATION` env flag). CI sets the flag
 * and provides a pgvector service; locally you can `INTEGRATION=1 npm run
 * test:integration` once Docker is healthy.
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createDb } from '../../src/database/db';
import type { Db } from '../../src/database/db';

export interface IntegrationContext {
  container: StartedTestContainer;
  pool: Pool; // admin (BYPASSRLS) connection
  db: Db; // Kysely bound to admin pool
  appPool: Pool; // app-role (NOBYPASSRLS) connection — use for RLS tests
  appDb: Db; // Kysely bound to app pool
  stop: () => Promise<void>;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const SEED_DIR = path.join(REPO_ROOT, 'db', 'seed');

/**
 * The CI-only fixtures db/seed/MANIFEST keeps out of the deploy, applied just
 * before the first payer-rules-* seed. Must match FIXTURES_BEFORE_RULES in
 * .github/workflows/ci.yml; lib/__tests__/ci-seed-order-drift.spec.ts fails if
 * they diverge. Before the rule library because 0018 writes payer_rule keys
 * the library also writes: after it, both would stay live and a LIMIT 1 lookup
 * would answer by row order.
 */
export const FIXTURES_BEFORE_RULES = [
  '0016_phase11_design_partner_subscription.sql',
  '0017_test_users.sql',
  '0018_test_palliative_payer_rules.sql',
  '0020_local_clinical_fixture.sql',
  'ingestion-source-medicare-pdf.sql',
];

/**
 * CI applies these after the rule library (FIXTURES_AFTER_RULES in ci.yml).
 * This harness does NOT: they are psql scripts — \set, \if, :'variables' —
 * which pool.query cannot run, and they are demo data no integration spec
 * reads. CI's schema-apply job applies them with psql on every push, so they
 * are still proved to apply. Listed here so the drift spec can hold this list
 * and ci.yml's in step.
 */
export const FIXTURES_AFTER_RULES_PSQL_ONLY = ['tenant-demo-palliative.sql'];

/**
 * The seeds this harness applies, in order: db/seed/MANIFEST — the file
 * scripts/deploy.sh walks, so the rule library these specs read is the one
 * production applies — with FIXTURES_BEFORE_RULES placed exactly where ci.yml
 * places them.
 *
 * It used to be readdirSync(SEED_DIR).sort(), i.e. filesystem order, which
 * broke two ways at once. '-' (0x2D) sorts before '.' (0x2E), so
 * payer-rules-denial-attributes-2.sql ran before round 1 and whichever ran
 * last won; glob order also reached payer-rules-aetna-frequency.sql before the
 * source document it references, failing on payer_rule_source_doc_id_fkey. And
 * it fed tenant-demo-palliative.sql — a psql script — to pool.query, which
 * fails on its first \set. CI's jest step runs this harness with INTEGRATION=1,
 * so both were live failures, not hypotheticals.
 */
export function seedFiles(seedDir: string = SEED_DIR): string[] {
  const manifest = readFileSync(path.join(seedDir, 'MANIFEST'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
  const out: string[] = [];
  let fixturesDone = false;
  for (const f of manifest) {
    if (!fixturesDone && f.startsWith('payer-rules-')) {
      out.push(...FIXTURES_BEFORE_RULES);
      fixturesDone = true;
    }
    out.push(f);
  }
  if (!fixturesDone) {
    throw new Error(
      'db/seed/MANIFEST lists no payer-rules-* seed, so the fixtures were never applied',
    );
  }
  return out;
}

/** Returns true if Docker is reachable; otherwise integration tests are skipped. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    // The Testcontainers runtime probes the daemon during container .start().
    // To avoid a cascade of timeouts, we do a fast TCP check on common
    // Docker Desktop named pipes via a no-op container metadata call.
    // Falling back: just try `new GenericContainer('hello-world')` with a
    // short timeout. Cheaper: just try to connect to the daemon socket.
    // Easiest portable check: env var, since CI sets it explicitly.
    if (process.env.INTEGRATION === '1') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Start a fresh Postgres container, wire pools, apply every migration + seed.
 * Returns a context with both an admin pool (for setup / break-glass) and an
 * app-role pool (NOBYPASSRLS) for exercising RLS policies.
 */
export async function startIntegrationContext(): Promise<IntegrationContext> {
  const container = await new GenericContainer('pgvector/pgvector:pg16')
    .withEnvironment({
      POSTGRES_USER: 'admin',
      POSTGRES_PASSWORD: 'admin_dev_only_change_in_prod',
      POSTGRES_DB: 'billing_rules',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminCfg = {
    host,
    port,
    user: 'admin',
    password: 'admin_dev_only_change_in_prod',
    database: 'billing_rules',
  };
  const pool = new Pool(adminCfg);

  // Apply migrations in order.
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await pool.query(sql);
  }
  // Apply seed data in MANIFEST order — see seedFiles.
  for (const f of seedFiles()) {
    const sql = readFileSync(path.join(SEED_DIR, f), 'utf8');
    // pool.query sends plain SQL. A psql meta-command would fail with an
    // unhelpful syntax error somewhere in the file; name the real cause.
    if (/^\s*\\[a-zA-Z]/m.test(sql)) {
      throw new Error(
        `db/seed/${f} contains psql meta-commands (\\set, \\if, …), which pool.query cannot run. ` +
          'Apply it with psql, or list it in FIXTURES_AFTER_RULES_PSQL_ONLY.',
      );
    }
    await pool.query(sql);
  }

  // App-role pool (NOBYPASSRLS) — used for tests that exercise RLS.
  const appPool = new Pool({
    host,
    port,
    user: 'app',
    password: 'app_dev_only_change_in_prod',
    database: 'billing_rules',
  });

  return {
    container,
    pool,
    db: createDb(pool),
    appPool,
    appDb: createDb(appPool),
    stop: async () => {
      await pool.end().catch(() => undefined);
      await appPool.end().catch(() => undefined);
      await container.stop({ timeout: 5_000 }).catch(() => undefined);
    },
  };
}

/**
 * Helper: only run the suite when INTEGRATION=1. Wraps Jest's `describe` so
 * the file still parses without a daemon present.
 */
export const integrationDescribe: jest.Describe =
  process.env.INTEGRATION === '1' ? describe : describe.skip;
