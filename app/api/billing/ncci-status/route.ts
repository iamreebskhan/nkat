/**
 * GET /api/billing/ncci-status — whether the claim review has NCCI pairs and
 * MUE values to check against (billing.superbills.view: billers read this on a
 * bill and cannot open Settings). 0122.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { ncciInUse } from "@/lib/features/billing/ncci-load.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await ncciInUse({ orgId: session.orgId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
