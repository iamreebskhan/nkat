/**
 * predictSuperbill — Phase B bridge between live data + the pure scorer.
 *
 * Given a draft superbill payload (lines + patient context), this service:
 *   1. Pulls the relevant payer_rule rows from the allowed-codes view
 *      (single query, per payer/state) and reshapes them into the
 *      CodeRuleSet shape the pure scorer needs.
 *   2. Pulls the patient's recent superbill lines for frequency-limit
 *      checks (last 90 days, RLS-scoped).
 *   3. Calls scoreSuperbill() and returns the structured result.
 *
 * Used by:
 *   * POST /api/superbills/predict — preview-only, no DB write.
 *   * persistDraft() — captures predicted_risk at save-time for the
 *     feedback loop.
 */
import { withOrgContext } from "@/lib/db";
import { addDaysIso } from "@/lib/features/org/org-date";
import { loadDocumentationGaps } from "@/lib/features/visits/documentation-check.service";

import { getDenialRuleMetrics } from "./denial-feedback.service";
import {
  scoreSuperbill,
  type CodeRuleSet,
  type DraftContext,
  type DraftLine,
  type RiskBand,
  type RiskReason,
} from "./denial-risk.service";

export interface PredictInput {
  orgId: string;
  payerId: string | null;
  state: string | null;
  patientId?: string;
  dos: string;
  cptCodes: string[];
  modifiers?: string[];
  icd10Codes?: string[];
  /**
   * The superbill being scored, when it is already persisted.
   *
   * Without it the frequency history counts the very lines under review:
   * a "maximum one per 30 days" rule then fires on the claim that IS the
   * first occurrence, on every saved super-bill, forever. Harmless while
   * no rule carried a numeric limit — which was true until the limits
   * were backfilled — and wrong the moment one did.
   */
  excludeSuperbillId?: string;
  /**
   * The visit being billed, for a bill not saved yet (audit R19): its note is
   * checked against the payer's documentation standard. Ignored when
   * excludeSuperbillId is set, which reads the saved bill's own payer.
   */
  visitId?: string;
  /** Has the patient been prior-authorized? */
  patientPriorAuth?: boolean;
  /** Clinician taxonomy code, if known. */
  clinicianTaxonomy?: string;
}

export interface PredictedRisk {
  worstBand: RiskBand;
  blockCount: number;
  highCount: number;
  mediumCount: number;
  perLine: Array<{
    code: string;
    score: number;
    riskBand: RiskBand;
    reasons: RiskReason[];
  }>;
  ranAt: string;
}

interface AllowedRow {
  code: string;
  coverage_status: "covered" | "not_covered" | "varies" | "unknown";
  confidence: string;
  modifier_required: boolean;
  prior_auth_required: boolean;
  has_frequency_limit: boolean;
  frequency_limit_value: string | null;
  payer_rule_id: string;
}

/**
 * Fetch the per-code rules + recent history needed to score a draft.
 * Returns the structured PredictedRisk.
 */
