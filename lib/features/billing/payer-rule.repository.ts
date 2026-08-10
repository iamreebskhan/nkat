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
  | "modifier_required"
  | "pos_allowed";

/**
 * The Pallio lookup layer uses short attribute names, but the
 * `payer_rule.attribute` column has a CHECK constraint that only
 * permits the canonical long-form names (see
 * db/migrations/0003_payers_and_rules.sql). Without this map a query
 * for `prior_auth` could never match a stored `prior_auth_required`
 * row — 6 of 9 attributes were silently un-answerable.
 *
 * `pos_allowed` is listed last because it was missing entirely until
 * 2026-08: the map had nine entries and the DB held 123 live
 * `pos_allowed` rules that no query could ever reach. Place of service
 * decides whether a home visit billed POS 12 gets paid, which for a
 * home-based palliative product line is not an edge case. The DB name
 * and the API name are the same, so it maps to itself.
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
  pos_allowed: "pos_allowed",
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

/**
 * Which `payer_rule.product_line` a payer's rules are filed under, given
 * only its `payer.payer_type`.
 *
 * Callers that filter product_line EXACTLY (getAllowedCodesForPayer) were
 * defaulting to 'commercial' for every payer. Measured 2026-08 on the
 * reference library: of the 268 rows in payer_allowed_codes_v, the 13
 * medicaid_mco payers have 152 rows — every one of them under
 * product_line='medicaid_mco' and ZERO under 'commercial'. The picker
 * returned an empty code list for every Medicaid MCO in the platform.
 *
 * Values are the `product_line` reference table's PKs (FK-enforced on
 * payer_rule.product_line), not invented strings.
 *
 * The four types with live data are medicaid_mco, medicare_mac, tribal and
 * commercial; the rest are the honest reading of the same reference table
 * and cost nothing to state now rather than discover as another silent
 * empty list. 'commercial' is the fallback for the administrator-style
 * types (tpa / self_insured / other) that pay on commercial terms.
 */
export const PAYER_TYPE_PRODUCT_LINE: Record<PayerType, string> = {
  medicare_mac: "medicare_ffs",
  medicare_advantage_org: "medicare_advantage",
  medicaid_state: "medicaid_ffs",
  medicaid_mco: "medicaid_mco",
  commercial: "commercial",
  tpa: "commercial",
  workers_comp: "workers_comp_state",
  auto_no_fault: "auto_no_fault",
  tribal: "tribal_638",
  self_insured: "commercial",
  other: "commercial",
};

/**
 * Default product line for a payer. Null payerType (payer not found)
 * falls back to 'commercial' — the query will return nothing for an
 * unknown payer either way, so this only picks which empty set.
 *
 * An explicit caller-supplied product line must always win over this;
 * this is the default, not an override.
 */
export function defaultProductLineForPayerType(
  payerType: PayerType | null,
): string {
  return (payerType && PAYER_TYPE_PRODUCT_LINE[payerType]) || "commercial";
}

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
  /**
   * True when this rule came from a STATE Medicaid policy rather than the
   * plan's own document. The answer is still correct — state policy
   * governs the MCOs — but the UI should say so rather than implying the
   * plan published it.
   *
   * Derived from the source document's type. It used to be
   * `payer_rule.payer_id IS NULL`, which is unreachable: payer_id is NOT
   * NULL (0 of 6,064 rows are null) and has been since 0003, so the flag
   * was hardwired false and every state-policy citation was mislabelled
   * "Payer policy document". Ingestion files one row per payer for a
   * shared state policy — the payer_id is the plan, the DOCUMENT is what
   * makes it statewide. Measured: 2,039 rules trace to a
   * `state_medicaid_manual` source document.
   */
  isStatewide: boolean;
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
  is_statewide: boolean;
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
  // Callers derive product_line from the payer's payer_type
  // (defaultProductLineForPayerType), but a payer's rules can still be
  // filed under a neighbouring line. Rank an exact product_line match
  // first, then fall back to any product line for the same
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
      sd.url             AS source_url,
      -- See PayerRuleHit.isStatewide. A shared state policy is ingested
      -- once per payer, so "statewide" is a property of the DOCUMENT.
      COALESCE(sd.document_type = 'state_medicaid_manual', FALSE) AS is_statewide
    FROM payer_rule pr
    LEFT JOIN source_document sd ON sd.id = pr.source_doc_id
    WHERE pr.state        = ${input.state}
      AND pr.code         = ${input.code}
      AND pr.attribute    = ${dbAttribute}
      AND pr.effective_date <= ${input.dos}
      AND (pr.expiration_date IS NULL OR pr.expiration_date > ${input.dos})
      -- One payer, one rule. There used to be a second branch here on
      -- "pr.payer_id IS NULL", described as a statewide-Medicaid fallback
      -- where one ingestion of a state policy answered for every MCO.
      -- It could never match — payer_id is NOT NULL — and the premise was
      -- wrong: ingestion writes one row PER PAYER for a shared state
      -- policy (2,039 such rules today, all with a payer_id), which
      -- already gives every MCO its own answer. Making payer_id nullable
      -- to revive the branch would buy nothing and would put a NULL into
      -- the (payer_id, state, code, attribute) uniqueness invariant the
      -- whole library rests on.
      AND pr.payer_id = ${input.payerId}::uuid
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
    isStatewide: row.is_statewide,
  };
}

