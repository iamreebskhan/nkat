/**
 * The review checks for one claim, read in the caller's transaction (0118;
 * Level-1 doc:71; Mark Q5 default). See claim-checks.ts for what each is.
 */
import { ValidationError } from "@/lib/api";
import { withOrgContext } from "@/lib/db";
import { defaultProductLineForPayerType } from "@/lib/features/billing/payer-rule.repository";
import { readActiveAuths } from "@/lib/features/patients/prior-auth.service";
import { lineChargeCents, type SuperbillPricing } from "@/lib/features/superbills/superbill-pure";

import {
  REVIEW_WARNING_LABEL,
  claimHardStops,
  mueWarnings,
  notCoveredWarnings,
  priorAuthWarnings,
  ptpWarnings,
  zeroChargeWarnings,
  type ReviewWarning,
} from "./claim-checks";
import type { CodeUnits } from "./code-units";
import { coveringAuth, uncoveredCodes } from "./prior-auth";

type Tx = Parameters<Parameters<typeof withOrgContext>[1]>[0];

export interface ReviewChecks {
  hardStops: string[];
  warnings: ReviewWarning[];
}

export async function loadReviewChecks(tx: Tx, a: { orgId: string; superbillId: string }): Promise<ReviewChecks> {
  const rows = await tx.$queryRaw<
    {
      cpt_codes: string[] | null; cpt_units: CodeUnits | null; modifiers: string[] | null; icd10_codes: string[] | null;
      member_id_snapshot: string | null; pricing: Partial<SuperbillPricing> | null; payer_id: string | null;
      patient_id: string; dos: string; state: string | null; payer_name: string | null;
      payer_type: Parameters<typeof defaultProductLineForPayerType>[0] | null;
    }[]
  >`
    SELECT s.cpt_codes, s.cpt_units, s.modifiers, s.icd10_codes, s.member_id_snapshot, s.pricing, s.payer_id, s.patient_id,
           to_char(s.date_of_service, 'YYYY-MM-DD') AS dos, COALESCE(p.insurance_state, p.state) AS state,
           pay.name AS payer_name, pay.payer_type
      FROM superbill s
      JOIN patient p ON p.id = s.patient_id AND p.org_id = s.org_id
      LEFT JOIN payer pay ON pay.id = s.payer_id
     WHERE s.id = ${a.superbillId}::uuid AND s.org_id = ${a.orgId}::uuid
  `;
  const b = rows[0];
  if (!b) return { hardStops: [], warnings: [] };
  const codes = [...new Set(b.cpt_codes ?? [])];
  const hardStops = claimHardStops({ memberId: b.member_id_snapshot ?? "", icd10: b.icd10_codes ?? [], codes });
  if (codes.length === 0) return { hardStops, warnings: [] };

  // NCCI as in force on the date of service, from CMS's practitioner files
  // the practice loaded itself (0122): the PTP pairs in use, by their own
  // dates; the MUE values of the latest load in force by that date.
  const edits = await tx.$queryRaw<{ column1_code: string; column2_code: string; modifier_indicator: number }[]>`
    SELECT e.column1_code, e.column2_code, e.modifier_indicator
      FROM org_ncci_ptp e
      JOIN org_ncci_load l ON l.id = e.load_id AND l.org_id = e.org_id AND l.kind = 'ptp' AND l.status = 'current'
     WHERE e.org_id = ${a.orgId}::uuid
       AND e.column1_code = ANY(${codes}::text[]) AND e.column2_code = ANY(${codes}::text[])
       AND e.effective_date <= ${b.dos}::date AND (e.deletion_date IS NULL OR e.deletion_date > ${b.dos}::date)
  `;
  const mues = await tx.$queryRaw<{ code: string; units_max: number }[]>`
    SELECT m.code, m.units_max
      FROM org_ncci_mue m
     WHERE m.org_id = ${a.orgId}::uuid AND m.code = ANY(${codes}::text[])
       AND m.load_id = (
             SELECT l.id FROM org_ncci_load l
              WHERE l.org_id = ${a.orgId}::uuid AND l.kind = 'mue' AND l.status = 'current'
                AND l.in_force_from <= ${b.dos}::date
              ORDER BY l.in_force_from DESC, l.committed_at DESC
              LIMIT 1)
  `;
  // What the payer's schedule says of each code, ranked as the rates are.
  const notCovered =
    b.payer_id && b.state
      ? await tx.$queryRaw<{ code: string }[]>`
          SELECT code FROM (
            SELECT DISTINCT ON (pr.code) pr.code, pr.coverage_status
              FROM payer_rule pr
             WHERE pr.payer_id = ${b.payer_id}::uuid AND pr.state = ${b.state}
               AND pr.code = ANY(${codes}::text[]) AND pr.attribute = 'covered' AND pr.superseded_by IS NULL
               AND pr.effective_date <= ${b.dos}::date
               AND (pr.expiration_date IS NULL OR pr.expiration_date > ${b.dos}::date)
             ORDER BY pr.code, (pr.product_line = ${defaultProductLineForPayerType(b.payer_type ?? null)}) DESC,
                      pr.effective_date DESC
          ) r
          WHERE r.coverage_status = 'not_covered'
        `
      : [];
  // Prior authorization (0124): the payer's firm rules only (priorAuthWarnings
  // says why), ranked as the rates are, against what the chart holds.
  const authRequired =
    b.payer_id && b.state
      ? await tx.$queryRaw<{ code: string }[]>`
          SELECT code FROM (
            SELECT DISTINCT ON (pr.code) pr.code, pr.coverage_status, pr.value
              FROM payer_rule pr
             WHERE pr.payer_id = ${b.payer_id}::uuid AND pr.state = ${b.state}
               AND pr.code = ANY(${codes}::text[]) AND pr.attribute = 'prior_auth_required' AND pr.superseded_by IS NULL
               AND pr.effective_date <= ${b.dos}::date
               AND (pr.expiration_date IS NULL OR pr.expiration_date > ${b.dos}::date)
             ORDER BY pr.code, (pr.product_line = ${defaultProductLineForPayerType(b.payer_type ?? null)}) DESC,
                      pr.effective_date DESC
          ) r
          WHERE r.coverage_status = 'covered' AND payer_rule_content_requires(r.value, 'prior_auth_required')
        `
      : [];
  const auths = (await readActiveAuths(tx, a.orgId, [b.patient_id])).get(b.patient_id) ?? [];
  const claimAuth = { payerId: b.payer_id, codes, dos: b.dos };
  const covering = coveringAuth(auths, claimAuth);
  let overCap: { authNumber: string; visitsAuthorized: number } | null = null;
  if (covering?.visitsAuthorized) {
    // The bills before this one on the same authorization, voided ones aside.
    const used = await tx.$queryRaw<{ n: bigint | number }[]>`
      SELECT count(*) AS n FROM superbill s
       WHERE s.org_id = ${a.orgId}::uuid AND s.patient_id = ${b.patient_id}::uuid AND s.payer_id = ${b.payer_id}::uuid
         AND s.id <> ${a.superbillId}::uuid AND s.status <> 'voided'
         AND s.date_of_service BETWEEN ${covering.validFrom}::date AND ${covering.validTo}::date
         AND (cardinality(${covering.codes}::text[]) = 0 OR s.cpt_codes && ${covering.codes}::text[])
    `;
    if (Number(used[0]?.n ?? 0) >= covering.visitsAuthorized) {
      overCap = { authNumber: covering.authNumber, visitsAuthorized: covering.visitsAuthorized };
    }
  }
  const lines = b.pricing?.lines ?? [];
  return {
    hardStops,
    warnings: [
      ...ptpWarnings(
        codes,
        b.modifiers ?? [],
        edits.map((e) => ({
          column1: e.column1_code, column2: e.column2_code, modifierIndicator: Number(e.modifier_indicator) as 0 | 1 | 9,
        })),
      ),
      ...mueWarnings(codes, b.cpt_units, mues.map((m) => ({ code: m.code, unitsMax: Number(m.units_max) }))),
      ...zeroChargeWarnings(lines.map((l) => ({ code: l.code, chargeCents: lineChargeCents(l) }))),
      ...notCoveredWarnings(notCovered.map((n) => ({ code: n.code, payerName: b.payer_name }))),
      ...priorAuthWarnings({
        requiredCodes: authRequired.map((r) => r.code),
        uncovered: uncoveredCodes(auths, claimAuth),
        payerName: b.payer_name,
        dos: b.dos,
        overCap,
      }),
    ],
  };
}

/** A claim with a hard stop (Mark Q5 default) is refused review and submission. */
export function hardStopMessage(stops: string[]): string {
  return `This claim has ${stops.join(", ")}. A payer rejects a claim without ${stops.length === 1 ? "it" : "them"}, so it cannot be marked ready or submitted until that is fixed.`;
}

/**
 * Marking a claim ready over warnings (Mark Q5 default) takes a reason, kept on
 * the claim's history. A ValidationError, so every route answers it at 422;
 * `warnings` lets the bill page offer the override without matching wording.
 */
export class ReviewWarningsError extends ValidationError {
  readonly warnings: ReviewWarning[];
  constructor(warnings: ReviewWarning[]) {
    super(
      `Before this claim is marked ready: ${warnings.map((w) => `${REVIEW_WARNING_LABEL[w.kind]} — ${w.detail}`).join(" ")} To mark it ready anyway, give the reason; it is kept on the claim history.`,
    );
    this.name = "ReviewWarningsError";
    this.warnings = warnings;
  }
}
