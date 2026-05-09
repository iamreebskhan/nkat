#!/usr/bin/env ts-node
/**
 * SES feedback round-trip verifier. Sends real emails to AWS's SES
 * Mailbox Simulator addresses; SES returns synthetic
 * bounce/complaint/delivery feedback through the configured SNS topic;
 * our `/v1/internal/ses-feedback` endpoint updates `email_suppression`.
 *
 * What we send (per AWS docs):
 *   bounce@simulator.amazonses.com         → permanent bounce
 *   complaint@simulator.amazonses.com      → complaint
 *   ooto@simulator.amazonses.com           → out-of-office (ignored)
 *   suppressionlist@simulator.amazonses.com → SES suppression list bounce
 *   success@simulator.amazonses.com        → normal delivery (control)
 *
 * After sending, the script polls `email_suppression` for the expected
 * rows. If they don't appear within `--wait-seconds` (default 90), the
 * round-trip fails — meaning SNS / our endpoint / our DB writer is
 * broken somewhere in the chain.
 *
 * Run (against stage with real AWS creds):
 *   ts-node scripts/ses-feedback-simulator.ts \
 *     --from no-reply@stage.example.com \
 *     --wait-seconds 90
 *
 * Env required:
 *   DATABASE_URL
 *   SES_REGION
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or session token)
 *   SES_CONFIGURATION_SET (must be the one wired to the feedback topic)
 */
import { argv, env, exit } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createDb } from '../src/database/db';
import { SesV2EmailClient } from '../src/email/ses-v2-email-client';

interface Args {
  from: string;
  waitSeconds: number;
  cases: Array<'bounce' | 'complaint' | 'success'>;
}

const SIMULATOR = {
  bounce: 'bounce@simulator.amazonses.com',
  complaint: 'complaint@simulator.amazonses.com',
  success: 'success@simulator.amazonses.com',
} as const;

function parseArgs(): Args {
  const a: Args = {
    from: '',
    waitSeconds: 90,
    cases: ['bounce', 'complaint', 'success'],
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--from') a.from = argv[++i];
    else if (argv[i] === '--wait-seconds') a.waitSeconds = parseInt(argv[++i], 10);
  }
  if (!a.from) {
    console.error('--from <verified-sender> is required');
    exit(2);
  }
  return a;
}

async function main() {
  const args = parseArgs();
  for (const k of ['DATABASE_URL', 'SES_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if (!env[k]) {
      console.error(`${k} is required`);
      exit(2);
    }
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  const db = createDb(pool);

  const client = new SesV2EmailClient({
    region: env.SES_REGION!,
    credentialsProvider: () => ({
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    }),
  });

  const sent: Array<{ case: 'bounce' | 'complaint' | 'success'; to: string; messageId: string }> =
    [];

  for (const c of args.cases) {
    const to = SIMULATOR[c];
    console.log(`Sending ${c} simulator to ${to}…`);
    try {
      const r = await client.send({
        from: args.from,
        to,
        subject: `[ses-feedback-simulator] ${c}`,
        text: `Simulator probe (${c}). Generated ${new Date().toISOString()}.`,
        html: `<p>Simulator probe (${c}).</p>`,
        ...(env.SES_CONFIGURATION_SET ? { configurationSetName: env.SES_CONFIGURATION_SET } : {}),
      });
      sent.push({ case: c, to, messageId: r.messageId });
      console.log(`  → MessageId ${r.messageId}`);
    } catch (e) {
      console.error(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (sent.length === 0) {
    await pool.end();
    exit(1);
  }

  // Poll suppression list for the bounce + complaint addresses.
  console.log(`\nPolling email_suppression for up to ${args.waitSeconds}s…`);
  const expected = sent
    .filter((s) => s.case === 'bounce' || s.case === 'complaint')
    .map((s) => s.to);
  const start = Date.now();
  const outstanding = new Set(expected);
  while (outstanding.size > 0 && (Date.now() - start) / 1000 < args.waitSeconds) {
    const rows = await db
      .selectFrom('email_suppression')
      .select(['email', 'reason', 'source'])
      .where('email', 'in', expected)
      .execute();
    for (const r of rows) {
      if (outstanding.has(r.email)) {
        console.log(`  ✓ ${r.email} → ${r.reason} (${r.source})`);
        outstanding.delete(r.email);
      }
    }
    if (outstanding.size > 0) await sleep(5000);
  }

  if (outstanding.size > 0) {
    console.error(`\n✗ Did not observe suppression rows for: ${[...outstanding].join(', ')}`);
    console.error(
      '  Check: SNS topic subscription confirmed? /v1/internal/ses-feedback reachable from SNS? Topic ARN allowlisted?',
    );
    await pool.end();
    exit(1);
  }

  console.log('\n✓ All expected feedback rows observed.');
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
