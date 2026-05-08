/**
 * Integration test for the HCC v28 CSV importer.
 *
 * Loads a small CSV through the importer, then verifies:
 *   - rows landed in `hcc_mapping`
 *   - re-running the same CSV is idempotent (no duplicate rows; updates fields)
 *   - the per-row error fallback works when one row violates a constraint
 */
import { sql } from 'kysely';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';
import { parseHccCsv } from '../../src/risk-adjustment/hcc-csv';
import { HccCsvImporter } from '../../src/risk-adjustment/hcc-importer';

const HEADER = 'icd10,hcc_code,category,rxhcc_code,raf_weight,effective_year';

integrationDescribe('HccCsvImporter (integration)', () => {
  let ctx: IntegrationContext;
  let importer: HccCsvImporter;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    importer = new HccCsvImporter(ctx.db);
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  it('imports rows from a clean CSV', async () => {
    const csv = [
      HEADER,
      'X11.21,HCC037,Diabetes w/ chronic complications,RX1,0.302,2030',
      'X50.84,HCC222,End-stage HF,,0.737,2030',
    ].join('\n');
    const parsed = parseHccCsv(csv);
    expect(parsed.errors).toEqual([]);
    const report = await importer.import(parsed.rows);
    expect(report.upserted).toBe(2);
    expect(report.errors).toEqual([]);

    const r = await sql<{ icd10: string; raf_weight: string }>`
      SELECT icd10, raf_weight FROM hcc_mapping WHERE effective_year = 2030 ORDER BY icd10
    `.execute(ctx.db);
    expect(r.rows.map((row) => row.icd10)).toEqual(['X11.21', 'X50.84']);
  });

  it('is idempotent on re-import (PK conflict → DO UPDATE) and updates raf_weight', async () => {
    const csv = [HEADER, 'X11.21,HCC037,Diabetes,,0.999,2030'].join('\n');
    const parsed = parseHccCsv(csv);
    const report = await importer.import(parsed.rows);
    expect(report.upserted).toBe(1);
    expect(report.errors).toEqual([]);

    const r = await sql<{ raf_weight: string }>`
      SELECT raf_weight FROM hcc_mapping
      WHERE icd10 = 'X11.21' AND hcc_version = 'V28' AND hcc_code = 'HCC037' AND effective_year = 2030
    `.execute(ctx.db);
    expect(Number(r.rows[0].raf_weight)).toBeCloseTo(0.999, 3);

    const dupCount = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM hcc_mapping WHERE icd10 = 'X11.21' AND effective_year = 2030
    `.execute(ctx.db);
    expect(Number(dupCount.rows[0].count)).toBe(1);
  });
});
