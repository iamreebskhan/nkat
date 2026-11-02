/**
 * Care between visits (0116; Level-1 doc:40, :48, :51-57, :101): tasks to the
 * interdisciplinary team, telephone encounters, escalation alerts and PCM/CCM
 * enrolment. Pure constants and Zod schemas, safe to import from client
 * components.
 */
import { z } from "zod";

import type { Discipline, EscalationMeasure } from "@/lib/features/care-plans/care-plan.types";
import { DISCIPLINES } from "@/lib/features/care-plans/care-plan.types";
import { isCalendarDay } from "@/lib/features/org/org-date";

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDay, "Not a calendar day.");
const text = (max: number) => z.string().trim().max(max);
const score = z.number().int().min(0).max(10);

// ---------------------------------------------------------------------------
// Tasks (doc:40, :54)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CreateTaskSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    title: z.string().trim().min(1, "Say what the task is").max(200),
    details: text(2000).optional(),
    discipline: z.enum(DISCIPLINES),
    /** Nobody yet: the discipline's to pick up. */
    assigneeUserId: z.string().uuid().optional(),
    dueOn: Day.optional(),
    /** Where it came from. */
    visitId: z.string().uuid().optional(),
    phoneEncounterId: z.string().uuid().optional(),
    alertId: z.string().uuid().optional(),
  })
  .strict();
export type CreateTask = z.infer<typeof CreateTaskSchema>;

/** A change to an open task, or closing it: done (a note optional) or cancelled (say why). */
export const UpdateTaskSchema = z.union([
  z
    .object({
      title: z.string().trim().min(1).max(200),
      details: text(2000).nullable(),
      discipline: z.enum(DISCIPLINES),
      assigneeUserId: z.string().uuid().nullable(),
      dueOn: Day.nullable(),
    })
    .partial()
    .strict()
    .refine((p) => Object.keys(p).length > 0, "Nothing to change."),
  z.object({ done: z.object({ note: text(1000).optional() }).strict() }).strict(),
  z.object({ cancel: z.object({ reason: z.string().trim().min(1, "Say why").max(1000) }).strict() }).strict(),
]);
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

export interface TaskView {
  id: string;
  patientId: string | null;
  patientName: string | null;
  title: string;
  details: string | null;
  discipline: Discipline;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueOn: string | null;
  /** Past its due day where the practice is, and still open. */
  overdue: boolean;
  status: TaskStatus;
  visitId: string | null;
  phoneEncounterId: string | null;
  alertId: string | null;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
  closedByName: string | null;
  closedAt: string | null;
  closeNote: string | null;
}

// ---------------------------------------------------------------------------
// Telephone encounters (doc:52)
// ---------------------------------------------------------------------------

export const CALL_DIRECTIONS = ["outbound", "inbound"] as const;
export const CALL_DIRECTION_LABEL: Record<(typeof CALL_DIRECTIONS)[number], string> = {
  outbound: "We called",
  inbound: "They called",
};
export const SPOKE_WITH = ["patient", "caregiver", "family", "facility", "provider", "other"] as const;
export const SPOKE_WITH_LABEL: Record<(typeof SPOKE_WITH)[number], string> = {
  patient: "The patient",
  caregiver: "A caregiver",
  family: "Family",
  facility: "The facility",
  provider: "A provider",
  other: "Someone else",
};

export const CreatePhoneEncounterSchema = z
  .object({
    /** When the call took place; now when not given. */
    occurredAt: z.string().datetime({ offset: true }).optional(),
    direction: z.enum(CALL_DIRECTIONS),
    spokeWith: z.enum(SPOKE_WITH),
    minutes: z.number().int().min(1).max(240).optional(),
    painScore: score.optional(),
    dyspneaScore: score.optional(),
    nauseaScore: score.optional(),
    summary: z.string().trim().min(1, "Say what was discussed").max(4000),
    /** Count the call's minutes toward this PCM/CCM enrolment's month (0117). */
    countForEnrollmentId: z.string().uuid().optional(),
  })
  .strict()
  .refine((c) => !c.countForEnrollmentId || c.minutes !== undefined, {
    message: "Say how long the call took to count it toward PCM/CCM time.",
    path: ["minutes"],
  });
