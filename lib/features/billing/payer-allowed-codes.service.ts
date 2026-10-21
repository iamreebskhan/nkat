/**
 * Payer allowed-codes service.
 *
 * Phase 0.2 of the EMR-pivot plan (2026-05-23). Powers:
 *   * Phase A — the payer-scoped CPT picker on the super-bill UI.
 *   * Phase B — the pre-submission denial predictor (which calls this
 *               to know whether a draft line uses a covered code).
 *
 * Reads from the `payer_allowed_codes_v` view (migration 0041). The
 * view is global (no RLS) — payer rules are reference data shared
 * across every org.
 *
 * Result is cached in-process for 60 seconds per (payerId, state, dos)
 * key. Payer rules move daily at most, so this is safe and keeps the
 * picker snappy even during a busy charting session.
 */
import { prisma } from "@/lib/db";
import { payerRuleSourceKind } from "@/lib/features/rulebook/rulebook-pure";

import { gateDescriptor, isAmaPlaceholder } from "./code-pure";
import { hasAmaLicense } from "./code.service";

/** Hint badges the picker shows next to each code. */
export type SourceKind = "crawler" | "analyst" | "ai" | "manual" | "unknown";

export interface AllowedCode {
  payerId: string;
  state: string;
  productLine: string;
  code: string;
  descriptor: string;
  category: string | null;
  codeSystem: "CPT" | "HCPCS2";
  coverageStatus: "covered" | "varies" | "not_covered" | "unknown";
  confidence: number;
  sourceKind: SourceKind;
  /** ISO date — when this rule started being in effect. */
  effectiveDate: string;
  /** Provenance: human-readable last-verified info. */
  ruleCreatedAt: string;
  createdBy: string;
  sourceDocId: string;
  sourceQuote: string | null;
  /** Picker hints — null means "no rule on file for this hint." */
  modifierRequired: boolean;
  priorAuthRequired: boolean;
  hasFrequencyLimit: boolean;
  frequencyLimitValue: string | null;
  priorAuthValue: string | null;
}

interface ViewRow {
  payer_id: string;
  state: string;
  product_line: string;
  code: string;
  descriptor: string;
  category: string | null;
  code_system: "CPT" | "HCPCS2";
  coverage_status: "covered" | "varies" | "not_covered" | "unknown";
  confidence: string; // numeric(3,2) comes back as string from Prisma raw
  effective_date: Date;
  rule_created_at: Date;
  created_by: string;
  source_doc_id: string;
  source_quote: string | null;
  source_kind: SourceKind;
  modifier_required: boolean;
  prior_auth_required: boolean;
  has_frequency_limit: boolean;
  frequency_limit_value: string | null;
  prior_auth_value: string | null;
}

interface CacheEntry {
  expiresAt: number;
  rows: AllowedCode[];
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(args: {
  payerId: string;
  state: string;
  dos: string;
  productLine: string;
}): string {
  return `${args.payerId}|${args.state}|${args.productLine}|${args.dos}`;
}

/**
 * Get every code the payer covers in `state` on `dos` (date of service).
 *
 * `productLine` defaults to 'commercial' — the picker can ask for a
 * different line (e.g. 'medicare_part_b') by passing it explicitly.
 * `dos` defaults to today.
 *
 * Returns rows sorted by category then code so the picker can group.
 */
export async function getAllowedCodesForPayer(args: {
  payerId: string;
  state: string;
  /** YYYY-MM-DD; defaults to today. Used to filter expired rules. */
  dos?: string;
  productLine?: string;
  /**
   * Phase A "show all" mode — also return codes where coverage_status
   * is 'not_covered' or 'unknown'. By default (false) the picker only
   * surfaces covered/varies codes so denied codes don't appear in the
   * autocomplete; the nurse can flip it on to bypass when they need to
   * add a denied code anyway (which still triggers the override modal).
   */
  includeDenied?: boolean;
}): Promise<AllowedCode[]> {
  const dos = args.dos ?? new Date().toISOString().slice(0, 10);
  const productLine = args.productLine ?? "commercial";
  const includeDenied = args.includeDenied ?? false;
  const key = cacheKey({ ...args, dos, productLine }) + (includeDenied ? "|denied" : "");

  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  // Use the view. The view already filters to active+covered rules,
  // but we still respect `dos` here so a request for a historic date
  // (denial review, audit) returns the right set.
  const statusFilter = includeDenied
    ? ["covered", "varies", "not_covered", "unknown"]
    : ["covered", "varies"];
  const rows = await prisma.$queryRaw<ViewRow[]>`
    SELECT
      payer_id, state, product_line, code,
      descriptor, category, code_system,
      coverage_status, confidence,
      effective_date, rule_created_at, created_by,
      source_doc_id, source_quote, source_kind,
      modifier_required, prior_auth_required,
      has_frequency_limit, frequency_limit_value, prior_auth_value
    FROM payer_allowed_codes_v
    WHERE payer_id = ${args.payerId}::uuid
      AND state    = ${args.state}
      AND product_line = ${productLine}
      AND effective_date <= ${dos}::date
      AND coverage_status = ANY(${statusFilter}::text[])
    ORDER BY
      CASE coverage_status
        WHEN 'covered' THEN 0 WHEN 'varies' THEN 1
        WHEN 'unknown' THEN 2 WHEN 'not_covered' THEN 3 ELSE 4 END,
      COALESCE(category, 'zzz') ASC, code ASC
  `;

  const licensed = hasAmaLicense();
  const mapped: AllowedCode[] = rows.map((r) => ({
    payerId: r.payer_id,
    state: r.state,
    productLine: r.product_line,
    code: r.code,
    // CPT text is AMA-licensed (audit R21). The view selects it raw, so it is
    // gated here, the one place every picker path passes through.
    descriptor: gateDescriptor(r.code_system, r.descriptor, licensed) ?? "",
    category: r.category,
    codeSystem: r.code_system,
    coverageStatus: r.coverage_status,
    confidence: Number(r.confidence),
    effectiveDate: r.effective_date.toISOString().slice(0, 10),
    ruleCreatedAt: r.rule_created_at.toISOString(),
    createdBy: r.created_by,
    sourceDocId: r.source_doc_id,
    sourceQuote: r.source_quote,
    // Not the view's source_kind: its CASE compares created_by with 'crawler'
    // and 'cms' exactly, so every rule extracted from a published document
    // ('extract:…', most of the library) read "Unsourced" (audit R21).
    sourceKind: payerRuleSourceKind(r.created_by),
    modifierRequired: r.modifier_required,
    priorAuthRequired: r.prior_auth_required,
    hasFrequencyLimit: r.has_frequency_limit,
    frequencyLimitValue: r.frequency_limit_value,
    priorAuthValue: r.prior_auth_value,
  }));

  CACHE.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rows: mapped });
  return mapped;
}

/**
 * Search variant — same data, filtered to codes matching `query`
 * (prefix on code OR ILIKE on descriptor). For the picker's autocomplete.
 */
export async function searchAllowedCodes(args: {
  payerId: string;
  state: string;
  query: string;
  dos?: string;
  productLine?: string;
  limit?: number;
  includeDenied?: boolean;
}): Promise<AllowedCode[]> {
  const all = await getAllowedCodesForPayer(args);
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const q = args.query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  return all
    .filter(
      (r) =>
        r.code.toLowerCase().startsWith(q) ||
        // A withheld CPT descriptor is not text to search: matching "ama"
        // against the placeholder would return every CPT code.
        (!isAmaPlaceholder(r.descriptor) && r.descriptor.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}

