/* eslint-disable no-console */
/**
 * scripts/ingest-hcc-v28.ts
 *
 * Bulk-load a CMS-HCC V28 mapping CSV into the `hcc_mapping` table.
 *
 *   npm run ingest:hcc -- --file=./data/hcc_v28.csv [--version=V28]
 *
 * Idempotent: re-running with the same file is a no-op.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { loadEnv } from '../src/config/env';
import { createPool } from '../src/database/pool';
import { createDb } from '../src/database/db';
import { parseHccCsv } from '../src/risk-adjustment/hcc-csv';
import { HccCsvImporter } from '../src/risk-adjustment/hcc-importer';

interface Args {
  file: string;
  version: string;
}

function parseArgs(argv: string[]): Args {
  let file = '';
  let version = 'V28';
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
    else if (arg.startsWith('--version=')) version = arg.slice('--version='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: ingest-hcc-v28 --file=<csv-path> [--version=V28]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  if (!file) {
    console.error('--file=<path> required');
    process.exit(2);
  }
  return { file, version };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const env = loadEnv();
  const pool = createPool(env);
  const db = createDb(pool);

  const csv = readFileSync(args.file, 'utf8');
  const parsed = parseHccCsv(csv);
  console.log(
    `Parsed: lines=${parsed.total_lines} rows=${parsed.rows.length} parse_errors=${parsed.errors.length}`,
  );
  for (const e of parsed.errors.slice(0, 10)) {
    console.warn(`  line ${e.line}: ${e.message}`);
  }
  if (parsed.errors.length > 10) {
    console.warn(`  …${parsed.errors.length - 10} more parse errors suppressed`);
  }

  const importer = new HccCsvImporter(db);
  const report = await importer.import(parsed.rows, args.version);
  console.log(`Imported: upserted=${report.upserted} errors=${report.errors.length}`);
  for (const e of report.errors.slice(0, 10)) {
    console.warn(`  ${e.row.icd10}/${e.row.hcc_code}: ${e.message}`);
  }

  await pool.end();
  process.exitCode = parsed.errors.length + report.errors.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
