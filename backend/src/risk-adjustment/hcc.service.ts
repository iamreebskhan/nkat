/**
 * HccRiskAdjustmentService — Medicare Advantage HCC risk score (RAF) computation.
 *
 *   computeRaf(icd10[]) — pure function: groups input ICD-10s into HCC
 *     categories, applies the V28 hierarchy (a more-severe HCC trumps a
 *     less-severe one within the same family, per CMS's hierarchy table
 *     below) and sums the surviving HCCs' raf_weights.
 *
 *   scorePatient(patient_external_id, icd10[]) — DB-backed: looks up V28
 *     mappings for the current effective_year and returns score + breakdown
 *     suitable for analytics / dashboards.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

export interface HccMapping {
  icd10: string;
  hcc_code: string;
  category: string | null;
  raf_weight: number;
}

export interface HccBreakdownItem {
  hcc_code: string;
  category: string | null;
  raf_weight: number;
  contributing_icd10s: string[];
  /** True if a more-severe HCC in the same V28 hierarchy trumped this entry. */
  trumped: boolean;
}

export interface RafResult {
  total_raf: number;
  breakdown: HccBreakdownItem[];
  unmapped_icd10s: string[];
}

/**
 * The V28 hierarchies, verbatim from CMS's V28_HCC_Hierarchies.csv (2026
 * model software, CMS_HCC_v28_2026_T): when a key HCC is present, every HCC
 * in its list is dropped. Codes are written as the database stores them
 * (HCC037, not HCC37).
 *
 * This was a four-entry sparse map that had the diabetes chain backwards: it
 * dropped HCC036 (severe acute complications) under HCC037 (chronic), where
 * CMS drops 37 and 38 under 36.
 */
const HIERARCHY: Readonly<Record<string, readonly string[]>> = {
  HCC017: ['HCC018', 'HCC019', 'HCC020', 'HCC021', 'HCC022', 'HCC023'],
  HCC018: ['HCC019', 'HCC020', 'HCC021', 'HCC022', 'HCC023'],
  HCC019: ['HCC020', 'HCC021', 'HCC022', 'HCC023'],
  HCC020: ['HCC021', 'HCC022', 'HCC023'],
  HCC021: ['HCC022', 'HCC023'],
  HCC022: ['HCC023'],
  HCC035: ['HCC036', 'HCC037', 'HCC038'],
  HCC036: ['HCC037', 'HCC038'],
  HCC037: ['HCC038'],
  HCC062: ['HCC063', 'HCC064', 'HCC065', 'HCC068'],
  HCC063: ['HCC064', 'HCC065', 'HCC068', 'HCC202'],
  HCC064: ['HCC065', 'HCC068'],
  HCC077: ['HCC078', 'HCC080', 'HCC081'],
  HCC080: ['HCC081'],
  HCC093: ['HCC094'],
  HCC107: ['HCC108'],
  HCC111: ['HCC112'],
  HCC114: ['HCC115'],
  HCC125: ['HCC126', 'HCC127'],
  HCC126: ['HCC127'],
  HCC135: ['HCC136', 'HCC137', 'HCC138', 'HCC139'],
  HCC136: ['HCC137', 'HCC138', 'HCC139'],
  HCC137: ['HCC138', 'HCC139'],
  HCC138: ['HCC139'],
  HCC151: ['HCC152', 'HCC153', 'HCC154', 'HCC155'],
  HCC152: ['HCC153', 'HCC154', 'HCC155'],
  HCC153: ['HCC154', 'HCC155'],
  HCC154: ['HCC155'],
  HCC180: ['HCC181', 'HCC182', 'HCC253', 'HCC254'],
  HCC181: ['HCC182', 'HCC254'],
  HCC191: ['HCC180', 'HCC181', 'HCC182', 'HCC192', 'HCC253', 'HCC254'],
  HCC192: ['HCC180', 'HCC181', 'HCC182', 'HCC253', 'HCC254'],
  HCC195: ['HCC196'],
  HCC211: ['HCC212', 'HCC213'],
  HCC212: ['HCC213'],
  HCC221: ['HCC222', 'HCC223', 'HCC224', 'HCC225', 'HCC226', 'HCC227'],
  HCC222: ['HCC223', 'HCC224', 'HCC225', 'HCC226', 'HCC227'],
  HCC223: ['HCC224', 'HCC225', 'HCC226', 'HCC227'],
  HCC224: ['HCC225', 'HCC226', 'HCC227'],
  HCC225: ['HCC226', 'HCC227'],
  HCC226: ['HCC227'],
  HCC228: ['HCC229'],
  HCC248: ['HCC249'],
  HCC253: ['HCC254'],
  HCC263: ['HCC264', 'HCC383', 'HCC409'],
  HCC276: ['HCC277', 'HCC278', 'HCC279', 'HCC280'],
  HCC277: ['HCC278', 'HCC279', 'HCC280'],
  HCC278: ['HCC279', 'HCC280'],
  HCC279: ['HCC280'],
  HCC282: ['HCC283'],
  HCC326: ['HCC327', 'HCC328', 'HCC329'],
  HCC327: ['HCC328', 'HCC329'],
  HCC328: ['HCC329'],
  HCC379: ['HCC380', 'HCC381', 'HCC382', 'HCC383'],
  HCC380: ['HCC381', 'HCC382', 'HCC383'],
  HCC381: ['HCC382', 'HCC383'],
  HCC382: ['HCC383'],
  HCC397: ['HCC202', 'HCC398', 'HCC399'],
  HCC398: ['HCC202', 'HCC399'],
  HCC405: ['HCC409'],
};

