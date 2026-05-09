import { generate837I } from '../generator-institutional';

const identity = { senderId: 'BR123456', receiverId: 'AVTYBHL01', usage: 'P' as const };
const provider = {
  organizationName: 'ACME HOSPICE',
  npi: '1234567893',
  taxId: '12-3456789',
  taxIdQualifier: 'EI' as const,
  taxonomy: '251G00000X', // Hospice taxonomy
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

const hospiceClaim = {
  patientControlNumber: 'PCN-001',
  totalCharge: 4500.0,
  typeOfBill: '0181', // hospice initial admission
  statementFrom: '20260401',
  statementThrough: '20260415',
  principalDiagnosis: 'C50.911',
  admittingDiagnosis: 'C50.911',
  otherDiagnoses: ['I50.32'],
  conditionCodes: ['80'], // hospice care
  lines: [
    {
      lineNumber: 1,
      revenueCode: '0651', // routine home care
      modifiers: [],
      chargeAmount: 3000.0,
      units: 14,
    },
    {
      lineNumber: 2,
      revenueCode: '0652', // continuous home care
      modifiers: [],
      chargeAmount: 1500.0,
      units: 24,
    },
  ],
};

describe('generate837I', () => {
  it('emits the X12 837I envelope with v5010X223A2', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('GS*HC*');
    expect(out).toContain('ST*837*0001*005010X223A2~');
  });

  it('emits CLM with type-of-bill split into facility:qual:freq', () => {
    // typeOfBill 0181 → facility=01, qual=A (UB-04), freq=8 (replacement)
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('CLM*PCN-001*4500.00***01:A:8');
  });

  it('emits DTP*434 statement covers period as RD8 range', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('DTP*434*RD8*20260401-20260415~');
  });

  it('encodes SV2 service lines with revenue codes (no procedure code)', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('LX*1~');
    expect(out).toContain('SV2*0651**3000.00*UN*14~');
    expect(out).toContain('LX*2~');
    expect(out).toContain('SV2*0652**1500.00*UN*24~');
  });

  it('encodes CPT in SV202 when procedureCode set', () => {
    const claim = {
      ...hospiceClaim,
      lines: [
        {
          lineNumber: 1,
          revenueCode: '0510', // outpatient clinic
          procedureCode: '99213',
          modifiers: ['25'],
          chargeAmount: 150.0,
          units: 1,
          serviceDate: '20260415',
        },
      ],
    };
    const out = generate837I(identity, provider, subscriber, payer, claim, ctl);
    expect(out).toContain('SV2*0510*HC:99213:25*150.00*UN*1~');
    expect(out).toContain('DTP*472*D8*20260415~');
  });

  it('encodes principal + admitting + other diagnosis HI segments', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('HI*ABK:C50911~');
    expect(out).toContain('HI*ABJ:C50911~');
    expect(out).toContain('HI*ABF:I5032~');
  });

  it('encodes condition codes via HI*BG', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out).toContain('HI*BG:80~');
  });

  it('encodes MS-DRG when supplied', () => {
    const out = generate837I(
      identity,
      provider,
      subscriber,
      payer,
      { ...hospiceClaim, msDrg: '470' },
      ctl,
    );
    expect(out).toContain('HI*DR:470~');
  });

  it('encodes occurrence + value codes', () => {
    const out = generate837I(
      identity,
      provider,
      subscriber,
      payer,
      {
        ...hospiceClaim,
        occurrenceCodes: [{ code: '11', date: '20260101' }],
        valueCodes: [{ code: '80', amount: 14.0 }],
      },
      ctl,
    );
    expect(out).toContain('HI*BH:11:D8:20260101~');
    expect(out).toContain('HI*BE:80::14.00~');
  });

  it('rejects a claim with no service lines', () => {
    expect(() =>
      generate837I(identity, provider, subscriber, payer, { ...hospiceClaim, lines: [] }, ctl),
    ).toThrow(/at least one service line/);
  });

  it('rejects non-4-digit revenue codes', () => {
    expect(() =>
      generate837I(
        identity,
        provider,
        subscriber,
        payer,
        {
          ...hospiceClaim,
          lines: [
            {
              lineNumber: 1,
              revenueCode: '651',
              modifiers: [],
              chargeAmount: 100,
              units: 1,
            },
          ],
        },
        ctl,
      ),
    ).toThrow(/4 digits/);
  });

  it('rejects malformed type-of-bill', () => {
    expect(() =>
      generate837I(
        identity,
        provider,
        subscriber,
        payer,
        { ...hospiceClaim, typeOfBill: 'XYZ' },
        ctl,
      ),
    ).toThrow(/typeOfBill/);
  });

  it('SE segment count matches actual segments', () => {
    const out = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    const segs = out
      .split('~')
      .filter((s) => s.length > 0)
      .map((s) => s.trim());
    const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segs.findIndex((s) => s.startsWith('SE*'));
    const declared = parseInt(segs[seIdx].split('*')[1], 10);
    expect(declared).toBe(seIdx - stIdx + 1);
  });

  it('emits CL1 + DTP*435 only when admission info supplied', () => {
    const inpatient = {
      ...hospiceClaim,
      typeOfBill: '0111',
      admissionDate: '20260401',
      admissionTime: '0930',
      admissionType: '1' as const,
      admissionSource: '1',
      patientStatus: '01',
    };
    const out = generate837I(identity, provider, subscriber, payer, inpatient, ctl);
    expect(out).toContain('CL1*1*1*01~');
    expect(out).toContain('DTP*435*DT*202604010930~');

    // Hospice case (no admission fields) does NOT emit CL1.
    const out2 = generate837I(identity, provider, subscriber, payer, hospiceClaim, ctl);
    expect(out2).not.toContain('CL1*');
  });
});
