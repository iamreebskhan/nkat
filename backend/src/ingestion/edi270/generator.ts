/**
 * X12 270 — Eligibility, Coverage or Benefit Inquiry (v5010A1).
 *
 * Pure generator. Takes a typed request shape and produces the
 * EDI string the clearinghouse expects. We hand-roll segments rather
 * than depend on a library because:
 *
 *   - We only ship a tiny subset of 270 (single subscriber, no
 *     dependents, single service-type query at a time) and want to
 *     own every byte that crosses the boundary.
 *   - Test surface is straightforward: input shape → expected segments.
 *
 * Output format:
 *   ISA*…~ GS*…~ ST*…~ BHT*…~ HL*…~ NM1*…~ … SE*…~ GE*…~ IEA*…~
 *
 * Segment terminator `~`, element separator `*`, sub-element separator `:`.
 * Per X12, segments are NOT followed by a newline by default; we
 * emit one anyway because clearinghouses tolerate it and humans need
 * to read the file.
 */

export interface Edi270Identity {
  /** Sender ID — typically your assigned trading partner ID. */
  senderId: string;
  /** Receiver ID — the clearinghouse / payer identifier. */
  receiverId: string;
  /** Production / Test indicator. */
  usage: 'P' | 'T';
}

export interface Edi270Information {
  /** Payer name + payer ID. */
  payerName: string;
  payerIdQualifier: 'PI' | 'XV'; // PI = Payer ID; XV = HCFA Plan ID
  payerId: string;
  /** Provider organization name + NPI. */
  providerName: string;
  providerNpi: string;
  /** Subscriber demographics. */
  subscriberFirstName: string;
  subscriberLastName: string;
  subscriberMemberId: string;
  /** YYYYMMDD. */
  subscriberDob: string;
  /** "M" / "F" / "U". */
  subscriberGender: 'M' | 'F' | 'U';
  /** Service-type code(s) — 30 = Health Benefit Plan; MH = Mental Health, etc. */
  serviceTypeCodes: string[];
  /** YYYYMMDD — date(s) of service to inquire about. */
  serviceDate: string;
  /**
   * Optional dependent. When supplied, the inquiry is for the
   * dependent rather than the subscriber — the 270 envelope adds an
   * extra HL=4 + NM1*03 + DMG segment under the subscriber.
   */
  dependent?: {
    firstName: string;
    lastName: string;
    /** YYYYMMDD. */
    dob: string;
    gender: 'M' | 'F' | 'U';
    /** INS01 / INS02 — relationship qualifier. 01 = Spouse, 19 = Child, etc. */
    relationship: '01' | '19' | '34' | 'G8';
  };
}

export interface Edi270Control {
  /** ISA13 — interchange control number, 9 digits. Caller assigns + tracks. */
  interchangeControlNumber: string;
  /** GS06 — group control number. Caller assigns. */
  groupControlNumber: string;
  /** ST02 — transaction set control number. Caller assigns. */
  transactionSetControlNumber: string;
  /** BHT03 — caller's reference id (free text up to 50). */
  referenceId: string;
  /** Override clock for tests. ISO timestamp. */
  nowIso?: string;
}

const SEG_TERM = '~';
const ELEM_SEP = '*';
const SUB_SEP = ':';

