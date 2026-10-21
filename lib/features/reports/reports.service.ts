/**
 * Reports service — fetches the rows the pure helpers need.
 *
 * All reads are tenant-scoped via withOrgContext. Each report is a
 * thin Prisma query → handed to the pure aggregator.
 */
import { withOrgContext } from "@/lib/db";
import { addDaysIso, orgToday } from "@/lib/features/org/org-date";
import { readOrgTimeZone } from "@/lib/features/org/org-time-zone";
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
  denialsByPayer: (DenialByPayer & { payerName: string | null })[];
  revenue: RevenueSummary;
  visitVolume: { clinicianUserId: string; clinicianName: string | null; count: number }[];
  ruleCoverage: RuleCoverageSummary;
}

/**
 * One-call dashboard aggregator. Pulls the last 30 days of denials +
 * superbills + visits from the org, plus every rulebook row, and
 * returns everything the /reports page needs.
 *
 * The window is a range of the practice's calendar days ('YYYY-MM-DD',
 * inclusive), by default the 30 ending on its today (0107). Days are bound
 * into ::date as strings: a JS Date binds as a timestamptz, whose ::date is
 * its day in the database session's zone, so a window of Dates took in the
 * 14th's bills on a Karachi session and August's on a New York one.
 */
export async function getOverview(args: {
  orgId: string;
  fromDay?: string;
  toDay?: string;
  /** For tests; the practice's today is taken from it. */
  now?: Date;
}): Promise<ReportsOverview> {
  return withOrgContext(args.orgId, async (tx) => {
    const tz = await readOrgTimeZone(tx, args.orgId);
    const toDay = args.toDay ?? orgToday(tz, args.now);
    // 29, not 30: enumerateUtcDays is inclusive of both endpoints, so a 30-day
    // offset produced 31 points and the card rendered "31 days" under a "(30d)"
    // heading. Today plus the 29 before it is 30 days.
    const fromDay = args.fromDay ?? addDaysIso(toDay, -29);

    const denials = await tx.$queryRaw<
      {
        carc_code: string;
        payer_id: string | null;
        cpt_code: string;
        denied_amount_cents: bigint;
        decision: string;
        outcome: string;
        denied_at: Date;
        superbill_id: string | null;
        claim_dos: Date;
      }[]
    >`
      -- The same claim cohort as the billed dollars below: claims whose date
      -- of service is in the window (audit R29). Windowed by the day of the
      -- denial, denials never met their own claims' billed dollars —
      -- denials land weeks after service — and the rate read 0%.
      SELECT d.carc_code, d.payer_id, d.cpt_code,
             d.denied_amount_cents, d.decision, d.outcome, d.denied_at, d.superbill_id,
             s.date_of_service AS claim_dos
        FROM superbill_denial d
        JOIN superbill s ON s.id = d.superbill_id AND s.org_id = d.org_id
       -- Every report names the org as well as relying on RLS: on a
       -- connection that bypasses RLS these were every org's figures.
       WHERE d.org_id = ${args.orgId}::uuid
         AND s.date_of_service BETWEEN ${fromDay}::date AND ${toDay}::date
    `;
    const denialRows = denials.map((d) => ({
      carcCode: d.carc_code,
      payerId: d.payer_id,
      cptCode: d.cpt_code,
      deniedAmountCents: Number(d.denied_amount_cents),
      decision: d.decision,
      outcome: d.outcome,
      deniedAt: d.denied_at,
      superbillId: d.superbill_id,
      claimDateOfService: d.claim_dos,
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
      WHERE org_id = ${args.orgId}::uuid
        AND date_of_service BETWEEN ${fromDay}::date AND ${toDay}::date
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
      WHERE org_id = ${args.orgId}::uuid
        AND (COALESCE(start_time, scheduled_start, created_at) AT TIME ZONE ${tz})::date
            BETWEEN ${fromDay}::date AND ${toDay}::date
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

    const byPayer = denialsByPayer({ superbills: sbRows, denials: denialRows });
    const volume = visitVolumeByClinician(visitRows);

    // Resolve ids → display names so the tables don't show raw UUIDs.
    // payer is a global reference table; app_user is global too — both are
    // fine to read without an org GUC. (Names shown are of this org's own
    // clinicians / the payers on this org's claims.)
    const payerIds = byPayer.map((p) => p.payerId).filter((v): v is string => !!v);
    const payerNames = new Map<string, string>();
    if (payerIds.length > 0) {
      const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id::text AS id, name FROM payer WHERE id = ANY(${payerIds}::uuid[])
      `;
      for (const r of rows) payerNames.set(r.id, r.name);
    }
    const clinicianIds = volume.map((v) => v.clinicianUserId);
    const clinicianNames = new Map<string, string>();
    if (clinicianIds.length > 0) {
      const rows = await tx.$queryRaw<{ id: string; name: string | null }[]>`
        SELECT id::text AS id, COALESCE(full_name, email) AS name
        FROM app_user WHERE id = ANY(${clinicianIds}::uuid[])
      `;
      for (const r of rows) clinicianNames.set(r.id, r.name ?? "");
    }

    return {
      range: { fromDate: fromDay, toDate: toDay },
      // The pure helper keys days by UTC midnight, the same Date a DATE
      // column comes back as, so the days are handed over at UTC midnight.
      denialRateTrend: denialRateTrend({
        superbills: sbRows,
        denials: denialRows,
        fromDate: new Date(`${fromDay}T00:00:00Z`),
        toDate: new Date(`${toDay}T00:00:00Z`),
      }),
      denialsByPayer: byPayer.map((p) => ({
        ...p,
        payerName: p.payerId ? payerNames.get(p.payerId) ?? null : null,
      })),
      revenue: revenueSummary(sbRows),
      visitVolume: volume.map((v) => ({
        ...v,
        clinicianName: clinicianNames.get(v.clinicianUserId) || null,
      })),
      ruleCoverage: ruleCoverage(rbRows),
    };
  });
}
