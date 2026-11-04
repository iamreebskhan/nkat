/**
 * AscService — payment-indicator lookup for Ambulatory Surgical Center claims.
 *
 *   evaluate(line, dos)  — for a CPT/HCPCS code billed under an ASC product
 *     line, returns the CMS ASC payment indicator (e.g. A2, P3, J8; CMS
 *     Addendum DD1). When no indicator is on file, the line is
 *     "ASC-not-payable" — typically a hospital-only procedure.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

export interface AscLineInput {
  index: number;
  code: string;
}

export interface AscIndicatorMatch {
  payment_indicator: string;
  payment_group: string | null;
  payment_rate: number | null;
  source_url: string | null;
  effective_year: number;
}

export type AscIssueKind =
  | 'asc_not_payable' // no indicator on file → hospital-only
  | 'asc_office_based'; // P2/P3/R2 → office-based procedure; payment may be capped

export interface AscIssue {
  kind: AscIssueKind;
  line_index: number;
  code: string;
  message: string;
  match?: AscIndicatorMatch;
  source_url?: string | null;
}

/**
 * The office-based surgical procedures of CMS Addendum DD1: P2, P3 (the ASC
 * rate is capped by the physician fee schedule's non-facility PE) and R2.
 * Not A2, which is a procedure on the ASC list since 2007 paid from its OPPS
 * relative weight; this used to flag A2, so cataract surgery and colonoscopy
 * were warned about an office-based cap they do not have.
 */
const OFFICE_BASED_INDICATORS: ReadonlySet<string> = new Set(['P2', 'P3', 'R2']);

/**
 * Pure-function evaluator. Given a line + the ASC indicator row (or undefined),
 * return any per-line issues.
 */
export function evaluateAscLine(
  line: AscLineInput,
  match: AscIndicatorMatch | undefined,
): AscIssue[] {
  if (!match) {
    return [
      {
        kind: 'asc_not_payable',
        line_index: line.index,
        code: line.code,
        message: `${line.code} is not on the CMS ASC fee schedule for this year; it is typically not payable in an ASC setting (hospital-only).`,
      },
    ];
  }
  if (OFFICE_BASED_INDICATORS.has(match.payment_indicator)) {
    return [
      {
        kind: 'asc_office_based',
        line_index: line.index,
        code: line.code,
        message: `${line.code} is classified ${match.payment_indicator} (office-based surgical procedure); ASC payment may be limited to the office-based rate ($${match.payment_rate?.toFixed(2) ?? '?'}).`,
        match,
        ...(match.source_url ? { source_url: match.source_url } : {}),
      },
    ];
  }
  return [];
}

@Injectable()
export class AscService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async evaluate(lines: AscLineInput[], dos: Date): Promise<AscIssue[]> {
    if (lines.length === 0) return [];
    const codes = Array.from(new Set(lines.map((l) => l.code)));
    const year = dos.getUTCFullYear();
    const rows = await this.db
      .selectFrom('asc_payment_indicator')
      .select([
        'code',
        'payment_indicator',
        'payment_group',
        'payment_rate',
        'source_url',
        'effective_year',
      ])
      .where('code', 'in', codes)
      .where('effective_year', '=', year)
      .execute();

    const byCode = new Map<string, AscIndicatorMatch>(
      rows.map((r) => [
        r.code,
        {
          payment_indicator: r.payment_indicator,
          payment_group: r.payment_group,
          payment_rate: r.payment_rate !== null ? Number(r.payment_rate) : null,
          source_url: r.source_url,
          effective_year: r.effective_year,
        },
      ]),
    );

    const out: AscIssue[] = [];
    for (const line of lines) {
      out.push(...evaluateAscLine(line, byCode.get(line.code)));
    }
    return out;
  }
}
