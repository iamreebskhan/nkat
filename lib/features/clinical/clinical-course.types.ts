/**
 * The course of care on the chart (0115; Level-1 doc:37, :58, :84-95, :108):
 * acuity with its history, hospice eligibility, significant events, and the
 * discharge with the move to hospice. Pure constants and Zod schemas, safe to
 * import from client components.
 */
import { z } from "zod";

import { isCalendarDay } from "@/lib/features/org/org-date";
import { PATIENT_ACUITIES, type PatientAcuity } from "@/lib/features/patients/patient.types";

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDay, "Not a calendar day.");
const text = (max: number) => z.string().trim().max(max);

// ---------------------------------------------------------------------------
// Acuity
// ---------------------------------------------------------------------------

export const ACUITY_SOURCES = ["intake", "triage", "visit", "review", "on_file"] as const;
export type AcuitySource = (typeof ACUITY_SOURCES)[number];
export const ACUITY_SOURCE_LABEL: Record<AcuitySource, string> = {
  intake: "At intake",
  triage: "Triage",
  visit: "NP visit",
  review: "Chart review",
  /** Set before the history began (0115), at intake or since. */
  on_file: "On file when the history began",
};

export const VisitAcuitySchema = z.object({ acuity: z.enum(PATIENT_ACUITIES) }).strict();

export interface AcuityEventView {
  id: string;
  acuity: PatientAcuity;
  source: AcuitySource;
  visitId: string | null;
  /** The visit's day where the practice is, for an NP-visit acuity. */
  visitDay: string | null;
  recordedByName: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Hospice eligibility (Mark Q11c default: yes/no, a day, a basis)
// ---------------------------------------------------------------------------

export const HospiceAssessmentSchema = z
  .object({
    eligible: z.boolean(),
    assessedOn: Day,
    basis: text(1000).optional(),
    visitId: z.string().uuid().optional(),
  })
  .strict();
export type HospiceAssessment = z.infer<typeof HospiceAssessmentSchema>;

export interface HospiceAssessmentView {
  id: string;
  eligible: boolean;
  assessedOn: string;
  basis: string | null;
  visitId: string | null;
  assessedByName: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Significant events (doc:58, :86-89)
// ---------------------------------------------------------------------------

/** The Events card's: falls, ED visits, admissions, other (doc:58, :86-89). */
export const EVENT_KINDS = ["fall", "ed_visit", "hospital_admission", "other"] as const;
/** Kept in the same log, shown with hospice eligibility (doc:92). */
export const HOSPICE_EVENT_KINDS = ["hospice_discussion", "hospice_referral"] as const;
export const ALL_EVENT_KINDS = [...EVENT_KINDS, ...HOSPICE_EVENT_KINDS] as const;
export type EventKind = (typeof ALL_EVENT_KINDS)[number];
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  fall: "Fall",
  ed_visit: "ED visit",
  hospital_admission: "Hospital admission",
  other: "Other significant event",
  hospice_discussion: "Hospice discussion",
  hospice_referral: "Hospice referral",
};
export const isHospiceEvent = (kind: string) => (HOSPICE_EVENT_KINDS as readonly string[]).includes(kind);

/** A readmission: an admission within this many days of the last discharge. */
export const READMISSION_WINDOW_DAYS = 30;

export const AddEventSchema = z
  .object({
    kind: z.enum(ALL_EVENT_KINDS),
    occurredOn: Day,
    /** The hospital discharge, for an admission. */
    endedOn: Day.optional(),
    /** The hospital; for a hospice referral, the hospice. */
    facility: text(150).optional(),
    /** For a fall. */
    injury: z.boolean().optional(),
    description: text(1000).optional(),
    visitId: z.string().uuid().optional(),
  })
  .strict()
  .refine((e) => !e.endedOn || e.kind === "hospital_admission", {
    message: "Only an admission has a discharge day.",
    path: ["endedOn"],
  })
  .refine((e) => !e.endedOn || e.endedOn >= e.occurredOn, {
    message: "Discharged before admitted.",
    path: ["endedOn"],
  })
  .refine((e) => e.injury === undefined || e.kind === "fall", {
    message: "Only a fall has an injury.",
    path: ["injury"],
  });
export type AddEvent = z.infer<typeof AddEventSchema>;

/** A later correction: the admission's discharge day, the details; or voiding it. */
export const UpdateEventSchema = z.union([
  z
    .object({
      endedOn: Day.nullable(),
      facility: text(150).nullable(),
      injury: z.boolean().nullable(),
      description: text(1000).nullable(),
    })
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, "Nothing to change."),
  z.object({ void: z.object({ reason: z.string().trim().min(1, "Say why").max(300) }).strict() }).strict(),
]);
export type UpdateEvent = z.infer<typeof UpdateEventSchema>;

