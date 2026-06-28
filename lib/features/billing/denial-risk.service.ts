/**
 * Denial-risk primitive — Phase 0.3 of the EMR-pivot plan.
 *
 * Pure function. No DB I/O, no network. Given a draft super-bill line
 * plus the contextual rules + recent-history facts the caller has
 * already fetched, return a structured risk score the UI can display
 * and the predictor (Phase B) can persist.
 *
 * Score is in [0, 1]: 0 = no concerns, 1 = certain denial.
 * Risk band is derived for UI:
 *   block  : 0.85+   (don't submit without override)
 *   high   : 0.60..0.85
 *   medium : 0.30..0.60
 *   low    : < 0.30
 *
 * Each contributing reason carries a code + human-readable message
 * + (optionally) the rule citation, so the popover "why?" UI can
 * deep-link to the source.
 *
 * Why a separate primitive: this is the one place every coverage,
 * modifier, prior-auth, frequency, taxonomy check lives. Both the
 * pre-submit predictor and the post-submit denial analyzer call it.
 * Both Phase A's picker and Phase B's banner read its output. Keeping
 * it pure means unit-testing 30+ branches is cheap, and the scoring
 * weights are easy to tune as we see real denial data.
 */

/** What the caller already knows about the line they're scoring. */
export interface DraftLine {
  /** CPT/HCPCS — already uppercased. */
  code: string;
  /** Service date in YYYY-MM-DD. */
  dos: string;
  /** Modifiers attached to this line, uppercase, no leading spaces. */
  modifiers: string[];
  /** Units billed on this line (default 1). */
  units?: number;
  /** Principal ICD-10 the line is justified by. */
  diagnosisIcd10?: string;
  /**
   * Time spent on the visit in minutes. Some E/M codes have a minimum
   * threshold; we surface it when the caller passes it.
   */
  timeMinutes?: number;
}

/** The patient + payer context every line shares. */
export interface DraftContext {
  /** Patient's primary payer (must be set or the line will be flagged). */
  payerId: string | null;
  /** Patient state for state-scoped rules. */
  state: string;
  /** Has the patient been authorized (prior-auth) for the relevant period? */
  patientPriorAuth: boolean;
  /** Clinician taxonomy code, if known. */
  clinicianTaxonomy?: string;
  /** Recent line history for this patient — feeds frequency-limit checks. */
  recentLinesForPatient?: Array<{ code: string; dos: string }>;
}

/**
 * The bits of payer_rule the scorer actually consumes for a code.
 * Caller fetches these in one query and hands them in — keeps the
 * scorer pure.
 */
export interface CodeRuleSet {
  /** Coverage answer: 'covered' | 'varies' | 'not_covered' | 'unknown'. */
  coverageStatus: "covered" | "varies" | "not_covered" | "unknown";
  /** Float confidence in [0,1]. Lower = wider uncertainty band. */
  confidence: number;
  /** Modifier required? If yes, what set is acceptable. */
  modifierRequired?: { required: boolean; acceptable: string[] };
  /** Prior auth required? */
  priorAuthRequired?: boolean;
  /**
   * Frequency limit, when known: at most `maxOccurrences` lines for this
   * code within the trailing `windowDays` calendar days.
   */
  frequencyLimit?: { maxOccurrences: number; windowDays: number };
  /** Allowed provider taxonomies; empty means "no restriction." */
  providerTaxonomyAllowed?: string[];
  /** Citation id, for the popover "why?" surface. */
  payerRuleId?: string;
}

export type RiskBand = "low" | "medium" | "high" | "block";

