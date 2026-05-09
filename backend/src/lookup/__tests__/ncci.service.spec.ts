import { evaluateNcci, type PtpEdit, type MueEdit } from '../services/ncci.service';

const dos = new Date('2026-04-15T00:00:00Z');

const release = 'NCCI v32.1';

const ptp: PtpEdit[] = [
  // 99213 + 36415 are bundled (modifier indicator 1 means override allowed)
  {
    column1_code: '99213',
    column2_code: '36415',
    modifier_indicator: 1,
    edit_type: 'practitioner',
    source_release: release,
  },
  // G0463 + 99211 bundled, no override (indicator 0)
  {
    column1_code: 'G0463',
    column2_code: '99211',
    modifier_indicator: 0,
    edit_type: 'hospital_outpatient',
    source_release: release,
  },
];

const mue: MueEdit[] = [
  { code: '99497', setting: 'practitioner', units_max: 1, source_release: release },
];

describe('evaluateNcci', () => {
  it('returns empty when no edits match', () => {
    const out = evaluateNcci(
      {
        lines: [{ index: 0, code: '99497', modifiers: [], units: 1 }],
        setting: 'practitioner',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toHaveLength(0);
  });

  it('flags 99213 + 36415 with no override modifier as bundled', () => {
    const out = evaluateNcci(
      {
        lines: [
          { index: 0, code: '99213', modifiers: [] },
          { index: 1, code: '36415', modifiers: [] },
        ],
        setting: 'practitioner',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toEqual([expect.objectContaining({ kind: 'ptp_bundled', carc: '97' })]);
  });

  it('reports ptp_modifier_overrides when 59 is on the column2 line', () => {
    const out = evaluateNcci(
      {
        lines: [
          { index: 0, code: '99213', modifiers: [] },
          { index: 1, code: '36415', modifiers: ['59'] },
        ],
        setting: 'practitioner',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toEqual([
      expect.objectContaining({ kind: 'ptp_modifier_overrides', modifier_used: '59' }),
    ]);
  });

  it('still flags as bundled when modifier_indicator is 0 even with 59 present', () => {
    const out = evaluateNcci(
      {
        lines: [
          { index: 0, code: 'G0463', modifiers: [] },
          { index: 1, code: '99211', modifiers: ['59'] },
        ],
        setting: 'outpatient_hospital',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toEqual([expect.objectContaining({ kind: 'ptp_bundled' })]);
  });

  it('skips PTP edits whose edit_type does not match the claim setting', () => {
    // 99213+36415 is a practitioner edit; if claim is hospital_outpatient, no flag.
    const out = evaluateNcci(
      {
        lines: [
          { index: 0, code: '99213', modifiers: [] },
          { index: 1, code: '36415', modifiers: [] },
        ],
        setting: 'outpatient_hospital',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toHaveLength(0);
  });

  it('flags MUE units exceeded', () => {
    const out = evaluateNcci(
      {
        lines: [{ index: 0, code: '99497', modifiers: [], units: 2 }],
        setting: 'practitioner',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toEqual([expect.objectContaining({ kind: 'mue_exceeded', carc: '97' })]);
  });

  it('passes when units are at the MUE threshold exactly', () => {
    const out = evaluateNcci(
      {
        lines: [{ index: 0, code: '99497', modifiers: [], units: 1 }],
        setting: 'practitioner',
        dos,
      },
      ptp,
      mue,
    );
    expect(out).toHaveLength(0);
  });
});
