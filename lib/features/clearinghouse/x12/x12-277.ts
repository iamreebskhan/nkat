/**
 * Claim acknowledgments and claim status (0120): the 277CA (005010X214),
 * sent back for every claim a clearinghouse or payer front end received, and
 * the 277 (005010X212), the answer to a 276 or an unsolicited status.
 *
 * Pure. Both share one shape: an HL tree down to the claim, then for the claim
 *   TRN*2*<patient control number>  — the CLM01 Pallio sent, its Claim ref
 *   STC …                          — one or more statuses
 *   REF*1K / REF*D9 / REF*EJ       — the payer's and the clearinghouse's numbers
 *   DTP*472                        — the service dates
 * and SVC lines under it. The HL levels above the claim (the clearinghouse,
 * the receiver, the provider) can carry statuses of their own (a batch's
 * acceptance); those are kept apart from the claims.
 *
 * Names and member IDs from NM1*QC/IL are not kept. The claim is found by its
 * patient control number, and that is a Claim ref, not PHI.
 */
import { cents, el, isoDay, isoDayEnd, readX12, X12ReadError, type X12Document, type X12Segment } from "./x12-read";

export interface ClaimStatus277 {
  /** STC01-1: A1, A2, A3, A7 … for a 277CA; F1, F2, P1, R3 … for a 277. */
  category: string;
  /** STC01-2: the claim status code. */
  code: string;
  /** STC01-3: the entity the status is about (40 receiver, PR payer, 41 submitter …). */
  entity: string;
  /** STC02. */
  effectiveDate: string | null;
  /** STC03: WQ accepted, U rejected (277CA). */
  action: string;
  /** STC04: the claim's charge as the sender understood it. */
  chargeCents: number | null;
  /** STC05 (277): what the payer paid. */
  paidCents: number | null;
  /** STC06 (277): adjudication or finalized date. */
  adjudicatedDate: string | null;
  /** STC08/STC09 (277): payment date and check or EFT number. */
  paymentDate: string | null;
  checkNumber: string;
  /** STC12: the free-text message. */
  message: string;
}

export interface Claim277 {
  /** TRN02 at claim level: the CLM01 sent (the Claim ref). */
  patientControlNumber: string;
  /** REF*1K. */
  payerClaimNumber: string | null;
  /** REF*D9 (277CA) or the clearinghouse trace. */
  clearinghouseTrace: string | null;
  /** REF*EJ, when the payer echoes the patient account number there. */
  patientAccountNumber: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  statuses: ClaimStatus277[];
  /** Line-level statuses: SVC code and its STCs. */
  lines: { code: string; statuses: ClaimStatus277[] }[];
}

export interface Doc277 {
  kind: "277ca" | "277";
  /**
   * Who is speaking (2100A, the information source): the clearinghouse (NM1*AY,
   * Availity's own 277CA, its IBR) or the payer (NM1*PR); null if neither. An
   * acceptance by the clearinghouse is not yet the payer's.
   */
  source: "clearinghouse" | "payer" | null;
  claims: Claim277[];
  /** Statuses above claim level (2200B/2200C): the batch as a whole. */
  batchStatuses: ClaimStatus277[];
}

function stc(doc: X12Document, s: X12Segment): ClaimStatus277[] {
  const one = (composite: string) => {
    const [category = "", code = "", entity = ""] = composite.split(doc.delimiters.component);
    return { category, code, entity };
  };
  const base = {
    effectiveDate: isoDay(el(s, 2)),
    action: el(s, 3),
    chargeCents: cents(el(s, 4)),
    paidCents: cents(el(s, 5)),
    adjudicatedDate: isoDay(el(s, 6)),
    paymentDate: isoDay(el(s, 8)),
    checkNumber: el(s, 9),
    message: el(s, 12).replace(/\s+/g, " ").trim(),
  };
  // STC01, then STC10 and STC11: up to three statuses on one segment.
  return [el(s, 1), el(s, 10), el(s, 11)]
    .filter((c) => c.trim() !== "")
    .map((c) => ({ ...one(c), ...base }));
}