export interface PatientEventView {
  id: string;
  kind: EventKind;
  occurredOn: string;
  endedOn: string | null;
  facility: string | null;
  injury: boolean | null;
  description: string | null;
  /** An admission within READMISSION_WINDOW_DAYS of the last one's discharge. */
  readmission: boolean;
  recordedByName: string | null;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

/**
 * Which admissions are readmissions: one beginning within the window after an
 * earlier admission ended (or began, when its discharge is not recorded).
 * Voided events count for nothing. Pure, so the chart and the reports agree.
 */
export function readmissionIds(
  events: Pick<PatientEventView, "id" | "kind" | "occurredOn" | "endedOn" | "voidedAt">[],
): Set<string> {
  const admissions = events
    .filter((e) => e.kind === "hospital_admission" && !e.voidedAt)
    .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  const out = new Set<string>();
  for (let i = 1; i < admissions.length; i++) {
    const prev = admissions[i - 1]!;
    const left = prev.endedOn ?? prev.occurredOn;
    const days = (Date.parse(admissions[i]!.occurredOn) - Date.parse(left)) / 86_400_000;
    if (days >= 0 && days <= READMISSION_WINDOW_DAYS) out.add(admissions[i]!.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discharge and the move to hospice (doc:93-95, :108)
// ---------------------------------------------------------------------------

export const HOSPICE_END_REASONS = ["death", "live_discharge", "revocation", "transfer"] as const;
export type HospiceEndReason = (typeof HOSPICE_END_REASONS)[number];
export const HOSPICE_END_REASON_LABEL: Record<HospiceEndReason, string> = {
  death: "Died in hospice",
  live_discharge: "Discharged alive",
  revocation: "Revoked the hospice benefit",
  transfer: "Transferred to another hospice",
};

export const DischargeSchema = z
  .object({
    dischargedOn: Day,
    reasonCodeId: z.string().uuid(),
    note: text(1000).optional(),
    /** For a move to hospice. */
    hospiceName: text(150).optional(),
    hospiceAdmittedOn: Day.optional(),
    /** For a death on service; the discharge day when not given. */
    diedOn: Day.optional(),
  })
  .strict();
export type Discharge = z.infer<typeof DischargeSchema>;

/**
 * The hospice stay after a discharge to hospice, recorded as it becomes known
 * (Mark Q11j default: by hand): the hospice and its admission day, then how
 * the stay ended, which gives the hospice length of stay (doc:95).
 */
export const HospiceStaySchema = z
  .object({
    hospiceName: text(150).optional(),
    hospiceAdmittedOn: Day.optional(),
    hospiceEndedOn: Day.optional(),
    hospiceEndReason: z.enum(HOSPICE_END_REASONS).optional(),
  })
  .strict()
  .refine((s) => Object.values(s).some((v) => v !== undefined), "Nothing to change.")
  .refine((s) => (s.hospiceEndedOn === undefined) === (s.hospiceEndReason === undefined), {
    message: "Give the day the hospice stay ended and how it ended, together.",
    path: ["hospiceEndReason"],
  });
export type HospiceStay = z.infer<typeof HospiceStaySchema>;

export const ReadmitSchema = z
  .object({
    readmittedOn: Day,
    reason: z.string().trim().min(1, "Say why").max(300),
  })
  .strict();
export type Readmit = z.infer<typeof ReadmitSchema>;

export interface DischargeView {
  id: string;
  admittedOn: string | null;
  dischargedOn: string;
  reasonCode: string;
  reasonLabel: string;
  /** What the code counts as: hospice_partner, hospice_other, death, … */
  category: string;
  note: string | null;
  hospiceName: string | null;
  hospiceAdmittedOn: string | null;
  hospiceEndedOn: string | null;
  hospiceEndReason: HospiceEndReason | null;
  diedOn: string | null;
  /** Days on palliative care in this episode. */
  lengthOfStayDays: number | null;
  /** Days in hospice, once the stay has ended (doc:95). */
  hospiceLengthOfStayDays: number | null;
  recordedByName: string | null;
  recordedAt: string;
  reversedAt: string | null;
  reversedReason: string | null;
}

export const isHospiceCategory = (category: string) => category === "hospice_partner" || category === "hospice_other";

/** Whole days from one practice day to another. */
export function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export interface ClinicalCourseView {
  status: string;
  admittedOn: string | null;
  practiceToday: string;
  acuity: {
    current: PatientAcuity | null;
    /** The admitting referral's triage, which a chart admitted before the history began has no event for. */
    triage: { acuity: PatientAcuity; on: string } | null;
    history: AcuityEventView[];
  };
  hospice: {
    assessments: HospiceAssessmentView[];
    /** What triage thought, for a patient admitted from a referral. */
    triage: { eligible: "yes" | "no" | "unsure"; basis: string | null; on: string } | null;
  };
  events: PatientEventView[];
  /** Newest first; the one in force has reversedAt null. */
  discharges: DischargeView[];
}
