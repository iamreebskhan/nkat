/**
 * Patient types + Zod schemas — shared between API routes and UI forms.
 *
 * Schema mirrors db/migrations/0029_phase_pallio_emr.sql.
 */
import { z } from "zod";

import { CONTACT_RELATIONSHIPS, NpiSchema, PhoneSchema } from "./contacts.types";
import { EthnicitySchema, PreferredLanguageSchema, RaceSchema } from "./uscdi";
import { normalizeIcd10 } from "@/lib/features/billing/icd10-format";
import type { PayerType } from "@/lib/features/billing/payer-types";
import type { ProlongedServiceCode } from "@/lib/features/billing/prolonged-code";

// Re-exported: the patient's own number, the emergency contact's, and every
// contact's and outside provider's share one rule (audit R30).
export { PhoneSchema };

export const PATIENT_STATUSES = [
  "active",
  "discharged",
  "deceased",
  "archived",
] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export const SEX_AT_BIRTH = ["M", "F", "X", "unknown"] as const;
export type SexAtBirth = (typeof SEX_AT_BIRTH)[number];

const StateAbbr = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "Use the 2-letter USPS abbreviation");

/**
 * The primary diagnosis, in the shape both diagnosis pickers accept and stored
 * dotted, as they store it (normalizeIcd10). /^[A-Z]\d{2}(\.\d{1,4})?$/i
 * refused real codes such as C7A.1 and S72.001A and an undotted "I509", and
 * kept a lowercase code as typed, which then matched nothing the visit's
 * diagnosis search returns.
 */
const Icd10 = z
  .string()
  .refine((s) => normalizeIcd10(s) !== null, "Not an ICD-10-CM code — for example C34.90")
  .transform((s) => normalizeIcd10(s) as string);
/** The same rule, for a referral's diagnosis (lib/features/referrals). */
export const Icd10Schema = Icd10;

const NameSchema = z
  .string()
  .min(1, "Required")
  .max(100, "Too long")
  .trim();

/** Step 1 — demographics. */
export const DemographicsSchema = z.object({
  firstName: NameSchema,
  lastName: NameSchema,
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  sexAssignedAtBirth: z.enum(SEX_AT_BIRTH).optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: StateAbbr.optional(),
  zip: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/, "ZIP: 5 digits, optional -4")
    .optional(),
  phone: PhoneSchema.optional(),
  /** USCDI (0128): each may be declined, which is an answer. */
  raceCodes: RaceSchema.optional(),
  ethnicity: EthnicitySchema.optional(),
  preferredLanguage: PreferredLanguageSchema.optional(),
  /**
   * The intake wizard's emergency contact. Create-only: createPatient files it
   * as a patient_contact row (audit R30), and from then on it is edited on the
   * chart's Family & caregivers card, never through PATCH /api/patients.
   */
  emergencyContactName: z.string().trim().max(120).optional(),
  emergencyContactPhone: PhoneSchema.optional(),
  emergencyContactRelationship: z.enum(CONTACT_RELATIONSHIPS).optional(),
});
export type Demographics = z.infer<typeof DemographicsSchema>;

/** Step 2 — insurance. */
export const InsuranceSchema = z.object({
  primaryPayerId: z.string().uuid().optional(),
  primaryMemberId: z.string().min(1).max(120).optional(),
  primaryGroupNumber: z.string().max(100).optional(),
  /**
   * State the POLICY is issued in — drives payer-rule lookups together with
   * primaryPayerId. Falls back to the patient's address state when absent.
   */
  insuranceState: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "Use the 2-letter USPS code")
    .transform((s) => s.toUpperCase())
    .optional(),
  insuranceEffectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  insuranceTerminationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * Secondary coverage (Mark Q11g default, 0109): captured even though Pallio
   * may never bill it, because the billing software needs it on the claim.
   */
  secondaryPayerId: z.string().uuid().optional(),
  secondaryMemberId: z.string().min(1).max(120).optional(),
  secondaryGroupNumber: z.string().max(100).optional(),
});
export type Insurance = z.infer<typeof InsuranceSchema>;

/** Step 3 — clinical context. */
export const ClinicalSchema = z.object({
  primaryDiagnosisIcd10: Icd10.optional(),
  /**
   * Create-only, like the emergency contact: createPatient files the pair on
   * the org's outside-provider roster and links it as the referring physician
   * (audit R30). The NPI must pass its check digit, as a roster NPI does.
   */
  referringPhysicianNpi: NpiSchema.optional(),
  referringPhysicianName: z.string().trim().max(150).optional(),
  palliativeReferralReason: z.string().max(2000).optional(),
  /** Phase D — palliative-care acuity. */
  acuity: z.enum(["low", "medium", "high", "critical"]).optional(),
});
export type Clinical = z.infer<typeof ClinicalSchema>;
export const PATIENT_ACUITIES = ["low", "medium", "high", "critical"] as const;
export type PatientAcuity = (typeof PATIENT_ACUITIES)[number];
export const PATIENT_ACUITY_LABEL: Record<PatientAcuity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

