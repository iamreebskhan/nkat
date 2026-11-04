/**
 * Denial pure helpers — CARC code dictionary + heuristic categorization.
 *
 * No DB. The full CARC list is ~300 codes; we ship a curated palliative-
 * care subset with human-readable text + a coarse category. Anything
 * unknown returns the raw code + "Unknown" category — Phase 6's
 * analyst attestation flow can fill the gap.
 *
 * Source: CMS WPC X12 Adjustment Reason Codes (cms.gov/.../carc-list).
 */

export type CarcCategory =
  | "auth_required"
  | "non_covered"
  | "duplicate"
  | "coordination_of_benefits"
  | "missing_info"
  | "timely_filing"
  | "medical_necessity"
  | "billing_error"
  | "patient_responsibility"
  | "other";

export interface CarcEntry {
  code: string;
  text: string;
  category: CarcCategory;
  /**
   * Heuristic recommendation — used as a fallback when AI analysis
   * isn't available. The orchestrator overrides with the AI's
   * recommendation when one exists.
   */
  defaultRecommendation: "refile" | "write_off" | "appeal" | "unknown";
}

/**
 * Curated palliative-care CARC catalog. Codes that come up against
 * 99341–99350 / G0318 / 99417 / 99497 / 99498. Add more as Mark's
 * client claim history surfaces them.
 */
const CARC_CATALOG: CarcEntry[] = [
  // Auth + missing-info
  // Wording as the X12 CARC list publishes it today (checked 3 Nov 2026);
  // 16, 197, 198 and 227 were older or shortened versions.
  { code: "197", text: "Precertification/authorization/notification/pre-treatment absent.", category: "auth_required", defaultRecommendation: "appeal" },
  { code: "198", text: "Precertification/notification/authorization/pre-treatment exceeded.", category: "auth_required", defaultRecommendation: "appeal" },
  { code: "16", text: "Claim/service lacks information or has submission/billing error(s).", category: "missing_info", defaultRecommendation: "refile" },
  { code: "227", text: "Information requested from the patient/insured/responsible party was not provided or was insufficient/incomplete.", category: "missing_info", defaultRecommendation: "refile" },
  // A payer asking for the note or another record before it pays; showed as
  // "Unknown CARC 252" on the denial page (localhost, 2026-10-27).
  { code: "252", text: "An attachment/other documentation is required to adjudicate this claim/service.", category: "missing_info", defaultRecommendation: "refile" },

  // Non-covered
  { code: "96", text: "Non-covered charge(s).", category: "non_covered", defaultRecommendation: "appeal" },
  { code: "204", text: "This service/equipment/drug is not covered under the patient's current benefit plan.", category: "non_covered", defaultRecommendation: "appeal" },
  { code: "50", text: "These are non-covered services because this is not deemed a 'medical necessity' by the payer.", category: "medical_necessity", defaultRecommendation: "appeal" },
  { code: "55", text: "Procedure/treatment/drug is deemed experimental/investigational by the payer.", category: "medical_necessity", defaultRecommendation: "appeal" },

  // Duplicate / billing
  { code: "18", text: "Exact duplicate claim/service.", category: "duplicate", defaultRecommendation: "write_off" },
  { code: "B7", text: "This provider was not certified/eligible to be paid for this procedure/service on this date of service.", category: "billing_error", defaultRecommendation: "appeal" },
  { code: "B22", text: "This payment is adjusted based on the diagnosis.", category: "billing_error", defaultRecommendation: "refile" },
  { code: "151", text: "Payment adjusted because the payer deems the information submitted does not support this many/frequency of services.", category: "billing_error", defaultRecommendation: "appeal" },

  // Coordination of Benefits
  { code: "22", text: "This care may be covered by another payer per coordination of benefits.", category: "coordination_of_benefits", defaultRecommendation: "refile" },
  { code: "23", text: "The impact of prior payer(s) adjudication including payments and/or adjustments.", category: "coordination_of_benefits", defaultRecommendation: "refile" },

  // Timely filing
  { code: "29", text: "The time limit for filing has expired.", category: "timely_filing", defaultRecommendation: "write_off" },

  // Patient responsibility
  { code: "1", text: "Deductible amount.", category: "patient_responsibility", defaultRecommendation: "write_off" },
  { code: "2", text: "Coinsurance amount.", category: "patient_responsibility", defaultRecommendation: "write_off" },
  { code: "3", text: "Co-payment amount.", category: "patient_responsibility", defaultRecommendation: "write_off" },
];

const CARC_BY_CODE: Map<string, CarcEntry> = new Map(
  CARC_CATALOG.map((e) => [e.code.toUpperCase(), e]),
);

export function lookupCarc(code: string): CarcEntry {
  const hit = CARC_BY_CODE.get(code.toUpperCase());
  return (
    hit ?? {
      code,
      text: `Unknown CARC ${code}. See CMS WPC list at cms.gov.`,
      category: "other",
      defaultRecommendation: "unknown",
    }
  );
}

/**
 * Remittance Advice Remark Codes a palliative claim meets, with the payer's
 * own wording (X12 RARC list, as CMS publishes it).
 *
 * The denial analyst was handed the RARC as a bare code and explained it
 * itself. On the live test it read MA130 — "unprocessable, no appeal rights,
 * submit a new claim" — as a missing "Patient Reason for Visit". The verdict
 * was still right, but a biller reads the explanation, and the code carries
 * the instruction. A code not listed here is passed on as a bare code with
 * the instruction not to interpret it.
 */
