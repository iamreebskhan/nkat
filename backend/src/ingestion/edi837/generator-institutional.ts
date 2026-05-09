/**
 * X12 837I — Health Care Claim: Institutional (v5010X223A2).
 *
 * Used for UB-04 / institutional billing — hospital, hospice, SNF,
 * home health, ASC. Distinct from 837P:
 *
 *   - Loop 2300 carries CLM + DTP*434 (statement covers period) +
 *     CL1 (admission type/source) + HI (DRG, principal diagnosis,
 *     admit dx, condition codes, value codes, occurrence codes).
 *   - Loop 2400 service line uses SV2 (NOT SV1). SV201 carries the
 *     revenue code; SV202 carries CPT/HCPCS as composite.
 *   - Bill type (CLM05-1) is the 3-character UB-04 type-of-bill code
 *     (e.g., 0322 home-health admit, 0181 hospice initial).
 *
 * Single submitter / single subscriber / multi-line case, like the
 * 837P generator. COB chain is not in this implementation.
 */
import { formatDate, formatTime, pad } from '../edi270/generator';

export interface Edi837IIdentity {
  senderId: string;
  receiverId: string;
  usage: 'P' | 'T';
}

export interface Edi837IProvider {
  organizationName: string;
  npi: string;
  taxId: string;
  taxIdQualifier: 'EI' | 'SY';
  /** Required on 837I — the facility's primary specialty taxonomy. */
  taxonomy: string;
}

export interface Edi837ISubscriber {
  memberId: string;
  firstName: string;
  lastName: string;
  dob: string;
  gender: 'M' | 'F' | 'U';
  address1: string;
  city: string;
  state: string;
  zip: string;
}

export interface Edi837IPayer {
  name: string;
  payerId: string;
  payerIdQualifier: 'PI' | 'XV';
}

export interface Edi837IServiceLine {
  lineNumber: number;
  /** UB-04 FL 42 — required on every line. 4-digit revenue code. */
  revenueCode: string;
  /** Optional CPT/HCPCS for outpatient lines; required by some payers. */
  procedureCode?: string;
  /** Up to 4 modifiers. */
  modifiers: string[];
  chargeAmount: number;
  units: number;
  /** Service date (YYYYMMDD) — for outpatient lines. Inpatient stays
   *  use the claim-level statement period instead. */
  serviceDate?: string;
  /** Non-covered amount (CLM-equivalent at line level). */
  nonCoveredCharge?: number;
}

export interface Edi837IClaim {
  patientControlNumber: string;
  totalCharge: number;
  /** UB-04 FL 4 type-of-bill code (3-digit, e.g. 0322). */
  typeOfBill: string;
  /** Statement covers period — YYYYMMDD start + end. */
  statementFrom: string;
  statementThrough: string;
  /** Admission info — required for inpatient. */
  admissionDate?: string;
  admissionTime?: string; // HHMM
  admissionType?: '1' | '2' | '3' | '4' | '5' | '9';
  admissionSource?: string;
  patientStatus?: string; // UB-04 FL 17
  /** ICD-10 diagnoses. First is principal. */
  principalDiagnosis: string;
  admittingDiagnosis?: string;
  otherDiagnoses: string[];
  /** Optional MS-DRG (HI*DR segment). */
  msDrg?: string;
  /** UB-04 condition codes (FL 18-28). Up to 11 supported. */
  conditionCodes?: string[];
  /** UB-04 occurrence codes (FL 31-34). */
  occurrenceCodes?: { code: string; date: string }[];
  /** UB-04 value codes (FL 39-41). */
  valueCodes?: { code: string; amount: number }[];
  lines: Edi837IServiceLine[];
}

export interface Edi837IControl {
  interchangeControlNumber: string;
  groupControlNumber: string;
  transactionSetControlNumber: string;
  referenceId: string;
  nowIso?: string;
}

const SEG_TERM = '~';
const ELEM_SEP = '*';
const SUB_SEP = ':';

