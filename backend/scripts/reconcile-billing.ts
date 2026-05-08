#!/usr/bin/env ts-node
/**
 * Billing reconciler orchestrator. Scheduled task that:
 *
 *   1. Reads recent `billing_event` rows (last `--lookback-hours`).
 *   2. Calls `findStaleInvoiceEvents` to identify subscriptions whose
 *      `invoice.*` events have no follow-up `customer.subscription.*`.
 *   3. For each, calls Stripe `retrieveSubscription`.
 *   4. Wraps the response in a synthetic `customer.subscription.updated`
 *      event and calls `BillingService.ingestEvent` — which is idempotent
 *      on the synthetic event id, so re-running the script is safe.
 *
 * Designed for EventBridge → Lambda invocation, but runs from the CLI
 * during stage rehearsal too. Reads admin (BYPASSRLS) connection — the
 * cross-tenant scan is intentional. The `ingestEvent` per-org call goes
 * through `runWithTenant` which re-applies RLS.
 *
 * Run:
 *   ts-node scripts/reconcile-billing.ts \
 *     --lookback-hours 24 --stale-seconds 600
 *
 * Env required:
 *   DATABASE_URL
 *   STRIPE_API_KEY     (sk_live_... in prod)
 */
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { createDb } from '../src/database/db';
import { BillingService } from '../src/billing/billing.service';
import { StripeApiClient } from '../src/billing/stripe-api-client';
import { buildSyntheticReconcileEvent, findStaleInvoiceEvents, type MinimalBillingEvent } from '../src/billing/reconciler';

interface Args {
  lookbackHours: number;
  staleSeconds: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { lookbackHours: 24, staleSeconds: 600, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--lookback-hours') a.lookbackHours = parseInt(argv[++i], 10);
    else if (x === '--stale-seconds') a.staleSeconds = parseInt(argv[++i], 10);
    else if (x === '--dry-run') a.dryRun = true;
  }
  if (Number.isNaN(a.lookbackHours) || a.lookbackHours < 1) {
    console.error('--lookback-hours must be a positive integer');
    exit(2);
  }
  return a;
}

async function main() {
  const args = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    exit(2);
  }
  if (!args.dryRun && !env.STRIPE_API_KEY) {
    console.error('STRIPE_API_KEY is required (or pass --dry-run)');
    exit(2);
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  // 1. Pull recent billing_event rows. Admin role: cross-tenant scan.
  const since = new Date(Date.now() - args.lookbackHours * 3600 * 1000);
  const events = await db
    .selectFrom('billing_event')
    .select(['org_id', 'event_type', 'occurred_at', 'raw_payload'])
    .where('received_at', '>=', since)
    .orderBy('occurred_at', 'asc')
    .execute();

  console.log(`Loaded ${events.length} billing_event rows since ${since.toISOString()}`);

  const minimal: MinimalBillingEvent[] = events.map((e) => ({
    org_id: e.org_id,
    event_type: e.event_type,
    occurred_at: e.occurred_at,
    raw_payload: e.raw_payload as Record<string, unknown>,
  }));

  // 2. Identify what needs a refetch.
  const plan = findStaleInvoiceEvents({
    events: minimal,
    nowMs: Date.now(),
    staleSeconds: args.staleSeconds,
  });

  if (plan.subscriptions_to_refetch.length === 0) {
    console.log('No reconciliation work needed.');
    await pool.end();
    exit(0);
  }
  console.log(`${plan.subscriptions_to_refetch.length} subscription(s) need refetch:`);
  for (const r of plan.subscriptions_to_refetch) {
    console.log(`  · ${r.stripe_subscription_id} (org ${r.org_id}): ${plan.reasons[r.stripe_subscription_id]}`);
  }

  if (args.dryRun) {
    console.log('--dry-run set; not calling Stripe.');
    await pool.end();
    exit(0);
  }

  // 3-4. Refetch + idempotent ingest.
  const stripe = new StripeApiClient({ apiKey: env.STRIPE_API_KEY! });
  const billing = new BillingService(db);

  let succeeded = 0;
  let failed = 0;
  for (const r of plan.subscriptions_to_refetch) {
    try {
      const sub = await stripe.retrieveSubscription(r.stripe_subscription_id);
      const synthetic = buildSyntheticReconcileEvent(r.org_id, sub, Date.now());
      const out = await billing.ingestEvent({ orgId: r.org_id, event: synthetic, subscription: sub });
      console.log(`  ✓ ${r.stripe_subscription_id}: ${out.duplicate ? 'duplicate (idempotent)' : 'applied'}`);
      succeeded++;
    } catch (e) {
      console.error(`  ✗ ${r.stripe_subscription_id}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  console.log(`\nReconciler done: ${succeeded} applied, ${failed} failed.`);
  await pool.end();
  exit(failed === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