/** Step 4 — consents (boolean acknowledgments + signature strings). */
export const ConsentsSchema = z.object({
  hipaaAcknowledged: z.boolean(),
  goalsOfCareConsent: z.boolean(),
  telehealthConsent: z.boolean(),
  /** Free-text signature line — typed by patient or care team. */
  signedBy: z.string().max(150).optional(),
  signedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
});
export type Consents = z.infer<typeof ConsentsSchema>;

/**
 * Step 5 — care team assignment. Persisted on the patient row (migration
 * 0054); every assignee must be a member of the patient's org (service-
 * enforced). All optional — a patient may have any subset assigned.
 */
export const CareTeamSchema = z.object({
  primaryNpUserId: z.string().uuid().optional(),
  rnUserId: z.string().uuid().optional(),
  socialWorkerUserId: z.string().uuid().optional(),
  chaplainUserId: z.string().uuid().optional(),
  billingAgentUserId: z.string().uuid().optional(),
});
export type CareTeam = z.infer<typeof CareTeamSchema>;

/**
 * PATCH variant — tri-state per field: absent = keep, null = unassign,
 * uuid = reassign. (The create schema has no nulls: absent simply means
 * "not assigned yet".)
 */
export const UpdateCareTeamSchema = z.object({
  primaryNpUserId: z.string().uuid().nullable().optional(),
  rnUserId: z.string().uuid().nullable().optional(),
  socialWorkerUserId: z.string().uuid().nullable().optional(),
  chaplainUserId: z.string().uuid().nullable().optional(),
  billingAgentUserId: z.string().uuid().nullable().optional(),
});
export type UpdateCareTeam = z.infer<typeof UpdateCareTeamSchema>;

/** One assigned care-team seat as the API returns it. */
export interface CareTeamMemberView {
  userId: string | null;
  /** Display name (app_user.full_name, falling back to email) — resolved on detail reads. */
  name: string | null;
}

/** Full payload for POST /api/patients (server merges + persists). */
export const CreatePatientSchema = z.object({
  demographics: DemographicsSchema,
  insurance: InsuranceSchema,
  clinical: ClinicalSchema,
  consents: ConsentsSchema,
  careTeam: CareTeamSchema,
  /**
   * The referral this intake admits (Level-1 doc:25, 0111). The patient is
   * created and the referral marked admitted in one transaction, or neither.
   */
  referralId: z.string().uuid().optional(),
});
export type CreatePatient = z.infer<typeof CreatePatientSchema>;

