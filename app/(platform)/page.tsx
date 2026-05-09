/**
 * Platform home — redirects to the role's default route.
 *
 * The dashboard lives at each role's first nav item (e.g. clinicians
 * land on /visits, billing agents on /billing/claims, admins on /).
 */
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth";
import { MANIFESTS } from "@/lib/manifests";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function PlatformHome() {
  const session = await getSession();
  if (!session) redirect("/login");

  const manifest = MANIFESTS[session.role];
  // Org admins stay on `/` (their default route is `/`); other roles
  // bounce to their default. Avoids an infinite redirect loop.
  if (manifest.defaultRoute !== "/") {
    redirect(manifest.defaultRoute);
  }

  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Dashboard</h1>
        <p className="text-slate-600 mt-1">
          Welcome back. Quick overview of organization health.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card interactive>
          <CardHeader>
            <CardTitle>Active patients</CardTitle>
            <CardDescription>Total under care this month</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular text-slate-900">—</div>
            <p className="text-xs text-slate-500 mt-1">
              Live data wires up in Phase 3 (EMR core).
            </p>
          </CardContent>
        </Card>

        <Card interactive>
          <CardHeader>
            <CardTitle>Claims pending</CardTitle>
            <CardDescription>Superbills awaiting submission</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular text-slate-900">—</div>
            <p className="text-xs text-slate-500 mt-1">
              Live data wires up in Phase 4 (clinical+billing integration).
            </p>
          </CardContent>
        </Card>

        <Card interactive>
          <CardHeader>
            <CardTitle>Denial rate (30d)</CardTitle>
            <CardDescription>Trending vs prior 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold tabular text-slate-900">—</div>
            <p className="text-xs text-slate-500 mt-1">
              Live data wires up in Phase 6 (reports).
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
