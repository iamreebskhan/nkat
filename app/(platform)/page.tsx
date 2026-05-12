/**
 * Platform home — dashboard with real org KPIs.
 *
 * Pulls from `/api/reports/overview` (revenue + denial rate trend +
 * rule coverage) and `/api/patients` (active count). Other roles
 * bounce to their default route per the manifest.
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth";
import { MANIFESTS } from "@/lib/manifests";
import { withOrgContext } from "@/lib/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getOverview } from "@/lib/features/reports/reports.service";

export const dynamic = "force-dynamic";

export default async function PlatformHome() {
  const session = await getSession();
  if (!session) redirect("/login");

  const manifest = MANIFESTS[session.role];
  if (manifest.defaultRoute !== "/") redirect(manifest.defaultRoute);

  const [activePatients, openVisits, overview] = await Promise.all([
    countActivePatients(session.orgId),
    countOpenVisits(session.orgId),
    safeOverview(session.orgId),
  ]);

  const peakDenialRate = overview
    ? overview.denialRateTrend.reduce((m, p) => (p.value > m ? p.value : m), 0)
    : 0;

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Dashboard</h1>
        <p className="text-slate-600 mt-1">
          {session.email} · {session.role.replace("_", " ")}
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPI
          title="Active patients"
          subtitle="Currently under care"
          value={activePatients.toLocaleString()}
        />
        <KPI
          title="Open visits"
          subtitle="Scheduled or in progress"
          value={openVisits.toLocaleString()}
        />
        <KPI
          title="Revenue (30d)"
          subtitle="Billed"
          value={overview ? `$${(overview.revenue.billedCents / 100).toFixed(0)}` : "—"}
        />
        <KPI
          title="Collection rate"
          subtitle="Paid / billed (30d)"
          value={overview ? `${(overview.revenue.collectionRate * 100).toFixed(0)}%` : "—"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Denial rate trend (30d)</CardTitle>
            <CardDescription>
              Peak {peakDenialRate.toFixed(1)}% · {overview?.denialRateTrend.length ?? 0} days
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!overview || overview.denialRateTrend.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">No data in the last 30 days.</p>
            ) : (
              <>
                <div className="flex items-end gap-1 h-40">
                  {overview.denialRateTrend.map((p) => (
                    <div
                      key={p.date}
                      className="flex-1 bg-[var(--color-brand-600)]/80 rounded-t"
                      style={{
                        height: `${peakDenialRate > 0 ? (p.value / peakDenialRate) * 100 : 0}%`,
                        minHeight: p.value > 0 ? "2px" : "0",
                      }}
                      title={`${p.date}: ${p.value}%`}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-2 tabular">
                  <span>{overview.denialRateTrend[0]?.date.slice(5)}</span>
                  <span>{overview.denialRateTrend[overview.denialRateTrend.length - 1]?.date.slice(5)}</span>
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
       WHERE status IN ('scheduled', 'in_progress', 'documented')
    `;
    return Number(r[0]?.n ?? 0);
  }).catch(() => 0);
}

async function safeOverview(orgId: string) {
  try {
    return await getOverview({ orgId });
  } catch {
    return null;
  }
}
