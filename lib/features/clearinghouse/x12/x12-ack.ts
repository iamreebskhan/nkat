/**
 * The acknowledgments of a file Pallio sent (0120): the TA1 (interchange) and
 * the 999 (each functional group and transaction set, 005010X231A1).
 *
 * Pure. What they answer by:
 *   - TA101 is the ISA13 of the file acknowledged (it may arrive alone, or at
 *     the top of the 999 when ISA14 asked for it — Availity's sample 999 has
 *     one, Batch EDI Standard Companion Guide 2023-04-14, p. 87);
 *   - AK102 is the GS06 of the group;
 *   - AK202 is the ST02 of the set: with one claim per set (x12-837p.ts), the
 *     claim.
 *
 * IK404 — the bad value itself — is never kept: it can be a member ID or a
 * name. An error is kept as the segment, its position, the loop and the
 * codes, which is what a person needs to find it on the bill.
 */
import { el, readX12, X12ReadError, type X12Document, type X12Segment } from "./x12-read";

export interface Ta1Result {
  /** TA101: the ISA13 acknowledged. */
  interchangeControlNumber: number | null;
  /** TA104: A accepted, E accepted with errors, R rejected. */
  status: "A" | "E" | "R" | string;
  /** TA105: what was wrong (000 = no error). */
  noteCode: string;
}

export interface AckElementError {
  /** IK401-1: the element's position in its segment. */
  position: string;
  /** IK402: the data element reference number. */
  reference: string;
  /** IK403: the error code. */
  code: string;
}

export interface AckSegmentError {
  /** IK301: the segment's tag, e.g. NM1. */
  segment: string;
  /** IK302: its position in the transaction set. */
  position: string;
  /** IK303: the loop it sits in, e.g. 2010BA. */
  loop: string;
  /** IK304: the segment-level error code. */
  code: string;
  /** CTX after it, when the sender's own key was quoted (e.g. "CLM01:REF"). */
  context: string[];
  elements: AckElementError[];
}

export interface AckTransactionSet {
  /** AK102 of the group it sits in. */
  groupControlNumber: number | null;
  /** AK201: 837, 270, 276. */
  type: string;
  /** AK202: the ST02 acknowledged. */
  controlNumber: string;
  /** IK501: A accepted, E accepted with errors, R/M/W/X rejected. */
  status: string;
  /** IK502-IK506. */
  codes: string[];
  errors: AckSegmentError[];
}

export interface AckGroup {
  /** AK101: HC, HS, HR. */
  functionalId: string;
  /** AK102: the GS06 acknowledged. */
  groupControlNumber: number | null;
  /** AK103: the version, e.g. 005010X222A1. */
  version: string;
  /** AK901: A, E, P (partially accepted), R. */
  status: string;
  /** AK902-AK904: sets included, received, accepted. */
  included: number | null;
  received: number | null;
  accepted: number | null;
  /** AK905-AK909: group-level error codes. */
  codes: string[];
}

export interface Ack999 {
  ta1: Ta1Result | null;
  groups: AckGroup[];
  sets: AckTransactionSet[];
}

const int = (v: string): number | null => {
  const n = Number(v.trim());
  return v.trim() !== "" && Number.isInteger(n) ? n : null;
};

function ta1Of(s: X12Segment): Ta1Result {
  return { interchangeControlNumber: int(el(s, 1)), status: el(s, 4), noteCode: el(s, 5) };
}

/** A TA1 file, or the TA1 riding on a 999. */
export function parseTa1(doc: X12Document): Ta1Result | null {
  const s = doc.segments.find((x) => x.tag === "TA1");
  return s ? ta1Of(s) : null;
}

export function parse999(input: string | X12Document): Ack999 {
  const doc = typeof input === "string" ? readX12(input) : input;
  if (!doc.transactionTypes.includes("999")) throw new X12ReadError("This is not a 999 acknowledgment.");
  const out: Ack999 = { ta1: parseTa1(doc), groups: [], sets: [] };
  let group: AckGroup | null = null;
  let set: AckTransactionSet | null = null;
  let segErr: AckSegmentError | null = null;
  for (const s of doc.segments) {
    switch (s.tag) {
      case "AK1":
        group = {
          functionalId: el(s, 1),
          groupControlNumber: int(el(s, 2)),
          version: el(s, 3),
          status: "",
          included: null,
          received: null,
          accepted: null,
          codes: [],
        };
        out.groups.push(group);
        set = null;
        segErr = null;
        break;
      case "AK2":
        set = {
          groupControlNumber: group?.groupControlNumber ?? null,
          type: el(s, 1),
          controlNumber: el(s, 2),
          status: "",
          codes: [],
          errors: [],
        };
        out.sets.push(set);
        segErr = null;
        break;
      case "IK3":
        if (!set) break;
        segErr = { segment: el(s, 1), position: el(s, 2), loop: el(s, 3), code: el(s, 4), context: [], elements: [] };
        set.errors.push(segErr);
        break;
      case "CTX":
        // Context for the segment error before it: the sender's key, never data.
        if (segErr) segErr.context.push(el(s, 1).split(doc.delimiters.component).slice(0, 2).join(":"));
        break;
      case "IK4":
        if (!segErr) break;
        segErr.elements.push({
          position: el(s, 1).split(doc.delimiters.component)[0] ?? "",
          reference: el(s, 2),
          code: el(s, 3),
          // IK404, the bad value, is deliberately not read.
        });
        break;
      case "IK5":
        if (!set) break;
        set.status = el(s, 1);
        set.codes = [2, 3, 4, 5, 6].map((n) => el(s, n)).filter(Boolean);
        set = null;
        segErr = null;
        break;
      case "AK9":
        if (!group) break;
        group.status = el(s, 1);
        group.included = int(el(s, 2));
        group.received = int(el(s, 3));
        group.accepted = int(el(s, 4));
        group.codes = [5, 6, 7, 8, 9].map((n) => el(s, n)).filter(Boolean);
        group = null;
        break;
    }
  }
  return out;
}

/** What a 999 says about one transaction set, as Pallio records it. */
export function setAckState(status: string): "accepted" | "accepted_with_errors" | "rejected" {
  if (status === "A") return "accepted";
  if (status === "E") return "accepted_with_errors";
  return "rejected";
}

/** What a 999 says about a whole group. */
export function groupAckState(status: string): "accepted" | "accepted_with_errors" | "partially_accepted" | "rejected" {
  if (status === "A") return "accepted";
  if (status === "E") return "accepted_with_errors";
  if (status === "P") return "partially_accepted";
  return "rejected";
}
