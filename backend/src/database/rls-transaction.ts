/**
 * RLS-enforcing transaction helper.
 *
 * Every request that touches tenant-scoped data MUST run through
 * `runWithTenant`. This:
 *
 *   1. Opens a Postgres transaction.
 *   2. SET LOCAL app.current_org_id = '<uuid>' so RLS policies match.
 *   3. Runs the caller's work inside that transaction with a typed Kysely tx.
 *   4. Commits on success, rolls back on throw.
 *
 * Reference data (code, modifier, payer_rule, NCCI, ...) has NO RLS and is
 * readable without a tenant context. Use `db.selectFrom(...)` directly for
 * those reads when you don't need the tenant boundary.
 */
import { Transaction, sql, type Kysely } from 'kysely';
import { isUuid } from '../common/uuid';
import type { Database } from './schema.types';

export type Tx = Transaction<Database>;

export async function runWithTenant<T>(
  db: Kysely<Database>,
  orgId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(orgId)) {
    throw new Error(`runWithTenant: orgId must be a UUID; got ${JSON.stringify(orgId)}`);
  }
  return db.transaction().execute(async (tx) => {
    // SET LOCAL with sql.lit gives Kysely-quoted, SQL-safe literal embedding.
    // Kysely / pg doesn't support bind parameters in SET commands.
    await sql`SET LOCAL app.current_org_id = ${sql.lit(orgId)}`.execute(tx);
    return work(tx);
  });
}

/**
 * Convenience wrapper for read-only paths that still need the tenant boundary
 * (e.g. list a client's rulebooks). Sets the transaction READ ONLY for
 * a tiny perf + safety win.
 */
export async function runReadOnlyWithTenant<T>(
  db: Kysely<Database>,
  orgId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return runWithTenant(db, orgId, async (tx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(tx);
    return work(tx);
  });
}
