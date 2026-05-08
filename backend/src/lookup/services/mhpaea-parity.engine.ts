/**
 * Pure-function MHPAEA parity engine.
 *
 * Given a payer_rule for a behavioral_health code and the corresponding rule
 * for its paired med/surg code, evaluate whether the BH side is treated MORE
 * RESTRICTIVELY than the med/surg side, which would be a candidate parity
 * violation under the Mental Health Parity and Addiction Equity Act.
 *
 * Comparisons:
 *   - prior_auth_required: BH=true, med/surg=false → flag
 *   - frequency_limit:     BH cap < med/surg cap → flag (lower is more restrictive)
 *   - copay_or_costshare:  BH cost > med/surg cost → flag
 *   - documentation_required burden weight (count of required elements) > med/surg → flag
 *
 * "Flag" is a candidate violation; the customer / parity counsel still has to
 * confirm the comparison is apples-to-apples for the classification (in/out
 * of network, inpatient/outpatient).
 */
import type { CoverageStatus, PayerRuleAttribute } from '../../database/schema.types';

export interface ParityRuleInput {
  code: string;
  attribute: PayerRuleAttribute;
  value: Record<string, unknown>;
  coverage_status: CoverageStatus;
}

export type ParityFlagKind =
  | 'prior_auth_more_restrictive'
  | 'frequency_lower'
  | 'cost_share_higher'
  | 'documentation_heavier'
  | 'covered_only_for_med_surg'
  | 'no_pair_for_classification';

export interface ParityFlag {
  kind: ParityFlagKind;
  bh_code: string;
  med_surg_code: string;
  detail: string;
  /** A 0..1 confidence of the flag itself (not the underlying rule). 1 = clear. */
  confidence: number;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function docElementCount(value: Record<string, unknown>): number {
  const sum =
    (Array.isArray(value.required_phrases) ? value.required_phrases.length : 0) +
    (Array.isArray(value.required_chart_elements) ? value.required_chart_elements.length : 0) +
    (Array.isArray(value.mdm_elements) ? value.mdm_elements.length : 0);
  return sum;
}

/**
 * Given two rule sets — one for the BH code, one for the paired med/surg
 * code — check the four quantitative + non-quantitative limits and return
 * the parity flags.
 *
 * `bhRules` and `msRules` are the full set of attribute rows for the
 * (payer, state, product_line, code) — typically 1-5 rows each.
 */
export function evaluateParity(
  bhCode: string,
  msCode: string,
  bhRules: ParityRuleInput[],
  msRules: ParityRuleInput[],
): ParityFlag[] {
  const flags: ParityFlag[] = [];
  const idx = (rules: ParityRuleInput[]) =>
    new Map(rules.map((r) => [r.attribute, r]));
  const bh = idx(bhRules);
  const ms = idx(msRules);

  // Coverage status: BH not_covered while med/surg covered → likely violation.
  const bhCovered = bh.get('covered');
  const msCovered = ms.get('covered');
  if (
    msCovered &&
    msCovered.coverage_status === 'covered' &&
    bhCovered &&
    bhCovered.coverage_status === 'not_covered'
  ) {
    flags.push({
      kind: 'covered_only_for_med_surg',
      bh_code: bhCode,
      med_surg_code: msCode,
      detail: `${bhCode} is not_covered while paired ${msCode} is covered.`,
      confidence: 1,
    });
  }

  // Prior authorization — BH=required, med/surg=not → violation.
  const bhPa = asBool(bh.get('prior_auth_required')?.value?.required);
  const msPa = asBool(ms.get('prior_auth_required')?.value?.required);
  if (bhPa === true && msPa === false) {
    flags.push({
      kind: 'prior_auth_more_restrictive',
      bh_code: bhCode,
      med_surg_code: msCode,
      detail: `${bhCode} requires prior authorization but paired ${msCode} does not.`,
      confidence: 1,
    });
  }

  // Frequency cap — BH lower than med/surg → potentially violation.
  const bhFreq = asNumber(bh.get('frequency_limit')?.value?.per_year);
  const msFreq = asNumber(ms.get('frequency_limit')?.value?.per_year);
  if (bhFreq !== undefined && msFreq !== undefined && bhFreq < msFreq) {
    flags.push({
      kind: 'frequency_lower',
      bh_code: bhCode,
      med_surg_code: msCode,
      detail: `${bhCode} caps frequency at ${bhFreq}/yr; paired ${msCode} allows ${msFreq}/yr.`,
      confidence: 0.9,
    });
  }

  // Cost share — BH higher than med/surg → violation candidate.
  const bhCost = asNumber(bh.get('copay_or_costshare')?.value?.copay);
  const msCost = asNumber(ms.get('copay_or_costshare')?.value?.copay);
  if (bhCost !== undefined && msCost !== undefined && bhCost > msCost) {
    flags.push({
      kind: 'cost_share_higher',
      bh_code: bhCode,
      med_surg_code: msCode,
      detail: `${bhCode} copay $${bhCost.toFixed(2)} > paired ${msCode} copay $${msCost.toFixed(2)}.`,
      confidence: 0.85,
    });
  }

  // Documentation NQTL — BH burden heavier than med/surg → violation candidate.
  const bhDoc = bh.get('documentation_required')?.value ?? {};
  const msDoc = ms.get('documentation_required')?.value ?? {};
  const bhDocCount = docElementCount(bhDoc as Record<string, unknown>);
  const msDocCount = docElementCount(msDoc as Record<string, unknown>);
  if (bhDocCount > msDocCount && bhDocCount > 0) {
    flags.push({
      kind: 'documentation_heavier',
      bh_code: bhCode,
      med_surg_code: msCode,
      detail: `${bhCode} requires ${bhDocCount} documentation elements vs ${msDocCount} for ${msCode}.`,
      confidence: 0.7,
    });
  }

  return flags;
}
