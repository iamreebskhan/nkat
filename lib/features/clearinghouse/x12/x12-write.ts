/**
 * Writing X12 (005010): segments, the interchange and group envelopes, and
 * the cleaning every value needs before it goes in one (0120).
 *
 * Pure. The 837P, 270 and 276 builders hand this their transaction sets and
 * get one file back, so the envelope rules live in one place:
 *
 *   - Delimiters are the ones every clearinghouse Pallio connects to uses and
 *     asks senders not to put in text: * element, : component, ^ repetition,
 *     ~ segment (Availity Batch EDI Standard Companion Guide, 2023-04-14,
 *     p. 52). A value is cleaned so none of them can appear inside it.
 *   - Segments are joined with no line breaks. Availity: "There will be no
 *     line feed in X12 code" (p. 55); a file with them is rejected.
 *   - ISA is fixed width (106 characters with its terminator); IDs are padded
 *     to 15, the control number to 9.
 *   - Times are UTC. Availity asks for GS05 "HHMM (GMT/UTC Standard)" (p. 57),
 *     and one clock for ISA, GS and BHT keeps the file's dates consistent.
 *   - Trailing empty elements are dropped: "NM1*41*2*NAME*****46*ID", never
 *     a segment ending in "*".
 */

export const X12 = { element: "*", component: ":", repetition: "^", segment: "~" } as const;

/** One element: a plain value, or a composite given as its components. */
export type X12Value = string | number | null | undefined | (string | number | null | undefined)[];

/**
 * Text as an X12 element can carry it: no delimiter, no control character,
 * upper case, accents folded ("José" → "JOSE"), runs of spaces collapsed.
 * What the TR3 basic character set does not have becomes a space. Cut to
 * `max` when given, without leaving a trailing space.
 */
export function x12Text(value: string | null | undefined, max?: number): string {
  if (value == null) return "";
  const folded = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Typographic quotes and dashes, as names pasted from documents carry them.
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .toUpperCase()
    // The basic character set plus the extended characters every one of the
    // four accepts (@ # % _). The delimiters * : ^ ~ are not in it, so they
    // can never reach a segment from data.
    .replace(/[^A-Z0-9 !"&'()+,\-./;?=@#%_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return max === undefined ? folded : folded.slice(0, max).trimEnd();
}

/** An identifier: letters and digits only, upper case (member IDs, NPIs, payer IDs). */
export function x12Id(value: string | null | undefined, max?: number): string {
  const id = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return max === undefined ? id : id.slice(0, max);
}

/** Digits only (EINs, ZIP codes, phone numbers). */
export function x12Digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Money in X12's decimal form, from cents: no leading zeros and no trailing
 * zeros after the point ("125", "125.5", "125.55"), as the standard asks of
 * the R data type.
 */
export function x12Amount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`x12Amount: ${cents} is not a whole, non-negative number of cents.`);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** 2026-10-29 → 20261029. */
export function x12Date(isoDay: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) throw new Error(`x12Date: ${isoDay} is not a YYYY-MM-DD day.`);
  return isoDay.replace(/-/g, "");
}

/** The UTC date and time a file is stamped with, in the forms ISA, GS and BHT take. */
export function x12Clock(now: Date): { ccyymmdd: string; yymmdd: string; hhmm: string } {
  const iso = now.toISOString();
  const ccyymmdd = iso.slice(0, 10).replace(/-/g, "");
  return { ccyymmdd, yymmdd: ccyymmdd.slice(2), hhmm: iso.slice(11, 16).replace(":", "") };
}

function element(tag: string, v: X12Value): string {
  const one = (p: string | number | null | undefined): string => {
    const s = p == null ? "" : String(p);
    // Callers clean values with x12Text/x12Id first; a delimiter that still
    // arrives is a bug, and a file it reached would split in the wrong place.
    if (/[*:^~]/.test(s)) throw new Error(`X12 ${tag}: a value carries a delimiter.`);
    return s;
  };
  if (Array.isArray(v)) {
    const parts = v.map(one);
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts.join(X12.component);
  }
  return one(v);
}

