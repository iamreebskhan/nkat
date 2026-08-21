/**
 * Rule-library health and coverage.
 *
 * The library ran with three registered sources and rules for three of
 * nineteen payers for months, and nothing reported it. A lookup that
 * returns "Unknown" because the library is empty is indistinguishable,
 * from the outside, from one that returns "Unknown" because the payer
 * genuinely has no such rule. That ambiguity is what let the gap sit
 * until a client noticed.
 *
 * This module answers the two questions that make the gap visible:
 *
 *   getSourceHealth()    — is the pipeline actually working?
 *   getCoverageMatrix()  — what does the library know, and what doesn't it?
 *
 * All three tables read here (ingestion_source, payer_rule, payer) are
 * GLOBAL — no RLS, no tenant scoping — so plain `prisma` is correct;
 * `withOrgContext` would be meaningless.
 */
import { prisma } from "@/lib/db";

/** Why a source needs attention. Ordered worst-first for display. */
export type SourceStatus =
  | "failing"        // repeated fetch failures — dead, not flaky
  | "review_pending" // content changed, awaiting grounded extraction
  | "no_rules"       // extracted but produced nothing — restructured?
  | "erroring"       // 1-2 failures, may recover
  | "never_checked"  // registered but the cron has never reached it
  | "stale"          // overdue against its own cadence
  | "frozen"         // fetched fine, but unchanged for a very long time
  | "ok";

export interface SourceHealth {
  id: string;
  name: string;
  url: string;
  payerName: string | null;
  state: string | null;
  documentType: string;
  cadence: string;
  active: boolean;
  autoExtract: boolean;
  status: SourceStatus;
  detail: string;
  lastCheckAt: Date | null;
  lastChangeDetectedAt: Date | null;
  lastRuleCount: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

interface SourceRow {
  id: string; name: string; url: string; payer_name: string | null;
  state: string | null; document_type: string; schedule_cadence: string;
  active: boolean; auto_extract: boolean; review_pending: boolean;
  last_check_at: Date | null; last_change_detected_at: Date | null;
  last_rule_count: number | null; consecutive_failures: number;
  last_error: string | null; days_since_check: number | null;
  days_since_change: number | null;
}

/** Cadence in days; a source is stale at 2x its own cadence. */
const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30, yearly: 365 };
const FROZEN_DAYS = 365;

function classify(r: SourceRow): { status: SourceStatus; detail: string } {
  if (r.consecutive_failures >= 3) {
    return { status: "failing",
      detail: `${r.consecutive_failures} consecutive fetch failures — treat as dead` };
  }
  if (r.review_pending) {
    return { status: "review_pending",
      detail: "Content changed; awaiting a grounded extraction (auto_extract is off)" };
  }
  if (r.last_rule_count === 0 && r.last_check_at !== null) {
    return { status: "no_rules",
      detail: "Last extraction produced no rules — the document may have been restructured" };
  }
  if (r.consecutive_failures > 0) {
    return { status: "erroring",
      detail: `${r.consecutive_failures} recent failure(s); may still recover` };
  }
  if (r.last_check_at === null) {
    return { status: "never_checked",
      detail: "Registered but the ingestion cron has never reached it" };
  }
  const limit = (CADENCE_DAYS[r.schedule_cadence] ?? 7) * 2;
  if ((r.days_since_check ?? 0) > limit) {
    return { status: "stale",
      detail: `Not checked for ${r.days_since_check} days (cadence is ${r.schedule_cadence}) — is the cron running?` };
  }
  // "Frozen" means: this should have moved by now and has not. That reading
  // does not survive an annual document. A final rule is published once and
  // never edited — the CY2027 edition appears at a DIFFERENT url — so a
  // yearly source is unchanged for a year by design, and flagging it would
  // put a permanent warning on the one source that is behaving correctly.
  //
  // What an operator actually needs for these is "a newer edition exists",
  // which no freshness check on this url can answer. Registering the new
  // year's document is a human step, and pretending otherwise with a warning
  // that never clears would just train them to ignore the column.
  const annual = r.schedule_cadence === "yearly";
  if (!annual && r.days_since_change !== null && r.days_since_change > FROZEN_DAYS) {
    return { status: "frozen",
      detail: `Fetches fine but unchanged for ${r.days_since_change} days — confirm the URL still points at the current edition` };
  }
  return { status: "ok", detail: "Healthy" };
}