export interface BenchmarkHit extends PayerRuleHit {
  payerName: string;
  payerType: PayerType;
}

/**
 * Reference rules for the same code and state from OTHER payers, used
 * when the requested payer has no published rule of its own.
 *
 * This is what a biller does by hand: a commercial plan publishes no
 * public fee schedule, so you look at what Medicare and the state
 * Medicaid programme pay to sanity-check the code before billing. It is
 * decision support, NOT an assertion about the requested payer — callers
 * must label it as a benchmark and must not present it as the payer's
 * rule.
 *
 * Medicare first (the universal reference), then a state Medicaid plan.
 */
export async function fetchBenchmarkRules(input: {
  state: string;
  code: string;
  attribute: PayerRuleAttribute;
  dos: Date;
  excludePayerId: string;
}): Promise<BenchmarkHit[]> {
  const dbAttribute = ATTRIBUTE_DB_MAP[input.attribute] ?? input.attribute;
  const rows = await prisma.$queryRaw<(RuleRow & { payer_name: string; payer_type: PayerType })[]>`
    SELECT
      pr.id AS rule_id, pr.attribute, pr.value, pr.coverage_status,
      pr.confidence::text AS confidence, pr.effective_date, pr.expiration_date,
      pr.source_doc_id, pr.source_quote, pr.source_page,
      sd.url AS source_url,
      COALESCE(sd.document_type = 'state_medicaid_manual', FALSE) AS is_statewide,
      p.name AS payer_name, p.payer_type
    FROM payer_rule pr
    JOIN payer p ON p.id = pr.payer_id
    LEFT JOIN source_document sd ON sd.id = pr.source_doc_id
    WHERE pr.state     = ${input.state}
      AND pr.code      = ${input.code}
      AND pr.attribute = ${dbAttribute}
      AND pr.payer_id <> ${input.excludePayerId}::uuid
      AND pr.effective_date <= ${input.dos}
      AND (pr.expiration_date IS NULL OR pr.expiration_date > ${input.dos})
      AND pr.coverage_status <> 'unknown'
    ORDER BY
      -- Medicare is the reference every payer is compared against.
      (p.payer_type = 'medicare_mac') DESC,
      pr.confidence DESC,
      pr.effective_date DESC
    LIMIT 2
  `;

  return rows.map((row) => ({
    ruleId: row.rule_id,
    attribute: input.attribute,
    value: row.value,
    coverageStatus: row.coverage_status,
    confidence: parseFloat(row.confidence),
    effectiveDate: row.effective_date,
    expirationDate: row.expiration_date,
    sourceDocId: row.source_doc_id,
    sourceUrl: row.source_url,
    sourceQuote: row.source_quote,
    sourcePage: row.source_page,
    isStatewide: row.is_statewide,
    payerName: row.payer_name,
    payerType: row.payer_type,
  }));
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
