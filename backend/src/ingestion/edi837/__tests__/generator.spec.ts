import { generate837P } from '../generator';

const identity = { senderId: 'BR123456', receiverId: 'AVTYBHL01', usage: 'P' as const };
const provider = {
  organizationName: 'ACME HOSPICE',
  npi: '1234567893',
  taxId: '12-3456789',
  taxIdQualifier: 'EI' as const,
  taxonomy: '251G00000X',
};
const subscriber = {
  memberId: 'W987654321',
  firstName: 'JANE',
  lastName: 'PUBLIC',
  dob: '19500412',
  gender: 'F' as const,
  address1: '123 OAK ST',
  city: 'CLEVELAND',
  state: 'OH',
  zip: '44109',
};
const payer = { name: 'AETNA', payerId: '60054', payerIdQualifier: 'PI' as const };
const ctl = {
  interchangeControlNumber: '1',
  groupControlNumber: '1',
  transactionSetControlNumber: '0001',
  referenceId: 'CLM-1',
  nowIso: '2026-04-15T10:30:00Z',
};

const baseClaim = {
  patientControlNumber: 'PCN-001',
  totalCharge: 350.0,
  diagnoses: ['Z51.5', 'I50.32'],
  lines: [
    {
      lineNumber: 1,
      procedureCode: '99497',
      modifiers: [],
      diagnosisPointers: [1],
      chargeAmount: 200.0,
      units: 1,
      serviceDate: '20260415',
      placeOfService: '11',
    },
    {
      lineNumber: 2,
      procedureCode: '99498',
      modifiers: ['25'],
      diagnosisPointers: [1, 2],
      chargeAmount: 150.0,
      units: 1,
      serviceDate: '20260415',
      placeOfService: '11',
    },
  ],
};

describe('generate837P', () => {
  it('emits the X12 837P envelope', () => {
    const out = generate837P(identity, provider, subscriber, payer, baseClaim, ctl);
    expect(out.startsWith('ISA*')).toBe(true);
    expect(out).toContain('GS*HC*');
    expect(out).toContain('ST*837*0001*005010X222A1~');
    expect(out).toContain('SE*');
    expect(out).toContain('IEA*1*000000001~');
  });

  it('encodes provider, subscriber, payer NM1', () => {
    const out = generate837P(identity, provider, subscriber, payer, baseClaim, ctl);
    expect(out).toContain('NM1*85*2*ACME HOSPICE*****XX*1234567893');
    expect(out).toContain('NM1*IL*1*PUBLIC*JANE****MI*W987654321');
    expect(out).toContain('NM1*PR*2*AETNA*****PI*60054');
  });

  it('encodes CLM + HI + service lines', () => {
    const out = generate837P(identity, provider, subscriber, payer, baseClaim, ctl);
    expect(out).toContain('CLM*PCN-001*350.00');
    expect(out).toContain('HI*ABK:Z515*ABF:I5032~');
    expect(out).toContain('LX*1~');
    expect(out).toContain('SV1*HC:99497*200.00*UN*1*11**1');
    expect(out).toContain('LX*2~');
    expect(out).toContain('SV1*HC:99498:25*150.00*UN*1*11**1:2');
    expect(out).toContain('DTP*472*D8*20260415~');
  });

  it('rejects an empty service-line list', () => {
    expect(() =>
      generate837P(identity, provider, subscriber, payer, { ...baseClaim, lines: [] }, ctl),
    ).toThrow(/at least one service line/);
  });

  it('rejects a claim with no diagnosis', () => {
    expect(() =>
      generate837P(identity, provider, subscriber, payer, { ...baseClaim, diagnoses: [] }, ctl),
    ).toThrow(/at least one diagnosis/);
  });

  it('rejects more than 12 diagnoses', () => {
    expect(() =>
      generate837P(
        identity,
        provider,
        subscriber,
        payer,
        { ...baseClaim, diagnoses: Array(13).fill('Z51.5') },
        ctl,
      ),
    ).toThrow(/cannot exceed 12/);
  });

  it('SE segment count is exact', () => {
    const out = generate837P(identity, provider, subscriber, payer, baseClaim, ctl);
    const segs = out.split('~').filter((s) => s.length > 0).map((s) => s.trim());
    const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segs.findIndex((s) => s.startsWith('SE*'));
    const declared = parseInt(segs[seIdx].split('*')[1], 10);
    expect(declared).toBe(seIdx - stIdx + 1);
  });

  it('emits the COB Loop 2320/2330 chain when secondaryPayer supplied', () => {
    const claim = {
      ...baseClaim,
      secondaryPayer: {
        payer: { name: 'BCBS', payerId: 'BCBSOH', payerIdQualifier: 'PI' as const },
        payerResponsibility: 'S' as const,
        relationship: '01' as const,
        otherSubscriberMemberId: 'X1234567',
        otherSubscriberFirstName: 'JOHN',
        otherSubscriberLastName: 'PUBLIC',
        paidAmount: 50.0,
      },
    };
    const out = generate837P(identity, provider, subscriber, payer, claim, ctl);
    expect(out).toContain('SBR*S*01******CI~');
    expect(out).toContain('AMT*D*50.00~');
    expect(out).toContain('OI***Y***Y~');
    expect(out).toContain('NM1*IL*1*PUBLIC*JOHN****MI*X1234567~');
    expect(out).toContain('NM1*PR*2*BCBS*****PI*BCBSOH~');
    // SE count must update.
    const segs = out.split('~').filter((s) => s.length > 0).map((s) => s.trim());
    const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segs.findIndex((s) => s.startsWith('SE*'));
    const declared = parseInt(segs[seIdx].split('*')[1], 10);
    expect(declared).toBe(seIdx - stIdx + 1);
  });
});
