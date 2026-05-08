/**
 * X12 837P — Health Care Claim: Professional (v5010A1).
 *
 * Subset of the 837P companion guide we need: single submitter,
 * single billing provider, single subscriber, multiple service lines.
 * Captures the segments that 95% of customers' claim-generation
 * needs require — adequate for our pre-flight + co-sell partner
 * integrations. NOT a replacement for a full clearinghouse-grade
 * 837 generator (we don't reach the institutional setting nor the
 * complex coordination of benefits chains).
 */

export interface Edi837Identity {
  senderId: string;
  receiverId: string;
  usage: 'P' | 'T';
}

export interface Edi837Provider {
  organizationName: string;
  npi: string;
  taxId: string;          // EIN — used in REF segment with EI qualifier
  taxIdQualifier: 'EI' | 'SY'; // EI = Employer ID, SY = SSN
  taxonomy?: string;      // Optional — REF segment with PXC qualifier
}

export interface Edi837Subscriber {
  memberId: string;
  firstName: string;
  lastName: string;
  dob: string;            // YYYYMMDD
  gender: 'M' | 'F' | 'U';
  address1: string;
  city: string;
  state: string;          // 2-letter
  zip: string;
}

export interface Edi837Payer {
  name: string;
  payerId: string;
  payerIdQualifier: 'PI' | 'XV';
}

export interface Edi837ServiceLine {
  /** Line counter (1-based). */
  lineNumber: number;
  /** CPT/HCPCS. */
  procedureCode: string;
  /** Modifiers. */
  modifiers: string[];
  /** Diagnosis pointers (1-based indices into the claim's HI segment). */
  diagnosisPointers: number[];
  /** Charge amount in dollars (will be sent with 2 decimals). */
  chargeAmount: number;
  /** Unit count (typically minutes, days, or visits). */
  units: number;
  /** Service date YYYYMMDD. */
  serviceDate: string;
  /** Place-of-service code. */
  placeOfService: string;
}

export interface Edi837Claim {
  /** Caller-assigned patient/claim control number (CLM01). */
  patientControlNumber: string;
  /** Total billed amount (sum of line charges; emitted as CLM02). */
  totalCharge: number;
  /** Diagnoses, ICD-10. First is principal. Up to 12 supported. */
  diagnoses: string[];
  /** Service lines. */
  lines: Edi837ServiceLine[];
  /**
   * Optional Coordination of Benefits chain — Loop 2320/2330 in 837P.
   * Only one secondary at present; clearinghouses accept this for
   * the common dual-coverage case (Medicare primary + commercial
   * secondary, MA-with-COB, etc.).
   */
  secondaryPayer?: {
    payer: Edi837Payer;
    payerResponsibility: 'S' | 'T'; // S = Secondary, T = Tertiary
    /** Subscriber relationship to patient on the OTHER policy. */
    relationship: '01' | '18' | '19' | 'G8';
    /** Other-payer member id. */
    otherSubscriberMemberId: string;
    otherSubscriberFirstName: string;
    otherSubscriberLastName: string;
    /** Already-paid amount from the other policy (AMT*D). */
    paidAmount: number;
  };
}

export interface Edi837Control {
  interchangeControlNumber: string;
  groupControlNumber: string;
  transactionSetControlNumber: string;
  /** BHT03 — caller-assigned reference. */
  referenceId: string;
  nowIso?: string;
}

import { formatDate, formatTime, pad } from '../edi270/generator';

const SEG_TERM = '~';
const ELEM_SEP = '*';
const SUB_SEP = ':';

