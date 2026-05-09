/**
 * /visits — clinician default landing.
 *
 * Phase 1 placeholder. Real content (today's schedule + visit cards
 * with sync-state cloud icons per playbook §6.1) lands in Phase 3.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function VisitsPage() {
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Visits</h1>
        <p className="text-slate-600 mt-1">
          Today&apos;s schedule and patient documentation.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            Visit documentation lands in Phase 3 (EMR core).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            The clinician will see today&apos;s schedule, tap a patient
            card to start documentation, and document on-device with
            offline sync (per playbook §6).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