export function generate837I(
  identity: Edi837IIdentity,
  provider: Edi837IProvider,
  subscriber: Edi837ISubscriber,
  payer: Edi837IPayer,
  claim: Edi837IClaim,
  ctl: Edi837IControl,
): string {
  if (claim.lines.length === 0) {
    throw new Error('837I claim must have at least one service line.');
  }
  if (!claim.principalDiagnosis) {
    throw new Error('837I claim must have a principal diagnosis.');
  }
  if (!/^\d{4}$/.test(claim.lines[0].revenueCode)) {
    throw new Error('837I service-line revenue codes must be 4 digits.');
  }
  if ((claim.otherDiagnoses?.length ?? 0) > 23) {
    throw new Error('837I cannot exceed 24 diagnoses (HI principal + 23 other).');
  }
  if (!/^\d{3,4}$/.test(claim.typeOfBill)) {
    throw new Error('837I typeOfBill must be a UB-04 3-4 digit code.');
  }

  const now = ctl.nowIso ? new Date(ctl.nowIso) : new Date();
  const yyyymmdd = formatDate(now);
  const yymmdd = yyyymmdd.slice(2);
  const hhmm = formatTime(now);

  const segs: string[] = [];

  segs.push(
    [
      'ISA',
      '00',
      '          ',
      '00',
      '          ',
      'ZZ',
      pad(identity.senderId, 15),
      'ZZ',
      pad(identity.receiverId, 15),
      yymmdd,
      hhmm,
      '^',
      '00501',
      pad(ctl.interchangeControlNumber, 9, '0', 'left'),
      '0',
      identity.usage,
      SUB_SEP,
    ].join(ELEM_SEP),
  );

  segs.push(
    [
      'GS',
      'HC',
      identity.senderId,
      identity.receiverId,
      yyyymmdd,
      hhmm,
      ctl.groupControlNumber,
      'X',
      '005010X223A2',
    ].join(ELEM_SEP),
  );

  segs.push(['ST', '837', ctl.transactionSetControlNumber, '005010X223A2'].join(ELEM_SEP));
  segs.push(['BHT', '0019', '00', ctl.referenceId, yyyymmdd, hhmm, 'CH'].join(ELEM_SEP));

  // Submitter
  segs.push(
    ['NM1', '41', '2', provider.organizationName, '', '', '', '', '46', identity.senderId].join(
      ELEM_SEP,
    ),
  );
  segs.push(['PER', 'IC', provider.organizationName].join(ELEM_SEP));

  // Receiver
  segs.push(
    ['NM1', '40', '2', payer.name, '', '', '', '', '46', identity.receiverId].join(ELEM_SEP),
  );

  // Billing Provider HL=1
  segs.push(['HL', '1', '', '20', '1'].join(ELEM_SEP));
  segs.push(['PRV', 'BI', 'PXC', provider.taxonomy].join(ELEM_SEP));
  segs.push(
    ['NM1', '85', '2', provider.organizationName, '', '', '', '', 'XX', provider.npi].join(
      ELEM_SEP,
    ),
  );
  segs.push(['REF', provider.taxIdQualifier, provider.taxId].join(ELEM_SEP));

  // Subscriber HL=2
  segs.push(['HL', '2', '1', '22', '0'].join(ELEM_SEP));
  segs.push(['SBR', 'P', '18', '', '', '', '', '', 'CI'].join(ELEM_SEP));
  segs.push(
    [
      'NM1',
      'IL',
      '1',
      subscriber.lastName,
      subscriber.firstName,
      '',
      '',
      '',
      'MI',
      subscriber.memberId,
    ].join(ELEM_SEP),
  );
  segs.push(['N3', subscriber.address1].join(ELEM_SEP));
  segs.push(['N4', subscriber.city, subscriber.state, subscriber.zip].join(ELEM_SEP));
  segs.push(['DMG', 'D8', subscriber.dob, subscriber.gender].join(ELEM_SEP));

  segs.push(
    ['NM1', 'PR', '2', payer.name, '', '', '', '', payer.payerIdQualifier, payer.payerId].join(
      ELEM_SEP,
    ),
  );

  // ----- Claim -----
  // CLM05 = facility code value : facility code qualifier : claim freq.
  // For 837I the "facility code" is the first 2 digits of TYPE-OF-BILL,
  // qualifier 'A' = UB-04, freq is the last digit of TOB.
  const tob = claim.typeOfBill.padStart(3, '0');
  const facilityCode = tob.slice(0, 2);
  const claimFreq = tob.slice(2, 3);
  segs.push(
    [
      'CLM',
      claim.patientControlNumber,
      claim.totalCharge.toFixed(2),
      '',
      '',
      `${facilityCode}${SUB_SEP}A${SUB_SEP}${claimFreq}`,
      'Y',
      'A',
      'Y',
      'I',
    ].join(ELEM_SEP),
  );

  // Statement covers period (DTP*434)
  segs.push(
    ['DTP', '434', 'RD8', `${claim.statementFrom}-${claim.statementThrough}`].join(ELEM_SEP),
  );

  // Admission info (CL1) — only when admission fields supplied (inpatient + some hospice).
  if (claim.admissionType || claim.admissionSource || claim.patientStatus) {
    segs.push(
      [
        'CL1',
        claim.admissionType ?? '',
        claim.admissionSource ?? '',
        claim.patientStatus ?? '',
      ].join(ELEM_SEP),
    );
  }
  if (claim.admissionDate) {
    const time = claim.admissionTime ?? '';
    segs.push(
      [
        'DTP',
        '435',
        time ? 'DT' : 'D8',
        time ? `${claim.admissionDate}${time}` : claim.admissionDate,
      ].join(ELEM_SEP),
    );
  }

  // HI — diagnoses + DRG + condition / occurrence / value codes.
  // Principal: ABK. Admit: ABJ. Other: ABF (up to 23). DRG: APR.
  const hiPrincipal = `ABK${SUB_SEP}${claim.principalDiagnosis.replace('.', '')}`;
  segs.push(['HI', hiPrincipal].join(ELEM_SEP));
  if (claim.admittingDiagnosis) {
    segs.push(['HI', `ABJ${SUB_SEP}${claim.admittingDiagnosis.replace('.', '')}`].join(ELEM_SEP));
  }
  if (claim.otherDiagnoses.length > 0) {
    const hi = claim.otherDiagnoses.map((dx) => `ABF${SUB_SEP}${dx.replace('.', '')}`);
    segs.push(['HI', ...hi].join(ELEM_SEP));
  }
  if (claim.msDrg) {
    segs.push(['HI', `DR${SUB_SEP}${claim.msDrg}`].join(ELEM_SEP));
  }
  if (claim.conditionCodes && claim.conditionCodes.length > 0) {
    const hi = claim.conditionCodes.map((c) => `BG${SUB_SEP}${c}`);
    segs.push(['HI', ...hi].join(ELEM_SEP));
  }
  if (claim.occurrenceCodes && claim.occurrenceCodes.length > 0) {
    const hi = claim.occurrenceCodes.map(
      (o) => `BH${SUB_SEP}${o.code}${SUB_SEP}D8${SUB_SEP}${o.date}`,
    );
    segs.push(['HI', ...hi].join(ELEM_SEP));
  }
  if (claim.valueCodes && claim.valueCodes.length > 0) {
    const hi = claim.valueCodes.map(
      (v) => `BE${SUB_SEP}${v.code}${SUB_SEP}${SUB_SEP}${v.amount.toFixed(2)}`,
    );
    segs.push(['HI', ...hi].join(ELEM_SEP));
  }

  // ----- Service Lines (Loop 2400) -----
  for (const line of claim.lines) {
    if (!/^\d{4}$/.test(line.revenueCode)) {
      throw new Error(`Service line ${line.lineNumber}: revenue code must be 4 digits.`);
    }
    segs.push(['LX', String(line.lineNumber)].join(ELEM_SEP));
    // SV2 — institutional service. SV201 = revenue code; SV202 =
    // composite "HC:CPT:mod1:mod2" when CPT applies; SV203 = charge;
    // SV204 = unit measure; SV205 = units.
    const sv202 = line.procedureCode
      ? `HC${SUB_SEP}${line.procedureCode}${line.modifiers.map((m) => SUB_SEP + m).join('')}`
      : '';
    const sv2 = [line.revenueCode, sv202, line.chargeAmount.toFixed(2), 'UN', String(line.units)];
    if (line.nonCoveredCharge !== undefined) {
      sv2.push(''); // SV206 not used
      sv2.push(line.nonCoveredCharge.toFixed(2));
    }
    segs.push(['SV2', ...sv2].join(ELEM_SEP));
    if (line.serviceDate) {
      segs.push(['DTP', '472', 'D8', line.serviceDate].join(ELEM_SEP));
    }
  }

  // SE
  const stIdx = segs.findIndex((s) => s.startsWith('ST' + ELEM_SEP));
  const seCount = segs.length - stIdx + 1;
  segs.push(['SE', String(seCount), ctl.transactionSetControlNumber].join(ELEM_SEP));

  segs.push(['GE', '1', ctl.groupControlNumber].join(ELEM_SEP));
  segs.push(['IEA', '1', pad(ctl.interchangeControlNumber, 9, '0', 'left')].join(ELEM_SEP));

  return segs.map((s) => s + SEG_TERM).join('\n') + '\n';
}
