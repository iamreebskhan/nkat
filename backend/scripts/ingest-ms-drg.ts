#!/usr/bin/env ts-node
/**
 * Annual MS-DRG ingestion. CMS publishes the table on Oct 1 each FY.
 *
 *   ts-node scripts/ingest-ms-drg.ts \
 *     --file ./ms-drg-fy2026.csv --version v43 \
 *     --effective 2025-10-01 --expiration 2026-09-30
 */
import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import { parseMsDrg } from '../src/ingestion/drg/parser';

interface Args {
  file: string;
  version: string;
  effective: string;
  expiration: string | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { file: '', version: '', effective: '', expiration: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file') a.file = argv[++i];
    else if (argv[i] === '--version') a.version = argv[++i];
    else if (argv[i] === '--effective') a.effective = argv[++i];
    else if (argv[i] === '--expiration') a.expiration = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

async function main() {
  const a = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    exit(2);
  }
  if (!a.file || !a.version || !a.effective) {
    console.error('--file --version --effective required');
    exit(2);
  }
  const csv = await readFile(a.file, 'utf8');
  const r = parseMsDrg(csv, {
    fyVersion: a.version,
    effectiveDate: new Date(`${a.effective}T00:00:00Z`),
    expirationDate: a.expiration ? new Date(`${a.expiration}T00:00:00Z`) : null,
  });
  console.log(`Parsed ${r.rows.length} DRG rows; ${r.errors.length} error(s).`);
  for (const e of r.errors.slice(0, 10)) console.warn(`  r${e.row}: ${e.reason}`);
  if (a.dryRun) {
    console.log('--dry-run: not writing.');
    exit(0);
  }
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));
  let written = 0;
  for (const row of r.rows) {
    await pool.query(
      `INSERT INTO ms_drg (code, description, mdc, type, relative_weight,
                            geometric_mean_los, arithmetic_mean_los,
                            fy_version, effective_date, expiration_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (code, fy_version) DO UPDATE SET
         description = EXCLUDED.description,
         mdc = EXCLUDED.mdc,
         type = EXCLUDED.type,
         relative_weight = EXCLUDED.relative_weight,
         geometric_mean_los = EXCLUDED.geometric_mean_los,
         arithmetic_mean_los = EXCLUDED.arithmetic_mean_los,
         effective_date = EXCLUDED.effective_date,
         expiration_date = EXCLUDED.expiration_date`,
      [
        row.code,
        row.description,
        row.mdc,
        row.type,
        row.relative_weight,
        row.geometric_mean_los,
        row.arithmetic_mean_los,
        row.fy_version,
        row.effective_date,
        row.expiration_date,
      ],
    );
    written += 1;
  }
  console.log(`Wrote ${written} MS-DRG row(s).`);
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
