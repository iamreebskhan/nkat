/**
 * PCM/CCM time and what a month of it bills (0117; Level-1 doc:53, :69, :101;
 * Mark Q10 default). Pure, so the screen, the service and the specs read one
 * rule.
 *
 * The codes (CPT, in the code table since seed 0019):
 *   PCM  99426 clinical staff, first 30 min/month; 99427 each additional 30
 *        99424 the practitioner personally, first 30 min/month; 99425 each additional 30
 *   CCM  99490 clinical staff, first 20 min/month; 99439 each additional 20, at most 2
 *        99491 the practitioner personally, 30 min/month (no add-on in the code table)
 *
 * Whose time counts:
 *   - the clinical-staff codes count everyone's: the staff's, under the
 *     practitioner's direction, and any practitioner's own;
 *   - the practitioner's codes count the billing practitioner's own time only.
 *     A colleague's minutes are not the biller's personal time.
 * A month bills one set or the other, chosen when the charge is raised. Add-on
 * units are whole increments. Complex CCM (99487/99489) needs a medical
 * decision-making judgement this log does not hold, and is not offered.
 *
 * The date of service is the day the counted time reached what is billed, the
 * base code and its add-on units together: a month may be billed once its time
 * is met, on that day, without waiting for the month to end.
 */
import { z } from "zod";

import { formatCodes } from "@/lib/features/billing/code-units";
import { isCalendarDay } from "@/lib/features/org/org-date";
import { tierForCredential } from "@/lib/features/team/clinician";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";

import type { CareProgram } from "./care-coordination.types";

export { CARE_MANAGEMENT_VISIT_TYPE };

/**
 * A practitioner's time (NP, MD, DO, PA, CNS: the credentials that bill), or
 * clinical staff time. Read from the credential on the Team page when logged.
 */
export type PerformerKind = "qhp" | "clinical_staff";
export const performerKindFor = (credential: string | null | undefined): PerformerKind =>
  tierForCredential(credential) ? "qhp" : "clinical_staff";
export const PERFORMER_KIND_LABEL: Record<PerformerKind, string> = {
  qhp: "Practitioner",
  clinical_staff: "Clinical staff",
};

export type ChargeBasis = "staff" | "qhp";
export const CHARGE_BASIS_LABEL: Record<ChargeBasis, string> = {
  staff: "Clinical staff time (everyone's minutes count)",
  qhp: "The practitioner's own time",
};

export const CM_ACTIVITIES = [
  "phone",
  "care_coordination",
  "medication_management",
  "care_plan",
  "caregiver_support",
  "other",
] as const;
export type CmActivity = (typeof CM_ACTIVITIES)[number];
export const CM_ACTIVITY_LABEL: Record<CmActivity, string> = {
  phone: "Phone call",
  care_coordination: "Care coordination",
  medication_management: "Medication management",
  care_plan: "Care plan work",
  caregiver_support: "Caregiver support",
  other: "Other",
};

/** Where the month is billed from: POS 11 (office) or 12 (home). */
export const CM_PLACES_OF_SERVICE = ["11", "12"] as const;

