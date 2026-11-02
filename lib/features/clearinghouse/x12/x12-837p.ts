/**
 * The 837P (005010X222A1): one professional claim as one transaction set
 * (0120).
 *
 * One claim per ST/SE, on purpose. A 999 accepts or rejects whole transaction
 * sets, so with one claim in each, a syntax error on one patient's claim
 * rejects that claim alone and the 999 says which (AK2 names the ST02), where
 * a batch in one set would come back rejected entire. The TR3 allows any
 * number of sets in a group, and Availity numbers them from 1 (Batch EDI
 * Standard Companion Guide, 2023-04-14, p. 53).
 *
 * Loops written, in TR3 order: 1000A submitter (with its contact, PER needs at
 * least one number), 1000B receiver, 2000A/2010AA billing provider (street
 * address, nine-digit ZIP, EIN), 2010AB pay-to when payment goes elsewhere,
 * 2000B/2010BA subscriber = the patient (SBR02 18: Pallio records the
 * patient's own coverage), 2010BB payer, 2300 claim (with REF*G1 when a prior
 * authorization covers it, 0124, and REF*F8 when it replaces a claim the
 * payer processed), 2310A referring provider when the
 * practice puts one on its claims (0123), 2310B rendering provider, 2400 lines
 * (each with its date of service and a line control number the 835 can echo).
 *
 * Pure; input is already checked (claim-837.ts lists what stops a claim).
 * What could still be wrong in it is a bug, and throws.
 */
import { closeTransactionSet, seg, x12Amount, x12Date, x12Digits, x12Id, x12Text } from "./x12-write";

