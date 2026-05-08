import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEra835 } from '../parser';

const FIXTURE = readFileSync(
  path.join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'sample-835.txt'),
  'utf8',
);

describe('parseEra835 — fixture', () => {
  it('parses header correctly', () => {
    const out = parseEra835(FIXTURE);
    expect(out.header.payer_name).toBe('MEDICARE PALMETTO GBA');
    expect(out.header.payee_name).toBe('ACME HOSPICE LLC');
    expect(out.header.trace_number).toBe('TRACE-ABC-001');
    expect(out.header.total_paid).toBe(1234.56);
    expect(out.header.payment_date).toEqual(new Date(Date.UTC(2026, 3, 15)));
  });

  it('parses 3 claims', () => {
    const out = parseEra835(FIXTURE);
    expect(out.claims).toHaveLength(3);
  });

  it('parses claim 1 (paid)', () => {
    const out = parseEra835(FIXTURE);
    const c = out.claims[0];
    expect(c.claim_id).toBe('CLAIM-001');
    expect(c.status_code).toBe('1');
    expect(c.billed_amount).toBe(250);
    expect(c.paid_amount).toBe(200);
    expect(c.patient_responsibility).toBe(50);
    expect(c.payer_claim_control_number).toBe('MCN-9001');
    expect(c.patient_external_id).toBe('MEMBER-HASH-1');
    // claim-level CAS
    expect(c.adjustments).toEqual([
      { group_code: 'CO', reason_code: '45', amount: 30 },
      { group_code: 'CO', reason_code: '253', amount: 20 },
    ]);
  });

  it('parses claim 1 service line with modifier 25 + line CARC + RARC', () => {
    const out = parseEra835(FIXTURE);
    const line = out.claims[0].service_lines[0];
    expect(line.service_code).toBe('99497');
    expect(line.modifiers).toEqual(['25']);
    expect(line.billed_amount).toBe(250);
    expect(line.paid_amount).toBe(200);
    expect(line.units).toBe(1);
    expect(line.service_dos).toEqual(new Date(Date.UTC(2026, 2, 1)));
    expect(line.adjustments).toEqual([
      { group_code: 'CO', reason_code: '45', amount: 30 },
      { group_code: 'PR', reason_code: '1', amount: 20 },
    ]);
    expect(line.rarc_codes).toEqual(['MA01', 'N115']);
  });

  it('parses claim 2 — denied for bundling (CARC 97)', () => {
    const out = parseEra835(FIXTURE);
    const c = out.claims[1];
    expect(c.claim_id).toBe('CLAIM-002');
    expect(c.status_code).toBe('4'); // denied
    expect(c.paid_amount).toBe(0);
    expect(c.adjustments).toEqual([{ group_code: 'CO', reason_code: '97', amount: 150 }]);
    expect(c.service_lines[0].rarc_codes).toEqual(['N56']);
    expect(c.service_lines[0].adjustments[0].reason_code).toBe('97');
  });

  it('parses claim 3 — denied for timely filing (CARC 29)', () => {
    const out = parseEra835(FIXTURE);
    const c = out.claims[2];
    expect(c.claim_id).toBe('CLAIM-003');
    expect(c.status_code).toBe('2');
    expect(c.adjustments[0].reason_code).toBe('29');
    expect(c.service_lines[0].service_dos).toEqual(new Date(Date.UTC(2025, 0, 1)));
  });

  it('records no unparsed segments for a clean fixture', () => {
    const out = parseEra835(FIXTURE);
    // LX (loop counter) is the only unhandled tag in the fixture.
    expect(out.unparsed_segments.every((s) => s.startsWith('LX'))).toBe(true);
  });
});

describe('parseEra835 — edge cases', () => {
  it('handles a file with no claims', () => {
    const out = parseEra835('ST*835*0001~SE*1*0001~');
    expect(out.claims).toHaveLength(0);
  });

  it('handles a file ending without IEA', () => {
    const minimal = 'CLP*X*1*100.00*100.00~SVC*HC:99213*100.00*100.00**1~';
    const out = parseEra835(minimal);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].service_lines).toHaveLength(1);
  });

  it('returns 0 for non-numeric amounts', () => {
    const out = parseEra835('CLP*X*1*foo*bar*baz~');
    expect(out.claims[0].billed_amount).toBe(0);
    expect(out.claims[0].paid_amount).toBe(0);
  });

  it('skips malformed CAS group codes silently', () => {
    const out = parseEra835('CLP*X*1*100*0~CAS*XYZ*97*100~');
    expect(out.claims[0].adjustments).toEqual([]);
  });

  it('parses multiple CAS triplets in one segment', () => {
    const out = parseEra835('CLP*X*1*100*0~CAS*CO*45*10*1*97*40*0*16*50*0~');
    expect(out.claims[0].adjustments).toEqual([
      { group_code: 'CO', reason_code: '45', amount: 10, quantity: 1 },
      { group_code: 'CO', reason_code: '97', amount: 40, quantity: 0 },
      { group_code: 'CO', reason_code: '16', amount: 50, quantity: 0 },
    ]);
  });

  it('respects custom delimiters from ISA header', () => {
    // Element delimiter '|', segment terminator '#'
    const isa = 'ISA|00|          |00|          |ZZ|P              |ZZ|R              |260415|1234|^|00501|000000001|0|P|:#';
    const body = 'CLP|X|1|100|100#';
    const out = parseEra835(isa + body);
    expect(out.claims[0].claim_id).toBe('X');
    expect(out.claims[0].billed_amount).toBe(100);
  });

  it('does not store patient name from NM1*QC, only the member id', () => {
    const out = parseEra835(
      'CLP*X*1*100*100~NM1*QC*1*SMITH*JOHN*A***MI*MEMBER-9~SVC*HC:99213*100*100**1~',
    );
    const c = out.claims[0];
    expect(c.patient_external_id).toBe('MEMBER-9');
    // Verify no name fields leaked
    expect(JSON.stringify(c)).not.toContain('SMITH');
    expect(JSON.stringify(c)).not.toContain('JOHN');
  });

  it('handles institutional revenue code on SVC04', () => {
    // SVC*HC:99213*100*100*0651*1
    const out = parseEra835('CLP*X*1*100*100~SVC*HC:99213*100*100*0651*1~');
    expect(out.claims[0].service_lines[0].revenue_code).toBe('0651');
  });

  it('does not lose adjustments when SVC ends and a new CLP starts', () => {
    const input = `
CLP*A*1*100*80~CAS*PR*1*20~SVC*HC:99497*100*80**1~CAS*PR*1*20~
CLP*B*4*200*0~CAS*CO*97*200~SVC*HC:36415*200*0**1~
`;
    const out = parseEra835(input);
    expect(out.claims).toHaveLength(2);
    expect(out.claims[0].service_lines).toHaveLength(1);
    expect(out.claims[0].service_lines[0].adjustments).toEqual([
      { group_code: 'PR', reason_code: '1', amount: 20 },
    ]);
    expect(out.claims[1].service_lines).toHaveLength(1);
    expect(out.claims[1].service_lines[0].service_code).toBe('36415');
  });

  it('normalizes CRLF line endings in the fixture stream', () => {
    const input = 'CLP*X*1*100*100~\r\nSVC*HC:99213*100*100**1~\r\n';
    const out = parseEra835(input);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].service_lines[0].service_code).toBe('99213');
  });
});
