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

      // Recent history for frequency check — only when we know the
      // patient. RLS keeps this scoped to the org.
      if (args.patientId) {
        const since = new Date();
        since.setUTCDate(since.getUTCDate() - 90);
        const sinceStr = since.toISOString().slice(0, 10);
        const hist = await tx.$queryRaw<
          { code: string; dos: Date }[]
        >`
          SELECT unnest(cpt_codes) AS code, date_of_service AS dos
            FROM superbill
           WHERE patient_id = ${args.patientId}::uuid
             AND date_of_service >= ${sinceStr}::date
        `;
        context.recentLinesForPatient = hist.map((h) => ({
          code: h.code.toUpperCase(),
          dos: h.dos.toISOString().slice(0, 10),
        }));
      }
    });
  }

  const result = scoreSuperbill({ lines, context, rulesByCode });
  return {
    worstBand: result.worstBand,
    blockCount: result.blockCount,
    highCount: result.highCount,
    mediumCount: result.mediumCount,
    perLine: result.perLine.map((p) => ({
      code: p.code,
      score: p.score,
      riskBand: p.riskBand,
      reasons: p.reasons,
    })),
    ranAt: new Date().toISOString(),
  };
}
