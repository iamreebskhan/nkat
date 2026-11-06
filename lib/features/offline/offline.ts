/**
 * Offline (Level-1 doc:33; Mark [v1 16:05-16:53]: with a patient at home and
 * "no internet and no cell phone service", clinicians need "access to the
 * patient's chart and make changes in the chart and to create their
 * documentation", and the app must be "as transparent as they can of the fact
 * that they're offline"). Mark Q8 default: read the chart and draft offline;
 * sign on reconnect.
 *
 * The device keeps a copy of the clinician's caseload and their coming visits
 * (OfflineSnapshot), and the note sections and vitals written with no signal
 * (OfflineDraft). A draft goes to the server through the same note and vitals
 * routes as one written online, with the same checks, and only onto the
 * version it was written against: a section someone changed since, or a note
 * signed since, keeps the draft for the clinician to settle by hand.
 *
 * Pure and client-safe: the types, the text ↔ note conversion, and the rule
 * for when a draft may be sent.
 */
import type { NoteSectionKind } from "@/lib/features/visits/note-template";

/** A copy older than this is not shown: save a new one while online. */
export const OFFLINE_MAX_AGE_HOURS = 72;

/** The clinician's coming visits taken: from yesterday to a week ahead. */
export const OFFLINE_VISIT_DAYS = { back: 1, ahead: 7 } as const;

export interface OfflinePatient {
  id: string;
  name: string;
  dateOfBirth: string | null;
  sex: string | null;
  race?: string | null;
  ethnicity?: string | null;
  preferredLanguage?: string | null;
  phone: string | null;
  address: string | null;
  acuity: string | null;
  primaryDiagnosis: string | null;
  referralReason: string | null;
  payerName: string | null;
  careTeam: { role: string; name: string }[];
  contacts: { name: string; relationship: string | null; phone: string | null; roles: string[] }[];
  problems: { code: string; description: string }[];
  medications: string[];
  allergies: { substance: string; reaction: string | null; severity: string | null }[];
  noKnownAllergies: boolean;
  carePlan: {
    goals: string[];
    symptoms: string[];
    interventions: string[];
    monitoring: string[];
    escalation: string[];
    reviewOn: string | null;
  } | null;
  /** The last visits made, newest first, with their assessment and plan. */
  recentVisits: { day: string; type: string; clinician: string | null; assessmentAndPlan: string }[];
}

export interface OfflineSection {
  sectionKey: string;
  label: string;
  helpText: string | null;
  kind: NoteSectionKind;
  isRequired: boolean;
  /** Prose as paragraphs, a list one item a line: what the device edits. */
  text: string;
  /** The server's copy this was taken from: a draft is sent only onto it. */
  updatedAt: string | null;
}

export interface OfflineVitals {
  values: Partial<Record<VitalsKey, number | null>> & { notes?: string | null };
  /** When the visit's vitals were last recorded; null when never. */
  recordedAt: string | null;
}

export interface OfflineVisit {
  id: string;
  patientId: string;
  patientName: string;
  type: string;
  /** "2026-10-29 09:00 EDT", the practice's clock. */
  when: string;
  status: string;
  sections: OfflineSection[];
  vitals: OfflineVitals | null;
}

export interface OfflineSnapshot {
  version: 1;
  generatedAt: string;
  /**
   * The practice's zone, so the page can say when the copy was saved on the
   * practice's clock while offline. Copies saved before 7 Nov 2026 have none.
   */
  timeZone?: string;
  orgId: string;
  user: { id: string; name: string };
  practiceToday: string;
  patients: OfflinePatient[];
  visits: OfflineVisit[];
}

/** The vitals a clinician records at the bedside, as the vitals route takes them. */
export const OFFLINE_VITALS_KEYS = [
  "bpSystolic", "bpDiastolic", "heartRate", "respRate", "temperatureC", "spo2Percent",
  "weightKg", "heightCm", "ppsPercent", "painScore", "dyspneaScore", "nauseaScore",
] as const;
export type VitalsKey = (typeof OFFLINE_VITALS_KEYS)[number];

