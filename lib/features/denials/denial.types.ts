/**
 * Denial workflow types + Zod schemas.
 *
 * Schema mirrors db/migrations/0030_phase_pallio_denials.sql.
 */
import { z } from "zod";

export const DENIAL_DECISIONS = [
  "pending",
  "refile",
  "write_off",
  "appeal",
] as const;
export type DenialDecision = (typeof DENIAL_DECISIONS)[number];

export const DENIAL_OUTCOMES = [
  "pending",
  "paid",
  "partially_paid",
  "secondary_denial",
  "written_off",
] as const;
export type DenialOutcome = (typeof DENIAL_OUTCOMES)[number];

export const AI_RECOMMENDATIONS = [
  "refile",
  "write_off",
  "appeal",
  "unknown",
] as const;
export type AiRecommendation = (typeof AI_RECOMMENDATIONS)[number];

const Iso = z.string().datetime({ offset: true }).or(
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
);

const CARC = z.string().regex(/^[A-Z0-9]{1,4}$/i, "Invalid CARC");
const Cpt = z
  .string()
  .regex(/^([A-Z]\d{4}|\d{4}[A-Z\d]|\d{5})$/, "Invalid CPT/HCPCS");

export const LogDenialSchema = z.object({
  superbillId: z.string().uuid(),
  cptCode: Cpt,
  carcCode: CARC,
  rarcCode: z.string().max(8).optional(),
  groupCode: z.string().max(4).optional(),
  denialReason: z.string().max(2000).optional(),
  deniedAmountCents: z.number().int().min(0).optional(),
  deniedAt: Iso,
  modifiers: z.array(z.string().max(4)).max(10).optional(),
  icd10Codes: z.array(z.string().max(10)).max(20).optional(),
});
export type LogDenialInput = z.infer<typeof LogDenialSchema>;

export const DecideDenialSchema = z.object({
  decision: z.enum(["refile", "write_off", "appeal"]),
  notes: z.string().max(2000).optional(),
});

export const RefileSchema = z.object({
  refiledAt: Iso.optional(),
  notes: z.string().max(2000).optional(),
});

export const RecordOutcomeSchema = z.object({
  outcome: z.enum(["paid", "partially_paid", "secondary_denial", "written_off"]),
  outcomeAmountCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).optional(),
});

export interface DenialView {
  id: string;
  superbillId: string;
  payerId: string | null;
  cptCode: string;
  icd10Codes: string[];
  modifiers: string[];
  carcCode: string;
  rarcCode: string | null;
  groupCode: string | null;
  denialReason: string | null;
  deniedAmountCents: number;
  deniedAt: string;

  aiAnalysisText: string | null;
  aiLikelyCause: string | null;
  aiRecommendation: AiRecommendation | null;
  aiCitationDocName: string | null;
  aiCitationQuote: string | null;
  aiAnalyzedAt: string | null;
  aiModelVersion: string | null;

  decision: DenialDecision;
  decisionAt: string | null;
  decisionByUserId: string | null;
  decisionNotes: string | null;

  refiledAt: string | null;
  outcome: DenialOutcome;
  outcomeAt: string | null;
  outcomeAmountCents: number | null;
  outcomeNotes: string | null;

  createdAt: string;
  updatedAt: string;
}
