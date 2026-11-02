/**
 * The two real-time questions (0120): eligibility (270, 005010X279A1) and
 * claim status (276, 005010X212), each one transaction set about one patient.
 *
 * Pure. The answers come back as a 271 and a 277 (x12-271.ts, x12-277.ts).
 * The patient is always the subscriber (Pallio records the patient's own
 * coverage), so neither carries a dependent loop.
 */
import { closeTransactionSet, seg, x12Amount, x12Date, x12Digits, x12Id, x12Text } from "./x12-write";

export interface Payer270 {
  name: string;
  /** NM109 in 2100A: this clearinghouse's ID for the payer. */
  id: string;
}

export interface Patient270 {
  lastName: string;
  firstName: string;
  memberId: string;
  /** YYYY-MM-DD. */
  dob: string;
  sex?: "F" | "M" | "U" | null;
}

/** BHT date and time, UTC as the envelope. */
function bht(now: Date): [string, string] {
  const iso = now.toISOString();
  return [iso.slice(0, 10).replace(/-/g, ""), iso.slice(11, 16).replace(":", "")];
}

/**
 * TRN03 in a 270: the originator, 10 characters — "1" and the EIN. A
 * practice with no EIN on file uses "9" and its NPI, which is also ten
 * characters with the 9 prefix taking the place the TR3 gives other IDs.
 */
export function traceOriginator(ein: string | null | undefined, npi: string): string {
  const e = x12Digits(ein);
  if (e.length === 9) return `1${e}`;
  return `9${x12Digits(npi).slice(0, 9)}`;
}

export function buildEligibility270(args: {
  controlNumber: string;
  reference: string;
  now: Date;
  payer: Payer270;
  provider: { name: string; npi: string };
  patient: Patient270;
  /** TRN02: Pallio's trace for this question; the 271 echoes it. */
  traceNumber: string;
  traceOriginator: string;
  /** EQ01: 30 (health benefit plan coverage) unless asked about one service. */
  serviceTypes: string[];
  /** The day coverage is asked about, YYYY-MM-DD. */
  asOf: string;
}): string[] {
  const [d, t] = bht(args.now);
  const s: string[] = [];
  s.push(seg("ST", "270", args.controlNumber, "005010X279A1"));
  s.push(seg("BHT", "0022", "13", x12Id(args.reference, 30), d, t));
  // 2000A / 2100A — the payer asked.
  s.push(seg("HL", "1", "", "20", "1"));
  s.push(seg("NM1", "PR", "2", x12Text(args.payer.name, 60), "", "", "", "", "PI", x12Id(args.payer.id, 80)));
  // 2000B / 2100B — who asks.
  s.push(seg("HL", "2", "1", "21", "1"));
  s.push(seg("NM1", "1P", "2", x12Text(args.provider.name, 60), "", "", "", "", "XX", x12Digits(args.provider.npi)));
  // 2000C / 2100C — the subscriber.
  s.push(seg("HL", "3", "2", "22", "0"));
  s.push(seg("TRN", "1", x12Id(args.traceNumber, 50), x12Id(args.traceOriginator, 10)));
  s.push(seg("NM1", "IL", "1", x12Text(args.patient.lastName, 60), x12Text(args.patient.firstName, 35), "", "", "", "MI", x12Id(args.patient.memberId, 80)));
  s.push(args.patient.sex ? seg("DMG", "D8", x12Date(args.patient.dob), args.patient.sex) : seg("DMG", "D8", x12Date(args.patient.dob)));
  s.push(seg("DTP", "291", "D8", x12Date(args.asOf)));
  const types = args.serviceTypes.length > 0 ? args.serviceTypes : ["30"];
  for (const st of types) s.push(seg("EQ", x12Id(st, 2)));
  return closeTransactionSet(s, args.controlNumber);
}

export function buildClaimStatus276(args: {
  controlNumber: string;
  reference: string;
  now: Date;
  payer: Payer270;
  /** 2100B: the information receiver, the submitter (ID qualifier 46). */
  submitter: { name: string; id: string };
  provider: { name: string; npi: string };
  patient: Patient270;
  claim: {
    /** TRN02: the trace the 277 answers by. */
    traceNumber: string;
    /** REF*EJ: the patient account number, which is the Claim ref (CLM01). */
    claimRef: string;
    /** REF*1K: the payer's number for the claim, when known. */
    payerClaimNumber?: string | null;
    totalChargeCents: number;
    /** YYYY-MM-DD. */
    dateOfService: string;
  };
}): string[] {
  const [d, t] = bht(args.now);
  const day = x12Date(args.claim.dateOfService);
  const s: string[] = [];
  s.push(seg("ST", "276", args.controlNumber, "005010X212"));
  s.push(seg("BHT", "0010", "13", x12Id(args.reference, 30), d, t));
  s.push(seg("HL", "1", "", "20", "1"));
  s.push(seg("NM1", "PR", "2", x12Text(args.payer.name, 60), "", "", "", "", "PI", x12Id(args.payer.id, 80)));
  s.push(seg("HL", "2", "1", "21", "1"));
  s.push(seg("NM1", "41", "2", x12Text(args.submitter.name, 60), "", "", "", "", "46", x12Text(args.submitter.id, 80)));
  s.push(seg("HL", "3", "2", "19", "1"));
  s.push(seg("NM1", "1P", "2", x12Text(args.provider.name, 60), "", "", "", "", "XX", x12Digits(args.provider.npi)));
  s.push(seg("HL", "4", "3", "22", "0"));
  s.push(args.patient.sex ? seg("DMG", "D8", x12Date(args.patient.dob), args.patient.sex) : seg("DMG", "D8", x12Date(args.patient.dob)));
  s.push(seg("NM1", "IL", "1", x12Text(args.patient.lastName, 60), x12Text(args.patient.firstName, 35), "", "", "", "MI", x12Id(args.patient.memberId, 80)));
  // 2200D — the claim asked about.
  s.push(seg("TRN", "1", x12Id(args.claim.traceNumber, 50)));
  if (args.claim.payerClaimNumber) s.push(seg("REF", "1K", x12Id(args.claim.payerClaimNumber, 50)));
  s.push(seg("REF", "EJ", x12Id(args.claim.claimRef, 50)));
  s.push(seg("AMT", "T3", x12Amount(args.claim.totalChargeCents)));
  s.push(seg("DTP", "472", "RD8", `${day}-${day}`));
  return closeTransactionSet(s, args.controlNumber);
}
