/**
 * What the payer's latest 835 said about one claim (0118; Level-1 doc:74; Mark
 * Q2 default: the billing software owns the patient's balance, and Pallio keeps
 * the payer's word as a record). Paid, the contractual adjustment (CAS group
 * CO), the patient's share (PR) and any other adjustment (OA, PI), summed over
 * the claim's lines in that file. Lines posted before 0118 carry no split, and
 * the summary says so rather than showing zeros.
 */
import { withOrgContext } from "@/lib/db";

export interface RemittanceSummary {
  paymentDate: string | null;
  traceNumber: string | null;
  paidCents: number;
  /** null when the file was posted before the split was recorded. */
  contractualCents: number | null;
  patientResponsibilityCents: number | null;
  otherAdjustmentCents: number | null;
}

const cents = (x: unknown): number => Math.round(Number(x ?? 0) * 100);

export async function remittanceSummaryForBill(args: { orgId: string; superbillId: string }): Promise<RemittanceSummary | null> {
  return withOrgContext(args.orgId, async (tx) => {
    const rows = await tx.$queryRaw<
      {
        payment_date: string | null; trace_number: string | null; paid: string | null; contractual: string | null;
        pr: string | null; other: string | null; split_known: boolean;
      }[]
    >`
      WITH latest AS (
        SELECT r.remittance_file_id
          FROM era_835_record r
          JOIN remittance_file f ON f.id = r.remittance_file_id AND f.org_id = r.org_id
         WHERE r.superbill_id = ${args.superbillId}::uuid AND r.org_id = ${args.orgId}::uuid
         ORDER BY f.uploaded_at DESC
         LIMIT 1
      )
      SELECT to_char(f.payment_date, 'YYYY-MM-DD') AS payment_date, f.trace_number,
             sum(r.paid_amount)::text AS paid, sum(r.contractual_amount)::text AS contractual,
             sum(r.patient_responsibility_amount)::text AS pr, sum(r.other_adjustment_amount)::text AS other,
             bool_and(r.contractual_amount IS NOT NULL) AS split_known
        FROM era_835_record r
        JOIN remittance_file f ON f.id = r.remittance_file_id AND f.org_id = r.org_id
       WHERE r.superbill_id = ${args.superbillId}::uuid AND r.org_id = ${args.orgId}::uuid
         AND r.remittance_file_id = (SELECT remittance_file_id FROM latest)
       GROUP BY f.payment_date, f.trace_number
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      paymentDate: r.payment_date,
      traceNumber: r.trace_number,
      paidCents: cents(r.paid),
      contractualCents: r.split_known ? cents(r.contractual) : null,
      patientResponsibilityCents: r.split_known ? cents(r.pr) : null,
      otherAdjustmentCents: r.split_known ? cents(r.other) : null,
    };
  });
}