export function parse277(input: string | X12Document): Doc277 {
  const doc = typeof input === "string" ? readX12(input) : input;
  if (!doc.transactionTypes.includes("277")) throw new X12ReadError("This is not a 277 claim acknowledgment or status.");
  const kind = (doc.version ?? "").startsWith("005010X214") ? "277ca" : "277";
  const out: Doc277 = { kind, source: null, claims: [], batchStatuses: [] };
  // The HL level the reader is in: claims sit under PT (277CA), 22 or 23 (277).
  let level = "";
  let claim: Claim277 | null = null;
  let line: Claim277["lines"][number] | null = null;
  for (const s of doc.segments) {
    switch (s.tag) {
      case "HL":
        level = el(s, 3);
        claim = null;
        line = null;
        break;
      case "NM1":
        if (level === "20" && !out.source) out.source = el(s, 1) === "AY" ? "clearinghouse" : el(s, 1) === "PR" ? "payer" : null;
        break;
      case "TRN": {
        const atClaim = level === "PT" || level === "22" || level === "23";
        if (atClaim && el(s, 1) === "2") {
          claim = {
            patientControlNumber: el(s, 2),
            payerClaimNumber: null,
            clearinghouseTrace: null,
            patientAccountNumber: null,
            serviceFrom: null,
            serviceTo: null,
            statuses: [],
            lines: [],
          };
          out.claims.push(claim);
          line = null;
        }
        break;
      }
      case "STC":
        if (line) line.statuses.push(...stc(doc, s));
        else if (claim) claim.statuses.push(...stc(doc, s));
        else out.batchStatuses.push(...stc(doc, s));
        break;
      case "REF":
        if (!claim || line) break;
        if (el(s, 1) === "1K") claim.payerClaimNumber = el(s, 2) || null;
        else if (el(s, 1) === "D9") claim.clearinghouseTrace = el(s, 2) || null;
        else if (el(s, 1) === "EJ") claim.patientAccountNumber = el(s, 2) || null;
        break;
      case "DTP":
        if (claim && !line && el(s, 1) === "472") {
          claim.serviceFrom = isoDay(el(s, 3));
          claim.serviceTo = isoDayEnd(el(s, 3));
        }
        break;
      case "SVC":
        if (!claim) break;
        line = { code: el(s, 1).split(doc.delimiters.component)[1] ?? "", statuses: [] };
        claim.lines.push(line);
        break;
      case "SE":
        claim = null;
        line = null;
        level = "";
        break;
    }
  }
  return out;
}

/**
 * A rejection of the claim itself: STC03 says it outright on a 277CA (U, not
 * WQ); otherwise A3 (returned as unprocessable), A6 (missing information),
 * A7 (invalid information), A8 (relational field in error).
 *
 * NOT rejections: A4 and D0 (the payer cannot find the claim) and E0-E4 (the
 * question could not be answered). Those say nothing about the claim's own
 * state, and treating them as rejections would send an accepted claim back
 * for correction because a status inquiry failed.
 */
export function isRejection(st: ClaimStatus277): boolean {
  if (st.action === "U") return true;
  if (st.action === "WQ") return false;
  return ["A3", "A6", "A7", "A8"].includes(st.category);
}

export type ClaimState277 = "accepted" | "rejected" | "pending" | "finalized";

/**
 * The claim's state from its statuses, worst first: any rejection rejects it;
 * a finalized status (F*) finalizes it; acceptance (A0 forwarded, A1
 * received, A2 accepted into adjudication, A5 split) accepts it; P* and R*
 * (pending, information requested) are pending. null when the statuses say
 * nothing about the claim (A4, D0, E*): the caller keeps what it knew.
 */
export function claimState277(statuses: ClaimStatus277[]): ClaimState277 | null {
  if (statuses.some(isRejection)) return "rejected";
  if (statuses.some((st) => st.category.startsWith("F"))) return "finalized";
  if (statuses.some((st) => ["A0", "A1", "A2", "A5"].includes(st.category))) return "accepted";
  if (statuses.some((st) => st.category.startsWith("P") || st.category.startsWith("R"))) return "pending";
  return null;
}
