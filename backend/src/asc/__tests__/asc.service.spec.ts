import { evaluateAscLine, type AscIndicatorMatch, type AscLineInput } from '../asc.service';

const line: AscLineInput = { index: 0, code: '27447' };

describe('evaluateAscLine', () => {
  it('flags asc_not_payable when no indicator is on file', () => {
    expect(evaluateAscLine(line, undefined)).toEqual([
      expect.objectContaining({ kind: 'asc_not_payable', line_index: 0, code: '27447' }),
    ]);
  });

  it('returns no issues for A2 (on the ASC list since 2007, paid from the OPPS weight)', () => {
    const m: AscIndicatorMatch = {
      payment_indicator: 'A2',
      payment_group: 'On ASC list since 2007; paid from OPPS relative weight',
      payment_rate: 1255.73,
      source_url: 'https://cms/asc',
      effective_year: 2026,
    };
    expect(evaluateAscLine({ index: 0, code: '66984' }, m)).toEqual([]);
  });

  it('flags P3 (office-based) as a payment-rate caveat', () => {
    const m: AscIndicatorMatch = {
      payment_indicator: 'P3',
      payment_group: 'Office-based; paid from MPFS non-facility PE RVUs',
      payment_rate: 165,
      source_url: 'https://cms/asc',
      effective_year: 2026,
    };
    const out = evaluateAscLine(line, m);
    expect(out).toEqual([
      expect.objectContaining({
        kind: 'asc_office_based',
        line_index: 0,
        source_url: 'https://cms/asc',
      }),
    ]);
    expect(out[0].message).toMatch(/classified P3/);
    expect(out[0].message).toMatch(/\$165\.00/);
  });

  it.each(['P2', 'R2'])('flags %s (office-based) too', (pi) => {
    const m: AscIndicatorMatch = {
      payment_indicator: pi,
      payment_group: null,
      payment_rate: 200,
      source_url: null,
      effective_year: 2026,
    };
    expect(evaluateAscLine(line, m)).toEqual([
      expect.objectContaining({ kind: 'asc_office_based' }),
    ]);
  });

  it('does not flag J8 (device-intensive) — paid normally with device adjustment', () => {
    const m: AscIndicatorMatch = {
      payment_indicator: 'J8',
      payment_group: 'Device-intensive procedure; paid at adjusted rate',
      payment_rate: 9393.16,
      source_url: 'https://cms/asc',
      effective_year: 2026,
    };
    expect(evaluateAscLine(line, m)).toEqual([]);
  });

  it('passes source_url through to the issue when present', () => {
    const m: AscIndicatorMatch = {
      payment_indicator: 'P3',
      payment_group: 'Office-based',
      payment_rate: 100,
      source_url: 'https://cms/source',
      effective_year: 2026,
    };
    const out = evaluateAscLine(line, m);
    expect(out[0].source_url).toBe('https://cms/source');
  });

  it('handles missing payment_rate gracefully (renders ?)', () => {
    const m: AscIndicatorMatch = {
      payment_indicator: 'R2',
      payment_group: null,
      payment_rate: null,
      source_url: null,
      effective_year: 2026,
    };
    const out = evaluateAscLine(line, m);
    expect(out[0].message).toMatch(/\$\?/);
  });
});
