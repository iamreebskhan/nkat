/**
 * GET /api/caseload — my caseload (0116; Level-1 doc:48): the patients under
 * care whose care team I am on, with their alerts, tasks, monitoring due and
 * next visit.
 */
import { handleServiceError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { listCaseload } from "@/lib/features/care-coordination/caseload.service";

export async function GET(): Promise<Response> {
  const session = await requireAuth(["patients.view"]);
  if (session instanceof Response) return session;
  try {
    return ok(await listCaseload({ orgId: session.orgId, userId: session.userId }));
  } catch (err) {
    return handleServiceError(err);
  }
}
