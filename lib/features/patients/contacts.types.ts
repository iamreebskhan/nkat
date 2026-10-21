/**
 * Family, caregivers and outside providers on a patient (audit R30): types and
 * Zod schemas shared by the API routes, the chart cards and the intake wizard.
 *
 * The chart held one unlabelled emergency-contact pair and one referring
 * physician. Mark's patients have a daughter-in-law who is the caregiver, a
 * nephew who holds power of attorney, and a PCP, a pulmonologist and an
 * oncologist in the header of every note. These are the shapes for all of
 * them.
 *
 * Pure (no IO), so client components can import it. Schema mirrors
 * db/migrations/0103_patient_contacts_and_external_providers.sql.
 */
import { z } from "zod";

import { isValidNpi } from "@/lib/features/team/clinician";

/** A phone number as the patient's own number is validated. */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^[\d\s().+-]{7,20}$/, "Invalid phone");

// ---------------------------------------------------------------------------
// Family and caregivers
// ---------------------------------------------------------------------------

/** Kept in step with the CHECK on patient_contact.relationship. */
export const CONTACT_RELATIONSHIPS = [
  "spouse",
  "partner",
  "child",
  "child_in_law",
  "parent",
  "sibling",
  "grandchild",
  "niece_nephew",
  "other_family",
  "friend",
  "paid_caregiver",
  "facility_staff",
  "other",
] as const;
export type ContactRelationship = (typeof CONTACT_RELATIONSHIPS)[number];

export const CONTACT_RELATIONSHIP_LABELS: Record<ContactRelationship, string> = {
  spouse: "Spouse",
  partner: "Partner",
  child: "Child",
  child_in_law: "Child-in-law",
  parent: "Parent",
  sibling: "Sibling",
  grandchild: "Grandchild",
  niece_nephew: "Niece/nephew",
  other_family: "Other family",
  friend: "Friend",
  paid_caregiver: "Paid caregiver",
  facility_staff: "Facility staff",
  other: "Other",
};

// .trim() first: zod v3 runs checks in order, so a name of spaces is refused.
const ContactName = z.string().trim().min(1, "Required").max(120, "Too long");
const Email = z.string().trim().email("Invalid email").max(254, "Too long");
const ContactNotes = z.string().trim().max(500, "Keep notes under 500 characters");

export const PatientContactSchema = z.object({
  fullName: ContactName,
  relationship: z.enum(CONTACT_RELATIONSHIPS),
  phone: PhoneSchema.optional(),
  altPhone: PhoneSchema.optional(),
  email: Email.optional(),
  isPrimaryCaregiver: z.boolean().default(false),
  isEmergencyContact: z.boolean().default(false),
  /** At most one per patient: the service refuses a second and names the first. */
  isHealthcarePoa: z.boolean().default(false),
  livesWithPatient: z.boolean().default(false),
  notes: ContactNotes.optional(),
});
export type PatientContact = z.infer<typeof PatientContactSchema>;
export type PatientContactInput = z.input<typeof PatientContactSchema>;

/**
 * PATCH variant — tri-state for the optional text fields, like
 * UpdateCareTeamSchema: absent = keep, null = clear, value = set. An empty
 * patch is refused rather than reported as a change.
 */
export const UpdatePatientContactSchema = z
  .object({
    fullName: ContactName.optional(),
    relationship: z.enum(CONTACT_RELATIONSHIPS).optional(),
    phone: PhoneSchema.nullable().optional(),
    altPhone: PhoneSchema.nullable().optional(),
    email: Email.nullable().optional(),
    isPrimaryCaregiver: z.boolean().optional(),
    isEmergencyContact: z.boolean().optional(),
    isHealthcarePoa: z.boolean().optional(),
    livesWithPatient: z.boolean().optional(),
    notes: ContactNotes.nullable().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "Nothing to change.",
  });
export type UpdatePatientContact = z.infer<typeof UpdatePatientContactSchema>;

export interface PatientContactView {
  id: string;
  fullName: string;
  relationship: ContactRelationship;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  isPrimaryCaregiver: boolean;
  isEmergencyContact: boolean;
  isHealthcarePoa: boolean;
  livesWithPatient: boolean;
  notes: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Outside providers
// ---------------------------------------------------------------------------

/** Kept in step with the CHECK on patient_external_provider.role. */
export const EXTERNAL_PROVIDER_ROLES = ["primary_care", "referring", "specialist", "other"] as const;
export type ExternalProviderRole = (typeof EXTERNAL_PROVIDER_ROLES)[number];

export const EXTERNAL_PROVIDER_ROLE_LABELS: Record<ExternalProviderRole, string> = {
  primary_care: "Primary care provider",
  referring: "Referring physician",
  specialist: "Specialist",
  other: "Other",
};

/**
 * Ten digits and a valid check digit, the rule the clinician NPI uses (audit
 * R40), so a transposed digit is caught here rather than by a payer.
 */
export const NpiSchema = z
  .string()
  .trim()
  .regex(/^\d{10}$/, "NPI must be 10 digits")
  .refine(isValidNpi, "That NPI fails its check digit. Re-check the number.");

const ProviderName = z.string().trim().min(1, "Required").max(150, "Too long");
const ProviderText = (max: number) => z.string().trim().max(max, "Too long");

export const ExternalProviderSchema = z.object({
  fullName: ProviderName,
  npi: NpiSchema.optional(),
  specialty: ProviderText(120).optional(),
  practiceName: ProviderText(150).optional(),
  phone: PhoneSchema.optional(),
  fax: PhoneSchema.optional(),
});
export type ExternalProviderInput = z.infer<typeof ExternalProviderSchema>;

/**
 * PATCH on a roster entry: fixes a phone or fax once, for every patient that
 * refers to this provider. Optional text is tri-state, as for contacts.
 */
export const UpdateExternalProviderSchema = z
  .object({
    fullName: ProviderName.optional(),
    npi: NpiSchema.nullable().optional(),
    specialty: ProviderText(120).nullable().optional(),
    practiceName: ProviderText(150).nullable().optional(),
    phone: PhoneSchema.nullable().optional(),
    fax: PhoneSchema.nullable().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "Nothing to change.",
  });
export type UpdateExternalProvider = z.infer<typeof UpdateExternalProviderSchema>;

/**
 * Link a provider to a patient: either one already on the org's roster, or a
 * new one described inline (which is added to the roster, or matched to the
 * roster row with the same NPI). Exactly one of the two.
 */
export const LinkExternalProviderSchema = z
  .object({
    role: z.enum(EXTERNAL_PROVIDER_ROLES),
    /** Required for a specialist (e.g. "Pulmonologist"); optional for other. */
    roleLabel: z.string().trim().min(1).max(80, "Too long").optional(),
    externalProviderId: z.string().uuid().optional(),
    provider: ExternalProviderSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.externalProviderId) === Boolean(v.provider)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalProviderId"],
        message: "Pick a provider from your roster, or describe a new one, but not both.",
      });
    }
    if (v.role === "specialist" && !v.roleLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roleLabel"],
        message: "Name the specialty, e.g. Pulmonologist.",
      });
    }
  });
export type LinkExternalProvider = z.infer<typeof LinkExternalProviderSchema>;

export interface ExternalProviderView {
  id: string;
  fullName: string;
  npi: string | null;
  specialty: string | null;
  practiceName: string | null;
  phone: string | null;
  fax: string | null;
}

export interface PatientProviderView {
  linkId: string;
  role: ExternalProviderRole;
  roleLabel: string | null;
  provider: ExternalProviderView;
}