export interface RiskReason {
  /** Stable machine code so we can compute per-reason precision later. */
  code:
    | "no_payer"
    | "coverage_unknown"
    | "coverage_denied"
    | "coverage_varies"
    | "low_confidence"
    | "missing_modifier"
    | "wrong_modifier"
    | "prior_auth_missing"
    | "frequency_exceeded"
    | "taxonomy_disallowed"
    | "stale_rule";
  /** Human-readable explanation, suitable for popovers. */
  message: string;
  /** How much this contributes to the score, in [0,1]. */
  contribution: number;
  /** Cited payer_rule.id so the UI can deep-link. */
  payerRuleId?: string;
  /**
   * Historical precision of THIS reason code from the nightly feedback
   * loop (denial_rule_metrics), 0..100. Attached by the predict service
   * (the pure scorer never touches the DB). Undefined until we have data.
   */
  precisionPct?: number | null;
}

export interface RiskResult {
  score: number;
  riskBand: RiskBand;
  reasons: RiskReason[];
}

/**
 * Convert a final score in [0,1] to a band.
 * Threshold choices match the predictor UI bands; tune via fixtures.
 */
function bandOf(score: number): RiskBand {
  if (score >= 0.85) return "block";
  if (score >= 0.6) return "high";
  if (score >= 0.3) return "medium";
  return "low";
}

/**
 * Combine independent reason contributions into a single score.
 * Uses noisy-OR (1 - Π(1 - r)) so multiple medium signals can stack into
 * a high band, but no single signal of contribution=0.5 alone pushes
 * past the block threshold.
 */
function combineNoisyOr(contributions: number[]): number {
  if (contributions.length === 0) return 0;
  let prod = 1;
  for (const c of contributions) prod *= 1 - Math.min(1, Math.max(0, c));
  return Math.min(1, 1 - prod);
}

/**
 * Count how many lines with this code occurred in the trailing window.
 * Pure — caller passes the history.
 */
function countInWindow(
  history: NonNullable<DraftContext["recentLinesForPatient"]>,
  code: string,
  dos: string,
  windowDays: number,
): number {
  const dosDate = Date.parse(dos);
  const windowStart = dosDate - windowDays * 86_400_000;
  return history.filter((h) => {
    if (h.code !== code) return false;
    const t = Date.parse(h.dos);
    return t >= windowStart && t <= dosDate;
  }).length;
}

/**
 * The scorer.
 */
