/**
 * PayerRuleRepository — DOS-aware lookup of `payer_rule` rows.
 *
 * Reads global (non-RLS) reference tables — no `withOrgContext`
 * needed. Returns the most recent rule effective at the requested
 * date-of-service.
 *
 * Source: ported from
 *   backend/src/lookup/services/payer-rule.repository.ts
 * with Kysely → Prisma raw-SQL swap (the schema isn't introspected
 * yet; full `prisma db pull` lands when the live DB is available).
 */
import { prisma } from "@/lib/db";

export type PayerRuleAttribute =
  | "covered"
  | "prior_auth"
  | "telehealth"
  | "provider_type"
  | "billing_limit"
  | "addon_compatible"
  | "documentation"
  | "frequency_limit"
  | "modifier_required";

/**
 * The Pallio lookup layer uses short attribute names, but the
 * `payer_rule.attribute` column has a CHECK constraint that only
 * permits the canonical long-form names (see
 * db/migrations/0003_payers_and_rules.sql). Without this map a query
 * for `prior_auth` could never match a stored `prior_auth_required`
 * row — 6 of 9 attributes were silently un-answerable.
 */
export const ATTRIBUTE_DB_MAP: Record<PayerRuleAttribute, string> = {
  covered: "covered",
  prior_auth: "prior_auth_required",
  telehealth: "telehealth_allowed",
  provider_type: "provider_taxonomy_allowed",
  billing_limit: "units_per_period_max",
  addon_compatible: "bundled_with",
  documentation: "documentation_required",
  frequency_limit: "frequency_limit",
  modifier_required: "modifier_required",
};

export type CoverageStatus = "covered" | "not_covered" | "varies" | "unknown";

/** Mirrors the payer.payer_type CHECK in db/migrations/0003_payers_and_rules.sql. */
export type PayerType =
  | "medicare_mac"
  | "medicare_advantage_org"
  | "medicaid_state"
  | "medicaid_mco"
  | "commercial"
  | "tpa"
  | "workers_comp"
  | "auto_no_fault"
  | "tribal"
  | "self_insured"
  | "other";

export interface FetchRuleInput {
  payerId: string;
  state: string;
  productLine: string;
  code: string;
  attribute: PayerRuleAttribute;
  /** Date of service. Rules effective on or before this date win. */
  dos: Date;
}

export interface PayerRuleHit {
  ruleId: string;
  attribute: PayerRuleAttribute;
  /** JSONB rule payload — shape varies by attribute. */
  value: Record<string, unknown>;
  coverageStatus: CoverageStatus;
  confidence: number;
  effectiveDate: Date;
  expirationDate: Date | null;
  sourceDocId: string;
  sourceUrl: string | null;
  sourceQuote: string | null;
  sourcePage: number | null;
}

interface RuleRow {
  rule_id: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverage_status: CoverageStatus;
  // Postgres NUMERIC arrives as a string from the pg driver — the
  // caller maps it to a number.
  confidence: string;
  effective_date: Date;
  expiration_date: Date | null;
  source_doc_id: string;
  source_quote: string | null;
  source_page: number | null;
  source_url: string | null;
}

/**
 * Fetch the rule that's effective on `dos` for the (payer, state,
 * product_line, code, attribute) tuple. Returns null if no rule
 * matches.
 *
 * The query joins `source_document` to surface the source URL, which
 * the caller renders in the citation panel.
 */
export async function fetchPayerRule(
  input: FetchRuleInput,
): Promise<PayerRuleHit | null> {
  // The caller defaults product_line to 'commercial', but many payers
  // are Medicaid MCOs / MA orgs whose rules are stored under a
  // different product line. Rank an exact product_line match first,
  // then fall back to any product line for the same
  // payer+state+code+attribute — a cited cross-product rule beats a
  // false "unknown".
  const dbAttribute = ATTRIBUTE_DB_MAP[input.attribute] ?? input.attribute;
  const rows = await prisma.$queryRaw<RuleRow[]>`
    SELECT
      pr.id              AS rule_id,
      pr.attribute       AS attribute,
      pr.value           AS value,
      pr.coverage_status AS coverage_status,
      pr.confidence::text AS confidence,
      pr.effective_date  AS effective_date,
      pr.expiration_date AS expiration_date,
      pr.source_doc_id   AS source_doc_id,
      pr.source_quote    AS source_quote,
      pr.source_page     AS source_page,
      sd.url             AS source_url
    FROM payer_rule pr
    LEFT JOIN source_document sd ON sd.id = pr.source_doc_id
    WHERE pr.payer_id     = ${input.payerId}::uuid
      AND pr.state        = ${input.state}
      AND pr.code         = ${input.code}
      AND pr.attribute    = ${dbAttribute}
      AND pr.effective_date <= ${input.dos}
      AND (pr.expiration_date IS NULL OR pr.expiration_date > ${input.dos})
    ORDER BY
      (pr.product_line = ${input.productLine}) DESC,
      pr.effective_date DESC
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    ruleId: row.rule_id,
    attribute: row.attribute,
    value: row.value,
    coverageStatus: row.coverage_status,
    confidence: parseFloat(row.confidence),
    effectiveDate: row.effective_date,
    expirationDate: row.expiration_date,
    sourceDocId: row.source_doc_id,
    sourceUrl: row.source_url,
    sourceQuote: row.source_quote,
    sourcePage: row.source_page,
  };
}

/** Resolve payer_id → payer_type. Useful for product-line defaulting. */
export async function getPayerType(payerId: string): Promise<PayerType | null> {
  const rows = await prisma.$queryRaw<{ payer_type: PayerType }[]>`
    SELECT payer_type FROM payer WHERE id = ${payerId}::uuid LIMIT 1
  `;
  return rows[0]?.payer_type ?? null;
}

/** List all configured payers — used to populate the rule-lookup dropdown. */
export interface PayerOption {
  id: string;
  name: string;
  type: PayerType;
  states: string[];
}

export async function listPayers(): Promise<PayerOption[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      name: string;
      payer_type: PayerType;
      states_served: string[];
    }[]
  >`
    SELECT id, name, payer_type, states_served
    FROM payer
    ORDER BY name ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.payer_type,
    states: r.states_served ?? [],
  }));
}
