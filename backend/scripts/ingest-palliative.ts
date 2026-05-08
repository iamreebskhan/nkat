/* eslint-disable no-console */
/**
 * scripts/ingest-palliative.ts
 *
 * Pulls Medicare LCDs / articles for the palliative code set into payer_rule.
 *
 * Prereqs:
 *   - CMS_COVERAGE_API_TOKEN in the environment (or anonymous flow if the
 *     license-agreement endpoint accepts it).
 *   - A `payer` row exists for each (state, MAC) you target — this script
 *     looks them up by name.
 *   - The palliative_codes seed migration has been applied (db/migrations/0008).
 *
 * Run:
 *   npm run ingest:palliative -- --states=OH,NC,SC --dry-run
 */
import 'reflect-metadata';
import { loadEnv } from '../src/config/env';
import { createPool } from '../src/database/pool';
import { createDb } from '../src/database/db';
import { CmsCoverageApiClient } from '../src/ingestion/cms-coverage-api.client';
import { NcdLcdIngestor } from '../src/ingestion/ncd-lcd.ingestor';

const PALLIATIVE_CODES = [
  '99341', '99342', '99344', '99345', '99347', '99348', '99349', '99350', // home visits
  '99497', '99498',                                                       // ACP
  'G0318',                                                                // palliative E/M longitudinal
  '98000', '98001', '98002', '98003', '98004', '98005', '98006', '98007',
  '98008', '98009', '98010', '98011', '98012', '98013', '98014', '98015', // audio-visual telemedicine
  'G0568', 'G0569', 'G0570',                                              // psych collab care
];

interface CliArgs {
  states: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let states = ['OH', 'NC', 'SC'];
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--states=')) states = arg.slice('--states='.length).split(',').map((s) => s.trim().toUpperCase());
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: ingest-palliative [--states=OH,NC,SC] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return { states, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const env = loadEnv();
  const pool = createPool(env);
  const db = createDb(pool);
  const cms = new CmsCoverageApiClient(env);

  console.log(`Targets: states=${args.states.join(',')} codes=${PALLIATIVE_CODES.length} dry=${args.dryRun}`);

  if (args.dryRun) {
    console.log('Dry run: would call listLcds() per (state, code) and persist results.');
    await pool.end();
    return;
  }

  const ingestor = new NcdLcdIngestor(db, cms);

  for (const state of args.states) {
    const payer = await db
      .selectFrom('payer')
      .select(['id', 'name'])
      .where('payer_type', '=', 'medicare_mac')
      .where((eb) => eb('states_served', '@>', [state]))
      .where('active', '=', true)
      .executeTakeFirst();
    if (!payer) {
      console.warn(`No active medicare_mac payer covers ${state}; skipping`);
      continue;
    }
    console.log(`State=${state} payer=${payer.name} id=${payer.id}`);
    const report = await ingestor.ingest({
      payer_id: payer.id,
      payer_name: payer.name,
      state,
      product_line: 'medicare_ffs',
      codes: PALLIATIVE_CODES,
    });
    console.log(
      `  lcds_seen=${report.lcds_seen} documents=${report.documents_persisted} rules=${report.rules_persisted} errors=${report.errors.length}`,
    );
    for (const e of report.errors) console.warn(`    LCD ${e.lcd_id}: ${e.message}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
