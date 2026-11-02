/**
 * GET /api/settings/ncci — the NCCI edits the practice has loaded, and the
 * codes a PTP load keeps pairs for (settings.view). 0122; see
 * ncci-load.service.ts.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getNcciStatus } from "@/lib/features/billing/ncci-load.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["settings.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await getNcciStatus({ orgId: session.orgId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
