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
  { code: "197", text: "Precertification/authorization/notification absent.", category: "auth_required", defaultRecommendation: "appeal" },
  { code: "198", text: "Precertification/authorization exceeded.", category: "auth_required", defaultRecommendation: "appeal" },
  { code: "16", text: "Claim/service lacks information needed for adjudication.", category: "missing_info", defaultRecommendation: "refile" },
  { code: "227", text: "Information requested from the patient/insured/responsible party was not provided.", category: "missing_info", defaultRecommendation: "refile" },

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
  pendingDecisions: number;
  byCarc: { carc: string; count: number; deniedCents: number }[];
  byPayerId: { payerId: string | null; count: number; deniedCents: number }[];
}

interface DenialMetricInput {
  carcCode: string;
  payerId: string | null;
  deniedAmountCents: number;
  decision: string;
}

export function computeDenialMetrics(rows: DenialMetricInput[]): DenialMetrics {
  const carcMap = new Map<string, { count: number; deniedCents: number }>();
  const payerMap = new Map<string | null, { count: number; deniedCents: number }>();
  let total = 0;
  let totalDeniedCents = 0;
  let pending = 0;

  for (const r of rows) {
    total++;
    totalDeniedCents += r.deniedAmountCents;
    if (r.decision === "pending") pending++;

    const c = carcMap.get(r.carcCode) ?? { count: 0, deniedCents: 0 };
    c.count++;
    c.deniedCents += r.deniedAmountCents;
    carcMap.set(r.carcCode, c);

    const p = payerMap.get(r.payerId) ?? { count: 0, deniedCents: 0 };
    p.count++;
    p.deniedCents += r.deniedAmountCents;
    payerMap.set(r.payerId, p);
  }

  return {
    total,
    totalDeniedCents,
    pendingDecisions: pending,
    byCarc: Array.from(carcMap.entries())
      .map(([carc, v]) => ({ carc, ...v }))
      .sort((a, b) => b.deniedCents - a.deniedCents),
    byPayerId: Array.from(payerMap.entries())
      .map(([payerId, v]) => ({ payerId, ...v }))
      .sort((a, b) => b.deniedCents - a.deniedCents),
  };
}