export function generate270(
  identity: Edi270Identity,
  info: Edi270Information,
  ctl: Edi270Control,
): string {
  const now = ctl.nowIso ? new Date(ctl.nowIso) : new Date();
  const yyyymmdd = formatDate(now);
  const yymmdd = yyyymmdd.slice(2);
  const hhmm = formatTime(now);

  const segs: string[] = [];

  // ISA — 16 fields, fixed-width-ish.
  segs.push(
    [
      'ISA',
      '00', '          ',                                  // 01,02 auth info
      '00', '          ',                                  // 03,04 security
      'ZZ', pad(identity.senderId, 15),                    // 05,06
      'ZZ', pad(identity.receiverId, 15),                  // 07,08
      yymmdd, hhmm,                                        // 09,10
      '^',                                                 // 11 repetition sep
      '00501',                                             // 12 version
      pad(ctl.interchangeControlNumber, 9, '0', 'left'),   // 13
      '0',                                                 // 14 ack requested
      identity.usage,                                      // 15 P/T
      SUB_SEP,                                             // 16 sub-element sep
    ].join(ELEM_SEP),
  );

  // GS — functional group header. Functional ID for 270 = HS.
  segs.push(
    [
      'GS', 'HS', identity.senderId, identity.receiverId,
      yyyymmdd, hhmm, ctl.groupControlNumber, 'X', '005010X279A1',
    ].join(ELEM_SEP),
  );

  // ST — transaction set header. 270 uses 005010X279A1.
  segs.push(['ST', '270', ctl.transactionSetControlNumber, '005010X279A1'].join(ELEM_SEP));

  // BHT — beginning of hierarchical transaction. 0022 = Information Source.
  segs.push(
    ['BHT', '0022', '13', ctl.referenceId, yyyymmdd, hhmm].join(ELEM_SEP),
  );

  // ----- Information Source (Payer) — HL=1 -----
  segs.push(['HL', '1', '', '20', '1'].join(ELEM_SEP));
  segs.push(
    ['NM1', 'PR', '2', info.payerName, '', '', '', '', info.payerIdQualifier, info.payerId].join(
      ELEM_SEP,
    ),
  );

  // ----- Information Receiver (Provider) — HL=2 parent=1 -----
  segs.push(['HL', '2', '1', '21', '1'].join(ELEM_SEP));
  segs.push(
    ['NM1', '1P', '2', info.providerName, '', '', '', '', 'XX', info.providerNpi].join(ELEM_SEP),
  );

  // ----- Subscriber — HL=3 parent=2. Has-children flag depends on dependent. -----
  const subHasChildren = info.dependent ? '1' : '0';
  segs.push(['HL', '3', '2', '22', subHasChildren].join(ELEM_SEP));
  segs.push(
    ['NM1', 'IL', '1', info.subscriberLastName, info.subscriberFirstName, '', '', '', 'MI', info.subscriberMemberId].join(
      ELEM_SEP,
    ),
  );
  segs.push(['DMG', 'D8', info.subscriberDob, info.subscriberGender].join(ELEM_SEP));

  if (info.dependent) {
    // Dependent — HL=4, parent=3, type=23. Also: INS segment marking
    // them as "not subscriber" (Y for INS01 = is-the-subscriber-the-insured).
    segs.push(['HL', '4', '3', '23', '0'].join(ELEM_SEP));
    segs.push(['INS', 'N', info.dependent.relationship].join(ELEM_SEP));
    segs.push(
      ['NM1', '03', '1', info.dependent.lastName, info.dependent.firstName].join(ELEM_SEP),
    );
    segs.push(['DMG', 'D8', info.dependent.dob, info.dependent.gender].join(ELEM_SEP));
    segs.push(['DTP', '291', 'D8', info.serviceDate].join(ELEM_SEP));
  } else {
    segs.push(['DTP', '291', 'D8', info.serviceDate].join(ELEM_SEP));
  }

  // EQ — eligibility-or-benefit inquiry. One segment per service type.
  for (const st of info.serviceTypeCodes) {
    segs.push(['EQ', st].join(ELEM_SEP));
  }

  // SE — transaction set trailer. Count = number of segments from ST through SE inclusive.
  // ST is index N (after ISA, GS); count from there.
  const stIdx = segs.findIndex((s) => s.startsWith('ST' + ELEM_SEP));
  const seCount = segs.length - stIdx + 1;
  segs.push(['SE', String(seCount), ctl.transactionSetControlNumber].join(ELEM_SEP));

  // GE — functional group trailer.
  segs.push(['GE', '1', ctl.groupControlNumber].join(ELEM_SEP));

  // IEA — interchange control trailer.
  segs.push(['IEA', '1', pad(ctl.interchangeControlNumber, 9, '0', 'left')].join(ELEM_SEP));

  return segs.map((s) => s + SEG_TERM).join('\n') + '\n';
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function formatTime(d: Date): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

export function pad(
  s: string,
  len: number,
  fill = ' ',
  side: 'left' | 'right' = 'right',
): string {
  if (s.length >= len) return s.slice(0, len);
  const f = fill.repeat(len - s.length);
  return side === 'left' ? f + s : s + f;
}
