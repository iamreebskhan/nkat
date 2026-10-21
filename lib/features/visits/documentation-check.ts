/**
 * Payer documentation requirements, checked against the note (audit R19).
 *
 * Pallio held per-payer, per-code charting standards and, since 0088, a
 * structured note with individually addressable sections, and compared
 * neither with the other. A UnitedHealthcare Community Plan Ohio claim for
 * 99349 could be signed and submitted with no chief complaint, and nothing
 * said a word: not to the clinician while the note could still be fixed, not
 * in the biller's risk score, not at submit.
 *
 * The standard is the payer's own, stored as an element list in the global
 * documentation_requirement table. This file is pure: the service next door
 * gathers the facts about one visit, and this decides which elements the
 * record shows.
 *
 * An element Pallio cannot see is never passed. A section-backed element
 * whose section the org's note template does not carry, or an element name
 * this file does not know, is reported as unverifiable. A check that
 * silently passes what it cannot read is the failure it exists to prevent.
 */
import { ValidationError } from "@/lib/api";

import type { PacketFinding } from "./audit-packet.service";

/** Every element a documentation_requirement row may name. */
export type ChartElement =
  | "vitals"
  | "chief_complaint"
  | "hpi"
  | "physical_exam"
  | "plan"
  | "diagnosis"
  | "telehealth_modality"
  | "time";

interface ElementSpec {
  /** In the payer's words, which is how the finding reads to a biller. */
  label: string;
  /** The note section that documents it, when a section does. */
  section?: string;
}

export const CHART_ELEMENTS: Record<ChartElement, ElementSpec> = {
  // Judged by the readings in visit_vitals, never by a section row: a vitals
  // section's content lives there, so its own row is always empty.
  vitals: { label: "Vital signs" },
  chief_complaint: { label: "Chief complaint", section: "chief_complaint" },
  hpi: { label: "History of present illness", section: "hpi" },
  physical_exam: { label: "Physical assessment", section: "physical_exam" },
  plan: { label: "Treatment plan", section: "assessment_and_plan" },
  diagnosis: { label: "Diagnosis" },
  // Only on a telehealth visit: the payer requires the note to state the
  // visit was done through audio-video, so an audio-only visit cannot meet it.
  telehealth_modality: { label: "Audio-video telehealth statement" },
  time: { label: "Time spent" },
};

export interface DocumentationFacts {
  /** Section keys with content on this visit. */
  filledSections: readonly string[];
  /** Section keys the visit's note template carries at all. */
  templateSections: readonly string[];
  hasVitals: boolean;
  dxCount: number;
  isTelehealth: boolean;
  telehealthModality: string | null;
  totalMinutes: number | null;
  /**
   * The note was written before 0088 in the single free-text box and has no
   * section rows. Pallio cannot see which elements it covers, so what the
   * record does not otherwise show is unverifiable, not missing: it must
   * neither pass nor block.
   */
  legacyNote?: boolean;
}

export interface DocumentationRequirement {
  code: string;
  elements: readonly string[];
}

export interface ElementRef {
  element: string;
  label: string;
}

export interface CodeDocumentation {
  code: string;
  /** What the payer asks for on this visit; telehealth-only elements drop off in person. */
  required: ElementRef[];
  missing: ElementRef[];
  unverifiable: ElementRef[];
}

function isKnown(e: string): e is ChartElement {
  return Object.prototype.hasOwnProperty.call(CHART_ELEMENTS, e);
}

export function elementLabel(element: string): string {
  return isKnown(element) ? CHART_ELEMENTS[element].label : element.replace(/_/g, " ");
}

const ref = (element: string): ElementRef => ({ element, label: elementLabel(element) });

/** Is one element documented? `null` means the record cannot say. */
function documented(element: string, f: DocumentationFacts): boolean | null {
  if (!isKnown(element)) return null;
  const { section } = CHART_ELEMENTS[element];
  if (section) {
    if (!f.templateSections.includes(section)) return null;
    if (f.filledSections.includes(section)) return true;
    // A legacy free-text note may well say it; Pallio cannot tell.
    return f.legacyNote ? null : false;
  }
  switch (element) {
    case "vitals":
      return f.hasVitals ? true : f.legacyNote ? null : false;
    case "diagnosis":
      return f.dxCount > 0 ? true : f.legacyNote ? null : false;
    case "telehealth_modality":
      return !f.isTelehealth || f.telehealthModality === "audio_video";
    case "time":
      return f.totalMinutes != null;
    default:
      return null;
  }
}

/**
 * Check each code's requirements against one visit. Several rows for one code
 * (a payer-specific row and an all-payer row, say) are combined.
 */