export type CreatePhoneEncounter = z.infer<typeof CreatePhoneEncounterSchema>;

export const VoidPhoneEncounterSchema = z
  .object({ void: z.object({ reason: z.string().trim().min(1, "Say why").max(300) }).strict() })
  .strict();

export interface PhoneEncounterView {
  id: string;
  clinicianUserId: string;
  clinicianName: string | null;
  occurredAt: string;
  /** The call's day where the practice is, and its clock time there ('HH:MM'). */
  occurredOn: string;
  occurredTime: string;
  direction: (typeof CALL_DIRECTIONS)[number];
  spokeWith: (typeof SPOKE_WITH)[number];
  minutes: number | null;
  painScore: number | null;
  dyspneaScore: number | null;
  nauseaScore: number | null;
  summary: string;
  voidedAt: string | null;
  voidReason: string | null;
  /** The program its minutes count toward (0117), while they do. */
  countedFor: CareProgram | null;
}

// ---------------------------------------------------------------------------
// Escalation alerts (doc:55-57)
// ---------------------------------------------------------------------------

export const ALERT_STATUSES = ["open", "acknowledged", "withdrawn"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const AcknowledgeAlertSchema = z.object({ note: text(1000).optional() }).strict();

export interface EscalationAlertView {
  id: string;
  patientId: string;
  patientName: string | null;
  measure: EscalationMeasure;
  value: number | null;
  threshold: number | null;
  source: "vitals" | "phone" | "event";
  visitId: string | null;
  phoneEncounterId: string | null;
  eventId: string | null;
  notifiedUserId: string | null;
  notifiedName: string | null;
  status: AlertStatus;
  raisedAt: string;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  acknowledgeNote: string | null;
}

/** "Pain 8/10 (limit 7)", "A fall". */
export function alertText(a: Pick<EscalationAlertView, "measure" | "value" | "threshold">, labels: Record<string, { label: string; unit?: string }>): string {
  const m = labels[a.measure];
  if (!m) return a.measure;
  if (a.value === null) return m.label;
  return `${m.label} ${a.value}${m.unit ?? ""} (limit ${a.threshold}${m.unit ?? ""})`;
}

// ---------------------------------------------------------------------------
// PCM/CCM enrolment (doc:38, :101)
// ---------------------------------------------------------------------------

export const CARE_PROGRAMS = ["pcm", "ccm"] as const;
export type CareProgram = (typeof CARE_PROGRAMS)[number];
export const CARE_PROGRAM_LABEL: Record<CareProgram, string> = {
  pcm: "Principal Care Management (PCM)",
  ccm: "Chronic Care Management (CCM)",
};
export const CARE_PROGRAM_SHORT: Record<CareProgram, string> = { pcm: "PCM", ccm: "CCM" };

export const EnrollSchema = z
  .object({
    program: z.enum(CARE_PROGRAMS),
    enrolledOn: Day,
    consentOn: Day,
    consentMethod: z.enum(["verbal", "written"]),
    consentNote: text(500).optional(),
  })
  .strict()
  .refine((e) => e.consentOn <= e.enrolledOn, { message: "Consent comes before enrolment.", path: ["consentOn"] });
export type Enroll = z.infer<typeof EnrollSchema>;

export const EndEnrollmentSchema = z
  .object({ endedOn: Day, reason: z.string().trim().min(1, "Say why").max(300) })
  .strict();

export interface EnrollmentView {
  id: string;
  program: CareProgram;
  enrolledOn: string;
  consentOn: string;
  consentMethod: "verbal" | "written";
  consentNote: string | null;
  enrolledByName: string | null;
  endedOn: string | null;
  endReason: string | null;
}
