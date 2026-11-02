/**
 * What a file from a clearinghouse is (0120), from its content first and its
 * name second. Pure.
 *
 * X12 files say what they are in their ST01 and GS08: a 999, a TA1 alone, a
 * 277CA (005010X214) or a 277 (005010X212), a 271, an 835. Everything else is
 * a vendor's own: Availity's notification files ("…-success", "…-FAILED" in
 * SendFiles), its pipe-delimited and text reports (.ACK .ACT .IBR .IBT .EBR
 * .EBT .DPR .DPT), Batch EDI Standard Companion Guide 2023-04-14, pp. 66-76.
 */
import { readX12, X12ReadError } from "./x12-read";

export type ClearinghouseFileKind =
  | "999"
  | "ta1"
  | "277ca"
  | "277"
  | "271"
  | "835"
  | "notification"
  | "vendor_report"
  | "unknown";

export interface Classified {
  kind: ClearinghouseFileKind;
  /** Why it could not be read, for an unknown file. */
  note?: string;
}

const VENDOR_REPORT = /\.(ack|act|ibr|ibrp|ibt|ibtp|ebr|ebt|dpr|dpt|tat|99t|278ebr|txt\.rpt|rpt)$/i;

export function classifyClearinghouseFile(name: string, text: string): Classified {
  const head = text.replace(/^﻿/, "").trimStart();
  if (head.startsWith("PK")) {
    return { kind: "unknown", note: "A compressed (zip) file. Set the clearinghouse to deliver files uncompressed." };
  }
  if (head.startsWith("ISA")) {
    try {
      const doc = readX12(head);
      const types = doc.transactionTypes;
      if (types.includes("999")) return { kind: "999" };
      if (types.includes("277")) return { kind: (doc.version ?? "").startsWith("005010X214") ? "277ca" : "277" };
      if (types.includes("271")) return { kind: "271" };
      if (types.includes("835")) return { kind: "835" };
      if (types.length === 0 && doc.segments.some((s) => s.tag === "TA1")) return { kind: "ta1" };
      return { kind: "unknown", note: `An X12 file of a kind Pallio does not read here (${types.join(", ") || "no transaction set"}).` };
    } catch (err) {
      return { kind: "unknown", note: err instanceof X12ReadError ? err.message : "The X12 could not be read." };
    }
  }
  if (/-(success|failed)$/i.test(name)) return { kind: "notification" };
  if (VENDOR_REPORT.test(name)) return { kind: "vendor_report" };
  return { kind: "unknown", note: "Not an X12 file, and not a report Pallio recognises." };
}
