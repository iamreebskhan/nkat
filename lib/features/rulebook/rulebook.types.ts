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
  /** Human-readable payer name from the payer table (LEFT JOIN). */
  payerName: string | null;
  /** payer.payer_type (commercial / medicaid_mco / …). */
  payerType: string | null;
  state: string;
  cptCode: string;
  /** 'CPT' | 'HCPCS2' — null when the code isn't in the global table. */
  codeSystem: string | null;
  /**
   * Short descriptor for the code. Server AMA-gated: CPT descriptors
   * are replaced by "[AMA license required]" until AMA_LICENSE_TOKEN
   * is set; HCPCS (public domain) shows the real text.
   */
  cptDescription: string | null;
  attribute: RulebookAttribute;
  ruleValue: Record<string, unknown>;
  coverageStatus: CoverageStatus;
  origin: RowOrigin;
  confidence: number;
  sourcePayerRuleId: string | null;
  sourceQuote: string | null;
  /**
   * Raw `payer_rule.created_by` text for the underlying source rule,
   * if any. Format: 'crawler:<doc_type>' | 'analyst:<userId>' | 'ai'
   * | analyst-email | 'test@…' for seed rows.
   */
  sourceCreatedBy: string | null;
  /**
   * Server-derived provenance bucket. One of:
   *   - 'crawler'  — payer_rule from CMS / payer URL ingestion
   *   - 'analyst'  — analyst-attested call
   *   - 'ai'       — AI-synthesized + auto-persisted (low confidence)
   *   - 'org'      — Path B upload or inline org override
   *   - 'manual'   — payer_rule with an analyst-email created_by
   *                  (legacy / explicit analyst entry)
   *   - 'unknown'  — origin='source' with no linked payer_rule (rare;
   *                  shouldn't happen post-regenerate)
   */
  sourceKind: "crawler" | "analyst" | "ai" | "org" | "manual" | "unknown";
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
/**
 * Conventional shape for `rule_value` JSONB when the org edits a cell
 * inline. Callers are not required to use this shape (the column is
 * an open JSON record), but the UI does, and rendering checks for
 * these keys. Keeping it explicit avoids the "every edit means
 * something different" drift.
 */
export interface OrgRuleValue {
  /** Plain-English summary, shown as the row's primary text. */
  answer?: string;
  /** Free-text the editor typed (e.g. payer-call notes). */
  notes?: string;
  /** Where the editor learned this (payer_call/contract/portal/other). */
  source?: "payer_call" | "contract" | "portal" | "other";
  /** Who confirmed it — human-readable name. */
  verifiedBy?: string;
  /** ISO date the verification happened. */
  verifiedAt?: string;
}

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
