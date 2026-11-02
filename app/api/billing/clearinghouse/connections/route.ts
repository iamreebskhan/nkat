/**
 * GET /api/billing/clearinghouse/connections — the active connections a
 * billing screen can send through (0120): names and channels only, never an
 * ID, a host or a secret (those are Settings → Integrations').
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listConnectionSummaries } from "@/lib/features/clearinghouse/connection.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["billing.superbills.view"]);
  if (session instanceof Response) return session;
  try {
    return ok({ connections: await listConnectionSummaries({ orgId: session.orgId }) });
  } catch (err) {
    return handleServiceError(err);
  }
}