export async function getSourceHealth(): Promise<SourceHealth[]> {
  const rows = await prisma.$queryRaw<SourceRow[]>`
    SELECT
      s.id, s.name, s.url, p.name AS payer_name, s.state, s.document_type,
      s.schedule_cadence, s.active, s.auto_extract, s.review_pending,
      s.last_check_at, s.last_change_detected_at, s.last_rule_count,
      s.consecutive_failures, s.last_error,
      EXTRACT(DAY FROM now() - s.last_check_at)::int           AS days_since_check,
      EXTRACT(DAY FROM now() - s.last_change_detected_at)::int AS days_since_change
    FROM ingestion_source s
    LEFT JOIN payer p ON p.id = s.payer_id
    ORDER BY s.active DESC, s.consecutive_failures DESC, s.name
  `;

  const order: SourceStatus[] = ["failing", "review_pending", "no_rules", "erroring",
    "never_checked", "stale", "frozen", "ok"];

  return rows
    .map((r) => {
      const { status, detail } = classify(r);
      return {
        id: r.id, name: r.name, url: r.url, payerName: r.payer_name,
        state: r.state, documentType: r.document_type,
        cadence: r.schedule_cadence, active: r.active,
        autoExtract: r.auto_extract, status, detail,
        lastCheckAt: r.last_check_at,
        lastChangeDetectedAt: r.last_change_detected_at,
        lastRuleCount: r.last_rule_count,
        consecutiveFailures: r.consecutive_failures,
        lastError: r.last_error,
      };
    })
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
}

export interface PayerCoverage {
  payerId: string;
  payerName: string;
  payerType: string;
  states: string[];
  /** Distinct target codes with at least one live rule, per state. */
  codesCovered: number;
  codesTargeted: number;
  coreCodesCovered: number;
  coreCodesTargeted: number;
  totalRules: number;
  sourceCount: number;
  /** Live rules for attributes OTHER than `covered`. */
  attributeRules: number;
  /** Target codes with NO live rule — the actionable gap. */
  missingCoreCodes: string[];
}

interface CoverageRow {
  payer_id: string; payer_name: string; payer_type: string; states: string[];
  codes_covered: number; core_covered: number; total_rules: number;
  source_count: number; attribute_rules: number; missing_core: string[];
}

/**
 * Per-payer coverage against `library_coverage_target`.
 *
 * "Covered" means a live rule exists for the `covered` ATTRIBUTE
 * specifically — is this code payable at all. That is deliberately
 * strict: an earlier version counted a rule for any attribute, which
 * reported a payer holding only place-of-service rules as 8/13 covered
 * when it could not answer the coverage question for a single code.
 * Overstating coverage is worse than reporting none, because it hides
 * the gap it is supposed to expose.
 *
 * `attributeRules` reports the breadth of everything else (telehealth,
 * prior auth, POS, modifiers) separately, so a payer with rich
 * conditional rules but no coverage data is visible as exactly that.
 */
export async function getCoverageMatrix(): Promise<PayerCoverage[]> {
  const rows = await prisma.$queryRaw<CoverageRow[]>`
    WITH target AS (
      SELECT code, is_core FROM library_coverage_target WHERE active
    ),
    live AS (
      -- The 'covered' attribute only: can we answer "is this payable".
      SELECT DISTINCT pr.payer_id, pr.code
        FROM payer_rule pr
       WHERE pr.attribute = 'covered'
         AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
         AND pr.effective_date <= CURRENT_DATE
    )
    SELECT
      p.id AS payer_id, p.name AS payer_name, p.payer_type::text AS payer_type,
      p.states_served AS states,
      (SELECT count(*)::int FROM target t
        WHERE EXISTS (SELECT 1 FROM live l WHERE l.payer_id = p.id AND l.code = t.code)
      ) AS codes_covered,
      (SELECT count(*)::int FROM target t
        WHERE t.is_core
          AND EXISTS (SELECT 1 FROM live l WHERE l.payer_id = p.id AND l.code = t.code)
      ) AS core_covered,
      (SELECT count(*)::int FROM payer_rule pr
        WHERE pr.payer_id = p.id
          AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
      ) AS total_rules,
      (SELECT count(*)::int FROM ingestion_source s
        WHERE s.payer_id = p.id AND s.active) AS source_count,
      -- Conditional rules (telehealth, prior auth, POS, modifiers).
      -- Reported separately so a payer with these but no coverage data
      -- reads as exactly that rather than as partially covered.
      (SELECT count(*)::int FROM payer_rule pr
        WHERE pr.payer_id = p.id AND pr.attribute <> 'covered'
          AND (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
      ) AS attribute_rules,
      COALESCE((SELECT array_agg(t.code ORDER BY t.code) FROM target t
        WHERE t.is_core
          AND NOT EXISTS (SELECT 1 FROM live l WHERE l.payer_id = p.id AND l.code = t.code)
      ), ARRAY[]::text[]) AS missing_core
    FROM payer p
    ORDER BY core_covered DESC, p.name
  `;

  const totals = await prisma.$queryRaw<{ all: number; core: number }[]>`
    SELECT count(*)::int AS all, count(*) FILTER (WHERE is_core)::int AS core
      FROM library_coverage_target WHERE active
  `;
  const codesTargeted = totals[0]?.all ?? 0;
  const coreTargeted = totals[0]?.core ?? 0;

  return rows.map((r) => ({
    payerId: r.payer_id, payerName: r.payer_name, payerType: r.payer_type,
    states: r.states ?? [],
    codesCovered: r.codes_covered, codesTargeted,
    coreCodesCovered: r.core_covered, coreCodesTargeted: coreTargeted,
    totalRules: r.total_rules, sourceCount: r.source_count,
    attributeRules: r.attribute_rules,
    missingCoreCodes: r.missing_core ?? [],
  }));
}

