import { parseCsvRow, parseNcciMue, parseNcciPtp } from '../parser';

describe('parseCsvRow', () => {
  it('handles a plain row', () => {
    expect(parseCsvRow('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with commas', () => {
    expect(parseCsvRow('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('handles escaped doublequotes inside quoted field', () => {
    expect(parseCsvRow('a,"b ""quoted"" c"')).toEqual(['a', 'b "quoted" c']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseCsvRow(' a , b ,c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseNcciPtp', () => {
  const csv =
    'Column_1,Column_2,Modifier_Indicator,Effective_Date,Deletion_Date,Rationale_for_pair\n' +
    '99213,99214,1,2026-01-01,*,Misc /1/ rationale\n' +
    '99213,99396,9,2026-01-01,2026-12-31,Mutually exclusive\n';

  it('parses well-formed rows', () => {
    const r = parseNcciPtp(csv, { editType: 'practitioner', release: '2026Q2' });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      column1_code: '99213',
      column2_code: '99214',
      modifier_indicator: 1,
      edit_type: 'practitioner',
      source_release: '2026Q2',
      expiration_date: null,
    });
    expect(r.rows[1].modifier_indicator).toBe(9);
    expect(r.rows[1].expiration_date).not.toBeNull();
  });

  it('records bad rows in errors[]', () => {
    const bad =
      'Column_1,Column_2,Modifier_Indicator,Effective_Date\n' +
      '99213,99214,bogus,2026-01-01\n';
    const r = parseNcciPtp(bad, { editType: 'practitioner', release: '2026Q2' });
    expect(r.rows).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
  });

  it('surfaces a header error when required columns are missing', () => {
    const noHeaders = 'foo,bar\n1,2\n';
    const r = parseNcciPtp(noHeaders, { editType: 'practitioner', release: '2026Q2' });
    expect(r.errors[0].reason).toMatch(/header missing/);
  });

  it('handles MM/DD/YYYY dates', () => {
    const csv =
      'Column_1,Column_2,Modifier_Indicator,Effective_Date\n' +
      '99213,99214,1,01/15/2026\n';
    const r = parseNcciPtp(csv, { editType: 'practitioner', release: '2026Q2' });
    expect(r.rows[0].effective_date.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });
});

describe('parseNcciMue', () => {
  const csv =
    'HCPCS_CPT_Code,MUE_Value,Effective_Date,Rationale\n' +
    '99213,1,2026-01-01,Anatomic considerations\n' +
    'J7322,4,2026-04-01,Drug units\n';

  it('parses MUE rows with setting injected', () => {
    const r = parseNcciMue(csv, { setting: 'practitioner', release: '2026Q2' });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      code: '99213',
      setting: 'practitioner',
      units_max: 1,
      source_release: '2026Q2',
    });
  });

  it('errors on negative or non-numeric units', () => {
    const csv =
      'HCPCS_CPT_Code,MUE_Value,Effective_Date\n' +
      '99213,abc,2026-01-01\n';
    const r = parseNcciMue(csv, { setting: 'practitioner', release: '2026Q2' });
    expect(r.errors).toHaveLength(1);
  });
});