export interface X12Address {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface Submitter837 {
  /** 1000A NM109: the ID the clearinghouse gave the practice. */
  id: string;
  name: string;
  contactName: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** 1000B: the clearinghouse (or payer) receiving the file. */
  receiverName: string;
  receiverId: string;
}

export interface ClaimLine837 {
  code: string;
  modifiers: string[];
  units: number;
  chargeCents: number;
  /** 1-based pointers into the claim's diagnoses, at most four. */
  diagnosisPointers: number[];
}

export interface Claim837 {
  /** CLM01: the Claim ref every answer echoes. */
  claimRef: string;
  /** CLM05-3: 1 original, 7 replacement, 8 void. */
  frequency: "1" | "7" | "8";
  /** REF*F8: the payer's number for the claim a 7 or 8 replaces. */
  originalClaimNumber?: string | null;
  /** REF*G1: the prior authorization that covers this claim (0124). */
  priorAuthNumber?: string | null;
  placeOfService: string;
  /** YYYY-MM-DD. */
  dateOfService: string;
  diagnoses: string[];
  lines: ClaimLine837[];
  billing: {
    name: string;
    npi: string;
    ein: string;
    taxonomy?: string | null;
    address: X12Address;
    payTo?: X12Address | null;
  };
  /** The referring physician (box 17), when the practice puts one on its claims (0123). */
  referring?: { lastName: string; firstName: string; npi: string } | null;
  /** The rendering clinician; left out when the billing NPI is the rendering one. */
  rendering?: { lastName: string; firstName: string; npi: string; taxonomy?: string | null } | null;
  subscriber: {
    lastName: string;
    firstName: string;
    memberId: string;
    /** YYYY-MM-DD. */
    dob: string;
    sex: "F" | "M" | "U";
    address: X12Address;
    groupNumber?: string | null;
  };
  payer: {
    name: string;
    /** 2010BB NM109: the payer ID this clearinghouse uses. */
    id: string;
    /** SBR09: MB, MC, CI, 16 … */
    filingIndicator: string;
  };
}

function address(a: X12Address, zipDigits: 5 | 9 | "5or9"): string[] {
  const zip = x12Digits(a.zip);
  const ok = zipDigits === "5or9" ? zip.length === 5 || zip.length === 9 : zip.length === zipDigits;
  if (!ok) throw new Error(`837P: ZIP ${zip.length} digits where ${zipDigits === "5or9" ? "5 or 9" : zipDigits} are required.`);
  const line2 = x12Text(a.line2 ?? "", 55);
  return [
    line2 ? seg("N3", x12Text(a.line1, 55), line2) : seg("N3", x12Text(a.line1, 55)),
    seg("N4", x12Text(a.city, 30), x12Id(a.state, 2), zip),
  ];
}

/** ICD-10-CM as the HI segment carries it: no decimal point. */
export function icdForX12(code: string): string {
  return x12Id(code);
}

/**
 * The claim as one ST … SE transaction set, ready for wrapInterchange.
 * `reference` is BHT03, the file's own reference for this set.
 */
export function buildClaim837P(args: {
  controlNumber: string;
  reference: string;
  now: Date;
  submitter: Submitter837;
  claim: Claim837;
}): string[] {
  const { submitter, claim } = args;
  if (claim.lines.length === 0) throw new Error("837P: a claim needs at least one service line.");
  if (claim.lines.length > 50) throw new Error("837P: a professional claim carries at most 50 service lines.");
  if (claim.diagnoses.length === 0 || claim.diagnoses.length > 12) {
    throw new Error("837P: a claim carries 1 to 12 diagnoses.");
  }
  if (!/^[0-9A-Z]{1,38}$/.test(claim.claimRef)) throw new Error("837P: CLM01 must be 1-38 letters or digits.");
  if ((claim.frequency === "7" || claim.frequency === "8") && !claim.originalClaimNumber) {
    throw new Error("837P: a replacement or void names the payer's claim number it replaces.");
  }
  const day = x12Date(claim.dateOfService);
  const iso = args.now.toISOString();
  const bhtDate = iso.slice(0, 10).replace(/-/g, "");
  const bhtTime = iso.slice(11, 16).replace(":", "");

  const s: string[] = [];
  s.push(seg("ST", "837", args.controlNumber, "005010X222A1"));
  s.push(seg("BHT", "0019", "00", x12Id(args.reference, 30), bhtDate, bhtTime, "CH"));

  // 1000A — submitter.
  s.push(seg("NM1", "41", "2", x12Text(submitter.name, 60), "", "", "", "", "46", x12Text(submitter.id, 80)));
  const phone = x12Digits(submitter.contactPhone);
  const email = x12Text(submitter.contactEmail ?? "", 256);
  if (!phone && !email) throw new Error("837P: the submitter contact needs a phone number or an email.");
  s.push(
    phone && email
      ? seg("PER", "IC", x12Text(submitter.contactName, 60), "TE", phone, "EM", email)
      : phone
        ? seg("PER", "IC", x12Text(submitter.contactName, 60), "TE", phone)
        : seg("PER", "IC", x12Text(submitter.contactName, 60), "EM", email),
  );
  // 1000B — receiver.
  s.push(seg("NM1", "40", "2", x12Text(submitter.receiverName, 60), "", "", "", "", "46", x12Text(submitter.receiverId, 80)));

  // 2000A / 2010AA — billing provider.
  s.push(seg("HL", "1", "", "20", "1"));
  if (claim.billing.taxonomy) s.push(seg("PRV", "BI", "PXC", x12Id(claim.billing.taxonomy, 10)));
  s.push(seg("NM1", "85", "2", x12Text(claim.billing.name, 60), "", "", "", "", "XX", x12Digits(claim.billing.npi)));
  // The billing provider's ZIP has all nine digits (TR3 2010AA N403).
  s.push(...address(claim.billing.address, 9));
  s.push(seg("REF", "EI", x12Digits(claim.billing.ein)));
  // 2010AB — pay-to, only when payment goes somewhere other than the billing address.
  if (claim.billing.payTo) {
    s.push(seg("NM1", "87", "2"));
    s.push(...address(claim.billing.payTo, "5or9"));
  }

  // 2000B / 2010BA — the subscriber, who is the patient.
  s.push(seg("HL", "2", "1", "22", "0"));
  s.push(seg("SBR", "P", "18", x12Text(claim.subscriber.groupNumber ?? "", 50), "", "", "", "", "", x12Id(claim.payer.filingIndicator, 2)));
  s.push(seg("NM1", "IL", "1", x12Text(claim.subscriber.lastName, 60), x12Text(claim.subscriber.firstName, 35), "", "", "", "MI", x12Id(claim.subscriber.memberId, 80)));
  s.push(...address(claim.subscriber.address, "5or9"));
  s.push(seg("DMG", "D8", x12Date(claim.subscriber.dob), claim.subscriber.sex));
  // 2010BB — payer.
  s.push(seg("NM1", "PR", "2", x12Text(claim.payer.name, 60), "", "", "", "", "PI", x12Id(claim.payer.id, 80)));

  // 2300 — the claim. CLM02 is the sum of the lines, to the cent.
  const total = claim.lines.reduce((sum, l) => sum + l.chargeCents, 0);
  s.push(
    seg("CLM", claim.claimRef, x12Amount(total), "", "", [x12Id(claim.placeOfService, 2), "B", claim.frequency], "Y", "A", "Y", "Y"),
  );
  // G1 before F8, the TR3's order in 2300. Both are the payer's own numbers and
  // go as it issued them: x12Id would drop a hyphen and name a different one.
  if (claim.priorAuthNumber) s.push(seg("REF", "G1", x12Text(claim.priorAuthNumber, 50)));
  if (claim.frequency !== "1") s.push(seg("REF", "F8", x12Text(claim.originalClaimNumber, 50)));
  s.push(
    seg("HI", ...claim.diagnoses.map((dx, i) => [i === 0 ? "ABK" : "ABF", icdForX12(dx)])),
  );
  // 2310A — referring provider, a person. Before 2310B in the TR3's order.
  if (claim.referring) {
    s.push(seg("NM1", "DN", "1", x12Text(claim.referring.lastName, 60), x12Text(claim.referring.firstName, 35), "", "", "", "XX", x12Digits(claim.referring.npi)));
  }
  // 2310B — rendering provider, a person.
  if (claim.rendering) {
    s.push(seg("NM1", "82", "1", x12Text(claim.rendering.lastName, 60), x12Text(claim.rendering.firstName, 35), "", "", "", "XX", x12Digits(claim.rendering.npi)));
    if (claim.rendering.taxonomy) s.push(seg("PRV", "PE", "PXC", x12Id(claim.rendering.taxonomy, 10)));
  }

  // 2400 — service lines.
  claim.lines.forEach((l, i) => {
    if (!/^[A-Z0-9]{5}$/.test(l.code)) throw new Error(`837P: ${l.code} is not a CPT/HCPCS code.`);
    if (l.modifiers.length > 4 || l.modifiers.some((m) => !/^[A-Z0-9]{2}$/.test(m))) {
      throw new Error(`837P: line ${i + 1} modifiers must be up to four two-character codes.`);
    }
    if (!Number.isInteger(l.units) || l.units < 1) throw new Error(`837P: line ${i + 1} units must be a whole number above 0.`);
    const ptrs = l.diagnosisPointers.filter((p) => p >= 1 && p <= claim.diagnoses.length).slice(0, 4);
    if (ptrs.length === 0) throw new Error(`837P: line ${i + 1} points at no diagnosis.`);
    s.push(seg("LX", String(i + 1)));
    s.push(seg("SV1", ["HC", l.code, ...l.modifiers], x12Amount(l.chargeCents), "UN", String(l.units), "", "", ptrs.map(String)));
    s.push(seg("DTP", "472", "D8", day));
    // A line control number the payer echoes on the 835 (REF*6R), so a
    // payment can be tied to its line and not only to its code.
    s.push(seg("REF", "6R", `${claim.claimRef}L${i + 1}`));
  });

  return closeTransactionSet(s, args.controlNumber);
}
