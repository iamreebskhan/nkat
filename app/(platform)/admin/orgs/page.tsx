/**
 * /admin/orgs — platform_admin default landing.
 *
 * Phase 1 placeholder. The cross-tenant view for Mark / Aura admins
 * lands in Phase 6.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlatformOrgsPage() {
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Organizations</h1>
        <p className="text-slate-600 mt-1">
          Cross-tenant view of every org on the platform.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            Multi-org admin lands in Phase 6.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Platform admins access this view via the breakglass
            Postgres role — every read is audit-logged. From here Mark
            can onboard new orgs, see denial-rate trends, and generate
            cheat sheets per client.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
