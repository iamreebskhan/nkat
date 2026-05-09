import { generate270 } from '../generator';

const identity = { senderId: 'BR123456', receiverId: 'AVTYBHL01', usage: 'P' as const };
const info = {
  payerName: 'AETNA',
  payerIdQualifier: 'PI' as const,
  payerId: '60054',
  providerName: 'ACME HOSPICE',
  providerNpi: '1234567893',
  subscriberFirstName: 'JANE',
  subscriberLastName: 'PUBLIC',
  subscriberMemberId: 'W987654321',
  subscriberDob: '19500412',
  subscriberGender: 'F' as const,
  serviceTypeCodes: ['30'],
  serviceDate: '20260415',
};
const ctl = {
  interchangeControlNumber: '1',
  groupControlNumber: '1',
  transactionSetControlNumber: '0001',
  referenceId: 'INQ-1',
  nowIso: '2026-04-15T10:30:00Z',
};

describe('generate270', () => {
  it('emits the canonical envelope (ISA/GS/ST … SE/GE/IEA)', () => {
    const out = generate270(identity, info, ctl);
    expect(out.startsWith('ISA*')).toBe(true);
    expect(out).toContain('GS*HS*');
    expect(out).toContain('ST*270*0001*005010X279A1~');
    expect(out).toContain('SE*');
    expect(out).toContain('GE*1*1~');
    expect(out).toContain('IEA*1*000000001~');
  });

  it('encodes payer + provider + subscriber NM1 segments', () => {
    const out = generate270(identity, info, ctl);
    expect(out).toContain('NM1*PR*2*AETNA');
    expect(out).toContain('NM1*1P*2*ACME HOSPICE');
    expect(out).toContain('NM1*IL*1*PUBLIC*JANE');
    expect(out).toContain('DMG*D8*19500412*F~');
    expect(out).toContain('DTP*291*D8*20260415~');
    expect(out).toContain('EQ*30~');
  });

  it('SE segment count matches actual segment count from ST through SE', () => {
    const out = generate270(identity, info, ctl);
    const segs = out
      .split('~')
      .filter((s) => s.length > 0)
      .map((s) => s.trim());
    const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segs.findIndex((s) => s.startsWith('SE*'));
    const declared = parseInt(segs[seIdx].split('*')[1], 10);
    const actual = seIdx - stIdx + 1;
    expect(declared).toBe(actual);
  });

  it('one EQ segment per service type', () => {
    const out = generate270(identity, { ...info, serviceTypeCodes: ['30', 'MH', 'AL'] }, ctl);
    const eqs = (out.match(/EQ\*/g) || []).length;
    expect(eqs).toBe(3);
  });

  it('ISA13 padded to 9 digits', () => {
    const out = generate270(identity, info, ctl);
    const isa = out.split('~')[0];
    const fields = isa.split('*');
    expect(fields[13]).toBe('000000001');
  });

  it('emits a dependent HL=4 + INS + NM1*03 + DMG when dependent supplied', () => {
    const out = generate270(
      identity,
      {
        ...info,
        dependent: {
          firstName: 'JOHN',
          lastName: 'PUBLIC',
          dob: '20100815',
          gender: 'M',
          relationship: '19',
        },
      },
      ctl,
    );
    expect(out).toContain('HL*3*2*22*1~'); // subscriber has-children flag = 1
    expect(out).toContain('HL*4*3*23*0~'); // dependent
    expect(out).toContain('INS*N*19~');
    expect(out).toContain('NM1*03*1*PUBLIC*JOHN');
    expect(out).toContain('DMG*D8*20100815*M~');
    // Ensures DTP*291 stays under the dependent, not the subscriber.
    const idx291 = out.indexOf('DTP*291');
    const idx04 = out.indexOf('HL*4*3');
    expect(idx291).toBeGreaterThan(idx04);
  });

  it('subscriber-only retains has-children flag = 0', () => {
    const out = generate270(identity, info, ctl);
    expect(out).toContain('HL*3*2*22*0~');
  });
});
