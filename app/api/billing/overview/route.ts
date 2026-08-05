/**
 * GET /api/billing/overview — aggregates for the Billing dashboard
 * (per-status totals, per-client activity, per-nurse bill counts).
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getBillingOverview } from "@/lib/features/billing/billing-overview.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getBillingOverview({ orgId: session.orgId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