/**
 * One segment, without its terminator. A composite is given as an array of
 * its components ("HC:99350:25" is ["HC", "99350", "25"]).
 */
export function seg(tag: string, ...elements: X12Value[]): string {
  const parts = elements.map((v) => element(tag, v));
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return [tag, ...parts].join(X12.element);
}

export interface InterchangeEnvelope {
  /** ISA05/ISA06: how the clearinghouse knows the practice (Availity: ZZ + customer ID). */
  senderQualifier: string;
  senderId: string;
  /** ISA07/ISA08: the clearinghouse (Availity: 01 + 030240928). */
  receiverQualifier: string;
  receiverId: string;
  /** GS02/GS03. */
  gsSenderCode: string;
  gsReceiverCode: string;
  /** ISA15: T while testing, P in production. */
  usage: "T" | "P";
  /** ISA13 and GS06: Pallio's sequences (0120), never reused. */
  interchangeControlNumber: number;
  groupControlNumber: number;
  /** GS01: HC claims, HS eligibility, HR claim status. */
  functionalId: "HC" | "HS" | "HR";
  /** GS08: 005010X222A1 (837P), 005010X279A1 (270), 005010X212 (276). */
  version: string;
  now: Date;
  /** ISA14: 1 asks for a TA1 back. Availity recommends 1 (p. 55). */
  ackRequested?: "0" | "1";
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

/** ISA … IEA around one functional group of transaction sets (each ST … SE). */
export function wrapInterchange(env: InterchangeEnvelope, transactionSets: string[][]): string {
  if (transactionSets.length === 0) throw new Error("wrapInterchange: no transaction sets.");
  const icn = env.interchangeControlNumber;
  const gcn = env.groupControlNumber;
  if (!Number.isInteger(icn) || icn < 1 || icn > 999_999_999) throw new Error("ISA13 must be 1-999999999.");
  if (!Number.isInteger(gcn) || gcn < 1 || gcn > 999_999_999) throw new Error("GS06 must be 1-999999999.");
  const senderId = x12Text(env.senderId, 15);
  const receiverId = x12Text(env.receiverId, 15);
  if (!senderId || !receiverId) throw new Error("The interchange needs a sender and a receiver ID.");
  const clock = x12Clock(env.now);
  const isaCn = String(icn).padStart(9, "0");
  const isa = [
    "ISA", "00", " ".repeat(10), "00", " ".repeat(10),
    pad(env.senderQualifier, 2), pad(senderId, 15),
    pad(env.receiverQualifier, 2), pad(receiverId, 15),
    clock.yymmdd, clock.hhmm, X12.repetition, "00501", isaCn,
    env.ackRequested ?? "1", env.usage, X12.component,
  ].join(X12.element);
  if (isa.length !== 105) throw new Error(`ISA is ${isa.length} characters; it must be 105 before its terminator.`);
  const segments = [
    isa,
    seg("GS", env.functionalId, x12Text(env.gsSenderCode, 15), x12Text(env.gsReceiverCode, 15),
      clock.ccyymmdd, clock.hhmm, String(gcn), "X", env.version),
    ...transactionSets.flat(),
    seg("GE", String(transactionSets.length), String(gcn)),
    seg("IEA", "1", isaCn),
  ];
  return segments.map((s) => s + X12.segment).join("");
}

/**
 * Close a transaction set: SE01 counts every segment from ST to SE, both
 * included. Takes the set from ST on and returns it with its SE.
 */
export function closeTransactionSet(segments: string[], controlNumber: string): string[] {
  if (!segments[0]?.startsWith(`ST${X12.element}`)) throw new Error("A transaction set starts with ST.");
  return [...segments, seg("SE", String(segments.length + 1), controlNumber)];
}

/** ST02: four digits at least, so 1 → "0001" (Availity numbers sets from 1, p. 53). */
export function transactionSetControlNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) throw new Error("ST02 must be 1-999999999.");
  return String(n).padStart(4, "0");
}
