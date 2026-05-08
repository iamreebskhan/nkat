import { evaluateParity, type ParityRuleInput } from '../services/mhpaea-parity.engine';

const r = (over: Partial<ParityRuleInput>): ParityRuleInput => ({
  code: '90837',
  attribute: 'covered',
  value: { covered: true },
  coverage_status: 'covered',
  ...over,
});

describe('evaluateParity', () => {
  it('returns no flags when both sides are aligned', () => {
    const out = evaluateParity('90837', '99214', [r({})], [r({ code: '99214' })]);
    expect(out).toEqual([]);
  });

  it('flags BH=not_covered while med/surg=covered', () => {
    const bh = [r({ coverage_status: 'not_covered' })];
    const ms = [r({ code: '99214' })];
    const out = evaluateParity('90837', '99214', bh, ms);
    expect(out).toEqual([
      expect.objectContaining({ kind: 'covered_only_for_med_surg', confidence: 1 }),
    ]);
  });

  it('flags BH=PA-required while med/surg=not', () => {
    const bh = [r({ attribute: 'prior_auth_required', value: { required: true } })];
    const ms = [r({ code: '99214', attribute: 'prior_auth_required', value: { required: false } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([
      expect.objectContaining({ kind: 'prior_auth_more_restrictive' }),
    ]);
  });

  it('does NOT flag when BH=not-required and med/surg=required (less restrictive is fine)', () => {
    const bh = [r({ attribute: 'prior_auth_required', value: { required: false } })];
    const ms = [r({ code: '99214', attribute: 'prior_auth_required', value: { required: true } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([]);
  });

  it('flags BH frequency cap lower than med/surg', () => {
    const bh = [r({ attribute: 'frequency_limit', value: { per_year: 12 } })];
    const ms = [r({ code: '99214', attribute: 'frequency_limit', value: { per_year: 26 } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([
      expect.objectContaining({ kind: 'frequency_lower' }),
    ]);
  });

  it('does NOT flag when BH frequency >= med/surg', () => {
    const bh = [r({ attribute: 'frequency_limit', value: { per_year: 26 } })];
    const ms = [r({ code: '99214', attribute: 'frequency_limit', value: { per_year: 12 } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([]);
  });

  it('flags BH copay higher than med/surg', () => {
    const bh = [r({ attribute: 'copay_or_costshare', value: { copay: 60 } })];
    const ms = [r({ code: '99214', attribute: 'copay_or_costshare', value: { copay: 30 } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([
      expect.objectContaining({ kind: 'cost_share_higher' }),
    ]);
  });

  it('flags BH documentation burden heavier than med/surg', () => {
    const bh = [
      r({
        attribute: 'documentation_required',
        value: {
          required_phrases: ['therapy goal', 'response to treatment'],
          required_chart_elements: ['progress note', 'crisis plan'],
          mdm_elements: [],
        },
      }),
    ];
    const ms = [
      r({
        code: '99214',
        attribute: 'documentation_required',
        value: { required_phrases: [], required_chart_elements: ['progress note'], mdm_elements: [] },
      }),
    ];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([
      expect.objectContaining({ kind: 'documentation_heavier' }),
    ]);
  });

  it('aggregates multiple flags from a single pair', () => {
    const bh = [
      r({ attribute: 'prior_auth_required', value: { required: true } }),
      r({ attribute: 'frequency_limit', value: { per_year: 8 } }),
      r({ attribute: 'copay_or_costshare', value: { copay: 75 } }),
    ];
    const ms = [
      r({ code: '99214', attribute: 'prior_auth_required', value: { required: false } }),
      r({ code: '99214', attribute: 'frequency_limit', value: { per_year: 26 } }),
      r({ code: '99214', attribute: 'copay_or_costshare', value: { copay: 30 } }),
    ];
    const out = evaluateParity('90837', '99214', bh, ms);
    const kinds = out.map((f) => f.kind);
    expect(kinds).toEqual(['prior_auth_more_restrictive', 'frequency_lower', 'cost_share_higher']);
  });

  it('treats missing rules on either side as no-flag (cannot compare)', () => {
    const bh: ParityRuleInput[] = [];
    const ms = [r({ code: '99214', attribute: 'prior_auth_required', value: { required: true } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([]);
  });

  it('coerces stringified booleans/numbers correctly', () => {
    const bh = [r({ attribute: 'prior_auth_required', value: { required: 'true' } })];
    const ms = [r({ code: '99214', attribute: 'prior_auth_required', value: { required: 'false' } })];
    expect(evaluateParity('90837', '99214', bh, ms)).toEqual([
      expect.objectContaining({ kind: 'prior_auth_more_restrictive' }),
    ]);
  });
});
