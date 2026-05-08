/* eslint-disable no-console */
/**
 * scripts/ingest-era835-batch.ts
 *
 * Bulk-load 835 ERA files from a directory for one tenant org+client.
 * Usage:
 *   npm run ingest:era835 -- \
 *     --org=<uuid> --client=<uuid> --dir=./incoming-835 [--source-prefix=s3://x/]
 *
 * Skips files we've already loaded (per-record dedup happens inside the
 * ingestor).
 */
import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/config/env';
import { createPool } from '../src/database/pool';
import { createDb } from '../src/database/db';
import { runWithTenant } from '../src/database/rls-transaction';
import { Era835Ingestor } from '../src/ingestion/era835/ingestor';
import { parseEra835 } from '../src/ingestion/era835/parser';
import { isUuid } from '../src/common/uuid';

interface CliArgs {
  orgId: string;
  clientId: string;
  dir: string;
  sourcePrefix?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let orgId = '';
  let clientId = '';
  let dir = '';
  let sourcePrefix: string | undefined;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--org=')) orgId = arg.slice('--org='.length);
    else if (arg.startsWith('--client=')) clientId = arg.slice('--client='.length);
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--source-prefix=')) sourcePrefix = arg.slice('--source-prefix='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: ingest-era835-batch --org=<uuid> --client=<uuid> --dir=<path> [--source-prefix=s3://x/]');
      process.exit(0);
    }
  }
  if (!isUuid(orgId)) throw new Error('--org=<uuid> required');
  if (!isUuid(clientId)) throw new Error('--client=<uuid> required');
  if (!dir) throw new Error('--dir=<path> required');
  return { orgId, clientId, dir, ...(sourcePrefix ? { sourcePrefix } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const env = loadEnv();
  const pool = createPool(env);
  const db = createDb(pool);
  const ingestor = new Era835Ingestor();

  const files = readdirSync(args.dir).filter((f) => /\.(835|edi|txt)$/i.test(f));
  console.log(`Found ${files.length} 835 files in ${args.dir}`);

  let totalPersisted = 0;
  let totalDup = 0;
  let totalWarned = 0;
  let totalErrors = 0;

  for (const fname of files) {
    const fullPath = path.join(args.dir, fname);
    const body = readFileSync(fullPath, 'utf8');
    const parsed = parseEra835(body);
    const sourceFileUri = args.sourcePrefix ? `${args.sourcePrefix}${fname}` : `file://${fullPath}`;

    const report = await runWithTenant(db, args.orgId, (tx) =>
      ingestor.ingest(tx, parsed, {
        org_id: args.orgId,
        client_id: args.clientId,
        source_file_uri: sourceFileUri,
      }),
    );
    totalPersisted += report.records_persisted;
    totalDup += report.records_skipped_duplicate;
    totalWarned += report.preflight_warned;
    totalErrors += report.errors.length;
    console.log(
      `  ${fname}: claims=${report.total_claims} lines=${report.total_lines} persisted=${report.records_persisted} dup=${report.records_skipped_duplicate} warned=${report.preflight_warned} errors=${report.errors.length}`,
    );
  }

  console.log(`\nTotal persisted=${totalPersisted} dup=${totalDup} warned=${totalWarned} errors=${totalErrors}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