export function scoreLine(args: {
  line: DraftLine;
  context: DraftContext;
  rules: CodeRuleSet;
}): RiskResult {
  const { line, context, rules } = args;
  const reasons: RiskReason[] = [];

  // --- 1. Payer set on the patient? --------------------------------
  if (!context.payerId) {
    reasons.push({
      code: "no_payer",
      message:
        "Patient has no primary payer on file. Set one before submitting.",
      contribution: 0.9,
    });
  }

  // --- 2. Coverage status -----------------------------------------
  switch (rules.coverageStatus) {
    case "not_covered":
      reasons.push({
        code: "coverage_denied",
        message: `Payer rules say ${line.code} is not covered.`,
        contribution: 0.95,
        payerRuleId: rules.payerRuleId,
      });
      break;
    case "unknown":
      reasons.push({
        code: "coverage_unknown",
        message: `No rule on file for ${line.code} with this payer.`,
        contribution: 0.45,
        payerRuleId: rules.payerRuleId,
      });
      break;
    case "varies":
      reasons.push({
        code: "coverage_varies",
        message: `Coverage for ${line.code} varies; manual review advised.`,
        contribution: 0.35,
        payerRuleId: rules.payerRuleId,
      });
      break;
    case "covered":
      // covered — no contribution, fall through.
      break;
  }

  // --- 3. Confidence floor ----------------------------------------
  if (rules.confidence < 0.5) {
    reasons.push({
      code: "low_confidence",
      message: `Underlying rule confidence is low (${rules.confidence.toFixed(
        2,
      )}). Verify against payer policy before submit.`,
      contribution: 0.25,
      payerRuleId: rules.payerRuleId,
    });
  }

  // --- 4. Modifier required + present ------------------------------
  if (rules.modifierRequired?.required) {
    const acceptable = rules.modifierRequired.acceptable.map((m) =>
      m.toUpperCase(),
    );
    const present = line.modifiers.map((m) => m.toUpperCase());
    if (present.length === 0) {
      reasons.push({
        code: "missing_modifier",
        message: `Payer requires a modifier on ${line.code}. Acceptable: ${
          acceptable.join(", ") || "see policy"
        }.`,
        contribution: 0.55,
        payerRuleId: rules.payerRuleId,
      });
    } else if (
      acceptable.length > 0 &&
      !present.some((p) => acceptable.includes(p))
    ) {
      reasons.push({
        code: "wrong_modifier",
        message: `Modifier ${present.join("/")} not in acceptable set (${acceptable.join(
          ", ",
        )}).`,
        contribution: 0.55,
        payerRuleId: rules.payerRuleId,
      });
    }
  }

  // --- 5. Prior auth required + flagged ----------------------------
  if (rules.priorAuthRequired && !context.patientPriorAuth) {
    reasons.push({
      code: "prior_auth_missing",
      message: `Prior authorization is required for ${line.code} but the patient has none on file.`,
      contribution: 0.7,
      payerRuleId: rules.payerRuleId,
    });
  }

  // --- 6. Frequency limit ------------------------------------------
  if (rules.frequencyLimit && context.recentLinesForPatient) {
    const used = countInWindow(
      context.recentLinesForPatient,
      line.code,
      line.dos,
      rules.frequencyLimit.windowDays,
    );
    // The line being scored isn't in the history yet — adding 1 to
    // simulate submitting it.
    if (used + 1 > rules.frequencyLimit.maxOccurrences) {
      reasons.push({
        code: "frequency_exceeded",
        message: `Frequency limit: this would be the ${
          used + 1
        }${nth(used + 1)} ${line.code} in ${
          rules.frequencyLimit.windowDays
        } days (max ${rules.frequencyLimit.maxOccurrences}).`,
        contribution: 0.75,
        payerRuleId: rules.payerRuleId,
      });
    }
  }

  // --- 7. Taxonomy -------------------------------------------------
  if (
    rules.providerTaxonomyAllowed &&
    rules.providerTaxonomyAllowed.length > 0 &&
    context.clinicianTaxonomy &&
    !rules.providerTaxonomyAllowed.includes(context.clinicianTaxonomy)
  ) {
    reasons.push({
      code: "taxonomy_disallowed",
      message: `Clinician taxonomy ${context.clinicianTaxonomy} is not in the payer's allowed set for ${line.code}.`,
      contribution: 0.6,
      payerRuleId: rules.payerRuleId,
    });
  }

  // Combine
  const score = combineNoisyOr(reasons.map((r) => r.contribution));
  return {
    score,
    riskBand: bandOf(score),
    reasons,
  };
}

function nth(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
}

/**
 * Score every line of a draft super-bill.
 * Caller supplies the per-code rules already keyed by `line.code`.
 */
export function scoreSuperbill(args: {
  lines: DraftLine[];
  context: DraftContext;
  rulesByCode: Map<string, CodeRuleSet>;
}): {
  perLine: Array<RiskResult & { code: string }>;
  worstBand: RiskBand;
  blockCount: number;
  highCount: number;
  mediumCount: number;
} {
  const order: RiskBand[] = ["low", "medium", "high", "block"];
  let worstIdx = 0;
  let blockCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  const perLine = args.lines.map((line) => {
    const rules =
      args.rulesByCode.get(line.code) ?? {
        coverageStatus: "unknown" as const,
        confidence: 0,
      };
    const result = scoreLine({ line, context: args.context, rules });
    if (result.riskBand === "block") blockCount += 1;
    if (result.riskBand === "high") highCount += 1;
    if (result.riskBand === "medium") mediumCount += 1;
    const idx = order.indexOf(result.riskBand);
    if (idx > worstIdx) worstIdx = idx;
    return { code: line.code, ...result };
  });
  return {
    perLine,
    worstBand: order[worstIdx]!,
    blockCount,
    highCount,
    mediumCount,
  };
}
