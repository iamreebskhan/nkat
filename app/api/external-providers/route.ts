/**
 * GET /api/external-providers?q= — the org's roster of outside providers
 * (audit R30), for the chart's "Outside providers" typeahead. Active entries
 * matching the name or practice, or an exact NPI; at most 20.
 *
 * Not patient-specific, so there is no PHI access to log.
 */
import { type NextRequest } from "next/server";

import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listOrgProviders } from "@/lib/features/patients/external-providers.service";

export async function GET(req: NextRequest): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  const q = new URL(req.url).searchParams.get("q")?.slice(0, 100) ?? null;
  try {
    return ok({ rows: await listOrgProviders({ orgId: session.orgId, q }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
