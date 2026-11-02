/**
 * Reading X12 (005010): the delimiters a file declares in its ISA, its
 * segments, and which transaction it is (0120).
 *
 * Pure. Every response parser here (999, TA1, 277CA, 277, 271) starts from
 * readX12, so the tolerance a real file needs is written once:
 *
 *   - the delimiters are the file's own, read from the fixed-width ISA
 *     (element at position 4, repetition at 83, component at 105, terminator
 *     at 106), never assumed;
 *   - line breaks after terminators, a byte-order mark and leading blank
 *     lines are ignored (vendors wrap files for reading);
 *   - a missing trailing element is an empty string, so el(n) never throws.
 *
 * The 835 keeps its own parser (remittances/era835-parser.ts, ported verbatim
 * from the legacy backend); this one is for the files that answer an 837P,
 * 270 or 276.
 */

export interface X12Delimiters {
  element: string;
  component: string;
  repetition: string;
  segment: string;
}

export interface X12Segment {
  tag: string;
  /** Elements 1…n as the TR3 numbers them: elements[1] is NM101. elements[0] is the tag. */
  elements: string[];
}

export interface X12Interchange {
  senderQualifier: string;
  senderId: string;
  receiverQualifier: string;
  receiverId: string;
  /** ISA13 as a number (the file's own interchange control number). */
  controlNumber: number | null;
  usage: string;
}

export interface X12Document {
  delimiters: X12Delimiters;
  interchange: X12Interchange;
  segments: X12Segment[];
  /** ST01 of each transaction set in order: "999", "277", "271", "835" … */
  transactionTypes: string[];
  /** GS08 of the first functional group: 005010X214 (277CA) vs 005010X212 (277). */
  version: string | null;
}

export class X12ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X12ReadError";
  }
}

/** Element n (1-based), "" when absent. */
export function el(s: X12Segment, n: number): string {
  return s.elements[n] ?? "";
}

/** Component m (1-based) of element n, "" when absent. */
export function comp(doc: X12Document, s: X12Segment, n: number, m: number): string {
  return el(s, n).split(doc.delimiters.component)[m - 1] ?? "";
}

/** Every repetition of element n. */
export function reps(doc: X12Document, s: X12Segment, n: number): string[] {
  const v = el(s, n);
  return v === "" ? [] : v.split(doc.delimiters.repetition);
}

export function readX12(text: string): X12Document {
  const start = text.indexOf("ISA");
  if (start < 0) throw new X12ReadError("This is not an X12 file: it has no ISA segment.");
  const body = text.slice(start);
  const elementSep = body[3] ?? "";
  if (elementSep === "" || /[A-Za-z0-9\s]/.test(elementSep)) {
    throw new X12ReadError("The ISA segment does not declare its delimiters where X12 puts them.");
  }
  // ISA16 (the component separator) is the one character after the 16th
  // element separator, and the segment terminator follows it. Counted rather
  // than read at fixed positions 104/105, so an ISA a sender failed to pad to
  // its fixed width still reads.
  let at = -1;
  for (let i = 0, seen = 0; i < Math.min(body.length, 200); i++) {
    if (body[i] === elementSep && ++seen === 16) {
      at = i;
      break;
    }
  }
  if (at < 0 || body.length < at + 3) throw new X12ReadError("The ISA segment is cut short.");
  const isaElements = body.slice(0, at).split(elementSep);
  // ISA11 is the repetition separator in 5010; some senders still write the
  // 4010 "U" there (Availity's own sample 999 does). A letter is not a
  // separator, so it means none was declared and the usual caret applies.
  const isa11 = (isaElements[11] ?? "").trim();
  const delimiters: X12Delimiters = {
    element: elementSep,
    repetition: isa11.length === 1 && !/[A-Za-z0-9]/.test(isa11) ? isa11 : "^",
    component: body[at + 1]!,
    segment: body[at + 2]!,
  };
  if (/[A-Za-z0-9 ]/.test(delimiters.segment) || delimiters.segment === delimiters.element) {
    throw new X12ReadError("The ISA segment does not declare a segment terminator X12 allows.");
  }
  const segments: X12Segment[] = [];
  for (const raw of body.split(delimiters.segment)) {
    const s = raw.replace(/^[\r\n\s]+|[\r\n]+$/g, "");
    if (s === "") continue;
    const elements = s.split(delimiters.element);
    segments.push({ tag: (elements[0] ?? "").trim(), elements });
  }
  const isa = segments[0]!;
  const icn = Number(el(isa, 13).trim());
  const interchange: X12Interchange = {
    senderQualifier: el(isa, 5).trim(),
    senderId: el(isa, 6).trim(),
    receiverQualifier: el(isa, 7).trim(),
    receiverId: el(isa, 8).trim(),
    controlNumber: Number.isInteger(icn) ? icn : null,
    usage: el(isa, 15).trim(),
  };
  const gs = segments.find((s) => s.tag === "GS");
  return {
    delimiters,
    interchange,
    segments,
    transactionTypes: segments.filter((s) => s.tag === "ST").map((s) => el(s, 1)),
    version: gs ? el(gs, 8) || null : null,
  };
}

/** An X12 date (CCYYMMDD, or a CCYYMMDD-CCYYMMDD range: its start) as YYYY-MM-DD. */
export function isoDay(value: string): string | null {
  const d = value.split("-")[0] ?? "";
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** The end of a CCYYMMDD-CCYYMMDD range, as YYYY-MM-DD; the day itself for a single date. */
export function isoDayEnd(value: string): string | null {
  const parts = value.split("-");
  return isoDay(parts[1] ?? parts[0] ?? "");
}

/** An X12 amount as cents, or null. */
export function cents(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
