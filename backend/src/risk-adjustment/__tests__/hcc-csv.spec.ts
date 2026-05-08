import { parseHccCsv, splitCsvLine } from '../hcc-csv';

describe('splitCsvLine', () => {
  it('splits a plain row', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with embedded commas', () => {
    expect(splitCsvLine('"a,b",c,"d,e,f"')).toEqual(['a,b', 'c', 'd,e,f']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    expect(splitCsvLine('"a""b",c')).toEqual(['a"b', 'c']);
  });

  it('preserves empty trailing fields', () => {
    expect(splitCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });

  it('handles a single empty field', () => {
    expect(splitCsvLine('')).toEqual(['']);
  });
});

describe('parseHccCsv', () => {
  const HEADER = 'icd10,hcc_code,category,rxhcc_code,raf_weight,effective_year';

  it('parses a clean file', () => {
    const csv = [
      HEADER,
      'E11.21,HCC037,Diabetes w/ chronic complications,RX002,0.302,2026',
      'I50.84,HCC222,End-Stage HF,,0.737,2026',
    ].join('\n');
    const r = parseHccCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({
      icd10: 'E11.21',
      hcc_code: 'HCC037',
      category: 'Diabetes w/ chronic complications',
      rxhcc_code: 'RX002',
      raf_weight: 0.302,
      effective_year: 2026,
    });
    expect(r.rows[1].rxhcc_code).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseHccCsv('icd10,hcc_code\nA,B')).toThrow(/raf_weight/);
  });

  it('records per-row errors without aborting the parse', () => {
    const csv = [
      HEADER,
      ',HCC037,Cat,,0.3,2026',                  // missing icd10
      'E11.21,HCC037,Cat,,not-a-number,2026',   // bad raf_weight
      'E11.22,HCC037,Cat,,0.3,1999',            // year out of range
      'E11.23,HCC037,Cat,,0.3,2026',            // good
    ].join('\n');
    const r = parseHccCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.message)).toEqual([
      'missing icd10',
      expect.stringMatching(/non-numeric raf_weight/),
      expect.stringMatching(/bad effective_year/),
    ]);
  });

  it('handles header columns in any order + extra unknown columns', () => {
    const csv = [
      'effective_year,icd10,hcc_code,raf_weight,extra_col',
      '2026,E11.21,HCC037,0.302,ignore-me',
    ].join('\n');
    const r = parseHccCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].icd10).toBe('E11.21');
  });

  it('treats CRLF + LF identically', () => {
    const csv = `${HEADER}\r\nE11.21,HCC037,,,0.302,2026\r\n`;
    expect(parseHccCsv(csv).rows).toHaveLength(1);
  });

  it('returns empty result for empty input', () => {
    const r = parseHccCsv('');
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('strips surrounding whitespace from fields', () => {
    const csv = `${HEADER}\n  E11.21 ,  HCC037 ,Cat , ,  0.302 , 2026 `;
    expect(parseHccCsv(csv).rows[0].icd10).toBe('E11.21');
  });
});
