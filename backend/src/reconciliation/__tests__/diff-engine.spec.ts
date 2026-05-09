import { computeDiff, type RuleSnapshot } from '../diff-engine';

const PAYER = '11111111-1111-4111-8111-111111111111';

const snap = (over: Partial<RuleSnapshot> = {}): RuleSnapshot => ({
  payer_id: PAYER,
  state: 'OH',
  product_line: 'medicare_ffs',
  code: '99497',
  attribute: 'covered',
  value: { covered: true },
  coverage_status: 'covered',
  effective_date: '2026-01-01',
  source_id: 'a-1',
  ...over,
});

describe('computeDiff', () => {
  it('returns empty when both inputs empty', () => {
    const d = computeDiff([], []);
    expect(d.total).toBe(0);
    expect(d.entries).toEqual([]);
    expect(d.by_outcome).toEqual({
      aligned: 0,
      conflicting: 0,
      missing_in_client: 0,
      missing_in_authoritative: 0,
    });
  });

  it('marks aligned when both sides agree on value + coverage_status', () => {
    const a = [snap({ source_id: 'a' })];
    const c = [snap({ source_id: 'c' })];
    const d = computeDiff(a, c);
    expect(d.by_outcome.aligned).toBe(1);
    expect(d.entries[0].outcome).toBe('aligned');
  });

  it('marks missing_in_client when only authoritative has the rule', () => {
    const d = computeDiff([snap()], []);
    expect(d.by_outcome.missing_in_client).toBe(1);
    expect(d.entries[0].outcome).toBe('missing_in_client');
    expect(d.entries[0].authoritative).toBeDefined();
    expect(d.entries[0].client).toBeUndefined();
  });

  it('marks missing_in_authoritative when only client has the rule', () => {
    const d = computeDiff([], [snap()]);
    expect(d.by_outcome.missing_in_authoritative).toBe(1);
    expect(d.entries[0].outcome).toBe('missing_in_authoritative');
    expect(d.entries[0].client).toBeDefined();
    expect(d.entries[0].authoritative).toBeUndefined();
  });

  it('marks conflicting when value JSON differs', () => {
    const a = [snap({ value: { covered: true, frequency_per_year: 1 } })];
    const c = [snap({ value: { covered: true, frequency_per_year: 2 } })];
    const d = computeDiff(a, c);
    expect(d.by_outcome.conflicting).toBe(1);
    expect(d.entries[0].field_diffs).toEqual(['frequency_per_year']);
  });

  it('marks conflicting when coverage_status differs', () => {
    const a = [snap({ coverage_status: 'covered' })];
    const c = [snap({ coverage_status: 'not_covered' })];
    const d = computeDiff(a, c);
    expect(d.by_outcome.conflicting).toBe(1);
    expect(d.entries[0].field_diffs).toEqual(['coverage_status']);
  });

  it('lists multiple field diffs deterministically', () => {
    const a = [snap({ value: { covered: true, x: 1, y: 'a' }, coverage_status: 'covered' })];
    const c = [snap({ value: { covered: true, x: 2, y: 'b' }, coverage_status: 'not_covered' })];
    const d = computeDiff(a, c);
    expect(d.entries[0].field_diffs).toEqual(['coverage_status', 'x', 'y']);
  });

  it('partitions a mixed input correctly', () => {
    const a = [
      snap({ code: '99497' }), // aligned
      snap({ code: '99498' }), // missing in client
      snap({ code: '99490', value: { freq: 1 } }), // conflicting
    ];
    const c = [
      snap({ code: '99497' }),
      snap({ code: '99490', value: { freq: 2 } }),
      snap({ code: 'G0318' }), // missing in authoritative
    ];
    const d = computeDiff(a, c);
    expect(d.by_outcome).toEqual({
      aligned: 1,
      conflicting: 1,
      missing_in_client: 1,
      missing_in_authoritative: 1,
    });
    expect(d.total).toBe(4);
  });

  it('produces a stable integrity_hash regardless of input order', () => {
    const a = [snap({ code: '99497' }), snap({ code: 'G0318', source_id: 'auth-g' })];
    const c = [snap({ code: '99497' }), snap({ code: 'G0318', source_id: 'client-g' })];
    const h1 = computeDiff(a, c).integrity_hash;
    const h2 = computeDiff([...a].reverse(), [...c].reverse()).integrity_hash;
    expect(h1).toBe(h2);
  });

  it('produces a different integrity_hash when outcome distribution changes', () => {
    const aligned = computeDiff([snap()], [snap()]);
    const conflicting = computeDiff([snap()], [snap({ coverage_status: 'not_covered' })]);
    expect(aligned.integrity_hash).not.toBe(conflicting.integrity_hash);
  });

  it('discriminates by attribute even when other fields match', () => {
    const a = [
      snap({ attribute: 'covered' }),
      snap({ attribute: 'telehealth_allowed', value: { allowed: true } }),
    ];
    const c = [snap({ attribute: 'covered' })];
    const d = computeDiff(a, c);
    expect(d.by_outcome.aligned).toBe(1);
    expect(d.by_outcome.missing_in_client).toBe(1);
    expect(d.entries.find((e) => e.key.attribute === 'telehealth_allowed')!.outcome).toBe(
      'missing_in_client',
    );
  });

  it('discriminates by state even when payer/code/product_line match', () => {
    const d = computeDiff([snap({ state: 'OH' })], [snap({ state: 'NC' })]);
    expect(d.by_outcome.missing_in_client).toBe(1);
    expect(d.by_outcome.missing_in_authoritative).toBe(1);
  });
});
