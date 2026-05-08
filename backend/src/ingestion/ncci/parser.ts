/**
 * NCCI quarterly file parsers.
 *
 * CMS publishes National Correct Coding Initiative quarterly:
 *   - PTP (Procedure-to-Procedure) edits — column1/column2 code pairs
 *     with a modifier_indicator (0/1/9) for practitioner + hospital_outpatient.
 *   - MUE (Medically Unlikely Edits) — units-of-service maximums per
 *     code and setting.
 *
 * Format on the CMS download page is Excel (.xlsx) with column
 * headers; we accept the CSV-export of those sheets, which is what
 * an analyst saves before checking into the data drop folder.
 *
 * Pure functions: each parser takes raw CSV text + the release
 * identifier (e.g. "2026Q2") and returns typed rows ready for
 * `INSERT INTO ncci_ptp` / `ncci_mue`. The DB-write step lives in
 * the cron script.
 *
 * Robust to:
 *   - CRLF or LF line endings
 *   - Quoted fields with embedded commas
 *   - Header rows with extra whitespace + alternative casing
 *   - Trailing empty rows from Excel exports
 */

export interface ParsedPtpRow {
  column1_code: string;
  column2_code: string;
  modifier_indicator: 0 | 1 | 9;
  edit_type: 'practitioner' | 'hospital_outpatient';
  effective_date: Date;
  expiration_date: Date | null;
  rationale: string | null;
  source_release: string;
}

export interface ParsedMueRow {
  code: string;
  setting: 'practitioner' | 'outpatient_hospital' | 'dme';
  units_max: number;
  rationale: string | null;
  effective_date: Date;
  expiration_date: Date | null;
  source_release: string;
}

export interface ParseError {
  row: number;
  reason: string;
  raw: string;
}

export interface ParseResult<T> {
  rows: T[];
  errors: ParseError[];
}

/**
 * Lenient CSV row tokenizer — handles quoted fields with embedded
 * commas + escaped doublequotes. Doesn't try to be RFC-4180 strict;
 * the CMS exports are well-formed enough.
 */
export function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsvText(csv: string): string[][] {
  const lines = csv.replace(/\r\n/g, '\n').split('\n');
  return lines
    .filter((l, i, arr) => l.trim().length > 0 || i < arr.length - 1)
    .map(parseCsvRow);
}

function findHeader(headers: string[], ...candidates: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseDate(s: string): Date | null {
  if (!s || s === '*' || s.toLowerCase() === 'no data') return null;
  // CMS files typically use YYYYMMDD, MM/DD/YYYY, or YYYY-MM-DD.
  const ymd = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (ymd) return new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00Z`);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const m = mdy[1].padStart(2, '0');
    const d = mdy[2].padStart(2, '0');
    return new Date(`${mdy[3]}-${m}-${d}T00:00:00Z`);
  }
  return null;
}

export function parseNcciPtp(
  csv: string,
  args: { editType: 'practitioner' | 'hospital_outpatient'; release: string },
): ParseResult<ParsedPtpRow> {
  const rows = parseCsvText(csv);
  const errors: ParseError[] = [];
  if (rows.length < 2) return { rows: [], errors };
  const headers = rows[0];
  const c1 = findHeader(headers, 'column_1', 'column1', 'col1', 'col_1', 'column_1_code');
  const c2 = findHeader(headers, 'column_2', 'column2', 'col2', 'col_2', 'column_2_code');
  const ind = findHeader(headers, 'modifier_indicator', 'modifier');
  const eff = findHeader(headers, 'effective_date', 'effective');
  const exp = findHeader(headers, 'deletion_date', 'expiration_date', 'expiration');
  const rationale = findHeader(headers, 'rationale_for_pair', 'rationale');
  if (c1 < 0 || c2 < 0 || ind < 0 || eff < 0) {
    return {
      rows: [],
      errors: [{ row: 0, reason: 'header missing required columns', raw: headers.join(',') }],
    };
  }

  const out: ParsedPtpRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || r.every((c) => c === '')) continue;
    try {
      const indicator = parseInt(r[ind], 10);
      if (indicator !== 0 && indicator !== 1 && indicator !== 9) {
        throw new Error(`bad modifier_indicator ${r[ind]}`);
      }
      const effDate = parseDate(r[eff]);
      if (!effDate) throw new Error(`bad effective_date ${r[eff]}`);
      out.push({
        column1_code: r[c1].toUpperCase(),
        column2_code: r[c2].toUpperCase(),
        modifier_indicator: indicator as 0 | 1 | 9,
        edit_type: args.editType,
        effective_date: effDate,
        expiration_date: exp >= 0 ? parseDate(r[exp]) : null,
        rationale: rationale >= 0 ? r[rationale] || null : null,
        source_release: args.release,
      });
    } catch (e) {
      errors.push({
        row: i + 1,
        reason: e instanceof Error ? e.message : String(e),
        raw: r.join(','),
      });
    }
  }
  return { rows: out, errors };
}

export function parseNcciMue(
  csv: string,
  args: { setting: 'practitioner' | 'outpatient_hospital' | 'dme'; release: string },
): ParseResult<ParsedMueRow> {
  const rows = parseCsvText(csv);
  const errors: ParseError[] = [];
  if (rows.length < 2) return { rows: [], errors };
  const headers = rows[0];
  const code = findHeader(headers, 'hcpcs_cpt_code', 'cpt_code', 'hcpcs', 'code');
  const units = findHeader(headers, 'mue_value', 'units_of_service', 'units', 'mue');
  const eff = findHeader(headers, 'effective_date', 'effective');
  const exp = findHeader(headers, 'deletion_date', 'expiration_date', 'expiration');
  const rationale = findHeader(headers, 'rationale', 'mue_rationale');
  if (code < 0 || units < 0 || eff < 0) {
    return {
      rows: [],
      errors: [{ row: 0, reason: 'header missing required columns', raw: headers.join(',') }],
    };
  }
  const out: ParsedMueRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || r.every((c) => c === '')) continue;
    try {
      const u = parseInt(r[units], 10);
      if (!Number.isFinite(u) || u < 0) throw new Error(`bad units ${r[units]}`);
      const effDate = parseDate(r[eff]);
      if (!effDate) throw new Error(`bad effective_date ${r[eff]}`);
      out.push({
        code: r[code].toUpperCase(),
        setting: args.setting,
        units_max: u,
        rationale: rationale >= 0 ? r[rationale] || null : null,
        effective_date: effDate,
        expiration_date: exp >= 0 ? parseDate(r[exp]) : null,
        source_release: args.release,
      });
    } catch (e) {
      errors.push({
        row: i + 1,
        reason: e instanceof Error ? e.message : String(e),
        raw: r.join(','),
      });
    }
  }
  return { rows: out, errors };
}