/**
 * Pure-function RAF computation.
 *
 * 1. Map each ICD-10 to its HCC (multi-mapping → take the highest raf_weight).
 * 2. Group contributing ICD-10s under each HCC.
 * 3. Apply V28 hierarchy: when two HCCs from the same family appear, the
 *    more-severe trumps the less-severe.
 * 4. Sum the surviving HCCs' raf_weights.
 */
export function computeRaf(icd10: string[], mappings: HccMapping[]): RafResult {
  const byIcd = new Map<string, HccMapping[]>();
  for (const m of mappings) {
    const arr = byIcd.get(m.icd10) ?? [];
    arr.push(m);
    byIcd.set(m.icd10, arr);
  }

  const groups = new Map<string, HccBreakdownItem>();
  const unmapped: string[] = [];

  for (const code of icd10) {
    const matches = byIcd.get(code);
    if (!matches || matches.length === 0) {
      unmapped.push(code);
      continue;
    }
    // Pick the highest-weighted HCC for this ICD-10 (some ICDs map to multiple).
    const top = matches.reduce((a, b) => (b.raf_weight > a.raf_weight ? b : a));
    const existing = groups.get(top.hcc_code);
    if (existing) {
      existing.contributing_icd10s.push(code);
    } else {
      groups.set(top.hcc_code, {
        hcc_code: top.hcc_code,
        category: top.category,
        raf_weight: top.raf_weight,
        contributing_icd10s: [code],
        trumped: false,
      });
    }
  }

  // Apply hierarchy: every HCC present drops the ones CMS ranks below it.
  for (const dominator of groups.keys()) {
    for (const lower of HIERARCHY[dominator] ?? []) {
      const item = groups.get(lower);
      if (item) item.trumped = true;
    }
  }

  const breakdown = Array.from(groups.values()).sort((a, b) =>
    a.hcc_code < b.hcc_code ? -1 : a.hcc_code > b.hcc_code ? 1 : 0,
  );
  const total = breakdown.filter((b) => !b.trumped).reduce((sum, b) => sum + b.raf_weight, 0);

  return {
    total_raf: round4(total),
    breakdown,
    unmapped_icd10s: unmapped.sort(),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

@Injectable()
export class HccRiskAdjustmentService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Look up V28 mappings for the supplied ICD-10s + effective year, then
   * compute a RAF score with breakdown.
   */
  async scorePatient(
    icd10: string[],
    effectiveYear = new Date().getUTCFullYear(),
  ): Promise<RafResult> {
    if (icd10.length === 0) {
      return { total_raf: 0, breakdown: [], unmapped_icd10s: [] };
    }
    const rows = await this.db
      .selectFrom('hcc_mapping')
      .select(['icd10', 'hcc_code', 'category', 'raf_weight'])
      .where('icd10', 'in', icd10)
      .where('hcc_version', '=', 'V28')
      .where('effective_year', '=', effectiveYear)
      .execute();
    const mappings: HccMapping[] = rows.map((r) => ({
      icd10: r.icd10,
      hcc_code: r.hcc_code,
      category: r.category,
      raf_weight: Number(r.raf_weight ?? 0),
    }));
    return computeRaf(icd10, mappings);
  }

  /**
   * Direct mapping lookup. Returns every (HCC, RxHCC, raf_weight) row
   * for a given ICD-10 + version + year. Useful for an analyst UI
   * that wants to show "this dx maps to these HCCs".
   */
  async getMappings(args: {
    icd10: string;
    hcc_version?: string;
    effective_year?: number;
  }): Promise<HccMappingDetail[]> {
    const r = await this.db
      .selectFrom('hcc_mapping')
      .select([
        'icd10',
        'hcc_version',
        'hcc_code',
        'category',
        'rxhcc_code',
        'raf_weight',
        'effective_year',
      ])
      .where('icd10', '=', args.icd10)
      .where('hcc_version', '=', args.hcc_version ?? 'V28')
      .where('effective_year', '=', args.effective_year ?? new Date().getUTCFullYear())
      .orderBy('hcc_code', 'asc')
      .execute();
    return r.map((row) => ({
      icd10: row.icd10,
      hcc_version: row.hcc_version,
      hcc_code: row.hcc_code,
      category: row.category,
      rxhcc_code: row.rxhcc_code,
      raf_weight: Number(row.raf_weight ?? 0),
      effective_year: row.effective_year,
    }));
  }
}

export interface HccMappingDetail {
  icd10: string;
  hcc_version: string;
  hcc_code: string;
  category: string | null;
  rxhcc_code: string | null;
  raf_weight: number;
  effective_year: number;
}