export async function predictSuperbill(args: PredictInput): Promise<PredictedRisk> {
  const lines: DraftLine[] = args.cptCodes.map((code) => ({
    code: code.toUpperCase(),
    dos: args.dos,
    modifiers: (args.modifiers ?? []).map((m) => m.toUpperCase()),
  }));

  const context: DraftContext = {
    payerId: args.payerId,
    state: args.state ?? "",
    patientPriorAuth: args.patientPriorAuth ?? false,
    clinicianTaxonomy: args.clinicianTaxonomy,
    recentLinesForPatient: [],
  };

  const rulesByCode = new Map<string, CodeRuleSet>();

  // Only query rules when payer + state are set; otherwise every line
  // will fall through to coverage_unknown which the scorer flags.
  if (args.payerId && args.state) {
    await withOrgContext(args.orgId, async (tx) => {
      const rows = await tx.$queryRaw<AllowedRow[]>`
        SELECT code, coverage_status, confidence,
               modifier_required, prior_auth_required,
               has_frequency_limit, frequency_limit_value, payer_rule_id
          FROM payer_allowed_codes_v
         WHERE payer_id = ${args.payerId}::uuid
           AND state    = ${args.state}
           AND code     = ANY(${lines.map((l) => l.code)}::text[])
      `;
      for (const r of rows) {
        let freq: CodeRuleSet["frequencyLimit"];
        if (r.has_frequency_limit && r.frequency_limit_value) {
          try {
            const parsed = JSON.parse(r.frequency_limit_value);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              typeof parsed.maxOccurrences === "number" &&
              typeof parsed.windowDays === "number"
            ) {
              freq = {
                maxOccurrences: parsed.maxOccurrences,
                windowDays: parsed.windowDays,
              };
            }
          } catch {
            /* shape varies in practice; skip on parse failure */
          }
        }
        rulesByCode.set(r.code, {
          coverageStatus: r.coverage_status,
          confidence: Number(r.confidence),
          modifierRequired: r.modifier_required
            ? { required: true, acceptable: [] }
            : undefined,
          priorAuthRequired: r.prior_auth_required,
          frequencyLimit: freq,
          payerRuleId: r.payer_rule_id,
        });
      }

      // The payer's documentation standard against the note (audit R19):
      // through the saved bill, or before it is saved, through the visit. The
      // codes and the date of service are the ones being scored, which may
      // not be saved yet, so the stored risk and its documentation check are
      // judged on one day. A saved bill's own date still wins.
      const docTarget = args.excludeSuperbillId
        ? { superbillId: args.excludeSuperbillId }
        : args.visitId
          ? { visitId: args.visitId }
          : null;
      if (docTarget) {
        const docs = await loadDocumentationGaps(tx, docTarget, {
          codes: lines.map((l) => l.code),
          dos: args.dos,
        });
        for (const r of docs.results) {
          if (r.missing.length === 0) continue;
          const cur = rulesByCode.get(r.code) ?? { coverageStatus: "unknown" as const, confidence: 0 };
          rulesByCode.set(r.code, { ...cur, documentationMissing: r.missing.map((m) => m.label) });
        }
      }

      // Recent history for frequency check — only when we know the
      // patient. Named by org as well as RLS.
      //
      // Counted back from the date of service being scored, as far as the
      // longest frequency window among these codes, and at least 90 days.
      // It was counted back 90 days from today in UTC: a visit billed weeks
      // later had its window cut short, so did any limit over 90 days, and
      // the boundary moved with the server's clock rather than the claim.
      if (args.patientId) {
        const longest = Math.max(
          90,
          ...[...rulesByCode.values()].map((r) => r.frequencyLimit?.windowDays ?? 0),
        );
        const sinceStr = addDaysIso(args.dos, -longest);
        const hist = await tx.$queryRaw<
          { code: string; dos: Date }[]
        >`
          SELECT unnest(cpt_codes) AS code, date_of_service AS dos
            FROM superbill
           WHERE org_id = ${args.orgId}::uuid
             AND patient_id = ${args.patientId}::uuid
             AND date_of_service >= ${sinceStr}::date
             -- Never count the super-bill under review as prior history.
             AND (${args.excludeSuperbillId ?? null}::uuid IS NULL
                  OR id <> ${args.excludeSuperbillId ?? null}::uuid)
        `;
        context.recentLinesForPatient = hist.map((h) => ({
          code: h.code.toUpperCase(),
          dos: h.dos.toISOString().slice(0, 10),
        }));
      }
    });
  }

  const result = scoreSuperbill({ lines, context, rulesByCode });
  // Enrich each reason with its historical precision from the nightly
  // feedback loop so the UI can show "this rule has X% precision". Best
  // effort — if metrics aren't available yet, reasons keep precisionPct
  // undefined and the badge just omits it.
  let metrics: Awaited<ReturnType<typeof getDenialRuleMetrics>> = {};
  try {
    metrics = await getDenialRuleMetrics();
  } catch {
    /* no metrics yet */
  }

  return {
    worstBand: result.worstBand,
    blockCount: result.blockCount,
    highCount: result.highCount,
    mediumCount: result.mediumCount,
    perLine: result.perLine.map((p) => ({
      code: p.code,
      score: p.score,
      riskBand: p.riskBand,
      reasons: p.reasons.map((r) => ({
        ...r,
        precisionPct: metrics[r.code]?.precisionPct ?? null,
      })),
    })),
    ranAt: new Date().toISOString(),
  };
}
