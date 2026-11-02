/**
 * What a claim is checked against when it is reviewed for submission (0118;
 * Level-1 doc:71; Mark Q5 default: "hard stops only for a missing member ID,
 * diagnosis or CPT code. Everything else warns, with a logged override, and
 * the biller or an admin reviews"). Pure.
 *
 *   hard stops   no member ID, no diagnosis, no CPT code: the review refuses.
 *   warnings     an NCCI procedure-to-procedure pair, units above an MUE, a
 *                line billing $0, a code the payer's schedule lists as not
 *                covered, a prior authorization the payer firmly requires and
 *                none on the chart covers, or one whose visits have run out:
 *                the review asks for a reason, kept on the claim's history and
 *                in the audit log, and goes ahead with it.
 *
 * NCCI data (CMS's quarterly practitioner files, which the practice loads into
 * its own account: org_ncci_ptp, org_ncci_mue, 0122) is read as in force on
 * the date of service; with none loaded there is no NCCI warning. Pallio's
 * bills carry claim-level modifiers, so a pair that a modifier may bypass is
 * reported as needing one on the column-2 line, whichever line it is on.
 */
import { normalizeUnits, unitsOf, type CodeUnits } from "@/lib/features/billing/code-units";

export { claimHardStops } from "./claim-export";

export interface NcciPtpEdit {
  column1: string;
  column2: string;
  /** 0: never billed together; 1: billed together with an NCCI-associated modifier; 9: not an edit. */
  modifierIndicator: 0 | 1 | 9;
}

export interface NcciMue {
  code: string;
  unitsMax: number;
}

/**
 * The NCCI-associated modifiers that may bypass a modifier-indicator-1 pair
 * (NCCI Policy Manual, ch. I): 59 and its X{EPSU} subsets, the global-surgery
 * and E/M modifiers, and repeat-test 91.
 */
export const NCCI_BYPASS_MODIFIERS = ["24", "25", "27", "57", "58", "59", "78", "79", "91", "XE", "XP", "XS", "XU"] as const;

export type ReviewWarningKind = "ncci_ptp" | "ncci_mue" | "zero_charge" | "not_covered" | "prior_auth";

export interface ReviewWarning {
  kind: ReviewWarningKind;
  /** The code (or the column-2 code of a pair) the warning is about. */
  code: string;
  detail: string;
}

export function ptpWarnings(codes: string[], modifiers: string[], edits: NcciPtpEdit[]): ReviewWarning[] {
  const on = new Set(codes);
  const bypass = modifiers.filter((m) => (NCCI_BYPASS_MODIFIERS as readonly string[]).includes(m));
  const out: ReviewWarning[] = [];
  for (const e of edits) {
    if (e.modifierIndicator === 9 || !on.has(e.column1) || !on.has(e.column2) || e.column1 === e.column2) continue;
    if (e.modifierIndicator === 0) {
      out.push({
        kind: "ncci_ptp",
        code: e.column2,
        detail: `${e.column1} and ${e.column2} are an NCCI pair that no modifier separates: ${e.column2} is not paid with ${e.column1}.`,
      });
    } else if (bypass.length === 0) {
      out.push({
        kind: "ncci_ptp",
        code: e.column2,
        detail: `${e.column1} and ${e.column2} are an NCCI pair: ${e.column2} is paid with ${e.column1} only with an NCCI-associated modifier (59, XE, XP, XS, XU or 25, as the service supports) on its line.`,
      });
    } else {
      out.push({
        kind: "ncci_ptp",
        code: e.column2,
        detail: `${e.column1} and ${e.column2} are an NCCI pair the bill's modifier ${bypass.join(", ")} may separate: confirm it is on ${e.column2}'s line and that the record supports a distinct service.`,
      });
    }
  }
  return out;
}

export function mueWarnings(codes: string[], units: CodeUnits | null | undefined, mues: NcciMue[]): ReviewWarning[] {
  const per = normalizeUnits(codes, units);
  const max = new Map(mues.map((m) => [m.code, m.unitsMax]));
  return [...new Set(codes)].flatMap((code) => {
    const n = unitsOf(per, code);
    const m = max.get(code);
    return m !== undefined && n > m
      ? [{ kind: "ncci_mue" as const, code, detail: `${code} × ${n} is above its NCCI medically unlikely edit of ${m} per day.` }]
      : [];
  });
}

export function zeroChargeWarnings(lines: { code: string; chargeCents: number }[]): ReviewWarning[] {
  return lines
    .filter((l) => l.chargeCents === 0)
    .map((l) => ({ kind: "zero_charge" as const, code: l.code, detail: `${l.code} bills $0.00: no rate or fee is on file for it.` }));
}

export function notCoveredWarnings(notCovered: { code: string; payerName: string | null }[]): ReviewWarning[] {
  return notCovered.map((n) => ({
    kind: "not_covered" as const,
    code: n.code,
    detail: `${n.payerName ?? "The payer"}'s schedule lists ${n.code} as not covered.`,
  }));
}

/**
 * A prior authorization the claim needs and does not have (0124). Only for a
 * payer's FIRM rule: most rules on file are conditional ("out of network",
 * "depends on the plan"), and asking for a reason on every claim to those
 * payers would teach billers to type past it. The predictor still shows those.
 */
export function priorAuthWarnings(a: {
  requiredCodes: string[];
  uncovered: string[];
  payerName: string | null;
  dos: string;
  /** A covering authorization whose allowed visits this claim goes past. */
  overCap?: { authNumber: string; visitsAuthorized: number } | null;
}): ReviewWarning[] {
  const payer = a.payerName ?? "This payer";
  const out: ReviewWarning[] = a.requiredCodes
    .filter((code) => a.uncovered.includes(code))
    .map((code) => ({
      kind: "prior_auth" as const,
      code,
      detail: `${payer} requires prior authorization for ${code}, and none on the chart covers ${a.dos}.`,
    }));
  if (a.overCap) {
    const n = a.overCap.visitsAuthorized;
    out.push({
      kind: "prior_auth",
      code: a.overCap.authNumber,
      detail: `Authorization ${a.overCap.authNumber} allows ${n} visit${n === 1 ? "" : "s"}, and this claim goes past that.`,
    });
  }
  return out;
}

export const REVIEW_WARNING_LABEL: Record<ReviewWarningKind, string> = {
  ncci_ptp: "NCCI pair",
  ncci_mue: "Units above the MUE",
  zero_charge: "$0 line",
  not_covered: "Not covered by the payer",
  prior_auth: "Prior authorization",
};