/** Patient row as the API returns it. */
export interface PatientView {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sexAssignedAtBirth: SexAtBirth | null;
  /** USCDI (0128). Empty or null: never asked. Resolved on detail reads. */
  raceCodes: string[];
  ethnicity: string | null;
  preferredLanguage: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  primaryPayerId: string | null;
  /** Payer display name — resolved on detail reads (list reads carry the id only). */
  primaryPayerName: string | null;
  /**
   * The payer's payer_type, resolved on detail reads (list reads carry null);
   * null when there is no payer. Picks the prolonged-service code (audit R17):
   * Medicare and Medicare Advantage bill that time as G0318, everyone else as
   * 99417. It is read off the patient's own payer, active or not, because a
   * payer withdrawn from the roster still covers the patients already on it,
   * and the active-only payer list would call them non-Medicare.
   */
  primaryPayerType: PayerType | null;
  /**
   * The prolonged-service code the payer's record names (0108), resolved on
   * detail reads like the type; null when it names none, so the type decides
   * (prolongedServiceCodeFor). Set where a payer takes the other code than its
   * type would, e.g. an Ohio Medicaid managed-care plan that takes G0318.
   */
  primaryPayerProlongedCode: ProlongedServiceCode | null;
  primaryMemberId: string | null;
  /** Policy state; falls back to the address state for rule lookups. */
  insuranceState: string | null;
  primaryDiagnosisIcd10: string | null;
  acuity: PatientAcuity | null;
  /**
   * Detail reads only (getPatient); list reads leave these undefined. They are
   * what the chart's edit forms start from, and the referral reason, which
   * intake stored and nothing showed again (audit 27 Oct, doc:22).
   */
  addressLine2?: string | null;
  primaryGroupNumber?: string | null;
  insuranceEffectiveDate?: string | null;
  insuranceTerminationDate?: string | null;
  palliativeReferralReason?: string | null;
  secondaryPayerId?: string | null;
  secondaryPayerName?: string | null;
  secondaryMemberId?: string | null;
  secondaryGroupNumber?: string | null;
  /** Intake consents (0109): when each was recorded, ISO; null = not recorded. */
  hipaaAcknowledgedAt?: string | null;
  goalsOfCareConsentAt?: string | null;
  consentSignedBy?: string | null;
  /** The referral this patient was admitted from (0111); detail read only. */
  referral?: { id: string; receivedOn: string; sourceName: string | null } | null;
  /** Most recent completed/started visit (ISO date) — caseload column. */
  lastVisitDate: string | null;
  /** Next upcoming scheduled visit (ISO date) — caseload column. */
  nextVisitDate: string | null;
  /** Assigned care team. Names are resolved on detail reads; list reads carry ids only. */
  careTeam: {
    primaryNp: CareTeamMemberView;
    rn: CareTeamMemberView;
    socialWorker: CareTeamMemberView;
    chaplain: CareTeamMemberView;
    billingAgent: CareTeamMemberView;
  };
  /**
   * When the patient consented to telehealth at intake (audit R22), as an ISO
   * timestamp; null = not recorded. It pre-ticks, and never replaces, each
   * telehealth visit's own consent acknowledgment. Resolved on detail reads;
   * list reads carry null.
   */
  telehealthConsentAt: string | null;
  status: PatientStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * The intake telehealth consent that pre-ticks a visit's own consent box
 * (audit R22), or null when it must not. Only an open visit (scheduled or in
 * progress) that is telehealth, by its box or by its type, and has no consent
 * of its own yet takes it: a signed visit shows only what was attested. The
 * tick is where the clinician starts, not a substitute for their answer; the
 * server still refuses to sign a telehealth visit whose own flag is unset.
 */
export function intakeTelehealthConsentFor(
  visit: {
    status: string;
    isTelehealth: boolean;
    visitTypeIsTelehealth: boolean;
    telehealthConsentDocumented: boolean;
  },
  patient: Pick<PatientView, "telehealthConsentAt">,
): string | null {
  const open = visit.status === "scheduled" || visit.status === "in_progress";
  const tele = visit.isTelehealth || visit.visitTypeIsTelehealth;
  if (!open || !tele || visit.telehealthConsentDocumented) return null;
  return patient.telehealthConsentAt;
}

/**
 * PATCH shape — every field optional, schema-validated subset of CreatePatient.
 *
 * The emergency contact and the referring physician are not in it (audit
 * R30): they live in patient_contact and patient_external_provider and are
 * edited through their own endpoints. .strict() makes a PATCH that still
 * sends them fail with a 422 naming the key. Stripping them silently would
 * repeat the drop this replaced, where the demographics branch discarded all
 * but name and DOB while its audit row said demographics had changed.
 *
 * TRI-STATE for every optional field: absent = keep, null = clear, a value =
 * set. The chart had no edit screen, and the update wrote COALESCE(new, old),
 * so a wrong phone number or group number could be replaced but never removed.
 * Name and date of birth stay required: they can be corrected, not cleared.
 */
const nullable = <T extends z.ZodTypeAny>(s: T) => s.nullable();
export const UpdatePatientSchema = z.object({
  demographics: z
    .object({
      firstName: NameSchema,
      lastName: NameSchema,
      dateOfBirth: DemographicsSchema.shape.dateOfBirth,
      sexAssignedAtBirth: nullable(z.enum(SEX_AT_BIRTH)),
      addressLine1: nullable(z.string().max(200)),
      addressLine2: nullable(z.string().max(200)),
      city: nullable(z.string().max(100)),
      state: nullable(StateAbbr),
      zip: nullable(z.string().regex(/^\d{5}(-\d{4})?$/, "ZIP: 5 digits, optional -4")),
      phone: nullable(PhoneSchema),
      // An empty list clears race, as null clears the others.
      raceCodes: RaceSchema,
      ethnicity: nullable(EthnicitySchema),
      preferredLanguage: nullable(PreferredLanguageSchema),
    })
    .partial()
    .strict()
    .optional(),
  insurance: z
    .object({
      // The primary payer can be changed but not removed from here: a patient
      // whose plan ended is a coverage change, not a blank.
      primaryPayerId: z.string().uuid(),
      primaryMemberId: nullable(z.string().min(1).max(120)),
      primaryGroupNumber: nullable(z.string().max(100)),
      insuranceState: InsuranceSchema.shape.insuranceState.unwrap(),
      insuranceEffectiveDate: nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
      insuranceTerminationDate: nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
      secondaryPayerId: nullable(z.string().uuid()),
      secondaryMemberId: nullable(z.string().min(1).max(120)),
      secondaryGroupNumber: nullable(z.string().max(100)),
    })
    .partial()
    .strict()
    .optional(),
  clinical: z
    .object({
      primaryDiagnosisIcd10: nullable(Icd10),
      palliativeReferralReason: nullable(z.string().max(2000)),
      acuity: ClinicalSchema.shape.acuity.unwrap(),
    })
    .partial()
    .strict()
    .optional(),
  /**
   * Consents recorded or withdrawn after intake (0109). true stamps now, unless
   * one is already recorded; false clears it. signedBy is the signature line.
   */
  consents: z
    .object({
      hipaaAcknowledged: z.boolean(),
      goalsOfCareConsent: z.boolean(),
      telehealthConsent: z.boolean(),
      signedBy: nullable(z.string().trim().max(150)),
    })
    .partial()
    .strict()
    .optional(),
  careTeam: UpdateCareTeamSchema.optional(),
  status: z.enum(PATIENT_STATUSES).optional(),
});
export type UpdatePatient = z.infer<typeof UpdatePatientSchema>;