export function generate837P(
  identity: Edi837Identity,
  provider: Edi837Provider,
  subscriber: Edi837Subscriber,
  payer: Edi837Payer,
  claim: Edi837Claim,
  ctl: Edi837Control,
): string {
  if (claim.lines.length === 0) {
    throw new Error('837P claim must have at least one service line.');
  }
  if (claim.diagnoses.length === 0) {
    throw new Error('837P claim must have at least one diagnosis.');
  }
  if (claim.diagnoses.length > 12) {
    throw new Error('837P claim cannot exceed 12 diagnoses (HI segment limit).');
  }

  const now = ctl.nowIso ? new Date(ctl.nowIso) : new Date();
  const yyyymmdd = formatDate(now);
  const yymmdd = yyyymmdd.slice(2);
  const hhmm = formatTime(now);

  const segs: string[] = [];

  // ISA — 16 elements, fixed widths.
  segs.push(
    [
      'ISA',
      '00', '          ',
      '00', '          ',
      'ZZ', pad(identity.senderId, 15),
      'ZZ', pad(identity.receiverId, 15),
      yymmdd, hhmm,
      '^',
      '00501',
      pad(ctl.interchangeControlNumber, 9, '0', 'left'),
      '0',
      identity.usage,
      SUB_SEP,
    ].join(ELEM_SEP),
  );

  // GS — functional group header. 837 functional ID = HC.
  segs.push(
    ['GS', 'HC', identity.senderId, identity.receiverId, yyyymmdd, hhmm,
     ctl.groupControlNumber, 'X', '005010X222A1'].join(ELEM_SEP),
  );

  // ST — transaction set.
  segs.push(['ST', '837', ctl.transactionSetControlNumber, '005010X222A1'].join(ELEM_SEP));

  // BHT — beginning of hierarchical transaction. 0019 = Information Source.
  segs.push(
    ['BHT', '0019', '00', ctl.referenceId, yyyymmdd, hhmm, 'CH'].join(ELEM_SEP),
  );

  // ----- Submitter (Loop 1000A) -----
  segs.push(
    ['NM1', '41', '2', provider.organizationName, '', '', '', '', '46', identity.senderId].join(ELEM_SEP),
  );
  segs.push(['PER', 'IC', provider.organizationName].join(ELEM_SEP));

  // ----- Receiver (Loop 1000B) -----
  segs.push(
    ['NM1', '40', '2', payer.name, '', '', '', '', '46', identity.receiverId].join(ELEM_SEP),
  );

  // ----- Billing Provider HL=1 -----
  segs.push(['HL', '1', '', '20', '1'].join(ELEM_SEP));
  segs.push(['PRV', 'BI', 'PXC', provider.taxonomy ?? '193200000X'].join(ELEM_SEP));
  segs.push(
    ['NM1', '85', '2', provider.organizationName, '', '', '', '', 'XX', provider.npi].join(ELEM_SEP),
  );
  segs.push(['REF', provider.taxIdQualifier, provider.taxId].join(ELEM_SEP));

  // ----- Subscriber HL=2, parent=1 -----
  segs.push(['HL', '2', '1', '22', '0'].join(ELEM_SEP));
  segs.push(['SBR', 'P', '18', '', '', '', '', '', 'CI'].join(ELEM_SEP));
  segs.push(
    ['NM1', 'IL', '1', subscriber.lastName, subscriber.firstName, '', '', '', 'MI', subscriber.memberId].join(ELEM_SEP),
  );
  segs.push(['N3', subscriber.address1].join(ELEM_SEP));
  segs.push(['N4', subscriber.city, subscriber.state, subscriber.zip].join(ELEM_SEP));
  segs.push(['DMG', 'D8', subscriber.dob, subscriber.gender].join(ELEM_SEP));

  // Payer Name (Loop 2010BB)
  segs.push(
    ['NM1', 'PR', '2', payer.name, '', '', '', '', payer.payerIdQualifier, payer.payerId].join(ELEM_SEP),
  );

  // ----- Claim (CLM segment) -----
  segs.push(
    [
      'CLM', claim.patientControlNumber, claim.totalCharge.toFixed(2), '', '',
      `${claim.lines[0].placeOfService}${SUB_SEP}B${SUB_SEP}1`,  // 11:B:1 facility code:freq:claim freq
      'Y', 'A', 'Y', 'I',
    ].join(ELEM_SEP),
  );

  // HI — health care diagnosis codes. ABK = principal ICD-10, ABF = additional.
  const hi = claim.diagnoses.map((dx, i) => {
    const qual = i === 0 ? 'ABK' : 'ABF';
    return `${qual}${SUB_SEP}${dx.replace('.', '')}`;
  });
  segs.push(['HI', ...hi].join(ELEM_SEP));

  // ----- Other Subscriber (Loop 2320/2330) — COB chain -----
  if (claim.secondaryPayer) {
    const sp = claim.secondaryPayer;
    // SBR — second occurrence inside the claim. Filing indicator 'CI' = commercial.
    segs.push(['SBR', sp.payerResponsibility, sp.relationship, '', '', '', '', '', 'CI'].join(ELEM_SEP));
    // AMT*D — payer-paid amount.
    segs.push(['AMT', 'D', sp.paidAmount.toFixed(2)].join(ELEM_SEP));
    // OI — Other Insurance Coverage Information.
    segs.push(['OI', '', '', 'Y', '', '', 'Y'].join(ELEM_SEP));
    // Other-subscriber identity.
    segs.push(
      [
        'NM1', 'IL', '1', sp.otherSubscriberLastName, sp.otherSubscriberFirstName,
        '', '', '', 'MI', sp.otherSubscriberMemberId,
      ].join(ELEM_SEP),
    );
    // Other-payer identity.
    segs.push(
      [
        'NM1', 'PR', '2', sp.payer.name, '', '', '', '',
        sp.payer.payerIdQualifier, sp.payer.payerId,
      ].join(ELEM_SEP),
    );
  }

  // ----- Service Lines (Loop 2400) -----
  for (const line of claim.lines) {
    segs.push(['LX', String(line.lineNumber)].join(ELEM_SEP));
    const sv1 = [
      `HC${SUB_SEP}${line.procedureCode}${line.modifiers.map((m) => SUB_SEP + m).join('')}`,
      line.chargeAmount.toFixed(2),
      'UN',
      String(line.units),
      line.placeOfService,
      '',
      line.diagnosisPointers.join(SUB_SEP),
    ];
    segs.push(['SV1', ...sv1].join(ELEM_SEP));
    segs.push(['DTP', '472', 'D8', line.serviceDate].join(ELEM_SEP));
  }

  // SE
  const stIdx = segs.findIndex((s) => s.startsWith('ST' + ELEM_SEP));
  const seCount = segs.length - stIdx + 1;
  segs.push(['SE', String(seCount), ctl.transactionSetControlNumber].join(ELEM_SEP));

  segs.push(['GE', '1', ctl.groupControlNumber].join(ELEM_SEP));
  segs.push(['IEA', '1', pad(ctl.interchangeControlNumber, 9, '0', 'left')].join(ELEM_SEP));

  return segs.map((s) => s + SEG_TERM).join('\n') + '\n';
}
