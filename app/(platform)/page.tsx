/**
 * Platform home — dashboard with real org KPIs.
 *
 * Pulls from `/api/reports/overview` (revenue + denial rate trend +
 * rule coverage) and `/api/patients` (active count). Other roles
 * bounce to their default route per the manifest.
 *
 * The money and the denial trend are for a period (Level-1 doc:75), the last
 * 30 days unless ?from=&to= names another; the patient and visit counts are
 * as of now.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth";
import { MANIFESTS } from "@/lib/manifests";
import { withOrgContext } from "@/lib/db";
import { DashboardPeriod } from "@/components/reports/dashboard-period";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  rangeFromParams,
  rangeLabel,
  trendLabel,
  type ReportRange,
} from "@/lib/features/reports/report-range";
import { getOverview } from "@/lib/features/reports/reports.service";
import { CARE_MANAGEMENT_VISIT_TYPE } from "@/lib/features/visits/visit.types";

export const dynamic = "force-dynamic";

export default async function PlatformHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  // The one page that reads data on the server, so it cannot rely on the API
  // refusing a session that still owes its second factor (0121).
  if (session.mfaReq && !session.mfa) redirect("/settings/security?required=1");

  const manifest = MANIFESTS[session.role];
  if (manifest.defaultRoute !== "/") redirect(manifest.defaultRoute);

  // A period the URL names but that cannot be shown falls back to the last
  // 30 days, and says why.
  const sp = await searchParams;
  const asked = rangeFromParams({ from: sp.from, to: sp.to });

  const [activePatients, openVisits, overview] = await Promise.all([
    countActivePatients(session.orgId),
    countOpenVisits(session.orgId),
    safeOverview(session.orgId, asked.range),
  ]);

  const peakDenialRate = overview
    ? overview.denialRateTrend.reduce((m, p) => (p.value > m ? p.value : m), 0)
    : 0;
  const period = overview ? rangeLabel(overview.range, overview.today) : "Last 30 days";
  const monthly = overview?.trendBucket === "month";
  const axis = (key: string | undefined) => (key ? (monthly ? trendLabel(key) : key.slice(5)) : "");

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Dashboard</h1>
        <p className="text-slate-600 mt-1">
          {session.email} · {session.role.replace("_", " ")}
        </p>
        {overview && (
          <div className="mt-4">
            <DashboardPeriod range={overview.range} today={overview.today} error={asked.problem} />
          </div>
        )}
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPI
          title="Active patients"
          subtitle="Currently under care"
          value={activePatients.toLocaleString()}
        />
        {/* Subtitle matches the query, which also counts 'documented' visits —
            work that's done but not yet billed. The old "Scheduled or in
            progress" under-described it. */}
        <KPI
          title="Open visits"
          subtitle="Scheduled, in progress, or awaiting billing"
          value={openVisits.toLocaleString()}
        />
        {/* This is charges RAISED, not money received — calling it "Revenue"
            overstated it. Collected sits in the next tile. */}
        <KPI
          title="Billed"
          subtitle={`Charges raised · ${period}`}
          value={overview ? `$${(overview.revenue.billedCents / 100).toFixed(0)}` : "—"}
        />
        <KPI
          title="Collection rate"
          subtitle={`Paid / billed · ${period}`}
          value={overview ? `${(overview.revenue.collectionRate * 100).toFixed(0)}%` : "—"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            {/* Per date of service (audit R29): denied $ ÷ billed $ for the
                claims with that service date. Keyed to the denial date, a
                denial never met its own claim and this read 0% everywhere. */}
            <CardTitle>Denial rate by date of service</CardTitle>
            <CardDescription>
              {period} · peak {peakDenialRate.toFixed(1)}% · denied $ ÷ billed $ for claims with that service{" "}
              {monthly ? "month" : "date"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!overview ? (
              <p className="text-sm text-slate-500 py-8 text-center">No data for this period.</p>
            ) : overview.revenue.billedCents === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">
                Nothing billed with a service date in this period.
              </p>
            ) : peakDenialRate === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">
                No denials on claims with a service date in this period.
              </p>
            ) : (
              <>
                <div className={`flex items-end h-40 ${overview.denialRateTrend.length > 45 ? "gap-px" : "gap-1"}`}>
                  {overview.denialRateTrend.map((p) => (
                    <div
                      key={p.date}
                      className="flex-1 bg-[var(--color-brand-600)]/80 rounded-t"
                      style={{
                        height: `${peakDenialRate > 0 ? (p.value / peakDenialRate) * 100 : 0}%`,
                        minHeight: p.value > 0 ? "2px" : "0",
                      }}
                      title={`${trendLabel(p.date)}: ${p.value}%`}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-2 tabular">
                  <span>{axis(overview.denialRateTrend[0]?.date)}</span>
                  <span>{axis(overview.denialRateTrend.at(-1)?.date)}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rule coverage</CardTitle>
            <CardDescription>
              {overview
                ? `${overview.ruleCoverage.confirmed} confirmed / ${overview.ruleCoverage.total} total`
                : "Generate or upload a rulebook to populate."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular text-slate-900">
              {overview ? `${(overview.ruleCoverage.coverageRate * 100).toFixed(1)}%` : "—"}
            </div>
            <div className="mt-4 h-2 bg-slate-100 rounded overflow-hidden">
              <div
                className="h-full bg-[var(--color-brand-600)]"
                style={{ width: `${(overview?.ruleCoverage.coverageRate ?? 0) * 100}%` }}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KPI({ title, subtitle, value }: { title: string; subtitle: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-slate-500 font-normal">{title}</CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold tabular text-slate-900">{value}</div>
      </CardContent>
    </Card>
  );
}

async function countActivePatients(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (tx) => {
    const r = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM patient WHERE status = 'active'
    `;
    return Number(r[0]?.n ?? 0);
  }).catch(() => 0);
}

async function countOpenVisits(orgId: string): Promise<number> {
  return withOrgContext(orgId, async (tx) => {
    const r = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM visit
       -- 'pending_billing' belongs here: it's the mandatory waypoint between
       -- documented and billed, so it IS the "awaiting billing" the subtitle
       -- promises. Omitting it made this KPI lower than the same buckets on
       -- /visits, which is exactly the mismatch the client asked us to check.
       WHERE status IN ('scheduled', 'in_progress', 'documented', 'pending_billing')
         -- A PCM/CCM month (0117) is a bill's carrier, not a visit.
         AND visit_type <> ${CARE_MANAGEMENT_VISIT_TYPE}
    `;
    return Number(r[0]?.n ?? 0);
  }).catch(() => 0);
}

async function safeOverview(orgId: string, range: ReportRange | null) {
  try {
    return await getOverview({ orgId, fromDay: range?.fromDate, toDay: range?.toDate });
  } catch {
    return null;
  }
}
