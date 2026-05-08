#!/usr/bin/env ts-node
/**
 * Webhook delivery worker. Scans `webhook_delivery` for rows whose
 * `ready_at <= now()` and status is queued/in_flight, and dispatches
 * them via `WebhookService.runDeliveryBatch(orgId, limit)`.
 *
 * Cross-tenant scan via admin connection identifies orgs with pending
 * work; each org's batch goes through `runWithTenant` which re-applies
 * RLS for the actual claim + UPDATE.
 *
 * Run:
 *   ts-node scripts/deliver-webhooks.ts [--org-batch 50] [--per-org 25]
 *
 * Idempotency / safety:
 *   - The service's claim uses SELECT FOR UPDATE SKIP LOCKED so two
 *     concurrent workers don't double-deliver. Running this script
 *     overlapping is safe.
 *   - HMAC signature is computed at enqueue-time + persisted; this
 *     worker only POSTs + records outcome.
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { createDb } from '../src/database/db';
import { WebhookService } from '../src/webhooks/webhook.service';

interface Args {
  orgBatch: number;
  perOrg: number;
}

function parseArgs(): Args {
  const a: Args = { orgBatch: 50, perOrg: 25 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--org-batch') a.orgBatch = parseInt(argv[++i], 10);
    else if (argv[i] === '--per-org') a.perOrg = parseInt(argv[++i], 10);
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
  const svc = new WebhookService(db);

  // 1. Distinct orgs with pending deliveries. Admin connection — RLS
  //    bypassed for this scan. Per-org calls below go through tenant
  //    context.
  const orgs = await db
    .selectFrom('webhook_delivery')
    .select(['org_id'])
    .distinct()
    .where('status', 'in', ['queued', 'in_flight'])
    .where('ready_at', '<=', new Date())
    .limit(args.orgBatch)
    .execute();

  if (orgs.length === 0) {
    console.log('No webhook_delivery rows ready.');
    await pool.end();
    exit(0);
  }
  console.log(`${orgs.length} org(s) have ready deliveries.`);

  let totalSucceeded = 0;
  let totalQueued = 0;
  let totalDead = 0;
  let orgsErrored = 0;
  for (const o of orgs) {
    try {
      const results = await svc.runDeliveryBatch(o.org_id, args.perOrg);
      const succeeded = results.filter((r) => r.next_status === 'succeeded').length;
      const queued = results.filter((r) => r.next_status === 'queued').length;
      const dead = results.filter((r) => r.next_status === 'dead_letter').length;
      totalSucceeded += succeeded;
      totalQueued += queued;
      totalDead += dead;
      console.log(`  · org=${o.org_id}: ${succeeded} sent, ${queued} retry, ${dead} dead-lettered`);
    } catch (e) {
      orgsErrored++;
      console.error(`  ! org=${o.org_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    `\nDone: ${totalSucceeded} delivered, ${totalQueued} requeued, ${totalDead} dead-lettered. ${orgsErrored} org(s) errored.`,
  );
  await pool.end();
  exit(orgsErrored === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
