/**
 * HccCsvImporter — bulk-loads parsed HCC rows into `hcc_mapping`.
 *
 * Idempotent: relies on the `(icd10, hcc_version, hcc_code, effective_year)`
 * primary key + ON CONFLICT DO UPDATE so re-runs are safe.
 *
 * Returns counts of inserted / updated / skipped rows for observability.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';
import type { HccCsvRow } from './hcc-csv';

export interface HccImportReport {
  total: number;
  upserted: number;
  errors: { row: HccCsvRow; message: string }[];
}

@Injectable()
export class HccCsvImporter {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async import(rows: HccCsvRow[], hccVersion = 'V28'): Promise<HccImportReport> {
    const report: HccImportReport = { total: rows.length, upserted: 0, errors: [] };
    if (rows.length === 0) return report;

    // Chunk inserts to avoid Postgres' parameter-count limit (default 32767
    // params; we use ~6 cols × N values).
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        await this.db
          .insertInto('hcc_mapping')
          .values(
            chunk.map((r) => ({
              icd10: r.icd10,
              hcc_version: hccVersion,
              hcc_code: r.hcc_code,
              category: r.category,
              rxhcc_code: r.rxhcc_code,
              raf_weight: r.raf_weight.toFixed(4),
              effective_year: r.effective_year,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['icd10', 'hcc_version', 'hcc_code', 'effective_year']).doUpdateSet({
              category: sql.ref('excluded.category'),
              rxhcc_code: sql.ref('excluded.rxhcc_code'),
              raf_weight: sql.ref('excluded.raf_weight'),
            }),
          )
          .execute();
        report.upserted += chunk.length;
      } catch (err) {
        // On chunk failure, fall back to per-row inserts to isolate the bad rows.
        for (const r of chunk) {
          try {
            await this.db
              .insertInto('hcc_mapping')
              .values({
                icd10: r.icd10,
                hcc_version: hccVersion,
                hcc_code: r.hcc_code,
                category: r.category,
                rxhcc_code: r.rxhcc_code,
                raf_weight: r.raf_weight.toFixed(4),
                effective_year: r.effective_year,
              })
              .onConflict((oc) =>
                oc.columns(['icd10', 'hcc_version', 'hcc_code', 'effective_year']).doUpdateSet({
                  category: sql.ref('excluded.category'),
                  rxhcc_code: sql.ref('excluded.rxhcc_code'),
                  raf_weight: sql.ref('excluded.raf_weight'),
                }),
              )
              .execute();
            report.upserted++;
          } catch (perRow) {
            report.errors.push({ row: r, message: (perRow as Error).message });
          }
        }
        // Surface that we had at least one chunk-level failure for telemetry.
        if (report.errors.length === 0) {
          report.errors.push({ row: chunk[0], message: (err as Error).message });
        }
      }
    }
    return report;
  }
}