export interface LibrarySummary {
  payersTotal: number;
  payersWithAnyRule: number;
  payersWithNoRule: number;
  payersWithNoSource: number;
  sourcesActive: number;
  sourcesNeedingAttention: number;
  liveRules: number;
  coreCodeCoveragePct: number;
}

export interface WeakCitation {
  payerName: string;
  /** The document the quote came from. */
  url: string;
  /** How many live rules lean on this one quote. */
  ruleCount: number;
  /** How many DIFFERENT codes it is asked to support. */
  codeCount: number;
  quote: string;
  sampleCodes: string[];
}

/**
 * Live rules whose quote never mentions the code it is cited for.
 *
 * Drift asks whether a citation is still THERE. Nothing asked whether it
 * says anything about the rule it supports, and the two are not the same
 * question. Fifty live Aetna rules across twenty-five codes cite
 *
 *   "Each benefit plan defines which services are covered, which are
 *    excluded..."
 *
 * from a disclaimer page. That quote is present, verbatim, on the page the
 * rule links to, so drift reports it ok forever — and a biller who clicks
 * through to find out why 99341 is covered reads a paragraph saying coverage
 * depends on the plan. The rule may even be right. The citation does not
 * establish it.
 *
 * The test is deliberately narrow: the quote does not contain the rule's own
 * code, AND the same quote is doing this for several codes at once. One
 * passage legitimately governing many codes is normal in rulemaking — the
 * CY2026 final rule finalises RVUs for tables of them — so this is a review
 * queue, not an error list. What it catches is boilerplate promoted to
 * evidence.
 */
export async function getWeakCitations(): Promise<WeakCitation[]> {
  return prisma.$queryRaw<WeakCitation[]>`
    SELECT
      p.name                                   AS "payerName",
      d.url                                    AS url,
      count(*)::int                            AS "ruleCount",
      count(DISTINCT pr.code)::int             AS "codeCount",
      left(regexp_replace(pr.source_quote, '\s+', ' ', 'g'), 160) AS quote,
      (array_agg(DISTINCT pr.code ORDER BY pr.code))[1:6]         AS "sampleCodes"
    FROM payer_rule pr
    JOIN payer p           ON p.id = pr.payer_id
    JOIN source_document d ON d.id = pr.source_doc_id
   WHERE pr.expiration_date IS NULL
     AND pr.source_quote IS NOT NULL
     -- the quote never names the code it is being used to support
     AND position(pr.code IN pr.source_quote) = 0
   GROUP BY p.name, d.url, pr.source_quote
  HAVING count(DISTINCT pr.code) >= 5
   ORDER BY count(*) DESC
   LIMIT 25
  `;
}

/** Headline numbers — the figures that should have been on a dashboard. */
export async function getLibrarySummary(): Promise<LibrarySummary> {
  const [coverage, health] = await Promise.all([getCoverageMatrix(), getSourceHealth()]);

  const payersWithAnyRule = coverage.filter((c) => c.totalRules > 0).length;
  const possible = coverage.length * (coverage[0]?.coreCodesTargeted ?? 0);
  const achieved = coverage.reduce((n, c) => n + c.coreCodesCovered, 0);

  return {
    payersTotal: coverage.length,
    payersWithAnyRule,
    payersWithNoRule: coverage.length - payersWithAnyRule,
    payersWithNoSource: coverage.filter((c) => c.sourceCount === 0).length,
    sourcesActive: health.filter((s) => s.active).length,
    sourcesNeedingAttention: health.filter((s) => s.active && s.status !== "ok").length,
    liveRules: coverage.reduce((n, c) => n + c.totalRules, 0),
    coreCodeCoveragePct: possible === 0 ? 0 : Math.round((achieved / possible) * 100),
  };
}
