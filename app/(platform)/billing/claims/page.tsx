/**
 * /billing/claims — billing_agent default landing.
 *
 * Phase 1 placeholder. Real content (TanStack DataTable with
 * Carbon density toggle per playbook §9.1, bulk-action bar,
 * row-stripe coverage status) lands in Phase 2 (billing port).
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ClaimsQueuePage() {
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Claims queue</h1>
        <p className="text-slate-600 mt-1">
          Visits ready for superbill generation.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            The denials/superbills/refile workflow lands in Phase 2.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            Billing agents will use this view to triage incoming
            visits, run rule lookups against the patient&apos;s payer,
            and generate superbills with one click.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