/** A section or the vitals, written on the device and not yet sent. */
export interface OfflineDraft {
  /** `${visitId}:${sectionKey}`, or `${visitId}:vitals`. */
  id: string;
  visitId: string;
  patientName: string;
  visitWhen: string;
  sectionKey: string;
  label: string;
  kind: NoteSectionKind;
  /** Prose and lists: the text as typed. */
  text?: string;
  /** Vitals: every value, as the route takes them. */
  vitals?: OfflineVitals["values"];
  /** The server's version it was written against. */
  baseUpdatedAt: string | null;
  savedAt: string;
  /** Why it could not be sent, when it could not: kept for the clinician. */
  problem?: string;
}

export const draftId = (visitId: string, sectionKey: string) => `${visitId}:${sectionKey}`;

// ---------------------------------------------------------------------------
// Text ↔ note
// ---------------------------------------------------------------------------

type ProseNode = { type?: string; text?: string; content?: ProseNode[] };

/** A prose section's text: a line a paragraph, list items as lines. */
export function proseText(doc: unknown): string {
  const lines: string[] = [];
  let cur = "";
  const walk = (n: unknown): void => {
    if (n == null || typeof n !== "object") return;
    if (Array.isArray(n)) return void n.forEach(walk);
    const node = n as ProseNode;
    if (typeof node.text === "string") cur += node.text;
    if (node.type === "hardBreak" || node.type === "hard_break") {
      lines.push(cur);
      cur = "";
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (node.type === "paragraph" || node.type === "heading") {
      lines.push(cur);
      cur = "";
    }
  };
  walk(doc);
  if (cur) lines.push(cur);
  // Trailing blank lines are the editor's, not the clinician's.
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Text typed on the device, as the note stores prose: a paragraph a line. */
export function textToProse(text: string): { type: "doc"; content: ProseNode[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return {
    type: "doc",
    content: lines.map((l) => (l.trim() === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: l }] })),
  };
}

export const listText = (content: unknown): string => {
  const items = (content as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.filter((i): i is string => typeof i === "string").join("\n") : "";
};

export const textToList = (text: string): { items: string[] } => ({
  items: text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean),
});

/** What a draft sends as the section's content. */
export function draftContent(d: Pick<OfflineDraft, "kind" | "text">): unknown {
  return d.kind === "list" ? textToList(d.text ?? "") : textToProse(d.text ?? "");
}

// ---------------------------------------------------------------------------
// When a draft may go
// ---------------------------------------------------------------------------

export type DraftPlan =
  | { send: true }
  | { send: false; problem: string };

/**
 * Whether a draft may be written to the visit as the server has it now. Only
 * onto the version it was written against: a newer version means someone
 * wrote to the section since (on another device, or a colleague), and sending
 * would overwrite it unseen.
 */
export function planDraft(
  d: Pick<OfflineDraft, "baseUpdatedAt" | "label">,
  server: { visitStatus: string; updatedAt: string | null; sectionExists: boolean },
): DraftPlan {
  if (["documented", "pending_billing", "billed"].includes(server.visitStatus)) {
    return { send: false, problem: "The note was signed since. Add what you wrote as an addendum on the visit." };
  }
  if (server.visitStatus === "cancelled" || server.visitStatus === "no_show") {
    return { send: false, problem: `The visit was marked ${server.visitStatus.replace("_", "-")} since.` };
  }
  if (!server.sectionExists) {
    return { send: false, problem: `${d.label} is no longer a section of this visit's note.` };
  }
  if ((server.updatedAt ?? null) !== (d.baseUpdatedAt ?? null)) {
    return {
      send: false,
      problem: `${d.label} was changed on the server after this copy was saved. Compare the two and copy across what you need; nothing was overwritten.`,
    };
  }
  return { send: true };
}

/** Whether a saved copy is still to be shown. */
export function snapshotIsFresh(s: Pick<OfflineSnapshot, "generatedAt">, now: Date): boolean {
  return now.getTime() - Date.parse(s.generatedAt) <= OFFLINE_MAX_AGE_HOURS * 3_600_000;
}
