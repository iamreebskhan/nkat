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
const CADENCE_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
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
  if (r.days_since_change !== null && r.days_since_change > FROZEN_DAYS) {
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
  /** Target codes with NO live rule — the actionable gap. */
  missingCoreCodes: string[];
}

interface CoverageRow {
  payer_id: string; payer_name: string; payer_type: string; states: string[];
  codes_covered: number; core_covered: number; total_rules: number;
  source_count: number; missing_core: string[];
}

/**
 * Per-payer coverage against `library_coverage_target`.
 *
 * "Covered" means a LIVE rule exists (effective now, not retracted) for
 * that payer and code in any of the payer's states, for any attribute.
 * It deliberately does not require every attribute — a payer that
 * answers `covered` but not `telehealth_allowed` is partially useful,
 * whereas a payer with nothing is a hole.
 */
export async function getCoverageMatrix(): Promise<PayerCoverage[]> {
  const rows = await prisma.$queryRaw<CoverageRow[]>`
    WITH target AS (
      SELECT code, is_core FROM library_coverage_target WHERE active
    ),
    live AS (
      SELECT DISTINCT pr.payer_id, pr.code
        FROM payer_rule pr
       WHERE (pr.expiration_date IS NULL OR pr.expiration_date > CURRENT_DATE)
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
