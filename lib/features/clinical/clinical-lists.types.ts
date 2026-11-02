/**
 * The chart's problem list, medication list and allergies (0114; Level-1
 * doc:36). Pure constants and Zod schemas, safe to import from client
 * components.
 *
 * Nothing on these lists is deleted: a problem is resolved, a medication
 * stopped, an allergy made inactive, and each change says who and when.
 */
import { z } from "zod";

import { isCalendarDay } from "@/lib/features/org/org-date";
import { Icd10Schema } from "@/lib/features/patients/patient.types";

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDay, "Not a calendar day.");
const text = (max: number) => z.string().trim().max(max);
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s === "" ? null : s));

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export const PROBLEM_STATUSES = ["active", "resolved"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export const AddProblemSchema = z
  .object({
    icd10: Icd10Schema,
    /** The code's description; the catalog's is used when this is empty. */
    description: text(300).optional(),
    onsetOn: Day.optional(),
    notes: text(1000).optional(),
  })
  .strict();
export type AddProblem = z.infer<typeof AddProblemSchema>;

/** A correction, or resolving / reopening the problem (tri-state, as elsewhere). */
export const UpdateProblemSchema = z
  .object({
    description: z.string().trim().min(1, "Describe the problem").max(300),
    onsetOn: Day.nullable(),
    notes: nullableText(1000),
    status: z.enum(PROBLEM_STATUSES),
    /** Required when resolving. */
    resolvedOn: Day,
  })
  .partial()
  .strict()
  .refine((p) => p.status !== "resolved" || p.resolvedOn !== undefined, {
    message: "Say when it resolved.",
    path: ["resolvedOn"],
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");
export type UpdateProblem = z.infer<typeof UpdateProblemSchema>;

export interface ProblemView {
  id: string;
  icd10: string;
  description: string;
  status: ProblemStatus;
  onsetOn: string | null;
  resolvedOn: string | null;
  notes: string | null;
  recordedByName: string | null;
  recordedAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

/** An RxNorm concept (0128): digits, as RxNav gives it. */
const RxCui = z.string().regex(/^\d{1,10}$/, "Not an RxNorm code.");

export const MEDICATION_STATUSES = ["active", "stopped"] as const;
export type MedicationStatus = (typeof MEDICATION_STATUSES)[number];

export const AddMedicationSchema = z
  .object({
    name: z.string().trim().min(1, "Name the medication").max(200),
    dose: text(100).optional(),
    route: text(50).optional(),
    frequency: text(100).optional(),
    prn: z.boolean().optional(),
    indication: text(200).optional(),
    startedOn: Day.optional(),
    rxnormCui: RxCui.optional(),
  })
  .strict();
export type AddMedication = z.infer<typeof AddMedicationSchema>;

export const UpdateMedicationSchema = z
  .object({
    name: z.string().trim().min(1, "Name the medication").max(200),
    dose: nullableText(100),
    route: nullableText(50),
    frequency: nullableText(100),
    prn: z.boolean(),
    indication: nullableText(200),
    startedOn: Day.nullable(),
    rxnormCui: RxCui.nullable(),
    status: z.enum(MEDICATION_STATUSES),
    /** Required when stopping. */
    stoppedOn: Day,
    stopReason: nullableText(300),
  })
  .partial()
  .strict()
  .refine((p) => p.status !== "stopped" || p.stoppedOn !== undefined, {
    message: "Say when it was stopped.",
    path: ["stoppedOn"],
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");
export type UpdateMedication = z.infer<typeof UpdateMedicationSchema>;

export interface MedicationView {
  id: string;
  name: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  prn: boolean;
  indication: string | null;
  status: MedicationStatus;
  startedOn: string | null;
  stoppedOn: string | null;
  stopReason: string | null;
  rxnormCui: string | null;
  recordedByName: string | null;
  recordedAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

/**
 * "Morphine ER 15 mg PO every 12 hours", with PRN when it is: how a
 * medication reads in a list, a care plan and its frozen versions. The SQL
 * twin, for the versions frozen at sign-off, is in care-plan.service.ts
 * (freezeCarePlanForSignedVisit); keep the two in step.
 */
export function medicationLabel(m: Pick<MedicationView, "name" | "dose" | "route" | "frequency" | "prn">): string {
  const parts = [m.name, m.dose, m.route, m.frequency].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" ") + (m.prn ? " PRN" : "");
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export const ALLERGY_KINDS = ["drug", "food", "environmental", "other"] as const;
export type AllergyKind = (typeof ALLERGY_KINDS)[number];
export const ALLERGY_KIND_LABEL: Record<AllergyKind, string> = {
  drug: "Drug",
  food: "Food",
  environmental: "Environmental",
  other: "Other",
};

export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];
export const ALLERGY_SEVERITY_LABEL: Record<AllergySeverity, string> = {
  mild: "Mild",
  moderate: "Moderate",
  severe: "Severe",
  unknown: "Unknown",
};

export const ALLERGY_STATUSES = ["active", "inactive"] as const;
export type AllergyStatus = (typeof ALLERGY_STATUSES)[number];

export const AddAllergySchema = z
  .object({
    substance: z.string().trim().min(1, "Name what they are allergic to").max(200),
    kind: z.enum(ALLERGY_KINDS),
    reaction: text(300).optional(),
    severity: z.enum(ALLERGY_SEVERITIES).optional(),
    rxnormCui: RxCui.optional(),
  })
  .strict();
export type AddAllergy = z.infer<typeof AddAllergySchema>;

export const UpdateAllergySchema = z
  .object({
    substance: z.string().trim().min(1, "Name what they are allergic to").max(200),
    kind: z.enum(ALLERGY_KINDS),
    reaction: nullableText(300),
    severity: z.enum(ALLERGY_SEVERITIES).nullable(),
    status: z.enum(ALLERGY_STATUSES),
    /** Why it is no longer active: entered in error, disproved. */
    inactiveReason: nullableText(300),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");
export type UpdateAllergy = z.infer<typeof UpdateAllergySchema>;

export interface AllergyView {
  id: string;
  substance: string;
  kind: AllergyKind;
  reaction: string | null;
  severity: AllergySeverity | null;
  status: AllergyStatus;
  inactiveReason: string | null;
  rxnormCui: string | null;
  recordedByName: string | null;
  recordedAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

/** Everything the chart's three cards show, in one read. */
export interface ClinicalListsView {
  problems: ProblemView[];
  medications: MedicationView[];
  allergies: AllergyView[];
  /** "No known allergies", when it was recorded and is still true. */
  noKnownAllergies: { at: string; byName: string | null } | null;
  /** The practice's today, which the forms' days default to and stop at. */
  practiceToday: string;
}

export const CLINICAL_LISTS = ["problems", "medications", "allergies"] as const;
export type ClinicalList = (typeof CLINICAL_LISTS)[number];

/**
 * The chart's active medications as the visit note's Medications section
 * lists them, one per line: what "Fill from the chart" writes, so the NP
 * reviews the list instead of retyping it (doc:36).
 */
export function noteMedicationLines(l: Pick<ClinicalListsView, "medications">): string[] {
  return l.medications
    .filter((m) => m.status === "active")
    .map((m) => medicationLabel(m) + (m.indication ? ` — for ${m.indication}` : ""));
}

/**
 * The chart's active allergies for the note's Allergies section, or "No known
 * allergies" when that was recorded. Empty when the chart says neither: the
 * note is not told there are none when nobody asked.
 */
export function noteAllergyLines(l: Pick<ClinicalListsView, "allergies" | "noKnownAllergies">): string[] {
  const active = l.allergies.filter((a) => a.status === "active");
  if (active.length === 0) return l.noKnownAllergies ? ["No known allergies"] : [];
  return active.map((a) =>
    [a.substance, a.reaction && `— ${a.reaction}`, a.severity && `(${ALLERGY_SEVERITY_LABEL[a.severity].toLowerCase()})`]
      .filter(Boolean)
      .join(" "),
  );
}
