/**
 * Org rulebook types — shared between API + UI.
 */
import { z } from "zod";

export const RULEBOOK_ORIGINS = ["generated", "uploaded", "merged"] as const;
export type RulebookOrigin = (typeof RULEBOOK_ORIGINS)[number];

export const ROW_ORIGINS = [
  "source",
  "org_upload",
  "org_override",
  "analyst",
] as const;
export type RowOrigin = (typeof ROW_ORIGINS)[number];

export const COVERAGE_STATUSES = [
  "covered",
  "not_covered",
  "varies",
  "unknown",
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const RULEBOOK_ATTRIBUTES = [
  "covered",
  "prior_auth",
  "telehealth",
  "provider_type",
  "billing_limit",
  "addon_compatible",
  "documentation",
  "frequency_limit",
  "modifier_required",
] as const;
export type RulebookAttribute = (typeof RULEBOOK_ATTRIBUTES)[number];

export interface RulebookRowView {
  id: string;
  payerId: string | null;
  state: string;
  cptCode: string;
  attribute: RulebookAttribute;
  ruleValue: Record<string, unknown>;
  coverageStatus: CoverageStatus;
  origin: RowOrigin;
  confidence: number;
  sourcePayerRuleId: string | null;
  sourceQuote: string | null;
  lastEditedByUserId: string | null;
  lastEditedAt: string | null;
}

export interface RulebookView {
  id: string;
  orgId: string;
  currentVersion: number;
  origin: RulebookOrigin;
  sourceStateCodes: string[];
  sourcePayerIds: string[];
  sourceCptCodes: string[];
  finalizedAt: string;
  finalizedByUserId: string | null;
  notes: string | null;
  rows: RulebookRowView[];
}

/** Editable cell value the FE sends back on save. */
export const EditCellSchema = z.object({
  rowId: z.string().uuid(),
  ruleValue: z.record(z.unknown()),
  coverageStatus: z.enum(COVERAGE_STATUSES),
});

export const SaveRulebookSchema = z.object({
  edits: z.array(EditCellSchema).max(5000),
  /** When true, finalize the rulebook (mark onboarding rulebook_complete). */
  finalize: z.boolean().optional(),
});

/** Comparison result row used by Path B side-by-side view (§9.4.2). */
export type ComparisonOutcome =
  | "match"        // green
  | "diff"         // amber
  | "unverified"   // gray
  | "new_from_pallio"; // blue

export interface ComparisonRow {
  payerId: string | null;
  state: string;
  cptCode: string;
  attribute: RulebookAttribute;
  /** What the org's uploaded doc said (null when missing). */
  orgValue: { coverageStatus: CoverageStatus; ruleValue: Record<string, unknown> } | null;
  /** What the source library says (null when no rule exists). */
  sourceValue: {
    coverageStatus: CoverageStatus;
    ruleValue: Record<string, unknown>;
    sourceQuote: string | null;
    sourcePayerRuleId: string | null;
  } | null;
  outcome: ComparisonOutcome;
}
