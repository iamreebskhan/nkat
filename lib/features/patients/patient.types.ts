/**
 * Patient types + Zod schemas — shared between API routes and UI forms.
 *
 * Schema mirrors db/migrations/0029_phase_pallio_emr.sql.
 */
import { z } from "zod";

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

const Icd10 = z.string().regex(/^[A-Z]\d{2}(\.\d{1,4})?$/i, "Invalid ICD-10");
const Npi = z.string().regex(/^\d{10}$/, "NPI must be 10 digits");

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
  phone: z
    .string()
    .regex(/^[\d\s().+-]{7,20}$/, "Invalid phone")
    .optional(),
  emergencyContactName: z.string().max(120).optional(),
  emergencyContactPhone: z
    .string()
    .regex(/^[\d\s().+-]{7,20}$/, "Invalid phone")
    .optional(),
});
export type Demographics = z.infer<typeof DemographicsSchema>;

/** Step 2 — insurance. */
export const InsuranceSchema = z.object({
  primaryPayerId: z.string().uuid().optional(),
  primaryMemberId: z.string().min(1).max(120).optional(),
  primaryGroupNumber: z.string().max(100).optional(),
  insuranceEffectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  insuranceTerminationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type Insurance = z.infer<typeof InsuranceSchema>;

/** Step 3 — clinical context. */
export const ClinicalSchema = z.object({
  primaryDiagnosisIcd10: Icd10.optional(),
  referringPhysicianNpi: Npi.optional(),
  referringPhysicianName: z.string().max(150).optional(),
  palliativeReferralReason: z.string().max(2000).optional(),
  /** Phase D — palliative-care acuity. */
  acuity: z.enum(["low", "medium", "high", "critical"]).optional(),
});
export type Clinical = z.infer<typeof ClinicalSchema>;
export const PATIENT_ACUITIES = ["low", "medium", "high", "critical"] as const;
export type PatientAcuity = (typeof PATIENT_ACUITIES)[number];

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

/** Step 5 — care team assignment. */
export const CareTeamSchema = z.object({
  primaryNpUserId: z.string().uuid().optional(),
  rnUserId: z.string().uuid().optional(),
  socialWorkerUserId: z.string().uuid().optional(),
  billingAgentUserId: z.string().uuid().optional(),
});
export type CareTeam = z.infer<typeof CareTeamSchema>;

/** Full payload for POST /api/patients (server merges + persists). */
export const CreatePatientSchema = z.object({
  demographics: DemographicsSchema,
  insurance: InsuranceSchema,
  clinical: ClinicalSchema,
  consents: ConsentsSchema,
  careTeam: CareTeamSchema,
});
export type CreatePatient = z.infer<typeof CreatePatientSchema>;

/** Patient row as the API returns it. */
export interface PatientView {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sexAssignedAtBirth: SexAtBirth | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  primaryPayerId: string | null;
  primaryMemberId: string | null;
  primaryDiagnosisIcd10: string | null;
  acuity: PatientAcuity | null;
  status: PatientStatus;
  createdAt: string;
  updatedAt: string;
}

/** PATCH shape — every field optional, schema-validated subset of CreatePatient. */
export const UpdatePatientSchema = z.object({
  demographics: DemographicsSchema.partial().optional(),
  insurance: InsuranceSchema.partial().optional(),
  clinical: ClinicalSchema.partial().optional(),
  status: z.enum(PATIENT_STATUSES).optional(),
});
export type UpdatePatient = z.infer<typeof UpdatePatientSchema>;
