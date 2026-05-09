#!/usr/bin/env ts-node
/**
 * Quarterly NCCI ingestion. Reads a CSV (downloaded ahead of time
 * from CMS NCCI quarterly files page) and upserts into `ncci_ptp` /
 * `ncci_mue`. Idempotent — re-running with the same release is safe.
 *
 *   ts-node scripts/ingest-ncci-quarterly.ts \
 *     --kind ptp --setting practitioner --release 2026Q2 --file ./ptp.csv
 *   ts-node scripts/ingest-ncci-quarterly.ts \
 *     --kind mue --setting practitioner --release 2026Q2 --file ./mue.csv
 *
 * --dry-run prints stats without writing.
 */
import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { Pool } from 'pg';
import {
  parseNcciMue,
  parseNcciPtp,
  type ParsedMueRow,
  type ParsedPtpRow,
} from '../src/ingestion/ncci/parser';

interface Args {
  kind: 'ptp' | 'mue' | null;
  setting: string;
  release: string;
  file: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { kind: null, setting: '', release: '', file: '', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--kind') a.kind = argv[++i] as 'ptp' | 'mue';
    else if (argv[i] === '--setting') a.setting = argv[++i];
    else if (argv[i] === '--release') a.release = argv[++i];
    else if (argv[i] === '--file') a.file = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

async function ingestPtp(pool: Pool, rows: ParsedPtpRow[], dryRun: boolean): Promise<number> {
  if (dryRun) return rows.length;
  let written = 0;
  // We use ON CONFLICT on a synthetic uniqueness predicate; in practice
  // the CMS file is deduped, but a previously-applied row should be
  // updated to reflect any rationale tweaks.
  for (const r of rows) {
    await pool.query(
      `INSERT INTO ncci_ptp (column1_code, column2_code, modifier_indicator, edit_type,
                              effective_date, expiration_date, rationale, source_release)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (column1_code, column2_code, edit_type, effective_date)
       DO UPDATE SET modifier_indicator = EXCLUDED.modifier_indicator,
                     expiration_date    = EXCLUDED.expiration_date,
                     rationale          = EXCLUDED.rationale,
                     source_release     = EXCLUDED.source_release`,
      [
        r.column1_code,
        r.column2_code,
        r.modifier_indicator,
        r.edit_type,
        r.effective_date,
        r.expiration_date,
        r.rationale,
        r.source_release,
      ],
    );
    written += 1;
  }
  return written;
}

async function ingestMue(pool: Pool, rows: ParsedMueRow[], dryRun: boolean): Promise<number> {
  if (dryRun) return rows.length;
  let written = 0;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO ncci_mue (code, setting, units_max, rationale,
                              effective_date, expiration_date, source_release)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (code, setting, effective_date)
       DO UPDATE SET units_max = EXCLUDED.units_max,
                     rationale = EXCLUDED.rationale,
                     expiration_date = EXCLUDED.expiration_date,
                     source_release = EXCLUDED.source_release`,
      [
        r.code,
        r.setting,
        r.units_max,
        r.rationale,
        r.effective_date,
        r.expiration_date,
        r.source_release,
      ],
    );
    written += 1;
  }
  return written;
}

async function main() {
  const a = parseArgs();
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    exit(2);
  }
  if (!a.kind || !a.release || !a.file) {
    console.error('--kind {ptp|mue} --release <id> --file <csv> required');
    exit(2);
  }
  const csv = await readFile(a.file, 'utf8');
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  pool.on('error', (e) => console.error('[pg.Pool]', e.message));

  if (a.kind === 'ptp') {
    const editType = (
      a.setting === 'hospital_outpatient' ? 'hospital_outpatient' : 'practitioner'
    ) as 'hospital_outpatient' | 'practitioner';
    const r = parseNcciPtp(csv, { editType, release: a.release });
    console.log(`PTP rows: ${r.rows.length} parsed; ${r.errors.length} error(s).`);
    for (const e of r.errors.slice(0, 10)) console.warn(`  err r${e.row}: ${e.reason}`);
    const n = await ingestPtp(pool, r.rows, a.dryRun);
    console.log(`PTP ${a.dryRun ? 'would-write' : 'written'}: ${n}`);
  } else {
    const setting = (
      ['practitioner', 'outpatient_hospital', 'dme'].includes(a.setting)
        ? a.setting
        : 'practitioner'
    ) as 'practitioner' | 'outpatient_hospital' | 'dme';
    const r = parseNcciMue(csv, { setting, release: a.release });
    console.log(`MUE rows: ${r.rows.length} parsed; ${r.errors.length} error(s).`);
    for (const e of r.errors.slice(0, 10)) console.warn(`  err r${e.row}: ${e.reason}`);
    const n = await ingestMue(pool, r.rows, a.dryRun);
    console.log(`MUE ${a.dryRun ? 'would-write' : 'written'}: ${n}`);
  }
  await pool.end();
  exit(0);
}

void main().catch((e) => {
  console.error(e);
  exit(1);
});
