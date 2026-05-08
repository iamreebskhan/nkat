/**
 * Postgres connection pool. One per process. Configured from validated env.
 *
 * Why pg directly + Kysely: we need explicit transaction control to set
 * `app.current_org_id` per-request via SET LOCAL. ORMs that hide the
 * transaction lifecycle make this fragile.
 */
import { Pool, type PoolConfig } from 'pg';
import type { Env } from '../config/env';

export function createPool(env: Env): Pool {
  const config: PoolConfig = {
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    max: env.PG_POOL_MAX,
    statement_timeout: env.PG_STATEMENT_TIMEOUT_MS || undefined,
    // Application name shows up in pg_stat_activity for debugging.
    application_name: 'billing-rules-backend',
  };
  if (env.PGSSLMODE !== 'disable') {
    config.ssl = { rejectUnauthorized: env.PGSSLMODE !== 'require' };
  }
  const pool = new Pool(config);
  // pg.Pool emits 'error' on idle-client failures; if no listener is
  // attached, Node treats the event as an uncaught exception and kills
  // the process. Production's logger middleware catches this; we install
  // a minimal default here so cold paths (export-openapi, scripts that
  // construct AppModule but never query) don't crash silently when the
  // DB isn't reachable.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg.Pool] idle-client error:', err.message);
  });
  return pool;
}
