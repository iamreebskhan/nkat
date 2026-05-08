/**
 * Pure CSV parser for the CMS-HCC V28 mapping file.
 *
 * Expected columns (case-insensitive, in any order):
 *   icd10        — required
 *   hcc_code     — required
 *   category     — optional
 *   rxhcc_code   — optional
 *   raf_weight   — required
 *   effective_year — required (integer)
 *
 * Tolerates:
 *   - Quoted fields with embedded commas / escaped quotes ("a,b" / "a""b").
 *   - CRLF + LF line endings.
 *   - Stray whitespace around fields.
 *
 * Rejects:
 *   - Missing required columns (throws once at the header level).
 *   - Rows with empty icd10 or hcc_code.
 *   - Non-numeric raf_weight or effective_year.
 *
 * Returns parsed rows + per-row error messages so the caller can produce a
 * useful ingestion report.
 */
export interface HccCsvRow {
  icd10: string;
  hcc_code: string;
  category: string | null;
  rxhcc_code: string | null;
  raf_weight: number;
  effective_year: number;
}

export interface HccCsvParseResult {
  rows: HccCsvRow[];
  errors: { line: number; message: string }[];
  total_lines: number;
}

const REQUIRED = ['icd10', 'hcc_code', 'raf_weight', 'effective_year'] as const;

/** Splits a CSV row into fields with proper quote handling (RFC 4180-ish). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseHccCsv(input: string): HccCsvParseResult {
  const result: HccCsvParseResult = { rows: [], errors: [], total_lines: 0 };
  const lines = input.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return result;

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  for (const req of REQUIRED) {
    if (!headers.includes(req)) {
      throw new Error(`HCC CSV missing required column: ${req}`);
    }
  }
  const idx = (col: string): number => headers.indexOf(col);

  for (let i = 1; i < lines.length; i++) {
    result.total_lines++;
    const fields = splitCsvLine(lines[i]).map((f) => f.trim());
    const lineNo = i + 1; // human-readable line number in the source file

    const icd10 = fields[idx('icd10')] ?? '';
    const hccCode = fields[idx('hcc_code')] ?? '';
    const rafWeightRaw = fields[idx('raf_weight')] ?? '';
    const yearRaw = fields[idx('effective_year')] ?? '';

    if (!icd10) {
      result.errors.push({ line: lineNo, message: 'missing icd10' });
      continue;
    }
    if (!hccCode) {
      result.errors.push({ line: lineNo, message: 'missing hcc_code' });
      continue;
    }
    const rafWeight = Number(rafWeightRaw);
    if (!Number.isFinite(rafWeight)) {
      result.errors.push({ line: lineNo, message: `non-numeric raf_weight "${rafWeightRaw}"` });
      continue;
    }
    const effYear = Number.parseInt(yearRaw, 10);
    if (!Number.isInteger(effYear) || effYear < 2020 || effYear > 2099) {
      result.errors.push({ line: lineNo, message: `bad effective_year "${yearRaw}"` });
      continue;
    }

    const categoryIdx = idx('category');
    const rxIdx = idx('rxhcc_code');
    result.rows.push({
      icd10,
      hcc_code: hccCode,
      category: categoryIdx >= 0 ? (fields[categoryIdx] || null) : null,
      rxhcc_code: rxIdx >= 0 ? (fields[rxIdx] || null) : null,
      raf_weight: rafWeight,
      effective_year: effYear,
    });
  }
  return result;
}