const RARC_TEXT: Record<string, string> = {
  MA130:
    "Your claim contains incomplete and/or invalid information, and no appeal rights are afforded because the claim is unprocessable. Submit a new claim with the complete/correct information.",
  MA04: "Secondary payment cannot be considered without the identity of or payment information from the primary payer. The information was either not reported or was illegible.",
  MA63: "Missing/incomplete/invalid principal diagnosis.",
  M51: "Missing/incomplete/invalid procedure code(s).",
  M76: "Missing/incomplete/invalid diagnosis or condition.",
  M77: "Missing/incomplete/invalid/inappropriate place of service.",
  M127: "Missing patient medical record for this service.",
  N30: "Patient ineligible for this service.",
  N56: "Procedure code billed is not correct/valid for the services billed or the date of service billed.",
  N130: "Consult plan benefit documents/guidelines for information about restrictions for this service.",
  N286: "Missing/incomplete/invalid referring provider primary identifier.",
  N290: "Missing/incomplete/invalid rendering provider primary identifier.",
  N479: "Missing Explanation of Benefits (Coordination of Benefits or Medicare Secondary Payer).",
};

/** The RARC's wording, or null when Pallio does not hold it. */
export function lookupRarc(code: string | null | undefined): string | null {
  if (!code) return null;
  return RARC_TEXT[code.trim().toUpperCase()] ?? null;
}

/**
 * Heuristic likely-cause string for the FE's "while waiting for AI"
 * state. Combines the CARC text with the rule attribute the denial
 * suggests.
 */
export function describeDenialHeuristic(args: {
  carcCode: string;
  cptCode: string;
}): { heuristic: string; recommendation: CarcEntry["defaultRecommendation"] } {
  const e = lookupCarc(args.carcCode);
  return {
    heuristic: `CARC ${e.code} — ${e.text} (CPT ${args.cptCode}).`,
    recommendation: e.defaultRecommendation,
  };
}

/**
 * Aggregate metrics over a list of denials. Pure — used by the
 * dashboard widgets + tests. Returns counts and dollar impact
 * grouped by carc + by payer.
 */
export interface DenialMetrics {
  total: number;
  totalDeniedCents: number;
  /** What came back on these denials: paid and partially paid outcomes. */
  totalRecoveredCents: number;
  pendingDecisions: number;
  byCarc: { carc: string; count: number; deniedCents: number }[];
  /**
   * outstandingCents is what is still not recovered, each denial counted up to
   * its own denied amount. "Top payer impact" counted resolved denials as if
   * the money were still lost: a refiled claim paid in full kept its payer at
   * the top of the screen.
   */
  byPayerId: {
    payerId: string | null;
    count: number;
    deniedCents: number;
    recoveredCents: number;
    outstandingCents: number;
  }[];
}

/**
 * What the denials screen gets: the metrics plus a name for every payer they
 * mention and for the payer being filtered on, read from payer itself so a
 * withdrawn payer keeps its name. The screen used to map ids through
 * /api/billing/payers, active payers only since R17, so a withdrawn payer's
 * row printed the first 8 characters of its UUID and the filter caption read
 * "for this payer".
 */
export interface DenialSummary extends DenialMetrics {
  payerNames: Record<string, string>;
}

interface DenialMetricInput {
  carcCode: string;
  payerId: string | null;
  deniedAmountCents: number;
  decision: string;
  /** superbill_denial.outcome; absent or 'pending' while it is open. */
  outcome?: string | null;
  outcomeAmountCents?: number | null;
}

/**
 * What a denial got back. A paid outcome with no amount — a remittance that
 * settled two denials on one line, where the split is the payer's — counts as
 * paid in full; a secondary denial or a write-off got nothing back.
 */
export function recoveredCentsOf(r: Pick<DenialMetricInput, "deniedAmountCents" | "outcome" | "outcomeAmountCents">): number {
  if (r.outcome === "paid") return r.outcomeAmountCents ?? r.deniedAmountCents;
  if (r.outcome === "partially_paid") return r.outcomeAmountCents ?? 0;
  return 0;
}

export function computeDenialMetrics(rows: DenialMetricInput[]): DenialMetrics {
  const carcMap = new Map<string, { count: number; deniedCents: number }>();
  const payerMap = new Map<
    string | null,
    { count: number; deniedCents: number; recoveredCents: number; outstandingCents: number }
  >();
  let total = 0;
  let totalDeniedCents = 0;
  let totalRecoveredCents = 0;
  let pending = 0;

  for (const r of rows) {
    total++;
    totalDeniedCents += r.deniedAmountCents;
    const recovered = recoveredCentsOf(r);
    totalRecoveredCents += recovered;
    if (r.decision === "pending") pending++;

    const c = carcMap.get(r.carcCode) ?? { count: 0, deniedCents: 0 };
    c.count++;
    c.deniedCents += r.deniedAmountCents;
    carcMap.set(r.carcCode, c);

    const p = payerMap.get(r.payerId) ?? { count: 0, deniedCents: 0, recoveredCents: 0, outstandingCents: 0 };
    p.count++;
    p.deniedCents += r.deniedAmountCents;
    p.recoveredCents += recovered;
    // An overpayment on one denial does not pay off another one.
    p.outstandingCents += Math.max(0, r.deniedAmountCents - recovered);
    payerMap.set(r.payerId, p);
  }

  return {
    total,
    totalDeniedCents,
    totalRecoveredCents,
    pendingDecisions: pending,
    byCarc: Array.from(carcMap.entries())
      .map(([carc, v]) => ({ carc, ...v }))
      .sort((a, b) => b.deniedCents - a.deniedCents),
    byPayerId: Array.from(payerMap.entries())
      .map(([payerId, v]) => ({ payerId, ...v }))
      .sort((a, b) => b.deniedCents - a.deniedCents),
  };
}
