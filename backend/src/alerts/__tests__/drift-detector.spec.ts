import { detectDrift } from '../drift-detector';
import type { DiffEntry, DiffSet } from '../../reconciliation/diff-engine';

const RBID = '11111111-1111-4111-8111-111111111111';
const PAYER = '22222222-2222-4222-8222-222222222222';

const entry = (over: Partial<DiffEntry>): DiffEntry => ({
  outcome: 'aligned',
  key: { payer_id: PAYER, state: 'OH', product_line: 'medicare_ffs', code: '99497', attribute: 'covered' },
  ...over,
});

const set = (entries: DiffEntry[]): DiffSet => ({
  total: entries.length,
  by_outcome: { aligned: 0, conflicting: 0, missing_in_client: 0, missing_in_authoritative: 0 },
  entries,
  integrity_hash: '0',
});

describe('detectDrift', () => {
  it('reports nothing when nothing changed', () => {
    const baseline = set([entry({})]);
    const current = set([entry({})]);
    expect(detectDrift(RBID, baseline, current)).toEqual([]);
  });

  it('emits CRITICAL on aligned → conflicting', () => {
    const baseline = set([entry({})]);
    const current = set([entry({ outcome: 'conflicting', field_diffs: ['frequency_per_year'] })]);
    const alerts = detectDrift(RBID, baseline, current);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].previous_outcome).toBe('aligned');
    expect(alerts[0].current_outcome).toBe('conflicting');
    expect(alerts[0].field_diffs).toEqual(['frequency_per_year']);
  });

  it('emits CRITICAL on aligned → missing_in_authoritative (rule retired)', () => {
    const baseline = set([entry({})]);
    const current = set([entry({ outcome: 'missing_in_authoritative' })]);
    const alerts = detectDrift(RBID, baseline, current);
    expect(alerts[0].severity).toBe('critical');
  });

  it('emits HIGH on missing_in_client → conflicting', () => {
    const baseline = set([entry({ outcome: 'missing_in_client' })]);
    const current = set([entry({ outcome: 'conflicting', field_diffs: ['coverage_status'] })]);
    expect(detectDrift(RBID, baseline, current)[0].severity).toBe('high');
  });

  it('does NOT emit on resolution: conflicting → aligned', () => {
    const baseline = set([entry({ outcome: 'conflicting', field_diffs: ['x'] })]);
    const current = set([entry({})]);
    expect(detectDrift(RBID, baseline, current)).toEqual([]);
  });

  it('does NOT emit on missing_in_client → aligned', () => {
    const baseline = set([entry({ outcome: 'missing_in_client' })]);
    const current = set([entry({})]);
    expect(detectDrift(RBID, baseline, current)).toEqual([]);
  });

  it('emits HIGH on conflicting → conflicting when field_diffs change', () => {
    const baseline = set([entry({ outcome: 'conflicting', field_diffs: ['x'] })]);
    const current = set([entry({ outcome: 'conflicting', field_diffs: ['x', 'y'] })]);
    expect(detectDrift(RBID, baseline, current)[0].severity).toBe('high');
  });

  it('does NOT emit on conflicting → conflicting when field_diffs are identical', () => {
    const baseline = set([entry({ outcome: 'conflicting', field_diffs: ['x'] })]);
    const current = set([entry({ outcome: 'conflicting', field_diffs: ['x'] })]);
    expect(detectDrift(RBID, baseline, current)).toEqual([]);
  });

  it('orders alerts critical → high → medium → info', () => {
    const baseline = set([
      entry({ outcome: 'aligned', key: { ...entry({}).key, code: '99497' } }), // → conflicting (critical)
      entry({ outcome: 'missing_in_client', key: { ...entry({}).key, code: '99498' } }), // → conflicting (high)
    ]);
    const current = set([
      entry({ outcome: 'conflicting', field_diffs: ['x'], key: { ...entry({}).key, code: '99497' } }),
      entry({ outcome: 'conflicting', field_diffs: ['y'], key: { ...entry({}).key, code: '99498' } }),
    ]);
    const alerts = detectDrift(RBID, baseline, current);
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'high']);
  });

  it('handles a brand-new authoritative rule (absent → missing_in_client)', () => {
    const baseline = set([]);
    const current = set([entry({ outcome: 'missing_in_client' })]);
    const alerts = detectDrift(RBID, baseline, current);
    expect(alerts[0].previous_outcome).toBe('absent');
    expect(alerts[0].current_outcome).toBe('missing_in_client');
    expect(alerts[0].severity).toBe('medium');
  });
});
