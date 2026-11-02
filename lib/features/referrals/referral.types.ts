/**
 * Referral types and schemas — the intake pipeline (Level-1 doc:22-28, 0111).
 *
 * A referral holds the person from the day it is received until it is
 * admitted (and becomes a patient), not taken under care, or transitioned.
 * Pure constants and Zod schemas, safe to import from client components.
 */
import { z } from "zod";

import type { EligibilitySummary } from "@/lib/features/clearinghouse/x12/x12-271";
import { isCalendarDay } from "@/lib/features/org/org-date";
import { NpiSchema, PhoneSchema } from "@/lib/features/patients/contacts.types";
import { Icd10Schema, PATIENT_ACUITIES, type PatientAcuity } from "@/lib/features/patients/patient.types";

/** The pipeline stages of the practice's current EHR. */
export const REFERRAL_STAGES = [
  "pre_admission",
  "pending_long_term",
  "admitted",
  "ntuc",
  "transitioned",
] as const;
export type ReferralStage = (typeof REFERRAL_STAGES)[number];

export const REFERRAL_STAGE_LABEL: Record<ReferralStage, string> = {
  pre_admission: "Pre-admission",
  pending_long_term: "Pending long term",
  admitted: "Admitted",
  ntuc: "Not taken under care",
  transitioned: "Transitioned",
};

/** Still being worked; the rest are dispositions. */
export const OPEN_STAGES: readonly ReferralStage[] = ["pre_admission", "pending_long_term"];

export const isOpenStage = (s: ReferralStage) => OPEN_STAGES.includes(s);

/**
 * The moves the board offers. Admission is not one of them: a referral is
 * admitted by completing intake for it (createPatient with its referralId),
 * which is what creates the patient. A closed referral can be reopened, but
 * an admitted one cannot: it has a chart now.
 */
export function stageMovesFrom(s: ReferralStage): ReferralStage[] {
  switch (s) {
    case "pre_admission":
      return ["pending_long_term", "ntuc", "transitioned"];
    case "pending_long_term":
      return ["pre_admission", "ntuc", "transitioned"];
    case "ntuc":
    case "transitioned":
      return ["pre_admission"];
    case "admitted":
      return [];
  }
}

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isCalendarDay, "Not a calendar day.");

const Name = z.string().trim().min(1, "Required").max(100, "Too long");
const optionalText = (max: number) => z.string().trim().max(max);

/** A new referral, as the intake coordinator writes it down. */
export const CreateReferralSchema = z
  .object({
    receivedOn: Day,
    firstName: Name,
    lastName: Name,
    dateOfBirth: Day.optional(),
    phone: PhoneSchema.optional(),
    sourceName: z.string().trim().min(1).max(150).optional(),
    referringProviderName: optionalText(150).optional(),
    referringProviderNpi: NpiSchema.optional(),
    reason: optionalText(2000).optional(),
    primaryDiagnosisIcd10: Icd10Schema.optional(),
    payerId: z.string().uuid().optional(),
    memberId: z.string().trim().min(1).max(120).optional(),
    assignedToUserId: z.string().uuid().optional(),
    notes: optionalText(2000).optional(),
  })
  .strict();
export type CreateReferral = z.infer<typeof CreateReferralSchema>;

const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable();

/**
 * A correction, tri-state like UpdatePatientSchema: absent keeps, null
 * clears, a value sets. Names and the received day can be corrected, not
 * cleared.
 */
export const UpdateReferralSchema = z
  .object({
    receivedOn: Day,
    firstName: Name,
    lastName: Name,
    dateOfBirth: nullable(Day),
    phone: nullable(PhoneSchema),
    sourceName: nullable(z.string().trim().min(1).max(150)),
    referringProviderName: nullable(optionalText(150)),
    referringProviderNpi: nullable(NpiSchema),
    reason: nullable(optionalText(2000)),
    primaryDiagnosisIcd10: nullable(Icd10Schema),
    payerId: nullable(z.string().uuid()),
    memberId: nullable(z.string().trim().min(1).max(120)),
    assignedToUserId: nullable(z.string().uuid()),
    notes: nullable(optionalText(2000)),
  })
  .partial()
  .strict();
export type UpdateReferral = z.infer<typeof UpdateReferralSchema>;

/**
 * A stage move from the board. NTUC carries its reason code and day
 * (Level-1 doc:25); every move may carry a note.
 */
export const StageChangeSchema = z.discriminatedUnion("to", [
  z.object({
    to: z.literal("ntuc"),
    reasonCodeId: z.string().uuid(),
    on: Day,
    note: optionalText(1000).optional(),
  }).strict(),
  z.object({
    to: z.enum(["pre_admission", "pending_long_term", "transitioned"]),
    note: optionalText(1000).optional(),
  }).strict(),
]);
export type StageChange = z.infer<typeof StageChangeSchema>;

/** One item of the pending-requirements checklist (Mark Q11d default). */
export interface ReferralRequirement {
  id: string;
  label: string;
  doneAt: string | null;
  doneBy: string | null;
}

export const RequirementsSchema = z
  .object({
    requirements: z
      .array(
        z.object({
          id: z.string().uuid(),
          label: z.string().trim().min(1, "Name the requirement").max(120),
          done: z.boolean(),
        }).strict(),
      )
      .max(30, "At most 30 requirements"),
  })
  .strict();

