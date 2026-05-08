/**
 * Integration test harness — boots a real `pgvector/pgvector:pg16` container
 * via Testcontainers, applies every migration in db/migrations/* and every
 * seed in db/seed/*, and exposes a typed Kysely Db plus an admin `pg.Pool`
 * for direct SQL.
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
  pool: Pool;          // admin (BYPASSRLS) connection
  db: Db;              // Kysely bound to admin pool
  appPool: Pool;       // app-role (NOBYPASSRLS) connection — use for RLS tests
  appDb: Db;           // Kysely bound to app pool
  stop: () => Promise<void>;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');
const SEED_DIR = path.join(REPO_ROOT, 'db', 'seed');

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
    host, port,
    user: 'admin', password: 'admin_dev_only_change_in_prod',
    database: 'billing_rules',
  };
  const pool = new Pool(adminCfg);

  // Apply migrations in order.
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await pool.query(sql);
  }
  // Apply seed data in order.
  for (const f of readdirSync(SEED_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(SEED_DIR, f), 'utf8');
    await pool.query(sql);
  }

  // App-role pool (NOBYPASSRLS) — used for tests that exercise RLS.
  const appPool = new Pool({
    host, port,
    user: 'app', password: 'app_dev_only_change_in_prod',
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
