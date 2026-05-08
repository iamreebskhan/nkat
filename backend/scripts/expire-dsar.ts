#!/usr/bin/env ts-node
/**
 * Daily DSAR auto-expiry: any `dsar_request` row whose `due_at` is
 * more than 7 days in the past AND is still in `received` /
 * `verified` flips to `status='expired'` with a synthetic note.
 *
 * The 7-day grace beyond the 45-day clock catches operator delay
 * without auto-flipping a request the team already started but
 * hasn't yet marked `fulfilled`.
 *
 * Operator must investigate every expired row — it represents a
 * compliance breach (45-day SLA missed). The audit_log entry
 * `privacy.dsar_auto_expired` is the SOC 2 evidence.
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';

interface Args { dryRun: boolean }

function parseArgs(): Args {
  const a: Args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL && !env.BREAKGLASS_DATABASE_URL) {
    console.error('DATABASE_URL or BREAKGLASS_DATABASE_URL is required.');
    exit(2);
  }
  // Use breakglass when available (cross-tenant scan + write). The
  // expiration is a fail-open audit signal, not a security control,
  // so falling back to DATABASE_URL is acceptable in single-tenant
  // dev environments.
  const url = env.BREAKGLASS_DATABASE_URL ?? env.DATABASE_URL!;
  const pool = new Pool({ connectionString: url });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));

  // Find candidates: status in (received, verified) AND due_at + 7d < now.
  const rows = await pool.query<{
    id: string;
    org_id: string;
    regime: string;
    request_type: string;
    due_at: Date;
    received_at: Date;
  }>(
    `SELECT id, org_id, regime, request_type, due_at, received_at
       FROM dsar_request
       WHERE status IN ('received', 'verified')
         AND due_at < now() - interval '7 days'
       ORDER BY due_at ASC
       LIMIT 1000`,
  );
  console.log(`Found ${rows.rows.length} overdue DSAR(s).`);
  if (rows.rows.length === 0) {
    await pool.end();
    exit(0);
  }
  if (args.dryRun) {
    for (const r of rows.rows) {
      const overdueDays = Math.floor((Date.now() - r.due_at.getTime()) / 86_400_000);
      console.log(`  ${r.id} (org=${r.org_id}) regime=${r.regime} ${overdueDays}d overdue`);
    }
    console.log('--dry-run: no updates issued.');
    await pool.end();
    exit(0);
  }

  let count = 0;
  for (const r of rows.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE dsar_request
            SET status = 'expired',
                rejection_reason = COALESCE(rejection_reason, '') ||
                  ' [auto-expired: 45-day SLA + 7-day grace exceeded]'
          WHERE id = $1
            AND status IN ('received', 'verified')
          RETURNING id`,
        [r.id],
      );
      if (upd.rowCount === 1) {
        await client.query(
          `INSERT INTO audit_log
            (org_id, user_id, action, target_type, target_id, payload, ip_address, user_agent)
           VALUES ($1, NULL, 'privacy.dsar_auto_expired', 'dsar_request', $2, $3, NULL, 'cron:expire-dsar')`,
          [r.org_id, r.id, JSON.stringify({
            regime: r.regime,
            request_type: r.request_type,
            due_at: r.due_at.toISOString(),
            overdue_days: Math.floor((Date.now() - r.due_at.getTime()) / 86_400_000),
          })],
        );
        count += 1;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ! ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.release();
    }
  }
  console.log(`Expired ${count} DSAR(s).`);
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
