#!/usr/bin/env ts-node
/**
 * Daily executor for tenant-deletion requests (MSA § 7).
 *
 * Find every `tenant_deletion_request` whose `earliest_execute_at` has
 * passed (status in 'requested' | 'scheduled') and delete the org's
 * data. Honors `retain_audit_log` — when true, audit_log rows survive.
 *
 *   ts-node scripts/execute-tenant-deletions.ts [--dry-run] [--limit 50]
 *
 * Operates as the `breakglass` Postgres role (BYPASSRLS) so it can
 * cross every tenant boundary without app.current_org_id juggling.
 * Connection string: BREAKGLASS_DATABASE_URL (required, separate from
 * the app's DATABASE_URL — auditing requires that distinct credential).
 *
 * Discovery: tables to delete from are read from `pg_class` —
 * everything with `relrowsecurity = true` AND an `org_id` column. The
 * `org` table itself is handled specially (id = $1).
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';

interface Args {
  dryRun: boolean;
  limit: number;
}

function parseArgs(): Args {
  const a: Args = { dryRun: false, limit: 50 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

interface TenantTable {
  table_name: string;
  has_org_id: boolean; // false only for `org` itself
}

/**
 * Discover every RLS-protected, tenant-scoped table currently in the
 * schema. We use this rather than a hard-coded list so adding a new
 * tenant-scoped table doesn't silently break deletion compliance.
 */
async function discoverTenantTables(pool: Pool): Promise<TenantTable[]> {
  const r = await pool.query<{ table_name: string; has_org_id: boolean }>(`
    SELECT
      c.relname AS table_name,
      EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      ) AS has_org_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
    ORDER BY c.relname;
  `);
  return r.rows;
}

interface ReadyRequest {
  id: string;
  org_id: string;
  retain_audit_log: boolean;
  earliest_execute_at: Date;
}

async function findReady(pool: Pool, limit: number): Promise<ReadyRequest[]> {
  const r = await pool.query<ReadyRequest>(
    `SELECT id, org_id, retain_audit_log, earliest_execute_at
       FROM tenant_deletion_request
       WHERE status IN ('requested','scheduled')
         AND earliest_execute_at <= now()
       ORDER BY earliest_execute_at ASC
       LIMIT $1`,
    [limit],
  );
  return r.rows;
}

interface DeletionStats {
  byTable: Record<string, number>;
  totalRows: number;
}

async function executeOne(
  pool: Pool,
  req: ReadyRequest,
  tables: TenantTable[],
  dryRun: boolean,
): Promise<DeletionStats> {
  const stats: DeletionStats = { byTable: {}, totalRows: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Statement timeout per-tx — a deletion that hangs longer than 5
    // minutes likely indicates a stuck lock; bail and let the next run
    // pick it up.
    await client.query(`SET LOCAL statement_timeout = '300s'`);

    // Delete from every tenant-scoped table EXCEPT:
    //   - `org` itself (handled last; cascade reaches anything we missed)
    //   - `audit_log` if retain_audit_log
    //   - `tenant_deletion_request` (we update the row at the end; deleting it
    //     would lose our success record)
    for (const t of tables) {
      if (t.table_name === 'org') continue;
      if (t.table_name === 'tenant_deletion_request') continue;
      if (t.table_name === 'audit_log' && req.retain_audit_log) continue;
      if (!t.has_org_id) {
        // Table is RLS-protected without org_id — should never happen
        // except for `org` itself. Skip with a log.
        console.warn(`  ! Skipping ${t.table_name}: RLS table without org_id column.`);
        continue;
      }
      const sql = `DELETE FROM ${t.table_name} WHERE org_id = $1`;
      if (dryRun) {
        const c = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${t.table_name} WHERE org_id = $1`,
          [req.org_id],
        );
        const n = Number(c.rows[0]?.n ?? 0);
        stats.byTable[t.table_name] = n;
        stats.totalRows += n;
      } else {
        const r = await client.query(sql, [req.org_id]);
        stats.byTable[t.table_name] = r.rowCount ?? 0;
        stats.totalRows += r.rowCount ?? 0;
      }
    }

    // Mark the deletion request as executed BEFORE we touch the org row
    // (or in retain mode, keep the org row for FK integrity).
    if (!dryRun) {
      await client.query(
        `UPDATE tenant_deletion_request
            SET status = 'executed', executed_at = now()
          WHERE id = $1`,
        [req.id],
      );
    }

    // For retain_audit_log=true we keep the org row as a tombstone so
    // audit_log FK stays valid. For retain_audit_log=false delete the
    // org row — ON DELETE CASCADE wipes anything we missed.
    if (!req.retain_audit_log) {
      if (dryRun) {
        const c = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM org WHERE id = $1`,
          [req.org_id],
        );
        const n = Number(c.rows[0]?.n ?? 0);
        stats.byTable['org'] = n;
        stats.totalRows += n;
      } else {
        const r = await client.query(`DELETE FROM org WHERE id = $1`, [req.org_id]);
        stats.byTable['org'] = r.rowCount ?? 0;
        stats.totalRows += r.rowCount ?? 0;
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!dryRun) {
      // Mark failed so we don't silently retry forever.
      const reason = e instanceof Error ? e.message : String(e);
      await pool
        .query(
          `UPDATE tenant_deletion_request
              SET status = 'failed', failure_reason = $2
            WHERE id = $1`,
          [req.id, reason.slice(0, 1000)],
        )
        .catch(() => {});
    }
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs();
  const url = env.BREAKGLASS_DATABASE_URL;
  if (!url) {
    console.error('BREAKGLASS_DATABASE_URL is required (must be a BYPASSRLS role).');
    exit(2);
  }
  const pool = new Pool({ connectionString: url });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));

  // Quick sanity: confirm the role is actually BYPASSRLS so we don't
  // silently fail RLS checks on partial deletes.
  const roleCheck = await pool.query<{ rolbypassrls: boolean; rolname: string }>(
    `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const role = roleCheck.rows[0];
  if (!role?.rolbypassrls) {
    console.error(`Connected role ${role?.rolname ?? '?'} is not BYPASSRLS — abort.`);
    await pool.end();
    exit(2);
  }

  const tables = await discoverTenantTables(pool);
  console.log(`Discovered ${tables.length} tenant-scoped table(s) under RLS.`);

  const ready = await findReady(pool, args.limit);
  console.log(`Found ${ready.length} ready deletion request(s).`);
  if (ready.length === 0) {
    await pool.end();
    exit(0);
  }

  let okCount = 0;
  let failCount = 0;
  for (const req of ready) {
    console.log(
      `\n→ ${req.id} (org=${req.org_id}) ` +
        `earliest=${req.earliest_execute_at.toISOString()} ` +
        `retain_audit_log=${req.retain_audit_log}`,
    );
    try {
      const stats = await executeOne(pool, req, tables, args.dryRun);
      console.log(
        `  ok: ${stats.totalRows} row(s) ${args.dryRun ? 'would-delete' : 'deleted'} across ${
          Object.keys(stats.byTable).length
        } table(s).`,
      );
      for (const [t, n] of Object.entries(stats.byTable)) {
        if (n > 0) console.log(`    ${t}: ${n}`);
      }
      okCount += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  FAILED: ${msg}`);
      failCount += 1;
    }
  }

  console.log(`\nSummary: ${okCount} executed, ${failCount} failed.`);
  if (args.dryRun) console.log('--dry-run set; all transactions rolled back.');
  await pool.end();
  exit(failCount > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
