/**
 * Onboarding wizard state types + Zod schemas.
 *
 * Schema mirrors db/migrations/0031_phase_pallio_onboarding_rulebook.sql.
 */
import { z } from "zod";

export const ORG_TYPES = ["palliative", "hospice", "home_health"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ProfileSchema = z.object({
  name: z.string().min(2).max(120),
  npi: z.string().regex(/^\d{10}$/, "Org NPI must be 10 digits"),
  orgType: z.enum(ORG_TYPES),
  customDomain: z
    .string()
    .max(120)
    .regex(/^[a-z0-9.-]+$/i, "Lowercase letters, digits, dots, dashes only")
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const StatesSchema = z.object({
  states: z
    .array(z.string().length(2).regex(/^[A-Z]{2}$/))
    .min(1, "Pick at least one state"),
});

export const PayersSchema = z.object({
  payerIds: z.array(z.string().uuid()).min(1, "Pick at least one payer"),
});

export const CptCodesSchema = z.object({
  cptCodes: z.array(z.string().regex(/^([A-Z]\d{4}|\d{5})$/)).min(1),
});

export interface OnboardingStatusView {
  orgId: string;
  profileComplete: boolean;
  statesComplete: boolean;
  payersComplete: boolean;
  cptCodesComplete: boolean;
  rulebookComplete: boolean;
  activeStates: string[];
  activePayerIds: string[];
  orgType: OrgType | null;
  customDomain: string | null;
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
