import { computeRaf, type HccMapping } from '../hcc.service';

const MAPPINGS: HccMapping[] = [
  // Diabetes family
  { icd10: 'E11.21', hcc_code: 'HCC037', category: 'Diabetes w/ chronic complications', raf_weight: 0.302 },
  { icd10: 'E11.22', hcc_code: 'HCC037', category: 'Diabetes w/ chronic complications', raf_weight: 0.302 },
  { icd10: 'E11.65', hcc_code: 'HCC036', category: 'Diabetes w/ acute',                  raf_weight: 0.302 },
  { icd10: 'E11.9',  hcc_code: 'HCC038', category: 'Diabetes w/o complication',          raf_weight: 0.105 },
  // CHF family
  { icd10: 'I50.84', hcc_code: 'HCC222', category: 'End-stage HF',                       raf_weight: 0.737 },
  { icd10: 'I50.22', hcc_code: 'HCC224', category: 'HF except end-stage',                raf_weight: 0.337 },
  { icd10: 'I50.9',  hcc_code: 'HCC226', category: 'HF unspecified',                     raf_weight: 0.275 },
  // Cancers
  { icd10: 'C18.0',  hcc_code: 'HCC020', category: 'Colorectal cancer',                  raf_weight: 0.281 },
  { icd10: 'C34.10', hcc_code: 'HCC017', category: 'Lung cancer',                        raf_weight: 0.928 },
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
    expect(r.total_raf).toBeCloseTo(0.302 + 0.281, 4);
    expect(r.breakdown.map((b) => b.hcc_code)).toEqual(['HCC020', 'HCC037']);
    expect(r.breakdown.every((b) => !b.trumped)).toBe(true);
  });

  it('groups multiple ICD-10s into the same HCC and counts the weight only once', () => {
    const r = computeRaf(['E11.21', 'E11.22'], MAPPINGS);
    expect(r.total_raf).toBeCloseTo(0.302, 4);
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
    expect(r.total_raf).toBeCloseTo(0.302, 4);
  });

  it('applies V28 hierarchy: HCC036 + HCC037 — HCC036 (acute) trumped by HCC037 (chronic)', () => {
    const r = computeRaf(['E11.65', 'E11.21'], MAPPINGS);
    const acute = r.breakdown.find((b) => b.hcc_code === 'HCC036')!;
    expect(acute.trumped).toBe(true);
    expect(r.total_raf).toBeCloseTo(0.302, 4);
  });

  it('CHF: end-stage HF trumps both general and unspecified HF', () => {
    const r = computeRaf(['I50.84', 'I50.22', 'I50.9'], MAPPINGS);
    const ends = r.breakdown.find((b) => b.hcc_code === 'HCC222')!;
    const gen = r.breakdown.find((b) => b.hcc_code === 'HCC224')!;
    const uns = r.breakdown.find((b) => b.hcc_code === 'HCC226')!;
    expect(ends.trumped).toBe(false);
    expect(gen.trumped).toBe(true);
    expect(uns.trumped).toBe(true);
    expect(r.total_raf).toBeCloseTo(0.737, 4);
  });

  it('records unmapped ICDs separately', () => {
    const r = computeRaf(['E11.21', 'Z51.5', 'C99.99'], MAPPINGS);
    expect(r.unmapped_icd10s).toEqual(['C99.99', 'Z51.5']);
    expect(r.total_raf).toBeCloseTo(0.302, 4);
  });

  it('rounds total to 4 decimal places', () => {
    const m = [{ icd10: 'X', hcc_code: 'HCCX', category: null, raf_weight: 0.123_456 }];
    const r = computeRaf(['X'], m);
    expect(r.total_raf).toBe(0.1235);
  });

  it('orders breakdown by HCC code alphabetically (stable for snapshot diffs)', () => {
    const r = computeRaf(['C34.10', 'E11.21', 'I50.84'], MAPPINGS);
    expect(r.breakdown.map((b) => b.hcc_code)).toEqual(['HCC017', 'HCC037', 'HCC222']);
  });

  it('handles ICD-10 with multiple mappings by picking the highest-weighted HCC', () => {
    const m: HccMapping[] = [
      { icd10: 'E11.21', hcc_code: 'HCC036', category: null, raf_weight: 0.200 },
      { icd10: 'E11.21', hcc_code: 'HCC037', category: null, raf_weight: 0.302 },
    ];
    const r = computeRaf(['E11.21'], m);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0].hcc_code).toBe('HCC037');
    expect(r.total_raf).toBeCloseTo(0.302, 4);
  });

  it('does not trump when the dominant HCC is absent', () => {
    const r = computeRaf(['E11.9'], MAPPINGS);
    const item = r.breakdown.find((b) => b.hcc_code === 'HCC038')!;
    expect(item.trumped).toBe(false);
    expect(r.total_raf).toBeCloseTo(0.105, 4);
  });
});
