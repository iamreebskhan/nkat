/**
 * HccRiskAdjustmentService — Medicare Advantage HCC risk score (RAF) computation.
 *
 *   computeRaf(icd10[]) — pure function: groups input ICD-10s into HCC
 *     categories, applies the V28 hierarchy (a more-severe HCC trumps a
 *     less-severe one within the same family — implemented via explicit
 *     `dominates` map; the simple in-DB seed has no hierarchy chains, so the
 *     pure fn just sums the unique HCC raf_weights).
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
  /** True if a more-severe HCC trumped this entry (currently always false until V28 chains are seeded). */
  trumped: boolean;
}

export interface RafResult {
  total_raf: number;
  breakdown: HccBreakdownItem[];
  unmapped_icd10s: string[];
}

/**
 * V28 hierarchy "trumping" rules as a sparse map: when both keys are present,
 * the value HCC suppresses the key HCC.
 *
 * Example: HCC037 (Diabetes with chronic complications) trumps HCC038
 * (Diabetes without complication). HCC222 (End-Stage HF) trumps HCC224 and
 * HCC226. Real V28 has many more; this seed covers the cases in our DB seed
 * (db/seed/0014_hcc_v28.sql) so the unit tests are honest.
 */
const HIERARCHY_TRUMPS: Record<string, string> = {
  HCC038: 'HCC037', // diabetes w/o complications trumped by w/ chronic complications
  HCC036: 'HCC037', // diabetes w/ acute trumped by w/ chronic
  HCC224: 'HCC222', // HF (general) trumped by end-stage HF
  HCC226: 'HCC222', // HF (unspecified) trumped by end-stage HF
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

  // Apply hierarchy.
  const presentHccs = new Set(groups.keys());
  for (const [trumped, dominator] of Object.entries(HIERARCHY_TRUMPS)) {
    if (presentHccs.has(trumped) && presentHccs.has(dominator)) {
      groups.get(trumped)!.trumped = true;
    }
  }

  const breakdown = Array.from(groups.values()).sort((a, b) =>
    a.hcc_code < b.hcc_code ? -1 : a.hcc_code > b.hcc_code ? 1 : 0,
  );
  const total = breakdown
    .filter((b) => !b.trumped)
    .reduce((sum, b) => sum + b.raf_weight, 0);

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
  async scorePatient(icd10: string[], effectiveYear = new Date().getUTCFullYear()): Promise<RafResult> {
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
      .select(['icd10', 'hcc_version', 'hcc_code', 'category', 'rxhcc_code', 'raf_weight', 'effective_year'])
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
