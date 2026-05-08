/**
 * MS-DRG annual table parser.
 *
 * CMS publishes the MS-DRG (Medicare-Severity Diagnosis-Related Group)
 * table once per fiscal year (FY starts Oct 1). FY2026 is v43.
 *
 * Source CSV columns (after Excel export):
 *   MS-DRG, MDC, Type, MS-DRG Title, Weight, Geometric mean LOS, Arithmetic mean LOS
 *
 * `Type` values are 'MED' (medical) or 'SURG' (surgical).
 */
import { parseCsvText } from '../ncci/parser';

export interface ParsedMsDrgRow {
  code: string;
  description: string;
  mdc: string;
  type: 'medical' | 'surgical';
  relative_weight: number;
  geometric_mean_los: number | null;
  arithmetic_mean_los: number | null;
  fy_version: string;
  effective_date: Date;
  expiration_date: Date | null;
}

export interface ParseError {
  row: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedMsDrgRow[];
  errors: ParseError[];
}

function findHeader(headers: string[], ...candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().replace(/[\s\-]+/g, '_'));
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseMsDrg(
  csv: string,
  args: {
    fyVersion: string;
    effectiveDate: Date;
    expirationDate?: Date | null;
  },
): ParseResult {
  const rows = parseCsvText(csv);
  const errors: ParseError[] = [];
  if (rows.length < 2) return { rows: [], errors };
  const headers = rows[0];
  const code = findHeader(headers, 'ms_drg', 'msdrg', 'drg', 'ms_drg_code');
  const desc = findHeader(headers, 'ms_drg_title', 'description', 'title');
  const mdc = findHeader(headers, 'mdc');
  const type = findHeader(headers, 'type');
  const weight = findHeader(headers, 'weight', 'relative_weight', 'weights');
  const gmlos = findHeader(headers, 'geometric_mean_los', 'gmean_los');
  const amlos = findHeader(headers, 'arithmetic_mean_los', 'amean_los');
  if (code < 0 || desc < 0 || weight < 0) {
    return { rows: [], errors: [{ row: 0, reason: 'header missing required columns' }] };
  }
  const out: ParsedMsDrgRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || r.every((c) => c === '')) continue;
    try {
      const drg = (r[code] || '').padStart(3, '0');
      if (!/^\d{3}$/.test(drg)) throw new Error(`invalid DRG code ${r[code]}`);
      const w = parseFloat(r[weight]);
      if (!Number.isFinite(w)) throw new Error(`bad weight ${r[weight]}`);
      const t = (r[type] || '').toUpperCase();
      out.push({
        code: drg,
        description: r[desc] || '',
        mdc: mdc >= 0 ? (r[mdc] || '').padStart(2, '0') : '',
        type: t === 'SURG' || t === 'SURGICAL' ? 'surgical' : 'medical',
        relative_weight: w,
        geometric_mean_los: gmlos >= 0 && r[gmlos] ? parseFloat(r[gmlos]) : null,
        arithmetic_mean_los: amlos >= 0 && r[amlos] ? parseFloat(r[amlos]) : null,
        fy_version: args.fyVersion,
        effective_date: args.effectiveDate,
        expiration_date: args.expirationDate ?? null,
      });
    } catch (e) {
      errors.push({ row: i + 1, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { rows: out, errors };
}
