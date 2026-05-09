/**
 * Attestation types + Zod schemas.
 * Schema mirrors db/migrations/0032_phase_pallio_attestations_branding.sql.
 */
import { z } from "zod";

export const ATTESTATION_LIFECYCLES = [
  "active",
  "expired",
  "voided",
  "re_verified",
] as const;
export type AttestationLifecycle = (typeof ATTESTATION_LIFECYCLES)[number];

export const REQUEST_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "duplicate",
  "irrelevant",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const Cpt = z
  .string()
  .regex(/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/, "Invalid CPT/HCPCS");

export const CreateAttestationSchema = z.object({
  payerId: z.string().uuid(),
  state: z.string().length(2).regex(/^[A-Z]{2}$/),
  cptCode: Cpt,
  attribute: z.string().max(64),
  ruleValue: z.record(z.unknown()).optional(),
  coverageStatus: z.enum(["covered", "not_covered", "varies", "unknown"]),
  payerRepName: z.string().min(1).max(120),
  payerRepId: z.string().max(60).optional(),
  callDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  callTime: z.string().max(40).optional(),
  callPhoneNumber: z.string().max(40).optional(),
  callNotes: z.string().max(4000).optional(),
  confirmedQuote: z.string().max(2000).optional(),
  /** Optional override of the default 90-day window. */
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** When set, marks this row as superseding a previous attestation. */
  supersedesId: z.string().uuid().optional(),
});
export type CreateAttestation = z.infer<typeof CreateAttestationSchema>;

export const VoidAttestationSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export interface AttestationView {
  id: string;
  payerId: string;
  state: string;
  cptCode: string;
  attribute: string;
  ruleValue: Record<string, unknown>;
  coverageStatus: "covered" | "not_covered" | "varies" | "unknown";
  payerRepName: string;
  payerRepId: string | null;
  callDate: string;
  callTime: string | null;
  callPhoneNumber: string | null;
  callNotes: string | null;
  confirmedQuote: string | null;
  expiresAt: string;
  status: AttestationLifecycle;
  supersedesId: string | null;
  attestedByUserId: string;
  voidedByUserId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttestationRequestView {
  id: string;
  payerId: string | null;
  state: string | null;
  cptCode: string;
  attribute: string;
  sourceQuery: string | null;
  status: RequestStatus;
  resolvedAttestationId: string | null;
  claimedByUserId: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}
