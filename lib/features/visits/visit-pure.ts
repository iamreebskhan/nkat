/**
 * Visit pure helpers — time math and status-transition rules.
 *
 * No DB, no env, no fetch. Lifted into its own module so unit tests
 * never need a fixture or container.
 */
import type { VisitStatus, VisitType, VisitTypeHint } from "./visit.types";

/**
 * Compute total minutes from start/stop. Rounds DOWN to whole minutes
 * so a 29:59 visit is 29 minutes (not 30) — Mark's clinicians document
 * to the literal stop time.
 *
 * Returns null when either timestamp is missing or stop precedes start.
 */
export function computeTotalMinutes(
  startTime: Date | null | undefined,
  stopTime: Date | null | undefined,
): number | null {
  if (!startTime || !stopTime) return null;
  const ms = stopTime.getTime() - startTime.getTime();
  if (ms < 0) return null;
  return Math.floor(ms / 60_000);
}

/** Allowed status transitions. Anything else throws. */
const TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  scheduled: ["in_progress", "cancelled", "no_show"],
  in_progress: ["documented", "cancelled"],
  documented: ["pending_billing"],
  pending_billing: ["billed"],
  billed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: VisitStatus, to: VisitStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Is this visit's note actually blank?
 *
 * `document_text` holds a TipTap ProseMirror document serialised to JSON, and
 * an untouched editor still serialises to a doc — `{"type":"doc","content":[]}`
 * from the document page's own fallback, or a doc holding one empty paragraph
 * once the editor has been focused. A `!documentText` check therefore reads all
 * three of those as "documented", which is how 207 visits in the local database
 * came to be attested with nothing in them.
 *
 * Legacy rows hold plain text rather than JSON (see parseDoc on the document
 * page); those count as documented when they carry any non-whitespace.
 *
 * Deliberately conservative about what counts as content: any text node with a
 * non-whitespace character, or any leaf that is not a text/paragraph container
 * (an image, a table, a horizontal rule), makes the note non-empty. A clinician
 * who pastes only an image has still documented something; that is a clinical
 * quality question, not a "did they write anything" question.
 */
export function noteIsEmpty(documentText: string | null | undefined): boolean {
  if (documentText == null) return true;
  const raw = documentText.trim();
  if (raw === "") return true;

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // Not JSON — legacy plain text. Non-blank text is real documentation.
    return false;
  }
  return !hasContent(doc);
}

/** Depth-first walk for the first sign of real content in a ProseMirror node. */
function hasContent(node: unknown): boolean {
  if (node == null) return false;
  if (Array.isArray(node)) return node.some(hasContent);
  if (typeof node !== "object") return false;

  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof n.text === "string" && n.text.trim() !== "") return true;

  // A leaf that carries meaning without text — image, table, rule, hard break
  // is excluded because an editor emits one for a stray Enter.
  if (
    typeof n.type === "string" &&
    !["doc", "paragraph", "text", "hardBreak", "hard_break"].includes(n.type) &&
    !Array.isArray(n.content)
  ) {
    return true;
  }
  return Array.isArray(n.content) && n.content.some(hasContent);
}

export function nextStatuses(from: VisitStatus): VisitStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Medicare 11-day billing window per §5.2: 3 days before DOS + DOS + 7
 * days after = 11 days. Returns true if `today` is inside the window.
 *
 * Used by the FE to render a "submit before X" hint on documented
 * visits + by the billing dashboard alert system.
 */
export function isInsideMedicareWindow(
  dos: Date,
  today: Date = new Date(),
): boolean {
  const dosMid = startOfDay(dos);
  const todayMid = startOfDay(today);
  const dayMs = 86_400_000;
  const days = (todayMid.getTime() - dosMid.getTime()) / dayMs;
  return days >= -3 && days <= 7;
}

/**
 * Days remaining in the 11-day Medicare billing window. Returns 0 when
 * outside the window (caller should warn).
 */
export function daysRemainingInMedicareWindow(
  dos: Date,
  today: Date = new Date(),
): number {
  const dosMid = startOfDay(dos);
  const todayMid = startOfDay(today);
  const dayMs = 86_400_000;
  const days = (todayMid.getTime() - dosMid.getTime()) / dayMs;
  if (days < -3 || days > 7) return 0;
  return Math.max(0, 7 - Math.floor(days));
}

function startOfDay(d: Date): Date {
  // UTC-anchored — `setHours()` would use the runtime's local timezone,
  // which makes the day-count math drift across CI and dev machines.
  // Tests + production both interpret the Medicare window in UTC.
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * A date's calendar day in the viewer's own time zone, as YYYY-MM-DD.
 *
 * toISOString().slice(0, 10) is the UTC day. For an Ohio nurse that is
 * already tomorrow after 8 pm (7 pm in winter), so the printed route sheet
 * defaulted to the wrong day and filed an evening visit under the next one.
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Where Pallio's own history disagrees with the band a visit type bills on:
 *
 *   'looks_new'          an established type, and no visit in the window
 *   'looks_established'  a new-patient type after a visit in the window
 *
 * null when they agree, when there is no hint, and for every band the
 * new-vs-established question does not apply to (ACP, not billed, inpatient).
 * Advisory only: the practice may have seen the patient before it used Pallio,
 * so the screens say it and never pick or block a type on it. Shared by the
 * scheduler's composer and the document screen's Visit type card.
 */
export function visitTypeHistoryWarning(
  codingBasis: VisitType,
  hint: VisitTypeHint | null,
): "looks_new" | "looks_established" | null {
  if (!hint) return null;
  if (codingBasis === "established_patient_home" && hint.lastVisitAt === null) return "looks_new";
  if (codingBasis === "new_patient_home" && hint.lastVisitAt !== null) return "looks_established";
  return null;
}