export const HOSPICE_ELIGIBILITY = ["yes", "no", "unsure"] as const;
export type HospiceEligibility = (typeof HOSPICE_ELIGIBILITY)[number];

/** A triage, by a nurse or other clinical team member (doc:26-27). */
export const TriageSchema = z
  .object({
    symptoms: optionalText(2000).optional(),
    immediateNeeds: optionalText(2000).optional(),
    preliminaryAcuity: z.enum(PATIENT_ACUITIES).optional(),
    hospiceEligible: z.enum(HOSPICE_ELIGIBILITY).optional(),
    hospiceBasis: optionalText(1000).optional(),
  })
  .strict()
  .refine(
    (t) => Object.values(t).some((v) => v !== undefined && v !== ""),
    "Record at least one finding.",
  );
export type Triage = z.infer<typeof TriageSchema>;

export const VERIFICATION_METHODS = ["portal", "phone", "clearinghouse", "other"] as const;
export const VERIFICATION_RESULTS = ["active", "inactive", "not_found", "pending"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VERIFICATION_METHOD_LABEL: Record<VerificationMethod, string> = {
  portal: "Payer portal",
  phone: "Phone",
  clearinghouse: "Clearinghouse",
  other: "Other",
};
export const VERIFICATION_RESULT_LABEL: Record<VerificationResult, string> = {
  active: "Active",
  inactive: "Inactive",
  not_found: "Member not found",
  pending: "Pending",
};

/** One check of coverage (doc:23). */
export const VerificationSchema = z
  .object({
    payerId: z.string().uuid().optional(),
    memberId: z.string().trim().min(1).max(120).optional(),
    method: z.enum(VERIFICATION_METHODS),
    result: z.enum(VERIFICATION_RESULTS),
    coverageEffectiveOn: Day.optional(),
    coverageEndsOn: Day.optional(),
    reference: optionalText(100).optional(),
    notes: optionalText(1000).optional(),
  })
  .strict()
  .refine(
    (v) => !v.coverageEffectiveOn || !v.coverageEndsOn || v.coverageEndsOn >= v.coverageEffectiveOn,
    { message: "Coverage ends before it starts.", path: ["coverageEndsOn"] },
  );
export type Verification = z.infer<typeof VerificationSchema>;

export interface TriageView {
  id: string;
  symptoms: string | null;
  immediateNeeds: string | null;
  preliminaryAcuity: PatientAcuity | null;
  hospiceEligible: HospiceEligibility | null;
  hospiceBasis: string | null;
  triagedByName: string | null;
  triagedAt: string;
}

export interface VerificationView {
  id: string;
  payerId: string | null;
  payerName: string | null;
  memberId: string | null;
  method: VerificationMethod;
  result: VerificationResult;
  coverageEffectiveOn: string | null;
  coverageEndsOn: string | null;
  reference: string | null;
  notes: string | null;
  verifiedByName: string | null;
  verifiedAt: string;
  /** What the payer said, for an electronic check (271 or Availity's API, 0120); null for one recorded by hand. */
  details: EligibilitySummary | null;
}

/** A row on the board. */
export interface ReferralRow {
  id: string;
  receivedOn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  sourceName: string | null;
  referringProviderName: string | null;
  stage: ReferralStage;
  stageChangedAt: string;
  /** The practice's day of the last move, YYYY-MM-DD ("Transitioned on …"). */
  stageChangedOn: string;
  /** Days since it came in, to its disposition when it has one. */
  daysOpen: number;
  requirementsOpen: number;
  requirementsTotal: number;
  latestAcuity: PatientAcuity | null;
  triaged: boolean;
  /** The last coverage check's result, or null when none was made. */
  verification: VerificationResult | null;
  payerName: string | null;
  assignedToName: string | null;
  patientId: string | null;
  /** "21a To the partner hospice" on an NTUC referral. */
  ntucReason: string | null;
}

export interface ReferralView extends ReferralRow {
  phone: string | null;
  referringProviderNpi: string | null;
  reason: string | null;
  primaryDiagnosisIcd10: string | null;
  payerId: string | null;
  memberId: string | null;
  assignedToUserId: string | null;
  notes: string | null;
  requirements: ReferralRequirement[];
  ntucReasonCodeId: string | null;
  ntucOn: string | null;
  closedNote: string | null;
  admittedOn: string | null;
  createdByName: string | null;
  createdAt: string;
  triage: TriageView[];
  verifications: VerificationView[];
  /**
   * The practice's today when read, YYYY-MM-DD: what the forms default a day
   * to and check it against, as the server does. The browser's own day can be
   * a day ahead (a coordinator in Asia, a practice in Ohio).
   */
  practiceToday: string;
}

/** What the board counts. */
export interface ReferralSummary {
  /** Open referrals by stage, and dispositions in the last 12 months. */
  counts: Record<ReferralStage, number>;
  /** Received in the last 12 months, and how many of those were admitted. */
  received12m: number;
  admitted12m: number;
  /** admitted ÷ received, 0..1; null when nothing was received. */
  conversion: number | null;
}
