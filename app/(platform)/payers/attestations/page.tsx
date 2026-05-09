/**
 * /payers/attestations — analyst default landing.
 *
 * Phase 1 placeholder. Real content (analyst attestation queue,
 * 90-day expiry tracking, payer-rep call entry form) lands in
 * Phase 6.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AttestationsPage() {
  return (
    <div className="px-8 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">Attestations</h1>
        <p className="text-slate-600 mt-1">
          Rules awaiting analyst confirmation by direct payer call.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            Analyst workflow lands in Phase 6.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            When the rule lookup engine returns NO_RULE_FOUND, the
            unknown rule is queued here. The analyst calls the payer,
            enters the rep name + call date + confirmed rule, and the
            attestation becomes the new source for that payer × code.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
