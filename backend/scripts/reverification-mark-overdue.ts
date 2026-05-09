/* eslint-disable no-console */
/**
 * scripts/reverification-mark-overdue.ts
 *
 * Cron-friendly: flips pending attestation_reverification rows past their
 * reverify_by date to status='overdue'. Intended to run daily.
 *
 *   npm run reverification:mark-overdue
 */
import 'reflect-metadata';
import { loadEnv } from '../src/config/env';
import { createPool } from '../src/database/pool';
import { createDb } from '../src/database/db';
import { ReverificationService } from '../src/reverification/reverification.service';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const db = createDb(pool);
  const svc = new ReverificationService(db);

  const result = await svc.markOverdue();
  console.log(`marked_overdue=${result.marked}`);

  const due = await svc.listDue();
  for (const item of due) {
    console.log(
      `  rule=${item.payer_rule_id} reverify_by=${item.reverify_by.toISOString().slice(0, 10)} days_overdue=${item.days_overdue}`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
