import { parseMsDrg } from '../parser';

const csv =
  'MS-DRG,MDC,Type,MS-DRG Title,Weight,Geometric mean LOS,Arithmetic mean LOS\n' +
  '001,01,SURG,Heart transplant w MCC,29.5,30.5,40.2\n' +
  '470,08,SURG,Major joint replacement w/o MCC,2.1,2.5,2.7\n' +
  '871,18,MED,Septicemia or severe sepsis w/o MV >96 hours w MCC,1.8,4.5,5.1\n';

describe('parseMsDrg', () => {
  it('parses well-formed FY2026 rows', () => {
    const r = parseMsDrg(csv, {
      fyVersion: 'v43',
      effectiveDate: new Date('2025-10-01T00:00:00Z'),
      expirationDate: new Date('2026-09-30T00:00:00Z'),
    });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({
      code: '001',
      mdc: '01',
      type: 'surgical',
      relative_weight: 29.5,
      geometric_mean_los: 30.5,
      arithmetic_mean_los: 40.2,
      fy_version: 'v43',
    });
    expect(r.rows[2].type).toBe('medical');
  });

  it('zero-pads short DRG codes', () => {
    const partial = 'MS-DRG,MDC,Type,MS-DRG Title,Weight\n' + '1,01,SURG,Test entry,1.0\n';
    const r = parseMsDrg(partial, { fyVersion: 'v43', effectiveDate: new Date() });
    expect(r.rows[0].code).toBe('001');
  });

  it('errors on missing required columns', () => {
    const r = parseMsDrg('foo,bar\n1,2\n', { fyVersion: 'v43', effectiveDate: new Date() });
    expect(r.errors[0].reason).toMatch(/header/);
  });

  it('errors on non-numeric weight', () => {
    const bad = 'MS-DRG,Type,MS-DRG Title,Weight\n' + '999,SURG,Bogus,abc\n';
    const r = parseMsDrg(bad, { fyVersion: 'v43', effectiveDate: new Date() });
    expect(r.errors).toHaveLength(1);
  });
});
