/**
 * Reports service — fetches the rows the pure helpers need.
 *
 * All reads are tenant-scoped via withOrgContext. Each report is a
 * thin Prisma query → handed to the pure aggregator.
 */
import { withOrgContext } from "@/lib/db";
import {
  denialRateTrend,
  denialsByPayer,
  revenueSummary,
  ruleCoverage,
  visitVolumeByClinician,
  type DailyDataPoint,
  type DenialByPayer,
  type RevenueSummary,
  type RuleCoverageSummary,
} from "./reports-pure";

export interface ReportsOverview {
  range: { fromDate: string; toDate: string };
  denialRateTrend: DailyDataPoint[];
  denialsByPayer: DenialByPayer[];
  revenue: RevenueSummary;
  visitVolume: { clinicianUserId: string; count: number }[];
  ruleCoverage: RuleCoverageSummary;
}

/**
 * One-call dashboard aggregator. Pulls the last 30 days of denials +
 * superbills + visits from the org, plus every rulebook row, and
 * returns everything the /reports page needs.
 */
export async function getOverview(args: {
  orgId: string;
  fromDate?: Date;
  toDate?: Date;
}): Promise<ReportsOverview> {
  const toDate = args.toDate ?? new Date();
  const fromDate = args.fromDate ?? new Date(toDate.getTime() - 30 * 86_400_000);

  return withOrgContext(args.orgId, async (tx) => {
    const denials = await tx.$queryRaw<
      {
        carc_code: string;
        payer_id: string | null;
        cpt_code: string;
        denied_amount_cents: bigint;
        decision: string;
        outcome: string;
        denied_at: Date;
      }[]
    >`
      SELECT carc_code, payer_id, cpt_code,
             denied_amount_cents, decision, outcome, denied_at
      FROM superbill_denial
      WHERE denied_at BETWEEN ${fromDate}::timestamptz AND ${toDate}::timestamptz
    `;
    const denialRows = denials.map((d) => ({
      carcCode: d.carc_code,
      payerId: d.payer_id,
      cptCode: d.cpt_code,
      deniedAmountCents: Number(d.denied_amount_cents),
      decision: d.decision,
      outcome: d.outcome,
      deniedAt: d.denied_at,
    }));

    const superbills = await tx.$queryRaw<
      {
        payer_id: string | null;
        status: string;
        billed_amount_cents: bigint;
        paid_amount_cents: bigint | null;
        date_of_service: Date;
      }[]
    >`
      SELECT payer_id, status, billed_amount_cents, paid_amount_cents,
             date_of_service
      FROM superbill
      WHERE date_of_service BETWEEN ${fromDate}::date AND ${toDate}::date
    `;
    const sbRows = superbills.map((s) => ({
      payerId: s.payer_id,
      status: s.status,
      billedAmountCents: Number(s.billed_amount_cents),
      paidAmountCents: s.paid_amount_cents ? Number(s.paid_amount_cents) : null,
      dateOfService: s.date_of_service,
    }));

    const visits = await tx.$queryRaw<
      {
        visit_type: string;
        status: string;
        clinician_user_id: string;
        scheduled_start: Date | null;
        start_time: Date | null;
      }[]
    >`
      SELECT visit_type, status, clinician_user_id, scheduled_start, start_time
      FROM visit
      WHERE COALESCE(start_time, scheduled_start, created_at)
            BETWEEN ${fromDate}::timestamptz AND ${toDate}::timestamptz
    `;
    const visitRows = visits.map((v) => ({
      visitType: v.visit_type,
      status: v.status,
      clinicianUserId: v.clinician_user_id,
      scheduledStart: v.scheduled_start,
      startTime: v.start_time,
    }));

    const rb = await tx.$queryRaw<{ coverage_status: string }[]>`
      SELECT coverage_status FROM org_rulebook_row
      WHERE org_id = ${args.orgId}::uuid
    `;
    const rbRows = rb.map((r) => ({ coverageStatus: r.coverage_status }));

    return {
      range: {
        fromDate: fromDate.toISOString().slice(0, 10),
        toDate: toDate.toISOString().slice(0, 10),
      },
      denialRateTrend: denialRateTrend({
        superbills: sbRows,
        denials: denialRows,
        fromDate,
        toDate,
      }),
      denialsByPayer: denialsByPayer({ superbills: sbRows, denials: denialRows }),
      revenue: revenueSummary(sbRows),
      visitVolume: visitVolumeByClinician(visitRows),
      ruleCoverage: ruleCoverage(rbRows),
    };
  });
}