/** A claim carries at most 12 diagnoses (837P HI, CMS-1500 21A–L). */
export const MAX_CHARGE_DIAGNOSES = 12;
/** PCM is billed for one serious condition, CCM for two or more (CMS). */
export const MIN_DIAGNOSES: Record<CareProgram, number> = { pcm: 1, ccm: 2 };

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDay, "Not a calendar day.");
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export const LogTimeSchema = z
  .object({
    enrollmentId: z.string().uuid(),
    serviceOn: Day,
    minutes: z.number().int().min(1, "At least a minute").max(240, "At most 240 minutes in one entry"),
    activity: z.enum(CM_ACTIVITIES),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type LogTime = z.infer<typeof LogTimeSchema>;

export const VoidTimeSchema = z
  .object({ void: z.object({ reason: z.string().trim().min(1, "Say why").max(300) }).strict() })
  .strict();

/** ?month=YYYY-MM; left out, the practice's current month. */
export const MonthQuerySchema = z.object({ month: Month.nullable() });

export const RaiseChargeSchema = z
  .object({
    enrollmentId: z.string().uuid(),
    /** 'YYYY-MM': the calendar month, where the practice is. */
    month: Month,
    basis: z.enum(["staff", "qhp"]),
    /** Fewer add-on units than the time allows; left out, all of them. */
    addOnUnits: z.number().int().min(0).max(20).optional(),
    placeOfService: z.enum(CM_PLACES_OF_SERVICE),
    /** ICD-10 codes from the patient's active problem list, in claim order. */
    diagnoses: z
      .array(z.string().trim().min(3).max(10))
      .min(1, "Pick the diagnoses the month was for")
      .max(MAX_CHARGE_DIAGNOSES, `At most ${MAX_CHARGE_DIAGNOSES} diagnoses on a claim`)
      .refine((d) => new Set(d.map((c) => c.toUpperCase())).size === d.length, "A diagnosis is listed twice"),
  })
  .strict();
export type RaiseCharge = z.infer<typeof RaiseChargeSchema>;

export interface TimeEntry {
  serviceOn: string;
  minutes: number;
  kind: PerformerKind;
  performedBy: string;
}

export interface TimeEntryView {
  id: string;
  serviceOn: string;
  minutes: number;
  activity: CmActivity;
  note: string | null;
  performedByUserId: string;
  performedByName: string | null;
  kind: PerformerKind;
  /** Logged with a call (its minutes). */
  phoneEncounterId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** Not voided, and on a day the enrolment was in force. */
  counted: boolean;
}

export interface ChargeView {
  id: string;
  visitId: string;
  basis: ChargeBasis;
  dateOfService: string;
  codes: string[];
  units: Record<string, number>;
  qhpMinutes: number;
  staffMinutes: number;
  raisedByName: string | null;
  raisedAt: string;
  superbillId: string | null;
  superbillStatus: string | null;
}

export interface CareManagementMonthView {
  /** The practice's today, and the month shown ('YYYY-MM'). */
  today: string;
  month: string;
  /** The viewer as a logger of time: null when no credential is recorded. */
  viewer: { kind: PerformerKind | null };
  hasCarePlan: boolean;
  /** The active problem list: what a charge's diagnoses are picked from. */
  problems: { icd10: string; description: string }[];
  /** Each enrolment in force at some point in the month. */
  programs: {
    enrollmentId: string;
    program: CareProgram;
    enrolledOn: string;
    endedOn: string | null;
    consentOn: string;
    consentMethod: "verbal" | "written";
    entries: TimeEntryView[];
    /** The counted minutes, by whom. */
    minutes: { staff: number; qhp: number };
    staff: SetProgress;
    /** The viewer's own time, when the viewer is a practitioner. */
    qhp: SetProgress | null;
    charge: ChargeView | null;
  }[];
}

/** How far a month's time has come under one code set. */
export interface SetProgress {
  basis: ChargeBasis;
  base: string;
  addOn: string | null;
  /** Minutes the base code needs, and each add-on unit after it. */
  first: number;
  each: number;
  /** The most add-on units the set bills (null: no limit). */
  cap: number | null;
  /** The minutes this set counts. */
  minutes: number;
  /**
   * The day the counted time reached the base code's minimum, then the day it
   * reached each further add-on unit (within the cap). Empty: not reached.
   */
  reached: string[];
}

interface Rule {
  base: string;
  first: number;
  addOn: string | null;
  each: number;
  cap: number | null;
}

const RULES: Record<CareProgram, Record<ChargeBasis, Rule>> = {
  pcm: {
    staff: { base: "99426", first: 30, addOn: "99427", each: 30, cap: null },
    qhp: { base: "99424", first: 30, addOn: "99425", each: 30, cap: null },
  },
  ccm: {
    staff: { base: "99490", first: 20, addOn: "99439", each: 20, cap: 2 },
    qhp: { base: "99491", first: 30, addOn: null, each: 30, cap: 0 },
  },
};

function progress(program: CareProgram, basis: ChargeBasis, entries: TimeEntry[]): SetProgress {
  const r = RULES[program][basis];
  const sorted = [...entries].sort((a, b) => a.serviceOn.localeCompare(b.serviceOn));
  let minutes = 0;
  const reached: string[] = [];
  for (const e of sorted) {
    minutes += e.minutes;
    // reached.length thresholds are behind; the next is the base code's
    // minimum, then one more increment per add-on unit, until the cap.
    for (;;) {
      const k = reached.length;
      if (k > 0 && (r.addOn === null || (r.cap !== null && k > r.cap))) break;
      if (minutes < r.first + k * r.each) break;
      reached.push(e.serviceOn);
    }
  }
  return { basis, base: r.base, addOn: r.addOn, first: r.first, each: r.each, cap: r.addOn ? r.cap : 0, minutes, reached };
}

/**
 * The month under each code set. The practitioner's set is the billing
 * practitioner's own time, so it is worked out for one practitioner, or not at
 * all (null) when no one is named.
 */
export function monthProgress(
  program: CareProgram,
  entries: TimeEntry[],
  billingPractitioner: string | null,
): { staff: SetProgress; qhp: SetProgress | null } {
  return {
    staff: progress(program, "staff", entries),
    qhp: billingPractitioner
      ? progress(
          program,
          "qhp",
          entries.filter((e) => e.kind === "qhp" && e.performedBy === billingPractitioner),
        )
      : null,
  };
}

/** The base code's minimum for a set, for "N more minutes" before any time is logged. */
export const firstMinutes = (program: CareProgram, basis: ChargeBasis) => RULES[program][basis].first;

/**
 * What a charge on this set carries: codes, units as the visit and the bill
 * hold them, and the date of service. Fewer add-on units than the time allows
 * may be billed, never more. Null when the base code's time is not met.
 */
export function chargeFor(
  p: SetProgress,
  addOnUnits?: number,
): { codes: string[]; units: Record<string, number>; addOnUnits: number; dateOfService: string } | null {
  if (p.reached.length === 0) return null;
  const most = p.reached.length - 1;
  const n = addOnUnits === undefined ? most : Math.max(0, Math.min(addOnUnits, most));
  const withAddOn = p.addOn !== null && n > 0;
  return {
    codes: withAddOn ? [p.base, p.addOn!] : [p.base],
    // One unit is stored as no key (code-units.ts normalizeUnits).
    units: withAddOn && n > 1 ? { [p.addOn!]: n } : {},
    addOnUnits: withAddOn ? n : 0,
    dateOfService: p.reached[n]!,
  };
}

/**
 * The signed record a month's charge is carried on: what was billed, on whose
 * time, how much of it, and the consent it rests on. Plain text, as the visit
 * keeps it; never the time log's notes.
 */
export function chargeSummaryText(a: {
  program: CareProgram;
  month: string;
  basis: ChargeBasis;
  codes: string[];
  units: Record<string, number>;
  minutes: { counted: number; staff: number; qhp: number };
  entries: number;
  firstDay: string;
  lastDay: string;
  dateOfService: string;
  enrolledOn: string;
  consentOn: string;
  consentMethod: "verbal" | "written";
  raisedBy: string;
}): string {
  const program = a.program === "pcm" ? "PCM" : "CCM";
  const span = a.firstDay === a.lastDay ? `on ${a.firstDay}` : `from ${a.firstDay} to ${a.lastDay}`;
  const entries = `${a.entries} ${a.entries === 1 ? "entry" : "entries"}`;
  return [
    `${program}, ${monthLabel(a.month)}: billed from the time log.`,
    `Codes: ${formatCodes(a.codes, a.units)}, on ${a.basis === "staff" ? "clinical staff time" : "the practitioner's own time"}.`,
    a.basis === "staff"
      ? `Time counted: ${a.minutes.counted} minutes (${a.minutes.staff} clinical staff, ${a.minutes.qhp} practitioner), ${entries} ${span}.`
      : `Time counted: ${a.minutes.counted} minutes of ${a.raisedBy}'s own time, ${entries} ${span}.`,
    `Date of service: ${a.dateOfService}, the day the billed time was reached.`,
    `Enrolled ${a.enrolledOn}, after ${a.consentMethod} consent on ${a.consentOn}.`,
    `Raised by ${a.raisedBy}.`,
  ].join("\n");
}

/** 'YYYY-MM' → its first and last day. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, "0")}` };
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The month a day falls in, 'YYYY-MM'. */
export const monthOf = (day: string) => day.slice(0, 7);

/** The months before and after 'YYYY-MM'. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