export function checkDocumentation(
  reqs: readonly DocumentationRequirement[],
  facts: DocumentationFacts,
): CodeDocumentation[] {
  const byCode = new Map<string, string[]>();
  for (const r of reqs) {
    const code = r.code.toUpperCase();
    const cur = byCode.get(code) ?? [];
    for (const e of r.elements) if (!cur.includes(e)) cur.push(e);
    byCode.set(code, cur);
  }
  return [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, elements]) => {
      const applies = elements.filter((e) => e !== "telehealth_modality" || facts.isTelehealth);
      const missing: ElementRef[] = [];
      const unverifiable: ElementRef[] = [];
      for (const e of applies) {
        const d = documented(e, facts);
        if (d === null) unverifiable.push(ref(e));
        else if (!d) missing.push(ref(e));
      }
      return { code, required: applies.map(ref), missing, unverifiable };
    });
}

/** The distinct elements across several codes, in first-seen order. */
function union(refs: readonly ElementRef[]): ElementRef[] {
  const seen = new Set<string>();
  const out: ElementRef[] = [];
  for (const r of refs) {
    if (seen.has(r.element)) continue;
    seen.add(r.element);
    out.push(r);
  }
  return out;
}

const labels = (refs: readonly ElementRef[]) => refs.map((r) => r.label).join(", ");

/**
 * The reconciliation's statement about payer documentation. Before signing a
 * gap is unfinished work, so it reads as attention; on a signed note it is a
 * discrepancy an auditor would raise.
 */
export function documentationFindings(
  results: readonly CodeDocumentation[],
  payerName: string | null,
  opts: { signed: boolean },
): PacketFinding[] {
  if (results.length === 0) return [];
  const payer = payerName ?? "The payer";
  const out: PacketFinding[] = [];

  const short = results.filter((r) => r.missing.length > 0);
  if (short.length > 0) {
    out.push({
      severity: opts.signed ? "mismatch" : "attention",
      label: "Payer documentation",
      detail:
        `${payer} requires, for ${short.map((r) => r.code).join(", ")}: ` +
        `${labels(union(short.flatMap((r) => r.required)))}. ` +
        `${opts.signed ? "Not documented in the signed note" : "Not documented yet"}: ` +
        `${labels(union(short.flatMap((r) => r.missing)))}.`,
    });
  }

  const unseen = results.filter((r) => r.unverifiable.length > 0);
  if (unseen.length > 0) {
    out.push({
      severity: "attention",
      label: "Payer documentation",
      detail:
        `${payer} also requires ${labels(union(unseen.flatMap((r) => r.unverifiable)))} ` +
        `for ${unseen.map((r) => r.code).join(", ")}. Pallio cannot check that from this note ` +
        "(the template does not record it, or the note predates structured sections) — confirm it by hand.",
    });
  }

  if (short.length === 0 && unseen.length === 0) {
    out.push({
      severity: "match",
      label: "Payer documentation",
      detail:
        `${payer}'s required elements for ${results.map((r) => r.code).join(", ")} are documented: ` +
        `${labels(union(results.flatMap((r) => r.required)))}.`,
    });
  }
  return out;
}

/** What stops a claim going out: the payer, the codes, and what the note lacks. */
export interface DocumentationGap {
  payerName: string | null;
  codes: string[];
  missing: ElementRef[];
}

export function documentationGap(
  results: readonly CodeDocumentation[],
  payerName: string | null,
): DocumentationGap | null {
  const short = results.filter((r) => r.missing.length > 0);
  if (short.length === 0) return null;
  return {
    payerName,
    codes: short.map((r) => r.code),
    missing: union(short.flatMap((r) => r.missing)),
  };
}

export function documentationGapMessage(g: DocumentationGap): string {
  return (
    `${g.payerName ?? "The payer"} requires ${labels(g.missing)} in the note for ${g.codes.join(", ")}, ` +
    `and the signed note does not document ${g.missing.length === 1 ? "it" : "them"}. ` +
    "If it is recorded elsewhere in the record (an addendum, say), submit with a reason saying where; " +
    "the reason is kept on the claim history."
  );
}

/**
 * Submitting a claim the payer's documentation standard says the note does
 * not support. A ValidationError, so every route already answers it at 422;
 * `gap` lets a screen offer the override without matching on wording.
 */
export class DocumentationIncompleteError extends ValidationError {
  readonly gap: DocumentationGap;
  constructor(gap: DocumentationGap) {
    super(documentationGapMessage(gap));
    this.name = "DocumentationIncompleteError";
    this.gap = gap;
  }
}
