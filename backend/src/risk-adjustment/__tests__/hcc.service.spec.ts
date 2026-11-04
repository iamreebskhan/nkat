import { computeRaf, type HccMapping } from '../hcc.service';

// Real V28 mappings for payment year 2026 (CMS 2026 Midyear/Final ICD-10-CM
// Mappings) with community, non-dual, aged relative factors from the V28
// model software — the same rows as db/seed/0014_hcc_v28.sql, plus E10.10 and
// I50.23 for the HCC 36 and HCC 224 hierarchy cases.
const MAPPINGS: HccMapping[] = [
  // Diabetes family
  {
    icd10: 'E10.10',
    hcc_code: 'HCC036',
    category: 'Diabetes with Severe Acute Complications',
    raf_weight: 0.166,
  },
  {
    icd10: 'E11.21',
    hcc_code: 'HCC037',
    category: 'Diabetes with Chronic Complications',
    raf_weight: 0.166,
  },
  {
    icd10: 'E11.22',
    hcc_code: 'HCC037',
    category: 'Diabetes with Chronic Complications',
    raf_weight: 0.166,
  },
  {
    icd10: 'E11.9',
    hcc_code: 'HCC038',
    category: 'Diabetes with No, Glycemic, or Unspecified Complications',
    raf_weight: 0.166,
  },
  // Heart failure family
  { icd10: 'I50.84', hcc_code: 'HCC222', category: 'End Stage Heart Failure', raf_weight: 2.505 },
  {
    icd10: 'I50.23',
    hcc_code: 'HCC224',
    category: 'Acute on Chronic Heart Failure',
    raf_weight: 0.36,
  },
  {
    icd10: 'I50.9',
    hcc_code: 'HCC226',
    category: 'Heart Failure, Except End Stage and Acute',
    raf_weight: 0.36,
  },
  // Cancers
  {
    icd10: 'C18.0',
    hcc_code: 'HCC022',
    category: 'Bladder, Colorectal, and Other Cancers',
    raf_weight: 0.363,
  },
  {
    icd10: 'C34.10',
    hcc_code: 'HCC020',
    category: 'Lung and Other Severe Cancers',
    raf_weight: 1.136,
  },
];

describe('computeRaf', () => {
  it('returns zero RAF for an empty input', () => {
    expect(computeRaf([], MAPPINGS)).toEqual({
      total_raf: 0,
      breakdown: [],
      unmapped_icd10s: [],
    });
  });

  it('sums RAF for two unrelated HCCs (no hierarchy interaction)', () => {
    const r = computeRaf(['E11.21', 'C18.0'], MAPPINGS);
    expect(r.total_raf).toBeCloseTo(0.166 + 0.363, 4);
    expect(r.breakdown.map((b) => b.hcc_code)).toEqual(['HCC022', 'HCC037']);
    expect(r.breakdown.every((b) => !b.trumped)).toBe(true);
  });

  it('groups multiple ICD-10s into the same HCC and counts the weight only once', () => {
    const r = computeRaf(['E11.21', 'E11.22'], MAPPINGS);
    expect(r.total_raf).toBeCloseTo(0.166, 4);
    const item = r.breakdown.find((b) => b.hcc_code === 'HCC037')!;
    expect(item.contributing_icd10s).toEqual(['E11.21', 'E11.22']);
  });

  it('applies V28 hierarchy: HCC038 trumped by HCC037 in the same patient', () => {
    const r = computeRaf(['E11.21', 'E11.9'], MAPPINGS);
    const trumped = r.breakdown.find((b) => b.hcc_code === 'HCC038')!;
    const dominant = r.breakdown.find((b) => b.hcc_code === 'HCC037')!;
    expect(trumped.trumped).toBe(true);
    expect(dominant.trumped).toBe(false);
    // Total RAF excludes trumped HCC.
    expect(r.total_raf).toBeCloseTo(0.166, 4);
  });

  it('applies V28 hierarchy: HCC036 (severe acute) trumps HCC037 (chronic), not the reverse', () => {
    const r = computeRaf(['E10.10', 'E11.21'], MAPPINGS);
    expect(r.breakdown.find((b) => b.hcc_code === 'HCC036')!.trumped).toBe(false);
    expect(r.breakdown.find((b) => b.hcc_code === 'HCC037')!.trumped).toBe(true);
    expect(r.total_raf).toBeCloseTo(0.166, 4);
  });

  it('heart failure: end-stage HF trumps acute-on-chronic and other HF', () => {
    const r = computeRaf(['I50.84', 'I50.23', 'I50.9'], MAPPINGS);
    const ends = r.breakdown.find((b) => b.hcc_code === 'HCC222')!;
    const acuteOnChronic = r.breakdown.find((b) => b.hcc_code === 'HCC224')!;
    const other = r.breakdown.find((b) => b.hcc_code === 'HCC226')!;
    expect(ends.trumped).toBe(false);
    expect(acuteOnChronic.trumped).toBe(true);
    expect(other.trumped).toBe(true);
    expect(r.total_raf).toBeCloseTo(2.505, 4);
  });

  it('cancer: lung (HCC020) trumps colorectal (HCC022)', () => {
    const r = computeRaf(['C34.10', 'C18.0'], MAPPINGS);
    expect(r.breakdown.find((b) => b.hcc_code === 'HCC022')!.trumped).toBe(true);
    expect(r.total_raf).toBeCloseTo(1.136, 4);
  });

  it('records unmapped ICDs separately', () => {
    const r = computeRaf(['E11.21', 'Z51.5', 'C99.99'], MAPPINGS);
    expect(r.unmapped_icd10s).toEqual(['C99.99', 'Z51.5']);
    expect(r.total_raf).toBeCloseTo(0.166, 4);
  });

  it('rounds total to 4 decimal places', () => {
    const m = [{ icd10: 'X', hcc_code: 'HCCX', category: null, raf_weight: 0.123_456 }];
    const r = computeRaf(['X'], m);
    expect(r.total_raf).toBe(0.1235);
  });

  it('orders breakdown by HCC code alphabetically (stable for snapshot diffs)', () => {
    const r = computeRaf(['C34.10', 'E11.21', 'I50.84'], MAPPINGS);
    expect(r.breakdown.map((b) => b.hcc_code)).toEqual(['HCC020', 'HCC037', 'HCC222']);
  });

  it('handles ICD-10 with multiple mappings by picking the highest-weighted HCC', () => {
    // Synthetic codes and weights: this tests the selection, not a V28 fact.
    const m: HccMapping[] = [
      { icd10: 'X1', hcc_code: 'HCCA', category: null, raf_weight: 0.2 },
      { icd10: 'X1', hcc_code: 'HCCB', category: null, raf_weight: 0.302 },
    ];
    const r = computeRaf(['X1'], m);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].hcc_code).toBe('HCCB');
    expect(r.total_raf).toBeCloseTo(0.302, 4);
  });

  it('does not trump when the dominant HCC is absent', () => {
    const r = computeRaf(['E11.9'], MAPPINGS);
    const item = r.breakdown.find((b) => b.hcc_code === 'HCC038')!;
    expect(item.trumped).toBe(false);
    expect(r.total_raf).toBeCloseTo(0.166, 4);
  });
});
